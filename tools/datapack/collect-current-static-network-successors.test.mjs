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
  const output = await collectCurrentStaticNetworkSuccessors({ sourceSnapshots: selected, baselineRouteMapBytes: baseline, observedAt: "2026-08-22T00:00:00.000Z", fetchImpl: async (url, init) => {
    calls.push([url.href, init.redirect]);
    if (url.href === MOLIT_URL) return new Response(csv, { headers: { "content-type": "application/octet-stream" } });
    if (url.href === SEOUL_ROOT_URL) return new Response('<script src="/kr/getLineData.do"></script>', { headers: { "content-type": "text/html" } });
    if (url.href === SEOUL_ASSET_URL) return new Response(baseline, { headers: { "content-type": "application/javascript" } });
    throw new Error("unexpected");
  } });
  assert.equal(output.molit.records.length, 5); assert.equal(output.routeMap.migration.migrationKind, "LEGACY_SAMPLE_TO_FULL_CONSUMED_FIELDS");
  assert.ok(calls.every(([, redirect]) => redirect === "error"));
});

test("partial observation failure is raised before any publisher can run", async () => {
  await assert.rejects(collectCurrentStaticNetworkSuccessors({ sourceSnapshots: selected, baselineRouteMapBytes: baseline, observedAt: "2026-08-22T00:00:00.000Z", fetchImpl: async () => { throw new Error("offline"); } }), /STATIC_NETWORK_SUCCESSOR/);
});
