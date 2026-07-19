#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { collectKricRouteRoster } from "./collect-kric-route-roster.mjs";

export async function collectKricNationwideRouteRosters({
  targets,
  fixture,
  serviceKey,
  collectImpl = collectKricRouteRoster,
  now = new Date(),
  concurrency = 3,
} = {}) {
  requiredString(serviceKey, "KRIC_SERVICE_KEY");
  const targetVersion = requiredString(targets?.targetVersion, "targets.targetVersion");
  if (!Array.isArray(targets?.activeLineScopes) || targets.activeLineScopes.length === 0) {
    throw new Error("targets.activeLineScopes is required");
  }
  if (!Array.isArray(fixture?.providerLineScopes) || fixture.providerLineScopes.length === 0) {
    throw new Error("fixture.providerLineScopes is required");
  }
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) throw new Error("concurrency is invalid");

  const providerScopeByKey = new Map();
  for (const scope of fixture.providerLineScopes) {
    const key = scopeKey(scope);
    if (providerScopeByKey.has(key)) throw new Error(`duplicate fixture provider scope: ${key}`);
    for (const field of ["mreaWideCd", "lnCd", "railOprIsttCd"]) requiredString(scope[field], `provider scope ${key}.${field}`);
    providerScopeByKey.set(key, scope);
  }
  const seenTargetScopeKeys = new Set();
  const providerScopes = targets.activeLineScopes.map((scope) => {
    const key = scopeKey(scope);
    if (seenTargetScopeKeys.has(key)) throw new Error(`duplicate target active line scope: ${key}`);
    seenTargetScopeKeys.add(key);
    const providerScope = providerScopeByKey.get(key);
    if (!providerScope) throw new Error(`target/provider scope set does not match: ${key}`);
    return providerScope;
  });

  const requests = [...new Map(providerScopes.map((scope) => [
    `${scope.mreaWideCd}:${scope.lnCd}`,
    { mreaWideCd: scope.mreaWideCd, lnCd: scope.lnCd },
  ])).values()].sort((left, right) => (
    left.mreaWideCd.localeCompare(right.mreaWideCd) || left.lnCd.localeCompare(right.lnCd)
  ));
  const rosters = new Array(requests.length);
  let nextRequest = 0;
  let aborted = false;
  const failures = [];
  const worker = async () => {
    while (!aborted && nextRequest < requests.length) {
      const requestIndex = nextRequest;
      nextRequest += 1;
      try {
        rosters[requestIndex] = await collectImpl({ ...requests[requestIndex], serviceKey, now });
      } catch (error) {
        aborted = true;
        failures.push(error);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, requests.length) }, () => worker()));
  if (failures.length > 0) {
    throw new AggregateError(failures, "KRIC nationwide roster collection failed");
  }

  const rosterByRequest = new Map(rosters.map((roster) => [`${roster.mreaWideCd}:${roster.lnCd}`, roster]));
  for (const scope of providerScopes) {
    const roster = rosterByRequest.get(`${scope.mreaWideCd}:${scope.lnCd}`);
    if (roster?.artifactKind !== "kric-route-roster" || roster.resultCode !== "00" || !Array.isArray(roster.stations)) {
      throw new Error(`KRIC nationwide roster schema is invalid: ${scope.mreaWideCd}:${scope.lnCd}`);
    }
    if (!roster.stations.some(({ railOprIsttCd }) => railOprIsttCd === scope.railOprIsttCd)) {
      throw new Error(`KRIC provider operator row is missing: ${scope.railOprIsttCd}/${scope.lnCd}`);
    }
  }

  return {
    schemaVersion: 1,
    artifactKind: "kric-nationwide-route-rosters",
    sourceId: "kric-subway-route-info",
    targetVersion,
    capturedAt: now.toISOString(),
    credentialRedacted: true,
    providerScopeCount: providerScopes.length,
    requestCount: requests.length,
    providerScopes,
    rosters,
  };
}

function scopeKey(scope) {
  return ["regionId", "operatorId", "lineId"].map((field) => requiredString(scope?.[field], `scope.${field}`)).join(":");
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} is required`);
  return value;
}

export function parseArgs(argv) {
  if (argv.length !== 6 || argv[0] !== "--targets" || argv[2] !== "--fixture" || argv[4] !== "--output") {
    throw new Error("usage: collect-kric-nationwide-route-rosters.mjs --targets <targets.json> --fixture <fixture.json> --output <absolute.json>");
  }
  if (!path.isAbsolute(argv[5])) throw new Error("--output must be absolute");
  return { targets: argv[1], fixture: argv[3], output: argv[5] };
}

export async function main(argv, {
  serviceKey = process.env.KRIC_SERVICE_KEY,
  readFileImpl = readFile,
  writeFileImpl = writeFile,
  collectRostersImpl = collectKricNationwideRouteRosters,
  log = console.log,
} = {}) {
  const args = parseArgs(argv);
  const targets = JSON.parse(await readFileImpl(args.targets, "utf8"));
  const fixture = JSON.parse(await readFileImpl(args.fixture, "utf8"));
  const result = await collectRostersImpl({
    targets,
    fixture,
    serviceKey,
  });
  await writeFileImpl(args.output, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  log(`sanitized KRIC nationwide rosters ready: scopes=${result.providerScopeCount} requests=${result.requestCount}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "KRIC nationwide roster collection failed");
    process.exitCode = 1;
  }
}
