// 정기 실행 전용 2인 역할(#929 D3, QA 결정 2026-10-04 D3(A)).
//
// 사람 역할(예 data-operator-lead / data-release-authority)은 사람이 workflow_dispatch로 넘기는 값이다.
// 정기 실행은 사람 승인 없이 후보를 만들므로, 그 사실을 숨기지 않는 고정 라벨 두 개를 쓴다.
// - requestedBy: datapack-scheduled-refresh  (요청 주체 = 정기 후보 갱신 workflow)
// - approvedBy:  datapack-release-gates      (승인 근거 = 그 run이 통과한 게이트들)
// 이 라벨은 schedule·체인(workflow_run) 이벤트에서만 쓸 수 있고, release request에는 그 후보를 만든 run(gateRun)을
// 반드시 결속한다. RC chain은 GitHub run 기록과 gateRun을 대조한 뒤에만 RC를 dispatch한다.
export const SCHEDULED_RELEASE_ROLES = Object.freeze({
  requestedBy: "datapack-scheduled-refresh",
  approvedBy: "datapack-release-gates",
});
export const SCHEDULED_ROLE_EVENTS = Object.freeze(["schedule", "workflow_run"]);
export const PERSON_ROLE_EVENT = "workflow_dispatch";
export const GATE_RUN_REPOSITORY = "AquilaXk/easysubway-data";
export const GATE_RUN_WORKFLOW_PATH = ".github/workflows/nationwide-candidate-refresh.yml";

const GATE_RUN_KEYS = Object.freeze(["repository", "workflowPath", "runId", "runAttempt", "event", "headSha"]);
const RESERVED = new Set(Object.values(SCHEDULED_RELEASE_ROLES));
const lower = (value) => (typeof value === "string" ? value.trim().toLowerCase() : value);
const isReserved = (value) => RESERVED.has(lower(value));
const positiveInteger = (value) => Number.isSafeInteger(value) && value > 0;

function isExactScheduledPair({ requestedBy, approvedBy }) {
  return requestedBy === SCHEDULED_RELEASE_ROLES.requestedBy && approvedBy === SCHEDULED_RELEASE_ROLES.approvedBy;
}

export function releaseRoleEventViolations({ requestedBy, approvedBy, event }) {
  const scheduled = isExactScheduledPair({ requestedBy, approvedBy });
  if (!scheduled && (isReserved(requestedBy) || isReserved(approvedBy))) {
    return ["scheduled roles must be used as the exact pair (requestedBy datapack-scheduled-refresh, approvedBy datapack-release-gates)"];
  }
  if (scheduled) {
    return SCHEDULED_ROLE_EVENTS.includes(event)
      ? []
      : [`scheduled roles are allowed only for schedule or chain events (event: ${String(event)})`];
  }
  // 사람 역할: 로컬 실행(event 없음)과 사람 dispatch만 받는다.
  return event === undefined || event === null || event === PERSON_ROLE_EVENT
    ? []
    : [`person roles require workflow_dispatch (event: ${String(event)})`];
}

export function gateRunViolations(gateRun) {
  if (!gateRun || typeof gateRun !== "object" || Array.isArray(gateRun)) return ["gateRun must be an object"];
  const violations = [];
  const keys = Object.keys(gateRun);
  if (keys.length !== GATE_RUN_KEYS.length || !GATE_RUN_KEYS.every((key) => keys.includes(key))) {
    violations.push(`gateRun keys must be ${GATE_RUN_KEYS.join(",")}`);
  }
  if (gateRun.repository !== GATE_RUN_REPOSITORY) violations.push(`gateRun repository must be ${GATE_RUN_REPOSITORY}`);
  if (gateRun.workflowPath !== GATE_RUN_WORKFLOW_PATH) violations.push(`gateRun workflowPath must be ${GATE_RUN_WORKFLOW_PATH}`);
  if (!positiveInteger(gateRun.runId)) violations.push("gateRun runId must be a positive integer");
  if (!positiveInteger(gateRun.runAttempt)) violations.push("gateRun runAttempt must be a positive integer");
  if (typeof gateRun.event !== "string" || gateRun.event === "") violations.push("gateRun event is required");
  if (!/^[a-f0-9]{40}$/u.test(gateRun.headSha ?? "")) violations.push("gateRun headSha must be a 40-hex commit");
  return violations;
}

// release request 결속 규칙. 정기 역할이면 gateRun이 필수이고 그 event가 정기·체인 이벤트여야 한다.
// 사람 역할이면 gateRun은 없어도 되지만, 있으면 workflow_dispatch run이어야 한다.
export function scheduledAuthorityViolations(releaseRequest) {
  const { requestedBy, approvedBy, gateRun } = releaseRequest ?? {};
  const scheduled = isExactScheduledPair({ requestedBy, approvedBy });
  if (scheduled && gateRun === undefined) return ["gateRun is required for scheduled roles"];
  const violations = gateRun === undefined ? [] : gateRunViolations(gateRun);
  violations.push(...releaseRoleEventViolations({ requestedBy, approvedBy, event: gateRun?.event }));
  return violations;
}

function fail(detail) {
  throw new Error(`SCHEDULED_AUTHORITY_GATE_RUN: ${detail}`);
}

// 후보 갱신 workflow run 안에서만 gateRun을 만든다. 값은 GitHub Actions가 넣는 기본 환경 변수만 쓴다.
export function gateRunFromEnvironment(env = process.env) {
  if (env.GITHUB_REPOSITORY !== GATE_RUN_REPOSITORY) fail("repository");
  if (env.GITHUB_WORKFLOW_REF !== `${GATE_RUN_REPOSITORY}/${GATE_RUN_WORKFLOW_PATH}@refs/heads/main`) fail("workflow ref");
  const runId = /^[1-9]\d*$/u.test(env.GITHUB_RUN_ID ?? "") ? Number(env.GITHUB_RUN_ID) : Number.NaN;
  const runAttempt = /^[1-9]\d*$/u.test(env.GITHUB_RUN_ATTEMPT ?? "") ? Number(env.GITHUB_RUN_ATTEMPT) : Number.NaN;
  const gateRun = {
    repository: env.GITHUB_REPOSITORY,
    workflowPath: GATE_RUN_WORKFLOW_PATH,
    runId,
    runAttempt,
    event: env.GITHUB_EVENT_NAME,
    headSha: env.GITHUB_SHA,
  };
  const violations = gateRunViolations(gateRun);
  if (violations.length > 0) fail(violations.join("; "));
  return gateRun;
}

// GitHub run 기록(GET /repos/{repo}/actions/runs/{id})과 gateRun을 대조한다. main에서 성공한 그 run이어야 한다.
export function gateRunRecordViolations({ gateRun, run }) {
  const violations = [];
  const expect = (label, actual, expected) => {
    if (actual !== expected) violations.push(`gate run ${label} mismatch (record: ${String(actual)}, request: ${String(expected)})`);
  };
  expect("id", run?.id, gateRun?.runId);
  expect("run_attempt", run?.run_attempt, gateRun?.runAttempt);
  expect("event", run?.event, gateRun?.event);
  expect("head_sha", run?.head_sha, gateRun?.headSha);
  expect("head_branch", run?.head_branch, "main");
  expect("path", typeof run?.path === "string" ? run.path.split("@")[0] : run?.path, gateRun?.workflowPath);
  expect("repository", run?.repository?.full_name, gateRun?.repository);
  expect("conclusion", run?.conclusion, "success");
  return violations;
}
