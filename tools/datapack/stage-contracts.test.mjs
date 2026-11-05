import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  annualOfficialFileSourceIds,
  bundleUrl,
  historicalRouteMapSourceIds,
  productionRequiredSourceIds,
  routeMapGovernanceMappings,
  routeMapPositionSourceIds,
  stageContracts,
  staticAccessibilitySourceIds,
} from "./stage-contracts.mjs";

const bundleSha256 = "48e3a41d992fac4135b28c1fe83dc62f4ca1fcdfc5d2e4dbad4f039d4b4b811c";
const committedFreshnessSla = readFileSync(
  new URL("../../release/product-gates/datapack-freshness-sla.json", import.meta.url),
  "utf8",
);

const resources = {
  "datapack/mobility-profile-policy.json": "{\"id\":\"mobility\"}\n",
  "datapack/datapack-freshness-sla.json": committedFreshnessSla,
  "datapack/source-governance-policy.json": `${JSON.stringify({
    sources: routeMapGovernanceMappings,
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
  const localGatesDir = path.join(root, "release/product-gates");
  mkdirSync(localGatesDir, { recursive: true });
  const localFreshnessPath = path.join(localGatesDir, "datapack-freshness-sla.json");
  writeFileSync(localFreshnessPath, committedFreshnessSla);
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

    const invalidStaticAccessibilityResources = structuredClone(resources);
    invalidStaticAccessibilityResources["datapack/datapack-freshness-sla.json"] = `${JSON.stringify({
      sourceClasses: [
        { id: "static_accessibility_facility", sourceIds: staticAccessibilitySourceIds.slice(0, -1) },
        { id: "route_map_positions", sourceIds: routeMapPositionSourceIds, reverificationCadence: "P90D", offlinePackEligible: true },
        { id: "route_map_asset_historical", sourceIds: historicalRouteMapSourceIds, reverificationCadence: "P1Y", offlinePackEligible: false },
        { id: "annual_official_file", sourceIds: annualOfficialFileSourceIds },
      ],
    })}\n`;
    const invalidStaticAccessibilityBytes = Buffer.from(`${JSON.stringify({
      schemaVersion: 1,
      bundleVersion: "1.0.0",
      resources: invalidStaticAccessibilityResources,
    }, null, 2)}\n`);
    lock.sha256 = createHash("sha256").update(invalidStaticAccessibilityBytes).digest("hex");
    writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
    await assert.rejects(
      stageContracts({ root, fetchBundle: async () => invalidStaticAccessibilityBytes }),
      /static_accessibility_facility sourceIds/,
    );

    const invalidRouteMapResources = structuredClone(resources);
    invalidRouteMapResources["datapack/datapack-freshness-sla.json"] = `${JSON.stringify({
      sourceClasses: [
        { id: "static_accessibility_facility", sourceIds: staticAccessibilitySourceIds },
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

    const invalidRouteMapGovernanceResources = structuredClone(resources);
    invalidRouteMapGovernanceResources["datapack/source-governance-policy.json"] = `${JSON.stringify({
      sources: [
        { sourceId: "seoul-metro-route-map-positions", sourceClassId: "route_map_asset_historical" },
        { sourceId: "seoulmetro-cyberstation-route-map", sourceClassId: "route_map_asset_historical" },
      ],
    })}\n`;
    const invalidRouteMapGovernanceBytes = Buffer.from(`${JSON.stringify({
      schemaVersion: 1,
      bundleVersion: "1.0.0",
      resources: invalidRouteMapGovernanceResources,
    }, null, 2)}\n`);
    lock.sha256 = createHash("sha256").update(invalidRouteMapGovernanceBytes).digest("hex");
    writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
    await assert.rejects(
      stageContracts({ root, fetchBundle: async () => invalidRouteMapGovernanceBytes }),
      /route-map source governance mappings/,
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

    const missingRouteMapPositionResources = structuredClone(resources);
    missingRouteMapPositionResources["datapack/production-datapack-scope.json"] = `${JSON.stringify({
      productionSourceSet: {
        requiredSourceIds: productionRequiredSourceIds.filter((sourceId) =>
          sourceId !== "seoul-metro-route-map-positions"),
      },
    })}\n`;
    const missingRouteMapPositionBytes = Buffer.from(`${JSON.stringify({
      schemaVersion: 1,
      bundleVersion: "1.0.0",
      resources: missingRouteMapPositionResources,
    }, null, 2)}\n`);
    lock.sha256 = createHash("sha256").update(missingRouteMapPositionBytes).digest("hex");
    writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
    await assert.rejects(
      stageContracts({ root, fetchBundle: async () => missingRouteMapPositionBytes }),
      /production requiredSourceIds/,
    );

    // 수집기·등록기의 topology 창(lib 컷오버 이후 P7D)과 release가 쓰는 고정 Hub 정책이 갈라지면 stage 단계에서 막는다.
    const legacyTopologyResources = structuredClone(resources);
    const legacyTopologyFreshness = JSON.parse(legacyTopologyResources["datapack/datapack-freshness-sla.json"]);
    legacyTopologyFreshness.sourceClasses.find(({ id }) => id === "route_graph_topology").reverificationCadence = "P1D";
    legacyTopologyResources["datapack/datapack-freshness-sla.json"] = `${JSON.stringify(legacyTopologyFreshness)}\n`;
    const legacyTopologyBytes = Buffer.from(`${JSON.stringify({
      schemaVersion: 1,
      bundleVersion: "1.0.0",
      resources: legacyTopologyResources,
    }, null, 2)}\n`);
    lock.sha256 = createHash("sha256").update(legacyTopologyBytes).digest("hex");
    writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
    await assert.rejects(
      stageContracts({ root, fetchBundle: async () => legacyTopologyBytes }),
      /route_graph_topology reverificationCadence/,
    );

    writeFileSync(localFreshnessPath, "{\"sourceClasses\":[]}\n");
    lock.sha256 = createHash("sha256").update(bytes).digest("hex");
    writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
    await assert.rejects(
      stageContracts({ root, fetchBundle: async () => bytes }),
      /local release\/product-gates\/datapack-freshness-sla\.json does not match contract bundle/,
    );

    writeFileSync(localFreshnessPath, committedFreshnessSla);
    await stageContracts({ root, fetchBundle: async () => bytes });
    assert.equal(readFileSync(path.join(root, "build/contracts/datapack/datapack-freshness-sla.json"), "utf8"), committedFreshnessSla);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
