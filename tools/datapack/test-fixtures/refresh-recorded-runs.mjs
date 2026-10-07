// 기록된 실제 갱신 PR(refresh-recorded-runs.json)에서 base·head 트리를 합성하는 테스트 helper(#1012).
// 계약 테스트·정책 테스트·emitter 테스트가 같은 합성을 쓴다. 값은 기록된 실제 값이고, 파일 본문은 검증에 쓰이는 필드만 합성한다.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const RECORDED = JSON.parse(readFileSync(new URL("./refresh-recorded-runs.json", import.meta.url), "utf8")).runs;
export const POLICY = { schemaVersion: 1, issue: 969, allowContentChange: true, maxRowDeltaRatio: 0.05, allowCoverageDecrease: false, sourceOverrides: {} };
export const LEDGER_PATH = "tools/datapack/release/source-snapshots.json";
export const INVENTORY_PATH = "tools/datapack/source-inventory.json";
export const CANONICAL_PACK_PATH = "tools/datapack/release/capital-production-canonical-pack.json";
export const INPUT_PATH = "tools/datapack/inputs/capital-pilot-production-source-input.json";

export const sha256 = (text) => createHash("sha256").update(text).digest("hex");
export const runsOf = (stage) => RECORDED.filter((run) => run.stage === stage);
export const filenames = (run) => run.files.map(({ filename }) => filename).sort((left, right) => (left < right ? -1 : Number(left > right)));

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
export function recordedTrees(run, { mutateInventory = () => {}, mutateLedger = () => {}, mutateInput = () => {}, mutateFiles = () => {}, mutateBaseInventory = () => {} } = {}) {
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
    base.set(INPUT_PATH, JSON.stringify(before));
    head.set(INPUT_PATH, JSON.stringify(after));
  }
  if (run.capital) {
    const { previous, head: current } = run.capital;
    base.set(`tools/datapack/sources/${previous.snapshotId}.json`, JSON.stringify({ sourceId: "capital-route-topology", contentSha256: previous.contentSha256, lineCount: previous.lineCount, totalEdgeCount: previous.totalEdgeCount }));
    head.set(current.path, JSON.stringify({ sourceId: current.sourceId, contentSha256: current.contentSha256, lineCount: current.lineCount, totalEdgeCount: current.totalEdgeCount }));
    head.set(run.capital.reverificationPath, JSON.stringify({ candidate: { contentSha256: run.capital.reverificationCandidateContentSha256 } }));
    for (const [filename, doc] of Object.entries(run.snapshotFiles)) head.set(filename, JSON.stringify(doc));
    // canonical pack 내용은 이 helper가 합성하지 않는다. 경로 계약에 필요한 변경(modified)만 만든다.
    base.set(CANONICAL_PACK_PATH, JSON.stringify({ packs: [{ sourceInventory: [] }] }));
    head.set(CANONICAL_PACK_PATH, JSON.stringify({ packs: [{ sourceInventory: [{ topology: current.path }] }] }));
  }
  mutateFiles(head, base);
  return { base, head };
}

