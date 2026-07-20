import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { gunzipSync } from "node:zlib";

import {
  buildItxSourceCandidate,
  collectKorailItxCheongchunCompleteness,
  collectKorailItxCheongchunPlan,
  collectKorailItxCheongchunTimetable,
  evaluateItxSnapshotAnomaly,
  materializeKorailItxRows,
  promoteItxSourceCandidate,
  runKorailItxCompletenessCli,
  validateKorailItxPlans,
} from "./collect-korail-itx-cheongchun-timetable.mjs";

const PACK_PATH = "apps/mobile/assets/datapacks/capital.sqlite.gz";
const PACK_BYTES = await readFile(PACK_PATH);
const PACK_SHA256 = createHash("sha256").update(PACK_BYTES).digest("hex");
const PACK_SQLITE_SHA256 = createHash("sha256").update(gunzipSync(PACK_BYTES)).digest("hex");
const YONGSAN_STATION_ID = "station-8aa315864466";
const CHUNCHEON_STATION_ID = "station-dd14cfb89cbc";
const CAPITAL_APPROACH_LINE_ID = "line-6e39be0cb6e2";
const GYEONGCHUN_LINE_ID = "line-54a7b980b7c3";
const LIVE_EVIDENCE = JSON.parse(await readFile(
  new URL("./sources/korail-itx-cheongchun-station-sequence-20260713.json", import.meta.url),
  "utf8",
));
const LIVE_TAGO_EVIDENCE = JSON.parse(await readFile(
  new URL("./sources/tago-itx-cheongchun-od-20260714.json", import.meta.url),
  "utf8",
));

function planRow(trainNumber, departure, arrival, departureAt, arrivalAt) {
  return {
    run_ymd: "20260713",
    trn_no: trainNumber,
    dptre_stn_cd: departure === "용산" ? "0104" : "140873",
    dptre_stn_nm: departure,
    arvl_stn_cd: arrival === "춘천" ? "140873" : "130126",
    arvl_stn_nm: arrival,
    trn_plan_dptre_dt: departureAt,
    trn_plan_arvl_dt: arrivalAt,
  };
}

function infoRow(trainNumber, sequence, stationCode, stationName, arrivalAt, departureAt, overrides = {}) {
  return {
    run_ymd: "20260713",
    trn_no: trainNumber,
    trn_run_sn: sequence,
    stn_cd: stationCode,
    stn_nm: stationName,
    mrnt_cd: "GJ",
    mrnt_nm: "경춘선",
    uppln_dn_se_cd: Number(trainNumber) % 2 === 0 ? "U" : "D",
    stop_se_cd: "11",
    stop_se_nm: "여객승하차",
    trn_dptre_dt: departureAt,
    trn_arvl_dt: arrivalAt,
    ...overrides,
  };
}

function apiResponse(rows, { totalCount = rows.length, pageNo = 1 } = {}) {
  return new Response(JSON.stringify({
    response: {
      header: { resultCode: "0", resultMsg: "NORMAL SERVICE." },
      body: {
        items: { item: rows },
        numOfRows: 1000,
        pageNo,
        totalCount,
      },
    },
  }), { status: 200, headers: { "content-type": "application/json" } });
}

function fixtureRows() {
  return {
    plans: [
      planRow("02001", "용산", "춘천", "20260713060000", "20260713080000"),
      planRow("02002", "춘천", "청량리", "20260713070000", "20260713090000"),
    ],
    info: [
      infoRow("02001", 1, "0104", "용산", "20260713060000", "20260713060000"),
      infoRow("02001", 2, "130126", "청량리", "20260713062000", "20260713062100"),
      infoRow("02001", 3, "140701", "평내호평", "20260713071000", "20260713071100"),
      infoRow("02001", 4, "140873", "춘천", "20260713080000", "-"),
      infoRow("02002", 1, "140873", "춘천", "20260713070000", "20260713070000"),
      infoRow("02002", 2, "140701", "평내호평", "20260713074800", "20260713074900"),
      infoRow("02002", 3, "130126", "청량리", "20260713090000", "20260713090000"),
    ],
  };
}

function trainNumberEvidence() {
  return {
    artifactKind: "tago-itx-cheongchun-roster-evidence",
    serviceId: "ITX_CHEONGCHUN",
    kricServiceDayCode: "8",
    serviceDate: "20260713",
    expectedOdCount: 2,
    completedOdCount: 2,
    failedOdCount: 0,
    stationSetHash: "b".repeat(64),
    odMatrixHash: "c".repeat(64),
    trainNumbers: ["02001", "02002"],
    itineraries: [
      {
        trainNumber: "02001",
        departureStationId: "station-b819702fa7d9",
        arrivalStationId: "station-dd14cfb89cbc",
        departureAt: "2026-07-13T06:21:00+09:00",
        arrivalAt: "2026-07-13T08:00:00+09:00",
      },
      {
        trainNumber: "02002",
        departureStationId: "station-dd14cfb89cbc",
        arrivalStationId: "station-b819702fa7d9",
        departureAt: "2026-07-13T07:00:00+09:00",
        arrivalAt: "2026-07-13T09:00:00+09:00",
      },
    ],
    evidenceHash: "a".repeat(64),
  };
}

function sourceCandidate(overrides = {}) {
  const dayCodes = ["8", "7", "9"];
  const dateByDay = { "8": "2026-07-16", "7": "2026-07-18", "9": "2026-07-19" };
  const stationRosters = dayCodes.map((dayCd) => ({
    dayCd,
    stations: [
      {
        canonicalStationId: YONGSAN_STATION_ID,
        providerStationId: "provider-a",
        providerStationName: "용산",
        nameKo: "용산",
        corridorSequence: 1,
        lineId: CAPITAL_APPROACH_LINE_ID,
      },
      {
        canonicalStationId: CHUNCHEON_STATION_ID,
        providerStationId: "provider-b",
        providerStationName: "춘천",
        nameKo: "춘천",
        corridorSequence: 27,
        lineId: GYEONGCHUN_LINE_ID,
      },
    ],
  }));
  const stationSequences = dayCodes.flatMap((dayCd) => [
    {
      dayCd,
      trainNumber: "2001",
      directionId: "up",
      originStationName: "용산",
      destinationStationName: "춘천",
      terminalVariant: "용산→춘천",
      observedOdCount: 1,
      stopCount: 2,
      conflictingTimestampCount: 0,
      missingPairCount: 0,
      duplicateOdCount: 0,
      stops: [
        { stationId: YONGSAN_STATION_ID, nameKo: "용산", corridorSequence: 1, lineId: CAPITAL_APPROACH_LINE_ID, arrivalAt: `${dateByDay[dayCd]}T08:00:00+09:00`, departureAt: `${dateByDay[dayCd]}T08:00:00+09:00`, arrivalSeconds: 28_800, departureSeconds: 28_800, stopSequence: 1 },
        { stationId: CHUNCHEON_STATION_ID, nameKo: "춘천", corridorSequence: 27, lineId: GYEONGCHUN_LINE_ID, arrivalAt: `${dateByDay[dayCd]}T09:00:00+09:00`, departureAt: `${dateByDay[dayCd]}T09:00:00+09:00`, arrivalSeconds: 32_400, departureSeconds: 32_400, stopSequence: 2 },
      ],
    },
    {
      dayCd,
      trainNumber: "2002",
      directionId: "down",
      originStationName: "춘천",
      destinationStationName: "용산",
      terminalVariant: "춘천→용산",
      observedOdCount: 1,
      stopCount: 2,
      conflictingTimestampCount: 0,
      missingPairCount: 0,
      duplicateOdCount: 0,
      stops: [
        { stationId: CHUNCHEON_STATION_ID, nameKo: "춘천", corridorSequence: 27, lineId: GYEONGCHUN_LINE_ID, arrivalAt: `${dateByDay[dayCd]}T10:00:00+09:00`, departureAt: `${dateByDay[dayCd]}T10:00:00+09:00`, arrivalSeconds: 36_000, departureSeconds: 36_000, stopSequence: 1 },
        { stationId: YONGSAN_STATION_ID, nameKo: "용산", corridorSequence: 1, lineId: CAPITAL_APPROACH_LINE_ID, arrivalAt: `${dateByDay[dayCd]}T11:00:00+09:00`, departureAt: `${dateByDay[dayCd]}T11:00:00+09:00`, arrivalSeconds: 39_600, departureSeconds: 39_600, stopSequence: 2 },
      ],
    },
  ]).sort((left, right) => left.dayCd.localeCompare(right.dayCd, "ko", { numeric: true })
    || left.trainNumber.localeCompare(right.trainNumber, "ko", { numeric: true }));
  const serviceIdByDay = { "8": "weekday-kric", "7": "saturday-kric", "9": "holiday-kric" };
  const transitTrips = dayCodes.flatMap((dayCd) => [
    {
      id: `route-line-54a7b980b7c3-up-2001-${dayCd}`,
      routeId: "route-line-54a7b980b7c3-up",
      serviceId: serviceIdByDay[dayCd],
      directionId: "up",
      servicePattern: "EXPRESS",
      tripHeadsign: "춘천",
    },
    {
      id: `route-line-54a7b980b7c3-down-2002-${dayCd}`,
      routeId: "route-line-54a7b980b7c3-down",
      serviceId: serviceIdByDay[dayCd],
      directionId: "down",
      servicePattern: "EXPRESS",
      tripHeadsign: "용산",
    },
  ]).sort((left, right) => left.id.localeCompare(right.id, "ko", { numeric: true }));
  const transitStopTimes = transitTrips.flatMap(({ id: tripId, directionId }) => directionId === "up" ? [
    { tripId, stopSequence: 1, stationId: YONGSAN_STATION_ID, lineId: CAPITAL_APPROACH_LINE_ID, arrivalSeconds: 28_800, departureSeconds: 28_800 },
    { tripId, stopSequence: 2, stationId: CHUNCHEON_STATION_ID, lineId: GYEONGCHUN_LINE_ID, arrivalSeconds: 32_400, departureSeconds: 32_400 },
  ] : [
    { tripId, stopSequence: 1, stationId: CHUNCHEON_STATION_ID, lineId: GYEONGCHUN_LINE_ID, arrivalSeconds: 36_000, departureSeconds: 36_000 },
    { tripId, stopSequence: 2, stationId: YONGSAN_STATION_ID, lineId: CAPITAL_APPROACH_LINE_ID, arrivalSeconds: 39_600, departureSeconds: 39_600 },
  ]);
  const normalizedSnapshotSets = dayCodes.map((dayCd) => ({
    dayCd,
    sets: {
      stationSet: [YONGSAN_STATION_ID, CHUNCHEON_STATION_ID].sort(),
      odSet: [[dayCd, "provider-a", "provider-b"], [dayCd, "provider-b", "provider-a"]],
      trainSet: ["2001", "2002"],
      stopSequenceSet: [
        [dayCd, "2001", "up", [YONGSAN_STATION_ID, CHUNCHEON_STATION_ID]],
        [dayCd, "2002", "down", [CHUNCHEON_STATION_ID, YONGSAN_STATION_ID]],
      ],
      timetableTupleSet: [
        [dayCd, "2001", YONGSAN_STATION_ID, 28_800, 28_800],
        [dayCd, "2001", CHUNCHEON_STATION_ID, 32_400, 32_400],
        [dayCd, "2002", CHUNCHEON_STATION_ID, 36_000, 36_000],
        [dayCd, "2002", YONGSAN_STATION_ID, 39_600, 39_600],
      ],
    },
  }));
  const candidate = {
    schemaVersion: 1,
    artifactKind: "itx-cheongchun-source-timetable",
    artifactId: "itx-cheongchun-source-timetable-20260715010000000",
    serviceId: "ITX_CHEONGCHUN",
    observedAt: "2026-07-15T01:00:00.000Z",
    freshUntil: "2026-07-20T00:00:00+09:00",
    policyVersion: "itx-snapshot-anomaly-v1",
    validationStatus: "SUPPORTED",
    promotionStatus: "BOOTSTRAP_REVIEW_REQUIRED",
    completenessEvidenceSha256: null,
    canonicalPackIdentity: { path: PACK_PATH, sha256: PACK_SHA256 },
    selectedServiceDates: { "8": "20260716", "7": "20260718", "9": "20260719" },
    sourceLineage: dayCodes.map((dayCd) => ({
      dayCd,
      rosterEvidenceHash: "a".repeat(64),
      timetableEvidenceHash: "b".repeat(64),
    })),
    stationRosters,
    stationSequences,
    transitTrips,
    transitStopTimes,
    warnings: [],
    normalizedSnapshotSets,
    snapshotDiff: {
      policyVersion: "itx-snapshot-anomaly-v1",
      threshold: "ZERO_TOLERANCE",
      status: "BOOTSTRAP_REVIEW_REQUIRED",
      previousArtifactSha256: null,
      serviceDays: [],
    },
    credentialRedacted: true,
    ...overrides,
  };
  candidate.completenessEvidenceSha256 = createHash("sha256")
    .update(completenessBytes(completenessForCandidate(candidate)))
    .digest("hex");
  candidate.evidenceHash = createHash("sha256").update(JSON.stringify(candidate)).digest("hex");
  return candidate;
}

function rehashCandidate(candidate) {
  const { evidenceHash: _, ...withoutEvidenceHash } = candidate;
  candidate.evidenceHash = createHash("sha256").update(JSON.stringify(withoutEvidenceHash)).digest("hex");
  return candidate;
}

function sourceBytes(candidate) {
  return `${JSON.stringify(candidate, null, 2)}\n`;
}

function completenessForCandidate(candidate, { warnings = candidate.warnings } = {}) {
  const serviceDays = ["8", "7", "9"].map((dayCd) => {
    const lineage = candidate.sourceLineage.find((row) => row.dayCd === dayCd);
    const dayWarnings = warnings.filter((warning) => warning.dayCd === dayCd);
    return {
      dayCd,
      serviceDate: candidate.selectedServiceDates[dayCd],
      status: "SUPPORTED",
      warnings: dayWarnings.map(({ code: _, dayCd: __, ...warning }) => warning),
      roster: {
        stations: candidate.stationRosters.find((row) => row.dayCd === dayCd).stations,
        trainNumbers: candidate.stationSequences
          .filter((row) => row.dayCd === dayCd)
          .map(({ trainNumber }) => trainNumber),
        evidenceHash: lineage.rosterEvidenceHash,
      },
      timetable: {
        stationSequences: candidate.stationSequences
          .filter((row) => row.dayCd === dayCd)
          .map(({ dayCd: _, ...sequence }) => sequence),
        transitTrips: candidate.transitTrips.filter(({ id }) => id.endsWith(`-${dayCd}`)),
        transitStopTimes: candidate.transitStopTimes.filter(({ tripId }) => tripId.endsWith(`-${dayCd}`)),
        korailPlanCorroboration: {
          missingTrainNumbers: dayWarnings.map(({ trainNumber }) => trainNumber),
        },
        evidenceHash: lineage.timetableEvidenceHash,
      },
    };
  });
  const completeness = {
    schemaVersion: 2,
    artifactKind: "korail-itx-cheongchun-completeness-evidence",
    serviceId: "ITX_CHEONGCHUN",
    observedAt: candidate.observedAt,
    timezone: "Asia/Seoul",
    validationMode: "ADMISSION",
    selectedServiceDates: candidate.selectedServiceDates,
    validationStatus: "SUPPORTED",
    admissionStatus: candidate.promotionStatus,
    admissionEligible: false,
    serviceDays,
    snapshotDiff: candidate.snapshotDiff,
    sourceTimetableArtifact: {
      status: candidate.promotionStatus,
      artifactId: candidate.artifactId,
      policyVersion: candidate.policyVersion,
      freshUntil: candidate.freshUntil,
    },
    materialization: { status: "SUPPORTED" },
    credentialRedacted: true,
  };
  completeness.evidenceHash = createHash("sha256").update(JSON.stringify(completeness)).digest("hex");
  return completeness;
}

function completenessBytes(completeness) {
  return `${JSON.stringify(completeness, null, 2)}\n`;
}

async function writeCandidateCompleteness(candidatePath, candidate, options) {
  const completenessPath = `${candidatePath}.completeness.json`;
  await writeFile(completenessPath, completenessBytes(completenessForCandidate(candidate, options)));
  return completenessPath;
}

function bindCandidateCompleteness(candidate, options) {
  const completeness = completenessForCandidate(candidate, options);
  candidate.completenessEvidenceSha256 = createHash("sha256")
    .update(completenessBytes(completeness))
    .digest("hex");
  rehashCandidate(candidate);
  return completeness;
}

async function writeAdmittedSourceBundle(sourceDir, candidate) {
  const completeness = bindCandidateCompleteness(candidate);
  const sourceBytesValue = sourceBytes(candidate);
  const completenessBytesValue = completenessBytes(completeness);
  const artifactPath = `tools/datapack/sources/${candidate.artifactId}.json`;
  const completenessEvidencePath = `tools/datapack/sources/${candidate.artifactId}-completeness-evidence.json`;
  await Promise.all([
    writeFile(path.join(sourceDir, `${candidate.artifactId}.json`), sourceBytesValue),
    writeFile(path.join(sourceDir, `${candidate.artifactId}-completeness-evidence.json`), completenessBytesValue),
  ]);
  return {
    reference: {
      status: "ADMITTED",
      admissionEligible: true,
      artifactId: candidate.artifactId,
      artifactPath,
      sha256: createHash("sha256").update(sourceBytesValue).digest("hex"),
      completenessEvidencePath,
      completenessEvidenceSha256: createHash("sha256").update(completenessBytesValue).digest("hex"),
      schemaVersion: 1,
      freshUntil: candidate.freshUntil,
      policyVersion: "itx-snapshot-anomaly-v1",
    },
  };
}

function ownerApproval(candidate) {
  const digest = createHash("sha256").update(sourceBytes(candidate)).digest("hex");
  return {
    approvedSha256: digest,
    approvalUrl: "https://github.com/AquilaXk/easysubway/issues/2135#issuecomment-123",
    fetchImpl: async () => new Response(JSON.stringify({
      author_association: "OWNER",
      html_url: "https://github.com/AquilaXk/easysubway/issues/2135#issuecomment-123",
      body: `/approve-itx-bootstrap artifactId=${candidate.artifactId} sha256=${digest} policy=itx-snapshot-anomaly-v1`,
      created_at: "2026-07-15T01:30:00.000Z",
    }), { status: 200, headers: { "content-type": "application/json" } }),
  };
}

const STALE_PIN_SHA256 = "1".repeat(64);
const STALE_PIN_SQLITE_SHA256 = "2".repeat(64);

function stalePin(overrides = {}) {
  return {
    id: "capital",
    sourceIssue: 2097,
    sha256: STALE_PIN_SHA256,
    sqliteSha256: STALE_PIN_SQLITE_SHA256,
    ...overrides,
  };
}

function shippedPackTopologyEvidence(overrides = {}) {
  return {
    schemaVersion: 1,
    artifactKind: "itx-cheongchun-mobile-topology-evidence",
    serviceId: "ITX_CHEONGCHUN",
    sourceIssue: 2135,
    topology: { sha256: "d".repeat(64) },
    pack: {
      id: "capital",
      outputSha256: PACK_SHA256,
      outputSqliteSha256: PACK_SQLITE_SHA256,
      byteSize: PACK_BYTES.length,
      ...(overrides.pack ?? {}),
    },
    ...overrides.top,
  };
}

// UNCHANGED_AUTO 승격 흐름을 구성하고 promote한 뒤, 결과 contract를 반환한다.
// topologyEvidence === null이면 topology evidence 파일을 생성하지 않는다.
async function promoteUnchangedWithPin({ pin, topologyEvidence }) {
  const dir = await mkdtemp(path.join(tmpdir(), "itx-pin-correction-"));
  try {
    const sourceDir = path.join(dir, "tools/datapack/sources");
    await mkdir(sourceDir, { recursive: true });
    const previous = sourceCandidate({
      artifactId: "itx-cheongchun-source-timetable-20260714010000000",
      promotionStatus: "SUPPORTED",
    });
    const { reference: previousReference } = await writeAdmittedSourceBundle(sourceDir, previous);
    const previousSha = previousReference.sha256;
    const contractExtras = { sourceTimetableArtifact: previousReference };
    if (pin !== undefined) {
      contractExtras.officialEvidence = { korailCompletenessAdmission: { canonicalPackIdentity: pin } };
    }
    const contractPath = await writeCoverageContract(dir, JSON.stringify(contractExtras));
    if (topologyEvidence !== null) {
      await writeFile(
        path.join(dir, "tools/datapack/itx-cheongchun-topology-evidence.json"),
        `${JSON.stringify(topologyEvidence, null, 2)}\n`,
      );
    }
    const candidate = sourceCandidate({ promotionStatus: "SUPPORTED" });
    candidate.snapshotDiff = unchangedSnapshotDiff(previousSha, candidate.normalizedSnapshotSets);
    bindCandidateCompleteness(candidate);
    const completeness = completenessForCandidate(candidate);
    const candidatePath = path.join(dir, "candidate.json");
    const completenessPath = path.join(dir, "completeness.json");
    await Promise.all([
      writeFile(candidatePath, sourceBytes(candidate)),
      writeFile(completenessPath, completenessBytes(completeness)),
    ]);
    const promoted = await promoteItxSourceCandidate({
      candidatePath,
      completenessPath,
      sourceOutputDir: sourceDir,
      coverageContractPath: contractPath,
      repositoryRoot: dir,
      now: new Date("2026-07-15T02:00:00.000Z"),
    });
    return { promoted, contract: JSON.parse(await readFile(contractPath, "utf8")) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function writeCoverageContract(repositoryRoot, contents) {
  const packPath = path.join(repositoryRoot, PACK_PATH);
  await mkdir(path.dirname(packPath), { recursive: true });
  await writeFile(packPath, PACK_BYTES);
  const contractPath = path.join(
    repositoryRoot,
    "tools/datapack/itx-cheongchun-coverage-contract.json",
  );
  await mkdir(path.dirname(contractPath), { recursive: true });
  const contract = {
    schemaVersion: 2,
    artifactKind: "itx-cheongchun-coverage-contract",
    serviceId: "ITX_CHEONGCHUN",
    canonicalLineId: "line-54a7b980b7c3",
    completenessAdmission: {
      snapshotAnomalyPolicy: { policyId: "itx-snapshot-anomaly-v1" },
    },
    ...JSON.parse(contents),
  };
  await writeFile(contractPath, `${JSON.stringify(contract, null, 2)}\n`);
  return contractPath;
}

function unchangedSnapshotDiff(previousArtifactSha256, normalizedSnapshotSets) {
  const names = ["stationSet", "odSet", "trainSet", "stopSequenceSet", "timetableTupleSet"];
  return {
    policyVersion: "itx-snapshot-anomaly-v1",
    threshold: "ZERO_TOLERANCE",
    status: "SUPPORTED",
    previousArtifactSha256,
    serviceDays: normalizedSnapshotSets.map(({ dayCd, sets }) => ({
      dayCd,
      blocked: false,
      sets: Object.fromEntries(names.map((name) => {
        const values = sets[name].map((value) => JSON.stringify(value)).sort().map(JSON.parse);
        return [name, {
          count: values.length,
          added: [],
          removed: [],
          sha256: createHash("sha256").update(JSON.stringify(values)).digest("hex"),
        }];
      })),
    })),
  };
}

test("ITX completeness는 dayCd 8/7/9를 독립 수집해 하나의 admission artifact로 묶는다", async () => {
  const calls = [];
  const corridorInputs = [];
  const requestBudgets = [];
  const artifact = await collectKorailItxCheongchunCompleteness({
    serviceKey: "secret",
    serviceDates: { "8": "20260715", "7": "20260718", "9": "20260719" },
    packPath: PACK_PATH,
    now: new Date("2026-07-14T00:00:00.000Z"),
    collectRosterImpl: async ({ serviceDate, kricServiceDayCode, canonicalStations, requestBudget }) => {
      corridorInputs.push(canonicalStations);
      requestBudgets.push(requestBudget);
      return { ...trainNumberEvidence(), serviceDate, kricServiceDayCode };
    },
    collectTimetableImpl: async ({ runDate, kricServiceDayCode }) => {
      calls.push([kricServiceDayCode, runDate]);
      return {
        runDate,
        kricServiceDayCode,
        materialization: { status: "SUPPORTED" },
        legacyDaejeonRowCount: 0,
        legacyYongsanDaejeonTripCount: 0,
        credentialRedacted: true,
      };
    },
  });

  assert.deepEqual(calls, [["8", "20260715"], ["7", "20260718"], ["9", "20260719"]]);
  assert.equal(corridorInputs.length, 3);
  assert.equal(new Set(requestBudgets).size, 1);
  assert.deepEqual(requestBudgets[0], { limit: 10_000, remaining: 10_000 });
  assert.equal(corridorInputs[0].length, 28);
  assert.deepEqual(corridorInputs[0].slice(0, 3), [
    { canonicalStationId: "station-8aa315864466", nameKo: "용산", corridorSequence: 1, lineId: "line-6e39be0cb6e2" },
    { canonicalStationId: "station-c0679b9a6cf8", nameKo: "옥수", corridorSequence: 2, lineId: "line-6e39be0cb6e2" },
    { canonicalStationId: "station-e5cf592cf355", nameKo: "왕십리", corridorSequence: 3, lineId: "line-6e39be0cb6e2" },
  ]);
  assert.deepEqual(corridorInputs[0].slice(3).map(({ corridorSequence }) => corridorSequence), [
    4, 5, 6, 7, 8, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27,
  ]);
  assert.deepEqual(artifact.selectedServiceDates, { "8": "20260715", "7": "20260718", "9": "20260719" });
  assert.equal(artifact.validationStatus, "SUPPORTED");
  assert.equal(artifact.admissionStatus, "BOOTSTRAP_REVIEW_REQUIRED");
  assert.equal(artifact.admissionEligible, false);
  assert.equal(artifact.snapshotDiff.status, "BOOTSTRAP_REVIEW_REQUIRED");
  assert.equal(artifact.snapshotDiff.policyVersion, "itx-snapshot-anomaly-v1");
  assert.equal(artifact.sourceTimetableArtifact.status, "BOOTSTRAP_REVIEW_REQUIRED");
  assert.deepEqual(artifact.allowedConsumerIssues, ["#2145", "#1400", "#2098", "#2099", "#2058", "#2137"]);
  assert.equal(artifact.serviceDays.length, 3);
  assert.match(artifact.evidenceHash, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(artifact), /secret/);
});

test("ITX snapshot anomaly gate는 동일 집합을 통과시키고 열차 소실을 차단한다", () => {
  const day = (dayCd, trainNumbers = ["2001", "2002"]) => ({
    dayCd,
    status: "SUPPORTED",
    expectedOdCount: 306,
    stationSetHash: "a".repeat(64),
    trainSetHashes: { materialized: createHash("sha256").update(JSON.stringify(trainNumbers)).digest("hex") },
    roster: {
      stations: [
        { canonicalStationId: "station-a" },
        { canonicalStationId: "station-b" },
      ],
      trainNumbers,
    },
  });
  const previousArtifact = {
    artifactKind: "korail-itx-cheongchun-completeness-evidence",
    admissionStatus: "ADMITTED",
    admissionEligible: true,
    evidenceHash: "f".repeat(64),
    serviceDays: [day("8"), day("7"), day("9")],
  };

  const unchanged = evaluateItxSnapshotAnomaly({
    serviceDays: [day("8"), day("7"), day("9")],
    previousArtifact,
  });
  assert.equal(unchanged.status, "SUPPORTED");
  assert.equal(unchanged.serviceDays.every(({ blocked }) => blocked === false), true);

  const missingTrain = evaluateItxSnapshotAnomaly({
    serviceDays: [day("8", ["2001"]), day("7"), day("9")],
    previousArtifact,
  });
  assert.equal(missingTrain.status, "CHANGE_REVIEW_REQUIRED");
  assert.deepEqual(missingTrain.serviceDays[0].sets.trainSet.removed, ["2002"]);
  assert.equal(missingTrain.serviceDays[0].blocked, true);
});

test("ITX snapshot anomaly gate는 canonical-provider 역 매핑 교환을 차단한다", () => {
  const previousArtifact = sourceCandidate({ promotionStatus: "SUPPORTED" });
  const serviceDays = ["8", "7", "9"].map((dayCd) => ({
    dayCd,
    roster: {
      stations: structuredClone(previousArtifact.stationRosters.find((row) => row.dayCd === dayCd).stations),
      trainNumbers: ["2001", "2002"],
    },
    timetable: {
      stationSequences: previousArtifact.stationSequences.filter((row) => row.dayCd === dayCd),
    },
  }));
  const swapped = serviceDays[0].roster.stations;
  [swapped[0].providerStationId, swapped[1].providerStationId]
    = [swapped[1].providerStationId, swapped[0].providerStationId];

  const result = evaluateItxSnapshotAnomaly({ serviceDays, previousArtifact });

  assert.equal(result.status, "CHANGE_REVIEW_REQUIRED");
  assert.equal(result.serviceDays[0].blocked, true);
  assert.equal(result.serviceDays[0].sets.stationSet.added.length, 2);
  assert.equal(result.serviceDays[0].sets.stationSet.removed.length, 2);
});

test("ITX completeness는 이전 ADMITTED snapshot의 열차 소실을 SNAPSHOT_DIFF에서 차단한다", async () => {
  const serviceDates = { "8": "20260715", "7": "20260718", "9": "20260719" };
  const collectTimetableImpl = async () => ({
    materialization: { status: "SUPPORTED" },
    legacyDaejeonRowCount: 0,
    legacyYongsanDaejeonTripCount: 0,
  });
  const baseline = await collectKorailItxCheongchunCompleteness({
    serviceKey: "key", serviceDates, packPath: PACK_PATH,
    now: new Date("2026-07-14T00:00:00.000Z"),
    collectRosterImpl: async ({ serviceDate, kricServiceDayCode }) => ({
      ...trainNumberEvidence(), serviceDate, kricServiceDayCode,
    }),
    collectTimetableImpl,
  });
  const blocked = await collectKorailItxCheongchunCompleteness({
    serviceKey: "key", serviceDates, packPath: PACK_PATH,
    now: new Date("2026-07-14T01:00:00.000Z"),
    previousAdmittedArtifact: { ...baseline, admissionStatus: "ADMITTED", admissionEligible: true },
    collectRosterImpl: async ({ serviceDate, kricServiceDayCode }) => ({
      ...trainNumberEvidence(),
      serviceDate,
      kricServiceDayCode,
      trainNumbers: kricServiceDayCode === "8" ? ["02001"] : ["02001", "02002"],
    }),
    collectTimetableImpl,
  });

  assert.equal(blocked.validationStatus, "SUPPORTED");
  assert.equal(blocked.admissionStatus, "CHANGE_REVIEW_REQUIRED");
  assert.equal(blocked.admissionEligible, false);
  assert.equal(blocked.failureStage, "SNAPSHOT_DIFF");
  assert.equal(blocked.failureReasonCode, "SNAPSHOT_ANOMALY_BLOCKED");
  assert.deepEqual(blocked.snapshotDiff.serviceDays[0].sets.trainSet.removed, ["2002"]);
});

test("ITX completeness는 partial day·replay·provider 오류를 admission하지 않는다", async (context) => {
  const serviceDates = { "8": "20260715", "7": "20260718", "9": "20260719" };
  const roster = async ({ serviceDate, kricServiceDayCode }) => ({
    ...trainNumberEvidence(), serviceDate, kricServiceDayCode,
  });

  await context.test("한 날짜 MISSING", async () => {
    const artifact = await collectKorailItxCheongchunCompleteness({
      serviceKey: "key", serviceDates, packPath: PACK_PATH,
      now: new Date("2026-07-14T00:00:00.000Z"), collectRosterImpl: roster,
      collectTimetableImpl: async ({ kricServiceDayCode }) => ({
        materialization: { status: kricServiceDayCode === "7" ? "MISSING_STATION_TIMES" : "SUPPORTED" },
        legacyDaejeonRowCount: 0,
        legacyYongsanDaejeonTripCount: 0,
      }),
    });
    assert.equal(artifact.admissionStatus, "MISSING");
    assert.equal(artifact.admissionEligible, false);
    assert.equal(artifact.serviceDays.length, 3);
    assert.equal(artifact.serviceDays[1].failureStage, "PLAN_CORROBORATION");
    assert.equal(artifact.serviceDays[1].failureReasonCode, "PLANNED_TIME_MISSING");
  });

  await context.test("replay", async () => {
    const artifact = await collectKorailItxCheongchunCompleteness({
      serviceKey: "key",
      serviceDates: { "8": "20260713", "7": "20260711", "9": "20260712" },
      packPath: PACK_PATH,
      now: new Date("2026-07-14T00:00:00.000Z"), replay: true, collectRosterImpl: roster,
      collectTimetableImpl: async () => ({
        materialization: { status: "SUPPORTED" },
        legacyDaejeonRowCount: 0,
        legacyYongsanDaejeonTripCount: 0,
      }),
    });
    assert.equal(artifact.admissionStatus, "REPLAY_ONLY");
    assert.equal(artifact.admissionEligible, false);
  });

  await context.test("provider 오류", async () => {
    const attemptedDates = [];
    const artifact = await collectKorailItxCheongchunCompleteness({
      serviceKey: "key", serviceDates, packPath: PACK_PATH,
      now: new Date("2026-07-14T00:00:00.000Z"),
      collectRosterImpl: async ({ serviceDate }) => {
        attemptedDates.push(serviceDate);
        throw new Error("TAGO GetStrtpntAlocFndTrainInfo HTTP 503");
      },
      collectTimetableImpl: async () => assert.fail("must not run"),
    });
    assert.equal(artifact.admissionStatus, "MISSING");
    assert.equal(artifact.admissionEligible, false);
    assert.equal(artifact.serviceDays[0].failureStage, "ROSTER");
    assert.equal(artifact.serviceDays[0].failureReasonCode, "PROVIDER_HTTP_FAILURE");
    assert.deepEqual(attemptedDates, ["20260715", "20260718", "20260719"]);
    assert.equal(artifact.serviceDays.length, 3);
    assert.doesNotMatch(JSON.stringify(artifact), /503/);
  });

  await context.test("OD 일부 실패", async () => {
    const artifact = await collectKorailItxCheongchunCompleteness({
      serviceKey: "key", serviceDates, packPath: PACK_PATH,
      now: new Date("2026-07-14T00:00:00.000Z"),
      collectRosterImpl: async ({ serviceDate, kricServiceDayCode }) => ({
        ...trainNumberEvidence(), serviceDate, kricServiceDayCode,
        completedOdCount: 1,
        failedOdCount: 1,
        failedOds: [{
          departureStationId: "station-a",
          arrivalStationId: "station-b",
          reasonCode: "PROVIDER_HTTP_FAILURE",
          failureContext: "operation=GetStrtpntAlocFndTrainInfo,httpStatus=503",
        }],
      }),
      collectTimetableImpl: async () => assert.fail("must not run"),
    });
    assert.equal(artifact.serviceDays[0].failureReasonCode, "OD_MATRIX_INCOMPLETE");
    assert.equal(artifact.serviceDays[0].completedOdCount, 1);
    assert.equal(artifact.serviceDays[0].failedOdCount, 1);
    assert.equal(artifact.admissionStatus, "MISSING");
    assert.equal(
      artifact.serviceDays[0].failureContext,
      "operation=GetStrtpntAlocFndTrainInfo,httpStatus=503,departureStationId=station-a,arrivalStationId=station-b",
    );
  });

  await context.test("OD materialization 실패 evidence 보존", async () => {
    const partialRoster = {
      ...trainNumberEvidence(),
      schemaVersion: 2,
      expectedOdCount: 6,
      completedOdCount: 6,
      failedOdCount: 0,
      credentialRedacted: true,
      reconstructionSummary: {
        trainCount: 1,
        stopCount: 0,
        conflictingTimestampCount: 1,
        missingPairCount: 0,
        duplicateOdCount: 0,
      },
    };
    const artifact = await collectKorailItxCheongchunCompleteness({
      serviceKey: "key", serviceDates, packPath: PACK_PATH,
      now: new Date("2026-07-14T00:00:00.000Z"),
      collectRosterImpl: async ({ serviceDate, kricServiceDayCode }) => {
        const error = new Error("TAGO_OD_TIME_CONFLICT: 2001");
        error.rosterEvidence = { ...partialRoster, serviceDate, kricServiceDayCode };
        throw error;
      },
      collectTimetableImpl: async () => assert.fail("must not run"),
    });
    assert.equal(artifact.serviceDays[0].failureReasonCode, "TAGO_OD_TIME_CONFLICT");
    assert.equal(artifact.serviceDays[0].failureStage, "OD_MATERIALIZATION");
    assert.equal(artifact.serviceDays[0].expectedOdCount, 6);
    assert.equal(artifact.serviceDays[0].completedOdCount, 6);
    assert.equal(artifact.serviceDays[0].roster.serviceDate, "20260715");
    assert.equal(artifact.serviceDays[0].roster.expectedOdCount, 6);
    assert.equal(artifact.serviceDays[0].reconstructionSummary.conflictingTimestampCount, 1);
  });

  await context.test("quota exhaustion은 OD materialization 단계로 기록", async () => {
    const artifact = await collectKorailItxCheongchunCompleteness({
      serviceKey: "key", serviceDates, packPath: PACK_PATH,
      now: new Date("2026-07-14T00:00:00.000Z"),
      collectRosterImpl: async () => { throw new Error("TAGO_QUOTA_BUDGET_EXHAUSTED"); },
      collectTimetableImpl: async () => assert.fail("must not run"),
    });
    assert.equal(artifact.serviceDays[0].failureReasonCode, "TAGO_QUOTA_BUDGET_EXHAUSTED");
    assert.equal(artifact.serviceDays[0].failureStage, "OD_MATERIALIZATION");
  });

  await context.test("불완전한 OD count는 OD materialization 단계로 기록", async () => {
    const artifact = await collectKorailItxCheongchunCompleteness({
      serviceKey: "key", serviceDates, packPath: PACK_PATH,
      now: new Date("2026-07-14T00:00:00.000Z"),
      collectRosterImpl: async ({ serviceDate, kricServiceDayCode }) => ({
        ...trainNumberEvidence(),
        schemaVersion: 2,
        serviceDate,
        kricServiceDayCode,
        expectedOdCount: 6,
        completedOdCount: 5,
        failedOdCount: 1,
      }),
      collectTimetableImpl: async () => assert.fail("must not run"),
    });
    assert.equal(artifact.serviceDays[0].failureStage, "OD_MATERIALIZATION");
  });

  await context.test("KORAIL plan duplicate context", async () => {
    const artifact = await collectKorailItxCheongchunCompleteness({
      serviceKey: "key", serviceDates, packPath: PACK_PATH,
      now: new Date("2026-07-14T00:00:00.000Z"), collectRosterImpl: roster,
      collectTimetableImpl: async () => { throw new Error("KORAIL_PLAN_DUPLICATE: 2041"); },
    });
    assert.equal(artifact.serviceDays[0].failureStage, "PLAN_CORROBORATION");
    assert.equal(artifact.serviceDays[0].failureReasonCode, "KORAIL_PLAN_DUPLICATE");
    assert.equal(artifact.serviceDays[0].failureContext, "reason=KORAIL_PLAN_DUPLICATE,trainNumber=2041");
    assert.equal(artifact.serviceDays[0].korailPlanSummary.duplicateCount, 1);
    assert.equal(artifact.serviceDays[0].korailPlanSummary.mismatchCount, 0);
  });

  await context.test("KORAIL plan mismatch summary", async () => {
    const artifact = await collectKorailItxCheongchunCompleteness({
      serviceKey: "key", serviceDates, packPath: PACK_PATH,
      now: new Date("2026-07-14T00:00:00.000Z"), collectRosterImpl: roster,
      collectTimetableImpl: async () => { throw new Error("KORAIL_PLAN_MISMATCH: 2041"); },
    });
    assert.equal(artifact.serviceDays[0].failureReasonCode, "KORAIL_PLAN_MISMATCH");
    assert.equal(artifact.serviceDays[0].korailPlanSummary.duplicateCount, 0);
    assert.equal(artifact.serviceDays[0].korailPlanSummary.mismatchCount, 1);
  });

  await context.test("station mapping 오류", async () => {
    const artifact = await collectKorailItxCheongchunCompleteness({
      serviceKey: "key", serviceDates, packPath: PACK_PATH,
      now: new Date("2026-07-14T00:00:00.000Z"),
      collectRosterImpl: async () => { throw new Error("TAGO station mapping is missing or ambiguous: 갈매"); },
      collectTimetableImpl: async () => assert.fail("must not run"),
    });
    assert.equal(artifact.serviceDays[0].failureReasonCode, "STATION_MAPPING_INCOMPLETE");
    assert.equal(artifact.serviceDays[0].failureContext, "갈매");
  });

  await context.test("필수 station mapping 오류는 누락 역 이름을 보존", async () => {
    const artifact = await collectKorailItxCheongchunCompleteness({
      serviceKey: "key", serviceDates, packPath: PACK_PATH,
      now: new Date("2026-07-14T00:00:00.000Z"),
      collectRosterImpl: async () => {
        throw new Error("TAGO required station mapping is incomplete: 옥수,왕십리");
      },
      collectTimetableImpl: async () => assert.fail("must not run"),
    });
    assert.equal(artifact.serviceDays[0].failureReasonCode, "STATION_MAPPING_INCOMPLETE");
    assert.equal(artifact.serviceDays[0].failureContext, "missingStations=옥수,왕십리");
  });

  await context.test("TAGO schema 오류 context", async () => {
    const artifact = await collectKorailItxCheongchunCompleteness({
      serviceKey: "key", serviceDates, packPath: PACK_PATH,
      now: new Date("2026-07-14T00:00:00.000Z"),
      collectRosterImpl: async () => {
        throw new Error("TAGO GetVhcleKndList schema mismatch: totalCount bodyFields=items,numOfRows,pageNo");
      },
      collectTimetableImpl: async () => assert.fail("must not run"),
    });
    assert.equal(artifact.serviceDays[0].failureReasonCode, "PROVIDER_SCHEMA_FAILURE");
    assert.equal(
      artifact.serviceDays[0].failureContext,
      "operation=GetVhcleKndList,reason=schema_mismatch,totalCount,bodyFields=items,numOfRows,pageNo",
    );
  });

  await context.test("TAGO invalid JSON schema 오류 context", async () => {
    const artifact = await collectKorailItxCheongchunCompleteness({
      serviceKey: "key", serviceDates, packPath: PACK_PATH,
      now: new Date("2026-07-14T00:00:00.000Z"),
      collectRosterImpl: async () => {
        throw new Error("TAGO GetVhcleKndList schema mismatch: invalid JSON");
      },
      collectTimetableImpl: async () => assert.fail("must not run"),
    });
    assert.equal(artifact.serviceDays[0].failureReasonCode, "PROVIDER_SCHEMA_FAILURE");
    assert.equal(
      artifact.serviceDays[0].failureContext,
      "operation=GetVhcleKndList,reason=schema_mismatch,invalid-json",
    );
  });

  await context.test("canonical passenger-stop mapping 오류", async () => {
    const artifact = await collectKorailItxCheongchunCompleteness({
      serviceKey: "key", serviceDates, packPath: PACK_PATH,
      now: new Date("2026-07-14T00:00:00.000Z"), collectRosterImpl: roster,
      collectTimetableImpl: async () => {
        throw new Error("Korail ITX passenger stop canonical mapping missing: 2001/UNKNOWN");
      },
    });
    assert.equal(artifact.serviceDays[0].failureReasonCode, "CANONICAL_STATION_MAPPING_INCOMPLETE");
  });

  await context.test("timetable 오류에도 완료된 OD evidence를 보존", async () => {
    const artifact = await collectKorailItxCheongchunCompleteness({
      serviceKey: "key", serviceDates, packPath: PACK_PATH,
      now: new Date("2026-07-14T00:00:00.000Z"), collectRosterImpl: roster,
      collectTimetableImpl: async () => {
        throw new Error(
          "Korail train operation API pagination incomplete: " +
          "operation=travelerTrainRunInfo2,collected=1000,total=1500,pages=2",
        );
      },
    });
    assert.equal(artifact.serviceDays[0].failureStage, "PLAN_CORROBORATION");
    assert.equal(artifact.serviceDays[0].expectedOdCount, 2);
    assert.equal(artifact.serviceDays[0].completedOdCount, 2);
    assert.equal(artifact.serviceDays[0].failedOdCount, 0);
    assert.equal(artifact.serviceDays[0].stationSetHash, "b".repeat(64));
    assert.equal(artifact.serviceDays[0].odMatrixHash, "c".repeat(64));
    assert.equal(artifact.serviceDays[0].roster.evidenceHash, "a".repeat(64));
    assert.equal(
      artifact.serviceDays[0].failureContext,
      "operation=travelerTrainRunInfo2,collected=1000,total=1500,pages=2",
    );
  });

  await context.test("공식 run info 0건", async () => {
    const artifact = await collectKorailItxCheongchunCompleteness({
      serviceKey: "key", serviceDates, packPath: PACK_PATH,
      now: new Date("2026-07-14T00:00:00.000Z"), collectRosterImpl: roster,
      collectTimetableImpl: async () => { throw new Error("Korail ITX run info returned zero rows"); },
    });
    assert.equal(artifact.serviceDays[0].failureReasonCode, "OFFICIAL_RUN_INFO_EMPTY");
    assert.equal(artifact.serviceDays[0].failureContext, "operation=travelerTrainRunInfo2,total=0");
  });

  await context.test("legacy 대전 위반 count 보존", async () => {
    const artifact = await collectKorailItxCheongchunCompleteness({
      serviceKey: "key", serviceDates, packPath: PACK_PATH,
      now: new Date("2026-07-14T00:00:00.000Z"), collectRosterImpl: roster,
      collectTimetableImpl: async () => {
        const error = new Error("Korail ITX legacy Daejeon data must be zero");
        error.legacyDaejeonRowCount = 2;
        error.legacyYongsanDaejeonTripCount = 1;
        throw error;
      },
    });
    assert.equal(artifact.serviceDays[0].failureReasonCode, "LEGACY_DAEJEON_DATA_PRESENT");
    assert.equal(artifact.serviceDays[0].legacyDaejeonRowCount, 2);
    assert.equal(artifact.serviceDays[0].legacyYongsanDaejeonTripCount, 1);
    assert.equal(artifact.legacyDaejeonRowCount, 6);
    assert.equal(artifact.legacyYongsanDaejeonTripCount, 3);
  });
});

test("ITX CLI는 runtime 실패를 MISSING artifact로 저장하고 non-zero를 반환한다", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "itx-cli-test-"));
  const output = path.join(dir, "evidence.json");
  try {
    const result = await runKorailItxCompletenessCli({
      argv: [
        "--day8-date", "20260715",
        "--day7-date", "20260718",
        "--day9-date", "20260719",
        "--canonical-pack", PACK_PATH,
        "--output", output,
      ],
      env: { DATA_GO_KR_SERVICE_KEY: "secret" },
      now: new Date("2026-07-14T00:00:00.000Z"),
      collectImpl: async () => { throw new Error("provider HTTP 503 secret"); },
    });
    const artifact = JSON.parse(await readFile(output, "utf8"));
    assert.equal(result.exitCode, 1);
    assert.equal(artifact.admissionStatus, "MISSING");
    assert.equal(artifact.admissionEligible, false);
    assert.equal(artifact.schemaVersion, 2);
    assert.deepEqual(artifact.allowedConsumerIssues, ["#2145", "#1400", "#2098", "#2099", "#2058", "#2137"]);
    assert.equal(artifact.failureReasonCode, "PROVIDER_HTTP_FAILURE");
    assert.doesNotMatch(JSON.stringify(artifact), /503|secret/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ITX CLI는 성공 completeness evidence와 candidate를 별도 canonical bytes로 보존한다", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "itx-cli-success-evidence-"));
  const output = path.join(dir, "candidate.json");
  const completenessOutput = path.join(dir, "completeness.json");
  const expected = completenessForCandidate(sourceCandidate());
  try {
    const result = await runKorailItxCompletenessCli({
      argv: [
        "--day8-date", "20260716", "--day7-date", "20260718", "--day9-date", "20260719",
        "--canonical-pack", PACK_PATH,
        "--completeness-output", completenessOutput,
        "--output", output,
      ],
      env: { DATA_GO_KR_SERVICE_KEY: "secret" },
      now: new Date("2026-07-15T02:00:00.000Z"),
      collectImpl: async () => structuredClone(expected),
    });
    const [candidateBytes, preservedBytes] = await Promise.all([readFile(output), readFile(completenessOutput)]);
    const candidate = JSON.parse(candidateBytes);
    assert.deepEqual(preservedBytes, Buffer.from(completenessBytes(expected)));
    assert.equal(
      candidate.completenessEvidenceSha256,
      createHash("sha256").update(preservedBytes).digest("hex"),
    );
    assert.equal(result.completenessEvidenceSha256, candidate.completenessEvidenceSha256);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ITX CLI는 candidate와 completeness evidence에 같은 output path를 허용하지 않는다", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "itx-cli-evidence-path-"));
  const output = path.join(dir, "shared.json");
  const expected = completenessForCandidate(sourceCandidate());
  try {
    await assert.rejects(runKorailItxCompletenessCli({
      argv: [
        "--day8-date", "20260716", "--day7-date", "20260718", "--day9-date", "20260719",
        "--canonical-pack", PACK_PATH,
        "--completeness-output", output,
        "--output", output,
      ],
      env: { DATA_GO_KR_SERVICE_KEY: "secret" },
      now: new Date("2026-07-15T02:00:00.000Z"),
      collectImpl: async () => structuredClone(expected),
    }), /candidate and completeness output paths must differ/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ITX CLI는 --previous-admitted 임의 baseline을 거부한다", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "itx-cli-previous-"));
  const output = path.join(dir, "current.json");
  try {
    await assert.rejects(runKorailItxCompletenessCli({
      argv: [
        "--day8-date", "20260715", "--day7-date", "20260718", "--day9-date", "20260719",
        "--canonical-pack", PACK_PATH, "--previous-admitted", path.join(dir, "candidate.json"), "--output", output,
      ],
      env: { DATA_GO_KR_SERVICE_KEY: "secret" },
      now: new Date("2026-07-14T00:00:00.000Z"),
      collectImpl: async () => assert.fail("must reject before collection"),
    }), /--previous-admitted is not supported/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ITX CLI는 invalid coverage contract를 baseline authority로 사용하지 않는다", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "itx-cli-contract-authority-"));
  const output = path.join(dir, "current.json");
  try {
    await writeCoverageContract(dir, '{"schemaVersion":1}\n');
    await assert.rejects(runKorailItxCompletenessCli({
      argv: [
        "--day8-date", "20260715", "--day7-date", "20260718", "--day9-date", "20260719",
        "--canonical-pack", path.join(dir, PACK_PATH), "--output", output,
      ],
      env: { DATA_GO_KR_SERVICE_KEY: "secret" },
      repositoryRoot: dir,
      now: new Date("2026-07-14T00:00:00.000Z"),
      collectImpl: async () => assert.fail("must reject before collection"),
    }), /ITX_COVERAGE_CONTRACT_INVALID/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ITX candidate builder의 실제 payload에서 생성한 5-set은 promotion 재검증을 통과한다", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "itx-built-candidate-"));
  const template = sourceCandidate();
  const serviceDays = ["8", "7", "9"].map((dayCd) => ({
    dayCd,
    roster: {
      stations: template.stationRosters.find((row) => row.dayCd === dayCd).stations,
      trainNumbers: ["2001", "2002"],
      evidenceHash: "a".repeat(64),
    },
    timetable: {
      stationSequences: template.stationSequences
        .filter((row) => row.dayCd === dayCd)
        .map(({ dayCd: _, ...sequence }) => sequence)
        .reverse(),
      transitTrips: template.transitTrips.filter(({ id }) => id.endsWith(`-${dayCd}`)),
      transitStopTimes: template.transitStopTimes.filter(({ tripId }) => tripId.endsWith(`-${dayCd}`)),
      evidenceHash: "b".repeat(64),
    },
  }));
  const completeness = completenessForCandidate(template);
  completeness.serviceDays = serviceDays;
  const { evidenceHash: _, ...completenessWithoutEvidenceHash } = completeness;
  completeness.evidenceHash = createHash("sha256").update(JSON.stringify(completenessWithoutEvidenceHash)).digest("hex");
  try {
    const contractPath = await writeCoverageContract(dir, '{"schemaVersion":2}\n');
    const alternatePackPath = path.join(dir, PACK_PATH);
    const invalidCompleteness = structuredClone(completeness);
    invalidCompleteness.serviceDays[0].timetable.transitTrips[0].serviceId = "holiday-kric";
    await assert.rejects(buildItxSourceCandidate({
      completeness: invalidCompleteness,
      packPath: alternatePackPath,
      repositoryRoot: dir,
      now: new Date("2026-07-15T02:00:00.000Z"),
    }), /TAGO_OD_STOP_SEQUENCE_INVALID/);

    const candidate = await buildItxSourceCandidate({
      completeness,
      packPath: alternatePackPath,
      repositoryRoot: dir,
      now: new Date("2026-07-15T02:00:00.000Z"),
    });
    assert.equal(candidate.canonicalPackIdentity.path, PACK_PATH);
    const originalCwd = process.cwd();
    process.chdir(dir);
    try {
      const repositoryCandidate = await buildItxSourceCandidate({
        completeness,
        packPath: PACK_PATH,
        repositoryRoot: path.resolve(import.meta.dirname, "../.."),
        now: new Date("2026-07-15T02:00:00.000Z"),
      });
      assert.equal(repositoryCandidate.canonicalPackIdentity.path, PACK_PATH);
      assert.equal(repositoryCandidate.canonicalPackIdentity.sha256, PACK_SHA256);
    } finally {
      process.chdir(originalCwd);
    }
    const candidatePath = path.join(dir, "candidate.json");
    const bytes = sourceBytes(candidate);
    const digest = createHash("sha256").update(bytes).digest("hex");
    await writeFile(candidatePath, bytes);
    await writeFile(`${candidatePath}.completeness.json`, completenessBytes(completeness));
    const promoted = await promoteItxSourceCandidate({
      candidatePath,
      approvedSha256: digest,
      approvalUrl: "https://github.com/AquilaXk/easysubway/issues/2135#issuecomment-123",
      sourceOutputDir: path.join(dir, "tools/datapack/sources"),
      coverageContractPath: contractPath,
      repositoryRoot: dir,
      now: new Date("2026-07-15T02:00:00.000Z"),
      fetchImpl: async () => new Response(JSON.stringify({
        author_association: "OWNER",
        html_url: "https://github.com/AquilaXk/easysubway/issues/2135#issuecomment-123",
        body: `/approve-itx-bootstrap artifactId=${candidate.artifactId} sha256=${digest} policy=itx-snapshot-anomaly-v1`,
        created_at: "2026-07-15T01:30:00.000Z",
      }), { status: 200, headers: { "content-type": "application/json" } }),
    });
    assert.equal(promoted.sourceTimetableArtifact.status, "ADMITTED");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ITX bootstrap promotion은 exact candidate SHA와 OWNER approval 뒤에만 immutable payload를 만든다", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "itx-promotion-"));
  const candidatePath = path.join(dir, "candidate.json");
  const sourceDir = path.join(dir, "tools/datapack/sources");
  const candidate = sourceCandidate();
  const candidateBytes = sourceBytes(candidate);
  const digest = createHash("sha256").update(candidateBytes).digest("hex");
  const approvalUrl = "https://github.com/AquilaXk/easysubway/issues/2135#issuecomment-123";
  try {
    await writeFile(candidatePath, candidateBytes);
    await writeCandidateCompleteness(candidatePath, candidate);
    const contractPath = await writeCoverageContract(dir, '{"schemaVersion":2}\n');
    await assert.rejects(promoteItxSourceCandidate({
      candidatePath,
      approvedSha256: digest,
      approvalUrl,
      sourceOutputDir: sourceDir,
      coverageContractPath: contractPath,
      repositoryRoot: dir,
      now: new Date("2026-07-20T00:00:00+09:00"),
    }), /SOURCE_SNAPSHOT_EXPIRED/);
    await assert.rejects(promoteItxSourceCandidate({
      candidatePath,
      approvedSha256: "0".repeat(64),
      approvalUrl,
      sourceOutputDir: sourceDir,
      coverageContractPath: contractPath,
      repositoryRoot: dir,
      now: new Date("2026-07-15T02:00:00.000Z"),
    }), /SNAPSHOT_BOOTSTRAP_APPROVAL_INVALID/);

    const promoted = await promoteItxSourceCandidate({
      candidatePath,
      approvedSha256: digest,
      approvalUrl,
      sourceOutputDir: sourceDir,
      coverageContractPath: contractPath,
      repositoryRoot: dir,
      now: new Date("2026-07-15T02:00:00.000Z"),
      fetchImpl: async () => new Response(JSON.stringify({
        author_association: "OWNER",
        html_url: approvalUrl,
        body: `/approve-itx-bootstrap artifactId=${candidate.artifactId} sha256=${digest} policy=itx-snapshot-anomaly-v1`,
        created_at: "2026-07-15T01:30:00.000Z",
      }), { status: 200, headers: { "content-type": "application/json" } }),
    });
    assert.equal(promoted.candidateSha256, digest);
    assert.deepEqual(await readFile(promoted.artifactPath), Buffer.from(candidateBytes));
    const contract = JSON.parse(await readFile(contractPath, "utf8"));
    assert.equal(contract.sourceTimetableArtifact.status, "ADMITTED");
    assert.equal(contract.sourceTimetableArtifact.promotion.mode, "BOOTSTRAP_OWNER_APPROVED");
    assert.equal(
      contract.sourceTimetableArtifact.artifactPath,
      `tools/datapack/sources/${candidate.artifactId}.json`,
    );
    assert.equal(
      contract.sourceTimetableArtifact.completenessEvidencePath,
      `tools/datapack/sources/${candidate.artifactId}-completeness-evidence.json`,
    );
    const completenessEvidenceBytes = await readFile(promoted.completenessArtifactPath);
    assert.deepEqual(completenessEvidenceBytes, Buffer.from(completenessBytes(completenessForCandidate(candidate))));
    assert.equal(
      contract.sourceTimetableArtifact.completenessEvidenceSha256,
      createHash("sha256").update(completenessEvidenceBytes).digest("hex"),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ITX unchanged promotion은 preserved completeness와 다른 warning·lineage를 거부한다", async (context) => {
  for (const scenario of [
    {
      name: "warning 삭제",
      mutate(candidate) {
        candidate.warnings = [];
      },
    },
    {
      name: "lineage digest 변조",
      mutate(candidate) {
        candidate.sourceLineage[0].rosterEvidenceHash = "f".repeat(64);
      },
    },
  ]) {
    await context.test(scenario.name, async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "itx-promotion-evidence-binding-"));
      const sourceDir = path.join(dir, "tools/datapack/sources");
      try {
        await mkdir(sourceDir, { recursive: true });
        const previous = sourceCandidate({
          artifactId: "itx-cheongchun-source-timetable-20260714010000000",
          promotionStatus: "SUPPORTED",
        });
        const { reference: previousReference } = await writeAdmittedSourceBundle(sourceDir, previous);
        const previousSha = previousReference.sha256;
        const contractPath = await writeCoverageContract(dir, JSON.stringify({
          sourceTimetableArtifact: previousReference,
        }));
        const warning = { code: "KORAIL_PLAN_NOT_AVAILABLE", dayCd: "8", trainNumber: "2001" };
        const candidate = sourceCandidate({ promotionStatus: "SUPPORTED", warnings: [warning] });
        candidate.snapshotDiff = unchangedSnapshotDiff(previousSha, candidate.normalizedSnapshotSets);
        bindCandidateCompleteness(candidate);
        const completeness = completenessForCandidate(candidate);
        scenario.mutate(candidate);
        rehashCandidate(candidate);
        const candidatePath = path.join(dir, "candidate.json");
        const completenessPath = path.join(dir, "completeness.json");
        await Promise.all([
          writeFile(candidatePath, sourceBytes(candidate)),
          writeFile(completenessPath, completenessBytes(completeness)),
        ]);

        await assert.rejects(promoteItxSourceCandidate({
          candidatePath,
          completenessPath,
          sourceOutputDir: sourceDir,
          coverageContractPath: contractPath,
          repositoryRoot: dir,
          now: new Date("2026-07-15T02:00:00.000Z"),
        }), /SOURCE_COMPLETENESS_EVIDENCE_MISMATCH/);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  }
});

test("ITX changed candidate는 change OWNER approval로 immutable artifact를 승격한다", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "itx-change-promotion-"));
  const sourceDir = path.join(dir, "tools/datapack/sources");
  try {
    await mkdir(sourceDir, { recursive: true });
    const previous = sourceCandidate({
      artifactId: "itx-cheongchun-source-timetable-20260714010000000",
      promotionStatus: "SUPPORTED",
    });
    const previousSequence = previous.stationSequences.find(({ dayCd, trainNumber }) => (
      dayCd === "8" && trainNumber === "2001"
    ));
    previousSequence.stops[0].arrivalAt = "2026-07-16T07:58:20+09:00";
    previousSequence.stops[0].departureAt = "2026-07-16T07:58:20+09:00";
    previousSequence.stops[0].arrivalSeconds = 28_700;
    previousSequence.stops[0].departureSeconds = 28_700;
    const previousStopTime = previous.transitStopTimes.find(({ tripId, stationId }) => (
      tripId.endsWith("-2001-8") && stationId === YONGSAN_STATION_ID
    ));
    previousStopTime.arrivalSeconds = 28_700;
    previousStopTime.departureSeconds = 28_700;
    const previousTuple = previous.normalizedSnapshotSets
      .find(({ dayCd }) => dayCd === "8").sets.timetableTupleSet
      .find(([, trainNumber, stationId]) => trainNumber === "2001" && stationId === YONGSAN_STATION_ID);
    previousTuple[3] = 28_700;
    previousTuple[4] = 28_700;
    const { reference: previousReference } = await writeAdmittedSourceBundle(sourceDir, previous);
    const previousSha = previousReference.sha256;

    const contractPath = await writeCoverageContract(dir, JSON.stringify({
      sourceTimetableArtifact: previousReference,
    }));
    const candidate = sourceCandidate({ promotionStatus: "CHANGE_REVIEW_REQUIRED" });
    candidate.snapshotDiff = unchangedSnapshotDiff(previousSha, candidate.normalizedSnapshotSets);
    candidate.snapshotDiff.status = "CHANGE_REVIEW_REQUIRED";
    const changedDay = candidate.snapshotDiff.serviceDays.find(({ dayCd }) => dayCd === "8");
    changedDay.blocked = true;
    changedDay.sets.timetableTupleSet.added = [["8", "2001", YONGSAN_STATION_ID, 28_800, 28_800]];
    changedDay.sets.timetableTupleSet.removed = [["8", "2001", YONGSAN_STATION_ID, 28_700, 28_700]];
    bindCandidateCompleteness(candidate);
    const candidateBytes = sourceBytes(candidate);
    const digest = createHash("sha256").update(candidateBytes).digest("hex");
    const candidatePath = path.join(dir, "candidate.json");
    const approvalUrl = "https://github.com/AquilaXk/easysubway/issues/2135#issuecomment-123";
    await writeFile(candidatePath, candidateBytes);
    await writeCandidateCompleteness(candidatePath, candidate);

    const promoted = await promoteItxSourceCandidate({
      candidatePath,
      approvedSha256: digest,
      approvalUrl,
      sourceOutputDir: sourceDir,
      coverageContractPath: contractPath,
      repositoryRoot: dir,
      now: new Date("2026-07-15T02:00:00.000Z"),
      fetchImpl: async () => new Response(JSON.stringify({
        author_association: "OWNER",
        html_url: approvalUrl,
        body: `/approve-itx-change artifactId=${candidate.artifactId} sha256=${digest} policy=itx-snapshot-anomaly-v1`,
        created_at: "2026-07-15T01:30:00.000Z",
      }), { status: 200, headers: { "content-type": "application/json" } }),
    });
    assert.equal(promoted.sourceTimetableArtifact.promotion.mode, "CHANGE_OWNER_APPROVED");
    assert.equal(promoted.sourceTimetableArtifact.promotion.previousArtifactSha256, previousSha);
    assert.equal(
      promoted.sourceTimetableArtifact.promotion.previousArtifactPath,
      `tools/datapack/sources/${previous.artifactId}.json`,
    );
    assert.deepEqual(await readFile(promoted.artifactPath), Buffer.from(candidateBytes));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("UNCHANGED_AUTO 승격은 조건이 모두 충족되면 admission pin을 출하 pack 실체로 교정한다", async () => {
  const { promoted, contract } = await promoteUnchangedWithPin({
    pin: stalePin(),
    topologyEvidence: shippedPackTopologyEvidence(),
  });
  assert.equal(promoted.sourceTimetableArtifact.promotion.mode, "UNCHANGED_AUTO");
  const pin = contract.officialEvidence.korailCompletenessAdmission.canonicalPackIdentity;
  // pin의 3필드는 출하 pack 실체로 갱신되고, sourceIssue 등 잔여 필드는 보존된다.
  assert.equal(pin.id, "capital");
  assert.equal(pin.sha256, PACK_SHA256);
  assert.equal(pin.sqliteSha256, PACK_SQLITE_SHA256);
  assert.equal(pin.sourceIssue, 2097);
  // 교정된 pin(sha256/sqliteSha256)은 build --without-topology-evidence 게이트가 요구하는
  // 출하 pack 실측 identity와 정확히 일치한다.
  assert.equal(pin.sha256, createHash("sha256").update(PACK_BYTES).digest("hex"));
  assert.equal(pin.sqliteSha256, createHash("sha256").update(gunzipSync(PACK_BYTES)).digest("hex"));
});

test("UNCHANGED_AUTO 승격은 조건 미충족 시 admission pin을 불변 유지한다", async (context) => {
  await context.test("topology evidence OUTPUT identity 불일치", async () => {
    const { promoted, contract } = await promoteUnchangedWithPin({
      pin: stalePin(),
      topologyEvidence: shippedPackTopologyEvidence({ pack: { outputSqliteSha256: "9".repeat(64) } }),
    });
    assert.equal(promoted.sourceTimetableArtifact.promotion.mode, "UNCHANGED_AUTO");
    const pin = contract.officialEvidence.korailCompletenessAdmission.canonicalPackIdentity;
    assert.equal(pin.sha256, STALE_PIN_SHA256);
    assert.equal(pin.sqliteSha256, STALE_PIN_SQLITE_SHA256);
  });

  await context.test("topology evidence 파일 부재", async () => {
    const { promoted, contract } = await promoteUnchangedWithPin({
      pin: stalePin(),
      topologyEvidence: null,
    });
    assert.equal(promoted.sourceTimetableArtifact.promotion.mode, "UNCHANGED_AUTO");
    const pin = contract.officialEvidence.korailCompletenessAdmission.canonicalPackIdentity;
    assert.equal(pin.sha256, STALE_PIN_SHA256);
    assert.equal(pin.sqliteSha256, STALE_PIN_SQLITE_SHA256);
  });

  await context.test("officialEvidence pin 부재 시에도 promote는 성공한다", async () => {
    const { promoted, contract } = await promoteUnchangedWithPin({
      topologyEvidence: shippedPackTopologyEvidence(),
    });
    assert.equal(promoted.sourceTimetableArtifact.promotion.mode, "UNCHANGED_AUTO");
    assert.equal(contract.officialEvidence, undefined);
  });
});

test("bootstrap 승격(UNCHANGED_AUTO 아님)은 admission pin을 교정하지 않는다", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "itx-pin-bootstrap-"));
  try {
    const sourceDir = path.join(dir, "tools/datapack/sources");
    await mkdir(sourceDir, { recursive: true });
    const candidate = sourceCandidate();
    const candidateBytes = sourceBytes(candidate);
    const candidatePath = path.join(dir, "candidate.json");
    await writeFile(candidatePath, candidateBytes);
    await writeCandidateCompleteness(candidatePath, candidate);
    await writeFile(
      path.join(dir, "tools/datapack/itx-cheongchun-topology-evidence.json"),
      `${JSON.stringify(shippedPackTopologyEvidence(), null, 2)}\n`,
    );
    const contractPath = await writeCoverageContract(dir, JSON.stringify({
      officialEvidence: { korailCompletenessAdmission: { canonicalPackIdentity: stalePin() } },
    }));
    const promoted = await promoteItxSourceCandidate({
      candidatePath,
      ...ownerApproval(candidate),
      sourceOutputDir: sourceDir,
      coverageContractPath: contractPath,
      repositoryRoot: dir,
      now: new Date("2026-07-15T02:00:00.000Z"),
    });
    assert.equal(promoted.sourceTimetableArtifact.promotion.mode, "BOOTSTRAP_OWNER_APPROVED");
    const contract = JSON.parse(await readFile(contractPath, "utf8"));
    const pin = contract.officialEvidence.korailCompletenessAdmission.canonicalPackIdentity;
    assert.equal(pin.sha256, STALE_PIN_SHA256);
    assert.equal(pin.sqliteSha256, STALE_PIN_SQLITE_SHA256);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ITX promotion은 동일한 immutable artifact bytes가 남은 재시도를 복구한다", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "itx-promotion-retry-"));
  const candidate = sourceCandidate();
  const candidateBytes = sourceBytes(candidate);
  const digest = createHash("sha256").update(candidateBytes).digest("hex");
  const sourceDir = path.join(dir, "tools/datapack/sources");
  const candidatePath = path.join(dir, "candidate.json");
  try {
    await mkdir(sourceDir, { recursive: true });
    await writeFile(candidatePath, candidateBytes);
    await writeCandidateCompleteness(candidatePath, candidate);
    await writeFile(path.join(sourceDir, `${candidate.artifactId}.json`), candidateBytes);
    const contractPath = await writeCoverageContract(dir, '{"schemaVersion":2}\n');
    const promoted = await promoteItxSourceCandidate({
      candidatePath,
      approvedSha256: digest,
      approvalUrl: "https://github.com/AquilaXk/easysubway/issues/2135#issuecomment-123",
      sourceOutputDir: sourceDir,
      coverageContractPath: contractPath,
      repositoryRoot: dir,
      now: new Date("2026-07-15T02:00:00.000Z"),
      fetchImpl: async () => new Response(JSON.stringify({
        author_association: "OWNER",
        html_url: "https://github.com/AquilaXk/easysubway/issues/2135#issuecomment-123",
        body: `/approve-itx-bootstrap artifactId=${candidate.artifactId} sha256=${digest} policy=itx-snapshot-anomaly-v1`,
        created_at: "2026-07-15T01:30:00.000Z",
      }), { status: 200, headers: { "content-type": "application/json" } }),
    });
    assert.equal(promoted.sourceTimetableArtifact.status, "ADMITTED");
    assert.deepEqual(await readFile(promoted.artifactPath), Buffer.from(candidateBytes));
    assert.deepEqual(
      await readFile(promoted.completenessArtifactPath),
      Buffer.from(completenessBytes(completenessForCandidate(candidate))),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ITX promotion은 byte-identical symlink를 immutable artifact로 재사용하지 않는다", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "itx-promotion-symlink-"));
  const candidate = sourceCandidate();
  const candidateBytes = sourceBytes(candidate);
  const sourceDir = path.join(dir, "tools/datapack/sources");
  const candidatePath = path.join(dir, "candidate.json");
  try {
    await mkdir(sourceDir, { recursive: true });
    await writeFile(candidatePath, candidateBytes);
    await writeCandidateCompleteness(candidatePath, candidate);
    await symlink(candidatePath, path.join(sourceDir, `${candidate.artifactId}.json`));
    const contractPath = await writeCoverageContract(dir, '{"schemaVersion":2}\n');
    await assert.rejects(promoteItxSourceCandidate({
      candidatePath,
      ...ownerApproval(candidate),
      sourceOutputDir: sourceDir,
      coverageContractPath: contractPath,
      repositoryRoot: dir,
      now: new Date("2026-07-15T02:00:00.000Z"),
    }), /ADMITTED_SOURCE_ARTIFACT_INVALID/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ITX promotion은 동일 artifact ID에 다른 bytes가 있으면 immutable conflict로 거부한다", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "itx-promotion-conflict-"));
  const candidate = sourceCandidate();
  const candidateBytes = sourceBytes(candidate);
  const sourceDir = path.join(dir, "tools/datapack/sources");
  const candidatePath = path.join(dir, "candidate.json");
  try {
    await mkdir(sourceDir, { recursive: true });
    await writeFile(candidatePath, candidateBytes);
    await writeCandidateCompleteness(candidatePath, candidate);
    const conflicting = sourceCandidate({ observedAt: "2026-07-15T01:00:01.000Z" });
    rehashCandidate(conflicting);
    await writeFile(path.join(sourceDir, `${candidate.artifactId}.json`), sourceBytes(conflicting));
    const contractPath = await writeCoverageContract(dir, '{"schemaVersion":2}\n');
    await assert.rejects(promoteItxSourceCandidate({
      candidatePath,
      ...ownerApproval(candidate),
      sourceOutputDir: sourceDir,
      coverageContractPath: contractPath,
      repositoryRoot: dir,
      now: new Date("2026-07-15T02:00:00.000Z"),
    }), /ADMITTED_SOURCE_ARTIFACT_CONFLICT/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ITX promotion은 freshness·payload sets·current ADMITTED authority를 재검증한다", async (context) => {
  await context.test("invalid offset timestamp", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "itx-promotion-freshness-"));
    try {
      const candidate = sourceCandidate({ freshUntil: "not-a-date" });
      const candidatePath = path.join(dir, "candidate.json");
      await writeFile(candidatePath, sourceBytes(candidate));
      const contractPath = await writeCoverageContract(dir, '{"schemaVersion":2}\n');
      await assert.rejects(promoteItxSourceCandidate({
        candidatePath,
        ...ownerApproval(candidate),
        sourceOutputDir: path.join(dir, "tools/datapack/sources"),
        coverageContractPath: contractPath,
        repositoryRoot: dir,
        now: new Date("2026-07-15T02:00:00.000Z"),
      }), /SOURCE_SNAPSHOT_FRESHNESS_INVALID/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  await context.test("candidate fixed schema와 source lineage tamper", async () => {
    for (const mutate of [
      (candidate) => { candidate.serviceId = "OTHER"; },
      (candidate) => { candidate.sourceLineage[0].rosterEvidenceHash = "invalid"; },
    ]) {
      const dir = await mkdtemp(path.join(tmpdir(), "itx-promotion-schema-"));
      try {
        const candidate = sourceCandidate();
        mutate(candidate);
        rehashCandidate(candidate);
        const candidatePath = path.join(dir, "candidate.json");
        await writeFile(candidatePath, sourceBytes(candidate));
        const contractPath = await writeCoverageContract(dir, '{"schemaVersion":2}\n');
        await assert.rejects(promoteItxSourceCandidate({
          candidatePath,
          ...ownerApproval(candidate),
          sourceOutputDir: path.join(dir, "tools/datapack/sources"),
          coverageContractPath: contractPath,
          repositoryRoot: dir,
          now: new Date("2026-07-15T02:00:00.000Z"),
        }), /ITX source candidate schema is invalid/);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });

  await context.test("candidate unknown top-level과 nested credential field", async () => {
    for (const mutate of [
      (candidate) => { candidate.serviceKey = "should-not-persist"; },
      (candidate) => { candidate.stationRosters[0].stations[0].serviceKey = "should-not-persist"; },
      (candidate) => {
        candidate.warnings = [{
          code: "KORAIL_PLAN_NOT_AVAILABLE",
          dayCd: "8",
          trainNumber: { serviceKey: "should-not-persist" },
        }];
      },
      (candidate) => {
        candidate.warnings = [{ code: "KORAIL_PLAN_NOT_AVAILABLE", dayCd: "8", trainNumber: "9999" }];
      },
      (candidate) => {
        candidate.warnings = [
          { code: "KORAIL_PLAN_NOT_AVAILABLE", dayCd: "8", trainNumber: "2001" },
          { code: "KORAIL_PLAN_NOT_AVAILABLE", dayCd: "8", trainNumber: "2001" },
        ];
      },
    ]) {
      const dir = await mkdtemp(path.join(tmpdir(), "itx-promotion-closed-schema-"));
      try {
        const candidate = sourceCandidate();
        mutate(candidate);
        rehashCandidate(candidate);
        const candidatePath = path.join(dir, "candidate.json");
        await writeFile(candidatePath, sourceBytes(candidate));
        const contractPath = await writeCoverageContract(dir, '{"schemaVersion":2}\n');
        await assert.rejects(promoteItxSourceCandidate({
          candidatePath,
          ...ownerApproval(candidate),
          sourceOutputDir: path.join(dir, "tools/datapack/sources"),
          coverageContractPath: contractPath,
          repositoryRoot: dir,
          now: new Date("2026-07-15T02:00:00.000Z"),
        }), /ITX source candidate schema is invalid/);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });

  await context.test("canonical v2 coverage contract authority", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "itx-promotion-contract-authority-"));
    try {
      const candidate = sourceCandidate();
      const candidatePath = path.join(dir, "candidate.json");
      await writeFile(candidatePath, sourceBytes(candidate));
      const contractPath = await writeCoverageContract(dir, '{"schemaVersion":1}\n');
      await assert.rejects(promoteItxSourceCandidate({
        candidatePath,
        ...ownerApproval(candidate),
        sourceOutputDir: path.join(dir, "tools/datapack/sources"),
        coverageContractPath: contractPath,
        repositoryRoot: dir,
        now: new Date("2026-07-15T02:00:00.000Z"),
      }), /ITX_COVERAGE_CONTRACT_INVALID/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  await context.test("existing promotion lock은 동시 promotion을 거부", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "itx-promotion-lock-"));
    try {
      const candidate = sourceCandidate();
      const candidatePath = path.join(dir, "candidate.json");
      await writeFile(candidatePath, sourceBytes(candidate));
      const contractPath = await writeCoverageContract(dir, '{"schemaVersion":2}\n');
      await writeFile(`${contractPath}.promotion.lock`, "held\n", { flag: "wx" });
      await assert.rejects(promoteItxSourceCandidate({
        candidatePath,
        ...ownerApproval(candidate),
        sourceOutputDir: path.join(dir, "tools/datapack/sources"),
        coverageContractPath: contractPath,
        repositoryRoot: dir,
        now: new Date("2026-07-15T02:00:00.000Z"),
      }), /ADMISSION_PROMOTION_CONFLICT/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  await context.test("OWNER approval canonical URL mismatch", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "itx-promotion-approval-url-"));
    try {
      const candidate = sourceCandidate();
      const approval = ownerApproval(candidate);
      const candidatePath = path.join(dir, "candidate.json");
      await writeFile(candidatePath, sourceBytes(candidate));
      await writeCandidateCompleteness(candidatePath, candidate);
      const contractPath = await writeCoverageContract(dir, '{"schemaVersion":2}\n');
      await assert.rejects(promoteItxSourceCandidate({
        candidatePath,
        ...approval,
        sourceOutputDir: path.join(dir, "tools/datapack/sources"),
        coverageContractPath: contractPath,
        repositoryRoot: dir,
        now: new Date("2026-07-15T02:00:00.000Z"),
        fetchImpl: async () => {
          const record = await approval.fetchImpl().then((response) => response.json());
          return new Response(JSON.stringify({ ...record, html_url: `${approval.approvalUrl}-other` }));
        },
      }), /SNAPSHOT_BOOTSTRAP_APPROVAL_INVALID/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  await context.test("OWNER approval transport는 timeout signal과 sanitized failure를 사용", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "itx-promotion-approval-timeout-"));
    let requestOptions;
    try {
      const candidate = sourceCandidate();
      const candidatePath = path.join(dir, "candidate.json");
      await writeFile(candidatePath, sourceBytes(candidate));
      await writeCandidateCompleteness(candidatePath, candidate);
      const contractPath = await writeCoverageContract(dir, '{"schemaVersion":2}\n');
      await assert.rejects(promoteItxSourceCandidate({
        candidatePath,
        ...ownerApproval(candidate),
        sourceOutputDir: path.join(dir, "tools/datapack/sources"),
        coverageContractPath: contractPath,
        repositoryRoot: dir,
        now: new Date("2026-07-15T02:00:00.000Z"),
        fetchImpl: async (_url, options) => {
          requestOptions = options;
          throw new Error("transport stalled");
        },
      }), /SNAPSHOT_BOOTSTRAP_APPROVAL_INVALID/);
      assert.equal(requestOptions.redirect, "error");
      assert.ok(requestOptions.signal instanceof AbortSignal);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  await context.test("selected service date의 dayCd 요일 tamper", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "itx-promotion-service-date-"));
    try {
      const candidate = sourceCandidate({
        selectedServiceDates: { "8": "20260718", "7": "20260716", "9": "20260719" },
      });
      const candidatePath = path.join(dir, "candidate.json");
      await writeFile(candidatePath, sourceBytes(candidate));
      const contractPath = await writeCoverageContract(dir, '{"schemaVersion":2}\n');
      await assert.rejects(promoteItxSourceCandidate({
        candidatePath,
        ...ownerApproval(candidate),
        sourceOutputDir: path.join(dir, "tools/datapack/sources"),
        coverageContractPath: contractPath,
        repositoryRoot: dir,
        now: new Date("2026-07-15T02:00:00.000Z"),
      }), /ITX source candidate schema is invalid/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  await context.test("현재 admission 범위를 벗어난 미래 service date tamper", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "itx-promotion-future-date-"));
    try {
      const sourceDir = path.join(dir, "tools/datapack/sources");
      await mkdir(sourceDir, { recursive: true });
      const previous = sourceCandidate({
        artifactId: "itx-cheongchun-source-timetable-20260714010000000",
        promotionStatus: "SUPPORTED",
      });
      const previousBytes = sourceBytes(previous);
      const previousSha = createHash("sha256").update(previousBytes).digest("hex");
      await writeFile(path.join(sourceDir, `${previous.artifactId}.json`), previousBytes);
      const contractPath = await writeCoverageContract(dir, JSON.stringify({
        sourceTimetableArtifact: {
          status: "ADMITTED",
          admissionEligible: true,
          artifactId: previous.artifactId,
          artifactPath: `tools/datapack/sources/${previous.artifactId}.json`,
          sha256: previousSha,
          schemaVersion: 1,
          policyVersion: "itx-snapshot-anomaly-v1",
          freshUntil: previous.freshUntil,
        },
      }));
      const candidate = sourceCandidate({
        promotionStatus: "SUPPORTED",
        selectedServiceDates: { "8": "20261015", "7": "20261017", "9": "20261018" },
        freshUntil: "2026-10-19T00:00:00+09:00",
      });
      candidate.snapshotDiff = unchangedSnapshotDiff(previousSha, candidate.normalizedSnapshotSets);
      rehashCandidate(candidate);
      const candidatePath = path.join(dir, "candidate.json");
      await writeFile(candidatePath, sourceBytes(candidate));
      await assert.rejects(promoteItxSourceCandidate({
        candidatePath,
        sourceOutputDir: sourceDir,
        coverageContractPath: contractPath,
        repositoryRoot: dir,
        now: new Date("2026-07-15T02:00:00.000Z"),
      }), /ITX admission dates must be today through 6 days/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  await context.test("canonical projection metadata tamper", async () => {
    const mutations = [
      (candidate) => { candidate.stationRosters[0].stations[0].nameKo = "변조역"; },
      (candidate) => { candidate.stationRosters[0].stations[0].providerStationName = "변조역"; },
      (candidate) => { candidate.stationRosters[0].stations[0].corridorSequence = 99; },
      (candidate) => { candidate.stationSequences[0].stops[0].nameKo = "변조역"; },
      (candidate) => { candidate.stationSequences[0].stops[0].corridorSequence = 99; },
      (candidate) => {
        candidate.stationSequences[0].stops[1].stationId = candidate.stationSequences[0].stops[0].stationId;
      },
      (candidate) => {
        candidate.stationSequences[0].stops[1].corridorSequence = candidate.stationSequences[0].stops[0].corridorSequence;
      },
      (candidate) => { candidate.stationSequences[0].stops[0].arrivalAt = "2026-07-18T08:01:00+09:00"; },
      (candidate) => { candidate.stationSequences[0].stops[0].stopSequence = 2; },
      (candidate) => { candidate.stationSequences[0].originStationName = "변조역"; },
      (candidate) => { candidate.stationSequences[0].destinationStationName = "변조역"; },
      (candidate) => { candidate.stationSequences[0].terminalVariant = "변조역→춘천"; },
      (candidate) => { candidate.stationSequences[0].stopCount = 99; },
      (candidate) => { candidate.stationSequences[0].observedOdCount = 2; },
      (candidate) => { candidate.stationSequences[0].conflictingTimestampCount = 1; },
      (candidate) => { candidate.transitTrips[0].tripHeadsign = "변조역"; },
    ];
    for (const [index, mutate] of mutations.entries()) {
      const dir = await mkdtemp(path.join(tmpdir(), `itx-promotion-metadata-${index}-`));
      try {
        const sourceDir = path.join(dir, "tools/datapack/sources");
        await mkdir(sourceDir, { recursive: true });
        const previous = sourceCandidate({
          artifactId: "itx-cheongchun-source-timetable-20260714010000000",
          promotionStatus: "SUPPORTED",
        });
        const previousBytes = sourceBytes(previous);
        const previousSha = createHash("sha256").update(previousBytes).digest("hex");
        await writeFile(path.join(sourceDir, `${previous.artifactId}.json`), previousBytes);
        const contractPath = await writeCoverageContract(dir, JSON.stringify({
          sourceTimetableArtifact: {
            status: "ADMITTED",
            admissionEligible: true,
            artifactId: previous.artifactId,
            artifactPath: `tools/datapack/sources/${previous.artifactId}.json`,
            sha256: previousSha,
            schemaVersion: 1,
            policyVersion: "itx-snapshot-anomaly-v1",
            freshUntil: previous.freshUntil,
          },
        }));
        const candidate = sourceCandidate({ promotionStatus: "SUPPORTED" });
        candidate.snapshotDiff = unchangedSnapshotDiff(previousSha, candidate.normalizedSnapshotSets);
        mutate(candidate);
        rehashCandidate(candidate);
        const candidatePath = path.join(dir, "candidate.json");
        await writeFile(candidatePath, sourceBytes(candidate));
        await assert.rejects(promoteItxSourceCandidate({
          candidatePath,
          sourceOutputDir: sourceDir,
          coverageContractPath: contractPath,
          repositoryRoot: dir,
          now: new Date("2026-07-15T02:00:00.000Z"),
        }), /CANONICAL_CORRIDOR_AUTHORITY_INVALID|SOURCE_SNAPSHOT_SETS_MISMATCH/);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });

  await context.test("인접 stop 시각 단조성 tamper", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "itx-promotion-stop-order-"));
    try {
      const candidate = sourceCandidate();
      const sequence = candidate.stationSequences.find(({ dayCd, trainNumber }) => (
        dayCd === "8" && trainNumber === "2001"
      ));
      const stop = sequence.stops[1];
      stop.arrivalAt = "2026-07-16T07:00:00+09:00";
      stop.departureAt = stop.arrivalAt;
      stop.arrivalSeconds = 25_200;
      stop.departureSeconds = 25_200;
      const stopTime = candidate.transitStopTimes.find(({ tripId, stopSequence }) => (
        tripId === "route-line-54a7b980b7c3-up-2001-8" && stopSequence === 2
      ));
      stopTime.arrivalSeconds = stop.arrivalSeconds;
      stopTime.departureSeconds = stop.departureSeconds;
      const tuple = candidate.normalizedSnapshotSets.find(({ dayCd }) => dayCd === "8")
        .sets.timetableTupleSet.find(([, trainNumber, stationId]) => (
          trainNumber === "2001" && stationId === CHUNCHEON_STATION_ID
        ));
      tuple[3] = stop.arrivalSeconds;
      tuple[4] = stop.departureSeconds;
      rehashCandidate(candidate);
      const candidatePath = path.join(dir, "candidate.json");
      await writeFile(candidatePath, sourceBytes(candidate));
      const contractPath = await writeCoverageContract(dir, '{"schemaVersion":2}\n');
      await assert.rejects(promoteItxSourceCandidate({
        candidatePath,
        ...ownerApproval(candidate),
        sourceOutputDir: path.join(dir, "tools/datapack/sources"),
        coverageContractPath: contractPath,
        repositoryRoot: dir,
        now: new Date("2026-07-15T02:00:00.000Z"),
      }), /CANONICAL_CORRIDOR_AUTHORITY_INVALID/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  await context.test("day roster 밖 stop station tamper", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "itx-promotion-roster-stop-"));
    try {
      const candidate = sourceCandidate();
      const sequence = candidate.stationSequences.find((row) => row.dayCd === "8" && row.trainNumber === "2001");
      sequence.stops[0].stationId = "station-outside-roster";
      const stopTime = candidate.transitStopTimes.find((row) => (
        row.tripId === "route-line-54a7b980b7c3-up-2001-8" && row.stopSequence === 1
      ));
      stopTime.stationId = "station-outside-roster";
      const sets = candidate.normalizedSnapshotSets.find((row) => row.dayCd === "8").sets;
      sets.stopSequenceSet.find(([, trainNumber]) => trainNumber === "2001")[3][0] = "station-outside-roster";
      sets.timetableTupleSet.find(([, trainNumber, , arrival]) => (
        trainNumber === "2001" && arrival === 28_800
      ))[2] = "station-outside-roster";
      rehashCandidate(candidate);
      const candidatePath = path.join(dir, "candidate.json");
      await writeFile(candidatePath, sourceBytes(candidate));
      const contractPath = await writeCoverageContract(dir, '{"schemaVersion":2}\n');
      await assert.rejects(promoteItxSourceCandidate({
        candidatePath,
        ...ownerApproval(candidate),
        sourceOutputDir: path.join(dir, "tools/datapack/sources"),
        coverageContractPath: contractPath,
        repositoryRoot: dir,
        now: new Date("2026-07-15T02:00:00.000Z"),
      }), /CANONICAL_CORRIDOR_AUTHORITY_INVALID/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  await context.test("parseable timestamp without offset", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "itx-promotion-no-offset-"));
    try {
      const candidate = sourceCandidate({ freshUntil: "2026-07-20T00:00:00" });
      const candidatePath = path.join(dir, "candidate.json");
      await writeFile(candidatePath, sourceBytes(candidate));
      const contractPath = await writeCoverageContract(dir, '{"schemaVersion":2}\n');
      await assert.rejects(promoteItxSourceCandidate({
        candidatePath,
        ...ownerApproval(candidate),
        sourceOutputDir: path.join(dir, "tools/datapack/sources"),
        coverageContractPath: contractPath,
        repositoryRoot: dir,
        now: new Date("2026-07-15T02:00:00.000Z"),
      }), /SOURCE_SNAPSHOT_FRESHNESS_INVALID/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  await context.test("one-direction candidate", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "itx-promotion-direction-"));
    try {
      const candidate = sourceCandidate();
      candidate.stationSequences = candidate.stationSequences.filter(({ directionId }) => directionId === "up");
      candidate.transitTrips = candidate.transitTrips.filter(({ directionId }) => directionId === "up");
      const tripIds = new Set(candidate.transitTrips.map(({ id }) => id));
      candidate.transitStopTimes = candidate.transitStopTimes.filter(({ tripId }) => tripIds.has(tripId));
      for (const { sets } of candidate.normalizedSnapshotSets) {
        sets.trainSet = ["2001"];
        sets.stopSequenceSet = sets.stopSequenceSet.filter(([, trainNumber]) => trainNumber === "2001");
        sets.timetableTupleSet = sets.timetableTupleSet.filter(([, trainNumber]) => trainNumber === "2001");
      }
      rehashCandidate(candidate);
      const candidatePath = path.join(dir, "candidate.json");
      await writeFile(candidatePath, sourceBytes(candidate));
      const contractPath = await writeCoverageContract(dir, '{"schemaVersion":2}\n');
      await assert.rejects(promoteItxSourceCandidate({
        candidatePath,
        ...ownerApproval(candidate),
        sourceOutputDir: path.join(dir, "tools/datapack/sources"),
        coverageContractPath: contractPath,
        repositoryRoot: dir,
        now: new Date("2026-07-15T02:00:00.000Z"),
      }), /SOURCE_SNAPSHOT_SETS_MISMATCH/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  await context.test("trip service contract tamper", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "itx-promotion-trip-contract-"));
    try {
      const candidate = sourceCandidate();
      candidate.transitTrips[0].serviceId = "holiday-kric";
      rehashCandidate(candidate);
      const candidatePath = path.join(dir, "candidate.json");
      await writeFile(candidatePath, sourceBytes(candidate));
      const contractPath = await writeCoverageContract(dir, '{"schemaVersion":2}\n');
      await assert.rejects(promoteItxSourceCandidate({
        candidatePath,
        ...ownerApproval(candidate),
        sourceOutputDir: path.join(dir, "tools/datapack/sources"),
        coverageContractPath: contractPath,
        repositoryRoot: dir,
        now: new Date("2026-07-15T02:00:00.000Z"),
      }), /SOURCE_SNAPSHOT_SETS_MISMATCH/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  await context.test("stop time lineId tamper", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "itx-promotion-stop-line-"));
    try {
      const candidate = sourceCandidate();
      candidate.transitStopTimes[0].lineId = "line-corrupted";
      rehashCandidate(candidate);
      const candidatePath = path.join(dir, "candidate.json");
      await writeFile(candidatePath, sourceBytes(candidate));
      const contractPath = await writeCoverageContract(dir, '{"schemaVersion":2}\n');
      await assert.rejects(promoteItxSourceCandidate({
        candidatePath,
        ...ownerApproval(candidate),
        sourceOutputDir: path.join(dir, "tools/datapack/sources"),
        coverageContractPath: contractPath,
        repositoryRoot: dir,
        now: new Date("2026-07-15T02:00:00.000Z"),
      }), /SOURCE_SNAPSHOT_SETS_MISMATCH/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  await context.test("roster와 materialized stop의 lineId 동시 tamper", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "itx-promotion-all-lines-"));
    try {
      const candidate = sourceCandidate();
      candidate.stationRosters[0].stations[0].lineId = "line-corrupted";
      candidate.stationSequences[0].stops[0].lineId = "line-corrupted";
      candidate.transitStopTimes[0].lineId = "line-corrupted";
      rehashCandidate(candidate);
      const candidatePath = path.join(dir, "candidate.json");
      await writeFile(candidatePath, sourceBytes(candidate));
      const contractPath = await writeCoverageContract(dir, '{"schemaVersion":2}\n');
      await assert.rejects(promoteItxSourceCandidate({
        candidatePath,
        ...ownerApproval(candidate),
        sourceOutputDir: path.join(dir, "tools/datapack/sources"),
        coverageContractPath: contractPath,
        repositoryRoot: dir,
        now: new Date("2026-07-15T02:00:00.000Z"),
      }), /CANONICAL_CORRIDOR_AUTHORITY_INVALID/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  await context.test("same checkout arbitrary canonical pack identity", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "itx-promotion-pack-path-"));
    try {
      const candidate = sourceCandidate();
      const arbitraryPath = "tools/datapack/arbitrary-pack.bin";
      const arbitraryBytes = Buffer.from("not-canonical");
      await mkdir(path.join(dir, "tools/datapack"), { recursive: true });
      await writeFile(path.join(dir, arbitraryPath), arbitraryBytes);
      candidate.canonicalPackIdentity = {
        path: arbitraryPath,
        sha256: createHash("sha256").update(arbitraryBytes).digest("hex"),
      };
      rehashCandidate(candidate);
      const candidatePath = path.join(dir, "candidate.json");
      await writeFile(candidatePath, sourceBytes(candidate));
      const contractPath = await writeCoverageContract(dir, '{"schemaVersion":2}\n');
      await assert.rejects(promoteItxSourceCandidate({
        candidatePath,
        ...ownerApproval(candidate),
        sourceOutputDir: path.join(dir, "tools/datapack/sources"),
        coverageContractPath: contractPath,
        repositoryRoot: dir,
        now: new Date("2026-07-15T02:00:00.000Z"),
      }), /CANONICAL_PACK_IDENTITY_INVALID/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  await context.test("stale canonical pack identity", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "itx-promotion-pack-"));
    try {
      const candidate = sourceCandidate();
      const candidatePath = path.join(dir, "candidate.json");
      await writeFile(candidatePath, sourceBytes(candidate));
      const contractPath = await writeCoverageContract(dir, '{"schemaVersion":2}\n');
      await writeFile(path.join(dir, PACK_PATH), "changed-pack");
      await assert.rejects(promoteItxSourceCandidate({
        candidatePath,
        ...ownerApproval(candidate),
        sourceOutputDir: path.join(dir, "tools/datapack/sources"),
        coverageContractPath: contractPath,
        repositoryRoot: dir,
        now: new Date("2026-07-15T02:00:00.000Z"),
      }), /CANONICAL_PACK_IDENTITY_INVALID/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  await context.test("invalid observedAt approval provenance", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "itx-promotion-observed-at-"));
    try {
      const candidate = sourceCandidate({ observedAt: "not-a-date" });
      const bytes = sourceBytes(candidate);
      const digest = createHash("sha256").update(bytes).digest("hex");
      const candidatePath = path.join(dir, "candidate.json");
      await writeFile(candidatePath, bytes);
      const contractPath = await writeCoverageContract(dir, '{"schemaVersion":2}\n');
      await assert.rejects(promoteItxSourceCandidate({
        candidatePath,
        approvedSha256: digest,
        approvalUrl: "https://github.com/AquilaXk/easysubway/issues/2135#issuecomment-123",
        sourceOutputDir: path.join(dir, "tools/datapack/sources"),
        coverageContractPath: contractPath,
        repositoryRoot: dir,
        now: new Date("2026-07-15T02:00:00.000Z"),
        fetchImpl: async () => new Response(JSON.stringify({
          author_association: "OWNER",
          html_url: "https://github.com/AquilaXk/easysubway/issues/2135#issuecomment-123",
          body: `/approve-itx-bootstrap artifactId=${candidate.artifactId} sha256=${digest} policy=itx-snapshot-anomaly-v1`,
          created_at: "2026-07-15T01:30:00.000Z",
        }), { status: 200, headers: { "content-type": "application/json" } }),
      }), /ITX source candidate schema is invalid/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  await context.test("stored normalized sets tamper", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "itx-promotion-sets-"));
    try {
      const candidate = sourceCandidate();
      candidate.normalizedSnapshotSets[0].sets.trainSet = ["9999"];
      candidate.evidenceHash = createHash("sha256")
        .update(JSON.stringify({ ...candidate, evidenceHash: undefined }))
        .digest("hex");
      const { evidenceHash: _, ...withoutEvidence } = candidate;
      candidate.evidenceHash = createHash("sha256").update(JSON.stringify(withoutEvidence)).digest("hex");
      const candidatePath = path.join(dir, "candidate.json");
      await writeFile(candidatePath, sourceBytes(candidate));
      const contractPath = await writeCoverageContract(dir, '{"schemaVersion":2}\n');
      await assert.rejects(promoteItxSourceCandidate({
        candidatePath,
        sourceOutputDir: path.join(dir, "tools/datapack/sources"),
        coverageContractPath: contractPath,
        repositoryRoot: dir,
        now: new Date("2026-07-15T02:00:00.000Z"),
      }), /SOURCE_SNAPSHOT_SETS_MISMATCH/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  await context.test("arbitrary status and stale baseline digest", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "itx-promotion-authority-"));
    try {
      const sourceDir = path.join(dir, "tools/datapack/sources");
      await mkdir(sourceDir, { recursive: true });
      const previous = sourceCandidate({
        artifactId: "itx-cheongchun-source-timetable-20260714010000000",
        promotionStatus: "SUPPORTED",
      });
      const { reference: previousReference } = await writeAdmittedSourceBundle(sourceDir, previous);
      const previousSha = previousReference.sha256;
      const contractPath = await writeCoverageContract(dir, `${JSON.stringify({
        schemaVersion: 2,
        sourceTimetableArtifact: previousReference,
      }, null, 2)}\n`);

      const arbitraryStatus = sourceCandidate({ promotionStatus: "BOOTSTRAP_REVIEW_REQUIRED" });
      arbitraryStatus.snapshotDiff = unchangedSnapshotDiff(previousSha, arbitraryStatus.normalizedSnapshotSets);
      rehashCandidate(arbitraryStatus);
      const staleDigest = sourceCandidate({ promotionStatus: "SUPPORTED" });
      staleDigest.snapshotDiff = unchangedSnapshotDiff("f".repeat(64), staleDigest.normalizedSnapshotSets);
      rehashCandidate(staleDigest);
      for (const candidate of [arbitraryStatus, staleDigest]) {
        const candidatePath = path.join(dir, `${candidate.promotionStatus}-candidate.json`);
        await writeFile(candidatePath, sourceBytes(candidate));
        await assert.rejects(promoteItxSourceCandidate({
          candidatePath,
          sourceOutputDir: sourceDir,
          coverageContractPath: contractPath,
          repositoryRoot: dir,
          now: new Date("2026-07-15T02:00:00.000Z"),
        }), /SNAPSHOT_PROMOTION_AUTHORITY_INVALID/);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  await context.test("snapshot diff summary tamper", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "itx-promotion-snapshot-summary-"));
    try {
      const sourceDir = path.join(dir, "tools/datapack/sources");
      await mkdir(sourceDir, { recursive: true });
      const previous = sourceCandidate({
        artifactId: "itx-cheongchun-source-timetable-20260714010000000",
        promotionStatus: "SUPPORTED",
      });
      const { reference: previousReference } = await writeAdmittedSourceBundle(sourceDir, previous);
      const previousSha = previousReference.sha256;
      const contractPath = await writeCoverageContract(dir, `${JSON.stringify({
        sourceTimetableArtifact: previousReference,
      })}\n`);
      const candidate = sourceCandidate({ promotionStatus: "SUPPORTED" });
      candidate.snapshotDiff = unchangedSnapshotDiff(previousSha, candidate.normalizedSnapshotSets);
      candidate.snapshotDiff.serviceDays[0].sets.trainSet.count += 1;
      rehashCandidate(candidate);
      const candidatePath = path.join(dir, "candidate.json");
      await writeFile(candidatePath, sourceBytes(candidate));
      await assert.rejects(promoteItxSourceCandidate({
        candidatePath,
        sourceOutputDir: sourceDir,
        coverageContractPath: contractPath,
        repositoryRoot: dir,
        now: new Date("2026-07-15T02:00:00.000Z"),
      }), /SNAPSHOT_PROMOTION_AUTHORITY_INVALID/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  await context.test("absolute ADMITTED artifact path", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "itx-promotion-path-"));
    try {
      const previous = sourceCandidate({ artifactId: "itx-cheongchun-source-timetable-20260714010000000" });
      const previousPath = path.join(dir, "previous.json");
      const previousBytes = sourceBytes(previous);
      await writeFile(previousPath, previousBytes);
      const contractPath = await writeCoverageContract(dir, `${JSON.stringify({
        sourceTimetableArtifact: {
          status: "ADMITTED",
          admissionEligible: true,
          artifactId: previous.artifactId,
          artifactPath: previousPath,
          sha256: createHash("sha256").update(previousBytes).digest("hex"),
          schemaVersion: 1,
          policyVersion: "itx-snapshot-anomaly-v1",
          freshUntil: previous.freshUntil,
        },
      })}\n`);
      const candidate = sourceCandidate();
      const candidatePath = path.join(dir, "candidate.json");
      await writeFile(candidatePath, sourceBytes(candidate));
      await assert.rejects(promoteItxSourceCandidate({
        candidatePath,
        sourceOutputDir: path.join(dir, "tools/datapack/sources"),
        coverageContractPath: contractPath,
        repositoryRoot: dir,
        now: new Date("2026-07-15T02:00:00.000Z"),
      }), /ADMITTED_SOURCE_REFERENCE_INVALID/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

test("ITX CLI는 invalid input을 artifact 생성 전에 거부한다", async (context) => {
  const dir = await mkdtemp(path.join(tmpdir(), "itx-cli-invalid-"));
  const base = [
    "--day8-date", "20260715",
    "--day7-date", "20260718",
    "--day9-date", "20260719",
    "--canonical-pack", PACK_PATH,
  ];
  try {
    for (const scenario of [
      { name: "잘못된 날짜", argv: base.with(1, "20260718"), env: { DATA_GO_KR_SERVICE_KEY: "key" }, pattern: /dayCd 8/ },
      { name: "pack 누락", argv: base.slice(0, -2), env: { DATA_GO_KR_SERVICE_KEY: "key" }, pattern: /--canonical-pack/ },
      { name: "credential 누락", argv: base, env: {}, pattern: /DATA_GO_KR_SERVICE_KEY/ },
    ]) {
      await context.test(scenario.name, async () => {
        const output = path.join(dir, `${scenario.name}.json`);
        await assert.rejects(runKorailItxCompletenessCli({
          argv: [...scenario.argv, "--output", output],
          env: scenario.env,
          now: new Date("2026-07-14T00:00:00.000Z"),
          collectImpl: async () => assert.fail("must not run"),
        }), scenario.pattern);
        await assert.rejects(readFile(output), /ENOENT/);
      });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ITX CLI promotion은 주입된 repository root를 전달한다", async () => {
  const repositoryRoot = "/tmp/itx-alternate-checkout";
  let received;
  const result = await runKorailItxCompletenessCli({
    argv: [
      "--promote-candidate", "/tmp/candidate.json",
      "--completeness-evidence", "/tmp/candidate.completeness.json",
      "--source-output-dir", "/tmp/itx-alternate-checkout/tools/datapack/sources",
      "--coverage-contract", "/tmp/itx-alternate-checkout/tools/datapack/itx-cheongchun-coverage-contract.json",
    ],
    env: {},
    repositoryRoot,
    promoteImpl: async (options) => {
      received = options;
      return { sourceTimetableArtifact: { status: "ADMITTED" } };
    },
  });

  assert.equal(received.repositoryRoot, repositoryRoot);
  assert.equal(result.promotion.sourceTimetableArtifact.status, "ADMITTED");
});

test("ITX CLI는 canonical coverage contract 복사본으로 admission authority를 우회하지 못한다", async () => {
  const repositoryRoot = "/tmp/itx-alternate-checkout";
  await assert.rejects(runKorailItxCompletenessCli({
    argv: [
      "--promote-candidate", "/tmp/candidate.json",
      "--completeness-evidence", "/tmp/candidate.completeness.json",
      "--source-output-dir", "/tmp/itx-alternate-checkout/tools/datapack/sources",
      "--coverage-contract", "/tmp/copied-itx-contract.json",
    ],
    env: {},
    repositoryRoot,
    promoteImpl: async () => assert.fail("promotion must not run"),
  }), /ITX coverage contract path must be canonical/);
});

test("Korail ITX-청춘 collector는 공식 station rows를 canonical EXPRESS trip으로 만든다", async () => {
  const { plans, info } = fixtureRows();
  const requested = [];
  const artifact = await collectKorailItxCheongchunTimetable({
    serviceKey: "never-print-this-key",
    runDate: "20260713",
    kricServiceDayCode: "8",
    packPath: PACK_PATH,
    trainNumberEvidence: trainNumberEvidence(),
    now: new Date("2026-07-14T06:00:00.000Z"),
    fetchImpl: async (url) => {
      requested.push(url);
      if (url.pathname.endsWith("codes2")) {
        return url.searchParams.get("cond[type::EQ]") === "mrnt_cd"
          ? apiResponse([{ code: "GJ", type: "mrnt_cd", value: "경춘선" }])
          : apiResponse([{ code: "11", type: "stop_se_cd", value: "여객승하차" }]);
      }
      return apiResponse(url.pathname.endsWith("travelerTrainRunPlan2") ? plans : info);
    },
  });

  assert.equal(requested.length, 4);
  assert.equal(requested[0].searchParams.get("cond[type::EQ]"), "mrnt_cd");
  assert.equal(requested[1].searchParams.get("cond[type::EQ]"), "stop_se_cd");
  assert.equal(requested[3].searchParams.get("cond[mrnt_cd::EQ]"), "GJ");
  assert.deepEqual(artifact.routeCodeMapping, { providerCode: "GJ", providerName: "경춘선" });
  assert.equal(artifact.providerResultCode, "0");
  assert.equal(artifact.trainCount, 2);
  assert.equal(artifact.transitTrips.length, 2);
  assert.equal(artifact.transitStopTimes.length, 7);
  assert.ok(artifact.transitTrips.every(({ servicePattern }) => servicePattern === "EXPRESS"));
  assert.deepEqual(artifact.directions, ["D", "U"]);
  assert.deepEqual(artifact.terminalVariants, [
    { directionCode: "D", originStationName: "용산", destinationStationName: "춘천" },
    { directionCode: "U", originStationName: "춘천", destinationStationName: "청량리" },
  ]);
  assert.deepEqual(artifact.trainNumberSets, {
    roster: ["2001", "2002"],
    plan: ["2001", "2002"],
    info: ["2001", "2002"],
    materialized: ["2001", "2002"],
  });
  assert.deepEqual(
    artifact.transitStopTimes.filter(({ tripId }) => tripId.includes("-2001-")).map(({ stationId }) => stationId),
    ["station-8aa315864466", "station-b819702fa7d9", "station-f3d9c93ba7d6", "station-dd14cfb89cbc"],
  );
  assert.equal(artifact.credentialRedacted, true);
  assert.doesNotMatch(JSON.stringify(artifact), /never-print-this-key/);
});

test("Korail station row의 시각이 비면 sequence evidence만 보존하고 timetable 지원을 열지 않는다", async () => {
  const { plans, info } = fixtureRows();
  const missingTimes = info.map((row) => row.trn_no === "02001" && row.stn_nm === "청량리"
    ? { ...row, trn_arvl_dt: "", trn_dptre_dt: "" }
    : row);
  const artifact = await collectKorailItxCheongchunTimetable({
    serviceKey: "key",
    runDate: "20260713",
    kricServiceDayCode: "8",
    packPath: PACK_PATH,
    trainNumberEvidence: trainNumberEvidence(),
    fetchImpl: async (url) => {
      if (url.pathname.endsWith("codes2")) {
        return url.searchParams.get("cond[type::EQ]") === "mrnt_cd"
          ? apiResponse([{ code: "GJ", type: "mrnt_cd", value: "경춘선" }])
          : apiResponse([{ code: "11", type: "stop_se_cd", value: "여객승하차" }]);
      }
      return apiResponse(url.pathname.endsWith("travelerTrainRunPlan2") ? plans : missingTimes);
    },
  });

  assert.deepEqual(artifact.materialization, {
    status: "MISSING_STATION_TIMES",
    missingTimestampStopCount: 1,
    stationTimeCapability: {
      status: "MISSING",
      reasonCode: "PARTIAL_OFFICIAL_OPERATION_FIELDS_EMPTY",
      checkedStopCount: 7,
      populatedTimestampStopCount: 6,
      requiredTimestampFieldCount: 10,
      populatedTimestampFieldCount: 8,
    },
  });
  assert.equal(artifact.stationSequences.length, 2);
  assert.equal(artifact.stationSequences[0].stops.length, 4);
  assert.deepEqual(artifact.transitTrips, []);
  assert.deepEqual(artifact.transitStopTimes, []);
});

test("Korail station row의 필수 시각이 부분적으로 있으면 전체 필드 empty로 분류하지 않는다", async () => {
  const { plans, info } = fixtureRows();
  const lastSequenceByTrain = new Map([["02001", 4], ["02002", 3]]);
  const partialTimes = info.map((row) => ({
    ...row,
    trn_dptre_dt: row.trn_run_sn < lastSequenceByTrain.get(row.trn_no) ? "" : row.trn_dptre_dt,
    trn_arvl_dt: row.trn_run_sn === lastSequenceByTrain.get(row.trn_no) ? "" : row.trn_arvl_dt,
  }));
  const artifact = await collectKorailItxCheongchunTimetable({
    serviceKey: "key",
    runDate: "20260713",
    kricServiceDayCode: "8",
    packPath: PACK_PATH,
    trainNumberEvidence: trainNumberEvidence(),
    fetchImpl: async (url) => {
      if (url.pathname.endsWith("codes2")) {
        return url.searchParams.get("cond[type::EQ]") === "mrnt_cd"
          ? apiResponse([{ code: "GJ", type: "mrnt_cd", value: "경춘선" }])
          : apiResponse([{ code: "11", type: "stop_se_cd", value: "여객승하차" }]);
      }
      return apiResponse(url.pathname.endsWith("travelerTrainRunPlan2") ? plans : partialTimes);
    },
  });

  assert.deepEqual(artifact.materialization.stationTimeCapability, {
    status: "MISSING",
    reasonCode: "PARTIAL_OFFICIAL_OPERATION_FIELDS_EMPTY",
    checkedStopCount: 7,
    populatedTimestampStopCount: 0,
    requiredTimestampFieldCount: 10,
    populatedTimestampFieldCount: 3,
  });
});

test("Korail collector는 legacy 대전 row를 canonical mapping 전에 count와 함께 거부한다", async () => {
  const { plans, info } = fixtureRows();
  const legacyPlans = plans.map((row) => row.trn_no === "02001"
    ? { ...row, arvl_stn_cd: "0010", arvl_stn_nm: "대전" }
    : row);
  const legacyInfo = info.map((row) => row.trn_no === "02001" && row.trn_run_sn === 4
    ? { ...row, stn_cd: "0010", stn_nm: "대전" }
    : row);
  await assert.rejects(collectKorailItxCheongchunTimetable({
    serviceKey: "key",
    runDate: "20260713",
    kricServiceDayCode: "8",
    packPath: PACK_PATH,
    trainNumberEvidence: trainNumberEvidence(),
    fetchImpl: async (url) => {
      if (url.pathname.endsWith("codes2")) {
        return url.searchParams.get("cond[type::EQ]") === "mrnt_cd"
          ? apiResponse([{ code: "GJ", type: "mrnt_cd", value: "경춘선" }])
          : apiResponse([{ code: "11", type: "stop_se_cd", value: "여객승하차" }]);
      }
      return apiResponse(url.pathname.endsWith("travelerTrainRunPlan2") ? legacyPlans : legacyInfo);
    },
  }), (error) => {
    assert.match(error.message, /legacy Daejeon data must be zero/);
    assert.equal(error.legacyDaejeonRowCount, 1);
    assert.equal(error.legacyYongsanDaejeonTripCount, 1);
    return true;
  });
});

test(
  `live evidence는 TAGO 18편을 Korail canonical sequence로 검증하고 빈 시각을 거부한다 ` +
    `(sequences=${LIVE_EVIDENCE.stationSequenceRowCount},missing=${LIVE_EVIDENCE.materialization.missingTimestampStopCount})`,
  () => {
    assert.equal(LIVE_EVIDENCE.artifactKind, "korail-itx-cheongchun-station-sequence-evidence");
    assert.equal(LIVE_EVIDENCE.trainCount, 18);
    assert.equal(LIVE_TAGO_EVIDENCE.trainNumbers.length, 18);
    assert.equal(LIVE_TAGO_EVIDENCE.evidenceHash, LIVE_EVIDENCE.trainNumberFilter.evidenceHash);
    assert.equal(LIVE_EVIDENCE.trainNumberFilter.trainNumberCount, 18);
    assert.ok(LIVE_EVIDENCE.stationSequenceRowCount > 0);
    assert.equal(LIVE_EVIDENCE.stationSequences.length, 18);
    assert.equal(LIVE_EVIDENCE.materialization.status, "MISSING_STATION_TIMES");
    assert.ok(LIVE_EVIDENCE.materialization.missingTimestampStopCount > 0);
    assert.deepEqual(LIVE_EVIDENCE.materialization.stationTimeCapability, {
      status: "EXPLICITLY_UNSUPPORTED_WITH_EVIDENCE",
      reasonCode: "OFFICIAL_OPERATION_FIELDS_EMPTY",
      checkedStopCount: 113,
      populatedTimestampStopCount: 0,
      requiredTimestampFieldCount: 190,
      populatedTimestampFieldCount: 0,
      verifiedAt: "2026-07-14T06:36:22.122Z",
      travelerTrainRunInfo2RawResponseSha256: "ff64cf6683de1fbc089dde751af198b4745bbd71260b3867cef69f615bafce4c",
    });
    assert.deepEqual(LIVE_EVIDENCE.transitTrips, []);
    assert.deepEqual(LIVE_EVIDENCE.transitStopTimes, []);
    assert.match(LIVE_EVIDENCE.evidenceHash, /^[a-f0-9]{64}$/);
    assert.equal(LIVE_EVIDENCE.credentialRedacted, true);
    assert.equal(LIVE_TAGO_EVIDENCE.credentialRedacted, true);
    assert.doesNotMatch(JSON.stringify([LIVE_EVIDENCE, LIVE_TAGO_EVIDENCE]),
      /serviceKey|DATA_GO_KR_SERVICE_KEY|KRIC_SERVICE_KEY/);
  },
);

test("Korail ITX materialization은 경춘선 밖 역을 포함한 용산~춘천 전체 trip을 보존한다", () => {
  const { plans, info } = fixtureRows();
  const fullTrip = info
    .filter(({ trn_no }) => trn_no === "02001")
    .map((row) => ({ ...row, trn_run_sn: row.trn_run_sn + (row.trn_run_sn > 1 ? 2 : 0) }));
  fullTrip[0] = { ...fullTrip[0], stop_se_cd: "11", stop_se_nm: "여객승하차" };
  fullTrip.splice(
    1,
    0,
    infoRow("02001", 2, "0106", "옥수", "20260713060800", "20260713060900"),
    infoRow("02001", 3, "0111", "왕십리", "20260713061400", "20260713061500"),
  );

  const materialized = materializeKorailItxRows({
    plans,
    infoRows: fullTrip,
    runDate: "20260713",
    kricServiceDayCode: "8",
    packPath: PACK_PATH,
    trainNumbers: ["02001"],
    routeCode: "GJ",
    passengerStopCodes: new Map([["11", "여객승하차"]]),
  });

  assert.deepEqual(materialized.transitStopTimes.map(({ stationId }) => stationId), [
    "station-8aa315864466",
    "station-c0679b9a6cf8",
    "station-e5cf592cf355",
    "station-b819702fa7d9",
    "station-f3d9c93ba7d6",
    "station-dd14cfb89cbc",
  ]);
  assert.deepEqual(materialized.transitStopTimes.map(({ lineId }) => lineId), [
    "line-6e39be0cb6e2",
    "line-6e39be0cb6e2",
    "line-6e39be0cb6e2",
    "line-54a7b980b7c3",
    "line-54a7b980b7c3",
    "line-54a7b980b7c3",
  ]);
});

test("Korail collector는 한 방향 roster를 timetable로 admission하지 않는다", async () => {
  const { plans, info } = fixtureRows();
  const roster = trainNumberEvidence();
  await assert.rejects(collectKorailItxCheongchunTimetable({
    serviceKey: "key",
    runDate: "20260713",
    kricServiceDayCode: "8",
    packPath: PACK_PATH,
    trainNumberEvidence: {
      ...roster,
      trainNumbers: ["02001"],
      itineraries: [roster.itineraries[0]],
    },
    fetchImpl: async (url) => {
      if (url.pathname.endsWith("codes2")) {
        return url.searchParams.get("cond[type::EQ]") === "mrnt_cd"
          ? apiResponse([{ code: "GJ", type: "mrnt_cd", value: "경춘선" }])
          : apiResponse([{ code: "11", type: "stop_se_cd", value: "여객승하차" }]);
      }
      return apiResponse(url.pathname.endsWith("travelerTrainRunPlan2") ? plans : info);
    },
  }), /both directions/);
});

test("Korail materialization은 현재 시종착 변형을 plan endpoint 그대로 보존한다", () => {
  const { info } = fixtureRows();
  const materialized = materializeKorailItxRows({
    plans: [planRow("02001", "용산", "평내호평", "20260713060000", "20260713071000")],
    infoRows: info.filter(({ trn_no, stn_nm }) => trn_no === "02001" && stn_nm !== "춘천"),
    runDate: "20260713",
    kricServiceDayCode: "8",
    packPath: PACK_PATH,
    trainNumbers: ["02001"],
    routeCode: "GJ",
    passengerStopCodes: new Map([["11", "여객승하차"]]),
  });

  assert.equal(materialized.transitTrips[0].tripHeadsign, "평내호평");
  assert.deepEqual(materialized.transitStopTimes.map(({ stationId }) => stationId), [
    "station-8aa315864466",
    "station-b819702fa7d9",
    "station-f3d9c93ba7d6",
  ]);
});

test("Korail ITX materialization은 누락·중복·역순·시각 역전을 거부한다", async (context) => {
  const { plans, info } = fixtureRows();
  const base = {
    plans,
    infoRows: info,
    runDate: "20260713",
    kricServiceDayCode: "8",
    packPath: PACK_PATH,
    trainNumbers: trainNumberEvidence().trainNumbers,
    routeCode: "GJ",
    passengerStopCodes: new Map([["11", "여객승하차"]]),
  };

  await context.test("양 끝역 누락", () => {
    assert.throws(() => materializeKorailItxRows({
      ...base,
      infoRows: info.filter(({ stn_nm }) => stn_nm !== "춘천"),
    }), /at least 2 canonical stops|plan endpoint|plan arrival/);
  });

  await context.test("중복 정차", () => {
    assert.throws(() => materializeKorailItxRows({
      ...base,
      infoRows: [...info, { ...info[2], trn_run_sn: 3.5 }],
    }), /duplicate canonical stop|trn_run_sn/);
  });

  await context.test("역순 정차", () => {
    const zigzag = info.map((row) => row.trn_no === "02001" && row.stn_nm === "춘천"
      ? { ...row, trn_run_sn: 5 }
      : row);
    zigzag.splice(3, 0, infoRow("02001", 4, "130161", "상봉", "20260713073000", "20260713073100"));
    assert.throws(() => materializeKorailItxRows({ ...base, infoRows: zigzag }), /lineSequence/);
  });

  await context.test("시각 역전", () => {
    const reversedTime = info.map((row) => row.trn_no === "02001" && row.stn_nm === "평내호평"
      ? { ...row, trn_arvl_dt: "20260713071200", trn_dptre_dt: "20260713071100" }
      : row);
    assert.throws(() => materializeKorailItxRows({ ...base, infoRows: reversedTime }), /arrival.*departure/);
  });

  await context.test("중간역 계획 출발시각 누락", () => {
    const missingDeparture = info.map((row) => row.trn_no === "02001" && row.stn_nm === "평내호평"
      ? { ...row, trn_dptre_dt: "" }
      : row);
    assert.throws(() => materializeKorailItxRows({ ...base, infoRows: missingDeparture }), /planned timestamp missing/);
  });

  await context.test("plan 출발시각 누락", () => {
    const missingPlanTime = plans.map((row) => row.trn_no === "02001"
      ? { ...row, trn_plan_dptre_dt: "" }
      : row);
    assert.throws(() => materializeKorailItxRows({ ...base, plans: missingPlanTime }), /plan timestamp missing/);
  });

  await context.test("plan 시각의 service date 불일치", () => {
    const wrongPlanDate = plans.map((row) => row.trn_no === "02001"
      ? { ...row, trn_plan_dptre_dt: "20260712060000" }
      : row);
    assert.throws(() => materializeKorailItxRows({ ...base, plans: wrongPlanDate }), /runDate or the immediately following date/);
  });

  await context.test("plan 출발시각과 첫 정차 출발시각 불일치", () => {
    const mismatchedPlanDeparture = plans.map((row) => row.trn_no === "02001"
      ? { ...row, trn_plan_dptre_dt: "20260713060100" }
      : row);
    assert.throws(() => materializeKorailItxRows({
      ...base,
      plans: mismatchedPlanDeparture,
    }), /plan departure.*first stop departure/);
  });

  await context.test("plan 도착시각과 마지막 정차 도착시각 불일치", () => {
    const mismatchedPlanArrival = plans.map((row) => row.trn_no === "02001"
      ? { ...row, trn_plan_arvl_dt: "20260713075900" }
      : row);
    assert.throws(() => materializeKorailItxRows({
      ...base,
      plans: mismatchedPlanArrival,
    }), /plan arrival.*last stop arrival/);
  });

  await context.test("지원하지 않는 service day", () => {
    assert.throws(() => materializeKorailItxRows({
      ...base,
      kricServiceDayCode: "6",
    }), /kricServiceDayCode must be 7, 8, or 9/);
  });

  await context.test("U/D가 아닌 방향 code", () => {
    const invalidDirection = info.map((row) => row.trn_no === "02001"
      ? { ...row, uppln_dn_se_cd: null }
      : row);
    assert.throws(() => materializeKorailItxRows({
      ...base,
      infoRows: invalidDirection,
    }), /direction code/);
  });

  await context.test("canonical mapping이 없는 여객 정차", () => {
    const withInteriorGap = info.map((row) => {
      if (row.trn_no !== "02001" || row.trn_run_sn < 3) return row;
      return { ...row, trn_run_sn: row.trn_run_sn + 1 };
    });
    withInteriorGap.push(infoRow(
      "02001", 3, "999999", "미등록역", "20260713065000", "20260713065100",
    ));
    assert.throws(() => materializeKorailItxRows({
      ...base,
      infoRows: withInteriorGap,
    }), /passenger stop canonical mapping missing/);
  });

  await context.test("여객 정차 code-name 불일치", () => {
    const mismatchedStopName = info.map((row) => row.trn_no === "02001" && row.stn_nm === "평내호평"
      ? { ...row, stop_se_nm: "통과" }
      : row);
    assert.throws(() => materializeKorailItxRows({ ...base, infoRows: mismatchedStopName }), /passenger stop name mismatch/);
  });

  await context.test("익일 도착", () => {
    const overnight = info.map((row) => {
      if (row.trn_no !== "02001") return row;
      if (row.stn_nm === "청량리") return { ...row, trn_arvl_dt: "20260713235000", trn_dptre_dt: "20260713235100" };
      if (row.stn_nm === "평내호평") return { ...row, trn_arvl_dt: "20260714003000", trn_dptre_dt: "20260714003100" };
      if (row.stn_nm === "춘천") return { ...row, trn_arvl_dt: "20260714010000", trn_dptre_dt: "-" };
      return row;
    });
    const overnightPlans = plans.map((row) => row.trn_no === "02001"
      ? { ...row, trn_plan_arvl_dt: "20260714010000" }
      : row);
    const materialized = materializeKorailItxRows({
      ...base,
      plans: overnightPlans,
      infoRows: overnight,
    });
    assert.ok(materialized.transitStopTimes
      .filter(({ tripId }) => tripId.includes("-2001-"))
      .at(-1).arrivalSeconds > 86_400);
  });
});

test("Korail ITX collector는 provider/schema/pagination 오류를 fail closed한다", async (context) => {
  const base = {
    serviceKey: "key",
    runDate: "20260713",
    kricServiceDayCode: "8",
    packPath: PACK_PATH,
    trainNumberEvidence: trainNumberEvidence(),
  };

  await context.test("provider failure", async () => {
    await assert.rejects(collectKorailItxCheongchunTimetable({
      ...base,
      fetchImpl: async () => new Response(JSON.stringify({ response: { header: { resultCode: "30" }, body: {} } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    }), /provider resultCode 30/);
  });

  await context.test("transport 오류는 최대 두 번 재시도", async () => {
    let attempts = 0;
    await assert.rejects(collectKorailItxCheongchunTimetable({
      ...base,
      fetchImpl: async () => {
        attempts += 1;
        throw new Error("socket unavailable");
      },
    }), /transport failure/);
    assert.equal(attempts, 3);
  });

  await context.test("최종 503 응답 body도 정리", async () => {
    let attempts = 0;
    let cancellations = 0;
    await assert.rejects(collectKorailItxCheongchunTimetable({
      ...base,
      fetchImpl: async () => {
        attempts += 1;
        return new Response(new ReadableStream({
          cancel() { cancellations += 1; },
        }), { status: 503 });
      },
    }), /^Error: Korail train operation API HTTP 503$/);
    assert.equal(attempts, 3);
    assert.equal(cancellations, 3);
  });

  await context.test("schema mismatch", async () => {
    await assert.rejects(collectKorailItxCheongchunTimetable({
      ...base,
      fetchImpl: async () => apiResponse([{ run_ymd: "20260713" }]),
    }), /fields missing/);
  });

  await context.test("2페이지 정상 수집", async () => {
    const { plans, info } = fixtureRows();
    const artifact = await collectKorailItxCheongchunTimetable({
      ...base,
      fetchImpl: async (url) => {
        if (url.pathname.endsWith("codes2") && url.searchParams.get("cond[type::EQ]") === "mrnt_cd") {
          return url.searchParams.get("pageNo") === "1"
            ? apiResponse([{ code: "GJ", type: "mrnt_cd", value: "경춘선" }], { totalCount: 2 })
            : apiResponse([{ code: "XX", type: "other", value: "기타" }], { totalCount: 2, pageNo: 2 });
        }
        if (url.pathname.endsWith("codes2")) {
          return apiResponse([{ code: "11", type: "stop_se_cd", value: "여객승하차" }]);
        }
        return apiResponse(url.pathname.endsWith("travelerTrainRunPlan2") ? plans : info);
      },
    });
    assert.equal(artifact.operations[0].pageCount, 2);
  });

  await context.test("빈 중간 페이지", async () => {
    await assert.rejects(collectKorailItxCheongchunTimetable({
      ...base,
      fetchImpl: async (url) => url.searchParams.get("pageNo") === "1"
        ? apiResponse([{ code: "GJ", type: "mrnt_cd", value: "경춘선" }], { totalCount: 2 })
        : apiResponse([], { totalCount: 2, pageNo: 2 }),
    }), /pagination incomplete: operation=codes2,collected=1,total=2,pages=2/);
  });

  await context.test("공식 totalCount 0은 pagination 오류로 오분류하지 않음", async () => {
    const { plans } = fixtureRows();
    await assert.rejects(collectKorailItxCheongchunTimetable({
      ...base,
      fetchImpl: async (url) => {
        if (url.pathname.endsWith("codes2")) {
          return url.searchParams.get("cond[type::EQ]") === "mrnt_cd"
            ? apiResponse([{ code: "GJ", type: "mrnt_cd", value: "경춘선" }])
            : apiResponse([{ code: "11", type: "stop_se_cd", value: "여객승하차" }]);
        }
        return url.pathname.endsWith("travelerTrainRunPlan2")
          ? apiResponse(plans)
          : apiResponse([], { totalCount: 0 });
      },
    }), /run info returned zero rows/);
  });

  await context.test("페이지 사이 totalCount 변경", async () => {
    await assert.rejects(collectKorailItxCheongchunTimetable({
      ...base,
      fetchImpl: async (url) => url.searchParams.get("pageNo") === "1"
        ? apiResponse([{ code: "GJ", type: "mrnt_cd", value: "경춘선" }], { totalCount: 2 })
        : apiResponse([{ code: "XX", type: "other", value: "기타" }], { totalCount: 3, pageNo: 2 }),
    }), /totalCount changed/);
  });
});

test("Korail/TAGO timetable join은 service date가 다르면 거부한다", async () => {
  const { plans, info } = fixtureRows();
  const mismatchedEvidence = { ...trainNumberEvidence(), serviceDate: "20260714" };
  await assert.rejects(collectKorailItxCheongchunTimetable({
    serviceKey: "key",
    runDate: "20260713",
    kricServiceDayCode: "8",
    packPath: PACK_PATH,
    trainNumberEvidence: mismatchedEvidence,
    fetchImpl: async (url) => {
      if (url.pathname.endsWith("codes2")) {
        return url.searchParams.get("cond[type::EQ]") === "mrnt_cd"
          ? apiResponse([{ code: "GJ", type: "mrnt_cd", value: "경춘선" }])
          : apiResponse([{ code: "11", type: "stop_se_cd", value: "여객승하차" }]);
      }
      return apiResponse(url.pathname.endsWith("travelerTrainRunPlan2") ? plans : info);
    },
  }), /service date mismatch/);
});

test("KORAIL plan은 TAGO materialized 열차별 exact 1행만 선택해 endpoint 시각을 검증한다", () => {
  const selected = validateKorailItxPlans({
    plans: [
      planRow("9999", "서울", "부산", "20260713050000", "20260713100000"),
      planRow("ITX-02001", "용산", "춘천", "20260713060000", "20260713080000"),
    ],
    materialized: tagoMaterializedFixture(),
    runDate: "20260713",
  });

  assert.deepEqual(selected.trainNumbers, ["2001"]);
  assert.equal(selected.selectedPlans.length, 1);
  assert.equal(selected.selectedPlans[0].normalizedTrainNumber, "2001");
  assert.deepEqual(selected.trainNumbers, selected.selectedPlans.map(({ normalizedTrainNumber }) => normalizedTrainNumber));
  assert.equal(selected.trainSetHash, createHash("sha256").update(JSON.stringify(selected.trainNumbers)).digest("hex"));
  assert.throws(() => validateKorailItxPlans({
    plans: [planRow("20O1", "용산", "춘천", "20260713060000", "20260713080000")],
    materialized: tagoMaterializedFixture(),
    runDate: "20260713",
  }), /invalid train number/);
});

test("fresh KORAIL admission은 travelerTrainRunPlan2만 호출하고 future info를 호출하지 않는다", async () => {
  const requestedOperations = [];
  const artifact = await collectKorailItxCheongchunPlan({
    serviceKey: "key",
    runDate: "20260713",
    kricServiceDayCode: "8",
    trainNumberEvidence: {
      ...trainNumberEvidence(),
      schemaVersion: 2,
      ...tagoMaterializedFixture(),
    },
    fetchImpl: async (url) => {
      requestedOperations.push(url.pathname.split("/").at(-1));
      return apiResponse([
        planRow("02001", "용산", "춘천", "20260713060000", "20260713080000"),
        planRow("02002", "춘천", "용산", "20260713070000", "20260713090000"),
      ]);
    },
  });

  assert.deepEqual(requestedOperations, ["travelerTrainRunPlan2"]);
  assert.equal(artifact.materialization.status, "SUPPORTED");
  assert.deepEqual(artifact.requiredTrainNumberSets, ["TAGO_OD", "MATERIALIZED"]);
  assert.deepEqual(artifact.korailPlanCorroboration, {
    availableCount: 2,
    missingCount: 0,
    duplicateCount: 0,
    mismatchCount: 0,
    warningCodes: [],
    missingTrainNumbers: [],
    corroboratedTrainSetHash: artifact.trainSetHashes.korailPlan,
  });
});

test("KORAIL plan row 0건은 admission을 뒤집지 않고 warning evidence로 기록한다", async () => {
  const artifact = await collectKorailItxCheongchunPlan({
    serviceKey: "key",
    runDate: "20260713",
    kricServiceDayCode: "8",
    trainNumberEvidence: {
      ...trainNumberEvidence(),
      schemaVersion: 2,
      ...tagoMaterializedFixture(),
    },
    fetchImpl: async () => apiResponse([]),
  });

  assert.equal(artifact.materialization.status, "SUPPORTED");
  assert.deepEqual(artifact.requiredTrainNumberSets, ["TAGO_OD", "MATERIALIZED"]);
  assert.deepEqual(artifact.trainNumberSets.korailPlan, []);
  assert.deepEqual(artifact.korailPlanCorroboration, {
    availableCount: 0,
    missingCount: 2,
    duplicateCount: 0,
    mismatchCount: 0,
    warningCodes: ["KORAIL_PLAN_NOT_AVAILABLE"],
    missingTrainNumbers: ["2001", "2002"],
    corroboratedTrainSetHash: createHash("sha256").update(JSON.stringify([])).digest("hex"),
  });
});

test("KORAIL plan selection은 missing warning과 duplicate·date·endpoint·time mismatch를 구분한다", () => {
  const materialized = tagoMaterializedFixture();
  const valid = planRow("02001", "용산", "춘천", "20260713060000", "20260713080000");
  const input = (plans) => ({ plans, materialized, runDate: "20260713" });

  const missing = validateKorailItxPlans(input([]));
  assert.deepEqual(missing.trainNumbers, []);
  assert.deepEqual(missing.missingTrainNumbers, ["2001", "2002"]);
  assert.throws(() => validateKorailItxPlans(input([valid, { ...valid }])), /KORAIL_PLAN_DUPLICATE/);
  assert.throws(() => validateKorailItxPlans(input([{ ...valid, run_ymd: "20260714" }])), /KORAIL_PLAN_MISMATCH/);
  assert.throws(() => validateKorailItxPlans(input([{ ...valid, dptre_stn_nm: "청량리" }])), /KORAIL_PLAN_MISMATCH/);
  assert.throws(() => validateKorailItxPlans(input([{ ...valid, trn_plan_dptre_dt: "20260713060100" }])), /KORAIL_PLAN_MISMATCH/);
  assert.throws(() => validateKorailItxPlans(input([{ ...valid, arvl_stn_nm: "청량리" }])), /KORAIL_PLAN_MISMATCH/);
  assert.throws(() => validateKorailItxPlans(input([{ ...valid, trn_plan_arvl_dt: "20260713080100" }])), /KORAIL_PLAN_MISMATCH/);
  assert.throws(() => validateKorailItxPlans(input([
    planRow("02001", "용산", "대전", "20260713060000", "20260713080000"),
  ])), /KORAIL_PLAN_MISMATCH/);
});

test("KORAIL plan 시각은 YYYYMMDDHHMISS와 YYYY-MM-DD HH:MM:SS[.f] 두 포맷만 엄격히 수용한다", () => {
  const materialized = tagoMaterializedFixture();
  const input = (plans) => ({ plans, materialized, runDate: "20260713" });

  // 대체 포맷(소수점 초 없음)도 동일 실제 시각이면 정상 통과한다.
  const noFraction = validateKorailItxPlans(input([
    planRow("02001", "용산", "춘천", "2026-07-13 06:00:00", "2026-07-13 08:00:00"),
  ]));
  assert.deepEqual(noFraction.trainNumbers, ["2001"]);

  // 대체 포맷(소수점 초 포함, provider 관측 포맷 그대로)도 정상 통과한다.
  const withFraction = validateKorailItxPlans(input([
    planRow("02001", "용산", "춘천", "2026-07-13 06:00:00.0", "2026-07-13 08:00:00.0"),
  ]));
  assert.deepEqual(withFraction.trainNumbers, ["2001"]);

  // 같은 호출 안에서 두 포맷이 섞여도 각자 정상 파싱된다.
  const mixedFormats = validateKorailItxPlans(input([
    planRow("02001", "용산", "춘천", "2026-07-13 06:00:00.0", "2026-07-13 08:00:00.0"),
    planRow("02002", "춘천", "용산", "20260713070000", "20260713090000"),
  ]));
  assert.deepEqual(mixedFormats.trainNumbers, ["2001", "2002"]);

  // 대체 포맷이라도 실제 컨텐츠(시각)가 TAGO와 다르면 여전히 fail-closed다 — 포맷 관용은
  // 문자열 파싱에만 적용되고 불일치 판정 로직은 변경하지 않는다.
  assert.throws(() => validateKorailItxPlans(input([
    planRow("02001", "용산", "춘천", "2026-07-13 06:01:00.0", "2026-07-13 08:00:00.0"),
  ])), /KORAIL_PLAN_MISMATCH/);

  // 두 포맷 모두에 해당하지 않는 문자열은 그대로 즉시 fail한다.
  assert.throws(() => validateKorailItxPlans(input([
    planRow("02001", "용산", "춘천", "2026-07-13T06:00:00.0", "2026-07-13 08:00:00.0"),
  ])), /KORAIL_PLAN_MISMATCH/);
  assert.throws(() => validateKorailItxPlans(input([
    planRow("02001", "용산", "춘천", "2026/07/13 06:00:00", "2026-07-13 08:00:00.0"),
  ])), /KORAIL_PLAN_MISMATCH/);
});

function tagoMaterializedFixture() {
  return {
    trainNumbers: ["2001", "2002"],
    stationSequences: [
      {
        trainNumber: "2001",
        directionId: "up",
        stops: [
          { stationId: "station-yongsan", nameKo: "용산", arrivalSeconds: 21_600, departureSeconds: 21_600 },
          { stationId: "station-chuncheon", nameKo: "춘천", arrivalSeconds: 28_800, departureSeconds: 28_800 },
        ],
      },
      {
        trainNumber: "2002",
        directionId: "down",
        stops: [
          { stationId: "station-chuncheon", nameKo: "춘천", arrivalSeconds: 25_200, departureSeconds: 25_200 },
          { stationId: "station-yongsan", nameKo: "용산", arrivalSeconds: 32_400, departureSeconds: 32_400 },
        ],
      },
    ],
    transitTrips: [
      {
        id: "route-line-54a7b980b7c3-up-2001-8",
        routeId: "route-line-54a7b980b7c3-up",
        serviceId: "weekday-kric",
        directionId: "up",
        servicePattern: "EXPRESS",
      },
      {
        id: "route-line-54a7b980b7c3-down-2002-8",
        routeId: "route-line-54a7b980b7c3-down",
        serviceId: "weekday-kric",
        directionId: "down",
        servicePattern: "EXPRESS",
      },
    ],
    transitStopTimes: [
      { tripId: "route-line-54a7b980b7c3-up-2001-8", stopSequence: 1, stationId: "station-yongsan", arrivalSeconds: 21_600, departureSeconds: 21_600 },
      { tripId: "route-line-54a7b980b7c3-up-2001-8", stopSequence: 2, stationId: "station-chuncheon", arrivalSeconds: 28_800, departureSeconds: 28_800 },
      { tripId: "route-line-54a7b980b7c3-down-2002-8", stopSequence: 1, stationId: "station-chuncheon", arrivalSeconds: 25_200, departureSeconds: 25_200 },
      { tripId: "route-line-54a7b980b7c3-down-2002-8", stopSequence: 2, stationId: "station-yongsan", arrivalSeconds: 32_400, departureSeconds: 32_400 },
    ],
  };
}
