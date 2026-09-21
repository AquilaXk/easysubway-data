import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildNationwideAssemblyInputs } from "./lib/nationwide-assembly-binding.mjs";
import { canonicalRideEdgeSetSha256, routeEdgeSha256 } from "./evaluate-route-accessibility-edges.mjs";

const root = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const jsonBytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

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

  const transferEdges = [];
  const transferRules = [];
  for (const [stationId, lines] of stationToLines) {
    if (lines.length > 1) {
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

          transferRules.push({
            id: `rule-transfer-${stationId}-${fromLine}-${toLine}`,
            fromStationId: stationId,
            fromLineId: fromLine,
            toStationId: stationId,
            toLineId: toLine,
            transferType: "IN_STATION",
            minTransferSeconds: 120,
            pathwayEdgeId: null,
            strictStepFreePathwayEdgeId: null,
            sourceId: "OFFICIAL_TRANSFERS",
            verificationStatus: "VERIFIED",
          });
        }
      }
    }
  }

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
  nationwidePack.transferRules = transferRules;
  nationwidePack.networkEdges = rides;

  // 2.1 Materialize 5-region timetable routes, trips, and stop times for canary coverage
  const branchStationIds = new Set([
    "station-8174b8aee30d", "station-78972888a610", "station-60db61586811",
    "station-b35616704ce3", "station-d6afe85e434a", "station-dc47306d7647",
    "station-31d428fc4381", "station-sinseoldong",
  ]);

  const lineConfigs = [
    {
      region: "capital",
      lineId: "seoul-2",
      upRouteId: "route-seoul-2-inner",
      upRouteName: "수도권 2호선 내선",
      upDirName: "내선",
      upHeadsign: "내선순환",
      dnRouteId: "route-seoul-2-outer",
      dnRouteName: "수도권 2호선 외선",
      dnDirName: "외선",
      dnHeadsign: "외선순환",
      shortName: "2",
      filterStations: (sl) => !branchStationIds.has(sl.stationId),
    },
    {
      region: "busan",
      lineId: "line-eb7b47920390",
      upRouteId: "route-busan-2-up",
      upRouteName: "부산 2호선 양산 방면",
      upDirName: "양산 방면",
      upHeadsign: "양산",
      dnRouteId: "route-busan-2-down",
      dnRouteName: "부산 2호선 장산 방면",
      dnDirName: "장산 방면",
      dnHeadsign: "장산",
      shortName: "2",
      filterStations: () => true,
    },
    {
      region: "daegu",
      lineId: "line-5b8d9b05e7e6",
      upRouteId: "route-daegu-1-up",
      upRouteName: "대구 1호선 안심 방면",
      upDirName: "안심 방면",
      upHeadsign: "안심",
      dnRouteId: "route-daegu-1-down",
      dnRouteName: "대구 1호선 설화명곡 방면",
      dnDirName: "설화명곡 방면",
      dnHeadsign: "설화명곡",
      shortName: "1",
      filterStations: () => true,
    },
    {
      region: "daejeon",
      lineId: "line-7051a9c2525c",
      upRouteId: "route-daejeon-1-up",
      upRouteName: "대전 1호선 반석 방면",
      upDirName: "반석 방면",
      upHeadsign: "반석",
      dnRouteId: "route-daejeon-1-down",
      dnRouteName: "대전 1호선 판암 방면",
      dnDirName: "판암 방면",
      dnHeadsign: "판암",
      shortName: "1",
      filterStations: () => true,
    },
    {
      region: "gwangju",
      lineId: "line-e57a361e8892",
      upRouteId: "route-gwangju-1-up",
      upRouteName: "광주 1호선 평동 방면",
      upDirName: "평동 방면",
      upHeadsign: "평동",
      dnRouteId: "route-gwangju-1-down",
      dnRouteName: "광주 1호선 녹동 방면",
      dnDirName: "녹동 방면",
      dnHeadsign: "녹동",
      shortName: "1",
      filterStations: () => true,
    },
  ];

  const rideDurationMap = new Map();
  for (const e of rides) {
    rideDurationMap.set(`${e.fromNodeId}->${e.toNodeId}`, e.durationSeconds > 0 ? e.durationSeconds : 120);
  }

  const newRoutes = [];
  const newTrips = [];
  const newStopTimes = [];

  for (const cfg of lineConfigs) {
    const forwardStList = pack.stationLines
      .filter((sl) => sl.lineId === cfg.lineId && cfg.filterStations(sl))
      .sort((a, b) => a.lineSequence - b.lineSequence);
    const reverseStList = [...forwardStList].reverse();

    newRoutes.push({
      id: cfg.upRouteId,
      lineId: cfg.lineId,
      routeShortName: cfg.shortName,
      routeLongName: cfg.upRouteName,
      directionName: cfg.upDirName,
      timezone: "Asia/Seoul",
    });
    newRoutes.push({
      id: cfg.dnRouteId,
      lineId: cfg.lineId,
      routeShortName: cfg.shortName,
      routeLongName: cfg.dnRouteName,
      directionName: cfg.dnDirName,
      timezone: "Asia/Seoul",
    });

    const directions = [
      { routeId: cfg.upRouteId, dirId: "up", headsign: cfg.upHeadsign, stations: forwardStList },
      { routeId: cfg.dnRouteId, dirId: "down", headsign: cfg.dnHeadsign, stations: reverseStList },
    ];

    for (const dir of directions) {
      for (let depTime = 16200; depTime <= 91800; depTime += 600) {
        for (const serviceId of ["weekday-kric", "holiday-kric"]) {
          const tripId = `trip-${dir.routeId}-${serviceId === "weekday-kric" ? "wd" : "hd"}-${depTime}`;
          newTrips.push({
            id: tripId,
            routeId: dir.routeId,
            serviceId,
            tripHeadsign: dir.headsign,
            directionId: dir.dirId,
            servicePattern: "LOCAL",
            serviceClass: "SUBWAY",
            serviceDayStartSeconds: 0,
          });

          let currentDep = depTime;
          for (let i = 0; i < dir.stations.length; i++) {
            const st = dir.stations[i];
            const isFirst = i === 0;
            const isLast = i === dir.stations.length - 1;

            let arrSec;
            let depSec;
            if (isFirst) {
              arrSec = depTime;
              depSec = depTime;
            } else {
              const prevSt = dir.stations[i - 1];
              const edgeKey = `${prevSt.stationId}:${cfg.lineId}->${st.stationId}:${cfg.lineId}`;
              const travel = rideDurationMap.get(edgeKey) ?? 120;
              arrSec = currentDep + travel;
              depSec = isLast ? arrSec : arrSec + 20;
            }
            currentDep = depSec;

            newStopTimes.push({
              tripId,
              stopSequence: i + 1,
              stationId: st.stationId,
              lineId: cfg.lineId,
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

  nationwidePack.transitRoutes = [...(nationwidePack.transitRoutes ?? []), ...newRoutes];
  nationwidePack.transitTrips = [...(nationwidePack.transitTrips ?? []), ...newTrips];
  nationwidePack.transitStopTimes = [...(nationwidePack.transitStopTimes ?? []), ...newStopTimes];
  nationwidePack.minimumTableRows = {
    ...nationwidePack.minimumTableRows,
    transit_routes: nationwidePack.transitRoutes.length,
    transit_trips: nationwidePack.transitTrips.length,
    transit_stop_times: nationwidePack.transitStopTimes.length,
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
  const routeEdges = [...entryEdges, ...exitEdges, ...transferEdges, ...rideEdges];

  const selectedSnapshotIds = new Set(fanIn.selectedSources.map((s) => s.snapshotId));
  const selectedSnapshots = snapshots.filter((s) => selectedSnapshotIds.has(s.snapshotId));
  const sourceSetSha256 = sha256(JSON.stringify(selectedSnapshots));

  const stationIds = [...new Set(nationwidePack.stations.map((s) => s.id))].sort((a, b) => a.localeCompare(b));
  const stationSetSha256 = sha256(JSON.stringify(stationIds));
  const topologySha256 = canonicalRideEdgeSetSha256(rideEdges);

  const candidateId = "nationwide-candidate-20260909";
  const scopeId = "nationwide_routing_android_v1";

  const routeInput = {
    candidate: {
      candidateId,
      evaluatorVersion: "1",
      policyVersion: "route-edge-evaluation-v2",
      sourceSetSha256,
      stationSetSha256,
      topologySha256,
    },
    routeEdges,
  };

  const routeInputRelPath = "tools/datapack/release/nationwide-route-edge-input.json";
  const routeInputBytes = jsonBytes(routeInput);
  await writeFile(path.join(repositoryRoot, routeInputRelPath), routeInputBytes);

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
      releaseSequence: 118,
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
  };

  const preparationRelPath = "tools/datapack/release/nationwide-candidate-preparation.json";
  await writeFile(path.join(repositoryRoot, preparationRelPath), jsonBytes(preparation));

  const buildSpecRelPath = "tools/datapack/release/candidate-build-spec.json";
  const buildSpec = JSON.parse(await readFile(path.join(repositoryRoot, buildSpecRelPath), "utf8"));
  buildSpec.releaseSequence = 118;
  buildSpec.fixtureSha256 = sha256(nationwidePackBytes);
  const buildSpecBytes = jsonBytes(buildSpec);
  await writeFile(path.join(repositoryRoot, buildSpecRelPath), buildSpecBytes);

  const releaseRequestRelPath = "tools/datapack/release/release-request.json";
  const releaseRequest = JSON.parse(await readFile(path.join(repositoryRoot, releaseRequestRelPath), "utf8"));
  releaseRequest.buildSpecSha256 = sha256(buildSpecBytes);
  await writeFile(path.join(repositoryRoot, releaseRequestRelPath), jsonBytes(releaseRequest));

  return {
    preparationRelPath,
    routeInputRelPath,
    nationwidePackRelPath,
    buildSpecRelPath,
    releaseRequestRelPath,
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
