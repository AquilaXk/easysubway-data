import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildCurrentSeoulAccessibilityRegistrationOutputs,
  commitCurrentSeoulAccessibilityRegistrationOutputs,
} from "./register-current-seoul-accessibility-snapshot.mjs";
import { validateLineage } from "./source-snapshot-policy.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const sha = (value) => createHash("sha256").update(value).digest("hex");
const OUTPUTS = [
  "tools/datapack/source-inventory.json",
  "tools/datapack/release/source-snapshots.json",
  "tools/datapack/inputs/capital-pilot-production-source-input.json",
  "tools/datapack/release/candidate-build-spec.json",
  "tools/datapack/release/release-request.json",
  "tools/datapack/release/hash-evidence.json",
  "tools/datapack/release/capital-production-canonical-pack.json",
  "tools/datapack/source-governance-policy.json",
  "release/product-gates/datapack-freshness-sla.json",
];

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "seoul-accessibility-registration-"));
  const readJson = async (relative) => JSON.parse(await readFile(path.join(ROOT, relative), "utf8"));
  const candidate = await readJson("tools/datapack/release/candidate-build-spec.json");
  const itx = candidate.itxTopologyEvidencePath;
  for (const relative of [...OUTPUTS, itx]) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await cp(path.join(ROOT, relative), target);
  }
  const inventory = await readJson("tools/datapack/source-inventory.json");
  const kric = inventory.sources.find(({ id }) => id === "kric-station-convenience-standard");
  const kricPath = kric.accessibilityAdmissionEvidence.snapshotPath;
  await mkdir(path.dirname(path.join(root, kricPath)), { recursive: true });
  await cp(path.join(ROOT, kricPath), path.join(root, kricPath));
  const seoul = inventory.sources.find(({ id }) => id === "seoul-metro-accessibility");
  const prior = await readJson(seoul.accessibilityAdmissionEvidence.snapshotPath);
  const capturedAt = "2026-08-22T00:00:00.000Z";
  const snapshot = {
    ...prior,
    snapshotId: "seoul-metro-accessibility-20260822T000000000Z",
    previousSnapshotId: prior.snapshotId,
    retrievedAt: capturedAt,
    capturedAt,
    observedAt: capturedAt,
    freshUntil: "2026-08-23T00:00:00.000Z",
    rawSha256: sha("new provider observation identity"),
  };
  const observation = await mkdtemp(path.join(os.tmpdir(), "seoul-accessibility-observation-"));
  const snapshotPath = path.join(observation, `${snapshot.snapshotId}.json`);
  const snapshotBytes = Buffer.from(`${JSON.stringify(snapshot, null, 2)}\n`);
  await writeFile(snapshotPath, snapshotBytes);
  const governance = await readJson("tools/datapack/source-governance-policy.json");
  const rawObjectSha256 = sha("immutable oci raw artifact");
  const receipt = {
    schemaVersion: 1,
    artifactKind: "seoul-accessibility-raw-object-receipt",
    sourceId: "seoul-metro-accessibility",
    snapshotId: snapshot.snapshotId,
    snapshotRawSha256: snapshot.rawSha256,
    capturedAt,
    snapshotFileSha256: sha(snapshotBytes),
    rawObjectUri: `oci://axvym6vk8g7i/easysubway-datapacks/source-raw/seoul-metro-accessibility/20260822/${rawObjectSha256}.json`,
    rawObjectSha256,
    byteSize: 29,
    storedAt: "2026-08-22T00:00:01.000Z",
    rawRetentionExpiresAt: "2026-11-20T00:00:00.000Z",
  };
  const receiptPath = path.join(observation, "receipt.json");
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  return { root, observation, snapshotPath, receiptPath, snapshot, receipt, kricPath };
}

async function writeObservation(values, snapshot, receipt) {
  const snapshotBytes = Buffer.from(`${JSON.stringify(snapshot, null, 2)}\n`);
  receipt.snapshotId = snapshot.snapshotId;
  receipt.snapshotRawSha256 = snapshot.rawSha256;
  receipt.capturedAt = snapshot.capturedAt;
  receipt.snapshotFileSha256 = sha(snapshotBytes);
  await writeFile(values.snapshotPath, snapshotBytes);
  await writeFile(values.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
}

test("fresh Seoul observation and OCI receipt rebind exactly seven outputs", async (t) => {
  const values = await fixture();
  t.after(() => Promise.all([rm(values.root, { recursive: true, force: true }), rm(values.observation, { recursive: true, force: true })]));
  const before = await Promise.all(OUTPUTS.slice(0, 6).map((relative) => readFile(path.join(values.root, relative))));
  const outputs = await buildCurrentSeoulAccessibilityRegistrationOutputs({
    repositoryRoot: values.root, snapshotPath: values.snapshotPath, receiptPath: values.receiptPath,
    now: new Date("2026-08-22T00:01:00.000Z"),
  });
  assert.equal(outputs.length, 7);
  assert.deepEqual(outputs.map(({ relative }) => relative).slice(1), OUTPUTS.slice(0, 6));
  assert.equal(outputs[0].relative, "tools/datapack/sources/seoul-metro-accessibility-20260822T000000000Z.json");
  await commitCurrentSeoulAccessibilityRegistrationOutputs({ repositoryRoot: values.root, outputs });
  const after = await Promise.all(OUTPUTS.slice(0, 6).map((relative) => readFile(path.join(values.root, relative))));
  assert.equal(after.some((bytes, index) => !bytes.equals(before[index])), true);
  const ledger = JSON.parse(await readFile(path.join(values.root, OUTPUTS[1]), "utf8"));
  assert.equal(ledger.at(-1).sourceId, "seoul-metro-accessibility");
  assert.equal(ledger.at(-1).rawObjectUri.startsWith("oci://"), true);
  const candidate = JSON.parse(await readFile(path.join(values.root, OUTPUTS[3]), "utf8"));
  assert.equal(candidate.sourceSnapshots.find(({ sourceId }) => sourceId === "seoul-metro-accessibility").snapshotId, ledger.at(-1).snapshotId);
  const beforeCandidate = JSON.parse(before[3]);
  for (const projection of beforeCandidate.sourceSnapshots.filter(({ sourceId }) => sourceId !== "seoul-metro-accessibility")) {
    assert.deepEqual(candidate.sourceSnapshots.find(({ sourceId }) => sourceId === projection.sourceId), projection);
  }
  assert.deepEqual(await readFile(path.join(values.root, values.kricPath)), await readFile(path.join(ROOT, values.kricPath)));
  const beforeInput = JSON.parse(before[2]);
  const afterInput = JSON.parse(await readFile(path.join(values.root, OUTPUTS[2]), "utf8"));
  assert.deepEqual(afterInput.kricStandardAccessibilitySnapshot, beforeInput.kricStandardAccessibilitySnapshot);
  const beforeHeads = validateLineage(JSON.parse(before[1])).headsBySource;
  const afterHeads = validateLineage(ledger).headsBySource;
  assert.equal(afterHeads["kric-station-convenience-standard"], beforeHeads["kric-station-convenience-standard"]);
});

test("invalid receipt, foreign replacement, and partial commit do not leave a mixed success", async (t) => {
  const values = await fixture();
  t.after(() => Promise.all([rm(values.root, { recursive: true, force: true }), rm(values.observation, { recursive: true, force: true })]));
  const before = await Promise.all(OUTPUTS.slice(0, 6).map((relative) => readFile(path.join(values.root, relative))));
  const receipt = JSON.parse(await readFile(values.receiptPath, "utf8"));
  receipt.rawObjectUri = "oci://other-bucket/source-raw/invalid.json";
  await writeFile(values.receiptPath, `${JSON.stringify(receipt)}\n`);
  await assert.rejects(buildCurrentSeoulAccessibilityRegistrationOutputs({ repositoryRoot: values.root, snapshotPath: values.snapshotPath, receiptPath: values.receiptPath, now: new Date("2026-08-22T00:01:00.000Z") }), /OCI receipt URI/);
  assert.deepEqual(await Promise.all(OUTPUTS.slice(0, 6).map((relative) => readFile(path.join(values.root, relative)))), before);

  receipt.rawObjectUri = `oci://axvym6vk8g7i/easysubway-datapacks/source-raw/seoul-metro-accessibility/20260822/${receipt.rawObjectSha256}.json`;
  await writeFile(values.receiptPath, `${JSON.stringify(receipt)}\n`);
  const outputs = await buildCurrentSeoulAccessibilityRegistrationOutputs({ repositoryRoot: values.root, snapshotPath: values.snapshotPath, receiptPath: values.receiptPath, now: new Date("2026-08-22T00:01:00.000Z") });
  await assert.rejects(commitCurrentSeoulAccessibilityRegistrationOutputs({ repositoryRoot: values.root, outputs, failAfter: 2 }), /injected transaction failure/);
  assert.deepEqual(await Promise.all(OUTPUTS.slice(0, 6).map((relative) => readFile(path.join(values.root, relative)))), before);

  await writeFile(path.join(values.root, OUTPUTS[0]), "foreign");
  await assert.rejects(commitCurrentSeoulAccessibilityRegistrationOutputs({ repositoryRoot: values.root, outputs }), /preserves foreign replacement/);
  assert.equal(await readFile(path.join(values.root, OUTPUTS[0]), "utf8"), "foreign");
});

test("lineage, time, governance, and freshness admission failures stop before registration", async (t) => {
  const invalid = [
    {
      name: "direct successor",
      mutate: (snapshot) => { snapshot.previousSnapshotId = "seoul-metro-accessibility-not-the-current-head"; },
      expected: /direct current successor/,
    },
    {
      name: "invalid receipt time",
      mutate: (_snapshot, receipt) => { receipt.storedAt = "not-a-time"; },
      expected: /storedAt is invalid/,
    },
    {
      name: "future receipt time",
      mutate: (_snapshot, receipt) => { receipt.storedAt = "2026-08-22T00:02:00.000Z"; },
      expected: /storage time/,
    },
    {
      name: "receipt schema",
      mutate: (_snapshot, receipt) => { receipt.unexpected = true; },
      expected: /receipt binding/,
    },
  ];
  for (const entry of invalid) {
    const values = await fixture();
    t.after(() => Promise.all([rm(values.root, { recursive: true, force: true }), rm(values.observation, { recursive: true, force: true })]));
    const snapshot = structuredClone(values.snapshot); const receipt = structuredClone(values.receipt);
    entry.mutate(snapshot, receipt); await writeObservation(values, snapshot, receipt);
    await assert.rejects(buildCurrentSeoulAccessibilityRegistrationOutputs({ repositoryRoot: values.root, snapshotPath: values.snapshotPath, receiptPath: values.receiptPath, now: new Date("2026-08-22T00:01:00.000Z") }), entry.expected, entry.name);
  }

  const governance = await fixture();
  t.after(() => Promise.all([rm(governance.root, { recursive: true, force: true }), rm(governance.observation, { recursive: true, force: true })]));
  const inventoryPath = path.join(governance.root, "tools/datapack/source-inventory.json");
  const inventory = JSON.parse(await readFile(inventoryPath, "utf8"));
  inventory.sources.find(({ id }) => id === "seoul-metro-accessibility").license.redistributionAllowed = false;
  await writeFile(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`);
  await assert.rejects(buildCurrentSeoulAccessibilityRegistrationOutputs({ repositoryRoot: governance.root, snapshotPath: governance.snapshotPath, receiptPath: governance.receiptPath, now: new Date("2026-08-22T00:01:00.000Z") }), /governance identity/);

  const stale = await fixture();
  t.after(() => Promise.all([rm(stale.root, { recursive: true, force: true }), rm(stale.observation, { recursive: true, force: true })]));
  const snapshot = structuredClone(stale.snapshot); const receipt = structuredClone(stale.receipt);
  snapshot.snapshotId = "seoul-metro-accessibility-20260820T000000000Z";
  snapshot.capturedAt = "2026-08-20T00:00:00.000Z"; snapshot.retrievedAt = snapshot.capturedAt; snapshot.observedAt = snapshot.capturedAt; snapshot.freshUntil = "2026-08-21T00:00:00.000Z";
  receipt.rawObjectUri = `oci://axvym6vk8g7i/easysubway-datapacks/source-raw/seoul-metro-accessibility/20260820/${receipt.rawObjectSha256}.json`;
  receipt.storedAt = "2026-08-20T00:00:01.000Z"; receipt.rawRetentionExpiresAt = "2026-11-18T00:00:00.000Z";
  await writeObservation(stale, snapshot, receipt);
  await assert.rejects(buildCurrentSeoulAccessibilityRegistrationOutputs({ repositoryRoot: stale.root, snapshotPath: stale.snapshotPath, receiptPath: stale.receiptPath, now: new Date("2026-08-22T00:01:00.000Z") }), /snapshot is stale/);
});
