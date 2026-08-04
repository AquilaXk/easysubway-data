#!/usr/bin/env node
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { collectKricAccessibilityProviderTupleEvidence } from "./collect-kric-accessibility-snapshots.mjs";
import { isMainModule } from "../lib/is-main-module.mjs";

const FACILITY_OPERATION_IDS = Object.freeze([
  "kric-station-elevator",
  "kric-station-escalator",
  "kric-wheelchair-lift-location",
  "kric-station-elevator-movement",
  "kric-wheelchair-lift-movement",
]);
const RESOLUTION_PATH = new URL("./sources/facility-gap-resolution-evidence-20260731.json", import.meta.url);
const ROUTE_ROSTERS_PATH = new URL("./sources/kric-nationwide-route-rosters-20260730T203926676Z.json", import.meta.url);
const CANDIDATES_PATH = new URL("./source-candidates.json", import.meta.url);

export function resolveKricFacilityProviderProbe({ resolution, routeRosters, candidatesDocument } = {}) {
  if (resolution?.schemaVersion !== 1
    || resolution?.artifactKind !== "facility-gap-resolution-evidence"
    || resolution?.admissionState !== "BLOCKED"
    || resolution?.productionAdmissionAllowed !== false
    || !Array.isArray(resolution?.blockedGroups)
    || !Array.isArray(routeRosters?.rosters)
    || !Array.isArray(candidatesDocument?.candidates)) {
    throw new Error("KRIC FACILITY provider probe inputs are invalid");
  }
  const providerTupleStrings = resolution.blockedGroups
    .filter(({ operatorCode }) => ["GX", "KR"].includes(operatorCode))
    .flatMap(({ providerTuples }) => providerTuples ?? [])
    .sort(compare);
  if (providerTupleStrings.length !== 20 || new Set(providerTupleStrings).size !== 20) {
    throw new Error("KRIC FACILITY provider tuple set is invalid");
  }
  const namesByTuple = new Map();
  for (const roster of routeRosters.rosters) {
    for (const station of roster?.stations ?? []) {
      const key = providerTuple(station);
      const names = namesByTuple.get(key) ?? new Set();
      if (typeof station?.stinNm === "string" && station.stinNm !== "") names.add(station.stinNm);
      namesByTuple.set(key, names);
    }
  }
  const tuples = providerTupleStrings.map((tuple) => {
    const [railOprIsttCd, lnCd, stinCd, extra] = tuple.split("/");
    const names = [...(namesByTuple.get(tuple) ?? [])];
    if (extra !== undefined || !railOprIsttCd || !lnCd || !stinCd || names.length !== 1) {
      throw new Error(`KRIC FACILITY provider tuple identity is invalid: ${tuple}`);
    }
    return { railOprIsttCd, lnCd, stinCd, stationName: names[0] };
  });
  const operations = FACILITY_OPERATION_IDS.map((sourceId) => {
    const candidate = candidatesDocument.candidates.find(({ id }) => id === sourceId);
    const endpoint = candidate?.operation?.endpoint;
    const responseFields = candidate?.operation?.responseFields;
    if (candidate?.requestUrl !== endpoint || !Array.isArray(responseFields) || responseFields.length === 0) {
      throw new Error(`KRIC FACILITY operation contract is invalid: ${sourceId}`);
    }
    return {
      sourceId,
      endpoint,
      responseFields: [...responseFields],
      tupleIdentityFields: ["railOprIsttCd", "lnCd", "stinCd"],
    };
  });
  return { tuples, operations };
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index]?.startsWith("--") || argv[index + 1] === undefined) throw new Error("invalid arguments");
    args[argv[index].slice(2)] = argv[index + 1];
  }
  if (!path.isAbsolute(args.output ?? "")) throw new Error("--output must be absolute");
  const requestIntervalMs = Number(args["request-interval-ms"] ?? 250);
  if (!Number.isInteger(requestIntervalMs) || requestIntervalMs < 0 || requestIntervalMs > 60_000) {
    throw new Error("--request-interval-ms is invalid");
  }
  return { output: args.output, requestIntervalMs };
}

async function main(argv) {
  const { output, requestIntervalMs } = parseArgs(argv);
  await rm(output, { force: true });
  const [resolution, routeRosters, candidatesDocument] = await Promise.all([
    readFile(RESOLUTION_PATH, "utf8").then(JSON.parse),
    readFile(ROUTE_ROSTERS_PATH, "utf8").then(JSON.parse),
    readFile(CANDIDATES_PATH, "utf8").then(JSON.parse),
  ]);
  const input = resolveKricFacilityProviderProbe({ resolution, routeRosters, candidatesDocument });
  const evidence = await collectKricAccessibilityProviderTupleEvidence({
    ...input,
    serviceKey: process.env.KRIC_SERVICE_KEY,
    requestIntervalMs,
  });
  await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`KRIC FACILITY provider tuple probe ready: operations=${evidence.operationCount} queries=${evidence.queryCount} rows=${evidence.rowCount}\n`);
}

function providerTuple(value) {
  return [value?.railOprIsttCd, value?.lnCd, value?.stinCd].join("/");
}

function compare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

if (isMainModule(import.meta.url)) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "KRIC FACILITY provider tuple probe failed"}\n`);
    process.exitCode = 1;
  }
}
