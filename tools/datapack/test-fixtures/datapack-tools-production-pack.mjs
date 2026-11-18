import { sha256 } from "../../lib/hash.mjs";
import {
  TEST_PRODUCTION_ACCESSIBILITY_SOURCE,
  TEST_ACCESSIBILITY_SNAPSHOT_ID,
  TEST_ACCESSIBILITY_RETRIEVED_AT,
} from "./datapack-tools-source-ingest.mjs";

export function makeProductionSourceFixtureStrictCoverageValid(fixture) {
  const pack = fixture.packs[0];
  const testAccessibilitySource = pack.sourceInventory.find(
    ({ id }) => id === TEST_PRODUCTION_ACCESSIBILITY_SOURCE,
  );
  if (!testAccessibilitySource) throw new Error("positive production fixture requires test accessibility source");
  const productionCoverageEvidence = JSON.parse(pack.metadata.productionCoverageEvidence).map((entry) => (
    entry.sourceDomain === "accessibility_facilities"
      ? { ...entry, sourceIds: [testAccessibilitySource.id] }
      : entry
  ));
  pack.metadata.productionCoverageEvidence = JSON.stringify(productionCoverageEvidence);
  for (const edge of pack.networkEdges.filter((row) => ["ENTRY", "EXIT"].includes(row.edgeType))) {
    edge.accessibilityStatus = "AVAILABLE";
    edge.sourceId = TEST_PRODUCTION_ACCESSIBILITY_SOURCE;
    edge.sourceSnapshotId = TEST_ACCESSIBILITY_SNAPSHOT_ID;
    edge.providerRecordHash = sha256(`provider:${edge.id}:test-only-capital-accessibility-fixture`);
    edge.evidenceHash = sha256(`evidence:${edge.id}:test-only-capital-accessibility-fixture:${TEST_ACCESSIBILITY_RETRIEVED_AT}`);
    edge.lastVerifiedAt = TEST_ACCESSIBILITY_RETRIEVED_AT;
  }
  for (const evidence of pack.stationFacilityEvidence) {
    evidence.sourceId = testAccessibilitySource.id;
    evidence.sourceSnapshotId = TEST_ACCESSIBILITY_SNAPSHOT_ID;
    evidence.providerRecordHash = sha256(`provider:${evidence.stationId}:${evidence.lineId}:${evidence.facilityType}:test-only-capital-accessibility-fixture`);
    evidence.evidenceHash = sha256(`evidence:${evidence.stationId}:${evidence.lineId}:${evidence.facilityType}:test-only-capital-accessibility-fixture:${TEST_ACCESSIBILITY_RETRIEVED_AT}`);
    evidence.operationalStatus = "AVAILABLE";
    evidence.statusMeaning = "OPERATOR_CONFIRMED";
    evidence.strictRouteEligible = true;
    evidence.strictRouteEligibleReason = "FACILITY_OPERATION_VERIFIED";
  }
  addApprovedMovementPathwayEvidence(pack, {
    sourceId: TEST_PRODUCTION_ACCESSIBILITY_SOURCE,
    sourceSnapshotId: TEST_ACCESSIBILITY_SNAPSHOT_ID,
    verifiedAt: TEST_ACCESSIBILITY_RETRIEVED_AT,
  });
}

export function addApprovedMovementPathwayEvidence(pack, { sourceId, sourceSnapshotId, verifiedAt }) {
  pack.stationPathwayNodes ??= [];
  pack.stationPathwayEdges ??= [];
  for (const { stationId, lineId } of pack.stationLines) {
    const surfaceNodeId = `test-approved-path-node-${stationId}-${lineId}-surface`;
    const platformNodeId = `test-approved-path-node-${stationId}-${lineId}-platform`;
    const pathwayEdgeId = `test-approved-path-edge-${stationId}-${lineId}`;
    pack.stationPathwayNodes.push(
      {
        id: surfaceNodeId,
        stationId,
        nodeType: "ENTRANCE",
        label: `${stationId} 출입구`,
      },
      {
        id: platformNodeId,
        stationId,
        lineId,
        nodeType: "PLATFORM",
        label: `${stationId} ${lineId} 승강장`,
      },
    );
    pack.stationPathwayEdges.push({
      id: pathwayEdgeId,
      fromNodeId: surfaceNodeId,
      toNodeId: platformNodeId,
      edgeType: "WALK",
      bidirectional: true,
      accessibilityStatus: "AVAILABLE",
      reliabilityScore: 90,
      sourceId,
      sourceSnapshotId,
      providerRecordHash: sha256(`provider:${pathwayEdgeId}:${sourceId}`),
      provenanceKind: "OFFICIAL_SOURCE",
      verificationStatus: "VERIFIED",
      lastVerifiedAt: verifiedAt,
      evidenceHash: sha256(`evidence:${pathwayEdgeId}:${sourceId}:${verifiedAt}`),
    });
  }
}
