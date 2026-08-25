import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CURRENT_SEOUL_PUBLIC_ROUTE_MAP_OPERATOR_IDS } from "./materialize-seoul-route-map-positions.mjs";
import { prepareCurrentStagedPublicRouteMapInventory } from "./prepare-current-staged-public-route-map-inventory.mjs";

const INVENTORY_PATH = "tools/datapack/source-inventory.json";
function inventory(operatorIds = ["seoul-metro"]) { return { schemaVersion: 1, sources: [{ id: "another-source", coverageScope: { operatorIds: ["other"] } }, { id: "seoul-metro-route-map-positions", coverageScope: { regionIds: ["capital"], operatorIds, lineIds: ["seoul-2"], sourceDomains: ["route_map_positions"] } }] }; }
async function writeInventory(root, value) { const file = path.join(root, INVENTORY_PATH); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, `${JSON.stringify(value, null, 2)}\n`); return file; }

test("staged preparer changes only the selected source operator scope", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "staged-public-inventory-")); const repositoryRoot = path.join(temporary, "repository"); const stagedRoot = path.join(temporary, "staged");
  try {
    await mkdir(repositoryRoot); await mkdir(stagedRoot); const original = inventory(); await writeInventory(repositoryRoot, original); await writeInventory(stagedRoot, original);
    assert.deepEqual(await prepareCurrentStagedPublicRouteMapInventory({ repositoryRoot, stagedRoot }), { inventoryPath: INVENTORY_PATH, changed: true });
    const expected = structuredClone(original); expected.sources[1].coverageScope.operatorIds = [...CURRENT_SEOUL_PUBLIC_ROUTE_MAP_OPERATOR_IDS];
    assert.deepEqual(JSON.parse(await readFile(path.join(stagedRoot, INVENTORY_PATH), "utf8")), expected);
    assert.deepEqual(JSON.parse(await readFile(path.join(repositoryRoot, INVENTORY_PATH), "utf8")), original);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test("staged preparer fails closed for repository-root identity and unexpected scope drift", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "staged-public-inventory-"));
  try {
    await writeInventory(temporary, inventory());
    await assert.rejects(prepareCurrentStagedPublicRouteMapInventory({ repositoryRoot: temporary, stagedRoot: temporary }), /distinct staged root/);
    const repositoryRoot = path.join(temporary, "repository"); const stagedRoot = path.join(temporary, "staged"); await mkdir(repositoryRoot); await mkdir(stagedRoot); await writeInventory(repositoryRoot, inventory());
    const drifted = inventory(["seoul-metro", "unexpected-operator"]); const stagedFile = await writeInventory(stagedRoot, drifted);
    await assert.rejects(prepareCurrentStagedPublicRouteMapInventory({ repositoryRoot, stagedRoot }), /operator scope drift/);
    assert.deepEqual(JSON.parse(await readFile(stagedFile, "utf8")), drifted);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test("staged preparer is idempotent when the exact operator scope is already current", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "staged-public-inventory-")); const repositoryRoot = path.join(temporary, "repository"); const stagedRoot = path.join(temporary, "staged");
  try {
    await mkdir(repositoryRoot); await mkdir(stagedRoot); await writeInventory(repositoryRoot, inventory()); const file = await writeInventory(stagedRoot, inventory([...CURRENT_SEOUL_PUBLIC_ROUTE_MAP_OPERATOR_IDS])); const before = await readFile(file);
    assert.deepEqual(await prepareCurrentStagedPublicRouteMapInventory({ repositoryRoot, stagedRoot }), { inventoryPath: INVENTORY_PATH, changed: false }); assert.deepEqual(await readFile(file), before);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
