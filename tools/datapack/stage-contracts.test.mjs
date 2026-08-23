import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { stageContracts } from "./stage-contracts.mjs";

const bundleUrl = "https://raw.githubusercontent.com/AquilaXk/easysubway/1730210fa56b74d2266dfd071d892472a650fd0d/contracts/bundles/data-contracts-v1.0.0.json";
const bundleSha256 = "00a88b901138326c7eabe4c82fd9fd97c4f460b377873dfb390a3ecb66ea6786";
const annualOfficialFileSourceIds = [
  "molit-railway-transfer-movement",
  "seoul-metro-transfer-distance-duration",
];
const routeMapPositionSourceIds = ["seoul-metro-route-map-positions"];
const historicalRouteMapSourceIds = ["seoulmetro-cyberstation-route-map"];
const productionRequiredSourceIds = [
  "molit-urban-rail-full-route",
  "seoulmetro-station-line-info",
  "seoul-metro-accessibility",
  "kric-station-convenience-standard",
  "kric-subway-timetable",
  "seoul-metro-transfer-distance-duration",
];

const resources = {
  "datapack/mobility-profile-policy.json": "{\"id\":\"mobility\"}\n",
  "datapack/datapack-freshness-sla.json": `${JSON.stringify({
    sourceClasses: [
      { id: "route_map_positions", sourceIds: routeMapPositionSourceIds, reverificationCadence: "P90D", offlinePackEligible: true },
      { id: "route_map_asset_historical", sourceIds: historicalRouteMapSourceIds, reverificationCadence: "P1Y", offlinePackEligible: false },
      { id: "annual_official_file", sourceIds: annualOfficialFileSourceIds },
    ],
  })}\n`,
  "datapack/datapack-manifest-acceptance-policy.json": "{\"id\":\"acceptance\"}\n",
  "datapack/production-datapack-scope.json": `${JSON.stringify({
    productionSourceSet: { requiredSourceIds: productionRequiredSourceIds },
  })}\n`,
  "datapack/train-search-itx-exclusion-gate.json": "{\"id\":\"itx\"}\n",
};

test("고정된 hub bundle만 build/contracts에 원문 그대로 stage한다", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "data-contracts-"));
  const bytes = Buffer.from(`${JSON.stringify({ schemaVersion: 1, bundleVersion: "1.0.0", resources }, null, 2)}\n`);
  const committedLock = JSON.parse(readFileSync(new URL("../../contracts.lock.json", import.meta.url), "utf8"));
  assert.deepEqual(committedLock, {
    schemaVersion: 1,
    bundleVersion: "1.0.0",
    url: bundleUrl,
    sha256: bundleSha256,
  });
  writeFileSync(path.join(root, "contracts.lock.json"), `${JSON.stringify({
    schemaVersion: 1,
    bundleVersion: "1.0.0",
    url: bundleUrl,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  }, null, 2)}\n`);
  try {
    await stageContracts({
      root,
      fetchBundle: async (url) => {
        assert.equal(url, bundleUrl);
        return bytes;
      },
    });
    for (const [name, value] of Object.entries(resources)) {
      assert.equal(readFileSync(path.join(root, "build/contracts", name), "utf8"), value);
    }

    rmSync(path.join(root, "build/contracts"), { recursive: true });
    const tampered = Buffer.from(bytes);
    tampered[0] ^= 1;
    await assert.rejects(
      stageContracts({ root, fetchBundle: async () => tampered }),
      /sha256/,
    );

    const lockPath = path.join(root, "contracts.lock.json");
    const lock = JSON.parse(readFileSync(lockPath, "utf8"));
    lock.url = "https://raw.githubusercontent.com/AquilaXk/easysubway/main/contracts/bundles/data-contracts-v1.0.0.json";
    writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
    await assert.rejects(
      stageContracts({ root, fetchBundle: async () => bytes }),
      /contracts\.lock\.json is invalid/,
    );

    const invalidAnnualSourceResources = structuredClone(resources);
    invalidAnnualSourceResources["datapack/datapack-freshness-sla.json"] = `${JSON.stringify({
      sourceClasses: [{ id: "annual_official_file", sourceIds: ["unexpected-source"] }],
    })}\n`;
    const invalidAnnualSourceBytes = Buffer.from(`${JSON.stringify({
      schemaVersion: 1,
      bundleVersion: "1.0.0",
      resources: invalidAnnualSourceResources,
    }, null, 2)}\n`);
    lock.url = bundleUrl;
    lock.sha256 = createHash("sha256").update(invalidAnnualSourceBytes).digest("hex");
    writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
    await assert.rejects(
      stageContracts({ root, fetchBundle: async () => invalidAnnualSourceBytes }),
      /annual_official_file sourceIds/,
    );

    const invalidRouteMapResources = structuredClone(resources);
    invalidRouteMapResources["datapack/datapack-freshness-sla.json"] = `${JSON.stringify({
      sourceClasses: [
        { id: "route_map_asset", sourceIds: historicalRouteMapSourceIds, reverificationCadence: "P1Y", offlinePackEligible: true },
        { id: "annual_official_file", sourceIds: annualOfficialFileSourceIds },
      ],
    })}\n`;
    const invalidRouteMapBytes = Buffer.from(`${JSON.stringify({
      schemaVersion: 1,
      bundleVersion: "1.0.0",
      resources: invalidRouteMapResources,
    }, null, 2)}\n`);
    lock.sha256 = createHash("sha256").update(invalidRouteMapBytes).digest("hex");
    writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
    await assert.rejects(
      stageContracts({ root, fetchBundle: async () => invalidRouteMapBytes }),
      /route-map freshness classes/,
    );

    const invalidProductionScopeResources = structuredClone(resources);
    invalidProductionScopeResources["datapack/production-datapack-scope.json"] = `${JSON.stringify({
      productionSourceSet: { requiredSourceIds: [...productionRequiredSourceIds].reverse() },
    })}\n`;
    const invalidProductionScopeBytes = Buffer.from(`${JSON.stringify({
      schemaVersion: 1,
      bundleVersion: "1.0.0",
      resources: invalidProductionScopeResources,
    }, null, 2)}\n`);
    lock.sha256 = createHash("sha256").update(invalidProductionScopeBytes).digest("hex");
    writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
    await assert.rejects(
      stageContracts({ root, fetchBundle: async () => invalidProductionScopeBytes }),
      /production requiredSourceIds/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
