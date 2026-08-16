#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, rm, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { canonicalCurrentCapitalFacilitySourceAdmissionJson } from "./build-current-capital-facility-source-admission.mjs";
import { canonicalCurrentStationLineInputJson } from "./build-current-station-line-accessibility.mjs";
import { canonicalJson, sha256 } from "./lib/manifest-validation.mjs";

const FILES = Object.freeze({
  candidate: "tools/datapack/release/candidate-build-spec.json",
  previous: "tools/datapack/release/current-station-line-accessibility/station-line-input.json",
  facility: "tools/datapack/release/current-capital-facility-source-admission.json",
  transition: "tools/datapack/release/current-capital-accessibility-transition.json",
});
const SHA = /^[a-f0-9]{64}$/u;
const TOP_LEVEL_KEYS = Object.freeze([
  "schemaVersion", "artifactKind", "state", "nextCandidate", "previousProduction",
  "facilityAdmission", "pendingPrerequisites", "transitionSha256",
]);

export function buildCurrentCapitalAccessibilityTransition(input) {
  const candidateBytes = requiredBytes(input?.candidateBytes, "candidate build spec");
  const previousBytes = requiredBytes(input?.previousBytes, "previous production station-line input");
  const facilityBytes = requiredBytes(input?.facilityBytes, "current FACILITY admission");
  const candidate = bindParsed(input?.candidate, candidateBytes, "candidate build spec");
  const previous = bindParsed(input?.previous, previousBytes, "previous production station-line input");
  const facility = bindParsed(input?.facilityAdmission, facilityBytes, "current FACILITY admission");
  if (canonicalCurrentStationLineInputJson(previous) !== previousBytes.toString("utf8")) {
    throw new Error("previous production station-line bytes are not canonical");
  }
  if (canonicalCurrentCapitalFacilitySourceAdmissionJson(facility) !== facilityBytes.toString("utf8")) {
    throw new Error("current FACILITY admission bytes are not canonical");
  }
  const candidateId = requiredString(candidate.candidateId, "candidateId");
  const nextSourceSet = requiredSha(candidate.sourceSnapshotSetHash, "candidate source snapshot set");
  const previousSourceSet = requiredSha(previous.candidate?.sourceSetSha256, "previous production source snapshot set");
  if (previous.candidate?.candidateId !== candidateId || previousSourceSet === nextSourceSet) {
    throw new Error("transition source-set boundary mismatch");
  }
  if (facility.decision !== "GO" || facility.candidate?.candidateId !== candidateId
    || facility.candidate?.sourceSnapshotSetHash !== nextSourceSet
    || facility.cellStateSummary?.ADMITTED_FACILITY_UNVERIFIED_BLOCKED !== 1
    || facility.cells?.filter(({ state }) => state === "ADMITTED_FACILITY_UNVERIFIED_BLOCKED").length !== 1) {
    throw new Error("transition FACILITY admission binding mismatch");
  }
  const blocked = facility.cells.find(({ state }) => state === "ADMITTED_FACILITY_UNVERIFIED_BLOCKED");
  if (blocked.stationId !== "station-b35616704ce3" || blocked.lineId !== "seoul-2") {
    throw new Error("transition FACILITY blocked identity mismatch");
  }
  const payload = {
    schemaVersion: 1,
    artifactKind: "current-capital-accessibility-transition",
    state: "PENDING_FULL_FAN_IN",
    nextCandidate: {
      path: FILES.candidate,
      sha256: sha256(candidateBytes),
      candidateId,
      sourceSnapshotSetHash: nextSourceSet,
    },
    previousProduction: {
      path: FILES.previous,
      sha256: sha256(previousBytes),
      sourceSnapshotSetHash: previousSourceSet,
    },
    facilityAdmission: {
      path: FILES.facility,
      sha256: sha256(facilityBytes),
      admissionDigest: requiredSha(facility.admissionDigest, "FACILITY admission digest"),
      snapshotId: requiredString(facility.sourceIdentity?.snapshotId, "FACILITY snapshotId"),
    },
    pendingPrerequisites: {
      exitAdmissionDirectory: "tools/datapack/release/current-exit-admission-v2",
      transferSourceId: "seoul-metro-transfer-distance-duration",
      fullCapitalInputDirectory: "tools/datapack/release/current-capital-accessibility-full",
      authorityEdgeCount: 456,
    },
  };
  return { ...payload, transitionSha256: sha256(Buffer.from(canonicalJson(payload))) };
}

export function canonicalCurrentCapitalAccessibilityTransitionJson(value) {
  validateTransition(value);
  return `${canonicalJson(value)}\n`;
}

export async function assertCurrentCapitalAccessibilityBuildAllowed({ repositoryRoot }) {
  const root = path.resolve(repositoryRoot ?? fileURLToPath(new URL("../../", import.meta.url)));
  const transitionPath = path.join(root, FILES.transition);
  let transition;
  try {
    transition = await readStableRegular(transitionPath, "current accessibility transition");
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  const [candidateBytes, previousBytes, facilityBytes] = await Promise.all([
    readStableRegular(path.join(root, FILES.candidate), "candidate build spec"),
    readStableRegular(path.join(root, FILES.previous), "previous production station-line input"),
    readStableRegular(path.join(root, FILES.facility), "current FACILITY admission"),
  ]);
  const rebuilt = buildCurrentCapitalAccessibilityTransition({
    candidate: parse(candidateBytes, "candidate build spec"),
    candidateBytes,
    previous: parse(previousBytes, "previous production station-line input"),
    previousBytes,
    facilityAdmission: parse(facilityBytes, "current FACILITY admission"),
    facilityBytes,
  });
  const parsed = parse(transition, "current accessibility transition");
  if (canonicalCurrentCapitalAccessibilityTransitionJson(parsed) !== transition.toString("utf8")
    || canonicalJson(parsed) !== canonicalJson(rebuilt)) {
    throw new Error("transition candidate binding mismatch");
  }
  throw new Error("CURRENT_ACCESSIBILITY_TRANSITION_BLOCKED");
}

export async function main(argv = process.argv.slice(2), {
  repositoryRoot = fileURLToPath(new URL("../../", import.meta.url)),
  log = console.log,
} = {}) {
  if (!Array.isArray(argv) || argv.length !== 0) throw new Error("current accessibility transition arguments mismatch");
  const root = path.resolve(repositoryRoot);
  const [candidateBytes, previousBytes, facilityBytes] = await Promise.all([
    readStableRegular(path.join(root, FILES.candidate), "candidate build spec"),
    readStableRegular(path.join(root, FILES.previous), "previous production station-line input"),
    readStableRegular(path.join(root, FILES.facility), "current FACILITY admission"),
  ]);
  const result = buildCurrentCapitalAccessibilityTransition({
    candidate: parse(candidateBytes, "candidate build spec"),
    candidateBytes,
    previous: parse(previousBytes, "previous production station-line input"),
    previousBytes,
    facilityAdmission: parse(facilityBytes, "current FACILITY admission"),
    facilityBytes,
  });
  await publish(path.join(root, FILES.transition), Buffer.from(canonicalCurrentCapitalAccessibilityTransitionJson(result)));
  log(JSON.stringify({ state: result.state, transitionSha256: result.transitionSha256 }));
  return result;
}

function validateTransition(value) {
  assertKeys(value, TOP_LEVEL_KEYS, "current accessibility transition");
  if (value.schemaVersion !== 1 || value.artifactKind !== "current-capital-accessibility-transition" || value.state !== "PENDING_FULL_FAN_IN") {
    throw new Error("current accessibility transition schema mismatch");
  }
  assertKeys(value.nextCandidate, ["path", "sha256", "candidateId", "sourceSnapshotSetHash"], "transition next candidate");
  assertKeys(value.previousProduction, ["path", "sha256", "sourceSnapshotSetHash"], "transition previous production");
  assertKeys(value.facilityAdmission, ["path", "sha256", "admissionDigest", "snapshotId"], "transition FACILITY admission");
  assertKeys(value.pendingPrerequisites, ["exitAdmissionDirectory", "transferSourceId", "fullCapitalInputDirectory", "authorityEdgeCount"], "transition prerequisites");
  if (value.nextCandidate.path !== FILES.candidate || value.previousProduction.path !== FILES.previous || value.facilityAdmission.path !== FILES.facility
    || ![value.nextCandidate.sha256, value.nextCandidate.sourceSnapshotSetHash, value.previousProduction.sha256, value.previousProduction.sourceSnapshotSetHash,
      value.facilityAdmission.sha256, value.facilityAdmission.admissionDigest, value.transitionSha256].every((entry) => SHA.test(entry ?? ""))
    || !requiredString(value.nextCandidate.candidateId, "transition candidateId")
    || !requiredString(value.facilityAdmission.snapshotId, "transition FACILITY snapshotId")
    || value.previousProduction.sourceSnapshotSetHash === value.nextCandidate.sourceSnapshotSetHash
    || value.pendingPrerequisites.exitAdmissionDirectory !== "tools/datapack/release/current-exit-admission-v2"
    || value.pendingPrerequisites.transferSourceId !== "seoul-metro-transfer-distance-duration"
    || value.pendingPrerequisites.fullCapitalInputDirectory !== "tools/datapack/release/current-capital-accessibility-full"
    || value.pendingPrerequisites.authorityEdgeCount !== 456) {
    throw new Error("current accessibility transition identity mismatch");
  }
  const { transitionSha256, ...payload } = value;
  if (sha256(Buffer.from(canonicalJson(payload))) !== transitionSha256) throw new Error("current accessibility transition self-hash mismatch");
}

async function readStableRegular(target, label) {
  if (!Number.isInteger(constants.O_NOFOLLOW)) throw new Error(`${label} cannot enforce O_NOFOLLOW`);
  const beforePath = await lstat(target);
  if (!beforePath.isFile() || beforePath.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file`);
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > 32 * 1024 * 1024) throw new Error(`${label} is invalid`);
    const bytes = await handle.readFile();
    const after = await handle.stat();
    const afterPath = await lstat(target);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs
      || before.dev !== afterPath.dev || before.ino !== afterPath.ino || bytes.length !== before.size) {
      throw new Error(`${label} changed while reading`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function publish(output, bytes) {
  const parent = path.dirname(output);
  const parentBefore = await lstat(parent);
  if (!parentBefore.isDirectory() || parentBefore.isSymbolicLink()) throw new Error("transition output parent mismatch");
  try {
    await lstat(output);
    throw new Error("transition output already exists");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const temporary = path.join(parent, `.current-capital-accessibility-transition-${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    const parentAfter = await lstat(parent);
    if (parentBefore.dev !== parentAfter.dev || parentBefore.ino !== parentAfter.ino || !parentAfter.isDirectory() || parentAfter.isSymbolicLink()) {
      throw new Error("transition output parent changed");
    }
    try {
      await lstat(output);
      throw new Error("transition output already exists");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await link(temporary, output);
    const parentHandle = await open(parent, constants.O_RDONLY);
    try { await parentHandle.sync(); } finally { await parentHandle.close(); }
    await unlink(temporary);
    const cleanupParentHandle = await open(parent, constants.O_RDONLY);
    try { await cleanupParentHandle.sync(); } finally { await cleanupParentHandle.close(); }
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function bindParsed(value, bytes, label) {
  const parsed = parse(bytes, label);
  if (canonicalJson(parsed) !== canonicalJson(value)) throw new Error(`${label} object/bytes mismatch`);
  return parsed;
}
function parse(bytes, label) { try { return JSON.parse(bytes.toString("utf8")); } catch { throw new Error(`${label} is invalid JSON`); } }
function requiredBytes(value, label) { if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) throw new Error(`${label} bytes are required`); return Buffer.from(value); }
function requiredString(value, label) { if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} is required`); return value; }
function requiredSha(value, label) { if (!SHA.test(value ?? "")) throw new Error(`${label} is invalid`); return value; }
function assertKeys(value, keys, label) { if (!value || typeof value !== "object" || Array.isArray(value) || canonicalJson(Object.keys(value).sort((left, right) => left.localeCompare(right))) !== canonicalJson([...keys].sort((left, right) => left.localeCompare(right)))) throw new Error(`${label} keys mismatch`); }

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(`current-capital-accessibility-transition: ${error.message}`); process.exitCode = 1; });
}
