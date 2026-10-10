import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AUTOMATION_PR_APP, AUTOMATION_STAGE_WORKFLOWS } from "./automation-pr-policy.mjs";
import { evaluateGithubExpression } from "./github-expression.mjs";
import { REFRESH_STAGE_IDS } from "./refresh-stage-contracts.mjs";
import {
  RECREATE_DAILY_LIMIT,
  RECREATE_MODE,
  STAGE_RECREATE_MODE,
  STAGE_REDISPATCH,
  main,
  planBehindRecreation,
  recreateBehindPullRequests,
} from "./automation-pr-recreate.mjs";
import { REFRESH_WORKFLOWS } from "./report-refresh-failure.mjs";
import { assertFailureReportLast, assertNoExpressionInRunScripts, ifCondition, loadWorkflow } from "./refresh-workflow-contract-helpers.mjs";

// #986 리뷰 F2: main보다 뒤처진 자동화 PR은 base를 갱신하지 않고(사람 커밋이 head 결속을 깬다) 닫고 브랜치를 지운 뒤 최신 main에서 다시 만든다.
// 같은 단계가 하루 3회를 넘게 닫히면 루프로 보고 이상으로 드러낸다.
const REPOSITORY = "AquilaXk/easysubway-data";
const NOW = new Date("2026-10-06T12:00:00Z");
const HUMAN = { login: "AquilaXk", id: 12345, type: "User" };
const BRANCHES = {
  registration: "automation/456-capital-topology-registration-9001",
  "derivative-rebinding": "automation/969-derivative-rebinding-9003",
  "candidate-refresh": "automation/927-nationwide-candidate-refresh-9004",
  "itx-promotion": "automation/977-itx-promotion-9002",
  "gwangju-timetable-refresh": "automation/504-retained-gwangju-timetable-refresh-9101",
  "capital-topology-refresh": "automation/636-current-topology-refresh-9102",
  "kric-facility-refresh": "automation/629-kric-facility-refresh-9103",
  "seoul-accessibility-refresh": "automation/639-seoul-accessibility-refresh-9104",
};
const sha = (digit) => String(digit).repeat(40);
const open = (number, branch, { user = AUTOMATION_PR_APP, repo = REPOSITORY, head = sha(number % 10), createdAt = "2026-10-01T00:00:00Z" } = {}) => ({ number, state: "open", user, created_at: createdAt, head: { ref: branch, sha: head, repo: { full_name: repo } }, base: { ref: "main" } });
const closed = (number, branch, hoursAgo, { merged = false, user = AUTOMATION_PR_APP } = {}) => ({
  number, state: "closed", user, head: { ref: branch, sha: sha(number % 10), repo: { full_name: REPOSITORY } },
  closed_at: new Date(NOW.getTime() - hoursAgo * 3600_000).toISOString(), merged_at: merged ? new Date(NOW.getTime() - hoursAgo * 3600_000).toISOString() : null,
});

// #1127: ITX 승격 PR은 닫기 전에 원본 run의 artifact(itx-current-promotion-<run id>)가 살아 있는지 읽는다. 기본은 모든 run에 살아 있는 artifact가 하나 있다.
const liveArtifact = (runId, overrides = {}) => ({ id: 1, name: `itx-current-promotion-${runId}`, expired: false, ...overrides });
function fakeApi({ openPulls = [], closedPulls = [], behind = {}, artifacts = (runId) => [liveArtifact(runId)] }) {
  const calls = [];
  const api = async (endpoint) => {
    calls.push(endpoint);
    const artifactMatch = /^repos\/[^/]+\/[^/]+\/actions\/runs\/(\d+)\/artifacts\?name=(itx-current-promotion-\d+)$/u.exec(endpoint);
    if (artifactMatch) {
      const list = artifacts(Number(artifactMatch[1]));
      return { total_count: list.length, artifacts: list };
    }
    if (endpoint === `repos/${REPOSITORY}/pulls?state=open&base=main&per_page=100&page=1`) return openPulls;
    if (endpoint === `repos/${REPOSITORY}/pulls?state=closed&base=main&sort=updated&direction=desc&per_page=100&page=1`) return closedPulls;
    const match = /^repos\/[^/]+\/[^/]+\/compare\/main\.\.\.([0-9a-f]{40})\?per_page=1$/u.exec(endpoint);
    if (match) return { status: behind[match[1]] ? "diverged" : "ahead", behind_by: behind[match[1]] ?? 0, ahead_by: 1 };
    throw new Error(`unexpected API path ${endpoint}`);
  };
  return { api, calls };
}

function recorder() {
  const writes = [];
  return {
    writes,
    closePullRequest: async (input) => { writes.push(["close", input.number]); },
    deleteBranch: async (branch) => { writes.push(["delete", branch]); },
    dispatchWorkflow: async (workflow, inputs = {}) => { writes.push(["dispatch", workflow]); if (Object.keys(inputs).length > 0) writes.push(["dispatch-inputs", workflow, inputs]); },
  };
}

test("뒤처진 자동화 PR만 계획에 오른다: App 작성·단계 claim 브랜치·같은 저장소·behind_by > 0", async () => {
  const behind = { [sha(1)]: 3, [sha(2)]: 1 };
  const { api, calls } = fakeApi({
    openPulls: [
      open(1, BRANCHES.registration), // 뒤처짐
      open(2, BRANCHES["derivative-rebinding"]), // 뒤처짐
      open(3, BRANCHES["itx-promotion"]), // 최신
      open(4, BRANCHES.registration, { user: HUMAN, head: sha(4) }), // 사람이 같은 접두사 브랜치로 연 PR은 건드리지 않는다
      open(5, "feature/x", { head: sha(5) }),
      open(6, "automation/700-unrelated-experiment-1", { head: sha(6) }),
      open(7, BRANCHES["candidate-refresh"], { repo: "someone/fork", head: sha(7) }),
    ],
    behind: { ...behind, [sha(4)]: 9, [sha(5)]: 9, [sha(6)]: 9, [sha(7)]: 9 },
  });
  const plan = await planBehindRecreation({ repository: REPOSITORY, api, now: NOW });
  assert.deepEqual(plan.actions.map(({ number, branch, stage }) => ({ number, branch, stage })), [
    { number: 1, branch: BRANCHES.registration, stage: "registration" },
    { number: 2, branch: BRANCHES["derivative-rebinding"], stage: "derivative-rebinding" },
  ]);
  assert.deepEqual(plan.anomalies, []);
  // 정책 대상이 아닌 PR은 compare도 부르지 않는다.
  assert.equal(calls.filter((entry) => entry.includes("/compare/")).length, 3);
});

test("재생성은 PR 닫기 -> 브랜치 삭제 -> workflow 재실행 순서이고 같은 workflow는 한 번만 부른다", async () => {
  const { api } = fakeApi({ openPulls: [open(1, BRANCHES.registration), open(2, BRANCHES["itx-promotion"])], behind: { [sha(1)]: 1, [sha(2)]: 1 } });
  const writer = recorder();
  await recreateBehindPullRequests({ repository: REPOSITORY, api, now: NOW, ...writer });
  assert.deepEqual(writer.writes, [
    ["close", 1], ["delete", BRANCHES.registration], ["dispatch", "current-capital-topology-registration.yml"],
    ["close", 2], ["delete", BRANCHES["itx-promotion"]], ["dispatch", "itx-current-promotion.yml"], ["dispatch-inputs", "itx-current-promotion.yml", { replay_run_id: "9002" }],
  ]);
  const duplicate = fakeApi({ openPulls: [open(1, BRANCHES.registration), open(8, BRANCHES.registration)], behind: { [sha(1)]: 1, [sha(8)]: 1 } });
  const again = recorder();
  await recreateBehindPullRequests({ repository: REPOSITORY, api: duplicate.api, now: NOW, ...again });
  assert.equal(again.writes.filter(([kind]) => kind === "dispatch").length, 1);
});

test("후보 갱신 단계는 dispatch하지 않는다: 정기 역할은 schedule 이벤트와 스케줄러 App dispatch에서만 쓸 수 있어 recreate(github-actions[bot])가 아니라 2시간 정기 실행이 다시 만든다", async () => {
  assert.deepEqual({ ...STAGE_REDISPATCH }, {
    registration: true, "derivative-rebinding": true, "candidate-refresh": false, "itx-promotion": true, "source-reverification": true,
    "gwangju-timetable-refresh": true, "capital-topology-refresh": true, "kric-facility-refresh": true, "seoul-accessibility-refresh": true,
  });
  const { api } = fakeApi({ openPulls: [open(1, BRANCHES["candidate-refresh"])], behind: { [sha(1)]: 1 } });
  const writer = recorder();
  await recreateBehindPullRequests({ repository: REPOSITORY, api, now: NOW, ...writer });
  assert.deepEqual(writer.writes, [["close", 1], ["delete", BRANCHES["candidate-refresh"]]]);
  // dispatch하는 workflow는 필수 입력이 없다(입력 없이 dispatch가 성립해야 한다).
  // 후보 갱신은 입력이 선택(#1032: 스케줄러 App이 입력 없이 깨운다)이지만 recreate의 dispatch 행위자(github-actions[bot])는 App이 아니라 사람 경로로 판정돼 입력 없이는 실패한다.
  for (const [stage, workflow] of Object.entries(AUTOMATION_STAGE_WORKFLOWS)) {
    const yml = readFileSync(path.resolve(import.meta.dirname, "../../.github/workflows", workflow), "utf8");
    assert.match(yml, /\n  workflow_dispatch:/u, workflow);
    const inputs = /\n  workflow_dispatch:\n    inputs:\n([\s\S]*?)\n\npermissions:/u.exec(yml)?.[1] ?? "";
    const required = /required: true/u.test(inputs);
    assert.equal(STAGE_REDISPATCH[stage], !required && stage !== "candidate-refresh", `${stage}: redispatch only when dispatch needs no required input and github-actions[bot] may start it`);
  }
});

// #1012: 정기 갱신 4종도 뒤처지면 닫고 같은 workflow를 다시 실행한다. 증거 블록이 head에 묶여 있어 base를 갱신할 수 없는 것은 기존 단계와 같다.
test("정기 갱신 4종: 뒤처진 PR은 닫히고 브랜치가 지워지고 해당 workflow가 다시 실행된다. 단계마다 한 번만", async () => {
  const stages = [...REFRESH_STAGE_IDS];
  assert.deepEqual(Object.keys(STAGE_REDISPATCH).sort(), Object.keys(AUTOMATION_STAGE_WORKFLOWS).sort(), "단계마다 redispatch 여부가 정해져 있다(빠진 단계가 없다)");
  const pulls = stages.map((stage, index) => open(20 + index, BRANCHES[stage], { head: sha(index + 1) }));
  const behind = Object.fromEntries(stages.map((_, index) => [sha(index + 1), 2]));
  const { api } = fakeApi({ openPulls: pulls, behind });
  const writer = recorder();
  await recreateBehindPullRequests({ repository: REPOSITORY, api, now: NOW, ...writer });
  assert.deepEqual(writer.writes, stages.flatMap((stage, index) => [["close", 20 + index], ["delete", BRANCHES[stage]], ["dispatch", AUTOMATION_STAGE_WORKFLOWS[stage]]]));
  assert.deepEqual(writer.writes.filter(([kind]) => kind === "dispatch").map(([, workflow]) => workflow), [
    "retained-gwangju-timetable-refresh.yml", "current-capital-topology-refresh.yml", "kric-current-facility-refresh.yml", "seoul-current-accessibility-refresh.yml",
  ]);
  // 최신인 갱신 PR은 건드리지 않고, 사람이 같은 접두사로 연 PR도 건드리지 않는다.
  const quiet = fakeApi({ openPulls: [open(30, BRANCHES["kric-facility-refresh"]), open(31, BRANCHES["seoul-accessibility-refresh"], { user: HUMAN, head: sha(5) })], behind: { [sha(5)]: 9 } });
  const untouched = recorder();
  await recreateBehindPullRequests({ repository: REPOSITORY, api: quiet.api, now: NOW, ...untouched });
  assert.deepEqual(untouched.writes, []);
  // 같은 단계가 하루 3회를 넘게 닫히면 갱신 단계도 루프 상한으로 멈추고 이상으로 보고한다.
  const loop = fakeApi({ openPulls: [open(40, BRANCHES["capital-topology-refresh"], { head: sha(6) })], closedPulls: [1, 2, 3].map((n) => closed(50 + n, BRANCHES["capital-topology-refresh"], n)), behind: { [sha(6)]: 1 } });
  const stopped = recorder();
  await assert.rejects(recreateBehindPullRequests({ repository: REPOSITORY, api: loop.api, now: NOW, ...stopped }), /AUTOMATION_PR_RECREATE_LOOP: capital-topology-refresh/u);
  assert.deepEqual(stopped.writes, []);
});

// 플랫폼 서버 스케줄러(platform #238)는 이 workflow들을 매시간 App으로 dispatch한다. 변수 게이트가 있는 workflow(DATAPACK_SCHEDULED_*)는 App·다른 봇의 dispatch를
// 변수가 true일 때만 받는다(#1001). recreate의 dispatch는 github-actions[bot]이므로 같은 게이트를 따른다. 갱신 4종은 변수 게이트가 없다(정기 실행이 기본 동작이다).
const jobIfOf = (workflow) => {
  const matches = [...readFileSync(path.resolve(import.meta.dirname, "../../.github/workflows", workflow), "utf8").matchAll(/\n    if: (\$\{\{[^\n]*\}\})\n/gu)];
  assert.equal(matches.length, 1, `${workflow}: job-level if가 하나`);
  return matches[0][1];
};
const runsOn = (workflow, { actor, vars }) => evaluateGithubExpression(jobIfOf(workflow), { github: { event_name: "workflow_dispatch", triggering_actor: actor, actor, ref: "refs/heads/main" }, vars });
const SCHEDULED_VARIABLES = {
  "current-capital-topology-registration.yml": "DATAPACK_SCHEDULED_SOURCE_REGISTRATION", "source-derivative-rebinding.yml": "DATAPACK_SCHEDULED_SOURCE_REBINDING",
  "itx-current-promotion.yml": "DATAPACK_SCHEDULED_ITX_PROMOTION", "source-reverification.yml": "DATAPACK_SCHEDULED_SOURCE_REVERIFICATION",
};

test("recreate의 dispatch(github-actions[bot])는 변수 게이트와 충돌하지 않는다: 갱신 4종은 게이트가 없어 항상 돌고, 게이트가 있는 단계는 변수 true일 때 돈다", () => {
  const APP = "easysubway-release-chain[bot]";
  for (const stage of REFRESH_STAGE_IDS) {
    const workflow = AUTOMATION_STAGE_WORKFLOWS[stage];
    assert.equal(STAGE_REDISPATCH[stage], true, stage);
    assert.doesNotMatch(jobIfOf(workflow), /vars\./u, `${workflow}: 변수 게이트 없음`);
    for (const actor of ["github-actions[bot]", APP, "AquilaXk"]) {
      for (const vars of [{}, { DATAPACK_AUTOMATION_AUTOMERGE: "true" }, { DATAPACK_AUTOMATION_AUTOMERGE: "false" }]) assert.equal(runsOn(workflow, { actor, vars }), true, `${workflow} ${actor} ${JSON.stringify(vars)}`);
    }
    // main이 아닌 ref에서는 돌지 않는다(recreate는 --ref main으로만 부른다).
    assert.equal(evaluateGithubExpression(jobIfOf(workflow), { github: { event_name: "workflow_dispatch", triggering_actor: "github-actions[bot]", ref: "refs/heads/feature" }, vars: {} }), false, workflow);
  }
  for (const [workflow, variable] of Object.entries(SCHEDULED_VARIABLES)) {
    assert.equal(runsOn(workflow, { actor: "github-actions[bot]", vars: { [variable]: "true" } }), true, `${workflow}: 변수 true`);
    assert.equal(runsOn(workflow, { actor: "github-actions[bot]", vars: {} }), false, `${workflow}: 변수가 없으면 dispatch도 돌지 않는다(자동화가 꺼진 상태)`);
  }
  // 외부 스케줄러 heartbeat는 App의 dispatch만 센다. recreate의 dispatch(github-actions[bot])가 스케줄러 중단을 가리지 않는다.
  const heartbeat = JSON.parse(readFileSync(path.resolve(import.meta.dirname, "../../release/product-gates/external-scheduler-heartbeat.json"), "utf8"));
  assert.equal(heartbeat.dispatcher.login, APP);
  assert.notEqual(heartbeat.dispatcher.login, "github-actions[bot]");
  for (const stage of REFRESH_STAGE_IDS) assert.ok(heartbeat.workflows.some(({ workflow }) => workflow === AUTOMATION_STAGE_WORKFLOWS[stage]), `${stage}: 스케줄러 heartbeat 대상`);
  // 재dispatch하는 단계의 workflow는 모두 위 두 부류 중 하나다.
  const redispatched = Object.entries(AUTOMATION_STAGE_WORKFLOWS).filter(([stage]) => STAGE_REDISPATCH[stage]).map(([, workflow]) => workflow);
  for (const workflow of redispatched) assert.ok(Object.hasOwn(SCHEDULED_VARIABLES, workflow) || REFRESH_STAGE_IDS.some((stage) => AUTOMATION_STAGE_WORKFLOWS[stage] === workflow), `${workflow}: 게이트 분류가 없다`);
});

test("반증: 같은 단계가 하루 3회를 넘게 닫히면 닫지 않고 이상으로 보고한다(루프 상한)", async () => {
  assert.equal(RECREATE_DAILY_LIMIT, 3);
  const recent = [closed(11, BRANCHES.registration, 1), closed(12, BRANCHES.registration, 5), closed(13, BRANCHES.registration, 23)];
  const { api } = fakeApi({ openPulls: [open(1, BRANCHES.registration), open(2, BRANCHES["itx-promotion"])], closedPulls: recent, behind: { [sha(1)]: 1, [sha(2)]: 1 } });
  const plan = await planBehindRecreation({ repository: REPOSITORY, api, now: NOW });
  assert.deepEqual(plan.actions.map(({ number }) => number), [2], "other stages are unaffected");
  assert.deepEqual(plan.anomalies.map(({ stage, number, closures }) => ({ stage, number, closures })), [{ stage: "registration", number: 1, closures: 3 }]);
  const writer = recorder();
  await assert.rejects(recreateBehindPullRequests({ repository: REPOSITORY, api, now: NOW, ...writer }), /AUTOMATION_PR_RECREATE_LOOP: registration/u);
  assert.deepEqual(writer.writes, [["close", 2], ["delete", BRANCHES["itx-promotion"]], ["dispatch", "itx-current-promotion.yml"], ["dispatch-inputs", "itx-current-promotion.yml", { replay_run_id: "9002" }]], "allowed stages still recreate before the report");
  // 두 번 닫혔으면 세 번째는 허용한다(경계). 병합된 PR·24시간 지난 PR·사람이 작성한 PR은 세지 않는다.
  const edge = fakeApi({
    openPulls: [open(1, BRANCHES.registration)],
    closedPulls: [closed(11, BRANCHES.registration, 1), closed(12, BRANCHES.registration, 2), closed(13, BRANCHES.registration, 3, { merged: true }), closed(14, BRANCHES.registration, 25), closed(15, BRANCHES.registration, 1, { user: HUMAN }), closed(16, BRANCHES["itx-promotion"], 1)],
    behind: { [sha(1)]: 1 },
  });
  const plan2 = await planBehindRecreation({ repository: REPOSITORY, api: edge.api, now: NOW });
  assert.equal(plan2.actions.length, 1);
  assert.deepEqual(plan2.anomalies, []);
  // 한 번에 같은 단계 PR이 여럿이면 실행 중에도 센다(3개째까지만).
  const many = fakeApi({
    openPulls: [open(1, BRANCHES.registration), open(2, BRANCHES.registration), open(3, BRANCHES.registration), open(4, BRANCHES.registration)],
    closedPulls: [],
    behind: { [sha(1)]: 1, [sha(2)]: 1, [sha(3)]: 1, [sha(4)]: 1 },
  });
  const plan3 = await planBehindRecreation({ repository: REPOSITORY, api: many.api, now: NOW });
  assert.equal(plan3.actions.length, 3);
  assert.equal(plan3.anomalies.length, 1);
});

test("반증: 쓰기가 하나라도 실패하면 이후 쓰기를 하지 않고 그대로 실패한다. 이전 상태로 덮지 않는다", async () => {
  const { api } = fakeApi({ openPulls: [open(1, BRANCHES.registration), open(2, BRANCHES["itx-promotion"])], behind: { [sha(1)]: 1, [sha(2)]: 1 } });
  for (const failing of ["closePullRequest", "deleteBranch", "dispatchWorkflow"]) {
    const writer = recorder();
    writer[failing] = async () => { throw new Error(`${failing} failed`); };
    await assert.rejects(recreateBehindPullRequests({ repository: REPOSITORY, api, now: NOW, ...writer }), new RegExp(`${failing} failed`, "u"));
    assert.ok(!writer.writes.some(([, target]) => target === 2 || target === BRANCHES["itx-promotion"]), `${failing}: later stage untouched`);
  }
  // 닫기가 실패하면 브랜치를 지우지 않는다(열린 PR의 브랜치를 지우면 PR이 깨진다).
  const closeFails = recorder();
  closeFails.closePullRequest = async () => { throw new Error("close failed"); };
  await assert.rejects(recreateBehindPullRequests({ repository: REPOSITORY, api, now: NOW, ...closeFails }), /close failed/u);
  assert.deepEqual(closeFails.writes, []);
  await assert.rejects(planBehindRecreation({ repository: REPOSITORY, api: async () => { throw new Error("HTTP 502"); }, now: NOW }), /HTTP 502/u);
  await assert.rejects(planBehindRecreation({ repository: REPOSITORY, api: async (endpoint) => (endpoint.includes("compare") ? { behind_by: "x" } : [open(1, BRANCHES.registration)]), now: NOW }), /AUTOMATION_PR_INPUT/u);
  await assert.rejects(planBehindRecreation({ repository: "bad repo", api, now: NOW }), /AUTOMATION_PR_INPUT/u);
});

test("CLI plan은 닫을 대상 수를 출력하고 알 수 없는 명령·인자는 실패한다", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "automation-pr-recreate-"));
  try {
    const { api } = fakeApi({ openPulls: [open(1, BRANCHES.registration), open(3, BRANCHES["itx-promotion"])], behind: { [sha(1)]: 1 } });
    const output = path.join(directory, "output.txt");
    await main(["plan", "--repository", REPOSITORY, "--github-output", output], { api, now: NOW, log: () => {} });
    assert.equal(await readFile(output, "utf8"), "targets=1\n");
    await assert.rejects(main(["unknown"], { api }), /AUTOMATION_PR_INPUT/u);
    await assert.rejects(main(["plan"], { api }), /AUTOMATION_PR_INPUT/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// workflow 계약
// ---------------------------------------------------------------------------
const FILE = "automation-pr-behind-recreate.yml";
const { yml, steps, step } = loadWorkflow(path.resolve(import.meta.dirname, "../.."), FILE);
const code = yml.split("\n").filter((line) => !line.trimStart().startsWith("#")).join("\n");
const APP_TOKEN_ACTION = "actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1";
const NEEDED = "${{ steps.plan.outputs.targets != '0' }}";

test("트리거는 main push와 CI 완료이고 변수가 true일 때만 돈다. pull_request_target과 PR 코드 checkout이 없다", () => {
  assert.match(yml, /\non:\n  push:\n    branches: \[main\]\n  workflow_run:\n    workflows: \[CI\]\n    types: \[completed\]\n/u);
  for (const trigger of ["pull_request_target", "pull_request", "schedule", "workflow_dispatch"]) assert.doesNotMatch(code, new RegExp(String.raw`\n  ${trigger}:`, "u"), trigger);
  assert.doesNotMatch(code, /pull_request_target/u);
  assert.equal(
    /\n    if: (\$\{\{[^\n]*\}\})\n/u.exec(yml)?.[1],
    "${{ vars.DATAPACK_AUTOMATION_AUTOMERGE == 'true' && (github.event_name == 'push' || (github.event.workflow_run.event == 'pull_request' && startsWith(github.event.workflow_run.head_branch, 'automation/') && github.event.workflow_run.head_repository.full_name == github.repository)) }}",
  );
  const checkouts = steps().filter(({ block }) => block.includes("uses: actions/checkout@"));
  assert.equal(checkouts.length, 1);
  assert.doesNotMatch(checkouts[0].block, /\n          ref:/u);
  for (const forbidden of [/refs\/pull/u, /pull_request\.head/u, /head_sha/u, /actions\/download-artifact/u, /gh pr merge|update-branch|--admin/u, /gh pr create/u]) assert.doesNotMatch(code, forbidden, String(forbidden));
  assert.deepEqual([...new Set([...code.matchAll(/node (\S+)/gu)].map((match) => match[1]))], ["tools/ci/automation-pr-recreate.mjs", "tools/ci/report-refresh-failure.mjs"]);
});

test("권한은 job 하나에만 있고 쓰기는 ref 삭제(contents)와 workflow 재실행(actions)뿐이다. PR 닫기는 App 토큰(pull_requests: write)으로 한다", () => {
  assert.match(yml, /\npermissions: \{\}\n/u);
  assert.equal((yml.match(/\n    permissions:\n/gu) ?? []).length, 1);
  assert.match(yml, /\n    permissions:\n      actions: write\n      contents: write\n      issues: write\n      pull-requests: read\n/u);
  assert.match(yml, /\n    concurrency:\n      group: automation-pr-recreate\n      cancel-in-progress: false\n/u);
  const mint = steps().filter(({ block }) => block.includes(`uses: ${APP_TOKEN_ACTION}`));
  assert.equal(mint.length, 1);
  assert.equal(ifCondition(mint[0].block), NEEDED);
  assert.match(mint[0].block, /\n          owner: AquilaXk\n          repositories: easysubway-data\n          permission-pull-requests: write(?:\n|$)/u);
  assert.doesNotMatch(mint[0].block, /permission-(contents|actions|workflows|issues|checks|statuses)/u);
  assert.deepEqual([...new Set([...code.matchAll(/secrets\.(\w+)/gu)].map((match) => match[1]))].sort(), ["EASYSUBWAY_RELEASE_APP_CLIENT_ID", "EASYSUBWAY_RELEASE_APP_PRIVATE_KEY"]);
  assert.equal(code.split("steps.app-token.outputs.token").length - 1, 1);
});

test("계획(읽기)이 먼저고, 닫을 대상이 있을 때만 App 토큰을 받아 실행 step에서 쓴다", () => {
  const names = steps().map(({ name }) => name);
  assert.deepEqual(names, [
    "Checkout the default branch",
    "Set up Node.js",
    "Plan the behind automation pull requests",
    "Mint App token for closing pull requests",
    "Close behind automation pull requests and request a fresh run",
    "Report refresh failure as an issue",
  ]);
  assertNoExpressionInRunScripts({ steps, file: FILE });
  const plan = step("Plan the behind automation pull requests");
  assert.match(plan.block, /\n        id: plan\n/u);
  assert.match(plan.block, /GH_TOKEN: \$\{\{ github\.token \}\}/u);
  assert.ok(plan.block.includes('node tools/ci/automation-pr-recreate.mjs plan --repository "${GITHUB_REPOSITORY}" --github-output "${GITHUB_OUTPUT}"'));
  const run = step("Close behind automation pull requests and request a fresh run");
  assert.equal(ifCondition(run.block), NEEDED);
  assert.match(run.block, /GH_TOKEN: \$\{\{ github\.token \}\}/u);
  assert.match(run.block, /APP_TOKEN: \$\{\{ steps\.app-token\.outputs\.token \}\}/u);
  assert.ok(run.block.includes('node tools/ci/automation-pr-recreate.mjs run --repository "${GITHUB_REPOSITORY}"'));
});

test("실패하면 마지막 step이 #926 경로로 이슈를 연다", () => {
  assertFailureReportLast({ yml, step, file: FILE });
  assert.ok(Object.hasOwn(REFRESH_WORKFLOWS, FILE));
  assert.doesNotMatch(code, /continue-on-error|\|\| true|\|\| exit 0/u);
});

// ---------------------------------------------------------------------------
// #1127: 하루 한 번만 받을 수 있는 수집분을 들고 있는 단계는 닫는 순간 그날 수집분을 잃는다.
// ---------------------------------------------------------------------------
test("단계마다 재생성 방식이 정해져 있다: ITX 승격은 보관 capture 재생, 같은 KST 날 ITX를 수집할 수 있는 수도권 topology 갱신은 대기, 나머지는 닫고 재실행", () => {
  assert.deepEqual(Object.keys(STAGE_RECREATE_MODE).sort(), Object.keys(AUTOMATION_STAGE_WORKFLOWS).sort(), "빠진 단계가 없다");
  assert.deepEqual({ ...STAGE_RECREATE_MODE }, {
    registration: RECREATE_MODE.CLOSE, "derivative-rebinding": RECREATE_MODE.CLOSE, "candidate-refresh": RECREATE_MODE.CLOSE,
    "itx-promotion": RECREATE_MODE.REPLAY, "source-reverification": RECREATE_MODE.CLOSE,
    "gwangju-timetable-refresh": RECREATE_MODE.CLOSE, "capital-topology-refresh": RECREATE_MODE.HOLD_SAME_KST_DAY,
    "kric-facility-refresh": RECREATE_MODE.CLOSE, "seoul-accessibility-refresh": RECREATE_MODE.CLOSE,
  });
  // 공급자 호출을 하루 한 번으로 묶는 예산 가드(guard-itx-current-collection-budget)에 등록된 수집 workflow는 모두 닫지 않는 방식이다.
  const guard = readFileSync(path.resolve(import.meta.dirname, "guard-itx-current-collection-budget.mjs"), "utf8");
  const guarded = [...guard.matchAll(/workflowFile: "([^"]+)"/gu)].map((match) => match[1]).filter((workflow) => workflow !== "itx-current-collection.yml");
  assert.deepEqual(guarded.sort(), ["current-capital-topology-refresh.yml", "itx-current-promotion.yml"]);
  for (const workflow of guarded) {
    const stage = Object.keys(AUTOMATION_STAGE_WORKFLOWS).find((candidate) => AUTOMATION_STAGE_WORKFLOWS[candidate] === workflow);
    assert.notEqual(STAGE_RECREATE_MODE[stage], RECREATE_MODE.CLOSE, `${stage}: 하루 한 번 수집분을 들고 있어 단순히 닫으면 그날 수집분을 잃는다`);
  }
});

test("뒤처진 ITX 승격 PR은 닫고 같은 수집분을 replay_run_id로 재생해 최신 main 위에 다시 만든다 (공급자 재호출 없음)", async () => {
  const { api, calls } = fakeApi({ openPulls: [open(2, BRANCHES["itx-promotion"])], behind: { [sha(2)]: 4 } });
  const plan = await planBehindRecreation({ repository: REPOSITORY, api, now: NOW });
  assert.deepEqual(plan.actions.map(({ number, stage, replayRunId }) => ({ number, stage, replayRunId })), [{ number: 2, stage: "itx-promotion", replayRunId: "9002" }]);
  assert.ok(calls.includes(`repos/${REPOSITORY}/actions/runs/9002/artifacts?name=itx-current-promotion-9002`), "닫기 전에 원본 artifact를 읽는다");
  const writer = recorder();
  await recreateBehindPullRequests({ repository: REPOSITORY, api, now: NOW, ...writer });
  assert.deepEqual(writer.writes, [
    ["close", 2], ["delete", BRANCHES["itx-promotion"]], ["dispatch", "itx-current-promotion.yml"], ["dispatch-inputs", "itx-current-promotion.yml", { replay_run_id: "9002" }],
  ]);
  // 재생 run이 다시 뒤처져도 그 PR의 branch 접미사(재생 run id)가 다음 재생의 원본이 된다.
  const chained = fakeApi({ openPulls: [open(3, "automation/977-itx-promotion-38070000000")], behind: { [sha(3)]: 1 } });
  const again = recorder();
  await recreateBehindPullRequests({ repository: REPOSITORY, api: chained.api, now: NOW, ...again });
  assert.deepEqual(again.writes.at(-1), ["dispatch-inputs", "itx-current-promotion.yml", { replay_run_id: "38070000000" }]);
});

test("반증: 재생할 원본 artifact가 없거나 만료됐거나 둘 이상이면 PR을 닫지 않고 이상으로 보고한다 (닫으면 그날 수집분을 잃는다)", async () => {
  for (const [label, artifacts] of [
    ["없음", () => []],
    ["만료", (runId) => [liveArtifact(runId, { expired: true })]],
    ["둘", (runId) => [liveArtifact(runId), liveArtifact(runId, { id: 2 })]],
    ["이름 다름", () => [{ id: 1, name: "other", expired: false }]],
  ]) {
    const { api } = fakeApi({ openPulls: [open(2, BRANCHES["itx-promotion"]), open(1, BRANCHES.registration)], behind: { [sha(1)]: 1, [sha(2)]: 1 }, artifacts });
    const plan = await planBehindRecreation({ repository: REPOSITORY, api, now: NOW });
    assert.deepEqual(plan.actions.map(({ stage }) => stage), ["registration"], label);
    assert.deepEqual(plan.anomalies.map(({ stage, number, reason }) => ({ stage, number, reason })), [{ stage: "itx-promotion", number: 2, reason: "ITX_REPLAY_SOURCE_MISSING" }], label);
    const writer = recorder();
    await assert.rejects(recreateBehindPullRequests({ repository: REPOSITORY, api, now: NOW, ...writer }), /ITX_REPLAY_SOURCE_MISSING: itx-promotion PR #2/u, label);
    assert.ok(!writer.writes.some(([, target]) => target === 2), `${label}: ITX PR은 건드리지 않는다`);
  }
  // branch 접미사가 run id가 아니면 원본을 알 수 없으므로 닫지 않는다.
  const bad = fakeApi({ openPulls: [open(2, "automation/977-itx-promotion-12345678901234567890")], behind: { [sha(2)]: 1 } });
  const plan = await planBehindRecreation({ repository: REPOSITORY, api: bad.api, now: NOW });
  assert.deepEqual(plan.actions, []);
  assert.equal(plan.anomalies[0].reason, "ITX_REPLAY_SOURCE_MISSING");
  // artifact 조회가 실패하면 추정하지 않고 그대로 실패한다.
  await assert.rejects(planBehindRecreation({ repository: REPOSITORY, api: async (endpoint) => { if (endpoint.includes("/artifacts?")) throw new Error("HTTP 502"); return fakeApi({ openPulls: [open(2, BRANCHES["itx-promotion"])], behind: { [sha(2)]: 1 } }).api(endpoint); }, now: NOW }), /HTTP 502/u);
});

test("재생 dispatch가 실패하면 원본 run id를 담아 실패한다: 같은 입력으로 다시 dispatch하면 복구된다", async () => {
  const { api } = fakeApi({ openPulls: [open(2, BRANCHES["itx-promotion"])], behind: { [sha(2)]: 1 } });
  const writer = recorder();
  writer.dispatchWorkflow = async () => { throw new Error("HTTP 500"); };
  await assert.rejects(recreateBehindPullRequests({ repository: REPOSITORY, api, now: NOW, ...writer }), /ITX_REPLAY_DISPATCH_FAILED: replay_run_id=9002 .*HTTP 500/u);
});

test("수도권 topology 갱신 PR은 같은 KST 날 만들어졌으면 닫지 않고 기다린다 (그날 ITX 수집분을 들고 있을 수 있다). 다음 KST 날부터는 닫고 다시 만든다", async () => {
  // NOW=2026-10-06T12:00Z(KST 21:00)이고 KST 날 시작은 2026-10-05T15:00Z다.
  const sameDay = fakeApi({ openPulls: [open(40, BRANCHES["capital-topology-refresh"], { head: sha(6), createdAt: "2026-10-05T15:00:00Z" })], behind: { [sha(6)]: 2 } });
  const plan = await planBehindRecreation({ repository: REPOSITORY, api: sameDay.api, now: NOW });
  assert.deepEqual(plan.actions, []);
  assert.deepEqual(plan.anomalies, []);
  assert.deepEqual(plan.deferred.map(({ stage, number, reason }) => ({ stage, number, reason })), [{ stage: "capital-topology-refresh", number: 40, reason: "SAME_KST_DAY_ITX_COLLECTION" }]);
  const writer = recorder();
  await recreateBehindPullRequests({ repository: REPOSITORY, api: sameDay.api, now: NOW, ...writer });
  assert.deepEqual(writer.writes, []);
  const previousDay = fakeApi({ openPulls: [open(40, BRANCHES["capital-topology-refresh"], { head: sha(6), createdAt: "2026-10-05T14:59:59Z" })], behind: { [sha(6)]: 2 } });
  assert.equal((await planBehindRecreation({ repository: REPOSITORY, api: previousDay.api, now: NOW })).actions.length, 1);
  // 대기는 닫기 횟수에 들지 않고 CLI의 targets에도 들지 않는다(닫을 일이 없으면 App 토큰도 받지 않는다).
  const directory = await mkdtemp(path.join(os.tmpdir(), "automation-pr-recreate-"));
  try {
    const output = path.join(directory, "output.txt");
    const logs = [];
    await main(["plan", "--repository", REPOSITORY, "--github-output", output], { api: sameDay.api, now: NOW, log: (line) => logs.push(line) });
    assert.equal(await readFile(output, "utf8"), "targets=0\n");
    assert.match(logs.join("\n"), /대기 1건/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  // created_at을 읽을 수 없으면 추정하지 않고 실패한다.
  const noDate = fakeApi({ openPulls: [{ ...open(40, BRANCHES["capital-topology-refresh"], { head: sha(6) }), created_at: undefined }], behind: { [sha(6)]: 2 } });
  await assert.rejects(planBehindRecreation({ repository: REPOSITORY, api: noDate.api, now: NOW }), /AUTOMATION_PR_INPUT/u);
});

test("워크플로: 재생 입력 dispatch를 위해 actions: write 하나만 쓰고 artifact는 REST 조회로만 읽는다 (다운로드·PR 코드 실행 없음)", () => {
  assert.match(yml, /\n    permissions:\n      actions: write\n/u);
  const header = yml.split("\n").filter((line) => line.startsWith("#")).join("\n");
  assert.match(header, /replay_run_id/u);
  assert.match(header, /#1127/u);
});
