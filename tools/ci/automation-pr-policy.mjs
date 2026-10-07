#!/usr/bin/env node
// 데이터 전용 자동화 PR의 자동 병합 정책(#985, #870 전체 자동화 2단계, #969 증거 블록의 소비자).
//
// 사람의 리뷰·라벨 없이 병합 경로(automerge 라벨 -> 코디네이터)에 올리는 판정이다. 아래 조건이 모두 맞을 때만 적격이고, 하나라도 어긋나면
// 위반 코드와 함께 막는다(fail closed). 증거 블록은 색인일 뿐이고 변경 경로·커밋 신원·CI는 GitHub API 데이터로, 게이트는 PR head에서
// 다시 계산해 대조한다.
//
//   AUTHOR          PR 작성자가 App easysubway-release-chain[bot](login·id·type 고정)이다.
//   BRANCH          head 브랜치가 증거 단계의 claim 접두사와 `<run id>`로 정확히 맞는다.
//   EVIDENCE        증거 블록이 정확히 하나이고 정확한 키·알려진 단계로 파싱된다.
//   HEAD_MISMATCH   블록의 head sha가 PR head와 같다.
//   BASE            블록의 base sha가 실제 분기점(compare merge base)과 같다.
//   BEHIND          PR이 main보다 뒤처지지 않았다(base 갱신은 head를 바꿔 블록 결속을 깨므로 하지 않는다).
//   COMMITS         브랜치의 모든 커밋의 작성자·커미터가 App 또는 github-actions이고 merge 커밋이 없다. App 신원의 커밋은 GitHub 서명(verification.verified)도 요구한다.
//                   이 검사는 advisory다(인증이 아니다): github-actions의 git push 커밋은 서명되지 않고(실측 verification.verified=false) GitHub이 작성자를 이메일로
//                   연결하므로 github-actions noreply 주소를 쓴 커밋은 이 검사를 통과한다. 실제 경계는 자동화 브랜치를 push할 수 있는 사람(저장소 쓰기 권한)이다.
//                   검사가 하는 일은 자동화 브랜치에 손으로 커밋을 얹은 정상적인 사람 개입을 이상으로 드러내는 것이다.
//   PATHS           API diff의 변경 경로가 단계별 allowlist와 정확히 맞는다(정기 갱신 4종(#1012): 증거 step의 경로와 정확히 같고 파일마다 added·modified가 규칙과 맞음. 등록·ITX: 정확히 같음. 등록은 원장·inventory 둘뿐이다(#989: 재등록은 정책 파일을 쓰지 않는다), 재결속: 증거의 변경 단계 경로와 같고
//                   각 단계가 허용한 경로, 후보: 후보 갱신 도구의 출력 목록 안).
//   CI              CI workflow가 이 head에서 성공으로 끝났고 ruleset의 required context가 모두 성공이다.
//   GATES           PR head에서 게이트를 다시 계산한 check(Automation PR gates)가 github-actions가 만든 성공이다.
//   LEDGER_GATE·INVENTORY_GATE·ITX_GATE·CANDIDATE_GATE·REFRESH_GATE·EVIDENCE_DRIFT   게이트 재계산(CI가 PR head 작업 트리에서 한다)의 위반이다.
//
// 이 파일의 명령:
//   prepare   CI job의 분류: 정책 대상 PR이면 증거의 base sha를 내보낸다(그 커밋을 fetch한 뒤 gates를 부른다).
//   gates     CI job의 게이트 재계산. 읽기 전용 토큰으로 PR head 작업 트리에서 돈다.
//   decide    라벨러(workflow_run, 기본 브랜치 코드)의 판정. PR 데이터는 API로만 읽고 PR 코드는 실행하지 않는다.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { automationPrEvidencePayload, itxPromotionAllowedPaths, itxPromotionSourceRow, parseAutomationPrEvidence } from "./automation-pr-evidence.mjs";
import { REFRESH_CLAIM_PREFIXES } from "./refresh-open-pr-age.mjs";
import { evaluateLedgerChange, parseLedgerChangePolicy } from "./source-ledger-gate.mjs";
import { SOURCE_REVERIFICATION_REGISTRATION_OUTPUTS, isSourceReverificationAllowedPath } from "./source-reverification-paths.mjs";
import { evaluateEvidenceChange } from "../datapack/run-source-reverification.mjs";
import { REVERIFICATION_RECIPES, inventoryChangeViolations, inventoryScopeViolations } from "../datapack/source-reverification-recipes.mjs";
import { DERIVATIVE_STEPS } from "../datapack/run-derivative-rebinding.mjs";
import { REFRESH_STAGES, REFRESH_STAGE_IDS, evaluateRefreshStage, isRefreshStage, refreshFileViolation } from "./refresh-stage-contracts.mjs";
import { ITX_PROMOTION_MODE_GATE_PASSED, itxPromotionReceiptPath, verifyItxGatePromotion } from "../datapack/lib/itx-promotion-authority.mjs";
import { SCHEDULED_RELEASE_ROLES, gateRunViolations } from "../datapack/lib/scheduled-release-authority.mjs";
import {
  NATIONWIDE_CANDIDATE_REFRESH_OUTPUTS,
  nationwideCandidateRefreshViolations,
  readNationwideCandidateRefreshState,
} from "../datapack/refresh-nationwide-candidate.mjs";

const execFileAsync = promisify(execFile);
const GIT = "/usr/bin/git";

/** 자동화 PR을 만들고 자동 병합을 승인하는 App. login·id·type이 모두 같아야 신뢰한다. */
export const AUTOMATION_PR_APP = Object.freeze({ login: "easysubway-release-chain[bot]", id: 337648189, type: "Bot" });
/** 자동화 workflow의 브랜치 push가 쓰는 GITHUB_TOKEN 신원. */
export const AUTOMATION_PR_ACTIONS_BOT = Object.freeze({ login: "github-actions[bot]", id: 41898282, type: "Bot" });
const TRUSTED_COMMIT_IDENTITIES = Object.freeze([AUTOMATION_PR_APP, AUTOMATION_PR_ACTIONS_BOT]);
export const GITHUB_ACTIONS_APP_ID = 15368;
export const AUTOMATION_PR_GATES_CONTEXT = "Automation PR gates";
export const AUTOMATION_AUTOMERGE_LABEL = "automerge";
export const AUTOMATION_AUTOMERGE_VARIABLE = "DATAPACK_AUTOMATION_AUTOMERGE";
const ATTESTATION_PREFIX = "<!-- Automation automerge policy: ";

/** 단계 -> 그 단계 PR을 만드는 workflow. claim 접두사의 정본은 refresh-open-pr-age의 REFRESH_CLAIM_PREFIXES 한 곳이다. */
export const AUTOMATION_STAGE_WORKFLOWS = Object.freeze({
  registration: "current-capital-topology-registration.yml",
  "derivative-rebinding": "source-derivative-rebinding.yml",
  "candidate-refresh": "nationwide-candidate-refresh.yml",
  "itx-promotion": "itx-current-promotion.yml",
  "source-reverification": "source-reverification.yml",
  // #1012: 정기 갱신 4종. workflow 표는 refresh-stage-contracts가 정본이다.
  ...Object.fromEntries(REFRESH_STAGE_IDS.map((stage) => [stage, REFRESH_STAGES[stage].workflow])),
});
export const AUTOMATION_STAGE_PREFIXES = Object.freeze(
  Object.fromEntries(Object.entries(AUTOMATION_STAGE_WORKFLOWS).map(([stage, workflow]) => [stage, REFRESH_CLAIM_PREFIXES[workflow]])),
);

/**
 * 등록 PR이 자동 병합 대상으로서 바꿔도 되는 경로: 원장과 inventory 둘이다(#986 F6).
 * governance 정책·신선도 SLA(release/product-gates)는 원천을 처음 등록할 때만 바뀌는 정책이고 내용을 독립적으로 재계산할 수 없어 allowlist에 넣지 않는다.
 * 재등록(P7D)은 두 파일을 쓰지 않는다(#989): 등록기는 정책 변경이 필요하면 게시 전에 REGISTRATION_POLICY_CHANGE_REQUIRED로 실패하고,
 * 등록 workflow는 두 경로만 커밋하며 정책 파일이 바뀌어 있으면 REGISTRATION_POLICY_CHANGED로 실패한다. 계약 테스트가 이 두 경로와 workflow가 커밋하는 경로를 고정한다.
 */
export const REGISTRATION_ALLOWED_PATHS = Object.freeze([
  "tools/datapack/release/source-snapshots.json",
  "tools/datapack/source-inventory.json",
]);

/**
 * 등록 단계가 inventory의 등록 원천 항목에서 바꾸는 필드(#989). 등록기가 항목을 다시 만들 때 바뀌는 것은 수집 시각과 admission 증거뿐이고,
 * 실제 등록 커밋(seq127 6741d1b89, seq128 8a7b4c1ba)이 정확히 이 세 필드만 바꿨다. 정책성 필드(productionUseAllowed·license·datasetUrl·coverage 등)는 고정이다.
 */
export const REGISTRATION_INVENTORY_FIELDS = Object.freeze({
  "capital-route-topology": Object.freeze(["observedDataUpdatedAt", "retrievedAt", "capitalTopologyAdmissionEvidence"]),
});

const INVENTORY_PATH = "tools/datapack/source-inventory.json";
const GOVERNANCE_PATH = "tools/datapack/source-governance-policy.json";
const LEDGER_PATH = "tools/datapack/release/source-snapshots.json";
const LEDGER_POLICY_PATH = "tools/ci/source-ledger-change-policy.json";
const ITX_CONTRACT_PATH = "tools/datapack/itx-cheongchun-coverage-contract.json";
const COMMIT_LIMIT = 250;
const FILE_LIMIT = 3000;
const COMMIT_PAGES = 3;
const FILE_PAGES = 30;
const COMMIT = /^[0-9a-f]{40}$/u;
export const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const MAIN = "main";

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const sortCodepoint = (values) => [...values].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
const message = (error) => (error instanceof Error ? error.message : String(error));

export function inputError(detail) {
  return new Error(`AUTOMATION_PR_INPUT: ${detail}`);
}

const SHA256 = /^[0-9a-f]{64}$/u;

/** 기록 본문. head와 CI가 본 증거 블록 digest에 묶인다(#986 F3). */
export function automationAttestationMarker(headSha, evidenceSha256) {
  if (typeof headSha !== "string" || !COMMIT.test(headSha)) throw inputError("head sha");
  if (typeof evidenceSha256 !== "string" || !SHA256.test(evidenceSha256)) throw inputError("evidence sha256");
  return `${ATTESTATION_PREFIX}${headSha} evidence ${evidenceSha256} -->`;
}

/** 본문 증거 블록 JSON 페이로드 텍스트의 sha256. 블록이 없거나 둘 이상이면 실패한다. */
export function automationEvidenceDigest(body) {
  const payload = automationPrEvidencePayload(body);
  if (payload === null) throw new Error("AUTOMATION_PR_EVIDENCE: 증거 블록이 정확히 하나가 아니다");
  return createHash("sha256").update(payload).digest("hex");
}

/**
 * App이 남긴 정책 통과 기록이 이 head에서 유효한지(#986 F1). 코디네이터의 jq 판정과 같은 기준이다.
 * - 작성자가 신뢰 App이고 본문이 이 head와 증거 블록 digest의 기록과 정확히 같다.
 * - 편집되지 않았다(updated_at이 created_at과 같다). 쓰기 권한자가 App 기록을 새 head로 고쳐 쓰는 것을 막는다.
 * - head 커밋보다 먼저 만들어지지 않았다. 앞선 head의 기록을 재사용하는 것을 막는다(커밋 시각은 작성자가 정할 수 있어 이것만으로 방어가 되지는 않는다).
 */
export function isValidAttestation(comment, headSha, evidenceSha256, headCommittedAt) {
  if (!isObject(comment) || !sameIdentity(comment.user, AUTOMATION_PR_APP) || comment.body !== automationAttestationMarker(headSha, evidenceSha256)) return false;
  const created = Date.parse(comment.created_at);
  return typeof comment.created_at === "string" && comment.created_at === comment.updated_at
    && created >= Date.parse(headCommittedAt);
}

/** 브랜치가 어느 단계의 claim 브랜치인지. 접두사 뒤가 양의 정수 run id 하나가 아니면 null이다. */
export function automationStageForBranch(ref) {
  if (typeof ref !== "string") return null;
  for (const [stage, prefix] of Object.entries(AUTOMATION_STAGE_PREFIXES)) {
    if (ref.startsWith(prefix) && /^[1-9][0-9]*$/u.test(ref.slice(prefix.length))) return stage;
  }
  return null;
}

const sameIdentity = (user, expected) => isObject(user) && user.login === expected.login && user.id === expected.id && user.type === expected.type;
const trustedCommitIdentity = (user) => TRUSTED_COMMIT_IDENTITIES.some((expected) => sameIdentity(user, expected));
export const isAutomationApp = (user) => sameIdentity(user, AUTOMATION_PR_APP);

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isObject(value)) return `{${sortCodepoint(Object.keys(value)).map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
const sameJson = (left, right) => canonicalJson(left) === canonicalJson(right);

function describeSetDifference(actual, expected, { subset = false } = {}) {
  const missing = subset ? [] : expected.filter((entry) => !actual.includes(entry));
  const extra = actual.filter((entry) => !expected.includes(entry));
  const shown = (list) => list.slice(0, 8).join(", ") + (list.length > 8 ? ` 외 ${list.length - 8}개` : "");
  return [extra.length > 0 ? `허용 밖 경로: ${shown(extra)}` : "", missing.length > 0 ? `빠진 경로: ${shown(missing)}` : ""].filter(Boolean).join(" / ");
}

/** API diff의 변경 경로. 이름을 바꾼 파일은 원래 경로도 바뀐 경로로 센다. */
function changedPathsOf(files) {
  const changed = new Set();
  for (const entry of files) {
    if (!isObject(entry) || typeof entry.filename !== "string" || entry.filename === "") return null;
    changed.add(entry.filename);
    if (entry.previous_filename !== undefined) {
      if (typeof entry.previous_filename !== "string" || entry.previous_filename === "") return null;
      changed.add(entry.previous_filename);
    }
  }
  return sortCodepoint(changed);
}

/** 단계별 allowlist와 API diff를 대조한다. 어긋나면 사람이 읽을 사유를 돌려주고, 맞으면 null이다. */
function pathViolation(evidence, files) {
  if (files.length >= FILE_LIMIT) return `변경 파일 목록이 API 상한(${FILE_LIMIT})에 닿아 전체를 알 수 없다`;
  const changed = changedPathsOf(files);
  if (changed === null) return "변경 파일 항목의 형식이 다르다";
  if (changed.length === 0) return "변경 경로가 비어 있다";
  if (isRefreshStage(evidence.stage)) {
    // 정기 갱신 4종(#1012): 증거 step의 경로 allowlist와 API diff가 정확히 같고, 파일마다 단계 규칙이 정한 변경 종류(added·modified)여야 한다.
    // allowlist는 .github·tools 코드·governance·SLA를 담지 못한다(단계 규칙 밖). 이름 변경·삭제는 규칙의 변경 종류가 아니다.
    const fileReason = refreshFileViolation(evidence.stage, files);
    if (fileReason !== null) return fileReason;
    const claimedPaths = evidence.steps[0].paths;
    return sameJson(changed, sortCodepoint(claimedPaths)) ? null : describeSetDifference(changed, sortCodepoint(claimedPaths));
  }
  if (evidence.stage === "registration") {
    return sameJson(changed, sortCodepoint(REGISTRATION_ALLOWED_PATHS)) ? null : describeSetDifference(changed, sortCodepoint(REGISTRATION_ALLOWED_PATHS));
  }
  if (evidence.stage === "itx-promotion") {
    const allowed = itxPromotionAllowedPaths(evidence.sources[0].snapshotId);
    return sameJson(changed, allowed) ? null : describeSetDifference(changed, allowed);
  }
  if (evidence.stage === "derivative-rebinding") {
    const claimed = [];
    for (const step of evidence.steps) {
      const known = DERIVATIVE_STEPS.find(({ id }) => id === step.id);
      if (!known) return `알 수 없는 재결속 단계: ${step.id}`;
      for (const entry of step.paths) {
        if (!known.isAllowedPath(entry)) return `재결속 단계 ${step.id}가 허용하지 않는 경로: ${entry}`;
        claimed.push(entry);
      }
    }
    const expected = sortCodepoint(new Set(claimed));
    return sameJson(changed, expected) ? null : describeSetDifference(changed, expected);
  }
  if (evidence.stage === "source-reverification") {
    // 원천 재확인(#987 F6): 증거가 주장한 경로가 재확인이 허용한 경로(원장·inventory·새 snapshot 파일)여야 하고 API diff와 정확히 같아야 한다.
    // governance 정책은 재확인이 바꾸지 않는다. 바뀌면 등록 단계처럼 사람 경로로 보낸다.
    const claimed = sortCodepoint(new Set(evidence.steps.flatMap((step) => step.paths)));
    const outside = claimed.filter((entry) => !isSourceReverificationAllowedPath(entry) || entry === GOVERNANCE_PATH);
    if (outside.length > 0) return `원천 재확인이 자동 병합 대상으로 허용하지 않는 경로: ${outside.slice(0, 8).join(", ")}`;
    // 파일 status(#987 N2): snapshot 파일은 새 파일(added)만, 원장·inventory는 제자리 수정(modified)만 허용한다. 이미 있는 snapshot의 수정·삭제·이름 변경은 불변 계약 위반이다.
    for (const entry of files) {
      const inPlace = SOURCE_REVERIFICATION_REGISTRATION_OUTPUTS.includes(entry.filename);
      const expected = inPlace ? "modified" : "added";
      if (entry.status !== expected) return `${entry.filename}의 변경 종류(${String(entry.status)})가 ${expected}가 아니다${inPlace ? "" : " (기존 snapshot 파일은 불변이다)"}`;
    }
    return sameJson(changed, claimed) ? null : describeSetDifference(changed, claimed);
  }
  // 후보 갱신: 증거가 주장한 경로가 후보 갱신 도구의 출력 목록 안이어야 하고 API diff가 그 경로와 정확히 같아야 한다(#986 F4).
  const outputs = sortCodepoint(NATIONWIDE_CANDIDATE_REFRESH_OUTPUTS);
  const claimed = evidence.candidate.paths;
  const outside = claimed.filter((entry) => !outputs.includes(entry));
  if (outside.length > 0) return `증거가 후보 갱신 출력 목록 밖 경로를 주장한다: ${outside.slice(0, 8).join(", ")}`;
  return sameJson(changed, sortCodepoint(claimed)) ? null : describeSetDifference(changed, sortCodepoint(claimed));
}

function latestRun(checkRuns, name, appId = null) {
  const runs = checkRuns
    .filter((item) => isObject(item) && item.name === name && (appId === null || item.app?.id === appId))
    .sort((left, right) => (String(left.started_at ?? "") < String(right.started_at ?? "") ? -1 : String(left.started_at ?? "") > String(right.started_at ?? "") ? 1 : (left.id ?? 0) - (right.id ?? 0)));
  return runs.at(-1) ?? null;
}

function runState(item) {
  if (item === null) return "없음";
  if (item.status !== "completed" || item.conclusion === null || item.conclusion === undefined) return "진행 중";
  return item.conclusion === "success" ? "success" : item.conclusion;
}

function commitViolation(commits, compare) {
  if (commits.length === 0) return "PR에 커밋이 없다";
  if (commits.length >= COMMIT_LIMIT) return `PR 커밋 목록이 API 상한(${COMMIT_LIMIT})에 닿아 전체를 알 수 없다`;
  if (compare.ahead_by !== commits.length) return `compare의 커밋 수(${compare.ahead_by})가 PR 커밋 목록(${commits.length})과 다르다`;
  for (const entry of commits) {
    const sha = typeof entry?.sha === "string" ? entry.sha.slice(0, 12) : "?";
    if (!isObject(entry) || !trustedCommitIdentity(entry.author)) return `커밋 ${sha}의 작성자가 App 또는 github-actions가 아니다`;
    if (!trustedCommitIdentity(entry.committer)) return `커밋 ${sha}의 커미터가 App 또는 github-actions가 아니다`;
    // App 신원은 GitHub 서명이 검증된 커밋만 인정한다. App 토큰으로 API를 통해 만든 커밋은 서명되므로 noreply 주소만 흉내 낸 커밋은 걸러진다.
    if ((sameIdentity(entry.author, AUTOMATION_PR_APP) || sameIdentity(entry.committer, AUTOMATION_PR_APP)) && entry.commit?.verification?.verified !== true) {
      return `커밋 ${sha}가 App 신원인데 GitHub 서명(verification.verified)이 검증되지 않았다`;
    }
    if (!Array.isArray(entry.parents) || entry.parents.length !== 1) return `커밋 ${sha}가 merge 커밋이거나 부모를 알 수 없다`;
  }
  return null;
}

/**
 * 한 PR의 모든 입력을 대조한다. 예외를 던지지 않는다. 모양이 다른 입력도 위반으로 돌려 막는다.
 * @returns {{ applicable: boolean, eligible: boolean, stage: string|null, headSha: string|null, violations: { code: string, detail: string }[] }}
 */
export function evaluateAutomationPullRequest(input) {
  const violations = [];
  const violate = (code, detail) => violations.push({ code, detail });
  const { repository, pull, commits, files, compare, checkRuns, requiredContexts, workflowRun, ciEvidence } = isObject(input) ? input : {};
  const ref = pull?.head?.ref;
  const headSha = pull?.head?.sha;
  if (!isObject(pull) || typeof ref !== "string" || typeof headSha !== "string") {
    return { applicable: true, eligible: false, stage: null, headSha: null, violations: [{ code: "INPUT", detail: "PR 객체의 모양이 다르다" }] };
  }
  const branchStage = automationStageForBranch(ref);
  if (branchStage === null) return { applicable: false, eligible: false, stage: null, headSha, violations: [] };

  if (!COMMIT.test(headSha)) violate("INPUT", "PR head sha 형식이 다르다");
  if (pull.state !== "open" || pull.merged === true) violate("STATE", "PR이 열려 있지 않다");
  if (pull.base?.ref !== MAIN) violate("STATE", `base가 ${MAIN}이 아니다`);
  if (pull.head?.repo?.full_name !== repository || pull.base?.repo?.full_name !== repository) violate("STATE", "head가 이 저장소의 브랜치가 아니다");
  if (!sameIdentity(pull.user, AUTOMATION_PR_APP)) violate("AUTHOR", `PR 작성자가 ${AUTOMATION_PR_APP.login}(id ${AUTOMATION_PR_APP.id})가 아니다`);

  let evidence = null;
  try {
    evidence = parseAutomationPrEvidence(pull.body, { headSha });
  } catch (error) {
    const text = message(error);
    violate(text.startsWith("AUTOMATION_PR_EVIDENCE_HEAD_MISMATCH") ? "HEAD_MISMATCH" : "EVIDENCE", text);
  }

  if (evidence !== null) {
    // CI가 게이트를 재계산할 때 본 증거 블록과 지금 본문의 블록이 같아야 한다(#986 F3). CI 뒤 본문 편집으로 단계·경로 주장을 바꾸지 못한다.
    const keys = isObject(ciEvidence) ? sortCodepoint(Object.keys(ciEvidence)) : [];
    if (!isObject(ciEvidence) || keys.join(",") !== "evidenceSha256,headSha,schemaVersion,stage" || ciEvidence.schemaVersion !== 1
      || ciEvidence.headSha !== headSha || ciEvidence.stage !== evidence.stage
      || typeof ciEvidence.evidenceSha256 !== "string" || ciEvidence.evidenceSha256 !== automationEvidenceDigest(pull.body)) {
      violate("DIGEST", "CI가 기록한 증거 블록 digest가 현재 본문의 블록과 다르다");
    }
  }

  const arrays = [["commits", commits], ["files", files], ["checkRuns", checkRuns]].filter(([, value]) => !Array.isArray(value));
  for (const [name] of arrays) violate("INPUT", `${name} 입력이 배열이 아니다`);
  if (!isObject(compare)) violate("INPUT", "compare 입력이 객체가 아니다");

  if (evidence !== null) {
    if (evidence.stage !== branchStage) violate("BRANCH", `증거 단계(${evidence.stage})와 브랜치 접두사의 단계(${branchStage})가 다르다`);
    if (isObject(compare)) {
      if (compare.merge_base_commit?.sha !== evidence.baseSha) violate("BASE", `증거의 base sha(${evidence.baseSha.slice(0, 12)})가 실제 분기점과 다르다`);
    }
    if (Array.isArray(files)) {
      const reason = pathViolation(evidence, files);
      if (reason !== null) violate("PATHS", reason);
    }
  }

  if (isObject(compare)) {
    if (compare.behind_by !== 0 || compare.status !== "ahead") violate("BEHIND", `PR이 ${MAIN}보다 뒤처졌거나 갈라졌다(status ${String(compare.status)}, behind_by ${String(compare.behind_by)})`);
    if (Array.isArray(commits)) {
      const reason = commitViolation(commits, compare);
      if (reason !== null) violate("COMMITS", reason);
    }
  } else if (Array.isArray(commits) && commits.length === 0) {
    violate("COMMITS", "PR에 커밋이 없다");
  }

  if (!isObject(workflowRun) || workflowRun.conclusion !== "success" || workflowRun.headSha !== headSha) {
    violate("CI", `CI workflow가 이 head에서 성공으로 끝나지 않았다(${String(workflowRun?.conclusion)})`);
  }
  if (Array.isArray(checkRuns)) {
    if (!Array.isArray(requiredContexts) || requiredContexts.length === 0) {
      violate("CI", "required context 목록을 알 수 없다");
    } else {
      for (const required of requiredContexts) {
        const state = runState(latestRun(checkRuns, required?.context, required?.integration_id ?? null));
        if (state !== "success") violate("CI", `required context ${String(required?.context)}가 성공이 아니다(${state})`);
      }
    }
    const gates = runState(latestRun(checkRuns, AUTOMATION_PR_GATES_CONTEXT, GITHUB_ACTIONS_APP_ID));
    if (gates !== "success") violate("GATES", `${AUTOMATION_PR_GATES_CONTEXT} check가 github-actions의 성공이 아니다(${gates})`);
  }

  return { applicable: true, eligible: violations.length === 0, stage: evidence?.stage ?? branchStage, headSha, violations };
}

// ---------------------------------------------------------------------------
// 게이트 재계산: CI(pull_request, 읽기 전용 토큰)가 PR head 작업 트리에서 한다.
// ---------------------------------------------------------------------------
function treeAndBaseFiles(repositoryRoot) {
  return {
    readTree: (relative) => readFile(path.join(repositoryRoot, relative), "utf8"),
    readBase: async (sha, relative) => (await execFileAsync(GIT, ["show", `${sha}:${relative}`], { cwd: repositoryRoot, maxBuffer: 512 * 1024 * 1024 })).stdout,
  };
}

/**
 * 원장 게이트와 ITX 승격 게이트를 PR head에서 다시 계산하고 증거 블록과 대조한다. 블록의 PASS 주장을 믿지 않는다.
 * @returns {Promise<{ violations: { code: string, detail: string }[] }>}
 */
export async function recomputeAutomationGates({
  evidence,
  repositoryRoot,
  files = treeAndBaseFiles(repositoryRoot),
  verifyItx = verifyItxGatePromotion,
  readCandidateState = readNationwideCandidateRefreshState,
  candidateViolations = nationwideCandidateRefreshViolations,
}) {
  const violations = [];
  const violate = (code, detail) => violations.push({ code, detail });

  if (isRefreshStage(evidence.stage)) {
    // 정기 갱신 4종(#1012): 원장 방식·소유 inventory 범위·증거 결속은 단계 계약(evaluateRefreshStage)이 base·head 두 판본에서 다시 계산한다.
    // 증거 블록의 정책·원천 행은 색인일 뿐이고 재계산한 값과 같아야 한다. emitter(refresh-automation-pr)가 PR을 열기 전에 같은 함수를 부른다.
    try {
      const policy = parseLedgerChangePolicy(JSON.parse(await files.readTree(LEDGER_POLICY_PATH)));
      if (!sameJson(policy, evidence.policy)) violate("EVIDENCE_DRIFT", "증거 블록의 정책이 커밋된 원장 변화 정책과 다르다");
      const result = await evaluateRefreshStage({ stage: evidence.stage, paths: evidence.steps[0].paths, baseSha: evidence.baseSha, policy, files });
      for (const item of result.violations) violate(item.code, item.detail);
      if (!sameJson(result.rows, evidence.sources)) violate("EVIDENCE_DRIFT", "증거 블록의 원천 행이 base·head에서 다시 계산한 변화와 다르다");
    } catch (error) {
      violate("LEDGER_GATE", message(error));
    }
    return { violations };
  }

  let policy = null;
  let sources = null;
  try {
    policy = parseLedgerChangePolicy(JSON.parse(await files.readTree(LEDGER_POLICY_PATH)));
    const baseLedger = JSON.parse(await files.readBase(evidence.baseSha, LEDGER_PATH));
    const headLedger = JSON.parse(await files.readTree(LEDGER_PATH));
    const result = evaluateLedgerChange({ baseLedger, headLedger, policy });
    for (const item of result.violations) violate("LEDGER_GATE", `${item.code}: ${item.sourceId} ${item.snapshotId}: ${item.detail}`);
    sources = result.sources;
  } catch (error) {
    violate("LEDGER_GATE", message(error));
  }

  if (sources !== null) {
    if (evidence.stage === "registration" || evidence.stage === "derivative-rebinding") {
      if (!sameJson(sources, evidence.sources)) violate("EVIDENCE_DRIFT", "증거 블록의 원천 행이 원장에서 다시 계산한 변화와 다르다");
      if (!sameJson(policy, evidence.policy)) violate("EVIDENCE_DRIFT", "증거 블록의 정책이 커밋된 원장 변화 정책과 다르다");
    } else if (evidence.stage !== "source-reverification" && sources.length > 0) {
      violate("EVIDENCE_DRIFT", `${evidence.stage} 단계는 원장 행을 바꾸지 않는데 새 행이 ${sources.length}개 있다`);
    }
  }

  if (evidence.stage === "source-reverification" && sources !== null) {
    // 원천 재확인(#987 F6): 원장 행은 위에서 다시 계산한 값이고, 원장 행이 없는 KRIC projection 증거 행은 inventory 두 판본에서 다시 계산한다.
    // inventory는 원천 항목을 더하거나 지울 수 없고 최상위 필드도 그대로여야 한다. 항목 내용의 정합은 required CI의 inventory 검증이 본다.
    try {
      const base = JSON.parse(await files.readBase(evidence.baseSha, INVENTORY_PATH));
      const head = JSON.parse(await files.readTree(INVENTORY_PATH));
      if (!Array.isArray(base?.sources) || !Array.isArray(head?.sources)) throw new Error("inventory sources must be an array");
      const { sources: baseSources, ...baseTop } = base;
      const { sources: headSources, ...headTop } = head;
      if (!sameJson(baseTop, headTop)) throw new Error("inventory top-level fields changed");
      // 항목 범위(#987 N1): 이 PR의 recipe가 소유하지 않은 항목은 깊은 비교로 같아야 하고, 소유 항목도 recipe가 명시한 갱신 필드만 바뀐다.
      const outside = inventoryChangeViolations({ base, head, recipeIds: evidence.steps.map(({ id }) => id) });
      if (outside.length > 0) throw new Error(`inventory changed outside the recipes' scope: ${outside.slice(0, 6).join(" | ")}`);
      const rows = [];
      for (const step of evidence.steps) {
        const due = REVERIFICATION_RECIPES.find(({ id }) => id === step.id)?.due;
        if (due?.kind !== "inventory-evidence") continue;
        const find = (list) => list.find((entry) => entry?.id === due.sourceId);
        for (const key of due.evidenceKeys) {
          const result = evaluateEvidenceChange({ sourceId: due.sourceId, before: find(baseSources)?.[key] ?? null, after: find(headSources)?.[key] ?? null, policy });
          for (const item of result.violations) violate("INVENTORY_GATE", `${item.code}: ${item.sourceId} ${item.snapshotId}: ${item.detail}`);
          if (result.row) rows.push(result.row);
        }
      }
      if (!sameJson([...sources, ...rows], evidence.sources)) violate("EVIDENCE_DRIFT", "증거 블록의 원천 행이 원장·inventory 증거에서 다시 계산한 변화와 다르다");
      if (!sameJson(policy, evidence.policy)) violate("EVIDENCE_DRIFT", "증거 블록의 정책이 커밋된 원장 변화 정책과 다르다");
    } catch (error) {
      violate("INVENTORY_GATE", message(error));
    }
  }

  if (evidence.stage === "registration") {
    // 원장 밖 파일의 범위 재계산(#986 F6, #989): inventory는 등록한 원천 항목의 갱신 필드만 바뀔 수 있고(원천 재확인 #987 N1과 같은 규칙) 그 밖의 항목·최상위 필드는 그대로여야 한다.
    // 항목 내용의 정합은 required CI의 inventory 검증이 본다.
    try {
      const base = JSON.parse(await files.readBase(evidence.baseSha, INVENTORY_PATH));
      const head = JSON.parse(await files.readTree(INVENTORY_PATH));
      if (!Array.isArray(base?.sources) || !Array.isArray(head?.sources)) throw new Error("inventory sources must be an array");
      const topLevel = (inventory) => Object.fromEntries(Object.entries(inventory).filter(([key]) => key !== "sources"));
      if (!sameJson(topLevel(base), topLevel(head))) throw new Error("inventory top-level fields changed");
      const allowed = new Map(evidence.sources.map(({ sourceId }) => [sourceId, new Set(REGISTRATION_INVENTORY_FIELDS[sourceId] ?? [])]));
      const outside = inventoryScopeViolations({ base, head, allowed });
      if (outside.length > 0) throw new Error(`inventory changed outside the registered sources' scope: ${outside.slice(0, 6).join(" | ")}`);
      for (const { sourceId } of evidence.sources) {
        const count = head.sources.filter((entry) => entry?.id === sourceId).length;
        if (count !== 1) throw new Error(`inventory must have exactly one entry for ${sourceId} (found ${count})`);
      }
    } catch (error) {
      violate("INVENTORY_GATE", message(error));
    }
  }

  if (evidence.stage === "itx-promotion") {
    let row = null;
    try {
      const reference = JSON.parse(await files.readTree(ITX_CONTRACT_PATH))?.sourceTimetableArtifact;
      const expected = evidence.sources[0];
      if (reference?.artifactId !== expected.snapshotId) throw new Error(`coverage contract의 승격 원천(${String(reference?.artifactId)})이 증거의 snapshot(${expected.snapshotId})과 다르다`);
      if (reference.promotion?.mode !== ITX_PROMOTION_MODE_GATE_PASSED) throw new Error(`승격 근거가 게이트 모드(${ITX_PROMOTION_MODE_GATE_PASSED})가 아니다`);
      await verifyItx({ reference, repositoryRoot });
      row = itxPromotionSourceRow(JSON.parse(await files.readTree(itxPromotionReceiptPath(reference.artifactId))));
    } catch (error) {
      violate("ITX_GATE", message(error));
    }
    if (row !== null && !sameJson(row, evidence.sources[0])) violate("EVIDENCE_DRIFT", "증거 블록의 ITX 원천 행이 커밋된 게이트 영수증과 다르다");
  }

  if (evidence.stage === "candidate-refresh") {
    let state = null;
    try {
      state = await readCandidateState(repositoryRoot);
      // 결속 검증기에 넘기는 기대값은 검증 대상 파일(release request) 자신에서 가져오지 않는다(#986 F4).
      //  - 후보 시계: build spec의 publishedAt. 검증기가 fan-in의 시계와 대조한다.
      //  - 요청·승인 역할: 정기 후보 갱신의 고정 역할 쌍. 사람 역할(dispatch)의 후보는 자동 병합 대상이 아니다.
      //  - gateRun: 이 증거 블록을 만든 run과 그 run이 본 main 커밋(증거의 base). release request의 gateRun 나머지 필드(반복·이벤트 등)는 형식만 본다.
      const runId = Number(/\/actions\/runs\/([1-9][0-9]*)$/u.exec(evidence.runUrl)?.[1]);
      const recorded = state.releaseRequest?.gateRun;
      const expectedGateRun = { ...(isObject(recorded) ? recorded : {}), runId, headSha: evidence.baseSha };
      const problems = [
        ...gateRunViolations(recorded),
        ...(isObject(recorded) && recorded.runId !== runId ? [`gateRun runId ${String(recorded.runId)} is not the evidence run ${runId}`] : []),
        ...(isObject(recorded) && recorded.headSha !== evidence.baseSha ? [`gateRun headSha ${String(recorded.headSha)} is not the evidence base ${evidence.baseSha}`] : []),
        ...candidateViolations({
          ...state,
          evaluatedAt: state.buildSpec?.publishedAt,
          requestedBy: SCHEDULED_RELEASE_ROLES.requestedBy,
          approvedBy: SCHEDULED_RELEASE_ROLES.approvedBy,
          gateRun: expectedGateRun,
        }),
      ];
      if (problems.length > 0) throw new Error(problems.join("; "));
    } catch (error) {
      violate("CANDIDATE_GATE", message(error));
      state = null;
    }
    if (state !== null) {
      const { candidateId, releaseSequence, sourceSnapshotSetHash } = state.buildSpec ?? {};
      const { candidateId: claimedId, releaseSequence: claimedSequence, sourceSnapshotSetHash: claimedHash } = evidence.candidate;
      if (!sameJson({ candidateId, releaseSequence, sourceSnapshotSetHash }, { candidateId: claimedId, releaseSequence: claimedSequence, sourceSnapshotSetHash: claimedHash })) violate("EVIDENCE_DRIFT", "증거 블록의 후보 식별이 커밋된 후보 build spec과 다르다");
    }
  }
  return { violations };
}

// ---------------------------------------------------------------------------
// 라벨러의 판정: PR 데이터는 API로만 읽는다.
// ---------------------------------------------------------------------------
export async function readPages(api, endpoint, { limit, pick = (body) => body, overflow = "throw" }) {
  const items = [];
  const separator = endpoint.includes("?") ? "&" : "?";
  for (let page = 1; page <= limit; page += 1) {
    const list = pick(await api(`${endpoint}${separator}per_page=100&page=${page}`));
    if (!Array.isArray(list)) throw inputError(`${endpoint} 응답이 배열이 아니다`);
    items.push(...list);
    if (list.length < 100) return items;
  }
  if (overflow === "throw") throw inputError(`${endpoint}가 ${limit}페이지를 넘는다`);
  return items;
}

function requiredContextsOf(rules) {
  if (!Array.isArray(rules)) throw inputError("ruleset 응답이 배열이 아니다");
  return rules
    .filter((rule) => rule?.type === "required_status_checks")
    .flatMap((rule) => rule.parameters?.required_status_checks ?? [])
    .map((item) => ({ context: item?.context, integration_id: item?.integration_id ?? null }));
}

export const EVIDENCE_ARTIFACT_NAME = "automation-pr-evidence";
export const EVIDENCE_ARTIFACT_MEMBER = "evidence-digest.json";

/** 게이트 재계산 job이 본 증거 블록의 digest 기록(artifact 본문). */
export async function writeEvidenceDigest({ file, pull, evidence }) {
  await writeFile(file, `${JSON.stringify({ schemaVersion: 1, headSha: pull.head.sha, stage: evidence.stage, evidenceSha256: automationEvidenceDigest(pull.body) })}\n`);
}

/** 이 CI run의 digest artifact를 읽는다. 없거나 만료됐거나 둘 이상이면 판정하지 않고 막는다. */
async function readCiEvidence({ api, repository, runId }) {
  const listing = await api(`repos/${repository}/actions/runs/${runId}/artifacts?name=${EVIDENCE_ARTIFACT_NAME}`);
  const live = (Array.isArray(listing?.artifacts) ? listing.artifacts : []).filter((item) => item?.name === EVIDENCE_ARTIFACT_NAME && item.expired === false);
  if (live.length !== 1 || !Number.isSafeInteger(live[0].id)) throw new Error(`AUTOMATION_PR_DIGEST: CI run ${runId}의 ${EVIDENCE_ARTIFACT_NAME} artifact가 정확히 하나(만료 전)가 아니다`);
  return api(`repos/${repository}/actions/artifacts/${live[0].id}/zip#${EVIDENCE_ARTIFACT_MEMBER}`);
}

/**
 * 라벨러가 CI 완료 뒤 부른다. 정책 대상이 아니거나 head가 이미 바뀌었으면 아무것도 하지 않는 상태를 돌려주고,
 * 대상인데 어긋나면 위반 코드를 담은 예외로 끝난다(job 실패 -> #926 실패 보고).
 * @returns {Promise<{ state: "ELIGIBLE", pullRequest: number, headSha: string, stage: string, draft: boolean, labeled: boolean, attested: boolean } | { state: "NOT_APPLICABLE" | "STALE" }>}
 */
export async function decideAutomationPullRequest({ repository, headSha, runConclusion, runId, api }) {
  if (typeof repository !== "string" || !REPOSITORY_PATTERN.test(repository)) throw inputError("repository");
  if (typeof headSha !== "string" || !COMMIT.test(headSha)) throw inputError("head sha");
  if (typeof runConclusion !== "string" || runConclusion === "") throw inputError("run conclusion");
  if (!Number.isSafeInteger(runId) || runId < 1) throw inputError("run id");
  if (runConclusion === "cancelled" || runConclusion === "skipped") return { state: "STALE" };

  const associated = (await api(`repos/${repository}/commits/${headSha}/pulls`)).filter((item) => item?.state === "open" && item.base?.ref === MAIN);
  if (associated.length === 0) return { state: "NOT_APPLICABLE" };
  if (associated.length > 1) throw inputError(`head ${headSha.slice(0, 12)}를 가진 열린 PR이 둘 이상이다`);
  const number = associated[0].number;
  if (!Number.isSafeInteger(number) || number < 1) throw inputError("PR number");

  const pull = await api(`repos/${repository}/pulls/${number}`);
  if (pull?.head?.sha !== headSha) return { state: "STALE" };
  if (automationStageForBranch(pull.head.ref) === null) return { state: "NOT_APPLICABLE" };

  const commits = await readPages(api, `repos/${repository}/pulls/${number}/commits`, { limit: COMMIT_PAGES, overflow: "return" });
  const files = await readPages(api, `repos/${repository}/pulls/${number}/files`, { limit: FILE_PAGES, overflow: "return" });
  const compare = await api(`repos/${repository}/compare/${MAIN}...${headSha}?per_page=1`);
  const checkRuns = await readPages(api, `repos/${repository}/commits/${headSha}/check-runs`, { limit: 5, pick: (body) => body?.check_runs });
  const requiredContexts = requiredContextsOf(await api(`repos/${repository}/rules/branches/${MAIN}`));
  const comments = await readPages(api, `repos/${repository}/issues/${number}/comments`, { limit: 3 });

  const ciEvidence = await readCiEvidence({ api, repository, runId });

  const result = evaluateAutomationPullRequest({
    repository, pull, commits, files, compare, checkRuns, requiredContexts, workflowRun: { conclusion: runConclusion, headSha }, ciEvidence,
  });
  if (!result.applicable) return { state: "NOT_APPLICABLE" };
  // 뒤처진 것만이 위반이면 이상이 아니다. base 갱신은 head 결속을 깨므로 하지 않고, 닫고 다시 만드는 일은 automation-pr-behind-recreate.yml의 몫이다(#986 F2).
  if (!result.eligible && result.violations.every(({ code }) => code === "BEHIND")) return { state: "BEHIND" };
  if (!result.eligible) throw new Error(result.violations.map(({ code, detail }) => `AUTOMATION_PR_${code}: ${detail}`).join("\n"));
  const headCommittedAt = commits.find((entry) => entry?.sha === headSha)?.commit?.committer?.date;
  return {
    state: "ELIGIBLE",
    pullRequest: number,
    headSha,
    stage: result.stage,
    evidenceSha256: ciEvidence.evidenceSha256,
    draft: pull.draft === true,
    labeled: Array.isArray(pull.labels) && pull.labels.some((label) => label?.name === AUTOMATION_AUTOMERGE_LABEL),
    attested: comments.some((comment) => isValidAttestation(comment, headSha, ciEvidence.evidenceSha256, headCommittedAt)),
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
async function ghApi(endpoint) {
  const hash = endpoint.indexOf("#");
  if (hash !== -1) {
    // artifact zip 안의 파일 하나를 JSON으로 읽는다: <endpoint>#<member>
    const member = endpoint.slice(hash + 1);
    if (member !== EVIDENCE_ARTIFACT_MEMBER) throw inputError(`artifact member ${member}`);
    const { stdout: bytes } = await execFileAsync("gh", ["api", endpoint.slice(0, hash)], { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 });
    const dir = await mkdtemp(path.join(os.tmpdir(), "automation-pr-artifact-"));
    try {
      const zip = path.join(dir, "artifact.zip");
      await writeFile(zip, bytes);
      return JSON.parse((await execFileAsync("unzip", ["-p", zip, member], { maxBuffer: 1024 * 1024 })).stdout);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  const { stdout } = await execFileAsync("gh", ["api", "-H", "Accept: application/vnd.github+json", endpoint], { maxBuffer: 256 * 1024 * 1024 });
  return JSON.parse(stdout);
}

export function parseOptions(rest, allowed, optional = ["github-output", "digest-output"]) {
  const values = {};
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    if (!key?.startsWith("--") || !allowed.includes(key.slice(2)) || Object.hasOwn(values, key.slice(2)) || typeof rest[index + 1] !== "string") throw inputError(`argument ${String(key)}`);
    values[key.slice(2)] = rest[index + 1];
  }
  for (const key of allowed) {
    if (!optional.includes(key) && !Object.hasOwn(values, key)) throw inputError(`--${key} is required`);
  }
  return values;
}

const OUTPUT_VALUE = /^[A-Za-z0-9._/-]*$/u;
export function writeOutputs(file, outputs) {
  if (file === undefined) return;
  for (const [key, value] of Object.entries(outputs)) {
    const text = String(value);
    if (!/^[a-z0-9_]+$/u.test(key) || !OUTPUT_VALUE.test(text)) throw inputError(`output ${key}`);
    appendFileSync(file, `${key}=${text}\n`);
  }
}

async function readPull(file) {
  const pull = JSON.parse(await readFile(file, "utf8"));
  if (!isObject(pull) || typeof pull.head?.ref !== "string" || !COMMIT.test(pull.head?.sha ?? "")) throw inputError("pull request file");
  return pull;
}

export async function main(argv, { api = ghApi, log = (line) => process.stdout.write(`${line}\n`) } = {}) {
  const [command, ...rest] = argv;
  if (command === "prepare") {
    const values = parseOptions(rest, ["pull-request", "github-output"]);
    const pull = await readPull(values["pull-request"]);
    const stage = automationStageForBranch(pull.head.ref);
    if (stage === null) {
      writeOutputs(values["github-output"], { applicable: "false", base_sha: "" });
      log("자동화 PR 게이트 대상이 아니다.");
      return;
    }
    const evidence = parseAutomationPrEvidence(pull.body, { headSha: pull.head.sha });
    if (evidence.stage !== stage) throw new Error(`AUTOMATION_PR_BRANCH: 증거 단계(${evidence.stage})와 브랜치 접두사의 단계(${stage})가 다르다`);
    writeOutputs(values["github-output"], { applicable: "true", base_sha: evidence.baseSha });
    log(`자동화 PR 게이트 대상: ${stage}`);
  } else if (command === "gates") {
    const values = parseOptions(rest, ["pull-request", "repository-root", "digest-output"]);
    const pull = await readPull(values["pull-request"]);
    const evidence = parseAutomationPrEvidence(pull.body, { headSha: pull.head.sha });
    const head = (await execFileAsync(GIT, ["rev-parse", "HEAD"], { cwd: values["repository-root"] })).stdout.trim();
    if (head !== pull.head.sha) throw new Error(`AUTOMATION_PR_HEAD_MISMATCH: 작업 트리 head(${head})가 PR head(${pull.head.sha})와 다르다`);
    const { violations } = await recomputeAutomationGates({ evidence, repositoryRoot: path.resolve(values["repository-root"]) });
    if (violations.length > 0) throw new Error(violations.map(({ code, detail }) => `AUTOMATION_PR_${code}: ${detail}`).join("\n"));
    if (values["digest-output"] !== undefined) await writeEvidenceDigest({ file: values["digest-output"], pull, evidence });
    log(`자동화 PR 게이트 재계산 통과: ${evidence.stage}`);
  } else if (command === "decide") {
    const values = parseOptions(rest, ["repository", "head-sha", "run-conclusion", "run-id", "github-output"]);
    const decision = await decideAutomationPullRequest({ repository: values.repository, headSha: values["head-sha"], runConclusion: values["run-conclusion"], runId: Number(values["run-id"]), api });
    writeOutputs(values["github-output"], {
      state: decision.state,
      pull_request: decision.pullRequest ?? "",
      head_sha: decision.headSha ?? "",
      stage: decision.stage ?? "",
      evidence_sha256: decision.evidenceSha256 ?? "",
      draft: decision.draft ?? false,
      labeled: decision.labeled ?? false,
      attested: decision.attested ?? false,
    });
    log(`자동화 PR 판정: ${decision.state}${decision.pullRequest ? ` #${decision.pullRequest}` : ""}`);
  } else {
    throw inputError(`unknown command ${String(command)}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${message(error)}\n`);
    process.exitCode = 1;
  }
}
