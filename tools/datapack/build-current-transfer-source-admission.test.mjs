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
const OBSERVED_AT = "2026-08-14T09:30:00.000Z";
const EVALUATED_AT = "2026-08-14T05:30:38.000Z";
const EVIDENCE = observationEvidence();
const BASE_INPUT = await trackedInput();

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

test("CLI는 self-bound 두 handoff를 absent directory에 원자적으로 쓴다", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "current-transfer-admission-"));
  const evidencePath = path.join(root, "evidence.json");
  const freshnessPath = path.join(root, "freshness.json");
  const outputDirectory = path.join(root, "output");
  await writeFile(evidencePath, `${JSON.stringify(EVIDENCE, null, 2)}\n`, { mode: 0o600 });
  await writeFile(freshnessPath, `${JSON.stringify(BASE_INPUT.freshnessResult, null, 2)}\n`, { mode: 0o600 });
  const argv = [
    "--revalidation-evidence", evidencePath,
    "--freshness-result", freshnessPath,
    "--observed-at", OBSERVED_AT,
    "--output-directory", outputDirectory,
  ];

  const result = await main(argv, { repositoryRoot: REPOSITORY_ROOT, log: () => {} });
  assert.equal(result.admission.decision, "GO");
  for (const fileName of ["transfer-topology-source-admission.json", "transfer-topology-admission.json"]) {
    assert.equal((await stat(path.join(outputDirectory, fileName))).mode & 0o777, 0o600);
  }
  await assert.rejects(main(argv, { repositoryRoot: REPOSITORY_ROOT, log: () => {} }), /output.*absent/i);
});

test("tracked current TRANSFER handoff는 exact two-cell GO identity를 고정한다", async () => {
  const [sourceBytes, admissionBytes] = await Promise.all([
    readFile(new URL("./release/current-transfer-admission/transfer-topology-source-admission.json", import.meta.url)),
    readFile(new URL("./release/current-transfer-admission/transfer-topology-admission.json", import.meta.url)),
  ]);
  const source = JSON.parse(sourceBytes);
  const admission = JSON.parse(admissionBytes);
  const fresh = buildCurrentTransferSourceAdmission(cloneInput());
  assert.equal(source.admissionDigest, "8431808200dcf69c542d20c8a884d142c9c8e3da98be1df8d7a135a46c0a7e1c");
  assert.equal(admission.admissionDigest, "d925818a23ee26a553ec07cc381cb350240d3774d057dec59b4af9a186fbebdd");
  assert.equal(source.revalidationEvidenceSha256, EVIDENCE.evidenceHash);
  assert.equal(source.freshnessResultSha256, BASE_INPUT.freshnessResult.resultSha256);
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
  assert.equal(canonicalCurrentTransferSourceAdmissionJson(fresh.sourceAdmission), sourceBytes.toString("utf8"));
  assert.equal(`${canonicalTransferTopologyAdmissionJson(fresh.admission)}\n`, admissionBytes.toString("utf8"));
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
  const freshnessResult = evaluateCurrentMolitTransferFreshness({
    evidence: EVIDENCE,
    evaluationAt: EVALUATED_AT,
    gzipBytes,
    metadata,
    metadataBytes,
    now: Date.parse(EVALUATED_AT),
    policy,
  });
  return {
    candidateBuildSpec,
    facilityAdmission,
    freshnessResult,
    gzipBytes,
    metadata,
    metadataBytes,
    observedAt: OBSERVED_AT,
    policy,
    productionInput,
    providerCodeCatalog,
    revalidationEvidence: EVIDENCE,
    sourceInventory,
    sourceSnapshots,
  };
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
