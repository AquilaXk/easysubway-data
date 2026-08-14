#!/usr/bin/env node
import { lstat, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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
  EXIT: "13baa3ecf6d603063c76307b912537c7528002bb86b5e434d465962e833d5dca",
  FACILITY: "e3dee749e4a4c9810eac907964dd93fe072d68c5f66fe9fbcec12474f45cf82a",
  TRANSFER: "d925818a23ee26a553ec07cc381cb350240d3774d057dec59b4af9a186fbebdd",
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
} = {}) {
  const args = parseArgs(argv);
  await outputMustBeAbsent(args.outputDirectory);
  const root = path.resolve(repositoryRoot);
  const [facilityAdmission, exitAdmission, transferAdmission] = await Promise.all([
    readJson(path.join(root, FACILITY_FILE)),
    readJson(path.join(root, EXIT_FILE)),
    readJson(path.join(root, TRANSFER_FILE)),
  ]);
  const result = buildCurrentStationLineAccessibility({
    facilityAdmission,
    exitAdmission,
    transferAdmission,
    observedAt: args.observedAt,
  });
  await publishDirectory(args.outputDirectory, result);
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

async function publishDirectory(outputDirectory, result) {
  const parent = path.dirname(outputDirectory);
  const parentBefore = await lstat(parent);
  if (!parentBefore.isDirectory() || parentBefore.isSymbolicLink()) {
    throw new Error("output parent must be a directory");
  }
  const staging = await mkdtemp(path.join(parent, ".current-station-line-accessibility-"));
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
    await rename(staging, outputDirectory);
  } catch (error) {
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

async function readJson(filePath) {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await readFile(filePath)));
  } catch (error) {
    throw new Error(`${path.basename(filePath)} must be valid JSON`, { cause: error });
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
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort(compareBytes);
  const wanted = [...expected].sort(compareBytes);
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} mismatch`);
  }
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

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
