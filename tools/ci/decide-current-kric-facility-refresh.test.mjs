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
  await writeFile(inventoryPath, JSON.stringify({ sources: [{ id: "kric-station-convenience-standard", accessibilityAdmissionEvidence: { freshUntil } }] }));
  await writeFile(policyPath, JSON.stringify({ monitoring: { alertBeforePackExpiry: policy } }));
  await writeFile(prsPath, "[]");
  await writeFile(claimsPath, "");
  return { directory, inventoryPath, policyPath, prsPath, claimsPath, repository: "AquilaXk/easysubway-data" };
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

test("KRIC refresh decision recovers exactly one durable remote claim before provider work", async () => {
  const { decideCurrentKricFacilityRefresh } = await load();
  const input = await fixture();
  await writeFile(input.claimsPath, "0123456789abcdef0123456789abcdef01234567\trefs/heads/automation/629-kric-facility-refresh-123\tClaim KRIC facility refresh\n");
  const recovered = await decideCurrentKricFacilityRefresh({ ...input, now: new Date("2026-08-30T07:00:00.000Z") });
  assert.deepEqual(recovered, { state: "RECOVER_CLAIM", alertBeforePackExpiry: "PT6H", branch: "automation/629-kric-facility-refresh-123" });
  await writeFile(input.claimsPath, "0123456789abcdef0123456789abcdef01234567\trefs/heads/automation/629-kric-facility-refresh-123\tClaim KRIC facility refresh\n89abcdef0123456789abcdef0123456789abcdef\trefs/heads/automation/629-kric-facility-refresh-124\tClaim KRIC facility refresh\n");
  await assert.rejects(() => decideCurrentKricFacilityRefresh({ ...input, now: new Date("2026-08-30T07:00:00.000Z") }), /duplicate/);
  await writeFile(input.claimsPath, "not-a-ref\n");
  await assert.rejects(() => decideCurrentKricFacilityRefresh({ ...input, now: new Date("2026-08-30T07:00:00.000Z") }), /claim/);
});

test("terminal historical claims ignore merged history and fail closed on closed claims", async () => {
  const { decideCurrentKricFacilityRefresh } = await load();
  const input = await fixture();
  const branch = "automation/629-kric-facility-refresh-122";
  await writeFile(input.claimsPath, `0123456789abcdef0123456789abcdef01234567\trefs/heads/${branch}\tRefresh KRIC facility snapshot\n`);
  await writeFile(input.prsPath, JSON.stringify([{ number: 628, state: "MERGED", isDraft: false, headRefName: branch, baseRefName: "main", headRepository: { nameWithOwner: input.repository }, isCrossRepository: false }]));
  assert.equal((await decideCurrentKricFacilityRefresh({ ...input, now: new Date("2026-08-30T07:00:00.000Z") })).state, "DUE");
  await writeFile(input.claimsPath, `0123456789abcdef0123456789abcdef01234567\trefs/heads/${branch}\tRefresh KRIC facility snapshot\n89abcdef0123456789abcdef0123456789abcdef\trefs/heads/automation/629-kric-facility-refresh-123\tClaim KRIC facility refresh\n`);
  assert.equal((await decideCurrentKricFacilityRefresh({ ...input, now: new Date("2026-08-30T07:00:00.000Z") })).state, "RECOVER_CLAIM");
  await writeFile(input.claimsPath, `0123456789abcdef0123456789abcdef01234567\trefs/heads/${branch}\tRefresh KRIC facility snapshot\n`);
  await writeFile(input.prsPath, JSON.stringify([{ number: 628, state: "CLOSED", isDraft: true, headRefName: branch, baseRefName: "main", headRepository: { nameWithOwner: input.repository }, isCrossRepository: false }]));
  await assert.rejects(
    () => decideCurrentKricFacilityRefresh({ ...input, now: new Date("2026-08-30T07:00:00.000Z") }),
    /requires manual resolution/,
  );
  await writeFile(input.claimsPath, `0123456789abcdef0123456789abcdef01234567\trefs/heads/${branch}\tRefresh KRIC facility snapshot\n89abcdef0123456789abcdef0123456789abcdef\trefs/heads/automation/629-kric-facility-refresh-123\tClaim KRIC facility refresh\n`);
  await assert.rejects(
    () => decideCurrentKricFacilityRefresh({ ...input, now: new Date("2026-08-30T07:00:00.000Z") }),
    /duplicate|ambiguous/,
  );
});

test("decision CLI writes only the generic recovery state and branch", async () => {
  const input = await fixture();
  const branch = "automation/629-kric-facility-refresh-123";
  await writeFile(input.claimsPath, `0123456789abcdef0123456789abcdef01234567\trefs/heads/${branch}\tRefresh KRIC facility snapshot\n`);
  const outputPath = path.join(input.directory, "decision.json");
  const githubOutputPath = path.join(input.directory, "github-output.txt");
  const { runCurrentKricFacilityRefreshDecision } = await load();
  await runCurrentKricFacilityRefreshDecision({ inventoryPath: input.inventoryPath, policyPath: input.policyPath, prsPath: input.prsPath, claimsPath: input.claimsPath, repository: input.repository, outputPath, githubOutputPath, now: new Date("2026-08-30T07:00:00.000Z") });
  const output = await readFile(outputPath, "utf8");
  assert.match(output, /"state": "RECOVER_CLAIM"/);
  assert.doesNotMatch(output, /https:\/\//);
  assert.equal(
    await readFile(githubOutputPath, "utf8"),
    `state=RECOVER_CLAIM\nbranch=${branch}\n`,
  );
});

test("claim refs must carry their head commit subject", async () => {
  const { decideCurrentKricFacilityRefresh } = await load();
  const input = await fixture();
  await writeFile(input.claimsPath, "0123456789abcdef0123456789abcdef01234567\trefs/heads/automation/629-kric-facility-refresh-123\n");
  await assert.rejects(() => decideCurrentKricFacilityRefresh({ ...input, now: new Date("2026-08-30T07:00:00.000Z") }), /KRIC refresh claim is invalid/);
});

test("an abandoned claim is closed out and no longer selected for recovery", async () => {
  const { decideCurrentKricFacilityRefresh, ABANDONED_CLAIM_SUBJECT } = await load();
  assert.equal(ABANDONED_CLAIM_SUBJECT, "Abandon KRIC facility refresh claim");
  const input = await fixture();
  const abandoned = `0123456789abcdef0123456789abcdef01234567\trefs/heads/automation/629-kric-facility-refresh-33931967736\t${ABANDONED_CLAIM_SUBJECT}\n`;
  await writeFile(input.claimsPath, abandoned);
  assert.equal((await decideCurrentKricFacilityRefresh({ ...input, now: new Date("2026-08-30T12:00:00.000Z") })).state, "EXPIRED");
  assert.equal((await decideCurrentKricFacilityRefresh({ ...input, now: new Date("2026-08-30T07:00:00.000Z") })).state, "DUE");
  await writeFile(input.claimsPath, `${abandoned}89abcdef0123456789abcdef0123456789abcdef\trefs/heads/automation/629-kric-facility-refresh-123\tClaim KRIC facility refresh\n`);
  assert.deepEqual(await decideCurrentKricFacilityRefresh({ ...input, now: new Date("2026-08-30T07:00:00.000Z") }),
    { state: "RECOVER_CLAIM", alertBeforePackExpiry: "PT6H", branch: "automation/629-kric-facility-refresh-123" });
  await writeFile(input.claimsPath, abandoned);
  await writeFile(input.prsPath, JSON.stringify([{ number: 700, state: "CLOSED", isDraft: true, headRefName: "automation/629-kric-facility-refresh-33931967736", baseRefName: "main", headRepository: { nameWithOwner: input.repository }, isCrossRepository: false }]));
  await assert.rejects(() => decideCurrentKricFacilityRefresh({ ...input, now: new Date("2026-08-30T07:00:00.000Z") }), /abandoned KRIC refresh claim has a pull request/);
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
