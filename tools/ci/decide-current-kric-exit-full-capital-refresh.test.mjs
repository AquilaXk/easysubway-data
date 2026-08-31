import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const modulePath = path.join(root, "tools/ci/decide-current-kric-exit-full-capital-refresh.mjs");
const repository = "AquilaXk/easysubway-data";

async function load() { return import(`${pathToFileURL(modulePath).href}?test=${Date.now()}`); }

async function fixture({ freshUntil = "2026-08-30T12:00:00.000Z" } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "kric-exit-full-capital-refresh-"));
  const inventoryPath = path.join(directory, "inventory.json");
  const policyPath = path.join(directory, "policy.json");
  const prsPath = path.join(directory, "prs.json");
  const claimsPath = path.join(directory, "claims.txt");
  await writeFile(inventoryPath, JSON.stringify({ sourceIdentity: { sourceId: "kric-station-movement-standard", freshUntil } }));
  await writeFile(policyPath, JSON.stringify({ monitoring: { alertBeforePackExpiry: "PT6H" } }));
  await writeFile(prsPath, "[]");
  await writeFile(claimsPath, "");
  return { directory, inventoryPath, policyPath, prsPath, claimsPath, repository };
}

test("EXIT full-capital refresh decides NOT_DUE, DUE, and EXPIRED from canonical sourceIdentity freshness", async () => {
  const { decideCurrentKricExitFullCapitalRefresh } = await load();
  const input = await fixture();
  for (const [now, state] of [["2026-08-30T05:59:59.999Z", "NOT_DUE"], ["2026-08-30T06:00:00.000Z", "DUE"], ["2026-08-30T12:00:00.000Z", "EXPIRED"]]) {
    assert.deepEqual(await decideCurrentKricExitFullCapitalRefresh({ ...input, now: new Date(now) }), { state, alertBeforePackExpiry: "PT6H" });
  }
});

test("EXIT full-capital refresh admits only one same-repository main automation PR", async () => {
  const { decideCurrentKricExitFullCapitalRefresh } = await load();
  const input = await fixture();
  await writeFile(input.prsPath, JSON.stringify([
    { state: "OPEN", isDraft: true, headRefName: "automation/6-kric-exit-full-capital-refresh-1", baseRefName: "main", headRepository: { nameWithOwner: "other/fork" }, isCrossRepository: true },
    { state: "OPEN", isDraft: true, headRefName: "automation/6-kric-exit-full-capital-refresh-2", baseRefName: "release", headRepository: { nameWithOwner: repository }, isCrossRepository: false },
  ]));
  assert.equal((await decideCurrentKricExitFullCapitalRefresh({ ...input, now: new Date("2026-08-30T07:00:00.000Z") })).state, "DUE");
  await writeFile(input.prsPath, JSON.stringify([{ state: "OPEN", isDraft: true, headRefName: "automation/6-kric-exit-full-capital-refresh-3", baseRefName: "main", headRepository: { nameWithOwner: repository }, isCrossRepository: false }]));
  assert.equal((await decideCurrentKricExitFullCapitalRefresh({ ...input, now: new Date("2026-08-30T07:00:00.000Z") })).state, "OPEN_PR");
  await writeFile(input.prsPath, JSON.stringify([{ state: "OPEN", isDraft: true, headRefName: "automation/6-kric-exit-full-capital-refresh-3", baseRefName: "main", headRepository: { nameWithOwner: repository }, isCrossRepository: false }, { state: "OPEN", isDraft: true, headRefName: "automation/6-kric-exit-full-capital-refresh-4", baseRefName: "main", headRepository: { nameWithOwner: repository }, isCrossRepository: false }]));
  await assert.rejects(() => decideCurrentKricExitFullCapitalRefresh({ ...input, now: new Date("2026-08-30T07:00:00.000Z") }), /duplicate/);
});

test("EXIT full-capital refresh recovers exactly one durable completed claim before any provider operation", async () => {
  const { decideCurrentKricExitFullCapitalRefresh } = await load();
  const input = await fixture();
  const branch = "automation/6-kric-exit-full-capital-refresh-123";
  await writeFile(input.claimsPath, `0123456789abcdef0123456789abcdef01234567\trefs/heads/${branch}\n`);
  assert.deepEqual(await decideCurrentKricExitFullCapitalRefresh({ ...input, now: new Date("2026-08-30T07:00:00.000Z") }), { state: "RECOVER_CLAIM", alertBeforePackExpiry: "PT6H", branch });
  await writeFile(input.claimsPath, `0123456789abcdef0123456789abcdef01234567\trefs/heads/${branch}\n89abcdef0123456789abcdef0123456789abcdef\trefs/heads/automation/6-kric-exit-full-capital-refresh-124\n`);
  await assert.rejects(() => decideCurrentKricExitFullCapitalRefresh({ ...input, now: new Date("2026-08-30T07:00:00.000Z") }), /duplicate/);
});

test("EXIT full-capital refresh CLI writes only a sanitized decision", async () => {
  const { runCurrentKricExitFullCapitalRefreshDecision } = await load();
  const input = await fixture();
  const outputPath = path.join(input.directory, "decision.json");
  const githubOutputPath = path.join(input.directory, "github-output.txt");
  await runCurrentKricExitFullCapitalRefreshDecision({ ...input, outputPath, githubOutputPath, now: new Date("2026-08-30T07:00:00.000Z") });
  assert.match(await readFile(outputPath, "utf8"), /"state": "DUE"/);
  assert.match(await readFile(githubOutputPath, "utf8"), /^state=DUE$/m);
});
