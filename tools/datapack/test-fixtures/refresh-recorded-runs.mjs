// 기록된 실제 갱신 PR(refresh-recorded-runs.json)에서 base·head 트리를 합성하는 테스트 helper(#1012).
// 계약 테스트·정책 테스트·emitter 테스트가 같은 합성을 쓴다. 값은 기록된 실제 값이고, 파일 본문은 검증에 쓰이는 필드만 합성한다.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { ARTIFACT_KIND, CAPITAL_MAP_LINE_IDS, SOURCE_ID as CAPITAL_SOURCE_ID } from "../collect-capital-route-topology.mjs";

export const RECORDED = JSON.parse(readFileSync(new URL("./refresh-recorded-runs.json", import.meta.url), "utf8")).runs;
// 테스트가 실제 정책 파일을 그대로 쓴다. 정책 값이 바뀌면 테스트가 그 값을 따라간다.
export const POLICY = JSON.parse(readFileSync(new URL("../../ci/source-ledger-change-policy.json", import.meta.url), "utf8"));
export const LEDGER_PATH = "tools/datapack/release/source-snapshots.json";
export const INVENTORY_PATH = "tools/datapack/source-inventory.json";
export const CANONICAL_PACK_PATH = "tools/datapack/release/capital-production-canonical-pack.json";
export const INPUT_PATH = "tools/datapack/inputs/capital-pilot-production-source-input.json";

export const sha256 = (text) => createHash("sha256").update(text).digest("hex");
export const runsOf = (stage) => RECORDED.filter((run) => run.stage === stage);
export const filenames = (run) => run.files.map(({ filename }) => filename).sort((left, right) => (left < right ? -1 : Number(left > right)));


// ---------------------------------------------------------------------------
// 수도권 topology snapshot: 생산자(collect-capital-route-topology)의 신원 규칙을 따르는 합성 본문.
// 선별 노선 22개(인천 분리 노선 제외), 노선마다 역 4개·간선 3개. requireCurrentSourceSeparatedCapitalTopology와 compareCapitalRouteTopologies가 그대로 통과한다.
// ---------------------------------------------------------------------------
const SEPARATED_INCHEON_LINE_IDS = ["line-42b5805f3b5a", "line-98718184f016"];

function finalizeLine(line) {
  return {
    ...line,
    stationCount: line.scope.length,
    edgeCount: line.edges.length,
    scopeSha256: sha256(JSON.stringify(line.scope)),
    edgesSha256: sha256(JSON.stringify(line.edges)),
    contentSha256: sha256(JSON.stringify({ scope: line.scope, edges: line.edges })),
  };
}

/** mutateLines가 신원 필드를 계산하기 전의 노선(lineId·datasetId·rawSha256·scope·edges·branchSequences)을 고친다. 신원 필드는 그 뒤에 다시 계산한다. */
export function buildCapitalSnapshot(mutateLines = () => {}) {
  const lines = CAPITAL_MAP_LINE_IDS.filter((lineId) => !SEPARATED_INCHEON_LINE_IDS.includes(lineId)).map((lineId, index) => {
    const names = Array.from({ length: 4 }, (_, position) => `역${index}-${position}`);
    return {
      lineId, datasetId: String(1000 + index), rawSha256: sha256(`raw-${lineId}`),
      scope: names.map((stationName, position) => ({ stationName, sequence: position + 1 })),
      edges: names.slice(1).map((toStationName, position) => ({ fromStationName: names[position], toStationName, distanceMeters: 1000 + position, durationSeconds: 0, branchNames: [] })),
      branchSequences: [],
    };
  });
  mutateLines(lines);
  const finalized = lines.map(finalizeLine);
  const topologyGaps = [];
  return {
    schemaVersion: 1, artifactKind: ARTIFACT_KIND, sourceId: CAPITAL_SOURCE_ID, capturedAt: "2026-10-07T06:29:46.374Z",
    lineCount: finalized.length,
    totalEdgeCount: finalized.reduce((sum, { edgeCount }) => sum + edgeCount, 0),
    contentSha256: sha256(JSON.stringify({
      lines: finalized.map(({ lineId, edgeCount, stationCount, contentSha256, rawSha256, datasetId }) => ({ lineId, edgeCount, stationCount, contentSha256, rawSha256, datasetId })),
      topologyGaps,
    })),
    lines: finalized, topologyGaps,
  };
}

// ---------------------------------------------------------------------------
// canonical pack: 기록된 갱신 커밋(ab90519c9 등)이 바꾸는 출처 표식만 담은 합성 pack.
// 기록된 diff는 sourceInventory[].updatedAt, stations·stationLines·networkEdges의 sourceSnapshotId·lastVerifiedAt,
// routeMapPositions의 sourceSnapshotId·reviewedAt·updatedAt, 시간표 표 6종의 sourceSnapshotId·updatedAt뿐이다.
// ---------------------------------------------------------------------------
export const PACK_STAMP_KEYS = ["sourceSnapshotId", "updatedAt", "lastVerifiedAt", "reviewedAt"];

/** 기록된 실행의 inventory 증거에서 원천별 (직전·새) snapshot id와 관측 시각을 읽는다. */
export function packSourcesOf(run) {
  const evidenceOf = (id, key) => {
    const entry = run.inventory.changed.find((item) => item.id === id);
    return { before: entry.before[key], after: entry.after[key] };
  };
  const station = evidenceOf("incheon-transit-station-info", "topologyAdmissionEvidence");
  const line1 = evidenceOf("incheon-line1-train-timetable", "scheduleAdmissionEvidence");
  const line2 = evidenceOf("incheon-line2-train-timetable", "scheduleAdmissionEvidence");
  const pick = (evidence) => ({ before: { snapshotId: evidence.before.snapshotId, at: evidence.before.capturedAt }, after: { snapshotId: evidence.after.snapshotId, at: evidence.after.capturedAt } });
  return { "incheon-transit-station-info": pick(station), "incheon-line1-train-timetable": pick(line1), "incheon-line2-train-timetable": pick(line2) };
}

const SEOUL_POSITIONS_STAMP = { sourceSnapshotId: "seoul-metro-route-map-positions-current-20260826T035408251Z", reviewedAt: "2026-08-26T03:54:08.251Z", updatedAt: "2026-08-26T03:54:08.251Z" };

export function packOf(run, side) {
  const sources = packSourcesOf(run);
  const at = (id) => sources[id][side === "before" ? "before" : "after"];
  const station = at("incheon-transit-station-info");
  const l1 = at("incheon-line1-train-timetable");
  const l2 = at("incheon-line2-train-timetable");
  const stationStamp = { sourceSnapshotId: station.snapshotId, lastVerifiedAt: station.at };
  const timetable = (line, extra) => ({ ...extra, sourceSnapshotId: line.snapshotId, updatedAt: line.at });
  return {
    packs: [{
      id: "capital-production", version: "1", schemaVersion: 1,
      sourceInventory: [
        { id: "other-source", updatedAt: "2026-01-01T00:00:00.000Z", sourceSha256: "1".repeat(64) },
        { id: "incheon-transit-station-info", updatedAt: station.at, sourceSha256: "4fd138ac".padEnd(64, "0") },
        { id: "incheon-line1-train-timetable", updatedAt: l1.at, fields: ["service_calendar", "trip", "stop_time"] },
        { id: "incheon-line2-train-timetable", updatedAt: l2.at, fields: ["service_calendar", "trip", "stop_time"] },
      ],
      metadata: { generatedFor: "capital", note: "정책과 무관한 메타데이터" },
      stations: [{ id: "station-1", nameKo: "가", accessible: true, ...stationStamp }, { id: "station-2", nameKo: "나", accessible: false, ...stationStamp }],
      stationLines: [{ stationId: "station-1", lineId: "line-a", sequence: 1, ...stationStamp }, { stationId: "station-2", lineId: "line-a", sequence: 2, ...stationStamp }],
      networkEdges: [
        { id: "edge-1", fromStationId: "station-1", toStationId: "station-2", distanceMeters: 1000, stairFree: true, ...stationStamp },
        { id: "edge-2", fromStationId: "station-2", toStationId: "station-1", distanceMeters: 1000, stairFree: false, ...stationStamp },
      ],
      routeMapPositions: [
        { stationId: "station-1", x: 10, y: 20, sourceSnapshotId: station.snapshotId, reviewedAt: station.at, updatedAt: station.at },
        { stationId: "station-9", x: 30, y: 40, ...SEOUL_POSITIONS_STAMP },
      ],
      serviceCalendars: [timetable(l1, { serviceId: "weekday-1", monday: true }), timetable(l2, { serviceId: "weekday-2", monday: true })],
      serviceCalendarDates: [timetable(l1, { serviceId: "weekday-1", date: "2026-10-09", exceptionType: 1 }), timetable(l2, { serviceId: "weekday-2", date: "2026-10-09", exceptionType: 1 })],
      transitRoutes: [timetable(l1, { id: "route-1", lineId: "line-a" }), timetable(l2, { id: "route-2", lineId: "line-b" })],
      transitTrips: [timetable(l1, { id: "trip-1", routeId: "route-1", serviceId: "weekday-1" }), timetable(l2, { id: "trip-2", routeId: "route-2", serviceId: "weekday-2" })],
      transitStopTimes: [
        timetable(l1, { tripId: "trip-1", stopSequence: 1, stationId: "station-1", arrivalSeconds: 21600, departureSeconds: 21660 }),
        timetable(l1, { tripId: "trip-1", stopSequence: 2, stationId: "station-2", arrivalSeconds: 21900, departureSeconds: 21960 }),
        timetable(l2, { tripId: "trip-2", stopSequence: 1, stationId: "station-2", arrivalSeconds: 22000, departureSeconds: 22060 }),
      ],
      routeServiceArtifactEvidence: [{ kind: "x", sha256: "2".repeat(64) }],
    }],
  };
}

function entryOf(entry, side, { snapshotFileSha256 = null } = {}) {
  const base = { id: entry.id, ...entry.kept, license: { type: "PUBLIC_DATA_FREE_USE" } };
  if (entry.routeMap) {
    const { routeMap } = entry;
    const topologySnapshotId = side === "before" ? routeMap.beforeTopologySnapshotId : routeMap.afterTopologySnapshotId;
    return {
      ...base,
      routeMapAdmissionEvidence: {
        snapshotId: routeMap.snapshotId, snapshotSha256: routeMap.snapshotSha256,
        currentTopologyAdmission: {
          schemaVersion: 1, topologySnapshotId, reviewedAt: side === "before" ? "2026-01-01T00:00:00.000Z" : routeMap.reviewedAt,
          freshUntil: side === "before" ? "2026-01-08T00:00:00.000Z" : routeMap.freshUntil, topologyLineages: [{ sourceId: "capital-route-topology", snapshotId: topologySnapshotId }],
        },
      },
    };
  }
  const merged = { ...base, ...structuredClone(entry[side]) };
  if (side === "after" && snapshotFileSha256 !== null && merged.accessibilityAdmissionEvidence) merged.accessibilityAdmissionEvidence = { ...merged.accessibilityAdmissionEvidence, snapshotFileSha256 };
  return merged;
}

function snapshotTextOf(run) {
  const entry = run.inventory.changed[0];
  const evidence = entry.after.accessibilityAdmissionEvidence;
  return JSON.stringify({ sourceId: entry.id, snapshotId: evidence.snapshotId, rawSha256: evidence.rawSha256, contentSha256: evidence.contentSha256 });
}

export function sourceInputOf(run, side) {
  const arrays = {};
  for (const change of run.sourceInputChanges) {
    arrays[change.container] ??= Array.from({ length: change.length }, (_, index) => ({ id: `keep-${change.container}-${index}`, sourceSnapshotId: "unrelated-snapshot" }));
    arrays[change.container][change.index] = structuredClone(side === "before" ? change.before : change.after);
  }
  return { schemaVersion: 1, ...arrays, facilityRows: [{ id: "facility-1", note: "정책과 무관한 행" }] };
}

/** 기록된 실행의 base·head 트리. mutate가 head 쪽만 고친다. */
export function recordedTrees(run, { mutateInventory = () => {}, mutateLedger = () => {}, mutateInput = () => {}, mutateFiles = () => {}, mutateBaseInventory = () => {}, mutateCapitalLines = () => {}, mutatePack = () => {}, mutateBasePack = () => {}, mutateBaseInput = () => {} } = {}) {
  const base = new Map();
  const head = new Map();
  const snapshotText = run.stage === "seoul-accessibility-refresh" || run.stage === "kric-facility-refresh" ? snapshotTextOf(run) : null;
  const unowned = run.inventory.unownedEntryIds.map((id) => ({ id, productionUseAllowed: true, datasetUrl: `https://example.test/${id}` }));
  const baseInventory = { ...run.inventory.top, sources: [...unowned, ...run.inventory.changed.map((entry) => entryOf(entry, "before"))] };
  const headInventory = { ...run.inventory.top, sources: [...unowned.map((entry) => ({ ...entry })), ...run.inventory.changed.map((entry) => entryOf(entry, "after", { snapshotFileSha256: snapshotText === null ? null : sha256(snapshotText) }))] };
  mutateBaseInventory(baseInventory);
  mutateInventory(headInventory);
  const ledgerHead = structuredClone(run.ledger?.head ?? []);
  mutateLedger(ledgerHead);
  base.set(INVENTORY_PATH, JSON.stringify(baseInventory));
  head.set(INVENTORY_PATH, JSON.stringify(headInventory));
  base.set(LEDGER_PATH, JSON.stringify(run.ledger?.base ?? [{ snapshotId: "unrelated", sourceId: "unrelated" }]));
  head.set(LEDGER_PATH, JSON.stringify(run.ledger ? ledgerHead : [{ snapshotId: "unrelated", sourceId: "unrelated" }]));
  if (snapshotText !== null) head.set(run.files.find(({ status }) => status === "added").filename, snapshotText);
  if (run.sourceInputChanges) {
    const before = sourceInputOf(run, "before");
    const after = sourceInputOf(run, "after");
    mutateInput(after);
    mutateBaseInput(before);
    base.set(INPUT_PATH, JSON.stringify(before));
    head.set(INPUT_PATH, JSON.stringify(after));
  }
  if (run.capital) {
    const { previous, head: current } = run.capital;
    const previousSnapshot = buildCapitalSnapshot();
    const headSnapshot = buildCapitalSnapshot(mutateCapitalLines);
    base.set(`tools/datapack/sources/${previous.snapshotId}.json`, JSON.stringify(previousSnapshot));
    head.set(current.path, JSON.stringify(headSnapshot));
    head.set(run.capital.reverificationPath, JSON.stringify({ candidate: { contentSha256: headSnapshot.contentSha256 } }));
    for (const [filename, doc] of Object.entries(run.snapshotFiles)) head.set(filename, JSON.stringify(doc));
    const headPack = packOf(run, "after");
    mutatePack(headPack);
    const basePack = packOf(run, "before");
    mutateBasePack(basePack);
    base.set(CANONICAL_PACK_PATH, JSON.stringify(basePack));
    head.set(CANONICAL_PACK_PATH, JSON.stringify(headPack));
  }
  mutateFiles(head, base);
  return { base, head };
}

// ---------------------------------------------------------------------------
// #1062: reviewed pack과 KRIC·서울 증거 재결속의 실제 재생 fixture.
// 2026-10-09T00:39Z·00:47Z 실패 run(37865886911·37866515161)과 같은 입력으로 base ad1455fb0 위에서 활성화를 다시 실행한 결과에서 바뀐 행(전·후),
// 입력 파일의 같은 신원 행, 원장 계보, inventory 관측일만 담았다.
// ---------------------------------------------------------------------------
export const REVIEWED_PACK_PATH = "tools/datapack/release/capital-production-reviewed-pack.json";
export const REPLAY = JSON.parse(readFileSync(new URL("./topology-reviewed-pack-replay-20261009.json", import.meta.url), "utf8"));
const FOLLOW_TABLES = ["facilities", "networkEdges", "stationFacilityEvidence"];

const replaySide = (name, side) => {
  const changed = REPLAY.packs[name];
  return {
    ...Object.fromEntries(FOLLOW_TABLES.map((table) => [table, changed[table].map((entry) => structuredClone(entry[side]))])),
    sourceInventory: changed.sourceInventory.map((entry) => structuredClone(entry[side])),
  };
};

/** 활성화 결과를 합성한다: reviewed pack을 더하고, canonical pack에 같은 행을 싣고, 입력 파일·원장·inventory 관측일을 맞춘다. */
export function replayMutations({ reviewed = () => {}, canonical = () => {}, input = () => {}, ledger = () => {}, inventory = () => {}, files = () => {} } = {}) {
  const observed = (inv) => {
    for (const [id, observedDataUpdatedAt] of Object.entries(REPLAY.inventoryObservedDataUpdatedAt)) inv.sources.push({ id, observedDataUpdatedAt, productionUseAllowed: true, datasetUrl: `https://example.test/${id}` });
  };
  return {
    mutateBaseInventory: observed,
    mutateInventory: (inv) => { observed(inv); inventory(inv); },
    mutateBasePack: (pack) => {
      const rows = replaySide("canonical", "before");
      for (const table of FOLLOW_TABLES) pack.packs[0][table] = [...(pack.packs[0][table] ?? []), ...rows[table]];
      pack.packs[0].sourceInventory.push(...rows.sourceInventory);
    },
    mutatePack: (pack) => {
      const rows = replaySide("canonical", "after");
      for (const table of FOLLOW_TABLES) pack.packs[0][table] = [...(pack.packs[0][table] ?? []), ...rows[table]];
      pack.packs[0].sourceInventory.push(...rows.sourceInventory);
      canonical(pack);
    },
    mutateFiles: (head, base) => {
      for (const [tree, side] of [[base, "before"], [head, "after"]]) tree.set(REVIEWED_PACK_PATH, JSON.stringify({ packs: [replaySide("reviewed", side)] }));
      const headReviewed = JSON.parse(head.get(REVIEWED_PACK_PATH));
      reviewed(headReviewed);
      head.set(REVIEWED_PACK_PATH, JSON.stringify(headReviewed));
      const twins = structuredClone(REPLAY.inputTwins);
      input(twins);
      for (const tree of [base, head]) tree.set(INPUT_PATH, JSON.stringify(twins));
      const lineage = structuredClone(REPLAY.ledgerLineage);
      ledger(lineage);
      for (const tree of [base, head]) tree.set(LEDGER_PATH, JSON.stringify(lineage));
      files(head, base);
    },
  };
}
