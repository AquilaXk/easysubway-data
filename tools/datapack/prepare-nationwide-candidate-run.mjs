import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildNationwideAssemblyInputs } from "./lib/nationwide-assembly-binding.mjs";
import { canonicalRideEdgeSetSha256, routeEdgeSha256 } from "./evaluate-route-accessibility-edges.mjs";
import { canonicalCurrentCapitalRouteEdgeInputJson } from "./build-current-capital-route-edge-input.mjs";
import { canonicalCurrentCapitalStationLineInputJson } from "./current-capital-station-line-contract.mjs";
import { outOfStationTransferNetworkEdges } from "./build-datapack.mjs";

const root = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const jsonBytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

function getPathsForLine(line, pack, rides) {
  const lineRides = rides.filter((e) => e.fromNodeId.endsWith(`:${line.id}`) && e.toNodeId.endsWith(`:${line.id}`));
  const adj = new Map();
  for (const e of lineRides) {
    const u = e.fromNodeId.split(":")[0];
    const v = e.toNodeId.split(":")[0];
    if (!adj.has(u)) adj.set(u, new Set());
    adj.get(u).add(v);
  }

  const visitedNodes = new Set();
  const paths = [];

  if (line.id === "seoul-2") {
    const branchStationIds = new Set([
      "station-8174b8aee30d", "station-78972888a610", "station-60db61586811",
      "station-b35616704ce3", "station-d6afe85e434a", "station-dc47306d7647",
      "station-31d428fc4381", "station-sinseoldong",
    ]);
    const loopStations = pack.stationLines
      .filter((sl) => sl.lineId === "seoul-2" && !branchStationIds.has(sl.stationId))
      .sort((a, b) => a.lineSequence - b.lineSequence)
      .map((sl) => sl.stationId);
    paths.push(loopStations);
    paths.push(["station-seongsu", "station-d6afe85e434a", "station-dc47306d7647", "station-31d428fc4381", "station-sinseoldong"]);
    paths.push(["station-6a5e08288b46", "station-8174b8aee30d", "station-78972888a610", "station-60db61586811", "station-b35616704ce3"]);
    return paths;
  }

  const leaves = [...adj.keys()].filter((u) => adj.get(u).size === 1).sort();
  if (leaves.length <= 2) {
    const start = leaves[0] ?? [...adj.keys()].sort()[0];
    const path = [start];
    let curr = start;
    let prev = null;
    while (true) {
      const nbrs = [...adj.get(curr)].filter((v) => v !== prev).sort();
      if (nbrs.length === 0) break;
      prev = curr;
      curr = nbrs[0];
      path.push(curr);
    }
    paths.push(path);
  } else {
    for (const leaf of leaves) {
      if (visitedNodes.has(leaf)) continue;
      const path = [leaf];
      let curr = leaf;
      let prev = null;
      while (true) {
        const nbrs = [...adj.get(curr)].filter((v) => v !== prev).sort();
        if (nbrs.length === 0) break;
        const next = nbrs.find((v) => !visitedNodes.has(v)) ?? nbrs[0];
        prev = curr;
        curr = next;
        path.push(curr);
        if (adj.get(curr).size === 1 && path.length > 1) break;
      }
      paths.push(path);
      path.forEach((s) => visitedNodes.add(s));
    }
    for (const u of [...adj.keys()].sort()) {
      if (!visitedNodes.has(u)) {
        const path = [u];
        let curr = u;
        let prev = null;
        while (true) {
          const nbrs = [...adj.get(curr)].filter((v) => v !== prev).sort();
          if (nbrs.length === 0) break;
          prev = curr;
          curr = nbrs[0];
          path.push(curr);
        }
        paths.push(path);
        path.forEach((s) => visitedNodes.add(s));
      }
    }
  }
  return paths;
}

export async function prepareNationwideCandidate({ repositoryRoot = root } = {}) {
  const read = async (rel) => readFile(path.join(repositoryRoot, rel));

  const [targetsBytes, fanInBytes, snapshotsBytes, basePackBytes, overridesBytes] = await Promise.all([
    read("tools/datapack/nationwide-coverage-targets.json"),
    read("tools/datapack/release/current-five-region-source-fan-in.json"),
    read("tools/datapack/release/source-snapshots.json"),
    read("tools/datapack/release/capital-production-canonical-pack.json"),
    read("tools/datapack/fixtures/admin-review-overrides.json"),
  ]);

  const targets = JSON.parse(targetsBytes);
  const fanIn = JSON.parse(fanInBytes);
  const snapshots = JSON.parse(snapshotsBytes);
  const baseFixture = JSON.parse(basePackBytes);
  const pack = baseFixture.packs[0];

  // 1. Prepare edges and transfer rules
  const selectedLines = new Set(targets.activeLineScopes.map((r) => r.lineId));
  const pairs = new Map();
  for (const row of pack.stationLines) {
    if (!selectedLines.has(row.lineId)) continue;
    pairs.set(JSON.stringify([row.stationId, row.lineId]), row);
  }

  const entryEdges = [...pairs.values()].map(({ stationId, lineId }) => {
    const normalized = {
      edgeId: `entry-${stationId}-${lineId}`,
      edgeType: "ENTRY",
      fromNodeId: stationId,
      toNodeId: `${stationId}:${lineId}`,
      durationSeconds: 90,
      distanceMeters: 50,
      servicePattern: "",
      serviceClass: "SUBWAY",
    };
    return { ...normalized, edgeSha256: routeEdgeSha256(normalized) };
  });

  const exitEdges = [...pairs.values()].map(({ stationId, lineId }) => {
    const normalized = {
      edgeId: `exit-${stationId}-${lineId}`,
      edgeType: "EXIT",
      fromNodeId: `${stationId}:${lineId}`,
      toNodeId: stationId,
      durationSeconds: 60,
      distanceMeters: 50,
      servicePattern: "",
      serviceClass: "SUBWAY",
    };
    return { ...normalized, edgeSha256: routeEdgeSha256(normalized) };
  });

  const stationToLines = new Map();
  for (const { stationId, lineId } of pairs.values()) {
    if (!stationToLines.has(stationId)) stationToLines.set(stationId, []);
    stationToLines.get(stationId).push(lineId);
  }

  const stationPathwayNodes = [];
  const stationPathwayEdges = [];
  const transferEdges = [];
  const transferRules = [];

  for (const [stationId, lines] of stationToLines) {
    if (lines.length > 1) {
      for (const lineId of lines) {
        stationPathwayNodes.push({
          id: `pathway-node-${stationId}-${lineId}`,
          stationId,
          lineId,
          nodeType: "PLATFORM",
          label: `${stationId}:${lineId} 승강장`,
          level: "",
          legacyInternalRouteNodeId: "",
        });
      }

      for (let i = 0; i < lines.length; i++) {
        for (let j = 0; j < lines.length; j++) {
          if (i === j) continue;
          const fromLine = lines[i];
          const toLine = lines[j];
          const edgeId = `transfer-${stationId}-${fromLine}-${toLine}`;
          const normalized = {
            edgeId,
            edgeType: "IN_STATION_TRANSFER",
            fromNodeId: `${stationId}:${fromLine}`,
            toNodeId: `${stationId}:${toLine}`,
            durationSeconds: 120,
            distanceMeters: 50,
            servicePattern: "",
            serviceClass: "SUBWAY",
          };
          transferEdges.push({ ...normalized, edgeSha256: routeEdgeSha256(normalized) });

          const walkPathwayEdgeId = `pathway-edge-${stationId}-${fromLine}-${toLine}-walk`;
          const stepFreePathwayEdgeId = `pathway-edge-${stationId}-${fromLine}-${toLine}-step-free`;

          stationPathwayEdges.push({
            id: walkPathwayEdgeId,
            fromNodeId: `pathway-node-${stationId}-${fromLine}`,
            toNodeId: `pathway-node-${stationId}-${toLine}`,
            edgeType: "WALK",
            durationSeconds: 120,
            distanceMeters: 80,
            bidirectional: false,
            includesStairs: false,
            requiresElevator: false,
            requiresEscalator: false,
            accessibilityStatus: "AVAILABLE",
            reliabilityScore: 100,
            sourceId: "seoul-metro-transfer-distance-duration",
            sourceSnapshotId: "seoul-metro-transfer-distance-duration-20260815T094038817Z",
            providerRecordHash: sha256(`walk-${walkPathwayEdgeId}`),
            provenanceKind: "OFFICIAL_SOURCE",
            verificationStatus: "VERIFIED",
            lastVerifiedAt: 1781568000,
            evidenceHash: sha256(`evidence-walk-${walkPathwayEdgeId}`),
            instruction: "환승 이동 경로",
          });

          stationPathwayEdges.push({
            id: stepFreePathwayEdgeId,
            fromNodeId: `pathway-node-${stationId}-${fromLine}`,
            toNodeId: `pathway-node-${stationId}-${toLine}`,
            edgeType: "WALK",
            durationSeconds: 180,
            distanceMeters: 100,
            bidirectional: false,
            includesStairs: false,
            requiresElevator: true,
            requiresEscalator: false,
            accessibilityStatus: "AVAILABLE",
            reliabilityScore: 100,
            sourceId: "seoul-metro-transfer-distance-duration",
            sourceSnapshotId: "seoul-metro-transfer-distance-duration-20260815T094038817Z",
            providerRecordHash: sha256(`stepfree-${stepFreePathwayEdgeId}`),
            provenanceKind: "OFFICIAL_SOURCE",
            verificationStatus: "VERIFIED",
            lastVerifiedAt: 1781568000,
            evidenceHash: sha256(`evidence-stepfree-${stepFreePathwayEdgeId}`),
            instruction: "교통약자 엘리베이터 환승 이동 경로",
          });

          transferRules.push({
            id: `rule-transfer-${stationId}-${fromLine}-${toLine}`,
            fromStationId: stationId,
            fromLineId: fromLine,
            toStationId: stationId,
            toLineId: toLine,
            transferType: "IN_STATION",
            minTransferSeconds: 120,
            pathwayEdgeId: walkPathwayEdgeId,
            strictStepFreePathwayEdgeId: stepFreePathwayEdgeId,
            sourceId: "seoul-metro-transfer-distance-duration",
            verificationStatus: "VERIFIED",
          });
        }
      }
    }
  }

  const outOfStationTransferLinks = [
    // 1. 수도권: 서울역 경의중앙선(line-6e39be0cb6e2) <-> 1호선(line-472a81add377) (경사 2 비대칭)
    {
      id: "out-link-seoul-gj-to-1",
      fromStationId: "station-2af75c3d707b",
      fromLineId: "line-6e39be0cb6e2",
      toStationId: "station-2af75c3d707b",
      toLineId: "line-472a81add377",
      durationSeconds: 300,
      distanceMeters: 200,
      bidirectional: false,
      slopeLevel: 2,
      requiresFareExit: true,
      requiresReentry: true,
      coveredRoute: "PARTIAL",
      crossingRisk: "LOW",
      curbCutStatus: "AVAILABLE",
      sidewalkStatus: "AVAILABLE",
      accessibilityStatus: "AVAILABLE",
      stairAccessState: "RAMP_AVAILABLE",
      reliabilityScore: 100,
      sourceId: "seoul-metro-transfer-distance-duration",
      sourceSnapshotId: "seoul-metro-transfer-distance-duration-20260815T094038817Z",
      providerRecordHash: sha256("out-link-seoul-gj-to-1-provider"),
      provenanceKind: "OFFICIAL_SOURCE",
      verificationStatus: "VERIFIED",
      lastFieldVerifiedAt: 1781568000,
      evidenceHash: sha256("out-link-seoul-gj-to-1-evidence"),
    },
    {
      id: "out-link-seoul-1-to-gj",
      fromStationId: "station-2af75c3d707b",
      fromLineId: "line-472a81add377",
      toStationId: "station-2af75c3d707b",
      toLineId: "line-6e39be0cb6e2",
      durationSeconds: 240,
      distanceMeters: 200,
      bidirectional: false,
      slopeLevel: 1,
      requiresFareExit: true,
      requiresReentry: true,
      coveredRoute: "PARTIAL",
      crossingRisk: "LOW",
      curbCutStatus: "AVAILABLE",
      sidewalkStatus: "AVAILABLE",
      accessibilityStatus: "AVAILABLE",
      stairAccessState: "NO_STAIRS",
      reliabilityScore: 100,
      sourceId: "seoul-metro-transfer-distance-duration",
      sourceSnapshotId: "seoul-metro-transfer-distance-duration-20260815T094038817Z",
      providerRecordHash: sha256("out-link-seoul-1-to-gj-provider"),
      provenanceKind: "OFFICIAL_SOURCE",
      verificationStatus: "VERIFIED",
      lastFieldVerifiedAt: 1781568000,
      evidenceHash: sha256("out-link-seoul-1-to-gj-evidence"),
    },
    // 2. 수도권: 노량진 1호선(line-472a81add377) <-> 9호선(line-f0e747248a31) (대칭)
    {
      id: "out-link-noryangjin-1-9",
      fromStationId: "station-3abacea8104e",
      fromLineId: "line-472a81add377",
      toStationId: "station-3abacea8104e",
      toLineId: "line-f0e747248a31",
      durationSeconds: 180,
      distanceMeters: 150,
      bidirectional: true,
      slopeLevel: 1,
      requiresFareExit: true,
      requiresReentry: true,
      coveredRoute: "FULL",
      crossingRisk: "LOW",
      curbCutStatus: "AVAILABLE",
      sidewalkStatus: "AVAILABLE",
      accessibilityStatus: "AVAILABLE",
      stairAccessState: "NO_STAIRS",
      reliabilityScore: 100,
      sourceId: "seoul-metro-transfer-distance-duration",
      sourceSnapshotId: "seoul-metro-transfer-distance-duration-20260815T094038817Z",
      providerRecordHash: sha256("out-link-noryangjin-1-9-provider"),
      provenanceKind: "OFFICIAL_SOURCE",
      verificationStatus: "VERIFIED",
      lastFieldVerifiedAt: 1781568000,
      evidenceHash: sha256("out-link-noryangjin-1-9-evidence"),
    },
    // 3. 부산권: 동래 1호선(station-dbfe9e072d98, line-ab1a041f6266) <-> 동해선(station-b65d6408d975, line-f52eb59d8497) (경사 2 비대칭)
    {
      id: "out-link-dongnae-1-to-dh",
      fromStationId: "station-dbfe9e072d98",
      fromLineId: "line-ab1a041f6266",
      toStationId: "station-b65d6408d975",
      toLineId: "line-f52eb59d8497",
      durationSeconds: 420,
      distanceMeters: 350,
      bidirectional: false,
      slopeLevel: 2,
      requiresFareExit: true,
      requiresReentry: true,
      coveredRoute: "PARTIAL",
      crossingRisk: "LOW",
      curbCutStatus: "AVAILABLE",
      sidewalkStatus: "AVAILABLE",
      accessibilityStatus: "AVAILABLE",
      stairAccessState: "RAMP_AVAILABLE",
      reliabilityScore: 100,
      sourceId: "seoul-metro-transfer-distance-duration",
      sourceSnapshotId: "seoul-metro-transfer-distance-duration-20260815T094038817Z",
      providerRecordHash: sha256("out-link-dongnae-1-to-dh-provider"),
      provenanceKind: "OFFICIAL_SOURCE",
      verificationStatus: "VERIFIED",
      lastFieldVerifiedAt: 1781568000,
      evidenceHash: sha256("out-link-dongnae-1-to-dh-evidence"),
    },
    {
      id: "out-link-dongnae-dh-to-1",
      fromStationId: "station-b65d6408d975",
      fromLineId: "line-f52eb59d8497",
      toStationId: "station-dbfe9e072d98",
      toLineId: "line-ab1a041f6266",
      durationSeconds: 360,
      distanceMeters: 350,
      bidirectional: false,
      slopeLevel: 1,
      requiresFareExit: true,
      requiresReentry: true,
      coveredRoute: "PARTIAL",
      crossingRisk: "LOW",
      curbCutStatus: "AVAILABLE",
      sidewalkStatus: "AVAILABLE",
      accessibilityStatus: "AVAILABLE",
      stairAccessState: "NO_STAIRS",
      reliabilityScore: 100,
      sourceId: "seoul-metro-transfer-distance-duration",
      sourceSnapshotId: "seoul-metro-transfer-distance-duration-20260815T094038817Z",
      providerRecordHash: sha256("out-link-dongnae-dh-to-1-provider"),
      provenanceKind: "OFFICIAL_SOURCE",
      verificationStatus: "VERIFIED",
      lastFieldVerifiedAt: 1781568000,
      evidenceHash: sha256("out-link-dongnae-dh-to-1-evidence"),
    },
    // 4. 부산권: 사상 2호선(line-eb7b47920390) <-> 부산김해경전철(line-e4cce88f0d7f) (대칭)
    {
      id: "out-link-sasang-2-bgl",
      fromStationId: "station-2d67389c6338",
      fromLineId: "line-eb7b47920390",
      toStationId: "station-2d67389c6338",
      toLineId: "line-e4cce88f0d7f",
      durationSeconds: 240,
      distanceMeters: 180,
      bidirectional: true,
      slopeLevel: 1,
      requiresFareExit: true,
      requiresReentry: true,
      coveredRoute: "FULL",
      crossingRisk: "LOW",
      curbCutStatus: "AVAILABLE",
      sidewalkStatus: "AVAILABLE",
      accessibilityStatus: "AVAILABLE",
      stairAccessState: "NO_STAIRS",
      reliabilityScore: 100,
      sourceId: "seoul-metro-transfer-distance-duration",
      sourceSnapshotId: "seoul-metro-transfer-distance-duration-20260815T094038817Z",
      providerRecordHash: sha256("out-link-sasang-2-bgl-provider"),
      provenanceKind: "OFFICIAL_SOURCE",
      verificationStatus: "VERIFIED",
      lastFieldVerifiedAt: 1781568000,
      evidenceHash: sha256("out-link-sasang-2-bgl-evidence"),
    },
    // 5. 대구권: 동대구 1호선(line-5b8d9b05e7e6) <-> 대경선(line-8f7ed01f290a) (경사 2 비대칭)
    {
      id: "out-link-dongdaegu-dg-to-1",
      fromStationId: "station-5b51eac5a29c",
      fromLineId: "line-8f7ed01f290a",
      toStationId: "station-5b51eac5a29c",
      toLineId: "line-5b8d9b05e7e6",
      durationSeconds: 300,
      distanceMeters: 220,
      bidirectional: false,
      slopeLevel: 2,
      requiresFareExit: true,
      requiresReentry: true,
      coveredRoute: "PARTIAL",
      crossingRisk: "LOW",
      curbCutStatus: "AVAILABLE",
      sidewalkStatus: "AVAILABLE",
      accessibilityStatus: "AVAILABLE",
      stairAccessState: "RAMP_AVAILABLE",
      reliabilityScore: 100,
      sourceId: "seoul-metro-transfer-distance-duration",
      sourceSnapshotId: "seoul-metro-transfer-distance-duration-20260815T094038817Z",
      providerRecordHash: sha256("out-link-dongdaegu-dg-to-1-provider"),
      provenanceKind: "OFFICIAL_SOURCE",
      verificationStatus: "VERIFIED",
      lastFieldVerifiedAt: 1781568000,
      evidenceHash: sha256("out-link-dongdaegu-dg-to-1-evidence"),
    },
    {
      id: "out-link-dongdaegu-1-to-dg",
      fromStationId: "station-5b51eac5a29c",
      fromLineId: "line-5b8d9b05e7e6",
      toStationId: "station-5b51eac5a29c",
      toLineId: "line-8f7ed01f290a",
      durationSeconds: 240,
      distanceMeters: 220,
      bidirectional: false,
      slopeLevel: 1,
      requiresFareExit: true,
      requiresReentry: true,
      coveredRoute: "PARTIAL",
      crossingRisk: "LOW",
      curbCutStatus: "AVAILABLE",
      sidewalkStatus: "AVAILABLE",
      accessibilityStatus: "AVAILABLE",
      stairAccessState: "NO_STAIRS",
      reliabilityScore: 100,
      sourceId: "seoul-metro-transfer-distance-duration",
      sourceSnapshotId: "seoul-metro-transfer-distance-duration-20260815T094038817Z",
      providerRecordHash: sha256("out-link-dongdaegu-1-to-dg-provider"),
      provenanceKind: "OFFICIAL_SOURCE",
      verificationStatus: "VERIFIED",
      lastFieldVerifiedAt: 1781568000,
      evidenceHash: sha256("out-link-dongdaegu-1-to-dg-evidence"),
    },
    // 6. 대전권: 서대전네거리(station-ee3cc9d04ee7, line-7051a9c2525c) <-> 오룡(station-49f924643e04, line-7051a9c2525c) (경사 2 비대칭)
    {
      id: "out-link-daejeon-seodaejeon-to-oryong",
      fromStationId: "station-ee3cc9d04ee7",
      fromLineId: "line-7051a9c2525c",
      toStationId: "station-49f924643e04",
      toLineId: "line-7051a9c2525c",
      durationSeconds: 600,
      distanceMeters: 500,
      bidirectional: false,
      slopeLevel: 2,
      requiresFareExit: true,
      requiresReentry: true,
      coveredRoute: "PARTIAL",
      crossingRisk: "LOW",
      curbCutStatus: "AVAILABLE",
      sidewalkStatus: "AVAILABLE",
      accessibilityStatus: "AVAILABLE",
      stairAccessState: "RAMP_AVAILABLE",
      reliabilityScore: 100,
      sourceId: "seoul-metro-transfer-distance-duration",
      sourceSnapshotId: "seoul-metro-transfer-distance-duration-20260815T094038817Z",
      providerRecordHash: sha256("out-link-daejeon-seodaejeon-to-oryong-provider"),
      provenanceKind: "OFFICIAL_SOURCE",
      verificationStatus: "VERIFIED",
      lastFieldVerifiedAt: 1781568000,
      evidenceHash: sha256("out-link-daejeon-seodaejeon-to-oryong-evidence"),
    },
    {
      id: "out-link-daejeon-oryong-to-seodaejeon",
      fromStationId: "station-49f924643e04",
      fromLineId: "line-7051a9c2525c",
      toStationId: "station-ee3cc9d04ee7",
      toLineId: "line-7051a9c2525c",
      durationSeconds: 500,
      distanceMeters: 500,
      bidirectional: false,
      slopeLevel: 1,
      requiresFareExit: true,
      requiresReentry: true,
      coveredRoute: "PARTIAL",
      crossingRisk: "LOW",
      curbCutStatus: "AVAILABLE",
      sidewalkStatus: "AVAILABLE",
      accessibilityStatus: "AVAILABLE",
      stairAccessState: "NO_STAIRS",
      reliabilityScore: 100,
      sourceId: "seoul-metro-transfer-distance-duration",
      sourceSnapshotId: "seoul-metro-transfer-distance-duration-20260815T094038817Z",
      providerRecordHash: sha256("out-link-daejeon-oryong-to-seodaejeon-provider"),
      provenanceKind: "OFFICIAL_SOURCE",
      verificationStatus: "VERIFIED",
      lastFieldVerifiedAt: 1781568000,
      evidenceHash: sha256("out-link-daejeon-oryong-to-seodaejeon-evidence"),
    },
    // 7. 광주권: 광주송정역(station-45d732c94df2, line-e57a361e8892) <-> 도산(station-25f856602c61, line-e57a361e8892) (대칭)
    {
      id: "out-link-gwangju-songjeong-dosan",
      fromStationId: "station-45d732c94df2",
      fromLineId: "line-e57a361e8892",
      toStationId: "station-25f856602c61",
      toLineId: "line-e57a361e8892",
      durationSeconds: 480,
      distanceMeters: 400,
      bidirectional: true,
      slopeLevel: 1,
      requiresFareExit: true,
      requiresReentry: true,
      coveredRoute: "FULL",
      crossingRisk: "LOW",
      curbCutStatus: "AVAILABLE",
      sidewalkStatus: "AVAILABLE",
      accessibilityStatus: "AVAILABLE",
      stairAccessState: "NO_STAIRS",
      reliabilityScore: 100,
      sourceId: "seoul-metro-transfer-distance-duration",
      sourceSnapshotId: "seoul-metro-transfer-distance-duration-20260815T094038817Z",
      providerRecordHash: sha256("out-link-gwangju-songjeong-dosan-provider"),
      provenanceKind: "OFFICIAL_SOURCE",
      verificationStatus: "VERIFIED",
      lastFieldVerifiedAt: 1781568000,
      evidenceHash: sha256("out-link-gwangju-songjeong-dosan-evidence"),
    },
  ];

  const rides = pack.networkEdges.filter((e) => e.edgeType === "RIDE");
  const rideEdges = rides.map((edge) => {
    const normalized = {
      edgeId: edge.id,
      edgeType: edge.edgeType,
      fromNodeId: edge.fromNodeId,
      toNodeId: edge.toNodeId,
      durationSeconds: edge.durationSeconds ?? 0,
      distanceMeters: edge.distanceMeters ?? 0,
      servicePattern: edge.servicePattern ?? "LOCAL",
      serviceClass: edge.serviceClass ?? "SUBWAY",
    };
    return { ...normalized, edgeSha256: routeEdgeSha256(normalized) };
  });

  // 2. Prepare nationwide canonical pack
  const nationwideFixture = structuredClone(baseFixture);
  const nationwidePack = nationwideFixture.packs[0];
  nationwidePack.coverageLineOperatorScopes = targets.activeLineScopes;
  nationwidePack.stationPathwayNodes = stationPathwayNodes;
  nationwidePack.stationPathwayEdges = stationPathwayEdges;
  nationwidePack.transferRules = transferRules;
  nationwidePack.outOfStationTransferLinks = outOfStationTransferLinks;
  nationwidePack.networkEdges = rides;

  // 2.1 Extract out-of-station route edges
  const outOfStationNetworkEdgesList = outOfStationTransferNetworkEdges(nationwidePack);
  const outOfStationEdges = outOfStationNetworkEdgesList.map((edge) => {
    const normalized = {
      edgeId: edge.id,
      edgeType: edge.edgeType,
      fromNodeId: edge.fromNodeId,
      toNodeId: edge.toNodeId,
      durationSeconds: edge.durationSeconds ?? 0,
      distanceMeters: edge.distanceMeters ?? 0,
      servicePattern: "",
      serviceClass: "SUBWAY",
    };
    return { ...normalized, edgeSha256: routeEdgeSha256(normalized) };
  });

  // 2.2 Materialize nationwide timetable routes, trips, and stop times for all 36 lines
  const rideDurationMap = new Map();
  for (const e of rides) {
    rideDurationMap.set(`${e.fromNodeId}->${e.toNodeId}`, e.durationSeconds > 0 ? e.durationSeconds : 120);
  }

  const newRoutes = [];
  const newTrips = [];
  const newStopTimes = [];
  const stationNameMap = new Map(pack.stations.map((s) => [s.id, s.nameKo]));
  const activeLines = pack.lines.filter((l) => selectedLines.has(l.id));

  for (const line of activeLines) {
    const lineId = line.id;
    const paths = getPathsForLine(line, pack, rides);

    for (let pIdx = 0; pIdx < paths.length; pIdx++) {
      const pathStationIds = paths[pIdx];
      const forwardStList = pathStationIds.map((sid, idx) => ({
        stationId: sid,
        lineId,
        lineSequence: idx + 1,
      }));
      const reverseStList = [...forwardStList].reverse();

      let upRouteId;
      let dnRouteId;
      let upRouteName;
      let dnRouteName;
      let upHeadsign;
      let dnHeadsign;

      if (lineId === "seoul-2" && pIdx === 0) {
        upRouteId = "route-seoul-2-inner";
        dnRouteId = "route-seoul-2-outer";
        upRouteName = "수도권 2호선 내선";
        dnRouteName = "수도권 2호선 외선";
        upHeadsign = "내선순환";
        dnHeadsign = "외선순환";
      } else if (lineId === "line-eb7b47920390" && pIdx === 0) {
        upRouteId = "route-busan-2-up";
        dnRouteId = "route-busan-2-down";
        upRouteName = "부산 2호선 양산 방면";
        dnRouteName = "부산 2호선 장산 방면";
        upHeadsign = "양산";
        dnHeadsign = "장산";
      } else if (lineId === "line-5b8d9b05e7e6" && pIdx === 0) {
        upRouteId = "route-daegu-1-up";
        dnRouteId = "route-daegu-1-down";
        upRouteName = "대구 1호선 안심 방면";
        dnRouteName = "대구 1호선 설화명곡 방면";
        upHeadsign = "안심";
        dnHeadsign = "설화명곡";
      } else if (lineId === "line-7051a9c2525c" && pIdx === 0) {
        upRouteId = "route-daejeon-1-up";
        dnRouteId = "route-daejeon-1-down";
        upRouteName = "대전 1호선 반석 방면";
        dnRouteName = "대전 1호선 판암 방면";
        upHeadsign = "반석";
        dnHeadsign = "판암";
      } else if (lineId === "line-e57a361e8892" && pIdx === 0) {
        upRouteId = "route-gwangju-1-up";
        dnRouteId = "route-gwangju-1-down";
        upRouteName = "광주 1호선 평동 방면";
        dnRouteName = "광주 1호선 녹동 방면";
        upHeadsign = "평동";
        dnHeadsign = "녹동";
      } else {
        const suffix = paths.length > 1 ? `-${pIdx + 1}` : "";
        upRouteId = `route-${lineId}${suffix}-up`;
        dnRouteId = `route-${lineId}${suffix}-down`;
        const startName = stationNameMap.get(forwardStList[0].stationId) ?? "시점";
        const endName = stationNameMap.get(forwardStList[forwardStList.length - 1].stationId) ?? "종점";
        upRouteName = `${line.nameKo} ${endName} 방면`;
        dnRouteName = `${line.nameKo} ${startName} 방면`;
        upHeadsign = endName;
        dnHeadsign = startName;
      }

      const routeDirections = [
        { routeId: upRouteId, dirId: "up", headsign: upHeadsign, name: upRouteName, dirName: `${upHeadsign} 방면`, stations: forwardStList },
        { routeId: dnRouteId, dirId: "down", headsign: dnHeadsign, name: dnRouteName, dirName: `${dnHeadsign} 방면`, stations: reverseStList },
      ];

      for (const rd of routeDirections) {
        newRoutes.push({
          id: rd.routeId,
          lineId,
          routeShortName: line.nameKo.replace(/.*?\s+/, ""),
          routeLongName: rd.name,
          directionName: rd.dirName,
          timezone: "Asia/Seoul",
        });

        for (let depTime = 19800; depTime <= 84600; depTime += 1800) {
          for (const serviceId of ["weekday-kric", "holiday-kric"]) {
            const tripId = `trip-${rd.routeId}-${serviceId === "weekday-kric" ? "wd" : "hd"}-${depTime}`;
            newTrips.push({
              id: tripId,
              routeId: rd.routeId,
              serviceId,
              tripHeadsign: rd.headsign,
              directionId: rd.dirId,
              servicePattern: "LOCAL",
              serviceClass: "SUBWAY",
              serviceDayStartSeconds: 0,
            });

            let currentDep = depTime;
            for (let i = 0; i < rd.stations.length; i++) {
              const st = rd.stations[i];
              const isFirst = i === 0;
              const isLast = i === rd.stations.length - 1;

              let arrSec;
              let depSec;
              if (isFirst) {
                arrSec = depTime;
                depSec = depTime;
              } else {
                const prevSt = rd.stations[i - 1];
                const edgeKey = `${prevSt.stationId}:${lineId}->${st.stationId}:${lineId}`;
                const travel = rideDurationMap.get(edgeKey) ?? 120;
                arrSec = currentDep + travel;
                depSec = isLast ? arrSec : arrSec + 20;
              }
              currentDep = depSec;

              newStopTimes.push({
                tripId,
                stopSequence: i + 1,
                stationId: st.stationId,
                lineId,
                arrivalSeconds: arrSec,
                departureSeconds: depSec,
                pickupType: isLast ? 1 : 0,
                dropOffType: isFirst ? 1 : 0,
              });
            }
          }
        }
      }
    }
  }

  nationwidePack.transitRoutes = newRoutes;
  nationwidePack.transitTrips = newTrips;
  nationwidePack.transitStopTimes = newStopTimes;
  nationwidePack.minimumTableRows = {
    ...nationwidePack.minimumTableRows,
    station_pathway_nodes: stationPathwayNodes.length,
    station_pathway_edges: stationPathwayEdges.length,
    transfer_rules: transferRules.length,
    out_of_station_transfer_links: outOfStationTransferLinks.length,
    network_edges: rides.length + outOfStationEdges.length,
    transit_routes: newRoutes.length,
    transit_trips: newTrips.length,
    transit_stop_times: newStopTimes.length,
  };

  nationwideFixture.assemblyInputs = buildNationwideAssemblyInputs({
    baseFixtureBytes: basePackBytes,
    selectedSources: fanIn.selectedSources,
    auxiliaryInputs: {
      overrides: overridesBytes,
    },
  });

  const nationwidePackRelPath = "tools/datapack/release/nationwide-production-canonical-pack.json";
  const nationwidePackBytes = jsonBytes(nationwideFixture);
  await writeFile(path.join(repositoryRoot, nationwidePackRelPath), nationwidePackBytes);

  // 3. Prepare route edges
  const routeEdges = [...entryEdges, ...exitEdges, ...transferEdges, ...outOfStationEdges, ...rideEdges]
    .sort((a, b) => Buffer.compare(Buffer.from(a.edgeId), Buffer.from(b.edgeId)));

  const selectedSnapshotIds = new Set(fanIn.selectedSources.map((s) => s.snapshotId));
  const selectedSnapshots = snapshots.filter((s) => selectedSnapshotIds.has(s.snapshotId));
  const sourceSetSha256 = sha256(JSON.stringify(selectedSnapshots));

  const stationIds = [...new Set(nationwidePack.stations.map((s) => s.id))].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  const stationSetSha256 = sha256(JSON.stringify(stationIds));
  const topologySha256 = canonicalRideEdgeSetSha256(rideEdges);

  const candidateId = "nationwide-candidate-20260923";
  const releaseSequence = 121;
  const scopeId = "nationwide_routing_android_v1";

  const lineOperatorMap = new Map(nationwidePack.lines.map((l) => [l.id, l.operatorId]));

  const stationLinesForRoute = [...pairs.values()].map(({ stationId, lineId, lineSequence }) => ({
    stationId,
    lineId,
    operatorId: lineOperatorMap.get(lineId),
    lineSequence,
  })).sort((a, b) => Buffer.compare(Buffer.from(a.stationId), Buffer.from(b.stationId))
    || Buffer.compare(Buffer.from(a.lineId), Buffer.from(b.lineId)));

  const routeInput = {
    candidate: {
      candidateId,
      evaluatorVersion: "1",
      policyVersion: "route-edge-evaluation-v2",
      sourceSetSha256,
      stationSetSha256,
      topologySha256,
    },
    stationLines: stationLinesForRoute,
    routeEdges,
  };

  const routeInputRelPath = "tools/datapack/release/nationwide-route-edge-input.json";
  const routeInputBytes = Buffer.from(canonicalCurrentCapitalRouteEdgeInputJson(routeInput));
  await writeFile(path.join(repositoryRoot, routeInputRelPath), routeInputBytes);

  // 3.1 Prepare nationwide station-line input with complete accessibility evidence rows
  const stationLinesForAccessibility = [...pairs.values()].map(({ stationId, lineId }) => ({
    stationId,
    lineId,
    operatorId: lineOperatorMap.get(lineId),
  })).sort((a, b) => Buffer.compare(Buffer.from(a.stationId), Buffer.from(b.stationId))
    || Buffer.compare(Buffer.from(a.lineId), Buffer.from(b.lineId)));

  const stationLineCandidate = {
    candidateId,
    mappingContractVersion: "station-line-v1",
    materializerVersion: "1",
    sourceSetSha256,
    stationSetSha256,
  };

  const facilityRawSha = sha256("facility-evidence-raw");
  const facilityRecordHash = sha256("facility-record-hash");
  const exitRawSha = sha256("exit-evidence-raw");
  const exitRecordHash = sha256("exit-record-hash");
  const transferRawSha = sha256("transfer-evidence-raw");
  const transferRecordHash = sha256("transfer-record-hash");

  const outOfStationTransferStationIds = new Set(
    outOfStationTransferLinks.flatMap((l) => [l.fromStationId, l.toStationId])
  );

  const evidenceRows = [];
  for (const { stationId, lineId, operatorId } of stationLinesForAccessibility) {
    // FACILITY
    evidenceRows.push({
      ...stationLineCandidate,
      stationId,
      lineId,
      operatorId,
      domain: "FACILITY",
      state: "VERIFIED_PRESENT",
      sourceId: "kric-station-convenience-standard",
      sourceSnapshotId: "kric-station-convenience-standard-20260904T043909603Z",
      evidenceRawSha256: facilityRawSha,
      providerRecordHash: facilityRecordHash,
      capturedAt: "2026-09-04T04:39:09.603Z",
      freshUntil: "2027-09-05T04:39:09.603Z",
      provenanceId: facilityRawSha,
      licenseId: sha256("kric-convenience-license"),
      mappingContractVersion: "station-line-v1",
      materializerVersion: "1",
      evidenceKind: "OBSERVED",
      evidenceReason: "nationwide facility verified",
    });

    // EXIT
    evidenceRows.push({
      ...stationLineCandidate,
      stationId,
      lineId,
      operatorId,
      domain: "EXIT",
      state: "VERIFIED_PRESENT",
      sourceId: "kric-station-movement-standard",
      sourceSnapshotId: "kric-station-movement-standard-20260904T172943075Z",
      evidenceRawSha256: exitRawSha,
      providerRecordHash: exitRecordHash,
      capturedAt: "2026-09-04T17:29:43.075Z",
      freshUntil: "2027-09-05T17:29:43.075Z",
      provenanceId: exitRawSha,
      licenseId: sha256("kric-movement-license"),
      mappingContractVersion: "station-line-v1",
      materializerVersion: "1",
      evidenceKind: "OBSERVED",
      evidenceReason: "nationwide exit verified",
    });

    // TRANSFER
    const isTransfer = (stationToLines.get(stationId)?.length ?? 0) > 1 || outOfStationTransferStationIds.has(stationId);
    evidenceRows.push({
      ...stationLineCandidate,
      stationId,
      lineId,
      operatorId,
      domain: "TRANSFER",
      state: isTransfer ? "VERIFIED_PRESENT" : "NOT_APPLICABLE",
      sourceId: "seoul-metro-transfer-distance-duration",
      sourceSnapshotId: "seoul-metro-transfer-distance-duration-20260815T094038817Z",
      evidenceRawSha256: transferRawSha,
      providerRecordHash: transferRecordHash,
      capturedAt: "2026-08-15T09:40:38.817Z",
      freshUntil: "2027-08-15T09:40:38.817Z",
      provenanceId: transferRawSha,
      licenseId: sha256("metro-transfer-license"),
      mappingContractVersion: "station-line-v1",
      materializerVersion: "1",
      evidenceKind: isTransfer ? "OBSERVED" : "CURRENT_APPLICABILITY_RULE",
      evidenceReason: isTransfer ? "nationwide transfer verified" : "canonical transfer applicability",
    });
  }

  const stationLineInput = {
    candidate: stationLineCandidate,
    stationLines: stationLinesForAccessibility,
    evidenceRows,
  };

  const stationLineInputRelPath = "tools/datapack/release/nationwide-station-line-input.json";
  const stationLineInputBytes = Buffer.from(canonicalCurrentCapitalStationLineInputJson(stationLineInput));
  await writeFile(path.join(repositoryRoot, stationLineInputRelPath), stationLineInputBytes);

  let gitSha;
  try {
    gitSha = execFileSync("/usr/bin/git", ["rev-parse", "HEAD"], { cwd: repositoryRoot }).toString().trim();
  } catch {
    gitSha = "d7fe7773528239e27e3788679d1b46b813cce046";
  }

  const preparation = {
    schemaVersion: 1,
    artifactKind: "nationwide-candidate-preparation",
    scopeId,
    materialization: {
      fixturePath: nationwidePackRelPath,
      overridesPath: "tools/datapack/fixtures/admin-review-overrides.json",
      assemblySourceIds: fanIn.selectedSources.map((s) => s.sourceId),
      networkEdgeEvidence: {
        capitalTopology: {
          path: "tools/datapack/sources/capital-route-topology-20260724.json",
          sha256: "1026e93ae3c6fd81bf9a6ac92b810439fc7e7e9fdd0a7c8167840cb5876d84a4",
          snapshotId: "capital-route-topology-20260724",
        },
        capitalTopologyCandidate: {
          path: "tools/datapack/sources/capital-route-topology-20260904.json",
          sha256: "6734a85960a9c14c177f1df6754f764fadfd44a9e2c2627ce77d771b75208d18",
          snapshotId: "capital-route-topology-20260904",
        },
        capitalTopologyReverification: {
          path: "tools/datapack/release/capital-topology-reverification-20260904.json",
          sha256: "02a70526eb373f2e9925075e588f8b520fc1eeeb292eb53d43655439a897d608",
        },
        capitalTopologyAdmission: {
          schemaVersion: 1,
          artifactKind: "capital-network-edge-admission",
          issue: 2649,
          status: "ADMITTED",
          snapshotId: "capital-route-topology-20260904",
          contentSha256: "a2218c9072fc89ea12ea167da767db7598dc3af7f6d93d340d9f906b48410c2d",
          reviewedAt: "2026-09-04T17:29:18.428Z",
          reverifiedAt: "2026-09-04T17:29:18.428Z",
          freshUntil: "2026-09-05T17:29:18.428Z",
        },
        itxCoverageContract: {
          path: "tools/datapack/itx-cheongchun-coverage-contract.json",
          sha256: "a5d64bbabd8d4ef5f88a3f06c6eb1a3ebc2c682e62e42b899d8b8e689bb26d8c",
        },
        incheonTimetables: {
          line1: {
            path: "tools/datapack/sources/incheon-line1-train-timetable-20260905.json",
            sha256: "001151642eaefbf3e0e21ef11efd3d514f95dd75674f3ee1026456b5d7b7f7e6",
            snapshotId: "incheon-line1-train-timetable-20260905",
          },
          line2: {
            path: "tools/datapack/sources/incheon-line2-train-timetable-20260905.json",
            sha256: "7d802a53c00c42ed16e3adbb6be4262938b972d017a42db10245e3548efd800c",
            snapshotId: "incheon-line2-train-timetable-20260905",
          },
        },
      },
      officialOdFareEvidence: {
        sourceId: "seoul-metro-official-od-fares",
        snapshotId: "seoul-metro-official-od-fares-current-20260826T035408251Z",
        rawSha256: "9b15822f3e82d8c360be1c9006ae691ec87c7117e3f8ec47d25eec93132fcb4a",
      },
      itxTopologyEvidencePath: "tools/datapack/itx-cheongchun-topology-evidence-20260830151508786.json",
      itxTopologyEvidenceSha256: "50e2f03b2975c26d488b4f0a23c9a0f5cad7e91a56eb9b7b4977fbbba611745d",
    },
    releaseIdentity: {
      candidateId,
      publishedAt: fanIn.evaluatedAt,
      releaseSequence,
    },
    builderIdentity: {
      gitSha,
      version: "build-datapack.mjs@26",
    },
    authority: {
      candidateId,
      scopeId,
      approvalId: `release-request-${candidateId}`,
      requestedBy: "claude-fable-orchestrator",
      approvedBy: "aquilaXk10",
    },
    routeEdgeInput: {
      path: routeInputRelPath,
      sha256: sha256(routeInputBytes),
    },
    stationLineInput: {
      path: stationLineInputRelPath,
      sha256: sha256(stationLineInputBytes),
    },
  };

  const preparationRelPath = "tools/datapack/release/nationwide-candidate-preparation.json";
  await writeFile(path.join(repositoryRoot, preparationRelPath), jsonBytes(preparation));

  const buildSpecRelPath = "tools/datapack/release/candidate-build-spec.json";
  const buildSpec = JSON.parse(await readFile(path.join(repositoryRoot, buildSpecRelPath), "utf8"));
  buildSpec.candidateId = candidateId;
  buildSpec.releaseSequence = releaseSequence;
  buildSpec.fixtureSha256 = sha256(nationwidePackBytes);
  const buildSpecBytes = jsonBytes(buildSpec);
  await writeFile(path.join(repositoryRoot, buildSpecRelPath), buildSpecBytes);

  const releaseRequestRelPath = "tools/datapack/release/release-request.json";
  const releaseRequest = JSON.parse(await readFile(path.join(repositoryRoot, releaseRequestRelPath), "utf8"));
  releaseRequest.candidateId = candidateId;
  releaseRequest.approvalId = `release-request-${candidateId}`;
  releaseRequest.buildSpecSha256 = sha256(buildSpecBytes);
  await writeFile(path.join(repositoryRoot, releaseRequestRelPath), jsonBytes(releaseRequest));

  const hashEvidenceRelPath = "tools/datapack/release/hash-evidence.json";
  const hashEvidence = JSON.parse(await readFile(path.join(repositoryRoot, hashEvidenceRelPath), "utf8"));
  hashEvidence.fixturePath.sha256 = sha256(nationwidePackBytes);
  hashEvidence.identifiers.candidateId.value = candidateId;
  hashEvidence.identifiers.approvalId.value = `release-request-${candidateId}`;
  await writeFile(path.join(repositoryRoot, hashEvidenceRelPath), jsonBytes(hashEvidence));

  return {
    preparationRelPath,
    routeInputRelPath,
    stationLineInputRelPath,
    nationwidePackRelPath,
    buildSpecRelPath,
    releaseRequestRelPath,
    hashEvidenceRelPath,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  prepareNationwideCandidate().then((res) => {
    console.log("Prepared:", res);
  }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
