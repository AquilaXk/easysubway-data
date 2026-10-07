#!/usr/bin/env node
// 자동화 PR의 기계 판독 증거 블록(#969, 2단계 자동 병합 정책의 입력 계약, 이슈 §7).
// PR 본문에 `<!-- easysubway-automation-pr:v1 {JSON} -->`를 정확히 하나 남긴다. 정책은 이 블록을 색인으로만 쓰고
// 변경 경로·원장·원천 sha는 diff에서 다시 계산해 대조한다. 본문은 PR 생성 뒤에도 고칠 수 있으므로 블록만 믿고 병합하지 않는다.
//
// - 블록은 알려진 키와 값만 받는다. 모르는 키·잘못된 이슈 번호·잘못된 값은 정규화하지 않고 파싱 오류로 실패한다(fail closed).
// - 블록은 base/head 커밋에 결속된다. 읽는 쪽이 PR head 커밋을 넘기면 블록의 headSha와 같아야 한다.
// - 단계(stage)별 필수 내용: registration은 원천 행(sources)과 정책, derivative-rebinding은 단계(steps)와 정책, candidate-refresh는 후보 식별(candidate).
//   itx-promotion(#977)은 ITX 원천 행 하나(raw capture sha·후보 sha·직전 snapshot)와 변경 경로 단계 하나이고 정책·후보 식별이 없다.
//   변경 경로는 coverage contract와 그 snapshot의 원천·완전성 증거·게이트 영수증 네 개뿐이어야 한다(2단계 allowlist).
//   source-reverification(#984)은 정책·원천 행(원장 게이트 + 증거 게이트)·recipe 단계를 담는다. 단계 id는 알려진 recipe뿐이고,
//   변경 경로는 등록 결과 세 파일(신선도 정책 제외)과 새 원천 snapshot 파일뿐이어야 한다(경로 계약은 source-reverification-paths.mjs 하나).
//   정기 갱신 4종(#1012: gwangju-timetable-refresh·capital-topology-refresh·kric-facility-refresh·seoul-accessibility-refresh)은 정책·원천 행·증거 step 하나(정확한 경로 allowlist)를 담는다.
//   단계별 경로 규칙·원천 행의 원천 집합은 refresh-stage-contracts.mjs 하나가 정본이고, 이 파일은 그 계약으로 블록을 검증한다.
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { parseLedgerChangePolicy } from "./source-ledger-gate.mjs";
import { REFRESH_STAGES, REFRESH_STAGE_IDS, isRefreshStage, refreshPathShapeViolation } from "./refresh-stage-contracts.mjs";
import { SOURCE_REVERIFICATION_RECIPE_IDS, isSourceReverificationAllowedPath } from "./source-reverification-paths.mjs";

export const AUTOMATION_PR_EVIDENCE_MARKER = "easysubway-automation-pr:v1";
export const AUTOMATION_PR_STAGES = Object.freeze(["registration", "candidate-refresh", "derivative-rebinding", "itx-promotion", "source-reverification", ...REFRESH_STAGE_IDS]);
const ISSUE = 969;
const BLOCK = new RegExp(`<!-- ${AUTOMATION_PR_EVIDENCE_MARKER} (.*?) -->`, "gu");
const RUN_URL = /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/actions\/runs\/[1-9][0-9]*$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const EVIDENCE_KEYS = Object.freeze(["schemaVersion", "stage", "issue", "runUrl", "baseSha", "headSha", "policy", "sources", "steps", "candidate"]);
const SOURCE_KEYS = Object.freeze(["sourceId", "snapshotId", "previousSnapshotId", "rawSha256", "contentSha256", "rowDelta", "coverageDelta", "diffStatus"]);
const STEP_KEYS = Object.freeze(["id", "changed", "paths"]);
const CANDIDATE_KEYS = Object.freeze(["candidateId", "releaseSequence", "sourceSnapshotSetHash", "paths"]);

function fail(code, detail = "") {
  throw new Error(detail ? `${code}: ${detail}` : code);
}
const invalid = (detail) => fail("AUTOMATION_PR_EVIDENCE_INVALID", detail);
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const hasExactKeys = (value, keys) => isObject(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const text = (value) => typeof value === "string" && value !== "";

function validateSource(source) {
  if (!hasExactKeys(source, SOURCE_KEYS) || !text(source.sourceId) || !text(source.snapshotId)
    || !(source.previousSnapshotId === null || text(source.previousSnapshotId))
    || !SHA256.test(source.rawSha256) || !SHA256.test(source.contentSha256)
    || !Number.isSafeInteger(source.rowDelta) || !Number.isSafeInteger(source.coverageDelta) || !text(source.diffStatus)) invalid("source row");
}

function validateStep(step) {
  if (!hasExactKeys(step, STEP_KEYS) || !text(step.id) || typeof step.changed !== "boolean" || !Array.isArray(step.paths)
    || step.paths.some((entry) => !text(entry)) || step.changed !== (step.paths.length > 0)) invalid(`step ${String(step?.id)}`);
}

function validateCandidate(candidate) {
  if (!hasExactKeys(candidate, CANDIDATE_KEYS) || !text(candidate.candidateId) || !Number.isSafeInteger(candidate.releaseSequence)
    || candidate.releaseSequence < 1 || !SHA256.test(candidate.sourceSnapshotSetHash)
    || !Array.isArray(candidate.paths) || candidate.paths.length === 0 || candidate.paths.some((entry) => !text(entry))
    || candidate.paths.some((entry, index) => index > 0 && !(candidate.paths[index - 1] < entry))) invalid("candidate");
}

const ITX_SOURCE_ID = "itx-cheongchun-source-timetable";
const ITX_SNAPSHOT_ID = /^itx-cheongchun-source-timetable-\d{17}$/u;
const ITX_STEP_ID = "itx-promotion";
const ITX_CONTRACT_PATH = "tools/datapack/itx-cheongchun-coverage-contract.json";
const ITX_GATE_POLICY_ID = "itx-promotion-gate-v1";

const ITX_TOPOLOGY_EVIDENCE_PATH = "tools/datapack/itx-cheongchun-topology-evidence.json";
const ITX_ALIGNMENT_FIXTURE_PATHS = Object.freeze(["busan", "daegu", "daejeon", "gwangju", "seoul"].map((name) => `tools/route-map/route-map-defs/${name}-alignment-fixture.json`));

/**
 * ITX 승격 PR이 바꿔도 되는 경로(#977 + #979 파생 재결속): coverage contract와 승격한 snapshot의 파일 셋(4),
 * 같은 job의 재결속이 만드는 topology 증거(현재·버전 별)·5권역 alignment fixture(7). 후보 pin은 병합 뒤 전국 후보 준비가 묶는다. 코드 상수 하나다.
 */
export function itxPromotionAllowedPaths(snapshotId) {
  const stamp = ITX_SNAPSHOT_ID.exec(snapshotId)?.[0].slice(`${ITX_SOURCE_ID}-`.length);
  if (stamp === undefined) invalid("itx-promotion: snapshot id");
  return [
    ITX_CONTRACT_PATH,
    `tools/datapack/sources/${snapshotId}-completeness-evidence.json`,
    `tools/datapack/sources/${snapshotId}-promotion-gate.json`,
    `tools/datapack/sources/${snapshotId}.json`,
    ITX_TOPOLOGY_EVIDENCE_PATH,
    `tools/datapack/itx-cheongchun-topology-evidence-${stamp}.json`,
    ...ITX_ALIGNMENT_FIXTURE_PATHS,
  ].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

function validateItxPromotion(source, step) {
  if (source.sourceId !== ITX_SOURCE_ID || !ITX_SNAPSHOT_ID.test(source.snapshotId) || !ITX_SNAPSHOT_ID.test(source.previousSnapshotId ?? "")
    || source.previousSnapshotId === source.snapshotId || source.diffStatus !== "PASS") invalid("itx-promotion: source row");
  if (step.id !== ITX_STEP_ID || step.changed !== true || JSON.stringify(step.paths) !== JSON.stringify(itxPromotionAllowedPaths(source.snapshotId))) {
    invalid("itx-promotion: changed paths are not the allowed set");
  }
}

function validateSourceReverification(steps) {
  const seen = new Set();
  for (const step of steps) {
    if (!SOURCE_REVERIFICATION_RECIPE_IDS.includes(step.id) || seen.has(step.id) || step.changed !== true
      || step.paths.some((relative) => !isSourceReverificationAllowedPath(relative))) invalid(`source-reverification: step ${String(step.id)}`);
    seen.add(step.id);
  }
}

/** 정기 갱신 4종(#1012): 정책·원천 행·증거 step 하나. step 경로는 단계 규칙과 정확히 맞고 정렬돼 있어야 하며 원천 행은 단계가 기대한 원천 집합과 같다. */
function validateRefreshStage(value) {
  const spec = REFRESH_STAGES[value.stage];
  const only = (condition, detail) => { if (!condition) invalid(`${value.stage}: ${detail}`); };
  only(value.policy !== null && value.candidate === null && value.sources.length > 0 && value.steps.length === 1, "needs a policy, source rows and exactly one step, no candidate");
  const [step] = value.steps;
  only(step.id === spec.stepId && step.changed === true, `the step must be ${spec.stepId} and changed`);
  only(step.paths.every((entry, index) => index === 0 || step.paths[index - 1] < entry), "paths must be sorted and unique");
  const shape = refreshPathShapeViolation(value.stage, step.paths);
  only(shape === null, `paths: ${String(shape)}`);
  only(JSON.stringify(value.sources.map(({ sourceId }) => sourceId)) === JSON.stringify(spec.expectedSourceIds), `source rows must be exactly ${spec.expectedSourceIds.join(", ")}`);
}

function validateEvidence(value) {
  if (!hasExactKeys(value, EVIDENCE_KEYS)) invalid("keys");
  if (value.schemaVersion !== 1 || value.issue !== ISSUE) invalid("schemaVersion or issue");
  if (!AUTOMATION_PR_STAGES.includes(value.stage)) invalid("stage");
  if (typeof value.runUrl !== "string" || !RUN_URL.test(value.runUrl)) invalid("run URL");
  if (typeof value.baseSha !== "string" || !COMMIT.test(value.baseSha) || typeof value.headSha !== "string" || !COMMIT.test(value.headSha)) invalid("commit");
  if (!Array.isArray(value.sources) || !Array.isArray(value.steps)) invalid("sources or steps");
  value.sources.forEach(validateSource);
  value.steps.forEach(validateStep);
  if (value.policy !== null) {
    try { parseLedgerChangePolicy(value.policy); } catch { invalid("policy"); }
  }
  if (value.candidate !== null) validateCandidate(value.candidate);
  const only = (condition, detail) => { if (!condition) invalid(`${value.stage}: ${detail}`); };
  if (value.stage === "registration") {
    only(value.policy !== null && value.sources.length > 0 && value.steps.length === 0 && value.candidate === null, "needs a policy and source rows, no steps or candidate");
  } else if (value.stage === "derivative-rebinding") {
    only(value.policy !== null && value.steps.length > 0 && value.candidate === null, "needs a policy and steps, no candidate");
  } else if (value.stage === "source-reverification") {
    only(value.policy !== null && value.sources.length > 0 && value.steps.length > 0 && value.candidate === null, "needs a policy, source rows and recipe steps, no candidate");
    validateSourceReverification(value.steps);
  } else if (isRefreshStage(value.stage)) {
    validateRefreshStage(value);
  } else if (value.stage === "itx-promotion") {
    only(value.policy === null && value.sources.length === 1 && value.steps.length === 1 && value.candidate === null, "needs one source row and one step, no policy or candidate");
    validateItxPromotion(value.sources[0], value.steps[0]);
  } else {
    only(value.candidate !== null && value.policy === null && value.sources.length === 0 && value.steps.length === 0, "needs only the candidate identity");
  }
  return value;
}

function evidenceValue({ stage, runUrl, baseSha, headSha, policy, sources, steps, candidate }) {
  return validateEvidence({ schemaVersion: 1, stage, issue: ISSUE, runUrl, baseSha, headSha, policy, sources, steps, candidate });
}

export function automationPrEvidenceBlock(input) {
  return `<!-- ${AUTOMATION_PR_EVIDENCE_MARKER} ${JSON.stringify(evidenceValue(input))} -->`;
}

/**
 * 본문의 증거 블록 JSON 페이로드 텍스트(마커와 공백 구분자 사이, 한 글자도 바꾸지 않은 원문). 블록이 정확히 하나가 아니면 null이다.
 * 2단계 자동 병합 정책(#985)이 CI가 본 블록과 라벨 시점의 블록이 같은지 sha256으로 대조할 때 쓴다.
 */
export function automationPrEvidencePayload(body) {
  const blocks = [...String(body ?? "").matchAll(BLOCK)];
  return blocks.length === 1 ? blocks[0][1] : null;
}

/** 블록이 없으면 null. 둘 이상이거나 형식이 어긋나면 실패한다. headSha를 넘기면 블록의 headSha와 같아야 한다(블록이 없으면 실패). */
export function parseAutomationPrEvidence(body, { headSha } = {}) {
  const blocks = [...String(body ?? "").matchAll(BLOCK)];
  if (blocks.length > 1) fail("AUTOMATION_PR_EVIDENCE_DUPLICATE");
  if (blocks.length === 0) {
    if (headSha !== undefined) fail("AUTOMATION_PR_EVIDENCE_MISSING");
    return null;
  }
  let value;
  try { value = JSON.parse(blocks[0][1]); } catch { invalid("not JSON"); }
  validateEvidence(value);
  if (headSha !== undefined && value.headSha !== headSha) fail("AUTOMATION_PR_EVIDENCE_HEAD_MISMATCH", `${value.headSha} is not ${headSha}`);
  return value;
}

const code = (value) => `\`${value}\``;

export function registrationPullRequestBody({ runUrl, baseSha, headSha, policy, sources }) {
  const block = automationPrEvidenceBlock({ stage: "registration", runUrl, baseSha, headSha, policy, sources, steps: [], candidate: null });
  return [
    "Register the protected current capital topology receipt.", "",
    "| 원천 | snapshot | 직전 snapshot | rowDelta | coverageDelta | diff |", "| --- | --- | --- | --- | --- | --- |",
    ...sources.map((source) => `| ${source.sourceId} | ${source.snapshotId} | ${source.previousSnapshotId ?? "-"} | ${source.rowDelta} | ${source.coverageDelta} | ${source.diffStatus} |`),
    "", `- 실행 run: ${runUrl}`, "", "Refs #456", "Refs #969", "", block, "",
  ].join("\n");
}

export function candidateRefreshEvidenceBlock({ runUrl, baseSha, headSha, candidate }) {
  return automationPrEvidenceBlock({ stage: "candidate-refresh", runUrl, baseSha, headSha, policy: null, sources: [], steps: [], candidate });
}

export function derivativeRebindingPullRequestBody({ runUrl, baseSha, headSha, policy, sources, steps }) {
  const block = automationPrEvidenceBlock({ stage: "derivative-rebinding", runUrl, baseSha, headSha, policy, sources, steps, candidate: null });
  return [
    "## Summary", "",
    "- 원천 등록·재확인 뒤 입력 결속이 바뀐 파생 산출물을 `run-derivative-rebinding`이 다시 만들었다.",
    "- 도구는 멱등이라 바뀐 단계만 커밋이 있다. 후보·hash·release request는 이 PR이 바꾸지 않는다(후보 갱신의 몫이다).",
    `- 실행 run: ${runUrl}`, "",
    "| 단계 | 결과 | 경로 |", "| --- | --- | --- |",
    ...steps.map((step) => `| ${step.id} | ${step.changed ? "갱신" : "변경 없음"} | ${step.changed ? step.paths.map(code).join(", ") : "-"} |`),
    "", "Refs #969", "Refs #870", "", block, "",
  ].join("\n");
}

export function sourceReverificationPullRequestBody({ runUrl, baseSha, headSha, policy, sources, steps }) {
  const block = automationPrEvidenceBlock({ stage: "source-reverification", runUrl, baseSha, headSha, policy, sources, steps, candidate: null });
  return [
    "## Summary", "",
    "- 만료가 가까운 P7D 원천을 `run-source-reverification`이 수집 → OCI 게시 → 원장 등록 순서로 다시 확인해 등록했다.",
    "- 원장·증거 변화는 `source-ledger-change-policy.json`의 정책(SOURCE_SHA_DRIFT·SOURCE_COUNT_DELTA)을 통과했다. 파생 재결속·후보 갱신은 이 PR이 바꾸지 않는다.",
    `- 실행 run: ${runUrl}`, "",
    "| recipe | 결과 | 경로 |", "| --- | --- | --- |",
    ...steps.map((step) => `| ${step.id} | ${step.changed ? "갱신" : "변경 없음"} | ${step.paths.map(code).join(", ") || "-"} |`), "",
    "| 원천 | snapshot | 직전 snapshot | rowDelta | coverageDelta | diff |", "| --- | --- | --- | --- | --- | --- |",
    ...sources.map((source) => `| ${source.sourceId} | ${source.snapshotId} | ${source.previousSnapshotId ?? "-"} | ${source.rowDelta} | ${source.coverageDelta} | ${source.diffStatus} |`),
    "", "Refs #984", "Refs #969", "Refs #870", "", block, "",
  ].join("\n");
}

/** 정기 갱신 4종의 증거 블록(#1012). 블록 생성 경로는 automationPrEvidenceBlock 하나이고 여기서는 단계의 step 하나만 채운다. */
export function refreshEvidenceBlock({ stage, runUrl, baseSha, headSha, policy, sources, paths }) {
  if (!isRefreshStage(stage)) invalid(`unknown refresh stage ${String(stage)}`);
  return automationPrEvidenceBlock({ stage, runUrl, baseSha, headSha, policy, sources, steps: [{ id: REFRESH_STAGES[stage].stepId, changed: true, paths }], candidate: null });
}

const oneLine = (label, value) => {
  if (typeof value !== "string" || value.trim() === "" || /[\r\n]/u.test(value) || value.includes(AUTOMATION_PR_EVIDENCE_MARKER)) invalid(`pull request ${label}`);
  return value;
};

/** 정기 갱신 4종의 PR 본문: 요약, 참조 이슈, 원천 표, 변경 경로 목록, 증거 블록 하나. summary·refs는 한 줄이고 증거 마커를 담을 수 없다. */
export function refreshPullRequestBody({ stage, runUrl, baseSha, headSha, policy, sources, paths, summary, refs }) {
  const block = refreshEvidenceBlock({ stage, runUrl, baseSha, headSha, policy, sources, paths });
  return [
    oneLine("summary", summary), "", oneLine("refs", refs), "",
    "| 원천 | snapshot | 직전 snapshot | rowDelta | coverageDelta | diff |", "| --- | --- | --- | --- | --- | --- |",
    ...sources.map((source) => `| ${source.sourceId} | ${source.snapshotId} | ${source.previousSnapshotId ?? "-"} | ${source.rowDelta} | ${source.coverageDelta} | ${source.diffStatus} |`),
    "", "## 변경 경로", "", ...paths.map((entry) => `- ${code(entry)}`), "",
    `- 실행 run: ${runUrl}`, `- 기준 커밋: ${code(baseSha)}`, "", "Refs #969", "Refs #870", "", block, "",
  ].join("\n");
}

const sumChecks = (checks, id, pick) => checks.filter((item) => item?.id === id).reduce((total, item) => total + pick(item.observed), 0);
const needInteger = (value) => { if (!Number.isSafeInteger(value)) invalid("itx-promotion: receipt metric"); return value; };

/** 게이트 영수증에서 ITX 원천 행을 만든다. PASS 영수증만 받고, 행의 sha는 영수증이 결속한 raw capture·후보 sha 그대로다. */
export function itxPromotionSourceRow(receipt) {
  if (!isObject(receipt) || receipt.artifactKind !== "itx-promotion-gate-receipt" || receipt.schemaVersion !== 1
    || receipt.policyId !== ITX_GATE_POLICY_ID || receipt.status !== "PASS"
    || !Array.isArray(receipt.blockedCheckIds) || receipt.blockedCheckIds.length !== 0 || !Array.isArray(receipt.checks)
    || !isObject(receipt.candidate) || !isObject(receipt.previous) || !isObject(receipt.source)) invalid("itx-promotion: receipt");
  const checks = receipt.checks;
  for (const id of ["STATION_COVERAGE", "OD_COVERAGE", "TUPLE_REMOVED", "TUPLE_ADDED"]) {
    if (!checks.some((item) => item?.id === id && item.status === "PASS")) invalid(`itx-promotion: receipt lacks ${id}`);
  }
  if (checks.some((item) => item?.status !== "PASS")) invalid("itx-promotion: receipt has a blocked check");
  const rowDelta = sumChecks(checks, "TUPLE_ADDED", (observed) => needInteger(observed.count)) - sumChecks(checks, "TUPLE_REMOVED", (observed) => needInteger(observed.count));
  const coverageDelta = ["STATION_COVERAGE", "OD_COVERAGE"].reduce((total, id) => total + sumChecks(checks, id, (observed) => needInteger(observed.added) + needInteger(observed.removed)), 0);
  const row = {
    sourceId: ITX_SOURCE_ID,
    snapshotId: receipt.candidate.artifactId,
    previousSnapshotId: receipt.previous.artifactId,
    rawSha256: receipt.source.rawCaptureSha256,
    contentSha256: receipt.candidate.sha256,
    rowDelta,
    coverageDelta,
    diffStatus: "PASS",
  };
  validateSource(row);
  validateItxPromotion(row, { id: ITX_STEP_ID, changed: true, paths: itxPromotionAllowedPaths(row.snapshotId) });
  return row;
}

const LIMIT_LABELS = Object.freeze([
  ["stationSetDelta", "역 집합 변화 한도", (value) => `${value}`],
  ["odSetDelta", "OD 집합 변화 한도", (value) => `${value}`],
  ["tripCountDeltaPermille", "편수 변화 한도(직전 대비)", (value) => `${value / 10}%`],
  ["tripMembershipDeltaPermille", "열차 구성 변화 한도(직전 대비)", (value) => `${value / 10}%`],
  ["stopPatternChangedTripsPermille", "정차 순서가 바뀐 열차 한도(직전 대비)", (value) => `${value / 10}%`],
  ["timetableTupleRemovedPermille", "정차 시각 제거 한도(직전 대비)", (value) => `${value / 10}%`],
  ["timetableTupleAddedPermille", "정차 시각 추가 한도(직전 대비)", (value) => `${value / 10}%`],
  ["firstDepartureShiftSeconds", "첫차 이동 한도", (value) => `${value}초`],
  ["lastDepartureShiftSeconds", "막차 이동 한도", (value) => `${value}초`],
  ["providerErrorRecords", "공급자 오류 응답 한도", (value) => `${value}건`],
]);

function metricCell(item) {
  const { observed, limit } = item;
  switch (item.id) {
    case "STATION_COVERAGE": case "OD_COVERAGE": return `+${observed.added} -${observed.removed} / ${limit.delta}`;
    case "TRIP_COUNT": return `${observed.delta} / ${limit.delta}`;
    case "TRIP_MEMBERSHIP": return `+${observed.added} -${observed.removed} / ${limit.each}`;
    case "STOP_PATTERN": return `${observed.changed} / ${limit.changed}`;
    case "TUPLE_REMOVED": case "TUPLE_ADDED": return `${observed.count} / ${limit.count}`;
    case "FIRST_DEPARTURE_SHIFT": case "LAST_DEPARTURE_SHIFT": return `${observed.shiftSeconds} / ${limit.shiftSeconds}`;
    default: return "-";
  }
}

export function itxPromotionPullRequestBody({ runUrl, baseSha, headSha, receipt, changedPaths }) {
  const source = itxPromotionSourceRow(receipt);
  const paths = [...changedPaths].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  const block = automationPrEvidenceBlock({
    stage: "itx-promotion", runUrl, baseSha, headSha, policy: null, sources: [source],
    steps: [{ id: ITX_STEP_ID, changed: true, paths }], candidate: null,
  });
  const basis = receipt.policy?.measuredBasis;
  return [
    `ITX-청춘 원천 시간표 ${code(source.snapshotId)}를 자동 이상 판정 게이트(${code(receipt.policyId)})가 통과시켜 승격한다. 승인 코멘트(${code("/approve-itx-current")})는 쓰지 않았다.`, "",
    "| 원천 | snapshot | 직전 snapshot | raw capture sha256 | 후보 sha256 | 시각 tuple 순증감 | 역·OD 변화 | 판정 |", "| --- | --- | --- | --- | --- | --- | --- | --- |",
    `| ${source.sourceId} | ${source.snapshotId} | ${source.previousSnapshotId} | ${code(source.rawSha256)} | ${code(source.contentSha256)} | ${source.rowDelta} | ${source.coverageDelta} | ${source.diffStatus} |`, "",
    ...(receipt.baseline ? [`누적 drift 기준선(마지막 owner 승인 원천): ${code(receipt.baseline.artifactId)}`, ""] : []),
    "## 적용한 한도", "",
    "| 항목 | 값 |", "| --- | --- |",
    ...LIMIT_LABELS.map(([key, label, format]) => `| ${label} | ${format(receipt.policy.limits[key])} |`), "",
    ...(basis ? [`측정 근거: 승인 이력 snapshot ${basis.snapshots}개, 전환 ${basis.transitions}회(안정 ${basis.stableTransitions}, 변동 ${basis.changedTransitions}). 역·OD·편수 변화 최대 0, 막차 이동 최대 ${basis.observedMax.lastDepartureShiftSeconds}초. 변동 구간의 0이 아닌 일별 변화는 정차 순서 ${basis.changedDayMinPermille.stopPatternChangedTrips}‰, 제거 ${basis.changedDayMinPermille.timetableTupleRemoved}‰, 추가 ${basis.changedDayMinPermille.timetableTupleAdded}‰ 이상이었다.`, ""] : []),
    "## 요일별 지표 (관측 / 한도)", "",
    "| 지표 | 요일 | 관측 / 한도 |", "| --- | --- | --- |",
    ...receipt.checks.filter((item) => item.dayCd !== undefined).map((item) => `| ${item.id} | ${item.dayCd} | ${metricCell(item)} |`), "",
    "## 변경 경로", "", ...paths.map((entry) => `- ${code(entry)}`), "",
    `- 실행 run: ${runUrl}`,
    "- 같은 run의 재결속이 topology 증거와 alignment fixture를 새 원천에 맞췄다. mobile fixture는 ITX 적용 전 입력 팩으로 고정돼 있어 바뀌지 않고, CI가 입력 팩에서 출력 팩을 파생해 증거와 대조한다.", "",
    "Refs #977", "Refs #979", "Refs #870", "Refs #969", "Refs #636", "", block, "",
  ].join("\n");
}

function parseOptions(rest) {
  const values = {};
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    if (!key?.startsWith("--") || Object.hasOwn(values, key.slice(2)) || typeof rest[index + 1] !== "string") fail("AUTOMATION_PR_EVIDENCE_ARGUMENTS");
    values[key.slice(2)] = rest[index + 1];
  }
  return values;
}

export async function main(argv, { write = (chunk) => process.stdout.write(chunk) } = {}) {
  const [command, ...rest] = argv;
  const values = parseOptions(rest);
  const need = (...keys) => { if (keys.some((key) => !Object.hasOwn(values, key))) fail("AUTOMATION_PR_EVIDENCE_ARGUMENTS"); };
  const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));
  const common = () => ({ runUrl: values["run-url"], baseSha: values["base-sha"], headSha: values["head-sha"] });
  if (command === "registration-body") {
    need("gate", "base-sha", "head-sha", "run-url", "output");
    const { policy, sources } = await readJson(values.gate);
    await writeFile(values.output, registrationPullRequestBody({ ...common(), policy, sources }), { flag: "wx" });
  } else if (command === "derivative-rebinding-body") {
    need("gate", "result", "base-sha", "head-sha", "run-url", "output");
    const { policy, sources } = await readJson(values.gate);
    const { steps } = await readJson(values.result);
    // controller 결과의 변경 없는 단계는 paths가 없다. 증거 블록은 항상 paths를 남긴다.
    await writeFile(values.output, derivativeRebindingPullRequestBody({ ...common(), policy, sources, steps: steps.map((step) => ({ ...step, paths: step.paths ?? [] })) }), { flag: "wx" });
  } else if (command === "source-reverification-body") {
    need("gate", "result", "base-sha", "head-sha", "run-url", "output");
    const { policy, sources } = await readJson(values.gate);
    const { steps, evidenceSources } = await readJson(values.result);
    if (!Array.isArray(steps) || !Array.isArray(evidenceSources)) invalid("source-reverification: the controller result lacks steps or evidenceSources");
    // 원장 행 증거(게이트)와 원장 행이 없는 증거(controller의 inventory 증거 게이트)를 한 표로 합친다.
    await writeFile(values.output, sourceReverificationPullRequestBody({ ...common(), policy, sources: [...sources, ...evidenceSources], steps: steps.map((step) => ({ ...step, paths: step.paths ?? [] })) }), { flag: "wx" });
  } else if (command === "itx-promotion-body") {
    need("receipt", "changed-paths", "base-sha", "head-sha", "run-url", "output");
    const receipt = await readJson(values.receipt);
    const changedPaths = (await readFile(values["changed-paths"], "utf8")).split("\n").filter(Boolean);
    await writeFile(values.output, itxPromotionPullRequestBody({ ...common(), receipt, changedPaths }), { flag: "wx" });
  } else if (command === "candidate-refresh-block") {
    need("build-spec", "changed-paths", "base-sha", "head-sha", "run-url");
    const { candidateId, releaseSequence, sourceSnapshotSetHash } = await readJson(values["build-spec"]);
    // 후보 PR이 바꾼 경로 전체(#986 F4). 2단계 정책이 API diff와 정확히 대조하고 후보 갱신 도구의 출력 목록 안인지 본다.
    const paths = [...new Set((await readFile(values["changed-paths"], "utf8")).split("\n").filter(Boolean))].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
    write(`${candidateRefreshEvidenceBlock({ ...common(), candidate: { candidateId, releaseSequence, sourceSnapshotSetHash, paths } })}\n`);
  } else {
    fail("AUTOMATION_PR_EVIDENCE_ARGUMENTS");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
