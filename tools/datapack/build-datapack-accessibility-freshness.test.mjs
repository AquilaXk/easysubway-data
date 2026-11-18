import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { sha256 } from "../lib/hash.mjs";
import {
  admittedKricEscalatorAccessibilityEvidence,
  productionAccessibilityFreshUntil,
} from "./build-datapack.mjs";

test("accessibility freshness ignores ordinary walk edges", (t) => {
  const previousBuildNow = process.env.EASYSUBWAY_DATAPACK_BUILD_NOW;
  process.env.EASYSUBWAY_DATAPACK_BUILD_NOW = "2026-07-28T00:00:00.000Z";
  t.after(() => {
    if (previousBuildNow === undefined) delete process.env.EASYSUBWAY_DATAPACK_BUILD_NOW;
    else process.env.EASYSUBWAY_DATAPACK_BUILD_NOW = previousBuildNow;
  });

  const freshUntil = productionAccessibilityFreshUntil([{
    facilities: [],
    stationFacilityEvidence: [],
    networkEdges: [
      { edgeType: "WALK", sourceId: "topology", sourceSnapshotId: "topology-snapshot" },
      { edgeType: "ENTRY", sourceId: "accessibility", sourceSnapshotId: "accessibility-snapshot" },
    ],
  }], {
    sources: [{ id: "accessibility", accessibilityAdmissionEvidence: {
      snapshotId: "accessibility-snapshot", freshUntil: "2026-07-28T00:00:00.000Z",
    } }],
  }, [{
    sourceId: "accessibility", snapshotId: "accessibility-snapshot",
    freshnessExpiresAt: "2026-08-28T00:00:00.000Z",
  }]);

  assert.equal(freshUntil, "2026-08-28T00:00:00.000Z");
});

test("accessibility freshness fails closed at the locked snapshot policy boundary", (t) => {
  const previousBuildNow = process.env.EASYSUBWAY_DATAPACK_BUILD_NOW;
  process.env.EASYSUBWAY_DATAPACK_BUILD_NOW = "2026-07-28T00:00:00.000Z";
  t.after(() => {
    if (previousBuildNow === undefined) delete process.env.EASYSUBWAY_DATAPACK_BUILD_NOW;
    else process.env.EASYSUBWAY_DATAPACK_BUILD_NOW = previousBuildNow;
  });

  assert.throws(() => productionAccessibilityFreshUntil([{
    facilities: [{ sourceId: "accessibility", sourceSnapshotId: "accessibility-snapshot" }],
  }], {
    sources: [{ id: "accessibility", accessibilityAdmissionEvidence: {
      snapshotId: "accessibility-snapshot", freshUntil: "2026-07-29T00:00:00.000Z",
    } }],
  }, [{
    sourceId: "accessibility", snapshotId: "accessibility-snapshot",
    freshnessExpiresAt: "2026-07-28T00:00:00.000Z",
  }]), /production accessibility snapshot is stale: accessibility/);
});

test("accessibility freshness reports missing admission without a TypeError", () => {
  assert.throws(() => productionAccessibilityFreshUntil([{
    facilities: [{ sourceId: "missing", sourceSnapshotId: undefined }],
  }], { sources: [] }, []), /production accessibility evidence mismatch: missing/);
});

test("registered Incheon accessibility freshness uses the generic candidate projection", () => {
  const sourceId = "incheon-transit-accessibility";
  const snapshotId = "incheon-transit-accessibility-20260828T043356000Z";
  const evidenceHash = "a".repeat(64);
  const schemaFingerprint = "b".repeat(64);
  const claimBindingsSha256 = "c".repeat(64);
  const adminReviewRecordHash = "d".repeat(64);
  const rawSha256 = "e".repeat(64);
  const source = {
    id: sourceId,
    requiredForProductionPack: true,
    productionUseAllowed: true,
    license: { redistributionAllowed: true },
    admissionEvidence: { sampleEvidenceHash: evidenceHash, adminReviewRecordHash },
    registrationEvidence: {
      sourceId,
      snapshotId,
      rawObjectUri: "oci://example/incheon.json",
      rawObjectSha256: rawSha256,
      normalizedSchemaFingerprint: schemaFingerprint,
      claimBindingsSha256,
      adminReviewRecordHash,
    },
  };
  const admission = { source, snapshotId, evidenceHash };
  assert.equal(productionAccessibilityFreshUntil([{
    facilities: [{ sourceId, sourceSnapshotId: snapshotId, evidenceHash }],
  }], { sources: [source] }, [{
    sourceId,
    snapshotId,
    rawObjectUri: "oci://example/incheon.json",
    rawSha256,
    schemaFingerprint,
    adminReviewRecordHash,
    licenseStatus: "PASS",
    redistributionAllowed: true,
    credentialRedacted: true,
    snapshotStatus: "LOCKED",
    freshnessExpiresAt: "2026-08-28T00:00:00.000Z",
  }], new Date("2026-07-28T00:00:00.000Z"), {
    admittedAccessibilityEvidence: new Map([[sourceId, admission]]),
  }), "2026-08-28T00:00:00.000Z");
});

test("registered KRIC escalator accessibility freshness validates per-query evidenceHashes Set", () => {
  const sourceId = "kric-station-escalator-detailed";
  const snapshotId = "kric-station-escalator-detailed-20261105T201741340Z";
  const facilityEvidenceHash = "a".repeat(64);
  const statusEvidenceHash = "b".repeat(64);
  const source = {
    id: sourceId,
    requiredForProductionPack: false,
    productionUseAllowed: true,
    license: { redistributionAllowed: true },
    accessibilityAdmissionEvidence: {
      snapshotId,
      freshUntil: "2026-11-06T20:17:41.340Z",
    },
  };
  const admission = {
    source,
    snapshotId,
    freshUntil: "2026-11-06T20:17:41.340Z",
    evidenceHashes: new Set([facilityEvidenceHash, statusEvidenceHash]),
  };
  assert.equal(productionAccessibilityFreshUntil([{
    facilities: [{ sourceId, sourceSnapshotId: snapshotId, evidenceHash: facilityEvidenceHash }],
    stationFacilityEvidence: [{ sourceId, sourceSnapshotId: snapshotId, evidenceHash: statusEvidenceHash }],
  }], { sources: [source] }, [], new Date("2026-11-05T20:30:00.000Z"), {
    admittedAccessibilityEvidence: new Map([[sourceId, admission]]),
  }), "2026-11-06T20:17:41.340Z");
  assert.throws(() => productionAccessibilityFreshUntil([{
    facilities: [{ sourceId, sourceSnapshotId: snapshotId, evidenceHash: "c".repeat(64) }],
  }], { sources: [source] }, [], new Date("2026-11-05T20:30:00.000Z"), {
    admittedAccessibilityEvidence: new Map([[sourceId, admission]]),
  }), /production accessibility snapshot mismatch: kric-station-escalator-detailed/);
});

test("admittedKricEscalatorAccessibilityEvidence skips snapshot lookup when packs omit KRIC escalator rows", async (t) => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "kric-escalator-skip-"));
  t.after(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  const sourceId = "kric-station-escalator-detailed";
  const snapshotId = "kric-station-escalator-detailed-20261105T201741340Z";
  const inventory = {
    sources: [{
      id: sourceId,
      requiredForProductionPack: false,
      productionUseAllowed: true,
      capabilities: { facility: { productionUseAllowed: true } },
      license: { redistributionAllowed: true },
      admissionEvidence: { licenseEvidenceHash: "2".repeat(64) },
      accessibilityAdmissionEvidence: {
        decision: "APPROVED",
        productionUseAllowed: true,
        licenseEvidenceHash: "2".repeat(64),
        snapshotId,
        snapshotPath: `tools/datapack/sources/${snapshotId}.json`,
        capturedAt: "2026-11-05T20:17:41.340Z",
        observedAt: "2026-11-05T20:17:41.340Z",
        freshUntil: "2026-11-06T20:17:41.340Z",
        absenceEvidenceMode: "EXHAUSTIVE_LIST",
        rawSha256: "3".repeat(64),
        contentSha256: "4".repeat(64),
        schemaFingerprint: "bf492f17cab7aa5ff8bb4ca4426162d6833bb6de639d1c3613d4ec2e47f892ab",
        snapshotFileSha256: "5".repeat(64),
      },
    }],
  };
  const packsWithoutEscalator = [{
    facilities: [{ sourceId: "kric-station-convenience-standard" }],
    stationFacilityEvidence: [{ sourceId: "kric-station-convenience-standard" }],
    networkEdges: [{ edgeType: "ENTRY", sourceId: "seoul-metro-accessibility" }],
  }];

  const skippedAdmission = await admittedKricEscalatorAccessibilityEvidence(
    inventory,
    packsWithoutEscalator,
    tempRoot,
  );
  assert.equal(skippedAdmission, null);
});

test("admittedKricEscalatorAccessibilityEvidence validates snapshot identity and rejects tampering", async (t) => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "kric-escalator-admit-"));
  t.after(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  const sourceId = "kric-station-escalator-detailed";
  const capturedAt = "2026-11-05T20:17:41.340Z";
  const freshUntil = "2026-11-06T20:17:41.340Z";
  const snapshotId = "kric-station-escalator-detailed-20261105T201741340Z";
  const stationId = "station-9707f89c740a";
  const lineId = "shinbundang";
  const row = {
    dtlLoc: "(B2) 오금환승",
    exitNo: null,
    grndDvNmFr: "지하",
    grndDvNmTo: "지하",
    lnCd: "D1",
    railOprIsttCd: "DX",
    runStinFlorFr: 2,
    runStinFlorTo: 1,
    stinCd: "D004",
    updnDvNm: "상행",
  };
  const rows = [row];
  const rawResponseSha256 = "1".repeat(64);
  const providerRecordHash = sha256(JSON.stringify(rows));
  const query = {
    stationId,
    lineId,
    railOprIsttCd: "DX",
    lnCd: "D1",
    stinCd: "D004",
    canonicalMappings: [{ artifactId: "bundled-capital", stationId, lineId }],
    status: "PRESENT",
    rawResponseSha256,
    providerRecordHash,
    rows,
  };
  const queries = [query];
  const { rawResponseSha256: _ignoredRaw, ...contentQuery } = query;
  const contentSha256 = sha256(JSON.stringify([contentQuery]));
  const rawSha256 = sha256(JSON.stringify([{
    stationId,
    lineId,
    railOprIsttCd: "DX",
    lnCd: "D1",
    stinCd: "D004",
    rawResponseSha256,
  }]));
  const schemaFingerprint = sha256(JSON.stringify([
    "dtlLoc", "exitNo", "grndDvNmFr", "grndDvNmTo", "lnCd",
    "railOprIsttCd", "runStinFlorFr", "runStinFlorTo", "stinCd", "updnDvNm",
  ]));
  const redactedRequestFingerprint = sha256(JSON.stringify({
    endpoint: "https://openapi.kric.go.kr/openapi/convenientInfo/stationEscalator",
    tuples: [{ railOprIsttCd: "DX", lnCd: "D1", stinCd: "D004" }],
  }));
  const snapshot = {
    schemaVersion: 1,
    artifactKind: "kric-accessibility-snapshot",
    sourceId,
    snapshotId,
    capturedAt,
    observedAt: capturedAt,
    freshUntil,
    credentialRedacted: true,
    providerResultCode: "00",
    schemaStatus: "PASS",
    absenceEvidenceMode: "EXHAUSTIVE_LIST",
    queryCount: 1,
    rowCount: 1,
    rawSha256,
    contentSha256,
    schemaFingerprint,
    redactedRequestFingerprint,
    queries,
  };
  const snapshotRelPath = `tools/datapack/sources/${snapshotId}.json`;
  const snapshotAbsPath = path.join(tempRoot, snapshotRelPath);
  await mkdir(path.dirname(snapshotAbsPath), { recursive: true });
  const snapshotBytes = `${JSON.stringify(snapshot, null, 2)}\n`;
  await writeFile(snapshotAbsPath, snapshotBytes, "utf8");
  const snapshotFileSha256 = sha256(snapshotBytes);
  const licenseEvidenceHash = "2".repeat(64);

  const validSource = {
    id: sourceId,
    requiredForProductionPack: false,
    productionUseAllowed: true,
    capabilities: { facility: { productionUseAllowed: true } },
    license: { redistributionAllowed: true },
    admissionEvidence: { licenseEvidenceHash },
    accessibilityAdmissionEvidence: {
      decision: "APPROVED",
      productionUseAllowed: true,
      licenseEvidenceHash,
      snapshotId,
      snapshotPath: snapshotRelPath,
      capturedAt,
      observedAt: capturedAt,
      freshUntil,
      absenceEvidenceMode: "EXHAUSTIVE_LIST",
      rawSha256,
      contentSha256,
      schemaFingerprint,
      snapshotFileSha256,
    },
  };
  const expectedRowEvidenceHash = sha256(JSON.stringify({
    snapshotId,
    query: { railOprIsttCd: "DX", lnCd: "D1", stinCd: "D004" },
    providerRecordHash: sha256(JSON.stringify(row)),
  }));
  const packs = [{
    stations: [{ id: stationId, nameKo: "신사" }],
    stationLines: [{ stationId, lineId }],
    facilities: [{
      sourceId,
      sourceSnapshotId: snapshotId,
      evidenceHash: expectedRowEvidenceHash,
    }],
  }];

  const admitted = await admittedKricEscalatorAccessibilityEvidence(
    { sources: [validSource] },
    packs,
    tempRoot,
  );
  assert.equal(admitted?.snapshotId, snapshotId);
  assert.equal(admitted?.freshUntil, "2026-11-06T20:17:41.340Z");
  assert.equal(admitted?.evidenceHashes.has(expectedRowEvidenceHash), true);
  assert.equal(productionAccessibilityFreshUntil(
    packs,
    { sources: [validSource] },
    [],
    new Date("2026-11-05T20:30:00.000Z"),
    { admittedAccessibilityEvidence: new Map([[sourceId, admitted]]) },
  ), "2026-11-06T20:17:41.340Z");

  const mismatchedLicenseInventory = {
    sources: [{
      ...validSource,
      accessibilityAdmissionEvidence: {
        ...validSource.accessibilityAdmissionEvidence,
        licenseEvidenceHash: "9".repeat(64),
      },
    }],
  };
  await assert.rejects(
    admittedKricEscalatorAccessibilityEvidence(mismatchedLicenseInventory, packs, tempRoot),
    /production accessibility snapshot mismatch: kric-station-escalator-detailed/,
  );

  const tamperedSnapshot = {
    ...snapshot,
    queries: [{ ...query, providerRecordHash: "f".repeat(64) }],
  };
  const tamperedBytes = `${JSON.stringify(tamperedSnapshot, null, 2)}\n`;
  await writeFile(snapshotAbsPath, tamperedBytes, "utf8");
  const tamperedInventory = {
    sources: [{
      ...validSource,
      accessibilityAdmissionEvidence: {
        ...validSource.accessibilityAdmissionEvidence,
        snapshotFileSha256: sha256(tamperedBytes),
      },
    }],
  };
  await assert.rejects(
    admittedKricEscalatorAccessibilityEvidence(tamperedInventory, packs, tempRoot),
    /production accessibility snapshot mismatch: kric-station-escalator-detailed/,
  );
});

