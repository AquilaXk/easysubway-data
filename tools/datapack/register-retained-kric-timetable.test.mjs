import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { parseMolitGwangjuStationMappings } from "./build-molit-nationwide-fixture.mjs";
import { buildAppendOnlyGovernancePolicyRegistration, deriveRawRetentionExpiresAt } from "./source-governance-policy.mjs";
import { prepareRetainedKricTimetablePublication } from "./prepare-retained-kric-timetable-publication.mjs";
import { projectHistoricalRegionalMaterializeInventory } from "./materialize-test-fixture.mjs";
import { canonicalJson } from "./lib/manifest-validation.mjs";
import { materializeGwangjuTimetable } from "./materialize-gwangju-timetable.mjs";
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
  assert.deepEqual(registered.map(({ relative }) => relative), outputs);
  assert.equal(new Set(registered[0].inputs.map(({ absolute }) => absolute)).size, registered[0].inputs.length);
  assert.throws(() => materializeGwangjuTimetable({
    ...fixture.materializerInput, inventory: JSON.parse(registered[0].bytes), now: fixture.now,
  }), /evidence is stale/);
  await assert.rejects(() => commitRetainedKricTimetableRegistrationOutputs({
    repositoryRoot: fixture.repositoryRoot, outputs: registered, failAfter: 1,
  }), /injected/);
  assert.deepEqual(await outputBytes(fixture.repositoryRoot), before);
  await commitRetainedKricTimetableRegistrationOutputs({ repositoryRoot: fixture.repositoryRoot, outputs: registered });
  assert.notDeepEqual(await outputBytes(fixture.repositoryRoot), before);
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

async function registrationFixture(context) {
  const directory = await mkdtemp(path.join(tmpdir(), "retained-kric-registration-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const repositoryRoot = path.join(directory, "repo");
  for (const relative of [...outputs, "tools/datapack/source-candidates.json", "tools/datapack/sources/gwangju-transportation-route-topology-20260720.json", "tools/datapack/sources/molit-urban-rail-full-route-20251211.csv"]) {
    const target = path.join(repositoryRoot, relative); await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, await readFile(path.join(root, relative)));
  }
  const [currentInventory, currentGovernance, candidates, topologySnapshot, mappingBytes] = await Promise.all([
    readJson(path.join(repositoryRoot, outputs[0])), readJson(path.join(repositoryRoot, outputs[2])),
    readJson(path.join(repositoryRoot, "tools/datapack/source-candidates.json")),
    readJson(path.join(repositoryRoot, "tools/datapack/sources/gwangju-transportation-route-topology-20260720.json")),
    readFile(path.join(repositoryRoot, "tools/datapack/sources/molit-urban-rail-full-route-20251211.csv")),
  ]);
  const inventory = projectHistoricalRegionalMaterializeInventory(currentInventory);
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
  const mappings = parseMolitGwangjuStationMappings(mappingBytes);
  const retained = createRetainedGwangjuTestInput({ baseFixture, topologySnapshot,
    inventory: structuredClone(inventory), canonicalStationMappings: mappings }).retainedTimetable;
  const candidate = candidates.candidates.find(({ id }) => id === "kric-nationwide-timetable-file");
  const observationPath = path.join(directory, "observation.json"), collectionReceiptPath = path.join(directory, "collection-receipt.json");
  const publicationReceiptPath = path.join(directory, "publication-receipt.json"), retainedContractPath = path.join(directory, "contract.json");
  const canonicalStationMappingsPath = path.join(repositoryRoot, "tools/datapack/sources/molit-urban-rail-full-route-20251211.csv");
  const observationBytes = Buffer.from(`${JSON.stringify(retained.observation, null, 2)}\n`);
  const governanceEntry = governanceEntryFor(candidate, now);
  const prepared = prepareRetainedKricTimetablePublication({ candidate, observationBytes, receipt: retained.receipt, routeNumber: retained.routeNumber,
    sourcePath: "observation.json", evaluationAt: now.toISOString(), providerValidUntil: null });
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
    collectionReceiptPath, publicationReceiptPath, retainedContractPath, canonicalStationMappingsPath, governanceEntry, providerValidUntil: null }, null, 2)}\n`);
  return { repositoryRoot, sourceInputPath, publicationReceiptPath, now, env,
    materializerInput: { baseFixture, retainedTimetable: retained, topologySnapshot, canonicalStationMappings: mappings } };
}
function governanceEntryFor(candidate, now) {
  const terms = { type: candidate.evidence.license, provider: candidate.evidence.provider, evidenceUrl: candidate.evidence.licenseEvidenceUrl, redistributionAllowed: true };
  return { sourceId: candidate.id, sourceClassId: candidate.confirmationPolicy.id, retentionClassId: "standard-90d", ownerRole: "datapack-source-owner", stewardRole: "datapack-data-steward", approvalRole: "datapack-release-approver", escalationHours: 4, alertRoute: "github:area-datapack", licenseReview: { status: "APPROVED", termsHash: sha(canonicalJson(terms)),
    reviewedAt: new Date(now.valueOf() - 1000).toISOString(),
    nextReviewAt: new Date(now.valueOf() + 86400000).toISOString(),
    termsUrl: candidate.evidence.licenseEvidenceUrl, reviewedProvider: candidate.evidence.provider, reviewedDatasetUrl: candidate.detailUrl, redistributionScopes: ["DERIVED_DATAPACK"], approvedByRole: "datapack-release-approver" } };
}

// 실제 등록 이력에서 테스트 대상만 제외해 재구성한다. 다른 source가 추가돼도 날짜나 SHA를 갱신하지 않는다.
function governanceBeforeSource(current, sourceId) {
  const batches = [];
  let policy = structuredClone(current);
  while (policy.sources.some(row => row.sourceId === sourceId)) {
    const lineage = policy.registrationLineage;
    assert.ok(lineage, "test source must belong to append-only registration lineage");
    const additions = policy.sources.filter(row => lineage.addedSourceIds.includes(row.sourceId));
    batches.unshift(additions.filter(row => row.sourceId !== sourceId));
    const predecessor = { ...policy, sources: policy.sources.filter(row => !lineage.addedSourceIds.includes(row.sourceId)) };
    if (lineage.predecessorLineage === null) delete predecessor.registrationLineage;
    else predecessor.registrationLineage = lineage.predecessorLineage;
    const bytes = lineage.predecessorPolicyText === null
      ? Buffer.from(`${JSON.stringify(predecessor, null, 2)}\n`) : Buffer.from(lineage.predecessorPolicyText);
    assert.equal(sha(bytes), lineage.predecessorPolicySha256);
    policy = JSON.parse(bytes);
  }
  for (const addedSources of batches.filter(rows => rows.length > 0)) {
    policy = buildAppendOnlyGovernancePolicyRegistration({
      predecessorPolicyBytes: Buffer.from(`${JSON.stringify(policy, null, 2)}\n`), addedSources,
    }).policy;
  }
  return policy;
}
async function readJson(file) { return JSON.parse(await readFile(file, "utf8")); }
async function outputBytes(repositoryRoot) { return Promise.all(outputs.map((relative) => readFile(path.join(repositoryRoot, relative)))); }
