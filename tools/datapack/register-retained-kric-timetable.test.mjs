import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { decideRetainedGwangjuTimetableRefresh } from "../ci/decide-retained-gwangju-timetable-refresh.mjs";

import { parseCurrentMolitGwangjuStationMappings } from "./build-molit-nationwide-fixture.mjs";
import { deriveRawRetentionExpiresAt } from "./source-governance-policy.mjs";
import { prepareRetainedKricTimetablePublication } from "./prepare-retained-kric-timetable-publication.mjs";
import { canonicalJson } from "./lib/manifest-validation.mjs";
import { governanceBeforeSource } from "./test-fixtures/independent-source-governance.mjs";
import { materializeGwangjuTimetable, restoreAdmittedGwangjuTimetable, validateRetainedGwangjuSource } from "./materialize-gwangju-timetable.mjs";
import { createRetainedGwangjuTestInput } from "./gwangju-retained-test-fixture.mjs";
import {
  buildRetainedKricTimetableRegistrationOutputs,
  commitRetainedKricTimetableRegistrationOutputs,
} from "./register-retained-kric-timetable.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const outputs = ["tools/datapack/source-inventory.json", "tools/datapack/release/source-snapshots.json", "tools/datapack/source-governance-policy.json", "release/product-gates/datapack-freshness-sla.json"];
const env = { EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL: "https://objectstorage.ap-seoul-1.oraclecloud.com/p/test/n/axvym6vk8g7i/b/easysubway-datapacks/o" };
const sha = (value) => createHash("sha256").update(value).digest("hex");

test("receipt-bound retained registration projects exactly four CAS outputs and rolls back injected writes", async (context) => {
  const fixture = await registrationFixture(context);
  const before = await outputBytes(fixture.repositoryRoot);
  const registered = await buildRetainedKricTimetableRegistrationOutputs(fixture);
  assert.equal(JSON.parse(registered[0].bytes).sources.find(row => row.id === "kric-nationwide-timetable-file").license.type, "PUBLIC_DATA_FREE_USE");
  assert.deepEqual(registered.map(({ relative }) => relative), outputs);
  assert.equal(new Set(registered[0].inputs.map(({ absolute }) => absolute)).size, registered[0].inputs.length);
  assert.ok(registered[0].inputs.some(({ absolute }) => absolute.endsWith(fixture.molitObservationPath)));
  assert.ok(registered[0].inputs.every(({ absolute }) => !absolute.endsWith("molit-urban-rail-full-route-20251211.csv")));
  // 개발 변환은 원문으로 재현한다. 운영 만료는 publication 경계에서 거부한다.
  assert.doesNotThrow(() => materializeGwangjuTimetable({
    ...fixture.materializerInput, inventory: JSON.parse(registered[0].bytes),
  }));
  await assert.rejects(() => commitRetainedKricTimetableRegistrationOutputs({
    repositoryRoot: fixture.repositoryRoot, outputs: registered, failAfter: 1,
  }), /injected/);
  assert.deepEqual(await outputBytes(fixture.repositoryRoot), before);
  await commitRetainedKricTimetableRegistrationOutputs({ repositoryRoot: fixture.repositoryRoot, outputs: registered });
  assert.notDeepEqual(await outputBytes(fixture.repositoryRoot), before);
});

test("registered timetable remains consumable after operation inputs are removed", async (context) => {
  const fixture = await registrationFixture(context);
  const registered = await buildRetainedKricTimetableRegistrationOutputs(fixture);
  await commitRetainedKricTimetableRegistrationOutputs({ repositoryRoot: fixture.repositoryRoot, outputs: registered });
  const input = await readJson(fixture.sourceInputPath);
  const observationBytes = await readFile(input.observationPath);
  for (const file of [input.observationPath, input.collectionReceiptPath,
    input.publicationReceiptPath, input.retainedContractPath, fixture.sourceInputPath]) await rm(file);
  const inventory = await readJson(path.join(fixture.repositoryRoot, outputs[0]));
  const snapshots = await readJson(path.join(fixture.repositoryRoot, outputs[1]));
  const restored = restoreAdmittedGwangjuTimetable({ observationBytes, inventory, snapshots });
  assert.deepEqual(restored, fixture.materializerInput.retainedTimetable);
  const source = inventory.sources.find(({ id }) => id === "kric-nationwide-timetable-file");
  assert.deepEqual(validateRetainedGwangjuSource({ ...fixture.materializerInput, source,
    retainedTimetable: restored }), validateRetainedGwangjuSource({ ...fixture.materializerInput, source }));
  assert.throws(() => restoreAdmittedGwangjuTimetable({
    observationBytes: Buffer.concat([observationBytes, Buffer.from(" ")]), inventory, snapshots,
  }), /persisted input binding/);
  snapshots.at(-1).retainedTimetableInputs.contract.calendar.publicHolidayDates.push("20990101");
  assert.throws(() => restoreAdmittedGwangjuTimetable({ observationBytes, inventory, snapshots }), /persisted input binding/);
});

test("registration preserves the provider cutoff for the refresh consumer", async (context) => {
  const fixture = await registrationFixture(context, { capped: true });
  const registered = await buildRetainedKricTimetableRegistrationOutputs(fixture);
  const input = await readJson(fixture.sourceInputPath);
  const snapshots = JSON.parse(registered[1].bytes);
  assert.equal(snapshots.at(-1).serviceEffectiveUntil, input.providerValidUntil);
  const candidates = await readJson(path.join(fixture.repositoryRoot, "tools/datapack/source-candidates.json"));
  assert.equal(decideRetainedGwangjuTimetableRefresh({
    inventory: JSON.parse(registered[0].bytes), snapshots,
    candidate: candidates.candidates.find(({ id }) => id === "kric-nationwide-timetable-file"),
    now: new Date(input.providerValidUntil),
  }).state, "DUE");
});

test("retained registration fails closed for publication or frozen-input drift without writes", async (context) => {
  const fixture = await registrationFixture(context);
  const before = await outputBytes(fixture.repositoryRoot);
  await writeFile(fixture.publicationReceiptPath, "{}\n");
  await assert.rejects(() => buildRetainedKricTimetableRegistrationOutputs(fixture));
  assert.deepEqual(await outputBytes(fixture.repositoryRoot), before);

  const mixed = await registrationFixture(context);
  const mixedBefore = await outputBytes(mixed.repositoryRoot);
  const registered = await buildRetainedKricTimetableRegistrationOutputs(mixed);
  await writeFile(path.join(mixed.repositoryRoot, "tools/datapack/source-candidates.json"), "{}\n");
  await assert.rejects(() => commitRetainedKricTimetableRegistrationOutputs({ repositoryRoot: mixed.repositoryRoot, outputs: registered }));
  assert.deepEqual(await outputBytes(mixed.repositoryRoot), mixedBefore);
});

test("retained registration appends only a genuine receipt-bound successor", async (context) => {
  const fixture = await registrationFixture(context);
  await commitRetainedKricTimetableRegistrationOutputs({ repositoryRoot: fixture.repositoryRoot,
    outputs: await buildRetainedKricTimetableRegistrationOutputs(fixture) });
  const policyBytes = await readFile(path.join(fixture.repositoryRoot, outputs[2]));
  const freshnessBytes = await readFile(path.join(fixture.repositoryRoot, outputs[3]));
  const initialLedger = await readJson(path.join(fixture.repositoryRoot, outputs[1]));

  await replaceWithSuccessor(fixture);
  const successor = await buildRetainedKricTimetableRegistrationOutputs(fixture);
  assert.ok(successor[2].bytes.equals(policyBytes));
  assert.ok(successor[3].bytes.equals(freshnessBytes));
  const nextInventory = JSON.parse(successor[0].bytes);
  const nextLedger = JSON.parse(successor[1].bytes);
  assert.equal(nextInventory.sources.filter(({ id }) => id === "kric-nationwide-timetable-file").length, 1);
  assert.deepEqual(nextLedger.slice(0, initialLedger.length), initialLedger);
  assert.equal(nextLedger.at(-1).previousSnapshotId, initialLedger.find(({ sourceId }) => sourceId === "kric-nationwide-timetable-file").snapshotId);
  await commitRetainedKricTimetableRegistrationOutputs({ repositoryRoot: fixture.repositoryRoot, outputs: successor });

  const replayBefore = await outputBytes(fixture.repositoryRoot);
  await assert.rejects(() => buildRetainedKricTimetableRegistrationOutputs(fixture), /REFRESH_OBSERVATION/);
  assert.deepEqual(await outputBytes(fixture.repositoryRoot), replayBefore);

  const inventoryPath = path.join(fixture.repositoryRoot, outputs[0]);
  const inventory = await readJson(inventoryPath);
  inventory.sources.find(({ id }) => id === "kric-nationwide-timetable-file").retainedScheduleAdmissionEvidence.snapshotId = "wrong-head";
  await writeFile(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`);
  const headBefore = await outputBytes(fixture.repositoryRoot);
  await assert.rejects(() => buildRetainedKricTimetableRegistrationOutputs(fixture), /REFRESH_HEAD/);
  assert.deepEqual(await outputBytes(fixture.repositoryRoot), headBefore);
  await writeFile(inventoryPath, replayBefore[0]);

  const input = await readJson(fixture.sourceInputPath);
  input.governanceEntry.ownerRole = "different-owner";
  await writeFile(fixture.sourceInputPath, `${JSON.stringify(input, null, 2)}\n`);
  const approvalBefore = await outputBytes(fixture.repositoryRoot);
  await assert.rejects(() => buildRetainedKricTimetableRegistrationOutputs(fixture), /REFRESH_POLICY/);
  assert.deepEqual(await outputBytes(fixture.repositoryRoot), approvalBefore);
  input.governanceEntry.ownerRole = "datapack-source-owner";
  await writeFile(fixture.sourceInputPath, `${JSON.stringify(input, null, 2)}\n`);

  const governancePath = path.join(fixture.repositoryRoot, outputs[2]);
  const governance = await readJson(governancePath);
  governance.sources.find(({ sourceId }) => sourceId === "kric-nationwide-timetable-file").ownerRole = "policy-drift";
  await writeFile(governancePath, `${JSON.stringify(governance, null, 2)}\n`);
  const policyBefore = await outputBytes(fixture.repositoryRoot);
  await assert.rejects(() => buildRetainedKricTimetableRegistrationOutputs(fixture), /REFRESH_POLICY/);
  assert.deepEqual(await outputBytes(fixture.repositoryRoot), policyBefore);
});

async function registrationFixture(context, { capped = false } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "retained-kric-registration-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const repositoryRoot = path.join(directory, "repo");
  for (const relative of [...outputs, "tools/datapack/source-candidates.json", "tools/datapack/sources/gwangju-transportation-route-topology-20260720.json"]) {
    const target = path.join(repositoryRoot, relative); await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, await readFile(path.join(root, relative)));
  }
  const [currentInventory, currentGovernance, candidates, topologySnapshot] = await Promise.all([
    readJson(path.join(repositoryRoot, outputs[0])), readJson(path.join(repositoryRoot, outputs[2])),
    readJson(path.join(repositoryRoot, "tools/datapack/source-candidates.json")),
    readJson(path.join(repositoryRoot, "tools/datapack/sources/gwangju-transportation-route-topology-20260720.json")),
  ]);
  const inventory = structuredClone(currentInventory);
  const molitAdmission = inventory.sources.find(({ id }) => id === "molit-urban-rail-full-route").admissionEvidence;
  const molitObservationPath = `tools/datapack/sources/${molitAdmission.snapshotId}.json`;
  await mkdir(path.dirname(path.join(repositoryRoot, molitObservationPath)), { recursive: true });
  await writeFile(path.join(repositoryRoot, molitObservationPath), await readFile(path.join(root, molitObservationPath)));
  const sourceId = "kric-nationwide-timetable-file";
  inventory.sources = inventory.sources.filter(row => row.id !== sourceId);
  if (!inventory.sources.some(row => row.id === "gwangju-transportation-cyberstation-timetable")) {
    inventory.sources.push({ id: "gwangju-transportation-cyberstation-timetable", requiredForProductionPack: false });
  }
  const governance = governanceBeforeSource(currentGovernance, sourceId);
  const ledger = (await readJson(path.join(repositoryRoot, outputs[1]))).filter(row => row.sourceId !== sourceId);
  const freshness = await readJson(path.join(repositoryRoot, outputs[3]));
  freshness.sourceClasses = freshness.sourceClasses.filter(row => !row.sourceIds.includes(sourceId));
  await writeFile(path.join(repositoryRoot, outputs[1]), `${JSON.stringify(ledger, null, 2)}\n`);
  await writeFile(path.join(repositoryRoot, outputs[2]), `${JSON.stringify(governance, null, 2)}\n`);
  await writeFile(path.join(repositoryRoot, outputs[3]), `${JSON.stringify(freshness, null, 2)}\n`);
  await writeFile(path.join(repositoryRoot, outputs[0]), `${JSON.stringify(inventory, null, 2)}\n`);
  const now = new Date(Date.parse(topologySnapshot.capturedAt) + 2 * 86400000);
  const arrays = ["sourceInventory", "operators", "lines", "stations", "stationLines", "networkEdges",
    "serviceCalendars", "serviceCalendarDates", "transitRoutes", "transitTrips", "transitStopTimes", "transitFeedInfo"];
  const pack = { ...Object.fromEntries(arrays.map((key) => [key, []])),
    id: "base", version: "1", artifactKind: "production", url: "", minimumTableRows: {} };
  const baseFixture = { manifest: { activePack: { id: pack.id, version: pack.version } }, packs: [pack] };
  const molitObservation = await readJson(path.join(repositoryRoot, molitObservationPath));
  const mappings = parseCurrentMolitGwangjuStationMappings(
    molitObservation.normalizedProjection, molitAdmission.rawSha256, topologySnapshot,
    ledger.find((row) => row.sourceId === "molit-urban-rail-full-route" && row.snapshotId === molitAdmission.snapshotId),
  );
  const retained = createRetainedGwangjuTestInput({ baseFixture, topologySnapshot,
    inventory: structuredClone(inventory), canonicalStationMappings: mappings }).retainedTimetable;
  const candidate = candidates.candidates.find(({ id }) => id === "kric-nationwide-timetable-file");
  const observationPath = path.join(directory, "observation.json"), collectionReceiptPath = path.join(directory, "collection-receipt.json");
  const publicationReceiptPath = path.join(directory, "publication-receipt.json"), retainedContractPath = path.join(directory, "contract.json");
  const observationBytes = Buffer.from(`${JSON.stringify(retained.observation, null, 2)}\n`);
  const governanceEntry = governanceEntryFor(candidate, now);
  const providerValidUntil = capped ? new Date(now.valueOf() + 1000).toISOString() : null;
  const prepared = prepareRetainedKricTimetablePublication({ candidate, observationBytes, receipt: retained.receipt, routeNumber: retained.routeNumber,
    sourcePath: "observation.json", evaluationAt: now.toISOString(), providerValidUntil });
  const rawRetentionExpiresAt = deriveRawRetentionExpiresAt({ policy: { ...governance, sources: [...governance.sources, governanceEntry] }, sourceId: candidate.id, retrievedAt: retained.observation.observedAt });
  const publication = { schemaVersion: 1, artifactKind: "kric-retained-timetable-object-receipt", sourceId: candidate.id,
    snapshotId: `${candidate.id}-${prepared.source.observationIdentitySha256}`, observedAt: prepared.source.observedAt,
    acquisitionRawSha256: prepared.source.rawSha256, rawObjectSha256: prepared.observationSha256,
    collectionReceiptSha256: prepared.source.receiptSha256, observationIdentitySha256: prepared.source.observationIdentitySha256,
    recordsSha256: prepared.source.recordsSha256, rawObjectUri: `oci://axvym6vk8g7i/easysubway-datapacks/${prepared.plan.steps[0].objectKey}`,
    byteSize: observationBytes.length, storedAt: now.toISOString(), freshnessExpiresAt: prepared.freshnessExpiresAt, rawRetentionExpiresAt };
  const contract = { ...retained }; delete contract.observation; delete contract.receipt;
  await Promise.all([
    writeFile(observationPath, observationBytes), writeFile(collectionReceiptPath, `${JSON.stringify(retained.receipt, null, 2)}\n`),
    writeFile(publicationReceiptPath, `${JSON.stringify(publication, null, 2)}\n`), writeFile(retainedContractPath, `${JSON.stringify(contract, null, 2)}\n`),
  ]);
  const sourceInputPath = path.join(directory, "input.json");
  await writeFile(sourceInputPath, `${JSON.stringify({ schemaVersion: 1, artifactKind: "retained-kric-timetable-registration-input", observationPath,
    collectionReceiptPath, publicationReceiptPath, retainedContractPath, governanceEntry, providerValidUntil }, null, 2)}\n`);
  return { repositoryRoot, sourceInputPath, publicationReceiptPath, now, env,
    materializerInput: { baseFixture, retainedTimetable: retained, topologySnapshot, canonicalStationMappings: mappings },
    molitObservationPath };
}
function governanceEntryFor(candidate, now) {
  const terms = { type: candidate.evidence.license, provider: candidate.evidence.provider, evidenceUrl: candidate.evidence.licenseEvidenceUrl, redistributionAllowed: true };
  return { sourceId: candidate.id, sourceClassId: candidate.confirmationPolicy.id, retentionClassId: "standard-90d", ownerRole: "datapack-source-owner", stewardRole: "datapack-data-steward", approvalRole: "datapack-release-approver", escalationHours: 4, alertRoute: "github:area-datapack", licenseReview: { status: "APPROVED", termsHash: sha(canonicalJson(terms)),
    reviewedAt: new Date(now.valueOf() - 1000).toISOString(),
    nextReviewAt: new Date(now.valueOf() + 86400000).toISOString(),
    termsUrl: candidate.evidence.licenseEvidenceUrl, reviewedProvider: candidate.evidence.provider, reviewedDatasetUrl: candidate.detailUrl, redistributionScopes: ["DERIVED_DATAPACK"], approvedByRole: "datapack-release-approver" } };
}

async function replaceWithSuccessor(fixture) {
  const input = await readJson(fixture.sourceInputPath);
  const [observation, receipt, contract, candidates, governance] = await Promise.all([
    readJson(input.observationPath), readJson(input.collectionReceiptPath), readJson(input.retainedContractPath),
    readJson(path.join(fixture.repositoryRoot, "tools/datapack/source-candidates.json")),
    readJson(path.join(fixture.repositoryRoot, outputs[2])),
  ]);
  const observedAt = new Date(fixture.now.valueOf() - 86400000).toISOString();
  observation.observedAt = observedAt;
  observation.rawSha256 = "b".repeat(64);
  receipt.capturedAt = observedAt;
  receipt.sha256 = observation.rawSha256;
  const observationBytes = Buffer.from(`${JSON.stringify(observation, null, 2)}\n`);
  const candidate = candidates.candidates.find(({ id }) => id === "kric-nationwide-timetable-file");
  const prepared = prepareRetainedKricTimetablePublication({ candidate, observationBytes, receipt,
    routeNumber: contract.routeNumber, sourcePath: "observation.json", evaluationAt: fixture.now.toISOString(), providerValidUntil: null });
  const rawRetentionExpiresAt = deriveRawRetentionExpiresAt({ policy: governance, sourceId: candidate.id, retrievedAt: observedAt });
  const publication = { schemaVersion: 1, artifactKind: "kric-retained-timetable-object-receipt", sourceId: candidate.id,
    snapshotId: `${candidate.id}-${prepared.source.observationIdentitySha256}`, observedAt,
    acquisitionRawSha256: prepared.source.rawSha256, rawObjectSha256: prepared.observationSha256,
    collectionReceiptSha256: prepared.source.receiptSha256, observationIdentitySha256: prepared.source.observationIdentitySha256,
    recordsSha256: prepared.source.recordsSha256,
    rawObjectUri: `oci://axvym6vk8g7i/easysubway-datapacks/${prepared.plan.steps[0].objectKey}`,
    byteSize: observationBytes.length, storedAt: fixture.now.toISOString(), freshnessExpiresAt: prepared.freshnessExpiresAt, rawRetentionExpiresAt };
  await Promise.all([
    writeFile(input.observationPath, observationBytes),
    writeFile(input.collectionReceiptPath, `${JSON.stringify(receipt, null, 2)}\n`),
    writeFile(input.publicationReceiptPath, `${JSON.stringify(publication, null, 2)}\n`),
  ]);
}

// 실제 등록 이력에서 테스트 대상만 제외해 재구성한다. 다른 source가 추가돼도 날짜나 SHA를 갱신하지 않는다.
async function readJson(file) { return JSON.parse(await readFile(file, "utf8")); }
async function outputBytes(repositoryRoot) { return Promise.all(outputs.map((relative) => readFile(path.join(repositoryRoot, relative)))); }
