import { createHash } from "node:crypto";

const INPUT_KEYS = ["candidate", "gates"];
const FINAL_KEYS = [
  "schemaVersion", "artifactKind", "result", "candidate", "gates", "blockers", "finalSha256",
];
const CANDIDATE_KEYS = [
  "repository", "gitSha", "bundleId", "releaseSequence", "stationSetSha256", "sourceSnapshotSetHash",
  "signingInputSha256", "signedManifestRawSha256", "payloadRootSha256", "componentInventorySha256",
  "componentDigests", "activeFrom", "freshUntil", "keyId",
];
const COMPONENT_KEYS = ["topology", "timetable", "accessibility", "fare"];
const GATE_NAMES = [
  "sourceFreshness",
  "stationLineAccessibility",
  "routeEdgeEvaluation",
  "artifactInventory",
  "signature",
  "publication",
  "rebuildParityPromotion",
];
const GATE_STATES = {
  sourceFreshness: ["PASS", "UNAVAILABLE", "STALE", "PARTIAL", "IDENTITY_MISMATCH"],
  stationLineAccessibility: ["PASS", "UNAVAILABLE", "MISSING", "STALE", "UNKNOWN", "PARTIAL", "IDENTITY_MISMATCH"],
  routeEdgeEvaluation: ["PASS", "UNAVAILABLE", "MISSING", "STALE", "UNKNOWN", "NOT_EVALUATED", "PARTIAL", "IDENTITY_MISMATCH"],
  artifactInventory: ["PASS", "UNAVAILABLE", "MISSING", "PARTIAL", "IDENTITY_MISMATCH"],
  signature: ["PASS", "UNAVAILABLE", "IDENTITY_MISMATCH"],
  publication: ["PASS", "UNAVAILABLE", "IDENTITY_MISMATCH"],
  rebuildParityPromotion: ["PASS", "UNAVAILABLE", "PARTIAL", "IDENTITY_MISMATCH"],
};
const GO_REQUIRED_CANDIDATE_SHA_FIELDS = [
  "signedManifestRawSha256", "payloadRootSha256", "componentInventorySha256",
];

export function buildServerRouteBundleFinal(input) {
  assertKeys(input, INPUT_KEYS, "input keys");
  const candidate = validateCandidate(input.candidate);
  const gates = validateGates(input.gates);
  return finalized(candidate, gates);
}

export function validateServerRouteBundleFinal(value) {
  assertKeys(value, FINAL_KEYS, "FINAL keys");
  if (value.schemaVersion !== 1) throw new Error("schemaVersion must be 1");
  if (value.artifactKind !== "server-route-bundle-final") {
    throw new Error("artifactKind must be server-route-bundle-final");
  }
  const candidate = validateCandidate(value.candidate);
  const gates = validateGates(value.gates);
  const expected = finalized(candidate, gates);
  if (value.result !== expected.result) throw new Error("result mismatch");
  if (canonicalJson(value.blockers) !== canonicalJson(expected.blockers)) throw new Error("blockers mismatch");
  if (value.finalSha256 !== expected.finalSha256) throw new Error("finalSha256 mismatch");
  return expected;
}

export function canonicalServerRouteBundleFinalJson(value) {
  return canonicalJson(validateServerRouteBundleFinal(value));
}

function finalized(candidate, gates) {
  const blockers = GATE_NAMES
    .filter((gate) => gates[gate].state !== "PASS")
    .map((gate) => `${gate}:${gates[gate].state}`)
    .sort(compareBytes);
  const result = blockers.length === 0 ? "GO" : "NO_GO";
  if (result === "GO") validateGoIdentity(candidate);
  const payload = canonicalObject({
    schemaVersion: 1,
    artifactKind: "server-route-bundle-final",
    result,
    candidate,
    gates,
    blockers,
  });
  return canonicalObject({
    ...payload,
    finalSha256: sha256(canonicalJson(payload)),
  });
}

function validateCandidate(value) {
  assertKeys(value, CANDIDATE_KEYS, "candidate keys");
  if (value.repository !== "AquilaXk/easysubway-data") {
    throw new Error("candidate repository mismatch");
  }
  if (typeof value.gitSha !== "string" || !/^[a-f0-9]{40}$/.test(value.gitSha)) {
    throw new Error("candidate gitSha must be a full lowercase Git SHA");
  }
  raw(value.bundleId, "candidate bundleId");
  if (!Number.isSafeInteger(value.releaseSequence) || value.releaseSequence < 1) {
    throw new Error("candidate releaseSequence must be a safe positive integer");
  }
  for (const field of ["stationSetSha256", "sourceSnapshotSetHash", "signingInputSha256"]) {
    sha(value[field], `candidate ${field}`);
  }
  for (const field of GO_REQUIRED_CANDIDATE_SHA_FIELDS) nullableSha(value[field], `candidate ${field}`);
  assertKeys(value.componentDigests, COMPONENT_KEYS, "componentDigests keys");
  for (const component of COMPONENT_KEYS) {
    nullableSha(value.componentDigests[component], `candidate componentDigests.${component}`);
  }
  const activeFrom = kst(value.activeFrom, "candidate activeFrom");
  const freshUntil = kst(value.freshUntil, "candidate freshUntil");
  if (activeFrom >= freshUntil) throw new Error("candidate activeFrom must be before freshUntil");
  raw(value.keyId, "candidate keyId");
  return canonicalObject(value);
}

function validateGates(value) {
  assertKeys(value, GATE_NAMES, "gates keys");
  return canonicalObject(Object.fromEntries(GATE_NAMES.map((gate) => {
    const gateValue = value[gate];
    assertKeys(gateValue, ["state", "evidenceSha256"], `${gate} gate keys`);
    if (!GATE_STATES[gate].includes(gateValue.state)) throw new Error(`${gate} state is invalid`);
    if (gateValue.state === "UNAVAILABLE") {
      if (gateValue.evidenceSha256 !== null) throw new Error(`${gate} UNAVAILABLE evidenceSha256 must be null`);
    } else {
      sha(gateValue.evidenceSha256, `${gate} evidenceSha256`);
    }
    return [gate, { state: gateValue.state, evidenceSha256: gateValue.evidenceSha256 }];
  })));
}

function validateGoIdentity(candidate) {
  for (const field of GO_REQUIRED_CANDIDATE_SHA_FIELDS) {
    if (candidate[field] === null) throw new Error(`candidate ${field} is required for GO`);
  }
  for (const component of COMPONENT_KEYS) {
    if (candidate.componentDigests[component] === null) {
      throw new Error(`candidate componentDigests.${component} is required for GO`);
    }
  }
}

function assertKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort(compareBytes);
  const wanted = [...expected].sort(compareBytes);
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} mismatch`);
  }
}

function raw(value, label) {
  if (typeof value !== "string" || value === "" || value.trim() !== value) {
    throw new Error(`${label} must be a non-empty raw string`);
  }
  return value;
}

function sha(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${label} must be sha256`);
  }
  return value;
}

function nullableSha(value, label) {
  if (value === null) return null;
  return sha(value, label);
}

function kst(value, label) {
  raw(value, label);
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}\+09:00$/.test(value)) {
    throw new Error(`${label} must be an exact KST millisecond instant`);
  }
  const milliseconds = Date.parse(value);
  if (Number.isNaN(milliseconds)
    || new Date(milliseconds + (9 * 60 * 60 * 1000)).toISOString().replace("Z", "+09:00") !== value) {
    throw new Error(`${label} must be a valid KST millisecond instant`);
  }
  return milliseconds;
}

function canonicalObject(value) {
  if (Array.isArray(value)) return value.map(canonicalObject);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort(compareBytes).map((key) => [key, canonicalObject(value[key])]));
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalObject(value));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function compareBytes(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}
