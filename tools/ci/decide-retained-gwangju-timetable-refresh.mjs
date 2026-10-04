import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { addCadence, deriveFreshnessExpiresAt } from "../datapack/freshness-policy.mjs";
import { validateLineage } from "../datapack/source-snapshot-policy.mjs";
import { requireRetainedTimetableConfirmationPolicy } from "../datapack/prepare-retained-kric-timetable-publication.mjs";

const SOURCE_ID = "kric-nationwide-timetable-file";
// #929 D2 / #930 F2: 일일 재확인 주기. QA 결정 D2(a)(2026-10-04)로 관측 후 P1D가 지나면 재확인한다.
// 정책 클래스 cadence(official_static_timetable_confirmation P7D)는 만료(freshnessExpiresAt)를 정하는 값이고 그대로 둔다.
// 이 값은 만료가 아니라 재확인 시작 시각이므로 cadence보다 짧아야 한다(계약 테스트로 고정).
export const RETAINED_GWANGJU_DAILY_REVERIFICATION_PERIOD = "P1D";

// Workflow와 controller는 동일한 current 입력을 읽고, 운영 시각은 호출 시 한 번 캡처한다.
export async function readRetainedGwangjuTimetableRefreshDecision({
  repositoryRoot = path.resolve(import.meta.dirname, "../.."), now = new Date(),
} = {}) {
  const readJson = async (relative) => JSON.parse(await readFile(path.join(repositoryRoot, relative), "utf8"));
  const [inventory, snapshots, candidates, freshnessPolicy] = await Promise.all([
    readJson("tools/datapack/source-inventory.json"),
    readJson("tools/datapack/release/source-snapshots.json"),
    readJson("tools/datapack/source-candidates.json"),
    readJson("release/product-gates/datapack-freshness-sla.json"),
  ]);
  const candidate = exactlyOne(candidates.candidates, ({ id }) => id === SOURCE_ID, "SOURCE_CANDIDATE");
  return decideRetainedGwangjuTimetableRefresh({ inventory, snapshots, candidate, freshnessPolicy, now });
}

// 등록된 head와 발행 경로가 공유하는 정책으로 갱신 시점을 계산한다.
// #903: 만료 뒤가 아니라 SLA monitoring.alertBeforePackExpiry(수도권 topology 갱신 판정과 같은 기준) 창이 시작될 때부터 DUE다.
// #929 D2: 그보다 먼저, 관측 후 하루가 지나면 DUE다(일일 재확인).
// 만료 시각 자체는 바꾸지 않는다(연장 없음). 창 안에서 새로 수집해 등록해야 만료 전에 head가 이어진다.
export function decideRetainedGwangjuTimetableRefresh({ inventory, snapshots, candidate, freshnessPolicy, now = new Date() } = {}) {
  const nowMillis = requiredDate(now, "NOW");
  const alertBeforeExpiryMillis = alertWindowMillis(freshnessPolicy?.monitoring?.alertBeforePackExpiry);
  const policy = requireRetainedTimetableConfirmationPolicy(candidate);
  const source = exactlyOne(inventory?.sources, (entry) => entry?.id === SOURCE_ID, "INVENTORY_SOURCE");
  const lineage = validateLineage(snapshots);
  const headId = lineage.headsBySource[SOURCE_ID];
  const head = exactlyOne(snapshots, (entry) => entry?.sourceId === SOURCE_ID && entry.snapshotId === headId, "TERMINAL_HEAD");
  const evidence = source.retainedScheduleAdmissionEvidence;
  if (!evidence || evidence.snapshotId !== head.snapshotId || evidence.rawSha256 !== head.rawSha256
    || evidence.observationIdentitySha256 !== head.contentSha256 || evidence.observedAt !== head.observedAt) {
    fail("HEAD_BINDING");
  }
  const observedMillis = requiredUtc(head.observedAt, "OBSERVED_AT");
  if (observedMillis > nowMillis) fail("FUTURE_OBSERVATION");
  const freshnessExpiresAt = deriveFreshnessExpiresAt({
    policy: { sourceClasses: [policy] }, sourceClassId: policy.id,
    basisAt: head.observedAt, providerValidUntil: head.serviceEffectiveUntil, evaluationAt: now.toISOString(),
  });
  if (head.freshnessExpiresAt !== freshnessExpiresAt || head.freshUntil !== freshnessExpiresAt) {
    fail("FRESHNESS_EXPIRES_AT");
  }
  // #929 D2(QA 결정 2026-10-04): 관측 후 P1D가 지나면 매일 재확인한다. 만료 경보 창이 그보다 먼저 오면 그 시각이 우선이다.
  // 만료 시각(freshnessExpiresAt) 계산은 바꾸지 않는다.
  const refreshDueAt = new Date(Math.min(
    addCadence(observedMillis, RETAINED_GWANGJU_DAILY_REVERIFICATION_PERIOD),
    requiredUtc(freshnessExpiresAt, "FRESHNESS_EXPIRES_AT") - alertBeforeExpiryMillis,
  )).toISOString();
  return {
    state: nowMillis < Date.parse(refreshDueAt) ? "CURRENT" : "DUE",
    sourceId: SOURCE_ID, snapshotId: head.snapshotId, observedAt: head.observedAt, freshnessExpiresAt, refreshDueAt,
  };
}

function exactlyOne(items, predicate, code) {
  const matches = Array.isArray(items) ? items.filter((item) => predicate(item)) : [];
  if (matches.length !== 1) fail(code);
  return matches[0];
}

// SLA 경보 창은 시·분·초 ISO 8601 기간(PT6H 등)만 받는다. 0이거나 다른 형식이면 판정하지 않는다.
function alertWindowMillis(value) {
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/u.exec(typeof value === "string" ? value : "");
  if (!match || match.slice(1).every((part) => part === undefined)) fail("ALERT_BEFORE_EXPIRY");
  const millis = (Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0)) * 1000;
  if (millis < 1) fail("ALERT_BEFORE_EXPIRY");
  return millis;
}

function requiredDate(value, code) {
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) fail(code);
  return value.valueOf();
}

function requiredUtc(value, code) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail(code);
  return Date.parse(value);
}

function fail(code) { throw new Error(`RETAINED_GWANGJU_TIMETABLE_REFRESH_${code}`); }

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.length !== 2) fail("CLI_ARGUMENTS");
  process.stdout.write(`${JSON.stringify(await readRetainedGwangjuTimetableRefreshDecision())}\n`);
}
