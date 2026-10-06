#!/usr/bin/env node
// 수도권 topology 등록 판정(#969 P3, #870 전체 자동화 1단계).
//
// 수도권 topology 갱신 PR(current-capital-topology-refresh)이 병합되면 보호 admission(inventory의
// seoul-metro-route-map-positions.routeMapAdmissionEvidence.currentTopologyAdmission)이 main에 들어온다.
// 그 topology snapshot이 원장(source-snapshots.json)에 없으면 OCI 게시와 원장 등록이 필요하다.
// 이 판정은 읽기만 하고, 등록 workflow가 어느 단계를 할지 한 단어로 돌려준다.
//
//   REGISTERED              admission snapshot이 이미 원장 head다. 할 일이 없다.
//   REGISTER                등록이 필요하다. cleanupClaims는 먼저 지울 claim 브랜치다(병합된 PR의 남은 claim, 게시 증거 없이 버려진 claim).
//   OPEN_PR                 이 workflow의 열린 PR이 있다. 새 일을 하지 않고 CI·방치 상한만 본다.
//   RECOVER_CLAIM           OCI 게시 receipt를 남기고 실패·취소된 claim이다. 그 증거로 PR만 다시 만든다.
//   CLAIM_IN_PROGRESS       claim을 만든 run이 아직 돈다. 기다린다.
//   BLOCKED_BY_PENDING_PR   같은 원장 파일을 쓰는 다른 자동화 PR이 열려 있다. 이상이 아니라 대기다.
//
// 게시 증거 없이 남은 claim은 사람이 지울 일이 아니다(이슈 #973). 정리 대상으로 알리고 이번 실행이 새로 시작한다.
// 그 밖에 판정할 수 없는 상태(claim 중복·닫힌 PR의 claim·복구 불가 claim·admission 누락/만료 등)는 이상이다.
// 이상은 REGISTRATION_* 코드로 실패해 실패 이슈로 드러난다. 이전 데이터로 대체하거나 성공으로 덮지 않는다.
//
// 사용: node tools/ci/decide-capital-topology-registration.mjs --inventory <file> --ledger <file> --prs <gh pr list JSON>
//   --claims <git ls-remote 출력> --runs <gh run list JSON> --artifacts <run id별 artifact 이름 JSON> --repository <owner/repo> --current-main-sha <sha>
//   --pr-limit <gh pr list --limit> --run-limit <gh run list --limit> [--github-output <path>]
import { appendFile, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { requiredUtcInstant } from "../datapack/lib/utc-instant.mjs";
import { isCapitalRouteTopologySnapshotId } from "../datapack/lib/capital-route-topology-snapshot-id.mjs";
import { ownPullRequestsByBranch, parsePrefixedRefs, pendingLedgerWriterPullRequests, validRepository } from "./automation-pr-state.mjs";
import { REFRESH_CLAIM_PREFIXES } from "./refresh-open-pr-age.mjs";

export const REGISTRATION_WORKFLOW = "current-capital-topology-registration.yml";
export const REGISTRATION_CLAIM_PREFIX = REFRESH_CLAIM_PREFIXES[REGISTRATION_WORKFLOW];
const REGISTRATION_WORKFLOW_NAME = "Current Capital Topology Registration";
const SOURCE_ID = "capital-route-topology";
const OWNER_SOURCE_ID = "seoul-metro-route-map-positions";
const SHA = /^[0-9a-f]{40}$/u;

function fail(code, detail = "") {
  throw new Error(detail ? `${code}: ${detail}` : code);
}

/** git ls-remote --heads 출력에서 등록 claim 브랜치만 읽는다. 다른 형식이 섞이면 실패한다. */
export function parseRegistrationClaims(text) {
  return parsePrefixedRefs(text, REGISTRATION_CLAIM_PREFIX, (detail) => fail("REGISTRATION_CLAIM_INVALID", detail));
}

function admission(inventory) {
  const owners = Array.isArray(inventory?.sources) ? inventory.sources.filter(({ id }) => id === OWNER_SOURCE_ID) : [];
  const value = owners.length === 1 ? owners[0].routeMapAdmissionEvidence?.currentTopologyAdmission : null;
  let freshUntilMillis = Number.NaN;
  try { freshUntilMillis = requiredUtcInstant(value?.freshUntil, "freshUntil"); } catch { /* 아래에서 누락으로 실패한다 */ }
  if (value?.status !== "ADMITTED" || !isCapitalRouteTopologySnapshotId(value.topologySnapshotId) || !Number.isFinite(freshUntilMillis)) {
    fail("REGISTRATION_ADMISSION_MISSING", "the protected capital topology admission is missing or malformed");
  }
  return { snapshotId: value.topologySnapshotId, freshUntilMillis };
}

// PR 없는 claim의 처지를 producer run(claim 브랜치 이름의 run id)으로 가린다(이슈 #973).
//  - RECOVER: 같은 main에서 실패·취소·시간 초과로 끝났고 게시 receipt artifact를 남겼다. 그 증거로 PR만 다시 만든다.
//  - RUNNING: 아직 도는 run이다. 건드리지 않고 기다린다.
//  - ABANDONED: 게시 증거가 없거나(provider 단계 실패), main이 움직여 그 증거를 쓸 수 없거나, run 기록이 없거나 성공으로 끝났는데 PR이 없다.
//    사람이 브랜치를 지울 일이 아니다. 정리 대상으로 알리고 이번 실행이 새로 시작한다(게시는 내용 주소 객체라 같은 원본이면 안전하다).
const FINISHED_WITHOUT_PR = new Set(["failure", "cancelled", "timed_out"]);
function classifyUnboundClaim(branch, { runs, artifacts, currentMainSha }) {
  const runId = branch.slice(REGISTRATION_CLAIM_PREFIX.length);
  const found = runs.find((item) => String(item?.databaseId) === runId);
  if (!found) return { kind: "ABANDONED" };
  const unrecoverable = (reason) => fail("REGISTRATION_CLAIM_UNRECOVERABLE", `${branch}: ${reason}`);
  if (found.workflowName !== REGISTRATION_WORKFLOW_NAME) unrecoverable(`producer run ${runId} is not the registration workflow`);
  if (found.headBranch !== "main") unrecoverable(`producer run ${runId} was not on main`);
  if (found.status !== "completed") return { kind: "RUNNING" };
  if (!FINISHED_WITHOUT_PR.has(found.conclusion)) return { kind: "ABANDONED" };
  const hasReceipt = (artifacts[runId] ?? []).includes(`current-capital-topology-registration-${runId}`);
  return hasReceipt && found.headSha === currentMainSha ? { kind: "RECOVER", runId } : { kind: "ABANDONED" };
}

export function decideCapitalTopologyRegistration({ inventory, ledger, pullRequests, claims, runs, repository, currentMainSha, now, limits, artifacts } = {}) {
  if (!Array.isArray(ledger) || !Array.isArray(pullRequests) || !Array.isArray(claims) || !Array.isArray(runs)
    || !artifacts || typeof artifacts !== "object" || Array.isArray(artifacts)
    || !validRepository(repository) || !SHA.test(currentMainSha ?? "")
    || !(now instanceof Date) || Number.isNaN(now.getTime())
    || !Number.isSafeInteger(limits?.pullRequests) || limits.pullRequests < 1 || !Number.isSafeInteger(limits?.runs) || limits.runs < 1) fail("REGISTRATION_INPUT_INVALID");

  const { snapshotId, freshUntilMillis } = admission(inventory);
  const rows = ledger.filter((entry) => entry?.sourceId === SOURCE_ID);
  if (rows.some((entry) => entry.snapshotId === snapshotId)) {
    if (rows.at(-1).snapshotId !== snapshotId) fail("REGISTRATION_ADMISSION_NOT_HEAD", `${snapshotId} is registered but is not the ledger head ${rows.at(-1).snapshotId}`);
    return { state: "REGISTERED", snapshotId };
  }
  if (now.getTime() >= freshUntilMillis) fail("REGISTRATION_ADMISSION_EXPIRED", `${snapshotId} expired before it was registered`);

  // 목록 조회에는 개수 상한이 있다. 상한과 같은 개수면 잘렸을 수 있으므로 일부만 보고 판정하지 않는다(#972 리뷰 F3).
  if (pullRequests.length >= limits.pullRequests) fail("REGISTRATION_LIST_TRUNCATED", `pull request list reached its limit ${limits.pullRequests}`);
  if (runs.length >= limits.runs) fail("REGISTRATION_LIST_TRUNCATED", `run list reached its limit ${limits.runs}`);

  const own = ownPullRequestsByBranch(pullRequests, REGISTRATION_CLAIM_PREFIX, repository, (branch) => fail("REGISTRATION_PR_DUPLICATE", branch));
  const open = [...own.values()].filter(({ state }) => state === "OPEN");
  if (open.length > 1) fail("REGISTRATION_PR_DUPLICATE", open.map(({ number }) => `#${number}`).join(", "));
  const live = claims.filter(({ branch }) => own.get(branch)?.state !== "MERGED");
  // 병합된 PR의 claim 브랜치는 남아 있어도 살아 있는 claim이 아니다. claim step과 같은 기준으로 정리 대상에 올린다(#972 리뷰 F2).
  const cleanupClaims = claims.filter(({ branch }) => own.get(branch)?.state === "MERGED").map(({ branch }) => branch);
  if (open.length === 1) {
    const [pullRequest] = open;
    if (!live.some(({ branch }) => branch === pullRequest.headRefName)) fail("REGISTRATION_CLAIM_MISSING", `#${pullRequest.number} has no claim branch`);
    if (live.length > 1) fail("REGISTRATION_CLAIM_DUPLICATE", live.map(({ branch }) => branch).join(", "));
    return { state: "OPEN_PR", snapshotId, branch: pullRequest.headRefName };
  }
  if (live.length > 1) fail("REGISTRATION_CLAIM_DUPLICATE", live.map(({ branch }) => branch).join(", "));

  let result = { state: "REGISTER", snapshotId, cleanupClaims };
  if (live.length === 1) {
    const [{ branch }] = live;
    if (own.get(branch)?.state === "CLOSED") fail("REGISTRATION_CLAIM_CLOSED", `${branch} is bound to a closed pull request`);
    const claim = classifyUnboundClaim(branch, { runs, artifacts, currentMainSha });
    if (claim.kind === "RUNNING") return { state: "CLAIM_IN_PROGRESS", snapshotId, branch };
    result = claim.kind === "RECOVER"
      ? { state: "RECOVER_CLAIM", snapshotId, branch, recoveryRunId: claim.runId, cleanupClaims }
      : { state: "REGISTER", snapshotId, cleanupClaims: [...cleanupClaims, branch] };
  }
  const blockedBy = pendingLedgerWriterPullRequests(pullRequests, repository, REGISTRATION_WORKFLOW);
  return blockedBy.length > 0 ? { state: "BLOCKED_BY_PENDING_PR", snapshotId, blockedBy } : result;
}

function parseArgs(argv) {
  const keys = new Map([
    ["--inventory", "inventory"], ["--ledger", "ledger"], ["--prs", "prs"], ["--claims", "claims"], ["--runs", "runs"], ["--artifacts", "artifacts"],
    ["--repository", "repository"], ["--current-main-sha", "currentMainSha"], ["--pr-limit", "prLimit"], ["--run-limit", "runLimit"], ["--github-output", "githubOutput"],
  ]);
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = keys.get(argv[index]);
    if (!key || Object.hasOwn(values, key) || typeof argv[index + 1] !== "string") fail("REGISTRATION_INPUT_INVALID", `argument ${String(argv[index])}`);
    values[key] = argv[index + 1];
  }
  for (const key of ["inventory", "ledger", "prs", "claims", "runs", "artifacts", "repository", "currentMainSha", "prLimit", "runLimit"]) {
    if (!Object.hasOwn(values, key)) fail("REGISTRATION_INPUT_INVALID", `missing --${key}`);
  }
  return values;
}

export async function main(argv, { now = new Date(), log = console.log } = {}) {
  const values = parseArgs(argv);
  const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));
  const result = decideCapitalTopologyRegistration({
    inventory: await readJson(values.inventory), ledger: await readJson(values.ledger), pullRequests: await readJson(values.prs),
    claims: parseRegistrationClaims(await readFile(values.claims, "utf8")), runs: await readJson(values.runs), artifacts: await readJson(values.artifacts),
    repository: values.repository, currentMainSha: values.currentMainSha, now,
    limits: { pullRequests: Number(values.prLimit), runs: Number(values.runLimit) },
  });
  log(JSON.stringify(result));
  if (values.githubOutput) {
    await appendFile(values.githubOutput, [
      `state=${result.state}`, `snapshot_id=${result.snapshotId}`, `branch=${result.branch ?? ""}`,
      `recovery_run_id=${result.recoveryRunId ?? ""}`, `cleanup_claims=${(result.cleanupClaims ?? []).join(",")}`, `blocked_by=${(result.blockedBy ?? []).join(",")}`, "",
    ].join("\n"));
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
