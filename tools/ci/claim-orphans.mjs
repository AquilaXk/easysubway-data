#!/usr/bin/env node
// PR 없는 claim 브랜치(고아)의 공통 판정(#995).
//
// 원장을 쓰는 갱신 workflow는 provider에 접근하기 전에 claim 브랜치(빈 커밋)를 push한다. run이 그 뒤에 실패하면 claim이 PR 없이 남는다.
// 남은 claim은 원장을 쓰는 다른 자동화를 모두 대기시키므로(ledger-writers-idle) 소유 workflow가 스스로 판정해 정리해야 한다.
// 이 모듈은 그 판정을 한 곳에 둔다. 각 workflow의 판정(decide-*·classify*)이 가져다 쓴다.
//
// claim이 고아인 조건: 같은 저장소의 main 대상 PR이 어떤 상태로도 없다. 고아는 만든 run(브랜치 이름의 run id)과 게시 증거로 가른다.
//   ACTIVE       만든 run이 아직 끝나지 않았다(completed가 아니다). 기다린다. 정상이다.
//   RECOVERABLE  claim 뒤에 출력 커밋이 있거나(빈 claim 하나가 아니다) receipt artifact가 있다. 소유 workflow가 DUE·CURRENT와 무관하게 복구한다.
//                복구 step이 형식을 검증하고 어긋나면 실패한다. 내용이 있는 브랜치는 이 모듈이 지우지 않는다.
//   ABANDONED    run이 끝났거나 기록이 없고(Not Found) 빈 claim뿐이다. 게시된 것이 없다. 보고(#926)한 뒤 지운다(remove-orphan-claims.mjs).
// 판정할 수 없는 상태(다른 workflow·main이 아닌 run을 가리키는 claim, 알 수 없는 run 상태, 어긋난 증거, 증거 없는 고아)는 이상이다.
// 이상은 CLAIM_ORPHAN_* 코드로 실패해 실패 이슈로 드러난다. 추정하거나 성공으로 덮지 않는다.
//
// run 조회는 #987 리뷰 F1·#994의 상한 패턴을 따른다: 끝난 run 이력을 목록으로 받지 않고(`gh run list` 없음) 고아마다 `gh run view <id>` 한 번.
// Not Found는 끝나서 사라진 run이고 그 밖의 gh 오류는 fail closed다. claim 브랜치는 MAX_CLAIM_BRANCHES(50)를 넘으면 gh를 부르기 전에 실패한다.
//
// 증거 수집 사용: node tools/ci/claim-orphans.mjs --workflow <file> --repository <owner/repo> --refs <git ls-remote 출력> --prs <collect-automation-prs.mjs 출력> --output <path>
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { ownPullRequestsByBranch, parsePrefixedRefs, validRepository } from "./automation-pr-state.mjs";
import { MAX_CLAIM_BRANCHES } from "./collect-automation-prs.mjs";
import { REFRESH_CLAIM_PREFIXES } from "./refresh-open-pr-age.mjs";
import { defaultRunGh } from "./report-refresh-failure.mjs";

// claim 브랜치를 provider 접근 전에 만드는 갱신 workflow. receiptArtifact는 게시 뒤 실패한 run이 남기는 복구 증거 artifact 이름이다.
// 출력 커밋이 증거인 workflow(광주·서울·topology)는 receiptArtifact가 없다. abandonedSubject는 소유 workflow가 "닫았다"고 남기는 커밋 제목이다.
const owner = (workflowFile, workflowName, claimSubject, extra = {}) => Object.freeze({ prefix: REFRESH_CLAIM_PREFIXES[workflowFile], workflowName, claimSubject, ...extra });
export const CLAIM_OWNERS = Object.freeze({
  "retained-gwangju-timetable-refresh.yml": owner("retained-gwangju-timetable-refresh.yml", "Retained Gwangju Timetable Refresh", "Claim retained Gwangju timetable refresh"),
  "seoul-current-accessibility-refresh.yml": owner("seoul-current-accessibility-refresh.yml", "Seoul Current Accessibility Refresh", "Claim Seoul accessibility refresh"),
  "kric-current-facility-refresh.yml": owner("kric-current-facility-refresh.yml", "KRIC Current Facility Refresh", "Claim KRIC facility refresh", {
    abandonedSubject: "Abandon KRIC facility refresh claim",
    receiptArtifact: (runId) => `kric-current-facility-refresh-${runId}`,
  }),
  "current-capital-topology-refresh.yml": owner("current-capital-topology-refresh.yml", "Current Capital Topology Refresh", "Claim current topology refresh"),
  "current-capital-topology-registration.yml": owner("current-capital-topology-registration.yml", "Current Capital Topology Registration", "Claim capital topology registration", {
    receiptArtifact: (runId) => `current-capital-topology-registration-${runId}`,
  }),
  "source-reverification.yml": owner("source-reverification.yml", "Source Reverification", "Claim source reverification"),
});

// GitHub Actions run status. completed가 아닌 모든 상태는 아직 끝나지 않은 run이다.
const RUN_STATUSES = Object.freeze(["completed", "in_progress", "queued", "waiting", "pending", "requested"]);
const RUN_ID = /^[1-9]\d*$/u;

function fail(code, detail = "") {
  throw new Error(detail ? `${code}: ${detail}` : code);
}

function ownerOf(workflowFile) {
  if (!Object.hasOwn(CLAIM_OWNERS, workflowFile ?? "")) fail("CLAIM_ORPHAN_INPUT_INVALID", `workflow ${String(workflowFile)}`);
  return CLAIM_OWNERS[workflowFile];
}

/** claim 브랜치 이름의 접미사(만든 run id)를 읽는다. 접두어가 다르거나 접미사가 양의 정수가 아니면 실패한다. */
export function claimRunId(workflowFile, branch) {
  const { prefix } = ownerOf(workflowFile);
  const runId = typeof branch === "string" && branch.startsWith(prefix) ? branch.slice(prefix.length) : "";
  if (!RUN_ID.test(runId)) fail("CLAIM_ORPHAN_INPUT_INVALID", `claim branch ${String(branch)}`);
  return runId;
}

/** gh가 HTTP 404로 끝난 오류인가. 403·5xx·네트워크 오류는 Not Found가 아니다. */
export function isGhNotFound(error) {
  return error instanceof Error && /HTTP 404(?!\d)/u.test(error.message);
}

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isCount = (value) => Number.isSafeInteger(value) && value >= 0;

function assertEvidence(claimOwner, evidence) {
  const invalid = (detail) => fail("CLAIM_ORPHAN_EVIDENCE_INVALID", detail);
  if (!isObject(evidence) || typeof evidence.branch !== "string") invalid("evidence is not an object");
  if (!evidence.branch.startsWith(claimOwner.prefix) || evidence.runId !== evidence.branch.slice(claimOwner.prefix.length) || !RUN_ID.test(evidence.runId)) invalid(`${evidence.branch} run id`);
  const { run, commits, artifacts } = evidence;
  if (!isObject(run) || typeof run.found !== "boolean") invalid(`${evidence.branch} run`);
  if (run.found && (!RUN_STATUSES.includes(run.status) || typeof run.workflowName !== "string" || typeof run.headBranch !== "string"
    || !(run.conclusion === null || typeof run.conclusion === "string"))) invalid(`${evidence.branch} run state`);
  if (!isObject(commits) || !isCount(commits.aheadBy) || !isCount(commits.changedFiles)
    || !Array.isArray(commits.subjects) || commits.subjects.some((subject) => typeof subject !== "string")) invalid(`${evidence.branch} commits`);
  if (!Array.isArray(artifacts) || artifacts.some((artifact) => !isObject(artifact) || typeof artifact.name !== "string" || typeof artifact.expired !== "boolean")) invalid(`${evidence.branch} artifacts`);
  return claimOwner;
}

/** claim 이름이 가리키는 run이 이 workflow의 main run이 아니면 이상이다. 다른 run의 claim을 추정으로 처리하지 않는다. */
export function assertClaimRunOwner(workflowFile, branch, run) {
  const claimOwner = ownerOf(workflowFile);
  if (run.found && (run.workflowName !== claimOwner.workflowName || run.headBranch !== "main")) {
    fail("CLAIM_ORPHAN_RUN_MISMATCH", `${branch}: producer run ${claimRunId(workflowFile, branch)} is not a ${claimOwner.workflowName} run on main`);
  }
}

/**
 * PR 없는 claim 하나의 처지를 정한다.
 * @returns {{ branch: string, runId: string, kind: "ACTIVE"|"RECOVERABLE"|"ABANDONED", reason: string }}
 */
export function classifyUnboundClaim(workflowFile, evidence) {
  const claimOwner = assertEvidence(ownerOf(workflowFile), evidence);
  const { branch, runId, run, commits, artifacts } = evidence;
  const result = (kind, reason) => ({ branch, runId, kind, reason });
  assertClaimRunOwner(workflowFile, branch, run);
  if (run.found && run.status !== "completed") return result("ACTIVE", "RUN_IN_PROGRESS");
  if (claimOwner.abandonedSubject && commits.subjects.at(-1) === claimOwner.abandonedSubject) return result("ABANDONED", "CLAIM_CLOSED_OUT");
  // 빈 claim 하나뿐인 브랜치만 "게시된 것이 없다"고 본다. 개수·제목·내용 중 하나라도 다르면 내용이 있는 브랜치라 지우지 않는다.
  const emptyClaim = commits.aheadBy === 1 && commits.subjects.length === 1 && commits.subjects[0] === claimOwner.claimSubject && commits.changedFiles === 0;
  if (!emptyClaim) return result("RECOVERABLE", "BRANCH_CARRIES_OUTPUT");
  if (claimOwner.receiptArtifact) {
    const name = claimOwner.receiptArtifact(runId);
    if (artifacts.some((artifact) => artifact.name === name && artifact.expired === false)) return result("RECOVERABLE", "RECEIPT_ARTIFACT");
  }
  return result("ABANDONED", run.found ? "EMPTY_CLAIM_RUN_FINISHED" : "EMPTY_CLAIM_RUN_GONE");
}

function boundBranches(workflowFile, repository, pullRequests) {
  if (!validRepository(repository) || !Array.isArray(pullRequests)) fail("CLAIM_ORPHAN_INPUT_INVALID", "repository or pull requests");
  const { prefix } = ownerOf(workflowFile);
  const own = ownPullRequestsByBranch(pullRequests, prefix, repository, (branch) => fail("CLAIM_ORPHAN_INPUT_INVALID", `duplicate pull request for ${branch}`));
  return new Set(own.keys());
}

function assertClaimBranches(workflowFile, claimBranches) {
  if (!Array.isArray(claimBranches) || new Set(claimBranches).size !== claimBranches.length) fail("CLAIM_ORPHAN_INPUT_INVALID", "claim branches");
  for (const branch of claimBranches) claimRunId(workflowFile, branch);
  // 브랜치마다 gh를 부르므로 느려지기 전에 이름 있는 코드로 실패한다(collect-automation-prs와 같은 상한).
  if (claimBranches.length > MAX_CLAIM_BRANCHES) fail("AUTOMATION_CLAIM_BRANCH_LIMIT", `${claimBranches.length} claim branches exceed the limit ${MAX_CLAIM_BRANCHES}`);
}

/**
 * claim 브랜치 중 PR이 없는 것(고아)을 증거로 가른다. PR이 어떤 상태로든 있으면 고아가 아니다(그 PR의 처리는 소유 workflow 몫이다).
 * @returns {{ active: string[], recoverable: string[], abandoned: string[] }} 각각 오름차순 브랜치 이름
 */
export function planUnboundClaims({ workflowFile, repository, claimBranches, pullRequests, evidence } = {}) {
  assertClaimBranches(workflowFile, claimBranches);
  const bound = boundBranches(workflowFile, repository, pullRequests);
  if (!Array.isArray(evidence)) fail("CLAIM_ORPHAN_INPUT_INVALID", "evidence");
  const plan = { active: [], recoverable: [], abandoned: [] };
  const groups = { ACTIVE: plan.active, RECOVERABLE: plan.recoverable, ABANDONED: plan.abandoned };
  for (const branch of claimBranches.filter((name) => !bound.has(name))) {
    const matches = evidence.filter((entry) => entry?.branch === branch);
    if (matches.length !== 1) fail("CLAIM_ORPHAN_EVIDENCE_MISSING", `${branch} has ${matches.length} evidence records`);
    groups[classifyUnboundClaim(workflowFile, matches[0]).kind].push(branch);
  }
  for (const group of Object.values(groups)) group.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  return plan;
}

async function ghJson(runGh, args, describe) {
  const text = await runGh(args);
  try {
    return JSON.parse(text);
  } catch {
    return fail("CLAIM_ORPHAN_EVIDENCE_INVALID", `${describe} is not JSON`);
  }
}

/** claim을 만든 run 하나를 `gh run view <id>`로 조회한다. 기록이 없으면(Not Found) { found: false }, 그 밖의 gh 오류는 그대로 던진다. */
export async function lookupClaimRun(runGh, repository, runId) {
  try {
    const run = await ghJson(runGh, ["run", "view", runId, "--repo", repository, "--json", "status,conclusion,workflowName,headBranch"], `run ${runId}`);
    return { found: true, status: run?.status, conclusion: run?.conclusion ?? null, workflowName: run?.workflowName, headBranch: run?.headBranch };
  } catch (error) {
    // 기록이 없는 run은 끝나서 사라진 run이다. 그 밖의 오류(권한·서버·네트워크)는 추정하지 않고 실패한다.
    if (isGhNotFound(error)) return { found: false };
    throw error;
  }
}

async function lookupCommits(runGh, repository, branch) {
  // claim 뒤에 무엇이 올라갔는지는 main과 비교한 결과로 안다. 브랜치가 사라졌으면 404로 실패한다(추정하지 않는다).
  const compared = await ghJson(runGh, [
    "api", `repos/${repository}/compare/main...${branch}`, "--jq",
    "{aheadBy: .ahead_by, changedFiles: ((.files // []) | length), messages: [.commits[].commit.message]}",
  ], `compare ${branch}`);
  if (!isObject(compared) || !isCount(compared.aheadBy) || !isCount(compared.changedFiles)
    || !Array.isArray(compared.messages) || compared.messages.some((message) => typeof message !== "string")) {
    fail("CLAIM_ORPHAN_EVIDENCE_INVALID", `compare ${branch} result`);
  }
  return { aheadBy: compared.aheadBy, subjects: compared.messages.map((message) => message.split("\n")[0]), changedFiles: compared.changedFiles };
}

async function lookupArtifacts(runGh, repository, runId) {
  try {
    const listed = await ghJson(runGh, ["api", `repos/${repository}/actions/runs/${runId}/artifacts?per_page=100`, "--jq", "[.artifacts[] | {name, expired}]"], `artifacts ${runId}`);
    return listed;
  } catch (error) {
    if (isGhNotFound(error)) return [];
    throw error;
  }
}

/**
 * PR 없는 claim마다 증거(run 상태, claim 뒤 커밋, receipt artifact)를 모은다. PR이 있는 claim은 조회하지 않는다.
 * 고아마다 gh run view 한 번, 커밋 비교 한 번, (receipt artifact를 정의한 workflow만) artifact 목록 한 번이다.
 */
export async function collectClaimEvidence({ workflowFile, repository, claimBranches, pullRequests, runGh = defaultRunGh } = {}) {
  const claimOwner = ownerOf(workflowFile);
  assertClaimBranches(workflowFile, claimBranches);
  const bound = boundBranches(workflowFile, repository, pullRequests);
  const evidence = [];
  for (const branch of claimBranches.filter((name) => !bound.has(name))) {
    const runId = claimRunId(workflowFile, branch);
    const run = await lookupClaimRun(runGh, repository, runId);
    const commits = await lookupCommits(runGh, repository, branch);
    const artifacts = claimOwner.receiptArtifact && run.found ? await lookupArtifacts(runGh, repository, runId) : [];
    evidence.push({ branch, runId, run, commits, artifacts });
  }
  return evidence;
}

function parseArgs(argv) {
  const keys = new Map([["--workflow", "workflowFile"], ["--repository", "repository"], ["--refs", "refs"], ["--prs", "prs"], ["--output", "output"]]);
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = keys.get(argv[index]);
    if (!key || Object.hasOwn(values, key) || typeof argv[index + 1] !== "string") fail("CLAIM_ORPHAN_INPUT_INVALID", `argument ${String(argv[index])}`);
    values[key] = argv[index + 1];
  }
  for (const key of keys.values()) if (!Object.hasOwn(values, key)) fail("CLAIM_ORPHAN_INPUT_INVALID", `missing ${key}`);
  return values;
}

export async function main(argv, { runGh = defaultRunGh, log = console.log } = {}) {
  const values = parseArgs(argv);
  const { prefix } = ownerOf(values.workflowFile);
  const claimBranches = parsePrefixedRefs(await readFile(values.refs, "utf8"), prefix, (detail) => fail("CLAIM_ORPHAN_INPUT_INVALID", `claim refs ${detail}`)).map(({ branch }) => branch);
  const pullRequests = JSON.parse(await readFile(values.prs, "utf8"));
  const evidence = await collectClaimEvidence({ workflowFile: values.workflowFile, repository: values.repository, claimBranches, pullRequests, runGh });
  await writeFile(values.output, `${JSON.stringify(evidence)}\n`);
  log(`claim evidence: claims=${claimBranches.length} orphans=${evidence.length} run_lookups=${evidence.length}`);
  return evidence;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
