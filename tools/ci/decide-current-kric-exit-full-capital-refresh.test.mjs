import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const modulePath = path.join(root, "tools/ci/decide-current-kric-exit-full-capital-refresh.mjs");
const repository = "AquilaXk/easysubway-data";
const sourcePath = "tools/datapack/sources/kric-station-convenience-standard-fixture.json";
const facilityPaths = [
  "tools/datapack/release/candidate-build-spec.json",
  "tools/datapack/release/current-capital-facility-source-admission.json",
  "tools/datapack/release/source-snapshots.json",
  "tools/datapack/source-inventory.json",
  "tools/datapack/release/release-request.json",
  "tools/datapack/release/hash-evidence.json",
  sourcePath,
];

async function load() { return import(`${pathToFileURL(modulePath).href}?test=${Date.now()}`); }

async function fixture({ freshUntil = "2026-08-30T12:00:00.000Z" } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "kric-exit-full-capital-refresh-"));
  const inventoryPath = path.join(directory, "inventory.json");
  const policyPath = path.join(directory, "policy.json");
  const prsPath = path.join(directory, "prs.json");
  const claimsPath = path.join(directory, "claims.txt");
  const claimEvidencePath = path.join(directory, "claim-evidence.json");
  const facilityPrsPath = path.join(directory, "facility-prs.json");
  await Promise.all([
    writeFile(inventoryPath, JSON.stringify({ sourceIdentity: { sourceId: "kric-station-movement-standard", freshUntil } })),
    writeFile(policyPath, JSON.stringify({ monitoring: { alertBeforePackExpiry: "PT6H" } })),
    writeFile(prsPath, "[]"),
    writeFile(claimsPath, ""),
    writeFile(claimEvidencePath, "[]"),
    writeFile(facilityPrsPath, JSON.stringify([facilityPullRequest()])),
  ]);
  return {
    directory, inventoryPath, policyPath, prsPath, claimsPath, claimEvidencePath,
    currentMainSha: "b".repeat(40), facilityPrsPath, repository,
  };
}

function claimEvidence({
  sha = "c".repeat(40),
  branch = "automation/6-kric-exit-full-capital-refresh-123",
  parentSha = "b".repeat(40),
  commitCount = 1,
  subject = "Claim KRIC EXIT full-capital refresh",
} = {}) {
  return { sha, branch, parentSha, commitCount, subject };
}

function facilityPullRequest({ files = facilityPaths, headRefOid = "a".repeat(40) } = {}) {
  return {
    number: 629,
    state: "OPEN",
    isDraft: true,
    baseRefName: "main",
    isCrossRepository: false,
    headRepository: { nameWithOwner: repository },
    headRefName: "automation/629-kric-facility-refresh-123",
    headRefOid,
    files: files.map((file) => ({ path: file })),
  };
}

test("EXIT decision binds due work to exactly one complete same-repository FACILITY Draft PR", async () => {
  const { decideCurrentKricExitFullCapitalRefresh } = await load();
  const input = await fixture();
  const result = await decideCurrentKricExitFullCapitalRefresh({ ...input, now: new Date("2026-08-30T07:00:00.000Z") });
  assert.deepEqual(result, {
    state: "DUE",
    alertBeforePackExpiry: "PT6H",
    facilityBranch: "automation/629-kric-facility-refresh-123",
    facilityHeadSha: "a".repeat(40),
  });
});

test("EXIT decision rejects an incomplete, overbroad, duplicated, or ambiguous FACILITY selection", async () => {
  const { decideCurrentKricExitFullCapitalRefresh } = await load();
  const input = await fixture();
  for (const files of [
    facilityPaths.filter((file) => !file.endsWith("release-request.json")),
    facilityPaths.filter((file) => !file.endsWith("hash-evidence.json")),
    [...facilityPaths, "tools/datapack/sources/kric-station-convenience-standard-extra.json"],
    [...facilityPaths, "README.md"],
  ]) {
    await writeFile(input.facilityPrsPath, JSON.stringify([facilityPullRequest({ files })]));
    await assert.rejects(
      () => decideCurrentKricExitFullCapitalRefresh({ ...input, now: new Date("2026-08-30T07:00:00.000Z") }),
      /exactly one validated same-repository FACILITY pull request is required/,
    );
  }
  await writeFile(input.facilityPrsPath, JSON.stringify([facilityPullRequest(), facilityPullRequest({ headRefOid: "b".repeat(40) })]));
  await assert.rejects(
    () => decideCurrentKricExitFullCapitalRefresh({ ...input, now: new Date("2026-08-30T07:00:00.000Z") }),
    /exactly one validated same-repository FACILITY pull request is required/,
  );
});

test("EXIT decision stops new work behind an open EXIT PR and carries the validated FACILITY binding into recovery", async () => {
  const { decideCurrentKricExitFullCapitalRefresh } = await load();
  const input = await fixture();
  await writeFile(input.prsPath, JSON.stringify([{
    state: "OPEN", isDraft: true, headRefName: "automation/6-kric-exit-full-capital-refresh-1",
    baseRefName: "main", headRepository: { nameWithOwner: repository }, isCrossRepository: false,
  }]));
  assert.deepEqual(
    await decideCurrentKricExitFullCapitalRefresh({ ...input, now: new Date("2026-08-30T07:00:00.000Z") }),
    { state: "OPEN_PR", alertBeforePackExpiry: "PT6H" },
  );
  await writeFile(input.prsPath, "[]");
  const branch = "automation/6-kric-exit-full-capital-refresh-123";
  await writeFile(input.claimsPath, `${"c".repeat(40)}\trefs/heads/${branch}\n`);
  await writeFile(input.claimEvidencePath, JSON.stringify([claimEvidence()]));
  assert.deepEqual(
    await decideCurrentKricExitFullCapitalRefresh({ ...input, now: new Date("2026-08-30T07:00:00.000Z") }),
    { state: "RECOVER_CLAIM", alertBeforePackExpiry: "PT6H", branch, facilityBranch: "automation/629-kric-facility-refresh-123", facilityHeadSha: "a".repeat(40) },
  );
});

test("EXIT decision recovers only an exact canonical claim directly parented by current main", async () => {
  const { decideCurrentKricExitFullCapitalRefresh } = await load();
  const input = await fixture();
  const branch = "automation/6-kric-exit-full-capital-refresh-123";
  await writeFile(input.claimsPath, `${"c".repeat(40)}\trefs/heads/${branch}\n`);
  await writeFile(input.claimEvidencePath, JSON.stringify([claimEvidence()]));
  assert.deepEqual(
    await decideCurrentKricExitFullCapitalRefresh({ ...input, now: new Date("2026-08-30T07:00:00.000Z") }),
    { state: "RECOVER_CLAIM", alertBeforePackExpiry: "PT6H", branch, facilityBranch: "automation/629-kric-facility-refresh-123", facilityHeadSha: "a".repeat(40) },
  );

  await writeFile(input.claimEvidencePath, JSON.stringify([claimEvidence({ parentSha: "d".repeat(40) })]));
  assert.deepEqual(
    await decideCurrentKricExitFullCapitalRefresh({ ...input, now: new Date("2026-08-30T07:00:00.000Z") }),
    { state: "DUE", alertBeforePackExpiry: "PT6H", facilityBranch: "automation/629-kric-facility-refresh-123", facilityHeadSha: "a".repeat(40) },
  );
});

test("EXIT decision fails closed for malformed or duplicate current-main claim evidence", async () => {
  const { decideCurrentKricExitFullCapitalRefresh } = await load();
  const input = await fixture();
  const firstBranch = "automation/6-kric-exit-full-capital-refresh-123";
  const secondBranch = "automation/6-kric-exit-full-capital-refresh-456";
  await writeFile(input.claimsPath, `${"c".repeat(40)}\trefs/heads/${firstBranch}\n`);
  await writeFile(input.claimEvidencePath, JSON.stringify([{ ...claimEvidence(), subject: "Unexpected claim subject" }]));
  await assert.rejects(
    () => decideCurrentKricExitFullCapitalRefresh({ ...input, now: new Date("2026-08-30T07:00:00.000Z") }),
    /EXIT full-capital refresh claim evidence is invalid/,
  );

  await writeFile(input.claimsPath, `${"c".repeat(40)}\trefs/heads/${firstBranch}\n${"d".repeat(40)}\trefs/heads/${secondBranch}\n`);
  await writeFile(input.claimEvidencePath, JSON.stringify([
    claimEvidence(),
    claimEvidence({ sha: "d".repeat(40), branch: secondBranch }),
  ]));
  await assert.rejects(
    () => decideCurrentKricExitFullCapitalRefresh({ ...input, now: new Date("2026-08-30T07:00:00.000Z") }),
    /duplicate current-main EXIT full-capital refresh claims exist/,
  );
});

test("EXIT decision CLI writes only state and immutable FACILITY identity", async () => {
  const { runCurrentKricExitFullCapitalRefreshDecision } = await load();
  const input = await fixture();
  const outputPath = path.join(input.directory, "decision.json");
  const githubOutputPath = path.join(input.directory, "github-output.txt");
  await runCurrentKricExitFullCapitalRefreshDecision({ ...input, outputPath, githubOutputPath, now: new Date("2026-08-30T07:00:00.000Z") });
  assert.match(await readFile(outputPath, "utf8"), /"facilityHeadSha": "a{40}"/);
  assert.match(await readFile(githubOutputPath, "utf8"), /^facility_branch=automation\/629-kric-facility-refresh-123$/m);
  assert.match(await readFile(githubOutputPath, "utf8"), /^facility_head_sha=a{40}$/m);
});
