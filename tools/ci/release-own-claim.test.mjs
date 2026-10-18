import assert from "node:assert/strict";
import test from "node:test";

import { CLAIM_OWNERS } from "./claim-orphans.mjs";
import { main, releaseOwnClaim } from "./release-own-claim.mjs";

// #1326: 실패한 run이 자기 claim을 같은 run에서 해제하는 공통 진입점. workflow마다 ls-remote와 도구 호출을 복붙하지 않는다.
// 삭제 규칙(빈 claim·PR 없음·sha 일치·게시 step 증거·보고 먼저)은 remove-orphan-claims가 정하고, 여기서는 원격 sha를 읽어 넘기는 일만 한다.
const REPOSITORY = "AquilaXk/easysubway-data";
const SEOUL = "seoul-current-accessibility-refresh.yml";
const RUN_ID = "39083041685";
const BRANCH = `${CLAIM_OWNERS[SEOUL].prefix}${RUN_ID}`;
const SHA = "b".repeat(40);

function harness({ remote = `${SHA}\trefs/heads/${BRANCH}\n` } = {}) {
  const calls = { git: [], removed: [], order: [] };
  const runGit = async (args) => { calls.git.push(args); calls.order.push("git"); return remote; };
  const runGh = async (args) => { assert.deepEqual(args, ["auth", "setup-git"]); calls.order.push("auth"); return ""; };
  const removeClaims = async (input) => { calls.removed.push(input); return [{ branch: input.claims[0], action: "removed_orphan", reported: "skip" }]; };
  const logs = [];
  return { calls, runGit, runGh, removeClaims, logs, log: (line) => logs.push(line) };
}
const input = (h, overrides = {}) => ({
  workflowFile: SEOUL, repository: REPOSITORY, runId: RUN_ID, branch: BRANCH, claimSha: SHA, publicationOutcome: "skipped", runGit: h.runGit, removeClaims: h.removeClaims, log: h.log, ...overrides,
});

test("자기 claim의 원격 sha를 읽어 자기 run 모드로 도구에 넘긴다", async () => {
  const h = harness();
  const result = await releaseOwnClaim(input(h));
  assert.deepEqual(h.calls.git, [["ls-remote", "origin", `refs/heads/${BRANCH}`]]);
  assert.equal(h.calls.removed.length, 1);
  const [call] = h.calls.removed;
  assert.equal(call.workflowFile, SEOUL);
  assert.equal(call.repository, REPOSITORY);
  assert.deepEqual(call.claims, [BRANCH]);
  assert.equal(call.refsText, `${SHA}\trefs/heads/${BRANCH}\n`);
  assert.equal(call.selfRunId, RUN_ID);
  assert.equal(call.expectedSha, SHA);
  assert.equal(call.publicationOutcome, "skipped");
  assert.deepEqual(result, [{ branch: BRANCH, action: "removed_orphan", reported: "skip" }]);
});

test("이미 사라진 claim은 지울 것이 없다(도구를 부르지 않는다)", async () => {
  const h = harness({ remote: "" });
  assert.deepEqual(await releaseOwnClaim(input(h)), []);
  assert.equal(h.calls.removed.length, 0);
  assert.match(h.logs.join("\n"), /already absent/u);
});

test("게시 step 결과를 주지 않으면 그대로 넘겨 도구가 거부하게 한다(여기서 추정하지 않는다)", async () => {
  const h = harness();
  await releaseOwnClaim(input(h, { publicationOutcome: undefined }));
  assert.equal(h.calls.removed[0].publicationOutcome, undefined);
});

test("CLI는 필수 인자가 빠지거나 중복이면 아무것도 하지 않고 실패한다", async () => {
  const h = harness();
  const full = ["--workflow", SEOUL, "--repository", REPOSITORY, "--run-id", RUN_ID, "--branch", BRANCH, "--claim-sha", SHA, "--publication-outcome", "skipped"];
  const dependencies = { runGit: h.runGit, runGh: h.runGh, removeClaims: h.removeClaims, log: h.log };
  assert.equal((await main(full, dependencies))[0].action, "removed_orphan");
  for (const drop of ["--workflow", "--repository", "--run-id", "--branch", "--claim-sha"]) {
    const index = full.indexOf(drop);
    const reduced = full.filter((_, position) => position !== index && position !== index + 1);
    await assert.rejects(main(reduced, dependencies), /CLAIM_ORPHAN_INPUT_INVALID.*missing/u, drop);
  }
  await assert.rejects(main([...full, "--branch", BRANCH], dependencies), /CLAIM_ORPHAN_INPUT_INVALID/u);
  await assert.rejects(main([...full, "--unknown", "x"], dependencies), /CLAIM_ORPHAN_INPUT_INVALID/u);
  assert.equal(h.calls.removed.length, 1, "잘못된 호출은 도구에 닿지 않는다");
  assert.deepEqual(h.calls.order, ["auth", "git"], "삭제 push 인증을 먼저 준비한다(workflow가 따로 gh auth setup-git을 부르지 않는다)");
});

test("게시 step 결과 없이 CLI를 불러도 통과시킨다(게시하지 않는 workflow의 호출)", async () => {
  const h = harness();
  const base = ["--workflow", SEOUL, "--repository", REPOSITORY, "--run-id", RUN_ID, "--branch", BRANCH, "--claim-sha", SHA];
  await main(base, { runGit: h.runGit, runGh: h.runGh, removeClaims: h.removeClaims, log: h.log });
  assert.equal(h.calls.removed[0].publicationOutcome, undefined);
});
