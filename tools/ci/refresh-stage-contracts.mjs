// 정기 갱신 4종(광주 보관 시간표·수도권 topology·KRIC 시설·서울 접근성)의 자동 병합 정책 계약(#1012, #870 전체 자동화, #969).
//
// 증거 블록 검증(automation-pr-evidence), API diff 경로 판정과 CI 게이트 재계산(automation-pr-policy), PR 증거를 만드는 emitter(refresh-automation-pr)가
// 같은 표를 읽는다. 단계별 허용 경로·소유 inventory 항목과 필드·원장 방식의 정본은 이 파일 하나다.
//
// ground truth: #862 결정 C 이후 실제 workflow가 만든 갱신 PR의 base·head다.
//   수도권 topology   #965 #1003 (#936 #952도 같은 모양): 파일 7개, 원장은 바뀌지 않는다(등록은 병합 뒤 등록 workflow의 몫).
//   광주 보관 시간표   #937 #1011 (#1004도 같다): 원장·inventory 두 파일.
//   KRIC 시설         #1010: 원장·inventory·새 snapshot 파일.
//   서울 접근성       #1009: 원장·inventory·입력 파일·새 snapshot 파일.
// 이전 세대(#644 #651 #667 #671 #708 #713)는 후보 spec·hash evidence·release request까지 같이 바꾸던 결정 C 이전 산출물이라 기준이 아니다.
// 원본 응답의 출처는 병합 뒤 등록 workflow가 OCI 원본으로 확인한다. 수도권 topology의 원본은 커밋된 snapshot 파일 바이트 자체이고(run-current-capital-route-topology-registration.mjs:
// `rawSha256 = sha256(admission.topologyBytes)`를 게시하고 `sha256(raw) !== journal.rawSha256`·`receipt.rawObjectSha256 !== journal.rawSha256`를 대조한다), 이 단계가 증거 행에 싣는
// rawSha256은 그 파일 바이트의 sha256이다. 즉 이 단계가 증명하는 것은 "본문이 생산자 규칙으로 자기 일관적이고 직전과 비교한 변화가 한도 안"이며, 노선별 provider 원본 sha(line.rawSha256)의
// 출처 확인은 이 단계의 몫이 아니다.
// 관측된 적 없는 경로(reviewed pack, ITX 입력)는 허용하지 않는다. workflow가 만들 수는 있지만 자동 병합 대상이 아니라 사람 경로로 보낸다(fail closed).
//
// 게이트 재계산(evaluateRefreshStage)이 돌려주는 위반 코드:
//   LEDGER_GATE     원장이 append-only가 아니거나(기존 행 변경·순서 변경) 새 행이 기대한 원천이 아니거나 원장 변화 정책(SOURCE_SHA_DRIFT·SOURCE_COUNT_DELTA·BINDING_MISMATCH)을 어겼다.
//                   수도권 topology 단계는 원장이 한 글자도 바뀌면 안 된다.
//   INVENTORY_GATE  inventory가 소유 항목·소유 필드 밖에서 바뀌었다(inventoryScopeViolations). 증거 전후 변화가 정책 한도를 넘었다.
//   REFRESH_GATE    inventory 증거·snapshot 파일·원장 행·입력 파일이 서로 결속되지 않았다.
import { createHash } from "node:crypto";

import { requireCurrentSourceSeparatedCapitalTopology } from "../datapack/collect-capital-route-topology.mjs";
import { inventoryScopeViolations } from "../datapack/source-reverification-recipes.mjs";
import { evaluateLedgerChange, parseLedgerChangePolicy } from "./source-ledger-gate.mjs";

const LEDGER_PATH = "tools/datapack/release/source-snapshots.json";
const INVENTORY_PATH = "tools/datapack/source-inventory.json";
const SEOUL_INPUT_PATH = "tools/datapack/inputs/capital-pilot-production-source-input.json";
const CANONICAL_PACK_PATH = "tools/datapack/release/capital-production-canonical-pack.json";
const SNAPSHOT_DIR = "tools/datapack/sources";

const escapeRegex = (text) => text.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);
const exact = (path, status) => Object.freeze({ id: path, regex: new RegExp(`^${escapeRegex(path)}$`, "u"), status });
const family = (id, regex, status) => Object.freeze({ id, regex, status });
const D8 = String.raw`[0-9]{8}`;
const STAMP = String.raw`[0-9]{8}T[0-9]{9}Z`;
const snapshotFamily = (name, stamp, status = "added") => family(name, new RegExp(String.raw`^${escapeRegex(SNAPSHOT_DIR)}/${escapeRegex(name)}-${stamp}\.json$`, "u"), status);

const sortCodepoint = (values) => [...values].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const message = (error) => (error instanceof Error ? error.message : String(error));
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const HEX64 = /^[0-9a-f]{64}$/u;

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isObject(value)) return `{${sortCodepoint(Object.keys(value)).map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
const sameJson = (left, right) => canonicalJson(left) === canonicalJson(right);

const freezeFields = (map) => Object.freeze(Object.fromEntries(Object.entries(map).map(([id, fields]) => [id, Object.freeze([...fields])])));

// 수도권 topology 갱신이 route-map 위치 항목에서 바꾸는 것은 currentTopologyAdmission 안의 이 네 키뿐이다(#936 #952 #965 #1003 모두 같다).
const ROUTE_MAP_MOVING_KEYS = Object.freeze(["topologySnapshotId", "reviewedAt", "freshUntil", "topologyLineages"]);
export const CAPITAL_ROUTE_MAP_ENTRY_IDS = Object.freeze([
  "kric-airport-railroad-route-map-positions", "kric-everline-route-map-positions", "kric-gimpo-goldline-route-map-positions", "kric-gtx-a-route-map-positions",
  "kric-gyeongchun-route-map-positions", "kric-gyeonggang-route-map-positions", "kric-gyeongui-jungang-route-map-positions", "kric-seohae-route-map-positions",
  "kric-seoul-metro-line9-1-route-map-positions", "kric-shinbundang-route-map-positions", "kric-sillim-route-map-positions", "kric-suin-bundang-route-map-positions",
  "kric-ui-sinseol-route-map-positions", "kric-uijeongbu-route-map-positions", "seoul-metro-line9-23-route-map-positions", "seoul-metro-route-map-positions",
]);

const TOPOLOGY_OWNED = freezeFields({
  "incheon-line1-train-timetable": ["retrievedAt", "scheduleAdmissionEvidence"],
  "incheon-line2-train-timetable": ["retrievedAt", "scheduleAdmissionEvidence"],
  "incheon-transit-station-info": ["retrievedAt", "membershipAdmissionEvidence", "topologyAdmissionEvidence", "routeMapAdmissionEvidence"],
  ...Object.fromEntries(CAPITAL_ROUTE_MAP_ENTRY_IDS.map((id) => [id, ["routeMapAdmissionEvidence"]])),
});

const LEDGER_RULES = [exact(LEDGER_PATH, "modified"), exact(INVENTORY_PATH, "modified")];

/**
 * 단계 표.
 *  workflow          이 단계 PR을 만드는 workflow(claim 접두사의 정본은 refresh-open-pr-age의 REFRESH_CLAIM_PREFIXES).
 *  stepId            증거 블록의 단계 id.
 *  ledger            "append" 원장에 새 행 하나를 덧붙인다 / "unchanged" 원장을 바꾸지 않는다.
 *  expectedSourceIds 증거 sources에 있어야 하는 원천(정렬). append는 새 원장 행의 원천, unchanged는 증거 전후 비교 행의 원천이다.
 *  owned             inventory에서 바꿔도 되는 항목 id -> 필드(최상위 키).
 *  rules             API diff의 파일 규칙: 파일마다 정확히 한 규칙에 맞아야 하고 규칙마다 정확히 하나가 있어야 한다.
 */
export const REFRESH_STAGES = Object.freeze({
  "gwangju-timetable-refresh": Object.freeze({
    workflow: "retained-gwangju-timetable-refresh.yml",
    stepId: "gwangju-timetable-refresh",
    ledger: "append",
    expectedSourceIds: Object.freeze(["kric-nationwide-timetable-file"]),
    owned: freezeFields({ "kric-nationwide-timetable-file": ["retrievedAt", "retainedScheduleAdmissionEvidence"] }),
    rules: Object.freeze([...LEDGER_RULES]),
  }),
  "capital-topology-refresh": Object.freeze({
    workflow: "current-capital-topology-refresh.yml",
    stepId: "capital-topology-refresh",
    ledger: "unchanged",
    expectedSourceIds: Object.freeze(["capital-route-topology", "incheon-line1-train-timetable", "incheon-line2-train-timetable", "incheon-transit-station-info"]),
    owned: TOPOLOGY_OWNED,
    rules: Object.freeze([
      snapshotFamily("capital-route-topology", D8),
      snapshotFamily("incheon-transit-station-info", D8),
      snapshotFamily("incheon-line1-train-timetable", D8),
      snapshotFamily("incheon-line2-train-timetable", D8),
      family("capital-topology-reverification", new RegExp(String.raw`^tools/datapack/release/capital-topology-reverification-${D8}\.json$`, "u"), "added"),
      exact(INVENTORY_PATH, "modified"),
      exact(CANONICAL_PACK_PATH, "modified"),
    ]),
  }),
  "kric-facility-refresh": Object.freeze({
    workflow: "kric-current-facility-refresh.yml",
    stepId: "kric-facility-refresh",
    ledger: "append",
    expectedSourceIds: Object.freeze(["kric-station-convenience-standard"]),
    owned: freezeFields({ "kric-station-convenience-standard": ["observedDataUpdatedAt", "retrievedAt", "admissionEvidence", "accessibilityAdmissionEvidence"] }),
    rules: Object.freeze([...LEDGER_RULES, snapshotFamily("kric-station-convenience-standard", STAMP)]),
  }),
  "seoul-accessibility-refresh": Object.freeze({
    workflow: "seoul-current-accessibility-refresh.yml",
    stepId: "seoul-accessibility-refresh",
    ledger: "append",
    expectedSourceIds: Object.freeze(["seoul-metro-accessibility"]),
    owned: freezeFields({ "seoul-metro-accessibility": ["observedDataUpdatedAt", "retrievedAt", "accessibilityAdmissionEvidence"] }),
    rules: Object.freeze([...LEDGER_RULES, exact(SEOUL_INPUT_PATH, "modified"), snapshotFamily("seoul-metro-accessibility", STAMP)]),
  }),
});

export const REFRESH_STAGE_IDS = Object.freeze(Object.keys(REFRESH_STAGES));

export function isRefreshStage(stage) {
  return typeof stage === "string" && Object.hasOwn(REFRESH_STAGES, stage);
}

const ruleOf = (stage, filename) => REFRESH_STAGES[stage].rules.find(({ regex }) => regex.test(filename)) ?? null;
const shown = (list) => list.slice(0, 8).join(", ") + (list.length > 8 ? ` 외 ${list.length - 8}개` : "");
const stampOf = (filename) => /-([0-9]{8})\.json$/u.exec(filename)?.[1] ?? null;

/**
 * 경로 집합이 단계 규칙과 정확히 맞는지 본다(상태는 보지 않는다). 맞으면 null, 어긋나면 사람이 읽을 사유다.
 * 파일마다 정확히 한 규칙에 맞고, 규칙마다 정확히 하나씩 있어야 한다. 수도권 topology의 재검증 기록은 topology와 같은 날짜 표식이어야 한다.
 */
export function refreshPathShapeViolation(stage, paths) {
  if (!isRefreshStage(stage)) return `알 수 없는 갱신 단계: ${String(stage)}`;
  if (!Array.isArray(paths) || paths.length === 0) return "변경 경로가 비어 있다";
  if (paths.some((entry) => typeof entry !== "string" || entry === "")) return "변경 경로의 형식이 다르다";
  if (new Set(paths).size !== paths.length) return "같은 경로가 둘 이상이다";
  const outside = paths.filter((entry) => ruleOf(stage, entry) === null);
  if (outside.length > 0) return `허용 밖 경로: ${shown(outside)}`;
  const missing = REFRESH_STAGES[stage].rules.filter((rule) => paths.filter((entry) => rule.regex.test(entry)).length !== 1);
  if (missing.length > 0) return `정확히 하나여야 하는 경로 종류가 아니다: ${missing.map(({ id }) => id).join(", ")}`;
  if (stage === "capital-topology-refresh") {
    const capital = paths.find((entry) => ruleOf(stage, entry)?.id === "capital-route-topology");
    const reverification = paths.find((entry) => ruleOf(stage, entry)?.id === "capital-topology-reverification");
    if (stampOf(capital) !== stampOf(reverification)) return `재검증 기록(${stampOf(reverification)})이 topology(${stampOf(capital)})와 날짜가 다르다`;
  }
  return null;
}

/** API diff의 파일 목록(filename·status)을 단계 규칙과 대조한다. 경로 집합은 정확히 같아야 하고 파일마다 규칙이 정한 변경 종류여야 한다. */
export function refreshFileViolation(stage, files) {
  if (!isRefreshStage(stage)) return `알 수 없는 갱신 단계: ${String(stage)}`;
  if (!Array.isArray(files) || files.length === 0) return "변경 경로가 비어 있다";
  for (const entry of files) {
    if (!isObject(entry) || typeof entry.filename !== "string" || entry.filename === "") return "변경 파일 항목의 형식이 다르다";
    if (entry.previous_filename !== undefined) return `${entry.filename}가 이름 변경이다(이전 경로 ${String(entry.previous_filename)})`;
    const rule = ruleOf(stage, entry.filename);
    if (rule !== null && entry.status !== rule.status) return `${entry.filename}의 변경 종류(${String(entry.status)})가 ${rule.status}가 아니다`;
  }
  return refreshPathShapeViolation(stage, files.map(({ filename }) => filename));
}

// ---------------------------------------------------------------------------
// 게이트 재계산
// ---------------------------------------------------------------------------
const topLevel = (inventory) => Object.fromEntries(Object.entries(inventory).filter(([key]) => key !== "sources"));
const entryOf = (inventory, id) => inventory.sources.find((entry) => entry?.id === id);

/** 소유 항목 바깥에서 inventory가 바뀌었는지 본다. 원천 재확인·등록 단계와 같은 inventoryScopeViolations를 쓴다. */
function inventoryViolations({ spec, baseInventory, headInventory }) {
  if (!Array.isArray(baseInventory?.sources) || !Array.isArray(headInventory?.sources)) throw new Error("inventory sources must be an array");
  if (!sameJson(topLevel(baseInventory), topLevel(headInventory))) throw new Error("inventory top-level fields changed");
  const allowed = new Map(Object.entries(spec.owned).map(([id, fields]) => [id, new Set(fields)]));
  const outside = inventoryScopeViolations({ base: baseInventory, head: headInventory, allowed });
  if (outside.length > 0) throw new Error(`inventory changed outside the refresh stage's scope: ${outside.slice(0, 6).join(" | ")}`);
  for (const id of Object.keys(spec.owned)) {
    const count = headInventory.sources.filter((entry) => entry?.id === id).length;
    if (count !== 1) throw new Error(`inventory must have exactly one entry for ${id} (found ${count})`);
  }
}

/** route-map 위치 항목은 currentTopologyAdmission의 이동 키 밖을 바꿀 수 없다. 위치 데이터 자체는 이 갱신이 만지지 않는다. */
function routeMapNestedViolations({ baseInventory, headInventory }) {
  const problems = [];
  for (const id of CAPITAL_ROUTE_MAP_ENTRY_IDS) {
    const before = entryOf(baseInventory, id)?.routeMapAdmissionEvidence;
    const after = entryOf(headInventory, id)?.routeMapAdmissionEvidence;
    if (!isObject(before) || !isObject(after) || !isObject(before.currentTopologyAdmission) || !isObject(after.currentTopologyAdmission)) {
      problems.push(`${id}: routeMapAdmissionEvidence.currentTopologyAdmission is missing`);
      continue;
    }
    const { currentTopologyAdmission: movedBefore, ...restBefore } = before;
    const { currentTopologyAdmission: movedAfter, ...restAfter } = after;
    if (!sameJson(restBefore, restAfter)) problems.push(`${id}: routeMapAdmissionEvidence changed outside currentTopologyAdmission`);
    const keys = [...new Set([...Object.keys(movedBefore), ...Object.keys(movedAfter)])].filter((key) => !sameJson(movedBefore[key], movedAfter[key]) && !ROUTE_MAP_MOVING_KEYS.includes(key));
    if (keys.length > 0) problems.push(`${id}: currentTopologyAdmission fields outside the refresh set changed: ${sortCodepoint(keys).join(", ")}`);
  }
  return problems;
}

const percent = (ratio) => `${(ratio * 100).toFixed(1)}%`;

/**
 * 증거 전후 비교 행. 원장 변화 게이트(evaluateLedgerChange)와 같은 정책 한도를 쓴다.
 * identityChanged는 호출자가 정한다: 원천 식별(원본·내용 sha)이 직전과 달라졌는가. 갱신마다 시각이 바뀌는 파일 바이트는 식별이 아니다.
 */
function evidenceDeltaRow({ sourceId, before, after, identityChanged, policy, violate }) {
  const effective = { ...policy, ...(policy.sourceOverrides[sourceId] ?? {}) };
  const rowDelta = after.rows - before.rows;
  const coverageDelta = after.coverage - before.coverage;
  const contentChanged = identityChanged;
  const where = `${sourceId} ${after.snapshotId}`;
  if (contentChanged && !effective.allowContentChange) violate("INVENTORY_GATE", `SOURCE_SHA_DRIFT: ${where}: the source identity changed and the policy does not allow content change`);
  const ratio = Math.abs(rowDelta) / Math.max(before.rows, 1);
  if (ratio > effective.maxRowDeltaRatio) violate("INVENTORY_GATE", `SOURCE_COUNT_DELTA: ${where}: rowDelta ${rowDelta} (${percent(ratio)}) exceeds ${percent(effective.maxRowDeltaRatio)}`);
  if (coverageDelta < 0 && !effective.allowCoverageDecrease) violate("INVENTORY_GATE", `SOURCE_COUNT_DELTA: ${where}: coverageDelta ${coverageDelta} decreases coverage`);
  return {
    sourceId, snapshotId: after.snapshotId, previousSnapshotId: before.snapshotId, rawSha256: after.rawSha256, contentSha256: after.contentSha256,
    rowDelta, coverageDelta, diffStatus: contentChanged || rowDelta !== 0 || coverageDelta !== 0 ? "CHANGED" : "NO_CHANGE",
  };
}

const bind = (violate, ok, detail) => { if (!ok) violate("REFRESH_GATE", detail); };

async function readJson(reader, what, violate) {
  try {
    return JSON.parse(await reader());
  } catch (error) {
    violate("REFRESH_GATE", `${what}: ${message(error)}`);
    return null;
  }
}

/** Seoul·KRIC: inventory 증거 <-> 새 snapshot 파일 <-> 새 원장 행을 묶는다. */
async function verifyAccessibilityBinding({ spec, paths, rows, newLedgerRows, headInventory, files, violate }) {
  const [row] = rows;
  const ledgerRow = newLedgerRows.get(row.snapshotId);
  const sourceId = spec.expectedSourceIds[0];
  const evidence = entryOf(headInventory, sourceId)?.accessibilityAdmissionEvidence;
  if (!isObject(evidence)) { violate("REFRESH_GATE", `${sourceId}: accessibilityAdmissionEvidence is missing`); return; }
  const snapshotPath = `${SNAPSHOT_DIR}/${row.snapshotId}.json`;
  bind(violate, evidence.snapshotId === row.snapshotId, `증거 snapshotId(${String(evidence.snapshotId)})가 새 원장 행(${row.snapshotId})과 다르다`);
  bind(violate, evidence.snapshotPath === snapshotPath && paths.includes(snapshotPath), `증거 snapshotPath(${String(evidence.snapshotPath)})가 새 snapshot 파일(${snapshotPath})과 다르다`);
  bind(violate, evidence.contentSha256 === row.contentSha256, "증거 contentSha256이 새 원장 행과 다르다");
  bind(violate, evidence.capturedAt === (ledgerRow?.retrievedAt ?? null), "증거 capturedAt이 새 원장 행의 retrievedAt과 다르다");
  if (evidence.snapshotPath !== snapshotPath || !paths.includes(snapshotPath)) return;
  let text;
  try {
    text = await files.readTree(snapshotPath);
  } catch (error) {
    violate("REFRESH_GATE", `snapshot 파일을 읽을 수 없다: ${message(error)}`);
    return;
  }
  bind(violate, sha256(text) === evidence.snapshotFileSha256, "증거 snapshotFileSha256이 snapshot 파일의 실제 sha256과 다르다");
  const doc = await readJson(async () => text, "snapshot 파일", violate);
  if (doc === null) return;
  bind(violate, doc.sourceId === sourceId, `snapshot 파일의 sourceId(${String(doc.sourceId)})가 ${sourceId}가 아니다`);
  bind(violate, doc.rawSha256 === evidence.rawSha256, "snapshot 파일의 rawSha256이 증거와 다르다");
  bind(violate, doc.contentSha256 === evidence.contentSha256, "snapshot 파일의 contentSha256이 증거와 다르다");
}

const SOURCE_INPUT_EVIDENCE_KEYS = Object.freeze(["lastVerifiedAt", "sourceSnapshotId", "evidenceHash", "verifiedAt", "retrievedAt"]);
const SOURCE_INPUT_TIME_KEYS = Object.freeze(["lastVerifiedAt", "verifiedAt", "retrievedAt"]);

/**
 * Seoul 입력 파일의 변화 범위. 행을 더하거나 지울 수 없고, 바뀐 행은 새 snapshot을 가리키는 증거 필드(5개)만 바뀐다.
 * 기록된 #1009가 routeEdges 4행·accessibilityStatusEvidence 2행에서 바꾼 필드가 정확히 이 집합이다.
 */
function sourceInputViolations({ base, head, sourceId, snapshotId, capturedAt }) {
  const problems = [];
  if (!isObject(base) || !isObject(head)) return ["입력 파일이 객체가 아니다"];
  let changedRows = 0;
  for (const key of new Set([...Object.keys(base), ...Object.keys(head)])) {
    if (sameJson(base[key], head[key])) continue;
    if (!Array.isArray(base[key]) || !Array.isArray(head[key])) { problems.push(`${key}: 행 목록이 아닌 최상위 항목이 바뀌었다`); continue; }
    if (base[key].length !== head[key].length) { problems.push(`${key}: 행 수가 바뀌었다`); continue; }
    for (const [index, before] of base[key].entries()) {
      const after = head[key][index];
      if (sameJson(before, after)) continue;
      changedRows += 1;
      const where = `${key}[${index}]`;
      if (!isObject(before) || !isObject(after) || !sameJson(sortCodepoint(Object.keys(before)), sortCodepoint(Object.keys(after)))) { problems.push(`${where}: 행의 키 구성이 바뀌었다`); continue; }
      const changed = Object.keys(after).filter((field) => !sameJson(before[field], after[field]));
      const outside = changed.filter((field) => !SOURCE_INPUT_EVIDENCE_KEYS.includes(field));
      if (outside.length > 0) { problems.push(`${where}: 증거 필드가 아닌 필드가 바뀌었다: ${outside.join(", ")}`); continue; }
      if (after.sourceSnapshotId !== snapshotId || typeof before.sourceSnapshotId !== "string" || !before.sourceSnapshotId.startsWith(`${sourceId}-`) || before.sourceSnapshotId === snapshotId) {
        problems.push(`${where}: sourceSnapshotId가 ${sourceId}의 이전 snapshot에서 새 snapshot(${snapshotId})으로 바뀐 것이 아니다`);
      }
      if (Object.hasOwn(after, "sourceId") && after.sourceId !== sourceId) problems.push(`${where}: 다른 원천(${String(after.sourceId)})의 행이다`);
      for (const field of changed.filter((entry) => SOURCE_INPUT_TIME_KEYS.includes(entry))) {
        if (after[field] !== capturedAt) problems.push(`${where}: ${field}가 새 snapshot 시각(${capturedAt})이 아니다`);
      }
      if (changed.includes("evidenceHash") && !HEX64.test(after.evidenceHash)) problems.push(`${where}: evidenceHash 형식이 다르다`);
    }
  }
  if (changedRows === 0 && problems.length === 0) problems.push("입력 파일이 바뀌지 않았다");
  return problems;
}

async function verifySeoul(context) {
  await verifyAccessibilityBinding(context);
  const { rows, newLedgerRows, files, baseSha, violate } = context;
  const row = rows[0];
  const ledgerRow = newLedgerRows.get(row.snapshotId);
  const base = await readJson(async () => files.readBase(baseSha, SEOUL_INPUT_PATH), "base 입력 파일", violate);
  const head = await readJson(async () => files.readTree(SEOUL_INPUT_PATH), "head 입력 파일", violate);
  if (base === null || head === null) return;
  for (const problem of sourceInputViolations({ base, head, sourceId: context.spec.expectedSourceIds[0], snapshotId: row.snapshotId, capturedAt: ledgerRow?.retrievedAt ?? null })) violate("REFRESH_GATE", `입력 파일 ${SEOUL_INPUT_PATH}: ${problem}`);
}

/** 광주 보관 시간표: inventory 보관 증거 <-> 새 원장 행. */
function verifyGwangju({ spec, rows, newLedgerRows, headInventory, violate }) {
  const [row] = rows;
  const ledgerRow = newLedgerRows.get(row.snapshotId);
  const sourceId = spec.expectedSourceIds[0];
  const evidence = entryOf(headInventory, sourceId)?.retainedScheduleAdmissionEvidence;
  if (!isObject(evidence)) { violate("REFRESH_GATE", `${sourceId}: retainedScheduleAdmissionEvidence is missing`); return; }
  bind(violate, evidence.snapshotId === row.snapshotId, `보관 증거 snapshotId(${String(evidence.snapshotId)})가 새 원장 행(${row.snapshotId})과 다르다`);
  bind(violate, evidence.rawSha256 === row.rawSha256, "보관 증거 rawSha256이 새 원장 행과 다르다");
  bind(violate, evidence.observationIdentitySha256 === row.contentSha256, "보관 증거 observationIdentitySha256이 새 원장 행의 contentSha256과 다르다");
  bind(violate, typeof evidence.observationIdentitySha256 === "string" && row.snapshotId.endsWith(`-${evidence.observationIdentitySha256}`), "원장 행 snapshotId가 관측 식별 sha로 끝나지 않는다");
  bind(violate, evidence.observedAt === (ledgerRow?.capturedAt ?? null), "보관 증거 observedAt이 새 원장 행의 capturedAt과 다르다");
}

const countOf = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null);

/** 수도권 topology: 새 snapshot 파일 네 개와 재검증 기록, inventory 증거가 서로 결속되고 직전 현재 snapshot 대비 변화가 정책 한도 안이다. */
async function verifyTopology({ paths, baseSha, policy, baseInventory, headInventory, files, violate }) {
  const byRule = (id) => paths.find((entry) => ruleOf("capital-topology-refresh", entry)?.id === id);
  const capitalPath = byRule("capital-route-topology");
  const stationPath = byRule("incheon-transit-station-info");
  const linePaths = { "incheon-line1-train-timetable": byRule("incheon-line1-train-timetable"), "incheon-line2-train-timetable": byRule("incheon-line2-train-timetable") };
  const reverificationPath = byRule("capital-topology-reverification");
  if ([capitalPath, stationPath, ...Object.values(linePaths), reverificationPath].includes(undefined)) { violate("REFRESH_GATE", "topology 갱신의 새 파일 다섯 개가 모두 있어야 한다"); return []; }
  const stem = (filename) => filename.split("/").pop().replace(/\.json$/u, "");
  const capitalId = stem(capitalPath);

  // route-map 위치 항목: 새 topology를 가리키는 항목은 소유한 16개와 정확히 같고 모두 새 snapshot을 가리킨다.
  const admitted = (inventory) => inventory.sources.filter((entry) => isObject(entry?.routeMapAdmissionEvidence?.currentTopologyAdmission));
  const headAdmitted = admitted(headInventory);
  bind(violate, sameJson(sortCodepoint(headAdmitted.map(({ id }) => id)), sortCodepoint(CAPITAL_ROUTE_MAP_ENTRY_IDS)), "currentTopologyAdmission을 가진 항목이 소유한 16개와 다르다");
  for (const entry of headAdmitted) {
    bind(violate, entry.routeMapAdmissionEvidence.currentTopologyAdmission.topologySnapshotId === capitalId, `${entry.id}: currentTopologyAdmission이 새 topology(${capitalId})를 가리키지 않는다`);
  }
  const previousIds = [...new Set(admitted(baseInventory).map((entry) => entry.routeMapAdmissionEvidence.currentTopologyAdmission.topologySnapshotId))];
  if (previousIds.length !== 1 || typeof previousIds[0] !== "string") { violate("REFRESH_GATE", `base의 route-map 항목들이 가리키는 현재 topology가 하나가 아니다(${previousIds.length}개)`); return []; }
  const [previousId] = previousIds;

  const capitalText = await files.readTree(capitalPath);
  const previousText = await files.readBase(baseSha, `${SNAPSHOT_DIR}/${previousId}.json`);
  // 신원(노선별 scope·edges 해시, lineCount, totalEdgeCount, contentSha256)은 파일이 선언한 값이 아니라 본문에서 생산자의 검증 함수로 다시 계산한다(리뷰 F2).
  // 이 검증은 노선 집합이 소유 규칙(인천 분리 노선 제외 22개)과 같은지도 본다. 비교 기준인 직전 snapshot도 같은 함수로 검증한다.
  let capital;
  let previous;
  try {
    capital = requireCurrentSourceSeparatedCapitalTopology(JSON.parse(capitalText));
    previous = requireCurrentSourceSeparatedCapitalTopology(JSON.parse(previousText));
  } catch (error) {
    violate("REFRESH_GATE", `topology snapshot의 신원을 본문에서 다시 계산하지 못했다: ${message(error)}`);
    return [];
  }
  const reverification = JSON.parse(await files.readTree(reverificationPath));
  bind(violate, reverification?.candidate?.contentSha256 === capital.contentSha256, "재검증 기록의 후보 contentSha256이 새 topology와 다르다");

  // 현재 topology의 식별은 내용 sha다. snapshot 파일 바이트는 갱신 시각이 들어 있어 날마다 달라지므로 식별로 쓰지 않는다.
  // 행의 rawSha256은 커밋된 새 snapshot 파일 바이트의 sha256이고(원본 응답 sha가 아니다), 원장 등록 뒤 원장 행이 원본 sha를 갖는다.
  const rows = [evidenceDeltaRow({
    sourceId: "capital-route-topology", policy, violate, identityChanged: capital.contentSha256 !== previous.contentSha256,
    before: { snapshotId: previousId, rawSha256: sha256(previousText), contentSha256: previous.contentSha256, rows: previous.totalEdgeCount, coverage: previous.lineCount },
    after: { snapshotId: capitalId, rawSha256: sha256(capitalText), contentSha256: capital.contentSha256, rows: capital.totalEdgeCount, coverage: capital.lineCount },
  })];

  const baseStation = entryOf(baseInventory, "incheon-transit-station-info");
  const headStation = entryOf(headInventory, "incheon-transit-station-info");
  const stationBefore = baseStation?.topologyAdmissionEvidence;
  const stationAfter = headStation?.topologyAdmissionEvidence;
  if (!isObject(stationBefore) || !isObject(stationAfter)) { violate("REFRESH_GATE", "incheon-transit-station-info의 topologyAdmissionEvidence가 없다"); return rows; }
  bind(violate, stationAfter.snapshotId === stem(stationPath) && stationAfter.snapshotPath === stationPath, "역 정보 topology 증거가 새 snapshot 파일을 가리키지 않는다");
  bind(violate, headStation.membershipAdmissionEvidence?.snapshotId === stationAfter.snapshotId, "역 정보 membership 증거가 새 snapshot과 다르다");
  bind(violate, headStation.routeMapAdmissionEvidence?.snapshotId === stationAfter.snapshotId && headStation.routeMapAdmissionEvidence?.topologySnapshotId === stationAfter.snapshotId, "역 정보 노선도 증거가 새 snapshot과 다르다");
  const stationDoc = await readJson(async () => files.readTree(stationPath), "역 정보 snapshot 파일", violate);
  if (stationDoc !== null) {
    bind(violate, stationDoc.sourceId === "incheon-transit-station-info", "역 정보 snapshot 파일의 sourceId가 다르다");
    bind(violate, stationDoc.rawSha256 === stationAfter.rawSha256 && stationDoc.contentSha256 === stationAfter.contentSha256, "역 정보 snapshot 파일의 sha가 증거와 다르다");
  }
  if ([stationBefore.edgeCount, stationBefore.stationCount, stationAfter.edgeCount, stationAfter.stationCount].some((value) => countOf(value) === null)
    || !HEX64.test(stationAfter.rawSha256 ?? "") || !HEX64.test(stationAfter.contentSha256 ?? "")) { violate("REFRESH_GATE", "역 정보 topology 증거의 수치·sha 형식이 다르다"); return rows; }
  rows.push(evidenceDeltaRow({
    sourceId: "incheon-transit-station-info", policy, violate, identityChanged: stationBefore.rawSha256 !== stationAfter.rawSha256 || stationBefore.contentSha256 !== stationAfter.contentSha256,
    before: { snapshotId: stationBefore.snapshotId, rawSha256: stationBefore.rawSha256, contentSha256: stationBefore.contentSha256, rows: stationBefore.edgeCount, coverage: stationBefore.stationCount },
    after: { snapshotId: stationAfter.snapshotId, rawSha256: stationAfter.rawSha256, contentSha256: stationAfter.contentSha256, rows: stationAfter.edgeCount, coverage: stationAfter.stationCount },
  }));

  for (const [sourceId, linePath] of Object.entries(linePaths)) {
    const before = entryOf(baseInventory, sourceId)?.scheduleAdmissionEvidence;
    const after = entryOf(headInventory, sourceId)?.scheduleAdmissionEvidence;
    if (!isObject(before) || !isObject(after)) { violate("REFRESH_GATE", `${sourceId}의 scheduleAdmissionEvidence가 없다`); continue; }
    bind(violate, after.snapshotId === stem(linePath) && after.snapshotPath === linePath, `${sourceId}: 시간표 증거가 새 snapshot 파일을 가리키지 않는다`);
    bind(violate, after.topologySnapshotId === stationAfter.snapshotId, `${sourceId}: 시간표 증거가 새 역 정보 snapshot에 결속되지 않았다`);
    const lineDoc = await readJson(async () => files.readTree(linePath), `${sourceId} snapshot 파일`, violate);
    if (lineDoc !== null) bind(violate, lineDoc.sourceId === sourceId && lineDoc.rawSha256 === after.rawSha256, `${sourceId}: snapshot 파일의 sourceId·rawSha256이 증거와 다르다`);
    if ([before.rowCount, before.departureCount, after.rowCount, after.departureCount].some((value) => countOf(value) === null)
      || !HEX64.test(after.rawSha256 ?? "") || !HEX64.test(after.rowsSha256 ?? "")) { violate("REFRESH_GATE", `${sourceId}: 시간표 증거의 수치·sha 형식이 다르다`); continue; }
    rows.push(evidenceDeltaRow({
      sourceId, policy, violate, identityChanged: before.rawSha256 !== after.rawSha256 || before.rowsSha256 !== after.rowsSha256,
      before: { snapshotId: before.snapshotId, rawSha256: before.rawSha256, contentSha256: before.rowsSha256, rows: before.rowCount, coverage: before.departureCount },
      after: { snapshotId: after.snapshotId, rawSha256: after.rawSha256, contentSha256: after.rowsSha256, rows: after.rowCount, coverage: after.departureCount },
    }));
  }
  return rows;
}

/**
 * 단계 하나의 게이트를 base·head 두 판본에서 다시 계산한다. 예외를 던지지 않고(알 수 없는 단계만 예외) 모든 어긋남을 위반으로 돌려준다.
 * @param {{ stage: string, paths: string[], baseSha: string, policy: object, files: { readTree: (relative: string) => Promise<string>, readBase: (sha: string, relative: string) => Promise<string> } }} input
 * @returns {Promise<{ rows: object[], violations: { code: string, detail: string }[] }>}
 */
export async function evaluateRefreshStage({ stage, paths, baseSha, policy, files }) {
  if (!isRefreshStage(stage)) throw new Error(`REFRESH_STAGE_UNKNOWN: ${String(stage)}`);
  const spec = REFRESH_STAGES[stage];
  const violations = [];
  const violate = (code, detail) => violations.push({ code, detail });

  const shape = refreshPathShapeViolation(stage, paths);
  if (shape !== null) violate("REFRESH_GATE", shape);

  let parsedPolicy = null;
  try {
    parsedPolicy = parseLedgerChangePolicy(policy);
  } catch (error) {
    violate("LEDGER_GATE", message(error));
    return { rows: [], violations };
  }

  let rows = [];
  let newLedgerRows = new Map();
  let ledgerOk = true;
  const violateLedger = (detail) => { ledgerOk = false; violate("LEDGER_GATE", detail); };
  try {
    const baseLedger = JSON.parse(await files.readBase(baseSha, LEDGER_PATH));
    const headLedger = JSON.parse(await files.readTree(LEDGER_PATH));
    if (!Array.isArray(baseLedger) || !Array.isArray(headLedger)) throw new Error("ledgers must be arrays");
    if (spec.ledger === "unchanged") {
      if (!sameJson(baseLedger, headLedger)) violateLedger("the source ledger must not change in this stage (registration happens after the merge)");
    } else {
      // 원장은 append-only다: 기존 행은 한 글자도 바뀌지 않은 채 같은 자리에 있어야 한다. evaluateLedgerChange는 원천 식별 필드만 보므로 그 밖의 필드 변경은 여기서 막는다.
      if (headLedger.length < baseLedger.length || baseLedger.some((row, index) => !sameJson(row, headLedger[index]))) {
        violateLedger("existing ledger rows must stay byte-identical and in place (append-only)");
      }
      const result = evaluateLedgerChange({ baseLedger, headLedger, policy: parsedPolicy });
      for (const item of result.violations) violateLedger(`${item.code}: ${item.sourceId} ${item.snapshotId}: ${item.detail}`);
      rows = result.sources;
      const known = new Set(baseLedger.map((row) => row?.snapshotId));
      newLedgerRows = new Map(headLedger.filter((row) => !known.has(row?.snapshotId)).map((row) => [row.snapshotId, row]));
      const found = rows.map(({ sourceId }) => sourceId);
      if (!sameJson(found, spec.expectedSourceIds)) violateLedger(`the ledger must gain exactly one new row for ${spec.expectedSourceIds.join(", ")} (found ${found.length === 0 ? "none" : found.join(", ")})`);
    }
  } catch (error) {
    violateLedger(message(error));
  }

  let baseInventory = null;
  let headInventory = null;
  try {
    baseInventory = JSON.parse(await files.readBase(baseSha, INVENTORY_PATH));
    headInventory = JSON.parse(await files.readTree(INVENTORY_PATH));
    inventoryViolations({ spec, baseInventory, headInventory });
    if (stage === "capital-topology-refresh") {
      const nested = routeMapNestedViolations({ baseInventory, headInventory });
      if (nested.length > 0) throw new Error(`inventory changed outside the route-map admission scope: ${nested.slice(0, 6).join(" | ")}`);
    }
  } catch (error) {
    violate("INVENTORY_GATE", message(error));
    baseInventory = null;
    headInventory = null;
  }

  if (shape === null && baseInventory !== null && headInventory !== null && ledgerOk) {
    const context = { spec, paths, rows, newLedgerRows, baseSha, policy: parsedPolicy, baseInventory, headInventory, files, violate };
    try {
      if (stage === "seoul-accessibility-refresh") await verifySeoul(context);
      else if (stage === "kric-facility-refresh") await verifyAccessibilityBinding(context);
      else if (stage === "gwangju-timetable-refresh") verifyGwangju(context);
      else rows = (await verifyTopology(context)).sort((left, right) => (left.sourceId < right.sourceId ? -1 : Number(left.sourceId > right.sourceId)));
    } catch (error) {
      violate("REFRESH_GATE", message(error));
    }
  }
  return { rows, violations };
}
