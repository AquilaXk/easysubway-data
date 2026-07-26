#!/usr/bin/env node
// release request와 candidate build spec의 결속(binding)을 release 시작 지점에서 fail-closed로 검증한다.
//
// 이 검증을 repository-contract(모든 PR에서 도는 계약 테스트)에 걸지 않고 release 판정 경로에만
// 배선한 근거:
//   - tools/datapack/release/candidate-build-spec.json은 admission PR마다 sourceInventorySha256가
//     재pin되어 파일 바이트 해시가 바뀐다(#2246 재결속 이후 main 기준 28커밋이 이 파일을 수정).
//     모든 PR에서 바이트 해시 일치를 강제하면 admission PR마다 release request 재결속(=오너 재승인)을
//     요구하는 과결합이 되고, 승인 이력이 데이터 반입 리듬에 종속된다.
//   - 반대로 결속이 어긋난 채 release를 돌리면 decide-datapack-release.mjs의 validApproval()이
//     approvalValid=false → MATERIAL_CHANGE_UNAPPROVED로 막아 주기는 하지만, 그 시점은 data pack을
//     전부 빌드한 뒤이고 reason code만으로는 어느 필드가 어긋났는지 드러나지 않는다.
//   - 그래서 같은 술어를 release 경로 진입 직후로 앞당겨, 어긋난 필드를 지목하며 즉시 종료시킨다.
//     admission PR에는 아무 영향이 없고 release 실행만 fail-closed로 막힌다.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { parseArgs, requiredArg } from "./lib/cli-args.mjs";

// decide-datapack-release.mjs의 validApproval()과 같은 술어를 검사한다.
// 여기서 통과하고 거기서 막히는 경우가 없도록 항목을 일치시킨다.
// expectedApprovalId를 넘기면 "요청된 release request ID == release request의 approvalId" 대조까지
// 더해 preflight가 validApproval()의 실제 상위집합이 된다. 도입 시점(#2521)에는 workflow의 인라인
// 대조(datapack-release.yml)가 파일 입력 경로에만 걸려 있어 API 조회 경로에서 이 항목을 아무도 보지
// 않는 비대칭이 있었고, #2565가 그 조회 경로 자체를 제거해 지금은 release request 입력이 리포 파일
// 하나뿐이다. 대조는 그대로 유지된다 — dispatch가 넘긴 ID와 파일의 approvalId가 어긋나면 막는다.
export function releaseRequestBindingViolations({
  buildSpec, buildSpecSha256, releaseRequest, expectedApprovalId = null,
}) {
  if (!buildSpec || typeof buildSpec !== "object") return ["build spec을 읽지 못했다"];
  if (!releaseRequest || typeof releaseRequest !== "object") return ["release request를 읽지 못했다"];
  const violations = [];
  if (releaseRequest.artifactKind !== "datapack-release-request") {
    violations.push(`artifactKind는 datapack-release-request여야 한다 (실제: ${describe(releaseRequest.artifactKind)})`);
  }
  if (releaseRequest.targetChannel !== "production") {
    violations.push(`targetChannel은 production이어야 한다 (실제: ${describe(releaseRequest.targetChannel)})`);
  }
  if (typeof releaseRequest.approvalId !== "string" || releaseRequest.approvalId.length === 0) {
    violations.push("approvalId는 비어 있지 않은 문자열이어야 한다");
  }
  if (expectedApprovalId != null && releaseRequest.approvalId !== expectedApprovalId) {
    violations.push(`approvalId가 요청된 release request ID와 다르다 (request: ${describe(releaseRequest.approvalId)}, 요청: ${describe(expectedApprovalId)})`);
  }
  if (!nonEmptyString(releaseRequest.requestedBy) || !nonEmptyString(releaseRequest.approvedBy)
    || releaseRequest.requestedBy === releaseRequest.approvedBy) {
    violations.push("requestedBy·approvedBy는 비어 있지 않고 서로 달라야 한다");
  }
  if (!isSha256(buildSpecSha256)) violations.push("build spec 바이트 해시를 계산하지 못했다");
  if (!isSha256(buildSpec.sourceSnapshotSetHash)) {
    violations.push("buildSpec.sourceSnapshotSetHash는 sha256이어야 한다");
  }
  if (!isSha256(buildSpec.approvedAliasLedgerHash)) {
    violations.push("buildSpec.approvedAliasLedgerHash는 sha256이어야 한다");
  }
  pushMismatch(violations, "candidateId", releaseRequest.candidateId, buildSpec.candidateId);
  pushMismatch(violations, "buildSpecSha256", releaseRequest.buildSpecSha256, buildSpecSha256);
  pushMismatch(violations, "sourceSnapshotSetHash",
    releaseRequest.sourceSnapshotSetHash, buildSpec.sourceSnapshotSetHash);
  pushMismatch(violations, "approvedLedgerHash",
    releaseRequest.approvedLedgerHash, buildSpec.approvedAliasLedgerHash);
  return violations;
}

function pushMismatch(violations, field, actual, expected) {
  if (actual === expected) return;
  violations.push(`release request ${field}가 build spec과 어긋났다 (request: ${describe(actual)}, build spec: ${describe(expected)})`);
}

function describe(value) {
  return typeof value === "string" ? value : String(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function isSha256(value) {
  return /^[a-f0-9]{64}$/.test(value ?? "");
}

async function main(argv) {
  const args = parseArgs(argv);
  const buildSpecPath = path.resolve(requiredArg(args, "build-spec"));
  const releaseRequestPath = path.resolve(requiredArg(args, "release-request"));
  const buildSpecBytes = await readFile(buildSpecPath);
  const buildSpec = JSON.parse(buildSpecBytes.toString("utf8"));
  const releaseRequest = JSON.parse(await readFile(releaseRequestPath, "utf8"));
  const buildSpecSha256 = createHash("sha256").update(buildSpecBytes).digest("hex");
  const violations = releaseRequestBindingViolations({
    buildSpec, buildSpecSha256, releaseRequest,
    expectedApprovalId: args.get("expected-approval-id") ?? null,
  });
  if (violations.length > 0) {
    throw new Error([
      "release request가 현행 build spec에 결속돼 있지 않다 — release를 진행할 수 없다.",
      ...violations.map((violation) => `- ${violation}`),
      `build spec: ${buildSpecPath}`,
      `release request: ${releaseRequestPath}`,
    ].join("\n"));
  }
  process.stdout.write(`${JSON.stringify({
    status: "PASS",
    candidateId: buildSpec.candidateId,
    approvalId: releaseRequest.approvalId,
    buildSpecSha256,
  })}\n`);
}

// main().catch(...)는 decide-datapack-release.mjs 말미와 같은 리포 관용구다. top-level await로
// 바꾸면 이 모듈을 import하는 테스트가 CLI 실패 경로의 rejection을 그대로 떠안게 되므로 유지한다.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
