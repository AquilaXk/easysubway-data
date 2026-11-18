import assert from "node:assert/strict";
import test from "node:test";

import {
  assertRetainedGwangjuRecoveryPullRequestAbsent,
  classifyRetainedGwangjuRefreshDelivery,
  validateRetainedGwangjuRefreshOutputPaths,
} from "./retained-gwangju-refresh-delivery.mjs";

const repository = "AquilaXk/easysubway-data";
const branch = "automation/504-retained-gwangju-timetable-refresh-123";
const claim = { sha: "a".repeat(40), branch };
const otherBranch = "automation/504-retained-gwangju-timetable-refresh-124";
const CLAIM_SUBJECT = "Claim retained Gwangju timetable refresh";
const OUTPUT_SUBJECT = "Refresh retained Gwangju timetable";
let nextPullRequestNumber = 1;
const pullRequest = (state, name = branch, overrides = {}) => ({
  number: nextPullRequestNumber++, state, isDraft: state !== "MERGED", headRefName: name, baseRefName: "main",
  headRepository: { nameWithOwner: repository }, isCrossRepository: false, ...overrides,
});
// 만든 run이 끝났고(기본) 빈 claim뿐인 고아(#995). 기본값이 504 사례다.
const NOT_PUBLISHED = [{ name: "Publish and register retained Gwangju timetable", status: "completed", conclusion: "skipped" }];
const evidence = (name = branch, overrides = {}) => ({
  branch: name, runId: name.slice(name.lastIndexOf("-") + 1),
  run: { found: true, status: "completed", conclusion: "failure", workflowName: "Retained Gwangju Timetable Refresh", headBranch: "main", steps: NOT_PUBLISHED },
  commits: { aheadBy: 1, subjects: [CLAIM_SUBJECT], changedFiles: 0 }, artifacts: [], ...overrides,
});
const withOutput = (name = branch) => evidence(name, { commits: { aheadBy: 2, subjects: [CLAIM_SUBJECT, OUTPUT_SUBJECT], changedFiles: 2 } });
const running = (name = branch) => evidence(name, { run: { found: true, status: "in_progress", conclusion: null, workflowName: "Retained Gwangju Timetable Refresh", headBranch: "main", steps: NOT_PUBLISHED } });
const classify = (input) => classifyRetainedGwangjuRefreshDelivery({ repository, claims: [], pullRequests: [], claimEvidence: [], ...input });

test("retained Gwangju recovery ignores fork PRs with the claim name but rejects same-repository PRs", () => {
  assert.doesNotThrow(() => assertRetainedGwangjuRecoveryPullRequestAbsent({
    repository, branch, pullRequests: [pullRequest("OPEN", branch, { headRepository: { nameWithOwner: "fork/easysubway-data" }, isCrossRepository: true })],
  }));
  assert.throws(() => assertRetainedGwangjuRecoveryPullRequestAbsent({
    repository, branch, pullRequests: [pullRequest("CLOSED")],
  }), /already has a pull request/);
});

test("retained Gwangju delivery ignores cross-repository PR records and recovers one exact unassociated claim that carries output", () => {
  assert.deepEqual(classify({
    decision: { state: "DUE" }, claims: [claim], claimEvidence: [withOutput()],
    pullRequests: [pullRequest("OPEN", branch, { headRepository: { nameWithOwner: "fork/easysubway-data" }, isCrossRepository: true })],
  }), { state: "RECOVER_CLAIM", branch, cleanupClaims: [] });
});

// #995: 504 사례. CURRENT면 claim을 보지 않고 돌아와 고아가 영원히 남았다. DUE·CURRENT와 무관하게 claim을 판정한다.
test("a recoverable claim is recovered whether the source is DUE or CURRENT", () => {
  for (const state of ["DUE", "CURRENT"]) {
    assert.deepEqual(classify({ decision: { state }, claims: [claim], claimEvidence: [withOutput()] }), { state: "RECOVER_CLAIM", branch, cleanupClaims: [] }, state);
  }
});

test("an empty claim whose producer run finished is handed to cleanup, then the normal due state continues", () => {
  assert.deepEqual(classify({ decision: { state: "CURRENT" }, claims: [claim], claimEvidence: [evidence()] }), { state: "CURRENT", cleanupClaims: [branch] });
  assert.deepEqual(classify({ decision: { state: "DUE" }, claims: [claim], claimEvidence: [evidence()] }), { state: "DUE", cleanupClaims: [branch] });
  // run 기록이 사라졌으면(Not Found) 게시 step까지 갔는지 알 수 없어 빈 claim도 지우지 않고 실패한다(#995 F1).
  assert.throws(() => classify({ decision: { state: "CURRENT" }, claims: [claim], claimEvidence: [evidence(branch, { run: { found: false } })] }), /CLAIM_ORPHAN_RUN_UNAVAILABLE/);
  // 게시 step이 시작된 run의 빈 claim은 지우지 않고 실패한다.
  const published = { found: true, status: "completed", conclusion: "failure", workflowName: "Retained Gwangju Timetable Refresh", headBranch: "main", steps: [{ name: "Publish and register retained Gwangju timetable", status: "completed", conclusion: "failure" }] };
  assert.throws(() => classify({ decision: { state: "CURRENT" }, claims: [claim], claimEvidence: [evidence(branch, { run: published })] }), /CLAIM_ORPHAN_PUBLISHED_UNREGISTERED/);
});

test("a claim whose producer run is still running waits, DUE or CURRENT", () => {
  for (const state of ["DUE", "CURRENT"]) {
    assert.deepEqual(classify({ decision: { state }, claims: [claim], claimEvidence: [running()] }), { state: "CLAIM_IN_PROGRESS", branch, cleanupClaims: [] }, state);
  }
});

test("an abandoned claim is cleaned while another claim is recovered or still running", () => {
  const claims = [claim, { ...claim, branch: otherBranch }];
  assert.deepEqual(classify({ decision: { state: "CURRENT" }, claims, claimEvidence: [evidence(), withOutput(otherBranch)] }), { state: "RECOVER_CLAIM", branch: otherBranch, cleanupClaims: [branch] });
  assert.deepEqual(classify({ decision: { state: "DUE" }, claims, claimEvidence: [evidence(), running(otherBranch)] }), { state: "CLAIM_IN_PROGRESS", branch: otherBranch, cleanupClaims: [branch] });
});

test("a claim without evidence is not guessed", () => {
  assert.throws(() => classify({ decision: { state: "CURRENT" }, claims: [claim], claimEvidence: [] }), /CLAIM_ORPHAN_EVIDENCE_MISSING/);
  assert.throws(() => classify({ decision: { state: "DUE" }, claims: [claim] , claimEvidence: undefined }), /delivery input is invalid/);
});

test("retained Gwangju delivery rejects duplicate live and closed claims while preserving merged leftovers", () => {
  assert.throws(() => classify({
    decision: { state: "DUE" }, claims: [claim, { ...claim, branch: otherBranch }], claimEvidence: [withOutput(), withOutput(otherBranch)],
  }), /multiple live claims/);
  assert.throws(() => classify({ decision: { state: "DUE" }, claims: [claim], pullRequests: [pullRequest("CLOSED")] }), /closed live claim/);
  assert.throws(() => classify({ decision: { state: "CURRENT" }, claims: [claim], pullRequests: [pullRequest("CLOSED")] }), /closed live claim/);
  assert.deepEqual(classify({ decision: { state: "DUE" }, claims: [claim], pullRequests: [pullRequest("MERGED")] }), { state: "DUE", cleanupClaims: [] });
  assert.deepEqual(classify({ decision: { state: "DUE" }, pullRequests: [pullRequest("OPEN")] }), { state: "OPEN_PR", branch, cleanupClaims: [] });
});

test("an open pull request is handled whether the source is DUE or CURRENT, and a second live claim is an anomaly", () => {
  for (const state of ["DUE", "CURRENT"]) {
    assert.deepEqual(classify({ decision: { state }, claims: [claim], pullRequests: [pullRequest("OPEN")] }), { state: "OPEN_PR", branch, cleanupClaims: [] }, state);
  }
  assert.throws(() => classify({
    decision: { state: "DUE" }, claims: [claim, { ...claim, branch: otherBranch }], pullRequests: [pullRequest("OPEN")], claimEvidence: [withOutput(otherBranch)],
  }), /multiple live claims/);
  assert.deepEqual(classify({
    decision: { state: "DUE" }, claims: [claim, { ...claim, branch: otherBranch }], pullRequests: [pullRequest("OPEN")], claimEvidence: [evidence(otherBranch)],
  }), { state: "OPEN_PR", branch, cleanupClaims: [otherBranch] });
  assert.throws(() => classify({
    decision: { state: "DUE" }, pullRequests: [pullRequest("OPEN"), pullRequest("OPEN", otherBranch)],
  }), /multiple open PRs/);
});

test("an invalid decision is not interpreted", () => {
  assert.throws(() => classify({ decision: { state: "EXPIRED" } }), /due decision is invalid/);
  assert.throws(() => classify({ decision: undefined }), /due decision is invalid/);
});

test("retained Gwangju delivery accepts exactly the two registration outputs", () => {
  assert.doesNotThrow(() => validateRetainedGwangjuRefreshOutputPaths({
    changedPaths: ["tools/datapack/source-inventory.json", "tools/datapack/release/source-snapshots.json"], deletedPaths: [],
  }));
  assert.throws(() => validateRetainedGwangjuRefreshOutputPaths({
    changedPaths: ["tools/datapack/source-inventory.json"], deletedPaths: [],
  }), /exactly/);
  assert.throws(() => validateRetainedGwangjuRefreshOutputPaths({
    changedPaths: ["tools/datapack/source-inventory.json", "tools/datapack/release/source-snapshots.json", "unexpected"], deletedPaths: [],
  }), /exactly two paths/);
  assert.throws(() => validateRetainedGwangjuRefreshOutputPaths({
    changedPaths: ["tools/datapack/source-inventory.json", "unexpected"], deletedPaths: [],
  }), /unsupported/);
  assert.throws(() => validateRetainedGwangjuRefreshOutputPaths({
    changedPaths: ["tools/datapack/source-inventory.json", "tools/datapack/release/source-snapshots.json"], deletedPaths: ["tools/datapack/source-inventory.json"],
  }), /deletion/);
});
