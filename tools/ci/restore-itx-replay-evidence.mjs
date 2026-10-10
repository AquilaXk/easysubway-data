#!/usr/bin/env node
// 이전 run이 받아 둔 ITX-청춘 수집분을 승격 workflow의 작업 위치로 되살린다(#1127).
//
// ITX 공급자 호출은 KST 하루 한 번이다. 그날 받은 응답이 승격 PR과 함께 사라지면(PR이 닫히고 브랜치가 지워지는 경우) 다음 수집 가능 시각까지 기다려야 한다.
// 그러나 수집분은 이전 run의 artifact(후보·완전성 증거·게이트 영수증·raw provider capture·replay)에 남아 있다.
// 이 도구는 그 artifact가 "실제로 수집기가 성공하고 게이트가 통과한 run"의 것인지 확인하고, 후보·완전성·capture가 영수증과 바이트 단위로 맞을 때만
// 후보·완전성·capture·서비스 일자 네 파일을 작업 위치에 쓴다. 이어지는 step이 같은 capture에서 replay를 다시 계산하고 게이트를 다시 돌린다.
// - 공급자를 부르지 않는다. 받은 바이트(보관 capture) 밖의 값은 쓰지 않는다. 어긋나면 추정하거나 이전 값으로 덮지 않고 실패한다.
// - 이미 승격됐거나 더 옛날인 수집분, 신선도가 이미 지난 수집분은 되살리지 않는다.
// - 되살린 run도 같은 artifact를 올리므로 재생이 한 번 더 필요해져도(예: 승격 PR이 다시 뒤처짐) 같은 방식으로 이어진다.
//
// 사용: node tools/ci/restore-itx-replay-evidence.mjs --source-run-id <run id> --repository <owner/repo> --run <gh api run json> --jobs <gh api jobs json>
//   --artifact-dir <내려받은 artifact 디렉터리> --contract <coverage contract> --output-root <작업 위치>
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { codepointCompare } from "../lib/codepoint-compare.mjs";

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
const RUN_ID = /^[1-9][0-9]{0,15}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const MAX_FILE_BYTES = 32 * 1024 * 1024;

function fail(code, detail = "") {
  throw new Error(detail ? `${code}: ${detail}` : code);
}

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function parseJson(buffer, label) {
  try {
    const value = JSON.parse(buffer.toString("utf8"));
    if (isObject(value)) return value;
  } catch {
    // 아래에서 같은 오류로 닫는다.
  }
  return fail("ITX_REPLAY_ARTIFACT_INVALID", `${label} is not a JSON object`);
}

function verifyRun({ sourceRunId, repository, run }) {
  if (typeof sourceRunId !== "string" || !RUN_ID.test(sourceRunId)) fail("ITX_REPLAY_RUN_INVALID", "source run id");
  if (!isObject(run) || run.id !== Number(sourceRunId) || run.path !== ITX_REPLAY_WORKFLOW_PATH || run.head_branch !== "main"
    || !["workflow_dispatch", "schedule"].includes(run.event) || run.repository?.full_name !== repository) {
    fail("ITX_REPLAY_RUN_INVALID", `run ${sourceRunId} is not a main run of itx-current-promotion.yml in ${repository}`);
  }
}

const stepConclusion = (steps, name) => {
  const matches = steps.filter((item) => item?.name === name);
  return matches.length === 1 && matches[0].status === "completed" ? matches[0].conclusion : null;
};

function verifyJobs({ sourceRunId, jobs }) {
  const matches = (Array.isArray(jobs?.jobs) ? jobs.jobs : []).filter((job) => job?.name === JOB_NAME && job.run_id === Number(sourceRunId));
  const steps = matches.length === 1 && Array.isArray(matches[0].steps) ? matches[0].steps : null;
  if (steps === null) return fail("ITX_REPLAY_STEP_NOT_SUCCESS", `run ${sourceRunId} has no single ${JOB_NAME} job`);
  // 수집기가 성공했거나(처음 수집한 run), 복원 step이 성공한 run(재생 run)이어야 한다. 둘 다이면 모순이라 거부한다.
  const collected = stepConclusion(steps, COLLECT_STEP) === "success";
  const restored = stepConclusion(steps, RESTORE_STEP) === "success";
  if (collected === restored) fail("ITX_REPLAY_STEP_NOT_SUCCESS", `run ${sourceRunId} must have exactly one of "${COLLECT_STEP}" or "${RESTORE_STEP}" succeed`);
  if (stepConclusion(steps, GATE_STEP) !== "success") fail("ITX_REPLAY_STEP_NOT_SUCCESS", `run ${sourceRunId} did not pass "${GATE_STEP}"`);
}

/**
 * 이전 run의 메타데이터와 artifact 파일을 검증하고 되살릴 파일을 돌려준다. 읽기만 한다.
 * @returns {{ artifactId: string, freshUntil: string, observedAt: string, outputs: Record<string, Buffer> }}
 */
export function verifyItxReplaySource({ sourceRunId, repository, run, jobs, files, contract, now }) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime()) || typeof repository !== "string" || !isObject(files)) fail("ITX_REPLAY_INPUT_INVALID");
  verifyRun({ sourceRunId, repository, run });
  verifyJobs({ sourceRunId, jobs });

  const names = Object.keys(files).sort(codepointCompare);
  if (JSON.stringify(names) !== JSON.stringify(ITX_REPLAY_EVIDENCE_FILES) || names.some((name) => !Buffer.isBuffer(files[name]))) {
    fail("ITX_REPLAY_ARTIFACT_INVALID", `artifact files must be exactly ${ITX_REPLAY_EVIDENCE_FILES.join(", ")}`);
  }
  const receipt = parseJson(files["itx-promotion-gate.json"], "itx-promotion-gate.json");
  const result = parseJson(files["itx-result.json"], "itx-result.json");
  const mismatch = (detail) => fail("ITX_REPLAY_BINDING_MISMATCH", detail);
  if (receipt.artifactKind !== "itx-promotion-gate-receipt" || receipt.status !== "PASS" || !isObject(receipt.candidate) || !isObject(receipt.source)) mismatch("gate receipt is not a PASS receipt");
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

async function readRegularFile(file, code) {
  const stat = await lstat(file).catch(() => null);
  if (stat === null || !stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) fail(code, `${path.basename(file)} is not a regular file within the size limit`);
  return readFile(file);
}

export async function main(argv, { now = new Date(), log = (line) => process.stdout.write(`${line}\n`) } = {}) {
  const values = parseArgs(argv);
  const readJson = async (file) => JSON.parse((await readRegularFile(file, "ITX_REPLAY_INPUT_INVALID")).toString("utf8"));
  const files = {};
  for (const name of await readdir(values.artifactDir)) files[name] = await readRegularFile(path.join(values.artifactDir, name), "ITX_REPLAY_ARTIFACT_INVALID");
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
