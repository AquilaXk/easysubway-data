import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { stageContracts } from "./stage-contracts.mjs";

const bundleUrl = "https://raw.githubusercontent.com/AquilaXk/easysubway/e31f9fa4f46bbeb0bd75d6776eb5ff6643169798/contracts/bundles/data-contracts-v1.0.0.json";
const bundleSha256 = "177bc2ff3fa2a7ef1f8fe0d7b4a572a58f2e47c1c54ada36ef0eb4b8cca1c76d";
const annualOfficialFileSourceIds = [
  "molit-railway-transfer-movement",
  "seoul-metro-transfer-distance-duration",
];

const resources = {
  "datapack/mobility-profile-policy.json": "{\"id\":\"mobility\"}\n",
  "datapack/datapack-freshness-sla.json": `${JSON.stringify({
    sourceClasses: [{ id: "annual_official_file", sourceIds: annualOfficialFileSourceIds }],
  })}\n`,
  "datapack/datapack-manifest-acceptance-policy.json": "{\"id\":\"acceptance\"}\n",
  "datapack/production-datapack-scope.json": "{\"id\":\"scope\"}\n",
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
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
