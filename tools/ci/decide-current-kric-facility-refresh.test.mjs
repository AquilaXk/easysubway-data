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
  await writeFile(input.claimsPath, "0123456789abcdef0123456789abcdef01234567\trefs/heads/automation/629-kric-facility-refresh-123\n");
  const recovered = await decideCurrentKricFacilityRefresh({ ...input, now: new Date("2026-08-30T07:00:00.000Z") });
  assert.deepEqual(recovered, { state: "RECOVER_CLAIM", alertBeforePackExpiry: "PT6H", branch: "automation/629-kric-facility-refresh-123" });
  await writeFile(input.claimsPath, "0123456789abcdef0123456789abcdef01234567\trefs/heads/automation/629-kric-facility-refresh-123\n89abcdef0123456789abcdef0123456789abcdef\trefs/heads/automation/629-kric-facility-refresh-124\n");
  await assert.rejects(() => decideCurrentKricFacilityRefresh({ ...input, now: new Date("2026-08-30T07:00:00.000Z") }), /duplicate/);
  await writeFile(input.claimsPath, "not-a-ref\n");
  await assert.rejects(() => decideCurrentKricFacilityRefresh({ ...input, now: new Date("2026-08-30T07:00:00.000Z") }), /claim/);
});

test("terminal historical claims do not block the next due refresh", async () => {
  const { decideCurrentKricFacilityRefresh } = await load();
  const input = await fixture();
  const branch = "automation/629-kric-facility-refresh-122";
  await writeFile(input.claimsPath, `0123456789abcdef0123456789abcdef01234567\trefs/heads/${branch}\n`);
  await writeFile(input.prsPath, JSON.stringify([{ number: 628, state: "MERGED", isDraft: false, headRefName: branch, baseRefName: "main", headRepository: { nameWithOwner: input.repository }, isCrossRepository: false }]));
  assert.equal((await decideCurrentKricFacilityRefresh({ ...input, now: new Date("2026-08-30T07:00:00.000Z") })).state, "DUE");
  await writeFile(input.claimsPath, `0123456789abcdef0123456789abcdef01234567\trefs/heads/${branch}\n89abcdef0123456789abcdef0123456789abcdef\trefs/heads/automation/629-kric-facility-refresh-123\n`);
  assert.equal((await decideCurrentKricFacilityRefresh({ ...input, now: new Date("2026-08-30T07:00:00.000Z") })).state, "RECOVER_CLAIM");
  await writeFile(input.claimsPath, `0123456789abcdef0123456789abcdef01234567\trefs/heads/${branch}\n`);
  await writeFile(input.prsPath, JSON.stringify([{ number: 628, state: "CLOSED", isDraft: true, headRefName: branch, baseRefName: "main", headRepository: { nameWithOwner: input.repository }, isCrossRepository: false }]));
  assert.equal((await decideCurrentKricFacilityRefresh({ ...input, now: new Date("2026-08-30T07:00:00.000Z") })).state, "DUE");
});

test("decision CLI writes sanitized JSON and GitHub outputs without PR URLs", async () => {
  const input = await fixture();
  const outputPath = path.join(input.directory, "decision.json");
  const githubOutputPath = path.join(input.directory, "github-output.txt");
  const { runCurrentKricFacilityRefreshDecision } = await load();
  await runCurrentKricFacilityRefreshDecision({ inventoryPath: input.inventoryPath, policyPath: input.policyPath, prsPath: input.prsPath, claimsPath: input.claimsPath, repository: input.repository, outputPath, githubOutputPath, now: new Date("2026-08-30T07:00:00.000Z") });
  const output = await readFile(outputPath, "utf8");
  assert.match(output, /"state": "DUE"/);
  assert.doesNotMatch(output, /https:\/\//);
  assert.match(await readFile(githubOutputPath, "utf8"), /^state=DUE$/m);
});
