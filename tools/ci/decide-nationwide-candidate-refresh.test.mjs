import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { buildCandidateInputManifest } from "../datapack/lib/candidate-input-bundle.mjs";
import { CANDIDATE_REFRESH_CLAIM_PREFIX, decideNationwideCandidateRefresh, parseCandidateRefreshBranches } from "./decide-nationwide-candidate-refresh.mjs";

// #969 P5: 전국 후보 갱신은 입력이 바뀌었을 때만 한다. 후보가 읽은 입력 매니페스트가 지금 작업 트리와 같으면 CURRENT다.
// 매일 무조건 sequence를 올려 후보 PR을 만들던 정기 실행을 변경 판정(STALE)·열린 PR(OPEN_PR)·원장 쓰기 PR 대기로 바꾼다.
const REPOSITORY = "AquilaXk/easysubway-data";
const sha = (text) => createHash("sha256").update(text).digest("hex");
const FILES = { "a.json": "A", "b.json": "B" };
const DIGEST = "e".repeat(64);
const manifest = (files = FILES) => buildCandidateInputManifest({
  candidateId: "nationwide-candidate-test", candidateBuildSpecSha256: DIGEST, preparationSha256: DIGEST, fanInSha256: DIGEST,
  entries: Object.keys(files).map((path) => ({ path, sha256: sha(files[path]), byteSize: Buffer.byteLength(files[path]) })),
});
const reader = (files) => async (path) => { if (!(path in files)) throw new Error("missing"); return Buffer.from(files[path]); };
const pr = (state, runId, overrides = {}) => ({
  number: 980, state, isDraft: true, headRefName: `${CANDIDATE_REFRESH_CLAIM_PREFIX}${runId}`, baseRefName: "main",
  isCrossRepository: false, headRepository: { nameWithOwner: REPOSITORY }, ...overrides,
});
const ledgerWriter = (number, prefix = "automation/639-seoul-accessibility-refresh-") => pr("OPEN", 9, { number, headRefName: `${prefix}9` });
const run = async (overrides = {}) => decideNationwideCandidateRefresh({
  manifest: manifest(), readLocal: reader(FILES), pullRequests: [], branches: [], repository: REPOSITORY, event: "schedule", ...overrides,
});

test("후보가 읽은 입력이 모두 작업 트리와 같으면 CURRENT이고 아무것도 하지 않는다", async () => {
  assert.deepEqual(await run(), { state: "CURRENT" });
});

test("입력이 하나라도 다르거나 없으면 STALE이고 어느 경로가 달라졌는지 남긴다", async () => {
  assert.deepEqual(await run({ readLocal: reader({ ...FILES, "a.json": "A2" }) }), { state: "STALE", stalePaths: ["a.json"] });
  assert.deepEqual(await run({ readLocal: reader({ "a.json": "A" }) }), { state: "STALE", stalePaths: ["b.json"] });
  assert.deepEqual(await run({ readLocal: reader({ "a.json": "x", "b.json": "y" }) }), { state: "STALE", stalePaths: ["a.json", "b.json"] });
});

test("사람 dispatch는 CURRENT여도 FORCED로 진행한다(명시 요청)", async () => {
  assert.deepEqual(await run({ event: "workflow_dispatch" }), { state: "FORCED" });
  assert.equal((await run({ event: "workflow_dispatch", readLocal: reader({ ...FILES, "a.json": "A2" }) })).state, "STALE");
});

test("이 workflow의 열린 PR이 있으면 CURRENT·STALE과 무관하게 OPEN_PR이고 dispatch도 새로 만들지 않는다", async () => {
  const branch = `${CANDIDATE_REFRESH_CLAIM_PREFIX}1`;
  const open = { pullRequests: [pr("OPEN", 1)], branches: [branch] };
  assert.deepEqual(await run(open), { state: "OPEN_PR", branch });
  assert.deepEqual(await run({ ...open, event: "workflow_dispatch" }), { state: "OPEN_PR", branch });
  assert.equal((await run({ ...open, readLocal: reader({}) })).state, "OPEN_PR");
});

test("STALE이어도 원장을 쓰는 자동화 PR이 열려 있으면 BLOCKED_BY_PENDING_PR로 기다린다(CURRENT는 기다리지 않는다)", async () => {
  const stale = { readLocal: reader({ ...FILES, "a.json": "A2" }) };
  assert.deepEqual(await run({ ...stale, pullRequests: [ledgerWriter(971), ledgerWriter(972, "automation/456-capital-topology-registration-")] }),
    { state: "BLOCKED_BY_PENDING_PR", stalePaths: ["a.json"], blockedBy: [971, 972] });
  assert.equal((await run({ pullRequests: [ledgerWriter(971)] })).state, "CURRENT");
  // 후보 PR끼리·사람 PR·다른 저장소 PR·닫힌 PR은 기다릴 이유가 아니다.
  assert.equal((await run({ ...stale, pullRequests: [pr("OPEN", 9, { number: 973, headRefName: "feat/x" }), { ...ledgerWriter(974), isCrossRepository: true }, { ...ledgerWriter(975), state: "MERGED" }] })).state, "STALE");
});

test("PR 없이 남은 후보 브랜치나 닫힌 PR의 브랜치, 중복 열린 PR은 이상이다", async () => {
  const orphan = `${CANDIDATE_REFRESH_CLAIM_PREFIX}7`;
  await assert.rejects(run({ branches: [orphan] }), /CANDIDATE_REFRESH_ORPHAN_BRANCH/u);
  await assert.rejects(run({ branches: [orphan], pullRequests: [pr("CLOSED", 7)] }), /CANDIDATE_REFRESH_ORPHAN_BRANCH/u);
  await assert.rejects(run({ pullRequests: [pr("OPEN", 1), pr("OPEN", 2, { number: 981 })], branches: [`${CANDIDATE_REFRESH_CLAIM_PREFIX}1`, `${CANDIDATE_REFRESH_CLAIM_PREFIX}2`] }), /CANDIDATE_REFRESH_PR_DUPLICATE/u);
  await assert.rejects(run({ pullRequests: [pr("OPEN", 1)], branches: [] }), /CANDIDATE_REFRESH_BRANCH_MISSING/u);
  // 병합된 이전 후보 PR의 브랜치는 남아 있어도 된다.
  assert.deepEqual(await run({ branches: [orphan], pullRequests: [pr("MERGED", 7)] }), { state: "CURRENT" });
});

test("매니페스트가 잘못됐거나 입력이 이상하면 판정하지 않고 실패한다", async () => {
  await assert.rejects(run({ manifest: { files: [{ path: "a.json" }] } }), /CANDIDATE_REFRESH_MANIFEST_INVALID/u);
  await assert.rejects(run({ manifest: null }), /CANDIDATE_REFRESH_MANIFEST_INVALID/u);
  await assert.rejects(run({ event: "push" }), /CANDIDATE_REFRESH_INPUT_INVALID/u);
  await assert.rejects(run({ repository: "x" }), /CANDIDATE_REFRESH_INPUT_INVALID/u);
  await assert.rejects(run({ pullRequests: null }), /CANDIDATE_REFRESH_INPUT_INVALID/u);
});

test("후보 브랜치 목록은 후보 갱신 브랜치 ref만 받는다", () => {
  const sha40 = "d".repeat(40);
  assert.deepEqual(parseCandidateRefreshBranches(""), []);
  assert.deepEqual(parseCandidateRefreshBranches(`${sha40}\trefs/heads/${CANDIDATE_REFRESH_CLAIM_PREFIX}5\n`), [`${CANDIDATE_REFRESH_CLAIM_PREFIX}5`]);
  assert.throws(() => parseCandidateRefreshBranches(`${sha40}\trefs/heads/automation/other-1\n`), /CANDIDATE_REFRESH_BRANCH_INVALID/u);
});
