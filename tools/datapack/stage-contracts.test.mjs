import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { stageContracts } from "./stage-contracts.mjs";

const resources = {
  "datapack/mobility-profile-policy.json": "{\"id\":\"mobility\"}\n",
  "datapack/datapack-freshness-sla.json": "{\"id\":\"freshness\"}\n",
  "datapack/datapack-manifest-acceptance-policy.json": "{\"id\":\"acceptance\"}\n",
  "datapack/production-datapack-scope.json": "{\"id\":\"scope\"}\n",
  "datapack/train-search-itx-exclusion-gate.json": "{\"id\":\"itx\"}\n",
};

test("고정된 hub bundle만 build/contracts에 원문 그대로 stage한다", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "data-contracts-"));
  const bytes = Buffer.from(`${JSON.stringify({ schemaVersion: 1, bundleVersion: "1.0.0", resources }, null, 2)}\n`);
  writeFileSync(path.join(root, "contracts.lock.json"), `${JSON.stringify({
    schemaVersion: 1,
    bundleVersion: "1.0.0",
    url: "https://raw.githubusercontent.com/AquilaXk/easysubway/main/contracts/bundles/data-contracts-v1.0.0.json",
    sha256: createHash("sha256").update(bytes).digest("hex"),
  }, null, 2)}\n`);
  try {
    await stageContracts({ root, fetchBundle: async () => bytes });
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
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
