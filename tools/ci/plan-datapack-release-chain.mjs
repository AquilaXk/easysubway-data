#!/usr/bin/env node
// 데이터팩 발행 체인의 CI 입력을 저장소 파일에서 정한다(#927, #870).
// - candidate-refresh: 전국 후보 갱신 workflow의 dispatch 입력을 검증하고 후보 시계(실행 시각)를 정한다.
//   사람 dispatch(workflow_dispatch)는 2인 역할을 입력으로만 받는다. 이전 후보나 환경 변수에서 채우지 않는다.
//   정기 이벤트(schedule, #929 D3)는 사람 입력 없이 정기 전용 고정 역할과 커밋된 후보 다음 sequence를 쓴다.
//   외부 스케줄러 App이 시작한 workflow_dispatch(#1032)도 같다. 행위자는 GitHub 컨텍스트에서만 받고 입력으로 받지 않는다.
// - gate-run: 후보를 만드는 이 run의 기록(release request gateRun)을 Actions 기본 환경 변수로 만든다.
// - release-candidate-mode-args: main에 들어온 후보로 RC를 dispatch할 modeArgs를 만든다.
//   release request가 build spec에 결속되지 않았거나 RC 증거 파일이 없으면 dispatch 전에 실패한다.
import { createHash } from "node:crypto";
import { access, appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { releaseRequestBindingViolations } from "../datapack/verify-release-request-binding.mjs";
import {
  PERSON_ROLE_EVENT,
  SCHEDULED_RELEASE_ROLES,
  SCHEDULED_ROLE_EVENTS,
  SCHEDULER_APP_LOGIN,
  gateRunFromEnvironment,
  gateRunRecordViolations,
  releaseRoleEventViolations,
} from "../datapack/lib/scheduled-release-authority.mjs";

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

export function planNationwideCandidateRefresh({ releaseSequence, requestedBy, approvedBy, committedBuildSpec, now, event, actor }) {
  requireNationwide(committedBuildSpec, "CANDIDATE_REFRESH_SCOPE");
  const committed = committedBuildSpec.releaseSequence;
  if (!Number.isSafeInteger(committed) || committed < 1) fail("CANDIDATE_REFRESH_RELEASE_SEQUENCE", "committed sequence is invalid");
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) fail("CANDIDATE_REFRESH_CLOCK");
  if (SCHEDULED_ROLE_EVENTS.includes(event) || (event === PERSON_ROLE_EVENT && actor === SCHEDULER_APP_LOGIN)) {
    // 정기 실행과 스케줄러 App의 dispatch는 사람 입력을 받지 않는다. 입력이 섞이면 누가 무엇을 정했는지 흐려지므로 실패한다.
    if ([releaseSequence, requestedBy, approvedBy].some((value) => value !== undefined && value !== "")) {
      fail("CANDIDATE_REFRESH_SCHEDULED_INPUT", `${event} run takes no release sequence or role input`);
    }
    return { evaluatedAt: now.toISOString(), releaseSequence: committed + 1, ...SCHEDULED_RELEASE_ROLES };
  }
  if (event !== PERSON_ROLE_EVENT) fail("CANDIDATE_REFRESH_EVENT", String(event));
  if (typeof releaseSequence !== "string" || !/^[1-9][0-9]*$/u.test(releaseSequence)
    || !Number.isSafeInteger(Number(releaseSequence)) || Number(releaseSequence) <= committed) {
    fail("CANDIDATE_REFRESH_RELEASE_SEQUENCE", `must be an integer greater than committed ${committed}`);
  }
  for (const role of [requestedBy, approvedBy]) {
    if (typeof role !== "string" || !ROLE.test(role)) fail("CANDIDATE_REFRESH_ROLE", JSON.stringify(role));
  }
  if (requestedBy.toLowerCase() === approvedBy.toLowerCase()) fail("CANDIDATE_REFRESH_TWO_PERSON_RULE", requestedBy);
  const roleViolations = releaseRoleEventViolations({ requestedBy, approvedBy, event, actor });
  if (roleViolations.length > 0) fail("CANDIDATE_REFRESH_ROLE_EVENT", roleViolations.join("; "));
  return { evaluatedAt: now.toISOString(), releaseSequence: Number(releaseSequence), requestedBy, approvedBy };
}

export async function readReleaseCandidateModeArgs({ repositoryRoot = ROOT, gateRunRecord } = {}) {
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
  // #929 D3: gateRun을 결속한 후보는 GitHub run 기록과 대조해 main에서 성공한 그 run일 때만 RC로 보낸다.
  if (releaseRequest.gateRun !== undefined) {
    if (gateRunRecord === undefined) fail("RELEASE_CANDIDATE_GATE_RUN", "record is required for a request with gateRun");
    const recordViolations = gateRunRecordViolations({
      gateRun: releaseRequest.gateRun, run: gateRunRecord, candidateClock: buildSpec.publishedAt,
    });
    if (recordViolations.length > 0) fail("RELEASE_CANDIDATE_GATE_RUN", recordViolations.join("; "));
  } else if (gateRunRecord !== undefined) {
    fail("RELEASE_CANDIDATE_GATE_RUN", "a record was given for a request with no gateRun");
  }
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

// data#1084: 승격까지 끝난 후보를 production-publish로 보낼 modeArgs. RC와 같은 저장소 파일·같은 결속 검증을 거치고,
// 후보 RC run과 hub 승격 run의 정확한 id만 더한다. 파일에 없는 값은 입력으로 받지 않는다.
export async function readProductionPublishModeArgs({ repositoryRoot = ROOT, gateRunRecord, candidateRunId, promotionRunId } = {}) {
  for (const value of [candidateRunId, promotionRunId]) {
    if (typeof value !== "string" || !/^[1-9][0-9]*$/u.test(value)) fail("PRODUCTION_PUBLISH_RUN_ID", String(value));
  }
  const modeArgs = await readReleaseCandidateModeArgs({ repositoryRoot, gateRunRecord });
  return { ...modeArgs, candidateRunId, promotionRunId };
}

function options(argv, names, optionalNames = []) {
  const values = {};
  if (argv.length % 2 !== 0 || argv.length < names.length * 2 || argv.length > (names.length + optionalNames.length) * 2) {
    fail("PLAN_RELEASE_CHAIN_ARGUMENTS");
  }
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]?.startsWith("--") ? argv[index].slice(2) : null;
    if ((!names.includes(name) && !optionalNames.includes(name)) || Object.hasOwn(values, name) || typeof argv[index + 1] !== "string") {
      fail("PLAN_RELEASE_CHAIN_ARGUMENTS");
    }
    values[name] = argv[index + 1];
  }
  if (names.some((name) => !Object.hasOwn(values, name))) fail("PLAN_RELEASE_CHAIN_ARGUMENTS");
  return values;
}

function absoluteOutput(value) {
  if (!path.isAbsolute(value ?? "")) fail("PLAN_RELEASE_CHAIN_ARGUMENTS", "output must be absolute");
  return value;
}

export async function runPlanDatapackReleaseChain({ argv = process.argv.slice(2), repositoryRoot = ROOT, now = () => new Date(), env = process.env } = {}) {
  const [command, ...rest] = argv;
  if (command === "candidate-refresh") {
    const values = options(rest, ["release-sequence", "requested-by", "approved-by", "event", "github-output"], ["actor"]);
    const output = absoluteOutput(values["github-output"]);
    const committedBuildSpec = JSON.parse(await readFile(path.join(repositoryRoot, RELEASE_CANDIDATE_PATHS.buildSpecPath), "utf8"));
    const plan = planNationwideCandidateRefresh({
      releaseSequence: values["release-sequence"], requestedBy: values["requested-by"], approvedBy: values["approved-by"],
      committedBuildSpec, now: now(), event: values.event, actor: values.actor,
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
  if (command === "gate-run") {
    const values = options(rest, ["output"]);
    const gateRun = gateRunFromEnvironment(env);
    await writeFile(absoluteOutput(values.output), `${JSON.stringify(gateRun, null, 2)}\n`, { flag: "wx" });
    return gateRun;
  }
  if (command === "release-candidate-mode-args") {
    const values = options(rest, ["output"], ["gate-run-record"]);
    const gateRunRecord = values["gate-run-record"] === undefined
      ? undefined
      : JSON.parse(await readFile(absoluteOutput(values["gate-run-record"]), "utf8"));
    const modeArgs = await readReleaseCandidateModeArgs({ repositoryRoot, gateRunRecord });
    await writeFile(absoluteOutput(values.output), `${JSON.stringify(modeArgs)}\n`, { flag: "wx" });
    return modeArgs;
  }
  if (command === "production-publish-mode-args") {
    const values = options(rest, ["output", "candidate-run-id", "promotion-run-id"], ["gate-run-record"]);
    const gateRunRecord = values["gate-run-record"] === undefined
      ? undefined
      : JSON.parse(await readFile(absoluteOutput(values["gate-run-record"]), "utf8"));
    const modeArgs = await readProductionPublishModeArgs({
      repositoryRoot, gateRunRecord, candidateRunId: values["candidate-run-id"], promotionRunId: values["promotion-run-id"],
    });
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
