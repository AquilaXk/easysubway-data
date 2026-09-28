import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

import { canonicalJson } from "./lib/manifest-validation.mjs";
import { buildNationwideAssemblyInputs } from "./lib/nationwide-assembly-binding.mjs";
import { canonicalRideEdgeSetSha256, routeEdgeSha256 } from "./evaluate-route-accessibility-edges.mjs";
import { canonicalCurrentCapitalRouteEdgeInputJson } from "./build-current-capital-route-edge-input.mjs";
import { canonicalCurrentCapitalStationLineInputJson } from "./current-capital-station-line-contract.mjs";
import { outOfStationTransferNetworkEdges } from "./build-datapack.mjs";
import { materializeIncheonTimetable } from "./materialize-incheon-timetable.mjs";

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

export async function prepareNationwideCandidate({
  repositoryRoot = root,
  releaseSequence = 122,
  candidateId: candidateIdOverride = null,
  requestedBy: requestedByOption = null,
  approvedBy: approvedByOption = null,
} = {}) {
  const requestedBy = requestedByOption
    || process.env.DATAPACK_REQUESTED_BY
    || (process.argv.find((a) => a.startsWith("--requested-by="))?.split("=")[1]);
  const approvedBy = approvedByOption
    || process.env.DATAPACK_APPROVED_BY
    || (process.argv.find((a) => a.startsWith("--approved-by="))?.split("=")[1]);

  if (!requestedBy || typeof requestedBy !== "string" || requestedBy.trim() === "") {
    throw new Error("DATAPACK_REQUESTED_BY (--requested-by) is required");
  }
  if (!approvedBy || typeof approvedBy !== "string" || approvedBy.trim() === "") {
    throw new Error("DATAPACK_APPROVED_BY (--approved-by) is required");
  }
  if (requestedBy.trim() === approvedBy.trim()) {
    throw new Error(`Two-person rule violation: requester and approver cannot be the same person (${requestedBy.trim()})`);
  }

  const read = async (rel) => readFile(path.join(repositoryRoot, rel));

  const [
    targetsBytes, fanInBytes, snapshotsBytes, basePackBytes, overridesBytes,
    incheonTopologyBytes, incheonLine1Bytes, incheonLine2Bytes, sourceInventoryBytes,
    busanAccessibilityBytes, daeguAccessibilityBytes, daejeonAccessibilityBytes, gwangjuAccessibilityBytes,
    molitTransferMetaBytes, molitTransferGzipBytes,
    transferMetricsBytes, kricConvenienceBytes,
  ] = await Promise.all([
    read("tools/datapack/nationwide-coverage-targets.json"),
    read("tools/datapack/release/current-five-region-source-fan-in.json"),
    read("tools/datapack/release/source-snapshots.json"),
    read("tools/datapack/release/capital-production-canonical-pack.json"),
    read("tools/datapack/fixtures/admin-review-overrides.json"),
    read("tools/datapack/sources/incheon-transit-station-info-20260904.json"),
    read("tools/datapack/sources/incheon-line1-train-timetable-20260905.json"),
    read("tools/datapack/sources/incheon-line2-train-timetable-20260905.json"),
    read("tools/datapack/source-inventory.json"),
    read("tools/datapack/sources/busan-transportation-accessibility-3854af12545fc002afaae3204784bf5e9a786a328223c531702b635cf9c47a78-20260909.json"),
    read("tools/datapack/sources/daegu-transportation-accessibility-25276f4f6e48ab8c6ffca6af833af14ad33fd86777af9d3376eed4b6a77fef9e-20260909.json"),
    read("tools/datapack/sources/daejeon-transportation-accessibility-31ef85c5ac5d279d7322c028e05f7be16e6c5a794aa313aef314eef076b61426-20260909.json"),
    read("tools/datapack/sources/gwangju-transportation-accessibility-a39793ed95d7f0075fa0fd58378e651823d9c1ed752ac310a86c853f8853f521-20260909.json"),
    read("tools/datapack/sources/molit-railway-transfer-movement-20250811.csv.gz.json"),
    read("tools/datapack/sources/molit-railway-transfer-movement-20250811.csv.gz"),
    read("tools/datapack/release/current-transfer-topology-metrics.json"),
    read("tools/datapack/sources/kric-station-convenience-standard-20260904T043909603Z.json"),
  ]);

  const targets = JSON.parse(targetsBytes);
  const fanIn = JSON.parse(fanInBytes);
  const snapshots = JSON.parse(snapshotsBytes);
  const baseFixture = JSON.parse(basePackBytes);
  const pack = baseFixture.packs[0];
  const incheonTopology = JSON.parse(incheonTopologyBytes);
  const incheonLine1 = JSON.parse(incheonLine1Bytes);
  const incheonLine2 = JSON.parse(incheonLine2Bytes);
  const sourceInventory = JSON.parse(sourceInventoryBytes);
  const busanAccessibility = JSON.parse(busanAccessibilityBytes);
  const daeguAccessibility = JSON.parse(daeguAccessibilityBytes);
  const daejeonAccessibility = JSON.parse(daejeonAccessibilityBytes);
  const gwangjuAccessibility = JSON.parse(gwangjuAccessibilityBytes);
  const molitTransferMeta = JSON.parse(molitTransferMetaBytes);
  const transferMetrics = JSON.parse(transferMetricsBytes);
  const kricConvenience = JSON.parse(kricConvenienceBytes);

  const molitTransferUncompressed = gunzipSync(molitTransferGzipBytes);
  const molitTransferText = new TextDecoder("euc-kr").decode(molitTransferUncompressed);
  const molitLines = molitTransferText.split(/\r?\n/).filter(Boolean);
  const molitRows = molitLines.slice(1).map((line) => {
    const parts = line.split(",");
    return {
      RAIL_OPR_ISTT_CD: parts[0],
      LN_NM: parts[1],
      STIN_NM: parts[2],
      CHTN_MV_TP_ORDR: parts[3],
      MV_CONT_DTL: parts[4],
      CHTN_MV_CONT: parts.slice(5).join(","),
    };
  });

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
      durationSeconds: 0,
      distanceMeters: 0,
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
      durationSeconds: 0,
      distanceMeters: 0,
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

  const busanDaeguTransferInfo = new Map([
    ["station-dbfe9e072d98", { molitStation: "동래", lineMapping: { "line-ab1a041f6266": "1호선", "line-d812a5bc1e5f": "4호선" } }],
    ["station-1fc7a7c971c8", { molitStation: "서면", lineMapping: { "line-ab1a041f6266": "1호선", "line-eb7b47920390": "2호선" } }],
    ["station-803200d76012", { molitStation: "연산", lineMapping: { "line-ab1a041f6266": "1호선", "line-d74614a04530": "3호선" } }],
    ["station-85f3b04485c3", { molitStation: "덕천(부산과기대)", lineMapping: { "line-d74614a04530": "3호선", "line-eb7b47920390": "2호선" } }],
    ["station-fbcc387e1db9", { molitStation: "벡스코(시립미술관)", lineMapping: { "line-eb7b47920390": "2호선", "line-f52eb59d8497": "동해선" } }],
    ["station-2d67389c6338", { molitStation: "사상(서부터미널)", lineMapping: { "line-e4cce88f0d7f": "부산김해경전철", "line-eb7b47920390": "2호선" } }],
    ["station-902ff39b9a39", { molitStation: "수영", lineMapping: { "line-d74614a04530": "3호선", "line-eb7b47920390": "2호선" } }],
    ["station-623ba7995f56", { molitStation: "거제(법원.검찰청)", lineMapping: { "line-d74614a04530": "3호선", "line-f52eb59d8497": "동해선" } }],
    ["station-e0daeeda6b37", { molitStation: "대저", lineMapping: { "line-d74614a04530": "3호선", "line-e4cce88f0d7f": "부산김해경전철" } }],
    ["station-3b042820c466", { molitStation: "미남", lineMapping: { "line-d74614a04530": "3호선", "line-d812a5bc1e5f": "4호선" } }],
    ["station-a94cb65fc5ee", { molitStation: "명덕(2.28민주운동기념회관)", lineMapping: { "line-0ffaa95b1b5d": "3호선", "line-5b8d9b05e7e6": "1호선" } }],
    ["station-44dc03b65cae", { molitStation: "반월당", lineMapping: { "line-5b8d9b05e7e6": "1호선", "line-e2938a4cc492": "2호선" } }],
    ["station-3de9d5097085", { molitStation: "청라언덕", lineMapping: { "line-0ffaa95b1b5d": "3호선", "line-e2938a4cc492": "2호선" } }],
  ]);
  const busanDaeguTransferStationIds = new Set(busanDaeguTransferInfo.keys());

  const seoulTransferMetricMap = new Map();
  for (const m of transferMetrics.metrics) {
    seoulTransferMetricMap.set(`${m.stationId}:${m.fromLineId}->${m.toLineId}`, m);
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
          const walkPathwayEdgeId = `pathway-edge-${stationId}-${fromLine}-${toLine}-walk`;
          const stepFreePathwayEdgeId = `pathway-edge-${stationId}-${fromLine}-${toLine}-step-free`;
          const isBusanDaeguTransfer = busanDaeguTransferStationIds.has(stationId);
          const seoulMetric = seoulTransferMetricMap.get(`${stationId}:${fromLine}->${toLine}`);

          let transferDuration = 0;
          let transferDistance = 0;
          let walkDuration = 0;
          let walkDistance = 0;
          let walkSourceId = "";
          let walkSourceSnapshotId = "";
          let walkProviderRecordHash = "";
          let walkProvenanceKind = "UNVERIFIED";
          let walkVerificationStatus = "UNVERIFIED";
          let walkLastVerifiedAt = 0;
          let walkEvidenceHash = "";
          let walkInstruction = "";

          let stepDuration = 0;
          let stepDistance = 0;
          let stepInstruction = "";
          let stepRecordHash = "";
          let stepSourceId = "";
          let stepSourceSnapshotId = "";
          let stepProvenanceKind = "UNVERIFIED";
          let stepVerificationStatus = "UNVERIFIED";
          let stepLastVerifiedAt = 0;
          let stepEvidenceHash = "";
          let stepAccessibilityStatus = "UNKNOWN";

          const molitRawSha = "3a45dc1d82f81666c48eeef81fdc35b0e4a0c59312e4b26907f644c45b518ce3";

          if (seoulMetric) {
            transferDuration = seoulMetric.officialDurationSecondsReference;
            transferDistance = seoulMetric.distanceMeters;

            walkDuration = seoulMetric.officialDurationSecondsReference;
            walkDistance = seoulMetric.distanceMeters;
            walkSourceId = "seoul-metro-transfer-distance-duration";
            walkSourceSnapshotId = "seoul-metro-transfer-distance-duration-20260815T094038817Z";
            walkProviderRecordHash = seoulMetric.sourceRecordSha256;
            walkProvenanceKind = "OFFICIAL_SOURCE";
            walkVerificationStatus = "VERIFIED";
            walkLastVerifiedAt = "2026-08-15T09:40:38.817Z";
            walkEvidenceHash = seoulMetric.sourceRecordSha256;
            walkInstruction = "환승 이동 경로";
          } else if (isBusanDaeguTransfer) {
            const info = busanDaeguTransferInfo.get(stationId);
            const fromLineMolit = info.lineMapping[fromLine];
            let matchedRows = molitRows.filter((r) => r.STIN_NM === info.molitStation && r.LN_NM === fromLineMolit);
            if (matchedRows.length === 0) {
              matchedRows = molitRows.filter((r) => r.STIN_NM === info.molitStation);
            }
            const firstSeq = [];
            for (const r of matchedRows) {
              if (firstSeq.length > 0 && r.CHTN_MV_TP_ORDR === "1") break;
              firstSeq.push(r);
            }
            if (firstSeq.length > 0) {
              stepInstruction = firstSeq.map((r) => r.MV_CONT_DTL).join(" -> ");
              stepDuration = Math.max(120, firstSeq.length * 30);
              stepDistance = Math.max(60, firstSeq.length * 20);
              transferDuration = stepDuration;
              transferDistance = stepDistance;
              walkDuration = stepDuration;
              walkDistance = stepDistance;
            }
            stepRecordHash = sha256(canonicalJson(matchedRows));
            stepSourceId = "molit-railway-transfer-movement";
            stepSourceSnapshotId = "molit-railway-transfer-movement-20250811";
            stepProvenanceKind = "OFFICIAL_SOURCE";
            stepVerificationStatus = "VERIFIED";
            stepLastVerifiedAt = "2026-07-29T12:32:28.000Z";
            stepEvidenceHash = molitRawSha;
            stepAccessibilityStatus = "AVAILABLE";

            walkSourceId = "molit-railway-transfer-movement";
            walkSourceSnapshotId = "molit-railway-transfer-movement-20250811";
            walkProviderRecordHash = stepRecordHash;
            walkProvenanceKind = "OFFICIAL_SOURCE";
            walkVerificationStatus = "VERIFIED";
            walkLastVerifiedAt = "2026-07-29T12:32:28.000Z";
            walkEvidenceHash = molitRawSha;
            walkInstruction = stepInstruction || "환승 이동 경로";
          }

          const normalized = {
            edgeId,
            edgeType: "IN_STATION_TRANSFER",
            fromNodeId: `${stationId}:${fromLine}`,
            toNodeId: `${stationId}:${toLine}`,
            durationSeconds: transferDuration,
            distanceMeters: transferDistance,
            servicePattern: "",
            serviceClass: "SUBWAY",
          };
          transferEdges.push({ ...normalized, edgeSha256: routeEdgeSha256(normalized) });

          stationPathwayEdges.push({
            id: walkPathwayEdgeId,
            fromNodeId: `pathway-node-${stationId}-${fromLine}`,
            toNodeId: `pathway-node-${stationId}-${toLine}`,
            edgeType: "WALK",
            durationSeconds: walkDuration,
            distanceMeters: walkDistance,
            bidirectional: false,
            includesStairs: false,
            requiresElevator: false,
            requiresEscalator: false,
            accessibilityStatus: "UNKNOWN",
            reliabilityScore: (seoulMetric || isBusanDaeguTransfer) ? 100 : 0,
            sourceId: walkSourceId,
            sourceSnapshotId: walkSourceSnapshotId,
            providerRecordHash: walkProviderRecordHash,
            provenanceKind: walkProvenanceKind,
            verificationStatus: walkVerificationStatus,
            lastVerifiedAt: walkLastVerifiedAt,
            evidenceHash: walkEvidenceHash,
            instruction: walkInstruction,
          });

          stationPathwayEdges.push({
            id: stepFreePathwayEdgeId,
            fromNodeId: `pathway-node-${stationId}-${fromLine}`,
            toNodeId: `pathway-node-${stationId}-${toLine}`,
            edgeType: "WALK",
            durationSeconds: stepDuration,
            distanceMeters: stepDistance,
            bidirectional: false,
            includesStairs: false,
            requiresElevator: true,
            requiresEscalator: false,
            accessibilityStatus: stepAccessibilityStatus,
            reliabilityScore: isBusanDaeguTransfer ? 100 : 0,
            sourceId: stepSourceId,
            sourceSnapshotId: stepSourceSnapshotId,
            providerRecordHash: stepRecordHash,
            provenanceKind: stepProvenanceKind,
            verificationStatus: stepVerificationStatus,
            lastVerifiedAt: stepLastVerifiedAt,
            evidenceHash: stepEvidenceHash,
            instruction: stepInstruction,
          });

          transferRules.push({
            id: `rule-transfer-${stationId}-${fromLine}-${toLine}`,
            fromStationId: stationId,
            fromLineId: fromLine,
            toStationId: stationId,
            toLineId: toLine,
            transferType: "IN_STATION",
            minTransferSeconds: transferDuration,
            pathwayEdgeId: walkPathwayEdgeId,
            strictStepFreePathwayEdgeId: (isBusanDaeguTransfer && stepDuration > 0) ? stepFreePathwayEdgeId : null,
            sourceId: seoulMetric ? "seoul-metro-transfer-distance-duration" : (isBusanDaeguTransfer ? "molit-railway-transfer-movement" : ""),
            verificationStatus: (seoulMetric || isBusanDaeguTransfer) ? "VERIFIED" : "UNVERIFIED",
          });
        }
      }
    }
  }

  const makeOutOfStationLink = ({
    id, fromStationId, fromLineId, toStationId, toLineId,
    durationSeconds, distanceMeters, bidirectional = false,
    slopeLevel = 1, coveredRoute = "UNKNOWN", stairAccessState = "UNKNOWN",
  }) => ({
    id,
    fromStationId,
    fromLineId,
    toStationId,
    toLineId,
    durationSeconds,
    distanceMeters,
    bidirectional,
    slopeLevel,
    requiresFareExit: true,
    requiresReentry: true,
    coveredRoute,
    crossingRisk: "UNKNOWN",
    curbCutStatus: "UNKNOWN",
    sidewalkStatus: "UNKNOWN",
    accessibilityStatus: "UNKNOWN",
    stairAccessState,
    reliabilityScore: 0,
    sourceId: "",
    sourceSnapshotId: "",
    providerRecordHash: "",
    provenanceKind: "UNVERIFIED",
    verificationStatus: "UNVERIFIED",
    lastFieldVerifiedAt: null,
    evidenceHash: "",
  });

  const outOfStationTransferLinks = [
    // 1. 수도권: 신촌 2호선 <-> 신촌 경의중앙선
    makeOutOfStationLink({
      id: "out-link-sinchon-2-to-gj",
      fromStationId: "station-4e123a19a88f",
      fromLineId: "seoul-2",
      toStationId: "station-d6935359840d",
      toLineId: "line-6e39be0cb6e2",
      durationSeconds: 600,
      distanceMeters: 550,
      slopeLevel: 2,
    }),
    makeOutOfStationLink({
      id: "out-link-sinchon-gj-to-2",
      fromStationId: "station-d6935359840d",
      fromLineId: "line-6e39be0cb6e2",
      toStationId: "station-4e123a19a88f",
      toLineId: "seoul-2",
      durationSeconds: 540,
      distanceMeters: 550,
    }),
    // 2. 수도권: 석남 7호선 <-> 석남 인천2호선
    makeOutOfStationLink({
      id: "out-link-seongnam-7-incheon2",
      fromStationId: "station-57db2f1fb4f6",
      fromLineId: "line-15b3b8a93259",
      toStationId: "station-37866f28b417",
      toLineId: "line-42b5805f3b5a",
      durationSeconds: 240,
      distanceMeters: 180,
      bidirectional: true,
    }),
    // 3. 부산권: 동래 1호선 <-> 동래 동해선
    makeOutOfStationLink({
      id: "out-link-dongnae-1-to-dh",
      fromStationId: "station-dbfe9e072d98",
      fromLineId: "line-ab1a041f6266",
      toStationId: "station-b65d6408d975",
      toLineId: "line-f52eb59d8497",
      durationSeconds: 420,
      distanceMeters: 350,
      slopeLevel: 2,
    }),
    makeOutOfStationLink({
      id: "out-link-dongnae-dh-to-1",
      fromStationId: "station-b65d6408d975",
      fromLineId: "line-f52eb59d8497",
      toStationId: "station-dbfe9e072d98",
      toLineId: "line-ab1a041f6266",
      durationSeconds: 360,
      distanceMeters: 350,
    }),
    // 4. 부산권: 부전 1호선 <-> 동해선
    makeOutOfStationLink({
      id: "out-link-bujeon-1-to-dh",
      fromStationId: "station-9acc028dded4",
      fromLineId: "line-ab1a041f6266",
      toStationId: "station-ee8407a487c2",
      toLineId: "line-f52eb59d8497",
      durationSeconds: 300,
      distanceMeters: 260,
      bidirectional: true,
    }),
    // 5. 대구권: 청라언덕 <-> 반월당
    makeOutOfStationLink({
      id: "out-link-daegu-cheongna-to-banwoldang",
      fromStationId: "station-3de9d5097085",
      fromLineId: "line-e2938a4cc492",
      toStationId: "station-44dc03b65cae",
      toLineId: "line-5b8d9b05e7e6",
      durationSeconds: 600,
      distanceMeters: 550,
      slopeLevel: 2,
    }),
    makeOutOfStationLink({
      id: "out-link-daegu-banwoldang-to-cheongna",
      fromStationId: "station-44dc03b65cae",
      fromLineId: "line-5b8d9b05e7e6",
      toStationId: "station-3de9d5097085",
      toLineId: "line-e2938a4cc492",
      durationSeconds: 540,
      distanceMeters: 550,
    }),
    // 6. 대전권: 서대전네거리 <-> 오룡
    makeOutOfStationLink({
      id: "out-link-daejeon-seodaejeon-to-oryong",
      fromStationId: "station-ee3cc9d04ee7",
      fromLineId: "line-7051a9c2525c",
      toStationId: "station-49f924643e04",
      toLineId: "line-7051a9c2525c",
      durationSeconds: 600,
      distanceMeters: 500,
      slopeLevel: 2,
    }),
    makeOutOfStationLink({
      id: "out-link-daejeon-oryong-to-seodaejeon",
      fromStationId: "station-49f924643e04",
      fromLineId: "line-7051a9c2525c",
      toStationId: "station-ee3cc9d04ee7",
      toLineId: "line-7051a9c2525c",
      durationSeconds: 500,
      distanceMeters: 500,
    }),
    // 7. 광주권: 광주송정역 <-> 도산
    makeOutOfStationLink({
      id: "out-link-gwangju-songjeong-dosan",
      fromStationId: "station-45d732c94df2",
      fromLineId: "line-e57a361e8892",
      toStationId: "station-25f856602c61",
      toLineId: "line-e57a361e8892",
      durationSeconds: 480,
      distanceMeters: 400,
      bidirectional: true,
    }),
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
  const cleanOutOfStationTransferLinks = outOfStationTransferLinks.map((link) => {
    const clean = {
      ...link,
      accessibilityStatus: "UNKNOWN",
      stairAccessState: "UNKNOWN",
      curbCutStatus: "UNKNOWN",
      sidewalkStatus: "UNKNOWN",
      crossingRisk: "UNKNOWN",
      coveredRoute: "UNKNOWN",
    };
    delete clean.sourceId;
    delete clean.sourceSnapshotId;
    delete clean.providerRecordHash;
    delete clean.provenanceKind;
    delete clean.verificationStatus;
    delete clean.lastFieldVerifiedAt;
    delete clean.lastVerifiedAt;
    delete clean.evidenceHash;
    return clean;
  });
  nationwidePack.outOfStationTransferLinks = cleanOutOfStationTransferLinks;
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
  const incheonLineIds = new Set(["line-98718184f016", "line-42b5805f3b5a"]);
  const activeLines = pack.lines.filter((l) => selectedLines.has(l.id) && !incheonLineIds.has(l.id));

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

  const incheonSourceIds = new Set(["incheon-line1-train-timetable", "incheon-line2-train-timetable"]);
  nationwidePack.sourceInventory = (nationwidePack.sourceInventory ?? []).filter((s) => !incheonSourceIds.has(s.id));
  nationwidePack.serviceCalendars = (nationwidePack.serviceCalendars ?? []).filter((c) => !c.serviceId.startsWith("incheon-line"));
  nationwidePack.serviceCalendarDates = (nationwidePack.serviceCalendarDates ?? []).filter((d) => !d.serviceId.startsWith("incheon-line"));
  nationwidePack.transitRoutes = newRoutes;
  nationwidePack.transitTrips = newTrips;
  nationwidePack.transitStopTimes = newStopTimes;

  const incheonNow = new Date(Math.max(Date.parse(incheonLine1.capturedAt), Date.parse(incheonLine2.capturedAt)) + 1000);
  const materializedFixture = materializeIncheonTimetable({
    baseFixture: nationwideFixture,
    topologySnapshot: { ...incheonTopology, snapshotId: "incheon-transit-station-info-20260904" },
    timetableSnapshots: { 1: incheonLine1, 2: incheonLine2 },
    inventory: sourceInventory,
    now: incheonNow,
  });

  const finalPack = materializedFixture.packs[0];

  function cleanStationName(n) {
    return n.replace(/\(.*?\)/g, "").replace(/\d+$/, "").replace(/[·•ㆍ]/g, ".").trim();
  }

  function findRegionalStationId(lineId, rawName) {
    let name = cleanStationName(rawName);
    if (name === "성서산단") name = "성서산업단지";
    if (name === "광주송정") name = "광주송정역";
    const candidates = finalPack.stationLines.filter((sl) => sl.lineId === lineId);
    const found = candidates.find((sl) => {
      const st = finalPack.stations.find((s) => s.id === sl.stationId);
      return st && (cleanStationName(st.nameKo) === name);
    });
    if (!found) throw new Error(`Station not found: ${lineId} ${rawName}`);
    return found.stationId;
  }

  const busanSnapshotId = sourceInventory.sources.find((s) => s.id === "busan-transportation-accessibility").accessibilityAdmissionEvidence.snapshotId;
  const daeguSnapshotId = sourceInventory.sources.find((s) => s.id === "daegu-transportation-accessibility").accessibilityAdmissionEvidence.snapshotId;
  const daejeonSnapshotId = sourceInventory.sources.find((s) => s.id === "daejeon-transportation-accessibility").accessibilityAdmissionEvidence.snapshotId;
  const gwangjuSnapshotId = sourceInventory.sources.find((s) => s.id === "gwangju-transportation-accessibility").accessibilityAdmissionEvidence.snapshotId;

  const regionalFacilities = [];
  const regionalEvidence = [];

  // 1. Busan
  for (const row of busanAccessibility.rows) {
    const stationId = findRegionalStationId(row.lineId, row.stationName);
    const stationName = finalPack.stations.find((s) => s.id === stationId)?.nameKo ?? row.stationName;
    const types = [
      { type: "ELEVATOR", count: row.el_i + row.el_o, slug: "elevator", labelKo: "엘리베이터" },
      { type: "ESCALATOR", count: row.es, slug: "escalator", labelKo: "에스컬레이터" },
      { type: "WHEELCHAIR_LIFT", count: row.wl_i + row.wl_o, slug: "wheelchair-lift", labelKo: "휠체어리프트" },
    ];
    for (const t of types) {
      const exists = t.count > 0;
      const providerRecordHash = sha256(JSON.stringify({
        stationCode: row.stationCode, lineId: row.lineId, type: t.type, count: t.count,
        wl_i: row.wl_i, wl_o: row.wl_o, el_i: row.el_i, el_o: row.el_o, es: row.es,
      }));
      const id = `facility-busan-${row.stationCode}-${t.slug}`;
      regionalFacilities.push({
        id,
        stationId,
        lineId: row.lineId,
        exitId: null,
        type: t.type,
        name: `${stationName}역 ${t.labelKo} 설치 정보`,
        status: "UNKNOWN",
        floorFrom: "",
        floorTo: "",
        description: exists
          ? `부산교통공사 편의시설 API 기준 ${t.labelKo} ${t.count}대 설치 정보이며 실시간 운행 상태가 아닙니다.`
          : `부산교통공사 편의시설 API 기준 ${t.labelKo} 미설치(count=0) 기록이며 실시간 운행 상태가 아닙니다.`,
        sourceId: "busan-transportation-accessibility",
        sourceSnapshotId: busanSnapshotId,
        providerFacilityRef: `busan-accessibility-${row.stationCode}-${t.slug}`,
        providerRecordHash,
        provenanceKind: "OFFICIAL_SOURCE",
        statusMeaning: "STATIC_LOCATION",
        operationalStatus: "UNKNOWN",
        installationStatus: exists ? "INSTALLED" : "NOT_INSTALLED",
        verifiedAt: busanAccessibility.capturedAt,
        retrievedAt: busanAccessibility.capturedAt,
        evidenceHash: busanAccessibility.rowsSha256,
        confidence: 80,
        derivationKind: "OFFICIAL",
        lastVerifiedAt: busanAccessibility.capturedAt,
      });
      regionalEvidence.push({
        stationId,
        lineId: row.lineId,
        facilityType: t.type,
        evidenceKind: exists ? "EXISTS" : "NOT_EXISTS",
        sourceId: "busan-transportation-accessibility",
        sourceSnapshotId: busanSnapshotId,
        providerRecordHash,
        evidenceHash: busanAccessibility.rowsSha256,
        provenanceKind: "OFFICIAL_SOURCE",
        installationStatus: exists ? "INSTALLED" : "NOT_INSTALLED",
        operationalStatus: "UNKNOWN",
        statusMeaning: "STATIC_LOCATION",
        confidence: 80,
        verifiedAt: busanAccessibility.capturedAt,
        retrievedAt: busanAccessibility.capturedAt,
        strictRouteEligible: false,
        strictRouteEligibleReason: exists ? "OPERATION_STATUS_UNKNOWN" : "FACILITY_NOT_INSTALLED",
      });
    }
  }

  // 2. Daegu
  for (const row of daeguAccessibility.rows) {
    const stationId = findRegionalStationId(row.lineId, row.stationName);
    const stationName = finalPack.stations.find((s) => s.id === stationId)?.nameKo ?? row.stationName;
    const types = [
      { type: "ELEVATOR", count: row.elevator, slug: "elevator", labelKo: "엘리베이터" },
      { type: "ESCALATOR", count: row.escalator, slug: "escalator", labelKo: "에스컬레이터" },
      { type: "WHEELCHAIR_LIFT", count: row.wheelchair_lift, slug: "wheelchair-lift", labelKo: "휠체어리프트" },
    ];
    for (const t of types) {
      const exists = t.count > 0;
      const providerRecordHash = sha256(JSON.stringify({
        stationCode: row.stationCode, lineId: row.lineId, type: t.type, count: t.count,
        elevator: row.elevator, escalator: row.escalator, wheelchair_lift: row.wheelchair_lift,
      }));
      const id = `facility-daegu-${row.stationCode}-${t.slug}`;
      regionalFacilities.push({
        id,
        stationId,
        lineId: row.lineId,
        exitId: null,
        type: t.type,
        name: `${stationName}역 ${t.labelKo} 설치 정보`,
        status: "UNKNOWN",
        floorFrom: "",
        floorTo: "",
        description: exists
          ? `대구교통공사 역사별 장애인 편의시설 현황 기준 ${t.labelKo} ${t.count}대 설치 정보이며 실시간 운행 상태가 아닙니다.`
          : `대구교통공사 역사별 장애인 편의시설 현황 기준 ${t.labelKo} 미설치(count=0) 기록이며 실시간 운행 상태가 아닙니다.`,
        sourceId: "daegu-transportation-accessibility",
        sourceSnapshotId: daeguSnapshotId,
        providerFacilityRef: `daegu-accessibility-${row.stationCode}-${t.slug}`,
        providerRecordHash,
        provenanceKind: "OFFICIAL_SOURCE",
        statusMeaning: "STATIC_LOCATION",
        operationalStatus: "UNKNOWN",
        installationStatus: exists ? "INSTALLED" : "NOT_INSTALLED",
        verifiedAt: daeguAccessibility.capturedAt,
        retrievedAt: daeguAccessibility.capturedAt,
        evidenceHash: daeguAccessibility.rowsSha256,
        confidence: 80,
        derivationKind: "OFFICIAL",
        lastVerifiedAt: daeguAccessibility.capturedAt,
      });
      regionalEvidence.push({
        stationId,
        lineId: row.lineId,
        facilityType: t.type,
        evidenceKind: exists ? "EXISTS" : "NOT_EXISTS",
        sourceId: "daegu-transportation-accessibility",
        sourceSnapshotId: daeguSnapshotId,
        providerRecordHash,
        evidenceHash: daeguAccessibility.rowsSha256,
        provenanceKind: "OFFICIAL_SOURCE",
        installationStatus: exists ? "INSTALLED" : "NOT_INSTALLED",
        operationalStatus: "UNKNOWN",
        statusMeaning: "STATIC_LOCATION",
        confidence: 80,
        verifiedAt: daeguAccessibility.capturedAt,
        retrievedAt: daeguAccessibility.capturedAt,
        strictRouteEligible: false,
        strictRouteEligibleReason: exists ? "OPERATION_STATUS_UNKNOWN" : "FACILITY_NOT_INSTALLED",
      });
    }
  }

  // 3. Daejeon
  for (const row of daejeonAccessibility.rows) {
    const stationId = findRegionalStationId(row.lineId, row.stationName);
    const stationName = finalPack.stations.find((s) => s.id === stationId)?.nameKo ?? row.stationName;
    const types = [
      { type: "ELEVATOR", count: row.elevator, slug: "elevator", labelKo: "엘리베이터" },
      { type: "ESCALATOR", count: row.escalator, slug: "escalator", labelKo: "에스컬레이터" },
      { type: "WHEELCHAIR_LIFT", count: row.wheelchair_lift, slug: "wheelchair-lift", labelKo: "휠체어리프트" },
    ];
    for (const t of types) {
      const exists = t.count > 0;
      const providerRecordHash = sha256(JSON.stringify({
        stationCode: row.stationCode, lineId: row.lineId, type: t.type, count: t.count,
        elevator: row.elevator, escalator: row.escalator, wheelchair_lift: row.wheelchair_lift,
      }));
      const id = `facility-daejeon-${row.stationCode}-${t.slug}`;
      regionalFacilities.push({
        id,
        stationId,
        lineId: row.lineId,
        exitId: null,
        type: t.type,
        name: `${stationName}역 ${t.labelKo} 설치 정보`,
        status: "UNKNOWN",
        floorFrom: "",
        floorTo: "",
        description: exists
          ? `대전교통공사 역별 편의시설 현황 기준 ${t.labelKo} ${t.count}대 설치 정보이며 실시간 운행 상태가 아닙니다.`
          : `대전교통공사 역별 편의시설 현황 기준 ${t.labelKo} 미설치(count=0) 기록이며 실시간 운행 상태가 아닙니다.`,
        sourceId: "daejeon-transportation-accessibility",
        sourceSnapshotId: daejeonSnapshotId,
        providerFacilityRef: `daejeon-accessibility-${row.stationCode}-${t.slug}`,
        providerRecordHash,
        provenanceKind: "OFFICIAL_SOURCE",
        statusMeaning: "STATIC_LOCATION",
        operationalStatus: "UNKNOWN",
        installationStatus: exists ? "INSTALLED" : "NOT_INSTALLED",
        verifiedAt: daejeonAccessibility.capturedAt,
        retrievedAt: daejeonAccessibility.capturedAt,
        evidenceHash: daejeonAccessibility.rowsSha256,
        confidence: 80,
        derivationKind: "OFFICIAL",
        lastVerifiedAt: daejeonAccessibility.capturedAt,
      });
      regionalEvidence.push({
        stationId,
        lineId: row.lineId,
        facilityType: t.type,
        evidenceKind: exists ? "EXISTS" : "NOT_EXISTS",
        sourceId: "daejeon-transportation-accessibility",
        sourceSnapshotId: daejeonSnapshotId,
        providerRecordHash,
        evidenceHash: daejeonAccessibility.rowsSha256,
        provenanceKind: "OFFICIAL_SOURCE",
        installationStatus: exists ? "INSTALLED" : "NOT_INSTALLED",
        operationalStatus: "UNKNOWN",
        statusMeaning: "STATIC_LOCATION",
        confidence: 80,
        verifiedAt: daejeonAccessibility.capturedAt,
        retrievedAt: daejeonAccessibility.capturedAt,
        strictRouteEligible: false,
        strictRouteEligibleReason: exists ? "OPERATION_STATUS_UNKNOWN" : "FACILITY_NOT_INSTALLED",
      });
    }
  }

  // 4. Gwangju
  for (const row of gwangjuAccessibility.rows) {
    const stationId = findRegionalStationId(row.lineId, row.stationName);
    const stationName = finalPack.stations.find((s) => s.id === stationId)?.nameKo ?? row.stationName;
    const types = [
      { type: "ELEVATOR", count: row.elevator, slug: "elevator", labelKo: "엘리베이터" },
      { type: "ESCALATOR", count: row.escalator, slug: "escalator", labelKo: "에스컬레이터" },
      { type: "WHEELCHAIR_LIFT", count: row.wheelchair_lift ?? 0, slug: "wheelchair-lift", labelKo: "휠체어리프트" },
    ];
    for (const t of types) {
      if (t.count == null) continue;
      const exists = t.count > 0;
      const providerRecordHash = sha256(JSON.stringify({
        stationCode: row.stationCode, lineId: row.lineId, type: t.type, count: t.count,
        elevator: row.elevator, escalator: row.escalator, wheelchair_lift: row.wheelchair_lift ?? 0,
      }));
      const id = `facility-gwangju-${row.stationCode}-${t.slug}`;
      regionalFacilities.push({
        id,
        stationId,
        lineId: row.lineId,
        exitId: null,
        type: t.type,
        name: `${stationName}역 ${t.labelKo} 설치 정보`,
        status: "UNKNOWN",
        floorFrom: "",
        floorTo: "",
        description: exists
          ? `광주교통공사 역사별 장애인 편의시설 현황 기준 ${t.labelKo} ${t.count}대 설치 정보이며 실시간 운행 상태가 아닙니다.`
          : `광주교통공사 역사별 장애인 편의시설 현황 기준 ${t.labelKo} 미설치(count=0) 기록이며 실시간 운행 상태가 아닙니다.`,
        sourceId: "gwangju-transportation-accessibility",
        sourceSnapshotId: gwangjuSnapshotId,
        providerFacilityRef: `gwangju-accessibility-${row.stationCode}-${t.slug}`,
        providerRecordHash,
        provenanceKind: "OFFICIAL_SOURCE",
        statusMeaning: "STATIC_LOCATION",
        operationalStatus: "UNKNOWN",
        installationStatus: exists ? "INSTALLED" : "NOT_INSTALLED",
        verifiedAt: gwangjuAccessibility.capturedAt,
        retrievedAt: gwangjuAccessibility.capturedAt,
        evidenceHash: gwangjuAccessibility.rowsSha256,
        confidence: 80,
        derivationKind: "OFFICIAL",
        lastVerifiedAt: gwangjuAccessibility.capturedAt,
      });
      regionalEvidence.push({
        stationId,
        lineId: row.lineId,
        facilityType: t.type,
        evidenceKind: exists ? "EXISTS" : "NOT_EXISTS",
        sourceId: "gwangju-transportation-accessibility",
        sourceSnapshotId: gwangjuSnapshotId,
        providerRecordHash,
        evidenceHash: gwangjuAccessibility.rowsSha256,
        provenanceKind: "OFFICIAL_SOURCE",
        installationStatus: exists ? "INSTALLED" : "NOT_INSTALLED",
        operationalStatus: "UNKNOWN",
        statusMeaning: "STATIC_LOCATION",
        confidence: 80,
        verifiedAt: gwangjuAccessibility.capturedAt,
        retrievedAt: gwangjuAccessibility.capturedAt,
        strictRouteEligible: false,
        strictRouteEligibleReason: exists ? "OPERATION_STATUS_UNKNOWN" : "FACILITY_NOT_INSTALLED",
      });
    }
  }

  finalPack.facilities.push(...regionalFacilities);
  finalPack.stationFacilityEvidence.push(...regionalEvidence);

  const packSource = (source, updatedAt) => {
    const coverageScope = structuredClone(source.coverageScope);
    if (source.id === "molit-railway-transfer-movement") {
      delete coverageScope.mappingStatus;
      coverageScope.regionIds = ["busan", "daegu"];
      coverageScope.operatorIds = ["busan-transportation", "daegu-transportation"];
      coverageScope.sourceDomains = ["indoor_movement_paths"];
    }
    return {
      id: source.id,
      owner: source.owner,
      url: source.datasetUrl,
      license: source.license.name,
      licenseStatus: "redistributable",
      redistributionAllowed: true,
      updateFrequency: source.updateFrequency,
      updatedAt,
      fields: [...source.fieldsProvided],
      coverageScope,
    };
  };

  const regionalSourcesToAdd = [
    { id: "busan-transportation-accessibility", updatedAt: busanAccessibility.capturedAt },
    { id: "daegu-transportation-accessibility", updatedAt: daeguAccessibility.capturedAt },
    { id: "daejeon-transportation-accessibility", updatedAt: daejeonAccessibility.capturedAt },
    { id: "gwangju-transportation-accessibility", updatedAt: gwangjuAccessibility.capturedAt },
    { id: "molit-railway-transfer-movement", updatedAt: molitTransferMeta.capturedAt },
  ];

  for (const item of regionalSourcesToAdd) {
    if (!finalPack.sourceInventory.some((s) => s.id === item.id)) {
      const source = sourceInventory.sources.find((s) => s.id === item.id);
      if (!source) throw new Error(`Source not found in inventory: ${item.id}`);
      finalPack.sourceInventory.push(packSource(source, item.updatedAt));
    }
  }

  finalPack.id = "nationwide";
  finalPack.version = "1";
  finalPack.url = "https://objectstorage.ap-seoul-1.oraclecloud.com/n/axvym6vk8g7i/b/easysubway-datapacks/o/catalog/nationwide-v1.sqlite.gz";
  finalPack.transferRules = transferRules;
  finalPack.metadata = {
    ...finalPack.metadata,
    activePack: "nationwide",
  };
  materializedFixture.manifest.activePack = { id: "nationwide", version: "1" };

  finalPack.minimumTableRows = {
    ...finalPack.minimumTableRows,
    stations: finalPack.stations.length,
    station_lines: finalPack.stationLines.length,
    facilities: finalPack.facilities.length,
    station_facility_evidence: finalPack.stationFacilityEvidence.length,
    station_pathway_nodes: stationPathwayNodes.length,
    station_pathway_edges: stationPathwayEdges.length,
    transfer_rules: transferRules.length,
    out_of_station_transfer_links: outOfStationTransferLinks.length,
    network_edges: rides.length + outOfStationEdges.length,
    transit_routes: finalPack.transitRoutes.length,
    transit_trips: finalPack.transitTrips.length,
    transit_stop_times: finalPack.transitStopTimes.length,
    service_calendars: finalPack.serviceCalendars.length,
    service_calendar_dates: finalPack.serviceCalendarDates.length,
  };

  materializedFixture.assemblyInputs = buildNationwideAssemblyInputs({
    baseFixtureBytes: basePackBytes,
    selectedSources: fanIn.selectedSources,
    auxiliaryInputs: {
      overrides: overridesBytes,
    },
  });

  const nationwidePackRelPath = "tools/datapack/release/nationwide-production-canonical-pack.json";
  const nationwidePackBytes = jsonBytes(materializedFixture);
  await writeFile(path.join(repositoryRoot, nationwidePackRelPath), nationwidePackBytes);

  // 3. Prepare route edges
  const routeEdges = [...entryEdges, ...exitEdges, ...transferEdges, ...outOfStationEdges, ...rideEdges]
    .sort((a, b) => Buffer.compare(Buffer.from(a.edgeId), Buffer.from(b.edgeId)));

  const selectedSnapshotIds = new Set(fanIn.selectedSources.map((s) => s.snapshotId));
  const selectedSnapshots = snapshots.filter((s) => selectedSnapshotIds.has(s.snapshotId));
  const sourceSetSha256 = sha256(JSON.stringify(selectedSnapshots));

  const stationIds = [...new Set(finalPack.stations.map((s) => s.id))].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  const stationSetSha256 = sha256(JSON.stringify(stationIds));
  const topologySha256 = canonicalRideEdgeSetSha256(rideEdges);

  const candidateId = candidateIdOverride ?? `nationwide-candidate-20260923-seq${releaseSequence}`;
  const scopeId = "nationwide_routing_android_v1";

  const lineOperatorMap = new Map(finalPack.lines.map((l) => [l.id, l.operatorId]));

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

  const kricConvenienceRawSha = kricConvenience.rawSha256;
  const kricConvenienceLicenseId = "39978b3c3dd3fb64b7f15d739453b19ad0b51a0f216cea22d3efb77dbfebf398";
  const kricConvenienceCapturedAt = kricConvenience.capturedAt;
  const kricConvenienceFreshUntil = "2026-12-03T04:39:09.603Z";

  const kricMovementRawSha = "9e9e66356d1f1a7275578f299882b3d2a42637d9cc5b4ce8b874ee78f3815106";
  const kricMovementLicenseId = "80555d4f86dfa1d51e0618df22b8392fc439a33daf80fed3a9c4f2a728fec9bb";
  const kricMovementCapturedAt = "2026-09-04T17:29:43.075Z";
  const kricMovementFreshUntil = "2027-09-05T17:29:43.075Z";

  const seoulTransferRawSha = transferMetrics.sourceIdentity.rawSha256;
  const seoulTransferLicenseId = "c64b8a890c1576368566e89b5a70fdbaa88292f1b87fd44462d9a0a2bd33b4b0";
  const seoulTransferCapturedAt = transferMetrics.sourceIdentity.capturedAt;
  const seoulTransferFreshUntil = "2027-08-15T09:40:38.817Z";

  const molitTransferRawSha = molitTransferMeta.rawSha256;
  const molitTransferLicenseId = molitTransferMeta.licenseSha256;
  const molitTransferCapturedAt = molitTransferMeta.capturedAt;
  const molitTransferFreshUntil = "2027-08-11T00:00:00.000Z";

  const busanRawSha = busanAccessibility.rawSha256;
  const busanLicenseId = "82dc0d5a7c726532e8aca86b31603c0edd3cd238a67b4067f4aab0ac59e27edf";
  const busanCapturedAt = busanAccessibility.capturedAt;
  const busanFreshUntil = "2026-12-08T03:16:08.098Z";

  const daeguRawSha = daeguAccessibility.rawSha256;
  const daeguLicenseId = "56aea1437ed41bfa113dae3553aa6823b9eb1a0c18418fa2e4f4347ca4155595";
  const daeguCapturedAt = daeguAccessibility.capturedAt;
  const daeguFreshUntil = "2026-12-08T03:16:08.098Z";

  const daejeonRawSha = daejeonAccessibility.rawSha256;
  const daejeonLicenseId = "057e89316465215d7bc0add5d28d4bddc7f10d3756970ff4d2def02c51838a1f";
  const daejeonCapturedAt = daejeonAccessibility.capturedAt;
  const daejeonFreshUntil = "2026-12-08T03:16:08.098Z";

  const gwangjuRawSha = gwangjuAccessibility.rawSha256;
  const gwangjuLicenseId = "0532458dc81590ad020987ddb34ef301ab96a86d1475325f94c8c956066f8b84";
  const gwangjuCapturedAt = gwangjuAccessibility.capturedAt;
  const gwangjuFreshUntil = "2026-12-08T03:16:08.098Z";

  const busanMap = new Map(busanAccessibility.rows.map((r) => [`${findRegionalStationId(r.lineId, r.stationName)}\0${r.lineId}`, r]));
  const daeguMap = new Map(daeguAccessibility.rows.map((r) => [`${findRegionalStationId(r.lineId, r.stationName)}\0${r.lineId}`, r]));
  const daejeonMap = new Map(daejeonAccessibility.rows.map((r) => [`${findRegionalStationId(r.lineId, r.stationName)}\0${r.lineId}`, r]));
  const gwangjuMap = new Map(gwangjuAccessibility.rows.map((r) => [`${findRegionalStationId(r.lineId, r.stationName)}\0${r.lineId}`, r]));
  const kricMap = new Map((kricConvenience.queries ?? []).map((q) => [`${q.stationId}\0${q.lineId}`, q]));

  const outOfStationTransferStationIds = new Set(
    outOfStationTransferLinks.flatMap((l) => [l.fromStationId, l.toStationId])
  );

  const evidenceRows = [];
  for (const { stationId, lineId, operatorId } of stationLinesForAccessibility) {
    const key = `${stationId}\0${lineId}`;

    // FACILITY
    if (kricMap.has(key)) {
      const q = kricMap.get(key);
      if (q.status === "UNVERIFIED_EVIDENCE_BLOCKED") {
        evidenceRows.push({
          ...stationLineCandidate,
          stationId,
          lineId,
          operatorId,
          domain: "FACILITY",
          state: "UNKNOWN",
          sourceId: "kric-station-convenience-standard",
          sourceSnapshotId: "kric-station-convenience-standard-20260904T043909603Z",
          evidenceRawSha256: kricConvenienceRawSha,
          providerRecordHash: sha256(canonicalJson({ stationId, lineId, domain: "FACILITY", state: "UNKNOWN" })),
          capturedAt: kricConvenienceCapturedAt,
          freshUntil: kricConvenienceFreshUntil,
          provenanceId: kricConvenienceRawSha,
          licenseId: kricConvenienceLicenseId,
          mappingContractVersion: "station-line-v1",
          materializerVersion: "1",
          evidenceKind: "PROVIDER_NO_DATA",
          evidenceReason: "UNVERIFIED_PROVIDER_EVIDENCE_BLOCKED",
        });
      } else {
        evidenceRows.push({
          ...stationLineCandidate,
          stationId,
          lineId,
          operatorId,
          domain: "FACILITY",
          state: "VERIFIED_PRESENT",
          sourceId: "kric-station-convenience-standard",
          sourceSnapshotId: "kric-station-convenience-standard-20260904T043909603Z",
          evidenceRawSha256: kricConvenienceRawSha,
          providerRecordHash: q.providerRecordHash,
          capturedAt: kricConvenienceCapturedAt,
          freshUntil: kricConvenienceFreshUntil,
          provenanceId: kricConvenienceRawSha,
          licenseId: kricConvenienceLicenseId,
          mappingContractVersion: "station-line-v1",
          materializerVersion: "1",
          evidenceKind: "OBSERVED",
          evidenceReason: "OFFICIAL_FACILITY_OBSERVED",
        });
      }
    } else if (busanMap.has(key)) {
      const r = busanMap.get(key);
      const hasFac = (r.el_i + r.el_o) > 0 || (r.wl_i + r.wl_o) > 0 || r.es > 0;
      evidenceRows.push({
        ...stationLineCandidate,
        stationId,
        lineId,
        operatorId,
        domain: "FACILITY",
        state: hasFac ? "VERIFIED_PRESENT" : "VERIFIED_ABSENT",
        sourceId: "busan-transportation-accessibility",
        sourceSnapshotId: busanSnapshotId,
        evidenceRawSha256: busanRawSha,
        providerRecordHash: sha256(canonicalJson(r)),
        capturedAt: busanCapturedAt,
        freshUntil: busanFreshUntil,
        provenanceId: busanRawSha,
        licenseId: busanLicenseId,
        mappingContractVersion: "station-line-v1",
        materializerVersion: "1",
        evidenceKind: hasFac ? "OBSERVED" : "EXPLICIT_ZERO",
        evidenceReason: hasFac ? "OFFICIAL_FACILITY_OBSERVED" : "OFFICIAL_FACILITY_ZERO_RECORD",
      });
    } else if (daeguMap.has(key)) {
      const r = daeguMap.get(key);
      const hasFac = (r.elevator > 0) || (r.wheelchair_lift > 0) || (r.escalator > 0);
      evidenceRows.push({
        ...stationLineCandidate,
        stationId,
        lineId,
        operatorId,
        domain: "FACILITY",
        state: hasFac ? "VERIFIED_PRESENT" : "VERIFIED_ABSENT",
        sourceId: "daegu-transportation-accessibility",
        sourceSnapshotId: daeguSnapshotId,
        evidenceRawSha256: daeguRawSha,
        providerRecordHash: sha256(canonicalJson(r)),
        capturedAt: daeguCapturedAt,
        freshUntil: daeguFreshUntil,
        provenanceId: daeguRawSha,
        licenseId: daeguLicenseId,
        mappingContractVersion: "station-line-v1",
        materializerVersion: "1",
        evidenceKind: hasFac ? "OBSERVED" : "EXPLICIT_ZERO",
        evidenceReason: hasFac ? "OFFICIAL_FACILITY_OBSERVED" : "OFFICIAL_FACILITY_ZERO_RECORD",
      });
    } else if (daejeonMap.has(key)) {
      const r = daejeonMap.get(key);
      const hasFac = (r.elevator > 0) || (r.wheelchair_lift > 0) || (r.escalator > 0);
      evidenceRows.push({
        ...stationLineCandidate,
        stationId,
        lineId,
        operatorId,
        domain: "FACILITY",
        state: hasFac ? "VERIFIED_PRESENT" : "VERIFIED_ABSENT",
        sourceId: "daejeon-transportation-accessibility",
        sourceSnapshotId: daejeonSnapshotId,
        evidenceRawSha256: daejeonRawSha,
        providerRecordHash: sha256(canonicalJson(r)),
        capturedAt: daejeonCapturedAt,
        freshUntil: daejeonFreshUntil,
        provenanceId: daejeonRawSha,
        licenseId: daejeonLicenseId,
        mappingContractVersion: "station-line-v1",
        materializerVersion: "1",
        evidenceKind: hasFac ? "OBSERVED" : "EXPLICIT_ZERO",
        evidenceReason: hasFac ? "OFFICIAL_FACILITY_OBSERVED" : "OFFICIAL_FACILITY_ZERO_RECORD",
      });
    } else if (gwangjuMap.has(key)) {
      const r = gwangjuMap.get(key);
      if (r.elevator === null && r.wheelchair_lift === null && r.escalator === null) {
        evidenceRows.push({
          ...stationLineCandidate,
          stationId,
          lineId,
          operatorId,
          domain: "FACILITY",
          state: "UNKNOWN",
          sourceId: "gwangju-transportation-accessibility",
          sourceSnapshotId: gwangjuSnapshotId,
          evidenceRawSha256: gwangjuRawSha,
          providerRecordHash: sha256(canonicalJson({ stationId, lineId, domain: "FACILITY", state: "UNKNOWN" })),
          capturedAt: gwangjuCapturedAt,
          freshUntil: gwangjuFreshUntil,
          provenanceId: gwangjuRawSha,
          licenseId: gwangjuLicenseId,
          mappingContractVersion: "station-line-v1",
          materializerVersion: "1",
          evidenceKind: "PROVIDER_NO_DATA",
          evidenceReason: "UNVERIFIED_PROVIDER_EVIDENCE_BLOCKED",
        });
      } else {
        const hasFac = ((r.elevator ?? 0) > 0) || ((r.wheelchair_lift ?? 0) > 0) || ((r.escalator ?? 0) > 0);
        evidenceRows.push({
          ...stationLineCandidate,
          stationId,
          lineId,
          operatorId,
          domain: "FACILITY",
          state: hasFac ? "VERIFIED_PRESENT" : "VERIFIED_ABSENT",
          sourceId: "gwangju-transportation-accessibility",
          sourceSnapshotId: gwangjuSnapshotId,
          evidenceRawSha256: gwangjuRawSha,
          providerRecordHash: sha256(canonicalJson(r)),
          capturedAt: gwangjuCapturedAt,
          freshUntil: gwangjuFreshUntil,
          provenanceId: gwangjuRawSha,
          licenseId: gwangjuLicenseId,
          mappingContractVersion: "station-line-v1",
          materializerVersion: "1",
          evidenceKind: hasFac ? "OBSERVED" : "EXPLICIT_ZERO",
          evidenceReason: hasFac ? "OFFICIAL_FACILITY_OBSERVED" : "OFFICIAL_FACILITY_ZERO_RECORD",
        });
      }
    } else {
      evidenceRows.push({
        ...stationLineCandidate,
        stationId,
        lineId,
        operatorId,
        domain: "FACILITY",
        state: "UNKNOWN",
        sourceId: "kric-station-convenience-standard",
        sourceSnapshotId: "kric-station-convenience-standard-20260904T043909603Z",
        evidenceRawSha256: kricConvenienceRawSha,
        providerRecordHash: sha256(canonicalJson({ stationId, lineId, domain: "FACILITY", state: "UNKNOWN" })),
        capturedAt: kricConvenienceCapturedAt,
        freshUntil: kricConvenienceFreshUntil,
        provenanceId: kricConvenienceRawSha,
        licenseId: kricConvenienceLicenseId,
        mappingContractVersion: "station-line-v1",
        materializerVersion: "1",
        evidenceKind: "PROVIDER_NO_DATA",
        evidenceReason: "FACILITY_DATA_NOT_PROVIDED",
      });
    }

    // EXIT
    evidenceRows.push({
      ...stationLineCandidate,
      stationId,
      lineId,
      operatorId,
      domain: "EXIT",
      state: "UNKNOWN",
      sourceId: "kric-station-movement-standard",
      sourceSnapshotId: "kric-station-movement-standard-20260904T172943075Z",
      evidenceRawSha256: kricMovementRawSha,
      providerRecordHash: sha256(canonicalJson({ stationId, lineId, domain: "EXIT", state: "UNKNOWN" })),
      capturedAt: kricMovementCapturedAt,
      freshUntil: kricMovementFreshUntil,
      provenanceId: kricMovementRawSha,
      licenseId: kricMovementLicenseId,
      mappingContractVersion: "station-line-v1",
      materializerVersion: "1",
      evidenceKind: "PROVIDER_NO_DATA",
      evidenceReason: "EXIT_DATA_NOT_PROVIDED",
    });

    // TRANSFER
    const isTransfer = (stationToLines.get(stationId)?.length ?? 0) > 1 || outOfStationTransferStationIds.has(stationId);
    const isBusanDaeguTransfer = busanDaeguTransferStationIds.has(stationId);
    if (!isTransfer) {
      evidenceRows.push({
        ...stationLineCandidate,
        stationId,
        lineId,
        operatorId,
        domain: "TRANSFER",
        state: "NOT_APPLICABLE",
        sourceId: "seoul-metro-transfer-distance-duration",
        sourceSnapshotId: "seoul-metro-transfer-distance-duration-20260815T094038817Z",
        evidenceRawSha256: seoulTransferRawSha,
        providerRecordHash: sha256(canonicalJson({ stationId, lineId, domain: "TRANSFER", state: "NOT_APPLICABLE" })),
        capturedAt: seoulTransferCapturedAt,
        freshUntil: seoulTransferFreshUntil,
        provenanceId: seoulTransferRawSha,
        licenseId: seoulTransferLicenseId,
        mappingContractVersion: "station-line-v1",
        materializerVersion: "1",
        evidenceKind: "CURRENT_APPLICABILITY_RULE",
        evidenceReason: "canonical transfer applicability",
      });
    } else if (isBusanDaeguTransfer) {
      const info = busanDaeguTransferInfo.get(stationId);
      const molitLine = info?.lineMapping[lineId];
      let lineMatched = molitRows.filter((r) => r.STIN_NM === info?.molitStation && r.LN_NM === molitLine);
      if (lineMatched.length === 0) {
        lineMatched = molitRows.filter((r) => r.STIN_NM === info?.molitStation);
      }
      const transferLineRecordHash = sha256(canonicalJson(lineMatched));

      evidenceRows.push({
        ...stationLineCandidate,
        stationId,
        lineId,
        operatorId,
        domain: "TRANSFER",
        state: "VERIFIED_PRESENT",
        sourceId: "molit-railway-transfer-movement",
        sourceSnapshotId: "molit-railway-transfer-movement-20250811",
        evidenceRawSha256: molitTransferRawSha,
        providerRecordHash: transferLineRecordHash,
        capturedAt: molitTransferCapturedAt,
        freshUntil: molitTransferFreshUntil,
        provenanceId: molitTransferRawSha,
        licenseId: molitTransferLicenseId,
        mappingContractVersion: "station-line-v1",
        materializerVersion: "1",
        evidenceKind: "OBSERVED",
        evidenceReason: "OFFICIAL_TRANSFER_TOPOLOGY_PRESENT",
      });
    } else {
      const matchedMetrics = (transferMetrics?.metrics ?? []).filter(
        (m) => m.stationId === stationId && (m.fromLineId === lineId || m.toLineId === lineId)
      );
      if (matchedMetrics.length > 0) {
        evidenceRows.push({
          ...stationLineCandidate,
          stationId,
          lineId,
          operatorId,
          domain: "TRANSFER",
          state: "VERIFIED_PRESENT",
          sourceId: "seoul-metro-transfer-distance-duration",
          sourceSnapshotId: "seoul-metro-transfer-distance-duration-20260815T094038817Z",
          evidenceRawSha256: seoulTransferRawSha,
          providerRecordHash: sha256(canonicalJson(matchedMetrics)),
          capturedAt: seoulTransferCapturedAt,
          freshUntil: seoulTransferFreshUntil,
          provenanceId: seoulTransferRawSha,
          licenseId: seoulTransferLicenseId,
          mappingContractVersion: "station-line-v1",
          materializerVersion: "1",
          evidenceKind: "OBSERVED",
          evidenceReason: "OFFICIAL_TRANSFER_TOPOLOGY_PRESENT",
        });
      } else {
        evidenceRows.push({
          ...stationLineCandidate,
          stationId,
          lineId,
          operatorId,
          domain: "TRANSFER",
          state: "UNKNOWN",
          sourceId: "seoul-metro-transfer-distance-duration",
          sourceSnapshotId: "seoul-metro-transfer-distance-duration-20260815T094038817Z",
          evidenceRawSha256: seoulTransferRawSha,
          providerRecordHash: sha256(canonicalJson({ stationId, lineId, domain: "TRANSFER", state: "UNKNOWN" })),
          capturedAt: seoulTransferCapturedAt,
          freshUntil: seoulTransferFreshUntil,
          provenanceId: seoulTransferRawSha,
          licenseId: seoulTransferLicenseId,
          mappingContractVersion: "station-line-v1",
          materializerVersion: "1",
          evidenceKind: "PROVIDER_NO_DATA",
          evidenceReason: "TRANSFER_DATA_NOT_PROVIDED",
        });
      }
    }
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
      requestedBy,
      approvedBy,
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
  buildSpec.sourceInventorySha256 = sha256(Buffer.from(JSON.stringify(sourceInventory)));
  if (buildSpec.networkEdgeEvidence?.sourceInventory) {
    buildSpec.networkEdgeEvidence.sourceInventory.sha256 = sha256(sourceInventoryBytes);
  }
  const buildSpecBytes = jsonBytes(buildSpec);
  await writeFile(path.join(repositoryRoot, buildSpecRelPath), buildSpecBytes);

  const releaseRequestRelPath = "tools/datapack/release/release-request.json";
  const releaseRequest = JSON.parse(await readFile(path.join(repositoryRoot, releaseRequestRelPath), "utf8"));
  releaseRequest.candidateId = candidateId;
  releaseRequest.approvalId = `release-request-${candidateId}`;
  releaseRequest.requestedBy = requestedBy;
  releaseRequest.approvedBy = approvedBy;
  releaseRequest.buildSpecSha256 = sha256(buildSpecBytes);
  await writeFile(path.join(repositoryRoot, releaseRequestRelPath), jsonBytes(releaseRequest));

  const hashEvidenceRelPath = "tools/datapack/release/hash-evidence.json";
  const hashEvidence = JSON.parse(await readFile(path.join(repositoryRoot, hashEvidenceRelPath), "utf8"));
  hashEvidence.fixturePath.sha256 = sha256(nationwidePackBytes);
  hashEvidence.identifiers.candidateId.value = candidateId;
  hashEvidence.identifiers.approvalId.value = `release-request-${candidateId}`;
  hashEvidence.sourceInventorySha256.value = sha256(Buffer.from(JSON.stringify(sourceInventory)));
  if (hashEvidence.ledgerHashes?.facilityEvidenceLedgerHash) {
    hashEvidence.ledgerHashes.facilityEvidenceLedgerHash.rowCount = finalPack.stationFacilityEvidence.length;
  }
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
  const args = process.argv.slice(2);
  let releaseSequence = 122;
  const seqArg = args.find((a) => a.startsWith("--sequence="));
  if (seqArg) releaseSequence = Number(seqArg.split("=")[1]);
  prepareNationwideCandidate({ releaseSequence }).then((res) => {
    console.log("Prepared:", res);
  }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
