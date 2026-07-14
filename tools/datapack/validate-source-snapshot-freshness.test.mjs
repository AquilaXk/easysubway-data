import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  assertRepositoryRelativePath,
  validateSourceSnapshotFreshness,
} from "./validate-source-snapshot-freshness.mjs";

const evaluationAt = "2026-07-15T00:00:00.000Z";
const policy = {
  clockSkewSeconds: 300,
  sourceClasses: [{
    id: "static_network_metadata",
    sourceIds: ["source-a"],
    basisField: "retrievedAt",
    reverificationCadence: "P30D",
  }],
};

function input(overrides = {}) {
  const snapshots = [{
    snapshotId: "snapshot-a",
    sourceId: "source-a",
    rawObjectUri: "s3://bucket/snapshot-a.json",
    rawSha256: "a".repeat(64),
    redactedRequestFingerprint: "b".repeat(64),
    schemaFingerprint: "c".repeat(64),
    licenseStatus: "PASS",
    redistributionAllowed: true,
    snapshotStatus: "LOCKED",
    credentialRedacted: true,
    retrievedAt: "2026-07-12T00:00:00Z",
    freshnessExpiresAt: "2026-08-11T00:00:00Z",
    ...overrides,
  }];
  return {
    snapshots,
    buildSpec: {
      sourceSnapshotIds: ["snapshot-a"],
      sourceSnapshots: snapshots.map((snapshot) => ({
        snapshotId: snapshot.snapshotId,
        sourceId: snapshot.sourceId,
        rawObjectUri: snapshot.rawObjectUri,
        rawSha256: snapshot.rawSha256,
        redactedRequestFingerprint: snapshot.redactedRequestFingerprint,
        schemaFingerprint: snapshot.schemaFingerprint,
        licenseStatus: snapshot.licenseStatus,
        redistributionAllowed: snapshot.redistributionAllowed,
        snapshotStatus: snapshot.snapshotStatus,
        credentialRedacted: snapshot.credentialRedacted,
        freshnessExpiresAt: snapshot.freshnessExpiresAt,
      })),
      sourceSnapshotSetHash: createHash("sha256").update(JSON.stringify(snapshots)).digest("hex"),
    },
    policy,
    evaluationAt,
  };
}

test("source snapshot ID·hash·policy 파생 freshness가 맞으면 통과한다", () => {
  const result = validateSourceSnapshotFreshness(input());

  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].status, "FRESH");
});

test("source snapshot evidence의 absolute relative-result를 거부한다", () => {
  assert.throws(
    () => assertRepositoryRelativePath("/other-drive/snapshots.json"),
    /must stay within the repository/,
  );
});

test("저장된 far-future expiry는 fail closed한다", () => {
  assert.throws(
    () => validateSourceSnapshotFreshness(input({ freshnessExpiresAt: "2099-08-01T00:00:00Z" })),
    /SOURCE_FRESHNESS_DERIVATION_MISMATCH/,
  );
});

test("build spec의 snapshot ID와 evidence가 다르면 fail closed한다", () => {
  const value = input();
  value.buildSpec.sourceSnapshotIds = ["snapshot-other"];

  assert.throws(() => validateSourceSnapshotFreshness(value), /source snapshot IDs/);
});

test("build provenance와 검증 evidence의 snapshot 내용이 다르면 fail closed한다", () => {
  const value = input();
  value.buildSpec.sourceSnapshots[0].rawObjectUri = "s3://bucket/other.json";

  assert.throws(
    () => validateSourceSnapshotFreshness(value),
    /source snapshot provenance/,
  );
});

test("build admission hash와 canonical snapshot hash는 의미가 달라도 freshness를 검증한다", () => {
  const value = input();
  value.buildSpec.sourceSnapshots[0].rawSha256 = "d".repeat(64);
  value.buildSpec.sourceSnapshots[0].schemaFingerprint = "e".repeat(64);

  const result = validateSourceSnapshotFreshness(value);

  assert.equal(result.results[0].status, "FRESH");
});
