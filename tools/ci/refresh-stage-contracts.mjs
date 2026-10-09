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
// reviewed pack은 #1062부터 바뀌면 허용한다(0 또는 1개). 입력 파일이 옮겨 간 KRIC·서울 증거 표식을 pack이 따라가는 갱신(2026-10-09 실패 run 37865886911·37866515161)에서 바뀌고,
// canonical pack과 같은 구조 diff 규칙(출처 표식만, 값은 입력 파일·원장·새 snapshot에 결속)으로 본다.
// 관측된 적 없는 경로(ITX 입력 등)는 허용하지 않는다. 이런 변경은 emitter가 push 전에 거부해 workflow가 실패하고 #926 실패 보고로 드러난다.
// 브랜치도 PR도 만들어지지 않는다(workflow가 그 파일을 스테이징해도 증거 본문을 만들지 못한다). 허용하려면 이 표에 규칙을 더하는 코드 변경이 필요하다(fail closed).
//
// 게이트 재계산(evaluateRefreshStage)이 돌려주는 위반 코드:
//   LEDGER_GATE     원장이 append-only가 아니거나(기존 행 변경·순서 변경) 새 행이 기대한 원천이 아니거나 원장 변화 정책(SOURCE_SHA_DRIFT·SOURCE_COUNT_DELTA·BINDING_MISMATCH)을 어겼다.
//                   수도권 topology 단계는 원장이 한 글자도 바뀌면 안 된다.
//   INVENTORY_GATE  inventory가 소유 항목·소유 필드 밖에서 바뀌었다(inventoryScopeViolations). 증거 전후 변화가 정책 한도를 넘었다.
//   REFRESH_GATE    inventory 증거·snapshot 파일·원장 행·입력 파일이 서로 결속되지 않았다. topology는 제거가 있거나(자동 경로 불허) snapshot 신원이 본문과 다르다.
//   PACK_CONTENT    canonical·reviewed pack이 출처 표식(sourceSnapshotId·updatedAt·lastVerifiedAt·reviewedAt, KRIC·서울 증거 행은 verifiedAt·retrievedAt·evidenceHash 포함) 밖에서 바뀌었거나 표식 값이 새 snapshot·증거 시각·입력 파일과 다르다.
import { createHash } from "node:crypto";

import { compareCapitalRouteTopologies, requireCurrentSourceSeparatedCapitalTopology } from "../datapack/collect-capital-route-topology.mjs";
import { latestEvidenceObservedDates } from "../datapack/import-official-sources.mjs";
import { materializeAccessibilitySourceInput, seoulEdgeEvidenceHash, seoulStatusEvidenceHash } from "../datapack/materialize-accessibility-source-input.mjs";
import { inventoryScopeViolations } from "../datapack/source-reverification-recipes.mjs";
import { validateLineage } from "../datapack/source-snapshot-policy.mjs";
import { evaluateLedgerChange, parseLedgerChangePolicy } from "./source-ledger-gate.mjs";

const LEDGER_PATH = "tools/datapack/release/source-snapshots.json";
const INVENTORY_PATH = "tools/datapack/source-inventory.json";
const SEOUL_INPUT_PATH = "tools/datapack/inputs/capital-pilot-production-source-input.json";
const CANONICAL_PACK_PATH = "tools/datapack/release/capital-production-canonical-pack.json";
const REVIEWED_PACK_PATH = "tools/datapack/release/capital-production-reviewed-pack.json";
const SNAPSHOT_DIR = "tools/datapack/sources";

const escapeRegex = (text) => text.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);
const exact = (path, status, { optional = false } = {}) => Object.freeze({ id: path, regex: new RegExp(`^${escapeRegex(path)}$`, "u"), status, optional });
const family = (id, regex, status) => Object.freeze({ id, regex, status, optional: false });
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
      // #1062: 입력 파일이 옮겨 간 KRIC·서울 증거 표식을 pack이 따라가는 갱신에서만 바뀐다(바뀌지 않는 갱신도 있다). 있으면 정확히 하나이고 canonical pack과 같은 구조 diff 규칙을 쓴다.
      exact(REVIEWED_PACK_PATH, "modified", { optional: true }),
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
  const missing = REFRESH_STAGES[stage].rules.filter((rule) => {
    const count = paths.filter((entry) => rule.regex.test(entry)).length;
    return rule.optional ? count > 1 : count !== 1;
  });
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

// 입력 파일은 두 원천의 head를 함께 투영한 파일이다(materializeAccessibilitySourceInput). KRIC 정기 갱신은 입력 파일을 만지지 않고 원장·inventory만 옮기므로,
// 서울 정기 갱신이 입력을 다시 만들 때 KRIC 소유 행도 현재 KRIC head로 따라간다(build-datapack은 입력 행의 sourceSnapshotId를 inventory 증거와 맞춘다).
const KRIC_SOURCE_ID = "kric-station-convenience-standard";
const KRIC_PROJECTED_KEYS = Object.freeze(["facilityRows", "accessibilityStatusEvidence"]);

const splitByKric = (rows) => {
  const kric = [];
  const rest = [];
  for (const [index, row] of rows.entries()) (isObject(row) && row.sourceId === KRIC_SOURCE_ID ? kric : rest).push({ row, index });
  return { kric: kric.map(({ row }) => row), rest };
};

/**
 * Seoul 입력 파일의 변화 범위. 행을 더하거나 지울 수 없고, 서울 소유 행(KRIC 소유 행이 아닌 행)은 새 snapshot을 가리키는 증거 필드(5개)만 바뀐다.
 * 기록된 #1009가 routeEdges 4행·accessibilityStatusEvidence 2행에서 바꾼 필드가 정확히 이 집합이다.
 * KRIC 소유 행은 바뀌지 않았거나(그대로), 바뀌었다면 호출자가 KRIC head에서 생산자 규칙으로 다시 계산해 대조한다(kricRebaseViolations). 바뀐 목록 키를 kricChangedKeys로 돌려준다.
 */
function sourceInputViolations({ base, head, sourceId, snapshotId, capturedAt }) {
  const problems = [];
  const kricChangedKeys = [];
  if (!isObject(base) || !isObject(head)) return { problems: ["입력 파일이 객체가 아니다"], kricChangedKeys };
  let changedRows = 0;
  for (const key of new Set([...Object.keys(base), ...Object.keys(head)])) {
    if (sameJson(base[key], head[key])) continue;
    if (!Array.isArray(base[key]) || !Array.isArray(head[key])) { problems.push(`${key}: 행 목록이 아닌 최상위 항목이 바뀌었다`); continue; }
    const [baseRows, headRows] = [splitByKric(base[key]), splitByKric(head[key])];
    if (!sameJson(baseRows.kric, headRows.kric)) {
      if (KRIC_PROJECTED_KEYS.includes(key)) kricChangedKeys.push(key);
      else problems.push(`${key}: KRIC 소유 행은 이 목록에서 바뀔 수 없다`);
    }
    if (baseRows.rest.length !== headRows.rest.length) { problems.push(`${key}: 행 수가 바뀌었다`); continue; }
    for (const [position, { row: before, index }] of baseRows.rest.entries()) {
      const after = headRows.rest[position].row;
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
      // evidenceHash는 형식이 아니라 값을 본다: 생성 코드와 같은 함수로 새 snapshot에서 다시 계산한 값과 같아야 한다.
      // 계산 방식을 아는 행 목록(routeEdges, accessibilityStatusEvidence)만 허용한다. 그 밖의 목록은 해시를 확인할 수 없어 막는다.
      let expectedHash = null;
      if (key === "routeEdges") expectedHash = seoulEdgeEvidenceHash({ edgeId: after.id, sourceSnapshotId: after.sourceSnapshotId, providerRecordHash: after.providerRecordHash });
      else if (key === "accessibilityStatusEvidence") expectedHash = seoulStatusEvidenceHash({ snapshotId: after.sourceSnapshotId, stationId: after.stationId, lineId: after.lineId, providerRecordHash: after.providerRecordHash });
      if (expectedHash === null) problems.push(`${where}: ${key} 목록의 evidenceHash 계산 방식을 알 수 없다`);
      else if (after.evidenceHash !== expectedHash) problems.push(`${where}: evidenceHash가 새 snapshot에서 다시 계산한 값과 다르다`);
    }
  }
  if (changedRows === 0 && problems.length === 0) problems.push(kricChangedKeys.length > 0 ? "서울 소유 행이 새 snapshot으로 바뀌지 않았다" : "입력 파일이 바뀌지 않았다");
  return { problems, kricChangedKeys };
}

/**
 * KRIC 소유 행이 바뀐 서울 갱신: 바뀐 행 전체가 현재 KRIC head snapshot에서 생산자 규칙(materializeAccessibilitySourceInput)으로 다시 만든 값과 같아야 한다.
 * 행 순서나 위치를 짝지어 보지 않는다. KRIC head는 head inventory 증거가 가리키는 snapshot 파일이고, 파일 바이트는 증거 snapshotFileSha256으로, head 여부는 원장 계보로 대조한다.
 */
export async function kricRebaseViolations({ base, head, baseInventory, headInventory, baseSha, seoulSnapshotId, files }) {
  // KRIC head는 base(main)의 inventory 증거와 원장이 정한다. head 트리의 값은 base와 정확히 같을 때만 믿는다(서울 단계 소유 규칙에 기대지 않는다).
  const evidence = entryOf(baseInventory, KRIC_SOURCE_ID)?.accessibilityAdmissionEvidence;
  if (!isObject(evidence) || typeof evidence.snapshotId !== "string") return [`${KRIC_SOURCE_ID}: base inventory의 accessibilityAdmissionEvidence가 없어 KRIC 소유 행이 바뀐 근거를 확인할 수 없다`];
  if (!sameJson(entryOf(headInventory, KRIC_SOURCE_ID)?.accessibilityAdmissionEvidence, evidence)) return ["head inventory의 KRIC accessibilityAdmissionEvidence가 base와 다르다(서울 갱신은 KRIC head를 옮길 수 없다)"];
  const kricPath = `${SNAPSHOT_DIR}/${evidence.snapshotId}.json`;
  if (evidence.snapshotPath !== kricPath) return [`KRIC 증거 snapshotPath(${String(evidence.snapshotPath)})가 head snapshot 파일(${kricPath})과 다르다`];
  const read = async (relative, what) => {
    try {
      return await files.readTree(relative);
    } catch (error) {
      throw new Error(`${what}을 읽을 수 없다: ${message(error)}`);
    }
  };
  try {
    const kricText = await read(kricPath, "KRIC head snapshot 파일");
    if (sha256(kricText) !== evidence.snapshotFileSha256) return ["KRIC head snapshot 파일의 sha256이 base inventory 증거 snapshotFileSha256과 다르다"];
    const kricSnapshot = JSON.parse(kricText);
    if (kricSnapshot.sourceId !== KRIC_SOURCE_ID || kricSnapshot.snapshotId !== evidence.snapshotId) return ["KRIC head snapshot 파일의 sourceId·snapshotId가 base inventory 증거와 다르다"];
    const baseLedger = JSON.parse(await files.readBase(baseSha, LEDGER_PATH));
    const heads = validateLineage(baseLedger).headsBySource;
    if (heads[KRIC_SOURCE_ID] !== evidence.snapshotId) return [`KRIC inventory 증거(${evidence.snapshotId})가 base 원장의 KRIC head(${String(heads[KRIC_SOURCE_ID])})와 다르다`];
    const kricRows = (ledger) => ledger.filter((row) => row?.sourceId === KRIC_SOURCE_ID);
    if (!sameJson(kricRows(baseLedger), kricRows(JSON.parse(await read(LEDGER_PATH, "원장"))))) return ["head 원장의 KRIC 행이 base와 다르다(서울 갱신은 KRIC 원장을 바꿀 수 없다)"];
    const seoulSnapshot = JSON.parse(await read(`${SNAPSHOT_DIR}/${seoulSnapshotId}.json`, "서울 새 snapshot 파일"));
    const expected = materializeAccessibilitySourceInput({ input: structuredClone(base), kricSnapshot, seoulSnapshot });
    const problems = [];
    for (const key of KRIC_PROJECTED_KEYS) {
      const [want, got] = [splitByKric(expected[key] ?? []).kric, splitByKric(head[key] ?? []).kric];
      if (want.length !== got.length) problems.push(`${key}: KRIC 소유 행이 ${got.length}개인데 KRIC head(${evidence.snapshotId})에서 다시 만든 값은 ${want.length}개다`);
      else {
        const different = want.filter((row, index) => !sameJson(row, got[index])).length;
        if (different > 0) problems.push(`${key}: KRIC 소유 행 ${different}개가 KRIC head(${evidence.snapshotId})에서 생산자 규칙으로 다시 만든 값과 다르다`);
      }
    }
    return problems;
  } catch (error) {
    return [`KRIC 소유 행을 KRIC head에서 다시 만들지 못했다: ${message(error)}`];
  }
}

async function verifySeoul(context) {
  await verifyAccessibilityBinding(context);
  const { rows, newLedgerRows, files, baseSha, violate, baseInventory, headInventory } = context;
  const row = rows[0];
  const ledgerRow = newLedgerRows.get(row.snapshotId);
  const base = await readJson(async () => files.readBase(baseSha, SEOUL_INPUT_PATH), "base 입력 파일", violate);
  const head = await readJson(async () => files.readTree(SEOUL_INPUT_PATH), "head 입력 파일", violate);
  if (base === null || head === null) return;
  const { problems, kricChangedKeys } = sourceInputViolations({ base, head, sourceId: context.spec.expectedSourceIds[0], snapshotId: row.snapshotId, capturedAt: ledgerRow?.retrievedAt ?? null });
  if (kricChangedKeys.length > 0) problems.push(...await kricRebaseViolations({ base, head, baseInventory, headInventory, baseSha, seoulSnapshotId: row.snapshotId, files }));
  for (const problem of problems) violate("REFRESH_GATE", `입력 파일 ${SEOUL_INPUT_PATH}: ${problem}`);
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


// ---------------------------------------------------------------------------
// canonical pack: base·head 구조 diff(리뷰 F1)
// ---------------------------------------------------------------------------
export const PACK_STAMP_KEYS = Object.freeze(["sourceSnapshotId", "updatedAt", "lastVerifiedAt", "reviewedAt"]);
const PACK_TIME_KEYS = Object.freeze(["updatedAt", "lastVerifiedAt", "reviewedAt"]);

// #1062: pack이 입력 파일을 따라 옮기는 KRIC·서울 증거 행. 표(pack) -> 입력 파일의 같은 신원 행 목록.
const FOLLOW_SOURCE_IDS = Object.freeze([KRIC_SOURCE_ID, "seoul-metro-accessibility"]);
const FOLLOW_TABLES = Object.freeze({ facilities: "facilityRows", networkEdges: "routeEdges", stationFacilityEvidence: "accessibilityStatusEvidence" });
const FOLLOW_ROW_KEYS = Object.freeze(["sourceSnapshotId", "verifiedAt", "retrievedAt", "lastVerifiedAt", "evidenceHash"]);
const evidenceKey = (row) => [row.stationId, row.lineId, row.facilityType, row.sourceId].join("\u0000");
const FOLLOW_IDENTITY = Object.freeze({
  facilities: (row) => row.id,
  networkEdges: (row) => row.id,
  stationFacilityEvidence: evidenceKey,
});

/**
 * pack의 KRIC·서울 증거 행이 따라가는 근거를 읽는다: head 입력 파일, head 원장 계보, head inventory 관측일.
 * 읽지 못해도 던지지 않는다. 근거가 필요한 행이 실제로 바뀌었을 때만 그 사유가 위반이 된다(바뀌지 않은 갱신은 이 근거를 보지 않는다).
 */
async function loadFollowContext({ files, headInventory }) {
  try {
    const input = JSON.parse(await files.readTree(SEOUL_INPUT_PATH));
    const ledger = JSON.parse(await files.readTree(LEDGER_PATH));
    if (!isObject(input) || !Array.isArray(ledger)) throw new Error("입력 파일 또는 원장의 형식이 다르다");
    const lineage = new Map(FOLLOW_SOURCE_IDS.map((id) => [id, new Map()]));
    for (const row of ledger) {
      const order = lineage.get(row?.sourceId);
      if (order !== undefined && typeof row.snapshotId === "string") order.set(row.snapshotId, order.size);
    }
    const identities = {};
    for (const [table, inputTable] of Object.entries(FOLLOW_TABLES)) {
      const rows = input[inputTable];
      if (!Array.isArray(rows)) throw new Error(`입력 파일의 ${inputTable}가 목록이 아니다`);
      identities[table] = new Map();
      for (const row of rows) {
        if (!isObject(row) || !FOLLOW_SOURCE_IDS.includes(row.sourceId)) continue;
        const key = FOLLOW_IDENTITY[table](row);
        identities[table].set(key, identities[table].has(key) ? null : row);
      }
    }
    const observed = new Map();
    for (const id of FOLLOW_SOURCE_IDS) {
      const date = entryOf(headInventory, id)?.observedDataUpdatedAt;
      if (typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(date)) observed.set(id, date);
    }
    return { lineage, identities, observed };
  } catch (error) {
    return { error: `KRIC·서울 증거 표식의 근거(입력 파일 ${SEOUL_INPUT_PATH}, 원장 계보, inventory 관측일)를 읽을 수 없다: ${message(error)}` };
  }
}

/** 입력 파일 행(시설 id·간선 id·증거 신원)의 값을 pack 행의 표식 키 이름으로 옮긴다. 시설의 lastVerifiedAt은 입력 행의 verifiedAt이다(생산 pack 규칙). */
const followValue = (table, twin, key) => (table === "facilities" && key === "lastVerifiedAt" ? twin.verifiedAt : twin[key]);

/** 시설 존재(EXISTS) 증거는 입력 파일의 증거 행이 아니라 같은 pack의 같은 시설 행에서 파생된다(import-official-sources의 stationFacilityEvidenceRows). */
const derivesFromFacility = (row) => row.sourceId === KRIC_SOURCE_ID && row.evidenceKind === "EXISTS" && row.facilityType !== "ACCESSIBILITY_STATUS_PROBE";

function followRowViolations({ x, y, table, follow, head }) {
  if (follow === null || follow.error !== undefined) return [follow?.error ?? "KRIC·서울 증거 표식이 바뀌었는데 근거 정보가 주어지지 않았다"];
  const reasons = [];
  const xKeys = Object.keys(x);
  const yKeys = Object.keys(y);
  if (xKeys.length !== yKeys.length || xKeys.some((key) => !Object.hasOwn(y, key))) return ["키 구성이 바뀌었다"];
  const changed = xKeys.filter((key) => !sameJson(x[key], y[key]));
  const outside = changed.filter((key) => !FOLLOW_ROW_KEYS.includes(key));
  if (outside.length > 0) return [`표식 키가 아닌 값이 바뀌었다: ${outside.join(", ")}`];
  if (!changed.includes("sourceSnapshotId")) return [`snapshot id가 그대로인데 표식(${changed.join(", ")})만 바뀌었다`];
  if (changed.some((key) => typeof x[key] !== "string" || typeof y[key] !== "string")) return ["표식 값이 문자열이 아니다"];

  const order = follow.lineage.get(x.sourceId);
  const [from, to] = [order.get(x.sourceSnapshotId), order.get(y.sourceSnapshotId)];
  if (to === undefined) reasons.push(`새 snapshot(${y.sourceSnapshotId})이 head 원장 계보의 ${x.sourceId} snapshot이 아니다`);
  if (from === undefined) reasons.push(`직전 snapshot(${x.sourceSnapshotId})이 head 원장 계보의 ${x.sourceId} snapshot이 아니다`);
  if (from !== undefined && to !== undefined && from >= to) reasons.push(`직전 snapshot(${x.sourceSnapshotId})이 새 snapshot(${y.sourceSnapshotId})보다 앞서지 않는다`);

  let twin;
  let twinLabel;
  if (table === "stationFacilityEvidence" && derivesFromFacility(y)) {
    const matches = (head.packs ?? []).flatMap((pack) => pack.facilities ?? [])
      .filter((facility) => facility?.stationId === y.stationId && facility.lineId === y.lineId && facility.type === y.facilityType && facility.providerRecordHash === y.providerRecordHash);
    twin = matches.length === 1 ? matches[0] : null;
    twinLabel = "같은 pack의 같은 시설 행";
  } else {
    twin = follow.identities[table].get(FOLLOW_IDENTITY[table](y));
    twinLabel = `입력 파일 ${FOLLOW_TABLES[table]}의 같은 신원 행`;
  }
  if (twin === undefined || twin === null) return [...reasons, `${twinLabel}이 없거나 둘 이상이다`];
  for (const key of FOLLOW_ROW_KEYS.filter((entry) => Object.hasOwn(y, entry))) {
    const expected = table === "stationFacilityEvidence" && twinLabel.startsWith("같은 pack") ? twin[key] : followValue(table, twin, key);
    if (typeof expected !== "string") { if (changed.includes(key)) reasons.push(`${key}: ${twinLabel}에 근거 값이 없다`); continue; }
    if (y[key] !== expected) reasons.push(`${key}(${y[key]})가 ${twinLabel}(${expected})과 다르다`);
  }
  return reasons;
}

function followInventoryViolations({ x, y, follow, pack }) {
  if (follow === null || follow.error !== undefined) return [follow?.error ?? "KRIC·서울 증거 표식이 바뀌었는데 근거 정보가 주어지지 않았다"];
  const keys = new Set([...Object.keys(x), ...Object.keys(y)]);
  const outside = [...keys].filter((key) => key !== "updatedAt" && !sameJson(x[key], y[key]));
  if (outside.length > 0) return [`원천 목록 항목은 updatedAt만 바뀔 수 있다: ${outside.join(", ")}`];
  const observed = follow.observed.get(x.id);
  if (observed === undefined) return [`inventory에 ${x.id}의 관측일이 없다`];
  const evidenceDate = latestEvidenceObservedDates([...(pack?.facilities ?? []), ...(pack?.stationFacilityEvidence ?? [])]).get(x.id);
  const expected = `${evidenceDate !== undefined && evidenceDate < observed ? evidenceDate : observed}T00:00:00.000Z`;
  return y.updatedAt === expected ? [] : [`updatedAt(${String(y.updatedAt)})이 inventory 관측일과 pack 증거의 가장 늦은 관측일로 정해지는 값(${expected})과 다르다`];
}

/**
 * 갱신이 pack에서 바꾸는 것은 출처 표식 키 4개뿐이다(기록된 갱신 커밋 ab90519c9 등). base와 head를 구조로 비교해
 * 표식 밖의 키·값·키 구성·배열 길이와 순서가 한 글자라도 다르면 위반으로 모은다. 표식 값도 믿지 않는다.
 *  - sourceSnapshotId: 직전 snapshot id에서 같은 원천의 새 snapshot id로 바뀐 것이어야 한다(원천마다 쌍이 정해져 있다).
 *  - updatedAt·lastVerifiedAt·reviewedAt: 그 원천의 증거 시각(capturedAt)과 정확히 같아야 한다.
 *  - sourceInventory 항목은 snapshot id를 갖지 않으므로 항목 id가 소유 원천이고 updatedAt만 그 원천의 증거 시각으로 바뀔 수 있다.
 *
 * #1062: pack은 production 입력 파일에서 만들어지므로, 서울 접근성 갱신이 입력 파일의 KRIC·서울 증거 행을 새 snapshot으로 옮기면 다음 topology 활성화가
 * pack의 KRIC·서울 증거 행을 따라 옮긴다(시설 4종 표식 + 간선·증거 행의 표식 + 원천 목록의 updatedAt). 이 행들은 follow 규칙(followRowViolations)으로만 바뀔 수 있다.
 *  - 바뀌는 키는 sourceSnapshotId·verifiedAt·retrievedAt·lastVerifiedAt·evidenceHash뿐이고 그 밖의 키·값·키 구성은 그대로여야 한다.
 *  - 새 값은 head 입력 파일의 같은 신원 행(시설 id, 간선 id, 증거 (역·노선·시설종류·원천))과 정확히 같다. 시설 존재(EXISTS) 증거는 같은 pack의 같은 시설 행을 따른다.
 *  - 새 snapshot은 head 원장 계보의 같은 원천 snapshot이고, 직전 값은 같은 원천의 더 앞선 snapshot이다(되돌림 불가).
 *  - sourceInventory의 updatedAt은 inventory 관측일과 pack이 싣는 증거의 가장 늦은 관측일 중 이른 날의 자정이다(packSourceInventoryEntry와 같은 규칙).
 * @param {{ base: unknown, head: unknown, sources: { id: string, before: string, after: string, at: string }[], follow?: object|null }} input
 * @returns {string[]} 위반 사유(없으면 빈 배열)
 */
export function packContentViolations({ base, head, sources, follow = null }) {
  const problems = [];
  const problem = (where, detail) => { if (problems.length < 50) problems.push(`${where}: ${detail}`); };
  const pairs = sources.map(({ before, after, at }) => ({ before, after, at }));
  const byInventoryId = new Map(sources.map((source) => [source.id, source]));
  const pathOf = (parts) => parts.join(".");

  const walk = (x, y, parts) => {
    if (x === y) return;
    const xArray = Array.isArray(x);
    const yArray = Array.isArray(y);
    if (xArray || yArray) {
      if (!xArray || !yArray) { problem(pathOf(parts), "배열이 아닌 값으로 바뀌었다"); return; }
      if (x.length !== y.length) { problem(pathOf(parts), `배열 길이가 ${x.length}에서 ${y.length}로 바뀌었다`); return; }
      for (let index = 0; index < x.length; index += 1) walk(x[index], y[index], [...parts, `[${index}]`]);
      return;
    }
    if (isObject(x) && isObject(y)) {
      const table = parts.at(-2);
      if (typeof x.sourceId === "string" && FOLLOW_SOURCE_IDS.includes(x.sourceId) && Object.hasOwn(FOLLOW_TABLES, table)) {
        if (sameJson(x, y)) return;
        for (const reason of followRowViolations({ x, y, table, follow, head })) problem(pathOf(parts), reason);
        return;
      }
      if (table === "sourceInventory" && typeof x.id === "string" && FOLLOW_SOURCE_IDS.includes(x.id)) {
        if (sameJson(x, y)) return;
        for (const reason of followInventoryViolations({ x, y, follow, pack: head.packs?.[Number(/^\[(\d+)\]$/u.exec(parts[2] ?? "")?.[1])] })) problem(pathOf(parts), reason);
        return;
      }
      const xKeys = Object.keys(x);
      const yKeys = Object.keys(y);
      if (xKeys.length !== yKeys.length || xKeys.some((key) => !Object.hasOwn(y, key))) { problem(pathOf(parts), "키 구성이 바뀌었다"); return; }
      const stamps = [];
      for (const key of xKeys) {
        if (PACK_STAMP_KEYS.includes(key) && (typeof x[key] !== "object" || x[key] === null) && (typeof y[key] !== "object" || y[key] === null)) {
          if (x[key] !== y[key]) stamps.push(key);
        } else {
          walk(x[key], y[key], [...parts, key]);
        }
      }
      if (stamps.length > 0) checkStamps(x, y, stamps, parts);
      return;
    }
    // 원시값이 다르거나 형이 바뀌었다. 표식 키는 위에서 따로 처리했으므로 여기 오면 표식 밖이다.
    problem(pathOf(parts), "표식 키가 아닌 값이 바뀌었다");
  };

  const checkStamps = (x, y, stamps, parts) => {
    const where = pathOf(parts);
    if (stamps.some((key) => typeof y[key] !== "string" || typeof x[key] !== "string")) { problem(where, "표식 값이 문자열이 아니다"); return; }
    let at;
    if (stamps.includes("sourceSnapshotId")) {
      const pair = pairs.find(({ before, after }) => before === x.sourceSnapshotId && after === y.sourceSnapshotId);
      if (!pair) { problem(where, `sourceSnapshotId가 소유 원천의 직전→새 snapshot(${y.sourceSnapshotId})로 바뀐 것이 아니다`); return; }
      at = pair.at;
    } else if (typeof y.id === "string" && byInventoryId.has(y.id) && stamps.every((key) => key === "updatedAt")) {
      at = byInventoryId.get(y.id).at;
    } else {
      problem(where, `표식(${stamps.join(", ")})이 새 snapshot을 가리키지 않는 객체에서 바뀌었다`);
      return;
    }
    for (const key of stamps.filter((entry) => PACK_TIME_KEYS.includes(entry))) {
      if (y[key] !== at) problem(where, `${key}(${y[key]})가 증거 시각(${at})과 다르다`);
    }
  };

  if (!isObject(base) || !isObject(head)) return ["pack이 객체가 아니다"];
  walk(base, head, ["$"]);
  return problems;
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
  // 리뷰 F4: 자동 경로는 제거를 허용하지 않는다. 직전 노선별 역·간선 집합은 새 집합의 부분집합이어야 한다(항목 식별자 기준: 역 이름, 방향 있는 간선 쌍).
  // 같은 수로 교체해도 개수는 그대로지만 제거로 잡힌다. 추가·수정은 capital-route-topology 전용 override(정책 파일)의 작은 한도까지만 허용한다.
  // 제거나 한도 초과는 PR을 열지 않고 실패해 사람 경로(#926 보고)로 간다.
  const comparison = compareCapitalRouteTopologies(previous, capital);
  const removedEdges = comparison.changes.flatMap(({ lineId, removed }) => removed.map((edge) => `${lineId}:${edge.fromStationName}->${edge.toStationName}`));
  const stationsOf = (snapshot) => new Map(snapshot.lines.map((line) => [line.lineId, new Set(line.scope.map(({ stationName }) => stationName))]));
  const [stationsBefore, stationsAfter] = [stationsOf(previous), stationsOf(capital)];
  const removedStations = [...stationsBefore].flatMap(([lineId, names]) => [...names].filter((name) => !stationsAfter.get(lineId)?.has(name)).map((name) => `${lineId}:${name}`));
  bind(violate, removedEdges.length === 0 && removedStations.length === 0,
    `topology에서 간선 ${removedEdges.length}개·역 ${removedStations.length}개가 제거되었다(제거는 자동 병합하지 않는다): ${shown([...removedEdges, ...removedStations])}`);
  const changedEdges = comparison.changes.reduce((sum, { added, modified }) => sum + added.length + modified.length, 0);
  const capitalPolicy = { ...policy, ...(policy.sourceOverrides["capital-route-topology"] ?? {}) };
  const changedRatio = changedEdges / Math.max(previous.totalEdgeCount, 1);
  if (changedRatio > capitalPolicy.maxRowDeltaRatio) {
    violate("INVENTORY_GATE", `SOURCE_COUNT_DELTA: capital-route-topology ${capitalId}: changed edges ${changedEdges} (${percent(changedRatio)}) exceed ${percent(capitalPolicy.maxRowDeltaRatio)}`);
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

  const packSources = [{ id: "incheon-transit-station-info", before: stationBefore.snapshotId, after: stationAfter.snapshotId, at: stationAfter.capturedAt }];
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
    packSources.push({ id: sourceId, before: before.snapshotId, after: after.snapshotId, at: after.capturedAt });
    rows.push(evidenceDeltaRow({
      sourceId, policy, violate, identityChanged: before.rawSha256 !== after.rawSha256 || before.rowsSha256 !== after.rowsSha256,
      before: { snapshotId: before.snapshotId, rawSha256: before.rawSha256, contentSha256: before.rowsSha256, rows: before.rowCount, coverage: before.departureCount },
      after: { snapshotId: after.snapshotId, rawSha256: after.rawSha256, contentSha256: after.rowsSha256, rows: after.rowCount, coverage: after.departureCount },
    }));
  }
  const follow = await loadFollowContext({ files, headInventory });
  // canonical pack은 항상, reviewed pack은 바뀐 경로로 주장될 때만 같은 규칙으로 본다(#1062).
  const packChecks = [["canonical pack", CANONICAL_PACK_PATH], ...(paths.includes(REVIEWED_PACK_PATH) ? [["reviewed pack", REVIEWED_PACK_PATH]] : [])];
  for (const [label, packPath] of packChecks) {
    try {
      const basePack = JSON.parse(await files.readBase(baseSha, packPath));
      const headPack = JSON.parse(await files.readTree(packPath));
      const problems = packContentViolations({ base: basePack, head: headPack, sources: packSources, follow });
      if (problems.length > 0) violate("PACK_CONTENT", `${label}이 출처 표식 밖에서 바뀌었거나 표식 값이 새 snapshot과 다르다(${problems.length}건): ${problems.slice(0, 6).join(" | ")}`);
    } catch (error) {
      violate("PACK_CONTENT", `${label}을 비교하지 못했다: ${message(error)}`);
    }
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
