import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { collectKricAccessibilitySnapshots } from "./collect-kric-accessibility-snapshots.mjs";
import { recoverKricStandardAccessibilitySnapshotTransaction, registerKricStandardAccessibilitySnapshot } from "./register-kric-standard-accessibility-snapshot.mjs";

const root = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const registryPaths = [
  "tools/datapack/source-inventory.json",
  "tools/datapack/release/source-snapshots.json",
  "tools/datapack/inputs/capital-pilot-production-source-input.json",
];
const roster = [
  { stationId: "station-sangnoksu", lineId: "seoul-4", railOprIsttCd: "KR", lnCd: "4", stinCd: "448", canonicalMappings: [{ artifactId: "bundled-capital", stationId: "station-sangnoksu", lineId: "seoul-4" }] },
  { stationId: "station-sadang", lineId: "seoul-4", railOprIsttCd: "S1", lnCd: "4", stinCd: "433", canonicalMappings: [{ artifactId: "bundled-capital", stationId: "station-sadang", lineId: "seoul-4" }] },
];
const operation = {
  sourceId: "kric-station-convenience-standard",
  endpoint: "https://openapi.kric.go.kr/openapi/handicapped/stationCnvFacl",
  responseFields: ["dtlLoc", "grndDvCd", "gubun", "imgPath", "mlFmlDvCd", "stinFlor", "trfcWeakDvCd"],
  tupleIdentityFields: [],
};

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "easysubway-kric-registration-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await Promise.all(registryPaths.map(async (relativePath) => {
    const target = path.join(directory, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await cp(path.join(root, relativePath), target, { recursive: true });
  }));
  const snapshot = (await collectKricAccessibilitySnapshots({
    roster,
    operations: [operation],
    serviceKey: "fixture-only-key",
    now: new Date("2026-08-03T00:00:00.000Z"),
    fetchImpl: async (url) => ({
      ok: true,
      status: 200,
      json: async () => ({ header: { resultCode: "00" }, body: [1, 2].map((number) => ({
        dtlLoc: `fresh ${url.searchParams.get("stinCd")} ${number}`,
        grndDvCd: url.searchParams.get("stinCd") === "433" ? "2" : "1",
        gubun: "EV",
        imgPath: "",
        mlFmlDvCd: "",
        stinFlor: number,
        trfcWeakDvCd: "01",
      })) }),
    }),
  }))[0];
  const snapshotFilePath = path.join(directory, "staging", `${snapshot.snapshotId}.json`);
  await mkdir(path.dirname(snapshotFilePath), { recursive: true });
  const snapshotBytes = Buffer.from(`${JSON.stringify(snapshot, null, 2)}\n`);
  await writeFile(snapshotFilePath, snapshotBytes);
  const paths = Object.fromEntries(registryPaths.map((relativePath) => [relativePath, path.join(directory, relativePath)]));
  return {
    paths,
    snapshot,
    snapshotFilePath,
    snapshotFileSha256: sha256(snapshotBytes),
    snapshotTargetPath: path.join(directory, "tools/datapack/sources", `${snapshot.snapshotId}.json`),
    seoulSnapshot: JSON.parse(await readFile(path.join(root, "tools/datapack/sources/seoul-metro-accessibility-20260728.json"), "utf8")),
    before: await Promise.all(registryPaths.map((relativePath) => readFile(paths[relativePath]))),
  };
}

function receipt(snapshot, snapshotFileSha256) {
  return {
    rawObjectUri: "s3://easysubway-datapack-sources/kric-station-convenience-standard/20260803.json",
    sourceId: snapshot.sourceId,
    snapshotId: snapshot.snapshotId,
    snapshotRawSha256: snapshot.rawSha256,
    capturedAt: snapshot.capturedAt,
    snapshotFileSha256,
    rawObjectSha256: "e".repeat(64),
    byteSize: 1234,
    storedAt: snapshot.capturedAt,
    rawRetentionExpiresAt: "2026-11-01T00:00:00.000Z",
  };
}

async function register(values, overrides = {}) {
  return registerKricStandardAccessibilitySnapshot({
    snapshotFilePath: values.snapshotFilePath,
    snapshotFileSha256: values.snapshotFileSha256,
    snapshotTargetPath: values.snapshotTargetPath,
    rawReceipt: receipt(values.snapshot, values.snapshotFileSha256),
    seoulSnapshot: values.seoulSnapshot,
    registryPaths: values.paths,
    repositoryRoot: path.dirname(path.dirname(path.dirname(path.dirname(values.snapshotTargetPath)))),
    now: new Date("2026-08-03T00:01:00.000Z"),
    ...overrides,
  });
}

async function assertUnchanged(values) {
  assert.deepEqual(await Promise.all(registryPaths.map((relativePath) => readFile(values.paths[relativePath]))), values.before);
}

function journalPath(values) {
  return path.join(path.dirname(path.dirname(path.dirname(path.dirname(values.snapshotTargetPath)))), "tools/datapack/.kric-standard-registration-transaction.json");
}

test("fresh KRIC queries를 materialize해 세 registry의 동일 identity로 원자 등록한다", async (t) => {
  const values = await fixture(t);
  await register(values);
  const [inventory, snapshots, input] = await Promise.all(registryPaths.map(async (relativePath) =>
    JSON.parse(await readFile(values.paths[relativePath], "utf8"))));
  const source = inventory.sources.find(({ id }) => id === values.snapshot.sourceId);
  const ledger = snapshots.at(-1);
  const kricRows = input.facilityRows.filter(({ sourceId }) => sourceId === values.snapshot.sourceId);
  const kricStatus = input.accessibilityStatusEvidence.filter(({ sourceId }) => sourceId === values.snapshot.sourceId);
  assert.equal(source.productionUseAllowed, true);
  assert.equal(source.accessibilityAdmissionEvidence.snapshotId, values.snapshot.snapshotId);
  assert.equal(source.accessibilityAdmissionEvidence.contentSha256, values.snapshot.contentSha256);
  assert.equal(source.accessibilityAdmissionEvidence.freshUntil, values.snapshot.freshUntil);
  assert.equal(source.accessibilityAdmissionEvidence.snapshotFileSha256, values.snapshotFileSha256);
  assert.equal(ledger.snapshotId, values.snapshot.snapshotId);
  assert.equal(ledger.rawSha256, receipt(values.snapshot, values.snapshotFileSha256).rawObjectSha256);
  assert.equal(ledger.contentSha256, values.snapshot.contentSha256);
  assert.equal(source.accessibilityAdmissionEvidence.rawSha256, values.snapshot.rawSha256);
  assert.equal(ledger.rawObjectUri, receipt(values.snapshot, values.snapshotFileSha256).rawObjectUri);
  assert.equal(ledger.freshnessExpiresAt, values.snapshot.freshUntil);
  assert.equal(ledger.rawRetentionExpiresAt, receipt(values.snapshot, values.snapshotFileSha256).rawRetentionExpiresAt);
  assert.match(source.admissionEvidence.productionUseNoteKo, new RegExp(values.snapshot.snapshotId));
  assert.doesNotMatch(source.admissionEvidence.productionUseNoteKo, /Data #39.*차단/);
  assert.deepEqual(input.kricStandardAccessibilitySnapshot, {
    snapshotId: values.snapshot.snapshotId,
    contentSha256: values.snapshot.contentSha256,
    freshUntil: values.snapshot.freshUntil,
  });
  assert.deepEqual(await readFile(values.snapshotTargetPath), await readFile(values.snapshotFilePath));
  assert.equal(sha256(await readFile(values.snapshotTargetPath)), values.snapshotFileSha256);
  assert.equal(kricRows.length, 4);
  assert.ok(kricRows.every(({ sourceSnapshotId, description }) => sourceSnapshotId === values.snapshot.snapshotId && description.startsWith("fresh ")));
  assert.ok(kricStatus.length > 0 && kricStatus.every(({ sourceSnapshotId }) => sourceSnapshotId === values.snapshot.snapshotId));
});

test("provider/schema/hash/receipt/partial-write 오류는 세 registry bytes를 모두 유지한다", async (t) => {
  const mutations = [
    ["provider", (snapshot) => { snapshot.providerResultCode = "30"; }],
    ["schema", (snapshot) => { snapshot.schemaStatus = "FAIL"; }],
    ["hash", (snapshot) => { snapshot.contentSha256 = "0".repeat(64); }],
    ["row schema", (snapshot) => { snapshot.queries[0].rows[0].unexpected = true; }],
  ];
  for (const [label, mutate] of mutations) {
    const values = await fixture(t);
    const invalid = structuredClone(values.snapshot);
    mutate(invalid);
    const bytes = Buffer.from(`${JSON.stringify(invalid)}\n`);
    await writeFile(values.snapshotFilePath, bytes);
    await assert.rejects(register(values, { snapshotFileSha256: sha256(bytes) }), /snapshot identity/);
    await assertUnchanged(values);
  }
  const stale = await fixture(t);
  const staleSnapshot = structuredClone(stale.snapshot);
  staleSnapshot.capturedAt = "2020-01-01T00:00:00.000Z";
  staleSnapshot.observedAt = staleSnapshot.capturedAt;
  staleSnapshot.snapshotId = "kric-station-convenience-standard-20200101T000000000Z";
  staleSnapshot.freshUntil = "2026-08-04T00:00:00.000Z";
  const staleBytes = Buffer.from(JSON.stringify(staleSnapshot));
  await writeFile(stale.snapshotFilePath, staleBytes);
  await assert.rejects(register(stale, {
    snapshotFileSha256: sha256(staleBytes),
    rawReceipt: {
      ...receipt(staleSnapshot, sha256(staleBytes)),
      capturedAt: staleSnapshot.capturedAt,
      snapshotId: staleSnapshot.snapshotId,
    },
  }), /freshUntil/);
  await assertUnchanged(stale);
  const invalidReceipt = await fixture(t);
  await assert.rejects(register(invalidReceipt, { rawReceipt: { ...receipt(invalidReceipt.snapshot, invalidReceipt.snapshotFileSha256), rawObjectUri: "https://example.com/raw.json" } }), /receipt/);
  await assertUnchanged(invalidReceipt);
  const mismatchedReceipt = await fixture(t);
  await assert.rejects(register(mismatchedReceipt, {
    rawReceipt: { ...receipt(mismatchedReceipt.snapshot, mismatchedReceipt.snapshotFileSha256), snapshotId: "unrelated-snapshot" },
  }), /snapshot binding/);
  await assertUnchanged(mismatchedReceipt);
  const immutable = await fixture(t);
  await mkdir(path.dirname(immutable.snapshotTargetPath), { recursive: true });
  await writeFile(immutable.snapshotTargetPath, "different snapshot bytes");
  await assert.rejects(register(immutable), /already exists with different bytes/);
  await assertUnchanged(immutable);
  const partial = await fixture(t);
  let writes = 0;
  await assert.rejects(register(partial, {
    atomicReplaceImpl: async (target, bytes, phase) => {
      writes += 1;
      if (writes === 2) throw new Error("partial write");
      await mkdir(path.dirname(target), { recursive: true });
      return writeFile(target, bytes);
    },
  }), /partial write/);
  await assertUnchanged(partial);
  await assert.rejects(readFile(partial.snapshotTargetPath), { code: "ENOENT" });
});

test("registry replace phase #3과 #4 실패는 네 surface를 journal backup으로 복구한다", async (t) => {
  for (const phase of [3, 4]) {
    const values = await fixture(t);
    await assert.rejects(register(values, {
      atomicReplaceImpl: async (target, bytes, currentPhase) => {
        if (currentPhase === phase) throw new Error(`replace ${phase}`);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, bytes);
      },
    }), new RegExp(`replace ${phase}`));
    await assertUnchanged(values);
    await assert.rejects(readFile(values.snapshotTargetPath), { code: "ENOENT" });
    await assert.rejects(readFile(journalPath(values)), { code: "ENOENT" });
  }
});

test("rollback replace 실패는 RECOVERY_REQUIRED journal을 보존하고 exported recovery가 복구한다", async (t) => {
  const values = await fixture(t);
  const failCommit = async (target, bytes, phase) => {
    if (phase === 3) throw new Error("replace 3");
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes);
  };
  await assert.rejects(register(values, {
    atomicReplaceImpl: failCommit,
    rollbackAtomicReplaceImpl: async () => { throw new Error("rollback replace"); },
  }), /RECOVERY_REQUIRED/);
  await readFile(journalPath(values));
  const syncCalls = [];
  const outcome = await recoverKricStandardAccessibilitySnapshotTransaction({
    repositoryRoot: path.dirname(path.dirname(path.dirname(path.dirname(values.snapshotTargetPath)))),
    cleanupTransactionDirectoryImpl: async () => { throw new Error("recovery cleanup failed"); },
    syncDirectoryImpl: async (directoryPath) => {
      const journalExists = await readFile(journalPath(values)).then(
        () => true,
        (error) => {
          if (error?.code === "ENOENT") return false;
          throw error;
        },
      );
      syncCalls.push([directoryPath, journalExists]);
    },
  });
  assert.equal(outcome, "PREPARED");
  assert.deepEqual(syncCalls[0], [path.dirname(values.snapshotTargetPath), true]);
  await assertUnchanged(values);
  await assert.rejects(readFile(values.snapshotTargetPath), { code: "ENOENT" });
  await assert.rejects(readFile(journalPath(values)), { code: "ENOENT" });
});

test("COMMITTED journal 전환 실패 후에도 PREPARED backups로 네 surface를 복구한다", async (t) => {
  const values = await fixture(t);
  await assert.rejects(register(values, {
    commitJournalReplaceImpl: async () => { throw new Error("journal commit failed"); },
  }), /journal commit failed/);
  await assertUnchanged(values);
  await assert.rejects(readFile(values.snapshotTargetPath), { code: "ENOENT" });
  await assert.rejects(readFile(journalPath(values)), { code: "ENOENT" });
});

test("COMMITTED journal bytes 기록 뒤 오류는 recovery가 committed 성공으로 확정한다", async (t) => {
  const values = await fixture(t);
  await register(values, {
    commitJournalReplaceImpl: async (target, bytes) => {
      await writeFile(target, bytes);
      throw new Error("parent fsync failed");
    },
  });
  assert.equal(sha256(await readFile(values.snapshotTargetPath)), values.snapshotFileSha256);
  const inventory = JSON.parse(await readFile(values.paths[registryPaths[0]], "utf8"));
  assert.equal(inventory.sources.find(({ id }) => id === values.snapshot.sourceId).productionUseAllowed, true);
  await assert.rejects(readFile(journalPath(values)), { code: "ENOENT" });
});

test("commit point 뒤 transaction directory cleanup 실패는 성공 결과를 되돌리지 않는다", async (t) => {
  const values = await fixture(t);
  await register(values, { cleanupTransactionDirectoryImpl: async () => { throw new Error("cleanup failed"); } });
  assert.equal(sha256(await readFile(values.snapshotTargetPath)), values.snapshotFileSha256);
  const inventory = JSON.parse(await readFile(values.paths[registryPaths[0]], "utf8"));
  assert.equal(inventory.sources.find(({ id }) => id === values.snapshot.sourceId).productionUseAllowed, true);
  await assert.rejects(readFile(journalPath(values)), { code: "ENOENT" });
});
