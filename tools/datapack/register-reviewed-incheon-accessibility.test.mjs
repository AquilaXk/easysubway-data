import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildReviewedIncheonAccessibilityRegistrationOutputs, commitReviewedIncheonAccessibilityRegistrationOutputs } from "./register-reviewed-incheon-accessibility.mjs";
import { runIncheonAccessibilityCollector } from "./collect-incheon-accessibility.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const sha = (value) => createHash("sha256").update(value).digest("hex");
const noLease = async () => async () => {};
const fixed = ["tools/datapack/source-inventory.json", "tools/datapack/release/source-snapshots.json", "tools/datapack/release/candidate-build-spec.json", "tools/datapack/release/release-request.json", "tools/datapack/release/hash-evidence.json", "tools/datapack/source-candidates.json", "tools/datapack/source-governance-policy.json", "release/product-gates/datapack-freshness-sla.json", "tools/datapack/sources/incheon-transit-station-info-20260828.json"];
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "incheon-register-")); t.after(() => rm(root, { recursive: true, force: true }));
  for (const relative of fixed) { await mkdir(path.dirname(path.join(root, relative)), { recursive: true }); await cp(path.join(ROOT, relative), path.join(root, relative)); }
  const inventory = JSON.parse(await readFile(path.join(root, fixed[0]), "utf8")); const source = inventory.sources.find(({ id }) => id === "incheon-transit-accessibility");
  const capturedAt = source.admissionEvidence.snapshotId.match(/(\d{8}T\d{9}Z)$/u)?.[1].replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z$/u, "$1-$2-$3T$4:$5:$6.$7Z");
  assert.equal(capturedAt, source.accessibilityAdmissionEvidence.capturedAt); const observationRoot = path.join(root, "observation");
  await runIncheonAccessibilityCollector(["--elevator-input", path.join(ROOT, "tools/datapack/fixtures/incheon-accessibility-raw/data-go-15083478.csv"), "--escalator-input", path.join(ROOT, "tools/datapack/fixtures/incheon-accessibility-raw/data-go-15010199.csv"), "--wheelchair-input", path.join(ROOT, "tools/datapack/fixtures/incheon-accessibility-raw/data-go-15146049.csv"), "--topology-snapshot", path.join(root, "tools/datapack/sources/incheon-transit-station-info-20260828.json"), "--observation-output", observationRoot, "--captured-at", capturedAt]);
  const manifest = JSON.parse(await readFile(path.join(observationRoot, "observation.json"), "utf8")); const snapshot = JSON.parse(await readFile(path.join(observationRoot, manifest.snapshotFile), "utf8")); const rawBytes = await readFile(path.join(observationRoot, manifest.rawArtifactFile));
  assert.equal(snapshot.snapshotId, source.admissionEvidence.snapshotId); assert.equal(snapshot.rawSha256, source.admissionEvidence.rawSha256);
  const receiptPath = path.join(root, "receipt.json"); const receipt = { schemaVersion: 1, artifactKind: "incheon-accessibility-raw-object-receipt", sourceId: source.id, snapshotId: snapshot.snapshotId, snapshotRawSha256: snapshot.rawSha256, capturedAt, snapshotFileSha256: manifest.snapshotFileSha256, rawObjectUri: `oci://axvym6vk8g7i/easysubway-datapacks/source-raw/${source.id}/${capturedAt.slice(0, 10).replaceAll("-", "")}/${sha(rawBytes)}.json`, rawObjectSha256: sha(rawBytes), byteSize: rawBytes.length, storedAt: "2026-08-28T04:40:00.000Z", rawRetentionExpiresAt: "2026-11-26T04:33:56.000Z" }; await writeFile(receiptPath, JSON.stringify(receipt));
  return { root, observationRoot, receiptPath, now: new Date("2026-08-28T04:50:00.000Z") };
}
async function removeTransferPrestate(root) {
  const candidatePath = path.join(root, fixed[2]);
  const ledgerPath = path.join(root, fixed[1]);
  const requestPath = path.join(root, fixed[3]);
  const evidencePath = path.join(root, fixed[4]);
  const candidate = JSON.parse(await readFile(candidatePath, "utf8"));
  const transferIndex = candidate.sourceSnapshots.findIndex(({ sourceId }) => sourceId === "seoul-metro-transfer-distance-duration");
  assert.notEqual(transferIndex, -1);
  const [removed] = candidate.sourceSnapshots.splice(transferIndex, 1);
  candidate.sourceSnapshotIds.splice(transferIndex, 1);
  const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
  const selected = ledger.filter(({ snapshotId }) => candidate.sourceSnapshotIds.includes(snapshotId));
  candidate.sourceSnapshotSetHash = sha(JSON.stringify(selected));
  const candidateBytes = Buffer.from(`${JSON.stringify(candidate, null, 2)}\n`);
  const request = JSON.parse(await readFile(requestPath, "utf8"));
  request.buildSpecSha256 = sha(candidateBytes);
  request.sourceSnapshotSetHash = candidate.sourceSnapshotSetHash;
  const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
  evidence.sourceSnapshotSetHash.value = candidate.sourceSnapshotSetHash;
  evidence.perSourceEvidence = evidence.perSourceEvidence.filter(({ sourceId }) => sourceId !== removed.sourceId);
  await Promise.all([
    writeFile(candidatePath, candidateBytes),
    writeFile(requestPath, `${JSON.stringify(request, null, 2)}\n`),
    writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`),
  ]);
}
test("registers from either current active candidate sequence without a fixed source count", async (t) => {
  const value = await fixture(t);
  await removeTransferPrestate(value.root);
  const outputs = await buildReviewedIncheonAccessibilityRegistrationOutputs({ repositoryRoot: value.root, observationRoot: value.observationRoot, receiptPath: value.receiptPath, now: value.now });
  const candidate = JSON.parse(outputs[3].bytes);
  assert.equal(candidate.sourceSnapshots.at(-1).sourceId, "incheon-transit-accessibility");
});
test("registers exactly six reviewed outputs and preserves atomic prestate", async (t) => {
  const value = await fixture(t); const before = await Promise.all(fixed.slice(0, 5).map((relative) => readFile(path.join(value.root, relative))));
  const outputs = await buildReviewedIncheonAccessibilityRegistrationOutputs({ repositoryRoot: value.root, observationRoot: value.observationRoot, receiptPath: value.receiptPath, now: value.now });
  assert.equal(outputs.length, 6); assert.deepEqual(outputs.slice(1).map(({ relative }) => relative), fixed.slice(0, 5)); await assert.rejects(commitReviewedIncheonAccessibilityRegistrationOutputs({ repositoryRoot: value.root, outputs, failAfter: 2, acquireLease: noLease }), /injected/); assert.deepEqual(await Promise.all(fixed.slice(0, 5).map((relative) => readFile(path.join(value.root, relative)))), before);
  const inventory = JSON.parse(outputs[1].bytes); const source = inventory.sources.find(({ id }) => id === "incheon-transit-accessibility");
  const originalSource = JSON.parse(before[0]).sources.find(({ id }) => id === "incheon-transit-accessibility");
  const ledger = JSON.parse(outputs[2].bytes); const registered = ledger.at(-1);
  const candidate = JSON.parse(outputs[3].bytes); const request = JSON.parse(outputs[4].bytes); const evidence = JSON.parse(outputs[5].bytes);
  assert.equal(source.requiredForProductionPack, true); assert.equal(Object.hasOwn(source, "accessibilityAdmissionEvidence"), false); assert.deepEqual(source.admissionEvidence, originalSource.admissionEvidence);
  const registeredSnapshot = JSON.parse(outputs[0].bytes);
  assert.deepEqual(registered.previousSnapshotId, null); assert.deepEqual(registered.providerRecordHashes, registeredSnapshot.rows.map((row) => sha(JSON.stringify(row)))); assert.equal(registered.claimBindingsSha256, registeredSnapshot.claimBindingsSha256); assert.equal(registeredSnapshot.claimBindings.length, 426);
  assert.notEqual(registered.redactedRequestFingerprint, registered.rawSha256); assert.deepEqual(Object.keys(registered.rawReceipt), ["schemaVersion", "artifactKind", "sourceId", "snapshotId", "snapshotRawSha256", "capturedAt", "snapshotFileSha256", "rawObjectUri", "rawObjectSha256", "byteSize", "storedAt", "rawRetentionExpiresAt"]); assert.equal(registered.rawReceipt.capturedAt, "2026-08-28T04:33:56.000Z"); assert.equal(registered.adminReviewRecordHash, source.admissionEvidence.adminReviewRecordHash);
  assert.deepEqual(candidate.sourceSnapshots.map(({ sourceId }) => sourceId), ["seoul-metro-route-map-positions", "kric-subway-timetable", "seoul-metro-accessibility", "kric-station-convenience-standard", "molit-urban-rail-full-route", "seoulmetro-station-line-info", "incheon-transit-accessibility", "seoul-metro-transfer-distance-duration"]);
  assert.equal(Object.hasOwn(candidate.networkEdgeEvidence, "incheonAccessibility"), false); assert.equal(candidate.publishedAt, "2026-08-28T04:50:00.000Z");
  const selectedLedgerOrder = ledger.filter(({ snapshotId }) => candidate.sourceSnapshotIds.includes(snapshotId));
  assert.equal(candidate.sourceSnapshotSetHash, sha(JSON.stringify(selectedLedgerOrder))); assert.equal(request.buildSpecSha256, sha(outputs[3].bytes)); assert.deepEqual(evidence.perSourceEvidence.map(({ sourceId }) => sourceId), selectedLedgerOrder.map(({ sourceId }) => sourceId)); assert.equal(evidence.perSourceEvidence.length, 8); assert.equal(evidence.sourceSnapshots.order.includes("incheon-transit-accessibility"), true); assert.match(evidence.sourceSnapshots.specRowRawSha256Note, /OCI object hash/);
  await commitReviewedIncheonAccessibilityRegistrationOutputs({ repositoryRoot: value.root, outputs, acquireLease: noLease }); assert.equal(JSON.parse(await readFile(path.join(value.root, outputs[0].relative))).sourceId, "incheon-transit-accessibility");
});
test("rejects receipt raw, captured-at, URI, and admitted-topology mutations before commit", async (t) => {
  for (const [field, replacement, expected] of [["rawObjectSha256", "0".repeat(64), /receipt/], ["capturedAt", "2026-08-28T04:33:57.000Z", /receipt/], ["rawObjectUri", "s3://legacy", /receipt/]]) {
    const value = await fixture(t); const receipt = JSON.parse(await readFile(value.receiptPath, "utf8")); receipt[field] = replacement; await writeFile(value.receiptPath, JSON.stringify(receipt)); await assert.rejects(buildReviewedIncheonAccessibilityRegistrationOutputs({ repositoryRoot: value.root, observationRoot: value.observationRoot, receiptPath: value.receiptPath, now: value.now }), expected);
  }
  const value = await fixture(t); const topology = path.join(value.root, fixed[8]); const mutated = JSON.parse(await readFile(topology, "utf8")); mutated.contentSha256 = "0".repeat(64); await writeFile(topology, `${JSON.stringify(mutated)}\n`); await assert.rejects(buildReviewedIncheonAccessibilityRegistrationOutputs({ repositoryRoot: value.root, observationRoot: value.observationRoot, receiptPath: value.receiptPath, now: value.now }), /topology/);

  const reordered = await fixture(t); const candidatePath = path.join(reordered.root, fixed[2]); const candidate = JSON.parse(await readFile(candidatePath, "utf8")); [candidate.sourceSnapshotIds[0], candidate.sourceSnapshotIds[1]] = [candidate.sourceSnapshotIds[1], candidate.sourceSnapshotIds[0]]; [candidate.sourceSnapshots[0], candidate.sourceSnapshots[1]] = [candidate.sourceSnapshots[1], candidate.sourceSnapshots[0]]; await writeFile(candidatePath, `${JSON.stringify(candidate)}\n`); await assert.rejects(buildReviewedIncheonAccessibilityRegistrationOutputs({ repositoryRoot: reordered.root, observationRoot: reordered.observationRoot, receiptPath: reordered.receiptPath, now: reordered.now }), /candidate prestate/);

  const licenseDrift = await fixture(t); const inventoryPath = path.join(licenseDrift.root, fixed[0]); const inventory = JSON.parse(await readFile(inventoryPath, "utf8")); inventory.sources.find(({ id }) => id === "incheon-transit-accessibility").admissionEvidence.licenseEvidenceHash = "0".repeat(64); await writeFile(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`); await assert.rejects(buildReviewedIncheonAccessibilityRegistrationOutputs({ repositoryRoot: licenseDrift.root, observationRoot: licenseDrift.observationRoot, receiptPath: licenseDrift.receiptPath, now: licenseDrift.now }), /receipt-pending production admission/);

  const unauthorized = await fixture(t); const requestPath = path.join(unauthorized.root, fixed[3]); const request = JSON.parse(await readFile(requestPath, "utf8")); request.approvedLedgerHash = "0".repeat(64); await writeFile(requestPath, `${JSON.stringify(request)}\n`); await assert.rejects(buildReviewedIncheonAccessibilityRegistrationOutputs({ repositoryRoot: unauthorized.root, observationRoot: unauthorized.observationRoot, receiptPath: unauthorized.receiptPath, now: unauthorized.now }), /release prestate/);
});
test("recovers a committed journal and preserves a foreign prepared replacement", async (t) => {
  const value = await fixture(t); const outputs = await buildReviewedIncheonAccessibilityRegistrationOutputs({ repositoryRoot: value.root, observationRoot: value.observationRoot, receiptPath: value.receiptPath, now: value.now });
  const records = outputs.map(({ relative, prestateBytes, bytes }) => ({ relative, before: prestateBytes?.toString("base64") ?? null, beforeSha256: prestateBytes == null ? null : sha(prestateBytes), after: bytes.toString("base64"), afterSha256: sha(bytes) }));
  await writeFile(path.join(value.root, "tools/datapack/.incheon-accessibility-registration-transaction.json"), `${JSON.stringify({ state: "COMMITTED", records })}\n`);
  await writeFile(path.join(value.root, outputs[1].relative), outputs[1].bytes);
  await assert.rejects(commitReviewedIncheonAccessibilityRegistrationOutputs({ repositoryRoot: value.root, outputs, acquireLease: noLease }), /foreign replacement/);
  for (const output of outputs) assert.deepEqual(await readFile(path.join(value.root, output.relative)), output.bytes);

  const foreign = await fixture(t); const foreignOutputs = await buildReviewedIncheonAccessibilityRegistrationOutputs({ repositoryRoot: foreign.root, observationRoot: foreign.observationRoot, receiptPath: foreign.receiptPath, now: foreign.now });
  const foreignRecords = foreignOutputs.map(({ relative, prestateBytes, bytes }) => ({ relative, before: prestateBytes?.toString("base64") ?? null, beforeSha256: prestateBytes == null ? null : sha(prestateBytes), after: bytes.toString("base64"), afterSha256: sha(bytes) }));
  await writeFile(path.join(foreign.root, "tools/datapack/.incheon-accessibility-registration-transaction.json"), `${JSON.stringify({ state: "PREPARED", records: foreignRecords })}\n`);
  const foreignTarget = path.join(foreign.root, foreignOutputs[1].relative); await writeFile(foreignTarget, "foreign\n");
  await assert.rejects(commitReviewedIncheonAccessibilityRegistrationOutputs({ repositoryRoot: foreign.root, outputs: foreignOutputs, acquireLease: noLease }), /foreign replacement/);
  assert.deepEqual(await readFile(foreignTarget), Buffer.from("foreign\n"));
});
