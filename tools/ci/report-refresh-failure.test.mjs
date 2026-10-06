import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
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
    "current-capital-topology-refresh.yml",
    "current-capital-topology-registration.yml",
    "kric-current-facility-refresh.yml",
    "nationwide-candidate-refresh.yml",
    "retained-gwangju-timetable-refresh.yml",
    "seoul-current-accessibility-refresh.yml",
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
    assert.match(body, /\n        if: \$\{\{ failure\(\) \}\}\n/u, `${file} must report only on failure`);
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
