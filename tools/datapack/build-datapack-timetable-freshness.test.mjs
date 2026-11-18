import assert from "node:assert/strict";
import test from "node:test";

import { candidateArtifactFreshness, productionTimetableFreshness, timetableFreshnessSkipReason } from "./build-datapack.mjs";

// #913: 팩 expiresAt·서버 번들 freshUntil은 topology·접근성 창뿐 아니라 시간표 원천의 신선도 만료까지 반영해야 한다.
const NOW = new Date("2026-10-03T01:00:00.000Z");
const policy = {
  sourceClasses: [
    { id: "official_static_timetable_confirmation", reverificationCadence: "P7D", basisField: "observedAt", sourceIds: ["kric-file"] },
    { id: "planned_timetable", basisField: "serviceEffectiveAt", sourceIds: ["planned"] },
    { id: "incheon_timetable_observation", reverificationCadence: "P30D", basisField: "capturedAt", sourceIds: ["incheon-line1"] },
    { id: "busan_timetable_observation", reverificationCadence: "P30D", basisField: "capturedAt", sourceIds: ["busan"] },
    { id: "route_graph_topology", reverificationCadence: "P7D", basisField: "retrievedAt", sourceIds: ["topology"] },
  ],
};
const sourceSnapshots = [
  { sourceId: "kric-file", snapshotId: "kric-retained", freshnessExpiresAt: "2026-10-08T04:19:25.298Z" },
  { sourceId: "planned", snapshotId: "planned-1", freshnessExpiresAt: "2026-11-02T00:05:31.571Z" },
  { sourceId: "busan", snapshotId: "busan-1", freshnessExpiresAt: "2026-11-01T06:09:43.513Z" },
  { sourceId: "topology", snapshotId: "topology-1", freshnessExpiresAt: "2026-10-10T00:31:56.311Z" },
];
const inventory = {
  sources: [
    { id: "kric-file", capitalScheduleAdmissionEvidence: { snapshotId: "kric-capital", observedAt: "2026-10-03T00:11:32.831Z" } },
    { id: "incheon-line1", scheduleAdmissionEvidence: { snapshotId: "incheon-line1-20261003", capturedAt: "2026-10-03T00:33:08.535Z" } },
  ],
};
const trip = (id, sourceId, sourceSnapshotId) => ({ id, sourceId, ...(sourceSnapshotId === undefined ? {} : { sourceSnapshotId }) });
const packs = [{ transitTrips: [
  trip("a", "kric-file", "kric-capital"), trip("b", "kric-file", "kric-retained"), trip("c", "incheon-line1", "incheon-line1-20261003"),
  trip("d", "planned", "planned-1"), trip("e", "busan"),
] }];

test("시간표 원천 신선도는 spec 원장 행과 inventory evidence(정책 유도)에서 모두 모으고 가장 이른 원천이 만료를 정한다", () => {
  const result = productionTimetableFreshness({ packs, sourceSnapshots, inventory, freshnessPolicy: policy, evaluationAt: "2026-10-03T00:40:43.059Z", now: NOW });
  assert.equal(result.freshUntil, "2026-10-08T04:19:25.298Z");
  assert.deepEqual(result.sources.map(({ sourceId, sourceSnapshotId, freshnessExpiresAt, basis }) => [sourceId, sourceSnapshotId, freshnessExpiresAt, basis]), [
    ["busan", "busan-1", "2026-11-01T06:09:43.513Z", "buildSpec.sourceSnapshots"],
    ["incheon-line1", "incheon-line1-20261003", "2026-11-02T00:33:08.535Z", "inventory.scheduleAdmissionEvidence"],
    ["kric-file", "kric-capital", "2026-10-10T00:11:32.831Z", "inventory.capitalScheduleAdmissionEvidence"],
    ["kric-file", "kric-retained", "2026-10-08T04:19:25.298Z", "buildSpec.sourceSnapshots"],
    ["planned", "planned-1", "2026-11-02T00:05:31.571Z", "buildSpec.sourceSnapshots"],
  ]);
});

test("trip이 가리키는 시간표 원천의 만료를 계산할 수 없거나 이미 만료됐으면 실패한다", () => {
  const unknown = [{ transitTrips: [...packs[0].transitTrips, trip("x", "cyberstation")] }];
  assert.throws(() => productionTimetableFreshness({ packs: unknown, sourceSnapshots, inventory, freshnessPolicy: policy, evaluationAt: "2026-10-03T00:40:43.059Z", now: NOW }),
    /TIMETABLE_FRESHNESS_UNRESOLVED: cyberstation/u);
  const unbound = [{ transitTrips: [trip("y", "kric-file", "kric-other")] }];
  assert.throws(() => productionTimetableFreshness({ packs: unbound, sourceSnapshots, inventory, freshnessPolicy: policy, evaluationAt: "2026-10-03T00:40:43.059Z", now: NOW }),
    /TIMETABLE_FRESHNESS_UNRESOLVED: kric-file kric-other/u);
  assert.throws(() => productionTimetableFreshness({ packs, sourceSnapshots, inventory, freshnessPolicy: policy, evaluationAt: "2026-10-03T00:40:43.059Z", now: new Date("2026-10-08T04:19:25.298Z") }),
    /TIMETABLE_FRESHNESS_EXPIRED: kric-file kric-retained/u);
});

test("팩 만료는 네트워크(topology·ITX·접근성) 창과 시간표 창 중 이른 쪽이고 결정한 원천을 남긴다", () => {
  const timetable = productionTimetableFreshness({ packs, sourceSnapshots, inventory, freshnessPolicy: policy, evaluationAt: "2026-10-03T00:40:43.059Z", now: NOW });
  const laterCited = [{ snapshotId: "late", sourceClassId: "route_graph_topology", status: "FRESH", freshnessExpiresAt: "2026-12-31T00:00:00.000Z" }];
  const earlierTimetable = candidateArtifactFreshness({ networkFreshUntil: "2026-10-10T00:31:56.311Z", timetable, citedSources: laterCited });
  assert.equal(earlierTimetable.freshUntil, "2026-10-08T04:19:25.298Z");
  assert.deepEqual(earlierTimetable.decidedBy, [{ kind: "timetable", sourceId: "kric-file", sourceSnapshotId: "kric-retained" }]);
  const earlierNetwork = candidateArtifactFreshness({ networkFreshUntil: "2026-10-07T00:00:00.000Z", timetable, citedSources: laterCited });
  assert.equal(earlierNetwork.freshUntil, "2026-10-07T00:00:00.000Z");
  assert.deepEqual(earlierNetwork.decidedBy, [{ kind: "network" }]);
  assert.equal(earlierNetwork.timetableSources.length, 5);
});

// #913 리뷰 F2: 전국 production 팩에서 시간표 원천이 하나도 없으면 계산 불가로 실패한다. 의도적으로 건너뛰는 경우는 사유를 남긴다.
test("전국 production 팩인데 시간표 원천이 0개면 실패한다", () => {
  assert.throws(() => productionTimetableFreshness({ packs: [{ transitTrips: [] }], sourceSnapshots: [], inventory: { sources: [] },
    freshnessPolicy: policy, evaluationAt: "2026-10-03T00:40:43.059Z", now: NOW }), /TIMETABLE_FRESHNESS_UNRESOLVED: no timetable sources/u);
});

test("시간표 신선도를 건너뛰는 범위는 사유로 구분하고 전국 발행 빌드만 계산한다", () => {
  const production = [{ artifactKind: "production" }];
  assert.equal(timetableFreshnessSkipReason({ productionScopeId: "nationwide_routing_android_v1", productionPacks: production, validationOnly: false }), null);
  assert.equal(timetableFreshnessSkipReason({ productionScopeId: "capital_pilot_android_v1", productionPacks: production, validationOnly: false }), "NOT_NATIONWIDE_SCOPE");
  assert.equal(timetableFreshnessSkipReason({ productionScopeId: "nationwide_routing_android_v1", productionPacks: [], validationOnly: false }), "NO_PRODUCTION_PACK");
  assert.equal(timetableFreshnessSkipReason({ productionScopeId: "nationwide_routing_android_v1", productionPacks: production, validationOnly: true }), "VALIDATION_ONLY_BUILD");
});

// #913 후속(seq126 production-publish 실패): 서버 번들 FINAL은 spec이 인용한 모든 원천의 정책 신선도(validateSourceSnapshotFreshness)를
// cutoff로 본다. 팩 만료도 같은 원천 집합을 포함해야 FINAL과 어긋나지 않는다(예: 대경선 topology 첨부 원천 10-10T00:05:31Z).
test("팩 만료는 spec 인용 원천 전체의 정책 신선도도 포함하고 그 원천이 더 이르면 결정 원천으로 남는다", () => {
  const timetable = productionTimetableFreshness({ packs, sourceSnapshots, inventory, freshnessPolicy: policy, evaluationAt: "2026-10-03T00:40:43.059Z", now: NOW });
  const cited = [
    { snapshotId: "korail-attachment-1", sourceClassId: "route_graph_topology", status: "FRESH", freshnessExpiresAt: "2026-10-08T00:05:31.571Z" },
    { snapshotId: "topology-1", sourceClassId: "route_graph_topology", status: "FRESH", freshnessExpiresAt: "2026-10-10T00:31:56.311Z" },
  ];
  const result = candidateArtifactFreshness({ networkFreshUntil: "2026-10-10T00:31:56.311Z", timetable, citedSources: cited });
  assert.equal(result.freshUntil, "2026-10-08T00:05:31.571Z");
  assert.deepEqual(result.decidedBy, [{ kind: "cited-source", sourceSnapshotId: "korail-attachment-1", sourceClassId: "route_graph_topology" }]);
  assert.equal(result.citedSourceFreshUntil, "2026-10-08T00:05:31.571Z");
  assert.throws(() => candidateArtifactFreshness({ networkFreshUntil: "2026-10-10T00:31:56.311Z", timetable, citedSources: [] }), /CITED_SOURCE_FRESHNESS_UNRESOLVED/u);
  assert.throws(() => candidateArtifactFreshness({ networkFreshUntil: "2026-10-10T00:31:56.311Z", timetable,
    citedSources: [{ ...cited[0], status: "STALE" }] }), /CITED_SOURCE_FRESHNESS_UNRESOLVED/u);
});
