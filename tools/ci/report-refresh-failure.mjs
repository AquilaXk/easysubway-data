#!/usr/bin/env node
// 원천 자동 갱신 workflow 실패를 이슈로 드러낸다(#860 알림 조건, #870 실패 동작).
// - workflow마다 열린 실패 이슈를 하나만 둔다. 없으면 만들고, 있으면 본문 상태 블록에 실패 run을 쌓는다.
// - 댓글 알림은 workflow 이슈당 하루 한 번이다. 이미 보고한 run(재실행 포함)은 다시 쓰지 않는다.
// - 같은 workflow의 열린 실패 이슈가 둘 이상이면 하나를 고르지 않고 실패한다.
// - 이 보고는 실패를 덮지 않는다. 갱신 job은 이미 실패했고, 이 단계는 실패를 사람이 보게 할 뿐이다.
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const REFRESH_WORKFLOWS = Object.freeze({
  "current-capital-topology-refresh.yml": "수도권 노선 구조(capital-route-topology)",
  "kric-current-facility-refresh.yml": "KRIC 역사 편의시설",
  "retained-gwangju-timetable-refresh.yml": "KRIC 전국 시간표 파일(kric-nationwide-timetable-file)",
  "seoul-current-accessibility-refresh.yml": "서울 지하철 접근성",
});

const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const RUN_ID = /^[1-9]\d{0,19}$/u;
export const COMMENT_INTERVAL_MS = 24 * 60 * 60 * 1000;
const MAX_RECORDED_RUNS = 20;
const STATUS_START = "<!-- refresh-failure-status:start -->";
const STATUS_END = "<!-- refresh-failure-status:end -->";
const COMMENT_MARKER = "<!-- easysubway-refresh-failure-comment -->";

function fail(code) {
  throw new Error(`REFRESH_FAILURE_REPORT_${code}`);
}

export function refreshFailureMarker(workflowFile) {
  return `<!-- easysubway-refresh-failure:${workflowFile} -->`;
}

function validated({ repository, workflowFile, runId }) {
  if (!Object.hasOwn(REFRESH_WORKFLOWS, workflowFile ?? "")) fail("WORKFLOW");
  if (typeof repository !== "string" || !REPOSITORY.test(repository)) fail("REPOSITORY");
  if (typeof runId !== "string" || !RUN_ID.test(runId)) fail("RUN_ID");
  return { repository, workflowFile, runId, runUrl: `https://github.com/${repository}/actions/runs/${runId}` };
}

function instant(value, code) {
  const millis = typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(millis)) fail(code);
  return millis;
}

// 이슈 본문의 상태 블록: 보고한 실패 run(최근 순)과 마지막 보고 시각. 같은 run을 다시 보고하지 않는 근거다.
function statusBlock(runUrls, reportedAt) {
  return [
    STATUS_START,
    `- 마지막 실패 보고 시각(UTC): ${reportedAt}`,
    `- 보고한 실패 run(최근 ${MAX_RECORDED_RUNS}개, 최근 순):`,
    ...runUrls.map((url) => `  - ${url}`),
    STATUS_END,
  ].join("\n");
}

function readStatus(body) {
  const begin = body.indexOf(STATUS_START);
  const end = body.indexOf(STATUS_END);
  if (begin === -1 || end === -1 || end < begin || body.indexOf(STATUS_START, begin + 1) !== -1) fail("STATUS_BLOCK");
  const block = body.slice(begin, end);
  const runUrls = [...block.matchAll(/^  - (https:\/\/github\.com\/\S+\/actions\/runs\/\d+)$/gmu)].map((match) => match[1]);
  return { runUrls, replace: (next) => `${body.slice(0, begin)}${next}${body.slice(end + STATUS_END.length)}` };
}

function comments(issue) {
  if (!Array.isArray(issue.comments ?? [])) fail("ISSUES");
  return (issue.comments ?? []).map((comment) => {
    if (!comment || typeof comment.body !== "string") fail("ISSUES");
    return comment;
  });
}

export function planRefreshFailureReport({ repository, workflowFile, runId, openIssues, now }) {
  const input = validated({ repository, workflowFile, runId });
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) fail("CLOCK");
  if (!Array.isArray(openIssues)) fail("ISSUES");
  const marker = refreshFailureMarker(input.workflowFile);
  const matching = openIssues.filter((issue) => {
    if (!issue || typeof issue !== "object" || !Number.isSafeInteger(issue.number) || issue.number < 1
      || typeof (issue.body ?? "") !== "string") fail("ISSUES");
    return (issue.body ?? "").includes(marker);
  });
  if (matching.length > 1) fail("DUPLICATE_ISSUES");
  const label = REFRESH_WORKFLOWS[input.workflowFile];
  const reportedAt = now.toISOString();
  if (matching.length === 1) {
    const issue = matching[0];
    const status = readStatus(issue.body);
    const issueComments = comments(issue);
    if (status.runUrls.includes(input.runUrl) || issueComments.some(({ body }) => body.includes(input.runUrl))) {
      return { action: "skip", issueNumber: issue.number };
    }
    const issueBody = status.replace(statusBlock([input.runUrl, ...status.runUrls].slice(0, MAX_RECORDED_RUNS), reportedAt));
    const lastNotice = Math.max(
      instant(issue.createdAt, "ISSUES"),
      ...issueComments.filter(({ body }) => body.includes(COMMENT_MARKER)).map(({ createdAt }) => instant(createdAt, "ISSUES")),
    );
    if (now.getTime() - lastNotice < COMMENT_INTERVAL_MS) return { action: "status", issueNumber: issue.number, issueBody };
    return {
      action: "comment",
      issueNumber: issue.number,
      issueBody,
      body: [
        COMMENT_MARKER,
        `\`${input.workflowFile}\`가 다시 실패했다. 이전 데이터로 대체하지 않았다.`,
        "",
        `- 실패 run: ${input.runUrl}`,
        "- 같은 workflow의 실패는 하루에 한 번만 댓글로 알린다. 그 사이 실패 run은 이슈 본문 상태 블록에 쌓인다.",
      ].join("\n"),
    };
  }
  return {
    action: "create",
    title: `[Fix] 원천 자동 갱신 실패: ${label} (${input.workflowFile})`,
    body: [
      marker,
      "### 목표",
      `${label} 원천 자동 갱신의 실패 원인을 고쳐 다음 정기 실행이 성공하게 한다.`,
      "",
      "### 배경",
      `- 정기 원천 갱신 workflow \`${input.workflowFile}\`가 실패했다. 이전 데이터로 대체하지 않았다.`,
      `- 실패 run: ${input.runUrl}`,
      "- 이 이슈는 workflow가 만들었다. 같은 workflow가 다시 실패하면 아래 상태 블록에 run을 쌓고, 하루에 한 번 댓글로 알린다.",
      "",
      "### 완료 조건",
      "- 실패 원인을 이 이슈에 적고 고친다.",
      "- 다음 run이 성공한 것을 확인하고 이 이슈를 닫는다.",
      "",
      "### 실패 상태",
      statusBlock([input.runUrl], reportedAt),
      "",
      "Refs #860",
      "Refs #870",
    ].join("\n"),
  };
}

function parseArgs(argv) {
  const names = new Map([["--workflow", "workflowFile"], ["--repository", "repository"], ["--run-id", "runId"]]);
  const values = {};
  if (!Array.isArray(argv) || argv.length !== names.size * 2) fail("ARGUMENTS");
  for (let index = 0; index < argv.length; index += 2) {
    const key = names.get(argv[index]);
    if (!key || Object.hasOwn(values, key) || typeof argv[index + 1] !== "string") fail("ARGUMENTS");
    values[key] = argv[index + 1];
  }
  return values;
}

// PATH 조회 없이 고정 경로로 gh를 찾는다(PATH 오염 차단, tools/route-map/svg-crop/render-svg.mjs와 같은 방식).
function resolveGh() {
  for (const candidate of ["/usr/bin/gh", "/opt/homebrew/bin/gh", "/usr/local/bin/gh"]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return fail("GH_EXECUTABLE");
}

function defaultRunGh(args, input = null) {
  const gh = resolveGh();
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

export async function reportRefreshFailure({ argv = process.argv.slice(2), runGh = defaultRunGh, now = () => new Date() } = {}) {
  const args = parseArgs(argv);
  const input = validated(args);
  let openIssues;
  try {
    openIssues = JSON.parse(await runGh([
      "issue", "list", "--repo", input.repository, "--state", "open", "--limit", "1000", "--json", "number,title,body,author,createdAt,comments",
    ]));
  } catch (error) {
    if (error instanceof SyntaxError) fail("ISSUES");
    throw error;
  }
  const plan = planRefreshFailureReport({ ...input, openIssues, now: now() });
  if (plan.action === "create") {
    await runGh(["issue", "create", "--repo", input.repository, "--title", plan.title, "--body-file", "-"], plan.body);
    return plan;
  }
  // 댓글을 먼저 단다. 본문 갱신이 실패해도 댓글에 run이 남아 다음 보고가 같은 run을 건너뛴다.
  if (plan.action === "comment") {
    await runGh(["issue", "comment", String(plan.issueNumber), "--repo", input.repository, "--body-file", "-"], plan.body);
  }
  if (plan.action === "comment" || plan.action === "status") {
    await runGh(["issue", "edit", String(plan.issueNumber), "--repo", input.repository, "--body-file", "-"], plan.issueBody);
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
