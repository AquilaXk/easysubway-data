import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { collectKricAccessibilitySnapshots } from "./collect-kric-accessibility-snapshots.mjs";
import { deriveFreshnessExpiresAt } from "./freshness-policy.mjs";
import { parseKricStandardAccessibilitySnapshotRegistrationArgs, registerKricStandardAccessibilitySnapshot } from "./register-kric-standard-accessibility-snapshot.mjs";
import { deriveRawRetentionExpiresAt } from "./source-governance-policy.mjs";

const root = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const registryPaths = [
  "tools/datapack/source-inventory.json",
  "tools/datapack/release/source-snapshots.json",
  "tools/datapack/inputs/capital-pilot-production-source-input.json",
];
const seoulSnapshotPath = "tools/datapack/sources/seoul-metro-accessibility-20260728.json";
const governancePolicyPath = "tools/datapack/source-governance-policy.json";
const freshnessPolicyPath = "release/product-gates/datapack-freshness-sla.json";
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

async function snapshotFor(kricRoster, now = new Date("2026-08-03T00:00:00.000Z")) {
  return (await collectKricAccessibilitySnapshots({
    roster: kricRoster,
    operations: [operation],
    serviceKey: "fixture-only-key",
    now,
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
}

async function stageSnapshot(values, snapshot) {
  const bytes = Buffer.from(`${JSON.stringify(snapshot, null, 2)}\n`);
  await writeFile(values.snapshotFilePath, bytes);
  values.snapshot = snapshot;
  values.snapshotFileSha256 = sha256(bytes);
}

async function fixture(t, now = new Date("2026-08-03T00:00:00.000Z")) {
  const directory = await mkdtemp(path.join(tmpdir(), "easysubway-kric-registration-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await Promise.all(registryPaths.map(async (relativePath) => {
    const target = path.join(directory, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await cp(path.join(root, relativePath), target, { recursive: true });
  }));
  await Promise.all([governancePolicyPath, freshnessPolicyPath].map(async (relativePath) => {
    const target = path.join(directory, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await cp(path.join(root, relativePath), target);
  }));
  const freshnessPolicy = JSON.parse(await readFile(path.join(directory, freshnessPolicyPath), "utf8"));
  await mkdir(path.dirname(path.join(directory, seoulSnapshotPath)), { recursive: true });
  await cp(path.join(root, seoulSnapshotPath), path.join(directory, seoulSnapshotPath));
  const admittedSeoul = JSON.parse(await readFile(path.join(directory, seoulSnapshotPath), "utf8"));
  admittedSeoul.capturedAt = now.toISOString();
  admittedSeoul.observedAt = admittedSeoul.capturedAt;
  admittedSeoul.freshUntil = new Date(now.getTime() + 86_400_000).toISOString();
  const admittedSeoulBytes = Buffer.from(`${JSON.stringify(admittedSeoul, null, 2)}\n`);
  await writeFile(path.join(directory, seoulSnapshotPath), admittedSeoulBytes);
  const inventory = JSON.parse(await readFile(path.join(directory, registryPaths[0]), "utf8"));
  const seoulEvidence = inventory.sources.find(({ id }) => id === "seoul-metro-accessibility").accessibilityAdmissionEvidence;
  seoulEvidence.capturedAt = admittedSeoul.capturedAt;
  seoulEvidence.observedAt = admittedSeoul.observedAt;
  seoulEvidence.freshUntil = admittedSeoul.freshUntil;
  seoulEvidence.snapshotFileSha256 = sha256(admittedSeoulBytes);
  await writeFile(path.join(directory, registryPaths[0]), `${JSON.stringify(inventory, null, 2)}\n`);
  const snapshots = JSON.parse(await readFile(path.join(directory, registryPaths[1]), "utf8"));
  const seoulLedger = snapshots.find(({ sourceId, snapshotId }) =>
    sourceId === "seoul-metro-accessibility" && snapshotId === admittedSeoul.snapshotId);
  seoulLedger.retrievedAt = admittedSeoul.capturedAt;
  seoulLedger.sourceUpdatedAt = admittedSeoul.observedAt;
  seoulLedger.freshnessExpiresAt = deriveFreshnessExpiresAt({
    policy: freshnessPolicy,
    sourceClassId: "static_accessibility_facility",
    basisAt: admittedSeoul.capturedAt,
    evaluationAt: now.toISOString(),
  });
  await writeFile(path.join(directory, registryPaths[1]), `${JSON.stringify(snapshots, null, 2)}\n`);
  const snapshot = await snapshotFor(roster, now);
  const snapshotFilePath = path.join(directory, "staging", `${snapshot.snapshotId}.json`);
  await mkdir(path.dirname(snapshotFilePath), { recursive: true });
  const snapshotBytes = Buffer.from(`${JSON.stringify(snapshot, null, 2)}\n`);
  await writeFile(snapshotFilePath, snapshotBytes);
  const governancePolicyBytes = await readFile(path.join(directory, governancePolicyPath));
  const governancePolicy = JSON.parse(governancePolicyBytes);
  const paths = Object.fromEntries(registryPaths.map((relativePath) => [relativePath, path.join(directory, relativePath)]));
  return {
    paths,
    snapshot,
    snapshotFilePath,
    snapshotFileSha256: sha256(snapshotBytes),
    snapshotTargetPath: path.join(directory, "tools/datapack/sources", `${snapshot.snapshotId}.json`),
    governancePolicy,
    governancePolicySha256: sha256(governancePolicyBytes),
    freshnessPolicy,
    rawRetentionExpiresAt: deriveRawRetentionExpiresAt({ policy: governancePolicy, sourceId: "kric-station-convenience-standard", retrievedAt: snapshot.capturedAt }),
    seoulSnapshot: JSON.parse(await readFile(path.join(directory, seoulSnapshotPath), "utf8")),
    before: await Promise.all(registryPaths.map((relativePath) => readFile(paths[relativePath]))),
  };
}

function receipt(snapshot, snapshotFileSha256, rawRetentionExpiresAt = new Date(Date.parse(snapshot.capturedAt) + 90 * 86_400_000).toISOString()) {
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
    rawRetentionExpiresAt,
  };
}

async function register(values, overrides = {}) {
  return registerKricStandardAccessibilitySnapshot({
    snapshotFilePath: values.snapshotFilePath,
    snapshotFileSha256: values.snapshotFileSha256,
    snapshotTargetPath: values.snapshotTargetPath,
    rawReceipt: receipt(values.snapshot, values.snapshotFileSha256, values.rawRetentionExpiresAt),
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

async function registryBytes(values) {
  return Promise.all(registryPaths.map((relativePath) => readFile(values.paths[relativePath])));
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
  const seoulLedger = snapshots.find(({ sourceId, snapshotId }) =>
    sourceId === "seoul-metro-accessibility" && snapshotId === values.seoulSnapshot.snapshotId);
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
  assert.equal(ledger.freshnessExpiresAt, "2026-11-01T00:00:00.000Z");
  assert.equal(values.snapshot.freshUntil, "2026-08-04T00:00:00.000Z");
  assert.equal(seoulLedger.freshnessExpiresAt, deriveFreshnessExpiresAt({
    policy: values.freshnessPolicy,
    sourceClassId: "static_accessibility_facility",
    basisAt: values.seoulSnapshot.capturedAt,
    evaluationAt: values.seoulSnapshot.capturedAt,
  }));
  assert.notEqual(seoulLedger.freshnessExpiresAt, values.seoulSnapshot.freshUntil);
  assert.equal(ledger.rawRetentionExpiresAt, values.rawRetentionExpiresAt);
  assert.equal(ledger.governancePolicySha256, values.governancePolicySha256);
  assert.equal(ledger.governancePolicyVersion, values.governancePolicy.policyVersion);
  assert.equal(ledger.snapshotStatus, "LOCKED");
  assert.equal(ledger.fetchStatus, "SUCCESS");
  assert.equal(ledger.schemaStatus, "PASS");
  assert.equal(ledger.licenseStatus, "PASS");
  assert.equal(ledger.redistributionAllowed, true);
  assert.equal(source.retrievedAt, values.snapshot.capturedAt.slice(0, 10));
  assert.equal(source.observedDataUpdatedAt, values.snapshot.observedAt.slice(0, 10));
  assert.match(source.retrievedAt, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(source.observedDataUpdatedAt, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(source.admissionEvidence.productionUseNoteKo, new RegExp(values.snapshot.snapshotId));
  assert.doesNotMatch(source.admissionEvidence.productionUseNoteKo, /Data #39.*차단/);
  assert.deepEqual(input.kricStandardAccessibilitySnapshot, {
    snapshotId: values.snapshot.snapshotId,
    contentSha256: values.snapshot.contentSha256,
    freshUntil: values.snapshot.freshUntil,
  });
  assert.deepEqual(input.kricStandardAccessibilityRoster, [
    { stationId: "station-sadang", lineId: "seoul-4", railOprIsttCd: "S1", lnCd: "4", stinCd: "433" },
    { stationId: "station-sangnoksu", lineId: "seoul-4", railOprIsttCd: "KR", lnCd: "4", stinCd: "448" },
  ]);
  assert.deepEqual(await readFile(values.snapshotTargetPath), await readFile(values.snapshotFilePath));
  assert.equal(sha256(await readFile(values.snapshotTargetPath)), values.snapshotFileSha256);
  assert.equal(kricRows.length, 4);
  assert.ok(kricRows.every(({ sourceSnapshotId, description }) => sourceSnapshotId === values.snapshot.snapshotId && description.startsWith("fresh ")));
  assert.ok(kricStatus.length > 0 && kricStatus.every(({ sourceSnapshotId }) => sourceSnapshotId === values.snapshot.snapshotId));
});

test("admitted Seoul snapshot object, file, evidence, and ledger mismatch reject before writes", async (t) => {
  const cases = [
    [async (values) => ({ seoulSnapshot: { ...values.seoulSnapshot, stations: [] } }), /Seoul snapshot admission is invalid/],
    [async (values) => {
      await writeFile(path.join(path.dirname(path.dirname(path.dirname(path.dirname(values.snapshotTargetPath)))), seoulSnapshotPath), "{}");
      return {};
    }, /Seoul snapshot admission is invalid/],
    [async (values) => {
      const inventory = JSON.parse(await readFile(values.paths[registryPaths[0]], "utf8"));
      delete inventory.sources.find(({ id }) => id === "seoul-metro-accessibility").accessibilityAdmissionEvidence.absenceEvidenceMode;
      await writeFile(values.paths[registryPaths[0]], `${JSON.stringify(inventory, null, 2)}\n`);
      return {};
    }, /Seoul snapshot admission is invalid/],
    [async (values) => {
      const inventory = JSON.parse(await readFile(values.paths[registryPaths[0]], "utf8"));
      delete inventory.sources.find(({ id }) => id === "seoul-metro-accessibility").accessibilityAdmissionEvidence.observedAt;
      await writeFile(values.paths[registryPaths[0]], `${JSON.stringify(inventory, null, 2)}\n`);
      return {};
    }, /Seoul snapshot admission is invalid/],
    [async (values) => {
      const inventory = JSON.parse(await readFile(values.paths[registryPaths[0]], "utf8"));
      inventory.sources.find(({ id }) => id === "seoul-metro-accessibility").accessibilityAdmissionEvidence.snapshotId = "wrong";
      await writeFile(values.paths[registryPaths[0]], `${JSON.stringify(inventory, null, 2)}\n`);
      return {};
    }, /Seoul snapshot admission is invalid/],
    [async (values) => {
      const snapshots = JSON.parse(await readFile(values.paths[registryPaths[1]], "utf8"));
      snapshots.find(({ sourceId, snapshotId }) => sourceId === "seoul-metro-accessibility" && snapshotId === values.seoulSnapshot.snapshotId).retrievedAt = "wrong";
      await writeFile(values.paths[registryPaths[1]], `${JSON.stringify(snapshots, null, 2)}\n`);
      return {};
    }, /Seoul snapshot admission is invalid/],
    [async (values) => {
      const rootDirectory = path.dirname(path.dirname(path.dirname(path.dirname(values.snapshotTargetPath))));
      const seoulPath = path.join(rootDirectory, seoulSnapshotPath);
      const stale = JSON.parse(await readFile(seoulPath, "utf8"));
      stale.freshUntil = "2026-08-03T00:00:00.000Z";
      const staleBytes = Buffer.from(`${JSON.stringify(stale, null, 2)}\n`);
      await writeFile(seoulPath, staleBytes);
      const inventory = JSON.parse(await readFile(values.paths[registryPaths[0]], "utf8"));
      const evidence = inventory.sources.find(({ id }) => id === "seoul-metro-accessibility").accessibilityAdmissionEvidence;
      evidence.freshUntil = stale.freshUntil;
      evidence.snapshotFileSha256 = sha256(staleBytes);
      await writeFile(values.paths[registryPaths[0]], `${JSON.stringify(inventory, null, 2)}\n`);
      return { seoulSnapshot: stale };
    }, /Seoul snapshot admission freshness is invalid/],
    [async (values) => {
      const rootDirectory = path.dirname(path.dirname(path.dirname(path.dirname(values.snapshotTargetPath))));
      const seoulPath = path.join(rootDirectory, seoulSnapshotPath);
      const relabeled = JSON.parse(await readFile(seoulPath, "utf8"));
      relabeled.capturedAt = "2020-01-01T00:00:00.000Z";
      relabeled.observedAt = relabeled.capturedAt;
      relabeled.freshUntil = "2026-08-04T00:00:00.000Z";
      const relabeledBytes = Buffer.from(`${JSON.stringify(relabeled, null, 2)}\n`);
      await writeFile(seoulPath, relabeledBytes);
      const inventory = JSON.parse(await readFile(values.paths[registryPaths[0]], "utf8"));
      const evidence = inventory.sources.find(({ id }) => id === "seoul-metro-accessibility").accessibilityAdmissionEvidence;
      evidence.capturedAt = relabeled.capturedAt;
      evidence.observedAt = relabeled.observedAt;
      evidence.freshUntil = relabeled.freshUntil;
      evidence.snapshotFileSha256 = sha256(relabeledBytes);
      await writeFile(values.paths[registryPaths[0]], `${JSON.stringify(inventory, null, 2)}\n`);
      const snapshots = JSON.parse(await readFile(values.paths[registryPaths[1]], "utf8"));
      const ledger = snapshots.find(({ sourceId, snapshotId }) =>
        sourceId === "seoul-metro-accessibility" && snapshotId === relabeled.snapshotId);
      ledger.retrievedAt = relabeled.capturedAt;
      ledger.sourceUpdatedAt = relabeled.observedAt;
      ledger.freshnessExpiresAt = relabeled.freshUntil;
      await writeFile(values.paths[registryPaths[1]], `${JSON.stringify(snapshots, null, 2)}\n`);
      return { seoulSnapshot: relabeled };
    }, /Seoul snapshot admission freshness is invalid/],
    [async (values) => {
      const inventory = JSON.parse(await readFile(values.paths[registryPaths[0]], "utf8"));
      inventory.sources.find(({ id }) => id === "seoul-metro-accessibility").productionUseAllowed = false;
      await writeFile(values.paths[registryPaths[0]], `${JSON.stringify(inventory, null, 2)}\n`);
      return {};
    }, /Seoul snapshot admission is invalid/],
    [async (values) => {
      const inventory = JSON.parse(await readFile(values.paths[registryPaths[0]], "utf8"));
      inventory.sources.find(({ id }) => id === "seoul-metro-accessibility").license.redistributionAllowed = false;
      await writeFile(values.paths[registryPaths[0]], `${JSON.stringify(inventory, null, 2)}\n`);
      return {};
    }, /Seoul snapshot admission is invalid/],
    [async (values) => {
      const inventory = JSON.parse(await readFile(values.paths[registryPaths[0]], "utf8"));
      inventory.sources.find(({ id }) => id === "seoul-metro-accessibility").accessibilityAdmissionEvidence.decision = "REJECTED";
      await writeFile(values.paths[registryPaths[0]], `${JSON.stringify(inventory, null, 2)}\n`);
      return {};
    }, /Seoul snapshot admission is invalid/],
    [async (values) => {
      const snapshots = JSON.parse(await readFile(values.paths[registryPaths[1]], "utf8"));
      snapshots.find(({ sourceId, snapshotId }) => sourceId === "seoul-metro-accessibility" && snapshotId === values.seoulSnapshot.snapshotId).licenseStatus = "FAIL";
      await writeFile(values.paths[registryPaths[1]], `${JSON.stringify(snapshots, null, 2)}\n`);
      return {};
    }, /Seoul snapshot admission is invalid/],
  ];
  for (const [arrange, expected] of cases) {
    const values = await fixture(t);
    const overrides = await arrange(values);
    const before = await registryBytes(values);
    await assert.rejects(register(values, overrides), expected);
    assert.deepEqual(await registryBytes(values), before);
  }
});

test("KRIC snapshot requires the admitted full tuple roster and persists it", async (t) => {
  for (const invalidRoster of [
    roster.slice(1),
    [...roster, {
      ...roster[0],
      stationId: "station-extra",
      stinCd: "999",
      canonicalMappings: [{ artifactId: "bundled-capital", stationId: "station-extra", lineId: "seoul-4" }],
    }],
    [{ ...roster[0], stinCd: "999" }, roster[1]],
  ]) {
    const values = await fixture(t);
    await stageSnapshot(values, await snapshotFor(invalidRoster));
    await assert.rejects(register(values), /KRIC accessibility (roster|snapshot) coverage is invalid/);
    await assertUnchanged(values);
  }
  const values = await fixture(t);
  await register(values);
  const input = JSON.parse(await readFile(values.paths[registryPaths[2]], "utf8"));
  assert.equal(input.kricStandardAccessibilityRoster.length, 2);
});

test("KRIC scope의 station과 line projection은 실제 station-line rows로 충족해야 한다", async (t) => {
  for (const [field, missing] of [["includedStationIds", "station-missing"], ["includedLineIds", "line-missing"]]) {
    const values = await fixture(t);
    const input = JSON.parse(await readFile(values.paths[registryPaths[2]], "utf8"));
    input.supportedV1Scope[field].push(missing);
    await writeFile(values.paths[registryPaths[2]], `${JSON.stringify(input, null, 2)}\n`);
    const before = await registryBytes(values);
    await assert.rejects(register(values), /KRIC accessibility roster coverage is invalid/);
    assert.deepEqual(await registryBytes(values), before);
  }
});

test("KRIC scope의 mapping과 station-line row 누락은 등록 전에 거부한다", async (t) => {
  for (const [remove, expected] of [
    [(input, sourceKeys) => { input.stationMappings = input.stationMappings.filter((mapping) => !sourceKeys.has([mapping.sourceId, mapping.sourceStationCode, mapping.lineId].join("\0"))); }, /KRIC accessibility scope mapping is invalid/],
    [(input, sourceKeys) => {
      input.stationLineRows = input.stationLineRows.filter((row) => {
        const station = row.station ?? row;
        return !sourceKeys.has([station.sourceId, station.sourceStationCode, station.lineId].join("\0"));
      });
    }, /KRIC accessibility roster coverage is invalid/],
  ]) {
    const values = await fixture(t);
    const input = JSON.parse(await readFile(values.paths[registryPaths[2]], "utf8"));
    input.kricStandardAccessibilityRoster = values.snapshot.queries;
    const sourceKeys = new Set(input.stationMappings
      .filter(({ stationId, lineId }) => stationId === roster[0].stationId && lineId === roster[0].lineId)
      .map(({ sourceId, sourceStationCode, lineId }) => [sourceId, sourceStationCode, lineId].join("\0")));
    assert.ok(sourceKeys.size > 0);
    remove(input, sourceKeys);
    await writeFile(values.paths[registryPaths[2]], `${JSON.stringify(input, null, 2)}\n`);
    const before = await registryBytes(values);
    await assert.rejects(register(values), expected);
    assert.deepEqual(await registryBytes(values), before);
  }
});

test("pending PREPARED recovery runs before registration reads", async (t) => {
  const values = await fixture(t);
  await assert.rejects(register(values, {
    atomicReplaceImpl: async (target, bytes, phase) => {
      if (phase === 3) throw new Error("replace 3");
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, bytes);
    },
    rollbackAtomicReplaceImpl: async () => { throw new Error("rollback"); },
  }), /RECOVERY_REQUIRED/);
  await register(values);
  assert.equal(JSON.parse(await readFile(values.paths[registryPaths[1]], "utf8")).at(-1).snapshotId, values.snapshot.snapshotId);
});

test("transaction directory is synced before the PREPARED journal exists", async (t) => {
  const values = await fixture(t);
  const journalSeenDuringSync = [];
  await register(values, {
    syncTransactionDirectoryImpl: async () => {
      journalSeenDuringSync.push(await readFile(journalPath(values)).then(
        () => true,
        (error) => {
          if (error?.code === "ENOENT") return false;
          throw error;
        },
      ));
    },
  });
  assert.deepEqual(journalSeenDuringSync, [false]);
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

test("pending PREPARED journal은 lock-held registration recovery로 rollback하고 정리한다", async (t) => {
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
  await writeFile(values.snapshotFilePath, "not JSON");
  await assert.rejects(register(values), /snapshot file SHA-256 mismatch/);
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

test("동시 등록은 첫 등록의 배타 lock 동안 읽기나 staging 전에 fail closed 한다", async (t) => {
  const values = await fixture(t);
  let acquired;
  const lockAcquired = new Promise((resolve) => { acquired = resolve; });
  let release;
  const holdLock = new Promise((resolve) => { release = resolve; });
  const first = register(values, { onLockAcquired: async () => { acquired(); await holdLock; } });
  await lockAcquired;
  await assert.rejects(register(values), /already in progress/);
  await assertUnchanged(values);
  release();
  await first;
  assert.equal(sha256(await readFile(values.snapshotTargetPath)), values.snapshotFileSha256);
});

test("등록 오류와 lock release 오류가 함께 나면 원래 오류와 표준 cause를 보존한다", async (t) => {
  const values = await fixture(t);
  const repositoryRoot = path.dirname(path.dirname(path.dirname(path.dirname(values.snapshotTargetPath))));
  const lockDirectory = path.join(repositoryRoot, "tools/datapack/.kric-standard-registration.lock");
  await assert.rejects(register(values, {
    onLockAcquired: async () => {
      await rm(lockDirectory, { recursive: true, force: true });
      await writeFile(lockDirectory, "sabotaged lock directory");
      throw new Error("original registration failure");
    },
  }), (error) => {
    assert.equal(error.message, "original registration failure");
    assert.match(error.cause?.message, /KRIC registration lock RECOVERY_REQUIRED/);
    return true;
  });
});

test("receipt 시간은 저장 시각과 raw retention 순서를 엄격히 검증한다", async (t) => {
  for (const mutate of [
    (value) => { value.storedAt = "2026-08-03T00:02:00.000Z"; },
    (value) => { value.rawRetentionExpiresAt = value.storedAt; },
    (value) => { value.rawRetentionExpiresAt = "2099-01-01T00:00:00.000Z"; },
  ]) {
    const values = await fixture(t);
    const invalidReceipt = receipt(values.snapshot, values.snapshotFileSha256);
    mutate(invalidReceipt);
    await assert.rejects(register(values, { rawReceipt: invalidReceipt }), /raw receipt (storedAt|rawRetentionExpiresAt) (is invalid|does not match governance policy)/);
    await assertUnchanged(values);
  }
});

test("KRIC license governance 불일치는 registry write 전에 거부한다", async (t) => {
  for (const mutate of [
    (policy) => { policy.sources.find(({ sourceId }) => sourceId === "kric-station-convenience-standard").licenseReview.termsHash = "0".repeat(64); },
    (policy) => { policy.sources.find(({ sourceId }) => sourceId === "kric-station-convenience-standard").licenseReview.redistributionScopes = ["NOT_DERIVED_DATAPACK"]; },
  ]) {
    const values = await fixture(t);
    const policy = JSON.parse(await readFile(path.join(path.dirname(path.dirname(path.dirname(path.dirname(values.snapshotTargetPath)))), governancePolicyPath), "utf8"));
    mutate(policy);
    await writeFile(path.join(path.dirname(path.dirname(path.dirname(path.dirname(values.snapshotTargetPath)))), governancePolicyPath), `${JSON.stringify(policy, null, 2)}\n`);
    await assert.rejects(register(values), /KRIC license governance is invalid|REDISTRIBUTION_NOT_APPROVED/);
    await assertUnchanged(values);
  }
});

test("직접 실행 CLI 인자는 중복, 누락, 알 수 없는 값을 거부한다", () => {
  const parsed = parseKricStandardAccessibilitySnapshotRegistrationArgs([
    "--repository-root", "/repository", "--snapshot", "/staging/snapshot.json",
    "--snapshot-sha256", "a".repeat(64), "--raw-receipt", "/staging/receipt.json",
    "--seoul-snapshot", "/staging/seoul.json",
  ]);
  assert.deepEqual(parsed, {
    repositoryRoot: "/repository", snapshotFilePath: "/staging/snapshot.json", snapshotFileSha256: "a".repeat(64),
    rawReceiptPath: "/staging/receipt.json", seoulSnapshotPath: "/staging/seoul.json",
  });
  for (const args of [
    ["--snapshot", "/a", "--snapshot", "/b", "--snapshot-sha256", "a".repeat(64), "--raw-receipt", "/c", "--seoul-snapshot", "/d"],
    ["--snapshot", "/a", "--snapshot-sha256", "a".repeat(64), "--raw-receipt", "/c"],
    ["--repository-root", "", "--snapshot", "/a", "--snapshot-sha256", "a".repeat(64), "--raw-receipt", "/c", "--seoul-snapshot", "/d"],
    ["--unknown", "/a"],
  ]) assert.throws(() => parseKricStandardAccessibilitySnapshotRegistrationArgs(args), /CLI arguments/);
});

test("직접 실행 CLI는 절대 경로로 격리 fixture를 등록하고 상대 경로 인자 누락을 거부한다", async (t) => {
  const values = await fixture(t, new Date());
  const script = fileURLToPath(new URL("./register-kric-standard-accessibility-snapshot.mjs", import.meta.url));
  const repositoryRoot = path.dirname(path.dirname(path.dirname(path.dirname(values.snapshotTargetPath))));
  const rawReceiptPath = path.join(repositoryRoot, "staging", "raw-receipt.json");
  await writeFile(rawReceiptPath, `${JSON.stringify(receipt(values.snapshot, values.snapshotFileSha256, values.rawRetentionExpiresAt))}\n`);
  const successful = spawnSync(process.execPath, [
    script, "--repository-root", repositoryRoot, "--snapshot", values.snapshotFilePath,
    "--snapshot-sha256", values.snapshotFileSha256, "--raw-receipt", rawReceiptPath,
    "--seoul-snapshot", path.join(repositoryRoot, seoulSnapshotPath),
  ], { encoding: "utf8" });
  assert.equal(successful.status, 0, successful.stderr);
  assert.equal(sha256(await readFile(values.snapshotTargetPath)), values.snapshotFileSha256);
  const missingArgs = spawnSync(process.execPath, ["tools/datapack/register-kric-standard-accessibility-snapshot.mjs"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(missingArgs.status, 1);
  assert.match(missingArgs.stderr, /registration CLI arguments are invalid/);
});
