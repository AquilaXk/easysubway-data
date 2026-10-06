#!/usr/bin/env node
// ITX-청춘 원천 시간표 자동 승격 게이트(#977, #870 전체 자동화 3단계).
// 사람의 QA 승인 코멘트(/approve-itx-current) 없이 승격해도 되는지를 이상 판정으로 정한다.
//
// - 비교 단위는 기존 이상 판정 정책 itx-snapshot-anomaly-v1과 같다: 역·OD·열차·정차 순서·시각 tuple 집합, 요일 유형(dayCd)별.
//   v1은 어떤 변화든 막는다(ZERO_TOLERANCE). 이 게이트는 같은 집합을 한도가 있는 지표로 읽는다. 한도는 policy 파일에 있고
//   승인된 이력 snapshot 10개에서 잰 값이다(policy.measuredBasis, 테스트가 이력에서 다시 계산해 대조한다).
// - 판정은 순수 함수다. 영수증(receipt)을 믿지 않고 승격 도구가 같은 입력으로 다시 계산한다. 같은 입력은 같은 영수증이다.
// - 실패를 추정치·이전 값으로 덮지 않는다. 입력이 모자라면 PASS가 아니라 BLOCK 또는 오류다.
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { codepointCompare } from "../lib/codepoint-compare.mjs";
import { parseProviderResponseCapture } from "./provider-response-capture.mjs";

export const ITX_PROMOTION_GATE_POLICY_ID = "itx-promotion-gate-v1";
export const ITX_ANOMALY_POLICY_VERSION = "itx-snapshot-anomaly-v1";
const POLICY_KEYS = ["anomalyPolicyVersion", "artifactKind", "dayCds", "limits", "measuredBasis", "policyId", "schemaVersion"];
const LIMIT_KEYS = [
  "firstDepartureShiftSeconds",
  "lastDepartureShiftSeconds",
  "odSetDelta",
  "providerErrorRecords",
  "stationSetDelta",
  "stopPatternChangedTripsPermille",
  "timetableTupleAddedPermille",
  "timetableTupleRemovedPermille",
  "tripCountDeltaPermille",
  "tripMembershipDeltaPermille",
].sort(codepointCompare);
const SHA256 = /^[0-9a-f]{64}$/u;

function policyInvalid(detail) {
  throw new Error(`ITX_PROMOTION_GATE_POLICY_INVALID: ${detail}`);
}

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const sameKeys = (value, keys) => isObject(value) && JSON.stringify(Object.keys(value).sort(codepointCompare)) === JSON.stringify([...keys].sort(codepointCompare));
const nonnegativeInteger = (value) => Number.isSafeInteger(value) && value >= 0;

export function parseItxPromotionGatePolicy(value) {
  if (!sameKeys(value, POLICY_KEYS)) policyInvalid("keys");
  if (value.schemaVersion !== 1 || value.artifactKind !== "itx-promotion-gate-policy") policyInvalid("identity");
  if (value.policyId !== ITX_PROMOTION_GATE_POLICY_ID) policyInvalid("policyId");
  if (value.anomalyPolicyVersion !== ITX_ANOMALY_POLICY_VERSION) policyInvalid("anomalyPolicyVersion");
  if (JSON.stringify(value.dayCds) !== JSON.stringify(["8", "7", "9"])) policyInvalid("dayCds");
  if (!sameKeys(value.limits, LIMIT_KEYS)) policyInvalid("limit keys");
  for (const key of LIMIT_KEYS) {
    if (!nonnegativeInteger(value.limits[key])) policyInvalid(`limit ${key}`);
    if (key.endsWith("Permille") && value.limits[key] > 1000) policyInvalid(`limit ${key}`);
  }
  if (!isObject(value.measuredBasis)) policyInvalid("measuredBasis");
  return structuredClone(value);
}

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const stringify = (value) => JSON.stringify(value);

function difference(left, right) {
  const rightValues = new Set(right.map(stringify));
  return left.filter((value) => !rightValues.has(stringify(value)));
}

const allowed = (previousCount, permille) => Math.floor((previousCount * permille) / 1000);

function daySetsOf(source) {
  const byDay = new Map();
  for (const entry of source?.normalizedSnapshotSets ?? []) {
    if (isObject(entry) && typeof entry.dayCd === "string" && isObject(entry.sets)) byDay.set(entry.dayCd, entry.sets);
  }
  return byDay;
}

function stationMappingsOf(source) {
  const byDay = new Map();
  for (const day of source?.stationRosters ?? []) {
    if (!isObject(day)) continue;
    byDay.set(day.dayCd, (day.stations ?? []).map(({ canonicalStationId, providerStationId }) => (
      [canonicalStationId, providerStationId ?? canonicalStationId]
    )));
  }
  return byDay;
}

function departureBounds(tuples) {
  const departures = tuples.map((tuple) => tuple?.[4]).filter(Number.isFinite);
  if (departures.length === 0 || departures.length !== tuples.length) return null;
  return { first: Math.min(...departures), last: Math.max(...departures) };
}

function check(id, dayCd, blocked, observed, limit) {
  return { id, ...(dayCd === null ? {} : { dayCd }), status: blocked ? "BLOCK" : "PASS", observed, limit };
}

/**
 * 후보와 직전 승인 원천의 normalizedSnapshotSets를 요일 유형별 지표로 비교한다.
 * 결속·수집 오류는 보지 않는다(evaluateItxPromotionGate가 본다). 이력 재생과 CI 재계산이 이 함수만 쓴다.
 */
export function evaluateItxPromotionMetrics({ policy, candidate, previous }) {
  const { limits, dayCds } = policy;
  const currentByDay = daySetsOf(candidate);
  const previousByDay = daySetsOf(previous);
  const currentMappings = stationMappingsOf(candidate);
  const previousMappings = stationMappingsOf(previous);
  const checks = [];
  for (const dayCd of dayCds) {
    const current = currentByDay.get(dayCd);
    const before = previousByDay.get(dayCd);
    const required = ["stationSet", "odSet", "trainSet", "stopSequenceSet", "timetableTupleSet"];
    if (!current || !before || required.some((name) => !Array.isArray(current[name]) || !Array.isArray(before[name]))) {
      checks.push(check("DAY_COVERAGE", dayCd, true, { current: Boolean(current), previous: Boolean(before) }, { dayCd }));
      continue;
    }
    const stationAdded = difference(current.stationSet, before.stationSet).length;
    const stationRemoved = difference(before.stationSet, current.stationSet).length;
    const mappingAdded = difference(currentMappings.get(dayCd) ?? [], previousMappings.get(dayCd) ?? []).length;
    const mappingRemoved = difference(previousMappings.get(dayCd) ?? [], currentMappings.get(dayCd) ?? []).length;
    const stationDelta = stationAdded + stationRemoved + mappingAdded + mappingRemoved;
    checks.push(check("STATION_COVERAGE", dayCd, stationDelta > limits.stationSetDelta,
      { added: stationAdded + mappingAdded, removed: stationRemoved + mappingRemoved }, { delta: limits.stationSetDelta }));
    const odAdded = difference(current.odSet, before.odSet).length;
    const odRemoved = difference(before.odSet, current.odSet).length;
    checks.push(check("OD_COVERAGE", dayCd, odAdded + odRemoved > limits.odSetDelta,
      { added: odAdded, removed: odRemoved }, { delta: limits.odSetDelta }));

    const previousTrips = before.trainSet.length;
    const tripDelta = Math.abs(current.trainSet.length - previousTrips);
    const tripLimit = allowed(previousTrips, limits.tripCountDeltaPermille);
    checks.push(check("TRIP_COUNT", dayCd, tripDelta > tripLimit,
      { previous: previousTrips, current: current.trainSet.length, delta: tripDelta }, { delta: tripLimit }));
    const tripsAdded = difference(current.trainSet, before.trainSet).length;
    const tripsRemoved = difference(before.trainSet, current.trainSet).length;
    const membershipLimit = allowed(previousTrips, limits.tripMembershipDeltaPermille);
    checks.push(check("TRIP_MEMBERSHIP", dayCd, tripsAdded > membershipLimit || tripsRemoved > membershipLimit,
      { previous: previousTrips, added: tripsAdded, removed: tripsRemoved }, { each: membershipLimit }));

    const patternChanged = difference(current.stopSequenceSet, before.stopSequenceSet).length;
    const patternLimit = allowed(previousTrips, limits.stopPatternChangedTripsPermille);
    checks.push(check("STOP_PATTERN", dayCd, patternChanged > patternLimit,
      { previous: previousTrips, changed: patternChanged }, { changed: patternLimit }));

    const previousTuples = before.timetableTupleSet.length;
    const tuplesRemoved = difference(before.timetableTupleSet, current.timetableTupleSet).length;
    const tuplesAdded = difference(current.timetableTupleSet, before.timetableTupleSet).length;
    const removedLimit = allowed(previousTuples, limits.timetableTupleRemovedPermille);
    const addedLimit = allowed(previousTuples, limits.timetableTupleAddedPermille);
    checks.push(check("TUPLE_REMOVED", dayCd, tuplesRemoved > removedLimit,
      { previous: previousTuples, count: tuplesRemoved }, { count: removedLimit }));
    checks.push(check("TUPLE_ADDED", dayCd, tuplesAdded > addedLimit,
      { previous: previousTuples, count: tuplesAdded }, { count: addedLimit }));

    const currentBounds = departureBounds(current.timetableTupleSet);
    const previousBounds = departureBounds(before.timetableTupleSet);
    for (const [id, key, limit] of [
      ["FIRST_DEPARTURE_SHIFT", "first", limits.firstDepartureShiftSeconds],
      ["LAST_DEPARTURE_SHIFT", "last", limits.lastDepartureShiftSeconds],
    ]) {
      if (!currentBounds || !previousBounds) {
        checks.push(check(id, dayCd, true, { previous: previousBounds?.[key] ?? null, current: currentBounds?.[key] ?? null, shiftSeconds: null }, { shiftSeconds: limit }));
        continue;
      }
      const shift = Math.abs(currentBounds[key] - previousBounds[key]);
      checks.push(check(id, dayCd, shift > limit,
        { previous: previousBounds[key], current: currentBounds[key], shiftSeconds: shift }, { shiftSeconds: limit }));
    }
  }
  return checks;
}

/**
 * 직전 승인 원천 대비 지표와 마지막 owner 승인 기준선 대비 지표(BASELINE_*)를 함께 낸다.
 * 직전 승인본 대비만 보면 매번 조금씩 어긋나는 누적 drift를 놓치므로 같은 한도로 기준선 대비도 본다.
 * 기준선이 직전 원천과 같으면(승인 승격 바로 다음) 같은 비교라 check를 더하지 않는다.
 */
export function evaluateItxPromotionMetricChecks({ policy, candidate, previous, previousSha256 = null, baseline = null, baselineSha256 = null }) {
  const checks = evaluateItxPromotionMetrics({ policy, candidate, previous });
  if (baseline && baselineSha256 !== previousSha256) {
    checks.push(...evaluateItxPromotionMetrics({ policy, candidate, previous: baseline }).map((item) => ({ ...item, id: `BASELINE_${item.id}` })));
  }
  return checks;
}

function evaluateBinding({ candidate, candidateSha256, completeness, completenessSha256, capture, captureSha256, replay, dayCds }) {
  const failures = [];
  const fail = (code) => failures.push(code);
  if (candidate?.artifactKind !== "itx-cheongchun-source-timetable" || candidate.validationStatus !== "SUPPORTED") fail("CANDIDATE_IDENTITY");
  if (!SHA256.test(candidateSha256 ?? "")) fail("CANDIDATE_SHA256");
  if (!SHA256.test(completenessSha256 ?? "") || completenessSha256 !== candidate?.completenessEvidenceSha256) fail("COMPLETENESS_SHA256");
  if (completeness?.sourceTimetableArtifact?.artifactId !== candidate?.artifactId) fail("COMPLETENESS_ARTIFACT_ID");
  if (completeness?.observedAt !== candidate?.observedAt
    || stringify(completeness?.selectedServiceDates) !== stringify(candidate?.selectedServiceDates)) fail("COMPLETENESS_OBSERVATION");
  if (!SHA256.test(captureSha256 ?? "")) fail("RAW_CAPTURE_SHA256");
  if (capture?.artifactKind !== "provider-response-capture" || !SHA256.test(capture?.contentSha256 ?? "")) fail("CAPTURE_IDENTITY");
  if (capture?.observedAt !== candidate?.observedAt) fail("CAPTURE_OBSERVED_AT");
  if (stringify(capture?.selectedServiceDates) !== stringify(candidate?.selectedServiceDates)) fail("CAPTURE_SERVICE_DATES");
  if (replay?.validationMode !== "REPLAY" || replay?.validationStatus !== "SUPPORTED"
    || !SHA256.test(replay?.evidenceHash ?? "")) fail("REPLAY_IDENTITY");
  if (replay?.observedAt !== candidate?.observedAt
    || stringify(replay?.selectedServiceDates) !== stringify(candidate?.selectedServiceDates)) fail("REPLAY_OBSERVATION");
  const replayDays = Array.isArray(replay?.serviceDays) ? replay.serviceDays : [];
  const completenessDays = Array.isArray(completeness?.serviceDays) ? completeness.serviceDays : [];
  const lineage = Array.isArray(candidate?.sourceLineage) ? candidate.sourceLineage : [];
  for (const dayCd of dayCds) {
    const fromReplay = replayDays.filter((day) => day?.dayCd === dayCd);
    const fromCompleteness = completenessDays.filter((day) => day?.dayCd === dayCd);
    const fromLineage = lineage.filter((day) => day?.dayCd === dayCd);
    if (fromReplay.length !== 1 || fromCompleteness.length !== 1 || fromLineage.length !== 1) {
      fail(`LINEAGE_DAY_${dayCd}`);
      continue;
    }
    const [replayDay] = fromReplay;
    const [completenessDay] = fromCompleteness;
    const [lineageDay] = fromLineage;
    const hashes = [
      [replayDay.roster?.evidenceHash, completenessDay.roster?.evidenceHash, lineageDay.rosterEvidenceHash],
      [replayDay.timetable?.evidenceHash, completenessDay.timetable?.evidenceHash, lineageDay.timetableEvidenceHash],
    ];
    if (hashes.some(([fromRaw, fromEvidence, fromCandidate]) => !SHA256.test(fromRaw ?? "") || fromRaw !== fromEvidence || fromRaw !== fromCandidate)) {
      fail(`LINEAGE_HASH_${dayCd}`);
    }
  }
  return check("SOURCE_BINDING", null, failures.length > 0, { failures }, {});
}

function evaluateFetchErrors({ completeness, capture, replay, limits, dayCds }) {
  const failures = [];
  if (completeness?.validationStatus !== "SUPPORTED" || completeness?.validationMode !== "ADMISSION") failures.push("COMPLETENESS_NOT_SUPPORTED");
  if (Object.hasOwn(completeness ?? {}, "failureReasonCode") || Object.hasOwn(completeness ?? {}, "failureStage")) failures.push("COMPLETENESS_FAILURE_CODE");
  for (const dayCd of dayCds) {
    const days = (completeness?.serviceDays ?? []).filter((day) => day?.dayCd === dayCd);
    if (days.length !== 1) {
      failures.push(`DAY_${dayCd}_MISSING`);
      continue;
    }
    const [day] = days;
    if (day.status !== "SUPPORTED") failures.push(`DAY_${dayCd}_NOT_SUPPORTED`);
    if (!Number.isInteger(day.expectedOdCount) || day.expectedOdCount < 1
      || day.completedOdCount !== day.expectedOdCount || day.failedOdCount !== 0) failures.push(`DAY_${dayCd}_OD_INCOMPLETE`);
  }
  if (replay?.validationStatus !== "SUPPORTED") failures.push("REPLAY_NOT_SUPPORTED");
  const records = Array.isArray(capture?.records) ? capture.records : null;
  let providerErrors = 0;
  if (records === null) failures.push("CAPTURE_RECORDS_MISSING");
  else {
    providerErrors = records.filter((record) => (
      record?.outcome?.kind !== "RESPONSE" || record.outcome.response?.status !== 200
    )).length;
    if (providerErrors > limits.providerErrorRecords) failures.push("PROVIDER_ERROR_RECORDS");
  }
  return check("FETCH_ERRORS", null, failures.length > 0, { failures, providerErrorRecords: providerErrors }, { providerErrorRecords: limits.providerErrorRecords });
}

/**
 * 승격 게이트. 모든 입력은 이미 읽은 값이다. previous가 null이면 첫 승격(bootstrap)이라 자동 승격하지 않는다.
 * 반환값은 영수증이다: status가 PASS일 때만 승격 도구가 쓴다.
 */
export function evaluateItxPromotionGate({
  policy,
  candidate,
  candidateSha256,
  completeness,
  completenessSha256,
  previous,
  previousSha256,
  baseline = null,
  baselineSha256 = null,
  capture,
  captureSha256,
  replay,
}) {
  const checks = [];
  if (previous === null || previous === undefined) {
    checks.push(check("PREVIOUS_APPROVED_SNAPSHOT_MISSING", null, true, {}, {}));
  } else {
    checks.push(...evaluateItxPromotionMetricChecks({ policy, candidate, previous, previousSha256, baseline, baselineSha256 }));
  }
  const effectiveBaseline = baseline ?? previous ?? null;
  const effectiveBaselineSha256 = baseline ? baselineSha256 : previousSha256 ?? null;
  checks.push(evaluateBinding({
    candidate, candidateSha256, completeness, completenessSha256, capture, captureSha256, replay, dayCds: policy.dayCds,
  }));
  checks.push(evaluateFetchErrors({ completeness, capture, replay, limits: policy.limits, dayCds: policy.dayCds }));
  const blockedCheckIds = checks
    .filter(({ status }) => status === "BLOCK")
    .map(({ id, dayCd }) => (dayCd === undefined ? id : `${id}:${dayCd}`))
    .sort(codepointCompare);
  return {
    schemaVersion: 1,
    artifactKind: "itx-promotion-gate-receipt",
    policyId: policy.policyId,
    anomalyPolicyVersion: policy.anomalyPolicyVersion,
    status: blockedCheckIds.length === 0 ? "PASS" : "BLOCK",
    candidate: {
      artifactId: candidate?.artifactId ?? null,
      sha256: candidateSha256 ?? null,
      observedAt: candidate?.observedAt ?? null,
      freshUntil: candidate?.freshUntil ?? null,
    },
    previous: previous ? { artifactId: previous.artifactId, sha256: previousSha256 } : null,
    baseline: effectiveBaseline ? { artifactId: effectiveBaseline.artifactId, sha256: effectiveBaselineSha256 } : null,
    source: {
      rawCaptureSha256: captureSha256 ?? null,
      captureContentSha256: capture?.contentSha256 ?? null,
      replayEvidenceHash: replay?.evidenceHash ?? null,
      providerRecordCount: Array.isArray(capture?.records) ? capture.records.length : null,
    },
    policy: structuredClone(policy),
    checks,
    blockedCheckIds,
  };
}

export function itxPromotionGateReceiptBytes(receipt) {
  return Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// CLI: 후보·직전 원천을 읽어 영수증을 쓰고 PASS면 0, BLOCK이면 3, 오류면 1로 끝난다.
// ---------------------------------------------------------------------------
function parseArguments(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    if (!key?.startsWith("--") || typeof argv[index + 1] !== "string" || Object.hasOwn(args, key.slice(2))) {
      throw new Error("ITX_PROMOTION_GATE_ARGUMENTS");
    }
    args[key.slice(2)] = argv[index + 1];
  }
  return args;
}

export async function runItxPromotionGateCli({ argv = process.argv.slice(2), repositoryRoot = path.resolve(import.meta.dirname, "../..") } = {}) {
  const args = parseArguments(argv);
  const required = ["candidate", "completeness", "capture", "replay", "coverage-contract", "policy", "output"];
  if (JSON.stringify(Object.keys(args).sort(codepointCompare)) !== JSON.stringify([...required].sort(codepointCompare))
    || required.some((name) => !path.isAbsolute(args[name]))) {
    throw new Error("ITX_PROMOTION_GATE_ARGUMENTS");
  }
  const policy = parseItxPromotionGatePolicy(JSON.parse(await readFile(args.policy, "utf8")));
  const candidateBytes = await readFile(args.candidate);
  const completenessBytes = await readFile(args.completeness);
  const captureBytes = await readFile(args.capture);
  const capture = parseProviderResponseCapture(captureBytes);
  const replay = JSON.parse(await readFile(args.replay, "utf8"));
  const contract = JSON.parse(await readFile(args["coverage-contract"], "utf8"));
  const reference = contract?.sourceTimetableArtifact;
  let previous = null;
  let previousSha256 = null;
  if (reference?.status === "ADMITTED" && typeof reference.artifactPath === "string") {
    const previousBytes = await readFile(path.join(repositoryRoot, reference.artifactPath));
    if (sha256(previousBytes) !== reference.sha256) throw new Error("ITX_PROMOTION_GATE_PREVIOUS_SHA256_MISMATCH");
    previous = JSON.parse(previousBytes);
    previousSha256 = reference.sha256;
  }
  const receipt = evaluateItxPromotionGate({
    policy,
    candidate: JSON.parse(candidateBytes),
    candidateSha256: sha256(candidateBytes),
    completeness: JSON.parse(completenessBytes),
    completenessSha256: sha256(completenessBytes),
    previous,
    previousSha256,
    capture,
    captureSha256: sha256(captureBytes),
    replay,
  });
  await writeFile(args.output, itxPromotionGateReceiptBytes(receipt), { flag: "wx", mode: 0o644 });
  return receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const receipt = await runItxPromotionGateCli();
    const summary = `ITX promotion gate ${receipt.status}: policy=${receipt.policyId} candidate=${receipt.candidate.artifactId}`
      + ` blocked=${receipt.blockedCheckIds.join(",") || "none"}`;
    if (receipt.status === "PASS") {
      console.log(summary);
    } else {
      console.error(summary);
      process.exitCode = 3;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
