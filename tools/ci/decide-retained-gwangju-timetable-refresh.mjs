import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { deriveFreshnessExpiresAt } from "../datapack/freshness-policy.mjs";
import { validateLineage } from "../datapack/source-snapshot-policy.mjs";
import { requireRetainedTimetableConfirmationPolicy } from "../datapack/prepare-retained-kric-timetable-publication.mjs";

const SOURCE_ID = "kric-nationwide-timetable-file";

// Workflow와 controller는 동일한 current 입력을 읽고, 운영 시각은 호출 시 한 번 캡처한다.
export async function readRetainedGwangjuTimetableRefreshDecision({
  repositoryRoot = path.resolve(import.meta.dirname, "../.."), now = new Date(),
} = {}) {
  const readJson = async (relative) => JSON.parse(await readFile(path.join(repositoryRoot, relative), "utf8"));
  const [inventory, snapshots, candidates] = await Promise.all([
    readJson("tools/datapack/source-inventory.json"),
    readJson("tools/datapack/release/source-snapshots.json"),
    readJson("tools/datapack/source-candidates.json"),
  ]);
  const candidate = exactlyOne(candidates.candidates, ({ id }) => id === SOURCE_ID, "SOURCE_CANDIDATE");
  return decideRetainedGwangjuTimetableRefresh({ inventory, snapshots, candidate, now });
}

// 등록된 head와 발행 경로가 공유하는 정책으로 갱신 시점을 계산한다.
export function decideRetainedGwangjuTimetableRefresh({ inventory, snapshots, candidate, now = new Date() } = {}) {
  const nowMillis = requiredDate(now, "NOW");
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
    basisAt: head.observedAt, providerValidUntil: null, evaluationAt: now.toISOString(),
  });
  if (head.freshnessExpiresAt !== freshnessExpiresAt || head.freshUntil !== freshnessExpiresAt) {
    fail("FRESHNESS_EXPIRES_AT");
  }
  return {
    state: nowMillis < requiredUtc(freshnessExpiresAt, "FRESHNESS_EXPIRES_AT") ? "CURRENT" : "DUE",
    sourceId: SOURCE_ID, snapshotId: head.snapshotId, observedAt: head.observedAt, freshnessExpiresAt,
  };
}

function exactlyOne(items, predicate, code) {
  const matches = Array.isArray(items) ? items.filter((item) => predicate(item)) : [];
  if (matches.length !== 1) fail(code);
  return matches[0];
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
