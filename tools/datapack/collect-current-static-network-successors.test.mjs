import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { collectCurrentStaticNetworkSuccessors, MOLIT_URL, SEOUL_POSITIONS_URL } from "./collect-current-static-network-successors.mjs";
import { parseSeoulRouteMapPositionsCsv } from "./collect-seoul-route-map-positions.mjs";

const snapshots = JSON.parse(await readFile(new URL("./release/source-snapshots.json", import.meta.url), "utf8"));
const selected = snapshots.filter(({ sourceId }) => ["molit-urban-rail-full-route", "seoulmetro-cyberstation-route-map"].includes(sourceId));
const csv = await readFile(new URL("./sources/molit-urban-rail-full-route-20251211.csv", import.meta.url));
const positionCsv = await readFile(new URL("./fixtures/seoul-route-map-positions-raw/data-go-15099316.csv", import.meta.url));
const publicRows = parseSeoulRouteMapPositionsCsv(positionCsv).rawPositions.map(
  ({ line, stationCode, stationName, latitude, longitude, basisDate }, index) => ({
    "연번": `${index + 1}`,
    "호선": line,
    "고유역번호(외부역코드)": stationCode,
    "역명": stationName,
    "위도": `${latitude}`,
    "경도": `${longitude}`,
    "작성기준일": basisDate,
  }),
);
const publicEnvelope = () => Buffer.from(JSON.stringify({ currentCount: publicRows.length, data: publicRows, matchCount: publicRows.length, page: 1, perPage: 1000, totalCount: publicRows.length }));
function publicFetcher({ positions = publicEnvelope(), molit = csv } = {}) {
  return async (url, init) => {
    if (url.href.startsWith(SEOUL_POSITIONS_URL)) return new Response(positions, { headers: { "content-type": "application/json; charset=utf-8" } });
    if (url.href === MOLIT_URL) return new Response(molit, { headers: { "content-type": "text/csv" } });
    assert.fail(`unexpected public URL: ${url.href}`);
  };
}

test("two official observations are equivalent before publication", async () => {
  const calls = [];
  const fetchImpl = publicFetcher();
  const output = await collectCurrentStaticNetworkSuccessors({ sourceSnapshots: selected, observedAt: "2026-08-22T00:00:00.000Z", serviceKey: "test-key", fetchImpl: async (url, init) => { calls.push([url.href, init.redirect]); return fetchImpl(url, init); } });
  assert.equal(output.positions.sourceId, "seoul-metro-route-map-positions");
  assert.equal(output.positions.records.length, 276);
  assert.equal(output.positions.records.filter(({ latitude, longitude }) =>
    latitude === 37.562182 && longitude === 126.82693).length, 2);
  assert.equal(output.positions.replacement.migrationKind, "CROSS_SOURCE_CANONICAL_REPLACEMENT");
  assert.equal(output.positions.replacement.replacedSourceId, "seoulmetro-cyberstation-route-map");
  assert.equal(output.molit.records.length, 1103);
  assert.deepEqual(output.molit.records[0], { region_code: "01", region_name: "수도권", operator_name: "공항철도주식회사", line_name: "공항", station_sequence: 1, station_name: "서울역" });
  assert.equal(output.molit.migration.migrationKind, "LEGACY_SAMPLE_TO_FULL_CONSUMED_FIELDS");
  assert.equal(output.molit.migration.fullProjectionRowCount, 1103);
  assert.ok(calls.every(([, redirect]) => redirect === "error"));
});

test("MOLIT full consumed projection normalizes equivalent Number sequence formatting", async () => {
  const token = Buffer.from(",1,"); const offset = csv.indexOf(token); assert.ok(offset >= 0);
  for (const replacement of [",01,", ",+1,", ",1.0,", ",1e0,"]) {
    const equivalent = Buffer.concat([csv.subarray(0, offset), Buffer.from(replacement), csv.subarray(offset + token.length)]);
    const output = await collectCurrentStaticNetworkSuccessors({ sourceSnapshots: selected, observedAt: "2026-08-22T00:00:00.000Z", serviceKey: "test-key", fetchImpl: publicFetcher({ molit: equivalent }) });
    assert.equal(output.molit.records[0].station_sequence, 1);
  }
});

test("MOLIT full consumed projection rejects quote-only formatting that another consumer cannot parse", async () => {
  const offset = csv.indexOf(Buffer.from("01,")); assert.ok(offset >= 0);
  const quoted = Buffer.concat([csv.subarray(0, offset), Buffer.from('"01",'), csv.subarray(offset + 3)]);
  await assert.rejects(collectCurrentStaticNetworkSuccessors({ sourceSnapshots: selected, observedAt: "2026-08-22T00:00:00.000Z", serviceKey: "test-key", fetchImpl: publicFetcher({ molit: quoted }) }), /STATIC_NETWORK_SUCCESSOR_MOLIT_SCHEMA/);
});

test("MOLIT full consumed projection rejects a region-code-only drift before publication", async () => {
  const drifted = Buffer.from(csv); const offset = drifted.indexOf(Buffer.from("01,")); drifted.write("99", offset, "ascii");
  await assert.rejects(collectCurrentStaticNetworkSuccessors({ sourceSnapshots: selected, observedAt: "2026-08-22T00:00:00.000Z", serviceKey: "test-key", fetchImpl: publicFetcher({ molit: drifted }) }), /STATIC_NETWORK_SUCCESSOR_MOLIT_SCHEMA/);
});

test("MOLIT full consumed projection rejects truncated official scope before publication", async () => {
  const rows = csv.toString("binary").split("\n");
  for (const molit of [
    Buffer.from(rows.slice(0, 7).join("\n"), "binary"),
    Buffer.from(rows.slice(0, -2).join("\n"), "binary"),
  ]) {
    await assert.rejects(
      collectCurrentStaticNetworkSuccessors({ sourceSnapshots: selected, observedAt: "2026-08-22T00:00:00.000Z", serviceKey: "test-key", fetchImpl: publicFetcher({ molit }) }),
      /STATIC_NETWORK_SUCCESSOR_MOLIT_SCOPE/,
    );
  }
});

test("Seoul public positions reject deletion and same-count membership substitution", async () => {
  const deleted = publicRows.slice(0, -1);
  const substituted = publicRows.map((row, index) => index === 0 ? { ...row, "역명": `${row["역명"]}-대체` } : row);
  for (const rows of [deleted, substituted]) {
    const positions = Buffer.from(JSON.stringify({ currentCount: rows.length, data: rows, matchCount: rows.length, page: 1, perPage: 1000, totalCount: rows.length }));
    await assert.rejects(
      collectCurrentStaticNetworkSuccessors({ sourceSnapshots: selected, observedAt: "2026-08-22T00:00:00.000Z", serviceKey: "test-key", fetchImpl: publicFetcher({ positions }) }),
      /STATIC_NETWORK_SUCCESSOR_SEOUL_POSITIONS_SCOPE/,
    );
  }
});

test("partial observation failure is raised before any publisher can run", async () => {
  await assert.rejects(collectCurrentStaticNetworkSuccessors({ sourceSnapshots: selected, observedAt: "2026-08-22T00:00:00.000Z", serviceKey: "test-key", fetchImpl: async () => { throw new Error("offline"); } }), /STATIC_NETWORK_SUCCESSOR/);
});

test("rejects malformed service keys and impossible or future basis dates before publication", async () => {
  let calls = 0;
  await assert.rejects(collectCurrentStaticNetworkSuccessors({ sourceSnapshots: selected, observedAt: "2026-08-22T00:00:00.000Z", serviceKey: "invalid%ZZ", fetchImpl: async () => { calls += 1; } }), /STATIC_NETWORK_SUCCESSOR_ARGUMENT/);
  assert.equal(calls, 0);
  const future = publicRows.map((row) => ({ ...row, "작성기준일": "2026-08-23" }));
  const envelope = Buffer.from(JSON.stringify({ currentCount: future.length, data: future, matchCount: future.length, page: 1, perPage: 1000, totalCount: future.length }));
  await assert.rejects(collectCurrentStaticNetworkSuccessors({ sourceSnapshots: selected, observedAt: "2026-08-22T00:00:00.000Z", serviceKey: "test-key", fetchImpl: publicFetcher({ positions: envelope }) }), /SEOUL_POSITIONS_SCHEMA/);
});
