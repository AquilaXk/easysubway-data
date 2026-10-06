#!/usr/bin/env node
// 자동화 PR의 기계 판독 증거 블록(#969, 2단계 자동 병합 정책의 입력 계약, 이슈 §7).
// PR 본문에 `<!-- easysubway-automation-pr:v1 {JSON} -->`를 정확히 하나 남긴다. 정책은 이 블록을 색인으로만 쓰고
// 변경 경로·원장·원천 sha는 diff에서 다시 계산해 대조한다. 본문은 PR 생성 뒤에도 고칠 수 있으므로 블록만 믿고 병합하지 않는다.
//
// - 블록은 알려진 키와 값만 받는다. 모르는 키·잘못된 이슈 번호·잘못된 값은 정규화하지 않고 파싱 오류로 실패한다(fail closed).
// - 블록은 base/head 커밋에 결속된다. 읽는 쪽이 PR head 커밋을 넘기면 블록의 headSha와 같아야 한다.
// - 단계(stage)별 필수 내용: registration은 원천 행(sources)과 정책, derivative-rebinding은 단계(steps)와 정책, candidate-refresh는 후보 식별(candidate).
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { parseLedgerChangePolicy } from "./source-ledger-gate.mjs";

export const AUTOMATION_PR_EVIDENCE_MARKER = "easysubway-automation-pr:v1";
export const AUTOMATION_PR_STAGES = Object.freeze(["registration", "candidate-refresh", "derivative-rebinding"]);
const ISSUE = 969;
const BLOCK = new RegExp(`<!-- ${AUTOMATION_PR_EVIDENCE_MARKER} (.*?) -->`, "gu");
const RUN_URL = /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/actions\/runs\/[1-9][0-9]*$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const EVIDENCE_KEYS = Object.freeze(["schemaVersion", "stage", "issue", "runUrl", "baseSha", "headSha", "policy", "sources", "steps", "candidate"]);
const SOURCE_KEYS = Object.freeze(["sourceId", "snapshotId", "previousSnapshotId", "rawSha256", "contentSha256", "rowDelta", "coverageDelta", "diffStatus"]);
const STEP_KEYS = Object.freeze(["id", "changed", "paths"]);
const CANDIDATE_KEYS = Object.freeze(["candidateId", "releaseSequence", "sourceSnapshotSetHash"]);

function fail(code, detail = "") {
  throw new Error(detail ? `${code}: ${detail}` : code);
}
const invalid = (detail) => fail("AUTOMATION_PR_EVIDENCE_INVALID", detail);
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const hasExactKeys = (value, keys) => isObject(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const text = (value) => typeof value === "string" && value !== "";

function validateSource(source) {
  if (!hasExactKeys(source, SOURCE_KEYS) || !text(source.sourceId) || !text(source.snapshotId)
    || !(source.previousSnapshotId === null || text(source.previousSnapshotId))
    || !SHA256.test(source.rawSha256) || !SHA256.test(source.contentSha256)
    || !Number.isSafeInteger(source.rowDelta) || !Number.isSafeInteger(source.coverageDelta) || !text(source.diffStatus)) invalid("source row");
}

function validateStep(step) {
  if (!hasExactKeys(step, STEP_KEYS) || !text(step.id) || typeof step.changed !== "boolean" || !Array.isArray(step.paths)
    || step.paths.some((entry) => !text(entry)) || step.changed !== (step.paths.length > 0)) invalid(`step ${String(step?.id)}`);
}

function validateCandidate(candidate) {
  if (!hasExactKeys(candidate, CANDIDATE_KEYS) || !text(candidate.candidateId) || !Number.isSafeInteger(candidate.releaseSequence)
    || candidate.releaseSequence < 1 || !SHA256.test(candidate.sourceSnapshotSetHash)) invalid("candidate");
}

function validateEvidence(value) {
  if (!hasExactKeys(value, EVIDENCE_KEYS)) invalid("keys");
  if (value.schemaVersion !== 1 || value.issue !== ISSUE) invalid("schemaVersion or issue");
  if (!AUTOMATION_PR_STAGES.includes(value.stage)) invalid("stage");
  if (typeof value.runUrl !== "string" || !RUN_URL.test(value.runUrl)) invalid("run URL");
  if (typeof value.baseSha !== "string" || !COMMIT.test(value.baseSha) || typeof value.headSha !== "string" || !COMMIT.test(value.headSha)) invalid("commit");
  if (!Array.isArray(value.sources) || !Array.isArray(value.steps)) invalid("sources or steps");
  value.sources.forEach(validateSource);
  value.steps.forEach(validateStep);
  if (value.policy !== null) {
    try { parseLedgerChangePolicy(value.policy); } catch { invalid("policy"); }
  }
  if (value.candidate !== null) validateCandidate(value.candidate);
  const only = (condition, detail) => { if (!condition) invalid(`${value.stage}: ${detail}`); };
  if (value.stage === "registration") {
    only(value.policy !== null && value.sources.length > 0 && value.steps.length === 0 && value.candidate === null, "needs a policy and source rows, no steps or candidate");
  } else if (value.stage === "derivative-rebinding") {
    only(value.policy !== null && value.steps.length > 0 && value.candidate === null, "needs a policy and steps, no candidate");
  } else {
    only(value.candidate !== null && value.policy === null && value.sources.length === 0 && value.steps.length === 0, "needs only the candidate identity");
  }
  return value;
}

function evidenceValue({ stage, runUrl, baseSha, headSha, policy, sources, steps, candidate }) {
  return validateEvidence({ schemaVersion: 1, stage, issue: ISSUE, runUrl, baseSha, headSha, policy, sources, steps, candidate });
}

export function automationPrEvidenceBlock(input) {
  return `<!-- ${AUTOMATION_PR_EVIDENCE_MARKER} ${JSON.stringify(evidenceValue(input))} -->`;
}

/** 블록이 없으면 null. 둘 이상이거나 형식이 어긋나면 실패한다. headSha를 넘기면 블록의 headSha와 같아야 한다(블록이 없으면 실패). */
export function parseAutomationPrEvidence(body, { headSha } = {}) {
  const blocks = [...String(body ?? "").matchAll(BLOCK)];
  if (blocks.length > 1) fail("AUTOMATION_PR_EVIDENCE_DUPLICATE");
  if (blocks.length === 0) {
    if (headSha !== undefined) fail("AUTOMATION_PR_EVIDENCE_MISSING");
    return null;
  }
  let value;
  try { value = JSON.parse(blocks[0][1]); } catch { invalid("not JSON"); }
  validateEvidence(value);
  if (headSha !== undefined && value.headSha !== headSha) fail("AUTOMATION_PR_EVIDENCE_HEAD_MISMATCH", `${value.headSha} is not ${headSha}`);
  return value;
}

const code = (value) => `\`${value}\``;

export function registrationPullRequestBody({ runUrl, baseSha, headSha, policy, sources }) {
  const block = automationPrEvidenceBlock({ stage: "registration", runUrl, baseSha, headSha, policy, sources, steps: [], candidate: null });
  return [
    "Register the protected current capital topology receipt.", "",
    "| 원천 | snapshot | 직전 snapshot | rowDelta | coverageDelta | diff |", "| --- | --- | --- | --- | --- | --- |",
    ...sources.map((source) => `| ${source.sourceId} | ${source.snapshotId} | ${source.previousSnapshotId ?? "-"} | ${source.rowDelta} | ${source.coverageDelta} | ${source.diffStatus} |`),
    "", `- 실행 run: ${runUrl}`, "", "Refs #456", "Refs #969", "", block, "",
  ].join("\n");
}

export function candidateRefreshEvidenceBlock({ runUrl, baseSha, headSha, candidate }) {
  return automationPrEvidenceBlock({ stage: "candidate-refresh", runUrl, baseSha, headSha, policy: null, sources: [], steps: [], candidate });
}

export function derivativeRebindingPullRequestBody({ runUrl, baseSha, headSha, policy, sources, steps }) {
  const block = automationPrEvidenceBlock({ stage: "derivative-rebinding", runUrl, baseSha, headSha, policy, sources, steps, candidate: null });
  return [
    "## Summary", "",
    "- 원천 등록·재확인 뒤 입력 결속이 바뀐 파생 산출물을 `run-derivative-rebinding`이 다시 만들었다.",
    "- 도구는 멱등이라 바뀐 단계만 커밋이 있다. 후보·hash·release request는 이 PR이 바꾸지 않는다(후보 갱신의 몫이다).",
    `- 실행 run: ${runUrl}`, "",
    "| 단계 | 결과 | 경로 |", "| --- | --- | --- |",
    ...steps.map((step) => `| ${step.id} | ${step.changed ? "갱신" : "변경 없음"} | ${step.changed ? step.paths.map(code).join(", ") : "-"} |`),
    "", "Refs #969", "Refs #870", "", block, "",
  ].join("\n");
}

function parseOptions(rest) {
  const values = {};
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    if (!key?.startsWith("--") || Object.hasOwn(values, key.slice(2)) || typeof rest[index + 1] !== "string") fail("AUTOMATION_PR_EVIDENCE_ARGUMENTS");
    values[key.slice(2)] = rest[index + 1];
  }
  return values;
}

export async function main(argv, { write = (chunk) => process.stdout.write(chunk) } = {}) {
  const [command, ...rest] = argv;
  const values = parseOptions(rest);
  const need = (...keys) => { if (keys.some((key) => !Object.hasOwn(values, key))) fail("AUTOMATION_PR_EVIDENCE_ARGUMENTS"); };
  const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));
  const common = () => ({ runUrl: values["run-url"], baseSha: values["base-sha"], headSha: values["head-sha"] });
  if (command === "registration-body") {
    need("gate", "base-sha", "head-sha", "run-url", "output");
    const { policy, sources } = await readJson(values.gate);
    await writeFile(values.output, registrationPullRequestBody({ ...common(), policy, sources }), { flag: "wx" });
  } else if (command === "derivative-rebinding-body") {
    need("gate", "result", "base-sha", "head-sha", "run-url", "output");
    const { policy, sources } = await readJson(values.gate);
    const { steps } = await readJson(values.result);
    // controller 결과의 변경 없는 단계는 paths가 없다. 증거 블록은 항상 paths를 남긴다.
    await writeFile(values.output, derivativeRebindingPullRequestBody({ ...common(), policy, sources, steps: steps.map((step) => ({ ...step, paths: step.paths ?? [] })) }), { flag: "wx" });
  } else if (command === "candidate-refresh-block") {
    need("build-spec", "base-sha", "head-sha", "run-url");
    const { candidateId, releaseSequence, sourceSnapshotSetHash } = await readJson(values["build-spec"]);
    write(`${candidateRefreshEvidenceBlock({ ...common(), candidate: { candidateId, releaseSequence, sourceSnapshotSetHash } })}\n`);
  } else {
    fail("AUTOMATION_PR_EVIDENCE_ARGUMENTS");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
