#!/usr/bin/env node
// PR 없는 claim 브랜치(고아)의 공통 판정(#995).
//
// 원장을 쓰는 갱신 workflow는 provider에 접근하기 전에 claim 브랜치(빈 커밋)를 push한다. run이 그 뒤에 실패하면 claim이 PR 없이 남는다.
// 남은 claim은 원장을 쓰는 다른 자동화를 모두 대기시키므로(ledger-writers-idle) 소유 workflow가 스스로 판정해 정리해야 한다.
// 이 모듈은 그 판정을 한 곳에 둔다. 각 workflow의 판정(decide-*·classify*)이 가져다 쓴다.
//
// claim이 고아인 조건: 같은 저장소의 main 대상 PR이 어떤 상태로도 없다. 고아는 만든 run(브랜치 이름의 run id)과 그 run의 step 기록으로 가른다.
//   ACTIVE       만든 run이 아직 끝나지 않았다(completed가 아니다). 기다린다. 정상이다.
//   RECOVERABLE  claim 뒤에 출력 커밋이 있거나, 게시 step이 시작된 run의 보존 증거(KRIC artifact)가 있다. 소유 workflow가 DUE·CURRENT와 무관하게 복구한다.
//                복구 step이 형식을 검증하고 어긋나면 실패한다. 내용이 있는 브랜치는 이 모듈이 지우지 않는다.
//   ABANDONED    빈 claim 하나뿐이고 만든 run이 OCI 게시 step까지 가지 않았다(수집 단계 실패 등). 게시된 것이 없다. 보고(#926)한 뒤 지운다(remove-orphan-claims.mjs).
// 게시 step이 시작된 run은 OCI에 객체를 올렸을 수 있다. 출력 커밋도 보존 증거도 없으면 "게시됐지만 등록되지 않았을 수 있는" 상태라서 지우지 않고
// CLAIM_ORPHAN_PUBLISHED_UNREGISTERED로 실패한다(사람이 볼 이상 상황이고, 실패한 job이 #926 보고로 드러난다).
// run 기록이 없거나(Not Found) step 정보가 없으면 게시 step까지 갔는지 알 수 없으므로 빈 claim이라도 지우지 않고 실패한다.
// 그 밖의 판정할 수 없는 상태(다른 workflow·main이 아닌 run을 가리키는 claim, 알 수 없는 run 상태, 어긋난 증거, 증거 없는 고아)도 CLAIM_ORPHAN_* 코드로 실패한다.
// 추정하거나 성공으로 덮지 않는다.
//
// 게시 step(publicationSteps)은 workflow 파일의 step 이름과 같아야 한다(계약 테스트가 대조한다). collect·publish를 한 step에서 하면 수집 실패와
// 게시 이후 실패를 가를 수 없으므로 광주·서울·KRIC은 두 step으로 나눠 두었다. 분리 전 합쳐진 step 이름도 표에 남겨 둔다(그 step이 시작된 옛 run은 게시된 것으로 본다).
//
// run 조회는 #987 리뷰 F1·#994의 상한 패턴을 따른다: 끝난 run 이력을 목록으로 받지 않고(`gh run list` 없음) 고아마다 `gh run view <id>` 한 번.
// Not Found는 { found: false }로 수집하고 그 밖의 gh 오류는 fail closed다. claim 브랜치는 MAX_CLAIM_BRANCHES(50)를 넘으면 gh를 부르기 전에 실패한다.
//
// 증거 수집 사용: node tools/ci/claim-orphans.mjs --workflow <file> --repository <owner/repo> --refs <git ls-remote 출력> --prs <collect-automation-prs.mjs 출력> --output <path>
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { ownPullRequestsByBranch, parsePrefixedRefs, validRepository } from "./automation-pr-state.mjs";
import { MAX_CLAIM_BRANCHES } from "./collect-automation-prs.mjs";
import { REFRESH_CLAIM_PREFIXES } from "./refresh-open-pr-age.mjs";
import { defaultRunGh } from "./report-refresh-failure.mjs";

// claim 브랜치를 provider 접근 전에 만드는 갱신 workflow.
// - publicationSteps: OCI 게시를 하는 step 이름(첫 이름이 현재, 나머지는 분리 전). null이면 이 workflow는 OCI에 게시하지 않는다. undefined면 이 workflow의 판정은 자기 의미를 쓴다(등록·재확인).
// - receiptArtifact: 게시 step이 시작된 run이 남기는 보존 증거 artifact 이름(KRIC). 출력 커밋이 증거인 workflow(광주·서울·topology)는 없다.
// - abandonedSubject: 소유 workflow가 "닫았다"고 남기는 커밋 제목.
const owner = (workflowFile, workflowName, claimSubject, extra = {}) => Object.freeze({ prefix: REFRESH_CLAIM_PREFIXES[workflowFile], workflowName, claimSubject, ...extra });
export const CLAIM_OWNERS = Object.freeze({
  "retained-gwangju-timetable-refresh.yml": owner("retained-gwangju-timetable-refresh.yml", "Retained Gwangju Timetable Refresh", "Claim retained Gwangju timetable refresh", {
    publicationSteps: Object.freeze(["Publish and register retained Gwangju timetable", "Refresh due retained Gwangju timetable"]),
  }),
  "seoul-current-accessibility-refresh.yml": owner("seoul-current-accessibility-refresh.yml", "Seoul Current Accessibility Refresh", "Claim Seoul accessibility refresh", {
    publicationSteps: Object.freeze(["Publish and register Seoul accessibility snapshot", "Collect and bind current snapshot"]),
  }),
  "kric-current-facility-refresh.yml": owner("kric-current-facility-refresh.yml", "KRIC Current Facility Refresh", "Claim KRIC facility refresh", {
    publicationSteps: Object.freeze(["KRIC current facility refresh / Publish and register current snapshot", "KRIC current facility refresh / Collect and bind current snapshot"]),
    abandonedSubject: "Abandon KRIC facility refresh claim",
    receiptArtifact: (runId) => `kric-current-facility-refresh-${runId}`,
  }),
  // 수도권 topology 갱신은 입력을 git 커밋으로만 남기고 OCI에 게시하지 않는다.
  "current-capital-topology-refresh.yml": owner("current-capital-topology-refresh.yml", "Current Capital Topology Refresh", "Claim current topology refresh", { publicationSteps: null }),
  "current-capital-topology-registration.yml": owner("current-capital-topology-registration.yml", "Current Capital Topology Registration", "Claim capital topology registration", {
    receiptArtifact: (runId) => `current-capital-topology-registration-${runId}`,
  }),
  "source-reverification.yml": owner("source-reverification.yml", "Source Reverification", "Claim source reverification"),
});

// 분리 전 합쳐진 step에서 실패한 옛 run은 수집 단계 실패와 게시 이후 실패를 step으로 가를 수 없다. 로그로 게시 전 실패가 확인된 run만 여기에 둔다.
// 근거는 값에 적는다. 새 run은 분리된 게시 step으로 판정하므로 이 표는 늘리지 않는다.
export const VERIFIED_PRE_PUBLICATION_RUNS = Object.freeze({
  "retained-gwangju-timetable-refresh.yml": Object.freeze({
    "37399282636": "step log ends with KRIC_TIMETABLE_FILE_BODY 30.1s after the step started; collectKricNationwideTimetableFile is the controller's first call, before OCI publication (checked 2026-10-07)",
  }),
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

const byText = (left, right) => (left < right ? -1 : Number(left > right));
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isCount = (value) => Number.isSafeInteger(value) && value >= 0;

function assertEvidence(claimOwner, evidence) {
  const invalid = (detail) => fail("CLAIM_ORPHAN_EVIDENCE_INVALID", detail);
  if (!isObject(evidence) || typeof evidence.branch !== "string") invalid("evidence is not an object");
  if (!evidence.branch.startsWith(claimOwner.prefix) || evidence.runId !== evidence.branch.slice(claimOwner.prefix.length) || !RUN_ID.test(evidence.runId)) invalid(`${evidence.branch} run id`);
  const { run, commits, artifacts } = evidence;
  if (!isObject(run) || typeof run.found !== "boolean") invalid(`${evidence.branch} run`);
  if (run.found && (!RUN_STATUSES.includes(run.status) || typeof run.workflowName !== "string" || typeof run.headBranch !== "string"
    || !(run.conclusion === null || typeof run.conclusion === "string")
    || !Array.isArray(run.steps) || run.steps.some((item) => !isObject(item) || typeof item.name !== "string" || typeof item.status !== "string"
      || !(item.conclusion === null || typeof item.conclusion === "string")))) invalid(`${evidence.branch} run state`);
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

/** claim 뒤에 커밋이 하나(빈 claim)뿐인가. 개수·제목·변경 파일 중 하나라도 다르면 내용이 있는 브랜치다. */
export function isEmptyClaim(workflowFile, commits) {
  return commits.aheadBy === 1 && commits.subjects.length === 1 && commits.subjects[0] === ownerOf(workflowFile).claimSubject && commits.changedFiles === 0;
}

// 게시 step이 시작됐는가. 건너뛰어진(skipped) step과 시작되지 않은 step은 게시하지 않았다. 목록에 게시 step이 하나도 없으면 판단할 수 없다.
function publicationStarted(claimOwner, claimRun, branch) {
  const found = claimRun.steps.filter(({ name }) => claimOwner.publicationSteps.includes(name));
  if (found.length === 0) fail("CLAIM_ORPHAN_STEPS_UNAVAILABLE", `${branch}: producer run has no ${claimOwner.publicationSteps[0]} step record`);
  // 끝난 run에서 건너뛰어지지 않은 step은 실행됐다(성공·실패·취소·시간 초과). 취소된 run의 미시작 step도 시작된 것으로 본다(지우지 않는 쪽).
  return found.some(({ conclusion }) => conclusion !== null && conclusion !== "skipped");
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
  // 빈 claim 하나뿐인 브랜치만 "출력 커밋이 없다"고 본다. 개수·제목·내용 중 하나라도 다르면 내용이 있는 브랜치라 지우지 않는다.
  // 빈 claim이라는 것만으로는 게시되지 않았다는 증거가 아니다. 게시는 출력 커밋보다 먼저 일어난다(아래 step 판정).
  if (!isEmptyClaim(workflowFile, commits)) return result("RECOVERABLE", "BRANCH_CARRIES_OUTPUT");
  if (claimOwner.publicationSteps === null) return result("ABANDONED", "EMPTY_CLAIM_NO_PUBLICATION");
  if (!run.found) fail("CLAIM_ORPHAN_RUN_UNAVAILABLE", `${branch}: producer run ${runId} record is gone, so whether it reached publication is unknown; the claim is kept`);
  if (!publicationStarted(claimOwner, run, branch)) return result("ABANDONED", "PUBLISH_STEP_NOT_STARTED");
  if (VERIFIED_PRE_PUBLICATION_RUNS[workflowFile]?.[runId] && run.steps.every(({ name }) => name !== claimOwner.publicationSteps[0])) return result("ABANDONED", "VERIFIED_PRE_PUBLICATION");
  const retained = claimOwner.receiptArtifact?.(runId);
  if (retained && artifacts.some((artifact) => artifact.name === retained && artifact.expired === false)) return result("RECOVERABLE", "RETAINED_EVIDENCE");
  return fail("CLAIM_ORPHAN_PUBLISHED_UNREGISTERED", `${branch}: producer run ${runId} started ${claimOwner.publicationSteps[0]} but left no output commit or retained evidence; the claim is kept for a human check`);
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
  for (const group of Object.values(groups)) group.sort(byText);
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

/**
 * claim을 만든 run 하나를 `gh run view <id>`로 조회한다. job의 step을 평탄화해 steps로 돌려준다(게시 step까지 갔는지 판정하는 근거).
 * 기록이 없으면(Not Found) { found: false }, 그 밖의 gh 오류는 그대로 던진다.
 */
export async function lookupClaimRun(runGh, repository, runId) {
  try {
    const run = await ghJson(runGh, ["run", "view", runId, "--repo", repository, "--json", "status,conclusion,workflowName,headBranch,jobs"], `run ${runId}`);
    const steps = (Array.isArray(run?.jobs) ? run.jobs : []).flatMap((job) => (Array.isArray(job?.steps) ? job.steps : []))
      .map(({ name, status, conclusion }) => ({ name, status, conclusion: conclusion === "" ? null : (conclusion ?? null) }));
    return { found: true, status: run?.status, conclusion: run?.conclusion ?? null, workflowName: run?.workflowName, headBranch: run?.headBranch, steps };
  } catch (error) {
    // 기록이 없는 run은 { found: false }다. 권한·서버·네트워크 오류는 추정하지 않고 실패한다.
    if (isGhNotFound(error)) return { found: false };
    throw error;
  }
}

/** claim 브랜치가 main보다 몇 커밋 앞서는지와 변경 파일 수를 `gh api compare`로 조회한다. 브랜치가 없으면 404로 실패한다(추정하지 않는다). */
export async function lookupClaimCommits(runGh, repository, branch) {
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
 * PR 없는 claim마다 증거(run 상태, claim 뒤 커밋, 보존 증거 artifact)를 모은다. PR이 있는 claim은 조회하지 않는다(Abandon 커밋을 쓰는 workflow만 커밋을 본다).
 * 고아마다 gh run view 한 번, 커밋 비교 한 번, (receipt artifact를 정의한 workflow만) artifact 목록 한 번이다.
 */
export async function collectClaimEvidence({ workflowFile, repository, claimBranches, pullRequests, runGh = defaultRunGh } = {}) {
  const claimOwner = ownerOf(workflowFile);
  assertClaimBranches(workflowFile, claimBranches);
  const bound = boundBranches(workflowFile, repository, pullRequests);
  const evidence = [];
  // Abandon 커밋을 남기는 workflow는 PR이 붙은 claim의 커밋도 본다(닫았다고 기록한 claim에 PR이 붙으면 이상이다). run은 조회하지 않는다.
  if (claimOwner.abandonedSubject) {
    for (const branch of claimBranches.filter((name) => bound.has(name))) {
      evidence.push({ branch, runId: claimRunId(workflowFile, branch), bound: true, commits: await lookupClaimCommits(runGh, repository, branch) }); // NOSONAR -- gh 호출은 일부러 순차다(claim 50개 상한)
    }
  }
  for (const branch of claimBranches.filter((name) => !bound.has(name))) {
    const runId = claimRunId(workflowFile, branch);
    // gh 호출은 일부러 순차다(claim 50개 상한, 조회 폭주 방지).
    const run = await lookupClaimRun(runGh, repository, runId); // NOSONAR
    const commits = await lookupClaimCommits(runGh, repository, branch); // NOSONAR
    const artifacts = claimOwner.receiptArtifact && run.found ? await lookupArtifacts(runGh, repository, runId) : []; // NOSONAR
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
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
