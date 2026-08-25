import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildPublicStaticNetworkV2SuccessorOutputs, buildStaticNetworkSuccessorOutputs, commitStaticNetworkSuccessorOutputs, registerCurrentStaticNetworkSuccessors, registerPublicStaticNetworkV2Successors } from "./register-current-static-network-successors.mjs";
import { collectCurrentStaticNetworkSuccessors, MOLIT_URL, SEOUL_POSITIONS_URL } from "./collect-current-static-network-successors.mjs";
import { buildPublicStaticNetworkV2Observations } from "./build-public-static-network-v2-observations.mjs";
import { runCurrentStaticNetworkSuccessors } from "./run-current-static-network-successors.mjs";
import { parseSeoulRouteMapPositionsCsv } from "./collect-seoul-route-map-positions.mjs";
import { deriveRawRetentionExpiresAt } from "./source-governance-policy.mjs";
import { releaseRequestBindingViolations } from "./verify-release-request-binding.mjs";
import { currentTopologyAdmissionClock } from "./test-fixtures/current-topology-admission-clock.mjs";
import {
  copySyntheticCurrentPublicRouteMapRepository,
  createStaticNetworkRegistrarPredecessorFixture,
} from "./test-fixtures/current-public-route-map-successor.mjs";

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

test("v2 registrar stages and commits exactly five outputs while preserving release approval bytes", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "static-network-v2-registrar-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(repositoryRoot, root, { recursive: true, filter: (source) => !source.includes("node_modules") });
  const inventoryPath = path.join(root, "tools/datapack/source-inventory.json"); const inventory = JSON.parse(await readFile(inventoryPath, "utf8"));
  for (const source of inventory.sources) delete source.membershipAdmissionEvidence;
  await writeFile(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`);
  const request = await readFile(path.join(root, "tools/datapack/release/release-request.json")); const hashes = await readFile(path.join(root, "tools/datapack/release/hash-evidence.json"));
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
  const supersededPosition = ledger.find(({ snapshotId }) => snapshotId === positionSnapshot.rootSupersession.supersededHeadSnapshotId);
  assert.equal(positionSnapshot.previousSnapshotId, null);
  assert.equal(positionSnapshot.diffSummary, null);
  assert.deepEqual(positionSnapshot.rootSupersession, {
    schemaVersion: 1, artifactKind: "source-root-supersession", sourceId: "seoul-metro-route-map-positions",
    supersededHeadSnapshotId: supersededPosition.snapshotId, supersededHeadRawSha256: supersededPosition.rawSha256,
    supersededHeadSchemaFingerprint: supersededPosition.schemaFingerprint, reasonCode: "CANONICAL_SOURCE_CONTRACT_RESET",
  });
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

test("v2 registrar resets only the approved legacy-v1 public positions head", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "static-network-v2-legacy-reset-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(repositoryRoot, root, { recursive: true, filter: (source) => !source.includes("node_modules") });
  const inventoryPath = path.join(root, "tools/datapack/source-inventory.json");
  const inventory = JSON.parse(await readFile(inventoryPath, "utf8"));
  for (const source of inventory.sources) delete source.membershipAdmissionEvidence;
  await writeFile(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`);
  const input = await publicV2Input(root);

  const ledgerPath = path.join(root, "tools/datapack/release/source-snapshots.json");
  const baseline = JSON.parse(await readFile(ledgerPath, "utf8"));
  const corruptions = [
    (previous) => { previous.projectionMigration = { ...previous.projectionMigration, candidateSlotSourceId: "wrong-current-slot" }; },
    (previous) => { previous.snapshotStatus = "REJECTED"; },
    (previous) => { previous.fetchStatus = "FAIL"; },
    (previous) => { previous.rawReceipt.storedAt = "2026-08-24T11:48:22.984Z"; },
  ];
  for (const corrupt of corruptions) {
    const ledger = structuredClone(baseline);
    corrupt(ledger.find(({ sourceId }) => sourceId === "seoul-metro-route-map-positions"));
    await writeFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
    await assert.rejects(
      buildPublicStaticNetworkV2SuccessorOutputs({ repositoryRoot: root, ...input }),
      /legacy v1 public positions predecessor is invalid/,
    );
  }
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

async function receiptFor(input, operationRoot, now) {
  const extension = input.sourceId === "seoul-metro-route-map-positions" ? "json" : "csv";
  const rawRelativePath = input.sourceId === "seoul-metro-route-map-positions" ? "positions.raw.json" : "molit.raw.csv";
  const rawBytes = await readFile(path.join(operationRoot, rawRelativePath)); const rawSha256 = sha(rawBytes);
  const date = input.capturedAt.slice(0, 10).replaceAll("-", ""); const objectKey = `source-raw/${input.sourceId}/${date}/${rawSha256}.${extension}`;
  const policy = JSON.parse(await readFile(path.join(repositoryRoot, "tools/datapack/source-governance-policy.json"), "utf8"));
  return { schemaVersion: 1, artifactKind: "static-network-source-raw-object-receipt", sourceId: input.sourceId, snapshotId: input.snapshotId, capturedAt: input.capturedAt,
    rawObjectUri: `oci://axvym6vk8g7i/easysubway-datapacks/${objectKey}`, rawObjectSha256: rawSha256, byteSize: rawBytes.length, storedAt: now.toISOString(),
    rawRetentionExpiresAt: deriveRawRetentionExpiresAt({ policy, sourceId: input.sourceId, retrievedAt: input.capturedAt }), ociNamespace: "axvym6vk8g7i", bucket: "easysubway-datapacks", objectKey,
    contentType: extension === "json" ? "application/json" : "text/csv; charset=euc-kr" };
}
async function registrarPredecessorFixture(t, now) {
  const root = await mkdtemp(path.join(os.tmpdir(), "static-network-registrar-predecessor-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await createStaticNetworkRegistrarPredecessorFixture(repositoryRoot, root, { now });
  return root;
}
function cloneObservations(observations) { return observations.map(({ snapshot, receipt, bytes, rawBytes }) => ({ snapshot: structuredClone(snapshot), receipt: structuredClone(receipt), bytes: Buffer.from(bytes), rawBytes: Buffer.from(rawBytes) })); }
function replaceMigration(observations, sourceId, patch) { const entry = observations.find(({ snapshot }) => snapshot.sourceId === sourceId); entry.snapshot.projectionMigration = { ...entry.snapshot.projectionMigration, ...patch }; const normalized = JSON.parse(entry.bytes); normalized.migration = { ...normalized.migration, ...patch }; entry.bytes = Buffer.from(`${JSON.stringify(normalized)}\n`); entry.snapshot.normalizedObservationSha256 = sha(entry.bytes); }
function swapDaejeonMembershipSequences(rawBytes) {
  const value = Buffer.from(rawBytes); const lines = value.toString("binary").split("\n"); let offset = 0; const targets = [];
  for (const line of lines) {
    const bytes = Buffer.from(line, "binary"); const decoded = new TextDecoder("euc-kr").decode(bytes);
    if (decoded.includes("대전,대전교통공사,1호선,")) {
      const comma = bytes.lastIndexOf(0x2c); const sequenceOffset = comma - 1;
      if (bytes[sequenceOffset] === 0x31 || bytes[sequenceOffset] === 0x32) targets.push(offset + sequenceOffset);
    }
    offset += bytes.length + 1;
  }
  assert.equal(targets.length >= 2, true);
  const first = targets.find((index) => value[index] === 0x31); const second = targets.find((index) => value[index] === 0x32);
  assert.notEqual(first, undefined); assert.notEqual(second, undefined);
  value[first] = 0x32; value[second] = 0x31; return value;
}

test("registrar fixture reconstructs the canonical legacy predecessor slot from a current public successor", async (t) => {
  const source = await mkdtemp(path.join(os.tmpdir(), "static-network-registrar-current-public-"));
  const root = await mkdtemp(path.join(os.tmpdir(), "static-network-registrar-predecessor-"));
  t.after(() => rm(source, { recursive: true, force: true }));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { inWindow: now } = await currentTopologyAdmissionClock(repositoryRoot);
  await copySyntheticCurrentPublicRouteMapRepository(repositoryRoot, source, { now });
  await createStaticNetworkRegistrarPredecessorFixture(source, root, { now });
  const candidate = JSON.parse(await readFile(path.join(root, "tools/datapack/release/candidate-build-spec.json"), "utf8"));
  assert.equal(candidate.sourceSnapshots[0].sourceId, "seoulmetro-cyberstation-route-map");
  assert.equal(candidate.sourceSnapshotIds[0], "seoulmetro-cyberstation-route-map-capital-admission-20260712");
});

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

test("registrar builds five source outputs, preserves approval evidence, and leaves changed candidate fail-closed", async (t) => {
  const operationRoot = await mkdtemp(path.join(os.tmpdir(), "static-network-registrar-build-output-"));
  t.after(() => rm(operationRoot, { recursive: true, force: true }));
  const { inWindow: now, expiredAt } = await currentTopologyAdmissionClock(repositoryRoot);
  const root = await registrarPredecessorFixture(t, now);
  const molitBaseline = await readFile(path.join(root, "tools/datapack/sources/molit-urban-rail-full-route-20251211.csv"));
  const positionCsv = await readFile(path.join(root, "tools/datapack/fixtures/seoul-route-map-positions-raw/data-go-15099316.csv"));
  const positions = parseSeoulRouteMapPositionsCsv(positionCsv).rawPositions.map(({ line, stationCode, stationName, latitude, longitude, basisDate }, index) => ({ "연번": `${index + 1}`, "호선": line, "고유역번호(외부역코드)": stationCode, "역명": stationName, "위도": `${latitude}`, "경도": `${longitude}`, "작성기준일": basisDate, "작성일자": basisDate }));
  const precisePosition = positions.find(({ "호선": line, "고유역번호(외부역코드)": stationCode }) => line === "4" && stationCode === "421");
  assert.ok(precisePosition);
  precisePosition["위도"] = "37.5708397";
  const positionEnvelope = Buffer.from(JSON.stringify({ currentCount: positions.length, data: positions, matchCount: positions.length, page: 1, perPage: 1000, totalCount: positions.length }));
  let outputs; let captured;
  await runCurrentStaticNetworkSuccessors({ repositoryRoot: root, operationRoot, now, assertExactMain: async () => "0".repeat(40),
    collectImpl: (input) => collectCurrentStaticNetworkSuccessors({ ...input, serviceKey: "test-service-key", fetchImpl: async (url) => {
      if (url.href === MOLIT_URL) return new Response(molitBaseline, { headers: { "content-type": "text/csv" } });
      if (url.href.startsWith(SEOUL_POSITIONS_URL)) return new Response(positionEnvelope, { headers: { "content-type": "application/json" } });
      throw new Error("unexpected official URL");
    } }), publishImpl: (input) => receiptFor(input, operationRoot, now),
    registerImpl: async ({ observations }) => { captured = cloneObservations(observations); outputs = await buildStaticNetworkSuccessorOutputs({ repositoryRoot: root, observations, now }); },
  });
  assert.equal(outputs.length, 5);
  assert.match(outputs[0].relative, /^tools\/datapack\/sources\/seoul-metro-route-map-positions-current-20\d{6}T\d{9}Z\.json$/u);
  assert.match(outputs[1].relative, /^tools\/datapack\/sources\/molit-urban-rail-full-route-current-20\d{6}T\d{9}Z\.json$/u);
  assert.deepEqual(outputs.slice(2).map(({ relative }) => relative), [
    "tools/datapack/source-inventory.json",
    "tools/datapack/release/source-snapshots.json",
    "tools/datapack/release/candidate-build-spec.json",
  ]);
  const nextInventory = JSON.parse(outputs[2].bytes); const candidate = JSON.parse(outputs[4].bytes); const nextLedger = JSON.parse(outputs[3].bytes);
  const selected = nextLedger.filter(({ snapshotId }) => candidate.sourceSnapshotIds.includes(snapshotId)); const expected = sha(JSON.stringify(selected));
  assert.equal(candidate.sourceSnapshotSetHash, expected);
  assert.equal(nextLedger.filter(({ sourceId, previousSnapshotId }) => sourceId === "seoul-metro-route-map-positions" && previousSnapshotId == null).length, 1);
  const approvalInputs = outputs[0].inputs;
  const requestBytes = approvalInputs.find(({ relative }) => relative === "tools/datapack/release/release-request.json").bytes;
  const hashBytes = approvalInputs.find(({ relative }) => relative === "tools/datapack/release/hash-evidence.json").bytes;
  assert.deepEqual(requestBytes, await readFile(path.join(root, "tools/datapack/release/release-request.json")));
  assert.deepEqual(hashBytes, await readFile(path.join(root, "tools/datapack/release/hash-evidence.json")));
  const violations = releaseRequestBindingViolations({
    buildSpec: candidate,
    buildSpecSha256: sha(outputs[4].bytes),
    releaseRequest: JSON.parse(requestBytes),
  });
  assert.ok(violations.some((violation) => violation.includes("buildSpecSha256")));
  assert.notDeepEqual(selected.map(({ snapshotId }) => snapshotId), candidate.sourceSnapshotIds);
  const positionSnapshot = nextLedger.find(({ sourceId }) => sourceId === "seoul-metro-route-map-positions");
  const positionObservation = JSON.parse(captured[0].bytes);
  const providerPosition = positionObservation.normalizedProjection.find(({ line, stationCode }) => line === "4" && stationCode === "421");
  const layoutPosition = positionObservation.routeMapLayoutArtifact.rawPositions.find(({ line, stationCode }) => line === "4" && stationCode === "421");
  assert.deepEqual(providerPosition, { serial: providerPosition.serial, line: "4", stationCode: "421", stationName: "동대문", latitude: 37.57084, longitude: providerPosition.longitude, basisDate: providerPosition.basisDate });
  assert.equal(layoutPosition.latitude, 37.57084);
  assert.equal(Object.hasOwn(providerPosition, "lineId"), false);
  assert.equal(typeof layoutPosition.lineId, "string");
  const positionSource = nextInventory.sources.find(({ id }) => id === positionSnapshot.sourceId);
  assert.equal(positionSource.requiredForProductionPack, true);
  assert.equal(positionSource.productionUseAllowed, true);
  assert.equal(positionSource.routeMapAdmissionEvidence.freshUntil, positionSnapshot.freshnessExpiresAt);
  assert.equal(positionSource.routeMapAdmissionEvidence.currentLayoutAdmission.snapshotSha256, positionSnapshot.normalizedObservationSha256);
  assert.equal(positionSource.routeMapAdmissionEvidence.currentTopologyAdmission.positionSnapshotSha256, positionSnapshot.normalizedObservationSha256);
  assert.equal(positionSource.routeMapAdmissionEvidence.currentLayoutAdmission.snapshotSha256, positionSource.routeMapAdmissionEvidence.currentTopologyAdmission.positionSnapshotSha256);
  await assert.rejects(buildStaticNetworkSuccessorOutputs({
    repositoryRoot: root, observations: captured, now: expiredAt,
  }), /topology admission snapshot is stale or future-dated/);
  const inconsistent = cloneObservations(captured); inconsistent[0].snapshot.projectionMigration = { ...inconsistent[0].snapshot.projectionMigration, replacedRawSha256: "0".repeat(64) };
  await assert.rejects(buildStaticNetworkSuccessorOutputs({ repositoryRoot: root, observations: inconsistent, now }), /snapshot migration binding/);
  const alteredKind = cloneObservations(captured); replaceMigration(alteredKind, "seoul-metro-route-map-positions", { migrationKind: "OTHER" });
  await assert.rejects(buildStaticNetworkSuccessorOutputs({ repositoryRoot: root, observations: alteredKind, now }), /public replacement binding/);
  const alteredSource = cloneObservations(captured); replaceMigration(alteredSource, "seoul-metro-route-map-positions", { sourceId: "wrong-source" });
  await assert.rejects(buildStaticNetworkSuccessorOutputs({ repositoryRoot: root, observations: alteredSource, now }), /migration contract/);
  const alteredLegacy = cloneObservations(captured); replaceMigration(alteredLegacy, "molit-urban-rail-full-route", { legacyRawSha256: "0".repeat(64) });
  await assert.rejects(buildStaticNetworkSuccessorOutputs({ repositoryRoot: root, observations: alteredLegacy, now }), /migration predecessor binding/);
  const alteredBaseline = cloneObservations(captured); replaceMigration(alteredBaseline, "molit-urban-rail-full-route", { legacySchemaFingerprint: "0".repeat(64) });
  await assert.rejects(buildStaticNetworkSuccessorOutputs({ repositoryRoot: root, observations: alteredBaseline, now }), /migration predecessor binding/);
  const truncatedMolit = cloneObservations(captured);
  const truncatedMolitObservation = JSON.parse(truncatedMolit[1].bytes);
  truncatedMolitObservation.normalizedProjection.pop();
  truncatedMolit[1].bytes = Buffer.from(`${JSON.stringify(truncatedMolitObservation)}\n`);
  await assert.rejects(buildStaticNetworkSuccessorOutputs({ repositoryRoot: root, observations: truncatedMolit, now }), /STATIC_NETWORK_SUCCESSOR_MOLIT_SCOPE/);
  const substitutedPosition = cloneObservations(captured);
  const substitutedPositionObservation = JSON.parse(substitutedPosition[0].bytes);
  substitutedPositionObservation.normalizedProjection[0].stationName += "-대체";
  substitutedPosition[0].bytes = Buffer.from(`${JSON.stringify(substitutedPositionObservation)}\n`);
  await assert.rejects(buildStaticNetworkSuccessorOutputs({ repositoryRoot: root, observations: substitutedPosition, now }), /STATIC_NETWORK_SUCCESSOR_SEOUL_POSITIONS_SCOPE/);
  const membershipDrift = cloneObservations(captured);
  const molitObservation = membershipDrift[1]; const driftedRaw = Buffer.from(molitObservation.rawBytes);
  const firstDaeguRecord = driftedRaw.indexOf(Buffer.from("03,")); const lineEnd = driftedRaw.indexOf(0x0a, firstDaeguRecord);
  assert.ok(firstDaeguRecord >= 0 && lineEnd > firstDaeguRecord);
  driftedRaw[driftedRaw[lineEnd - 1] === 0x0d ? lineEnd - 2 : lineEnd - 1] = 0x41;
  const rawSha256 = sha(driftedRaw); const date = molitObservation.snapshot.retrievedAt.slice(0, 10).replaceAll("-", "");
  const objectKey = `source-raw/${molitObservation.snapshot.sourceId}/${date}/${rawSha256}.csv`;
  const rawObjectUri = `oci://axvym6vk8g7i/easysubway-datapacks/${objectKey}`;
  molitObservation.rawBytes = driftedRaw;
  molitObservation.snapshot.rawSha256 = rawSha256;
  molitObservation.snapshot.rawObjectUri = rawObjectUri;
  molitObservation.receipt.rawObjectSha256 = rawSha256;
  molitObservation.receipt.byteSize = driftedRaw.length;
  molitObservation.receipt.objectKey = objectKey;
  molitObservation.receipt.rawObjectUri = rawObjectUri;
  molitObservation.snapshot.rawReceipt = structuredClone(molitObservation.receipt);
  const driftedObservation = JSON.parse(molitObservation.bytes);
  driftedObservation.rawSha256 = rawSha256;
  molitObservation.bytes = Buffer.from(`${JSON.stringify(driftedObservation)}\n`);
  molitObservation.snapshot.normalizedObservationSha256 = sha(molitObservation.bytes);
  await assert.rejects(buildStaticNetworkSuccessorOutputs({ repositoryRoot: root, observations: membershipDrift, now }), /static network MOLIT membership admission drift/);
});

test("registrar atomically rebinds every dependent regional membership evidence to verified current MOLIT raw bytes", async (t) => {
  const operationRoot = await mkdtemp(path.join(os.tmpdir(), "static-network-registrar-membership-rebind-"));
  t.after(() => rm(operationRoot, { recursive: true, force: true }));
  const now = (await currentTopologyAdmissionClock(repositoryRoot)).inWindow;
  const root = await registrarPredecessorFixture(t, now);
  const baseline = await readFile(path.join(root, "tools/datapack/sources/molit-urban-rail-full-route-20251211.csv"));
  const freshRaw = Buffer.concat([baseline, Buffer.from("\n")]);
  let outputs;
  await runCurrentStaticNetworkSuccessors({ repositoryRoot: root, operationRoot, now, assertExactMain: async () => "0".repeat(40),
    collectImpl: async (input) => {
      const collection = await collectCurrentStaticNetworkSuccessors({ ...input, serviceKey: "test-service-key", fetchImpl: async (url) => {
        if (url.href === MOLIT_URL) return new Response(freshRaw, { headers: { "content-type": "text/csv" } });
        if (url.href.startsWith(SEOUL_POSITIONS_URL)) {
          const csv = await readFile(path.join(root, "tools/datapack/fixtures/seoul-route-map-positions-raw/data-go-15099316.csv"));
          const rows = parseSeoulRouteMapPositionsCsv(csv).rawPositions.map(({ line, stationCode, stationName, latitude, longitude, basisDate }, index) => ({ "연번": `${index + 1}`, "호선": line, "고유역번호(외부역코드)": stationCode, "역명": stationName, "위도": `${latitude}`, "경도": `${longitude}`, "작성기준일": basisDate, "작성일자": basisDate }));
          return new Response(JSON.stringify({ currentCount: rows.length, data: rows, matchCount: rows.length, page: 1, perPage: 1000, totalCount: rows.length }), { headers: { "content-type": "application/json" } });
        }
        throw new Error("unexpected official URL");
      } });
      return collection;
    },
    publishImpl: (input) => receiptFor(input, operationRoot, now),
    registerImpl: async ({ observations }) => { outputs = await buildStaticNetworkSuccessorOutputs({ repositoryRoot: root, observations, now }); },
  });
  const inventory = JSON.parse(outputs[2].bytes);
  const evidence = inventory.sources.map(({ membershipAdmissionEvidence }) => membershipAdmissionEvidence).filter((value) => value?.membershipSourceId === "molit-urban-rail-full-route");
  assert.equal(evidence.length, 10);
  for (const value of evidence) {
    assert.equal(value.membershipSourceRawSha256, sha(freshRaw));
    assert.equal(value.membershipSourceSnapshotSha256, sha(freshRaw));
    assert.equal(value.verifiedAt, now.toISOString());
  }
});

test("registrar rejects parseable full-route membership drift before staging seven outputs", async (t) => {
  const operationRoot = await mkdtemp(path.join(os.tmpdir(), "static-network-registrar-membership-drift-"));
  t.after(() => rm(operationRoot, { recursive: true, force: true }));
  const now = (await currentTopologyAdmissionClock(repositoryRoot)).inWindow;
  const root = await registrarPredecessorFixture(t, now);
  const baseline = await readFile(path.join(root, "tools/datapack/sources/molit-urban-rail-full-route-20251211.csv"));
  const changedRaw = swapDaejeonMembershipSequences(baseline);
  await assert.rejects(runCurrentStaticNetworkSuccessors({ repositoryRoot: root, operationRoot, now, assertExactMain: async () => "0".repeat(40),
    collectImpl: async (input) => collectCurrentStaticNetworkSuccessors({ ...input, serviceKey: "test-service-key", fetchImpl: async (url) => {
      if (url.href === MOLIT_URL) return new Response(changedRaw, { headers: { "content-type": "text/csv" } });
      if (url.href.startsWith(SEOUL_POSITIONS_URL)) {
        const csv = await readFile(path.join(root, "tools/datapack/fixtures/seoul-route-map-positions-raw/data-go-15099316.csv"));
        const rows = parseSeoulRouteMapPositionsCsv(csv).rawPositions.map(({ line, stationCode, stationName, latitude, longitude, basisDate }, index) => ({ "연번": `${index + 1}`, "호선": line, "고유역번호(외부역코드)": stationCode, "역명": stationName, "위도": `${latitude}`, "경도": `${longitude}`, "작성기준일": basisDate, "작성일자": basisDate }));
        return new Response(JSON.stringify({ currentCount: rows.length, data: rows, matchCount: rows.length, page: 1, perPage: 1000, totalCount: rows.length }), { headers: { "content-type": "application/json" } });
      }
      throw new Error("unexpected official URL");
    } }),
    publishImpl: (input) => receiptFor(input, operationRoot, now),
    registerImpl: ({ observations }) => buildStaticNetworkSuccessorOutputs({ repositoryRoot: root, observations, now }),
  }), /membership admission drift/);
});

test("register API acquires the active owner lease before validating observations or reading inputs", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "static-network-lock-first-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(path.resolve(import.meta.dirname, "../.."), root, { recursive: true, filter: (source) => !source.includes("node_modules") });
  const port = await leasePort(t);
  await writeFile(path.join(root, "tools/datapack/.static-network-successors.lock"), `${JSON.stringify({ schemaVersion: 1, host: "127.0.0.1", port, pid: process.pid, token: "00000000-0000-4000-8000-000000000000" }, null, 2)}\n`);
  await assert.rejects(registerCurrentStaticNetworkSuccessors({ repositoryRoot: root, observations: [] }), /lock residue exists/);
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
