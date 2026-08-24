import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  buildCurrentTransferSourceAdmission,
  canonicalCurrentTransferSourceAdmissionJson,
  main,
} from "./build-current-transfer-source-admission.mjs";
import { canonicalTransferTopologyAdmissionJson } from "./build-transfer-topology-admission.mjs";
import { evaluateCurrentMolitTransferFreshness } from "./evaluate-current-molit-transfer-freshness.mjs";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const TRANSFER_FRESHNESS_EVALUATED_AT = "2026-08-14T05:30:38.000Z";
const EVIDENCE = observationEvidence();
const BASE_INPUT = await trackedInput();

test("legacy TRANSFER CLI는 staged transition을 입력보다 먼저 차단한다", async () => {
  const source = await readFile(new URL("./build-current-transfer-source-admission.mjs", import.meta.url), "utf8");
  const guard = source.indexOf("await assertCurrentCapitalAccessibilityBuildAllowed({ repositoryRoot: root });");
  const inputRead = source.indexOf("const [\n    candidateBuildSpec, facilityAdmission");
  assert.ok(guard >= 0, "staged transition guard가 필요하다");
  assert.ok(guard < inputRead, "staged transition guard는 legacy 입력보다 먼저 실행돼야 한다");
});

test("current official full source를 present와 exhaustive not-applicable로 admission한다", () => {
  const result = buildCurrentTransferSourceAdmission(cloneInput());

  assert.equal(result.sourceAdmission.decision, "APPROVED");
  assert.equal(result.sourceAdmission.productionUseAllowed, true);
  assert.deepEqual(result.sourceAdmission.coverageScope, {
    absenceEvidenceMode: "EXHAUSTIVE_OFFICIAL_FILE",
    notApplicableTargetCount: 1,
    observedTargetCount: 1,
    selectedRowCount: 22,
    targetStationLineCount: 2,
  });
  assert.equal(result.admission.schemaVersion, 2);
  assert.equal(result.admission.decision, "GO");
  assert.deepEqual(result.admission.cells.map(({ stationId, state }) => ({ stationId, state })), [
    { stationId: "station-sadang", state: "ADMITTED_TRANSFER_TOPOLOGY" },
    { stationId: "station-sangnoksu", state: "ADMITTED_NOT_APPLICABLE" },
  ]);
  assert.deepEqual(result.admission.materializerEvidenceRows.map(({ state, evidenceKind }) => ({
    state, evidenceKind,
  })), [
    { state: "VERIFIED_PRESENT", evidenceKind: "OBSERVED" },
    { state: "NOT_APPLICABLE", evidenceKind: "CURRENT_APPLICABILITY_RULE" },
  ]);
  assert.match(result.admission.materializerEvidenceRows[1].providerRecordHash, /^[0-9a-f]{64}$/u);
  assert.doesNotThrow(() => canonicalCurrentTransferSourceAdmissionJson(result.sourceAdmission));
  assert.doesNotThrow(() => canonicalTransferTopologyAdmissionJson(result.admission));
});

test("observation·freshness·candidate·source identity drift를 fail closed한다", () => {
  const cases = [
    ["observation", (input) => { input.revalidationEvidence.evidenceHash = "0".repeat(64); }],
    ["freshness", (input) => { input.freshnessResult.extendedFreshUntil = "2027-08-15T00:00:00.000Z"; }],
    ["facility", (input) => { input.facilityAdmission.admissionDigest = "0".repeat(64); }],
    ["candidate", (input) => { input.candidateBuildSpec.sourceSnapshotSetHash = "0".repeat(64); }],
    ["source", (input) => { input.sourceInventory.sources.find(({ id }) => id === "molit-railway-transfer-movement").rawSnapshotAdmission.rowCount = 8_053; }],
  ];
  for (const [label, mutate] of cases) {
    const input = cloneInput();
    mutate(input);
    assert.throws(() => buildCurrentTransferSourceAdmission(input), /admission|candidate|freshness|source|identity|revalidation/i, label);
  }
});

test("ambiguous target mapping과 partial official identity는 absence admission을 만들지 않는다", () => {
  const ambiguous = cloneInput();
  ambiguous.productionInput.kricStandardAccessibilityRoster.push(
    structuredClone(ambiguous.productionInput.kricStandardAccessibilityRoster[0]),
  );
  assert.throws(() => buildCurrentTransferSourceAdmission(ambiguous), /target mapping/i);

  const wrongStation = cloneInput();
  wrongStation.productionInput.kricStandardAccessibilityRoster
    .find(({ stationId }) => stationId === "station-sadang").stinCd = "448";
  assert.throws(() => buildCurrentTransferSourceAdmission(wrongStation), /target mapping/i);

  const partial = cloneInput();
  partial.metadata.rowCount = 8_053;
  assert.throws(() => buildCurrentTransferSourceAdmission(partial), /source|snapshot|identity/i);
});

test("CLI는 self-bound 두 handoff를 legacy/current candidate 경계 밖에서 재발행하지 않는다", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "current-transfer-admission-"));
  const evidencePath = path.join(root, "evidence.json");
  const freshnessPath = path.join(root, "freshness.json");
  const outputDirectory = path.join(root, "output");
  await writeFile(evidencePath, `${JSON.stringify(EVIDENCE, null, 2)}\n`, { mode: 0o600 });
  await writeFile(freshnessPath, `${JSON.stringify(BASE_INPUT.freshnessResult, null, 2)}\n`, { mode: 0o600 });
  const argv = [
    "--revalidation-evidence", evidencePath,
    "--freshness-result", freshnessPath,
    "--observed-at", BASE_INPUT.observedAt,
    "--output-directory", outputDirectory,
  ];

  if (await fileExists(path.join(REPOSITORY_ROOT, "tools/datapack/release/current-capital-accessibility-transition.json"))) {
    await assert.rejects(
      main(argv, { repositoryRoot: REPOSITORY_ROOT, log: () => {} }),
      /CURRENT_ACCESSIBILITY_TRANSITION_BLOCKED/,
    );
    assert.equal(await fileExists(outputDirectory), false);
    return;
  }

  await assert.rejects(
    main(argv, { repositoryRoot: REPOSITORY_ROOT, log: () => {} }),
    /candidate source identity mismatch/,
  );
  assert.equal(await fileExists(outputDirectory), false);
});

test("tracked current TRANSFER handoff는 exact two-cell GO identity를 고정한다", async () => {
  const [sourceBytes, admissionBytes] = await Promise.all([
    readFile(new URL("./release/current-transfer-admission/transfer-topology-source-admission.json", import.meta.url)),
    readFile(new URL("./release/current-transfer-admission/transfer-topology-admission.json", import.meta.url)),
  ]);
  const source = JSON.parse(sourceBytes);
  const admission = JSON.parse(admissionBytes);
  assert.equal(source.admissionDigest, "980ff67717804653ef1b352d64354e87fc8b691e91282701ddfaa29e13e88f83");
  assert.equal(admission.admissionDigest, "c9b5d0a883b06129a8339904437f69220627f5ee62b7020b320e0eb8ea4cdfbc");
  assert.equal(source.revalidationEvidenceSha256, EVIDENCE.evidenceHash);
  assert.equal(source.freshnessResultSha256, "81f77134af3c784ecf57e2bdbd6f0f6cc6edcd2d2259120ecc1d144f6028f9c2");
  assert.deepEqual(admission.stateSummary, {
    ADMITTED_NOT_APPLICABLE: 1,
    ADMITTED_TRANSFER_TOPOLOGY: 1,
    BLOCKED_WITH_EVIDENCE: 0,
    MISSING: 0,
    STALE: 0,
    UNKNOWN: 0,
  });
  assert.equal(canonicalCurrentTransferSourceAdmissionJson(source), sourceBytes.toString("utf8"));
  assert.equal(`${canonicalTransferTopologyAdmissionJson(admission)}\n`, admissionBytes.toString("utf8"));
});

async function trackedInput() {
  const readJson = async (relative) => JSON.parse(await readFile(path.join(REPOSITORY_ROOT, relative)));
  const [
    candidateBuildSpec, facilityAdmission, gzipBytes, metadataBytes, policy,
    productionInput, providerCodeCatalog, sourceInventory, sourceSnapshots,
  ] = await Promise.all([
    readJson("tools/datapack/release/candidate-build-spec.json"),
    readJson("tools/datapack/release/facility-source-admission.json"),
    readFile(path.join(REPOSITORY_ROOT, "tools/datapack/sources/molit-railway-transfer-movement-20250811.csv.gz")),
    readFile(path.join(REPOSITORY_ROOT, "tools/datapack/sources/molit-railway-transfer-movement-20250811.csv.gz.json")),
    readJson("release/product-gates/datapack-freshness-sla.json"),
    readJson("tools/datapack/inputs/capital-pilot-production-source-input.json"),
    readJson("tools/datapack/sources/kric-provider-code-catalog-20260228.json"),
    readJson("tools/datapack/source-inventory.json"),
    readJson("tools/datapack/release/source-snapshots.json"),
  ]);
  const metadata = JSON.parse(metadataBytes);
  const legacyKricSnapshotId = facilityAdmission.cells[0].sourceSnapshotId;
  assert.ok(facilityAdmission.cells.every(({ sourceSnapshotId }) => sourceSnapshotId === legacyKricSnapshotId));
  const historicalSourceIds = candidateBuildSpec.sourceSnapshots
    .filter(({ sourceId }) => sourceId !== "seoul-metro-transfer-distance-duration")
    .map(({ snapshotId, sourceId }) => {
      const selectedHead = sourceSnapshots.find((entry) => entry.snapshotId === snapshotId
        && entry.sourceId === sourceId);
      const migration = selectedHead?.projectionMigration;
      if (migration?.migrationKind !== "CROSS_SOURCE_CANONICAL_REPLACEMENT"
        || migration.sourceId !== sourceId) return sourceId;
      assert.equal(migration.candidateSlotSourceId, migration.replacedSourceId);
      return migration.replacedSourceId;
    });
  assert.equal(historicalSourceIds.length, 6);
  assert.ok(historicalSourceIds.includes("seoulmetro-cyberstation-route-map"));
  assert.equal(historicalSourceIds.includes("seoul-metro-route-map-positions"), false);
  assert.equal(legacyKricSnapshotId, "kric-station-convenience-standard-20260813T200604805Z");
  const historicalObservedAt = facilityAdmission.observedAt;
  const selected = historicalSourceIds.map((sourceId) => {
    const candidates = sourceSnapshots.filter((entry) => entry.sourceId === sourceId
      && sourceBasisAt(entry) <= Date.parse(historicalObservedAt));
    assert.ok(candidates.length > 0, `historical source head: ${sourceId}`);
    return candidates.at(-1);
  });
  assert.equal(selected.find(({ sourceId }) => sourceId === "kric-station-convenience-standard").snapshotId, legacyKricSnapshotId);
  const selectedIds = new Set(selected.map(({ snapshotId }) => snapshotId));
  const selectedInLedgerOrder = sourceSnapshots.filter(({ snapshotId }) => selectedIds.has(snapshotId));
  const projectionKeys = [
    "snapshotId", "sourceId", "rawObjectUri", "rawSha256", "schemaFingerprint",
    "licenseStatus", "redistributionAllowed", "snapshotStatus", "credentialRedacted",
  ];
  const legacyCandidateBuildSpec = {
    ...candidateBuildSpec,
    candidateId: facilityAdmission.candidate.candidateId,
    sourceSnapshotIds: selected.map(({ snapshotId }) => snapshotId),
    sourceSnapshots: selected.map((entry) => Object.fromEntries(projectionKeys.map((key) => [key, entry[key]]))),
    sourceSnapshotSetHash: sha256(JSON.stringify(selectedInLedgerOrder)),
  };
  assert.equal(legacyCandidateBuildSpec.sourceSnapshotSetHash, facilityAdmission.candidate.sourceSetSha256);
  assert.ok(Date.parse(TRANSFER_FRESHNESS_EVALUATED_AT) <= Date.parse(historicalObservedAt),
    "immutable TRANSFER freshness evaluation precedes the historical FACILITY handoff");
  const evaluationAt = TRANSFER_FRESHNESS_EVALUATED_AT;
  const freshnessResult = evaluateCurrentMolitTransferFreshness({
    evidence: EVIDENCE,
    evaluationAt,
    gzipBytes,
    metadata,
    metadataBytes,
    now: Date.parse(evaluationAt),
    policy,
  });
  return {
    candidateBuildSpec: legacyCandidateBuildSpec,
    facilityAdmission,
    freshnessResult,
    gzipBytes,
    metadata,
    metadataBytes,
    observedAt: historicalObservedAt,
    policy,
    productionInput,
    providerCodeCatalog,
    revalidationEvidence: EVIDENCE,
    sourceInventory,
    sourceSnapshots,
  };
}

function sourceBasisAt(entry) {
  const value = Math.max(...[entry.retrievedAt, entry.sourceUpdatedAt, entry.capturedAt, entry.rawReceipt?.storedAt]
    .filter(Boolean).map(Date.parse));
  assert.ok(Number.isFinite(value), `source basis: ${entry.snapshotId}`);
  return value;
}

async function fileExists(target) {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function cloneInput() {
  return structuredClone(BASE_INPUT);
}

function observationEvidence() {
  const payload = {
    schemaVersion: 1,
    artifactKind: "current-molit-transfer-source-revalidation-evidence",
    contractVersion: "1.0.0",
    sourceId: "molit-railway-transfer-movement",
    snapshotId: "molit-railway-transfer-movement-20250811",
    observedAt: "2026-08-14T04:53:59.000Z",
    operation: {
      method: "FILE_DOWNLOAD",
      operationId: "15130556-fileData-20250811",
      detailPageUrl: "https://www.data.go.kr/data/15130556/fileData.do",
    },
    lockedSnapshot: {
      metadataPath: "tools/datapack/sources/molit-railway-transfer-movement-20250811.csv.gz.json",
      metadataFileSha256: "f75e3ec2a2270cdd8d3b2303f12db0167cf0b5f5525115f6c980680468faa284",
      rawSha256: "3a45dc1d82f81666c48eeef81fdc35b0e4a0c59312e4b26907f644c45b518ce3",
      gzipSha256: "94e712d32860a7a6e4b4c1f1d9651dc25823305f537e50370142009c1ca66d28",
      sortedContentSha256: "7be53c0eb6d56c5aee1dc6e917d1f94d40464716505bf6cad04ae062859b7d5a",
      rowCount: 8_054,
    },
    providerObservation: {
      rawSha256: "3a45dc1d82f81666c48eeef81fdc35b0e4a0c59312e4b26907f644c45b518ce3",
      byteSize: 598_455,
      canonicalRowsSha256: "7be53c0eb6d56c5aee1dc6e917d1f94d40464716505bf6cad04ae062859b7d5a",
      totalCount: 8_054,
    },
    outcome: "NO_CHANGE_REVALIDATED",
    credentialRedacted: true,
  };
  return { ...payload, evidenceHash: sha256(JSON.stringify(payload)) };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
