import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  applyRouteMapFreshnessExtension,
  assertInventoryMirrorByteParity,
  replaceFileAtomically,
  replaceInventoryMirrors,
} from "./refresh-route-map-admission-freshness.mjs";
import { freshnessPolicySha256 } from "./freshness-policy.mjs";

const paths = ["canonical.json", "mobile.json"];
const now = Date.parse("2026-08-14T00:00:00.000Z");
const inventoryValue = {
  sources: [{
    id: "route-map-source",
    routeMapAdmissionEvidence: {
      snapshotId: "route-map-snapshot-1",
      snapshotSha256: "a".repeat(64),
      rawSha256: "b".repeat(64),
      capturedAt: "2026-07-01T00:00:00.000Z",
      freshUntil: "2026-08-15T00:00:00.000Z",
    },
  }],
};
const inventory = JSON.stringify(inventoryValue);
const policy = {
  schemaVersion: 2,
  clockSkewSeconds: 300,
  sourceClasses: [{
    id: "route_map_asset",
    sourceIds: ["route-map-source"],
    reverificationCadence: "P30D",
  }],
};

function input(observation = {}) {
  return {
    schemaVersion: 1,
    artifactKind: "source-freshness-extension-input",
    evaluationAt: "2026-08-14T00:00:00.000Z",
    sourceIdentity: {
      sourceId: "route-map-source",
      snapshotId: "route-map-snapshot-1",
      snapshotSha256: "a".repeat(64),
      rawEvidenceSha256: "b".repeat(64),
      currentFreshUntil: "2026-08-15T00:00:00.000Z",
    },
    policyBinding: {
      sourceClassId: "route_map_asset",
      policySha256: freshnessPolicySha256(policy),
    },
    observation: {
      schemaVersion: 1,
      artifactKind: "source-freshness-observation",
      outcome: "POSITIVE",
      sourceId: "route-map-source",
      snapshotId: "route-map-snapshot-1",
      snapshotSha256: "a".repeat(64),
      rawEvidenceSha256: "b".repeat(64),
      observedAt: "2026-08-14T00:00:00.000Z",
      evidenceSha256: "c".repeat(64),
      providerValidUntil: null,
      sourceValidUntil: null,
      licenseValidUntil: null,
      ...observation,
    },
  };
}

test("route-map consumer는 shared EXTENDED receipt만 전파하고 모든 실패에서 mutation 0이다", () => {
  assert.throws(() => assertInventoryMirrorByteParity([
    { bytes: Buffer.from(inventory) },
    { bytes: Buffer.from(`${inventory}\n`) },
  ]), /source inventory mirrors must be byte-identical before refresh/);
  assert.doesNotThrow(() => assertInventoryMirrorByteParity(paths.map(() => ({ bytes: Buffer.from(inventory) }))));

  const extended = applyRouteMapFreshnessExtension(inventoryValue, { input: input(), policy, now });
  assert.equal(extended.changed, true);
  assert.equal(
    extended.inventory.sources[0].routeMapAdmissionEvidence.freshUntil,
    "2026-09-13T00:00:00.000Z",
  );
  assert.deepEqual(
    extended.inventory.sources[0].routeMapAdmissionEvidence.freshnessExtension,
    extended.result,
  );
  assert.equal(inventoryValue.sources[0].routeMapAdmissionEvidence.freshnessExtension, undefined);

  const noChangeInput = input({ outcome: "NO_CHANGE" });
  const noChange = applyRouteMapFreshnessExtension(inventoryValue, { input: noChangeInput, policy, now });
  assert.equal(noChange.changed, false);
  assert.deepEqual(noChange.inventory, inventoryValue);

  const mismatchedInventoryInput = input();
  mismatchedInventoryInput.sourceIdentity.snapshotId = "other-snapshot";
  mismatchedInventoryInput.observation.snapshotId = "other-snapshot";
  assert.throws(
    () => applyRouteMapFreshnessExtension(inventoryValue, {
      input: mismatchedInventoryInput,
      policy,
      now,
    }),
    /route-map admission identity mismatch/,
  );

  const duplicateSource = structuredClone(inventoryValue);
  duplicateSource.sources.push(structuredClone(duplicateSource.sources[0]));
  assert.throws(
    () => applyRouteMapFreshnessExtension(duplicateSource, { input: input(), policy, now }),
    /exactly one route-map source/,
  );
});

test("inventory 교체는 임시 파일을 남기지 않고 기존 파일 권한을 보존한다", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "route-map-freshness-"));
  const targetPath = path.join(directory, "inventory.json");
  try {
    await writeFile(targetPath, "before\n", { mode: 0o640 });
    await replaceFileAtomically(targetPath, "after\n");
    assert.equal(await readFile(targetPath, "utf8"), "after\n");
    assert.equal((await stat(targetPath)).mode & 0o777, 0o640);
    assert.deepEqual(await readdir(directory), ["inventory.json"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("두 번째 mirror commit 실패 시 첫 번째 mirror를 원본으로 롤백한다", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "route-map-mirror-rollback-"));
  const targets = ["canonical.json", "mobile.json"].map((name) => ({
    targetPath: path.join(directory, name),
    originalBytes: Buffer.from(`${name}:before\n`),
  }));
  let stagedCount = 0;
  try {
    await Promise.all(targets.map(({ targetPath, originalBytes }) => writeFile(targetPath, originalBytes)));
    await assert.rejects(
      () => replaceInventoryMirrors(targets, "after\n", {
        stageReplacement: async (targetPath, bytes) => {
          stagedCount += 1;
          return {
            targetPath,
            commit: async () => {
              assert.equal(stagedCount, targets.length, "모든 mirror가 commit 전에 staging돼야 한다");
              if (targetPath === targets[1].targetPath) throw new Error("injected second commit failure");
              await writeFile(targetPath, bytes);
            },
            cleanup: async () => {},
          };
        },
      }),
      /injected second commit failure/,
    );
    assert.deepEqual(
      await Promise.all(targets.map(({ targetPath }) => readFile(targetPath))),
      targets.map(({ originalBytes }) => originalBytes),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
