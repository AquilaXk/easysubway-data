import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdtemp, mkdir, open, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildSnapshotDiff } from "./source-snapshot-policy.mjs";
import {
  atomicReplace,
  rebindCandidateSourceSnapshots,
  rebindCurrentCandidateSourceSnapshots,
} from "./rebind-current-candidate-source-snapshots.mjs";
import { KRIC_ACCESSIBILITY_OPERATIONS } from "./collect-kric-accessibility-snapshots.mjs";
import { releaseRequestBindingViolations } from "./verify-release-request-binding.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const NOW = new Date("2026-08-15T12:00:00.000Z");
const RELATIVE = [
  "tools/datapack/release/candidate-build-spec.json",
  "tools/datapack/source-inventory.json",
  "tools/datapack/release/source-snapshots.json",
  "tools/datapack/release/capital-production-canonical-pack.json",
  "tools/datapack/source-governance-policy.json",
  "release/product-gates/datapack-freshness-sla.json",
  "tools/datapack/release/release-request.json",
  "tools/datapack/release/hash-evidence.json",
];
const sha = (value) => createHash("sha256").update(value).digest("hex");
const jsonSha = (value) => sha(Buffer.from(JSON.stringify(value)));

function kric213Snapshot() {
  const operation = KRIC_ACCESSIBILITY_OPERATIONS[0];
  const capturedAt = "2026-08-15T11:00:00.000Z";
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
    snapshotId: "kric-station-convenience-standard-20260815T110000000Z", capturedAt, observedAt: capturedAt,
    freshUntil: "2026-08-16T11:00:00.000Z", providerResultCode: "00", schemaStatus: "PASS",
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
  for (const relative of RELATIVE) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await cp(path.join(ROOT, relative), target);
  }
  const readJson = async (relative) => JSON.parse(await readFile(path.join(root, relative), "utf8"));
  const snapshots = await readJson("tools/datapack/release/source-snapshots.json");
  const inventory = await readJson("tools/datapack/source-inventory.json");
  const previous = snapshots.find(({ snapshotId }) => snapshotId === "kric-station-convenience-standard-20260813T200604805Z");
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
  next.rawObjectUri = "s3://easysubway-datapack-sources/kric-station-convenience-standard/20260815/" + next.rawSha256 + ".json";
  next.redactedRequestFingerprint = snapshot.redactedRequestFingerprint;
  next.schemaFingerprint = snapshot.schemaFingerprint;
  next.contentSha256 = snapshot.contentSha256;
  next.freshnessExpiresAt = "2026-11-13T11:00:00.000Z";
  next.rawRetentionExpiresAt = "2026-11-13T11:00:00.000Z";
  next.rawReceipt = {
    ...next.rawReceipt,
    snapshotId: next.snapshotId,
    snapshotRawSha256: snapshot.rawSha256,
    rawObjectSha256: next.rawSha256,
    capturedAt: next.retrievedAt,
    storedAt: "2026-08-15T11:00:30.000Z",
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
  source.retrievedAt = "2026-08-15";
  source.observedDataUpdatedAt = "2026-08-15";
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

test("RED old candidate KRIC head cannot satisfy current FACILITY identity; GREEN rebind changes only closed fields", async (t) => {
  const { root, next } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const before = await readInput(root);
  const old = before.candidateBuildSpec;
  const rebound = rebindCandidateSourceSnapshots(before);
  const changed = Object.keys(old).filter((key) => JSON.stringify(old[key]) !== JSON.stringify(rebound[key]));
  assert.deepEqual(changed.sort((left, right) => left.localeCompare(right, "en")), ["networkEdgeEvidence", "sourceInventorySha256", "sourceSnapshotIds", "sourceSnapshots", "sourceSnapshotSetHash"]);
  const kric = rebound.sourceSnapshots.find(({ sourceId }) => sourceId === "kric-station-convenience-standard");
  assert.equal(kric.snapshotId, next.snapshotId);
  assert.equal(rebound.sourceSnapshotIds.includes(next.snapshotId), true);
  assert.equal(rebound.sourceSnapshotIds.includes("kric-station-convenience-standard-20260813T200604805Z"), false);
  assert.notEqual(rebound.sourceSnapshotSetHash, old.sourceSnapshotSetHash);
  assert.equal(rebound.sourceInventorySha256, sha(JSON.stringify(before.sourceInventory)));
  assert.equal(rebound.networkEdgeEvidence.sourceInventory.sha256, sha(before.sourceInventoryBytes));
  assert.notEqual(rebound.sourceInventorySha256, rebound.networkEdgeEvidence.sourceInventory.sha256);
  assert.equal(rebound.candidateId, old.candidateId);
  assert.equal(rebound.publishedAt, old.publishedAt);
});

test("release request/hash evidence remain byte-identical and stale approval fails closed", async (t) => {
  const { root } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const requestBefore = await readFile(path.join(root, "tools/datapack/release/release-request.json"));
  const hashesBefore = await readFile(path.join(root, "tools/datapack/release/hash-evidence.json"));
  const result = await rebindCurrentCandidateSourceSnapshots({ repositoryRoot: root, now: NOW });
  assert.deepEqual(await readFile(path.join(root, "tools/datapack/release/release-request.json")), requestBefore);
  assert.deepEqual(await readFile(path.join(root, "tools/datapack/release/hash-evidence.json")), hashesBefore);
  const violations = releaseRequestBindingViolations({
    buildSpec: result.candidate,
    buildSpecSha256: sha(result.bytes),
    releaseRequest: JSON.parse(requestBefore),
  });
  assert.ok(violations.some((violation) => /sourceSnapshotSetHash/.test(violation)));
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
    (input) => { input.sourceSnapshots.at(-1).rawReceipt.capturedAt = "2026-08-15T11:00:01.000Z"; },
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
