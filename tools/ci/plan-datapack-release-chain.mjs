#!/usr/bin/env node
// 데이터팩 발행 체인의 CI 입력을 저장소 파일에서 정한다(#927, #870).
// - candidate-refresh: 전국 후보 갱신 workflow의 dispatch 입력을 검증하고 후보 시계(실행 시각)를 정한다.
//   2인 역할 인자는 dispatch 입력으로만 받는다. 이전 후보나 환경 변수에서 채우지 않는다.
// - release-candidate-mode-args: main에 들어온 후보로 RC를 dispatch할 modeArgs를 만든다.
//   release request가 build spec에 결속되지 않았거나 RC 증거 파일이 없으면 dispatch 전에 실패한다.
import { createHash } from "node:crypto";
import { access, appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { releaseRequestBindingViolations } from "../datapack/verify-release-request-binding.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const NATIONWIDE_SCOPE_ID = "nationwide_routing_android_v1";
const ROLE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const APPROVAL_ID = /^[A-Za-z0-9._-]+$/u;

export const RELEASE_CANDIDATE_PATHS = Object.freeze({
  buildSpecPath: "tools/datapack/release/candidate-build-spec.json",
  releaseRequestPath: "tools/datapack/release/release-request.json",
  androidEvidencePath: "tools/datapack/release/android-evidence-summary.json",
  strictRouteRegressionPath: "tools/datapack/release/strict-route-regression-report.json",
});

function fail(code, detail = "") {
  throw new Error(detail ? `${code}: ${detail}` : code);
}

function requireNationwide(buildSpec, code) {
  if (buildSpec?.productionScopeId !== NATIONWIDE_SCOPE_ID) fail(code, String(buildSpec?.productionScopeId));
}

export function planNationwideCandidateRefresh({ releaseSequence, requestedBy, approvedBy, committedBuildSpec, now }) {
  requireNationwide(committedBuildSpec, "CANDIDATE_REFRESH_SCOPE");
  const committed = committedBuildSpec.releaseSequence;
  if (!Number.isSafeInteger(committed) || committed < 1) fail("CANDIDATE_REFRESH_RELEASE_SEQUENCE", "committed sequence is invalid");
  if (typeof releaseSequence !== "string" || !/^[1-9][0-9]*$/u.test(releaseSequence)
    || !Number.isSafeInteger(Number(releaseSequence)) || Number(releaseSequence) <= committed) {
    fail("CANDIDATE_REFRESH_RELEASE_SEQUENCE", `must be an integer greater than committed ${committed}`);
  }
  for (const role of [requestedBy, approvedBy]) {
    if (typeof role !== "string" || !ROLE.test(role)) fail("CANDIDATE_REFRESH_ROLE", JSON.stringify(role));
  }
  if (requestedBy.toLowerCase() === approvedBy.toLowerCase()) fail("CANDIDATE_REFRESH_TWO_PERSON_RULE", requestedBy);
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) fail("CANDIDATE_REFRESH_CLOCK");
  return { evaluatedAt: now.toISOString(), releaseSequence: Number(releaseSequence), requestedBy, approvedBy };
}

export async function readReleaseCandidateModeArgs({ repositoryRoot = ROOT } = {}) {
  const root = path.resolve(repositoryRoot);
  const buildSpecBytes = await readFile(path.join(root, RELEASE_CANDIDATE_PATHS.buildSpecPath));
  const buildSpec = JSON.parse(buildSpecBytes);
  const releaseRequest = JSON.parse(await readFile(path.join(root, RELEASE_CANDIDATE_PATHS.releaseRequestPath), "utf8"));
  requireNationwide(buildSpec, "RELEASE_CANDIDATE_SCOPE");
  const violations = releaseRequestBindingViolations({
    buildSpec,
    buildSpecSha256: createHash("sha256").update(buildSpecBytes).digest("hex"),
    releaseRequest,
    expectedApprovalId: `release-request-${buildSpec.candidateId}`,
  });
  if (typeof releaseRequest.approvalId !== "string" || !APPROVAL_ID.test(releaseRequest.approvalId)) {
    violations.push("approvalId must be a single [A-Za-z0-9._-] token");
  }
  if (violations.length > 0) fail("RELEASE_CANDIDATE_BINDING", violations.join("; "));
  for (const evidence of [RELEASE_CANDIDATE_PATHS.androidEvidencePath, RELEASE_CANDIDATE_PATHS.strictRouteRegressionPath]) {
    try {
      await access(path.join(root, evidence));
    } catch {
      fail("RELEASE_CANDIDATE_EVIDENCE", evidence);
    }
  }
  return {
    buildSpecPath: RELEASE_CANDIDATE_PATHS.buildSpecPath,
    releaseRequestId: releaseRequest.approvalId,
    releaseRequestPath: RELEASE_CANDIDATE_PATHS.releaseRequestPath,
    androidEvidencePath: RELEASE_CANDIDATE_PATHS.androidEvidencePath,
    strictRouteRegressionPath: RELEASE_CANDIDATE_PATHS.strictRouteRegressionPath,
    allowGaps: "false",
    sourceGovernanceEvaluationAt: "",
  };
}

function options(argv, names) {
  const values = {};
  if (argv.length !== names.length * 2) fail("PLAN_RELEASE_CHAIN_ARGUMENTS");
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]?.startsWith("--") ? argv[index].slice(2) : null;
    if (!names.includes(name) || Object.hasOwn(values, name) || typeof argv[index + 1] !== "string") fail("PLAN_RELEASE_CHAIN_ARGUMENTS");
    values[name] = argv[index + 1];
  }
  return values;
}

function absoluteOutput(value) {
  if (!path.isAbsolute(value ?? "")) fail("PLAN_RELEASE_CHAIN_ARGUMENTS", "output must be absolute");
  return value;
}

export async function runPlanDatapackReleaseChain({ argv = process.argv.slice(2), repositoryRoot = ROOT, now = () => new Date() } = {}) {
  const [command, ...rest] = argv;
  if (command === "candidate-refresh") {
    const values = options(rest, ["release-sequence", "requested-by", "approved-by", "github-output"]);
    const output = absoluteOutput(values["github-output"]);
    const committedBuildSpec = JSON.parse(await readFile(path.join(repositoryRoot, RELEASE_CANDIDATE_PATHS.buildSpecPath), "utf8"));
    const plan = planNationwideCandidateRefresh({
      releaseSequence: values["release-sequence"], requestedBy: values["requested-by"], approvedBy: values["approved-by"],
      committedBuildSpec, now: now(),
    });
    await appendFile(output, [
      `evaluated_at=${plan.evaluatedAt}`,
      `release_sequence=${plan.releaseSequence}`,
      `requested_by=${plan.requestedBy}`,
      `approved_by=${plan.approvedBy}`,
      "",
    ].join("\n"));
    return plan;
  }
  if (command === "release-candidate-mode-args") {
    const values = options(rest, ["output"]);
    const modeArgs = await readReleaseCandidateModeArgs({ repositoryRoot });
    await writeFile(absoluteOutput(values.output), `${JSON.stringify(modeArgs)}\n`, { flag: "wx" });
    return modeArgs;
  }
  return fail("PLAN_RELEASE_CHAIN_ARGUMENTS", `unknown command ${String(command)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.stdout.write(`${JSON.stringify(await runPlanDatapackReleaseChain())}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
