import assert from "node:assert/strict";
import test from "node:test";

import {
  REGISTRATION_CLAIM_PREFIX,
  decideCapitalTopologyRegistration,
  parseRegistrationClaims,
} from "./decide-capital-topology-registration.mjs";

// #969 P3: 수도권 topology 갱신 PR이 병합되면 보호 admission이 main에 들어온다. 그 snapshot이 원장에 없으면 등록이 필요하다.
// 판정은 파일 두 개(inventory의 admission, 원장)와 PR·claim·producer run 기록만 읽고, 아무것도 쓰지 않는다.
const REPOSITORY = "AquilaXk/easysubway-data";
const MAIN = "a".repeat(40);
const NOW = new Date("2026-10-06T03:00:00.000Z");
const SNAPSHOT = "capital-route-topology-20261006";
const PREVIOUS = "capital-route-topology-20261004";
const WORKFLOW_NAME = "Current Capital Topology Registration";

const inventory = ({ snapshotId = SNAPSHOT, freshUntil = "2026-10-13T00:30:00.000Z" } = {}) => ({
  sources: [
    { id: "capital-route-topology" },
    { id: "seoul-metro-route-map-positions", routeMapAdmissionEvidence: { currentTopologyAdmission: { status: "ADMITTED", topologySnapshotId: snapshotId, freshUntil } } },
  ],
});
const row = (snapshotId, sourceId = "capital-route-topology") => ({ sourceId, snapshotId });
const claim = (runId) => ({ sha: "b".repeat(40), branch: `${REGISTRATION_CLAIM_PREFIX}${runId}` });
const pr = (state, runId, overrides = {}) => ({
  number: 970, state, isDraft: true, headRefName: `${REGISTRATION_CLAIM_PREFIX}${runId}`, baseRefName: "main",
  isCrossRepository: false, headRepository: { nameWithOwner: REPOSITORY }, ...overrides,
});
const run = (id, overrides = {}) => ({
  databaseId: id, status: "completed", conclusion: "failure", workflowName: WORKFLOW_NAME, headBranch: "main", headSha: MAIN, ...overrides,
});
const base = {
  inventory: inventory(), ledger: [row(PREVIOUS)], pullRequests: [], claims: [], runs: [], repository: REPOSITORY, currentMainSha: MAIN, now: NOW,
  limits: { pullRequests: 1000, runs: 200 },
};
const decide = (overrides = {}) => decideCapitalTopologyRegistration({ ...base, ...overrides });

test("claim 접두어는 기존 등록 workflow의 브랜치 이름과 같다", () => {
  assert.equal(REGISTRATION_CLAIM_PREFIX, "automation/456-capital-topology-registration-");
});

test("보호 admission의 topology snapshot이 원장 head에 이미 있으면 REGISTERED이고 PR·claim은 보지 않는다", () => {
  assert.deepEqual(decide({ ledger: [row(PREVIOUS), row(SNAPSHOT)], pullRequests: [pr("OPEN", 1)], claims: [claim(1), claim(2)] }), { state: "REGISTERED", snapshotId: SNAPSHOT });
});

test("원장에 없고 열린 PR·claim·다른 자동화 PR이 없으면 REGISTER다", () => {
  assert.deepEqual(decide(), { state: "REGISTER", snapshotId: SNAPSHOT });
  // 병합된 이전 등록 PR의 claim은 살아 있는 claim이 아니다.
  assert.deepEqual(decide({ pullRequests: [pr("MERGED", 1)], claims: [claim(1)] }), { state: "REGISTER", snapshotId: SNAPSHOT });
});

test("이 workflow의 열린 PR이 있으면 OPEN_PR이다", () => {
  assert.deepEqual(decide({ pullRequests: [pr("OPEN", 1)], claims: [claim(1)] }), { state: "OPEN_PR", snapshotId: SNAPSHOT, branch: `${REGISTRATION_CLAIM_PREFIX}1` });
});

test("원장을 쓰는 다른 자동화 PR이 열려 있으면 BLOCKED_BY_PENDING_PR로 기다린다(이상이 아니다)", () => {
  const other = (prefix, number) => pr("OPEN", 9, { number, headRefName: `${prefix}9` });
  assert.deepEqual(decide({ pullRequests: [other("automation/639-seoul-accessibility-refresh-", 971)] }), {
    state: "BLOCKED_BY_PENDING_PR", snapshotId: SNAPSHOT, blockedBy: [971],
  });
  assert.deepEqual(decide({ pullRequests: [other("automation/636-current-topology-refresh-", 965), other("automation/504-retained-gwangju-timetable-refresh-", 972)] }).blockedBy, [965, 972]);
  // 후보 PR은 원장을 쓰지 않는다. 사람 PR·다른 저장소 PR도 직렬화 대상이 아니다.
  assert.equal(decide({ pullRequests: [other("automation/927-nationwide-candidate-refresh-", 973), pr("OPEN", 9, { number: 974, headRefName: "feat/x" })] }).state, "REGISTER");
  assert.equal(decide({ pullRequests: [{ ...other("automation/639-seoul-accessibility-refresh-", 975), isCrossRepository: true }] }).state, "REGISTER");
  // 닫히거나 병합된 다른 PR은 기다릴 이유가 아니다.
  assert.equal(decide({ pullRequests: [{ ...other("automation/639-seoul-accessibility-refresh-", 976), state: "MERGED" }] }).state, "REGISTER");
});

test("PR 없는 claim은 producer run이 같은 main에서 실패한 경우에만 RECOVER_CLAIM이다", () => {
  assert.deepEqual(decide({ claims: [claim(123)], runs: [run(123)] }), { state: "RECOVER_CLAIM", snapshotId: SNAPSHOT, branch: `${REGISTRATION_CLAIM_PREFIX}123`, recoveryRunId: "123" });
  // 복구도 새 원장 PR을 여는 일이라 다른 원장 쓰기 PR이 열려 있으면 기다린다.
  assert.equal(decide({ claims: [claim(123)], runs: [run(123)], pullRequests: [pr("OPEN", 9, { number: 971, headRefName: "automation/639-seoul-accessibility-refresh-9" })] }).state, "BLOCKED_BY_PENDING_PR");
});

test("복구할 수 없는 claim은 이상이다: producer run 없음·실패 아님·다른 workflow·main 이동", () => {
  const reject = (overrides, pattern) => assert.throws(() => decide(overrides), pattern);
  reject({ claims: [claim(123)], runs: [] }, /REGISTRATION_CLAIM_UNRECOVERABLE: .*producer run 123 was not found/u);
  reject({ claims: [claim(123)], runs: [run(123, { conclusion: "success" })] }, /REGISTRATION_CLAIM_UNRECOVERABLE: .*did not fail/u);
  reject({ claims: [claim(123)], runs: [run(123, { status: "in_progress", conclusion: "" })] }, /REGISTRATION_CLAIM_UNRECOVERABLE: .*did not fail/u);
  reject({ claims: [claim(123)], runs: [run(123, { workflowName: "Other" })] }, /REGISTRATION_CLAIM_UNRECOVERABLE: .*workflow/u);
  reject({ claims: [claim(123)], runs: [run(123, { headBranch: "feature" })] }, /REGISTRATION_CLAIM_UNRECOVERABLE: .*main/u);
  reject({ claims: [claim(123)], runs: [run(123, { headSha: "c".repeat(40) })] }, /REGISTRATION_CLAIM_UNRECOVERABLE: .*main moved/u);
});

test("claim이 둘 이상이거나 닫힌 PR에 묶였거나 PR이 중복이면 이상이다", () => {
  assert.throws(() => decide({ claims: [claim(1), claim(2)], runs: [run(1), run(2)] }), /REGISTRATION_CLAIM_DUPLICATE/u);
  assert.throws(() => decide({ claims: [claim(1)], pullRequests: [pr("CLOSED", 1)], runs: [run(1)] }), /REGISTRATION_CLAIM_CLOSED/u);
  assert.throws(() => decide({ pullRequests: [pr("OPEN", 1), pr("OPEN", 1, { number: 971 })] }), /REGISTRATION_PR_DUPLICATE/u);
  // 열린 PR이 있는데 claim 브랜치가 없으면 판정 근거가 어긋난 것이다.
  assert.throws(() => decide({ pullRequests: [pr("OPEN", 1)], claims: [] }), /REGISTRATION_CLAIM_MISSING/u);
});

test("admission이 없거나, 원장에 있으나 head가 아니거나, 만료됐는데 등록되지 않았으면 이상이다", () => {
  assert.throws(() => decide({ inventory: { sources: [{ id: "seoul-metro-route-map-positions" }] } }), /REGISTRATION_ADMISSION_MISSING/u);
  assert.throws(() => decide({ inventory: inventory({ snapshotId: "capital-route-topology-bad" }) }), /REGISTRATION_ADMISSION_MISSING/u);
  assert.throws(() => decide({ ledger: [row(SNAPSHOT), row("capital-route-topology-20261007")] }), /REGISTRATION_ADMISSION_NOT_HEAD/u);
  assert.throws(() => decide({ inventory: inventory({ freshUntil: "2026-10-06T03:00:00.000Z" }) }), /REGISTRATION_ADMISSION_EXPIRED/u);
  assert.throws(() => decide({ inventory: inventory({ freshUntil: "2026-10-13" }) }), /REGISTRATION_ADMISSION_MISSING/u);
  // 이미 등록됐다면 만료돼도 등록 판정은 할 일이 없다. 만료 경보는 다른 workflow의 일이다.
  assert.equal(decide({ inventory: inventory({ freshUntil: "2026-10-05T00:00:00.000Z" }), ledger: [row(SNAPSHOT)] }).state, "REGISTERED");
});

test("claim 목록은 등록 claim 브랜치 ref만 받고 형식이 어긋나면 실패한다", () => {
  const sha = "d".repeat(40);
  assert.deepEqual(parseRegistrationClaims(""), []);
  assert.deepEqual(parseRegistrationClaims(`${sha}\trefs/heads/${REGISTRATION_CLAIM_PREFIX}77\n`), [{ sha, branch: `${REGISTRATION_CLAIM_PREFIX}77` }]);
  assert.throws(() => parseRegistrationClaims(`${sha}\trefs/heads/automation/other-1\n`), /REGISTRATION_CLAIM_INVALID/u);
  assert.throws(() => parseRegistrationClaims(`${sha}\trefs/heads/${REGISTRATION_CLAIM_PREFIX}x\n`), /REGISTRATION_CLAIM_INVALID/u);
  assert.throws(() => parseRegistrationClaims(`${sha}\trefs/heads/${REGISTRATION_CLAIM_PREFIX}1\n${sha}\trefs/heads/${REGISTRATION_CLAIM_PREFIX}1\n`), /REGISTRATION_CLAIM_INVALID/u);
});

test("입력이 잘못되면 판정하지 않고 실패한다", () => {
  assert.throws(() => decide({ currentMainSha: "x" }), /REGISTRATION_INPUT_INVALID/u);
  assert.throws(() => decide({ ledger: {} }), /REGISTRATION_INPUT_INVALID/u);
  assert.throws(() => decide({ pullRequests: null }), /REGISTRATION_INPUT_INVALID/u);
  assert.throws(() => decide({ now: new Date("x") }), /REGISTRATION_INPUT_INVALID/u);
});

// #972 리뷰 F3: 목록 조회에는 개수 상한이 있다. 반환 개수가 상한과 같으면 잘렸을 수 있으므로 판정하지 않고 실패한다.
test("PR·run 목록이 조회 상한과 같은 개수면 잘린 것으로 보고 실패한다", () => {
  const limits = { pullRequests: 3, runs: 2 };
  const filler = (count, make) => Array.from({ length: count }, (_, index) => make(index));
  const other = (index) => ({ number: 1000 + index, state: "MERGED", isDraft: false, headRefName: `feat/x${index}`, baseRefName: "main", isCrossRepository: false, headRepository: { nameWithOwner: REPOSITORY } });
  assert.throws(() => decide({ limits, pullRequests: filler(3, other) }), /REGISTRATION_LIST_TRUNCATED: pull request list reached its limit 3/u);
  assert.throws(() => decide({ limits, runs: filler(2, (index) => run(900 + index, { conclusion: "success" })) }), /REGISTRATION_LIST_TRUNCATED: run list reached its limit 2/u);
  assert.equal(decide({ limits, pullRequests: filler(2, other), runs: filler(1, (index) => run(900 + index, { conclusion: "success" })) }).state, "REGISTER");
  // 등록된 snapshot이면 목록을 보지 않으므로 잘림과 무관하다.
  assert.equal(decide({ limits, ledger: [row(PREVIOUS), row(SNAPSHOT)], pullRequests: filler(3, other) }).state, "REGISTERED");
  assert.throws(() => decide({ limits: { pullRequests: 0, runs: 2 } }), /REGISTRATION_INPUT_INVALID/u);
  assert.throws(() => decide({ limits: undefined }), /REGISTRATION_INPUT_INVALID/u);
});
