import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  ITX_PROMOTION_GATE_POLICY_ID,
  evaluateItxPromotionGate,
  evaluateItxPromotionMetrics,
  parseItxPromotionGatePolicy,
  runItxPromotionGateCli,
} from "./itx-promotion-gate.mjs";
import { createProviderResponseRecorder, providerResponseCaptureBytes } from "./provider-response-capture.mjs";

const POLICY = parseItxPromotionGatePolicy(JSON.parse(await readFile(new URL("./itx-promotion-gate-policy.json", import.meta.url), "utf8")));
const SOURCES = new URL("./sources/", import.meta.url);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

// ---------------------------------------------------------------------------
// 합성 snapshot: 평일(8) 40편 x 7정차 = 280 tuple, 토(7)·일(9) 52편 x 7정차 = 364 tuple. 역은 18개다.
// ---------------------------------------------------------------------------
const STATIONS = Array.from({ length: 18 }, (_, index) => `station-${String(index).padStart(2, "0")}`);
const PATTERN = [0, 3, 6, 9, 12, 15, 17];
const TRAIN_COUNTS = { "8": 40, "7": 52, "9": 52 };

function daySets(dayCd, { trains = TRAIN_COUNTS[dayCd], stations = STATIONS } = {}) {
  const stationSet = [...stations];
  const provider = stationSet.map((id) => `NAT-${id}`);
  const odSet = provider.flatMap((from) => provider.filter((to) => to !== from).map((to) => [dayCd, from, to]));
  const trainSet = Array.from({ length: trains }, (_, index) => String(2001 + index));
  const stopSequenceSet = trainSet.map((train) => [dayCd, train, "up", PATTERN.map((index) => stationSet[index] ?? stationSet.at(-1))]);
  const timetableTupleSet = trainSet.flatMap((train, trainIndex) => PATTERN.map((_, stopIndex) => {
    const base = 20_000 + trainIndex * 600 + stopIndex * 300;
    return [dayCd, train, stationSet[PATTERN[stopIndex]] ?? stationSet.at(-1), base, base + 60];
  }));
  return { stationSet, odSet, trainSet, stopSequenceSet, timetableTupleSet };
}

function snapshot(name, { observedAt = "2026-10-04T15:15:19.524Z", freshUntil = "2026-10-12T00:00:00+09:00", mutate = () => {} } = {}) {
  const sets = Object.fromEntries(["8", "7", "9"].map((dayCd) => [dayCd, daySets(dayCd)]));
  const days = { sets };
  mutate(days);
  const selectedServiceDates = { "8": "20261006", "7": "20261010", "9": "20261011" };
  return {
    schemaVersion: 1,
    artifactKind: "itx-cheongchun-source-timetable",
    artifactId: `itx-cheongchun-source-timetable-${name}`,
    observedAt,
    freshUntil,
    selectedServiceDates,
    validationStatus: "SUPPORTED",
    normalizedSnapshotSets: ["8", "7", "9"].map((dayCd) => ({ dayCd, sets: days.sets[dayCd] })),
    stationRosters: ["8", "7", "9"].map((dayCd) => ({
      dayCd,
      stations: days.sets[dayCd].stationSet.map((id) => ({ canonicalStationId: id, providerStationId: `NAT-${id}` })),
    })),
    sourceLineage: ["8", "7", "9"].map((dayCd) => ({ dayCd, rosterEvidenceHash: sha256(`roster-${name}-${dayCd}`), timetableEvidenceHash: sha256(`timetable-${name}-${dayCd}`) })),
    completenessEvidenceSha256: sha256(`completeness-${name}`),
    warnings: [],
  };
}

function completenessFor(candidate, overrides = {}) {
  return {
    artifactKind: "korail-itx-cheongchun-completeness-evidence",
    validationMode: "ADMISSION",
    validationStatus: "SUPPORTED",
    observedAt: candidate.observedAt,
    selectedServiceDates: candidate.selectedServiceDates,
    sourceTimetableArtifact: { artifactId: candidate.artifactId },
    serviceDays: candidate.sourceLineage.map(({ dayCd, rosterEvidenceHash, timetableEvidenceHash }) => ({
      dayCd,
      status: "SUPPORTED",
      expectedOdCount: 306,
      completedOdCount: 306,
      failedOdCount: 0,
      roster: { evidenceHash: rosterEvidenceHash },
      timetable: { evidenceHash: timetableEvidenceHash },
    })),
    ...overrides,
  };
}

function captureFor(candidate, { records } = {}) {
  return {
    artifactKind: "provider-response-capture",
    observedAt: candidate.observedAt,
    selectedServiceDates: candidate.selectedServiceDates,
    requestCount: 3,
    contentSha256: sha256(`capture-${candidate.artifactId}`),
    records: records ?? [0, 1, 2].map((index) => ({ index, outcome: { kind: "RESPONSE", response: { status: 200 } } })),
  };
}

function replayFor(candidate, overrides = {}) {
  return {
    artifactKind: "korail-itx-cheongchun-completeness-evidence",
    validationMode: "REPLAY",
    validationStatus: "SUPPORTED",
    observedAt: candidate.observedAt,
    selectedServiceDates: candidate.selectedServiceDates,
    evidenceHash: sha256(`replay-${candidate.artifactId}`),
    serviceDays: completenessFor(candidate).serviceDays,
    ...overrides,
  };
}

function gateInput(candidateOverrides = {}, previousOverrides = {}) {
  const previous = snapshot("previous", { observedAt: "2026-09-30T16:38:54.026Z", freshUntil: "2026-10-11T00:00:00+09:00", ...previousOverrides });
  const candidate = snapshot("candidate", candidateOverrides);
  return {
    policy: POLICY,
    candidate,
    candidateSha256: sha256("candidate-bytes"),
    completeness: completenessFor(candidate),
    completenessSha256: candidate.completenessEvidenceSha256,
    previous,
    previousSha256: sha256("previous-bytes"),
    capture: captureFor(candidate),
    captureSha256: sha256("capture-bytes"),
    replay: replayFor(candidate),
  };
}

// 한도 산식(천분율을 내림해 열차·tuple 수로 바꾸고 초과만 차단)을 한도가 0이 아닌 정책으로 따로 검증한다. 실제 정책 한도는 0이다.
const WIDE = parseItxPromotionGatePolicy({
  ...structuredClone(POLICY),
  limits: {
    ...POLICY.limits,
    tripCountDeltaPermille: 50,
    tripMembershipDeltaPermille: 50,
    stopPatternChangedTripsPermille: 50,
    timetableTupleRemovedPermille: 50,
    timetableTupleAddedPermille: 50,
  },
});
function wideMetrics(candidateMutate) {
  return evaluateItxPromotionMetrics({ policy: WIDE, candidate: snapshot("candidate", { mutate: candidateMutate }), previous: snapshot("previous") });
}

function metricsOnly(candidateMutate) {
  const previous = snapshot("previous");
  const candidate = snapshot("candidate", { mutate: candidateMutate });
  return evaluateItxPromotionMetrics({ policy: POLICY, candidate, previous });
}

const blockedIds = (checks) => checks.filter(({ status }) => status === "BLOCK").map(({ id, dayCd }) => `${id}:${dayCd ?? "-"}`).sort();

function retimeTuples(sets, dayCd, count, delta, { skipEnds = true } = {}) {
  // 각 열차의 가운데 정차 tuple만 시각을 옮겨 첫차·막차 시각을 건드리지 않는다.
  let moved = 0;
  sets[dayCd].timetableTupleSet = sets[dayCd].timetableTupleSet.map((tuple, index) => {
    const inMiddle = !skipEnds || (index % PATTERN.length !== 0 && index % PATTERN.length !== PATTERN.length - 1);
    if (moved < count && inMiddle) {
      moved += 1;
      return [tuple[0], tuple[1], tuple[2], tuple[3] + delta, tuple[4] + delta];
    }
    return tuple;
  });
  assert.equal(moved, count);
}

// ---------------------------------------------------------------------------
// 정책 파일
// ---------------------------------------------------------------------------
test("게이트 정책은 닫힌 형식이고 기존 이상 판정 정책 이름에 결속된다", () => {
  assert.equal(POLICY.policyId, ITX_PROMOTION_GATE_POLICY_ID);
  assert.equal(POLICY.anomalyPolicyVersion, "itx-snapshot-anomaly-v1");
  assert.deepEqual(POLICY.dayCds, ["8", "7", "9"]);
  for (const mutate of [
    (value) => { value.limits.extra = 1; },
    (value) => { delete value.limits.stationSetDelta; },
    (value) => { value.limits.tripCountDeltaPermille = -1; },
    (value) => { value.limits.tripCountDeltaPermille = 50.5; },
    (value) => { value.limits.firstDepartureShiftSeconds = "300"; },
    (value) => { value.policyId = "itx-promotion-gate-v2"; },
    (value) => { value.anomalyPolicyVersion = "itx-snapshot-anomaly-v2"; },
    (value) => { value.dayCds = ["8", "7"]; },
    (value) => { value.extra = true; },
  ]) {
    const copy = structuredClone(POLICY);
    mutate(copy);
    assert.throws(() => parseItxPromotionGatePolicy(copy), /ITX_PROMOTION_GATE_POLICY_INVALID/u);
  }
});

// ---------------------------------------------------------------------------
// 지표별 반증 가능성: 한도 값은 통과, 한도+1은 차단
// ---------------------------------------------------------------------------
test("동일한 snapshot은 모든 지표를 통과한다", () => {
  const checks = metricsOnly(() => {});
  assert.deepEqual(blockedIds(checks), []);
  assert.ok(checks.length >= 3 * 9);
});

test("역 집합이 하나라도 달라지면 역·OD 커버리지가 차단된다", () => {
  const checks = metricsOnly(({ sets }) => {
    sets["8"] = daySets("8", { stations: STATIONS.slice(0, 17) });
  });
  const blocked = blockedIds(checks);
  assert.ok(blocked.includes("STATION_COVERAGE:8"));
  assert.ok(blocked.includes("OD_COVERAGE:8"));
  assert.ok(!blocked.some((id) => id.endsWith(":7") || id.endsWith(":9")));
});

test("역 canonical-provider 매핑이 바뀌면 역 집합이 같아도 차단된다", () => {
  const previous = snapshot("previous");
  const candidate = snapshot("candidate");
  candidate.stationRosters[0].stations[0].providerStationId = "NAT-OTHER";
  const blocked = blockedIds(evaluateItxPromotionMetrics({ policy: POLICY, candidate, previous }));
  assert.ok(blocked.includes("STATION_COVERAGE:8"));
});

test("[5% 한도 정책] 편수 변화는 한도(평일 40편 -> 2편)까지 통과하고 한도+1에서 차단된다", () => {
  const limit = Math.floor((40 * WIDE.limits.tripCountDeltaPermille) / 1000);
  assert.equal(limit, 2);
  for (const direction of ["drop", "add"]) {
    const change = (count) => ({ sets }) => {
      sets["8"] = daySets("8", { trains: direction === "drop" ? 40 - count : 40 + count });
    };
    assert.deepEqual(blockedIds(wideMetrics(change(limit))).filter((id) => id.startsWith("TRIP_COUNT")), [], direction);
    assert.deepEqual(blockedIds(wideMetrics(change(limit + 1))).filter((id) => id.startsWith("TRIP_COUNT")), ["TRIP_COUNT:8"], direction);
  }
});

test("[5% 한도 정책] 열차 구성이 바뀌면 편수가 같아도 TRIP_MEMBERSHIP이 한도+1에서 차단된다", () => {
  const limit = Math.floor((40 * WIDE.limits.tripMembershipDeltaPermille) / 1000);
  const swap = (count) => ({ sets }) => {
    const trains = sets["8"].trainSet;
    sets["8"].trainSet = trains.map((train, index) => (index < count ? `9${train}` : train));
  };
  assert.deepEqual(blockedIds(wideMetrics(swap(limit))).filter((id) => id.startsWith("TRIP_MEMBERSHIP")), []);
  assert.deepEqual(blockedIds(wideMetrics(swap(limit + 1))).filter((id) => id.startsWith("TRIP_MEMBERSHIP")), ["TRIP_MEMBERSHIP:8"]);
});

test("[5% 한도 정책] 정차 순서가 바뀐 열차 수는 한도(52편 -> 2편)까지 통과하고 한도+1에서 차단된다", () => {
  const limit = Math.floor((52 * WIDE.limits.stopPatternChangedTripsPermille) / 1000);
  assert.equal(limit, 2);
  const changePattern = (count) => ({ sets }) => {
    sets["7"].stopSequenceSet = sets["7"].stopSequenceSet.map((entry, index) => (
      index < count ? [entry[0], entry[1], entry[2], entry[3].slice(0, -2).concat(entry[3].at(-1))] : entry
    ));
  };
  assert.deepEqual(blockedIds(wideMetrics(changePattern(limit))).filter((id) => id.startsWith("STOP_PATTERN")), []);
  assert.deepEqual(blockedIds(wideMetrics(changePattern(limit + 1))).filter((id) => id.startsWith("STOP_PATTERN")), ["STOP_PATTERN:7"]);
});

test("[5% 한도 정책] 시각 tuple 이동은 한도(평일 280개 -> 14개)까지 통과하고 한도+1에서 제거·추가가 함께 차단된다", () => {
  const limit = Math.floor((280 * WIDE.limits.timetableTupleRemovedPermille) / 1000);
  assert.equal(limit, 14);
  const retime = (count) => ({ sets }) => retimeTuples(sets, "8", count, 120);
  assert.deepEqual(blockedIds(wideMetrics(retime(limit))).filter((id) => id.startsWith("TUPLE_")), []);
  assert.deepEqual(blockedIds(wideMetrics(retime(limit + 1))).filter((id) => id.startsWith("TUPLE_")), ["TUPLE_ADDED:8", "TUPLE_REMOVED:8"]);
});

test("[5% 한도 정책] tuple 제거만 일어나도(정차 소실) 제거 한도에서 차단되고 추가 지표는 통과한다", () => {
  const limit = Math.floor((364 * WIDE.limits.timetableTupleRemovedPermille) / 1000);
  assert.equal(limit, 18);
  const dropStops = (count) => ({ sets }) => { sets["9"].timetableTupleSet = sets["9"].timetableTupleSet.filter((_, index) => !(index % PATTERN.length === 3 && index / PATTERN.length < count)); };
  assert.deepEqual(blockedIds(wideMetrics(dropStops(limit))).filter((id) => id.startsWith("TUPLE_")), []);
  assert.deepEqual(blockedIds(wideMetrics(dropStops(limit + 1))).filter((id) => id.startsWith("TUPLE_")), ["TUPLE_REMOVED:9"]);
});

test("편수·열차 구성·정차 순서·시각 tuple 한도는 0이다: 이력상 안정 구간이 모두 0이라 한 편·한 tuple 변화도 멈춘다 (F2)", () => {
  for (const key of ["tripCountDeltaPermille", "tripMembershipDeltaPermille", "stopPatternChangedTripsPermille", "timetableTupleRemovedPermille", "timetableTupleAddedPermille"]) {
    assert.equal(POLICY.limits[key], 0, key);
  }
  for (const direction of ["drop", "add"]) {
    const oneTrip = ({ sets }) => { sets["8"] = daySets("8", { trains: direction === "drop" ? 39 : 41 }); };
    assert.ok(blockedIds(metricsOnly(oneTrip)).includes("TRIP_COUNT:8"), direction);
  }
  const swapOne = ({ sets }) => { sets["8"].trainSet = sets["8"].trainSet.map((train, index) => (index === 0 ? `9${train}` : train)); };
  assert.ok(blockedIds(metricsOnly(swapOne)).includes("TRIP_MEMBERSHIP:8"));
  const patternOne = ({ sets }) => { sets["7"].stopSequenceSet = sets["7"].stopSequenceSet.map((entry, index) => (index === 0 ? [entry[0], entry[1], entry[2], entry[3].slice(0, -2).concat(entry[3].at(-1))] : entry)); };
  assert.ok(blockedIds(metricsOnly(patternOne)).includes("STOP_PATTERN:7"));
  const retimeOne = ({ sets }) => retimeTuples(sets, "8", 1, 60);
  assert.deepEqual(blockedIds(metricsOnly(retimeOne)).filter((id) => id.startsWith("TUPLE_")), ["TUPLE_ADDED:8", "TUPLE_REMOVED:8"]);
  const dropOne = ({ sets }) => { sets["9"].timetableTupleSet = sets["9"].timetableTupleSet.filter((_, index) => index !== 3); };
  assert.deepEqual(blockedIds(metricsOnly(dropOne)).filter((id) => id.startsWith("TUPLE_")), ["TUPLE_REMOVED:9"]);
  assert.deepEqual(blockedIds(metricsOnly(() => {})), []);
});

// F2: 직전 승인본 대비만 보면 매번 조금씩 어긋나는 누적 drift를 놓친다. 마지막 owner 기준선 대비도 같은 한도로 비교한다.
function driftChain({ previousShift, candidateShift }) {
  const shiftLast = (seconds) => ({ sets }) => {
    const lastTrain = sets["9"].trainSet.at(-1);
    sets["9"].timetableTupleSet = sets["9"].timetableTupleSet.map((tuple) => (
      tuple[1] === lastTrain ? [tuple[0], tuple[1], tuple[2], tuple[3] + seconds, tuple[4] + seconds] : tuple
    ));
  };
  return {
    baseline: snapshot("baseline", { observedAt: "2026-09-20T16:00:00.000Z", freshUntil: "2026-09-27T00:00:00+09:00" }),
    previous: snapshot("previous", { observedAt: "2026-09-30T16:38:54.026Z", freshUntil: "2026-10-11T00:00:00+09:00", mutate: shiftLast(previousShift) }),
    candidate: shiftLast(candidateShift),
  };
}

test("누적 drift: 직전 대비는 한도 안이어도 owner 기준선 대비가 한도를 넘으면 BASELINE_* check가 차단한다 (F2)", () => {
  const chain = driftChain({ previousShift: 240, candidateShift: 480 });
  const input = { ...gateInput({ mutate: chain.candidate }), previous: chain.previous, baseline: chain.baseline, baselineSha256: sha256("baseline-bytes") };
  const receipt = evaluateItxPromotionGate(input);
  assert.equal(receipt.status, "BLOCK");
  assert.deepEqual(receipt.blockedCheckIds.filter((id) => id.startsWith("BASELINE_")).sort(), ["BASELINE_LAST_DEPARTURE_SHIFT:9", "BASELINE_TUPLE_ADDED:9", "BASELINE_TUPLE_REMOVED:9"].sort());
  // 직전 대비 check만 보면 마지막 이동은 240초라 통과한다. 기준선 check가 없으면 놓친다.
  assert.ok(!receipt.blockedCheckIds.includes("LAST_DEPARTURE_SHIFT:9"));
  assert.deepEqual(receipt.baseline, { artifactId: chain.baseline.artifactId, sha256: sha256("baseline-bytes") });
});

test("누적 drift: 기준선 대비도 한도 안이면 통과하고, 기준선이 직전 원천이면 추가 check를 만들지 않는다 (F2)", () => {
  const same = evaluateItxPromotionGate({ ...gateInput(), baseline: snapshot("previous"), baselineSha256: sha256("previous-bytes") });
  assert.equal(same.status, "PASS");
  assert.equal(same.checks.some(({ id }) => id.startsWith("BASELINE_")), false);
  assert.deepEqual(same.baseline, { artifactId: "itx-cheongchun-source-timetable-previous", sha256: sha256("previous-bytes") });
  const withinChain = driftChain({ previousShift: 0, candidateShift: 0 });
  const passed = evaluateItxPromotionGate({ ...gateInput({ mutate: withinChain.candidate }), previous: withinChain.previous, baseline: withinChain.baseline, baselineSha256: sha256("baseline-bytes") });
  assert.equal(passed.status, "PASS");
  assert.ok(passed.checks.some(({ id }) => id === "BASELINE_TRIP_COUNT"));
});

test("첫차 시각 이동은 한도 0(이력 최대 0초)에서 0초는 통과하고 1초부터 차단된다", () => {
  assert.equal(POLICY.limits.firstDepartureShiftSeconds, 0);
  const shiftFirst = (seconds) => ({ sets }) => {
    const [first, ...rest] = sets["8"].timetableTupleSet;
    sets["8"].timetableTupleSet = [[first[0], first[1], first[2], first[3] - seconds, first[4] - seconds], ...rest];
  };
  assert.deepEqual(blockedIds(metricsOnly(shiftFirst(0))).filter((id) => id.startsWith("FIRST_DEPARTURE")), []);
  assert.deepEqual(blockedIds(metricsOnly(shiftFirst(1))).filter((id) => id.startsWith("FIRST_DEPARTURE")), ["FIRST_DEPARTURE_SHIFT:8"]);
});

test("막차 시각 이동은 한도 240초(이력 최대)까지 통과하고 241초에서 차단된다 (앞·뒤 방향 모두)", () => {
  assert.equal(POLICY.limits.lastDepartureShiftSeconds, 240);
  for (const sign of [1, -1]) {
    // 마지막 열차의 모든 정차를 함께 옮겨, 옮긴 뒤에도 그 열차가 막차 시각을 정한다.
    const shiftLast = (seconds) => ({ sets }) => {
      const lastTrain = sets["9"].trainSet.at(-1);
      sets["9"].timetableTupleSet = sets["9"].timetableTupleSet.map((tuple) => (
        tuple[1] === lastTrain ? [tuple[0], tuple[1], tuple[2], tuple[3] + sign * seconds, tuple[4] + sign * seconds] : tuple
      ));
    };
    assert.deepEqual(blockedIds(metricsOnly(shiftLast(240))).filter((id) => id.startsWith("LAST_DEPARTURE")), [], `sign ${sign}`);
    assert.deepEqual(blockedIds(metricsOnly(shiftLast(241))).filter((id) => id.startsWith("LAST_DEPARTURE")), ["LAST_DEPARTURE_SHIFT:9"], `sign ${sign}`);
  }
});

test("요일 유형 하나가 비어 있으면 지표를 만들 수 없어 차단된다", () => {
  const previous = snapshot("previous");
  const candidate = snapshot("candidate");
  candidate.normalizedSnapshotSets = candidate.normalizedSnapshotSets.filter(({ dayCd }) => dayCd !== "7");
  const blocked = blockedIds(evaluateItxPromotionMetrics({ policy: POLICY, candidate, previous }));
  assert.ok(blocked.includes("DAY_COVERAGE:7"));
});

// ---------------------------------------------------------------------------
// 전체 게이트: 결속·수집 오류
// ---------------------------------------------------------------------------
test("모든 조건이 맞으면 PASS 영수증이 후보·직전 원천·raw capture sha에 결속된다", () => {
  const input = gateInput();
  const receipt = evaluateItxPromotionGate(input);
  assert.equal(receipt.status, "PASS");
  assert.deepEqual(receipt.blockedCheckIds, []);
  assert.equal(receipt.policyId, ITX_PROMOTION_GATE_POLICY_ID);
  assert.equal(receipt.anomalyPolicyVersion, "itx-snapshot-anomaly-v1");
  assert.deepEqual(receipt.candidate, {
    artifactId: input.candidate.artifactId,
    sha256: input.candidateSha256,
    observedAt: input.candidate.observedAt,
    freshUntil: input.candidate.freshUntil,
  });
  assert.deepEqual(receipt.previous, { artifactId: input.previous.artifactId, sha256: input.previousSha256 });
  assert.deepEqual(receipt.source, {
    rawCaptureSha256: input.captureSha256,
    captureContentSha256: input.capture.contentSha256,
    replayEvidenceHash: input.replay.evidenceHash,
    providerRecordCount: 3,
  });
  assert.deepEqual(receipt.policy, POLICY);
  // 같은 입력은 같은 영수증이다.
  assert.deepEqual(evaluateItxPromotionGate(gateInput()), receipt);
});

test("직전 승인 원천이 없으면(bootstrap) 자동 승격하지 않는다", () => {
  const input = { ...gateInput(), previous: null, previousSha256: null };
  const receipt = evaluateItxPromotionGate(input);
  assert.equal(receipt.status, "BLOCK");
  assert.deepEqual(receipt.blockedCheckIds, ["PREVIOUS_APPROVED_SNAPSHOT_MISSING"]);
});

test("후보 결속이 하나라도 어긋나면 차단된다", () => {
  const cases = {
    "completeness sha": (input) => { input.completenessSha256 = sha256("other"); },
    "completeness artifact id": (input) => { input.completeness.sourceTimetableArtifact.artifactId = "itx-cheongchun-source-timetable-other"; },
    "candidate status": (input) => { input.candidate.validationStatus = "MISSING"; },
    "capture observedAt": (input) => { input.capture.observedAt = "2026-10-04T15:15:19.525Z"; },
    "capture service dates": (input) => { input.capture.selectedServiceDates = { ...input.capture.selectedServiceDates, "8": "20261007" }; },
    "raw capture sha": (input) => { input.captureSha256 = "not-a-sha"; },
    "replay mode": (input) => { input.replay.validationMode = "ADMISSION"; },
    "replay observedAt": (input) => { input.replay.observedAt = "2026-10-04T15:15:19.525Z"; },
    "replay timetable hash": (input) => { input.replay.serviceDays[1].timetable.evidenceHash = sha256("x"); },
    "replay roster hash": (input) => { input.replay.serviceDays[0].roster.evidenceHash = sha256("y"); },
    "replay missing day": (input) => { input.replay.serviceDays.pop(); },
    "lineage mismatch": (input) => { input.candidate.sourceLineage[2].timetableEvidenceHash = sha256("z"); },
  };
  for (const [name, mutate] of Object.entries(cases)) {
    const input = gateInput();
    mutate(input);
    const receipt = evaluateItxPromotionGate(input);
    assert.equal(receipt.status, "BLOCK", name);
    assert.ok(receipt.blockedCheckIds.some((id) => id.startsWith("SOURCE_BINDING")), name);
  }
});

test("수집 오류는 차단된다: 실패한 provider 응답·전송 실패·OD 미완료·day 실패", () => {
  const cases = {
    "http 500 record": (input) => { input.capture.records[1].outcome.response.status = 500; },
    "http 429 record": (input) => { input.capture.records[2].outcome.response.status = 429; },
    "transport failure": (input) => { input.capture.records[0].outcome = { kind: "TRANSPORT_FAILURE" }; },
    "failed od": (input) => { input.completeness.serviceDays[0].failedOdCount = 1; },
    "incomplete od": (input) => { input.completeness.serviceDays[1].completedOdCount = 305; },
    "day not supported": (input) => { input.completeness.serviceDays[2].status = "MISSING"; },
    "completeness not supported": (input) => { input.completeness.validationStatus = "MISSING"; },
    "completeness failure code": (input) => { input.completeness.failureReasonCode = "TAGO_REQUEST_FAILED"; },
  };
  for (const [name, mutate] of Object.entries(cases)) {
    const input = gateInput();
    mutate(input);
    const receipt = evaluateItxPromotionGate(input);
    assert.equal(receipt.status, "BLOCK", name);
    assert.ok(receipt.blockedCheckIds.some((id) => id.startsWith("FETCH_ERRORS")), name);
  }
});

test("지표 차단은 영수증 BLOCK으로 이어지고 차단된 check id가 남는다", () => {
  const input = gateInput({ mutate: ({ sets }) => { sets["8"] = daySets("8", { trains: 36 }); } });
  const receipt = evaluateItxPromotionGate(input);
  assert.equal(receipt.status, "BLOCK");
  assert.ok(receipt.blockedCheckIds.includes("TRIP_COUNT:8"));
  assert.ok(receipt.checks.find(({ id, dayCd }) => id === "TRIP_COUNT" && dayCd === "8").observed.delta === 4);
});

test("정책 한도를 넓히면 같은 입력이 통과한다 (한도가 판정을 실제로 정한다)", () => {
  const mutate = ({ sets }) => { sets["8"] = daySets("8", { trains: 36 }); };
  const blocked = evaluateItxPromotionGate(gateInput({ mutate }));
  assert.equal(blocked.status, "BLOCK");
  const widened = structuredClone(POLICY);
  widened.limits.tripCountDeltaPermille = 100;
  widened.limits.tripMembershipDeltaPermille = 100;
  widened.limits.timetableTupleRemovedPermille = 150;
  widened.limits.stopPatternChangedTripsPermille = 100;
  // 4편이 빠지면 막차도 앞당겨진다(합성 열차는 600초 간격).
  widened.limits.lastDepartureShiftSeconds = 2400;
  const passed = evaluateItxPromotionGate({ ...gateInput({ mutate }), policy: parseItxPromotionGatePolicy(widened) });
  assert.equal(passed.status, "PASS");
});

// ---------------------------------------------------------------------------
// 이력 재생: 실제 승인 원천 10개를 순서대로 비교한다. 정책 한도의 측정 근거다.
// ---------------------------------------------------------------------------
async function allSources() {
  const names = (await readdir(SOURCES)).filter((name) => /^itx-cheongchun-source-timetable-\d{17}\.json$/u.test(name)).sort();
  const sources = [];
  for (const name of names) sources.push(JSON.parse(await readFile(new URL(name, SOURCES), "utf8")));
  return sources.sort((left, right) => left.observedAt.localeCompare(right.observedAt));
}

// 정책 한도는 승인된 이력 앞쪽 snapshot(measuredBasis.snapshots개)에서 잰 값이다. 이후 자동 승격이 snapshot을 더해도 이 측정 근거는 바뀌지 않는다(#979).
async function historicalSources() {
  const sources = await allSources();
  assert.ok(sources.length >= POLICY.measuredBasis.snapshots, "측정 근거 snapshot이 모두 남아 있어야 한다");
  return sources.slice(0, POLICY.measuredBasis.snapshots);
}

test("측정 근거 이후의 snapshot은 모두 게이트 승격이고 영수증이 같이 커밋돼 있다", async () => {
  const later = (await allSources()).slice(POLICY.measuredBasis.snapshots);
  for (const source of later) {
    const receipt = JSON.parse(await readFile(new URL(`${source.artifactId}-promotion-gate.json`, SOURCES), "utf8"));
    assert.equal(receipt.artifactKind, "itx-promotion-gate-receipt");
    assert.equal(receipt.status, "PASS");
    assert.equal(receipt.candidate.artifactId, source.artifactId);
  }
});

test("이력 재생: 안정 구간은 통과하고 시각표가 흔들린 4개 구간은 차단된다", async () => {
  const sources = await historicalSources();
  assert.equal(sources.length, POLICY.measuredBasis.snapshots);
  const outcomes = [];
  for (let index = 1; index < sources.length; index += 1) {
    const checks = evaluateItxPromotionMetrics({ policy: POLICY, candidate: sources[index], previous: sources[index - 1] });
    outcomes.push({ id: sources[index].artifactId.slice(-17), blocked: blockedIds(checks) });
  }
  assert.equal(outcomes.length, POLICY.measuredBasis.transitions);
  const stable = outcomes.filter(({ blocked }) => blocked.length === 0).map(({ id }) => id);
  assert.deepEqual(stable, [
    "20260715112641542", "20260715152903681", "20260719230524758", "20260727071853886", "20261004151519524",
  ]);
  assert.equal(stable.length, POLICY.measuredBasis.stableTransitions);
  const changed = Object.fromEntries(outcomes.filter(({ blocked }) => blocked.length > 0).map(({ id, blocked }) => [id, blocked]));
  assert.deepEqual(Object.keys(changed), ["20260812165525800", "20260824170958799", "20260830151508786", "20260930163854026"]);
  assert.equal(Object.keys(changed).length, POLICY.measuredBasis.changedTransitions);
  // 편수·역·OD는 이력 전체에서 한 번도 흔들리지 않았다. 흔들린 것은 정차 순서와 시각 tuple뿐이다.
  for (const blocked of Object.values(changed)) {
    assert.ok(blocked.every((id) => /^(STOP_PATTERN|TUPLE_ADDED|TUPLE_REMOVED):/u.test(id)), blocked.join(","));
  }
  assert.ok(changed["20260812165525800"].includes("TUPLE_REMOVED:8"));
  assert.ok(changed["20260930163854026"].includes("STOP_PATTERN:8"));
  assert.ok(!changed["20260930163854026"].some((id) => id.endsWith(":7") || id.endsWith(":9")));
});

test("정책 measuredBasis는 이력에서 다시 계산한 값과 같다", async () => {
  const sources = await historicalSources();
  const observed = {
    stationSetDelta: 0, odSetDelta: 0, tripCountDelta: 0, tripMembershipDelta: 0, firstDepartureShiftSeconds: 0, lastDepartureShiftSeconds: 0,
  };
  const min = { stopPatternChangedTrips: Infinity, timetableTupleRemoved: Infinity, timetableTupleAdded: Infinity };
  for (let index = 1; index < sources.length; index += 1) {
    const checks = evaluateItxPromotionMetrics({ policy: POLICY, candidate: sources[index], previous: sources[index - 1] });
    for (const { id, observed: value } of checks) {
      if (id === "STATION_COVERAGE") observed.stationSetDelta = Math.max(observed.stationSetDelta, value.added + value.removed);
      if (id === "OD_COVERAGE") observed.odSetDelta = Math.max(observed.odSetDelta, value.added + value.removed);
      if (id === "TRIP_COUNT") observed.tripCountDelta = Math.max(observed.tripCountDelta, value.delta);
      if (id === "TRIP_MEMBERSHIP") observed.tripMembershipDelta = Math.max(observed.tripMembershipDelta, value.added, value.removed);
      if (id === "FIRST_DEPARTURE_SHIFT") observed.firstDepartureShiftSeconds = Math.max(observed.firstDepartureShiftSeconds, value.shiftSeconds);
      if (id === "LAST_DEPARTURE_SHIFT") observed.lastDepartureShiftSeconds = Math.max(observed.lastDepartureShiftSeconds, value.shiftSeconds);
      const ratio = (count, base) => Math.floor((count * 1000) / base);
      if (id === "STOP_PATTERN" && value.changed > 0) min.stopPatternChangedTrips = Math.min(min.stopPatternChangedTrips, ratio(value.changed, value.previous));
      if (id === "TUPLE_REMOVED" && value.count > 0) min.timetableTupleRemoved = Math.min(min.timetableTupleRemoved, ratio(value.count, value.previous));
      if (id === "TUPLE_ADDED" && value.count > 0) min.timetableTupleAdded = Math.min(min.timetableTupleAdded, ratio(value.count, value.previous));
    }
  }
  assert.deepEqual(observed, POLICY.measuredBasis.observedMax);
  assert.deepEqual(min, POLICY.measuredBasis.changedDayMinPermille);
  // 한도는 이력의 모든 0이 아닌 변화 아래에 있다: 한도 밑의 변화는 이력에 없다.
  assert.ok(POLICY.limits.stopPatternChangedTripsPermille < min.stopPatternChangedTrips);
  assert.ok(POLICY.limits.timetableTupleRemovedPermille < min.timetableTupleRemoved);
  assert.ok(POLICY.limits.timetableTupleAddedPermille < min.timetableTupleAdded);
  assert.ok(POLICY.limits.firstDepartureShiftSeconds >= observed.firstDepartureShiftSeconds);
  assert.ok(POLICY.limits.lastDepartureShiftSeconds >= observed.lastDepartureShiftSeconds);
});

// ---------------------------------------------------------------------------
// CLI: 파일을 읽어 영수증을 쓴다. 영수증은 한 번만 쓴다(wx).
// ---------------------------------------------------------------------------
async function cliFixture({ mutateCandidate = () => {}, previousShaOverride = null } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "itx-gate-cli-"));
  const sourceDir = path.join(dir, "tools/datapack/sources");
  await mkdir(sourceDir, { recursive: true });
  const previous = snapshot("previous", { observedAt: "2026-09-30T16:38:54.026Z", freshUntil: "2026-10-11T00:00:00+09:00" });
  const candidate = snapshot("candidate", { mutate: mutateCandidate });
  const bytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  const previousBytes = bytes(previous);
  const candidateBytes = bytes(candidate);
  const completeness = completenessFor(candidate);
  const completenessBytes = bytes(completeness);
  candidate.completenessEvidenceSha256 = sha256(completenessBytes);
  const reboundCandidateBytes = bytes(candidate);
  await writeFile(path.join(sourceDir, `${previous.artifactId}.json`), previousBytes);
  const contractPath = path.join(dir, "tools/datapack/itx-cheongchun-coverage-contract.json");
  await writeFile(contractPath, JSON.stringify({ sourceTimetableArtifact: {
    status: "ADMITTED", artifactId: previous.artifactId, artifactPath: `tools/datapack/sources/${previous.artifactId}.json`, sha256: previousShaOverride ?? sha256(previousBytes),
  } }));
  const recorder = createProviderResponseRecorder({
    fetchImpl: async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
    observedAt: candidate.observedAt,
    selectedServiceDates: candidate.selectedServiceDates,
  });
  await recorder.fetchImpl("https://apis.data.go.kr/B551457/run/v2/travelerTrainRunPlan2?serviceKey=SECRET&pageNo=1");
  const files = {
    candidate: path.join(dir, "candidate.json"),
    completeness: path.join(dir, "completeness.json"),
    capture: path.join(dir, "capture.json"),
    replay: path.join(dir, "replay.json"),
    "coverage-contract": contractPath,
    policy: path.join(repositoryRootForCli, "tools/datapack/itx-promotion-gate-policy.json"),
    output: path.join(dir, "receipt.json"),
  };
  await writeFile(files.candidate, reboundCandidateBytes);
  await writeFile(files.completeness, completenessBytes);
  await writeFile(files.capture, providerResponseCaptureBytes(recorder.captureArtifact()));
  await writeFile(files.replay, JSON.stringify(replayFor(candidate)));
  const argv = Object.entries(files).flatMap(([name, value]) => [`--${name}`, value]);
  return { dir, files, argv };
}
const repositoryRootForCli = path.resolve(import.meta.dirname, "../..");

test("CLI는 후보·직전 원천(coverage contract)·capture·replay·정책으로 영수증을 한 번만 쓴다", async () => {
  const fixture = await cliFixture();
  try {
    const receipt = await runItxPromotionGateCli({ argv: fixture.argv, repositoryRoot: fixture.dir });
    assert.equal(receipt.status, "PASS");
    const written = JSON.parse(await readFile(fixture.files.output, "utf8"));
    assert.deepEqual(written, receipt);
    assert.equal(receipt.source.providerRecordCount, 1);
    assert.equal(receipt.source.rawCaptureSha256, sha256(await readFile(fixture.files.capture)));
    assert.equal(JSON.stringify(written).includes("SECRET"), false);
    await assert.rejects(runItxPromotionGateCli({ argv: fixture.argv, repositoryRoot: fixture.dir }), /EEXIST/u);
  } finally {
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test("CLI는 차단돼도 영수증을 남기고 BLOCK을 돌려준다", async () => {
  const fixture = await cliFixture({ mutateCandidate: ({ sets }) => { sets["9"] = daySets("9", { trains: 48 }); } });
  try {
    const receipt = await runItxPromotionGateCli({ argv: fixture.argv, repositoryRoot: fixture.dir });
    assert.equal(receipt.status, "BLOCK");
    assert.ok(receipt.blockedCheckIds.includes("TRIP_COUNT:9"));
    assert.equal(JSON.parse(await readFile(fixture.files.output, "utf8")).status, "BLOCK");
  } finally {
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test("CLI는 직전 원천 sha가 contract와 다르거나 인자가 잘못되면 실패한다", async () => {
  const mismatched = await cliFixture({ previousShaOverride: "f".repeat(64) });
  try {
    await assert.rejects(runItxPromotionGateCli({ argv: mismatched.argv, repositoryRoot: mismatched.dir }), /ITX_PROMOTION_GATE_PREVIOUS_SHA256_MISMATCH/u);
  } finally {
    await rm(mismatched.dir, { recursive: true, force: true });
  }
  const fixture = await cliFixture();
  try {
    await assert.rejects(runItxPromotionGateCli({ argv: fixture.argv.slice(2), repositoryRoot: fixture.dir }), /ITX_PROMOTION_GATE_ARGUMENTS/u);
    await assert.rejects(runItxPromotionGateCli({ argv: [...fixture.argv, "--extra", "x"], repositoryRoot: fixture.dir }), /ITX_PROMOTION_GATE_ARGUMENTS/u);
    const relative = [...fixture.argv];
    relative[relative.indexOf("--candidate") + 1] = "candidate.json";
    await assert.rejects(runItxPromotionGateCli({ argv: relative, repositoryRoot: fixture.dir }), /ITX_PROMOTION_GATE_ARGUMENTS/u);
  } finally {
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 실행 파일: workflow는 종료 코드로 PASS(0)·BLOCK(3)·오류(1)를 가른다. 저장소의 현재 승인 원천을 직전 원천으로 쓴다.
// ---------------------------------------------------------------------------
const execFileAsync = promisify(execFile);

async function executableFixture({ mutate }) {
  const dir = await mkdtemp(path.join(tmpdir(), "itx-gate-exec-"));
  const contract = JSON.parse(await readFile(new URL("./itx-cheongchun-coverage-contract.json", import.meta.url), "utf8"));
  const reference = contract.sourceTimetableArtifact;
  const current = JSON.parse(await readFile(new URL(`../../${reference.artifactPath}`, import.meta.url), "utf8"));
  const completeness = JSON.parse(await readFile(new URL(`../../${reference.completenessEvidencePath}`, import.meta.url), "utf8"));
  const candidate = structuredClone(current);
  mutate(candidate);
  const candidateBytes = Buffer.from(`${JSON.stringify(candidate, null, 2)}\n`);
  const completenessBytes = Buffer.from(`${JSON.stringify(completeness, null, 2)}\n`);
  candidate.completenessEvidenceSha256 = sha256(completenessBytes);
  const reboundBytes = Buffer.from(`${JSON.stringify(candidate, null, 2)}\n`);
  const recorder = createProviderResponseRecorder({
    fetchImpl: async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
    observedAt: candidate.observedAt,
    selectedServiceDates: candidate.selectedServiceDates,
  });
  await recorder.fetchImpl("https://apis.data.go.kr/B551457/run/v2/travelerTrainRunPlan2?serviceKey=SECRET&pageNo=1");
  const replay = { ...completeness, validationMode: "REPLAY", evidenceHash: sha256("replay") };
  const files = {
    candidate: path.join(dir, "candidate.json"),
    completeness: path.join(dir, "completeness.json"),
    capture: path.join(dir, "capture.json"),
    replay: path.join(dir, "replay.json"),
    "coverage-contract": new URL("./itx-cheongchun-coverage-contract.json", import.meta.url).pathname,
    policy: new URL("./itx-promotion-gate-policy.json", import.meta.url).pathname,
    output: path.join(dir, "receipt.json"),
  };
  await writeFile(files.candidate, reboundBytes);
  await writeFile(files.completeness, completenessBytes);
  await writeFile(files.capture, providerResponseCaptureBytes(recorder.captureArtifact()));
  await writeFile(files.replay, JSON.stringify(replay));
  return { dir, files, argv: Object.entries(files).flatMap(([name, value]) => [`--${name}`, value]) };
}

async function runExecutable(argv) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [new URL("./itx-promotion-gate.mjs", import.meta.url).pathname, ...argv]);
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

test("실행 파일은 PASS면 0, BLOCK이면 3, 오류면 1로 끝나고 차단 코드를 stderr에 남긴다", async () => {
  const same = await executableFixture({ mutate: () => {} });
  try {
    const result = await runExecutable(same.argv);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /ITX promotion gate PASS: policy=itx-promotion-gate-v1/u);
    assert.equal(JSON.parse(await readFile(same.files.output, "utf8")).status, "PASS");
    const again = await runExecutable(same.argv);
    assert.equal(again.code, 1);
    assert.match(again.stderr, /EEXIST/u);
  } finally {
    await rm(same.dir, { recursive: true, force: true });
  }
  const blocked = await executableFixture({
    mutate: (candidate) => {
      const day = candidate.normalizedSnapshotSets.find(({ dayCd }) => dayCd === "8");
      day.sets.trainSet = day.sets.trainSet.slice(0, 30);
    },
  });
  try {
    const result = await runExecutable(blocked.argv);
    assert.equal(result.code, 3, result.stderr);
    assert.match(result.stderr, /ITX promotion gate BLOCK: .*blocked=.*TRIP_COUNT:8/u);
    assert.equal(JSON.parse(await readFile(blocked.files.output, "utf8")).status, "BLOCK");
  } finally {
    await rm(blocked.dir, { recursive: true, force: true });
  }
  const invalid = await runExecutable(["--candidate", "relative.json"]);
  assert.equal(invalid.code, 1);
  assert.match(invalid.stderr, /ITX_PROMOTION_GATE_ARGUMENTS/u);
});
