import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { isCapitalRouteTopologySnapshotId } from "../lib/capital-route-topology-snapshot-id.mjs";
import { validateLineage } from "../source-snapshot-policy.mjs";

export const CURRENT_CAPITAL_BASE_SOURCE_IDS = Object.freeze([
  "molit-urban-rail-full-route", "seoulmetro-station-line-info", "seoul-metro-route-map-positions",
  "kric-subway-timetable", "seoul-metro-accessibility", "kric-station-convenience-standard",
  "seoul-metro-official-od-fares", "seoul-metro-transfer-distance-duration",
]);

// #1007: 정기 갱신 PR은 원장에 새 head를 덧붙이지만 후보 pin은 병합 뒤 후보 갱신이 옮긴다. 그 사이 커밋된 후보는 이전 snapshot을 가리킨다.
// fixture는 후보가 현재 원장 head를 고른 것처럼(current-public-route-map-successor의 rollCandidateToLedgerHeads) 구성하므로, 시각 기준도
// 후보가 고른 원천의 원장 head에서 구한다. head는 롤포워드와 같은 정의(validateLineage의 headsBySource)다. fork·중복 id가 있는 원장은
// validateLineage가 SOURCE_LINEAGE_BROKEN으로 거부하고, pin은 원장에 정확히 한 행으로 있어야 한다. pin이 이미 head이면 기존 계산과 같다.
// 이 fixture 계열은 후보 pin 신선도를 판정하지 않는다. 그 판정은 release 게이트(validate-candidate-source-set.mjs 114행)의 몫이다.
export function candidateSelectedLedgerHeads(buildSpec, sourceSnapshots) {
  const { headsBySource } = validateLineage(sourceSnapshots);
  return buildSpec.sourceSnapshots.map(({ sourceId, snapshotId }) => {
    const pins = sourceSnapshots.filter((entry) => entry.snapshotId === snapshotId && entry.sourceId === sourceId);
    assert.equal(pins.length, 1, `selected source snapshot identity: ${snapshotId}`);
    const heads = sourceSnapshots.filter((entry) => entry.snapshotId === headsBySource[sourceId]);
    assert.equal(heads.length, 1, `selected source ledger head identity: ${sourceId}`);
    return heads[0];
  });
}

// 후보가 고른 수도권 base 원천 head와 현재 capital topology admission 중 가장 늦은 시각.
// #862 결정 2: topology가 base head보다 늦게 수집될 수 있으므로(같은 날 재등록) reviewedAt을 기준에 포함하고,
// 그 시각 이후 2분이 모든 원천과 topology admission의 신선 창 안에 있어야 한다.
export async function selectedSourceHeadAt(datapackRoot) {
  const [buildSpec, sourceSnapshots, inventory] = await Promise.all([
    readFile(path.join(datapackRoot, "release/candidate-build-spec.json"), "utf8").then(JSON.parse),
    readFile(path.join(datapackRoot, "release/source-snapshots.json"), "utf8").then(JSON.parse),
    readFile(path.join(datapackRoot, "source-inventory.json"), "utf8").then(JSON.parse),
  ]);
  const selected = candidateSelectedLedgerHeads(buildSpec, sourceSnapshots)
    .filter((entry) => CURRENT_CAPITAL_BASE_SOURCE_IDS.includes(entry.sourceId));
  const topologyAdmission = inventory.sources
    ?.find(({ id }) => id === "seoul-metro-route-map-positions")
    ?.routeMapAdmissionEvidence?.currentTopologyAdmission;
  assert.ok(isCapitalRouteTopologySnapshotId(topologyAdmission?.topologySnapshotId), "current capital topology admission is required");
  const basisAt = Math.max(
    ...selected.flatMap((entry) => [
      entry.retrievedAt, entry.sourceUpdatedAt, entry.capturedAt, entry.rawReceipt?.storedAt,
    ].filter(Boolean).map(Date.parse)),
    Date.parse(topologyAdmission.reviewedAt),
  );
  const freshUntil = Math.min(
    ...selected.map(({ freshnessExpiresAt }) => Date.parse(freshnessExpiresAt)),
    Date.parse(topologyAdmission.freshUntil),
  );
  assert.ok(Number.isFinite(basisAt) && Number.isFinite(freshUntil) && basisAt + 120_000 < freshUntil);
  return basisAt;
}
