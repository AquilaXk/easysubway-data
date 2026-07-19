#!/usr/bin/env node
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { probeDaejeonCoverageApi } from "./probe-daejeon-coverage-api.mjs";

const SOURCE_ID = "daejeon-station-distance-fare";
export const DAEJEON_TOPOLOGY_ENDPOINT = "https://apis.data.go.kr/B554695/TimeDistSVC/getTimeDist01";
export const DAEJEON_LINE1_STATION_NUMBERS = Object.freeze(
  Array.from({ length: 22 }, (_, index) => String(101 + index)),
);

export async function collectDaejeonRouteTopology({
  serviceKey,
  fetchImpl = fetch,
  now = new Date(),
} = {}) {
  const key = requiredString(serviceKey, "DATA_GO_KR_SERVICE_KEY");
  const rows = [];
  for (let index = 0; index < DAEJEON_LINE1_STATION_NUMBERS.length - 1; index += 1) {
    const left = DAEJEON_LINE1_STATION_NUMBERS[index];
    const right = DAEJEON_LINE1_STATION_NUMBERS[index + 1];
    for (const [fromStationNumber, toStationNumber] of [[left, right], [right, left]]) {
      const evidence = await probeDaejeonCoverageApi({
        sourceId: SOURCE_ID,
        serviceKey: key,
        query: { strstnno: fromStationNumber, endstnno: toStationNumber },
        captureRows: true,
        fetchImpl,
        now,
      });
      if (evidence.rowCount !== 1 || evidence.rows.length !== 1) {
        throw new Error(`Daejeon adjacent OD must return exactly one row: ${fromStationNumber}:${toStationNumber}`);
      }
      const [{ distfloat, fee, min, sec }] = evidence.rows;
      rows.push({
        fromStationNumber,
        toStationNumber,
        distanceKilometers: Number(distfloat),
        fareWon: Number(fee),
        travelTimeSeconds: (Number(min) * 60) + Number(sec),
        responseSha256: evidence.rawSha256,
      });
    }
  }
  const rowsSha256 = sha256(JSON.stringify(rows));
  return {
    schemaVersion: 1,
    artifactKind: "daejeon-route-topology-collection",
    sourceId: SOURCE_ID,
    observedAt: now.toISOString(),
    endpoint: DAEJEON_TOPOLOGY_ENDPOINT,
    providerResultCode: "00",
    schemaStatus: "EXPECTED",
    stationNumbers: [...DAEJEON_LINE1_STATION_NUMBERS],
    rowCount: rows.length,
    rows,
    rowsSha256,
    excludedTransferCount: 0,
    rawSha256: sha256(JSON.stringify(rows.map(({ responseSha256 }) => responseSha256))),
    contentSha256: rowsSha256,
    credentialRedacted: true,
  };
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} is required`);
  return value;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function main() {
  const output = requiredString(process.env.DAEJEON_TOPOLOGY_OUTPUT, "DAEJEON_TOPOLOGY_OUTPUT");
  if (!path.isAbsolute(output)) throw new Error("DAEJEON_TOPOLOGY_OUTPUT must be absolute");
  const artifact = await collectDaejeonRouteTopology({ serviceKey: process.env.DATA_GO_KR_SERVICE_KEY });
  await writeFile(output, `${JSON.stringify(artifact, null, 2)}\n`, { mode: 0o600 });
  console.log(`sanitized Daejeon topology evidence ready: rows=${artifact.rowCount}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Daejeon topology collection failed");
    process.exitCode = 1;
  });
}
