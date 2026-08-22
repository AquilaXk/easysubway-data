import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { collectCurrentStaticNetworkSuccessors, MOLIT_URL, SEOUL_ASSET_URL, SEOUL_ROOT_URL } from "./collect-current-static-network-successors.mjs";

const snapshots = JSON.parse(await readFile(new URL("./release/source-snapshots.json", import.meta.url), "utf8"));
const selected = snapshots.filter(({ sourceId }) => ["molit-urban-rail-full-route", "seoulmetro-cyberstation-route-map"].includes(sourceId));
const baseline = await readFile(new URL("./sources/seoulmetro-cyberstation-line-data-20260623.js", import.meta.url));
const csv = await readFile(new URL("./sources/molit-urban-rail-full-route-20251211.csv", import.meta.url));

test("two official observations are equivalent before publication", async () => {
  const calls = [];
  const output = await collectCurrentStaticNetworkSuccessors({ sourceSnapshots: selected, baselineRouteMapBytes: baseline, baselineMolitBytes: csv, observedAt: "2026-08-22T00:00:00.000Z", fetchImpl: async (url, init) => {
    calls.push([url.href, init.redirect]);
    if (url.href === MOLIT_URL) return new Response(csv, { headers: { "content-type": "application/octet-stream" } });
    if (url.href === SEOUL_ROOT_URL) return new Response('<script src="/kr/getLineData.do"></script>', { headers: { "content-type": "text/html" } });
    if (url.href === SEOUL_ASSET_URL) return new Response(baseline, { headers: { "content-type": "application/javascript" } });
    throw new Error("unexpected");
  } });
  assert.equal(output.molit.records.length, 1103);
  assert.deepEqual(output.molit.records[0], { region_code: "01", region_name: "수도권", operator_name: "공항철도주식회사", line_name: "공항", station_sequence: 1, station_name: "서울역" });
  assert.equal(output.molit.migration.migrationKind, "LEGACY_SAMPLE_TO_FULL_CONSUMED_FIELDS");
  assert.equal(output.molit.migration.fullProjectionRowCount, 1103);
  assert.equal(output.routeMap.migration.migrationKind, "LEGACY_SAMPLE_TO_FULL_CONSUMED_FIELDS");
  assert.ok(calls.every(([, redirect]) => redirect === "error"));
});

test("MOLIT full consumed projection normalizes equivalent Number sequence formatting", async () => {
  const token = Buffer.from(",1,"); const offset = csv.indexOf(token); assert.ok(offset >= 0);
  for (const replacement of [",01,", ",+1,", ",1.0,", ",1e0,"]) {
    const equivalent = Buffer.concat([csv.subarray(0, offset), Buffer.from(replacement), csv.subarray(offset + token.length)]);
    const output = await collectCurrentStaticNetworkSuccessors({ sourceSnapshots: selected, baselineRouteMapBytes: baseline, baselineMolitBytes: csv, observedAt: "2026-08-22T00:00:00.000Z", fetchImpl: async (url) => {
      if (url.href === MOLIT_URL) return new Response(equivalent, { headers: { "content-type": "text/csv" } });
      if (url.href === SEOUL_ROOT_URL) return new Response('<script src="/kr/getLineData.do"></script>', { headers: { "content-type": "text/html" } });
      if (url.href === SEOUL_ASSET_URL) return new Response(baseline, { headers: { "content-type": "application/javascript" } });
      throw new Error("unexpected");
    } });
    assert.equal(output.molit.records[0].station_sequence, 1);
  }
});

test("MOLIT full consumed projection rejects quote-only formatting that another consumer cannot parse", async () => {
  const offset = csv.indexOf(Buffer.from("01,")); assert.ok(offset >= 0);
  const quoted = Buffer.concat([csv.subarray(0, offset), Buffer.from('"01",'), csv.subarray(offset + 3)]);
  await assert.rejects(collectCurrentStaticNetworkSuccessors({ sourceSnapshots: selected, baselineRouteMapBytes: baseline, baselineMolitBytes: csv, observedAt: "2026-08-22T00:00:00.000Z", fetchImpl: async (url) => {
    if (url.href === MOLIT_URL) return new Response(quoted, { headers: { "content-type": "text/csv" } });
    if (url.href === SEOUL_ROOT_URL) return new Response('<script src="/kr/getLineData.do"></script>', { headers: { "content-type": "text/html" } });
    if (url.href === SEOUL_ASSET_URL) return new Response(baseline, { headers: { "content-type": "application/javascript" } });
    throw new Error("unexpected");
  } }), /STATIC_NETWORK_SUCCESSOR_(?:MOLIT_SCHEMA|MATERIAL_CHANGE)/);
});

test("MOLIT full consumed projection rejects a region-code-only drift before publication", async () => {
  const drifted = Buffer.from(csv); const offset = drifted.indexOf(Buffer.from("01,")); drifted.write("99", offset, "ascii");
  await assert.rejects(collectCurrentStaticNetworkSuccessors({ sourceSnapshots: selected, baselineRouteMapBytes: baseline, baselineMolitBytes: csv, observedAt: "2026-08-22T00:00:00.000Z", fetchImpl: async (url) => {
    if (url.href === MOLIT_URL) return new Response(drifted, { headers: { "content-type": "text/csv" } });
    if (url.href === SEOUL_ROOT_URL) return new Response('<script src="/kr/getLineData.do"></script>', { headers: { "content-type": "text/html" } });
    if (url.href === SEOUL_ASSET_URL) return new Response(baseline, { headers: { "content-type": "application/javascript" } });
    throw new Error("unexpected");
  } }), /STATIC_NETWORK_SUCCESSOR_MATERIAL_CHANGE/);
});

test("partial observation failure is raised before any publisher can run", async () => {
  await assert.rejects(collectCurrentStaticNetworkSuccessors({ sourceSnapshots: selected, baselineRouteMapBytes: baseline, baselineMolitBytes: csv, observedAt: "2026-08-22T00:00:00.000Z", fetchImpl: async () => { throw new Error("offline"); } }), /STATIC_NETWORK_SUCCESSOR/);
});
