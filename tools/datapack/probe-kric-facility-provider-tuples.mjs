#!/usr/bin/env node
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { collectKricAccessibilityProviderTupleEvidence } from "./collect-kric-accessibility-snapshots.mjs";
import { assertKricControlOperation } from "./collect-kric-source-candidate-evidence.mjs";
import {
  assertProviderCredentialIntegrity,
  resolveProviderCallIntegrity,
} from "./lib/provider-call-integrity.mjs";
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
const ROUTE_ROSTERS_FILE = "kric-nationwide-route-rosters-20260730T203926676Z.json";

export function resolveKricFacilityProviderProbe({ resolution, routeRosters, candidatesDocument } = {}) {
  if (resolution?.schemaVersion !== 1
    || resolution?.artifactKind !== "facility-gap-resolution-evidence"
    || resolution?.admissionState !== "BLOCKED"
    || resolution?.productionAdmissionAllowed !== false
    || !Array.isArray(resolution?.blockedGroups)
    || !resolution?.evaluatedSourceSnapshots?.includes(ROUTE_ROSTERS_FILE)
    || routeRosters?.schemaVersion !== 1
    || routeRosters?.artifactKind !== "kric-nationwide-route-rosters"
    || routeRosters?.sourceId !== "kric-subway-route-info"
    || routeRosters?.credentialRedacted !== true
    || !Number.isFinite(Date.parse(routeRosters?.capturedAt))
    || !Array.isArray(routeRosters?.rosters)
    || routeRosters.requestCount !== routeRosters.rosters.length
    || routeRosters.rosters.some((roster) => (
      roster?.schemaVersion !== 1
      || roster?.artifactKind !== "kric-route-roster"
      || roster?.sourceId !== routeRosters.sourceId
      || roster?.capturedAt !== routeRosters.capturedAt
      || roster?.credentialRedacted !== true
      || roster?.resultCode !== "00"
      || !Number.isInteger(roster?.stationCount)
      || roster.stationCount < 0
      || !Array.isArray(roster?.stations)
      || roster?.stationCount !== roster?.stations?.length
    ))
    || !Array.isArray(candidatesDocument?.candidates)) {
    throw new Error("KRIC FACILITY provider probe inputs are invalid");
  }
  const blockedGroups = resolution.blockedGroups.filter(({ operatorCode }) => ["GX", "KR"].includes(operatorCode));
  if (blockedGroups.length !== 2 || new Set(blockedGroups.map(({ operatorCode }) => operatorCode)).size !== 2) {
    throw new Error("KRIC FACILITY blocked groups are invalid");
  }
  const providerTupleStrings = blockedGroups
    .flatMap(({ operatorCode, providerTuples }) => {
      if (!Array.isArray(providerTuples) || providerTuples.some((tuple) => !tuple.startsWith(`${operatorCode}/`))) {
        throw new Error(`KRIC FACILITY blocked group is invalid: ${operatorCode}`);
      }
      return providerTuples;
    })
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
  const operations = FACILITY_OPERATION_IDS.map((sourceId) => resolveOperation(candidatesDocument, sourceId));
  return { tuples, operations };
}

export async function preflightKricFacilityProviderProbe({
  candidatesDocument,
  serviceKey,
  fetchImpl = fetch,
  requestIntervalMs = 0,
  delayImpl = delay,
} = {}) {
  const integrity = resolveProviderCallIntegrity(candidatesDocument, "kric");
  assertProviderCredentialIntegrity({ providerId: "kric", credential: serviceKey, contract: integrity.credential });
  const control = assertKricControlOperation(candidatesDocument, integrity.controlOperation);
  if (control.format !== "json") throw new Error("KRIC FACILITY control operation format is invalid");
  const sampleUrl = new URL(control.sampleUrl);
  const tuple = Object.fromEntries(["railOprIsttCd", "lnCd", "stinCd"].map((field) => [
    field, sampleUrl.searchParams.get(field),
  ]));
  const evidence = await collectKricAccessibilityProviderTupleEvidence({
    tuples: [{ ...tuple, stationName: "CONTROL" }],
    operations: [{
      sourceId: control.candidateId,
      endpoint: control.endpoint,
      responseFields: [...control.expectedSuccess.requiredFields],
      tupleIdentityFields: [],
    }],
    serviceKey,
    fetchImpl,
    requestIntervalMs,
    delayImpl,
  });
  if (evidence.rowCount < control.expectedSuccess.minimumRowCount) {
    throw new Error("KRIC FACILITY control operation success contract is invalid");
  }
  if (requestIntervalMs > 0) await delayImpl(requestIntervalMs);
  return { credentialRedacted: true, controlOperationId: control.candidateId };
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index]?.startsWith("--") || argv[index + 1] === undefined) throw new Error("invalid arguments");
    const name = argv[index].slice(2);
    if (!["output", "request-interval-ms"].includes(name) || Object.hasOwn(args, name)) {
      throw new Error("invalid arguments");
    }
    args[name] = argv[index + 1];
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
  const serviceKey = process.env.KRIC_SERVICE_KEY;
  await preflightKricFacilityProviderProbe({ candidatesDocument, serviceKey, requestIntervalMs });
  const evidence = await collectKricAccessibilityProviderTupleEvidence({
    ...input,
    serviceKey,
    requestIntervalMs,
  });
  await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`KRIC FACILITY provider tuple probe ready: operations=${evidence.operationCount} queries=${evidence.queryCount} rows=${evidence.rowCount}\n`);
}

function resolveOperation(candidatesDocument, sourceId) {
  const matches = candidatesDocument?.candidates?.filter(({ id }) => id === sourceId) ?? [];
  const [candidate] = matches;
  const endpoint = candidate?.operation?.endpoint;
  const responseFields = candidate?.operation?.responseFields;
  if (matches.length !== 1 || candidate?.requestUrl !== endpoint
    || !Array.isArray(responseFields) || responseFields.length === 0) {
    throw new Error(`KRIC FACILITY operation contract is invalid: ${sourceId}`);
  }
  return {
    sourceId,
    endpoint,
    responseFields: [...responseFields],
    tupleIdentityFields: ["railOprIsttCd", "lnCd", "stinCd"],
  };
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
