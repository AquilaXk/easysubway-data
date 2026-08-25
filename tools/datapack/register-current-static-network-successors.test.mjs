import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildPublicStaticNetworkV2SuccessorOutputs, commitStaticNetworkSuccessorOutputs, registerPublicStaticNetworkV2Successors } from "./register-current-static-network-successors.mjs";
import { buildPublicStaticNetworkV2Observations } from "./build-public-static-network-v2-observations.mjs";
import { parseSeoulRouteMapPositionsCsv } from "./collect-seoul-route-map-positions.mjs";
import { deriveRawRetentionExpiresAt } from "./source-governance-policy.mjs";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const INPUT_PATHS = [
  "tools/datapack/source-inventory.json", "tools/datapack/release/source-snapshots.json", "tools/datapack/release/candidate-build-spec.json",
  "tools/datapack/release/release-request.json", "tools/datapack/release/hash-evidence.json", "tools/datapack/source-governance-policy.json",
  "release/product-gates/datapack-freshness-sla.json", "tools/datapack/sources/capital-route-topology-20260814.json",
];

async function registrationOutputs(root) {
  const output = (relative, before, after) => ({ relative, prestateBytes: before, bytes: after });
  const inputs = await Promise.all(INPUT_PATHS.map(async (relative) => ({ relative, bytes: await readFile(path.join(root, relative)) })));
  const outputs = [
    output("tools/datapack/sources/seoul-metro-route-map-positions-current-20260822T000000000Z.json", null, Buffer.from("positions\n")),
    output("tools/datapack/sources/molit-urban-rail-full-route-current-20260822T000000000Z.json", null, Buffer.from("molit\n")),
    output("tools/datapack/source-inventory.json", inputs[0].bytes, Buffer.from("inventory\n")),
    output("tools/datapack/release/source-snapshots.json", inputs[1].bytes, Buffer.from("ledger\n")),
    output("tools/datapack/release/candidate-build-spec.json", inputs[2].bytes, Buffer.from("candidate\n")),
  ];
  return outputs.map((entry) => ({ ...entry, inputs }));
}

async function publicV2Input(root, capturedAt = "2026-08-24T12:00:00.000Z") {
  const [sourceInventory, admittedTopologyBytes, positionCsv, molitRawBytes, governance] = await Promise.all([
    readFile(path.join(root, "tools/datapack/source-inventory.json"), "utf8").then(JSON.parse),
    readFile(path.join(root, "tools/datapack/sources/capital-route-topology-20260823.json")),
    readFile(path.join(root, "tools/datapack/fixtures/seoul-route-map-positions-raw/data-go-15099316.csv")),
    readFile(path.join(root, "tools/datapack/sources/molit-urban-rail-full-route-20251211.csv")),
    readFile(path.join(root, "tools/datapack/source-governance-policy.json"), "utf8").then(JSON.parse),
  ]);
  const rows = parseSeoulRouteMapPositionsCsv(positionCsv).rawPositions.map(({ line, stationCode, stationName, latitude, longitude, basisDate }, index) => ({ "연번": `${index + 1}`, "호선": line, "고유역번호(외부역코드)": stationCode, "역명": stationName, "위도": `${latitude}`, "경도": `${longitude}`, "작성기준일": basisDate, "작성일자": basisDate }));
  const positionRawBytes = Buffer.from(JSON.stringify({ currentCount: rows.length, data: rows, matchCount: rows.length, page: 1, perPage: 1000, totalCount: rows.length }));
  const receipt = (sourceId, rawBytes, extension, contentType) => { const rawSha256 = sha(rawBytes); const stamp = capturedAt.replaceAll(/[-:.]/gu, ""); const date = capturedAt.slice(0, 10).replaceAll("-", ""); const objectKey = `source-raw/${sourceId}/${date}/${rawSha256}.${extension}`; return { schemaVersion: 1, artifactKind: "static-network-source-raw-object-receipt", sourceId, snapshotId: `${sourceId}-current-${stamp}`, capturedAt, rawObjectSha256: rawSha256, rawObjectUri: `oci://axvym6vk8g7i/easysubway-datapacks/${objectKey}`, ociNamespace: "axvym6vk8g7i", bucket: "easysubway-datapacks", objectKey, contentType, byteSize: rawBytes.length, storedAt: capturedAt, rawRetentionExpiresAt: deriveRawRetentionExpiresAt({ policy: governance, sourceId, retrievedAt: capturedAt }) }; };
  const producerOutput = buildPublicStaticNetworkV2Observations({ positionRawBytes, molitRawBytes, capturedAt, sourceInventory, admittedTopologyBytes, admittedTopologyId: "capital-route-topology-20260823", positionReceipt: receipt("seoul-metro-route-map-positions", positionRawBytes, "json", "application/json"), molitReceipt: receipt("molit-urban-rail-full-route", molitRawBytes, "csv", "text/csv; charset=euc-kr") });
  return { producerOutput, rawBytesBySource: { "seoul-metro-route-map-positions": positionRawBytes, "molit-urban-rail-full-route": molitRawBytes }, now: new Date(capturedAt) };
}

async function activatePublicV2Predecessors(root) {
  const inventoryPath = path.join(root, "tools/datapack/source-inventory.json");
  const ledgerPath = path.join(root, "tools/datapack/release/source-snapshots.json");
  const inventory = JSON.parse(await readFile(inventoryPath, "utf8"));
  const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
  for (const sourceId of ["seoul-metro-route-map-positions", "molit-urban-rail-full-route"]) {
    const source = inventory.sources.find(({ id }) => id === sourceId);
    const snapshot = ledger.find(({ snapshotId }) => snapshotId === source.admissionEvidence.snapshotId);
    assert.ok(source); assert.ok(snapshot);
    const observation = {
      schemaVersion: 2, artifactKind: "public-static-network-v2-observation", sourceId,
      snapshotId: snapshot.snapshotId, capturedAt: snapshot.retrievedAt, rawSha256: snapshot.rawSha256,
      contentSha256: snapshot.contentSha256, rowCount: snapshot.rowCount,
      routeMapLayoutEvidence: snapshot.routeMapLayoutEvidence,
      routeMapLayoutArtifact: snapshot.routeMapLayoutArtifact,
    };
    if (sourceId === "molit-urban-rail-full-route") {
      delete observation.routeMapLayoutEvidence;
      delete observation.routeMapLayoutArtifact;
    }
    snapshot.publicStaticNetworkV2Observation = observation;
    snapshot.normalizedObservationSha256 = sha(Buffer.from(`${JSON.stringify(observation)}\n`));
    delete snapshot.projectionMigration;
    delete snapshot.historicalPredecessorAudit;
    if (sourceId === "seoul-metro-route-map-positions") {
      source.routeMapAdmissionEvidence.currentTopologyAdmission.positionSnapshotSha256 = snapshot.normalizedObservationSha256;
      source.routeMapAdmissionEvidence.currentLayoutAdmission = {
        schemaVersion: 2, artifactKind: "seoul-public-route-map-layout-admission", status: "ADMITTED",
        positionSnapshotId: snapshot.snapshotId,
        snapshotPath: `tools/datapack/sources/${snapshot.snapshotId}.json`,
        snapshotSha256: snapshot.normalizedObservationSha256, rawSha256: snapshot.rawSha256,
        contentSha256: snapshot.contentSha256, ...snapshot.routeMapLayoutEvidence,
      };
    }
  }
  await writeFile(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`);
  await writeFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
}

test("v2 registrar stages and commits exactly five outputs while preserving release approval bytes", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "static-network-v2-registrar-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(repositoryRoot, root, { recursive: true, filter: (source) => !source.includes("node_modules") });
  const inventoryPath = path.join(root, "tools/datapack/source-inventory.json"); const inventory = JSON.parse(await readFile(inventoryPath, "utf8"));
  for (const source of inventory.sources) delete source.membershipAdmissionEvidence;
  await writeFile(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`);
  const request = await readFile(path.join(root, "tools/datapack/release/release-request.json")); const hashes = await readFile(path.join(root, "tools/datapack/release/hash-evidence.json"));
  const historicalInput = await publicV2Input(root);
  await assert.rejects(buildPublicStaticNetworkV2SuccessorOutputs({ repositoryRoot: root, ...historicalInput }), /public v2 active predecessor is required/);
  await activatePublicV2Predecessors(root);
  const input = await publicV2Input(root); const staged = await buildPublicStaticNetworkV2SuccessorOutputs({ repositoryRoot: root, ...input });
  assert.equal(staged.length, 5); assert.deepEqual(staged.map(({ relative }) => relative).slice(2), ["tools/datapack/source-inventory.json", "tools/datapack/release/source-snapshots.json", "tools/datapack/release/candidate-build-spec.json"]);
  const stagedInventory = JSON.parse(staged[2].bytes);
  for (const sourceId of ["seoul-metro-route-map-positions", "molit-urban-rail-full-route"]) {
    const source = stagedInventory.sources.find(({ id }) => id === sourceId);
    assert.equal(source.requiredForProductionPack, true);
    assert.equal(source.productionUseAllowed, true);
  }
  const ledger = JSON.parse(staged[3].bytes);
  const positionSnapshot = ledger.find(({ snapshotId }) => snapshotId === input.producerOutput.observations[0].snapshotId);
  assert.equal(typeof positionSnapshot.previousSnapshotId, "string");
  assert.notEqual(positionSnapshot.diffSummary, null);
  assert.equal(positionSnapshot.rootSupersession, undefined);
  assert.equal(positionSnapshot.projectionMigration, undefined);
  const molitSnapshot = ledger.find(({ snapshotId }) => snapshotId === input.producerOutput.observations[1].snapshotId);
  assert.equal(typeof molitSnapshot.previousSnapshotId, "string");
  assert.equal(ledger.find(({ snapshotId }) => snapshotId === molitSnapshot.previousSnapshotId).sourceId, "molit-urban-rail-full-route");
  assert.equal(molitSnapshot.rootSupersession, undefined);
  for (const snapshot of [positionSnapshot, molitSnapshot]) {
    assert.equal(snapshot.schemaVersion, 1);
    assert.equal(snapshot.artifactKind, "official-source-snapshot");
    assert.equal(snapshot.snapshotStatus, "LOCKED");
    assert.equal(snapshot.schemaStatus, "PASS");
    assert.equal(snapshot.licenseStatus, "PASS");
    assert.equal(snapshot.fetchStatus, "SUCCESS");
    assert.equal(snapshot.redistributionAllowed, true);
    assert.equal(snapshot.credentialRedacted, true);
    assert.match(snapshot.governancePolicySha256, /^[a-f0-9]{64}$/u);
  }
  const result = await registerPublicStaticNetworkV2Successors({ repositoryRoot: root, ...input });
  assert.equal(result.outputs.length, 5); assert.deepEqual(await readFile(path.join(root, "tools/datapack/release/release-request.json")), request); assert.deepEqual(await readFile(path.join(root, "tools/datapack/release/hash-evidence.json")), hashes);
  const nextInput = await publicV2Input(root, "2026-08-24T12:30:00.000Z");
  const nextLedger = JSON.parse((await buildPublicStaticNetworkV2SuccessorOutputs({ repositoryRoot: root, ...nextInput }))
    .find(({ relative }) => relative === "tools/datapack/release/source-snapshots.json").bytes);
  const nextPosition = nextLedger.find(({ snapshotId }) => snapshotId === nextInput.producerOutput.observations[0].snapshotId);
  assert.equal(nextPosition.previousSnapshotId, positionSnapshot.snapshotId);
  assert.notEqual(nextPosition.diffSummary, null);
  assert.equal(nextPosition.rootSupersession, undefined);
});

test("v2 registrar rejects forged producer observations and stale or mismatched topology CAS inputs", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "static-network-v2-registrar-invariants-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(repositoryRoot, root, { recursive: true, filter: (source) => !source.includes("node_modules") });
  const inventoryPath = path.join(root, "tools/datapack/source-inventory.json");
  const baselineInventory = JSON.parse(await readFile(inventoryPath, "utf8"));
  for (const source of baselineInventory.sources) delete source.membershipAdmissionEvidence;
  await writeFile(inventoryPath, `${JSON.stringify(baselineInventory, null, 2)}\n`);
  const input = await publicV2Input(root);

  const forged = { ...input, producerOutput: structuredClone(input.producerOutput) };
  forged.producerOutput.observations[1].contentSha256 = "0".repeat(64);
  await assert.rejects(buildPublicStaticNetworkV2SuccessorOutputs({ repositoryRoot: root, ...forged }), /public v2 producer output is invalid/);

  const foreignReceipt = { ...input, producerOutput: structuredClone(input.producerOutput) };
  foreignReceipt.producerOutput.observations[1].rawReceipt.ociNamespace = "foreign-namespace";
  await assert.rejects(buildPublicStaticNetworkV2SuccessorOutputs({ repositoryRoot: root, ...foreignReceipt }), /public v2 observation binding is invalid/);

  const mismatchedInventory = JSON.parse(await readFile(inventoryPath, "utf8"));
  mismatchedInventory.sources.find(({ id }) => id === "seoul-metro-route-map-positions")
    .routeMapAdmissionEvidence.currentTopologyAdmission.topologyContentSha256 = "0".repeat(64);
  await writeFile(inventoryPath, `${JSON.stringify(mismatchedInventory, null, 2)}\n`);
  await assert.rejects(buildPublicStaticNetworkV2SuccessorOutputs({ repositoryRoot: root, ...input }), /static network topology identity is invalid/);

  const staleInventory = structuredClone(baselineInventory);
  await writeFile(inventoryPath, `${JSON.stringify(staleInventory, null, 2)}\n`);
  await assert.rejects(buildPublicStaticNetworkV2SuccessorOutputs({ repositoryRoot: root, ...input, now: new Date("2026-08-25T00:00:00.000Z") }), /topology admission snapshot is stale or future-dated/);
});

test("v2 registrar rejects every historical predecessor instead of resetting it", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "static-network-v2-legacy-reset-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(repositoryRoot, root, { recursive: true, filter: (source) => !source.includes("node_modules") });
  const inventoryPath = path.join(root, "tools/datapack/source-inventory.json");
  const inventory = JSON.parse(await readFile(inventoryPath, "utf8"));
  for (const source of inventory.sources) delete source.membershipAdmissionEvidence;
  await writeFile(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`);
  const input = await publicV2Input(root);

  await assert.rejects(
    buildPublicStaticNetworkV2SuccessorOutputs({ repositoryRoot: root, ...input }),
    /public v2 active predecessor is required/,
  );
  const candidatePath = path.join(root, "tools/datapack/release/candidate-build-spec.json");
  const candidate = JSON.parse(await readFile(candidatePath, "utf8"));
  candidate.sourceSnapshots[0].sourceId = "seoulmetro-cyberstation-route-map";
  await writeFile(candidatePath, `${JSON.stringify(candidate, null, 2)}\n`);
  await assert.rejects(
    buildPublicStaticNetworkV2SuccessorOutputs({ repositoryRoot: root, ...input }),
    /public v2 candidate source set is invalid/,
  );
});

async function leasePort(t) {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, resolve); });
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address(); assert.ok(address && typeof address !== "string"); return address.port;
}
async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, resolve); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

test("registrar commits only the exact five source-output allowlist and rolls back an interrupted write", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "static-network-registrar-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(path.resolve(import.meta.dirname, "../.."), root, { recursive: true, filter: (source) => !source.includes("node_modules") });
  const before = await readFile(path.join(root, "tools/datapack/source-inventory.json"));
  const approvedRequest = await readFile(path.join(root, "tools/datapack/release/release-request.json"));
  const approvedHashes = await readFile(path.join(root, "tools/datapack/release/hash-evidence.json"));
  const outputs = await registrationOutputs(root);
  await assert.rejects(commitStaticNetworkSuccessorOutputs({ repositoryRoot: root, outputs, failAfter: 2 }), /injected transaction failure/);
  assert.equal(await readFile(path.join(root, "tools/datapack/source-inventory.json"), "utf8"), before.toString("utf8"));
  await commitStaticNetworkSuccessorOutputs({ repositoryRoot: root, outputs });
  assert.equal(sha(await readFile(path.join(root, outputs[0].relative))), sha(outputs[0].bytes));
  assert.deepEqual(await readFile(path.join(root, "tools/datapack/release/release-request.json")), approvedRequest);
  assert.deepEqual(await readFile(path.join(root, "tools/datapack/release/hash-evidence.json")), approvedHashes);
});

test("registrar rejects a recovery journal whose five records are not the exact output allowlist", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "static-network-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(path.resolve(import.meta.dirname, "../.."), root, { recursive: true, filter: (source) => !source.includes("node_modules") });
  const before = await readFile(path.join(root, "tools/datapack/source-inventory.json"));
  const record = { relative: "tools/datapack/source-inventory.json", before: before.toString("base64"), after: before.toString("base64"), beforeSha256: sha(before), afterSha256: sha(before) };
  await writeFile(path.join(root, "tools/datapack/.static-network-successors-transaction.json"), JSON.stringify({ state: "PREPARED", records: Array.from({ length: 7 }, () => record) }));
  const outputs = await registrationOutputs(root);
  await assert.rejects(commitStaticNetworkSuccessorOutputs({ repositoryRoot: root, outputs }), /recovery required/);
});

test("registrar rejects derivation input drift before staging any output", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "static-network-input-cas-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(path.resolve(import.meta.dirname, "../.."), root, { recursive: true, filter: (source) => !source.includes("node_modules") });
  const outputs = await registrationOutputs(root);
  await writeFile(path.join(root, "tools/datapack/source-governance-policy.json"), "foreign input\n");
  await assert.rejects(commitStaticNetworkSuccessorOutputs({ repositoryRoot: root, outputs }), /preserves foreign replacement/);
  await assert.rejects(readFile(path.join(root, outputs[0].relative)), /ENOENT/);
});

test("register API acquires the active owner lease before validating observations or reading inputs", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "static-network-lock-first-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(path.resolve(import.meta.dirname, "../.."), root, { recursive: true, filter: (source) => !source.includes("node_modules") });
  const port = await leasePort(t);
  await writeFile(path.join(root, "tools/datapack/.static-network-successors.lock"), `${JSON.stringify({ schemaVersion: 1, host: "127.0.0.1", port, pid: process.pid, token: "00000000-0000-4000-8000-000000000000" }, null, 2)}\n`);
  await assert.rejects(registerPublicStaticNetworkV2Successors({ repositoryRoot: root, producerOutput: null, rawBytesBySource: {} }), /lock residue exists/);
});

test("registrar does not overwrite a foreign lock replacement after exclusively reclaiming a stale lease", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "static-network-lock-reclaim-race-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(path.resolve(import.meta.dirname, "../.."), root, { recursive: true, filter: (source) => !source.includes("node_modules") });
  const lock = path.join(root, "tools/datapack/.static-network-successors.lock");
  const stalePort = await freePort();
  const stale = `${JSON.stringify({ schemaVersion: 1, host: "127.0.0.1", port: stalePort, pid: 99999999, token: "00000000-0000-4000-8000-000000000000" })}\n`;
  await writeFile(lock, stale);
  const outputs = await registrationOutputs(root);
  const foreign = Buffer.from("foreign lock replacement\n");
  await assert.rejects(commitStaticNetworkSuccessorOutputs({
    repositoryRoot: root,
    outputs,
    afterStaleLockRead: async () => writeFile(lock, foreign),
  }), /lock residue exists/);
  assert.deepEqual(await readFile(lock), foreign);
});

test("registrar preserves a foreign fixed-output replacement that races the final publish", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "static-network-output-race-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(path.resolve(import.meta.dirname, "../.."), root, { recursive: true, filter: (source) => !source.includes("node_modules") });
  const outputs = await registrationOutputs(root);
  const fixed = path.join(root, "tools/datapack/source-inventory.json");
  const foreign = Buffer.from("foreign replacement\n");
  await assert.rejects(commitStaticNetworkSuccessorOutputs({
    repositoryRoot: root,
    outputs,
    beforeExistingPublish: async ({ file }) => {
      if (file === fixed) await writeFile(file, foreign, { flag: "wx" });
    },
  }), /preserves foreign replacement/);
  assert.deepEqual(await readFile(fixed), foreign);
});

test("registrar recovers a deterministic displaced fixed output after an interrupted publish", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "static-network-output-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(path.resolve(import.meta.dirname, "../.."), root, { recursive: true, filter: (source) => !source.includes("node_modules") });
  const outputs = await registrationOutputs(root);
  const records = outputs.map(({ relative, prestateBytes: before, bytes: after }) => ({ relative, before: before?.toString("base64") ?? null, after: after.toString("base64"), beforeSha256: before == null ? null : sha(before), afterSha256: sha(after) }));
  await writeFile(path.join(root, "tools/datapack/.static-network-successors-transaction.json"), JSON.stringify({ state: "PREPARED", records }));
  const fixed = path.join(root, "tools/datapack/source-inventory.json");
  const displaced = path.join(root, "tools/datapack/.source-inventory.json.static-network-successors.before");
  const retired = path.join(root, "tools/datapack/sources/.seoul-metro-route-map-positions-current-20260822T000000000Z.json.static-network-successors.retired");
  await rename(fixed, displaced);
  await writeFile(retired, outputs[0].bytes);
  await commitStaticNetworkSuccessorOutputs({ repositoryRoot: root, outputs });
  assert.deepEqual(await readFile(fixed), outputs[2].bytes);
  await assert.rejects(readFile(displaced), /ENOENT/);
  await assert.rejects(readFile(retired), /ENOENT/);
});

test("registrar commits an exact canonical COMMITTED journal and its displaced PREPARED predecessor together", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "static-network-journal-transition-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(path.resolve(import.meta.dirname, "../.."), root, { recursive: true, filter: (source) => !source.includes("node_modules") });
  const outputs = await registrationOutputs(root);
  const records = outputs.map(({ relative, prestateBytes: before, bytes: after }) => ({ relative, before: before?.toString("base64") ?? null, after: after.toString("base64"), beforeSha256: before == null ? null : sha(before), afterSha256: sha(after) }));
  for (const { relative, bytes } of outputs) await writeFile(path.join(root, relative), bytes);
  const journal = path.join(root, "tools/datapack/.static-network-successors-transaction.json");
  const displaced = path.join(root, "tools/datapack/..static-network-successors-transaction.json.static-network-successors.before");
  await writeFile(journal, JSON.stringify({ state: "COMMITTED", records }));
  await writeFile(displaced, JSON.stringify({ state: "PREPARED", records }));
  await assert.rejects(commitStaticNetworkSuccessorOutputs({ repositoryRoot: root, outputs }), /preserves foreign replacement/);
  await assert.rejects(readFile(journal), /ENOENT/);
  await assert.rejects(readFile(displaced), /ENOENT/);
  assert.deepEqual(await readFile(path.join(root, outputs[2].relative)), outputs[2].bytes);
});

test("registrar resumes predecessor cleanup before consuming its canonical COMMITTED journal", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "static-network-journal-cleanup-resume-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(path.resolve(import.meta.dirname, "../.."), root, { recursive: true, filter: (source) => !source.includes("node_modules") });
  const outputs = await registrationOutputs(root);
  const records = outputs.map(({ relative, prestateBytes: before, bytes: after }) => ({ relative, before: before?.toString("base64") ?? null, after: after.toString("base64"), beforeSha256: before == null ? null : sha(before), afterSha256: sha(after) }));
  for (const { relative, bytes } of outputs) await writeFile(path.join(root, relative), bytes);
  const journal = path.join(root, "tools/datapack/.static-network-successors-transaction.json");
  const cleanup = path.join(root, "tools/datapack/...static-network-successors-transaction.json.static-network-successors.before.static-network-successors.retired");
  await writeFile(journal, JSON.stringify({ state: "COMMITTED", records }));
  await writeFile(cleanup, JSON.stringify({ state: "PREPARED", records }));
  await assert.rejects(commitStaticNetworkSuccessorOutputs({ repositoryRoot: root, outputs }), /preserves foreign replacement/);
  await assert.rejects(readFile(journal), /ENOENT/);
  await assert.rejects(readFile(cleanup), /ENOENT/);
  assert.deepEqual(await readFile(path.join(root, outputs[2].relative)), outputs[2].bytes);
});

test("registrar recovers the actual journal transition state after COMMITTED publish cleanup fails", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "static-network-journal-publish-failure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(path.resolve(import.meta.dirname, "../.."), root, { recursive: true, filter: (source) => !source.includes("node_modules") });
  const outputs = await registrationOutputs(root);
  const journal = path.join(root, "tools/datapack/.static-network-successors-transaction.json");
  const displaced = path.join(root, "tools/datapack/..static-network-successors-transaction.json.static-network-successors.before");
  await assert.rejects(commitStaticNetworkSuccessorOutputs({
    repositoryRoot: root,
    outputs,
    afterExistingPublish: async ({ file, value }) => {
      if (file === journal && JSON.parse(value).state === "COMMITTED") throw new Error("injected journal cleanup failure");
    },
  }), /injected journal cleanup failure/);
  await assert.rejects(readFile(journal), /ENOENT/);
  await assert.rejects(readFile(displaced), /ENOENT/);
  for (const { relative, bytes } of outputs) assert.deepEqual(await readFile(path.join(root, relative)), bytes);
});

test("registrar fails closed before acquiring when a prior lock displacement remains", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "static-network-lock-residue-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(path.resolve(import.meta.dirname, "../.."), root, { recursive: true, filter: (source) => !source.includes("node_modules") });
  await writeFile(path.join(root, "tools/datapack/..static-network-successors.lock.static-network-successors.before"), "orphaned lock\n");
  await assert.rejects(commitStaticNetworkSuccessorOutputs({ repositoryRoot: root, outputs: await registrationOutputs(root) }), /lock residue exists/);
});
