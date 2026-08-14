#!/usr/bin/env node
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalExitPathAdmissionJson } from "./build-exit-path-admission.mjs";
import { canonicalFacilitySourceAdmissionJson } from "./build-facility-source-admission.mjs";
import { canonicalTransferTopologyAdmissionJson } from "./build-transfer-topology-admission.mjs";
import { requiredUtcInstant } from "./lib/utc-instant.mjs";
import {
  canonicalStationLineAccessibilityJson,
  materializeStationLineAccessibility,
} from "./materialize-station-line-accessibility.mjs";

const FACILITY_FILE = "tools/datapack/release/facility-source-admission.json";
const EXIT_FILE = "tools/datapack/release/current-exit-admission/exit-path-source-admission.json";
const TRANSFER_FILE = "tools/datapack/release/current-transfer-admission/transfer-topology-admission.json";
const INPUT_FILE = "station-line-input.json";
const MATERIALIZATION_FILE = "station-line-accessibility.json";
const EXPECTED_ADMISSION_DIGESTS = {
  EXIT: "d64f812b5e35680886e9377eda33e6fbabf1530c4da8b6f933b1204149a61f4c",
  FACILITY: "1f2a3f09dbbc3e79c3ff88f0ef5690033ab6775f7bf2b8a1ceedc80f82ac28ea",
  TRANSFER: "c9b5d0a883b06129a8339904437f69220627f5ee62b7020b320e0eb8ea4cdfbc",
};
const CANDIDATE_KEYS = [
  "candidateId", "mappingContractVersion", "materializerVersion", "sourceSetSha256", "stationSetSha256",
];
const EXPECTED_SUMMARY = {
  MISSING: 0,
  NOT_APPLICABLE: 1,
  STALE: 0,
  UNKNOWN: 0,
  VERIFIED_ABSENT: 0,
  VERIFIED_PRESENT: 5,
};

export function buildCurrentStationLineAccessibility(input) {
  assertKeys(input, ["facilityAdmission", "exitAdmission", "transferAdmission", "observedAt"], "current materialization input keys");
  const observedAt = requiredUtcInstant(input.observedAt, "observedAt");
  const handoffs = validateHandoffs(input);
  const candidate = validateCandidates(handoffs);
  const stationLines = validateStationLines(handoffs);
  const evidenceRows = validateEvidenceRows(handoffs, stationLines);
  const stationLineInput = canonicalObject({ candidate, stationLines, evidenceRows });
  const materialization = materializeStationLineAccessibility({
    ...stationLineInput,
    observedAt: new Date(observedAt).toISOString(),
  });
  if (canonicalJson(materialization.stateSummary) !== canonicalJson(EXPECTED_SUMMARY)) {
    throw new Error("current station-line materialization is not eligible");
  }
  canonicalCurrentStationLineInputJson(stationLineInput);
  canonicalStationLineAccessibilityJson(materialization);
  return { stationLineInput, materialization };
}

export function canonicalCurrentStationLineInputJson(value) {
  assertKeys(value, ["candidate", "stationLines", "evidenceRows"], "current station-line input keys");
  assertKeys(value.candidate, CANDIDATE_KEYS, "current materialization candidate keys");
  if (!Array.isArray(value.stationLines) || !Array.isArray(value.evidenceRows)) {
    throw new Error("current station-line arrays are required");
  }
  return canonicalJson(value);
}

export async function main(argv, {
  repositoryRoot = fileURLToPath(new URL("../../", import.meta.url)),
  log = console.log,
  testHooks = {},
} = {}) {
  const args = parseArgs(argv);
  await outputMustBeAbsent(args.outputDirectory);
  const root = path.resolve(repositoryRoot);
  const [facilityAdmission, exitAdmission, transferAdmission] = await Promise.all([
    readCanonicalJson(path.join(root, FACILITY_FILE), canonicalFacilitySourceAdmissionJson),
    readCanonicalJson(path.join(root, EXIT_FILE), canonicalExitPathAdmissionJson),
    readCanonicalJson(path.join(root, TRANSFER_FILE), canonicalTransferTopologyAdmissionJson, { trailingNewline: true }),
  ]);
  const result = buildCurrentStationLineAccessibility({
    facilityAdmission,
    exitAdmission,
    transferAdmission,
    observedAt: args.observedAt,
  });
  await publishDirectory(args.outputDirectory, result, testHooks);
  log(JSON.stringify({
    materializationDigest: result.materialization.materializationDigest,
    stateSummary: result.materialization.stateSummary,
  }));
  return result;
}

function validateHandoffs(input) {
  canonicalFacilitySourceAdmissionJson(input.facilityAdmission);
  canonicalExitPathAdmissionJson(input.exitAdmission);
  canonicalTransferTopologyAdmissionJson(input.transferAdmission);
  const handoffs = [
    { domain: "FACILITY", value: input.facilityAdmission },
    { domain: "EXIT", value: input.exitAdmission },
    { domain: "TRANSFER", value: input.transferAdmission },
  ];
  for (const { domain, value } of handoffs) {
    if (value.admissionDigest !== EXPECTED_ADMISSION_DIGESTS[domain]
      || value.decision !== "GO" || !Array.isArray(value.cells)
      || !Array.isArray(value.materializerEvidenceRows) || value.cells.length !== 2
      || value.materializerEvidenceRows.length !== 2
      || !/^[0-9a-f]{64}$/u.test(value.stationLineSetSha256)) {
      throw new Error(`current ${domain} admission identity mismatch`);
    }
  }
  return handoffs;
}

function validateCandidates(handoffs) {
  const [first, ...rest] = handoffs.map(({ value }) => value.candidate);
  assertKeys(first, CANDIDATE_KEYS, "current materialization candidate keys");
  if (first.mappingContractVersion !== "station-line-v1" || first.materializerVersion !== "1"
    || !/^[0-9a-f]{64}$/u.test(first.stationSetSha256)
    || !/^[0-9a-f]{64}$/u.test(first.sourceSetSha256)
    || rest.some((candidate) => canonicalJson(candidate) !== canonicalJson(first))) {
    throw new Error("current materialization candidate identity mismatch");
  }
  return canonicalObject(first);
}

function validateStationLines(handoffs) {
  const [first, ...rest] = handoffs;
  const expectedSetSha256 = first.value.stationLineSetSha256;
  const stationLines = projectedStationLines(first.value.cells);
  if (rest.some(({ value }) => value.stationLineSetSha256 !== expectedSetSha256
    || canonicalJson(projectedStationLines(value.cells)) !== canonicalJson(stationLines))) {
    throw new Error("current materialization station-line identity mismatch");
  }
  return stationLines;
}

function projectedStationLines(rows) {
  const result = rows.map((row) => {
    const projection = {
      lineId: row?.lineId,
      operatorId: row?.operatorId,
      stationId: row?.stationId,
    };
    if (Object.values(projection).some((value) => typeof value !== "string" || value.trim() === "")
      || row.stationLineId !== `${row.stationId}:${row.lineId}`) {
      throw new Error("current materialization station-line identity mismatch");
    }
    return projection;
  }).sort(compareStationLines);
  if (new Set(result.map(({ stationId, lineId }) => `${stationId}\u0000${lineId}`)).size !== result.length) {
    throw new Error("current materialization station-line identity mismatch");
  }
  return result;
}

function validateEvidenceRows(handoffs, stationLines) {
  const expectedLines = canonicalJson(stationLines);
  const evidenceRows = handoffs.flatMap(({ domain, value }) => {
    if (value.materializerEvidenceRows.some((row) => row?.domain !== domain)
      || canonicalJson(projectedEvidenceStationLines(value.materializerEvidenceRows)) !== expectedLines) {
      throw new Error(`current ${domain} materializer evidence identity mismatch`);
    }
    return value.materializerEvidenceRows;
  }).map(canonicalObject).sort(compareEvidenceRows);
  const states = Object.fromEntries(handoffs.map(({ domain, value }) => [
    domain,
    value.materializerEvidenceRows.map(({ state }) => state).sort(compareBytes),
  ]));
  if (canonicalJson(states) !== canonicalJson({
    EXIT: ["VERIFIED_PRESENT", "VERIFIED_PRESENT"],
    FACILITY: ["VERIFIED_PRESENT", "VERIFIED_PRESENT"],
    TRANSFER: ["NOT_APPLICABLE", "VERIFIED_PRESENT"],
  })) {
    throw new Error("current materializer evidence state mismatch");
  }
  return evidenceRows;
}

function projectedEvidenceStationLines(rows) {
  return rows.map(({ stationId, lineId, operatorId }) => ({
    lineId, operatorId, stationId,
  })).sort(compareStationLines);
}

async function publishDirectory(outputDirectory, result, testHooks) {
  const parent = path.dirname(outputDirectory);
  const parentBefore = await lstat(parent);
  if (!parentBefore.isDirectory() || parentBefore.isSymbolicLink()) {
    throw new Error("output parent must be a directory");
  }
  const staging = await mkdtemp(path.join(parent, ".current-station-line-accessibility-"));
  let outputIdentity;
  try {
    await Promise.all([
      writeFile(path.join(staging, INPUT_FILE), canonicalCurrentStationLineInputJson(result.stationLineInput), {
        flag: "wx", mode: 0o600,
      }),
      writeFile(path.join(staging, MATERIALIZATION_FILE), canonicalStationLineAccessibilityJson(result.materialization), {
        flag: "wx", mode: 0o600,
      }),
    ]);
    await outputMustBeAbsent(outputDirectory);
    const parentAfter = await lstat(parent);
    if (!sameIdentity(parentBefore, parentAfter)) throw new Error("output parent changed during build");
    await testHooks.beforeOutputReservation?.();
    await mkdir(outputDirectory, { mode: 0o700 });
    outputIdentity = await lstat(outputDirectory);
    await rename(path.join(staging, INPUT_FILE), path.join(outputDirectory, INPUT_FILE));
    await rename(path.join(staging, MATERIALIZATION_FILE), path.join(outputDirectory, MATERIALIZATION_FILE));
    await rm(staging, { recursive: true });
  } catch (error) {
    await removeOwnedDirectory(outputDirectory, outputIdentity);
    await rm(staging, { force: true, recursive: true });
    throw error;
  }
}

function parseArgs(argv) {
  if (!Array.isArray(argv) || argv.length !== 4) throw new Error("current materialization arguments mismatch");
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = String(argv[index] ?? "").replace(/^--/u, "");
    const value = argv[index + 1];
    if (!["observed-at", "output-directory"].includes(flag) || values[flag] !== undefined
      || typeof value !== "string" || value === "") {
      throw new Error("current materialization arguments mismatch");
    }
    values[flag] = value;
  }
  requiredUtcInstant(values["observed-at"], "--observed-at");
  if (!path.isAbsolute(values["output-directory"])) throw new Error("--output-directory must be an absolute path");
  return {
    observedAt: values["observed-at"],
    outputDirectory: path.resolve(values["output-directory"]),
  };
}

async function outputMustBeAbsent(target) {
  try {
    await lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error("output directory must be absent");
}

async function readCanonicalJson(filePath, canonicalize, { trailingNewline = false } = {}) {
  try {
    const source = new TextDecoder("utf-8", { fatal: true }).decode(await readFile(filePath));
    const value = JSON.parse(source);
    const canonicalSource = `${canonicalize(value)}${trailingNewline ? "\n" : ""}`;
    if (source !== canonicalSource) throw new Error("source bytes are not canonical");
    return value;
  } catch (error) {
    throw new Error(`${path.basename(filePath)} must be valid canonical JSON`, { cause: error });
  }
}

async function removeOwnedDirectory(target, identity) {
  if (!identity) return;
  try {
    const current = await lstat(target);
    if (current.isDirectory() && !current.isSymbolicLink() && sameIdentity(current, identity)) {
      await rm(target, { recursive: true });
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function compareStationLines(left, right) {
  return compareBytes(left.stationId, right.stationId)
    || compareBytes(left.lineId, right.lineId)
    || compareBytes(left.operatorId, right.operatorId);
}

function compareEvidenceRows(left, right) {
  return compareStationLines(left, right) || compareBytes(left.domain, right.domain);
}

function compareBytes(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function assertKeys(value, expected, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = new Set(Object.keys(value));
  if (actual.size !== expected.length || expected.some((key) => !actual.has(key))) throw new Error(`${label} mismatch`);
}

function canonicalObject(value) {
  if (Array.isArray(value)) return value.map(canonicalObject);
  if (value === null || typeof value !== "object") return value;
  return Object.keys(value).sort(compareBytes).reduce((result, key) => {
    result[key] = canonicalObject(value[key]);
    return result;
  }, {});
}

function canonicalJson(value) {
  return JSON.stringify(canonicalObject(value));
}

function sameIdentity(left, right) {
  return ["dev", "ino", "mode"].every((key) => left[key] === right[key]);
}

const invokedAsScript = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (invokedAsScript) {
  main(process.argv.slice(2)).then(undefined, (error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
