import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { guardFailureReasonPath } from "./failure-reason.mjs";
import {
  CHAIN_ROLLBACK_NOTE,
  CHAIN_WORKFLOWS,
  COMMENT_INTERVAL_MS,
  GH_CANDIDATES,
  REFRESH_WORKFLOWS,
  defaultRunGh,
  failureIssuesOf,
  failureReasonOf,
  planRefreshFailureReport,
  planRefreshFailureSummary,
  recordedRunIdsOf,
  refreshFailureMarker,
  reportRefreshFailure,
  resolveGh,
  sourceFailuresOf,
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

function botIssue(number, overrides = {}) {
  const plan = planRefreshFailureReport({ repository, workflowFile, runId: String(number), openIssues: [], now: start });
  return {
    number, title: plan.title, body: plan.body, author: { login: "app/github-actions", is_bot: true },
    createdAt: start.toISOString(), comments: [], state: "OPEN", ...overrides,
  };
}

test("단독 운영 실패 보고는 이슈/댓글/sub-issue API를 호출하지 않고 step summary와 ::error 주석만 남긴다", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "refresh-summary-"));
  try {
    const summaryPath = path.join(dir, "step-summary.md");
    const ghCalls = [];
    const annotations = [];
    const result = await reportRefreshFailure({
      argv: ["--workflow", workflowFile, "--repository", repository, "--run-id", "123"],
      env: { GITHUB_STEP_SUMMARY: summaryPath },
      runGh: async (args) => { ghCalls.push(args); return "[]"; },
      emitAnnotation: (line) => { annotations.push(line); },
      now: () => start,
    });
    assert.deepEqual(ghCalls, []);
    assert.equal(result.action, "summary");
    assert.equal(result.issueNumber, null);
    assert.equal(annotations.length, 1);
    assert.match(annotations[0], /^::error title=원천 자동 갱신 실패 \(current-capital-topology-refresh\.yml\)::/u);
    assert.ok(annotations[0].includes(runUrl(123)));
    const written = await readFile(summaryPath, "utf8");
    assert.ok(written.includes(workflowFile));
    assert.ok(written.includes(runUrl(123)));
    assert.match(written, /이전 데이터로 대체하지 않았다/u);
    assert.doesNotMatch(written, /\/Users\/|\/Volumes\/|\/home\/runner/u);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("step summary와 ::error 주석은 로컬 파일 경로를 노출하지 않고, 체인 workflow에만 롤백 안내를 포함한다", () => {
  const chain = planRefreshFailureSummary({
    repository,
    workflowFile: "datapack-release-cross-repo-chain.yml",
    runId: "37900000001",
    now: start,
  });
  assert.equal(chain.action, "summary");
  assert.ok(chain.summary.includes(CHAIN_ROLLBACK_NOTE));
  assert.match(chain.annotation, /rollback\.manifestMismatch/u);

  const orphanSummary = planRefreshFailureSummary({
    repository,
    workflowFile,
    runId: "123",
    now: start,
    orphan: { branch: "automation/636-current-topology-refresh-123", conclusion: "cancelled", reason: "failed at /Volumes/secret/work/out.json" },
  });
  assert.doesNotMatch(orphanSummary.summary, /\/Volumes\/secret/u);
  assert.doesNotMatch(orphanSummary.annotation, /\/Volumes\/secret/u);
  assert.ok(orphanSummary.summary.includes("<redacted-path>"));

  const refresh = planRefreshFailureSummary({ repository, workflowFile, runId: "37900000002", now: start });
  assert.equal(refresh.summary.includes(CHAIN_ROLLBACK_NOTE), false);
});

test("unknown workflow, repository, run identity, or clock is rejected before emitting any summary or GitHub call", async () => {
  assert.throws(() => planRefreshFailureSummary({ repository, workflowFile: "ci.yml", runId: "1", now: start }),
    /REFRESH_FAILURE_REPORT_WORKFLOW/u);
  assert.throws(() => planRefreshFailureSummary({ repository: "not a repo", workflowFile, runId: "1", now: start }),
    /REFRESH_FAILURE_REPORT_REPOSITORY/u);
  for (const runId of ["0", "-1", "12a", "", undefined]) {
    assert.throws(() => planRefreshFailureSummary({ repository, workflowFile, runId, now: start }),
      /REFRESH_FAILURE_REPORT_RUN_ID/u);
  }
  assert.throws(() => planRefreshFailureSummary({ repository, workflowFile, runId: "1", now: new Date(Number.NaN) }),
    /REFRESH_FAILURE_REPORT_CLOCK/u);
  const calls = [];
  const annotations = [];
  await assert.rejects(reportRefreshFailure({
    argv: ["--workflow", "ci.yml", "--repository", repository, "--run-id", "1"],
    runGh: async (args) => { calls.push(args); return "[]"; },
    emitAnnotation: (line) => { annotations.push(line); },
  }), /REFRESH_FAILURE_REPORT_WORKFLOW/u);
  await assert.rejects(reportRefreshFailure({
    argv: ["--workflow", workflowFile, "--repository", repository],
    runGh: async (args) => { calls.push(args); return "[]"; },
    emitAnnotation: (line) => { annotations.push(line); },
  }), /REFRESH_FAILURE_REPORT_ARGUMENTS/u);
  assert.deepEqual(calls, []);
  assert.deepEqual(annotations, []);
});

test("an open failure issue without the status block fails instead of guessing what was reported", () => {
  const issue = { ...botIssue(7), body: refreshFailureMarker(workflowFile) };
  assert.throws(() => planRefreshFailureReport({ repository, workflowFile, runId: "9", openIssues: [issue], now: start }),
    /REFRESH_FAILURE_REPORT_STATUS_BLOCK/u);
});

test("only bot-authored issues with the exact failure title count as the workflow failure issue (F2)", () => {
  const humanCopy = botIssue(5, { author: { login: "AquilaXk", is_bot: false } });
  const otherTitle = botIssue(6, { title: "[Fix] 다른 제목" });
  const created = planRefreshFailureReport({ repository, workflowFile, runId: "7", openIssues: [humanCopy, otherTitle], now: start });
  assert.equal(created.action, "create");
  const updated = planRefreshFailureReport({ repository, workflowFile, runId: "9", openIssues: [humanCopy, otherTitle, botIssue(8)], now: new Date(start.getTime() + hours(2)) });
  assert.equal(updated.action, "status");
  assert.equal(updated.issueNumber, 8);
});

test("duplicate bot failure issues plan status into the oldest one and list duplicateNumbers (F2)", () => {
  const plan = planRefreshFailureReport({
    repository, workflowFile, runId: "20", openIssues: [botIssue(13), botIssue(12)], now: new Date(start.getTime() + COMMENT_INTERVAL_MS),
  });
  assert.equal(plan.action, "comment");
  assert.equal(plan.issueNumber, 12);
  assert.deepEqual(plan.duplicateNumbers, [13]);
});

test("every scheduled source refresh workflow reports its own failure summary without creating GitHub issues", () => {
  assert.deepEqual(Object.keys(REFRESH_WORKFLOWS).sort(), [
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
    assert.match(yml, /\npermissions: \{\}\n/u, `${file} must not grant permissions at workflow level`);
    assert.doesNotMatch(yml, /\bissues:\s*write\b/u, `${file} must not grant issues: write`);
    assert.doesNotMatch(yml, /\bpull-requests:\s*write\b/u, `${file} must not grant pull-requests: write`);
    assert.equal((yml.match(/\n    permissions:\n/gu) ?? []).length, 1, `${file} has exactly one job permission block`);
    const stepName = file === "kric-current-facility-refresh.yml"
      ? "KRIC current facility refresh / Report refresh failure summary"
      : "Report refresh failure summary";
    const body = stepBody(yml, stepName);
    const failedOrCancelled = String.raw`failure\(\) \|\| cancelled\(\)`;
    const condition = {
      "source-reverification.yml": String.raw`${failedOrCancelled} \|\| steps\.decision\.outputs\.overdue_recipes != ''`,
      ...Object.fromEntries(["current-capital-topology-registration.yml", "nationwide-candidate-refresh.yml", "source-derivative-rebinding.yml", "itx-current-promotion.yml"].map((name) => [name, failedOrCancelled])),
    }[file] ?? String.raw`failure\(\)`;
    assert.match(body, new RegExp(String.raw`\n        if: \$\{\{ ${condition} \}\}\n`, "u"), `${file} must report only on failure`);
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

test("CLI의 orphan 보고는 이슈 작성 없이 summary와 주석만 남긴다", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "refresh-orphan-"));
  try {
    const summaryPath = path.join(dir, "step-summary.md");
    const calls = [];
    const annotations = [];
    const result = await reportRefreshFailure({
      argv: ["--workflow", workflowFile, "--repository", repository, "--run-id", "123"],
      env: { GITHUB_STEP_SUMMARY: summaryPath },
      runGh: async (args) => { calls.push(args); return "[]"; },
      emitAnnotation: (line) => { annotations.push(line); },
      now: () => start,
      orphan: orphanClaim(),
    });
    assert.deepEqual(calls, []);
    assert.equal(result.action, "summary");
    assert.ok(result.summary.includes("automation/636-current-topology-refresh-123"));
    assert.match(result.summary, /conclusion: cancelled/u);
    assert.match(annotations[0], /EMPTY_CLAIM_NO_PUBLICATION/u);
    const written = await readFile(summaryPath, "utf8");
    assert.ok(written.includes("automation/636-current-topology-refresh-123"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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

test("CLI의 --failures·--overdue는 검증 실패 시 GitHub 호출이나 주석 없이 실패하고, 정상 입력은 summary를 남긴다", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "refresh-failures-"));
  try {
    const file = path.join(dir, "failures.json");
    const calls = [];
    const annotations = [];
    await writeFile(file, JSON.stringify([blocking, { recipeId: "busan-timetable", code: "SOURCE_FETCH_FAILED" }]));
    const run = (extra = []) => reportRefreshFailure({
      argv: ["--workflow", reverificationFile, "--repository", repository, "--run-id", "9", "--failures", file, ...extra],
      env: { GITHUB_STEP_SUMMARY: path.join(dir, "summary.md") },
      runGh: async (args) => { calls.push(args); return "[]"; },
      emitAnnotation: (line) => { annotations.push(line); },
      now: () => start,
    });
    const withFailures = await run(["--overdue", "busan-topology,daegu-sources"]);
    assert.equal(withFailures.action, "summary");
    assert.ok(withFailures.summary.includes("kric-station-timetable"));
    assert.ok(withFailures.summary.includes("SOURCE_EXPECTATION_CHANGED"));
    assert.match(withFailures.summary, /재확인 기한을 넘긴 recipe: `busan-topology`, `daegu-sources`/u);
    assert.match(withFailures.annotation, /busan-topology/u);
    const absent = await reportRefreshFailure({
      argv: ["--workflow", reverificationFile, "--repository", repository, "--run-id", "10", "--failures", path.join(dir, "absent.json"), "--overdue", ""],
      runGh: async (args) => { calls.push(args); return "[]"; },
      emitAnnotation: (line) => { annotations.push(line); },
      now: () => start,
    });
    assert.doesNotMatch(absent.summary, /재확인 기한/u);
    assert.equal(calls.length, 0);

    const beforeAnnotations = annotations.length;
    await writeFile(file, "{\"not\":\"a list\"}");
    await assert.rejects(run(), /REFRESH_FAILURE_REPORT_FAILURES/u);
    await writeFile(file, "not json");
    await assert.rejects(run(), /REFRESH_FAILURE_REPORT_FAILURES/u);
    await writeFile(file, JSON.stringify([{ recipeId: "a -->\n<!-- x", code: "SOURCE_EXPECTATION_CHANGED" }]));
    await assert.rejects(run(), /REFRESH_FAILURE_REPORT_FAILURES/u);

    await writeFile(file, "[]");
    await assert.rejects(run(["--overdue", "busan topology"]), /REFRESH_FAILURE_REPORT_OVERDUE/u);
    await assert.rejects(run(["--overdue", "busan-topology,"]), /REFRESH_FAILURE_REPORT_OVERDUE/u);
    assert.equal(calls.length, 0);
    assert.equal(annotations.length, beforeAnnotations);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("recordedRunIdsOf는 봇이 쓴 본문과 봇의 알림 댓글에 적힌 run만 읽는다 (#1287)", () => {
  const first = planRefreshFailureReport({ repository, workflowFile, runId: "11", openIssues: [], now: start });
  const second = planRefreshFailureReport({
    repository, workflowFile, runId: "12",
    openIssues: [botIssue(5, { body: first.body })],
    now: new Date(start.getTime() + COMMENT_INTERVAL_MS),
  });
  const issue = {
    number: 5,
    title: first.title,
    body: second.issueBody,
    author: { login: "app/github-actions", is_bot: true },
    createdAt: start.toISOString(),
    comments: [{ author: { login: "github-actions" }, body: second.body, createdAt: new Date(start.getTime() + COMMENT_INTERVAL_MS).toISOString() }],
  };
  assert.deepEqual([...new Set(recordedRunIdsOf(issue))].sort(), [11, 12]);
  const withHuman = { ...issue, comments: [...issue.comments, { author: { login: "AquilaXk" }, body: `${runUrl(99)}`, createdAt: start.toISOString() }] };
  assert.deepEqual([...new Set(recordedRunIdsOf(withHuman))].sort(), [11, 12]);
  assert.deepEqual(recordedRunIdsOf({ ...issue, body: "본문에 run이 없다", comments: [] }), []);
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

// #1122: 공급처 기대 관측이 바뀐 recipe는 사람이 기대값을 고칠 때까지 같은 실패를 되풀이한다. 실패 이슈 상태 블록에 막힌 recipe 표지를 남겨 판정이 건너뛰게 한다.
const reverificationFile = "source-reverification.yml";
const blockMarker = (recipeId, code) => `<!-- reverification-blocked:${recipeId}:${code} -->`;
const blocking = { recipeId: "kric-station-timetable", code: "SOURCE_EXPECTATION_CHANGED" };
const reverificationReport = (runId, now, extra = {}) => planRefreshFailureReport({ repository, workflowFile: reverificationFile, runId: String(runId), now, ...extra });

test("기대 관측 변경 실패는 새 실패 이슈의 상태 블록에 막힌 recipe 표지를 남기고, 다른 코드는 남기지 않는다 (#1122)", () => {
  const plan = reverificationReport(1, start, { openIssues: [], failures: [blocking, { recipeId: "busan-timetable", code: "SOURCE_FETCH_FAILED" }] });
  assert.equal(plan.action, "create");
  const status = plan.body.slice(plan.body.indexOf("<!-- refresh-failure-status:start -->"), plan.body.indexOf("<!-- refresh-failure-status:end -->"));
  assert.ok(status.includes(blockMarker("kric-station-timetable", "SOURCE_EXPECTATION_CHANGED")));
  assert.doesNotMatch(plan.body, /reverification-blocked:busan-timetable/u);
  assert.match(plan.body, /이 이슈를 닫으면 다음 실행이 다시 수집한다/u);
  assert.doesNotMatch(reverificationReport(1, start, { openIssues: [], failures: [] }).body, /다시 수집하지 않는다/u);
});

test("이슈가 열려 있는 동안 표지는 유지된다: 표지 없는 후속 실패 보고가 지우지 않고 새 표지는 더해진다 (#1122)", () => {
  const first = reverificationReport(1, start, { openIssues: [], failures: [blocking] });
  const issue = { number: 5, title: first.title, body: first.body, author: { login: "app/github-actions" }, createdAt: start.toISOString(), comments: [] };
  const later = new Date(start.getTime() + hours(2));
  const plain = reverificationReport(2, later, { openIssues: [issue], failures: [] });
  assert.ok(plain.issueBody.includes(blockMarker("kric-station-timetable", "SOURCE_EXPECTATION_CHANGED")));
  const more = reverificationReport(3, later, { openIssues: [{ ...issue, body: plain.issueBody }], failures: [{ recipeId: "korail-topology", code: "SOURCE_EXPECTATION_CHANGED" }] });
  assert.ok(more.issueBody.includes(blockMarker("kric-station-timetable", "SOURCE_EXPECTATION_CHANGED")));
  assert.ok(more.issueBody.includes(blockMarker("korail-topology", "SOURCE_EXPECTATION_CHANGED")));
  assert.equal((more.issueBody.match(/reverification-blocked:kric-station-timetable/gu) ?? []).length, 1);
});

test("막힌 recipe 표지는 이 workflow의 봇 실패 이슈만 가리킨다 (#1122)", () => {
  const first = reverificationReport(1, start, { openIssues: [], failures: [blocking] });
  const issue = { number: 5, title: first.title, body: first.body, author: { login: "app/github-actions" }, createdAt: start.toISOString(), comments: [] };
  assert.deepEqual(failureIssuesOf({ openIssues: [issue], workflowFile: reverificationFile }).map(({ number }) => number), [5]);
  assert.deepEqual(failureIssuesOf({ openIssues: [{ ...issue, author: { login: "someone" } }], workflowFile: reverificationFile }), []);
  assert.deepEqual(failureIssuesOf({ openIssues: [issue], workflowFile: workflowFile }), []);
});

// #3036 7-26: 재확인 기한을 넘긴 recipe는 대기 run이 성공으로 끝나도 같은 실패 이슈 경로로 드러난다. 실패 즉시 보고는 그대로다.
test("재확인 기한을 넘긴 recipe(overdue)는 run이 성공이어도 실패 이슈를 열고, 열린 이슈에는 run과 연체 recipe를 기록한다 (#3036)", () => {
  const created = reverificationReport(9, start, { openIssues: [], overdue: ["busan-topology"] });
  assert.equal(created.action, "create");
  assert.match(created.body, /재확인 기한을 넘긴 recipe: `busan-topology`/u);
  assert.ok(created.body.includes(runUrl(9)));
  assert.doesNotMatch(created.body, /가 실패했다/u, "대기 run은 실패하지 않았다");
  const issue = { number: 5, title: created.title, body: created.body, author: { login: "app/github-actions" }, createdAt: start.toISOString(), comments: [] };
  const nextDay = reverificationReport(10, new Date(start.getTime() + hours(25)), { openIssues: [issue], overdue: ["busan-topology"] });
  assert.equal(nextDay.action, "comment");
  assert.match(nextDay.body, /재확인 기한을 넘긴 recipe: `busan-topology`/u);
  assert.doesNotMatch(nextDay.body, /다시 실패했다/u);
  assert.ok(nextDay.issueBody.includes(runUrl(10)));
  // 연체가 없으면 지금과 같은 실패 보고다.
  assert.match(reverificationReport(11, start, { openIssues: [] }).body, /가 실패했다/u);
});

// #3036: 원천이 여럿인 workflow의 실패 이슈는 어느 원천이 실패했는지 적고, 원천별 마지막 실패 시각을 상태 블록 표지로 남긴다.
// 선택 원천의 재시도 쿨다운이 이 표지를 읽는다.
const kricFile = "kric-current-facility-refresh.yml";
const KRIC_STANDARD = "kric-station-convenience-standard";
const KRIC_ESCALATOR = "kric-station-escalator-detailed";
const sourceMarker = (sourceId, at) => `<!-- refresh-source-failed:${sourceId}:${at.toISOString()} -->`;
const kricReport = (runId, now, extra = {}) => planRefreshFailureReport({ repository, workflowFile: kricFile, runId: String(runId), now, ...extra });
const kricIssue = (plan, at = start) => ({ number: 5, title: plan.title, body: plan.body, author: { login: "app/github-actions" }, createdAt: at.toISOString(), comments: [] });

test("새 실패 이슈는 실패한 원천 id를 적고 그 원천의 실패 시각 표지를 상태 블록에 남긴다 (#3036)", () => {
  const plan = kricReport(1, start, { openIssues: [], sourceId: KRIC_ESCALATOR });
  assert.equal(plan.action, "create");
  assert.match(plan.body, /실패 원천: `kric-station-escalator-detailed`/u);
  const status = plan.body.slice(plan.body.indexOf("<!-- refresh-failure-status:start -->"), plan.body.indexOf("<!-- refresh-failure-status:end -->"));
  assert.ok(status.includes(sourceMarker(KRIC_ESCALATOR, start)));
  assert.deepEqual(sourceFailuresOf(plan.body), [{ sourceId: KRIC_ESCALATOR, failedAt: start.toISOString() }]);
  const unnamed = kricReport(2, start, { openIssues: [] });
  assert.doesNotMatch(unnamed.body, /실패 원천|refresh-source-failed/u);
  assert.deepEqual(sourceFailuresOf(unnamed.body), []);
});

test("열린 이슈는 원천마다 마지막 실패 시각만 남기고 다른 원천의 표지를 지우지 않는다 (#3036)", () => {
  const first = kricReport(1, start, { openIssues: [], sourceId: KRIC_ESCALATOR });
  const standardAt = new Date(start.getTime() + hours(2));
  const standard = kricReport(2, standardAt, { openIssues: [kricIssue(first)], sourceId: KRIC_STANDARD });
  assert.equal(standard.action, "status");
  assert.deepEqual(sourceFailuresOf(standard.issueBody), [
    { sourceId: KRIC_STANDARD, failedAt: standardAt.toISOString() },
    { sourceId: KRIC_ESCALATOR, failedAt: start.toISOString() },
  ]);
  const escalatorAt = new Date(start.getTime() + hours(4));
  const again = kricReport(3, escalatorAt, { openIssues: [kricIssue({ ...first, body: standard.issueBody })], sourceId: KRIC_ESCALATOR });
  assert.deepEqual(sourceFailuresOf(again.issueBody), [
    { sourceId: KRIC_ESCALATOR, failedAt: escalatorAt.toISOString() },
    { sourceId: KRIC_STANDARD, failedAt: standardAt.toISOString() },
  ]);
  assert.equal((again.issueBody.match(/refresh-source-failed:kric-station-escalator-detailed/gu) ?? []).length, 1);
  const unnamed = kricReport(4, new Date(start.getTime() + hours(6)), { openIssues: [kricIssue({ ...first, body: again.issueBody })] });
  assert.deepEqual(sourceFailuresOf(unnamed.issueBody), [
    { sourceId: KRIC_ESCALATOR, failedAt: escalatorAt.toISOString() },
    { sourceId: KRIC_STANDARD, failedAt: standardAt.toISOString() },
  ]);
});

test("재알림 댓글도 실패한 원천을 적고, 이미 기록한 run은 표지를 바꾸지 않는다 (#3036)", () => {
  const first = kricReport(1, start, { openIssues: [], sourceId: KRIC_ESCALATOR });
  const nextDay = new Date(start.getTime() + COMMENT_INTERVAL_MS);
  const comment = kricReport(2, nextDay, { openIssues: [kricIssue(first)], sourceId: KRIC_STANDARD });
  assert.equal(comment.action, "comment");
  assert.match(comment.body, /실패 원천: `kric-station-convenience-standard`/u);
  assert.ok(sourceFailuresOf(comment.issueBody).some(({ sourceId, failedAt }) => sourceId === KRIC_STANDARD && failedAt === nextDay.toISOString()));
  const rerun = kricReport(1, nextDay, { openIssues: [kricIssue(first)], sourceId: KRIC_ESCALATOR });
  assert.equal(rerun.action, "skip");
});

test("PR 없는 claim 삭제 보고도 원천 실패 시각 표지를 지우지 않는다 (#3036)", () => {
  const first = kricReport(1, start, { openIssues: [], sourceId: KRIC_ESCALATOR });
  const orphan = kricReport(2, new Date(start.getTime() + hours(1)), { openIssues: [kricIssue(first)], orphan: orphanClaim({ branch: "automation/629-kric-facility-refresh-2" }) });
  assert.equal(orphan.action, "comment");
  assert.deepEqual(sourceFailuresOf(orphan.issueBody), [{ sourceId: KRIC_ESCALATOR, failedAt: start.toISOString() }]);
});

test("원천 표지는 상태 블록 안의 형식이 맞는 것만 읽고, 시각이 틀린 표지는 추정하지 않고 실패한다 (#3036)", () => {
  const plan = kricReport(1, start, { openIssues: [], sourceId: KRIC_ESCALATOR });
  const outside = `${sourceMarker(KRIC_STANDARD, start)}\n${plan.body}`;
  assert.deepEqual(sourceFailuresOf(outside).map(({ sourceId }) => sourceId), [KRIC_ESCALATOR]);
  for (const failedAt of ["2026-13-45T25:61:61.000Z", "2026-10-04", "2026-10-04T00:47:00Z"]) {
    const broken = plan.body.replace(`${KRIC_ESCALATOR}:${start.toISOString()}`, `${KRIC_ESCALATOR}:${failedAt}`);
    assert.throws(() => sourceFailuresOf(broken), /REFRESH_FAILURE_REPORT_SOURCE_MARKER/u, failedAt);
  }
  assert.throws(() => sourceFailuresOf("상태 블록이 없다"), /REFRESH_FAILURE_REPORT_STATUS_BLOCK/u);
});

test("CLI의 --source-id는 식별자이거나 빈 값일 때만 받고, 잘못된 입력은 summary·주석·GitHub 호출 없이 거부한다", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "refresh-source-id-"));
  try {
    const calls = [];
    const annotations = [];
    const cli = (...extra) => reportRefreshFailure({
      argv: ["--workflow", kricFile, "--repository", repository, "--run-id", "9", ...extra],
      env: { GITHUB_STEP_SUMMARY: path.join(dir, "summary.md") },
      runGh: async (args) => { calls.push(args); return "[]"; },
      emitAnnotation: (line) => { annotations.push(line); },
      now: () => start,
    });
    assert.match((await cli("--source-id", KRIC_ESCALATOR)).summary, /실패 원천: `kric-station-escalator-detailed`/u);
    for (const unnamed of [[], ["--source-id", ""]]) assert.doesNotMatch((await cli(...unnamed)).summary, /실패 원천/u);
    const before = annotations.length;
    for (const bad of ["Kric Escalator", "a -->\n<!-- x", "-lead"]) {
      await assert.rejects(cli("--source-id", bad), /REFRESH_FAILURE_REPORT_SOURCE_ID/u, JSON.stringify(bad));
    }
    assert.equal(calls.length, 0);
    assert.equal(annotations.length, before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("가드 실패 사유(reason=)는 실패 이슈 본문·재알림 댓글·상태 블록 표지에 기록되고, 사유 없는 후속 보고는 이전 사유를 유지한다 (#3036 7-20)", () => {
  const firstReason = "reason=QUOTA_EXHAUSTED allowance=ITX_COLLECTED_TODAY";
  const created = kricReport(1, start, { openIssues: [], sourceId: KRIC_ESCALATOR, reason: firstReason });
  assert.equal(created.action, "create");
  assert.match(created.body, /- 실패 원천: `kric-station-escalator-detailed`\n- 가드 사유: `reason=QUOTA_EXHAUSTED allowance=ITX_COLLECTED_TODAY`/u);
  assert.ok(created.body.includes(`<!-- refresh-failure-reason:${firstReason} -->`));
  assert.equal(failureReasonOf(created.body), firstReason);

  const withoutReason = kricReport(2, new Date(start.getTime() + hours(2)), { openIssues: [kricIssue(created)] });
  assert.equal(withoutReason.action, "status");
  assert.equal(failureReasonOf(withoutReason.issueBody), firstReason);

  const updatedReason = "reason=GITHUB_API_STATUS status=502 workflow=kric-current-facility-refresh.yml";
  const nextDay = new Date(start.getTime() + COMMENT_INTERVAL_MS);
  const commented = kricReport(3, nextDay, {
    openIssues: [kricIssue({ ...created, body: withoutReason.issueBody })],
    sourceId: KRIC_STANDARD,
    reason: updatedReason,
  });
  assert.equal(commented.action, "comment");
  assert.match(commented.body, /- 실패 원천: `kric-station-convenience-standard`\n- 가드 사유: `reason=GITHUB_API_STATUS status=502 workflow=kric-current-facility-refresh\.yml`/u);
  assert.equal(failureReasonOf(commented.issueBody), updatedReason);

  const orphan = kricReport(4, new Date(nextDay.getTime() + hours(1)), {
    openIssues: [kricIssue({ ...created, body: commented.issueBody })],
    orphan: orphanClaim({ branch: "automation/629-kric-facility-refresh-4" }),
  });
  assert.equal(orphan.action, "comment");
  assert.equal(failureReasonOf(orphan.issueBody), updatedReason);

  const unnamed = kricReport(5, start, { openIssues: [] });
  assert.doesNotMatch(unnamed.body, /가드 사유|refresh-failure-reason/u);
  assert.equal(failureReasonOf(unnamed.body), null);
});

test("CLI는 --reason 또는 RUNNER_TEMP의 가드 사유 파일을 읽고, 형식이 틀린 사유는 summary·GitHub 호출 없이 거부한다", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "refresh-reason-"));
  try {
    const calls = [];
    const annotations = [];
    const runWith = (argv, env = {}) => reportRefreshFailure({
      argv: ["--workflow", kricFile, "--repository", repository, "--run-id", "42", ...argv],
      env,
      runGh: async (args) => { calls.push(args); return "[]"; },
      emitAnnotation: (line) => { annotations.push(line); },
      now: () => start,
    });

    const reasonFile = guardFailureReasonPath({ RUNNER_TEMP: dir, GITHUB_RUN_ID: "42" });
    await writeFile(reasonFile, "reason=SECRET_MISSING secret=KRIC_SERVICE_KEY\n");
    const fromEnvFile = await runWith([], { RUNNER_TEMP: dir, GITHUB_RUN_ID: "42", GITHUB_STEP_SUMMARY: path.join(dir, "summary.md") });
    assert.match(fromEnvFile.summary, /- 가드 사유: `reason=SECRET_MISSING secret=KRIC_SERVICE_KEY`/u);
    assert.match(fromEnvFile.annotation, /reason=SECRET_MISSING secret=KRIC_SERVICE_KEY/u);

    const fromCli = await runWith(["--reason", "reason=AUTOMATION_PR_CI"], { RUNNER_TEMP: dir, GITHUB_RUN_ID: "42" });
    assert.match(fromCli.summary, /- 가드 사유: `reason=AUTOMATION_PR_CI`/u);

    const before = annotations.length;
    await assert.rejects(runWith(["--reason", "not-valid"]), /REFRESH_FAILURE_REPORT_REASON/u);
    await writeFile(reasonFile, "bad-reason-in-file\n");
    await assert.rejects(runWith([], { RUNNER_TEMP: dir, GITHUB_RUN_ID: "42" }), /REFRESH_FAILURE_REPORT_REASON/u);
    assert.equal(calls.length, 0);
    assert.equal(annotations.length, before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
