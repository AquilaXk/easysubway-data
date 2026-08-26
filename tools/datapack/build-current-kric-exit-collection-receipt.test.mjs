import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildCurrentKricExitCollectionPlan } from "./build-current-kric-exit-collection-plan.mjs";
import { buildCurrentKricExitCollectionBundle, buildCurrentKricExitCollectionReceipt, canonicalCurrentKricExitCollectionBundleJson, canonicalCurrentKricExitCollectionReceiptJson, main } from "./build-current-kric-exit-collection-receipt.mjs";

const root = fileURLToPath(new URL(".", import.meta.url));
const hash = (value) => createHash("sha256").update(value).digest("hex");
const canonical = (value) => JSON.stringify(sort(value));
function sort(value) { if (Array.isArray(value)) return value.map(sort); if (!value || typeof value !== "object") return value; return Object.fromEntries(Object.keys(value).sort((left, right) => left.localeCompare(right, "en")).map((key) => [key, sort(value[key])])); }

async function planAndSnapshot() {
  const paths = {
    canonicalPackBytes: "release/capital-production-canonical-pack.json", coverageTargetsBytes: "nationwide-coverage-targets.json",
    providerCodeCatalogBytes: "sources/kric-provider-code-catalog-20260228.json", routeRostersBytes: "sources/kric-nationwide-route-rosters-20260730T203926676Z.json",
    sourceInventoryBytes: "source-inventory.json", incheonTopologyBytes: "sources/incheon-transit-station-info-20260825.json",
  };
  const input = Object.fromEntries(await Promise.all(Object.entries(paths).map(async ([key, file]) => [key, await readFile(path.join(root, file))])));
  const plan = buildCurrentKricExitCollectionPlan(input, { now: new Date("2026-08-25T16:00:00.000Z"), coverageSelector: "capital-seoul-metro-production" });
  const rows = [{ edMovePath: null, elvtSttCd: null, elvtTpCd: null, exitMvTpOrdr: "1", imgPath: null, mvContDtl: null, mvPathMgNo: "1", stMovePath: null }];
  const results = plan.queryPlan.map((query, index) => ({
    queryId: query.queryId, state: index === 0 ? "ROWS_OBSERVED" : "EXPLICIT_ZERO", providerResultCode: "00",
    rawResponseSha256: hash(`raw-${index}`), rawResponseByteSize: 1, providerRecordHash: hash(canonical(index === 0 ? rows : [])), rows: index === 0 ? rows : [],
  }));
  const payload = { schemaVersion: 1, artifactKind: "kric-exit-path-provider-snapshot", sourceId: "kric-station-movement-standard", snapshotId: "kric-station-movement-standard-20260825T160000000Z", capturedAt: "2026-08-25T16:00:00.000Z", freshUntil: "2026-08-26T16:00:00.000Z", credentialRedacted: true, collectionPlanDigest: plan.collectionPlanDigest, queryPlanSha256: plan.queryPlanSha256, coverage: { requestPlanComplete: true, queryIds: plan.queryPlan.map(({ queryId }) => queryId) }, queryPlan: plan.queryPlan, results };
  const snapshot = sort({ ...payload, snapshotDigest: hash(canonical(payload)) });
  return { plan, snapshot };
}

test("213/199/420 paired bytes는 결정적 immutable receipt와 exact bundle을 만든다", async () => {
  const { plan, snapshot } = await planAndSnapshot();
  const planBytes = Buffer.from(canonical(plan)); const snapshotBytes = Buffer.from(canonical(snapshot));
  const input = { collectionPlanBytes: planBytes, providerSnapshotBytes: snapshotBytes, repository: "AquilaXk/easysubway-data", repositorySha: "a".repeat(40), workflowRunId: 123 };
  const receipt = buildCurrentKricExitCollectionReceipt(input);
  assert.equal(receipt.queryCount, 420);
  assert.equal(canonicalCurrentKricExitCollectionReceiptJson(receipt), canonicalCurrentKricExitCollectionReceiptJson(buildCurrentKricExitCollectionReceipt(input)));
  const temporary = await mkdtemp(path.join(tmpdir(), "exit-receipt-"));
  try {
    const planPath = path.join(temporary, "plan.json"); const snapshotPath = path.join(temporary, "snapshot.json"); const output = path.join(temporary, "bundle.json");
    await writeFile(planPath, planBytes, { mode: 0o600 }); await writeFile(snapshotPath, snapshotBytes, { mode: 0o600 });
    await main(["--collection-plan", planPath, "--provider-snapshot", snapshotPath, "--repository", "AquilaXk/easysubway-data", "--repository-sha", "a".repeat(40), "--workflow-run-id", "123", "--output", output], { env: { RUNNER_TEMP: temporary }, log() {} });
    const bundle = JSON.parse(await readFile(output, "utf8"));
    assert.equal((await lstat(output)).mode & 0o777, 0o600);
    assert.equal(canonicalCurrentKricExitCollectionBundleJson(bundle), JSON.stringify(bundle));
    assert.deepEqual([Buffer.from(bundle.collectionPlanJson), Buffer.from(bundle.providerSnapshotJson)], [planBytes, snapshotBytes]);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test("existing output collision is preserved and no bundle is substituted", async () => {
  const { plan, snapshot } = await planAndSnapshot(); const temporary = await mkdtemp(path.join(tmpdir(), "exit-receipt-collision-"));
  try {
    const planPath = path.join(temporary, "plan.json"); const snapshotPath = path.join(temporary, "snapshot.json"); const output = path.join(temporary, "bundle.json");
    await writeFile(planPath, canonical(plan)); await writeFile(snapshotPath, canonical(snapshot)); await writeFile(output, "preserve");
    await assert.rejects(main(["--collection-plan", planPath, "--provider-snapshot", snapshotPath, "--repository", "AquilaXk/easysubway-data", "--repository-sha", "a".repeat(40), "--workflow-run-id", "1", "--output", output], { env: { RUNNER_TEMP: temporary }, log() {} }), /output must be absent/);
    assert.equal((await readFile(output, "utf8")), "preserve");
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test("foreign symlink and directory output collisions are preserved", async () => {
  const { plan, snapshot } = await planAndSnapshot(); const temporary = await mkdtemp(path.join(tmpdir(), "exit-receipt-foreign-"));
  try {
    const planPath = path.join(temporary, "plan.json"); const snapshotPath = path.join(temporary, "snapshot.json"); await writeFile(planPath, canonical(plan)); await writeFile(snapshotPath, canonical(snapshot));
    for (const kind of ["symlink", "directory"]) {
      const output = path.join(temporary, `bundle-${kind}.json`);
      if (kind === "symlink") await symlink(planPath, output); else await mkdir(output);
      await assert.rejects(main(["--collection-plan", planPath, "--provider-snapshot", snapshotPath, "--repository", "AquilaXk/easysubway-data", "--repository-sha", "a".repeat(40), "--workflow-run-id", "1", "--output", output], { env: { RUNNER_TEMP: temporary }, log() {} }), /output must be absent/);
      assert.ok(await lstat(output));
    }
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test("plan/snapshot drift와 result coverage drift는 receipt 전에 fail closed한다", async () => {
  const { plan, snapshot } = await planAndSnapshot();
  const input = { collectionPlanBytes: Buffer.from(canonical(plan)), providerSnapshotBytes: Buffer.from(canonical(snapshot)), repository: "AquilaXk/easysubway-data", repositorySha: "a".repeat(40), workflowRunId: 1 };
  const drift = structuredClone(snapshot); drift.coverage.queryIds.reverse();
  assert.throws(() => buildCurrentKricExitCollectionReceipt({ ...input, providerSnapshotBytes: Buffer.from(canonical(drift)) }), /snapshot digest mismatch|coverage mismatch/);
  const substituted = structuredClone(snapshot); substituted.results.pop(); substituted.snapshotDigest = hash(canonical(Object.fromEntries(Object.entries(substituted).filter(([key]) => key !== "snapshotDigest"))));
  assert.throws(() => buildCurrentKricExitCollectionReceipt({ ...input, providerSnapshotBytes: Buffer.from(canonical(substituted)) }), /result coverage mismatch/);
  assert.throws(() => buildCurrentKricExitCollectionReceipt({ ...input, repositorySha: "A".repeat(40) }), /repository SHA mismatch/);
});

test("유효하게 재해시한 mapping·time·row drift도 semantic closure에서 거부한다", async () => {
  const { plan, snapshot } = await planAndSnapshot();
  const input = { collectionPlanBytes: Buffer.from(canonical(plan)), providerSnapshotBytes: Buffer.from(canonical(snapshot)), repository: "AquilaXk/easysubway-data", repositorySha: "a".repeat(40), workflowRunId: 1 };
  const mapped = structuredClone(plan); mapped.providerMappings[0].providerStationId = "drift"; mapped.candidate.providerMappingSha256 = hash(canonical(mapped.providerMappings)); rehashPlan(mapped);
  const rebound = rebindSnapshot(snapshot, mapped); assert.throws(() => buildCurrentKricExitCollectionReceipt({ ...input, collectionPlanBytes: Buffer.from(canonical(mapped)), providerSnapshotBytes: Buffer.from(canonical(rebound)) }), /station-line query relation mismatch/);
  const timed = structuredClone(snapshot); timed.capturedAt = "2026-08-25T16:00:00Z"; rehashSnapshot(timed);
  assert.throws(() => buildCurrentKricExitCollectionReceipt({ ...input, providerSnapshotBytes: Buffer.from(canonical(timed)) }), /snapshot (?:ID|time) mismatch/);
  const rowDrift = structuredClone(snapshot); rowDrift.results[0].rows[0].mvPathMgNo = null; rowDrift.results[0].providerRecordHash = hash(canonical(rowDrift.results[0].rows)); rehashSnapshot(rowDrift);
  assert.throws(() => buildCurrentKricExitCollectionReceipt({ ...input, providerSnapshotBytes: Buffer.from(canonical(rowDrift)) }), /ordering identity missing/);
  const stationDrift = structuredClone(plan); stationDrift.providerMappings[0].stationId = "station-drift"; stationDrift.providerMappings.sort((left, right) => Buffer.compare(Buffer.from(`${left.stationId}\0${left.lineId}`), Buffer.from(`${right.stationId}\0${right.lineId}`))); stationDrift.candidate.providerMappingSha256 = hash(canonical(stationDrift.providerMappings)); stationDrift.candidate.stationSetSha256 = hash(canonical([...new Set(stationDrift.providerMappings.map(({ stationId }) => stationId))].sort((left, right) => left.localeCompare(right, "en")))); rehashPlan(stationDrift);
  assert.throws(() => buildCurrentKricExitCollectionReceipt({ ...input, collectionPlanBytes: Buffer.from(canonical(stationDrift)), providerSnapshotBytes: Buffer.from(canonical(rebindSnapshot(snapshot, stationDrift)))}), /station-line query relation mismatch/);
  const edgeDrift = structuredClone(plan); edgeDrift.routeEdges[0].serviceClass = "RAIL"; edgeDrift.candidate.topologySha256 = hash(canonical(edgeDrift.routeEdges)); rehashPlan(edgeDrift);
  assert.throws(() => buildCurrentKricExitCollectionReceipt({ ...input, collectionPlanBytes: Buffer.from(canonical(edgeDrift)), providerSnapshotBytes: Buffer.from(canonical(rebindSnapshot(snapshot, edgeDrift)))}), /route edge relation mismatch/);
  const longWindow = structuredClone(snapshot); longWindow.freshUntil = "2026-08-27T16:00:00.000Z"; rehashSnapshot(longWindow);
  assert.throws(() => buildCurrentKricExitCollectionReceipt({ ...input, providerSnapshotBytes: Buffer.from(canonical(longWindow)) }), /freshness mismatch/);
});

test("bundle은 cross-collection receipt, cross-line label, scalar coercion을 재해시해도 거부한다", async () => {
  const { plan, snapshot } = await planAndSnapshot(); const planBytes = Buffer.from(canonical(plan)); const snapshotBytes = Buffer.from(canonical(snapshot));
  const receipt = buildCurrentKricExitCollectionReceipt({ collectionPlanBytes: planBytes, providerSnapshotBytes: snapshotBytes, repository: "AquilaXk/easysubway-data", repositorySha: "a".repeat(40), workflowRunId: 1 });
  const alternatePlan = structuredClone(plan); alternatePlan.candidate.candidateId = "other-collection"; rehashPlan(alternatePlan);
  const alternateSnapshot = rebindSnapshotPlan(snapshot, alternatePlan);
  assert.throws(() => buildCurrentKricExitCollectionBundle({ collectionPlanBytes: Buffer.from(canonical(alternatePlan)), providerSnapshotBytes: Buffer.from(canonical(alternateSnapshot)), receipt }), /receipt binding mismatch/);
  const swapped = structuredClone(plan); const other = swapped.queryPlan.findIndex((query) => query.lineName !== swapped.queryPlan[0].lineName); [swapped.queryPlan[0].lineName, swapped.queryPlan[other].lineName] = [swapped.queryPlan[other].lineName, swapped.queryPlan[0].lineName]; swapped.queryPlanSha256 = hash(canonical(swapped.queryPlan)); rehashPlan(swapped);
  const swappedSnapshot = rebindSnapshotPlan(snapshot, swapped);
  assert.throws(() => buildCurrentKricExitCollectionReceipt({ collectionPlanBytes: Buffer.from(canonical(swapped)), providerSnapshotBytes: Buffer.from(canonical(swappedSnapshot)), repository: "AquilaXk/easysubway-data", repositorySha: "a".repeat(40), workflowRunId: 1 }), /line identity mismatch/);
  const coerced = structuredClone(receipt); coerced.queryCount = "420"; rehashReceipt(coerced);
  assert.throws(() => buildCurrentKricExitCollectionBundle({ collectionPlanBytes: planBytes, providerSnapshotBytes: snapshotBytes, receipt: coerced }), /receipt identity mismatch/);
});

function rehashPlan(plan) { plan.collectionPlanDigest = hash(canonical(Object.fromEntries(Object.entries(plan).filter(([key]) => key !== "collectionPlanDigest")))); }
function rehashSnapshot(snapshot) { snapshot.snapshotDigest = hash(canonical(Object.fromEntries(Object.entries(snapshot).filter(([key]) => key !== "snapshotDigest")))); }
function rebindSnapshot(snapshot, plan) { const rebound = structuredClone(snapshot); rebound.collectionPlanDigest = plan.collectionPlanDigest; rebound.queryPlanSha256 = plan.queryPlanSha256; rehashSnapshot(rebound); return rebound; }
function rebindSnapshotPlan(snapshot, plan) { const rebound = rebindSnapshot(snapshot, plan); rebound.queryPlan = plan.queryPlan; rebound.coverage.queryIds = plan.queryPlan.map(({ queryId }) => queryId); rehashSnapshot(rebound); return rebound; }
function rehashReceipt(receipt) { receipt.receiptSha256 = hash(canonical(Object.fromEntries(Object.entries(receipt).filter(([key]) => key !== "receiptSha256")))); }
