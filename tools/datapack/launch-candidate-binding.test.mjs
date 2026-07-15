import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  bindAuthoritativeLaunchEvidence,
  buildLaunchCandidateBinding,
} from "./launch-candidate-binding.mjs";

const sha256 = (raw) => createHash("sha256").update(raw).digest("hex");
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

function boundArtifacts({ candidateId = "candidate-a", manifestVersion = "1" } = {}) {
  const buildSpecRaw = json({
    candidateId,
    builderGitSha: "abcdef1",
    sourceSnapshots: [{ freshnessExpiresAt: "2099-08-01T00:00:00Z" }],
  });
  const manifestRaw = json({ packs: [{ id: "capital", version: manifestVersion }] });
  const common = {
    candidateId,
    buildSpecSha256: sha256(buildSpecRaw),
    manifestSha256: sha256(manifestRaw),
  };
  const sourceEvidenceRaw = json({
    manifestSha256: common.manifestSha256,
    candidateBuild: {
      ...common,
      builderGitSha: "abcdef1",
      sourceSnapshots: [{ freshnessExpiresAt: "2099-08-01T00:00:00Z" }],
    },
  });
  const serverEvidenceRaw = json({ candidateBinding: common, freshnessExpiresAt: "2099-08-01T00:00:00Z" });
  const mobileEvidenceRaw = json({ candidateBinding: common, freshnessExpiresAt: "2099-08-01T00:00:00Z" });
  return { buildSpecRaw, manifestRaw, sourceEvidenceRaw, serverEvidenceRaw, mobileEvidenceRaw };
}

test("candidate binding binds current build, manifest, and fresh consumer evidence bytes", () => {
  const artifacts = boundArtifacts();
  const binding = buildLaunchCandidateBinding({ ...artifacts, now: new Date("2026-07-15T00:00:00Z") });
  assert.equal(binding.status, "BOUND");
  assert.equal(binding.buildCandidateId, "candidate-a");
  assert.equal(binding.packCandidateId, "capital@1");
  assert.equal(binding.candidateBuilderGitSha, "abcdef1");
  assert.equal(binding.buildSpecSha256, sha256(artifacts.buildSpecRaw));
  assert.equal(binding.manifestSha256, sha256(artifacts.manifestRaw));
  assert.deepEqual(binding.sourceEvidence, {
    status: "FRESH",
    sha256: sha256(artifacts.sourceEvidenceRaw),
    freshUntil: "2099-08-01T00:00:00Z",
  });
  assert.equal(binding.serverEvidence.status, "FRESH");
  assert.equal(binding.mobileEvidence.status, "FRESH");
});

test("candidate binding rejects replayed and stale consumer evidence", () => {
  const artifacts = boundArtifacts();
  const replayedServer = JSON.parse(artifacts.serverEvidenceRaw);
  replayedServer.candidateBinding.candidateId = "other-candidate";
  const staleMobile = JSON.parse(artifacts.mobileEvidenceRaw);
  staleMobile.freshnessExpiresAt = "2026-07-14T23:59:59Z";
  const binding = buildLaunchCandidateBinding({
    ...artifacts,
    serverEvidenceRaw: json(replayedServer),
    mobileEvidenceRaw: json(staleMobile),
    now: new Date("2026-07-15T00:00:00Z"),
  });
  assert.equal(binding.status, "INCOMPLETE");
  assert.equal(binding.serverEvidence.status, "INVALID");
  assert.equal(binding.mobileEvidence.status, "STALE");
});

test("candidate binding records missing authoritative evidence without fallback", () => {
  const artifacts = boundArtifacts();
  const binding = buildLaunchCandidateBinding({
    ...artifacts,
    serverEvidenceRaw: null,
    mobileEvidenceRaw: null,
    now: new Date("2026-07-15T00:00:00Z"),
  });
  assert.equal(binding.status, "INCOMPLETE");
  assert.deepEqual(binding.serverEvidence, { status: "MISSING", sha256: null, freshUntil: null });
  assert.deepEqual(binding.mobileEvidence, { status: "MISSING", sha256: null, freshUntil: null });
});

test("authoritative launch evidence overrides forged template consumer domains", () => {
  const artifacts = boundArtifacts();
  const binding = buildLaunchCandidateBinding({ ...artifacts, now: new Date("2026-07-15T00:00:00Z") });
  const forgedTemplate = {
    pilot: { coveredRowIds: ["forged-row"] },
    routing: { admittedStationIds: ["forged-station"] },
    source: { status: "ADMITTED" },
    server: { status: "ACTIVE" },
    mobile: { status: "READY" },
    safety: { signatureValid: true, rollbackVerified: true, freshness: "FRESH", lineage: "VERIFIED" },
    forbiddenEvidence: [],
    forbiddenEvidenceStatus: "VERIFIED",
  };
  const bound = bindAuthoritativeLaunchEvidence(forgedTemplate, {
    ...artifacts,
    candidateBinding: binding,
  });
  assert.deepEqual(bound.pilot, {});
  assert.deepEqual(bound.routing, {});
  assert.deepEqual(bound.source, { artifactHash: binding.sourceEvidence.sha256 });
  assert.deepEqual(bound.server, { artifactHash: binding.serverEvidence.sha256 });
  assert.deepEqual(bound.mobile, { artifactHash: binding.mobileEvidence.sha256 });
  assert.deepEqual(bound.safety, {});
  assert.equal(bound.forbiddenEvidence, null);
  assert.equal(bound.forbiddenEvidenceStatus, null);
});

test("authoritative launch evidence uses each bound artifact's explicit payload", () => {
  const artifacts = boundArtifacts();
  const source = JSON.parse(artifacts.sourceEvidenceRaw);
  const server = JSON.parse(artifacts.serverEvidenceRaw);
  const mobile = JSON.parse(artifacts.mobileEvidenceRaw);
  source.launchDenominatorEvidence = { routing: { admittedStationIds: ["station-a"] }, source: { status: "ADMITTED" } };
  server.launchDenominatorEvidence = { server: { status: "ACTIVE" } };
  mobile.launchDenominatorEvidence = { mobile: { status: "READY" } };
  const payloadArtifacts = {
    ...artifacts,
    sourceEvidenceRaw: json(source),
    serverEvidenceRaw: json(server),
    mobileEvidenceRaw: json(mobile),
  };
  const binding = buildLaunchCandidateBinding({ ...payloadArtifacts, now: new Date("2026-07-15T00:00:00Z") });
  const bound = bindAuthoritativeLaunchEvidence({}, { ...payloadArtifacts, candidateBinding: binding });
  assert.deepEqual(bound.routing, { admittedStationIds: ["station-a"] });
  assert.equal(bound.source.status, "ADMITTED");
  assert.equal(bound.server.status, "ACTIVE");
  assert.equal(bound.mobile.status, "READY");
});
