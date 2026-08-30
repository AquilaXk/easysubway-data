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
  await writeFile(inventoryPath, JSON.stringify({ sources: [{ id: "kric-station-convenience-standard", accessibilityAdmissionEvidence: { freshUntil } }] }));
  await writeFile(policyPath, JSON.stringify({ monitoring: { alertBeforePackExpiry: policy } }));
  await writeFile(prsPath, "[]");
  return { directory, inventoryPath, policyPath, prsPath };
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

test("KRIC refresh decision suppresses provider work for one open automation PR and rejects malformed identity", async () => {
  const { decideCurrentKricFacilityRefresh } = await load();
  const input = await fixture();
  await writeFile(input.prsPath, JSON.stringify([{ number: 629, headRefName: "automation/629-kric-facility-refresh-123", url: "https://example.test/pr/629" }]));
  assert.equal((await decideCurrentKricFacilityRefresh({ ...input, now: new Date("2026-08-30T07:00:00.000Z") })).state, "OPEN_PR");
  await writeFile(input.prsPath, JSON.stringify([{ number: 630, headRefName: "automation/629-kric-facility-refresh-1", url: "https://example.test/a" }, { number: 631, headRefName: "automation/629-kric-facility-refresh-2", url: "https://example.test/b" }]));
  await assert.rejects(() => decideCurrentKricFacilityRefresh({ ...input, now: new Date("2026-08-30T07:00:00.000Z") }), /duplicate/);
});

test("decision CLI writes sanitized JSON and GitHub outputs without PR URLs", async () => {
  const input = await fixture();
  const outputPath = path.join(input.directory, "decision.json");
  const githubOutputPath = path.join(input.directory, "github-output.txt");
  const { runCurrentKricFacilityRefreshDecision } = await load();
  await runCurrentKricFacilityRefreshDecision({ inventoryPath: input.inventoryPath, policyPath: input.policyPath, prsPath: input.prsPath, outputPath, githubOutputPath, now: new Date("2026-08-30T07:00:00.000Z") });
  const output = await readFile(outputPath, "utf8");
  assert.match(output, /"state": "DUE"/);
  assert.doesNotMatch(output, /https:\/\//);
  assert.match(await readFile(githubOutputPath, "utf8"), /^state=DUE$/m);
});
