#!/usr/bin/env node
// 원천 자동 갱신 workflow 실패를 이슈로 드러낸다(#860 알림 조건, #870 실패 동작).
// - workflow마다 열린 실패 이슈를 하나만 둔다. 없으면 만들고, 있으면 본문 상태 블록에 실패 run을 쌓는다.
// - 댓글 알림은 workflow 이슈당 하루 한 번이다. 이미 보고한 run(재실행 포함)은 다시 쓰지 않는다.
// - 같은 workflow의 열린 실패 이슈가 둘 이상이면 하나를 고르지 않고 실패한다.
// - 이 보고는 실패를 덮지 않는다. 갱신 job은 이미 실패했고, 이 단계는 실패를 사람이 보게 할 뿐이다.
// - 원천 재확인은 재확인 기한을 넘긴 recipe(--overdue)가 있으면 run이 성공으로 끝났어도(대기 run) 같은 이슈에 기록한다(#3036).
// - 원천이 여럿인 workflow는 실패한 원천(--source-id)을 이슈에 적고, 원천마다 마지막 실패 시각을 상태 블록 표지로 남긴다(#3036).
//   판정이 이 표지로 선택 원천의 재시도를 쿨다운한다. 이슈가 닫히면(회복) 표지도 함께 사라진다.
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { codepointCompare } from "../lib/codepoint-compare.mjs";
import { REVERIFICATION_BLOCKING_CODES } from "./source-reverification-paths.mjs";

export const REFRESH_WORKFLOWS = Object.freeze({
  "automation-pr-automerge.yml": "자동화 PR 자동 병합 정책(데이터 전용 PR)",
  "automation-pr-ci-rerun.yml": "자동화 PR의 CI 첫 시도 실패 job 한 번 재실행",
  "automation-blocked-redispatch.yml": "차단 PR 때문에 잃은 정기 슬롯 자동 재dispatch",
  "automation-pr-behind-recreate.yml": "뒤처진 자동화 PR 재생성(데이터 전용 PR)",
  "current-capital-topology-refresh.yml": "수도권 노선 구조(capital-route-topology)",
  "current-capital-topology-registration.yml": "수도권 노선 구조 등록(capital-route-topology)",
  "data-workflow-scheduler-watchdog.yml": "외부 정기 dispatch 스케줄러(OCI k3s CronJob) 중단 감시",
  "itx-current-promotion.yml": "ITX-청춘 원천 시간표 승격(itx-cheongchun-source-timetable)",
  "kric-current-facility-refresh.yml": "KRIC 역사 편의시설",
  "nationwide-candidate-refresh.yml": "전국 후보 갱신(nationwide candidate)",
  "retained-gwangju-timetable-refresh.yml": "KRIC 전국 시간표 파일(kric-nationwide-timetable-file)",
  "seoul-current-accessibility-refresh.yml": "서울 지하철 접근성",
  "source-derivative-rebinding.yml": "원천 파생 산출물 재결속(환승 지표·광주 보관 projection)",
  "source-reverification.yml": "P7D 원천 재확인(코레일·광주·부산·대전·대구 topology, KRIC 시간표 projection)",
});

// 정기 원천 갱신과 구조가 다른 workflow(발행·배포 체인)는 REFRESH_WORKFLOWS의 구조 계약 대상이 아니라 따로 등록한다(data#1084).
// 이슈 제목 규칙("원천 자동 갱신 실패")은 같아서 admin 자동화 상태가 같은 경로로 찾는다.
export const CHAIN_WORKFLOWS = Object.freeze({
  "datapack-release-cross-repo-chain.yml": "데이터팩 발행·배포 체인(RC 이후 호환성·승격·발행·배포·검증)",
});
// 롤백은 서버의 활성 pair만 되돌리고 공개 manifest는 새 release 번호에 남긴다. 이슈가 복구 완료처럼 읽히지 않도록 체인 실패에는 이 사실을 항상 적는다.
export const CHAIN_ROLLBACK_NOTE = "- 검증 실패로 롤백했다면 서버의 활성 FINAL은 직전 release이지만 공개 manifest(catalog/current.json)는 새 release 번호에 남는다. 실패 run 요약과 chain-state artifact의 `rollback.manifestMismatch`를 확인하고 공개 manifest를 정리해야 복구가 끝난다.";
const chainNote = (workflowFile) => (Object.hasOwn(CHAIN_WORKFLOWS, workflowFile) ? [CHAIN_ROLLBACK_NOTE] : []);
const REPORTABLE_WORKFLOWS = Object.freeze({ ...REFRESH_WORKFLOWS, ...CHAIN_WORKFLOWS });
export const REPORTABLE_WORKFLOW_FILES = Object.freeze(Object.keys(REPORTABLE_WORKFLOWS));

export const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const RUN_ID = /^[1-9]\d{0,19}$/u;
const RUN_URL_ID = /\/actions\/runs\/([1-9]\d{0,14})\b/gu;
export const COMMENT_INTERVAL_MS = 24 * 60 * 60 * 1000;
const MAX_RECORDED_RUNS = 20;
const STATUS_START = "<!-- refresh-failure-status:start -->";
const STATUS_END = "<!-- refresh-failure-status:end -->";
const COMMENT_MARKER = "<!-- easysubway-refresh-failure-comment -->";
// gh JSON에서 GITHUB_TOKEN(github-actions[bot])이 만든 이슈의 작성자 login
const BOT_LOGIN = "app/github-actions";
// 같은 토큰이 단 댓글의 작성자 login은 이슈와 달리 app/ 접두사가 없다.
const BOT_COMMENT_LOGIN = "github-actions";

function fail(code, detail = "") {
  throw new Error(detail ? `REFRESH_FAILURE_REPORT_${code}: ${detail}` : `REFRESH_FAILURE_REPORT_${code}`);
}

export function refreshFailureMarker(workflowFile) {
  return `<!-- easysubway-refresh-failure:${workflowFile} -->`;
}

function validated({ repository, workflowFile, runId }) {
  if (!Object.hasOwn(REPORTABLE_WORKFLOWS, workflowFile ?? "")) fail("WORKFLOW");
  if (typeof repository !== "string" || !REPOSITORY.test(repository)) fail("REPOSITORY");
  if (typeof runId !== "string" || !RUN_ID.test(runId)) fail("RUN_ID");
  return { repository, workflowFile, runId, runUrl: `https://github.com/${repository}/actions/runs/${runId}` };
}

// #995: PR 없는 claim을 지운 보고. producer run의 conclusion을 그대로 적고(무조건 실패라고 쓰지 않는다) 삭제 사실을 이슈에 남긴다.
function validatedOrphan(orphan) {
  if (orphan === undefined) return null;
  if (!orphan || typeof orphan !== "object" || typeof orphan.branch !== "string" || !orphan.branch.startsWith("automation/")
    || typeof orphan.conclusion !== "string" || orphan.conclusion === "" || typeof orphan.reason !== "string" || orphan.reason === "") fail("ORPHAN");
  return orphan;
}

const orphanMarker = (branch) => `<!-- easysubway-orphan-claim-removed:${branch} -->`;

function orphanLines(input, orphan) {
  return [
    `- producer run: ${input.runUrl} (conclusion: ${orphan.conclusion})`,
    `- 삭제한 claim 브랜치: \`${orphan.branch}\``,
    `- 분류 근거: ${orphan.reason}`,
    "- 삭제한 브랜치는 출력 커밋이 없는 빈 claim 하나였다. 복구에 쓸 증거는 남지 않는다.",
  ];
}

function instant(value, code) {
  const millis = typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(millis)) fail(code);
  return millis;
}

// 사람이 기대값을 고쳐야 풀리는 recipe 실패의 표지(#1122). 상태 블록 안에 두고, 이슈가 열려 있는 동안 쌓이기만 한다. 판정이 이 표지의 recipe를 건너뛴다.
const FAILURE_RECIPE_ID = /^[a-z][a-z0-9-]{0,63}$/u;
const FAILURE_CODE = /^[A-Z][A-Z0-9_]{1,63}$/u;
const BLOCK_MARKER = /^<!-- reverification-blocked:([a-z][a-z0-9-]{0,63}):([A-Z][A-Z0-9_]{1,63}) -->$/gmu;
const blockMarker = ({ recipeId, code }) => `<!-- reverification-blocked:${recipeId}:${code} -->`;
// 원천별 마지막 실패 시각 표지(#3036). 시각은 보고기가 쓴 ISO 순간(밀리초 포함)만 받는다.
const SOURCE_ID = FAILURE_RECIPE_ID;
const SOURCE_MARKER = /^<!-- refresh-source-failed:(\S+?):(\S+) -->$/gmu;
const sourceMarker = ({ sourceId, failedAt }) => `<!-- refresh-source-failed:${sourceId}:${failedAt} -->`;
const blocksOf = (text) => [...text.matchAll(BLOCK_MARKER)].map(([, recipeId, code]) => ({ recipeId, code })).filter(({ code }) => REVERIFICATION_BLOCKING_CODES.includes(code));

/** 이슈 본문에 표지가 남은 막힌 recipe id(중복 없음). */
export function blockedRecipeIdsOf(body) {
  return [...new Set(blocksOf(body).map(({ recipeId }) => recipeId))];
}

function mergedBlocks(existing, failures) {
  const merged = new Map([...existing, ...failures.filter(({ code }) => REVERIFICATION_BLOCKING_CODES.includes(code))].map((entry) => [blockMarker(entry), entry]));
  return [...merged.keys()].sort(codepointCompare);
}

function sourceFailuresIn(block) {
  return [...block.matchAll(SOURCE_MARKER)].map(([, sourceId, failedAt]) => {
    if (!SOURCE_ID.test(sourceId) || !Number.isFinite(Date.parse(failedAt)) || new Date(failedAt).toISOString() !== failedAt) fail("SOURCE_MARKER");
    return { sourceId, failedAt };
  });
}

// 원천마다 마지막 실패 시각 하나만 남긴다(최근 순, 같은 시각이면 원천 id 순). 이번 실패의 원천이 있으면 그 원천의 시각을 갱신한다.
function mergedSourceFailures(existing, sourceId, failedAt) {
  const latest = new Map(existing.map((entry) => [entry.sourceId, entry]));
  if (sourceId !== undefined) latest.set(sourceId, { sourceId, failedAt });
  return [...latest.values()].sort((left, right) => codepointCompare(right.failedAt, left.failedAt) || codepointCompare(left.sourceId, right.sourceId));
}

// 이슈 본문의 상태 블록: 보고한 실패 run(최근 순)과 마지막 보고 시각. 같은 run을 다시 보고하지 않는 근거다.
function statusBlock(runUrls, reportedAt, blocks = [], sourceFailures = []) {
  return [
    STATUS_START,
    `- 마지막 실패 보고 시각(UTC): ${reportedAt}`,
    `- 보고한 실패 run(최근 ${MAX_RECORDED_RUNS}개, 최근 순):`,
    ...runUrls.map((url) => `  - ${url}`),
    ...blocks,
    ...sourceFailures.map(sourceMarker),
    STATUS_END,
  ].join("\n");
}

function readStatus(body) {
  const begin = body.indexOf(STATUS_START);
  const end = body.indexOf(STATUS_END);
  if (begin === -1 || end === -1 || end < begin || body.indexOf(STATUS_START, begin + 1) !== -1) fail("STATUS_BLOCK");
  const block = body.slice(begin, end);
  const runUrls = [...block.matchAll(/^  - (https:\/\/github\.com\/\S+\/actions\/runs\/\d+)$/gmu)].map((match) => match[1]);
  return { runUrls, blocks: blocksOf(block), sourceFailures: sourceFailuresIn(block), replace: (next) => `${body.slice(0, begin)}${next}${body.slice(end + STATUS_END.length)}` };
}

function comments(issue) {
  if (!Array.isArray(issue.comments ?? [])) fail("ISSUES");
  return (issue.comments ?? []).map((comment) => {
    if (!comment || typeof comment.body !== "string") fail("ISSUES");
    return comment;
  });
}

// 이미 기록된 run이어도 claim을 지운 사실은 따로 남긴다. 같은 claim의 삭제는 한 번만 기록한다.
function planOrphanComment({ input, orphan, issue, status, issueComments, reportedAt, duplicateNumbers }) {
  // 이슈를 만들 때 본문에 적은 삭제 기록도 이미 기록된 것이다.
  if ((issue.body ?? "").includes(orphanMarker(orphan.branch)) || issueComments.some(({ body }) => body.includes(orphanMarker(orphan.branch)))) return { action: "skip", issueNumber: issue.number, duplicateNumbers };
  const recorded = status.runUrls.includes(input.runUrl) || issueComments.some(({ body }) => body.includes(input.runUrl));
  return {
    action: "comment",
    issueNumber: issue.number,
    ...(recorded ? {} : { issueBody: status.replace(statusBlock([input.runUrl, ...status.runUrls].slice(0, MAX_RECORDED_RUNS), reportedAt, mergedBlocks(status.blocks, []), status.sourceFailures)) }),
    duplicateNumbers,
    body: [
      orphanMarker(orphan.branch),
      `\`${input.workflowFile}\`의 PR 없는 claim 브랜치를 자동으로 삭제했다. 이전 데이터로 대체하지 않았다.`,
      "",
      ...orphanLines(input, orphan),
    ].join("\n"),
  };
}

/** 상태 블록 안의 원천별 마지막 실패 시각 표지. 형식이 틀린 표지는 추정하지 않고 실패한다. 호출자는 failureIssuesOf가 거른 봇 이슈만 넘긴다. */
export function sourceFailuresOf(body) {
  return readStatus(body).sourceFailures;
}

/**
 * 봇이 쓴 이슈 본문(상태 블록 포함)과 이 도구가 단 알림 댓글에 적힌 실패 run id. 하나도 없으면 빈 배열이다.
 * 사람 댓글과 다른 도구의 댓글은 읽지 않는다. Actions run id는 GitHub 전역에서 생성 순서대로 커지므로 가장 큰 값이 가장 최근 실패다.
 * 호출자는 failureIssuesOf가 거른 봇 이슈만 넘긴다.
 */
export function recordedRunIdsOf(issue) {
  const notices = comments(issue).filter(({ author, body }) => author?.login === BOT_COMMENT_LOGIN && body.includes(COMMENT_MARKER));
  return [issue.body ?? "", ...notices.map(({ body }) => body)].flatMap((text) => [...text.matchAll(RUN_URL_ID)].map(([, id]) => Number(id)));
}

/** 이 도구(workflow 토큰)가 만든, 제목 규칙이 같은 workflow 실패 이슈(번호순). 사람이 표지를 인용한 이슈는 무시한다. */
export function failureIssuesOf({ openIssues, workflowFile }) {
  if (!Object.hasOwn(REPORTABLE_WORKFLOWS, workflowFile ?? "")) fail("WORKFLOW");
  if (!Array.isArray(openIssues)) fail("ISSUES");
  const marker = refreshFailureMarker(workflowFile);
  const title = failureIssueTitle(workflowFile);
  return openIssues.filter((issue) => {
    if (!issue || typeof issue !== "object" || !Number.isSafeInteger(issue.number) || issue.number < 1
      || typeof (issue.body ?? "") !== "string") fail("ISSUES");
    return issue.author?.login === BOT_LOGIN && issue.title === title && (issue.body ?? "").includes(marker);
  }).sort((left, right) => left.number - right.number);
}

const inlineCode = (text) => `\`${text}\``;

// 재확인 기한을 넘긴 recipe(#3036). 대기 run은 실패하지 않았으므로 실패 문구 대신 연체 사실과 기록한 run을 적는다.
function overdueLines(input, overdue) {
  const recipes = overdue.map(inlineCode).join(", ");
  return [`- 재확인 기한을 넘긴 recipe: ${recipes}. 원장 head가 새로 등록될 때까지 run마다 이 이슈에 기록한다.`, `- 기록한 run: ${input.runUrl}`];
}

// 재알림 댓글의 첫 문장과 run 줄.
function noticeLines(input, overdue) {
  if (overdue.length > 0) return [`\`${input.workflowFile}\`의 원천이 아직 재확인 기한을 넘긴 상태다. 이전 데이터로 대체하지 않았다.`, "", ...overdueLines(input, overdue)];
  return [`\`${input.workflowFile}\`가 다시 실패했다. 이전 데이터로 대체하지 않았다.`, "", `- 실패 run: ${input.runUrl}`];
}

function reportBackground(input, { orphan, overdue }) {
  const workflow = `정기 원천 갱신 workflow \`${input.workflowFile}\``;
  if (orphan) return [`- ${workflow}의 run이 PR 없는 claim 브랜치를 남겼고, 자동으로 삭제했다. 이전 데이터로 대체하지 않았다.`, ...orphanLines(input, orphan), orphanMarker(orphan.branch)];
  if (overdue.length > 0) return [`- ${workflow}의 원천이 재확인 기한을 넘겼다. 이전 데이터로 대체하지 않았다.`, ...overdueLines(input, overdue)];
  return [`- ${workflow}가 실패했다. 이전 데이터로 대체하지 않았다.`, `- 실패 run: ${input.runUrl}`];
}

// 빈 값과 생략은 원천 없음이다. 이름은 이슈 본문과 표지에 그대로 들어가므로 식별자 형식이 아니면 받지 않는다.
function validatedSourceId(sourceId) {
  if (sourceId === undefined || sourceId === "") return undefined;
  if (typeof sourceId !== "string" || !SOURCE_ID.test(sourceId)) fail("SOURCE_ID", "source id must be an identifier");
  return sourceId;
}

const sourceLines = (sourceId) => (sourceId === undefined ? [] : [`- 실패 원천: ${inlineCode(sourceId)}`]);

const failureIssueTitle = (workflowFile) => `[Fix] 원천 자동 갱신 실패: ${REPORTABLE_WORKFLOWS[workflowFile]} (${workflowFile})`;

export function planRefreshFailureReport({ repository, workflowFile, runId, openIssues, now, orphan: orphanInput, failures = [], overdue = [], sourceId: sourceIdInput }) {
  const input = validated({ repository, workflowFile, runId });
  const orphan = validatedOrphan(orphanInput);
  const sourceId = validatedSourceId(sourceIdInput);
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) fail("CLOCK");
  if (!Array.isArray(openIssues)) fail("ISSUES");
  const marker = refreshFailureMarker(input.workflowFile);
  const label = REPORTABLE_WORKFLOWS[input.workflowFile];
  const title = failureIssueTitle(input.workflowFile);
  const matching = failureIssuesOf({ openIssues, workflowFile: input.workflowFile });
  // 중복이 생겨도 보고를 멈추지 않는다. 가장 오래된 이슈에 계속 기록하고, 실행 결과는 복구 안내와 함께 실패로 끝낸다.
  const duplicateNumbers = matching.slice(1).map(({ number }) => number);
  const reportedAt = now.toISOString();
  if (matching.length > 0) {
    const issue = matching[0];
    const status = readStatus(issue.body);
    const issueComments = comments(issue);
    if (orphan) return planOrphanComment({ input, orphan, issue, status, issueComments, reportedAt, duplicateNumbers });
    if (status.runUrls.includes(input.runUrl) || issueComments.some(({ body }) => body.includes(input.runUrl))) {
      return { action: "skip", issueNumber: issue.number, duplicateNumbers };
    }
    const issueBody = status.replace(statusBlock([input.runUrl, ...status.runUrls].slice(0, MAX_RECORDED_RUNS), reportedAt, mergedBlocks(status.blocks, failures), mergedSourceFailures(status.sourceFailures, sourceId, reportedAt)));
    const lastNotice = Math.max(
      instant(issue.createdAt, "ISSUES"),
      ...issueComments.filter(({ body }) => body.includes(COMMENT_MARKER)).map(({ createdAt }) => instant(createdAt, "ISSUES")),
    );
    if (now.getTime() - lastNotice < COMMENT_INTERVAL_MS) return { action: "status", issueNumber: issue.number, issueBody, duplicateNumbers };
    return {
      action: "comment",
      issueNumber: issue.number,
      issueBody,
      duplicateNumbers,
      body: [
        COMMENT_MARKER,
        ...noticeLines(input, overdue),
        ...sourceLines(sourceId),
        ...chainNote(input.workflowFile),
        "- 같은 workflow의 실패는 하루에 한 번만 댓글로 알린다. 그 사이 실패 run은 이슈 본문 상태 블록에 쌓인다.",
        ...(duplicateNumbers.length > 0
          ? [`- 같은 workflow의 실패 이슈가 더 있다: ${duplicateNumbers.map((number) => `#${number}`).join(", ")}. 이 이슈만 남기고 닫아야 보고 단계가 성공한다.`]
          : []),
      ].join("\n"),
    };
  }
  return {
    action: "create",
    title,
    body: [
      marker,
      "### 목표",
      `${label} 원천 자동 갱신의 실패 원인을 고쳐 다음 정기 실행이 성공하게 한다.`,
      "",
      "### 배경",
      ...reportBackground(input, { orphan, overdue }),
      ...sourceLines(sourceId),
      ...chainNote(input.workflowFile),
      ...(mergedBlocks([], failures).length > 0
        ? ["- 공급처 응답이 고정 기대 관측과 달라져 사람이 기대값을 고쳐야 풀리는 recipe가 있다(상태 블록의 표지). 이 이슈가 열려 있는 동안 그 recipe는 다시 수집하지 않는다. 기대값을 고친 뒤 이 이슈를 닫으면 다음 실행이 다시 수집한다."]
        : []),
      "- 이 이슈는 workflow가 만들었다. 같은 workflow가 다시 실패하면 아래 상태 블록에 run을 쌓고, 하루에 한 번 댓글로 알린다.",
      "",
      "### 완료 조건",
      "- 실패 원인을 이 이슈에 적고 고친다.",
      "- 다음 run이 성공하면 `recovered-failure-issues-close.yml`이 성공 run URL을 남기고 이 이슈를 자동으로 닫는다(표지가 남은 이슈와 PR 단위 workflow의 이슈는 사람이 닫는다).",
      "",
      "### 실패 상태",
      statusBlock([input.runUrl], reportedAt, mergedBlocks([], failures), mergedSourceFailures([], sourceId, reportedAt)),
      "",
      "Refs #860",
      "Refs #870",
    ].join("\n"),
  };
}

// --failures(원천 재확인 controller가 쓴 실패 목록), --overdue(재확인 판정의 연체 recipe, 쉼표 목록), --source-id(실패한 원천, 빈 값은 원천 없음)만 선택이다.
const REQUIRED_ARGUMENTS = Object.freeze(["workflowFile", "repository", "runId"]);

function parseArgs(argv) {
  const names = new Map([["--workflow", "workflowFile"], ["--repository", "repository"], ["--run-id", "runId"], ["--failures", "failuresPath"], ["--overdue", "overdueList"], ["--source-id", "sourceId"]]);
  const values = {};
  if (!Array.isArray(argv) || argv.length % 2 !== 0) fail("ARGUMENTS");
  for (let index = 0; index < argv.length; index += 2) {
    const key = names.get(argv[index]);
    if (!key || Object.hasOwn(values, key) || typeof argv[index + 1] !== "string") fail("ARGUMENTS");
    values[key] = argv[index + 1];
  }
  if (REQUIRED_ARGUMENTS.some((key) => !Object.hasOwn(values, key))) fail("ARGUMENTS");
  return values;
}

// 빈 값은 연체 없음이다. 이름은 이슈 본문에 그대로 들어가므로 식별자 형식이 아니면 받지 않는다.
function parseOverdue(list = "") {
  if (list === "") return [];
  const recipeIds = list.split(",");
  if (recipeIds.some((recipeId) => !FAILURE_RECIPE_ID.test(recipeId))) fail("OVERDUE", "recipe ids must be comma-separated identifiers");
  return recipeIds;
}

// PATH 조회 없이 고정 경로로 gh를 찾는다(PATH 오염 차단, tools/route-map/svg-crop/render-svg.mjs와 같은 방식).
export const GH_CANDIDATES = Object.freeze(["/usr/bin/gh", "/opt/homebrew/bin/gh", "/usr/local/bin/gh"]);
const isRegularFile = (candidate) => existsSync(candidate) && statSync(candidate).isFile();

export function resolveGh({ isFile = isRegularFile } = {}) {
  for (const candidate of GH_CANDIDATES) {
    if (isFile(candidate)) return candidate;
  }
  return fail("GH_EXECUTABLE");
}

export function defaultRunGh(args, input = null, { resolve: resolveExecutable = resolveGh } = {}) {
  const gh = resolveExecutable();
  return new Promise((resolve, reject) => {
    const child = spawn(gh, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`gh ${args.slice(0, 2).join(" ")} failed: ${stderr.trim().split("\n").at(-1) ?? ""}`));
    });
    child.stdin.end(input ?? "");
  });
}

// controller가 쓴 실패 목록([{ recipeId, code }]). 파일이 없으면 controller가 실패를 하나도 남기지 않은 것이다. 형식이 틀리면 추정하지 않고 실패한다.
async function readFailures(file, readText) {
  if (file === undefined) return [];
  let text;
  try {
    text = await readText(file);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  let failures;
  try {
    failures = JSON.parse(text);
  } catch {
    return fail("FAILURES", "not JSON");
  }
  // 표지는 이슈 본문에 한 줄 주석으로 들어간다. 식별자 형식이 아니면 본문을 깨뜨릴 수 있어 받지 않는다.
  if (!Array.isArray(failures) || failures.some((entry) => !FAILURE_RECIPE_ID.test(entry?.recipeId) || !FAILURE_CODE.test(entry.code))) fail("FAILURES", "entries must be { recipeId, code }");
  return failures;
}

/** 저장소의 열린 이슈(최대 1000개). 보고와 자동 종료가 같은 필드를 읽는다. */
export async function listOpenIssues(repository, runGh) {
  try {
    return JSON.parse(await runGh([
      "issue", "list", "--repo", repository, "--state", "open", "--limit", "1000", "--json", "number,title,body,author,createdAt,comments",
    ]));
  } catch (error) {
    if (error instanceof SyntaxError) fail("ISSUES");
    throw error;
  }
}

export async function reportRefreshFailure({
  argv = process.argv.slice(2), runGh = defaultRunGh, now = () => new Date(), orphan, readText = (file) => readFile(file, "utf8"),
} = {}) {
  const { failuresPath, overdueList, sourceId, ...args } = parseArgs(argv);
  const input = validated(args);
  const overdue = parseOverdue(overdueList);
  const failures = await readFailures(failuresPath, readText);
  const openIssues = await listOpenIssues(input.repository, runGh);
  const plan = planRefreshFailureReport({ ...input, openIssues, now: now(), orphan, failures, overdue, sourceId });
  if (plan.action === "create") {
    await runGh(["issue", "create", "--repo", input.repository, "--title", plan.title, "--body-file", "-"], plan.body);
    return plan;
  }
  // 댓글을 먼저 단다. 본문 갱신이 실패해도 댓글에 run이 남아 다음 보고가 같은 run을 건너뛴다.
  if (plan.action === "comment") {
    await runGh(["issue", "comment", String(plan.issueNumber), "--repo", input.repository, "--body-file", "-"], plan.body);
  }
  if (plan.issueBody !== undefined) {
    await runGh(["issue", "edit", String(plan.issueNumber), "--repo", input.repository, "--body-file", "-"], plan.issueBody);
  }
  if (plan.duplicateNumbers.length > 0) {
    const numbers = [plan.issueNumber, ...plan.duplicateNumbers].map((number) => `#${number}`).join(", ");
    fail("DUPLICATE_ISSUES", `${input.workflowFile}의 열린 실패 이슈가 여럿이다(${numbers}). 이번 실패는 #${plan.issueNumber}에 기록했다. #${plan.issueNumber} 하나만 남기고 나머지를 닫으면 다음 실패부터 정상 보고된다.`);
  }
  return plan;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const plan = await reportRefreshFailure();
    process.stdout.write(`${JSON.stringify({ action: plan.action, issueNumber: plan.issueNumber ?? null })}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
