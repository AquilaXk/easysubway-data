import assert from "node:assert/strict";
import test from "node:test";

import {
  GATE_RUN_REPOSITORY,
  GATE_RUN_WORKFLOW_PATH,
  SCHEDULED_RELEASE_ROLES,
  SCHEDULED_ROLE_EVENTS,
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

test("scheduled roles are allowed only for the schedule event and only as the exact pair", () => {
  const { requestedBy, approvedBy } = SCHEDULED_RELEASE_ROLES;
  assert.deepEqual(SCHEDULED_ROLE_EVENTS, ["schedule"]);
  assert.deepEqual(releaseRoleEventViolations({ requestedBy, approvedBy, event: "schedule" }), []);
  // #931 리뷰 F3: 후보 갱신 workflow에는 workflow_run 트리거가 없다. 만드는 쪽이 없는 이벤트는 받지 않는다.
  for (const event of ["workflow_run", "workflow_dispatch", "push", "pull_request", undefined]) {
    assert.match(releaseRoleEventViolations({ requestedBy, approvedBy, event }).join(";"), /only for the schedule event/u, String(event));
  }
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

test("a scheduled release request must bind the exact gate run that produced it", () => {
  assert.deepEqual(scheduledAuthorityViolations(request()), []);
  assert.match(scheduledAuthorityViolations(request({ gateRun: undefined })).join(";"), /gateRun is required/u);
  const tampered = [
    [{ workflowPath: ".github/workflows/datapack-release.yml" }, /workflowPath/u],
    [{ repository: "someone/else" }, /repository/u],
    [{ runId: "37200000001" }, /runId/u],
    [{ runAttempt: 0 }, /runAttempt/u],
    [{ event: "workflow_dispatch" }, /only for the schedule event/u],
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
  assert.deepEqual(scheduledAuthorityViolations({ ...person, gateRun: { ...scheduledRun(), event: "workflow_dispatch" } }), []);
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
    repository: { full_name: GATE_RUN_REPOSITORY },
  };
  assert.deepEqual(gateRunRecordViolations({ gateRun: scheduledRun(), run }), []);
  for (const [override, expected] of [
    [{ id: 1 }, /id/u], [{ run_attempt: 2 }, /run_attempt/u], [{ event: "workflow_dispatch" }, /event/u],
    [{ head_sha: "b".repeat(40) }, /head_sha/u], [{ head_branch: "feature" }, /head_branch/u],
    [{ path: ".github/workflows/other.yml@refs/heads/main" }, /path/u], [{ conclusion: "failure" }, /conclusion/u],
    [{ repository: { full_name: "fork/easysubway-data" } }, /repository/u],
  ]) {
    assert.match(gateRunRecordViolations({ gateRun: scheduledRun(), run: { ...run, ...override } }).join(";"), expected, JSON.stringify(override));
  }
});
