export function launchScope({ targets = "tools/datapack/nationwide-coverage-targets.json" } = {}) {
  const regions = ["busan", "capital", "daegu", "daejeon", "gwangju"];
  const stations = ["station-a", "station-b"];
  const facilities = ["ELEVATOR", "ESCALATOR", "WHEELCHAIR_LIFT"];
  return {
    verifiedAccessibilityScope: {
      id: "fixture-accessibility-v1",
      requiredRowIds: stations.flatMap((station) => facilities.map((facility) => `${station}|fixture-line|${facility}`)),
      includedStationIds: stations, includedLineIds: ["fixture-line"], requiredFacilityTypes: facilities,
    },
    supportScope: { id: "fixture-routing-v1", regionIds: [...regions] },
    routingLaunchScope: {
      id: "fixture-routing-v1", regionIds: [...regions],
      operatorIds: ["fixture-operator"], lineIds: ["fixture-line"], serviceIds: ["SUBWAY"],
      baseRoutingStationIds: ["station-a"], requiredTransferStationIds: ["station-b"],
      requiredBaseEdgeIds: ["edge-a"], requiredTransferEdgeIds: ["edge-b"],
      admittedStationEvidenceRequired: true, sourceDerivedConnectionEdgeEvidenceRequired: true,
    },
    nationwideRoadmapScope: {
      id: "fixture-nationwide-v1", targets, launchRequiredCount: regions.length, blocksRoutingLaunch: true,
    },
    identityMatrix: {
      requiredSharedFields: ["canonicalStationVersion", "corridorId", "serviceId", "lineageId", "schemaVersion"],
      differentArtifactHashesAllowed: true,
    },
  };
}
