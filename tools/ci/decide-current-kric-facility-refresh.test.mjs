import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const modulePath = path.join(root, "tools/ci/decide-current-kric-facility-refresh.mjs");

async function load() {
  return import(`${pathToFileURL(modulePath).href}?test=${Date.now()}`);
}

async function fixture({ freshUntil = "2026-08-30T12:00:00.000Z", policy = "PT6H" } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "kric-refresh-decision-"));
  const inventoryPath = path.join(directory, "inventory.json");
  const policyPath = path.join(directory, "policy.json");
  const prsPath = path.join(directory, "prs.json");
  const claimsPath = path.join(directory, "claims.txt");
  const claimEvidencePath = path.join(directory, "claim-evidence.json");
  await writeFile(inventoryPath, JSON.stringify({ sources: [{ id: "kric-station-convenience-standard", accessibilityAdmissionEvidence: { freshUntil } }] }));
  await writeFile(policyPath, JSON.stringify({ monitoring: { alertBeforePackExpiry: policy } }));
  await writeFile(prsPath, "[]");
  await writeFile(claimsPath, "");
  await writeFile(claimEvidencePath, "[]");
  return { directory, inventoryPath, policyPath, prsPath, claimsPath, claimEvidencePath, repository: "AquilaXk/easysubway-data" };
}

test("KRIC refresh decision reads the policy threshold and distinguishes NOT_DUE, DUE, and EXPIRED", async () => {
  const { decideCurrentKricFacilityRefresh } = await load();
  const input = await fixture();
  for (const [now, state] of [["2026-08-30T05:59:59.999Z", "NOT_DUE"], ["2026-08-30T06:00:00.000Z", "DUE"], ["2026-08-30T12:00:00.000Z", "EXPIRED"]]) {
    const result = await decideCurrentKricFacilityRefresh({ ...input, now: new Date(now) });
    assert.equal(result.state, state);
    assert.equal(result.alertBeforePackExpiry, "PT6H");
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
const kricEvidence = (runId, overrides = {}) => ({
  branch: `${PREFIX}${runId}`, runId: String(runId),
  run: { found: true, status: "completed", conclusion: "failure", workflowName: "KRIC Current Facility Refresh", headBranch: "main" },
  commits: { aheadBy: 1, subjects: ["Claim KRIC facility refresh"], changedFiles: 0 }, artifacts: [], ...overrides,
});
const withOutput = (runId) => kricEvidence(runId, { commits: { aheadBy: 2, subjects: ["Claim KRIC facility refresh", "Refresh KRIC facility snapshot"], changedFiles: 3 } });
const withReceipt = (runId) => kricEvidence(runId, { artifacts: [{ name: `kric-current-facility-refresh-${runId}`, expired: false }] });
const running = (runId) => kricEvidence(runId, { run: { found: true, status: "in_progress", conclusion: null, workflowName: "KRIC Current Facility Refresh", headBranch: "main" } });
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
    assert.deepEqual(await decideCurrentKricFacilityRefresh({ ...input, now: new Date(now) }), { state, alertBeforePackExpiry: "PT6H", cleanupClaims: [`${PREFIX}125`] }, state);
  }
  await evidenceFile(input, running(125));
  for (const now of ["2026-08-30T05:00:00.000Z", "2026-08-30T07:00:00.000Z"]) {
    assert.deepEqual(await decideCurrentKricFacilityRefresh({ ...input, now: new Date(now) }), { state: "CLAIM_IN_PROGRESS", alertBeforePackExpiry: "PT6H", branch: `${PREFIX}125`, cleanupClaims: [] }, now);
  }
  await evidenceFile(input);
  await assert.rejects(() => decideCurrentKricFacilityRefresh({ ...input, now: NOW }), /CLAIM_ORPHAN_EVIDENCE_MISSING/);
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
  await runCurrentKricFacilityRefreshDecision({ inventoryPath: input.inventoryPath, policyPath: input.policyPath, prsPath: input.prsPath, claimsPath: input.claimsPath, claimEvidencePath: input.claimEvidencePath, repository: input.repository, outputPath, githubOutputPath, now: NOW });
  const output = await readFile(outputPath, "utf8");
  assert.match(output, /"state": "RECOVER_CLAIM"/);
  assert.doesNotMatch(output, /https:\/\//);
  assert.equal(await readFile(githubOutputPath, "utf8"), `state=RECOVER_CLAIM\nbranch=${PREFIX}123\ncleanup_claims=${PREFIX}124\n`);
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
  assert.deepEqual(await decideCurrentKricFacilityRefresh({ ...input, now: new Date("2026-08-30T12:00:00.000Z") }), { state: "EXPIRED", alertBeforePackExpiry: "PT6H", cleanupClaims: [`${PREFIX}33931967736`] });
  assert.deepEqual(await decideCurrentKricFacilityRefresh({ ...input, now: NOW }), { state: "DUE", alertBeforePackExpiry: "PT6H", cleanupClaims: [`${PREFIX}33931967736`] });
  await writeFile(input.claimsPath, ref(33931967736) + ref(123));
  await evidenceFile(input, closed, withOutput(123));
  assert.deepEqual(await decideCurrentKricFacilityRefresh({ ...input, now: NOW }), { state: "RECOVER_CLAIM", alertBeforePackExpiry: "PT6H", branch: `${PREFIX}123`, cleanupClaims: [`${PREFIX}33931967736`] });
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
