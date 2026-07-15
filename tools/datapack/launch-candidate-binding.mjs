import { createHash } from "node:crypto";

const SHA256 = /^[a-f0-9]{64}$/;

export function buildLaunchCandidateBinding({
  buildSpecRaw,
  manifestRaw,
  sourceEvidenceRaw,
  serverEvidenceRaw,
  mobileEvidenceRaw,
  now = new Date(),
}) {
  const buildSpec = parseJson(buildSpecRaw);
  const manifest = parseJson(manifestRaw);
  const buildSpecSha256 = hashRaw(buildSpecRaw);
  const manifestSha256 = hashRaw(manifestRaw);
  const buildCandidateId = nonEmptyString(buildSpec?.candidateId) ? buildSpec.candidateId : null;
  const candidateBuilderGitSha = nonEmptyString(buildSpec?.builderGitSha) ? buildSpec.builderGitSha : null;
  const pack = manifest?.packs?.[0];
  const packCandidateId = nonEmptyString(pack?.id) && nonEmptyString(pack?.version)
    ? `${pack.id}@${pack.version}`
    : null;
  const coreValid = Boolean(
    buildCandidateId
    && candidateBuilderGitSha
    && packCandidateId
    && SHA256.test(buildSpecSha256 ?? "")
    && SHA256.test(manifestSha256 ?? ""),
  );
  const expected = coreValid ? {
    candidateId: buildCandidateId,
    buildSpecSha256,
    manifestSha256,
  } : null;
  const sourceEvidence = inspectSourceEvidence(
    sourceEvidenceRaw,
    expected,
    candidateBuilderGitSha,
    now,
  );
  const serverEvidence = inspectConsumerEvidence(serverEvidenceRaw, expected, now);
  const mobileEvidence = inspectConsumerEvidence(mobileEvidenceRaw, expected, now);
  const evidence = [sourceEvidence, serverEvidence, mobileEvidence];
  return {
    status: coreValid && evidence.every(({ status }) => status === "FRESH") ? "BOUND" : "INCOMPLETE",
    buildCandidateId,
    packCandidateId,
    candidateBuilderGitSha,
    buildSpecSha256,
    manifestSha256,
    sourceEvidence,
    serverEvidence,
    mobileEvidence,
  };
}

export function bindAuthoritativeLaunchEvidence(templateEvaluatorInput, {
  sourceEvidenceRaw,
  serverEvidenceRaw,
  mobileEvidenceRaw,
  candidateBinding,
}) {
  const evaluatorInput = structuredClone(templateEvaluatorInput ?? {});
  const sourcePayload = launchPayload(sourceEvidenceRaw);
  const serverPayload = launchPayload(serverEvidenceRaw);
  const mobilePayload = launchPayload(mobileEvidenceRaw);
  evaluatorInput.pilot = sourcePayload?.pilot ?? {};
  evaluatorInput.routing = sourcePayload?.routing ?? {};
  evaluatorInput.source = {
    ...(sourcePayload?.source ?? {}),
    artifactHash: candidateBinding?.sourceEvidence?.sha256 ?? null,
  };
  evaluatorInput.server = {
    ...(serverPayload?.server ?? {}),
    artifactHash: candidateBinding?.serverEvidence?.sha256 ?? null,
  };
  evaluatorInput.mobile = {
    ...(mobilePayload?.mobile ?? {}),
    artifactHash: candidateBinding?.mobileEvidence?.sha256 ?? null,
  };
  evaluatorInput.safety = sourcePayload?.safety ?? {};
  evaluatorInput.forbiddenEvidence = sourcePayload?.forbiddenEvidence ?? null;
  evaluatorInput.forbiddenEvidenceStatus = sourcePayload?.forbiddenEvidenceStatus ?? null;
  evaluatorInput.candidateBinding = candidateBinding;
  return evaluatorInput;
}

function inspectSourceEvidence(raw, expected, builderGitSha, now) {
  if (raw === null || raw === undefined) return missingEvidence();
  const sha256 = hashRaw(raw);
  const value = parseJson(raw);
  const snapshots = value?.candidateBuild?.sourceSnapshots;
  const expiries = Array.isArray(snapshots)
    ? snapshots.map(({ freshnessExpiresAt }) => freshnessExpiresAt)
    : [];
  const freshUntil = earliestValidTimestamp(expiries);
  if (
    !expected
    || !value
    || value.manifestSha256 !== expected.manifestSha256
    || value.candidateBuild?.candidateId !== expected.candidateId
    || value.candidateBuild?.buildSpecSha256 !== expected.buildSpecSha256
    || value.candidateBuild?.builderGitSha !== builderGitSha
    || !freshUntil
  ) {
    return { status: "INVALID", sha256, freshUntil: null };
  }
  return freshnessResult(sha256, freshUntil, now);
}

function inspectConsumerEvidence(raw, expected, now) {
  if (raw === null || raw === undefined) return missingEvidence();
  const sha256 = hashRaw(raw);
  const value = parseJson(raw);
  const freshUntil = validTimestamp(value?.freshnessExpiresAt) ? value.freshnessExpiresAt : null;
  if (!expected || !value || !sameCandidate(value.candidateBinding, expected) || !freshUntil) {
    return { status: "INVALID", sha256, freshUntil: null };
  }
  return freshnessResult(sha256, freshUntil, now);
}

function freshnessResult(sha256, freshUntil, now) {
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  return {
    status: Number.isFinite(nowMs) && Date.parse(freshUntil) > nowMs ? "FRESH" : "STALE",
    sha256,
    freshUntil,
  };
}

function sameCandidate(actual, expected) {
  return actual?.candidateId === expected.candidateId
    && actual?.buildSpecSha256 === expected.buildSpecSha256
    && actual?.manifestSha256 === expected.manifestSha256;
}

function earliestValidTimestamp(values) {
  if (values.length === 0 || values.some((value) => !validTimestamp(value))) return null;
  return values.reduce((earliest, value) => Date.parse(value) < Date.parse(earliest) ? value : earliest);
}

function validTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function hashRaw(raw) {
  return typeof raw === "string" || Buffer.isBuffer(raw)
    ? createHash("sha256").update(raw).digest("hex")
    : null;
}

function parseJson(raw) {
  if (typeof raw !== "string" && !Buffer.isBuffer(raw)) return null;
  try {
    return JSON.parse(raw.toString());
  } catch {
    return null;
  }
}

function launchPayload(raw) {
  const value = parseJson(raw)?.launchDenominatorEvidence;
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function missingEvidence() {
  return { status: "MISSING", sha256: null, freshUntil: null };
}
