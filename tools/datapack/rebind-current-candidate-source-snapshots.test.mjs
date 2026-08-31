import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, open, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildSnapshotDiff } from "./source-snapshot-policy.mjs";
import {
  atomicReplace,
  appendTransferCandidateSourceSnapshot,
  CURRENT_FULL_CANDIDATE_SOURCE_IDS,
  CURRENT_PRE_TRANSFER_CANDIDATE_SOURCE_IDS,
  deriveReleaseProjection,
  isActiveCandidateSourceSequence,
  requireCurrentCanonicalSourceRoster,
  rebindCandidateSourceSnapshots,
  rebindCurrentCandidateSourceSnapshots,
} from "./rebind-current-candidate-source-snapshots.mjs";
import { KRIC_ACCESSIBILITY_OPERATIONS } from "./collect-kric-accessibility-snapshots.mjs";
import { releaseRequestBindingViolations } from "./verify-release-request-binding.mjs";
import { approvedGovernanceBindingTransition } from "./source-governance-policy.mjs";
import { deriveRawRetentionExpiresAt } from "./source-governance-policy.mjs";
import { deriveFreshnessExpiresAt } from "./freshness-policy.mjs";
import { copySyntheticCurrentPublicRouteMapRepository } from "./test-fixtures/current-public-route-map-successor.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const CURRENT_SOURCE_HEAD_AT = await selectedSourceHeadAt();
const NOW = new Date(CURRENT_SOURCE_HEAD_AT + 120_000);
const sha = (value) => createHash("sha256").update(value).digest("hex");
const jsonSha = (value) => sha(Buffer.from(JSON.stringify(value)));
const CURRENT_CAPITAL_BASE_SOURCE_IDS = Object.freeze([
  "molit-urban-rail-full-route", "seoulmetro-station-line-info", "seoul-metro-route-map-positions",
  "kric-subway-timetable", "seoul-metro-accessibility", "kric-station-convenience-standard",
  "seoul-metro-official-od-fares", "seoul-metro-transfer-distance-duration",
]);

test("active candidate source sequence accepts only current Incheon predecessor and TRANSFER terminal rosters", () => {
  const six = [
    "seoul-metro-route-map-positions", "kric-subway-timetable", "seoul-metro-accessibility",
    "kric-station-convenience-standard", "molit-urban-rail-full-route", "seoulmetro-station-line-info",
  ];
  const currentPreTransfer = [...six, "incheon-transit-accessibility"];
  const currentFull = [...currentPreTransfer, "seoul-metro-transfer-distance-duration"];
  assert.deepEqual(CURRENT_PRE_TRANSFER_CANDIDATE_SOURCE_IDS, currentPreTransfer);
  assert.deepEqual(CURRENT_FULL_CANDIDATE_SOURCE_IDS, currentFull);
  assert.equal(isActiveCandidateSourceSequence(six), false);
  assert.equal(isActiveCandidateSourceSequence([...six, "seoul-metro-transfer-distance-duration"]), false);
  assert.equal(isActiveCandidateSourceSequence(currentPreTransfer), true);
  assert.equal(isActiveCandidateSourceSequence(currentFull), true);
  assert.equal(isActiveCandidateSourceSequence([...currentFull].reverse()), false);
  assert.equal(isActiveCandidateSourceSequence([...six, "other-source"]), false);
  assert.equal(isActiveCandidateSourceSequence([...six, six.at(-1)]), false);
  assert.equal(isActiveCandidateSourceSequence([...six, "seoul-metro-transfer-distance-duration", "incheon-transit-accessibility"]), false);
  assert.equal(isActiveCandidateSourceSequence([...currentPreTransfer, "incheon-transit-accessibility"]), false);
  assert.equal(isActiveCandidateSourceSequence([
    "seoulmetro-cyberstation-route-map", ...six.slice(1),
  ]), false);
});

function kric213Snapshot() {
  const operation = KRIC_ACCESSIBILITY_OPERATIONS[0];
  const capturedAt = new Date(CURRENT_SOURCE_HEAD_AT + 60_000).toISOString();
  const queries = Array.from({ length: 213 }, (_, index) => {
    const stationId = `station-${index}`;
    const lineId = `line-${index}`;
    const railOprIsttCd = `O${index}`;
    const lnCd = `L${index}`;
    const stinCd = `S${index}`;
    return {
      stationId, lineId, railOprIsttCd, lnCd, stinCd, rows: [],
      rawResponseSha256: sha(`raw-${index}`), providerRecordHash: jsonSha([]), status: "ABSENT_EXPLICIT_ZERO",
      canonicalMappings: [{ artifactId: "capital", stationId, lineId }],
    };
  });
  return {
    schemaVersion: 1, artifactKind: "kric-accessibility-snapshot", sourceId: operation.sourceId,
    snapshotId: `kric-station-convenience-standard-${capturedAt.replaceAll(/[-:.]/g, "").replace("Z", "Z")}`, capturedAt, observedAt: capturedAt,
    freshUntil: new Date(Date.parse(capturedAt) + 24 * 60 * 60 * 1_000).toISOString(), providerResultCode: "00", schemaStatus: "PASS",
    absenceEvidenceMode: "EXHAUSTIVE_LIST", credentialRedacted: true, queries, queryCount: queries.length,
    rowCount: 0,
    contentSha256: jsonSha(queries.map(({ rawResponseSha256: _, ...query }) => query)),
    rawSha256: jsonSha(queries.map(({
      stationId, lineId, railOprIsttCd, lnCd, stinCd, rawResponseSha256,
    }) => ({ stationId, lineId, railOprIsttCd, lnCd, stinCd, rawResponseSha256 }))),
    schemaFingerprint: jsonSha([...operation.responseFields].sort()),
    redactedRequestFingerprint: jsonSha({
      endpoint: operation.endpoint,
      tuples: queries.map(({ railOprIsttCd, lnCd, stinCd }) => ({ railOprIsttCd, lnCd, stinCd })),
    }),
  };
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "candidate-rebind-"));
  await copySyntheticCurrentPublicRouteMapRepository(ROOT, root, { now: NOW });
  const readJson = async (relative) => JSON.parse(await readFile(path.join(root, relative), "utf8"));
  const snapshots = await readJson("tools/datapack/release/source-snapshots.json");
  const inventory = await readJson("tools/datapack/source-inventory.json");
  const candidatePath = path.join(root, "tools/datapack/release/candidate-build-spec.json");
  const candidate = JSON.parse(await readFile(candidatePath, "utf8"));
  const governanceBytes = await readFile(path.join(root, "tools/datapack/source-governance-policy.json"));
  const governancePolicy = JSON.parse(governanceBytes);
  const freshnessPolicy = await readJson("release/product-gates/datapack-freshness-sla.json");
  const candidateBytes = Buffer.from(`${JSON.stringify(candidate, null, 2)}\n`);
  await writeFile(candidatePath, candidateBytes);
  const requestPath = path.join(root, "tools/datapack/release/release-request.json");
  const request = JSON.parse(await readFile(requestPath, "utf8"));
  request.buildSpecSha256 = sha(candidateBytes);
  await writeFile(requestPath, `${JSON.stringify(request, null, 2)}\n`);
  const selectedKricSnapshotId = candidate.sourceSnapshots
    .find(({ sourceId }) => sourceId === "kric-station-convenience-standard")?.snapshotId;
  const previous = snapshots.find(({ snapshotId }) => snapshotId === selectedKricSnapshotId);
  assert.ok(previous);
  const snapshot = kric213Snapshot();
  const next = structuredClone(previous);
  next.snapshotId = snapshot.snapshotId;
  next.previousSnapshotId = previous.snapshotId;
  next.retrievedAt = snapshot.capturedAt;
  next.sourceUpdatedAt = next.retrievedAt;
  next.rowCount = snapshot.rowCount;
  next.coverageCount = 213;
  next.rawSha256 = "a".repeat(64);
  next.rawObjectUri = `oci://fixture/kric-station-convenience-standard/${next.rawSha256}.json`;
  next.redactedRequestFingerprint = snapshot.redactedRequestFingerprint;
  next.schemaFingerprint = snapshot.schemaFingerprint;
  next.contentSha256 = snapshot.contentSha256;
  next.governancePolicyVersion = governancePolicy.policyVersion;
  next.governancePolicySha256 = sha(governanceBytes);
  next.freshnessExpiresAt = deriveFreshnessExpiresAt({ policy: freshnessPolicy, sourceClassId: "static_accessibility_facility", basisAt: snapshot.capturedAt, evaluationAt: NOW.toISOString() });
  next.rawRetentionExpiresAt = deriveRawRetentionExpiresAt({ policy: governancePolicy, sourceId: next.sourceId, retrievedAt: snapshot.capturedAt });
  next.rawReceipt = {
    ...next.rawReceipt,
    snapshotId: next.snapshotId,
    snapshotRawSha256: snapshot.rawSha256,
    rawObjectSha256: next.rawSha256,
    capturedAt: next.retrievedAt,
    storedAt: new Date(CURRENT_SOURCE_HEAD_AT + 90_000).toISOString(),
    byteSize: 213,
  };
  next.diffSummary = buildSnapshotDiff(previous, next);
  snapshots.push(next);
  const source = inventory.sources.find(({ id }) => id === next.sourceId);
  next.adminReviewRecordHash = source.admissionEvidence.adminReviewRecordHash;
  const snapshotBytes = Buffer.from(`${JSON.stringify(snapshot, null, 2)}\n`);
  next.rawReceipt.snapshotFileSha256 = sha(snapshotBytes);
  const snapshotPath = path.join(root, "tools/datapack/sources", `${next.snapshotId}.json`);
  await mkdir(path.dirname(snapshotPath), { recursive: true });
  await writeFile(snapshotPath, snapshotBytes);
  source.retrievedAt = new Date(CURRENT_SOURCE_HEAD_AT + 60_000).toISOString().slice(0, 10);
  source.observedDataUpdatedAt = new Date(CURRENT_SOURCE_HEAD_AT + 60_000).toISOString().slice(0, 10);
  source.accessibilityAdmissionEvidence = {
    ...source.accessibilityAdmissionEvidence,
    snapshotId: next.snapshotId,
    capturedAt: next.retrievedAt,
    observedAt: next.sourceUpdatedAt,
    freshUntil: snapshot.freshUntil,
    rawSha256: next.rawReceipt.snapshotRawSha256,
    contentSha256: next.contentSha256,
    schemaFingerprint: next.schemaFingerprint,
    snapshotPath: `tools/datapack/sources/${next.snapshotId}.json`,
    snapshotFileSha256: sha(snapshotBytes),
    absenceEvidenceMode: "EXHAUSTIVE_LIST",
    licenseEvidenceHash: source.admissionEvidence.licenseEvidenceHash,
  };
  await writeFile(path.join(root, "tools/datapack/release/source-snapshots.json"), `${JSON.stringify(snapshots, null, 2)}\n`);
  await writeFile(path.join(root, "tools/datapack/source-inventory.json"), `${JSON.stringify(inventory, null, 2)}\n`);
  return { root, next };
}

async function selectedSourceHeadAt() {
  const [buildSpec, sourceSnapshots] = await Promise.all([
    readFile(path.join(ROOT, "tools/datapack/release/candidate-build-spec.json"), "utf8").then(JSON.parse),
    readFile(path.join(ROOT, "tools/datapack/release/source-snapshots.json"), "utf8").then(JSON.parse),
  ]);
  const selected = buildSpec.sourceSnapshotIds.map((snapshotId) => {
    const matches = sourceSnapshots.filter((entry) => entry.snapshotId === snapshotId);
    assert.equal(matches.length, 1, `selected source snapshot identity: ${snapshotId}`);
    return matches[0];
  });
  const basisAt = Math.max(...selected.flatMap((entry) => [
    entry.retrievedAt, entry.sourceUpdatedAt, entry.capturedAt, entry.rawReceipt?.storedAt,
  ].filter(Boolean).map(Date.parse)));
  const freshUntil = Math.min(...selected.map(({ freshnessExpiresAt }) => Date.parse(freshnessExpiresAt)));
  assert.ok(Number.isFinite(basisAt) && Number.isFinite(freshUntil) && basisAt + 120_000 < freshUntil);
  return basisAt;
}

async function readInput(root) {
  const load = async (relative) => {
    const bytes = await readFile(path.join(root, relative));
    return { bytes, value: JSON.parse(bytes) };
  };
  const [candidate, inventory, snapshots, pack, governance, freshness, request] = await Promise.all([
    load("tools/datapack/release/candidate-build-spec.json"), load("tools/datapack/source-inventory.json"),
    load("tools/datapack/release/source-snapshots.json"), load("tools/datapack/release/capital-production-canonical-pack.json"),
    load("tools/datapack/source-governance-policy.json"), load("release/product-gates/datapack-freshness-sla.json"),
    load("tools/datapack/release/release-request.json"),
  ]);
  const kric = inventory.value.sources.find(({ id }) => id === "kric-station-convenience-standard");
  const kricSnapshotBytes = await readFile(path.join(root, kric.accessibilityAdmissionEvidence.snapshotPath));
  return {
    candidateBuildSpec: candidate.value, candidateBuildSpecBytes: candidate.bytes, releaseRequest: request.value,
    sourceInventory: inventory.value, sourceInventoryBytes: inventory.bytes,
    sourceSnapshots: snapshots.value, canonicalPack: pack.value, governancePolicy: governance.value,
    governancePolicyBytes: governance.bytes, freshnessPolicy: freshness.value, kricSnapshotBytes, now: NOW,
  };
}

test("current canonical pack binds public positions and TRANSFER, never CyberStation or S3", async (t) => {
  const { root, next } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const before = await readInput(root);
  const capital = before.canonicalPack.packs[0];
  const capitalSourceIds = requireCurrentCanonicalSourceRoster(capital);
  assert.deepEqual(capitalSourceIds.slice(0, CURRENT_CAPITAL_BASE_SOURCE_IDS.length), CURRENT_CAPITAL_BASE_SOURCE_IDS);
  assert.ok(capitalSourceIds.length > CURRENT_CAPITAL_BASE_SOURCE_IDS.length);
  assert.deepEqual(capitalSourceIds, capital.sourceInventory.map(({ id }) => id));
  assert.equal(capital.sourceInventory.some(({ id, url }) => id === "seoulmetro-cyberstation-route-map" || /amazonaws\.com|s3:/u.test(url ?? "")), false);
  assert.deepEqual(
    JSON.parse(capital.metadata.productionCoverageEvidence).find(({ sourceDomain }) => sourceDomain === "route_map_positions")?.sourceIds,
    ["seoul-metro-route-map-positions"],
  );
  assert.deepEqual(
    JSON.parse(capital.metadata.productionCoverageEvidence).find(({ sourceDomain }) => sourceDomain === "transfer_walk_duration")?.sourceIds,
    ["seoul-metro-transfer-distance-duration"],
  );
  const old = before.candidateBuildSpec;
  const rebound = rebindCandidateSourceSnapshots(before);
  const changed = Object.keys(old).filter((key) => JSON.stringify(old[key]) !== JSON.stringify(rebound[key]));
  const expectedChanged = ["networkEdgeEvidence", "sourceInventorySha256", "sourceSnapshotIds", "sourceSnapshots", "sourceSnapshotSetHash"];
  if (old.publishedAt !== NOW.toISOString()) expectedChanged.push("publishedAt");
  assert.deepEqual(changed.sort((left, right) => left.localeCompare(right, "en")), expectedChanged.sort((left, right) => left.localeCompare(right, "en")));
  const kric = rebound.sourceSnapshots.find(({ sourceId }) => sourceId === "kric-station-convenience-standard");
  assert.equal(kric.snapshotId, next.snapshotId);
  assert.equal(rebound.sourceSnapshotIds.includes(next.snapshotId), true);
  assert.equal(rebound.sourceSnapshotIds.includes("kric-station-convenience-standard-20260813T200604805Z"), false);
  assert.deepEqual(
    rebound.sourceSnapshots
      .map(({ sourceId }) => sourceId)
      .filter((sourceId) => capitalSourceIds.slice(CURRENT_CAPITAL_BASE_SOURCE_IDS.length).includes(sourceId)),
    ["incheon-transit-accessibility"],
  );
  assert.notEqual(rebound.sourceSnapshotSetHash, old.sourceSnapshotSetHash);
  const selectedIds = new Set(rebound.sourceSnapshotIds);
  assert.equal(rebound.sourceSnapshotSetHash, sha(JSON.stringify(before.sourceSnapshots.filter(({ snapshotId }) => selectedIds.has(snapshotId)))));
  assert.equal(rebound.sourceInventorySha256, sha(JSON.stringify(before.sourceInventory)));
  assert.equal(rebound.networkEdgeEvidence.sourceInventory.sha256, sha(before.sourceInventoryBytes));
  assert.notEqual(rebound.sourceInventorySha256, rebound.networkEdgeEvidence.sourceInventory.sha256);
  assert.equal(rebound.candidateId, old.candidateId);
  assert.equal(rebound.publishedAt, NOW.toISOString());
  assert.ok(Date.parse(rebound.publishedAt) > Date.parse(next.retrievedAt));
});

test("current seven-source candidate appends TRANSFER as the eighth exact source", async (t) => {
  const { root } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = await readInput(root);
  const preTransferCandidate = structuredClone(input.candidateBuildSpec);
  preTransferCandidate.sourceSnapshots = preTransferCandidate.sourceSnapshots.filter(
    ({ sourceId }) => sourceId !== "seoul-metro-transfer-distance-duration",
  );
  preTransferCandidate.sourceSnapshotIds = preTransferCandidate.sourceSnapshots.map(({ snapshotId }) => snapshotId);
  const selectedSnapshotIds = new Set(preTransferCandidate.sourceSnapshotIds);
  preTransferCandidate.sourceSnapshotSetHash = sha(JSON.stringify(
    input.sourceSnapshots.filter(({ snapshotId }) => selectedSnapshotIds.has(snapshotId)),
  ));
  const projection = {
    ...preTransferCandidate.sourceSnapshots[0],
    sourceId: "seoul-metro-transfer-distance-duration",
    snapshotId: "seoul-metro-transfer-distance-duration-20260712T150000000Z",
  };
  const rebound = appendTransferCandidateSourceSnapshot({
    candidateBuildSpec: preTransferCandidate,
    transferSnapshot: { sourceId: projection.sourceId, snapshotId: projection.snapshotId },
    transferProjection: projection,
  });
  assert.deepEqual(rebound.sourceSnapshots.map(({ sourceId }) => sourceId), CURRENT_FULL_CANDIDATE_SOURCE_IDS);
  assert.deepEqual(rebound.sourceSnapshots.slice(0, 7), preTransferCandidate.sourceSnapshots);
  assert.equal(rebound.sourceSnapshots.at(-1).sourceId, "seoul-metro-transfer-distance-duration");
});

test("additive governance successor preserves only approved non-TRANSFER prior projections", async (t) => {
  const { root } = await fixture(); t.after(() => rm(root, { recursive: true, force: true }));
  const input = await readInput(root); const expected = input.candidateBuildSpec.sourceSnapshots.find(({ sourceId }) => sourceId === "molit-urban-rail-full-route");
  const snapshot = input.sourceSnapshots.find(({ snapshotId }) => snapshotId === expected.snapshotId);
  assert.deepEqual(deriveReleaseProjection({ snapshot, sourceInventory: input.sourceInventory, governancePolicy: input.governancePolicy, governancePolicyBytes: input.governancePolicyBytes, freshnessPolicy: input.freshnessPolicy, nowMillis: NOW.valueOf() }), expected);
  for (const mutate of [
    (value) => {
      value.sourceId = "seoul-metro-transfer-distance-duration";
      value.governancePolicySha256 = "96fb678f2ec5da7f555d81d9d2009ac838e6145cc48ed2ae4757bce42c90ef70";
    },
    (value) => { value.governancePolicySha256 = "0".repeat(64); },
    (value) => { value.governancePolicyVersion = "2099-01-01"; },
  ]) {
    const invalid = structuredClone(snapshot); mutate(invalid);
    assert.throws(() => approvedGovernanceBindingTransition({ snapshot: invalid, currentPolicyVersion: input.governancePolicy.policyVersion, currentPolicySha256: sha(input.governancePolicyBytes) }), /governance policy binding/);
  }
});

test("rebind atomically preserves release authority while binding all release artifacts", async (t) => {
  const { root } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const requestBefore = await readFile(path.join(root, "tools/datapack/release/release-request.json"));
  const requestIdentity = JSON.parse(requestBefore);
  const result = await rebindCurrentCandidateSourceSnapshots({ repositoryRoot: root, now: NOW });
  const request = JSON.parse(await readFile(path.join(root, "tools/datapack/release/release-request.json"), "utf8"));
  const evidence = JSON.parse(await readFile(path.join(root, "tools/datapack/release/hash-evidence.json"), "utf8"));
  assert.equal(request.approvalId, requestIdentity.approvalId);
  assert.equal(request.requestedBy, requestIdentity.requestedBy);
  assert.equal(request.approvedBy, requestIdentity.approvedBy);
  const violations = releaseRequestBindingViolations({
    buildSpec: result.candidate,
    buildSpecSha256: sha(result.bytes),
    releaseRequest: request,
  });
  assert.deepEqual(violations, []);
  assert.equal(evidence.sourceSnapshotSetHash.value, result.candidate.sourceSnapshotSetHash);
  assert.equal(evidence.sourceInventorySha256.value, result.candidate.sourceInventorySha256);
  assert.deepEqual(evidence.perSourceEvidence.map(({ snapshotId }) => snapshotId), JSON.parse(await readFile(path.join(root, "tools/datapack/release/source-snapshots.json"), "utf8"))
    .filter(({ snapshotId }) => result.candidate.sourceSnapshotIds.includes(snapshotId)).map(({ snapshotId }) => snapshotId));
  await assert.rejects(readFile(path.join(root, "tools/datapack/.candidate-source-rebind-transaction.json")), { code: "ENOENT" });
});

test("CLI rejects candidate source-inventory and raw-inventory-hash drift before replacement", async (t) => {
  for (const mutate of [
    (candidate) => { candidate.sourceInventorySha256 = "0".repeat(64); },
    (candidate) => { candidate.networkEdgeEvidence.sourceInventory.sha256 = "0".repeat(64); },
  ]) {
    const { root } = await fixture();
    t.after(() => rm(root, { recursive: true, force: true }));
    const candidatePath = path.join(root, "tools/datapack/release/candidate-build-spec.json");
    const candidate = JSON.parse(await readFile(candidatePath, "utf8"));
    mutate(candidate);
    const mutated = Buffer.from(`${JSON.stringify(candidate, null, 2)}\n`);
    await writeFile(candidatePath, mutated);
    await assert.rejects(rebindCurrentCandidateSourceSnapshots({ repositoryRoot: root, now: NOW }));
    assert.deepEqual(await readFile(candidatePath), mutated);
  }
});

test("pure rebind rejects objects that drift from their authenticated raw buffers", async (t) => {
  for (const mutate of [
    (input) => { input.candidateBuildSpec.unboundCandidateDrift = true; },
    (input) => { input.sourceInventory.unboundInventoryDrift = true; },
    (input) => { input.governancePolicy.unboundGovernanceDrift = true; },
  ]) {
    const { root } = await fixture();
    t.after(() => rm(root, { recursive: true, force: true }));
    const input = await readInput(root);
    mutate(input);
    assert.throws(() => rebindCandidateSourceSnapshots(input), /not bound to their authenticated bytes/);
  }
});

test("interleaving candidate replacement preserves the newer target", async (t) => {
  const { root } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = path.join(root, "tools/datapack/release/candidate-build-spec.json");
  const newer = Buffer.from(`${await readFile(target, "utf8")}\n`);
  await assert.rejects(rebindCurrentCandidateSourceSnapshots({
    repositoryRoot: root,
    now: NOW,
    beforeReplace: async () => { await rm(target); await writeFile(target, newer); },
  }), /candidate changed during rebind/);
  assert.deepEqual(await readFile(target), newer);
});

test("failed staged write removes the owned temporary candidate file", async (t) => {
  const { root } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = path.join(root, "tools/datapack/release/candidate-build-spec.json");
  const before = await readFile(target);
  await assert.rejects(atomicReplace(target, Buffer.from("replacement"), {
    openImpl: async (...args) => {
      const handle = await open(...args);
      return new Proxy(handle, {
        get(value, key) {
          if (key === "writeFile") return async () => { throw new Error("injected write failure"); };
          const member = Reflect.get(value, key, value);
          return typeof member === "function" ? member.bind(value) : member;
        },
      });
    },
  }), /injected write failure/);
  assert.deepEqual(await readFile(target), before);
  const entries = await readdir(path.dirname(target));
  assert.equal(entries.some((entry) => entry.startsWith(".candidate-build-spec.json.") && entry.endsWith(".tmp")), false);
});

test("unsafe target, input race, lock residue and replace failure leave candidate bytes unchanged", async (t) => {
  const failures = [
    async ({ root }) => {
      const target = path.join(root, "tools/datapack/release/candidate-build-spec.json");
      const original = await readFile(target);
      await rm(target);
      await symlink("release-request.json", target);
      return { cleanup: async () => { await rm(target); await writeFile(target, original); } };
    },
    async ({ root }) => {
      const target = path.join(root, "tools/datapack/source-inventory.json");
      const original = await readFile(target);
      await rm(target);
      await symlink("release/candidate-build-spec.json", target);
      return { cleanup: async () => { await rm(target); await writeFile(target, original); } };
    },
    async ({ root }) => {
      const target = path.join(root, "tools/datapack/release/source-snapshots.json");
      const original = await readFile(target);
      await rm(target);
      await mkdir(target);
      return { cleanup: async () => { await rm(target, { recursive: true }); await writeFile(target, original); } };
    },
    async ({ root }) => {
      const target = path.join(root, "release/product-gates/datapack-freshness-sla.json");
      const original = await readFile(target);
      await rm(target);
      return { cleanup: async () => writeFile(target, original) };
    },
    async () => ({ beforeReplace: async ({ input }) => writeFile(input.inventory.target, input.inventory.bytes) }),
    async ({ root }) => {
      const lock = path.join(root, "tools/datapack/.candidate-source-rebind.lock");
      await mkdir(lock);
      return { cleanup: () => rm(lock, { recursive: true, force: true }) };
    },
    async () => ({ atomicReplaceImpl: async () => { throw new Error("injected replace failure"); } }),
  ];
  for (const setup of failures) {
    const { root } = await fixture();
    const candidatePath = path.join(root, "tools/datapack/release/candidate-build-spec.json");
    const before = await readFile(candidatePath);
    const options = await setup({ root });
    await assert.rejects(rebindCurrentCandidateSourceSnapshots({ repositoryRoot: root, now: NOW, ...options }));
    if (options.cleanup) await options.cleanup();
    assert.deepEqual(await readFile(candidatePath), before);
    await rm(root, { recursive: true, force: true });
  }
});

test("head, source identity, receipt, governance and inventory binding drifts fail before mutation", async (t) => {
  const mutations = [
    (input) => { input.sourceSnapshots.at(-1).previousSnapshotId = "wrong"; },
    (input) => { input.candidateBuildSpec.sourceSnapshots[0].snapshotId = "wrong"; },
    (input) => { input.sourceInventory.sources.push(structuredClone(input.sourceInventory.sources[0])); },
    (input) => { input.sourceSnapshots.at(-1).rawReceipt.byteSize = 0; },
    (input) => { input.sourceSnapshots.at(-1).coverageCount = 212; },
    (input) => { input.sourceSnapshots.at(-1).governancePolicySha256 = "0".repeat(64); },
    (input) => { input.candidateBuildSpec.networkEdgeEvidence.sourceInventory.path = "wrong"; },
    (input) => { input.candidateBuildSpec.sourceSnapshots.reverse(); input.candidateBuildSpec.sourceSnapshotIds.reverse(); },
    (input) => { input.candidateBuildSpec.sourceSnapshots[0].adminReviewRecordHash = "0".repeat(64); },
    (input) => { input.sourceInventory.sources.find(({ id }) => id === "kric-station-convenience-standard").admissionEvidence.decision = "REJECTED"; },
    (input) => { input.sourceInventory.sources.find(({ id }) => id === "kric-station-convenience-standard").accessibilityAdmissionEvidence.snapshotFileSha256 = "0".repeat(64); },
    (input) => { input.sourceSnapshots.at(-1).rawReceipt.snapshotFileSha256 = "0".repeat(64); },
    (input) => { input.sourceSnapshots.at(-1).rawReceipt.capturedAt = "2026-08-16T11:00:01.000Z"; },
    (input) => { input.sourceInventory.sources.find(({ id }) => id === "kric-station-convenience-standard").accessibilityAdmissionEvidence.absenceEvidenceMode = "UNVERIFIED"; },
    (input) => {
      const snapshot = JSON.parse(input.kricSnapshotBytes);
      snapshot.freshUntil = "2026-08-16T10:59:59.000Z";
      input.kricSnapshotBytes = Buffer.from(`${JSON.stringify(snapshot)}\n`);
    },
    (input) => { input.governancePolicy.sources.find(({ sourceId }) => sourceId === "kric-station-convenience-standard").licenseReview.nextReviewAt = "2026-08-14T00:00:00.000Z"; },
    (input) => {
      const next = input.sourceSnapshots.at(-1);
      next.rawRetentionExpiresAt = "2026-08-15T11:00:31.000Z";
      next.diffSummary = buildSnapshotDiff(input.sourceSnapshots.find(({ snapshotId }) => snapshotId === next.previousSnapshotId), next);
    },
    (input) => {
      const pack = input.canonicalPack.packs[0];
      const seoulMetro = new Set(pack.lines.filter(({ operatorId }) => operatorId === "seoul-metro").map(({ id }) => id));
      pack.stationLines.push(structuredClone(pack.stationLines.find(({ lineId }) => seoulMetro.has(lineId))));
    },
    (input) => { input.canonicalPack.packs[0].sourceInventory.pop(); },
    (input) => { input.canonicalPack.packs[0].sourceInventory.push({ id: "retired-maglev-source" }); },
    (input) => {
      const sourceInventory = input.canonicalPack.packs[0].sourceInventory;
      sourceInventory.push(structuredClone(sourceInventory.at(-1)));
    },
    (input) => { input.canonicalPack.packs[0].sourceInventory.push({ id: "unreferenced-regional-source" }); },
    (input) => {
      const pack = input.canonicalPack.packs[0];
      pack.sourceInventory.push({ id: "incomplete-provenance-source" });
      pack.stations.push({ sourceId: "incomplete-provenance-source" });
    },
    (input) => {
      const sourceInventory = input.canonicalPack.packs[0].sourceInventory;
      [sourceInventory[0], sourceInventory[1]] = [sourceInventory[1], sourceInventory[0]];
    },
    (input) => {
      const retired = structuredClone(input.sourceSnapshots[0]);
      retired.snapshotId = "seoul-metro-official-od-fares-retired-head";
      retired.sourceId = "seoul-metro-official-od-fares";
      retired.previousSnapshotId = null;
      retired.diffSummary = null;
      input.sourceSnapshots.push(retired);
    },
  ];
  for (const [index, mutate] of mutations.entries()) {
    const { root } = await fixture();
    const input = await readInput(root);
    mutate(input);
    assert.throws(() => rebindCandidateSourceSnapshots(input), undefined, `mutation ${index} must fail closed`);
    await rm(root, { recursive: true, force: true });
  }
});
