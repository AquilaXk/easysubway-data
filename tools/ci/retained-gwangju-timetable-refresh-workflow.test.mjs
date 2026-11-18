import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { ifCondition, loadWorkflow } from "./refresh-workflow-contract-helpers.mjs";

// 1인 프로젝트 표준: 광주 보관 시간표 갱신 workflow는 claim/PR 없이 main 직렬 CAS 검사 후 직접 push한다.
const FILE = "retained-gwangju-timetable-refresh.yml";
const { yml, workflow, job, steps, step } = loadWorkflow(path.resolve(import.meta.dirname, "../.."), FILE);
const names = () => steps().map(({ name }) => name);
const before = (earlier, later) => assert.ok(names().indexOf(earlier) !== -1 && names().indexOf(earlier) < names().indexOf(later), `${earlier} -> ${later}`);

test("run 조회용 actions: read와 contents: write만 가지며 PR/이슈/App/workflow_dispatch 쓰기 권한이 없다", () => {
  assert.deepEqual(workflow.permissions, {});
  assert.deepEqual(job.permissions, {
    actions: "read",
    contents: "write",
  });
  assert.doesNotMatch(yml, /pull-requests:\s*write|issues:\s*write|actions:\s*write|create-github-app-token|gh pr create|gh workflow run|repository_dispatch|automation\//u);
});

test("판정 step이 due 상태를 결정하고 base main SHA를 기록한다", () => {
  const decision = step("Read retained timetable due state");
  assert.ok(decision.run.includes('node tools/ci/decide-retained-gwangju-timetable-refresh.mjs > "${state_root}/due.json"'));
  assert.match(decision.run, /RETAINED_GWANGJU_MAIN_SHA=%s/u);
  assert.doesNotMatch(decision.run, /gh run list|collect-automation-prs|claim-orphans|gh pr list/u);
});

test("수집·게시·push step은 DUE에서만 열린다. CURRENT에서는 아무 쓰기도 하지 않는다", () => {
  const states = new Map([
    ["Collect due retained Gwangju timetable", "DUE"],
    ["Publish and register retained Gwangju timetable", "DUE"],
    ["Commit and push retained Gwangju timetable", "DUE"],
  ]);
  for (const [name, state] of states) assert.equal(ifCondition(step(name)), `\${{ steps.decision.outputs.state == '${state}' }}`, name);
});

test("실패 보고는 마지막 step이고 요약으로 동작한다", () => {
  const report = step("Report refresh failure summary");
  assert.equal(ifCondition(report), "${{ failure() }}");
  assert.ok(report.run.includes('node tools/ci/report-refresh-failure.mjs --workflow retained-gwangju-timetable-refresh.yml --repository "${GITHUB_REPOSITORY}" --run-id "${GITHUB_RUN_ID}"'));
  assert.equal(job.steps.at(-1)?.name, report.name);
});

test("수집과 게시·등록은 서로 다른 step이고 게시 전·push 전 origin/main CAS와 허용 경로를 검증한다", () => {
  const collect = step("Collect due retained Gwangju timetable");
  const publish = step("Publish and register retained Gwangju timetable");
  const push = step("Commit and push retained Gwangju timetable");
  const operation = '--operation-root "${RUNNER_TEMP}/retained-gwangju-timetable-refresh/${GITHUB_RUN_ID}/operation"';
  assert.ok(collect.run.includes(`run-retained-gwangju-timetable-refresh.mjs ${operation} --phase collect`));
  assert.ok(publish.run.includes(`run-retained-gwangju-timetable-refresh.mjs ${operation} --phase publish`));
  for (const item of [collect, publish]) {
    assert.equal(item.env.DATA_GO_KR_SERVICE_KEY, "${{ secrets.DATA_GO_KR_SERVICE_KEY }}");
    assert.equal(item.env.EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL, "${{ secrets.EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL }}");
    assert.ok(item.run.includes('[[ "$(git rev-parse HEAD)" == "${RETAINED_GWANGJU_MAIN_SHA}" ]]'));
  }
  assert.ok(publish.run.includes('git ls-remote origin refs/heads/main'));
  assert.ok(push.run.includes('git add -- tools/datapack/source-inventory.json tools/datapack/release/source-snapshots.json'));
  assert.ok(push.run.includes('validateRetainedGwangjuRefreshOutputPaths'));
  assert.ok(push.run.includes('refresh-automation-pr.mjs body --stage gwangju-timetable-refresh'));
  assert.ok(push.run.includes('git push origin HEAD:main'));
  assert.doesNotMatch(push.run, /git add -A|git add \.|--force|\s-f\b/u);
  before("Read retained timetable due state", collect.name);
  before(collect.name, publish.name);
  before(publish.name, push.name);
  assert.equal(names().includes("Refresh due retained Gwangju timetable"), false);
});

test("계측 파일 경로는 수집 전에 정하고 요약 step은 always()·continue-on-error로 마지막 보고 step 앞에서 돈다", () => {
  const record = step("Record source fetch attempts for the job summary");
  assert.match(record.run, /: > "\$\{RUNNER_TEMP\}\/source-fetch-telemetry\.jsonl"/u);
  assert.match(record.run, /SOURCE_FETCH_TELEMETRY_PATH=\$\{RUNNER_TEMP\}\/source-fetch-telemetry\.jsonl" >> "\$\{GITHUB_ENV\}"/u);
  before(record.name, "Read retained timetable due state");
  const summary = step("Summarize source fetch attempts");
  assert.equal(ifCondition(summary), "${{ always() }}");
  assert.equal(summary.continueOnError, true);
  assert.match(summary.run, /node tools\/ci\/summarize-source-fetch-telemetry\.mjs --input "\$\{SOURCE_FETCH_TELEMETRY_PATH:-\}" >> "\$\{GITHUB_STEP_SUMMARY\}"/u);
  assert.equal(steps().filter(({ continueOnError }) => continueOnError).length, 1, "요약 step만 continue-on-error다");
  before("Commit and push retained Gwangju timetable", summary.name);
  before(summary.name, "Report refresh failure summary");
});

