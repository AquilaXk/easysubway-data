#!/usr/bin/env node
import { lstat, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { codepointCompare } from "../lib/codepoint-compare.mjs";
import { isObject } from "../lib/is-object.mjs";
import { sha256 } from "../lib/hash.mjs";
import { readReplaySourceFile, replaySourceJobSteps, stepConclusion, verifyReplaySourceRun } from "./replay-source-run.mjs";

export const ITX_REPLAY_WORKFLOW_PATH = ".github/workflows/itx-current-promotion.yml";
export const ITX_REPLAY_EVIDENCE_FILES = Object.freeze([
  "freshness.json",
  "itx-completeness.json",
  "itx-promotion-gate.json",
  "itx-replay.json",
  "itx-result.json",
  "provider-response-capture.json",
]);
// 되살리는 파일. replay와 게이트 영수증은 보관 capture에서 다시 계산한다.
const RESTORED_FILES = Object.freeze(["freshness.json", "itx-completeness.json", "itx-result.json", "provider-response-capture.json"]);
const JOB_NAME = "ITX current promotion";
const COLLECT_STEP = "Collect current ITX timetable";
const RESTORE_STEP = "Restore retained ITX collection evidence";
const GATE_STEP = "Evaluate promotion gate";
const ARTIFACT_ID = /^itx-cheongchun-source-timetable-(\d{17})$/u;
const REPLAY_CODE = "ITX_REPLAY";
const SHA256 = /^[0-9a-f]{64}$/u;

function fail(code, detail = "") {
  throw new Error(detail ? `${code}: ${detail}` : code);
}


function parseJson(buffer, label) {
  try {
    const value = JSON.parse(buffer.toString("utf8"));
    if (isObject(value)) return value;
  } catch {
    // 아래에서 같은 오류로 닫는다.
  }
  return fail("ITX_REPLAY_ARTIFACT_INVALID", `${label} is not a JSON object`);
}

function verifyJobs({ sourceRunId, jobs }) {
  const steps = replaySourceJobSteps({ sourceRunId, jobs, jobName: JOB_NAME, code: REPLAY_CODE });
  const collected = stepConclusion(steps, COLLECT_STEP) === "success";
  const restored = stepConclusion(steps, RESTORE_STEP) === "success";
  if (collected === restored) fail("ITX_REPLAY_STEP_NOT_SUCCESS", `run ${sourceRunId} must have exactly one of "${COLLECT_STEP}" or "${RESTORE_STEP}" succeed`);
  const gate = stepConclusion(steps, GATE_STEP);
  if (gate !== "success" && gate !== "failure") fail("ITX_REPLAY_STEP_NOT_SUCCESS", `run ${sourceRunId} did not run "${GATE_STEP}"`);
}

export function verifyItxReplaySource({ sourceRunId, repository, run, jobs, files, contract, now }) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime()) || typeof repository !== "string" || !isObject(files)) fail("ITX_REPLAY_INPUT_INVALID");
  verifyReplaySourceRun({ sourceRunId, repository, run, workflowPath: ITX_REPLAY_WORKFLOW_PATH, code: REPLAY_CODE });
  verifyJobs({ sourceRunId, jobs });

  const names = Object.keys(files).sort(codepointCompare);
  if (JSON.stringify(names) !== JSON.stringify(ITX_REPLAY_EVIDENCE_FILES) || names.some((name) => !Buffer.isBuffer(files[name]))) {
    fail("ITX_REPLAY_ARTIFACT_INVALID", `artifact files must be exactly ${ITX_REPLAY_EVIDENCE_FILES.join(", ")}`);
  }
  const receipt = parseJson(files["itx-promotion-gate.json"], "itx-promotion-gate.json");
  const result = parseJson(files["itx-result.json"], "itx-result.json");
  const mismatch = (detail) => fail("ITX_REPLAY_BINDING_MISMATCH", detail);
  if (receipt.artifactKind !== "itx-promotion-gate-receipt" || (receipt.status !== "PASS" && receipt.status !== "BLOCK") || !isObject(receipt.candidate) || !isObject(receipt.source)) mismatch("gate receipt is not a valid promotion gate receipt");
  if (result.artifactKind !== "itx-cheongchun-source-timetable" || result.validationStatus !== "SUPPORTED") mismatch("candidate is not a supported ITX source timetable");
  const stamp = ARTIFACT_ID.exec(result.artifactId ?? "")?.[1];
  if (stamp === undefined) mismatch("candidate artifact id");
  if (receipt.candidate.artifactId !== result.artifactId || receipt.candidate.observedAt !== result.observedAt || receipt.candidate.freshUntil !== result.freshUntil) mismatch("receipt candidate identity");
  if (!SHA256.test(receipt.candidate.sha256 ?? "") || sha256(files["itx-result.json"]) !== receipt.candidate.sha256) mismatch("candidate sha256");
  if (!SHA256.test(receipt.source.rawCaptureSha256 ?? "") || sha256(files["provider-response-capture.json"]) !== receipt.source.rawCaptureSha256) mismatch("raw capture sha256");
  if (!SHA256.test(result.completenessEvidenceSha256 ?? "") || sha256(files["itx-completeness.json"]) !== result.completenessEvidenceSha256) mismatch("completeness evidence sha256");

  const admittedId = contract?.sourceTimetableArtifact?.artifactId;
  const admittedStamp = ARTIFACT_ID.exec(admittedId ?? "")?.[1];
  if (contract?.sourceTimetableArtifact?.status !== "ADMITTED" || admittedStamp === undefined) fail("ITX_REPLAY_INPUT_INVALID", "coverage contract has no admitted ITX source");
  if (stamp <= admittedStamp) fail("ITX_REPLAY_ALREADY_ADMITTED", `${result.artifactId} is not newer than the admitted ${admittedId}`);
  const freshUntil = Date.parse(result.freshUntil);
  if (!Number.isFinite(freshUntil)) mismatch("candidate freshUntil");
  if (freshUntil <= now.getTime()) fail("ITX_REPLAY_EXPIRED", `${result.artifactId} is fresh only until ${result.freshUntil}`);

  return {
    artifactId: result.artifactId,
    freshUntil: result.freshUntil,
    observedAt: result.observedAt,
    outputs: Object.fromEntries(RESTORED_FILES.map((name) => [name, files[name]])),
  };
}

function parseArgs(argv) {
  const keys = new Map([
    ["--source-run-id", "sourceRunId"], ["--repository", "repository"], ["--run", "run"], ["--jobs", "jobs"],
    ["--artifact-dir", "artifactDir"], ["--contract", "contract"], ["--output-root", "outputRoot"],
  ]);
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = keys.get(argv[index]);
    if (!key || Object.hasOwn(values, key) || typeof argv[index + 1] !== "string" || argv[index + 1] === "") fail("ITX_REPLAY_INPUT_INVALID", `argument ${String(argv[index])}`);
    values[key] = argv[index + 1];
  }
  for (const key of keys.values()) if (!Object.hasOwn(values, key)) fail("ITX_REPLAY_INPUT_INVALID", `missing ${key}`);
  if (!path.isAbsolute(values.artifactDir) || !path.isAbsolute(values.outputRoot)) fail("ITX_REPLAY_INPUT_INVALID", "paths must be absolute");
  return values;
}

export async function main(argv, { now = new Date(), log = (line) => process.stdout.write(`${line}\n`) } = {}) {
  const values = parseArgs(argv);
  const readJson = async (file) => JSON.parse((await readReplaySourceFile(file, "ITX_REPLAY_INPUT_INVALID")).toString("utf8"));
  const names = await readdir(values.artifactDir);
  const contents = await Promise.all(names.map((name) => readReplaySourceFile(path.join(values.artifactDir, name), "ITX_REPLAY_ARTIFACT_INVALID")));
  const files = Object.fromEntries(names.map((name, index) => [name, contents[index]]));
  const result = verifyItxReplaySource({
    sourceRunId: values.sourceRunId,
    repository: values.repository,
    run: await readJson(values.run),
    jobs: await readJson(values.jobs),
    files,
    contract: await readJson(values.contract),
    now,
  });
  // wx: 작업 위치에 이미 있는 파일을 덮어쓰지 않는다. 하나라도 있으면 아무것도 쓰지 않는다.
  for (const name of RESTORED_FILES) {
    if (await lstat(path.join(values.outputRoot, name)).then(() => true, () => false)) fail("ITX_REPLAY_OUTPUT_EXISTS", name);
  }
  for (const name of RESTORED_FILES) await writeFile(path.join(values.outputRoot, name), result.outputs[name], { flag: "wx", mode: 0o644 });
  const summary = { sourceRunId: values.sourceRunId, artifactId: result.artifactId, observedAt: result.observedAt, freshUntil: result.freshUntil, providerCalls: 0 };
  log(JSON.stringify(summary));
  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
