import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { REFRESH_STAGES } from "./refresh-stage-contracts.mjs";
import { ifCondition, loadWorkflow, parseWorkflowYaml } from "./refresh-workflow-contract-helpers.mjs";

// 정기 갱신 4종 workflow의 단독 운영 증거 계약:
// 각 workflow는 main 커밋·push 시점에 refresh-automation-pr.mjs body를 한 번 호출해 GITHUB_STEP_SUMMARY에 증거 본문을 남긴다.
const root = path.resolve(import.meta.dirname, "../..");
const RUN_URL = '--run-url "${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}"';

const WORKFLOWS = {
  "retained-gwangju-timetable-refresh.yml": {
    publish: "Commit and push retained Gwangju timetable",
    mainSha: "${RETAINED_GWANGJU_MAIN_SHA}",
    bodyFile: "${summary_file}",
    commit: 'git commit -m "Refresh retained Gwangju timetable"',
    stage: "gwangju-timetable-refresh",
  },
  "current-capital-topology-refresh.yml": {
    publish: "Activate current topology inputs exactly once",
    mainSha: "${TOPOLOGY_MAIN_SHA}",
    bodyFile: "${TOPOLOGY_OPERATION_ROOT}/commit-summary.md",
    commit: 'git commit -m "Activate current topology inputs"',
    stage: "capital-topology-refresh",
  },
  "kric-current-facility-refresh.yml": {
    publish: "KRIC current facility refresh / Commit and push KRIC facility refresh",
    mainSha: "${KRIC_REFRESH_MAIN_SHA}",
    bodyFile: "${summary_file}",
    commit: 'git commit -m "Refresh KRIC facility snapshot"',
    stage: "kric-facility-refresh",
  },
  "seoul-current-accessibility-refresh.yml": {
    publish: "Commit and push Seoul accessibility refresh",
    mainSha: "${SEOUL_REFRESH_MAIN_SHA}",
    bodyFile: "${summary_file}",
    commit: 'git commit -m "Refresh Seoul accessibility snapshot"',
    stage: "seoul-accessibility-refresh",
  },
};

const emitters = (script) => [...script.matchAll(/node tools\/ci\/refresh-automation-pr\.mjs body[^\n]*/gu)].map(([line]) => line);

test("parseWorkflowYaml은 들여쓰기·빈 줄·주석과 무관하게 workflow·job·step 구조화 필드를 파싱한다 (#3036 7-37)", () => {
  const parsed = parseWorkflowYaml(`name: "Sample Workflow"

# 최상위 주석
on:
  schedule:
    - cron: "15 */4 * * *"
  workflow_dispatch:
    inputs:
      retry_flag:
        description: Manual retry flag
        required: false
        default: false
        type: boolean

permissions: {}

concurrency:
  group: sample-group
  cancel-in-progress: false

jobs:
  sample:
    name: Sample job
    if: \${{ github.ref == 'refs/heads/main' }}
    runs-on: ubuntu-latest
    environment: sample-env
    timeout-minutes: 25
    permissions:
      actions: read
      contents: write
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1
        with:
          fetch-depth: 0
          persist-credentials: false
      - name: Run sample step
        id: run-step
        if: \${{ steps.prev.outputs.ready == 'true' }}
        continue-on-error: true
        working-directory: tools/ci
        shell: bash
        env:
          GH_TOKEN: \${{ github.token }}
        run: |
          set -euo pipefail
          # 스크립트 내부 주석
          echo "ok"
`);
  assert.equal(parsed.name, "Sample Workflow");
  assert.deepEqual(parsed.permissions, {});
  assert.deepEqual(parsed.concurrency, { group: "sample-group", "cancel-in-progress": false });
  assert.deepEqual(parsed.on.schedule, [{ cron: "15 */4 * * *" }]);
  assert.equal(parsed.on.workflow_dispatch.inputs.retry_flag.default, false);
  assert.equal(parsed.job.id, "sample");
  assert.equal(parsed.job.name, "Sample job");
  assert.equal(parsed.job.runsOn, "ubuntu-latest");
  assert.equal(parsed.job.environment, "sample-env");
  assert.equal(parsed.job.timeoutMinutes, 25);
  assert.deepEqual(parsed.job.permissions, { actions: "read", contents: "write" });
  assert.equal(parsed.job.steps.length, 2);
  assert.equal(parsed.job.steps[0].name, null);
  assert.deepEqual(parsed.job.steps[0].with, { "fetch-depth": "0", "persist-credentials": "false" });
  const runStep = parsed.job.steps[1];
  assert.equal(runStep.id, "run-step");
  assert.equal(ifCondition(runStep), "${{ steps.prev.outputs.ready == 'true' }}");
  assert.equal(runStep.continueOnError, true);
  assert.equal(runStep.workingDirectory, "tools/ci");
  assert.equal(runStep.shell, "bash");
  assert.deepEqual(runStep.env, { GH_TOKEN: "${{ github.token }}" });
  assert.equal(runStep.run, 'set -euo pipefail\n# 스크립트 내부 주석\necho "ok"');
});

test("갱신 4종 표가 단계 계약과 같은 workflow·단계를 가리킨다", () => {
  assert.deepEqual(Object.entries(WORKFLOWS).map(([file, { stage }]) => [file, stage]).sort(), Object.values(REFRESH_STAGES).map(({ workflow, stepId }) => [workflow, stepId]).sort());
});

for (const [file, spec] of Object.entries(WORKFLOWS)) {
  const { yml, steps, step } = loadWorkflow(root, file);

  test(`${file}: 결과를 커밋한 뒤 push 전에 증거 본문을 만들어 GITHUB_STEP_SUMMARY에 남긴다`, () => {
    const publish = step(spec.publish);
    const lines = emitters(publish.run);
    assert.equal(lines.length, 1, "publish 경로의 emitter 호출");
    const [line] = lines;
    const commit = publish.run.indexOf(spec.commit);
    const emit = publish.run.indexOf(line);
    const summaryAppend = publish.run.indexOf(`cat "${spec.bodyFile}" >> "\${GITHUB_STEP_SUMMARY}"`);
    const push = publish.run.indexOf("git push origin HEAD:main");
    assert.ok(commit !== -1 && emit > commit && summaryAppend > emit && push > summaryAppend, "commit -> emitter -> summary -> push 순서");
    assert.ok(line.includes(`--stage ${spec.stage}`), line);
    assert.ok(line.includes(`--base-sha "${spec.mainSha}"`), "기준은 판정 직후 main 커밋");
    assert.ok(line.includes('--head-sha "$(git rev-parse HEAD)"'), "head는 방금 만든 결과 커밋");
    assert.ok(line.includes(RUN_URL), line);
    assert.ok(line.includes('--refs "Direct main commit"'), line);
    assert.ok(line.includes(`--output "${spec.bodyFile}"`), line);
    assert.match(line, /--summary "[^"\n$]+"/u, "요약은 고정 문구");
    assert.ok(publish.run.includes("set -euo pipefail"));
    assert.doesNotMatch(publish.block, /APP_PR_TOKEN|create-github-app-token|gh pr create/u);
  });

  test(`${file}: 본문 생성기 호출은 한 곳뿐이고 표현식을 펼치지 않으며 PR 생성·이슈 생성 호출이 없다`, () => {
    assert.equal([...yml.matchAll(/refresh-automation-pr\.mjs body/gu)].length, 1);
    for (const line of steps().flatMap(({ run }) => emitters(run))) assert.doesNotMatch(line, /\$\{\{/u, line);
    assert.doesNotMatch(yml, /refresh-automation-pr\.mjs (?!body)/u);
    assert.doesNotMatch(yml, /gh pr create|create-github-app-token|pull-requests:\s*write|issues:\s*write/u);
  });
}
