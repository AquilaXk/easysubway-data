import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CHAIN_ROLLBACK_NOTE,
  CHAIN_WORKFLOWS,
  COMMENT_INTERVAL_MS,
  GH_CANDIDATES,
  REFRESH_WORKFLOWS,
  defaultRunGh,
  planRefreshFailureReport,
  refreshFailureMarker,
  reportRefreshFailure,
  resolveGh,
} from "./report-refresh-failure.mjs";

const repository = "AquilaXk/easysubway-data";
const workflowFile = "current-capital-topology-refresh.yml";
const runUrl = (id) => `https://github.com/${repository}/actions/runs/${id}`;
const start = new Date("2026-10-04T00:47:00.000Z");
const hours = (value) => value * 60 * 60 * 1000;

function workflowText(file) {
  return readFileSync(new URL(`../../.github/workflows/${file}`, import.meta.url), "utf8");
}

function stepBody(yml, name) {
  const begin = yml.indexOf(`      - name: ${name}\n`);
  assert.notEqual(begin, -1, `missing workflow step: ${name}`);
  const end = yml.indexOf("\n      - name: ", begin + 1);
  return yml.slice(begin, end === -1 ? yml.length : end);
}

// gh issue list/create/comment/edit만 흉내 내는 저장소. 실행된 쓰기 호출을 기록한다.
function fakeGitHub(initialIssues = []) {
  const issues = structuredClone(initialIssues);
  const writes = [];
  let clock = start;
  const runGh = async (args, input) => {
    const [, command] = args;
    if (command === "list") {
      return JSON.stringify(issues.filter(({ state }) => state === "OPEN").map(({ state, ...issue }) => issue));
    }
    writes.push({ command, args, input });
    if (command === "create") {
      const number = 100 + issues.length;
      issues.push({
        number, state: "OPEN", title: args[args.indexOf("--title") + 1], body: input,
        author: { login: "app/github-actions", is_bot: true }, createdAt: clock.toISOString(), comments: [],
      });
      return `https://github.com/${repository}/issues/${number}\n`;
    }
    const issue = issues.find(({ number }) => number === Number(args[2]));
    assert.ok(issue, `unknown issue ${args[2]}`);
    if (command === "comment") issue.comments.push({ author: { login: "github-actions" }, body: input, createdAt: clock.toISOString() });
    else if (command === "edit") issue.body = input;
    else assert.fail(`unexpected gh command ${command}`);
    return "";
  };
  return { issues, writes, runGh, setClock: (value) => { clock = value; } };
}

async function report(github, runId, now) {
  github.setClock(now);
  return reportRefreshFailure({
    argv: ["--workflow", workflowFile, "--repository", repository, "--run-id", String(runId)],
    runGh: github.runGh,
    now: () => now,
  });
}

function botIssue(number, overrides = {}) {
  const plan = planRefreshFailureReport({ repository, workflowFile, runId: String(number), openIssues: [], now: start });
  return {
    number, title: plan.title, body: plan.body, author: { login: "app/github-actions", is_bot: true },
    createdAt: start.toISOString(), comments: [], state: "OPEN", ...overrides,
  };
}

test("first failure of a refresh workflow opens one issue that names the failed run (#860·#870)", () => {
  const plan = planRefreshFailureReport({ repository, workflowFile, runId: "123", openIssues: [], now: start });
  assert.equal(plan.action, "create");
  assert.match(plan.title, /^\[Fix\] 원천 자동 갱신 실패: /u);
  assert.ok(plan.title.includes(workflowFile));
  assert.ok(plan.body.includes(refreshFailureMarker(workflowFile)));
  assert.ok(plan.body.includes(runUrl(123)));
  assert.match(plan.body, /이전 데이터로 대체하지 않았다/u);
  assert.match(plan.body, /Refs #860/u);
  assert.match(plan.body, /Refs #870/u);
  assert.doesNotMatch(plan.body, /\/Users\/|\/Volumes\/|\/home\/runner/u);
});

test("a later failure after the comment interval comments once and records the run in the issue status", async () => {
  const github = fakeGitHub();
  await report(github, 1, start);
  const plan = await report(github, 2, new Date(start.getTime() + COMMENT_INTERVAL_MS));
  assert.equal(plan.action, "comment");
  assert.deepEqual(github.writes.map(({ command }) => command), ["create", "comment", "edit"]);
  assert.ok(github.issues[0].comments[0].body.includes(runUrl(2)));
  assert.ok(github.issues[0].body.includes(runUrl(2)));
  assert.ok(github.issues[0].body.includes(runUrl(1)));
});

test("failures inside the comment interval only update the issue status, without a comment (F1)", async () => {
  const github = fakeGitHub();
  await report(github, 1, start);
  const plan = await report(github, 2, new Date(start.getTime() + hours(2)));
  assert.equal(plan.action, "status");
  assert.deepEqual(github.writes.map(({ command }) => command), ["create", "edit"]);
  assert.equal(github.issues[0].comments.length, 0);
  assert.ok(github.issues[0].body.includes(runUrl(2)));
});

test("the same run reported again (rerun or retried step) changes nothing (F1)", async () => {
  const github = fakeGitHub();
  await report(github, 1, start);
  await report(github, 2, new Date(start.getTime() + COMMENT_INTERVAL_MS));
  const writesBefore = github.writes.length;
  for (const [runId, offset] of [[1, hours(30)], [2, hours(30)], [2, hours(60)]]) {
    const plan = await report(github, runId, new Date(start.getTime() + offset));
    assert.equal(plan.action, "skip", `run ${runId}`);
  }
  assert.equal(github.writes.length, writesBefore);
});

test("a two-hourly outage of three days posts one issue and one comment per day (F1 반복 시나리오)", async () => {
  const github = fakeGitHub();
  const actions = [];
  for (let index = 0; index < 36; index += 1) {
    actions.push((await report(github, 1000 + index, new Date(start.getTime() + hours(2 * index)))).action);
  }
  assert.equal(github.issues.length, 1);
  assert.equal(actions.filter((action) => action === "create").length, 1);
  assert.equal(github.issues[0].comments.length, 2);
  assert.equal(actions.filter((action) => action === "status").length, 33);
  assert.ok(github.issues[0].body.includes(runUrl(1035)));
});

test("an open failure issue without the status block fails instead of guessing what was reported", () => {
  const issue = { ...botIssue(7), body: refreshFailureMarker(workflowFile) };
  assert.throws(() => planRefreshFailureReport({ repository, workflowFile, runId: "9", openIssues: [issue], now: start }),
    /REFRESH_FAILURE_REPORT_STATUS_BLOCK/u);
});

test("only bot-authored issues with the exact failure title count as the workflow failure issue (F2)", async () => {
  const humanCopy = botIssue(5, { author: { login: "AquilaXk", is_bot: false } });
  const otherTitle = botIssue(6, { title: "[Fix] 다른 제목" });
  const github = fakeGitHub([humanCopy, otherTitle]);
  const plan = await report(github, 7, start);
  assert.equal(plan.action, "create");
  const github2 = fakeGitHub([humanCopy, otherTitle, botIssue(8)]);
  const plan2 = await report(github2, 9, new Date(start.getTime() + hours(2)));
  assert.equal(plan2.action, "status");
  assert.equal(plan2.issueNumber, 8);
});

test("duplicate bot failure issues keep reporting into the oldest one and then fail with recovery guidance (F2)", async () => {
  const github = fakeGitHub([botIssue(13), botIssue(12)]);
  await assert.rejects(report(github, 20, new Date(start.getTime() + COMMENT_INTERVAL_MS)),
    (error) => /REFRESH_FAILURE_REPORT_DUPLICATE_ISSUES/u.test(error.message)
      && error.message.includes("#12, #13") && /하나만 남기고 나머지를 닫/u.test(error.message));
  const oldest = github.issues.find(({ number }) => number === 12);
  assert.ok(oldest.body.includes(runUrl(20)), "the failure is still recorded");
  assert.equal(oldest.comments.length, 1);
  assert.match(oldest.comments[0].body, /#13/u);
  assert.equal(github.issues.find(({ number }) => number === 13).comments.length, 0);
});

test("unknown workflow, repository, run identity, or clock is rejected before any GitHub call", async () => {
  assert.throws(() => planRefreshFailureReport({ repository, workflowFile: "ci.yml", runId: "1", openIssues: [], now: start }),
    /REFRESH_FAILURE_REPORT_WORKFLOW/u);
  assert.throws(() => planRefreshFailureReport({ repository: "not a repo", workflowFile, runId: "1", openIssues: [], now: start }),
    /REFRESH_FAILURE_REPORT_REPOSITORY/u);
  for (const runId of ["0", "-1", "12a", "", undefined]) {
    assert.throws(() => planRefreshFailureReport({ repository, workflowFile, runId, openIssues: [], now: start }),
      /REFRESH_FAILURE_REPORT_RUN_ID/u);
  }
  assert.throws(() => planRefreshFailureReport({ repository, workflowFile, runId: "1", openIssues: [], now: new Date(Number.NaN) }),
    /REFRESH_FAILURE_REPORT_CLOCK/u);
  const calls = [];
  await assert.rejects(reportRefreshFailure({
    argv: ["--workflow", "ci.yml", "--repository", repository, "--run-id", "1"],
    runGh: async (args) => { calls.push(args); return "[]"; },
  }), /REFRESH_FAILURE_REPORT_WORKFLOW/u);
  await assert.rejects(reportRefreshFailure({
    argv: ["--workflow", workflowFile, "--repository", repository],
    runGh: async (args) => { calls.push(args); return "[]"; },
  }), /REFRESH_FAILURE_REPORT_ARGUMENTS/u);
  assert.deepEqual(calls, []);
});

test("CLI lists open issues once with comments, then creates through gh with the planned body", async () => {
  const calls = [];
  const created = await reportRefreshFailure({
    argv: ["--workflow", workflowFile, "--repository", repository, "--run-id", "123"],
    runGh: async (args, input) => {
      calls.push({ args, input });
      return args[1] === "list" ? "[]\n" : `https://github.com/${repository}/issues/99\n`;
    },
    now: () => start,
  });
  assert.equal(created.action, "create");
  assert.deepEqual(calls[0].args, [
    "issue", "list", "--repo", repository, "--state", "open", "--limit", "1000",
    "--json", "number,title,body,author,createdAt,comments",
  ]);
  assert.deepEqual(calls[1].args.slice(0, 4), ["issue", "create", "--repo", repository]);
  assert.equal(calls[1].args[calls[1].args.indexOf("--title") + 1], created.title);
  assert.ok(calls[1].args.includes("--body-file"));
  assert.equal(calls[1].input, created.body);
  assert.equal(calls.length, 2);
});

test("a malformed issue listing fails the report instead of opening a duplicate issue", async () => {
  const calls = [];
  await assert.rejects(reportRefreshFailure({
    argv: ["--workflow", workflowFile, "--repository", repository, "--run-id", "123"],
    runGh: async (args) => { calls.push(args); return "{\"not\":\"a list\"}"; },
    now: () => start,
  }), /REFRESH_FAILURE_REPORT_ISSUES/u);
  assert.equal(calls.length, 1);
});

test("every scheduled source refresh workflow reports its own failure as an issue (#860 알림 조건)", () => {
  assert.deepEqual(Object.keys(REFRESH_WORKFLOWS).sort(), [
    "automation-blocked-redispatch.yml",
    "automation-pr-automerge.yml",
    "automation-pr-behind-recreate.yml",
    "automation-pr-ci-rerun.yml",
    "current-capital-topology-refresh.yml",
    "current-capital-topology-registration.yml",
    "data-workflow-scheduler-watchdog.yml",
    "itx-current-promotion.yml",
    "kric-current-facility-refresh.yml",
    "nationwide-candidate-refresh.yml",
    "retained-gwangju-timetable-refresh.yml",
    "seoul-current-accessibility-refresh.yml",
    "source-derivative-rebinding.yml",
    "source-reverification.yml",
  ]);
  for (const file of Object.keys(REFRESH_WORKFLOWS)) {
    const yml = workflowText(file);
    // F4: issues write는 workflow 전체가 아니라 갱신 job에만 준다.
    assert.match(yml, /\npermissions: \{\}\n/u, `${file} must not grant permissions at workflow level`);
    assert.doesNotMatch(yml, /\n  issues: write\n/u, `${file} must not grant issues: write at workflow level`);
    assert.match(yml, /\n    permissions:\n(?:      [a-z-]+: (?:read|write)\n)*      issues: write\n/u, `${file} needs job-level issues: write`);
    assert.equal((yml.match(/\n    permissions:\n/gu) ?? []).length, 1, `${file} has exactly one job permission block`);
    const stepName = file === "kric-current-facility-refresh.yml"
      ? "KRIC current facility refresh / Report refresh failure as an issue"
      : "Report refresh failure as an issue";
    const body = stepBody(yml, stepName);
    // #972 리뷰: 등록 workflow는 취소·시간 초과로 끝난 실행도 보고한다(PR 없는 claim이 조용히 남지 않게).
    const condition = ["current-capital-topology-registration.yml", "nationwide-candidate-refresh.yml", "source-derivative-rebinding.yml", "source-reverification.yml", "itx-current-promotion.yml"].includes(file) ? String.raw`failure\(\) \|\| cancelled\(\)` : String.raw`failure\(\)`;
    assert.match(body, new RegExp(String.raw`\n        if: \$\{\{ ${condition} \}\}\n`, "u"), `${file} must report only on failure`);
    assert.match(body, /GH_TOKEN: \$\{\{ github\.token \}\}/u);
    assert.ok(body.includes(
      `node tools/ci/report-refresh-failure.mjs --workflow ${file} --repository "\${GITHUB_REPOSITORY}" --run-id "\${GITHUB_RUN_ID}"`,
    ), `${file} must report with its own workflow identity`);
    assert.equal(yml.trimEnd().endsWith(body.trimEnd()), true, `${file} must report after every other step`);
    assert.doesNotMatch(body, /continue-on-error/u);
  }
});

test("retained Gwangju timetable refresh can be dispatched once for the #860 verification run", () => {
  const yml = workflowText("retained-gwangju-timetable-refresh.yml");
  assert.match(yml, /^on:\n  schedule:\n    - cron: "43 \*\/2 \* \* \*"\n  workflow_dispatch:\n/mu);
  assert.doesNotMatch(yml, /workflow_dispatch:\n    inputs:/u);
});

test("gh is resolved only from fixed paths, in order, and a missing gh fails with GH_EXECUTABLE (F3)", () => {
  assert.deepEqual(GH_CANDIDATES, ["/usr/bin/gh", "/opt/homebrew/bin/gh", "/usr/local/bin/gh"]);
  const checked = [];
  const found = resolveGh({ isFile: (candidate) => { checked.push(candidate); return candidate === "/opt/homebrew/bin/gh"; } });
  assert.equal(found, "/opt/homebrew/bin/gh");
  assert.deepEqual(checked, ["/usr/bin/gh", "/opt/homebrew/bin/gh"]);
  assert.equal(resolveGh({ isFile: () => true }), "/usr/bin/gh");
  assert.throws(() => resolveGh({ isFile: () => false }), /REFRESH_FAILURE_REPORT_GH_EXECUTABLE/u);
});

test("the default gh runner passes args and stdin to the resolved executable and surfaces its failure (F3)", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "fake-gh-"));
  try {
    const executable = path.join(directory, "gh");
    await writeFile(executable, [
      "#!/bin/sh",
      "input=$(cat)",
      "if [ \"$1\" = \"fail\" ]; then echo \"first line\" >&2; echo \"HTTP 403: denied\" >&2; exit 4; fi",
      "printf \"%s|%s|%s\" \"$1\" \"$2\" \"$input\"",
      "",
    ].join("\n"));
    await chmod(executable, 0o755);
    const resolve = () => executable;
    assert.equal(await defaultRunGh(["issue", "list"], "stdin body", { resolve }), "issue|list|stdin body");
    await assert.rejects(defaultRunGh(["fail", "now"], null, { resolve }), /gh fail now failed: HTTP 403: denied/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// #995 F3: PR 없는 claim을 지울 때의 보고. 이미 실패로 기록된 run이어도 "claim을 지웠다"는 사실이 이슈에 남아야 하고,
// producer run의 conclusion을 그대로 적는다(무조건 실패라고 쓰지 않는다).
const orphanClaim = (overrides = {}) => ({ branch: "automation/636-current-topology-refresh-123", conclusion: "cancelled", reason: "EMPTY_CLAIM_NO_PUBLICATION", ...overrides });

test("an orphan claim removal report opens an issue that states the run conclusion and the removed branch", () => {
  const plan = planRefreshFailureReport({ repository, workflowFile, runId: "123", openIssues: [], now: start, orphan: orphanClaim() });
  assert.equal(plan.action, "create");
  assert.ok(plan.body.includes(runUrl(123)));
  assert.ok(plan.body.includes("automation/636-current-topology-refresh-123"));
  assert.match(plan.body, /conclusion: cancelled/u);
  assert.match(plan.body, /EMPTY_CLAIM_NO_PUBLICATION/u);
  assert.match(plan.body, /삭제/u);
  assert.doesNotMatch(plan.body, /가 실패했다/u, "producer run의 conclusion을 그대로 적고 무조건 실패라고 쓰지 않는다");
});

test("a run already recorded as failed still gets one comment that records the claim removal, and the same removal is not repeated", async () => {
  const github = fakeGitHub();
  await report(github, 123, start);
  const writesBefore = github.writes.length;
  const orphanReport = (when) => { github.setClock(when); return reportRefreshFailure({ argv: ["--workflow", workflowFile, "--repository", repository, "--run-id", "123"], runGh: github.runGh, now: () => when, orphan: orphanClaim() }); };
  const first = await orphanReport(new Date(start.getTime() + hours(1)));
  assert.equal(first.action, "comment");
  assert.equal(github.writes.length, writesBefore + 1);
  const [comment] = github.issues[0].comments;
  assert.ok(comment.body.includes("automation/636-current-topology-refresh-123"));
  assert.match(comment.body, /conclusion: cancelled/u);
  assert.match(comment.body, /삭제/u);
  assert.equal((await orphanReport(new Date(start.getTime() + hours(2)))).action, "skip");
  assert.equal(github.writes.length, writesBefore + 1);
  // 같은 run의 다른 claim 삭제는 따로 기록한다.
  const other = await reportRefreshFailure({ argv: ["--workflow", workflowFile, "--repository", repository, "--run-id", "123"], runGh: github.runGh, now: () => new Date(start.getTime() + hours(3)), orphan: orphanClaim({ branch: "automation/636-current-topology-refresh-124" }) });
  assert.equal(other.action, "comment");
});

test("an orphan claim whose producer run succeeded is reported as succeeded, not failed", () => {
  const plan = planRefreshFailureReport({ repository, workflowFile, runId: "124", openIssues: [], now: start, orphan: orphanClaim({ conclusion: "success" }) });
  assert.match(plan.body, /conclusion: success/u);
  assert.doesNotMatch(plan.body, /conclusion: (failure|cancelled)/u);
});

test("an invalid orphan description is rejected before any GitHub call", async () => {
  for (const orphan of [{ branch: "main", conclusion: "failure", reason: "X" }, { branch: "automation/x-1", conclusion: 7, reason: "X" }, { branch: "automation/x-1", conclusion: "failure" }, "x"]) {
    assert.throws(() => planRefreshFailureReport({ repository, workflowFile, runId: "1", openIssues: [], now: start, orphan }), /REFRESH_FAILURE_REPORT_ORPHAN/u, JSON.stringify(orphan));
  }
});

// #995 F3 잔여: 이슈를 만들 때 본문에 적은 삭제 기록도 "이미 기록됨"이다. 같은 삭제를 comment로 다시 쓰지 않는다.
test("an orphan removal already written in the issue body is not repeated as a comment", async () => {
  const github = fakeGitHub();
  const orphanReport = (when) => { github.setClock(when); return reportRefreshFailure({ argv: ["--workflow", workflowFile, "--repository", repository, "--run-id", "123"], runGh: github.runGh, now: () => when, orphan: orphanClaim() }); };
  assert.equal((await orphanReport(start)).action, "create");
  assert.ok(github.issues[0].body.includes("easysubway-orphan-claim-removed:automation/636-current-topology-refresh-123"));
  const writesBefore = github.writes.length;
  assert.equal((await orphanReport(new Date(start.getTime() + hours(1)))).action, "skip");
  assert.equal(github.writes.length, writesBefore);
  assert.equal(github.issues[0].comments.length, 0);
  // 다른 claim의 삭제는 여전히 따로 기록한다.
  github.setClock(new Date(start.getTime() + hours(2)));
  const other = await reportRefreshFailure({ argv: ["--workflow", workflowFile, "--repository", repository, "--run-id", "123"], runGh: github.runGh, now: () => new Date(start.getTime() + hours(2)), orphan: orphanClaim({ branch: "automation/636-current-topology-refresh-124" }) });
  assert.equal(other.action, "comment");
});

test("데이터팩 발행·배포 체인도 같은 실패 이슈 경로(#926)로 보고하고 admin이 찾는 제목 규칙을 유지한다 (data#1084)", () => {
  assert.deepEqual(Object.keys(CHAIN_WORKFLOWS), ["datapack-release-cross-repo-chain.yml"]);
  // 구조 계약(permissions {}, 단일 job)이 다른 workflow라 정기 갱신 목록(REFRESH_WORKFLOWS)에는 넣지 않는다.
  assert.equal(Object.hasOwn(REFRESH_WORKFLOWS, "datapack-release-cross-repo-chain.yml"), false);
  const plan = planRefreshFailureReport({
    repository, workflowFile: "datapack-release-cross-repo-chain.yml", runId: "37900000001", openIssues: [], now: start,
  });
  assert.equal(plan.action, "create");
  assert.equal(plan.title, `[Fix] 원천 자동 갱신 실패: ${CHAIN_WORKFLOWS["datapack-release-cross-repo-chain.yml"]} (datapack-release-cross-repo-chain.yml)`);
  assert.match(plan.title, /원천 자동 갱신 실패/u);
  assert.match(plan.body, new RegExp(refreshFailureMarker("datapack-release-cross-repo-chain.yml").replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  assert.throws(() => planRefreshFailureReport({ repository, workflowFile: "other.yml", runId: "1", openIssues: [], now: start }), /WORKFLOW/u);
});

test("체인 실패 이슈는 롤백 뒤 공개 manifest와 서버 활성 FINAL이 어긋난다는 사실을 본문과 재알림 댓글에 적고, 정기 갱신 이슈에는 적지 않는다 (data#1084 F7)", () => {
  const chain = planRefreshFailureReport({ repository, workflowFile: "datapack-release-cross-repo-chain.yml", runId: "37900000001", openIssues: [], now: start });
  assert.ok(chain.body.includes(CHAIN_ROLLBACK_NOTE));
  assert.match(CHAIN_ROLLBACK_NOTE, /rollback\.manifestMismatch/u);
  const [workflowFile] = Object.keys(REFRESH_WORKFLOWS);
  const refresh = planRefreshFailureReport({ repository, workflowFile, runId: "37900000002", openIssues: [], now: start });
  assert.equal(refresh.body.includes(CHAIN_ROLLBACK_NOTE), false);
  const created = { number: 5, title: chain.title, body: chain.body, author: { login: "app/github-actions" }, createdAt: "2026-10-01T00:00:00.000Z", comments: [] };
  const again = planRefreshFailureReport({ repository, workflowFile: "datapack-release-cross-repo-chain.yml", runId: "37900000003", openIssues: [created], now: new Date("2026-10-09T00:00:00.000Z") });
  assert.equal(again.action, "comment");
  assert.ok(again.body.includes(CHAIN_ROLLBACK_NOTE));
});
