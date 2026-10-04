import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  REFRESH_WORKFLOWS,
  planRefreshFailureReport,
  refreshFailureMarker,
  reportRefreshFailure,
} from "./report-refresh-failure.mjs";

const repository = "AquilaXk/easysubway-data";
const workflowFile = "current-capital-topology-refresh.yml";
const runUrl = `https://github.com/${repository}/actions/runs/123`;

function workflowText(file) {
  return readFileSync(new URL(`../../.github/workflows/${file}`, import.meta.url), "utf8");
}

function stepBody(yml, name) {
  const start = yml.indexOf(`      - name: ${name}\n`);
  assert.notEqual(start, -1, `missing workflow step: ${name}`);
  const end = yml.indexOf("\n      - name: ", start + 1);
  return yml.slice(start, end === -1 ? yml.length : end);
}

test("first failure of a refresh workflow opens one issue that names the failed run (#860·#870)", () => {
  const plan = planRefreshFailureReport({ repository, workflowFile, runId: "123", openIssues: [] });
  assert.equal(plan.action, "create");
  assert.match(plan.title, /^\[Fix\] 원천 자동 갱신 실패: /u);
  assert.ok(plan.title.includes(workflowFile));
  assert.ok(plan.body.includes(refreshFailureMarker(workflowFile)));
  assert.ok(plan.body.includes(runUrl));
  assert.match(plan.body, /이전 데이터로 대체하지 않았다/u);
  assert.match(plan.body, /Refs #860/u);
  assert.match(plan.body, /Refs #870/u);
  assert.doesNotMatch(plan.body, /\/Users\/|\/Volumes\/|\/home\/runner/u);
});

test("repeated failure comments on the open issue of the same workflow instead of opening another", () => {
  const openIssues = [
    { number: 11, body: `${refreshFailureMarker("seoul-current-accessibility-refresh.yml")}\nother` },
    { number: 12, body: `${refreshFailureMarker(workflowFile)}\nfirst failure` },
  ];
  const plan = planRefreshFailureReport({ repository, workflowFile, runId: "124", openIssues });
  assert.equal(plan.action, "comment");
  assert.equal(plan.issueNumber, 12);
  assert.ok(plan.body.includes(`https://github.com/${repository}/actions/runs/124`));
});

test("duplicate open failure issues for one workflow fail instead of choosing one", () => {
  const openIssues = [
    { number: 12, body: refreshFailureMarker(workflowFile) },
    { number: 13, body: refreshFailureMarker(workflowFile) },
  ];
  assert.throws(
    () => planRefreshFailureReport({ repository, workflowFile, runId: "125", openIssues }),
    /REFRESH_FAILURE_REPORT_DUPLICATE_ISSUES/u,
  );
});

test("unknown workflow, repository, or run identity is rejected before any GitHub call", async () => {
  assert.throws(() => planRefreshFailureReport({ repository, workflowFile: "ci.yml", runId: "1", openIssues: [] }),
    /REFRESH_FAILURE_REPORT_WORKFLOW/u);
  assert.throws(() => planRefreshFailureReport({ repository: "not a repo", workflowFile, runId: "1", openIssues: [] }),
    /REFRESH_FAILURE_REPORT_REPOSITORY/u);
  for (const runId of ["0", "-1", "12a", "", undefined]) {
    assert.throws(() => planRefreshFailureReport({ repository, workflowFile, runId, openIssues: [] }),
      /REFRESH_FAILURE_REPORT_RUN_ID/u);
  }
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

test("CLI lists open issues once, then creates or comments through gh with the planned body", async () => {
  const createCalls = [];
  const created = await reportRefreshFailure({
    argv: ["--workflow", workflowFile, "--repository", repository, "--run-id", "123"],
    runGh: async (args, input) => {
      createCalls.push({ args, input });
      return args[1] === "list" ? "[]\n" : "https://github.com/AquilaXk/easysubway-data/issues/99\n";
    },
  });
  assert.equal(created.action, "create");
  assert.deepEqual(createCalls[0].args, [
    "issue", "list", "--repo", repository, "--state", "open", "--limit", "1000", "--json", "number,body",
  ]);
  assert.deepEqual(createCalls[1].args.slice(0, 4), ["issue", "create", "--repo", repository]);
  assert.equal(createCalls[1].args[createCalls[1].args.indexOf("--title") + 1], created.title);
  assert.ok(createCalls[1].args.includes("--body-file"));
  assert.equal(createCalls[1].input, created.body);
  assert.equal(createCalls.length, 2);

  const commentCalls = [];
  const commented = await reportRefreshFailure({
    argv: ["--workflow", workflowFile, "--repository", repository, "--run-id", "124"],
    runGh: async (args, input) => {
      commentCalls.push({ args, input });
      return args[1] === "list" ? JSON.stringify([{ number: 7, body: refreshFailureMarker(workflowFile) }]) : "";
    },
  });
  assert.equal(commented.action, "comment");
  assert.deepEqual(commentCalls[1].args.slice(0, 5), ["issue", "comment", "7", "--repo", repository]);
  assert.equal(commentCalls[1].input, commented.body);
});

test("a malformed issue listing fails the report instead of opening a duplicate issue", async () => {
  const calls = [];
  await assert.rejects(reportRefreshFailure({
    argv: ["--workflow", workflowFile, "--repository", repository, "--run-id", "123"],
    runGh: async (args) => { calls.push(args); return "{\"not\":\"a list\"}"; },
  }), /REFRESH_FAILURE_REPORT_ISSUES/u);
  assert.equal(calls.length, 1);
});

test("every scheduled source refresh workflow reports its own failure as an issue (#860 알림 조건)", () => {
  assert.deepEqual(Object.keys(REFRESH_WORKFLOWS).sort(), [
    "current-capital-topology-refresh.yml",
    "kric-current-facility-refresh.yml",
    "retained-gwangju-timetable-refresh.yml",
    "seoul-current-accessibility-refresh.yml",
  ]);
  for (const file of Object.keys(REFRESH_WORKFLOWS)) {
    const yml = workflowText(file);
    assert.match(yml, /\n  issues: write\n/u, `${file} needs issues: write`);
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
