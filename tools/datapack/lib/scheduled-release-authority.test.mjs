import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  GATE_RUN_REPOSITORY,
  GATE_RUN_WORKFLOW_PATH,
  SCHEDULED_RELEASE_ROLES,
  SCHEDULED_ROLE_EVENTS,
  SCHEDULER_APP_LOGIN,
  gateRunFromEnvironment,
  gateRunRecordViolations,
  releaseRoleEventViolations,
  scheduledAuthorityViolations,
} from "./scheduled-release-authority.mjs";

const headSha = "a".repeat(40);
const scheduledRun = () => ({
  repository: GATE_RUN_REPOSITORY,
  workflowPath: GATE_RUN_WORKFLOW_PATH,
  runId: 37200000001,
  runAttempt: 1,
  event: "schedule",
  headSha,
});
// #1032: 외부 스케줄러 App이 workflow_dispatch로 깨운 run. 정기 역할은 이 run에서도 쓸 수 있다.
const dispatchedRun = (actor = SCHEDULER_APP_LOGIN) => ({ ...scheduledRun(), event: "workflow_dispatch", actor });
const request = (overrides = {}) => ({
  requestedBy: SCHEDULED_RELEASE_ROLES.requestedBy,
  approvedBy: SCHEDULED_RELEASE_ROLES.approvedBy,
  gateRun: scheduledRun(),
  ...overrides,
});

test("the scheduled roles are two distinct fixed labels that no person label can collide with (#929 D3)", () => {
  assert.deepEqual(SCHEDULED_RELEASE_ROLES, {
    requestedBy: "datapack-scheduled-refresh",
    approvedBy: "datapack-release-gates",
  });
  assert.notEqual(SCHEDULED_RELEASE_ROLES.requestedBy, SCHEDULED_RELEASE_ROLES.approvedBy);
  assert.ok(Object.isFrozen(SCHEDULED_RELEASE_ROLES));
});

test("the scheduler App login is the dispatcher of the external scheduler heartbeat policy (#1032)", () => {
  const heartbeat = JSON.parse(readFileSync(path.resolve(import.meta.dirname, "../../../release/product-gates/external-scheduler-heartbeat.json"), "utf8"));
  assert.equal(SCHEDULER_APP_LOGIN, heartbeat.dispatcher.login);
  assert.equal(SCHEDULER_APP_LOGIN, "easysubway-release-chain[bot]");
});

test("scheduled roles are allowed only for the schedule event or a workflow_dispatch started by the scheduler App, and only as the exact pair", () => {
  const { requestedBy, approvedBy } = SCHEDULED_RELEASE_ROLES;
  assert.deepEqual(SCHEDULED_ROLE_EVENTS, ["schedule"]);
  assert.deepEqual(releaseRoleEventViolations({ requestedBy, approvedBy, event: "schedule" }), []);
  // #931 리뷰 F3: 후보 갱신 workflow에는 workflow_run 트리거가 없다. 만드는 쪽이 없는 이벤트는 받지 않는다.
  for (const event of ["workflow_run", "push", "pull_request", undefined]) {
    assert.match(releaseRoleEventViolations({ requestedBy, approvedBy, event, actor: SCHEDULER_APP_LOGIN }).join(";"), /only for the schedule event or/u, String(event));
  }
  // #1032: 사람이 정기 역할을 입력으로 넣은 dispatch는 거부하고, 스케줄러 App의 dispatch만 받는다.
  assert.deepEqual(releaseRoleEventViolations({ requestedBy, approvedBy, event: "workflow_dispatch", actor: SCHEDULER_APP_LOGIN }), []);
  for (const actor of ["AquilaXk", "github-actions[bot]", "easysubway-release-chain", "EASYSUBWAY-RELEASE-CHAIN[BOT]", "", undefined]) {
    assert.match(releaseRoleEventViolations({ requestedBy, approvedBy, event: "workflow_dispatch", actor }).join(";"), /scheduler App/u, String(actor));
  }
  // schedule 이벤트의 actor는 cron을 마지막으로 고친 사람이라 보지 않는다.
  assert.deepEqual(releaseRoleEventViolations({ requestedBy, approvedBy, event: "schedule", actor: "AquilaXk" }), []);
  assert.match(releaseRoleEventViolations({ requestedBy, approvedBy: "data-release-authority", event: "schedule" }).join(";"),
    /exact pair/u);
  assert.match(releaseRoleEventViolations({ requestedBy: "data-operator-lead", approvedBy: "DATAPACK-RELEASE-GATES", event: "workflow_dispatch" }).join(";"),
    /exact pair/u);
});

test("person roles are refused on the schedule event and on any non-dispatch event", () => {
  assert.deepEqual(releaseRoleEventViolations({ requestedBy: "data-operator-lead", approvedBy: "data-release-authority", event: "workflow_dispatch" }), []);
  assert.deepEqual(releaseRoleEventViolations({ requestedBy: "data-operator-lead", approvedBy: "data-release-authority", event: undefined }), []);
  for (const event of ["schedule", "workflow_run"]) {
    assert.match(releaseRoleEventViolations({ requestedBy: "data-operator-lead", approvedBy: "data-release-authority", event }).join(";"),
      /person roles require workflow_dispatch/u);
  }
});

test("a person role request cannot come from the scheduler App (#1032)", () => {
  const person = { requestedBy: "data-operator-lead", approvedBy: "data-release-authority" };
  assert.match(releaseRoleEventViolations({ ...person, event: "workflow_dispatch", actor: SCHEDULER_APP_LOGIN }).join(";"), /person roles cannot be requested by the scheduler App/u);
  assert.deepEqual(releaseRoleEventViolations({ ...person, event: "workflow_dispatch", actor: "AquilaXk" }), []);
  assert.match(scheduledAuthorityViolations({ ...person, gateRun: dispatchedRun() }).join(";"), /person roles cannot be requested by the scheduler App/u);
  assert.deepEqual(scheduledAuthorityViolations({ ...person, gateRun: dispatchedRun("AquilaXk") }), []);
});

test("a scheduled release request must bind the exact gate run that produced it", () => {
  assert.deepEqual(scheduledAuthorityViolations(request()), []);
  // #1032: 스케줄러 App이 dispatch한 run은 actor를 함께 결속한다. 사람 dispatch의 정기 역할은 거부된다.
  assert.deepEqual(scheduledAuthorityViolations(request({ gateRun: dispatchedRun() })), []);
  assert.match(scheduledAuthorityViolations(request({ gateRun: dispatchedRun("AquilaXk") })).join(";"), /scheduler App/u);
  const { actor: _actor, ...withoutActor } = dispatchedRun();
  assert.match(scheduledAuthorityViolations(request({ gateRun: withoutActor })).join(";"), /gateRun keys/u);
  assert.match(scheduledAuthorityViolations(request({ gateRun: { ...scheduledRun(), actor: SCHEDULER_APP_LOGIN } })).join(";"), /gateRun keys/u);
  assert.match(scheduledAuthorityViolations(request({ gateRun: dispatchedRun("") })).join(";"), /gateRun actor/u);
  assert.match(scheduledAuthorityViolations(request({ gateRun: undefined })).join(";"), /gateRun is required/u);
  const tampered = [
    [{ workflowPath: ".github/workflows/datapack-release.yml" }, /workflowPath/u],
    [{ repository: "someone/else" }, /repository/u],
    [{ runId: "37200000001" }, /runId/u],
    [{ runAttempt: 0 }, /runAttempt/u],
    [{ event: "workflow_dispatch" }, /gateRun keys/u],
    [{ headSha: "abc" }, /headSha/u],
    [{ extra: true }, /gateRun keys/u],
  ];
  for (const [override, expected] of tampered) {
    assert.match(scheduledAuthorityViolations(request({ gateRun: { ...scheduledRun(), ...override } })).join(";"), expected,
      JSON.stringify(override));
  }
});

test("a person release request may omit the gate run, but a bound gate run must be a workflow_dispatch run", () => {
  const person = { requestedBy: "data-operator-lead", approvedBy: "data-release-authority" };
  assert.deepEqual(scheduledAuthorityViolations(person), []);
  assert.deepEqual(scheduledAuthorityViolations({ ...person, gateRun: { ...scheduledRun(), event: "workflow_dispatch", actor: "AquilaXk" } }), []);
  assert.match(scheduledAuthorityViolations({ ...person, gateRun: scheduledRun() }).join(";"), /person roles require workflow_dispatch/u);
});

test("the gate run is read only from the GitHub Actions environment of the refresh workflow on main", () => {
  const env = {
    GITHUB_REPOSITORY: GATE_RUN_REPOSITORY,
    GITHUB_WORKFLOW_REF: `${GATE_RUN_REPOSITORY}/${GATE_RUN_WORKFLOW_PATH}@refs/heads/main`,
    GITHUB_RUN_ID: "37200000001",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_EVENT_NAME: "schedule",
    GITHUB_SHA: headSha,
  };
  assert.deepEqual(gateRunFromEnvironment(env), scheduledRun());
  // #1032: dispatch run은 시작한 행위자(GITHUB_TRIGGERING_ACTOR)를 gateRun에 담는다. 행위자가 없으면 만들지 않는다.
  assert.deepEqual(gateRunFromEnvironment({ ...env, GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_TRIGGERING_ACTOR: SCHEDULER_APP_LOGIN }), dispatchedRun());
  assert.throws(() => gateRunFromEnvironment({ ...env, GITHUB_EVENT_NAME: "workflow_dispatch" }), /SCHEDULED_AUTHORITY_GATE_RUN.*gateRun actor/u);
  assert.deepEqual(gateRunFromEnvironment({ ...env, GITHUB_TRIGGERING_ACTOR: "AquilaXk" }), scheduledRun());
  for (const [key, value] of [
    ["GITHUB_WORKFLOW_REF", `${GATE_RUN_REPOSITORY}/${GATE_RUN_WORKFLOW_PATH}@refs/heads/feature`],
    ["GITHUB_WORKFLOW_REF", `${GATE_RUN_REPOSITORY}/.github/workflows/other.yml@refs/heads/main`],
    ["GITHUB_REPOSITORY", "fork/easysubway-data"],
    ["GITHUB_RUN_ID", "abc"],
    ["GITHUB_SHA", "short"],
  ]) {
    assert.throws(() => gateRunFromEnvironment({ ...env, [key]: value }), /SCHEDULED_AUTHORITY_GATE_RUN/u, `${key}=${value}`);
  }
});

test("the recorded gate run must match the GitHub run record and have succeeded on main", () => {
  const run = {
    id: 37200000001, run_attempt: 1, event: "schedule", head_sha: headSha, head_branch: "main",
    path: `${GATE_RUN_WORKFLOW_PATH}@refs/heads/main`, conclusion: "success", status: "completed",
    repository: { full_name: GATE_RUN_REPOSITORY }, head_repository: { full_name: GATE_RUN_REPOSITORY },
    run_started_at: "2026-10-04T22:23:10Z", updated_at: "2026-10-04T22:41:02Z",
  };
  const candidateClock = "2026-10-04T22:23:31.456Z";
  assert.deepEqual(gateRunRecordViolations({ gateRun: scheduledRun(), run, candidateClock }), []);
  for (const [override, expected] of [
    [{ id: 1 }, /id/u], [{ run_attempt: 2 }, /run_attempt/u], [{ event: "workflow_dispatch" }, /event/u],
    [{ head_sha: "b".repeat(40) }, /head_sha/u], [{ head_branch: "feature" }, /head_branch/u],
    [{ path: ".github/workflows/other.yml@refs/heads/main" }, /path/u], [{ conclusion: "failure" }, /conclusion/u],
    [{ repository: { full_name: "fork/easysubway-data" } }, /repository/u],
  ]) {
    assert.match(gateRunRecordViolations({ gateRun: scheduledRun(), run: { ...run, ...override }, candidateClock }).join(";"), expected, JSON.stringify(override));
  }
});

test("a dispatched gate run must have been started and run by the scheduler App in the GitHub run record (#1032)", () => {
  const run = {
    id: 37200000001, run_attempt: 1, event: "workflow_dispatch", head_sha: headSha, head_branch: "main",
    path: `${GATE_RUN_WORKFLOW_PATH}@refs/heads/main`, conclusion: "success", status: "completed",
    repository: { full_name: GATE_RUN_REPOSITORY }, head_repository: { full_name: GATE_RUN_REPOSITORY },
    run_started_at: "2026-10-04T22:23:10Z", updated_at: "2026-10-04T22:41:02Z",
    actor: { login: SCHEDULER_APP_LOGIN }, triggering_actor: { login: SCHEDULER_APP_LOGIN },
  };
  const candidateClock = "2026-10-04T22:23:31.456Z";
  assert.deepEqual(gateRunRecordViolations({ gateRun: dispatchedRun(), run, candidateClock }), []);
  // 사람이 같은 run을 재실행하면 triggering_actor가 사람이 된다. 행위자를 속인 기록도 거부한다.
  for (const override of [{ triggering_actor: { login: "AquilaXk" } }, { actor: { login: "AquilaXk" } }, { triggering_actor: undefined }, { actor: undefined }]) {
    assert.match(gateRunRecordViolations({ gateRun: dispatchedRun(), run: { ...run, ...override }, candidateClock }).join(";"), /actor/u, JSON.stringify(override));
  }
  assert.match(gateRunRecordViolations({ gateRun: dispatchedRun("AquilaXk"), run, candidateClock }).join(";"), /actor/u);
  // schedule run의 행위자는 cron을 마지막으로 고친 사람이라 대조하지 않는다.
  assert.deepEqual(gateRunRecordViolations({ gateRun: scheduledRun(), run: { ...run, event: "schedule", actor: { login: "AquilaXk" } }, candidateClock }), []);
});

test("#931 F2 an old successful run cannot be replayed for a different candidate", () => {
  const run = {
    id: 37200000001, run_attempt: 1, event: "schedule", head_sha: headSha, head_branch: "main",
    path: `${GATE_RUN_WORKFLOW_PATH}@refs/heads/main`, conclusion: "success",
    repository: { full_name: GATE_RUN_REPOSITORY }, head_repository: { full_name: GATE_RUN_REPOSITORY },
    run_started_at: "2026-10-04T22:23:10Z", updated_at: "2026-10-04T22:41:02Z",
  };
  // 후보 시계(candidate publishedAt)는 그 run이 실행되는 동안 정해진다. 다른 시각의 후보에 같은 run을 붙이면 실패한다.
  for (const candidateClock of ["2026-10-04T22:23:09.999Z", "2026-10-04T22:41:02.001Z", "2026-10-11T22:23:31.000Z", undefined, "not a time"]) {
    assert.match(gateRunRecordViolations({ gateRun: scheduledRun(), run, candidateClock }).join(";"), /candidate clock/u, String(candidateClock));
  }
  assert.deepEqual(gateRunRecordViolations({ gateRun: scheduledRun(), run, candidateClock: "2026-10-04T22:23:10.000Z" }), []);
  assert.deepEqual(gateRunRecordViolations({ gateRun: scheduledRun(), run, candidateClock: "2026-10-04T22:41:02.000Z" }), []);
  for (const head_repository of [{ full_name: "fork/easysubway-data" }, undefined]) {
    assert.match(gateRunRecordViolations({ gateRun: scheduledRun(), run: { ...run, head_repository }, candidateClock: "2026-10-04T22:30:00.000Z" }).join(";"),
      /head_repository/u);
  }
  assert.match(gateRunRecordViolations({ gateRun: scheduledRun(), run: { ...run, run_started_at: undefined }, candidateClock: "2026-10-04T22:30:00.000Z" }).join(";"),
    /run window/u);
});
