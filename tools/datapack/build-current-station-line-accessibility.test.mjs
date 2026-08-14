import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  buildCurrentStationLineAccessibility,
  canonicalCurrentStationLineInputJson,
  main,
} from "./build-current-station-line-accessibility.mjs";
import { canonicalStationLineAccessibilityJson } from "./materialize-station-line-accessibility.mjs";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const OBSERVED_AT = "2026-08-14T15:34:07.000Z";
const BASE_INPUT = await trackedInput();
const ADMISSION_FILES = [
  "tools/datapack/release/facility-source-admission.json",
  "tools/datapack/release/current-exit-admission/exit-path-source-admission.json",
  "tools/datapack/release/current-transfer-admission/transfer-topology-admission.json",
];

test("current FACILITY·EXIT·TRANSFER를 exact six-cell eligible materialization으로 결속한다", () => {
  const result = buildCurrentStationLineAccessibility(cloneInput());

  assert.deepEqual(result.stationLineInput.stationLines, [
    { lineId: "seoul-4", operatorId: "seoul-metro", stationId: "station-sadang" },
    { lineId: "seoul-4", operatorId: "seoul-metro", stationId: "station-sangnoksu" },
  ]);
  assert.deepEqual(result.materialization.stateSummary, {
    MISSING: 0,
    NOT_APPLICABLE: 1,
    STALE: 0,
    UNKNOWN: 0,
    VERIFIED_ABSENT: 0,
    VERIFIED_PRESENT: 5,
  });
  assert.deepEqual(result.materialization.rows.map(({ stationId, domain, state }) => ({
    stationId, domain, state,
  })), [
    { stationId: "station-sadang", domain: "EXIT", state: "VERIFIED_PRESENT" },
    { stationId: "station-sadang", domain: "FACILITY", state: "VERIFIED_PRESENT" },
    { stationId: "station-sadang", domain: "TRANSFER", state: "VERIFIED_PRESENT" },
    { stationId: "station-sangnoksu", domain: "EXIT", state: "VERIFIED_PRESENT" },
    { stationId: "station-sangnoksu", domain: "FACILITY", state: "VERIFIED_PRESENT" },
    { stationId: "station-sangnoksu", domain: "TRANSFER", state: "NOT_APPLICABLE" },
  ]);
  assert.equal(result.stationLineInput.evidenceRows.length, 6);
  assert.equal(result.materialization.materializationDigest, "561ef3dde0f68e1223b05897d71a193d73b67b34cb677fc91201e99a4ae9eabb");
});

test("handoff identity·domain·freshness drift는 current materialization을 만들지 않는다", () => {
  const cases = [
    ["facility digest", (input) => { input.facilityAdmission.admissionDigest = "0".repeat(64); }],
    ["self-consistent facility rebind", (input) => {
      input.facilityAdmission.observedAt = "2026-08-14T09:49:59.000Z";
      rebindAdmissionDigest(input.facilityAdmission);
    }],
    ["candidate", (input) => { input.exitAdmission.candidate.candidateId = "other-candidate"; }],
    ["domain", (input) => { input.transferAdmission.materializerEvidenceRows[0].domain = "EXIT"; }],
    ["freshness", (input) => { input.observedAt = "2026-08-15T20:06:04.805Z"; }],
  ];
  for (const [label, mutate] of cases) {
    const input = cloneInput();
    mutate(input);
    assert.throws(() => buildCurrentStationLineAccessibility(input), /admission|candidate|domain|digest|eligible|identity|STALE/i, label);
  }
});

test("CLI는 absent directory에 canonical two-file handoff를 mode 0600으로 원자 publish한다", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "current-station-line-accessibility-"));
  const outputDirectory = path.join(root, "output");
  const argv = ["--observed-at", OBSERVED_AT, "--output-directory", outputDirectory];

  const result = await main(argv, { repositoryRoot: REPOSITORY_ROOT, log: () => {} });
  const inputPath = path.join(outputDirectory, "station-line-input.json");
  const materializationPath = path.join(outputDirectory, "station-line-accessibility.json");
  assert.equal((await stat(inputPath)).mode & 0o777, 0o600);
  assert.equal((await stat(materializationPath)).mode & 0o777, 0o600);
  assert.equal(await readFile(inputPath, "utf8"), canonicalCurrentStationLineInputJson(result.stationLineInput));
  assert.equal(await readFile(materializationPath, "utf8"), canonicalStationLineAccessibilityJson(result.materialization));
  await assert.rejects(main(argv, { repositoryRoot: REPOSITORY_ROOT, log: () => {} }), /output.*absent/i);
});

test("CLI는 object가 같아도 noncanonical admission source bytes를 거부한다", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "current-station-line-noncanonical-"));
  await copyAdmissions(root);
  const facilityPath = path.join(root, ADMISSION_FILES[0]);
  await writeFile(facilityPath, ` ${await readFile(facilityPath, "utf8")}`);
  const outputDirectory = path.join(root, "output");

  await assert.rejects(main([
    "--observed-at", OBSERVED_AT,
    "--output-directory", outputDirectory,
  ], { repositoryRoot: root, log: () => {} }), /canonical/i);
  await assert.rejects(lstat(outputDirectory), { code: "ENOENT" });
});

test("CLI는 publication 직전 경쟁 producer가 만든 output directory를 보존한다", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "current-station-line-race-"));
  const outputDirectory = path.join(root, "output");
  const ownerPath = path.join(outputDirectory, "owner.txt");

  await assert.rejects(main([
    "--observed-at", OBSERVED_AT,
    "--output-directory", outputDirectory,
  ], {
    repositoryRoot: REPOSITORY_ROOT,
    log: () => {},
    testHooks: {
      beforeOutputReservation: async () => {
        await mkdir(outputDirectory);
        await writeFile(ownerPath, "foreign-owner");
      },
    },
  }), /exist|absent/i);
  assert.equal(await readFile(ownerPath, "utf8"), "foreign-owner");
  await assert.rejects(lstat(path.join(outputDirectory, "station-line-input.json")), { code: "ENOENT" });
});

test("tracked current input·materialization은 fresh fan-in output과 byte-identical이다", async () => {
  const result = buildCurrentStationLineAccessibility(cloneInput());
  const [inputBytes, materializationBytes] = await Promise.all([
    readFile(new URL("./release/current-station-line-accessibility/station-line-input.json", import.meta.url), "utf8"),
    readFile(new URL("./release/current-station-line-accessibility/station-line-accessibility.json", import.meta.url), "utf8"),
  ]);

  assert.equal(inputBytes, canonicalCurrentStationLineInputJson(result.stationLineInput));
  assert.equal(materializationBytes, canonicalStationLineAccessibilityJson(result.materialization));
});

async function trackedInput() {
  const readJson = async (relative) => JSON.parse(await readFile(path.join(REPOSITORY_ROOT, relative)));
  const [facilityAdmission, exitAdmission, transferAdmission] = await Promise.all([
    readJson("tools/datapack/release/facility-source-admission.json"),
    readJson("tools/datapack/release/current-exit-admission/exit-path-source-admission.json"),
    readJson("tools/datapack/release/current-transfer-admission/transfer-topology-admission.json"),
  ]);
  return { facilityAdmission, exitAdmission, transferAdmission, observedAt: OBSERVED_AT };
}

async function copyAdmissions(root) {
  for (const relative of ADMISSION_FILES) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, await readFile(path.join(REPOSITORY_ROOT, relative)));
  }
}

function cloneInput() {
  return structuredClone(BASE_INPUT);
}

function rebindAdmissionDigest(admission) {
  const { admissionDigest: _, ...payload } = admission;
  admission.admissionDigest = createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
