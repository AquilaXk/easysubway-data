import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildCurrentStaticSourceRevalidation, writeCurrentStaticSourceRevalidation } from "./revalidate-current-static-network-sources.mjs";
import { registerSeoulmetroStationLineInfo } from "./register-seoulmetro-station-line-info.mjs";
import { buildSnapshotDiff, validateLineage } from "./source-snapshot-policy.mjs";

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "../..");
const SOURCE_ID = "seoulmetro-station-line-info";
const HEAD = "c".repeat(40);
const INPUTS = [
  "tools/datapack/source-inventory.json",
  "tools/datapack/release/source-snapshots.json",
  "tools/datapack/source-governance-policy.json",
  "release/product-gates/datapack-freshness-sla.json",
];
const sha = (value) => createHash("sha256").update(value).digest("hex");
const gitRunner = async (args) => (args[0] === "rev-parse" ? `${HEAD}\n` : "");

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "seoulmetro-line-info-repo-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "seoulmetro-line-info-op-"));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]));
  for (const relative of INPUTS) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await cp(path.join(REPOSITORY_ROOT, relative), path.join(root, relative));
  }
  const ledger = JSON.parse(await readFile(path.join(root, INPUTS[1]), "utf8"));
  const head = ledger.find(({ snapshotId }) => snapshotId === validateLineage(ledger).headsBySource[SOURCE_ID]);
  return { root, outside, ledger, head };
}

function providerResponse(rows) {
  return Buffer.from(JSON.stringify({ SearchSTNBySubwayLineInfo: { list_total_count: 5, RESULT: { CODE: "INFO-000", MESSAGE: "ok" }, row: rows } }));
}

// head의 canonical 5행을 응답으로 되돌릴 수 없으므로(해시만 원장에 있음), 테스트 원장 head를 테스트 응답 기준으로 다시 봉인한다.
async function resealHeadToResponse(root, head, rows) {
  const records = rows.map((row) => Object.fromEntries([["line", row.LINE_NUM], ["station_code", row.STATION_CD], ["station_name", row.STATION_NM]].sort(([a], [b]) => (a < b ? -1 : 1))));
  const ledgerPath = path.join(root, INPUTS[1]);
  const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
  const row = ledger.find(({ snapshotId }) => snapshotId === head.snapshotId);
  row.rawSha256 = sha(Buffer.from(`${JSON.stringify(records)}\n`));
  row.providerRecordHashes = records.map((record) => sha(JSON.stringify(record)));
  row.diffSummary = buildSnapshotDiff(ledger.find(({ snapshotId }) => snapshotId === row.previousSnapshotId), row);
  await writeFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
  const inventoryPath = path.join(root, INPUTS[0]);
  const inventory = JSON.parse(await readFile(inventoryPath, "utf8"));
  inventory.sources.find(({ id }) => id === SOURCE_ID).admissionEvidence.rawSha256 = row.rawSha256;
  await writeFile(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`);
  return ledger;
}

const ROWS = Array.from({ length: 5 }, (_, index) => ({
  FR_CODE: `4${10 + index}`, LINE_NUM: "04호선", STATION_CD: `04${10 + index}`, STATION_NM: `역${index + 1}`,
  STATION_NM_CHN: "站", STATION_NM_ENG: "Station", STATION_NM_JPN: "駅",
}));

async function revalidated(root, outside, ledger, observedAt) {
  const result = buildCurrentStaticSourceRevalidation({ sourceSnapshots: ledger, observedAt, responseBytesBySource: { seoul: providerResponse(ROWS) } });
  const directory = path.join(outside, `revalidation-${observedAt.replaceAll(/[-:.]/gu, "")}`);
  await writeCurrentStaticSourceRevalidation({ outputDirectory: directory, result });
  return { directory, result };
}

test("registrar appends one policy-bound revalidated head with credentialRedacted and rebinds inventory admission (#862 3a)", async (t) => {
  const { root, outside, head } = await fixture(t);
  const ledger = await resealHeadToResponse(root, head, ROWS);
  const now = new Date(Date.parse(head.retrievedAt) + 40 * 24 * 60 * 60 * 1_000);
  const observedAt = new Date(now.getTime() - 60_000).toISOString();
  const { directory, result } = await revalidated(root, outside, ledger, observedAt);
  const before = Object.fromEntries(await Promise.all(INPUTS.map(async (relative) => [relative, await readFile(path.join(root, relative))])));

  await registerSeoulmetroStationLineInfo({ repositoryRoot: root, revalidationDirectory: directory, expectedHeadSha: HEAD, gitRunner, now });

  const nextLedger = JSON.parse(await readFile(path.join(root, INPUTS[1]), "utf8"));
  assert.equal(nextLedger.length, ledger.length + 1);
  const row = nextLedger.at(-1);
  assert.equal(validateLineage(nextLedger).headsBySource[SOURCE_ID], row.snapshotId);
  assert.equal(row.snapshotId, result[0].snapshot.snapshotId);
  assert.equal(row.previousSnapshotId, head.snapshotId);
  assert.equal(row.credentialRedacted, true);
  assert.equal(row.licenseStatus, "PASS");
  assert.equal(row.freshnessExpiresAt, new Date(Date.parse(observedAt) + 30 * 24 * 60 * 60 * 1_000).toISOString());
  assert.ok(Date.parse(row.freshnessExpiresAt) > now.getTime());
  assert.equal(row.revalidationEvidenceSha256, result[0].evidence.evidenceSha256);
  assert.equal(row.governancePolicySha256, sha(before[INPUTS[2]]));
  const inventory = JSON.parse(await readFile(path.join(root, INPUTS[0]), "utf8"));
  const evidence = inventory.sources.find(({ id }) => id === SOURCE_ID).admissionEvidence;
  assert.equal(evidence.snapshotId, row.snapshotId);
  assert.equal(evidence.revalidatedAt, observedAt);
  assert.equal(evidence.revalidationEvidenceSha256, row.revalidationEvidenceSha256);
  assert.equal(evidence.revalidationResponseSha256, result[0].evidence.responseSha256);
  assert.deepEqual(await readFile(path.join(root, INPUTS[2])), before[INPUTS[2]]);
  assert.deepEqual(await readFile(path.join(root, INPUTS[3])), before[INPUTS[3]]);
});

test("registrar fails closed on HEAD mismatch, tampered evidence, stale observation, or expired license review (#862 3a)", async (t) => {
  const { root, outside, head } = await fixture(t);
  const ledger = await resealHeadToResponse(root, head, ROWS);
  const now = new Date(Date.parse(head.retrievedAt) + 40 * 24 * 60 * 60 * 1_000);
  const observedAt = new Date(now.getTime() - 60_000).toISOString();
  const { directory } = await revalidated(root, outside, ledger, observedAt);
  const ledgerBytes = await readFile(path.join(root, INPUTS[1]));
  const register = (overrides = {}) => registerSeoulmetroStationLineInfo({ repositoryRoot: root, revalidationDirectory: directory, expectedHeadSha: HEAD, gitRunner, now, ...overrides });

  await assert.rejects(register({ expectedHeadSha: "d".repeat(40) }), /execution HEAD mismatch/);

  const evidencePath = path.join(directory, `${SOURCE_ID}-revalidation-evidence.json`);
  const evidenceBytes = await readFile(evidencePath);
  const evidence = JSON.parse(evidenceBytes); evidence.observedAt = new Date(now.getTime() - 120_000).toISOString();
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  await assert.rejects(register(), /revalidation evidence is invalid/);
  await writeFile(evidencePath, evidenceBytes);

  // 정책 주기(30일)가 지난 관측은 등록하지 않는다.
  await assert.rejects(register({ now: new Date(Date.parse(observedAt) + 31 * 24 * 60 * 60 * 1_000) }), /freshness/);

  const governancePath = path.join(root, INPUTS[2]);
  const governanceBytes = await readFile(governancePath);
  const governance = JSON.parse(governanceBytes);
  governance.sources.find(({ sourceId }) => sourceId === SOURCE_ID).licenseReview.nextReviewAt = observedAt;
  await writeFile(governancePath, `${JSON.stringify(governance, null, 2)}\n`);
  await assert.rejects(register(), /license review/);
  await writeFile(governancePath, governanceBytes);

  assert.deepEqual(await readFile(path.join(root, INPUTS[1])), ledgerBytes);
});
