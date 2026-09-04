import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { publishCapitalRouteTopologyRaw } from "./publish-capital-route-topology-raw.mjs";
import {
  buildCurrentCapitalRouteTopologyRegistrationOutputs,
  commitCurrentCapitalRouteTopologyRegistrationOutputs,
  readCurrentCapitalRouteTopologyAdmission,
} from "./register-current-capital-route-topology.mjs";
import { deriveRawRetentionExpiresAt } from "./source-governance-policy.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const sha = (value) => createHash("sha256").update(value).digest("hex");
const writeJson = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + "\n");

async function copy(relative, root) {
  const target = path.join(root, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, await readFile(path.join(ROOT, relative)));
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "capital-topology-registration-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const inventory = JSON.parse(await readFile(path.join(ROOT, "tools/datapack/source-inventory.json")));
  const protectedAdmission = inventory.sources.find((source) => source.id === "seoul-metro-route-map-positions")
    .routeMapAdmissionEvidence.currentTopologyAdmission;
  const topologyRelative = "tools/datapack/sources/" + protectedAdmission.topologySnapshotId + ".json";
  for (const relative of [
    "tools/datapack/source-inventory.json",
    "tools/datapack/release/source-snapshots.json",
    "tools/datapack/source-candidates.json",
    "tools/datapack/source-governance-policy.json",
    "release/product-gates/datapack-freshness-sla.json",
    topologyRelative,
  ]) await copy(relative, root);
  const topology = JSON.parse(await readFile(path.join(root, topologyRelative)));
  const candidates = JSON.parse(await readFile(path.join(root, "tools/datapack/source-candidates.json")));
  const reviewedAt = candidates.candidates.find((candidate) => candidate.id === "capital-route-topology")
    .registrationMetadata.governance.licenseReview.reviewedAt;
  const now = await advanceProtectedTopology(root, new Date(Date.parse(topology.capturedAt) + 1_000), new Date(Date.parse(reviewedAt) + 1_000));
  const currentInventory = JSON.parse(await readFile(path.join(root, "tools/datapack/source-inventory.json")));
  const currentSnapshotId = currentInventory.sources.find((source) => source.id === "seoul-metro-route-map-positions")
    .routeMapAdmissionEvidence.currentTopologyAdmission.topologySnapshotId;
  return { root, topologyRelative: "tools/datapack/sources/" + currentSnapshotId + ".json", now };
}

async function receiptFixture(root, now) {
  const admission = await readCurrentCapitalRouteTopologyAdmission({ repositoryRoot: root, now });
  const rawObjectSha256 = sha(admission.topologyBytes);
  const objectKey = "source-raw/" + admission.sourceId + "/" + admission.capturedDate + "/" + rawObjectSha256 + ".json";
  const receipt = {
    schemaVersion: 1,
    artifactKind: "static-network-source-raw-object-receipt",
    sourceId: admission.sourceId,
    snapshotId: admission.snapshotId,
    capturedAt: admission.topology.capturedAt,
    rawObjectUri: "oci://axvym6vk8g7i/easysubway-datapacks/" + objectKey,
    rawObjectSha256,
    byteSize: admission.topologyBytes.length,
    storedAt: now.toISOString(),
    rawRetentionExpiresAt: deriveRawRetentionExpiresAt({
      policy: admission.governancePolicy,
      sourceId: admission.sourceId,
      retrievedAt: admission.topology.capturedAt,
    }),
    ociNamespace: "axvym6vk8g7i",
    bucket: "easysubway-datapacks",
    objectKey,
    contentType: "application/json",
  };
  const receiptPath = path.join(root, "receipt.json");
  await writeJson(receiptPath, receipt);
  return { admission, receipt, receiptPath };
}

async function registrationInputBytes(root) {
  return {
    inventoryBytes: await readFile(path.join(root, "tools/datapack/source-inventory.json")),
    candidateBytes: await readFile(path.join(root, "tools/datapack/source-candidates.json")),
    governanceBytes: await readFile(path.join(root, "tools/datapack/source-governance-policy.json")),
    freshnessBytes: await readFile(path.join(root, "release/product-gates/datapack-freshness-sla.json")),
  };
}

async function advanceProtectedTopology(root, previousNow, minimumCapturedAt = null) {
  const inventoryPath = path.join(root, "tools/datapack/source-inventory.json");
  const inventory = JSON.parse(await readFile(inventoryPath));
  const holder = inventory.sources.find((source) => source.id === "seoul-metro-route-map-positions");
  const previous = holder.routeMapAdmissionEvidence.currentTopologyAdmission;
  const previousTopology = JSON.parse(await readFile(path.join(root, "tools/datapack/sources/" + previous.topologySnapshotId + ".json")));
  const capturedMillis = Math.max(
    Date.parse(previousTopology.capturedAt) + 86_400_000,
    minimumCapturedAt?.valueOf() ?? Number.NEGATIVE_INFINITY,
  );
  const captured = new Date(capturedMillis).toISOString();
  const snapshotId = "capital-route-topology-" + captured.slice(0, 10).replaceAll("-", "");
  const topology = { ...previousTopology, capturedAt: captured, freshUntil: new Date(Date.parse(captured) + 86_400_000).toISOString() };
  const admission = {
    ...previous,
    topologySnapshotId: snapshotId,
    topologyContentSha256: topology.contentSha256,
    reviewedAt: captured,
    freshUntil: topology.freshUntil,
    topologyLineages: previous.topologyLineages.map((lineage) => ({ ...lineage, snapshotId, contentSha256: topology.contentSha256 })),
  };
  holder.routeMapAdmissionEvidence.currentTopologyAdmission = admission;
  const relative = "tools/datapack/sources/" + snapshotId + ".json";
  await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
  await writeJson(path.join(root, relative), topology);
  await writeJson(inventoryPath, inventory);
  return new Date(Math.max(Date.parse(captured) + 1_000, previousNow.valueOf() + 1));
}

test("publishes exactly the protected topology bytes and builds an initial registration", async (t) => {
  const { root, now } = await fixture(t);
  const { admission } = await receiptFixture(root, now);
  const operationRoot = await mkdtemp(path.join(os.tmpdir(), "capital-topology-publish-"));
  t.after(() => rm(operationRoot, { recursive: true, force: true }));
  await writeFile(path.join(operationRoot, "capital-route-topology.raw.json"), admission.topologyBytes);
  const objects = new Map();
  const client = {
    putObjectIfAbsent: async (key, body) => { if (objects.has(key)) return false; objects.set(key, Buffer.from(body)); return true; },
    readObject: async (key) => objects.has(key) ? { exists: true, body: objects.get(key) } : { exists: false },
  };
  const receipt = await publishCapitalRouteTopologyRaw({
    repositoryRoot: root, operationRoot, expectedMainSha: "a".repeat(40),
    gitRunner: async (args) => args[0] === "status" ? "" : "a".repeat(40),
    env: { EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL: "https://objectstorage.example.oraclecloud.com/p/test/n/axvym6vk8g7i/b/easysubway-datapacks/o/" },
    client, now, receiptPath: path.join(operationRoot, "capital-route-topology.raw-receipt.json"),
  });
  assert.equal(receipt.rawObjectSha256, sha(admission.topologyBytes));
  assert.equal(receipt.byteSize, admission.topologyBytes.length);
  assert.deepEqual(objects.get(receipt.objectKey), admission.topologyBytes);
  const receiptPath = path.join(root, "published-receipt.json");
  await writeJson(receiptPath, receipt);
  const outputs = await buildCurrentCapitalRouteTopologyRegistrationOutputs({ repositoryRoot: root, receiptPath, now });
  assert.deepEqual(outputs.map(({ relative }) => relative), [
    "tools/datapack/source-inventory.json",
    "tools/datapack/release/source-snapshots.json",
    "tools/datapack/source-governance-policy.json",
    "release/product-gates/datapack-freshness-sla.json",
  ]);
  const source = JSON.parse(outputs[0].bytes).sources.at(-1);
  const snapshot = JSON.parse(outputs[1].bytes).at(-1);
  for (const key of ["id", "displayName", "owner", "provider", "providerDepartment", "sourceSystem", "datasetUrl", "datasetKind", "coverage"]) {
    assert.equal(typeof source[key], "string", `generated inventory ${key}`);
    assert.notEqual(source[key], "", `generated inventory ${key}`);
  }
  assert.equal(source.requiredForProductionPack, true);
  assert.equal(source.productionUseAllowed, true);
  assert.equal(source.license.name, "공공누리 제1유형");
  assert.equal(snapshot.rawSha256, sha(admission.topologyBytes));
  assert.equal(snapshot.byteSize, admission.topologyBytes.length);
});

test("places capital topology evidence on the source schema", async () => {
  const schema = JSON.parse(await readFile(path.join(ROOT, "contracts/datapack/source-inventory.schema.json")));
  const sourceProperties = schema.properties.sources.items.properties;
  assert.ok(sourceProperties.capitalTopologyAdmissionEvidence);
  assert.equal(Object.hasOwn(sourceProperties.routeMapAdmissionEvidence.properties, "capitalTopologyAdmissionEvidence"), false);
});

test("derives admission from one captured repository input snapshot", async (t) => {
  const { root, now } = await fixture(t);
  const inputBytes = await registrationInputBytes(root);
  const governancePath = path.join(root, "tools/datapack/source-governance-policy.json");
  const changedGovernance = JSON.parse(inputBytes.governanceBytes);
  changedGovernance.concurrentSentinel = true;
  await writeJson(governancePath, changedGovernance);

  const admission = await readCurrentCapitalRouteTopologyAdmission({ repositoryRoot: root, now, inputBytes });

  assert.equal(Object.hasOwn(admission.governancePolicy, "concurrentSentinel"), false);
});

test("commits initial registration then replaces only its inventory record for a unique successor", async (t) => {
  const { root, now } = await fixture(t);
  let receipt = await receiptFixture(root, now);
  let outputs = await buildCurrentCapitalRouteTopologyRegistrationOutputs({ repositoryRoot: root, receiptPath: receipt.receiptPath, now });
  await commitCurrentCapitalRouteTopologyRegistrationOutputs({ repositoryRoot: root, outputs });
  const initialSnapshot = JSON.parse(outputs[1].bytes).at(-1).snapshotId;
  const successorNow = await advanceProtectedTopology(root, now);
  receipt = await receiptFixture(root, successorNow);
  outputs = await buildCurrentCapitalRouteTopologyRegistrationOutputs({ repositoryRoot: root, receiptPath: receipt.receiptPath, now: successorNow });
  await commitCurrentCapitalRouteTopologyRegistrationOutputs({ repositoryRoot: root, outputs });
  const inventory = JSON.parse(await readFile(path.join(root, "tools/datapack/source-inventory.json")));
  const snapshots = JSON.parse(await readFile(path.join(root, "tools/datapack/release/source-snapshots.json")))
    .filter((snapshot) => snapshot.sourceId === "capital-route-topology");
  assert.equal(inventory.sources.filter((source) => source.id === "capital-route-topology").length, 1);
  assert.equal(snapshots.length, 2);
  assert.equal(snapshots.at(-1).previousSnapshotId, initialSnapshot);
  assert.deepEqual(snapshots.at(-1).admissionEvidence.predecessorSnapshotIds, [initialSnapshot]);
});

test("rejects receipt, freshness, and protected-scope mismatches without output mutation", async (t) => {
  const { root, topologyRelative, now } = await fixture(t);
  const { receipt, receiptPath } = await receiptFixture(root, now);
  const targets = [
    "tools/datapack/source-inventory.json",
    "tools/datapack/release/source-snapshots.json",
    "tools/datapack/source-governance-policy.json",
    "release/product-gates/datapack-freshness-sla.json",
  ];
  const before = await Promise.all(targets.map((relative) => readFile(path.join(root, relative))));
  receipt.rawObjectUri = "https://example.invalid/not-oci";
  await writeJson(receiptPath, receipt);
  await assert.rejects(buildCurrentCapitalRouteTopologyRegistrationOutputs({ repositoryRoot: root, receiptPath, now }), /receipt binding/);
  const topology = JSON.parse(await readFile(path.join(root, topologyRelative)));
  const protectedFreshUntil = topology.freshUntil;
  topology.freshUntil = topology.capturedAt;
  await writeJson(path.join(root, topologyRelative), topology);
  await assert.rejects(buildCurrentCapitalRouteTopologyRegistrationOutputs({ repositoryRoot: root, receiptPath, now }), /freshness identity is invalid/);
  topology.freshUntil = protectedFreshUntil;
  await writeJson(path.join(root, topologyRelative), topology);
  assert.deepEqual(await Promise.all(targets.map((relative) => readFile(path.join(root, relative)))), before);
  const inventoryPath = path.join(root, "tools/datapack/source-inventory.json");
  const inventory = JSON.parse(await readFile(inventoryPath));
  const protectedAdmission = inventory.sources.find((source) => source.id === "seoul-metro-route-map-positions")
    .routeMapAdmissionEvidence.currentTopologyAdmission;
  protectedAdmission.topologyLineages[0].sourceId = "wrong-source";
  await writeJson(inventoryPath, inventory);
  const beforeProtectedScopeRejection = await Promise.all(targets.map((relative) => readFile(path.join(root, relative))));
  await assert.rejects(buildCurrentCapitalRouteTopologyRegistrationOutputs({ repositoryRoot: root, receiptPath, now }), /topology identity|canonical owner/);
  assert.deepEqual(await Promise.all(targets.map((relative) => readFile(path.join(root, relative)))), beforeProtectedScopeRejection);
});

test("rolls a prepared transaction back across all registration targets", async (t) => {
  const { root, now } = await fixture(t);
  const { receiptPath } = await receiptFixture(root, now);
  const outputs = await buildCurrentCapitalRouteTopologyRegistrationOutputs({ repositoryRoot: root, receiptPath, now });
  const targets = outputs.map(({ relative }) => path.join(root, relative));
  const before = await Promise.all(targets.map((target) => readFile(target)));
  await assert.rejects(commitCurrentCapitalRouteTopologyRegistrationOutputs({ repositoryRoot: root, outputs, failAfter: 0 }), /injected capital topology transaction failure/);
  assert.deepEqual(await Promise.all(targets.map((target) => readFile(target))), before);
  await assert.rejects(access(path.join(root, "tools/datapack/.capital-route-topology-registration-transaction.json")));
});
