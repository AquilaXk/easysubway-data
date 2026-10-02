import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { evaluateReleaseDecision } from "./decide-datapack-release.mjs";

const hash = (value) => value.repeat(64);
const evaluationAt = "2026-07-15T00:00:00.000Z";

function manifest(overrides = {}) {
  return {
    manifestVersion: 2,
    channel: "production",
    releaseSequence: 10,
    publishedAt: "2026-07-14T00:00:00.000Z",
    expiresAt: "2026-08-14T00:00:00.000Z",
    packs: [{
      id: "capital",
      version: "1",
      sha256: hash("a"),
      sqliteSha256: hash("b"),
      schemaVersion: "1",
      sourceInventory: [{ id: "source-a", updatedAt: "2026-07-14T00:00:00.000Z", fields: ["station"] }],
    }],
    ...overrides,
  };
}

function buildSpec() {
  return {
    candidateId: "candidate-10",
    sourceSnapshotSetHash: hash("c"),
    approvedAliasLedgerHash: hash("d"),
  };
}

function approval(buildSpecSha256 = hash("e")) {
  return {
    artifactKind: "datapack-release-request",
    candidateId: "candidate-10",
    buildSpecSha256,
    sourceSnapshotSetHash: hash("c"),
    approvedLedgerHash: hash("d"),
    requestedBy: "data-operator",
    approvedBy: "release-approver",
    approvalId: "approval-10",
    targetChannel: "production",
  };
}

function decide(overrides = {}) {
  return evaluateReleaseDecision({
    candidateManifest: manifest(),
    currentManifest: manifest(),
    candidateManifestSha256: hash("1"),
    currentManifestSha256: hash("2"),
    buildSpec: buildSpec(),
    buildSpecSha256: hash("e"),
    releaseRequest: approval(),
    strictValidationPassed: true,
    publishAttempted: false,
    remoteValidationPassed: false,
    evaluationAt,
    ...overrides,
  });
}

function releaseAttestation({ manifestSha256, releaseSequence }) {
  const launchDenominatorReportSha256 = hash("9");
  const launchDenominatorReport = {
    decision: "GO",
    evaluatorInput: { nationwide: { targetsSha256: hash("6") } },
    scopes: {
      nationwideRoadmapScope: {
        id: "nationwide-roadmap-v1",
        sha256: hash("8"),
      },
    },
  };
  return {
    releaseEvidenceBundle: {
      manifestSha256,
      releaseSequence,
      nationwideRoadmapScopeId: launchDenominatorReport.scopes.nationwideRoadmapScope.id,
      nationwideRoadmapScopeSha256: launchDenominatorReport.scopes.nationwideRoadmapScope.sha256,
      nationwideTargetsSha256: launchDenominatorReport.evaluatorInput.nationwide.targetsSha256,
      launchDenominatorDecision: launchDenominatorReport.decision,
      launchDenominatorReportSha256,
    },
    launchDenominatorReport,
    launchDenominatorReportSha256,
  };
}

test("변경이 없고 current pack이 fresh이면 NO_CHANGE_VALID이다", () => {
  assert.deepEqual(decide(), {
    schemaVersion: 1,
    artifactKind: "datapack-release-decision",
    outcome: "NO_CHANGE_VALID",
    productionWriteAllowed: false,
    materialChange: false,
    approvalValid: true,
    strictValidationPassed: true,
    publishRequired: false,
    publishAttempted: false,
    remoteValidationPassed: false,
    sourceSnapshotSetHash: hash("c"),
    selectedManifestSha256: hash("2"),
    selectedReleaseSequence: 10,
    reasonCodes: [],
    evaluationAt,
  });
});

test("변경은 있으나 승인 hash가 다르면 CHANGE_BLOCKED이고 write를 금지한다", () => {
  const result = decide({
    candidateManifest: manifest({ packs: [{ ...manifest().packs[0], sha256: hash("f") }] }),
    releaseRequest: approval(hash("0")),
  });

  assert.equal(result.outcome, "CHANGE_BLOCKED");
  assert.equal(result.productionWriteAllowed, false);
  assert.deepEqual(result.reasonCodes, [
    "PUBLISH_SEQUENCE_NOT_INCREASING",
    "MATERIAL_CHANGE_UNAPPROVED",
  ]);
});

test("approval ID가 없으면 matching hash여도 승인으로 보지 않는다", () => {
  const request = approval();
  delete request.approvalId;
  const result = decide({
    candidateManifest: manifest({ releaseSequence: 11, packs: [{ ...manifest().packs[0], sha256: hash("f") }] }),
    releaseRequest: request,
  });

  assert.equal(result.outcome, "CHANGE_BLOCKED");
  assert.equal(result.productionWriteAllowed, false);
});

test("승인된 material change는 preflight에서만 production write를 허용한다", () => {
  const result = decide({
    candidateManifest: manifest({ releaseSequence: 11, packs: [{ ...manifest().packs[0], sha256: hash("f") }] }),
  });

  assert.equal(result.outcome, "PUBLISH_REQUIRED");
  assert.equal(result.productionWriteAllowed, true);
  assert.deepEqual(result.reasonCodes, ["PUBLISH_REQUIRED_NOT_COMPLETED"]);
});

test("activePack·TTL·URL·license 변경도 material change로 판정한다", () => {
  const current = manifest({
    activePack: "capital",
    ttlSeconds: 86_400,
    packs: [{
      ...manifest().packs[0],
      url: "https://example.invalid/capital-v1.sqlite.gz",
      license: "ODbL-1.0",
    }],
  });
  const changes = [
    { ...current, releaseSequence: 11, activePack: "capital-rescue" },
    { ...current, releaseSequence: 11, ttlSeconds: 43_200 },
    { ...current, releaseSequence: 11, packs: [{ ...current.packs[0], url: "https://example.invalid/capital-v2.sqlite.gz" }] },
    { ...current, releaseSequence: 11, packs: [{ ...current.packs[0], license: "CC-BY-4.0" }] },
  ];

  for (const candidateManifest of changes) {
    const result = decide({ candidateManifest, currentManifest: current });
    assert.equal(result.materialChange, true);
    assert.equal(result.outcome, "PUBLISH_REQUIRED");
  }
});

test("packs가 동일해도 releaseSequence가 증가하고 승인되면 material change로 PUBLISH_REQUIRED이다", () => {
  const current = manifest({ releaseSequence: 10 });
  const candidate = manifest({ releaseSequence: 11 });
  const result = decide({ candidateManifest: candidate, currentManifest: current });

  assert.equal(result.materialChange, true);
  assert.equal(result.approvalValid, true);
  assert.equal(result.outcome, "PUBLISH_REQUIRED");
  assert.equal(result.productionWriteAllowed, true);
  assert.deepEqual(result.reasonCodes, ["PUBLISH_REQUIRED_NOT_COMPLETED"]);
});

test("packs가 동일해도 releaseSequence가 증가했으나 승인이 다르면 CHANGE_BLOCKED이다", () => {
  const current = manifest({ releaseSequence: 10 });
  const candidate = manifest({ releaseSequence: 11 });
  const result = decide({
    candidateManifest: candidate,
    currentManifest: current,
    releaseRequest: approval(hash("0")),
  });

  assert.equal(result.materialChange, true);
  assert.equal(result.approvalValid, false);
  assert.equal(result.outcome, "CHANGE_BLOCKED");
  assert.equal(result.productionWriteAllowed, false);
  assert.deepEqual(result.reasonCodes, ["MATERIAL_CHANGE_UNAPPROVED"]);
});

test("current expiry와 같은 평가 시각은 변경이 없어도 PUBLISH_REQUIRED이다", () => {
  const expired = manifest({ expiresAt: evaluationAt });
  const result = decide({
    candidateManifest: { ...expired, releaseSequence: 11 },
    currentManifest: expired,
  });

  assert.equal(result.outcome, "PUBLISH_REQUIRED");
  assert.equal(result.productionWriteAllowed, true);
  assert.deepEqual(result.reasonCodes, [
    "PACK_PUBLISH_FRESHNESS_EXPIRED",
    "PUBLISH_REQUIRED_NOT_COMPLETED",
  ]);
});

test("current expiry가 다음 schedule cadence 안이면 미리 PUBLISH_REQUIRED이다", () => {
  const current = manifest({ expiresAt: "2026-07-15T23:59:59.999Z" });
  const result = decide({
    candidateManifest: { ...current, releaseSequence: 11 },
    currentManifest: current,
    refreshBeforeMillis: 86_400_000,
  });

  assert.equal(result.outcome, "PUBLISH_REQUIRED");
  assert.equal(result.publishRequired, true);
  assert.deepEqual(result.reasonCodes, [
    "PACK_PUBLISH_FRESHNESS_EXPIRING",
    "PUBLISH_REQUIRED_NOT_COMPLETED",
  ]);
});

test("expiry alert 경로는 승인 없이 PUBLISH_REQUIRED를 보고하되 write를 금지한다", () => {
  const expired = manifest({ expiresAt: evaluationAt });
  const result = decide({
    candidateManifest: expired,
    currentManifest: expired,
    buildSpec: null,
    releaseRequest: null,
  });

  assert.equal(result.outcome, "PUBLISH_REQUIRED");
  assert.equal(result.productionWriteAllowed, false);
});

test("publish 후 remote validation 결과로 최종 상태를 정한다", () => {
  const changed = manifest({ releaseSequence: 11, packs: [{ ...manifest().packs[0], sha256: hash("f") }] });
  const verified = decide({
    candidateManifest: changed,
    publishAttempted: true,
    remoteValidationPassed: true,
    ...releaseAttestation({ manifestSha256: hash("1"), releaseSequence: 11 }),
  });
  assert.equal(verified.outcome, "PUBLISHED_AND_VERIFIED");
  assert.equal(verified.productionWriteAllowed, true);
  assert.equal(verified.selectedManifestSha256, hash("1"));
  assert.equal(verified.selectedReleaseSequence, 11);
  const failed = decide({
    candidateManifest: changed,
    publishAttempted: true,
    remoteValidationPassed: false,
  });
  assert.equal(failed.outcome, "FAILED");
  assert.equal(failed.productionWriteAllowed, false);
});

test("PUBLISHED_AND_VERIFIED는 선택 manifest·sequence에 결속한 전국 attestation만 발행한다", () => {
  const changed = manifest({ releaseSequence: 11, packs: [{ ...manifest().packs[0], sha256: hash("f") }] });
  const attestation = releaseAttestation({ manifestSha256: hash("1"), releaseSequence: 11 });
  const result = decide({
    candidateManifest: changed,
    publishAttempted: true,
    remoteValidationPassed: true,
    ...attestation,
  });

  assert.equal(result.nationwideRoadmapScopeId, "nationwide-roadmap-v1");
  assert.equal(result.nationwideRoadmapScopeSha256, hash("8"));
  assert.equal(result.nationwideTargetsSha256, hash("6"));
  assert.equal(result.launchDenominatorDecision, "GO");
  assert.equal(result.launchDenominatorReportSha256, hash("9"));
});

test("전국 attestation의 scope/report/candidate manifest/sequence drift는 decision 출력 전에 거부한다", () => {
  const changed = manifest({ releaseSequence: 11, packs: [{ ...manifest().packs[0], sha256: hash("f") }] });
  assert.throws(() => decide({
    candidateManifest: changed,
    publishAttempted: true,
    remoteValidationPassed: true,
    ...releaseAttestation({ manifestSha256: hash("2"), releaseSequence: 10 }),
  }), /selected manifest sha256 mismatch/);

  const attestation = releaseAttestation({ manifestSha256: hash("1"), releaseSequence: 11 });
  attestation.launchDenominatorReport.scopes.nationwideRoadmapScope.sha256 = hash("7");
  assert.throws(() => decide({
    candidateManifest: changed,
    publishAttempted: true,
    remoteValidationPassed: true,
    ...attestation,
  }), /nationwide roadmap scope binding mismatch/);

  const targetDrift = releaseAttestation({ manifestSha256: hash("1"), releaseSequence: 11 });
  targetDrift.launchDenominatorReport.evaluatorInput.nationwide.targetsSha256 = hash("7");
  assert.throws(() => decide({
    candidateManifest: changed,
    publishAttempted: true,
    remoteValidationPassed: true,
    ...targetDrift,
  }), /nationwide targets hash binding mismatch/);

  const missingTarget = releaseAttestation({ manifestSha256: hash("1"), releaseSequence: 11 });
  delete missingTarget.releaseEvidenceBundle.nationwideTargetsSha256;
  assert.throws(() => decide({
    candidateManifest: changed,
    publishAttempted: true,
    remoteValidationPassed: true,
    ...missingTarget,
  }), /nationwide targets hash must be sha256/);
});

test("NO_CHANGE_VALID는 candidate attestation을 current production manifest에 재사용하지 않는다", () => {
  assert.throws(() => decide({
    ...releaseAttestation({ manifestSha256: hash("1"), releaseSequence: 10 }),
  }), /selected manifest sha256 mismatch/);
  assert.throws(() => decide({
    releaseEvidenceBundle: releaseAttestation({ manifestSha256: hash("2"), releaseSequence: 10 }).releaseEvidenceBundle,
  }), /must be supplied together/);
});

test("NO_CHANGE_VALID는 exact prior attestation만 전국 final 필드로 전달한다", () => {
  const result = decide({
    ...releaseAttestation({ manifestSha256: hash("2"), releaseSequence: 10 }),
  });

  assert.equal(result.outcome, "NO_CHANGE_VALID");
  assert.equal(result.nationwideRoadmapScopeId, "nationwide-roadmap-v1");
  assert.equal(result.nationwideTargetsSha256, hash("6"));
  assert.equal(result.launchDenominatorReportSha256, hash("9"));
});

test("publish가 필요한 candidate sequence가 증가하지 않으면 fail closed한다", () => {
  const result = decide({
    candidateManifest: manifest({ packs: [{ ...manifest().packs[0], sha256: hash("f") }] }),
  });

  assert.equal(result.outcome, "FAILED");
  assert.equal(result.productionWriteAllowed, false);
  assert.deepEqual(result.reasonCodes, ["PUBLISH_SEQUENCE_NOT_INCREASING"]);
});

test("initial release도 양의 정수 sequence를 요구한다", () => {
  const result = decide({
    candidateManifest: manifest({ releaseSequence: "1" }),
    currentManifest: null,
  });

  assert.equal(result.outcome, "FAILED");
  assert.deepEqual(result.reasonCodes, ["PUBLISH_SEQUENCE_NOT_INCREASING"]);
});

test("initial release의 빈 packs는 구조 검증에서 거부한다", () => {
  assert.throws(() => decide({
    candidateManifest: manifest({ releaseSequence: 1, packs: [] }),
    currentManifest: null,
  }), /manifest\.packs must be a non-empty array/);
});

test("strict validation 실패는 승인과 무관하게 FAILED이며 write를 금지한다", () => {
  const result = decide({ strictValidationPassed: false });

  assert.equal(result.outcome, "FAILED");
  assert.equal(result.productionWriteAllowed, false);
});

test("CLI는 secret 없는 JSON과 GitHub outputs를 기록한다", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "datapack-release-decision-"));
  const candidatePath = path.join(dir, "candidate.json");
  const currentPath = path.join(dir, "current.json");
  const buildSpecPath = path.join(dir, "build-spec.json");
  const requestPath = path.join(dir, "request.json");
  const outputPath = path.join(dir, "decision.json");
  const githubOutputPath = path.join(dir, "github-output.txt");
  await Promise.all([
    writeFile(candidatePath, JSON.stringify(manifest())),
    writeFile(currentPath, JSON.stringify(manifest())),
    writeFile(buildSpecPath, JSON.stringify(buildSpec())),
  ]);
  const buildSpecBytes = await readFile(buildSpecPath);
  const { createHash } = await import("node:crypto");
  await writeFile(requestPath, JSON.stringify(approval(createHash("sha256").update(buildSpecBytes).digest("hex"))));

  const result = spawnSync(process.execPath, [
    "tools/datapack/decide-datapack-release.mjs",
    "--candidate-manifest", candidatePath,
    "--current-manifest", currentPath,
    "--build-spec", buildSpecPath,
    "--release-request", requestPath,
    "--strict-validation-status", "PASS",
    "--evaluation-at", evaluationAt,
    "--output", outputPath,
    "--github-output", githubOutputPath,
  ], { encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(await readFile(outputPath, "utf8")).outcome, "NO_CHANGE_VALID");
  assert.match(await readFile(githubOutputPath, "utf8"), /productionWriteAllowed=false/);
  assert.doesNotMatch(await readFile(outputPath, "utf8"), /release-approver|data-operator/);
});

test("CLI는 일반 실행과 alert-only의 manifest 누락을 구분한다", () => {
  const normal = spawnSync(process.execPath, [
    "tools/datapack/decide-datapack-release.mjs",
    "--output", "unused.json",
  ], { encoding: "utf8" });
  const alertOnly = spawnSync(process.execPath, [
    "tools/datapack/decide-datapack-release.mjs",
    "--alert-only",
    "--output", "unused.json",
  ], { encoding: "utf8" });

  assert.notEqual(normal.status, 0);
  assert.match(normal.stderr, /--candidate-manifest is required/);
  assert.notEqual(alertOnly.status, 0);
  assert.match(alertOnly.stderr, /--current-manifest is required with --alert-only/);
});

async function runDecisionCli({
  candidate,
  current,
  approved = true,
  publishAttempted = false,
  remoteValidationPassed = false,
  attest = false,
}) {
  const { createHash } = await import("node:crypto");
  const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const dir = await mkdtemp(path.join(tmpdir(), "datapack-release-decision-"));
  const candidatePath = path.join(dir, "candidate.json");
  const currentPath = path.join(dir, "current.json");
  const buildSpecPath = path.join(dir, "build-spec.json");
  const requestPath = path.join(dir, "request.json");
  const outputPath = path.join(dir, "decision.json");
  const candidateBytes = Buffer.from(JSON.stringify(candidate));
  await Promise.all([
    writeFile(candidatePath, candidateBytes),
    writeFile(currentPath, JSON.stringify(current)),
    writeFile(buildSpecPath, JSON.stringify(buildSpec())),
  ]);
  const args = [
    "tools/datapack/decide-datapack-release.mjs",
    "--candidate-manifest", candidatePath,
    "--current-manifest", currentPath,
    "--build-spec", buildSpecPath,
    "--strict-validation-status", "PASS",
    "--evaluation-at", evaluationAt,
    "--output", outputPath,
  ];
  if (approved) {
    await writeFile(requestPath, JSON.stringify(approval(sha(await readFile(buildSpecPath)))));
    args.push("--release-request", requestPath);
  }
  if (publishAttempted) args.push("--publish-attempted", "true");
  if (remoteValidationPassed) args.push("--remote-validation-status", "PASS");
  if (attest) {
    const reportPath = path.join(dir, "launch-denominator-report.json");
    const bundlePath = path.join(dir, "release-evidence-bundle.json");
    const attestation = releaseAttestation({
      manifestSha256: sha(candidateBytes),
      releaseSequence: candidate.releaseSequence,
    });
    const reportBytes = Buffer.from(JSON.stringify(attestation.launchDenominatorReport));
    await writeFile(reportPath, reportBytes);
    await writeFile(bundlePath, JSON.stringify({
      ...attestation.releaseEvidenceBundle,
      launchDenominatorReportSha256: sha(reportBytes),
    }));
    args.push("--launch-denominator-report", reportPath, "--release-evidence-bundle", bundlePath);
  }
  const result = spawnSync(process.execPath, args, { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return { result, decision: JSON.parse(await readFile(outputPath, "utf8")) };
}

const changedPack = () => ({ ...manifest().packs[0], sha256: hash("f") });
const expiredCurrent = () => manifest({ expiresAt: "2026-07-14T12:00:00.000Z" });

test("CLI는 FAILED 결정의 사유와 sequence를 stderr에 출력한다", async () => {
  const { result, decision } = await runDecisionCli({
    candidate: manifest({ releaseSequence: 123, packs: [changedPack()] }),
    current: manifest({ releaseSequence: 123 }),
  });

  assert.equal(decision.outcome, "FAILED");
  assert.match(result.stderr, /outcome=FAILED/);
  assert.match(result.stderr, /reasonCodes=PUBLISH_SEQUENCE_NOT_INCREASING/);
  assert.match(result.stderr, /candidateReleaseSequence=123/);
  assert.match(result.stderr, /currentReleaseSequence=123/);
});

test("CLI는 CHANGE_BLOCKED 결정의 사유를 stderr에 출력한다", async () => {
  const { result, decision } = await runDecisionCli({
    candidate: manifest({ releaseSequence: 11, packs: [changedPack()] }),
    current: manifest(),
    approved: false,
  });

  assert.equal(decision.outcome, "CHANGE_BLOCKED");
  assert.match(result.stderr, /outcome=CHANGE_BLOCKED/);
  assert.match(result.stderr, /reasonCodes=MATERIAL_CHANGE_UNAPPROVED/);
});

test("CLI는 write가 허가되지 않은 PUBLISH_REQUIRED의 사유를 stderr에 출력한다", async () => {
  const { result, decision } = await runDecisionCli({
    candidate: expiredCurrent(),
    current: expiredCurrent(),
    approved: false,
  });

  assert.equal(decision.outcome, "PUBLISH_REQUIRED");
  assert.equal(decision.productionWriteAllowed, false);
  assert.match(result.stderr, /outcome=PUBLISH_REQUIRED productionWriteAllowed=false/);
  assert.match(result.stderr, /reasonCodes=PACK_PUBLISH_FRESHNESS_EXPIRED,PUBLISH_SEQUENCE_NOT_INCREASING,PUBLISH_REQUIRED_NOT_COMPLETED/);
});

test("CLI는 write가 허가된 PUBLISH_REQUIRED에서는 stderr에 출력하지 않는다", async () => {
  const { result, decision } = await runDecisionCli({
    candidate: manifest({ releaseSequence: 124, packs: [changedPack()] }),
    current: manifest({ releaseSequence: 123 }),
  });

  assert.equal(decision.outcome, "PUBLISH_REQUIRED");
  assert.equal(decision.productionWriteAllowed, true);
  assert.deepEqual(decision.reasonCodes, ["PUBLISH_REQUIRED_NOT_COMPLETED"]);
  assert.equal(result.stderr, "");
});

test("CLI는 NO_CHANGE_VALID에서는 stderr에 출력하지 않는다", async () => {
  const { result, decision } = await runDecisionCli({ candidate: manifest(), current: manifest() });

  assert.equal(decision.outcome, "NO_CHANGE_VALID");
  assert.equal(decision.productionWriteAllowed, false);
  assert.equal(result.stderr, "");
});

test("CLI는 PUBLISHED_AND_VERIFIED에서는 stderr에 출력하지 않는다", async () => {
  const { result, decision } = await runDecisionCli({
    candidate: manifest({ releaseSequence: 11, packs: [changedPack()] }),
    current: expiredCurrent(),
    publishAttempted: true,
    remoteValidationPassed: true,
    attest: true,
  });

  assert.equal(decision.outcome, "PUBLISHED_AND_VERIFIED");
  assert.deepEqual(decision.reasonCodes, ["PACK_PUBLISH_FRESHNESS_EXPIRED"]);
  assert.equal(result.stderr, "");
});
