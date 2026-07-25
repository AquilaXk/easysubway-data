import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { evaluateReleaseDecision } from "./decide-datapack-release.mjs";
import { releaseRequestBindingViolations } from "./verify-release-request-binding.mjs";

const hash = (value) => value.repeat(64);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const cliPath = path.join(import.meta.dirname, "verify-release-request-binding.mjs");

function buildSpec(overrides = {}) {
  return {
    schemaVersion: 1,
    artifactKind: "datapack-candidate-build-spec",
    candidateId: "candidate-2521",
    sourceSnapshotSetHash: hash("c"),
    approvedAliasLedgerHash: hash("d"),
    ...overrides,
  };
}

function releaseRequest(buildSpecSha256, overrides = {}) {
  return {
    schemaVersion: 1,
    artifactKind: "datapack-release-request",
    candidateId: "candidate-2521",
    scopeId: "capital_pilot_android_v1",
    buildSpecSha256,
    sourceSnapshotSetHash: hash("c"),
    approvedLedgerHash: hash("d"),
    requestedBy: "data-operator",
    approvedBy: "release-approver",
    approvalId: "release-request-2026-07-26-01",
    targetChannel: "production",
    ...overrides,
  };
}

// request/spec 양쪽 override를 받는다. specSha256를 주면 build spec 바이트 해시 자리에 그 값을
// 넣어(CLI에서는 항상 64자 hex라 도달할 수 없는) 해시 형식 검사까지 함수 단위로 덮는다.
function boundPair({ request = {}, spec: specOverrides = {}, specSha256 = null } = {}) {
  const spec = buildSpec(specOverrides);
  const buildSpecSha256 = specSha256 ?? sha256(JSON.stringify(spec));
  return { buildSpec: spec, buildSpecSha256, releaseRequest: releaseRequest(buildSpecSha256, request) };
}

async function writePair(overrides = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "release-request-binding-"));
  const buildSpecPath = path.join(dir, "candidate-build-spec.json");
  const requestPath = path.join(dir, "release-request.json");
  const specBytes = JSON.stringify(buildSpec());
  await writeFile(buildSpecPath, specBytes);
  await writeFile(requestPath, JSON.stringify(releaseRequest(sha256(specBytes), overrides)));
  return { buildSpecPath, requestPath };
}

function runCli(buildSpecPath, requestPath, extraArgs = []) {
  return spawnSync(process.execPath, [
    cliPath,
    "--build-spec", buildSpecPath,
    "--release-request", requestPath,
    ...extraArgs,
  ], { encoding: "utf8" });
}

test("현행 build spec에 결속된 release request는 위반이 없다", () => {
  assert.deepEqual(releaseRequestBindingViolations(boundPair()), []);
});

test("stale buildSpecSha256는 어긋난 필드를 지목하며 검출된다", () => {
  const pair = boundPair({ request: { buildSpecSha256: hash("e") } });
  const violations = releaseRequestBindingViolations(pair);

  assert.equal(violations.length, 1);
  assert.match(violations[0], /buildSpecSha256가 build spec과 어긋났다/);
  assert.match(violations[0], new RegExp(pair.buildSpecSha256));
});

// validApproval()이 보는 술어를 하나도 빠짐없이 덮는다. 각 항목은 "그 검사만" 걸리도록 구성하고
// 기대 메시지까지 대조해, 검사 하나를 제거하는 변형이 이 스위트를 green으로 통과할 수 없게 한다.
const mirroredDrifts = [
  { label: "buildSpecSha256 불일치", args: { request: { buildSpecSha256: hash("e") } },
    expect: /buildSpecSha256가 build spec과 어긋났다/ },
  { label: "candidateId 불일치", args: { request: { candidateId: "candidate-other" } },
    expect: /candidateId가 build spec과 어긋났다/ },
  { label: "sourceSnapshotSetHash 불일치", args: { request: { sourceSnapshotSetHash: hash("f") } },
    expect: /sourceSnapshotSetHash가 build spec과 어긋났다/ },
  { label: "approvedLedgerHash 불일치", args: { request: { approvedLedgerHash: hash("f") } },
    expect: /approvedLedgerHash가 build spec과 어긋났다/ },
  { label: "artifactKind 불일치", args: { request: { artifactKind: "datapack-rollback-approval" } },
    expect: /artifactKind는 datapack-release-request여야 한다/ },
  { label: "targetChannel 비-production", args: { request: { targetChannel: "staging" } },
    expect: /targetChannel은 production이어야 한다/ },
  { label: "approvalId 공백", args: { request: { approvalId: "" } },
    expect: /approvalId는 비어 있지 않은 문자열이어야 한다/ },
  { label: "승인자=요청자", args: { request: { approvedBy: "data-operator" } },
    expect: /requestedBy·approvedBy는 비어 있지 않고 서로 달라야 한다/ },
  { label: "build spec 바이트 해시 비-sha256", args: { specSha256: "not-a-sha256" },
    expect: /build spec 바이트 해시를 계산하지 못했다/ },
  // buildSpec 측 형식 검사만 걸리도록 request 값을 같은 비-sha256으로 맞춰 불일치 검사를 비켜간다.
  { label: "buildSpec.sourceSnapshotSetHash 비-sha256",
    args: { spec: { sourceSnapshotSetHash: "not-a-sha256" }, request: { sourceSnapshotSetHash: "not-a-sha256" } },
    expect: /buildSpec\.sourceSnapshotSetHash는 sha256이어야 한다/ },
  { label: "buildSpec.approvedAliasLedgerHash 비-sha256",
    args: { spec: { approvedAliasLedgerHash: "not-a-sha256" }, request: { approvedLedgerHash: "not-a-sha256" } },
    expect: /buildSpec\.approvedAliasLedgerHash는 sha256이어야 한다/ },
];

test("결속 위반은 release 판정의 approvalValid=false와 항상 함께 발생한다", () => {
  for (const { label, args, expect } of mirroredDrifts) {
    const pair = boundPair(args);
    const violations = releaseRequestBindingViolations(pair);
    assert.ok(violations.some((violation) => expect.test(violation)),
      `${label}: 기대한 위반 미검출 — ${JSON.stringify(violations)}`);
    const decision = evaluateReleaseDecision({
      candidateManifest: manifest(11),
      currentManifest: manifest(10),
      candidateManifestSha256: hash("1"),
      currentManifestSha256: hash("2"),
      buildSpec: pair.buildSpec,
      buildSpecSha256: pair.buildSpecSha256,
      releaseRequest: pair.releaseRequest,
      strictValidationPassed: true,
      publishAttempted: false,
      remoteValidationPassed: false,
      evaluationAt: "2026-07-26T00:00:00.000Z",
    });
    assert.equal(decision.approvalValid, false, `${label}: approvalValid 불일치`);
    assert.ok(decision.reasonCodes.includes("MATERIAL_CHANGE_UNAPPROVED"), label);
  }
});

test("expected-approval-id는 validApproval 밖의 상위집합 검사다", () => {
  const bound = boundPair();
  assert.deepEqual(releaseRequestBindingViolations({
    ...bound, expectedApprovalId: bound.releaseRequest.approvalId,
  }), []);
  const violations = releaseRequestBindingViolations({
    ...bound, expectedApprovalId: "release-request-2026-07-18-01",
  });
  assert.equal(violations.length, 1);
  assert.match(violations[0], /approvalId가 요청된 release request ID와 다르다/);
  // 이 항목만 validApproval()에는 없다 — 그래서 preflight가 기존 검사의 진짜 상위집합이 된다.
  assert.equal(evaluateReleaseDecision({
    candidateManifest: manifest(11),
    currentManifest: manifest(10),
    candidateManifestSha256: hash("1"),
    currentManifestSha256: hash("2"),
    buildSpec: bound.buildSpec,
    buildSpecSha256: bound.buildSpecSha256,
    releaseRequest: bound.releaseRequest,
    strictValidationPassed: true,
    publishAttempted: false,
    remoteValidationPassed: false,
    evaluationAt: "2026-07-26T00:00:00.000Z",
  }).approvalValid, true);
});

test("CLI는 결속된 pair에서 PASS 요약을 내고 성공한다", async () => {
  const { buildSpecPath, requestPath } = await writePair();
  const result = runCli(buildSpecPath, requestPath);

  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  assert.equal(summary.status, "PASS");
  assert.equal(summary.candidateId, "candidate-2521");
  assert.equal(summary.buildSpecSha256, sha256(JSON.stringify(buildSpec())));
});

test("CLI는 결속 drift를 fail-closed로 종료한다", async () => {
  const { buildSpecPath, requestPath } = await writePair({ buildSpecSha256: hash("e") });
  const result = runCli(buildSpecPath, requestPath);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /release request가 현행 build spec에 결속돼 있지 않다/);
  assert.match(result.stderr, /buildSpecSha256/);
  assert.equal(result.stdout, "");
});

test("CLI는 요청된 release request ID와 다른 approvalId를 fail-closed로 막는다", async () => {
  const { buildSpecPath, requestPath } = await writePair();
  const matched = runCli(buildSpecPath, requestPath,
    ["--expected-approval-id", "release-request-2026-07-26-01"]);
  const mismatched = runCli(buildSpecPath, requestPath,
    ["--expected-approval-id", "release-request-2026-07-18-01"]);

  assert.equal(matched.status, 0, matched.stderr);
  assert.notEqual(mismatched.status, 0);
  assert.match(mismatched.stderr, /approvalId가 요청된 release request ID와 다르다/);
});

test("CLI는 필수 인자 누락을 거부한다", () => {
  const result = spawnSync(process.execPath, [
    cliPath,
    "--build-spec", "tools/datapack/release/candidate-build-spec.json",
  ], { encoding: "utf8" });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--release-request is required/);
});

function manifest(releaseSequence) {
  return {
    manifestVersion: 2,
    channel: "production",
    releaseSequence,
    publishedAt: "2026-07-20T00:00:00.000Z",
    expiresAt: "2026-08-20T00:00:00.000Z",
    packs: [{
      id: "capital",
      version: String(releaseSequence),
      sha256: hash("a"),
      sqliteSha256: hash("b"),
      schemaVersion: "1",
    }],
  };
}
