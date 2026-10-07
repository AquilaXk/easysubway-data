import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { MAX_CLAIM_BRANCHES } from "./collect-automation-prs.mjs";
import {
  CLAIM_OWNERS, VERIFIED_PRE_PUBLICATION_RUNS, classifyUnboundClaim, claimRunId, collectClaimEvidence, isGhNotFound, main, planUnboundClaims,
} from "./claim-orphans.mjs";

// #995: PR 없는 claim 브랜치(고아)는 만든 run과 게시 증거로 가른다.
//   ACTIVE      만든 run이 아직 돈다. 기다린다(정상).
//   RECOVERABLE claim 뒤에 출력 커밋이 있거나 receipt artifact가 있다. 소유 workflow가 DUE·CURRENT와 무관하게 복구한다.
//   ABANDONED   빈 claim뿐이고 만든 run이 게시 step까지 가지 않았다. 보고한 뒤 지운다.
// 게시 step이 시작됐는데 출력 커밋도 보존 증거도 없으면 게시됐을 수 있다: 지우지 않고 CLAIM_ORPHAN_PUBLISHED_UNREGISTERED로 실패한다.
const REPOSITORY = "AquilaXk/easysubway-data";
const GWANGJU = "retained-gwangju-timetable-refresh.yml";
const KRIC = "kric-current-facility-refresh.yml";
const SEOUL = "seoul-current-accessibility-refresh.yml";
const GWANGJU_CLAIM = "Claim retained Gwangju timetable refresh";
const branch = (workflow, runId) => `${CLAIM_OWNERS[workflow].prefix}${runId}`;
// #995 F1: 게시 여부는 만든 run이 게시 step까지 갔는지로 판정한다. 기본값은 게시 step이 건너뛰어진 run(수집 단계에서 실패)이다.
const step = (name, conclusion, status = "completed") => ({ name, status, conclusion });
const publishStepOf = (workflow) => CLAIM_OWNERS[workflow].publicationSteps[0];
const stepsBeforePublish = (workflow) => [step("Create claim", "success"), step("Collect", "failure"), step(publishStepOf(workflow), "skipped")];
const stepsPublished = (workflow, conclusion = "failure") => [step("Create claim", "success"), step("Collect", "success"), step(publishStepOf(workflow), conclusion)];
const finished = (workflow, overrides = {}) => ({
  found: true, status: "completed", conclusion: "failure", workflowName: CLAIM_OWNERS[workflow].workflowName, headBranch: "main",
  steps: CLAIM_OWNERS[workflow].publicationSteps ? stepsBeforePublish(workflow) : [], ...overrides,
});
const emptyClaim = (workflow = GWANGJU) => ({ aheadBy: 1, subjects: [CLAIM_OWNERS[workflow].claimSubject], changedFiles: 0 });
const evidence = (workflow, runId, overrides = {}) => ({
  branch: branch(workflow, runId), runId: String(runId), run: finished(workflow), commits: emptyClaim(workflow), artifacts: [], ...overrides,
});
const pr = (number, state, headRefName, overrides = {}) => ({
  number, state, isDraft: true, headRefName, baseRefName: "main", isCrossRepository: false, headRepository: { nameWithOwner: REPOSITORY }, ...overrides,
});

test("빈 claim뿐이고 run이 게시 step까지 가지 않았으면 ABANDONED다(504 사례: 수집 단계에서 실패해 claim만 남았다)", () => {
  assert.deepEqual(classifyUnboundClaim(GWANGJU, evidence(GWANGJU, 37399282636)), {
    branch: branch(GWANGJU, 37399282636), runId: "37399282636", kind: "ABANDONED", reason: "PUBLISH_STEP_NOT_STARTED",
  });
});

// #995 F1: run 기록이 사라졌으면(Not Found) 게시 step까지 갔는지 알 수 없다. 빈 claim이라도 지우지 않고 명시적 오류로 드러낸다.
test("claim을 만든 run 기록이 없으면(Not Found) 빈 claim이라도 지우지 않고 실패한다. 출력이 있으면 복구 대상이다", () => {
  for (const workflow of [GWANGJU, SEOUL, KRIC]) {
    assert.throws(() => classifyUnboundClaim(workflow, evidence(workflow, 11, { run: { found: false } })), /CLAIM_ORPHAN_RUN_UNAVAILABLE/u, workflow);
  }
  const output = { aheadBy: 2, subjects: [GWANGJU_CLAIM, "Refresh retained Gwangju timetable"], changedFiles: 2 };
  assert.equal(classifyUnboundClaim(GWANGJU, evidence(GWANGJU, 11, { run: { found: false }, commits: output })).kind, "RECOVERABLE");
});

test("게시 step이 건너뛰어졌으면(수집 단계 실패) ABANDONED다. 광주·서울·KRIC 모두 같다", () => {
  for (const workflow of [GWANGJU, SEOUL, KRIC]) {
    const result = classifyUnboundClaim(workflow, evidence(workflow, 16));
    assert.deepEqual([result.kind, result.reason], ["ABANDONED", "PUBLISH_STEP_NOT_STARTED"], workflow);
  }
});

test("게시 step이 시작된 뒤 실패·취소·시간 초과된 run은 출력 커밋도 보존 증거도 없으면 지우지 않고 실패한다", () => {
  for (const workflow of [GWANGJU, SEOUL, KRIC]) {
    for (const conclusion of ["failure", "cancelled", "timed_out", "success"]) {
      assert.throws(
        () => classifyUnboundClaim(workflow, evidence(workflow, 17, { run: finished(workflow, { steps: stepsPublished(workflow, conclusion) }) })),
        /CLAIM_ORPHAN_PUBLISHED_UNREGISTERED/u, `${workflow} ${conclusion}`,
      );
    }
  }
});

test("게시 step이 시작됐어도 claim 뒤 출력 커밋이 있으면 복구 대상이다", () => {
  const output = { aheadBy: 2, subjects: [GWANGJU_CLAIM, "Refresh retained Gwangju timetable"], changedFiles: 2 };
  const result = classifyUnboundClaim(GWANGJU, evidence(GWANGJU, 18, { run: finished(GWANGJU, { steps: stepsPublished(GWANGJU) }), commits: output }));
  assert.equal(result.kind, "RECOVERABLE");
});

test("step 정보가 없거나 게시 step이 목록에 없으면(workflow가 바뀐 run) 판단할 수 없어 실패한다", () => {
  for (const steps of [[], [step("Create claim", "success")]]) {
    assert.throws(() => classifyUnboundClaim(GWANGJU, evidence(GWANGJU, 19, { run: finished(GWANGJU, { steps }) })), /CLAIM_ORPHAN_STEPS_UNAVAILABLE/u);
  }
});

test("분리 전 workflow의 합쳐진 step(수집+게시)이 시작됐으면 게시됐을 수 있는 것으로 본다. 건너뛰어졌으면 ABANDONED다", () => {
  for (const [workflow, legacy] of [[GWANGJU, "Refresh due retained Gwangju timetable"], [SEOUL, "Collect and bind current snapshot"], [KRIC, "KRIC current facility refresh / Collect and bind current snapshot"]]) {
    assert.ok(CLAIM_OWNERS[workflow].publicationSteps.includes(legacy), workflow);
    const base = [step("Create claim", "success")];
    assert.throws(() => classifyUnboundClaim(workflow, evidence(workflow, 20, { run: finished(workflow, { steps: [...base, step(legacy, "failure")] }) })), /PUBLISHED_UNREGISTERED/u);
    assert.equal(classifyUnboundClaim(workflow, evidence(workflow, 20, { run: finished(workflow, { steps: [...base, step(legacy, "skipped")] }) })).kind, "ABANDONED");
  }
});

// 수동 확인된 예외: 분리 전 step 구조에서는 수집 단계 실패와 게시 이후 실패를 가를 수 없다. 로그로 확인한 run만 이 표에 둔다.
test("로그로 게시 전 실패가 확인된 run은 명시 표에 있을 때만 ABANDONED다", () => {
  const legacy = [step("Create claim", "success"), step("Refresh due retained Gwangju timetable", "failure")];
  const run = finished(GWANGJU, { steps: legacy });
  assert.deepEqual(Object.keys(VERIFIED_PRE_PUBLICATION_RUNS[GWANGJU]), ["37399282636"]);
  assert.match(VERIFIED_PRE_PUBLICATION_RUNS[GWANGJU]["37399282636"], /KRIC_TIMETABLE_FILE_BODY/u);
  const verified = classifyUnboundClaim(GWANGJU, evidence(GWANGJU, 37399282636, { run }));
  assert.deepEqual([verified.kind, verified.reason], ["ABANDONED", "VERIFIED_PRE_PUBLICATION"]);
  assert.throws(() => classifyUnboundClaim(GWANGJU, evidence(GWANGJU, 37399282637, { run })), /PUBLISHED_UNREGISTERED/u);
  // 표에 있어도 새 구조의 게시 step이 시작됐으면 쓰지 않는다.
  assert.throws(() => classifyUnboundClaim(GWANGJU, evidence(GWANGJU, 37399282636, { run: finished(GWANGJU, { steps: stepsPublished(GWANGJU) }) })), /PUBLISHED_UNREGISTERED/u);
});

test("게시 step이 없는 workflow(수도권 topology 갱신)는 빈 claim이면 run 기록이 없어도 ABANDONED다", () => {
  const topology = "current-capital-topology-refresh.yml";
  assert.equal(CLAIM_OWNERS[topology].publicationSteps, null);
  assert.equal(classifyUnboundClaim(topology, evidence(topology, 24)).kind, "ABANDONED");
  assert.equal(classifyUnboundClaim(topology, evidence(topology, 24, { run: { found: false } })).reason, "EMPTY_CLAIM_NO_PUBLICATION");
});

test("run이 끝나지 않았으면 어떤 상태든 ACTIVE다. 기다리고 지우지도 복구하지도 않는다", () => {
  for (const status of ["in_progress", "queued", "waiting", "pending", "requested"]) {
    const result = classifyUnboundClaim(GWANGJU, evidence(GWANGJU, 12, { run: finished(GWANGJU, { status, conclusion: null }) }));
    assert.equal(result.kind, "ACTIVE", status);
  }
  // 진행 중이면 출력 커밋이 있어도 지금 쓰는 중이므로 건드리지 않는다.
  const withOutput = evidence(GWANGJU, 12, { run: finished(GWANGJU, { status: "in_progress", conclusion: null }), commits: { aheadBy: 2, subjects: [GWANGJU_CLAIM, "Refresh retained Gwangju timetable"], changedFiles: 2 } });
  assert.equal(classifyUnboundClaim(GWANGJU, withOutput).kind, "ACTIVE");
});

test("알 수 없는 run 상태는 추정하지 않고 실패한다", () => {
  assert.throws(() => classifyUnboundClaim(GWANGJU, evidence(GWANGJU, 13, { run: finished(GWANGJU, { status: "mystery" }) })), /CLAIM_ORPHAN_EVIDENCE_INVALID/u);
});

test("claim 뒤에 출력 커밋이 있으면 RECOVERABLE이다. 끝난 run이든 사라진 run이든 지우지 않는다", () => {
  const output = { aheadBy: 2, subjects: [GWANGJU_CLAIM, "Refresh retained Gwangju timetable"], changedFiles: 2 };
  assert.equal(classifyUnboundClaim(GWANGJU, evidence(GWANGJU, 14, { commits: output })).kind, "RECOVERABLE");
  assert.equal(classifyUnboundClaim(GWANGJU, evidence(GWANGJU, 14, { commits: output, run: { found: false } })).kind, "RECOVERABLE");
  assert.equal(classifyUnboundClaim(GWANGJU, evidence(GWANGJU, 14, { commits: output })).reason, "BRANCH_CARRIES_OUTPUT");
});

test("claim 커밋이 비어 있지 않거나 제목이 다르면 내용이 있는 브랜치로 보고 지우지 않는다", () => {
  assert.equal(classifyUnboundClaim(GWANGJU, evidence(GWANGJU, 15, { commits: { aheadBy: 1, subjects: [GWANGJU_CLAIM], changedFiles: 1 } })).kind, "RECOVERABLE");
  assert.equal(classifyUnboundClaim(GWANGJU, evidence(GWANGJU, 15, { commits: { aheadBy: 1, subjects: ["someone else"], changedFiles: 0 } })).kind, "RECOVERABLE");
  assert.equal(classifyUnboundClaim(GWANGJU, evidence(GWANGJU, 15, { commits: { aheadBy: 0, subjects: [], changedFiles: 0 } })).kind, "RECOVERABLE");
  // 목록이 잘렸으면(개수가 어긋나면) 빈 claim이라고 단정하지 않는다.
  assert.equal(classifyUnboundClaim(GWANGJU, evidence(GWANGJU, 15, { commits: { aheadBy: 2, subjects: [GWANGJU_CLAIM], changedFiles: 0 } })).kind, "RECOVERABLE");
});

test("KRIC: 게시 step이 시작됐고 보존 증거 artifact가 있으면 복구 대상이다. 증거가 없거나 만료됐으면 지우지 않고 실패한다", () => {
  const retained = (runId, expired) => ({ name: `kric-current-facility-refresh-${runId}`, expired });
  const started = (artifacts) => evidence(KRIC, 21, { run: finished(KRIC, { steps: stepsPublished(KRIC) }), artifacts });
  const result = classifyUnboundClaim(KRIC, started([retained(21, false)]));
  assert.deepEqual([result.kind, result.reason], ["RECOVERABLE", "RETAINED_EVIDENCE"]);
  for (const artifacts of [[retained(21, true)], [], [retained(22, false)]]) {
    assert.throws(() => classifyUnboundClaim(KRIC, started(artifacts)), /CLAIM_ORPHAN_PUBLISHED_UNREGISTERED/u, JSON.stringify(artifacts));
  }
  // 게시 step이 시작되지 않았으면 artifact가 있어도(decision.json뿐이다) 게시된 것이 없다.
  assert.equal(classifyUnboundClaim(KRIC, evidence(KRIC, 21, { artifacts: [retained(21, false)] })).kind, "ABANDONED");
  // artifact를 정의하지 않은 workflow는 artifact가 있어도 증거로 보지 않는다.
  assert.throws(() => classifyUnboundClaim(GWANGJU, evidence(GWANGJU, 21, { run: finished(GWANGJU, { steps: stepsPublished(GWANGJU) }), artifacts: [{ name: "kric-current-facility-refresh-21", expired: false }] })), /PUBLISHED_UNREGISTERED/u);
});

test("KRIC이 닫았다고 남긴 Abandon 커밋은 receipt가 있어도 ABANDONED다", () => {
  const closed = { aheadBy: 2, subjects: ["Claim KRIC facility refresh", "Abandon KRIC facility refresh claim"], changedFiles: 0 };
  const result = classifyUnboundClaim(KRIC, evidence(KRIC, 22, { commits: closed, artifacts: [{ name: "kric-current-facility-refresh-22", expired: false }] }));
  assert.equal(result.kind, "ABANDONED");
  assert.equal(result.reason, "CLAIM_CLOSED_OUT");
});

test("claim 이름이 다른 workflow나 main이 아닌 run을 가리키면 이상이다. 어느 쪽도 추정하지 않는다", () => {
  assert.throws(() => classifyUnboundClaim(GWANGJU, evidence(GWANGJU, 31, { run: finished(GWANGJU, { workflowName: "Source Reverification" }) })), /CLAIM_ORPHAN_RUN_MISMATCH/u);
  assert.throws(() => classifyUnboundClaim(GWANGJU, evidence(GWANGJU, 31, { run: finished(GWANGJU, { headBranch: "feature" }) })), /CLAIM_ORPHAN_RUN_MISMATCH/u);
});

test("증거의 형식이 어긋나면 실패한다", () => {
  const good = evidence(GWANGJU, 41);
  for (const bad of [
    null, { ...good, runId: "42" }, { ...good, branch: "automation/other-41" }, { ...good, run: undefined }, { ...good, commits: undefined },
    { ...good, commits: { aheadBy: "1", subjects: [GWANGJU_CLAIM], changedFiles: 0 } }, { ...good, commits: { aheadBy: 1, subjects: "x", changedFiles: 0 } },
    { ...good, artifacts: undefined }, { ...good, artifacts: [{ name: 1, expired: false }] },
  ]) assert.throws(() => classifyUnboundClaim(GWANGJU, bad), /CLAIM_ORPHAN_EVIDENCE_INVALID/u, JSON.stringify(bad));
  assert.throws(() => classifyUnboundClaim("unknown.yml", good), /CLAIM_ORPHAN_INPUT_INVALID/u);
});

test("claim 브랜치 이름의 run id를 읽는다", () => {
  assert.equal(claimRunId(GWANGJU, branch(GWANGJU, 37399282636)), "37399282636");
  for (const bad of ["automation/504-retained-gwangju-timetable-refresh-", "automation/504-retained-gwangju-timetable-refresh-0", "automation/504-retained-gwangju-timetable-refresh-1x", "automation/639-seoul-accessibility-refresh-1"]) {
    assert.throws(() => claimRunId(GWANGJU, bad), /CLAIM_ORPHAN_INPUT_INVALID/u, bad);
  }
});

test("PR이 어떤 상태로든 있는 claim은 고아가 아니다. PR 없는 claim만 증거로 가른다", () => {
  const a = branch(GWANGJU, 51); const b = branch(GWANGJU, 52); const c = branch(GWANGJU, 53); const d = branch(GWANGJU, 54);
  const plan = planUnboundClaims({
    workflowFile: GWANGJU, repository: REPOSITORY, claimBranches: [a, b, c, d],
    pullRequests: [pr(1, "OPEN", a), pr(2, "CLOSED", b), pr(3, "MERGED", c)],
    evidence: [evidence(GWANGJU, 54)],
  });
  assert.deepEqual(plan, { active: [], recoverable: [], abandoned: [d] });
});

test("PR 없는 claim의 증거가 없으면 추정하지 않고 실패한다", () => {
  assert.throws(() => planUnboundClaims({
    workflowFile: GWANGJU, repository: REPOSITORY, claimBranches: [branch(GWANGJU, 61)], pullRequests: [], evidence: [],
  }), /CLAIM_ORPHAN_EVIDENCE_MISSING/u);
});

test("다른 저장소나 main이 아닌 PR은 claim을 묶지 않는다", () => {
  const a = branch(GWANGJU, 71);
  for (const foreign of [pr(1, "OPEN", a, { isCrossRepository: true, headRepository: { nameWithOwner: "fork/easysubway-data" } }), pr(2, "OPEN", a, { baseRefName: "release" })]) {
    const plan = planUnboundClaims({ workflowFile: GWANGJU, repository: REPOSITORY, claimBranches: [a], pullRequests: [foreign], evidence: [evidence(GWANGJU, 71)] });
    assert.deepEqual(plan.abandoned, [a]);
  }
});

test("여러 고아를 세 갈래로 나눠 오름차순으로 돌려준다", () => {
  const claims = [91, 92, 93, 94].map((id) => branch(GWANGJU, id));
  const plan = planUnboundClaims({
    workflowFile: GWANGJU, repository: REPOSITORY, claimBranches: claims, pullRequests: [],
    evidence: [
      evidence(GWANGJU, 94), evidence(GWANGJU, 93, { run: finished(GWANGJU, { status: "in_progress", conclusion: null }) }),
      evidence(GWANGJU, 92, { commits: { aheadBy: 2, subjects: [GWANGJU_CLAIM, "Refresh retained Gwangju timetable"], changedFiles: 2 } }), evidence(GWANGJU, 91),
    ],
  });
  assert.deepEqual(plan, { active: [claims[2]], recoverable: [claims[1]], abandoned: [claims[0], claims[3]] });
});

// ---- 증거 수집(gh 호출): #987 리뷰 F1·#994의 상한 패턴 ----
function fakeGitHub({ runs = {}, compare = {}, artifacts = {} } = {}) {
  const calls = [];
  const runGh = async (args) => {
    calls.push(args);
    if (args[0] === "run" && args[1] === "view") {
      const outcome = runs[args[2]];
      if (outcome instanceof Error) throw outcome;
      if (outcome === undefined) throw new Error("gh run view failed: failed to get run: HTTP 404: Not Found (https://api.github.com/x)");
      return JSON.stringify(outcome);
    }
    assert.equal(args[0], "api");
    const endpoint = args[1];
    const compared = /^repos\/[^/]+\/[^/]+\/compare\/main\.\.\.(.+)$/u.exec(endpoint);
    if (compared) {
      const outcome = compare[compared[1]];
      if (outcome instanceof Error) throw outcome;
      if (outcome === undefined) throw new Error("gh api repos/x/y/compare/z failed: gh: Not Found (HTTP 404)");
      return JSON.stringify(outcome);
    }
    const listed = /^repos\/[^/]+\/[^/]+\/actions\/runs\/(\d+)\/artifacts/u.exec(endpoint);
    assert.ok(listed, `unexpected endpoint ${endpoint}`);
    const outcome = artifacts[listed[1]];
    if (outcome instanceof Error) throw outcome;
    if (outcome === undefined) throw new Error("gh api repos/x/y/actions/runs/1/artifacts failed: gh: Not Found (HTTP 404)");
    return JSON.stringify(outcome);
  };
  return { runGh, calls };
}
// gh run view --json jobs: job마다 steps가 있다(number는 판정에 쓰지 않는다).
const runView = (workflow, overrides = {}) => ({
  status: "completed", conclusion: "failure", workflowName: CLAIM_OWNERS[workflow].workflowName, headBranch: "main",
  jobs: [{ name: "refresh", steps: stepsBeforePublish(workflow).map((item, index) => ({ ...item, number: index + 1 })) }], ...overrides,
});
const compared = (workflow = GWANGJU) => ({ aheadBy: 1, changedFiles: 0, messages: [CLAIM_OWNERS[workflow].claimSubject] });

test("고아마다 gh run view를 한 번씩 부르고 PR이 있는 claim은 조회하지 않는다", async () => {
  const orphan = branch(GWANGJU, 37399282636); const bound = branch(GWANGJU, 5);
  const github = fakeGitHub({ runs: { 37399282636: runView(GWANGJU) }, compare: { [orphan]: compared() } });
  const result = await collectClaimEvidence({
    workflowFile: GWANGJU, repository: REPOSITORY, claimBranches: [orphan, bound], pullRequests: [pr(9, "MERGED", bound)], runGh: github.runGh,
  });
  assert.deepEqual(result, [{
    branch: orphan, runId: "37399282636",
    run: { found: true, status: "completed", conclusion: "failure", workflowName: "Retained Gwangju Timetable Refresh", headBranch: "main", steps: stepsBeforePublish(GWANGJU) },
    commits: { aheadBy: 1, subjects: [GWANGJU_CLAIM], changedFiles: 0 }, artifacts: [],
  }]);
  const runViews = github.calls.filter(([a, b]) => a === "run" && b === "view");
  assert.deepEqual(runViews, [["run", "view", "37399282636", "--repo", REPOSITORY, "--json", "status,conclusion,workflowName,headBranch,jobs"]]);
  assert.equal(github.calls.some(([a, b]) => a === "run" && b === "list"), false, "끝난 run 이력 목록(gh run list)을 받지 않는다");
  assert.equal(github.calls.some((args) => args.includes(String(5))), false, "PR이 있는 claim은 run도 조회하지 않는다");
  assert.equal(github.calls.length, 2, "receipt artifact가 없는 workflow는 artifact를 조회하지 않는다");
});

test("run 기록이 없으면(Not Found) { found: false }로 수집한다(판정은 빈 claim도 지우지 않는다). 그 밖의 gh 오류는 수집에서 fail closed다", async () => {
  const orphan = branch(GWANGJU, 101);
  const gone = fakeGitHub({ runs: {}, compare: { [orphan]: compared() } });
  const result = await collectClaimEvidence({ workflowFile: GWANGJU, repository: REPOSITORY, claimBranches: [orphan], pullRequests: [], runGh: gone.runGh });
  assert.deepEqual(result[0].run, { found: false });
  for (const message of ["gh run view failed: HTTP 403: Resource not accessible by integration", "gh run view failed: HTTP 500: Server Error", "gh run view failed: connection reset", "gh run view failed: HTTP 4040: odd"]) {
    const broken = fakeGitHub({ runs: { 101: new Error(message) }, compare: { [orphan]: compared() } });
    await assert.rejects(collectClaimEvidence({ workflowFile: GWANGJU, repository: REPOSITORY, claimBranches: [orphan], pullRequests: [], runGh: broken.runGh }), (error) => error.message === message, message);
  }
});

test("run의 step은 모든 job에서 이름·status·conclusion만 평탄화해 모은다", async () => {
  const orphan = branch(GWANGJU, 102);
  const jobs = [
    { name: "a", steps: [{ name: "first", status: "completed", conclusion: "success", number: 1 }] },
    { name: "b", steps: [{ name: "second", status: "completed", conclusion: "skipped", number: 1, extra: "dropped" }] },
  ];
  const github = fakeGitHub({ runs: { 102: runView(GWANGJU, { jobs }) }, compare: { [orphan]: compared() } });
  const [result] = await collectClaimEvidence({ workflowFile: GWANGJU, repository: REPOSITORY, claimBranches: [orphan], pullRequests: [], runGh: github.runGh });
  assert.deepEqual(result.run.steps, [step("first", "success"), step("second", "skipped")]);
  const missing = fakeGitHub({ runs: { 102: runView(GWANGJU, { jobs: undefined }) }, compare: { [orphan]: compared() } });
  const [bare] = await collectClaimEvidence({ workflowFile: GWANGJU, repository: REPOSITORY, claimBranches: [orphan], pullRequests: [], runGh: missing.runGh });
  assert.deepEqual(bare.run.steps, [], "step 정보가 없으면 빈 목록이고 판정이 실패한다");
});

test("claim 브랜치 조회가 실패하면(브랜치가 사라졌거나 오류) 추정하지 않고 실패한다", async () => {
  const orphan = branch(GWANGJU, 111);
  await assert.rejects(collectClaimEvidence({
    workflowFile: GWANGJU, repository: REPOSITORY, claimBranches: [orphan], pullRequests: [], runGh: fakeGitHub({ runs: { 111: runView(GWANGJU) } }).runGh,
  }), /Not Found/u);
  await assert.rejects(collectClaimEvidence({
    workflowFile: GWANGJU, repository: REPOSITORY, claimBranches: [orphan], pullRequests: [],
    runGh: fakeGitHub({ runs: { 111: runView(GWANGJU) }, compare: { [orphan]: new Error("gh api failed: HTTP 502") } }).runGh,
  }), /HTTP 502/u);
  await assert.rejects(collectClaimEvidence({
    workflowFile: GWANGJU, repository: REPOSITORY, claimBranches: [orphan], pullRequests: [],
    runGh: fakeGitHub({ runs: { 111: runView(GWANGJU) }, compare: { [orphan]: { aheadBy: "x", changedFiles: 0, messages: [] } } }).runGh,
  }), /CLAIM_ORPHAN_EVIDENCE_INVALID/u);
});

test("receipt artifact를 정의한 workflow만 artifact를 조회한다. 없는 run의 artifact는 빈 목록이다", async () => {
  const orphan = branch(KRIC, 121);
  const github = fakeGitHub({
    runs: { 121: runView(KRIC) }, compare: { [orphan]: compared(KRIC) },
    artifacts: { 121: [{ name: "kric-current-facility-refresh-121", expired: false }] },
  });
  const [result] = await collectClaimEvidence({ workflowFile: KRIC, repository: REPOSITORY, claimBranches: [orphan], pullRequests: [], runGh: github.runGh });
  assert.deepEqual(result.artifacts, [{ name: "kric-current-facility-refresh-121", expired: false }]);
  const gone = fakeGitHub({ runs: {}, compare: { [orphan]: compared(KRIC) } });
  const [missing] = await collectClaimEvidence({ workflowFile: KRIC, repository: REPOSITORY, claimBranches: [orphan], pullRequests: [], runGh: gone.runGh });
  assert.deepEqual(missing.artifacts, []);
  const denied = fakeGitHub({ runs: { 121: runView(KRIC) }, compare: { [orphan]: compared(KRIC) }, artifacts: { 121: new Error("gh api failed: HTTP 403") } });
  await assert.rejects(collectClaimEvidence({ workflowFile: KRIC, repository: REPOSITORY, claimBranches: [orphan], pullRequests: [], runGh: denied.runGh }), /HTTP 403/u);
});

test(`claim 브랜치가 ${MAX_CLAIM_BRANCHES}개를 넘으면 gh를 부르기 전에 실패한다(#994 상한)`, async () => {
  const many = Array.from({ length: MAX_CLAIM_BRANCHES + 1 }, (_, index) => branch(GWANGJU, 1000 + index));
  const github = fakeGitHub();
  await assert.rejects(collectClaimEvidence({ workflowFile: GWANGJU, repository: REPOSITORY, claimBranches: many, pullRequests: [], runGh: github.runGh }), /AUTOMATION_CLAIM_BRANCH_LIMIT/u);
  assert.equal(github.calls.length, 0);
  const atLimit = many.slice(0, MAX_CLAIM_BRANCHES);
  const runs = Object.fromEntries(atLimit.map((name) => [claimRunId(GWANGJU, name), runView(GWANGJU)]));
  const compare = Object.fromEntries(atLimit.map((name) => [name, compared()]));
  const result = await collectClaimEvidence({ workflowFile: GWANGJU, repository: REPOSITORY, claimBranches: atLimit, pullRequests: [], runGh: fakeGitHub({ runs, compare }).runGh });
  assert.equal(result.length, MAX_CLAIM_BRANCHES);
});

test("gh 오류 판별은 HTTP 404만 Not Found로 본다", () => {
  assert.equal(isGhNotFound(new Error("gh run view failed: failed to get run: HTTP 404: Not Found (https://api.github.com/x)")), true);
  assert.equal(isGhNotFound(new Error("gh api x failed: gh: Not Found (HTTP 404)")), true);
  for (const message of ["HTTP 403: Forbidden", "HTTP 500", "HTTP 4040", "Not Found in the ledger", "timeout"]) assert.equal(isGhNotFound(new Error(message)), false, message);
  assert.equal(isGhNotFound("HTTP 404"), false);
});

test("CLI는 ls-remote 출력과 PR 목록에서 고아 증거만 모아 파일에 쓰고 요약을 남긴다", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "claim-orphans-"));
  try {
    const orphan = branch(GWANGJU, 131); const bound = branch(GWANGJU, 132);
    const sha = "a".repeat(40);
    await writeFile(path.join(directory, "claims.txt"), `${sha}\trefs/heads/${orphan}\n${sha}\trefs/heads/${bound}\n`);
    await writeFile(path.join(directory, "prs.json"), JSON.stringify([pr(7, "OPEN", bound)]));
    const logs = [];
    const github = fakeGitHub({ runs: { 131: runView(GWANGJU) }, compare: { [orphan]: compared() } });
    await main([
      "--workflow", GWANGJU, "--repository", REPOSITORY, "--refs", path.join(directory, "claims.txt"),
      "--prs", path.join(directory, "prs.json"), "--output", path.join(directory, "evidence.json"),
    ], { runGh: github.runGh, log: (line) => logs.push(line) });
    const written = JSON.parse(await readFile(path.join(directory, "evidence.json"), "utf8"));
    assert.deepEqual(written.map(({ branch: name }) => name), [orphan]);
    assert.deepEqual(logs, ["claim evidence: claims=2 orphans=1 run_lookups=1"]);
    await writeFile(path.join(directory, "claims.txt"), `${sha}\trefs/heads/automation/639-seoul-accessibility-refresh-1\n`);
    await assert.rejects(main([
      "--workflow", GWANGJU, "--repository", REPOSITORY, "--refs", path.join(directory, "claims.txt"),
      "--prs", path.join(directory, "prs.json"), "--output", path.join(directory, "evidence.json"),
    ], { runGh: github.runGh, log() {} }), /CLAIM_ORPHAN_INPUT_INVALID/u);
    await assert.rejects(main(["--workflow", GWANGJU], { runGh: github.runGh, log() {} }), /CLAIM_ORPHAN_INPUT_INVALID/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("owner 표는 workflow의 claim 접두어·이름·claim 제목과 같다", () => {
  assert.deepEqual(Object.keys(CLAIM_OWNERS).sort(), [
    "current-capital-topology-refresh.yml", "current-capital-topology-registration.yml", GWANGJU, KRIC, SEOUL, "source-reverification.yml",
  ].sort());
  assert.equal(CLAIM_OWNERS[SEOUL].prefix, "automation/639-seoul-accessibility-refresh-");
  assert.equal(CLAIM_OWNERS[KRIC].receiptArtifact("7"), "kric-current-facility-refresh-7");
  assert.equal(CLAIM_OWNERS[GWANGJU].receiptArtifact, undefined);
});

// 게시 step 이름은 workflow 파일의 step 이름과 어긋나면 판정이 조용히 틀어진다. 상수와 파일을 대조한다.
test("owner 표의 게시 step 이름은 workflow 파일에 실제로 있고 분리 전 이름은 표에 남아 있다", async () => {
  const { readFile } = await import("node:fs/promises");
  for (const [workflowFile, owner] of Object.entries(CLAIM_OWNERS)) {
    if (!owner.publicationSteps) continue;
    const text = await readFile(new URL(`../../.github/workflows/${workflowFile}`, import.meta.url), "utf8");
    assert.ok(text.includes(`      - name: ${owner.publicationSteps[0]}\n`), `${workflowFile}: ${owner.publicationSteps[0]}`);
    assert.ok(owner.publicationSteps.length >= 2, `${workflowFile}: 분리 전 step 이름을 함께 둔다`);
    assert.equal(text.includes(`      - name: ${owner.publicationSteps.at(-1)}\n`), false, `${workflowFile}: 분리 전 이름은 이제 없다`);
  }
  assert.equal(CLAIM_OWNERS["current-capital-topology-refresh.yml"].publicationSteps, null);
});
