import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CURRENT_CAPITAL_ACCESSIBILITY_SOURCE_FIXED_OUTPUTS,
  buildCurrentCapitalAccessibilitySourceHandoff,
  canonicalCurrentCapitalAccessibilitySourceHandoffJson,
  changedCurrentCapitalAccessibilitySourceOutputPaths,
  collectCurrentCapitalTerminalAccessibilitySources,
  decideCurrentCapitalAccessibilitySourceRefresh,
  rebuildCurrentCapitalAccessibilitySourceHandoffFromRoots,
  verifyCurrentCapitalAccessibilitySourceHandoff,
} from "./current-capital-accessibility-source-handoff.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const ROOT = path.resolve(import.meta.dirname, "../..");
const SOURCE_MAIN_SHA = "a".repeat(40);
const FACILITY_HEAD_SHA = "b".repeat(40);
const PROTECTED_CANDIDATE_ID = "capital-candidate-protected";
const OPERATION_NOW = "2026-09-02T12:00:00.000Z";

async function write(root, relative, bytes) {
  const target = path.join(root, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, bytes);
}

function snapshot(sourceId, stamp, previousSnapshotId) {
  const snapshotId = `${sourceId}-${stamp}`;
  const rawSha256 = (sourceId === "seoul-metro-accessibility" ? "c" : "d").repeat(64);
  return {
    sourceId,
    snapshotId,
    relativePath: `tools/datapack/sources/${snapshotId}.json`,
    bytes: Buffer.from(`${JSON.stringify({
      sourceId,
      snapshotId,
      previousSnapshotId,
      capturedAt: "2026-09-02T11:58:00.000Z",
      observedAt: "2026-09-02T11:58:00.000Z",
      freshUntil: "2026-09-03T11:58:00.000Z",
      rawSha256,
    })}\n`),
  };
}

function receipt(source, fill) {
  return Buffer.from(`${JSON.stringify({
    schemaVersion: 1,
    artifactKind: source.sourceId === "seoul-metro-accessibility"
      ? "seoul-accessibility-raw-object-receipt"
      : "kric-accessibility-raw-object-receipt",
    sourceId: source.sourceId,
    snapshotId: source.snapshotId,
    snapshotRawSha256: fill.repeat(64),
    capturedAt: "2026-09-02T11:58:00.000Z",
    snapshotFileSha256: sha256(source.bytes),
    rawObjectUri: `oci://fixture/${source.sourceId}/${fill.repeat(64)}.json`,
    rawObjectSha256: fill.repeat(64),
    byteSize: 123,
    storedAt: "2026-09-02T11:59:00.000Z",
    rawRetentionExpiresAt: "2026-12-01T11:58:00.000Z",
  })}\n`);
}

async function fixture(t) {
  const parent = await mkdtemp(path.join(tmpdir(), "capital-accessibility-handoff-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const retainedRoot = path.join(parent, "retained");
  const preparedRoot = path.join(parent, "prepared");
  await Promise.all([mkdir(retainedRoot), mkdir(preparedRoot)]);
  const seoul = snapshot("seoul-metro-accessibility", "20260902T115800000Z", "seoul-old");
  const kric = snapshot("kric-station-convenience-standard", "20260902T115900000Z", "kric-old");
  const preparedSources = [
    { action: "REFRESH", ...seoul, receiptBytes: receipt(seoul, "c") },
    { action: "REFRESH", ...kric, receiptBytes: receipt(kric, "d") },
  ];
  const [candidate, inventory, ledger] = await Promise.all([
    "tools/datapack/release/candidate-build-spec.json",
    "tools/datapack/source-inventory.json",
    "tools/datapack/release/source-snapshots.json",
  ].map(async (relative) => JSON.parse(await readFile(path.join(ROOT, relative), "utf8"))));
  for (const sourceId of ["seoul-metro-accessibility", "kric-station-convenience-standard"]) {
    const relative = inventory.sources.find(({ id }) => id === sourceId).accessibilityAdmissionEvidence.snapshotPath;
    await write(retainedRoot, relative, await readFile(path.join(ROOT, relative)));
  }
  candidate.candidateId = PROTECTED_CANDIDATE_ID;
  for (const source of preparedSources) {
    const selectedIndex = candidate.sourceSnapshots.findIndex(({ sourceId }) => sourceId === source.sourceId);
    const previousSnapshotId = candidate.sourceSnapshotIds[selectedIndex];
    const previous = ledger.find(({ snapshotId }) => snapshotId === previousSnapshotId);
    const rawReceipt = JSON.parse(source.receiptBytes);
    const next = {
      ...structuredClone(previous), snapshotId: source.snapshotId, previousSnapshotId,
      retrievedAt: rawReceipt.capturedAt, sourceUpdatedAt: rawReceipt.capturedAt,
      rawSha256: rawReceipt.rawObjectSha256, rawObjectUri: rawReceipt.rawObjectUri, rawReceipt,
      freshnessExpiresAt: "2026-12-01T11:58:00.000Z", rawRetentionExpiresAt: rawReceipt.rawRetentionExpiresAt,
      diffSummary: {
        status: "CHANGED", rawHashChanged: previous.rawSha256 !== rawReceipt.rawObjectSha256,
        schemaHashChanged: false, requestHashChanged: false, sourceUpdatedAtChanged: true,
        rowDelta: 0, coverageDelta: 0,
      },
    };
    ledger.push(next);
    candidate.sourceSnapshotIds[selectedIndex] = source.snapshotId;
    candidate.sourceSnapshots[selectedIndex].snapshotId = source.snapshotId;
    const selected = inventory.sources.find(({ id }) => id === source.sourceId);
    selected.accessibilityAdmissionEvidence.snapshotId = source.snapshotId;
    selected.accessibilityAdmissionEvidence.snapshotPath = source.relativePath;
    selected.accessibilityAdmissionEvidence.capturedAt = rawReceipt.capturedAt;
    selected.accessibilityAdmissionEvidence.observedAt = rawReceipt.capturedAt;
    selected.accessibilityAdmissionEvidence.freshUntil = "2026-09-03T11:58:00.000Z";
    selected.accessibilityAdmissionEvidence.rawSha256 = rawReceipt.snapshotRawSha256;
    selected.accessibilityAdmissionEvidence.snapshotFileSha256 = sha256(source.bytes);
  }
  for (const relative of CURRENT_CAPITAL_ACCESSIBILITY_SOURCE_FIXED_OUTPUTS) {
    let before = await readFile(path.join(ROOT, relative));
    if (relative === "tools/datapack/release/candidate-build-spec.json") {
      const retainedCandidate = JSON.parse(before);
      retainedCandidate.candidateId = PROTECTED_CANDIDATE_ID;
      before = Buffer.from(`${JSON.stringify(retainedCandidate)}\n`);
    }
    await write(retainedRoot, relative, before);
    let bytes = Buffer.from(`after:${relative}\n`);
    if (relative === "tools/datapack/release/candidate-build-spec.json") bytes = Buffer.from(`${JSON.stringify(candidate)}\n`);
    if (relative === "tools/datapack/release/current-capital-facility-source-admission.json") {
      bytes = Buffer.from(`${JSON.stringify({ observedAt: OPERATION_NOW })}\n`);
    }
    if (relative === "tools/datapack/source-inventory.json") bytes = Buffer.from(`${JSON.stringify(inventory)}\n`);
    if (relative === "tools/datapack/release/source-snapshots.json") bytes = Buffer.from(`${JSON.stringify(ledger)}\n`);
    await write(preparedRoot, relative, bytes);
  }
  await write(preparedRoot, seoul.relativePath, seoul.bytes);
  await write(preparedRoot, kric.relativePath, kric.bytes);
  return {
    retainedRoot,
    preparedRoot,
    sources: preparedSources,
  };
}

test("closed handoff binds two fresh sources and seven protected replacements", async (t) => {
  const input = await fixture(t);
  const noOpPath = "tools/datapack/release/release-request.json";
  await write(input.preparedRoot, noOpPath, await readFile(path.join(input.retainedRoot, noOpPath)));
  const handoff = await buildCurrentCapitalAccessibilitySourceHandoff({
    repository: "AquilaXk/easysubway-data",
    operationId: "kric-exit-full-capital-refresh-123456",
    sourceMainGitSha: SOURCE_MAIN_SHA,
    facilityBranch: "automation/629-kric-facility-refresh-123456",
    facilityHeadGitSha: FACILITY_HEAD_SHA,
    providerStartedAt: new Date(OPERATION_NOW),
    operationNow: new Date(OPERATION_NOW),
    protectedCandidateId: PROTECTED_CANDIDATE_ID,
    retainedRoot: input.retainedRoot,
    preparedRoot: input.preparedRoot,
    sources: input.sources,
  });
  const bytes = Buffer.from(`${canonicalCurrentCapitalAccessibilitySourceHandoffJson(handoff)}\n`);
  const verified = await verifyCurrentCapitalAccessibilitySourceHandoff({
    handoffBytes: bytes,
    retainedRoot: input.retainedRoot,
    preparedRoot: input.preparedRoot,
    expected: {
      repository: "AquilaXk/easysubway-data",
      operationId: "kric-exit-full-capital-refresh-123456",
      sourceMainGitSha: SOURCE_MAIN_SHA,
      facilityBranch: "automation/629-kric-facility-refresh-123456",
      facilityHeadGitSha: FACILITY_HEAD_SHA,
      protectedCandidateId: PROTECTED_CANDIDATE_ID,
    },
  });
  assert.deepEqual(verified.outputs.map(({ relativePath, operation }) => [relativePath, operation]), [
    ...CURRENT_CAPITAL_ACCESSIBILITY_SOURCE_FIXED_OUTPUTS.map((relative) => [relative, "replace"]),
    ...input.sources.map(({ relativePath }) => [relativePath, "create"]).sort(([left], [right]) => left.localeCompare(right, "en")),
  ].sort(([left], [right]) => left.localeCompare(right, "en")));
  assert.equal(changedCurrentCapitalAccessibilitySourceOutputPaths(verified).includes(noOpPath), false);
  assert.equal(changedCurrentCapitalAccessibilitySourceOutputPaths(verified).includes(input.sources[0].relativePath), true);

  await write(input.preparedRoot, input.sources[0].relativePath, Buffer.from("tampered\n"));
  await assert.rejects(verifyCurrentCapitalAccessibilitySourceHandoff({
    handoffBytes: bytes,
    retainedRoot: input.retainedRoot,
    preparedRoot: input.preparedRoot,
    expected: {
      repository: "AquilaXk/easysubway-data",
      operationId: "kric-exit-full-capital-refresh-123456",
      sourceMainGitSha: SOURCE_MAIN_SHA,
      facilityBranch: "automation/629-kric-facility-refresh-123456",
      facilityHeadGitSha: FACILITY_HEAD_SHA,
      protectedCandidateId: PROTECTED_CANDIDATE_ID,
    },
  }), /prepared output digest mismatch/);
});

test("mixed handoff retains Seoul bytes and refreshes only KRIC", async (t) => {
  const input = await fixture(t);
  const candidatePath = "tools/datapack/release/candidate-build-spec.json";
  const inventoryPath = "tools/datapack/source-inventory.json";
  const ledgerPath = "tools/datapack/release/source-snapshots.json";
  const [retainedCandidate, preparedCandidate, retainedInventory, preparedInventory, retainedLedger, preparedLedger] = await Promise.all([
    readFile(path.join(input.retainedRoot, candidatePath)).then(JSON.parse),
    readFile(path.join(input.preparedRoot, candidatePath)).then(JSON.parse),
    readFile(path.join(input.retainedRoot, inventoryPath)).then(JSON.parse),
    readFile(path.join(input.preparedRoot, inventoryPath)).then(JSON.parse),
    readFile(path.join(input.retainedRoot, ledgerPath)).then(JSON.parse),
    readFile(path.join(input.preparedRoot, ledgerPath)).then(JSON.parse),
  ]);
  const retainedId = "seoul-metro-accessibility";
  const retainedIndex = retainedCandidate.sourceSnapshots.findIndex(({ sourceId }) => sourceId === retainedId);
  retainedCandidate.sourceSnapshotIds[retainedIndex] = preparedCandidate.sourceSnapshotIds[retainedIndex];
  retainedCandidate.sourceSnapshots[retainedIndex] = structuredClone(preparedCandidate.sourceSnapshots[retainedIndex]);
  const retainedInventoryIndex = retainedInventory.sources.findIndex(({ id }) => id === retainedId);
  retainedInventory.sources[retainedInventoryIndex] = structuredClone(
    preparedInventory.sources.find(({ id }) => id === retainedId),
  );
  const retainedSnapshotId = retainedCandidate.sourceSnapshotIds[retainedIndex];
  retainedLedger.push(structuredClone(preparedLedger.find(({ snapshotId }) => snapshotId === retainedSnapshotId)));
  const retainedSnapshotPath = retainedInventory.sources[retainedInventoryIndex].accessibilityAdmissionEvidence.snapshotPath;
  await Promise.all([
    write(input.retainedRoot, candidatePath, Buffer.from(`${JSON.stringify(retainedCandidate)}\n`)),
    write(input.retainedRoot, inventoryPath, Buffer.from(`${JSON.stringify(retainedInventory)}\n`)),
    write(input.retainedRoot, ledgerPath, Buffer.from(`${JSON.stringify(retainedLedger)}\n`)),
    write(input.retainedRoot, retainedSnapshotPath, await readFile(path.join(input.preparedRoot, retainedSnapshotPath))),
  ]);
  const kricRefresh = input.sources.find(({ sourceId }) => sourceId === "kric-station-convenience-standard");
  const sources = [{ action: "RETAIN", sourceId: retainedId }, kricRefresh];
  const handoff = await buildCurrentCapitalAccessibilitySourceHandoff({
    repository: "AquilaXk/easysubway-data",
    operationId: "kric-exit-full-capital-refresh-123456",
    sourceMainGitSha: SOURCE_MAIN_SHA,
    facilityBranch: "automation/629-kric-facility-refresh-123456",
    facilityHeadGitSha: FACILITY_HEAD_SHA,
    providerStartedAt: new Date("2026-09-02T11:58:00.000Z"),
    operationNow: new Date(OPERATION_NOW),
    protectedCandidateId: PROTECTED_CANDIDATE_ID,
    retainedRoot: input.retainedRoot,
    preparedRoot: input.preparedRoot,
    sources,
  });
  const verified = await verifyCurrentCapitalAccessibilitySourceHandoff({
    handoffBytes: Buffer.from(`${canonicalCurrentCapitalAccessibilitySourceHandoffJson(handoff)}\n`),
    retainedRoot: input.retainedRoot,
    preparedRoot: input.preparedRoot,
    expected: {
      repository: "AquilaXk/easysubway-data",
      operationId: "kric-exit-full-capital-refresh-123456",
      sourceMainGitSha: SOURCE_MAIN_SHA,
      facilityBranch: "automation/629-kric-facility-refresh-123456",
      facilityHeadGitSha: FACILITY_HEAD_SHA,
      protectedCandidateId: PROTECTED_CANDIDATE_ID,
    },
  });
  assert.deepEqual(verified.sources.map(({ sourceId, action }) => [sourceId, action]), [
    ["kric-station-convenience-standard", "REFRESH"],
    ["seoul-metro-accessibility", "RETAIN"],
  ]);
  assert.equal(verified.outputs.some(({ relativePath }) => relativePath === retainedSnapshotPath), false);
  assert.equal(verified.outputs.some(({ relativePath }) => relativePath === kricRefresh.relativePath), true);
  const rebuilt = await rebuildCurrentCapitalAccessibilitySourceHandoffFromRoots({
    repository: "AquilaXk/easysubway-data",
    operationId: "kric-exit-full-capital-refresh-123456",
    sourceMainGitSha: SOURCE_MAIN_SHA,
    facilityBranch: "automation/629-kric-facility-refresh-123456",
    facilityHeadGitSha: FACILITY_HEAD_SHA,
    providerStartedAt: new Date("2026-09-02T11:58:00.000Z"),
    operationNow: new Date(OPERATION_NOW),
    protectedCandidateId: PROTECTED_CANDIDATE_ID,
    retainedRoot: input.retainedRoot,
    preparedRoot: input.preparedRoot,
  });
  assert.equal(rebuilt.handoffSha256, handoff.handoffSha256);
  assert.deepEqual(rebuilt.sources.map(({ sourceId, action }) => [sourceId, action]), [
    ["kric-station-convenience-standard", "REFRESH"],
    ["seoul-metro-accessibility", "RETAIN"],
  ]);
  assert.equal(rebuilt.outputs.some(({ relativePath }) => relativePath === retainedSnapshotPath), false);
});

test("roots-only rebuild preserves caller-supplied operation clocks", async (t) => {
  const input = await fixture(t);
  const rebuilt = await rebuildCurrentCapitalAccessibilitySourceHandoffFromRoots({
    repository: "AquilaXk/easysubway-data",
    operationId: "kric-exit-full-capital-refresh-123456",
    sourceMainGitSha: SOURCE_MAIN_SHA,
    facilityBranch: "automation/629-kric-facility-refresh-123456",
    facilityHeadGitSha: FACILITY_HEAD_SHA,
    providerStartedAt: new Date("2026-09-02T11:58:00.000Z"),
    operationNow: new Date(OPERATION_NOW),
    protectedCandidateId: PROTECTED_CANDIDATE_ID,
    retainedRoot: input.retainedRoot,
    preparedRoot: input.preparedRoot,
  });
  assert.equal(rebuilt.providerStartedAt, "2026-09-02T11:58:00.000Z");
  assert.equal(rebuilt.operationNow, OPERATION_NOW);
});

test("handoff rejects a source outside the exact Seoul and KRIC pair", async (t) => {
  const input = await fixture(t);
  const foreign = snapshot("foreign-accessibility", "20260902T115900000Z", "foreign-old");
  await write(input.preparedRoot, foreign.relativePath, foreign.bytes);
  await assert.rejects(buildCurrentCapitalAccessibilitySourceHandoff({
    repository: "AquilaXk/easysubway-data",
    operationId: "kric-exit-full-capital-refresh-123456",
    sourceMainGitSha: SOURCE_MAIN_SHA,
    facilityBranch: "automation/629-kric-facility-refresh-123456",
    facilityHeadGitSha: FACILITY_HEAD_SHA,
    providerStartedAt: new Date(OPERATION_NOW),
    operationNow: new Date(OPERATION_NOW),
    protectedCandidateId: PROTECTED_CANDIDATE_ID,
    retainedRoot: input.retainedRoot,
    preparedRoot: input.preparedRoot,
    sources: [...input.sources, { ...foreign, receiptBytes: receipt(foreign, "e") }],
  }), /source set mismatch/);
});

test("refresh decision expires only the selected source whose direct freshUntil elapsed", async (t) => {
  const parent = await mkdtemp(path.join(tmpdir(), "capital-accessibility-decision-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  for (const relative of [
    "tools/datapack/source-inventory.json",
    "tools/datapack/release/candidate-build-spec.json",
    "tools/datapack/release/source-snapshots.json",
  ]) await write(parent, relative, await readFile(path.join(ROOT, relative)));
  const inventory = JSON.parse(await readFile(path.join(parent, "tools/datapack/source-inventory.json")));
  for (const sourceId of ["kric-station-convenience-standard", "seoul-metro-accessibility"]) {
    const relative = inventory.sources.find(({ id }) => id === sourceId).accessibilityAdmissionEvidence.snapshotPath;
    await write(parent, relative, await readFile(path.join(ROOT, relative)));
  }
  const selected = ["kric-station-convenience-standard", "seoul-metro-accessibility"]
    .map((sourceId) => inventory.sources.find(({ id }) => id === sourceId).accessibilityAdmissionEvidence)
    .sort((left, right) => Date.parse(left.freshUntil) - Date.parse(right.freshUntil));

  const current = await decideCurrentCapitalAccessibilitySourceRefresh({
    repositoryRoot: parent,
    now: new Date(Date.parse(selected[0].freshUntil) - 1),
  });
  assert.equal(current.state, "CURRENT");
  assert.deepEqual(current.refreshSourceIds, []);

  const firstExpired = await decideCurrentCapitalAccessibilitySourceRefresh({
    repositoryRoot: parent,
    now: new Date(selected[0].freshUntil),
  });
  assert.equal(firstExpired.state, "EXPIRED");
  assert.deepEqual(firstExpired.refreshSourceIds, [
    inventory.sources.find(({ accessibilityAdmissionEvidence }) => accessibilityAdmissionEvidence?.snapshotId === selected[0].snapshotId).id,
  ]);

  const bothExpired = await decideCurrentCapitalAccessibilitySourceRefresh({
    repositoryRoot: parent,
    now: new Date(selected[1].freshUntil),
  });
  assert.deepEqual(bothExpired.refreshSourceIds, [
    "kric-station-convenience-standard",
    "seoul-metro-accessibility",
  ]);

  const candidatePath = path.join(parent, "tools/datapack/release/candidate-build-spec.json");
  const candidate = JSON.parse(await readFile(candidatePath));
  const seoulIndex = candidate.sourceSnapshots.findIndex(({ sourceId }) => sourceId === "seoul-metro-accessibility");
  candidate.sourceSnapshotIds[seoulIndex] = "seoul-metro-accessibility-mismatch";
  await writeFile(candidatePath, `${JSON.stringify(candidate)}\n`);
  await assert.rejects(decideCurrentCapitalAccessibilitySourceRefresh({
    repositoryRoot: parent,
    now: new Date(selected[1].freshUntil),
  }), /selected accessibility source identity mismatch: seoul-metro-accessibility/);
});

test("current sources prepare retain-only inputs with zero provider or OCI calls", async (t) => {
  const parent = await mkdtemp(path.join(tmpdir(), "capital-accessibility-retain-only-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const inventory = JSON.parse(await readFile(path.join(ROOT, "tools/datapack/source-inventory.json")));
  const selected = ["kric-station-convenience-standard", "seoul-metro-accessibility"]
    .map((sourceId) => inventory.sources.find(({ id }) => id === sourceId).accessibilityAdmissionEvidence);
  const lowerBound = Math.max(...selected.flatMap(({ capturedAt, observedAt }) => [Date.parse(capturedAt), Date.parse(observedAt)]));
  const upperBound = Math.min(...selected.map(({ freshUntil }) => Date.parse(freshUntil)));
  assert.ok(lowerBound < upperBound);
  const providerStartedAt = new Date(lowerBound + 1);
  const decision = await decideCurrentCapitalAccessibilitySourceRefresh({ repositoryRoot: ROOT, now: providerStartedAt });
  assert.deepEqual(decision.refreshSourceIds, []);
  const calls = { prepare: 0, providerOrOci: 0 };
  const providerOrOci = async () => { calls.providerOrOci += 1; };
  const result = await collectCurrentCapitalTerminalAccessibilitySources({
    repositoryRoot: ROOT,
    operationRoot: path.join(parent, "operation"),
    expectedMainSha: SOURCE_MAIN_SHA,
    expectedFacilityHeadSha: FACILITY_HEAD_SHA,
    providerStartedAt,
    refreshSourceIds: [],
    env: {},
    collectSeoulImpl: providerOrOci,
    writeSeoulImpl: providerOrOci,
    publishSeoulImpl: providerOrOci,
    prepareKricImpl: async () => { calls.prepare += 1; },
    collectKricImpl: providerOrOci,
    publishKricImpl: providerOrOci,
  });
  assert.deepEqual(calls, { prepare: 1, providerOrOci: 0 });
  assert.deepEqual(result.refreshSourceIds, []);
  assert.equal(result.seoul, null);
  assert.equal(result.kric, null);
});

test("malformed DATA_GO credential fails before every source delegate", async (t) => {
  const parent = await mkdtemp(path.join(tmpdir(), "capital-accessibility-credential-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const providerStartedAt = new Date("2027-01-01T00:00:00.000Z");
  const decision = await decideCurrentCapitalAccessibilitySourceRefresh({
    repositoryRoot: ROOT,
    now: providerStartedAt,
  });
  let calls = 0;
  const delegate = async () => { calls += 1; };
  await assert.rejects(collectCurrentCapitalTerminalAccessibilitySources({
    repositoryRoot: ROOT,
    operationRoot: path.join(parent, "operation"),
    expectedMainSha: SOURCE_MAIN_SHA,
    expectedFacilityHeadSha: FACILITY_HEAD_SHA,
    providerStartedAt,
    refreshSourceIds: decision.refreshSourceIds,
    env: { DATA_GO_KR_SERVICE_KEY: "invalid%ZZ" },
    collectSeoulImpl: delegate,
    writeSeoulImpl: delegate,
    publishSeoulImpl: delegate,
    prepareKricImpl: delegate,
    collectKricImpl: delegate,
    publishKricImpl: delegate,
  }), /DATA_GO_KR_SERVICE_KEY is invalid/);
  assert.equal(calls, 0);
});
