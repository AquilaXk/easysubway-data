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

test("retained Gwangju recovery ignores fork PRs with the claim name but rejects same-repository PRs", () => {
  assert.doesNotThrow(() => assertRetainedGwangjuRecoveryPullRequestAbsent({
    repository, branch, pullRequests: [{
      state: "OPEN", isDraft: true, headRefName: branch, baseRefName: "main",
      headRepository: { nameWithOwner: "fork/easysubway-data" }, isCrossRepository: true,
    }],
  }));
  assert.throws(() => assertRetainedGwangjuRecoveryPullRequestAbsent({
    repository, branch, pullRequests: [{
      state: "CLOSED", isDraft: true, headRefName: branch, baseRefName: "main",
      headRepository: { nameWithOwner: repository }, isCrossRepository: false,
    }],
  }), /already has a pull request/);
});

test("retained Gwangju delivery ignores cross-repository PR records and recovers one exact unassociated claim", () => {
  assert.deepEqual(classifyRetainedGwangjuRefreshDelivery({
    decision: { state: "DUE" }, repository, claims: [claim], pullRequests: [{
      state: "OPEN", isDraft: true, headRefName: branch, baseRefName: "main",
      headRepository: { nameWithOwner: "fork/easysubway-data" }, isCrossRepository: true,
    }],
  }), { state: "RECOVER_CLAIM", branch });
  assert.deepEqual(classifyRetainedGwangjuRefreshDelivery({
    decision: { state: "CURRENT" }, repository, claims: [claim], pullRequests: [],
  }), { state: "CURRENT" });
});

test("retained Gwangju delivery rejects duplicate and closed claims while preserving merged leftovers", () => {
  assert.throws(() => classifyRetainedGwangjuRefreshDelivery({
    decision: { state: "DUE" }, repository, claims: [claim, { ...claim, branch: "automation/504-retained-gwangju-timetable-refresh-124" }], pullRequests: [],
  }), /multiple live claims/);
  assert.throws(() => classifyRetainedGwangjuRefreshDelivery({
    decision: { state: "DUE" }, repository, claims: [claim], pullRequests: [{
      state: "CLOSED", isDraft: true, headRefName: branch, baseRefName: "main",
      headRepository: { nameWithOwner: repository }, isCrossRepository: false,
    }],
  }), /closed live claim/);
  assert.deepEqual(classifyRetainedGwangjuRefreshDelivery({
    decision: { state: "DUE" }, repository, claims: [claim], pullRequests: [{
      state: "MERGED", isDraft: false, headRefName: branch, baseRefName: "main",
      headRepository: { nameWithOwner: repository }, isCrossRepository: false,
    }],
  }), { state: "DUE" });
  assert.deepEqual(classifyRetainedGwangjuRefreshDelivery({
    decision: { state: "DUE" }, repository, claims: [], pullRequests: [{
      state: "OPEN", isDraft: true, headRefName: branch, baseRefName: "main",
      headRepository: { nameWithOwner: repository }, isCrossRepository: false,
    }],
  }), { state: "OPEN_PR", branch });
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
