import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { terminalHead } from "./build-current-five-region-source-fan-in.mjs";
import { deriveFreshnessExpiresAt } from "./freshness-policy.mjs";
import { canonicalJson } from "./lib/manifest-validation.mjs";
import { deriveRawRetentionExpiresAt, validateSourceGovernancePolicy } from "./source-governance-policy.mjs";
import { validateLineage } from "./source-snapshot-policy.mjs";
import {
  INCHEON_DATAPACK_SOURCE_IDS,
  INCHEON_DATAPACK_SOURCE_SPECS,
  buildIncheonInventoryAndGovernance,
  prepareIncheonDatapackSourceRegistration,
  publishAndRegisterIncheonDatapackSources,
} from "./register-incheon-datapack-sources.mjs";

const root = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const TEST_PAR_BASE_URL = "https://objectstorage.ap-seoul-1.oraclecloud.com/p/test-par-secret/n/axvym6vk8g7i/b/easysubway-datapacks/o/";

test("추적 중인 inventory·거버넌스 정책·원장은 인천 3개 원천을 LOCKED 행으로 정식 등록한다", async () => {
  const [inventoryBytes, governanceBytes, freshnessBytes, ledgerBytes] = await Promise.all([
    readFile(path.join(root, "tools/datapack/source-inventory.json")),
    readFile(path.join(root, "tools/datapack/source-governance-policy.json")),
    readFile(path.join(root, "release/product-gates/datapack-freshness-sla.json")),
    readFile(path.join(root, "tools/datapack/release/source-snapshots.json")),
  ]);
  const inventory = JSON.parse(inventoryBytes);
  const governance = JSON.parse(governanceBytes);
  const freshness = JSON.parse(freshnessBytes);
  const ledger = JSON.parse(ledgerBytes);

  assert.doesNotThrow(() => validateSourceGovernancePolicy({
    policy: governance,
    inventory,
    freshnessPolicy: freshness,
  }));
  assert.doesNotThrow(() => validateLineage(ledger));

  const sourceById = new Map(inventory.sources.map((source) => [source.id, source]));
  const governanceById = new Map(governance.sources.map((entry) => [entry.sourceId, entry]));

  for (const spec of INCHEON_DATAPACK_SOURCE_SPECS) {
    const source = sourceById.get(spec.sourceId);
    assert.ok(source, `${spec.sourceId} inventory entry`);
    assert.equal(source.requiredForProductionPack, false, `${spec.sourceId} requiredForProductionPack`);
    const expectedTermsHash = sha256(canonicalJson(source.license));
    assert.deepEqual(source.admissionEvidence, { licenseEvidenceHash: expectedTermsHash }, `${spec.sourceId} admissionEvidence`);

    const govEntry = governanceById.get(spec.sourceId);
    assert.ok(govEntry, `${spec.sourceId} governance entry`);
    assert.equal(govEntry.sourceClassId, spec.sourceClassId);
    assert.equal(govEntry.retentionClassId, "standard-90d");
    assert.deepEqual(govEntry.licenseReview, {
      status: "APPROVED",
      termsHash: expectedTermsHash,
      reviewedAt: "2026-10-01T00:00:00.000Z",
      nextReviewAt: "2027-10-01T00:00:00.000Z",
      termsUrl: source.license.evidenceUrl,
      reviewedProvider: "인천교통공사",
      reviewedDatasetUrl: source.datasetUrl,
      redistributionScopes: ["DERIVED_DATAPACK"],
      approvedByRole: "datapack-release-approver",
    });

    const evidence = source[spec.admissionKind];
    const head = terminalHead(spec.sourceId, ledger);
    assert.equal(head.snapshotStatus, "LOCKED");
    assert.equal(head.snapshotId, evidence.snapshotId);
    assert.equal(head.provider, "인천교통공사");
    assert.equal(head.rawSha256, evidence.rawSha256);
    assert.equal(head.contentSha256, evidence.contentSha256);
    assert.equal(head.capturedAt, evidence.capturedAt);
    assert.equal(head.retrievedAt, evidence.capturedAt);
    assert.equal(head.freshnessExpiresAt, deriveFreshnessExpiresAt({
      policy: freshness,
      sourceClassId: spec.sourceClassId,
      basisAt: evidence.capturedAt,
      evaluationAt: evidence.capturedAt,
    }));
    assert.equal(head.rawRetentionExpiresAt, deriveRawRetentionExpiresAt({
      policy: governance,
      sourceId: spec.sourceId,
      retrievedAt: evidence.capturedAt,
    }));
    assert.deepEqual(head.admissionRecordSha256s, [{
      kind: spec.admissionKind,
      sha256: sha256(canonicalJson(evidence)),
    }]);
  }
});

test("registerIncheonDatapackSources는 OCI 원본 발행·영수증 검증·원장 LOCKED 등록을 수행하고 위변조 입력을 거부한다", async () => {
  const [inventoryBytes, governanceBytes, freshnessBytes, ledgerBytes] = await Promise.all([
    readFile(path.join(root, "tools/datapack/source-inventory.json")),
    readFile(path.join(root, "tools/datapack/source-governance-policy.json")),
    readFile(path.join(root, "release/product-gates/datapack-freshness-sla.json")),
    readFile(path.join(root, "tools/datapack/release/source-snapshots.json")),
  ]);
  const baseLedger = JSON.parse(ledgerBytes).filter((row) => !INCHEON_DATAPACK_SOURCE_IDS.includes(row.sourceId));
  const storedObjects = new Map();
  const mockClient = {
    async putObjectIfAbsent(objectKey, bytes) {
      if (storedObjects.has(objectKey)) return false;
      storedObjects.set(objectKey, Buffer.from(bytes));
      return true;
    },
    async readObject(objectKey) {
      const body = storedObjects.get(objectKey);
      return body ? { exists: true, body } : { exists: false };
    },
  };
  const now = new Date("2026-11-09T01:00:00.000Z");
  const result = await publishAndRegisterIncheonDatapackSources({
    repositoryRoot: root,
    inventoryBytes,
    governanceBytes,
    freshnessBytes,
    ledgerBytes: Buffer.from(`${JSON.stringify(baseLedger, null, 2)}\n`),
    env: { EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL: TEST_PAR_BASE_URL },
    client: mockClient,
    now,
    writeFiles: false,
  });

  assert.equal(result.addedRows.length, 3);
  assert.equal(storedObjects.size, 3);
  for (const row of result.addedRows) {
    assert.equal(row.snapshotStatus, "LOCKED");
    assert.match(row.rawObjectUri, /^oci:\/\/axvym6vk8g7i\/easysubway-datapacks\/source-raw\/incheon-/u);
  }

  // 이미 등록된 스냅샷 재등록 거부
  await assert.rejects(
    publishAndRegisterIncheonDatapackSources({
      repositoryRoot: root,
      inventoryBytes: result.inventoryBytes,
      governanceBytes: result.governanceBytes,
      freshnessBytes,
      ledgerBytes: result.ledgerBytes,
      env: { EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL: TEST_PAR_BASE_URL },
      client: mockClient,
      now,
      writeFiles: false,
    }),
    /Incheon source snapshot is already registered/u,
  );

  // 라이선스 약관 위변조 거부
  const tamperedInventory = JSON.parse(inventoryBytes);
  tamperedInventory.sources.find(({ id }) => id === "incheon-transit-station-info").license.type = "UNKNOWN";
  assert.throws(
    () => buildIncheonInventoryAndGovernance({
      inventoryBytes: Buffer.from(JSON.stringify(tamperedInventory)),
      governanceBytes,
      freshnessPolicy: JSON.parse(freshnessBytes),
      now,
    }),
    /Incheon source license is invalid/u,
  );

  // 미래 관측 시각 거부
  await assert.rejects(
    prepareIncheonDatapackSourceRegistration({
      repositoryRoot: root,
      inventoryBytes,
      governanceBytes,
      freshnessBytes,
      ledgerBytes: Buffer.from(`${JSON.stringify(baseLedger, null, 2)}\n`),
      now: new Date("2026-11-08T00:00:00.000Z"),
    }),
    /Incheon source snapshot freshness is not current/u,
  );
});
