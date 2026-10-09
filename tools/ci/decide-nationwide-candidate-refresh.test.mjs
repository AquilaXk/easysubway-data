import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CANDIDATE_INPUT_MANIFEST_PATH, buildCandidateInputManifest } from "../datapack/lib/candidate-input-bundle.mjs";
import { CANDIDATE_REFRESH_CLAIM_PREFIX, decideNationwideCandidateRefresh, main, parseCandidateRefreshBranches } from "./decide-nationwide-candidate-refresh.mjs";

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
  manifest: manifest(), readLocal: reader(FILES), pullRequests: [], branches: [], automationBranches: [], repository: REPOSITORY, event: "schedule", ...overrides,
});

test("후보가 읽은 입력이 모두 작업 트리와 같으면 CURRENT이고 아무것도 하지 않는다", async () => {
  assert.deepEqual(await run(), { state: "CURRENT", cleanupBranches: [] });
});

test("입력이 하나라도 다르거나 없으면 STALE이고 어느 경로가 달라졌는지 남긴다", async () => {
  assert.deepEqual(await run({ readLocal: reader({ ...FILES, "a.json": "A2" }) }), { state: "STALE", stalePaths: ["a.json"], cleanupBranches: [] });
  assert.deepEqual(await run({ readLocal: reader({ "a.json": "A" }) }), { state: "STALE", stalePaths: ["b.json"], cleanupBranches: [] });
  assert.deepEqual(await run({ readLocal: reader({ "a.json": "x", "b.json": "y" }) }), { state: "STALE", stalePaths: ["a.json", "b.json"], cleanupBranches: [] });
});

test("사람 dispatch는 CURRENT여도 FORCED로 진행한다(명시 요청)", async () => {
  assert.deepEqual(await run({ event: "workflow_dispatch" }), { state: "FORCED", cleanupBranches: [] });
  assert.deepEqual(await run({ event: "workflow_dispatch", actor: "AquilaXk" }), { state: "FORCED", cleanupBranches: [] });
  assert.equal((await run({ event: "workflow_dispatch", readLocal: reader({ ...FILES, "a.json": "A2" }) })).state, "STALE");
});

// #1032: 스케줄러 App의 dispatch는 정기 실행의 대체 경로다. 2시간마다 깨워도 입력이 같으면 후보를 만들지 않는다(FORCED가 아니다).
test("스케줄러 App의 dispatch는 정기 실행과 같이 판정한다: CURRENT는 아무것도 하지 않고 STALE만 진행한다", async () => {
  const app = { event: "workflow_dispatch", actor: "easysubway-release-chain[bot]" };
  assert.deepEqual(await run(app), { state: "CURRENT", cleanupBranches: [] });
  assert.deepEqual(await run({ ...app, readLocal: reader({ ...FILES, "a.json": "A2" }) }), { state: "STALE", stalePaths: ["a.json"], cleanupBranches: [] });
  assert.equal((await run({ ...app, pullRequests: [pr("OPEN", 1)], branches: [`${CANDIDATE_REFRESH_CLAIM_PREFIX}1`] })).state, "OPEN_PR");
  // 비슷한 이름의 다른 행위자는 스케줄러가 아니다.
  for (const actor of ["easysubway-release-chain", "github-actions[bot]", "", undefined]) assert.equal((await run({ event: "workflow_dispatch", actor })).state, "FORCED", String(actor));
});

test("이 workflow의 열린 PR이 있으면 CURRENT·STALE과 무관하게 OPEN_PR이고 dispatch도 새로 만들지 않는다", async () => {
  const branch = `${CANDIDATE_REFRESH_CLAIM_PREFIX}1`;
  const open = { pullRequests: [pr("OPEN", 1)], branches: [branch] };
  assert.deepEqual(await run(open), { state: "OPEN_PR", branch, cleanupBranches: [] });
  assert.deepEqual(await run({ ...open, event: "workflow_dispatch" }), { state: "OPEN_PR", branch, cleanupBranches: [] });
  assert.equal((await run({ ...open, readLocal: reader({}) })).state, "OPEN_PR");
});

test("STALE이어도 원장을 쓰는 자동화 PR이 열려 있으면 BLOCKED_BY_PENDING_PR로 기다린다(CURRENT는 기다리지 않는다)", async () => {
  const stale = { readLocal: reader({ ...FILES, "a.json": "A2" }) };
  assert.deepEqual(await run({ ...stale, pullRequests: [ledgerWriter(971), ledgerWriter(972, "automation/456-capital-topology-registration-")] }),
    { state: "BLOCKED_BY_PENDING_PR", stalePaths: ["a.json"], blockedBy: [971, 972], cleanupBranches: [] });
  assert.equal((await run({ pullRequests: [ledgerWriter(971)] })).state, "CURRENT");
  // 후보 PR끼리·사람 PR·다른 저장소 PR·닫힌 PR은 기다릴 이유가 아니다.
  assert.equal((await run({ ...stale, pullRequests: [pr("OPEN", 9, { number: 973, headRefName: "feat/x" }), { ...ledgerWriter(974), isCrossRepository: true }, { ...ledgerWriter(975), state: "MERGED" }] })).state, "STALE");
});

// #974 리뷰 F3·이슈 #973: PR 없이 남았거나 닫힌 PR의 후보 브랜치는 사람이 지울 일이 아니다. 판정이 정리 대상으로 알린다.
// #974 리뷰 F2: 등록 run은 PR을 열기 전에 claim 브랜치를 push하고 OCI에 게시한다. 그 사이에도 원장 쓰기가 진행 중이다.
test("PR 전의 원장 쓰기 claim 브랜치가 있어도 STALE은 BLOCKED_BY_PENDING_PR로 기다린다", async () => {
  const stale = { readLocal: reader({ ...FILES, "a.json": "A2" }) };
  const claim = "automation/456-capital-topology-registration-111";
  assert.deepEqual(await run({ ...stale, automationBranches: [claim] }), { state: "BLOCKED_BY_PENDING_PR", stalePaths: ["a.json"], blockedBy: [claim], cleanupBranches: [] });
  assert.deepEqual(await run({ ...stale, automationBranches: [claim], pullRequests: [ledgerWriter(971)] }).then(({ blockedBy }) => blockedBy), [971, claim]);
  // 병합된 PR의 claim 브랜치는 끝난 일이다. CURRENT는 기다리지 않는다.
  assert.equal((await run({ ...stale, automationBranches: [claim], pullRequests: [pr("MERGED", 111, { headRefName: claim })] })).state, "STALE");
  assert.equal((await run({ automationBranches: [claim] })).state, "CURRENT");
});

test("PR 없이 남았거나 닫힌 PR의 후보 브랜치는 정리 대상으로 알리고 판정은 계속한다", async () => {
  const orphan = `${CANDIDATE_REFRESH_CLAIM_PREFIX}7`;
  assert.deepEqual(await run({ branches: [orphan] }), { state: "CURRENT", cleanupBranches: [orphan] });
  assert.deepEqual(await run({ branches: [orphan], pullRequests: [pr("CLOSED", 7)] }), { state: "CURRENT", cleanupBranches: [orphan] });
  assert.deepEqual(await run({ branches: [orphan], readLocal: reader({ ...FILES, "a.json": "A2" }) }), { state: "STALE", stalePaths: ["a.json"], cleanupBranches: [orphan] });
  // 열린 PR의 브랜치는 정리 대상이 아니다. 병합된 PR의 브랜치도 건드리지 않는다.
  assert.deepEqual(await run({ pullRequests: [pr("OPEN", 1)], branches: [`${CANDIDATE_REFRESH_CLAIM_PREFIX}1`, orphan] }), { state: "OPEN_PR", branch: `${CANDIDATE_REFRESH_CLAIM_PREFIX}1`, cleanupBranches: [orphan] });
});

test("열린 PR이 둘 이상이거나 열린 PR의 브랜치가 없으면 이상이다", async () => {
  await assert.rejects(run({ pullRequests: [pr("OPEN", 1), pr("OPEN", 2, { number: 981 })], branches: [`${CANDIDATE_REFRESH_CLAIM_PREFIX}1`, `${CANDIDATE_REFRESH_CLAIM_PREFIX}2`] }), /CANDIDATE_REFRESH_PR_DUPLICATE/u);
  await assert.rejects(run({ pullRequests: [pr("OPEN", 1)], branches: [] }), /CANDIDATE_REFRESH_BRANCH_MISSING/u);
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

// #1032: 원장 쓰기 자동화가 멈춰 있어도(사람 확인 대기 claim, 재생성 상한에 걸린 PR) 후보 갱신이 영구히 기다리지 않는다.
// 서울 claim(2026-10-07 19:16Z)과 광주 PR #1019(19:19Z)가 후보를 3시간 넘게 막은 사례를 고정한다.
const HOUR = 3_600_000;
const NOW = new Date("2026-10-07T23:00:00.000Z");
const ago = (milliseconds) => new Date(NOW.getTime() - milliseconds).toISOString();
const GWANGJU_PR = ledgerWriter(1019, "automation/504-retained-gwangju-timetable-refresh-");
const SEOUL_CLAIM = "automation/639-seoul-accessibility-refresh-37673242104";
const STALE = { readLocal: reader({ ...FILES, "a.json": "A2" }) };
const wait = (branchTimes) => ({ ledgerWriterWait: { maxAgeMs: 2 * HOUR, now: NOW, branchTimes } });

test("대기 상한을 넘긴 원장 쓰기 PR·claim은 기다리지 않고 STALE로 후보를 만들며 무시한 대상을 남긴다", async () => {
  const times = { [GWANGJU_PR.headRefName]: ago(3 * HOUR), [SEOUL_CLAIM]: ago(3.7 * HOUR) };
  assert.deepEqual(await run({ ...STALE, pullRequests: [GWANGJU_PR], automationBranches: [SEOUL_CLAIM], ...wait(times) }), {
    state: "STALE", stalePaths: ["a.json"], cleanupBranches: [],
    expiredBlockers: [{ blocker: 1019, branch: GWANGJU_PR.headRefName, ageMs: 3 * HOUR }, { blocker: SEOUL_CLAIM, branch: SEOUL_CLAIM, ageMs: 3.7 * HOUR }],
  });
  // 상한 안의 대상이 하나라도 있으면 그것만 기다린다. 멈춘 대상은 expiredBlockers로만 남는다.
  assert.deepEqual(await run({ ...STALE, pullRequests: [GWANGJU_PR], automationBranches: [SEOUL_CLAIM], ...wait({ ...times, [GWANGJU_PR.headRefName]: ago(20 * 60_000) }) }), {
    state: "BLOCKED_BY_PENDING_PR", stalePaths: ["a.json"], blockedBy: [1019], cleanupBranches: [],
    expiredBlockers: [{ blocker: SEOUL_CLAIM, branch: SEOUL_CLAIM, ageMs: 3.7 * HOUR }],
  });
});

test("나이를 알 수 없는 대상은 기다리고, 상한 설정이 없으면 지금처럼 모두 기다린다", async () => {
  assert.equal((await run({ ...STALE, pullRequests: [GWANGJU_PR], ...wait({}) })).state, "BLOCKED_BY_PENDING_PR");
  assert.equal((await run({ ...STALE, pullRequests: [GWANGJU_PR] })).state, "BLOCKED_BY_PENDING_PR");
  // CURRENT는 원래 기다리지 않으므로 expiredBlockers 계산 자체를 하지 않는다.
  assert.deepEqual(await run({ pullRequests: [GWANGJU_PR], ...wait({ [GWANGJU_PR.headRefName]: ago(9 * HOUR) }) }), { state: "CURRENT", cleanupBranches: [] });
});

// #1032: 보호 admission의 topology가 원장에 등록되기 전에 후보를 만들면 후보의 capitalTopologyAdmission(옛 reverification)이 inventory admission과 어긋나
// PR CI의 후보 build 테스트가 실패하고, 그 후보 PR이 열려 있는 동안 후보 갱신이 막힌다. 등록이 끝나기 전에는 후보를 만들지 않는다.
const REGISTERED_INVENTORY = (snapshotId) => ({ sources: [{ id: "seoul-metro-route-map-positions", routeMapAdmissionEvidence: { currentTopologyAdmission: { status: "ADMITTED", topologySnapshotId: snapshotId, freshUntil: "2026-10-14T20:10:18.488Z" } } }] });
const registration = (ledgerSnapshots) => ({ registration: { inventory: REGISTERED_INVENTORY("capital-route-topology-20261007"), ledger: ledgerSnapshots.map((snapshotId) => ({ sourceId: "capital-route-topology", snapshotId })) } });

test("등록되지 않은 topology admission이 있으면 STALE이어도 후보를 만들지 않고 기다린다. 원장 쓰기 PR이 있으면 그 대기가 먼저다", async () => {
  assert.deepEqual(await run({ ...STALE, ...registration(["capital-route-topology-20261005"]) }), {
    state: "BLOCKED_BY_PENDING_REGISTRATION", stalePaths: ["a.json"], registrationSnapshotId: "capital-route-topology-20261007", cleanupBranches: [],
  });
  assert.equal((await run({ ...STALE, pullRequests: [GWANGJU_PR], ...registration(["capital-route-topology-20261005"]) })).state, "BLOCKED_BY_PENDING_PR");
  // 등록됐으면 STALE로 진행한다. 입력이 같으면(CURRENT) 등록 여부를 보지 않는다.
  assert.equal((await run({ ...STALE, ...registration(["capital-route-topology-20261005", "capital-route-topology-20261007"]) })).state, "STALE");
  assert.equal((await run({ ...registration(["capital-route-topology-20261005"]) })).state, "CURRENT");
  // 멈춘 원장 쓰기 대상을 기다리지 않는 규칙과 함께 쓰면 expiredBlockers가 유지된다.
  const expired = await run({ ...STALE, pullRequests: [GWANGJU_PR], ...wait({ [GWANGJU_PR.headRefName]: ago(3 * HOUR) }), ...registration(["capital-route-topology-20261005"]) });
  assert.equal(expired.state, "BLOCKED_BY_PENDING_REGISTRATION");
  assert.deepEqual(expired.expiredBlockers.map(({ blocker }) => blocker), [1019]);
  // 사람 dispatch의 FORCED는 입력이 같을 때의 명시 요청이므로 등록 대기를 하지 않는다.
  assert.equal((await run({ event: "workflow_dispatch", ...registration(["capital-route-topology-20261005"]) })).state, "FORCED");
});

test("CLI는 git에서 읽은 브랜치 커밋 시각으로 상한을 적용하고 expired_blockers를 출력한다", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "decide-candidate-refresh-")); t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.dirname(path.join(root, CANDIDATE_INPUT_MANIFEST_PATH)), { recursive: true });
  await writeFile(path.join(root, CANDIDATE_INPUT_MANIFEST_PATH), `${JSON.stringify(manifest())}\n`);
  for (const [name, text] of Object.entries({ ...FILES, "a.json": "A2" })) await writeFile(path.join(root, name), text);
  // #1032: 판정은 등록 여부를 보려고 저장소의 inventory와 원장을 읽는다.
  await mkdir(path.join(root, "tools/datapack/release"), { recursive: true });
  await writeFile(path.join(root, "tools/datapack/source-inventory.json"), JSON.stringify(REGISTERED_INVENTORY("capital-route-topology-20261007")));
  const writeLedger = (snapshotIds) => writeFile(path.join(root, "tools/datapack/release/source-snapshots.json"), JSON.stringify(snapshotIds.map((snapshotId) => ({ sourceId: "capital-route-topology", snapshotId }))));
  await writeLedger(["capital-route-topology-20261007"]);
  const sha40 = "d".repeat(40);
  const file = (name) => path.join(root, `args-${name}`);
  await writeFile(file("prs.json"), JSON.stringify([GWANGJU_PR]));
  await writeFile(file("branches.txt"), "");
  await writeFile(file("automation.txt"), `${sha40}\trefs/heads/${GWANGJU_PR.headRefName}\n${sha40}\trefs/heads/${SEOUL_CLAIM}\n`);
  const times = { [GWANGJU_PR.headRefName]: "2026-10-07T19:19:20+00:00", [SEOUL_CLAIM]: "2026-10-07T19:16:40+00:00" };
  const runGit = async (args) => times[args.at(-1).replace("refs/remotes/origin/", "")] ?? "";
  const args = ["--event", "workflow_dispatch", "--actor", "easysubway-release-chain[bot]", "--repository", REPOSITORY, "--prs", file("prs.json"), "--branches", file("branches.txt"), "--automation-branches", file("automation.txt"), "--github-output", file("out.txt")];
  const result = await main(args, { repositoryRoot: root, log: () => {}, runGit, now: () => NOW });
  assert.equal(result.state, "STALE");
  const output = Object.fromEntries((await readFile(file("out.txt"), "utf8")).split("\n").filter(Boolean).map((line) => line.split(/=(.*)/su).slice(0, 2)));
  assert.deepEqual(output, { state: "STALE", branch: "", stale_paths: "a.json", cleanup_branches: "", blocked_by: "", expired_blockers: `1019,${SEOUL_CLAIM}`, registration_snapshot: "" });
  // 방금 만든 대상은 상한 안이라 기다린다.
  times[GWANGJU_PR.headRefName] = "2026-10-07T22:45:00+00:00";
  assert.deepEqual((await main(args.slice(0, -2), { repositoryRoot: root, log: () => {}, runGit, now: () => NOW })).blockedBy, [1019]);
  // 등록되지 않은 admission은 상한을 넘긴 대상을 지나쳐도 후보를 막고 snapshot id를 출력한다.
  times[GWANGJU_PR.headRefName] = "2026-10-07T19:19:20+00:00";
  await writeLedger(["capital-route-topology-20261005"]);
  await rm(file("out.txt"), { force: true });
  const waiting = await main(args, { repositoryRoot: root, log: () => {}, runGit, now: () => NOW });
  assert.equal(waiting.state, "BLOCKED_BY_PENDING_REGISTRATION");
  const waitingOutput = Object.fromEntries((await readFile(file("out.txt"), "utf8")).split("\n").filter(Boolean).map((line) => line.split(/=(.*)/su).slice(0, 2)));
  assert.equal(waitingOutput.state, "BLOCKED_BY_PENDING_REGISTRATION");
  assert.equal(waitingOutput.registration_snapshot, "capital-route-topology-20261007");
});
