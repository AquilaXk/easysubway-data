import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "../..");

test("release evidence bundle validator는 publish gate status를 모두 PASS로 요구한다", async () => {
  const outputDir = path.join(tmpdir(), `easysubway-release-evidence-${Date.now()}`);
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  const bundlePath = path.join(outputDir, "release-evidence-bundle.json");
  const hash = "a".repeat(64);
  const bundle = {
    schemaVersion: 1,
    artifactKind: "datapack-release-evidence-bundle",
    candidateId: "capital@1",
    scopeId: "capital_pilot_android_v1",
    releaseRequestId: "release-request-1",
    builderGitSha: "abcdef1",
    buildSpecSha256: hash,
    supportedDenominatorSha256: hash,
    sourceSnapshotSetHash: hash,
    approvedAliasLedgerHash: hash,
    facilityEvidenceLedgerHash: hash,
    routeEvidenceLedgerHash: hash,
    approvedOverrideSetHash: hash,
    normalizedSourceInventorySha256: hash,
    sqliteSha256: hash,
    gzipSha256: hash,
    manifestSha256: hash,
    coverageSummarySha256: hash,
    strictRouteRegressionSha256: hash,
    androidEvidenceSha256: hash,
    validatorStatus: "PASS",
    coverageStatus: "PASS",
    strictRouteRegressionStatus: "PASS",
    manifestSignatureStatus: "PASS",
    androidEvidenceStatus: "PASS",
    createdAt: "2026-06-30T00:00:00.000Z",
    workflowRunUrl: "https://github.com/AquilaXk/easysubway/actions/runs/1",
  };

  await writeFile(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`);
  await execFileAsync(
    process.execPath,
    ["tools/datapack/validate-release-evidence-bundle.mjs", "--bundle", bundlePath, "--require-pass"],
    { cwd: root },
  );

  bundle.androidEvidenceStatus = "FAIL";
  await writeFile(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`);
  await assert.rejects(
    execFileAsync(
      process.execPath,
      ["tools/datapack/validate-release-evidence-bundle.mjs", "--bundle", bundlePath, "--require-pass"],
      { cwd: root },
    ),
    /androidEvidenceStatus must be PASS for publish/,
  );
});
