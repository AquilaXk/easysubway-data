import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const modulePath = path.join(root, "tools/ci/decide-current-seoul-accessibility-refresh.mjs");
async function load() { return import(`${pathToFileURL(modulePath).href}?test=${Date.now()}`); }
async function fixture({ freshUntil = "2026-08-30T12:00:00.000Z" } = {}) { const directory = await mkdtemp(path.join(os.tmpdir(), "seoul-refresh-decision-")); const inventoryPath = path.join(directory, "inventory.json"); const policyPath = path.join(directory, "policy.json"); const prsPath = path.join(directory, "prs.json"); const claimsPath = path.join(directory, "claims.txt"); await writeFile(inventoryPath, JSON.stringify({ sources: [{ id: "seoul-metro-accessibility", accessibilityAdmissionEvidence: { freshUntil } }] })); await writeFile(policyPath, JSON.stringify({ monitoring: { alertBeforePackExpiry: "PT6H" } })); await writeFile(prsPath, "[]"); await writeFile(claimsPath, ""); return { inventoryPath, policyPath, prsPath, claimsPath, repository: "AquilaXk/easysubway-data", repositoryRoot: directory }; }
test("Seoul refresh decision distinguishes due states from the configured threshold", async () => { const { decideCurrentSeoulAccessibilityRefresh } = await load(); const input = await fixture(); for (const [now, state] of [["2026-08-30T05:59:59.999Z", "NOT_DUE"], ["2026-08-30T06:00:00.000Z", "DUE"], ["2026-08-30T12:00:00.000Z", "EXPIRED"]]) assert.equal((await decideCurrentSeoulAccessibilityRefresh({ ...input, now: new Date(now) })).state, state); });
test("Seoul refresh decision accepts only a same-repository main PR and recovers one claim", async () => { const { decideCurrentSeoulAccessibilityRefresh } = await load(); const input = await fixture(); await writeFile(input.prsPath, JSON.stringify([{ state: "OPEN", isDraft: true, headRefName: "automation/639-seoul-accessibility-refresh-1", baseRefName: "main", headRepository: { nameWithOwner: input.repository }, isCrossRepository: false }])); assert.equal((await decideCurrentSeoulAccessibilityRefresh({ ...input, now: new Date("2026-08-30T07:00:00.000Z") })).state, "OPEN_PR"); await writeFile(input.prsPath, "[]"); await writeFile(input.claimsPath, "0123456789abcdef0123456789abcdef01234567\trefs/heads/automation/639-seoul-accessibility-refresh-1\n"); assert.deepEqual(await decideCurrentSeoulAccessibilityRefresh({ ...input, now: new Date("2026-08-30T07:00:00.000Z") }), { state: "RECOVER_CLAIM", alertBeforePackExpiry: "PT6H", branch: "automation/639-seoul-accessibility-refresh-1" }); });

async function writeTransitionMarker(input, relative = "current-capital-accessibility-transition.json") {
  const marker = path.join(input.repositoryRoot, "tools/datapack/release", relative);
  await mkdir(path.dirname(marker), { recursive: true });
  await writeFile(marker, "{}\n");
  return marker;
}

test("a valid pending fan-in preempts Seoul due, PR, claim, and provider inputs", async () => {
  const { decideCurrentSeoulAccessibilityRefresh } = await load();
  const input = await fixture();
  input.repositoryRoot = path.dirname(input.inventoryPath);
  await writeTransitionMarker(input);
  assert.deepEqual(await decideCurrentSeoulAccessibilityRefresh({
    ...input,
    inventoryPath: path.join(input.repositoryRoot, "must-not-be-read.json"),
    readTransitionBoundary: async ({ repositoryRoot }) => {
      assert.equal(repositoryRoot, input.repositoryRoot);
      return { state: "PENDING_FULL_FAN_IN" };
    },
  }), { state: "PENDING_FULL_FAN_IN" });
});

test("an invalid pending fan-in fails closed before Seoul due and provider inputs", async () => {
  const { decideCurrentSeoulAccessibilityRefresh } = await load();
  const input = await fixture();
  input.repositoryRoot = path.dirname(input.inventoryPath);
  await writeTransitionMarker(input);
  await assert.rejects(() => decideCurrentSeoulAccessibilityRefresh({
    ...input,
    inventoryPath: path.join(input.repositoryRoot, "must-not-be-read.json"),
    readTransitionBoundary: async () => { throw new Error("transition candidate binding mismatch"); },
  }), /transition candidate binding mismatch/);
});

test("an orphan or dangling transition marker fails closed", async () => {
  const { decideCurrentSeoulAccessibilityRefresh } = await load();
  const input = await fixture();
  input.repositoryRoot = path.dirname(input.inventoryPath);
  await writeTransitionMarker(input, "current-capital-accessibility-transition-successor.json");
  await assert.rejects(
    () => decideCurrentSeoulAccessibilityRefresh(input),
    /successor has no base transition/,
  );
  const next = await fixture();
  next.repositoryRoot = path.dirname(next.inventoryPath);
  const marker = path.join(next.repositoryRoot, "tools/datapack/release/current-capital-accessibility-transition.json");
  await mkdir(path.dirname(marker), { recursive: true });
  await symlink("missing-transition.json", marker);
  await assert.rejects(
    () => decideCurrentSeoulAccessibilityRefresh(next),
    /regular non-symlink file/,
  );
});
