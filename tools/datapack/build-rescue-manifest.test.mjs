import assert from "node:assert/strict";
import { createHash, createSign, generateKeyPairSync } from "node:crypto";
import test from "node:test";

import { buildRescueManifest } from "./build-rescue-manifest.mjs";
import { canonicalJson, validateManifest, withoutSignature } from "./lib/manifest-validation.mjs";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" });
const publicKeyPem = publicKey.export({ type: "spki", format: "pem" });
const previousPublicKey = process.env.EASYSUBWAY_DATAPACK_SIGNING_PUBLIC_KEY_PEM;
process.env.EASYSUBWAY_DATAPACK_SIGNING_PUBLIC_KEY_PEM = publicKeyPem;

test.after(() => {
  if (previousPublicKey === undefined) delete process.env.EASYSUBWAY_DATAPACK_SIGNING_PUBLIC_KEY_PEM;
  else process.env.EASYSUBWAY_DATAPACK_SIGNING_PUBLIC_KEY_PEM = previousPublicKey;
});

test("current, failed, immutable catalog 최대값보다 큰 rescue sequence를 만든다", () => {
  const current = manifest(115);
  const knownGood = manifest(114);
  const knownGoodBytes = bytes(knownGood);
  const result = buildRescueManifest({
    currentManifest: current,
    currentManifestBytes: bytes(current),
    failedSequence: 115,
    knownGoodManifest: knownGood,
    knownGoodManifestBytes: knownGoodBytes,
    catalogSequences: [114, 115, 120],
    approval: approved(current, knownGood),
    publishedAt: "2026-07-15T01:00:00.000Z",
    expiresAt: "2026-07-16T01:00:00.000Z",
    now: new Date("2026-07-15T01:00:00.000Z"),
    privateKey: privateKeyPem,
  });

  assert.equal(result.manifest.releaseSequence, 121);
  assert.deepEqual(result.manifest.packs, knownGood.packs);
  assert.deepEqual(result.manifest.rollbackProvenance, {
    kind: "MONOTONIC_RESCUE",
    currentReleaseSequence: 115,
    failedReleaseSequence: 115,
    failedManifestSha256: sha256(bytes(current)),
    knownGoodReleaseSequence: 114,
    knownGoodManifestSha256: sha256(knownGoodBytes),
    rollbackApprovalEventId: "release-channel-event-1",
    approvedByRole: "release-manager",
    approvedAt: "2026-07-15T00:30:00.000Z",
    reasonCode: "FAILED_RELEASE",
  });
  assert.equal(result.evidence.from.releaseSequence, 115);
  assert.equal(result.evidence.failed.releaseSequence, 115);
  assert.equal(result.evidence.knownGood.manifestSha256, sha256(knownGoodBytes));
  assert.equal(result.evidence.rescue.releaseSequence, 121);
  assert.match(result.evidence.rescue.manifestSha256, /^[a-f0-9]{64}$/);
});

test("동일 승인 입력은 바이트가 같은 rescue manifest를 만든다", () => {
  const input = validInput();
  const first = buildRescueManifest(input);
  const second = buildRescueManifest(input);
  assert.deepEqual(first.manifestBytes, second.manifestBytes);
  assert.equal(first.evidence.rescue.manifestSha256, second.evidence.rescue.manifestSha256);
});

test("failed sequence와 current identity가 다르면 fail closed한다", () => {
  assert.throws(
    () => buildRescueManifest({ ...validInput(), failedSequence: 116 }),
    /failedSequence must match current manifest releaseSequence/,
  );
});

test("catalog sequence는 중복 없는 양의 정수여야 한다", () => {
  assert.throws(
    () => buildRescueManifest({ ...validInput(), catalogSequences: [114, 115, 115] }),
    /catalogSequences must not contain duplicates/,
  );
  assert.throws(
    () => buildRescueManifest({ ...validInput(), catalogSequences: [114, 0] }),
    /catalogSequences\[\] must be a positive integer/,
  );
  assert.throws(
    () => buildRescueManifest({ ...validInput(), catalogSequences: [114, 120] }),
    /catalogSequences must contain current and known-good releases/,
  );
});

test("승인 provenance와 유효한 새 시간 경계를 필수로 한다", () => {
  for (const field of [
    "rollbackApprovalEventId", "targetChannel", "failedManifestSha256", "knownGoodManifestSha256",
    "approvedBy", "approvedByRole", "approvedAt", "reasonCode",
  ]) {
    const approval = approved();
    delete approval[field];
    assert.throws(() => buildRescueManifest({ ...validInput(), approval }), new RegExp(`approval\\.${field}`));
  }
  assert.throws(
    () => buildRescueManifest({ ...validInput(), expiresAt: "2026-07-15T00:59:59.000Z" }),
    /expiresAt must be after publishedAt/,
  );
  for (const expiresAt of ["2026-07-15T01:30:00.000Z", "2026-07-15T02:00:00.000Z"]) {
    assert.throws(
      () => buildRescueManifest({
        ...validInput(),
        expiresAt,
        now: new Date("2026-07-15T02:00:00.000Z"),
      }),
      /expiresAt must be in the future/,
    );
  }
  assert.throws(
    () => buildRescueManifest({
      ...validInput(),
      approval: { ...approved(), approvedAt: "2026-07-15T01:00:01.000Z" },
    }),
    /approval.approvedAt must not be after publishedAt/,
  );
  assert.throws(
    () => buildRescueManifest({ ...validInput(), approval: { ...approved(), reasonCode: "free form secret" } }),
    /approval.reasonCode is invalid/,
  );
});

test("known-good는 같은 channel의 더 낮은 signed v2 release여야 한다", () => {
  const sameSequence = manifest(115);
  assert.throws(
    () => buildRescueManifest({
      ...validInput(),
      knownGoodManifest: sameSequence,
      knownGoodManifestBytes: bytes(sameSequence),
    }),
    /known-good releaseSequence must be lower than failedSequence/,
  );
  const otherChannel = manifest(114, { channel: "production" });
  assert.throws(
    () => buildRescueManifest({
      ...validInput(),
      knownGoodManifest: otherChannel,
      knownGoodManifestBytes: bytes(otherChannel),
    }),
    /known-good channel must match current channel/,
  );
  const tampered = manifest(114);
  tampered.ttlSeconds += 1;
  assert.throws(
    () => buildRescueManifest({ ...validInput(), knownGoodManifest: tampered, knownGoodManifestBytes: bytes(tampered) }),
    /manifest signature mismatch/,
  );

  for (const field of ["current", "knownGood"]) {
    const legacy = manifest(field === "current" ? 115 : 114, { manifestVersion: 1 });
    assert.throws(
      () => buildRescueManifest({
        ...validInput(),
        [`${field}Manifest`]: legacy,
        [`${field}ManifestBytes`]: bytes(legacy),
      }),
      /current and known-good manifests must be v2/,
    );
  }
});

test("production-equivalent RSA private key가 없으면 rescue 서명을 만들지 않는다", () => {
  assert.throws(
    () => buildRescueManifest({ ...validInput(), privateKey: undefined }),
    /signing private key is required/,
  );
});

test("staging fixture rescue는 private key 없이 fixture 서명 계약을 유지한다", () => {
  const current = fixtureManifest(115);
  const knownGood = fixtureManifest(114);
  const result = buildRescueManifest({
    ...validInput(),
    currentManifest: current,
    currentManifestBytes: bytes(current),
    knownGoodManifest: knownGood,
    knownGoodManifestBytes: bytes(knownGood),
    approval: approved(current, knownGood),
    privateKey: undefined,
  });

  assert.equal(result.manifest.signature.algorithm, "sha256-manifest-v2");
  assert.doesNotThrow(() => validateManifest(result.manifest, { releasesTarget: true }));
});

test("known-good의 지속 pack 선택만 보존하고 rollout은 제거한다", () => {
  const activePack = { id: "capital", version: "1" };
  const emergencyOverride = { ...activePack, reason: "KNOWN_GOOD_OVERRIDE" };
  const knownGood = manifest(114, {
    activePack,
    emergencyOverride,
    rollout: { percentage: 10, seed: "0123456789abcdef0123456789abcdef" },
  });
  const input = validInput();
  const result = buildRescueManifest({
    ...input,
    knownGoodManifest: knownGood,
    knownGoodManifestBytes: bytes(knownGood),
    approval: approved(input.currentManifest, knownGood),
  });

  assert.deepEqual(result.manifest.activePack, activePack);
  assert.deepEqual(result.manifest.emergencyOverride, emergencyOverride);
  assert.equal(result.manifest.rollout, undefined);
});

function validInput() {
  const current = manifest(115);
  const knownGood = manifest(114);
  return {
    currentManifest: current,
    currentManifestBytes: bytes(current),
    failedSequence: 115,
    knownGoodManifest: knownGood,
    knownGoodManifestBytes: bytes(knownGood),
    catalogSequences: [114, 115],
    approval: approved(current, knownGood),
    publishedAt: "2026-07-15T01:00:00.000Z",
    expiresAt: "2026-07-16T01:00:00.000Z",
    now: new Date("2026-07-15T01:00:00.000Z"),
    privateKey: privateKeyPem,
  };
}

function approved(current = manifest(115), knownGood = manifest(114)) {
  return {
    schemaVersion: 1,
    artifactKind: "datapack-rollback-approval",
    rollbackApprovalEventId: "release-channel-event-1",
    targetChannel: current.channel,
    failedManifestSha256: sha256(bytes(current)),
    knownGoodManifestSha256: sha256(bytes(knownGood)),
    approvedBy: "release-approver",
    approvedByRole: "release-manager",
    approvedAt: "2026-07-15T00:30:00.000Z",
    reasonCode: "FAILED_RELEASE",
  };
}

function manifest(releaseSequence, overrides = {}) {
  const value = {
    manifestVersion: 2,
    channel: "staging",
    releaseSequence,
    publishedAt: "2026-07-14T00:00:00.000Z",
    expiresAt: "2026-07-20T00:00:00.000Z",
    keyId: "production-v1",
    ttlSeconds: 3600,
    packs: [pack()],
    ...overrides,
  };
  value.signature = {
    algorithm: "rsa-sha256-manifest-v2",
    value: sign(canonicalJson(withoutSignature(value))),
  };
  return value;
}

function fixtureManifest(releaseSequence) {
  const value = manifest(releaseSequence, {
    keyId: "fixture-key",
    packs: [fixturePack()],
  });
  value.signature = {
    algorithm: "sha256-manifest-v2",
    value: sha256(canonicalJson(withoutSignature(value))),
  };
  return value;
}

function fixturePack() {
  const value = {
    ...pack(),
    artifactKind: "fixture",
    url: "catalog/capital-v1.sqlite.gz",
  };
  const payload = `${value.id}:${value.version}:${value.sha256}:${value.sqliteSha256}:${value.sizeBytes}`;
  value.signature = { algorithm: "sha256-pack-manifest-v2", value: sha256(payload) };
  value.representativeRouteRegressionSignature = {
    algorithm: "sha256-route-regression-v1",
    value: sha256(`${payload}:${JSON.stringify(value.representativeRouteRegressions)}`),
  };
  return value;
}

function pack() {
  return {
    id: "capital",
    version: "1",
    artifactKind: "production",
    url: "https://cdn.example.com/catalog/capital-v1.sqlite.gz",
    sha256: sha256("pack"),
    sqliteSha256: sha256("sqlite"),
    sizeBytes: 4,
    signature: { algorithm: "rsa-sha256-pack-manifest-v2", value: sign("pack") },
    schemaVersion: "1",
    sourceInventory: [{
      id: "source",
      owner: "owner",
      url: "https://data.example.com/source",
      license: "CC-BY-4.0",
      licenseStatus: "redistributable",
      redistributionAllowed: true,
      updateFrequency: "daily",
      updatedAt: "2026-07-14T00:00:00.000Z",
      fields: ["stations"],
      coverageScope: { regionIds: ["seoul"], operatorIds: ["metro"], sourceDomains: ["stations"] },
    }],
    regionalQualityMetrics: {
      stationCount: 1,
      facilityCoverageRatio: 1,
      requiredFacilityEvidenceCoverageRatio: 1,
      strictRouteEligibleFacilityRatio: 1,
      operationalKnownRatio: 1,
      freshnessValidRatio: 1,
      fieldVerifiedPathwayRatio: 1,
      edgeCount: 1,
      unknownAccessibilityRatio: 0,
      unknownEdgeRatioByProfile: { wheelchair: 0, stroller: 0, lowMobility: 0 },
    },
    representativeRouteRegressions: [],
    representativeRouteRegressionSignature: { algorithm: "rsa-sha256-route-regression-v1", value: sign("routes") },
    requiredTables: ["stations"],
    minimumTableRows: {
      stations: 1,
      station_lines: 1,
      network_edges: 1,
      facilities: 1,
      station_facility_evidence: 1,
    },
  };
}

function sign(value) {
  return createSign("RSA-SHA256").update(value).sign(privateKeyPem).toString("base64url");
}

function bytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
