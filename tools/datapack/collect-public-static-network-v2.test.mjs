import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { collectPublicStaticNetworkV2 } from "./collect-public-static-network-v2.mjs";
import { MOLIT_URL, SEOUL_POSITIONS_URL } from "./collect-current-static-network-successors.mjs";
import { parseSeoulRouteMapPositionsCsv } from "./collect-seoul-route-map-positions.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const capturedAt = "2026-08-25T00:00:00.000Z";
const positionCsv = await readFile(path.join(root, "tools/datapack/fixtures/seoul-route-map-positions-raw/data-go-15099316.csv"));
const molit = await readFile(path.join(root, "tools/datapack/sources/molit-urban-rail-full-route-20251211.csv"));
const rows = parseSeoulRouteMapPositionsCsv(positionCsv).rawPositions.map(({ line, stationCode, stationName, latitude, longitude, basisDate }, index) => ({
  "연번": `${index + 1}`, "호선": line, "고유역번호(외부역코드)": stationCode, "역명": stationName,
  "위도": `${latitude}`, "경도": `${longitude}`, "작성기준일": basisDate, "작성일자": basisDate,
}));
const positions = Buffer.from(JSON.stringify({ currentCount: rows.length, data: rows, matchCount: rows.length, page: 1, perPage: 1000, totalCount: rows.length }));

function officialFetch({ positionBytes = positions, molitBytes = molit } = {}) {
  return async (url) => new URL(url).href.startsWith(SEOUL_POSITIONS_URL)
    ? new Response(positionBytes, { headers: { "content-type": "application/json" } })
    : new URL(url).href === MOLIT_URL
      ? new Response(molitBytes, { headers: { "content-type": "text/csv" } })
      : (() => { throw new Error("unexpected official endpoint"); })();
}

test("official-only collector returns exactly the validated two raw responses", async () => {
  const output = await collectPublicStaticNetworkV2({ capturedAt, serviceKey: "test-key", fetchImpl: officialFetch() });
  assert.deepEqual(output, { capturedAt, positionRawBytes: positions, molitRawBytes: molit });
});

test("official-only collector rejects either invalid response without a partial output", async () => {
  await assert.rejects(
    collectPublicStaticNetworkV2({ capturedAt, serviceKey: "test-key", fetchImpl: officialFetch({ molitBytes: Buffer.from("not-csv") }) }),
    /PUBLIC_STATIC_NETWORK_V2_MOLIT_SCHEMA/,
  );
  await assert.rejects(
    collectPublicStaticNetworkV2({ capturedAt, serviceKey: "test-key", fetchImpl: officialFetch({ positionBytes: Buffer.from("{}") }) }),
    /PUBLIC_STATIC_NETWORK_V2_POSITIONS_SCHEMA/,
  );
});

test("official-only collector rejects malformed DATA_GO_KR_SERVICE_KEY before provider calls", async () => {
  let calls = 0;
  await assert.rejects(
    collectPublicStaticNetworkV2({
      capturedAt,
      serviceKey: "invalid%ZZ",
      fetchImpl: async () => { calls += 1; },
    }),
    /PUBLIC_STATIC_NETWORK_V2_ARGUMENT/,
  );
  assert.equal(calls, 0);
});
