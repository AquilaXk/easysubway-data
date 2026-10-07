import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { isCapitalRouteTopologySnapshotId } from "../lib/capital-route-topology-snapshot-id.mjs";

export const CURRENT_CAPITAL_BASE_SOURCE_IDS = Object.freeze([
  "molit-urban-rail-full-route", "seoulmetro-station-line-info", "seoul-metro-route-map-positions",
  "kric-subway-timetable", "seoul-metro-accessibility", "kric-station-convenience-standard",
  "seoul-metro-official-od-fares", "seoul-metro-transfer-distance-duration",
]);

// #1007: 정기 갱신 PR은 원장에 새 head를 덧붙이지만 후보 pin은 병합 뒤 후보 갱신이 옮긴다. 그 사이 커밋된 후보는 이전 snapshot을 가리킨다.
// fixture는 후보가 현재 원장 head를 고른 것처럼(current-public-route-map-successor의 rollCandidateToLedgerHeads) 구성하므로, 시각 기준도
// 후보가 고른 원천의 원장 head(원천별로 수집 시각이 가장 늦은 행)에서 구한다. 후보 pin이 이미 head이면 기존 계산과 같다.
// 계보 검증은 하지 않는다(fork 같은 잘못된 원장은 fixture 구성 단계가 SOURCE_LINEAGE_BROKEN으로 거부한다).
export function candidateSelectedLedgerHeads(buildSpec, sourceSnapshots) {
  return buildSpec.sourceSnapshots.map(({ sourceId, snapshotId }) => {
    const rows = sourceSnapshots.filter((entry) => entry.sourceId === sourceId);
    assert.ok(rows.some((entry) => entry.snapshotId === snapshotId), `selected source snapshot identity: ${snapshotId}`);
    return rows.reduce((head, entry) => Date.parse(entry.retrievedAt) >= Date.parse(head.retrievedAt) ? entry : head);
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
