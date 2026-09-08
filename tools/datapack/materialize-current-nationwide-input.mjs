#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  parseCurrentMolitDaeguStationMappings,
  parseCurrentMolitDaejeonStationMappings,
} from "./build-molit-nationwide-fixture.mjs";
import { DAEGU_LINES } from "./collect-daegu-datapack-sources.mjs";
import { loadCurrentMolitGwangjuStationMappings } from "./current-molit-observation.mjs";
import { readSelectedSourceSnapshot } from "./lib/source-admission-input.mjs";
import { materializeBusanRouteTopology, parseCanonicalBusanStationMappings } from "./materialize-busan-route-topology.mjs";
import { materializeBusanTimetable } from "./materialize-busan-timetable.mjs";
import { materializeDaeguTimetable } from "./materialize-daegu-timetable.mjs";
import { materializeDaejeonTimetable } from "./materialize-daejeon-timetable.mjs";
import { materializeGwangjuTimetable, restoreAdmittedGwangjuTimetable } from "./materialize-gwangju-timetable.mjs";
import { materializeKorailTimetable } from "./materialize-korail-timetable.mjs";

const INVENTORY_PATH = "tools/datapack/source-inventory.json";
const SNAPSHOT_LEDGER_PATH = "tools/datapack/release/source-snapshots.json";
const ROOT = path.resolve(import.meta.dirname, "../..");

export { readSelectedSourceSnapshot } from "./lib/source-admission-input.mjs";

export async function materializeCurrentNationwideInput({
  repositoryRoot = ROOT,
  baseFixturePath,
  retainedGwangjuObservationPath,
  busanStationMapPath,
  outputPath,
  now = new Date(),
} = {}) {
  if (!(now instanceof Date) || Number.isNaN(now.valueOf())) {
    throw new Error("nationwide materialization time is invalid");
  }
  const root = path.resolve(repositoryRoot);
  const trackedBytes = new Map();
  const readTracked = async (relativePath) => {
    const resolved = path.resolve(root, relativePath);
    if (!resolved.startsWith(`${root}${path.sep}`)) {
      throw new Error(`tracked input path is unsafe: ${relativePath}`);
    }
    if (!trackedBytes.has(resolved)) trackedBytes.set(resolved, await readFile(resolved));
    return trackedBytes.get(resolved);
  };
  const readAbsoluteTracked = async (inputPath, label) => {
    if (typeof inputPath !== "string" || !path.isAbsolute(inputPath)) {
      throw new Error(`${label} must be an absolute path`);
    }
    const resolved = path.resolve(inputPath);
    if (!trackedBytes.has(resolved)) trackedBytes.set(resolved, await readFile(resolved));
    return trackedBytes.get(resolved);
  };
  if (typeof outputPath !== "string" || !path.isAbsolute(outputPath)) {
    throw new Error("output path must be absolute");
  }

  const [baseFixtureBytes, retainedGwangjuObservationBytes, busanStationMapBytes, inventoryBytes, snapshotsBytes] =
    await Promise.all([
      readAbsoluteTracked(baseFixturePath, "base fixture"),
      readAbsoluteTracked(retainedGwangjuObservationPath, "retained Gwangju observation"),
      readAbsoluteTracked(busanStationMapPath, "Busan station map"),
      readTracked(INVENTORY_PATH),
      readTracked(SNAPSHOT_LEDGER_PATH),
    ]);
  const baseFixture = parseJson(baseFixtureBytes, "base fixture");
  if (!Array.isArray(baseFixture.packs) || baseFixture.packs.length !== 1
    || baseFixture.packs[0].artifactKind !== "production"
    || baseFixture.manifest?.activePack?.id !== baseFixture.packs[0].id
    || baseFixture.manifest.activePack.version !== baseFixture.packs[0].version) {
    throw new Error("nationwide materialization requires one canonical active production pack");
  }
  const inventory = parseJson(inventoryBytes, "source inventory");
  const snapshots = parseJson(snapshotsBytes, "source snapshot ledger");
  const selected = (sourceId, evidenceKind) => readSelectedSourceSnapshot({
    inventory,
    sourceId,
    evidenceKind,
    readTracked,
  });
  const [korailTimetable, busanTopology, busanTimetable, daejeonTopology, daejeonTimetable, gwangjuTopology,
    ...daeguSnapshots] = await Promise.all([
    selected("korail-metropolitan-planned-timetable", "scheduleAdmissionEvidence"),
    selected("busan-transportation-route-topology", "topologyAdmissionEvidence"),
    selected("busan-transportation-timetable", "scheduleAdmissionEvidence"),
    selected("daejeon-station-distance-fare", "topologyAdmissionEvidence"),
    selected("daejeon-train-timetable", "scheduleAdmissionEvidence"),
    selected("gwangju-transportation-route-topology", "topologyAdmissionEvidence"),
    ...DAEGU_LINES.flatMap((line) => [
      selected(`daegu-line${line.lineNumber}-route-topology`, "topologyAdmissionEvidence"),
      selected(`daegu-line${line.lineNumber}-train-timetable`, "scheduleAdmissionEvidence"),
    ]),
  ]);
  const currentMolit = await loadCurrentMolitGwangjuStationMappings({
    repositoryRoot: root,
    inventory,
    inventoryBytes,
    snapshots,
    snapshotsBytes,
    readTracked,
    topologySnapshot: gwangjuTopology,
  });
  const daeguTopologySnapshots = {};
  const daeguTimetableSnapshots = {};
  const daeguMappings = {};
  for (const [index, line] of DAEGU_LINES.entries()) {
    daeguTopologySnapshots[line.lineNumber] = daeguSnapshots[index * 2];
    daeguTimetableSnapshots[line.lineNumber] = daeguSnapshots[index * 2 + 1];
    daeguMappings[line.lineNumber] = parseCurrentMolitDaeguStationMappings(
      currentMolit.observation.normalizedProjection,
      currentMolit.current.rawSha256,
      line.lineName,
    );
  }
  const daejeonMappings = parseCurrentMolitDaejeonStationMappings(
    currentMolit.observation.normalizedProjection,
    currentMolit.current.rawSha256,
  );
  const retainedGwangjuTimetable = restoreAdmittedGwangjuTimetable({
    observationBytes: retainedGwangjuObservationBytes,
    inventory,
    snapshots,
  });

  let fixture = { ...baseFixture, packs: [materializeKorailTimetable({
    pack: baseFixture?.packs?.[0], snapshot: korailTimetable, inventory, ledger: snapshots, now,
  })] };
  fixture = materializeBusanRouteTopology({
    baseFixture: fixture,
    snapshot: busanTopology,
    inventory,
    canonicalStationMappings: parseCanonicalBusanStationMappings(busanStationMapBytes.toString("utf8")),
    now,
  });
  fixture = materializeDaejeonTimetable({
    baseFixture: fixture,
    timetableSnapshot: daejeonTimetable,
    topologySnapshot: daejeonTopology,
    inventory,
    canonicalStationMappings: daejeonMappings,
    now,
  });
  fixture = materializeBusanTimetable({
    baseFixture: fixture,
    timetableSnapshot: busanTimetable,
    topologySnapshot: busanTopology,
    inventory,
    now,
  });
  fixture = materializeGwangjuTimetable({
    baseFixture: fixture,
    retainedTimetable: retainedGwangjuTimetable,
    topologySnapshot: gwangjuTopology,
    inventory,
    canonicalStationMappings: currentMolit.mappings,
    now,
  });
  fixture = materializeDaeguTimetable({
    baseFixture: fixture,
    topologySnapshots: daeguTopologySnapshots,
    timetableSnapshots: daeguTimetableSnapshots,
    inventory,
    canonicalStationMappings: daeguMappings,
    now,
  });

  await assertTrackedInputsStable(trackedBytes);
  await writeFile(path.resolve(outputPath), `${JSON.stringify(fixture, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  return fixture;
}

async function assertTrackedInputsStable(trackedBytes) {
  for (const [inputPath, expected] of trackedBytes) {
    const current = await readFile(inputPath);
    if (!expected.equals(current)) {
      throw new Error(`nationwide materialization input drift: ${inputPath}`);
    }
  }
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(bytes);
  } catch {
    throw new Error(`nationwide ${label} is invalid`);
  }
}

function parseArgs(argv) {
  const flags = [
    "--base-fixture",
    "--retained-gwangju-observation",
    "--busan-station-map",
    "--output",
  ];
  if (!Array.isArray(argv) || argv.length !== flags.length * 2
    || flags.some((flag, index) => argv[index * 2] !== flag)
    || flags.some((_, index) => !path.isAbsolute(argv[index * 2 + 1]))) {
    throw new Error("usage: materialize-current-nationwide-input.mjs --base-fixture <absolute> --retained-gwangju-observation <absolute> --busan-station-map <absolute> --output <absolute>");
  }
  return Object.fromEntries(flags.map((flag, index) => [flag.slice(2), argv[index * 2 + 1]]));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    await materializeCurrentNationwideInput({
      repositoryRoot: ROOT,
      baseFixturePath: args["base-fixture"],
      retainedGwangjuObservationPath: args["retained-gwangju-observation"],
      busanStationMapPath: args["busan-station-map"],
      outputPath: args.output,
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : "nationwide input materialization failed");
    process.exitCode = 1;
  }
}
