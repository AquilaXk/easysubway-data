import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "../..");

test("release evidence bundle validator는 publish gate status와 deferred headway 예외를 검증한다", async () => {
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
    itxCheongchunCoverageSha256: hash,
    routeMapPositionCoverageSha256: hash,
    routeGraphTopologySha256: hash,
    headwayReportSha256: hash,
    strictRouteRegressionSha256: hash,
    androidEvidenceSha256: hash,
    validatorStatus: "PASS",
    coverageStatus: "PASS",
    routeMapPositionCoverageStatus: "PASS",
    routeGraphTopologyStatus: "PASS",
    routeGraphTopologyViolationCount: 0,
    headwayReportStatus: "PASS",
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

  bundle.androidEvidenceStatus = "PASS";
  bundle.headwayReportStatus = "DEFERRED";
  await writeFile(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`);
  await execFileAsync(
    process.execPath,
    ["tools/datapack/validate-release-evidence-bundle.mjs", "--bundle", bundlePath, "--require-pass"],
    { cwd: root },
  );

  bundle.headwayReportStatus = "PASS";
  // route_graph_topology는 capital pilot deferred domain이므로 위반 기록 시 DEFERRED가 publish gate를 통과한다.
  bundle.routeGraphTopologyStatus = "DEFERRED";
  bundle.routeGraphTopologyViolationCount = 4;
  await writeFile(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`);
  await execFileAsync(
    process.execPath,
    ["tools/datapack/validate-release-evidence-bundle.mjs", "--bundle", bundlePath, "--require-pass"],
    { cwd: root },
  );

  // deferred가 아닌 다른 게이트(예: routeMapPositionCoverageStatus)는 DEFERRED를 허용하지 않는다.
  bundle.routeGraphTopologyStatus = "PASS";
  bundle.routeGraphTopologyViolationCount = 0;
  bundle.routeMapPositionCoverageStatus = "DEFERRED";
  await writeFile(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`);
  await assert.rejects(
    execFileAsync(
      process.execPath,
      ["tools/datapack/validate-release-evidence-bundle.mjs", "--bundle", bundlePath, "--require-pass"],
      { cwd: root },
    ),
    /routeMapPositionCoverageStatus must be a release gate status/,
  );

  bundle.routeMapPositionCoverageStatus = "PASS";
  bundle.validatorStatus = "DEFERRED";
  await writeFile(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`);
  await assert.rejects(
    execFileAsync(process.execPath, ["tools/datapack/validate-release-evidence-bundle.mjs", "--bundle", bundlePath], {
      cwd: root,
    }),
    /validatorStatus must be a release gate status/,
  );

  // route_graph_topology status와 위반 수치의 정합을 런타임에서 강제한다.
  bundle.validatorStatus = "PASS";
  // DEFERRED인데 위반 0 → 위반 은폐 모순, 거부.
  bundle.routeGraphTopologyStatus = "DEFERRED";
  bundle.routeGraphTopologyViolationCount = 0;
  await writeFile(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`);
  await assert.rejects(
    execFileAsync(
      process.execPath,
      ["tools/datapack/validate-release-evidence-bundle.mjs", "--bundle", bundlePath, "--require-pass"],
      { cwd: root },
    ),
    /routeGraphTopologyStatus DEFERRED requires routeGraphTopologyViolationCount > 0/,
  );

  // PASS인데 위반 수치가 0이 아님 → 모순, 거부.
  bundle.routeGraphTopologyStatus = "PASS";
  bundle.routeGraphTopologyViolationCount = 4;
  await writeFile(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`);
  await assert.rejects(
    execFileAsync(
      process.execPath,
      ["tools/datapack/validate-release-evidence-bundle.mjs", "--bundle", bundlePath, "--require-pass"],
      { cwd: root },
    ),
    /routeGraphTopologyStatus PASS requires routeGraphTopologyViolationCount 0/,
  );

  // 음수 위반 수치 거부.
  bundle.routeGraphTopologyStatus = "PASS";
  bundle.routeGraphTopologyViolationCount = -1;
  await writeFile(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`);
  await assert.rejects(
    execFileAsync(
      process.execPath,
      ["tools/datapack/validate-release-evidence-bundle.mjs", "--bundle", bundlePath, "--require-pass"],
      { cwd: root },
    ),
    /routeGraphTopologyViolationCount must be a non-negative integer/,
  );

  // 위반 수치 누락 거부.
  bundle.routeGraphTopologyViolationCount = 0;
  delete bundle.routeGraphTopologyViolationCount;
  await writeFile(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`);
  await assert.rejects(
    execFileAsync(
      process.execPath,
      ["tools/datapack/validate-release-evidence-bundle.mjs", "--bundle", bundlePath, "--require-pass"],
      { cwd: root },
    ),
    /release evidence bundle missing routeGraphTopologyViolationCount/,
  );

  // 실데이터 경로(위반 4, DEFERRED) 정합 → 통과 유지.
  bundle.routeGraphTopologyStatus = "DEFERRED";
  bundle.routeGraphTopologyViolationCount = 4;
  await writeFile(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`);
  await execFileAsync(
    process.execPath,
    ["tools/datapack/validate-release-evidence-bundle.mjs", "--bundle", bundlePath, "--require-pass"],
    { cwd: root },
  );
});
