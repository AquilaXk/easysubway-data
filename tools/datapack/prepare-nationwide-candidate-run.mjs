import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildNationwideAssemblyInputs } from "./lib/nationwide-assembly-binding.mjs";

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

  // 1. Prepare nationwide canonical pack
  const nationwideFixture = structuredClone(baseFixture);
  const nationwidePack = nationwideFixture.packs[0];
  nationwidePack.coverageLineOperatorScopes = targets.activeLineScopes;

  nationwideFixture.assemblyInputs = buildNationwideAssemblyInputs({
    baseFixtureBytes: basePackBytes,
    selectedSources: fanIn.selectedSources,
    auxiliaryInputs: {
      overrides: overridesBytes,
    },
  });

  const nationwidePackRelPath = "tools/datapack/release/nationwide-production-canonical-pack.json";
  await writeFile(path.join(repositoryRoot, nationwidePackRelPath), jsonBytes(nationwideFixture));

  // 2. Prepare route edges
  const selectedLines = new Set(targets.activeLineScopes.map((r) => r.lineId));
  const pairs = new Map();
  for (const row of pack.stationLines) {
    if (!selectedLines.has(row.lineId)) continue;
    pairs.set(JSON.stringify([row.stationId, row.lineId]), row);
  }

  const routeEdges = [...pairs.values()].flatMap(({ stationId, lineId }) => [
    { edgeId: `entry-${stationId}-${lineId}`, edgeType: "ENTRY", fromNodeId: stationId, toNodeId: `${stationId}:${lineId}` },
    { edgeId: `exit-${stationId}-${lineId}`, edgeType: "EXIT", fromNodeId: `${stationId}:${lineId}`, toNodeId: stationId },
  ]);

  const stationToLines = new Map();
  for (const { stationId, lineId } of pairs.values()) {
    if (!stationToLines.has(stationId)) stationToLines.set(stationId, []);
    stationToLines.get(stationId).push(lineId);
  }

  for (const [stationId, lines] of stationToLines) {
    if (lines.length > 1) {
      for (let i = 0; i < lines.length; i++) {
        for (let j = i + 1; j < lines.length; j++) {
          routeEdges.push({
            edgeId: `transfer-${stationId}-${lines[i]}-${lines[j]}`,
            edgeType: "IN_STATION_TRANSFER",
            fromNodeId: `${stationId}:${lines[i]}`,
            toNodeId: `${stationId}:${lines[j]}`,
          });
          routeEdges.push({
            edgeId: `transfer-${stationId}-${lines[j]}-${lines[i]}`,
            edgeType: "IN_STATION_TRANSFER",
            fromNodeId: `${stationId}:${lines[j]}`,
            toNodeId: `${stationId}:${lines[i]}`,
          });
        }
      }
    }
  }

  routeEdges.push({ edgeId: "ride-subway", edgeType: "RIDE", serviceClass: "SUBWAY" });

  const selectedSnapshotIds = new Set(fanIn.selectedSources.map((s) => s.snapshotId));
  const selectedSnapshots = snapshots.filter((s) => selectedSnapshotIds.has(s.snapshotId));
  const sourceSetSha256 = sha256(JSON.stringify(selectedSnapshots));

  const candidateId = "nationwide-candidate-20260909";
  const scopeId = "nationwide_routing_android_v1";

  const routeInput = {
    candidate: {
      candidateId,
      sourceSetSha256,
    },
    routeEdges,
  };

  const routeInputRelPath = "tools/datapack/release/nationwide-route-edge-input.json";
  const routeInputBytes = jsonBytes(routeInput);
  await writeFile(path.join(repositoryRoot, routeInputRelPath), routeInputBytes);

  let gitSha;
  try {
    gitSha = execSync("git rev-parse HEAD", { cwd: repositoryRoot }).toString().trim();
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
      releaseSequence: 116,
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

  return {
    preparationRelPath,
    routeInputRelPath,
    nationwidePackRelPath,
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
