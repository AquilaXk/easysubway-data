import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const modulePath = path.join(root, "tools/ci/decide-current-seoul-accessibility-refresh.mjs");
async function load() { return import(`${pathToFileURL(modulePath).href}?test=${Date.now()}`); }
async function fixture({ freshUntil = "2026-08-30T12:00:00.000Z" } = {}) { const directory = await mkdtemp(path.join(os.tmpdir(), "seoul-refresh-decision-")); const inventoryPath = path.join(directory, "inventory.json"); const policyPath = path.join(directory, "policy.json"); const prsPath = path.join(directory, "prs.json"); const claimsPath = path.join(directory, "claims.txt"); const claimEvidencePath = path.join(directory, "claim-evidence.json"); await writeFile(inventoryPath, JSON.stringify({ sources: [{ id: "seoul-metro-accessibility", accessibilityAdmissionEvidence: { freshUntil } }] })); await writeFile(policyPath, JSON.stringify({ monitoring: { alertBeforePackExpiry: "PT6H" } })); await writeFile(prsPath, "[]"); await writeFile(claimsPath, ""); await writeFile(claimEvidencePath, "[]"); return { directory, inventoryPath, policyPath, prsPath, claimsPath, claimEvidencePath, repository: "AquilaXk/easysubway-data", repositoryRoot: directory }; }
test("Seoul refresh decision distinguishes due states from the configured threshold", async () => { const { decideCurrentSeoulAccessibilityRefresh } = await load(); const input = await fixture(); for (const [now, state] of [["2026-08-30T05:59:59.999Z", "NOT_DUE"], ["2026-08-30T06:00:00.000Z", "DUE"], ["2026-08-30T12:00:00.000Z", "EXPIRED"]]) assert.equal((await decideCurrentSeoulAccessibilityRefresh({ ...input, now: new Date(now) })).state, state); });
const SEOUL_PREFIX = "automation/639-seoul-accessibility-refresh-";
const CLAIM_SUBJECT = "Claim Seoul accessibility refresh";
const claimRef = (runId) => `0123456789abcdef0123456789abcdef01234567\trefs/heads/${SEOUL_PREFIX}${runId}\n`;
const seoulEvidence = (runId, overrides = {}) => ({
  branch: `${SEOUL_PREFIX}${runId}`, runId: String(runId),
  run: { found: true, status: "completed", conclusion: "failure", workflowName: "Seoul Current Accessibility Refresh", headBranch: "main" },
  commits: { aheadBy: 1, subjects: [CLAIM_SUBJECT], changedFiles: 0 }, artifacts: [], ...overrides,
});
const withOutput = (runId) => seoulEvidence(runId, { commits: { aheadBy: 2, subjects: [CLAIM_SUBJECT, "Refresh Seoul accessibility snapshot"], changedFiles: 4 } });
const running = (runId) => seoulEvidence(runId, { run: { found: true, status: "in_progress", conclusion: null, workflowName: "Seoul Current Accessibility Refresh", headBranch: "main" } });
const seoulPr = (number, state, runId, input) => ({ number, state, isDraft: true, headRefName: `${SEOUL_PREFIX}${runId}`, baseRefName: "main", headRepository: { nameWithOwner: input.repository }, isCrossRepository: false });
const NOW = new Date("2026-08-30T07:00:00.000Z");
test("Seoul refresh decision accepts only a same-repository main PR and recovers one claim that carries output", async () => { const { decideCurrentSeoulAccessibilityRefresh } = await load(); const input = await fixture(); await writeFile(input.prsPath, JSON.stringify([seoulPr(1, "OPEN", 1, input)])); await writeFile(input.claimsPath, claimRef(1)); assert.deepEqual(await decideCurrentSeoulAccessibilityRefresh({ ...input, now: NOW }), { state: "OPEN_PR", alertBeforePackExpiry: "PT6H", cleanupClaims: [] }); await writeFile(input.prsPath, "[]"); await writeFile(input.claimEvidencePath, JSON.stringify([withOutput(1)])); assert.deepEqual(await decideCurrentSeoulAccessibilityRefresh({ ...input, now: NOW }), { state: "RECOVER_CLAIM", alertBeforePackExpiry: "PT6H", branch: `${SEOUL_PREFIX}1`, cleanupClaims: [] }); });

// #995: 빈 claim은 복구할 수 없다. 예전에는 DUE마다 RECOVER_CLAIM으로 보내 복구 step이 영구 실패했다.
test("an empty claim of a finished run is handed to cleanup in every due state instead of failing recovery forever", async () => {
  const { decideCurrentSeoulAccessibilityRefresh } = await load();
  const input = await fixture();
  await writeFile(input.claimsPath, claimRef(7));
  await writeFile(input.claimEvidencePath, JSON.stringify([seoulEvidence(7)]));
  for (const [now, state] of [["2026-08-30T05:59:59.999Z", "NOT_DUE"], ["2026-08-30T06:00:00.000Z", "DUE"], ["2026-08-30T12:00:00.000Z", "EXPIRED"]]) {
    assert.deepEqual(await decideCurrentSeoulAccessibilityRefresh({ ...input, now: new Date(now) }), { state, alertBeforePackExpiry: "PT6H", cleanupClaims: [`${SEOUL_PREFIX}7`] }, state);
  }
});

test("a claim that carries output is recovered and a running producer waits, whatever the due state", async () => {
  const { decideCurrentSeoulAccessibilityRefresh } = await load();
  const input = await fixture();
  await writeFile(input.claimsPath, claimRef(8));
  for (const now of ["2026-08-30T05:00:00.000Z", "2026-08-30T07:00:00.000Z"]) {
    await writeFile(input.claimEvidencePath, JSON.stringify([withOutput(8)]));
    assert.deepEqual(await decideCurrentSeoulAccessibilityRefresh({ ...input, now: new Date(now) }), { state: "RECOVER_CLAIM", alertBeforePackExpiry: "PT6H", branch: `${SEOUL_PREFIX}8`, cleanupClaims: [] }, now);
    await writeFile(input.claimEvidencePath, JSON.stringify([running(8)]));
    assert.deepEqual(await decideCurrentSeoulAccessibilityRefresh({ ...input, now: new Date(now) }), { state: "CLAIM_IN_PROGRESS", alertBeforePackExpiry: "PT6H", branch: `${SEOUL_PREFIX}8`, cleanupClaims: [] }, now);
  }
});

test("an abandoned claim is cleaned next to a recoverable one, two live claims are an anomaly, missing evidence is not guessed", async () => {
  const { decideCurrentSeoulAccessibilityRefresh } = await load();
  const input = await fixture();
  await writeFile(input.claimsPath, claimRef(9) + claimRef(10));
  await writeFile(input.claimEvidencePath, JSON.stringify([seoulEvidence(9), withOutput(10)]));
  assert.deepEqual(await decideCurrentSeoulAccessibilityRefresh({ ...input, now: NOW }), { state: "RECOVER_CLAIM", alertBeforePackExpiry: "PT6H", branch: `${SEOUL_PREFIX}10`, cleanupClaims: [`${SEOUL_PREFIX}9`] });
  await writeFile(input.claimEvidencePath, JSON.stringify([withOutput(9), running(10)]));
  await assert.rejects(() => decideCurrentSeoulAccessibilityRefresh({ ...input, now: NOW }), /duplicate Seoul refresh claims exist/);
  await writeFile(input.claimEvidencePath, JSON.stringify([seoulEvidence(9)]));
  await assert.rejects(() => decideCurrentSeoulAccessibilityRefresh({ ...input, now: NOW }), /CLAIM_ORPHAN_EVIDENCE_MISSING/);
});

test("a claim bound to a closed PR needs manual resolution and a merged leftover is ignored", async () => {
  const { decideCurrentSeoulAccessibilityRefresh } = await load();
  const input = await fixture();
  await writeFile(input.claimsPath, claimRef(11));
  await writeFile(input.prsPath, JSON.stringify([seoulPr(1, "CLOSED", 11, input)]));
  await assert.rejects(() => decideCurrentSeoulAccessibilityRefresh({ ...input, now: NOW }), /closed Seoul refresh claim requires manual resolution/);
  await writeFile(input.prsPath, JSON.stringify([seoulPr(1, "MERGED", 11, input)]));
  assert.deepEqual(await decideCurrentSeoulAccessibilityRefresh({ ...input, now: NOW }), { state: "DUE", alertBeforePackExpiry: "PT6H", cleanupClaims: [] });
});

test("the decision CLI writes the state, branch and cleanup claims", async () => {
  const { runCurrentSeoulAccessibilityRefreshDecision } = await load();
  const input = await fixture();
  await writeFile(input.claimsPath, claimRef(12) + claimRef(13));
  await writeFile(input.claimEvidencePath, JSON.stringify([seoulEvidence(12), withOutput(13)]));
  const outputPath = path.join(input.directory, "decision.json"); const githubOutputPath = path.join(input.directory, "github-output.txt");
  await runCurrentSeoulAccessibilityRefreshDecision({ ...input, outputPath, githubOutputPath, now: NOW });
  assert.equal(await readFile(githubOutputPath, "utf8"), `state=RECOVER_CLAIM\nbranch=${SEOUL_PREFIX}13\ncleanup_claims=${SEOUL_PREFIX}12\n`);
});
