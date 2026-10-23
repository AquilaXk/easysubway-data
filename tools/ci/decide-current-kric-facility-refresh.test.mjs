import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { planRefreshFailureReport } from "./report-refresh-failure.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const modulePath = path.join(root, "tools/ci/decide-current-kric-facility-refresh.mjs");

async function load() {
  return import(`${pathToFileURL(modulePath).href}?test=${Date.now()}`);
}

const STANDARD = "kric-station-convenience-standard";
const ESCALATOR = "kric-station-escalator-detailed";
// 에스컬레이터 원천은 기본으로 표준보다 하루 늦게 만료되도록 등록돼 있어 기존 판정은 표준이 정한다. null이면 첫 등록 전(증거 없음) 상태다.
// 표준 원천은 release 필수(requiredForProductionPack)이고 에스컬레이터는 fan-in 밖 선택 원천이다. 필수 여부는 inventory 값으로만 정해진다.
async function fixture({ freshUntil = "2026-08-30T12:00:00.000Z", escalatorFreshUntil = "2026-08-31T12:00:00.000Z", policy = "PT6H", standardRequired = true, escalatorRequired = false } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "kric-refresh-decision-"));
  const inventoryPath = path.join(directory, "inventory.json");
  const policyPath = path.join(directory, "policy.json");
  const prsPath = path.join(directory, "prs.json");
  const claimsPath = path.join(directory, "claims.txt");
  const claimEvidencePath = path.join(directory, "claim-evidence.json");
  const issuesPath = path.join(directory, "issues.json");
  const escalator = escalatorFreshUntil === null ? { id: ESCALATOR } : { id: ESCALATOR, accessibilityAdmissionEvidence: { freshUntil: escalatorFreshUntil } };
  await writeFile(inventoryPath, JSON.stringify({ sources: [{ id: STANDARD, requiredForProductionPack: standardRequired, accessibilityAdmissionEvidence: { freshUntil } }, { ...escalator, requiredForProductionPack: escalatorRequired }] }));
  await writeFile(policyPath, JSON.stringify({ monitoring: { alertBeforePackExpiry: policy } }));
  await writeFile(prsPath, "[]");
  await writeFile(claimsPath, "");
  await writeFile(claimEvidencePath, "[]");
  await writeFile(issuesPath, "[]");
  return { directory, inventoryPath, policyPath, prsPath, claimsPath, claimEvidencePath, issuesPath, repository: "AquilaXk/easysubway-data" };
}

test("KRIC refresh decision reads the policy threshold and distinguishes NOT_DUE, DUE, and EXPIRED", async () => {
  const { decideCurrentKricFacilityRefresh } = await load();
  const input = await fixture();
  for (const [now, state] of [["2026-08-30T05:59:59.999Z", "NOT_DUE"], ["2026-08-30T06:00:00.000Z", "DUE"], ["2026-08-30T12:00:00.000Z", "EXPIRED"]]) {
    const result = await decideCurrentKricFacilityRefresh({ ...input, now: new Date(now) });
    assert.equal(result.state, state);
    assert.equal(result.alertBeforePackExpiry, "PT6H");
    assert.equal(result.sourceId, state === "NOT_DUE" ? undefined : STANDARD);
  }
});

// #3036: 표준·에스컬레이터 두 원천을 run 하나에 하나씩 갱신한다. release 필수 원천(표준)이 갱신 대상(EXPIRED·DUE)이면 선택 원천(에스컬레이터)보다 항상 먼저다.
// 선택 원천이 계속 실패해도 필수 원천의 갱신을 굶기지 않기 위해서다. 같은 쪽 안에서는 만료 상태, 그다음 가장 먼저 만료되는 원천 순이다.
test("KRIC refresh decision picks one source per run: a required source that needs refresh always precedes an optional one", async () => {
  const { decideCurrentKricFacilityRefresh } = await load();
  const cases = [
    [{ escalatorFreshUntil: null }, "2026-08-30T05:59:59.999Z", "DUE", ESCALATOR],
    [{ escalatorFreshUntil: null }, "2026-08-30T06:00:00.000Z", "DUE", STANDARD],
    [{ escalatorFreshUntil: null }, "2026-08-30T12:00:00.000Z", "EXPIRED", STANDARD],
    [{ escalatorFreshUntil: "2026-08-30T10:00:00.000Z" }, "2026-08-30T03:59:59.999Z", "NOT_DUE", undefined],
    [{ escalatorFreshUntil: "2026-08-30T10:00:00.000Z" }, "2026-08-30T04:00:00.000Z", "DUE", ESCALATOR],
    [{ escalatorFreshUntil: "2026-08-30T10:00:00.000Z" }, "2026-08-30T10:00:00.000Z", "DUE", STANDARD],
    [{ escalatorFreshUntil: "2026-08-30T10:00:00.000Z" }, "2026-08-30T12:00:00.000Z", "EXPIRED", STANDARD],
    [{ freshUntil: "2026-08-30T09:00:00.000Z", escalatorFreshUntil: "2026-08-30T10:00:00.000Z" }, "2026-08-30T04:00:00.000Z", "DUE", STANDARD],
    [{ freshUntil: "2026-08-30T10:00:00.000Z", escalatorFreshUntil: "2026-08-30T09:00:00.000Z" }, "2026-08-30T04:00:00.000Z", "DUE", STANDARD],
    [{ freshUntil: "2026-08-30T03:00:00.000Z", escalatorFreshUntil: "2026-08-30T02:00:00.000Z" }, "2026-08-30T04:00:00.000Z", "EXPIRED", STANDARD],
    [{ freshUntil: "2026-08-30T10:00:00.000Z", escalatorFreshUntil: "2026-08-30T02:00:00.000Z" }, "2026-08-30T04:00:00.000Z", "DUE", STANDARD],
    [{ freshUntil: "2026-08-30T20:00:00.000Z", escalatorFreshUntil: "2026-08-30T02:00:00.000Z" }, "2026-08-30T04:00:00.000Z", "EXPIRED", ESCALATOR],
    [{ freshUntil: "2026-08-30T20:00:00.000Z", escalatorFreshUntil: "2026-08-30T10:00:00.000Z" }, "2026-08-30T04:00:00.000Z", "DUE", ESCALATOR],
  ];
  for (const [options, now, state, sourceId] of cases) {
    const result = await decideCurrentKricFacilityRefresh({ ...(await fixture(options)), now: new Date(now) });
    assert.deepEqual([result.state, result.sourceId], [state, sourceId], `${JSON.stringify(options)} at ${now}`);
  }
});

test("KRIC refresh decision derives which source is required from the inventory, not from a source id", async () => {
  const { decideCurrentKricFacilityRefresh } = await load();
  const swapped = { standardRequired: false, escalatorRequired: true };
  const expiredStandardDueEscalator = { ...swapped, freshUntil: "2026-08-30T02:00:00.000Z", escalatorFreshUntil: "2026-08-30T10:00:00.000Z" };
  const result = await decideCurrentKricFacilityRefresh({ ...(await fixture(expiredStandardDueEscalator)), now: new Date("2026-08-30T04:00:00.000Z") });
  assert.deepEqual([result.state, result.sourceId], ["DUE", ESCALATOR]);
  const noneRequired = await fixture({ standardRequired: false });
  await assert.rejects(() => decideCurrentKricFacilityRefresh({ ...noneRequired, now: NOW }), /KRIC facility refresh has no required source/);
});

// 선택 원천이 실패하면 실패 보고기가 열린 실패 이슈에 실패 시각 표지를 남기고, 판정은 그 표지로 재시도를 쿨다운한다.
// 필수 원천은 쿨다운 대상이 아니다. 같은 이슈가 닫히면(회복) 표지도 사라진다.
const HOUR_MS = 3_600_000;
const FAILURE_COOLDOWN_MS = 24 * HOUR_MS;
const failureIssue = ({ sourceId, at, author = "app/github-actions", workflowFile = "kric-current-facility-refresh.yml" }) => {
  const plan = planRefreshFailureReport({ repository: "AquilaXk/easysubway-data", workflowFile, runId: "1001", openIssues: [], now: at, sourceId });
  return { number: 7, title: plan.title, body: plan.body, author: { login: author }, createdAt: at.toISOString(), comments: [] };
};
async function decideWithIssues(options, issues, now) {
  const { decideCurrentKricFacilityRefresh } = await load();
  const input = await fixture(options);
  await writeFile(input.issuesPath, JSON.stringify(issues));
  return decideCurrentKricFacilityRefresh({ ...input, now });
}

test("an optional source that failed is not selected again until its 24h cooldown has passed (first registration and expiry alike)", async () => {
  const failedAt = new Date("2026-08-30T01:00:00.000Z");
  const issues = [failureIssue({ sourceId: ESCALATOR, at: failedAt })];
  const standardFresh = { freshUntil: "2026-09-05T12:00:00.000Z" };
  for (const [escalatorFreshUntil, stateAfterCooldown] of [[null, "DUE"], ["2026-08-30T00:00:00.000Z", "EXPIRED"], ["2026-08-30T05:00:00.000Z", "EXPIRED"]]) {
    const options = { ...standardFresh, escalatorFreshUntil };
    for (const now of [failedAt, new Date(failedAt.getTime() + HOUR_MS), new Date(failedAt.getTime() + FAILURE_COOLDOWN_MS - 1)]) {
      const result = await decideWithIssues(options, issues, now);
      assert.deepEqual([result.state, result.sourceId], ["NOT_DUE", undefined], `${escalatorFreshUntil} at ${now.toISOString()}`);
    }
    const after = await decideWithIssues(options, issues, new Date(failedAt.getTime() + FAILURE_COOLDOWN_MS));
    assert.deepEqual([after.state, after.sourceId], [stateAfterCooldown, ESCALATOR], String(escalatorFreshUntil));
  }
});

test("a cooling optional source never holds back the required source, and the required source has no cooldown of its own", async () => {
  const failedAt = new Date("2026-08-30T01:00:00.000Z");
  const now = new Date(failedAt.getTime() + HOUR_MS);
  const escalatorFailed = [failureIssue({ sourceId: ESCALATOR, at: failedAt })];
  const standardFailed = [failureIssue({ sourceId: STANDARD, at: failedAt })];
  for (const [options, issues, state] of [
    [{ freshUntil: "2026-08-30T05:00:00.000Z", escalatorFreshUntil: null }, escalatorFailed, "DUE"],
    [{ freshUntil: "2026-08-30T01:30:00.000Z", escalatorFreshUntil: "2026-08-30T00:00:00.000Z" }, escalatorFailed, "EXPIRED"],
    [{ freshUntil: "2026-08-30T01:30:00.000Z", escalatorFreshUntil: null }, standardFailed, "EXPIRED"],
    [{ freshUntil: "2026-08-30T05:00:00.000Z", escalatorFreshUntil: null }, standardFailed, "DUE"],
  ]) {
    const result = await decideWithIssues(options, issues, now);
    assert.deepEqual([result.state, result.sourceId], [state, STANDARD], JSON.stringify(options));
  }
});

test("only a failure issue this workflow's bot wrote starts a cooldown", async () => {
  const failedAt = new Date("2026-08-30T01:00:00.000Z");
  const now = new Date(failedAt.getTime() + HOUR_MS);
  const options = { freshUntil: "2026-09-05T12:00:00.000Z", escalatorFreshUntil: null };
  for (const issue of [
    failureIssue({ sourceId: ESCALATOR, at: failedAt, author: "someone" }),
    failureIssue({ sourceId: ESCALATOR, at: failedAt, workflowFile: "seoul-current-accessibility-refresh.yml" }),
  ]) {
    const result = await decideWithIssues(options, [issue], now);
    assert.deepEqual([result.state, result.sourceId], ["DUE", ESCALATOR]);
  }
});

test("a failed attempt of the required source does not start a cooldown for the optional one, and each source cools on its own failure time", async () => {
  const standardFailedAt = new Date("2026-08-30T01:00:00.000Z");
  const now = new Date("2026-08-30T03:00:00.000Z");
  const options = { freshUntil: "2026-09-05T12:00:00.000Z", escalatorFreshUntil: null };
  const result = await decideWithIssues(options, [failureIssue({ sourceId: STANDARD, at: standardFailedAt })], now);
  assert.deepEqual([result.state, result.sourceId], ["DUE", ESCALATOR]);
});

test("a malformed failure marker or issue listing stops the decision instead of being guessed around", async () => {
  const failedAt = new Date("2026-08-30T01:00:00.000Z");
  const options = { freshUntil: "2026-09-05T12:00:00.000Z", escalatorFreshUntil: null };
  const issue = failureIssue({ sourceId: ESCALATOR, at: failedAt });
  const broken = { ...issue, body: issue.body.replace(`${ESCALATOR}:${failedAt.toISOString()}`, `${ESCALATOR}:2026-13-45T25:61:61.000Z`) };
  await assert.rejects(() => decideWithIssues(options, [broken], NOW), /REFRESH_FAILURE_REPORT_SOURCE_MARKER/);
  await assert.rejects(() => decideWithIssues(options, {}, NOW), /REFRESH_FAILURE_REPORT_ISSUES/);
  const { decideCurrentKricFacilityRefresh } = await load();
  const input = await fixture(options);
  await writeFile(input.issuesPath, "not json");
  await assert.rejects(() => decideCurrentKricFacilityRefresh({ ...input, now: NOW }), /open issues is invalid JSON/);
});

test("KRIC refresh decision fails when a refreshed source has no inventory entry or a registered source has no valid freshUntil", async () => {
  const { decideCurrentKricFacilityRefresh } = await load();
  const input = await fixture();
  for (const [sources, pattern] of [
    [[{ id: STANDARD, accessibilityAdmissionEvidence: { freshUntil: "2026-08-30T12:00:00.000Z" } }], /KRIC facility source is not in the inventory: kric-station-escalator-detailed/],
    [[{ id: ESCALATOR }], /KRIC facility source is not in the inventory: kric-station-convenience-standard/],
    [[{ id: STANDARD, accessibilityAdmissionEvidence: {} }, { id: ESCALATOR }], /kric-station-convenience-standard freshUntil is invalid/],
  ]) {
    await writeFile(input.inventoryPath, JSON.stringify({ sources }));
    await assert.rejects(() => decideCurrentKricFacilityRefresh({ ...input, now: NOW }), pattern);
  }
});

test("KRIC refresh decision trusts only a same-repository main-base automation PR", async () => {
  const { decideCurrentKricFacilityRefresh } = await load();
  const input = await fixture();
  await writeFile(input.prsPath, JSON.stringify([
    { number: 629, state: "OPEN", isDraft: true, headRefName: "automation/629-kric-facility-refresh-123", baseRefName: "main", headRepository: { nameWithOwner: "someone/fork" }, isCrossRepository: true },
    { number: 630, state: "OPEN", isDraft: true, headRefName: "automation/629-kric-facility-refresh-124", baseRefName: "release", headRepository: { nameWithOwner: input.repository }, isCrossRepository: false },
  ]));
  assert.equal((await decideCurrentKricFacilityRefresh({ ...input, now: new Date("2026-08-30T07:00:00.000Z") })).state, "DUE");
  await writeFile(input.prsPath, JSON.stringify([{ number: 631, state: "OPEN", isDraft: true, headRefName: "automation/629-kric-facility-refresh-125", baseRefName: "main", headRepository: { nameWithOwner: input.repository }, isCrossRepository: false }]));
  assert.equal((await decideCurrentKricFacilityRefresh({ ...input, now: new Date("2026-08-30T07:00:00.000Z") })).state, "OPEN_PR");
  await writeFile(input.prsPath, JSON.stringify([{ number: 632, state: "OPEN", isDraft: true, headRefName: "automation/629-kric-facility-refresh-126", baseRefName: "main", headRepository: { nameWithOwner: input.repository }, isCrossRepository: false }, { number: 633, state: "OPEN", isDraft: true, headRefName: "automation/629-kric-facility-refresh-127", baseRefName: "main", headRepository: { nameWithOwner: input.repository }, isCrossRepository: false }]));
  await assert.rejects(() => decideCurrentKricFacilityRefresh({ ...input, now: new Date("2026-08-30T07:00:00.000Z") }), /duplicate/);
});

const PREFIX = "automation/629-kric-facility-refresh-";
const SHA = "0123456789abcdef0123456789abcdef01234567";
const NOW = new Date("2026-08-30T07:00:00.000Z");
const ref = (runId) => `${SHA}\trefs/heads/${PREFIX}${runId}\n`;
const kricPr = (number, state, runId, input) => ({ number, state, isDraft: true, headRefName: `${PREFIX}${runId}`, baseRefName: "main", headRepository: { nameWithOwner: input.repository }, isCrossRepository: false });
const NOT_PUBLISHED = [{ name: "KRIC current facility refresh / Publish and register current snapshot", status: "completed", conclusion: "skipped" }];
const kricEvidence = (runId, overrides = {}) => ({
  branch: `${PREFIX}${runId}`, runId: String(runId),
  run: { found: true, status: "completed", conclusion: "failure", workflowName: "KRIC Current Facility Refresh", headBranch: "main", steps: NOT_PUBLISHED },
  commits: { aheadBy: 1, subjects: ["Claim KRIC facility refresh"], changedFiles: 0 }, artifacts: [], ...overrides,
});
const withOutput = (runId) => kricEvidence(runId, { commits: { aheadBy: 2, subjects: ["Claim KRIC facility refresh", "Refresh KRIC facility snapshot"], changedFiles: 3 } });
const withReceipt = (runId) => kricEvidence(runId, { run: { found: true, status: "completed", conclusion: "failure", workflowName: "KRIC Current Facility Refresh", headBranch: "main", steps: [{ name: "KRIC current facility refresh / Publish and register current snapshot", status: "completed", conclusion: "failure" }] }, artifacts: [{ name: `kric-current-facility-refresh-${runId}`, expired: false }] });
const running = (runId) => kricEvidence(runId, { run: { found: true, status: "in_progress", conclusion: null, workflowName: "KRIC Current Facility Refresh", headBranch: "main", steps: NOT_PUBLISHED } });
const evidenceFile = (input, ...records) => writeFile(input.claimEvidencePath, JSON.stringify(records));

test("KRIC refresh decision recovers exactly one durable remote claim that carries output or a receipt before provider work", async () => {
  const { decideCurrentKricFacilityRefresh } = await load();
  const input = await fixture();
  await writeFile(input.claimsPath, ref(123));
  for (const record of [withOutput(123), withReceipt(123)]) {
    await evidenceFile(input, record);
    assert.deepEqual(await decideCurrentKricFacilityRefresh({ ...input, now: NOW }), { state: "RECOVER_CLAIM", alertBeforePackExpiry: "PT6H", branch: `${PREFIX}123`, cleanupClaims: [] });
  }
  await writeFile(input.claimsPath, ref(123) + ref(124));
  await evidenceFile(input, withOutput(123), withReceipt(124));
  await assert.rejects(() => decideCurrentKricFacilityRefresh({ ...input, now: NOW }), /duplicate/);
  await writeFile(input.claimsPath, "not-a-ref\n");
  await assert.rejects(() => decideCurrentKricFacilityRefresh({ ...input, now: NOW }), /claim/);
});

// #995: receipt 없는 빈 claim은 복구할 것이 없다. 예전에는 보존 artifact가 항상 올라와 복구 step이 14일 동안 실패했고 Abandon 뒤에도 브랜치가 남았다.
test("an empty claim without a receipt is handed to cleanup in every due state and a running producer waits", async () => {
  const { decideCurrentKricFacilityRefresh } = await load();
  const input = await fixture();
  await writeFile(input.claimsPath, ref(125));
  await evidenceFile(input, kricEvidence(125));
  for (const [now, state] of [["2026-08-30T05:59:59.999Z", "NOT_DUE"], ["2026-08-30T06:00:00.000Z", "DUE"], ["2026-08-30T12:00:00.000Z", "EXPIRED"]]) {
    assert.deepEqual(await decideCurrentKricFacilityRefresh({ ...input, now: new Date(now) }), { state, alertBeforePackExpiry: "PT6H", cleanupClaims: [`${PREFIX}125`], ...(state === "NOT_DUE" ? {} : { sourceId: STANDARD }) }, state);
  }
  await evidenceFile(input, running(125));
  for (const now of ["2026-08-30T05:00:00.000Z", "2026-08-30T07:00:00.000Z"]) {
    assert.deepEqual(await decideCurrentKricFacilityRefresh({ ...input, now: new Date(now) }), { state: "CLAIM_IN_PROGRESS", alertBeforePackExpiry: "PT6H", branch: `${PREFIX}125`, cleanupClaims: [] }, now);
  }
  await evidenceFile(input);
  await assert.rejects(() => decideCurrentKricFacilityRefresh({ ...input, now: NOW }), /CLAIM_ORPHAN_EVIDENCE_MISSING/);
});

// #995 F1: 게시 step이 시작된 run의 빈 claim은 보존 증거가 없으면 지우지 않고 실패한다(게시됐지만 등록되지 않은 상태일 수 있다).
test("a published-but-unregistered claim without retained evidence fails instead of being cleaned", async () => {
  const { decideCurrentKricFacilityRefresh } = await load();
  const input = await fixture();
  await writeFile(input.claimsPath, ref(126));
  await evidenceFile(input, { ...withReceipt(126), artifacts: [] });
  await assert.rejects(() => decideCurrentKricFacilityRefresh({ ...input, now: NOW }), /CLAIM_ORPHAN_PUBLISHED_UNREGISTERED/);
  await evidenceFile(input, withReceipt(126));
  assert.equal((await decideCurrentKricFacilityRefresh({ ...input, now: NOW })).state, "RECOVER_CLAIM");
});

test("terminal historical claims ignore merged history and fail closed on closed claims", async () => {
  const { decideCurrentKricFacilityRefresh } = await load();
  const input = await fixture();
  await writeFile(input.claimsPath, ref(122));
  await writeFile(input.prsPath, JSON.stringify([kricPr(628, "MERGED", 122, input)]));
  assert.equal((await decideCurrentKricFacilityRefresh({ ...input, now: NOW })).state, "DUE");
  await writeFile(input.claimsPath, ref(122) + ref(123));
  await evidenceFile(input, withOutput(123));
  assert.equal((await decideCurrentKricFacilityRefresh({ ...input, now: NOW })).state, "RECOVER_CLAIM");
  await writeFile(input.claimsPath, ref(122));
  await writeFile(input.prsPath, JSON.stringify([kricPr(628, "CLOSED", 122, input)]));
  await assert.rejects(() => decideCurrentKricFacilityRefresh({ ...input, now: NOW }), /requires manual resolution/);
  await writeFile(input.claimsPath, ref(122) + ref(123));
  await assert.rejects(() => decideCurrentKricFacilityRefresh({ ...input, now: NOW }), /ambiguous/);
});

test("decision CLI writes the state, branch and cleanup claims", async () => {
  const input = await fixture();
  await writeFile(input.claimsPath, ref(123) + ref(124));
  await evidenceFile(input, withOutput(123), kricEvidence(124));
  const outputPath = path.join(input.directory, "decision.json");
  const githubOutputPath = path.join(input.directory, "github-output.txt");
  const { runCurrentKricFacilityRefreshDecision } = await load();
  await runCurrentKricFacilityRefreshDecision({ inventoryPath: input.inventoryPath, policyPath: input.policyPath, prsPath: input.prsPath, claimsPath: input.claimsPath, claimEvidencePath: input.claimEvidencePath, issuesPath: input.issuesPath, repository: input.repository, outputPath, githubOutputPath, now: NOW });
  const output = await readFile(outputPath, "utf8");
  assert.match(output, /"state": "RECOVER_CLAIM"/);
  assert.doesNotMatch(output, /https:\/\//);
  assert.equal(await readFile(githubOutputPath, "utf8"), `state=RECOVER_CLAIM\nbranch=${PREFIX}123\ncleanup_claims=${PREFIX}124\nsource_id=\n`);
  const dueOutputPath = path.join(input.directory, "github-output-due.txt");
  await writeFile(input.claimsPath, "");
  await evidenceFile(input);
  await runCurrentKricFacilityRefreshDecision({ inventoryPath: input.inventoryPath, policyPath: input.policyPath, prsPath: input.prsPath, claimsPath: input.claimsPath, claimEvidencePath: input.claimEvidencePath, issuesPath: input.issuesPath, repository: input.repository, outputPath: path.join(input.directory, "decision-due.json"), githubOutputPath: dueOutputPath, now: NOW });
  assert.equal(await readFile(dueOutputPath, "utf8"), `state=DUE\nbranch=\ncleanup_claims=\nsource_id=${STANDARD}\n`);
});

test("claim refs must be ls-remote heads of this workflow", async () => {
  const { decideCurrentKricFacilityRefresh } = await load();
  const input = await fixture();
  for (const bad of [`${SHA}\trefs/heads/${PREFIX}123\textra\n`, `${SHA}\trefs/heads/automation/639-seoul-accessibility-refresh-1\n`, ref(1) + ref(1)]) {
    await writeFile(input.claimsPath, bad);
    await assert.rejects(() => decideCurrentKricFacilityRefresh({ ...input, now: NOW }), /KRIC refresh claim is invalid|duplicate/);
  }
});

test("a claim the workflow closed out with an Abandon commit is cleaned like any abandoned claim", async () => {
  const { decideCurrentKricFacilityRefresh, ABANDONED_CLAIM_SUBJECT } = await load();
  assert.equal(ABANDONED_CLAIM_SUBJECT, "Abandon KRIC facility refresh claim");
  const input = await fixture();
  const closed = kricEvidence(33931967736, { commits: { aheadBy: 2, subjects: ["Claim KRIC facility refresh", ABANDONED_CLAIM_SUBJECT], changedFiles: 0 }, artifacts: [{ name: "kric-current-facility-refresh-33931967736", expired: false }] });
  await writeFile(input.claimsPath, ref(33931967736));
  await evidenceFile(input, closed);
  assert.deepEqual(await decideCurrentKricFacilityRefresh({ ...input, now: new Date("2026-08-30T12:00:00.000Z") }), { state: "EXPIRED", alertBeforePackExpiry: "PT6H", cleanupClaims: [`${PREFIX}33931967736`], sourceId: STANDARD });
  assert.deepEqual(await decideCurrentKricFacilityRefresh({ ...input, now: NOW }), { state: "DUE", alertBeforePackExpiry: "PT6H", cleanupClaims: [`${PREFIX}33931967736`], sourceId: STANDARD });
  await writeFile(input.claimsPath, ref(33931967736) + ref(123));
  await evidenceFile(input, closed, withOutput(123));
  assert.deepEqual(await decideCurrentKricFacilityRefresh({ ...input, now: NOW }), { state: "RECOVER_CLAIM", alertBeforePackExpiry: "PT6H", branch: `${PREFIX}123`, cleanupClaims: [`${PREFIX}33931967736`] });
});

// #995 F4: PR이 붙은 claim은 판정에서 묶인 claim이지만, Abandon 커밋이 있는 claim에 PR이 붙는 것은 이상이다(닫았다고 기록한 claim은 PR이 되지 않는다).
test("an Abandon-headed claim that has a pull request fails with a named error in every PR state", async () => {
  const { decideCurrentKricFacilityRefresh, ABANDONED_CLAIM_SUBJECT } = await load();
  const input = await fixture();
  await writeFile(input.claimsPath, ref(33931967736));
  const boundEvidence = { branch: `${PREFIX}33931967736`, runId: "33931967736", bound: true, commits: { aheadBy: 2, subjects: ["Claim KRIC facility refresh", ABANDONED_CLAIM_SUBJECT], changedFiles: 0 } };
  await evidenceFile(input, boundEvidence);
  for (const state of ["OPEN", "CLOSED", "MERGED"]) {
    await writeFile(input.prsPath, JSON.stringify([kricPr(700, state, 33931967736, input)]));
    await assert.rejects(() => decideCurrentKricFacilityRefresh({ ...input, now: NOW }), /abandoned KRIC refresh claim has a pull request/, state);
  }
  // 닫지 않은 claim에 PR이 붙은 것은 정상이다.
  await evidenceFile(input, { ...boundEvidence, commits: { aheadBy: 2, subjects: ["Claim KRIC facility refresh", "Refresh KRIC facility snapshot"], changedFiles: 3 } });
  await writeFile(input.prsPath, JSON.stringify([kricPr(700, "OPEN", 33931967736, input)]));
  assert.equal((await decideCurrentKricFacilityRefresh({ ...input, now: NOW })).state, "OPEN_PR");
});

test("claim evidence is AVAILABLE only while the named source-run artifact is unexpired", async () => {
  const { classifyKricFacilityClaimEvidence, KRIC_FACILITY_EVIDENCE_RETENTION_DAYS } = await load();
  assert.equal(KRIC_FACILITY_EVIDENCE_RETENTION_DAYS, 14);
  const sourceRunId = "33931967736";
  const sourceRunUpdatedAt = "2026-09-05T00:10:42Z";
  const artifact = (expired) => ({ total_count: 1, artifacts: [{ id: 1, name: `kric-current-facility-refresh-${sourceRunId}`, expired }] });
  const insideWindow = new Date("2026-09-18T00:00:00.000Z");
  const afterWindow = new Date("2026-09-19T00:10:42.000Z");
  assert.equal(classifyKricFacilityClaimEvidence({ sourceRunId, sourceRunUpdatedAt, artifacts: artifact(false), now: insideWindow }), "AVAILABLE");
  assert.equal(classifyKricFacilityClaimEvidence({ sourceRunId, sourceRunUpdatedAt, artifacts: artifact(true), now: insideWindow }), "EXPIRED");
  // 보존 기간이 지나 목록에서 사라진 artifact는 만료로 판정한다(2026-09-20 run 35507969487의 상황).
  assert.equal(classifyKricFacilityClaimEvidence({ sourceRunId, sourceRunUpdatedAt, artifacts: { total_count: 0, artifacts: [] }, now: afterWindow }), "EXPIRED");
  // 보존 기간 안에서 사라진 artifact는 만료 근거가 없으므로 수동 처리로 남긴다.
  assert.throws(() => classifyKricFacilityClaimEvidence({ sourceRunId, sourceRunUpdatedAt, artifacts: { total_count: 0, artifacts: [] }, now: insideWindow }),
    /retained evidence is missing inside its retention window/);
  const unrelated = { total_count: 1, artifacts: [{ id: 2, name: "kric-current-facility-refresh-1", expired: false }] };
  assert.equal(classifyKricFacilityClaimEvidence({ sourceRunId, sourceRunUpdatedAt, artifacts: unrelated, now: afterWindow }), "EXPIRED");
  assert.throws(() => classifyKricFacilityClaimEvidence({ sourceRunId, sourceRunUpdatedAt, artifacts: { total_count: 2, artifacts: [artifact(false).artifacts[0], artifact(true).artifacts[0]] }, now: insideWindow }), /duplicate/);
  assert.throws(() => classifyKricFacilityClaimEvidence({ sourceRunId, sourceRunUpdatedAt, artifacts: { total_count: 2, artifacts: [] }, now: insideWindow }), /artifact listing is invalid/);
  assert.throws(() => classifyKricFacilityClaimEvidence({ sourceRunId, sourceRunUpdatedAt, artifacts: { total_count: 1, artifacts: [{ name: `kric-current-facility-refresh-${sourceRunId}` }] }, now: insideWindow }), /artifact listing is invalid/);
  assert.throws(() => classifyKricFacilityClaimEvidence({ sourceRunId: "x", sourceRunUpdatedAt, artifacts: artifact(false), now: insideWindow }), /source run identity is invalid/);
  assert.throws(() => classifyKricFacilityClaimEvidence({ sourceRunId, sourceRunUpdatedAt: "yesterday", artifacts: artifact(false), now: insideWindow }), /source run updatedAt is invalid/);
});
