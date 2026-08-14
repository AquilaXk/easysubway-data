import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  evaluateCurrentMolitTransferFreshness,
  runCurrentMolitTransferFreshnessEvaluation,
} from "./evaluate-current-molit-transfer-freshness.mjs";
import { freshnessPolicySha256 } from "./freshness-policy.mjs";

const observedAt = "2026-08-14T04:53:59.000Z";
const evaluationAt = "2026-08-14T05:00:00.000Z";
const now = Date.parse(evaluationAt);
const metadataPath = "tools/datapack/sources/molit-railway-transfer-movement-20250811.csv.gz.json";
const gzipPath = "tools/datapack/sources/molit-railway-transfer-movement-20250811.csv.gz";
const policyPath = "release/product-gates/datapack-freshness-sla.json";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function evidenceFixture(metadata, metadataBytes, overrides = {}) {
  const payload = {
    schemaVersion: 1,
    artifactKind: "current-molit-transfer-source-revalidation-evidence",
    contractVersion: "1.0.0",
    sourceId: "molit-railway-transfer-movement",
    snapshotId: "molit-railway-transfer-movement-20250811",
    observedAt,
    operation: {
      method: "FILE_DOWNLOAD",
      operationId: "15130556-fileData-20250811",
      detailPageUrl: metadata.detailUrl,
    },
    lockedSnapshot: {
      metadataPath,
      metadataFileSha256: sha256(metadataBytes),
      rawSha256: metadata.rawSha256,
      gzipSha256: metadata.gzipSha256,
      sortedContentSha256: metadata.sortedContentSha256,
      rowCount: metadata.rowCount,
    },
    providerObservation: {
      rawSha256: metadata.rawSha256,
      byteSize: 598_455,
      canonicalRowsSha256: metadata.sortedContentSha256,
      totalCount: metadata.rowCount,
    },
    outcome: "NO_CHANGE_REVALIDATED",
    credentialRedacted: true,
    ...overrides,
  };
  return { ...payload, evidenceHash: sha256(JSON.stringify(payload)) };
}

async function trackedFixture() {
  const [metadataBytes, gzipBytes, policyBytes] = await Promise.all([
    readFile(metadataPath),
    readFile(gzipPath),
    readFile(policyPath),
  ]);
  const metadata = JSON.parse(metadataBytes);
  const policy = JSON.parse(policyBytes);
  return {
    evidence: evidenceFixture(metadata, metadataBytes),
    gzipBytes,
    metadata,
    metadataBytes,
    policy,
  };
}

test("exact official-file observation은 shared #57 POSITIVE extension result가 된다", async () => {
  const fixture = await trackedFixture();
  const result = evaluateCurrentMolitTransferFreshness({
    ...fixture,
    evaluationAt,
    now,
  });

  assert.equal(result.decision, "EXTENDED");
  assert.equal(result.reasonCode, "POSITIVE_OBSERVATION_EXTENDED");
  assert.equal(result.sourceClassId, "annual_official_file");
  assert.equal(result.snapshotSha256, fixture.metadata.gzipSha256);
  assert.equal(result.rawEvidenceSha256, fixture.metadata.rawSha256);
  assert.equal(result.observationEvidenceSha256, fixture.evidence.evidenceHash);
  assert.equal(result.currentFreshUntil, "2026-08-11T00:00:00.000Z");
  assert.equal(result.extendedFreshUntil, "2027-08-14T04:53:59.000Z");
  assert.equal(result.policySha256, freshnessPolicySha256(fixture.policy));
});

test("evidence·operation·source identity drift는 fail closed이고 output 0이다", async () => {
  const fixture = await trackedFixture();
  const mutations = [
    (value) => { value.evidenceHash = "0".repeat(64); },
    (value) => { value.operation.method = "GET"; },
    (value) => { value.lockedSnapshot.rawSha256 = "0".repeat(64); },
    (value) => { value.outcome = "CONTENT_CHANGE_ADMITTED"; },
  ];
  for (const mutate of mutations) {
    const evidence = structuredClone(fixture.evidence);
    mutate(evidence);
    assert.throws(() => evaluateCurrentMolitTransferFreshness({
      ...fixture,
      evidence,
      evaluationAt,
      now,
    }), /MOLIT_TRANSFER_FRESHNESS_/);
  }

  const directory = await mkdtemp(path.join(os.tmpdir(), "molit-transfer-freshness-invalid-"));
  try {
    const evidencePath = path.join(directory, "evidence.json");
    const output = path.join(directory, "result.json");
    const invalid = structuredClone(fixture.evidence);
    invalid.operation.method = "GET";
    await writeFile(evidencePath, `${JSON.stringify(invalid, null, 2)}\n`);
    await assert.rejects(() => runCurrentMolitTransferFreshnessEvaluation({
      argv: ["--revalidation-evidence", evidencePath, "--evaluation-at", evaluationAt, "--output", output],
      now,
    }), /MOLIT_TRANSFER_FRESHNESS_EVIDENCE/);
    await assert.rejects(() => stat(output), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("policy/time/file/output boundary는 mismatch에서 mutation 0을 유지한다", async () => {
  const fixture = await trackedFixture();
  const ineligiblePolicy = structuredClone(fixture.policy);
  ineligiblePolicy.sourceClasses = ineligiblePolicy.sourceClasses.filter(({ id }) => id !== "annual_official_file");
  assert.throws(() => evaluateCurrentMolitTransferFreshness({
    ...fixture,
    policy: ineligiblePolicy,
    evaluationAt,
    now,
  }), /MOLIT_TRANSFER_FRESHNESS_POLICY/);
  assert.throws(() => evaluateCurrentMolitTransferFreshness({
    ...fixture,
    evaluationAt,
    now: now + 10 * 60 * 1_000,
  }), /MOLIT_TRANSFER_FRESHNESS_INELIGIBLE/);

  const directory = await mkdtemp(path.join(os.tmpdir(), "molit-transfer-freshness-boundary-"));
  try {
    const evidencePath = path.join(directory, "evidence.json");
    const symlinkPath = path.join(directory, "evidence-link.json");
    const output = path.join(directory, "result.json");
    await writeFile(evidencePath, `${JSON.stringify(fixture.evidence, null, 2)}\n`);
    await symlink(evidencePath, symlinkPath);
    await assert.rejects(() => runCurrentMolitTransferFreshnessEvaluation({
      argv: ["--revalidation-evidence", symlinkPath, "--evaluation-at", evaluationAt, "--output", output],
      now,
    }), /MOLIT_TRANSFER_FRESHNESS_FILE/);
    await assert.rejects(() => stat(output), { code: "ENOENT" });

    await writeFile(output, "owner-bytes");
    await assert.rejects(() => runCurrentMolitTransferFreshnessEvaluation({
      argv: ["--revalidation-evidence", evidencePath, "--evaluation-at", evaluationAt, "--output", output],
      now,
    }), /MOLIT_TRANSFER_FRESHNESS_OUTPUT/);
    assert.equal(await readFile(output, "utf8"), "owner-bytes");

    await rm(output, { force: true });
    let replacedTemporary;
    await assert.rejects(() => runCurrentMolitTransferFreshnessEvaluation({
      argv: ["--revalidation-evidence", evidencePath, "--evaluation-at", evaluationAt, "--output", output],
      now,
      publishFixture: {
        afterLink: async ({ temporary }) => {
          replacedTemporary = temporary;
          await rm(output, { force: true });
          await rm(temporary, { force: true });
          await writeFile(output, "foreign-output");
          await writeFile(temporary, "foreign-temporary");
        },
      },
    }), /MOLIT_TRANSFER_FRESHNESS_OUTPUT/);
    assert.equal(await readFile(output, "utf8"), "foreign-output");
    assert.equal(await readFile(replacedTemporary, "utf8"), "foreign-temporary");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
