#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { cleanupPackDir, openPack, repoRoot } from "../route-map/pack-io.mjs";
import {
  collectTagoItxCheongchunRoster,
  validateItxServiceDates,
} from "./collect-tago-itx-cheongchun-od.mjs";
const API_ORIGIN = "https://apis.data.go.kr";
const DETAIL_URL = "https://www.data.go.kr/data/15125762/openapi.do";
const LINE_ID = "line-54a7b980b7c3";
const CAPITAL_APPROACH_LINE_ID = "line-6e39be0cb6e2";
const CANONICAL_PACK_PATH = "apps/mobile/assets/datapacks/capital.sqlite.gz";
const CAPITAL_APPROACH_STATIONS = Object.freeze([
  Object.freeze({ canonicalStationId: "station-8aa315864466", nameKo: "용산", corridorSequence: 1, lineId: CAPITAL_APPROACH_LINE_ID }),
  Object.freeze({ canonicalStationId: "station-c0679b9a6cf8", nameKo: "옥수", corridorSequence: 2, lineId: CAPITAL_APPROACH_LINE_ID }),
  Object.freeze({ canonicalStationId: "station-e5cf592cf355", nameKo: "왕십리", corridorSequence: 3, lineId: CAPITAL_APPROACH_LINE_ID }),
]);
const EXPECTED_FIELDS = Object.freeze({
  codes: Object.freeze(["code", "type", "value"]),
  plan: Object.freeze([
    "run_ymd", "trn_no", "dptre_stn_cd", "dptre_stn_nm", "arvl_stn_cd", "arvl_stn_nm",
    "trn_plan_dptre_dt", "trn_plan_arvl_dt",
  ]),
  info: Object.freeze([
    "run_ymd", "trn_no", "trn_run_sn", "stn_cd", "stn_nm", "mrnt_cd", "mrnt_nm",
    "uppln_dn_se_cd", "stop_se_cd", "stop_se_nm", "trn_dptre_dt", "trn_arvl_dt",
  ]),
});

export async function collectKorailItxCheongchunCompleteness({
  serviceKey,
  serviceDates,
  packPath,
  fetchImpl = fetch,
  now = new Date(),
  replay = false,
  previousAdmittedArtifact = null,
  collectRosterImpl = collectTagoItxCheongchunRoster,
  collectTimetableImpl = null,
} = {}) {
  const selectedServiceDates = validateItxServiceDates(serviceDates, { now, replay });
  const collectTimetable = collectTimetableImpl ?? (replay
    ? collectKorailItxCheongchunTimetable
    : collectKorailItxCheongchunPlan);
  const usingDefaultAdmissionCollector = collectTimetableImpl === null && !replay;
  requiredString(packPath, "packPath");
  const canonical = readCanonicalLine(packPath);
  const canonicalStations = canonical.rosterStations;
  canonical.close();
  const serviceDays = [];
  const tagoRequestBudget = { limit: 10_000, remaining: 10_000 };
  for (const dayCd of ["8", "7", "9"]) {
    const serviceDate = selectedServiceDates[dayCd];
    let failureStage = "ROSTER";
    let roster;
    try {
      roster = await collectRosterImpl({
        serviceKey, serviceDate, kricServiceDayCode: dayCd, canonicalStations, fetchImpl, now,
        requestBudget: tagoRequestBudget,
      });
      failureStage = "OD_MATERIALIZATION";
      if (roster.completedOdCount !== roster.expectedOdCount || roster.failedOdCount !== 0) {
        throw new Error("TAGO ITX OD matrix evidence is incomplete");
      }
      if (usingDefaultAdmissionCollector) {
        const directions = new Set(roster.stationSequences?.map(({ directionId }) => directionId));
        if (roster.schemaVersion !== 2 || !directions.has("up") || !directions.has("down")
          || roster.reconstructionSummary?.conflictingTimestampCount !== 0
          || roster.reconstructionSummary?.missingPairCount !== 0
          || roster.reconstructionSummary?.duplicateOdCount !== 0) {
          throw new Error("TAGO_OD_STOP_SEQUENCE_INVALID");
        }
      }
      failureStage = "PLAN_CORROBORATION";
      const timetable = await collectTimetable({
        serviceKey,
        runDate: serviceDate,
        kricServiceDayCode: dayCd,
        packPath,
        trainNumberEvidence: roster,
        fetchImpl,
        now,
      });
      const timetableSupported = timetable.materialization?.status === "SUPPORTED";
      serviceDays.push({
        dayCd,
        serviceDate,
        status: timetableSupported ? "SUPPORTED" : "MISSING",
        ...(!timetableSupported ? {
          failureStage: "PLAN_CORROBORATION",
          failureReasonCode: timetable.materialization?.status === "MISSING_STATION_TIMES"
            ? timetable.materialization?.stationTimeCapability?.reasonCode ?? "PLANNED_TIME_MISSING"
            : "TIMETABLE_MATERIALIZATION_INCOMPLETE",
        } : {}),
        expectedOdCount: roster.expectedOdCount,
        completedOdCount: roster.completedOdCount,
        failedOdCount: roster.failedOdCount,
        stationSetHash: roster.stationSetHash,
        odMatrixHash: roster.odMatrixHash,
        trainSetHashes: timetable.trainSetHashes ?? emptyTrainSetHashes(roster),
        korailPlanSummary: {
          availableCount: timetable.korailPlanCorroboration?.availableCount ?? 0,
          missingWarningCount: timetable.korailPlanCorroboration?.missingCount ?? 0,
          duplicateCount: timetable.korailPlanCorroboration?.duplicateCount ?? 0,
          mismatchCount: timetable.korailPlanCorroboration?.mismatchCount ?? 0,
        },
        warnings: (timetable.korailPlanCorroboration?.missingTrainNumbers ?? []).map((trainNumber) => ({
          code: "KORAIL_PLAN_NOT_AVAILABLE", trainNumber,
        })),
        reconstructionSummary: roster.reconstructionSummary ?? emptyReconstructionSummary(),
        roster,
        timetable,
      });
    } catch (error) {
      if (!roster && error?.rosterEvidence?.schemaVersion === 2
        && error.rosterEvidence.artifactKind === "tago-itx-cheongchun-roster-evidence"
        && error.rosterEvidence.serviceDate === serviceDate
        && error.rosterEvidence.kricServiceDayCode === dayCd
        && error.rosterEvidence.credentialRedacted === true) {
        roster = error.rosterEvidence;
      }
      const failureContext = completenessFailureContext(error) ?? rosterOdFailureContext(roster);
      const failureReasonCode = completenessFailureReason(error);
      const classifiedFailureStage = failureReasonCode === "TAGO_QUOTA_BUDGET_EXHAUSTED"
        || failureReasonCode.startsWith("TAGO_OD_")
        ? "OD_MATERIALIZATION"
        : failureReasonCode.startsWith("KORAIL_PLAN_") ? "PLAN_CORROBORATION" : failureStage;
      serviceDays.push({
        dayCd,
        serviceDate,
        status: "MISSING",
        failureStage: classifiedFailureStage,
        failureReasonCode,
        expectedOdCount: roster?.expectedOdCount ?? 0,
        completedOdCount: roster?.completedOdCount ?? 0,
        failedOdCount: roster?.failedOdCount ?? 0,
        stationSetHash: roster?.stationSetHash ?? sha256(JSON.stringify([])),
        odMatrixHash: roster?.odMatrixHash ?? sha256(JSON.stringify([])),
        trainSetHashes: emptyTrainSetHashes(roster),
        korailPlanSummary: {
          availableCount: 0,
          missingWarningCount: 0,
          duplicateCount: failureReasonCode === "KORAIL_PLAN_DUPLICATE" ? 1 : 0,
          mismatchCount: failureReasonCode === "KORAIL_PLAN_MISMATCH" ? 1 : 0,
        },
        warnings: [],
        reconstructionSummary: roster?.reconstructionSummary ?? emptyReconstructionSummary(),
        legacyDaejeonRowCount: Number.isInteger(error?.legacyDaejeonRowCount) ? error.legacyDaejeonRowCount : 0,
        legacyYongsanDaejeonTripCount: Number.isInteger(error?.legacyYongsanDaejeonTripCount)
          ? error.legacyYongsanDaejeonTripCount : 0,
        ...(roster ? {
          expectedOdCount: roster.expectedOdCount,
          completedOdCount: roster.completedOdCount,
          failedOdCount: roster.failedOdCount,
          stationSetHash: roster.stationSetHash,
          odMatrixHash: roster.odMatrixHash,
          roster,
        } : {}),
        ...(failureContext ? { failureContext } : {}),
      });
    }
  }
  const complete = serviceDays.length === 3 && serviceDays.every(({ status }) => status === "SUPPORTED");
  const snapshotDiff = complete && !replay
    ? evaluateItxSnapshotAnomaly({ serviceDays, previousArtifact: previousAdmittedArtifact })
    : { policyVersion: "itx-snapshot-anomaly-v1", status: "NOT_EVALUATED", serviceDays: [] };
  const snapshotBlocked = snapshotDiff.status === "CHANGE_REVIEW_REQUIRED";
  const validationStatus = complete ? "SUPPORTED" : "MISSING";
  const admissionStatus = complete
    ? replay ? "REPLAY_ONLY" : snapshotDiff.status
    : "MISSING";
  const artifact = {
    schemaVersion: 2,
    artifactKind: "korail-itx-cheongchun-completeness-evidence",
    serviceId: "ITX_CHEONGCHUN",
    observedAt: now.toISOString(),
    timezone: "Asia/Seoul",
    validationMode: replay ? "REPLAY" : "ADMISSION",
    selectedServiceDates,
    validationStatus,
    admissionStatus,
    admissionEligible: false,
    ...(snapshotBlocked ? {
      failureStage: "SNAPSHOT_DIFF",
      failureReasonCode: "SNAPSHOT_ANOMALY_BLOCKED",
    } : {}),
    allowedConsumerIssues: ["#2145", "#1400", "#2098", "#2099", "#2058", "#2137"],
    legacyDaejeonRowCount: serviceDays.reduce((total, day) => (
      total + (day.timetable?.legacyDaejeonRowCount ?? day.legacyDaejeonRowCount ?? 0)
    ), 0),
    legacyYongsanDaejeonTripCount: serviceDays.reduce((total, day) => (
      total + (day.timetable?.legacyYongsanDaejeonTripCount ?? day.legacyYongsanDaejeonTripCount ?? 0)
    ), 0),
    serviceDays,
    snapshotDiff,
    sourceTimetableArtifact: {
      status: admissionStatus,
      artifactId: `itx-cheongchun-source-timetable-${now.toISOString().replace(/\D/g, "")}`,
      policyVersion: "itx-snapshot-anomaly-v1",
      freshUntil: freshUntil(selectedServiceDates),
    },
    materialization: { status: complete ? "SUPPORTED" : "MISSING" },
    credentialRedacted: true,
  };
  artifact.evidenceHash = sha256(JSON.stringify(artifact));
  return artifact;
}

export function evaluateItxSnapshotAnomaly({ serviceDays, previousArtifact = null }) {
  const currentSets = serviceDays.map((day) => ({ dayCd: day.dayCd, sets: snapshotSets(day) }));
  if (previousArtifact === null) return compareSnapshotSets(currentSets, null, null);
  const previousCompleteness = previousArtifact?.artifactKind === "korail-itx-cheongchun-completeness-evidence"
    && previousArtifact.admissionStatus === "ADMITTED"
    && previousArtifact.admissionEligible === true
    && Array.isArray(previousArtifact.serviceDays);
  const previousSource = previousArtifact?.artifactKind === "itx-cheongchun-source-timetable"
    && Array.isArray(previousArtifact.normalizedSnapshotSets);
  const previousValid = previousCompleteness || previousSource;
  const previousSets = previousCompleteness
    ? previousArtifact.serviceDays.map((day) => [day.dayCd, snapshotSets(day)])
    : previousSource ? previousArtifact.normalizedSnapshotSets.map(({ dayCd, sets }) => [dayCd, sets]) : [];
  return applyStationMappingAuthority(compareSnapshotSets(
    currentSets,
    previousSets.map(([dayCd, sets]) => ({ dayCd, sets })),
    previousValid ? previousArtifact.sourceTimetableArtifact?.sha256 ?? previousArtifact.evidenceHash ?? null : null,
  ), stationMappingsFromServiceDays(serviceDays), previousCompleteness
    ? stationMappingsFromServiceDays(previousArtifact.serviceDays)
    : stationMappingsFromSource(previousArtifact));
}

function compareSnapshotSets(currentRows, previousRows, previousArtifactSha256) {
  const policy = { policyVersion: "itx-snapshot-anomaly-v1", threshold: "ZERO_TOLERANCE" };
  if (previousRows === null) {
    return { ...policy, status: "BOOTSTRAP_REVIEW_REQUIRED", previousArtifactSha256: null, serviceDays: [] };
  }
  const previousByDay = new Map(previousRows.map(({ dayCd, sets }) => [dayCd, sets]));
  const comparisons = currentRows.map(({ dayCd, sets: current }) => {
    const previous = previousByDay.get(dayCd);
    const names = ["stationSet", "odSet", "trainSet", "stopSequenceSet", "timetableTupleSet"];
    const sets = Object.fromEntries(names.map((name) => [name, summarizeSet(current[name], previous?.[name] ?? [])]));
    return {
      dayCd,
      blocked: !previous || Object.values(sets).some(({ added, removed }) => added.length > 0 || removed.length > 0),
      ...(!previous ? { reason: "PREVIOUS_ADMITTED_SNAPSHOT_MISSING" } : {}),
      sets,
    };
  });
  return {
    ...policy,
    status: comparisons.some(({ blocked }) => blocked) ? "CHANGE_REVIEW_REQUIRED" : "SUPPORTED",
    previousArtifactSha256,
    serviceDays: comparisons,
  };
}

function stationMappingsFromServiceDays(serviceDays) {
  return new Map((serviceDays ?? []).map((day) => [day.dayCd, stationMappingSet(day.roster?.stations)]));
}

function stationMappingsFromSource(source) {
  return new Map((source?.stationRosters ?? []).map((day) => [day.dayCd, stationMappingSet(day.stations)]));
}

function stationMappingSet(stations = []) {
  return stations.map(({ canonicalStationId, providerStationId }) => (
    [canonicalStationId, providerStationId ?? canonicalStationId]
  ));
}

function applyStationMappingAuthority(snapshotDiff, currentMappings, previousMappings) {
  if (previousMappings === null) return snapshotDiff;
  for (const day of snapshotDiff.serviceDays) {
    const summary = summarizeSet(currentMappings.get(day.dayCd) ?? [], previousMappings.get(day.dayCd) ?? []);
    if (summary.added.length > 0 || summary.removed.length > 0) {
      day.blocked = true;
      day.sets.stationSet = summary;
    }
  }
  if (snapshotDiff.serviceDays.some(({ blocked }) => blocked)) snapshotDiff.status = "CHANGE_REVIEW_REQUIRED";
  return snapshotDiff;
}

export async function buildItxSourceCandidate({ completeness, packPath, now = new Date(), repositoryRoot = repoRoot }) {
  if (completeness?.validationStatus !== "SUPPORTED" || completeness?.validationMode !== "ADMISSION") {
    throw new Error("ITX source candidate requires SUPPORTED admission completeness");
  }
  validateSourceFreshness(completeness.sourceTimetableArtifact, completeness.selectedServiceDates, now);
  const serviceDays = ["8", "7", "9"].map((dayCd) => {
    const matches = completeness.serviceDays.filter((day) => day?.dayCd === dayCd);
    if (matches.length !== 1) throw new Error("ITX source candidate requires one entry per service day");
    return matches[0];
  });
  if (completeness.serviceDays.length !== serviceDays.length) {
    throw new Error("ITX source candidate requires one entry per service day");
  }
  for (const { dayCd, timetable } of serviceDays) {
    validateMaterializedProjection(timetable, dayCd, "TAGO_OD_STOP_SEQUENCE_INVALID");
  }
  const stationSequences = serviceDays.flatMap(({ dayCd, timetable }) => (
    (timetable?.stationSequences ?? []).map((sequence) => ({ dayCd, ...sequence }))
  )).sort((left, right) => naturalCompare(left.dayCd, right.dayCd)
    || naturalCompare(left.trainNumber, right.trainNumber));
  const transitTrips = serviceDays.flatMap(({ timetable }) => timetable?.transitTrips ?? [])
    .sort((left, right) => naturalCompare(left.id, right.id));
  const transitStopTimes = serviceDays.flatMap(({ timetable }) => timetable?.transitStopTimes ?? [])
    .sort((left, right) => naturalCompare(left.tripId, right.tripId) || left.stopSequence - right.stopSequence);
  const warnings = serviceDays.flatMap(({ dayCd, timetable }) => (
    (timetable?.korailPlanCorroboration?.missingTrainNumbers ?? []).map((trainNumber) => ({
      code: "KORAIL_PLAN_NOT_AVAILABLE", dayCd, trainNumber,
    }))
  ));
  const candidate = {
    schemaVersion: 1,
    artifactKind: "itx-cheongchun-source-timetable",
    artifactId: completeness.sourceTimetableArtifact.artifactId,
    serviceId: "ITX_CHEONGCHUN",
    observedAt: completeness.observedAt,
    freshUntil: completeness.sourceTimetableArtifact.freshUntil,
    policyVersion: "itx-snapshot-anomaly-v1",
    validationStatus: "SUPPORTED",
    promotionStatus: completeness.sourceTimetableArtifact.status,
    completenessEvidenceSha256: sha256(canonicalJsonBytes(completeness)),
    canonicalPackIdentity: await readCanonicalPackIdentity(packPath, repositoryRoot),
    selectedServiceDates: completeness.selectedServiceDates,
    sourceLineage: serviceDays.map((day) => ({
      dayCd: day.dayCd,
      rosterEvidenceHash: day.roster?.evidenceHash,
      timetableEvidenceHash: day.timetable?.evidenceHash,
    })),
    stationRosters: serviceDays.map((day) => ({
      dayCd: day.dayCd,
      stations: day.roster?.stations ?? [],
    })),
    stationSequences,
    transitTrips,
    transitStopTimes,
    warnings,
    normalizedSnapshotSets: serviceDays.map((day) => ({ dayCd: day.dayCd, sets: snapshotSets(day) })),
    snapshotDiff: completeness.snapshotDiff,
    credentialRedacted: true,
  };
  validateSourceCandidateSchema(candidate);
  candidate.evidenceHash = sha256(JSON.stringify(candidate));
  return candidate;
}

export async function promoteItxSourceCandidate(options = {}) {
  const repositoryRoot = options.repositoryRoot ?? repoRoot;
  const coverageContractPath = validateCoverageContractPath(options.coverageContractPath, repositoryRoot);
  const lockPath = `${coverageContractPath}.promotion.lock`;
  try {
    await writeFile(lockPath, `${randomUUID()}\n`, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error?.code === "EEXIST") throw new Error("ADMISSION_PROMOTION_CONFLICT");
    throw error;
  }
  try {
    return await promoteItxSourceCandidateLocked({ ...options, coverageContractPath, repositoryRoot });
  } finally {
    await unlink(lockPath).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
}

async function promoteItxSourceCandidateLocked({
  candidatePath,
  completenessPath,
  approvedSha256,
  approvalUrl,
  sourceOutputDir,
  coverageContractPath,
  now = new Date(),
  fetchImpl = fetch,
  githubToken,
  repositoryRoot = repoRoot,
}) {
  const candidateBytes = await readFile(candidatePath);
  const candidateSha256 = sha256(candidateBytes);
  const candidate = JSON.parse(candidateBytes);
  validateSourceCandidateSchema(candidate);
  const { evidenceHash, ...candidateWithoutEvidenceHash } = candidate;
  if (evidenceHash !== sha256(JSON.stringify(candidateWithoutEvidenceHash))
    || candidateBytes.toString("utf8") !== `${JSON.stringify(candidate, null, 2)}\n`) {
    throw new Error("ITX source candidate hash is invalid");
  }
  validateSourceFreshness(candidate, candidate.selectedServiceDates, now);
  validateItxServiceDates(candidate.selectedServiceDates, { now });
  await validateCanonicalPackIdentity(candidate.canonicalPackIdentity, repositoryRoot);
  validateCanonicalCorridorAuthority(candidate);
  const candidateSets = validateSourceSnapshotSets(candidate);
  const contract = validateCoverageContractAuthority(JSON.parse(await readFile(coverageContractPath, "utf8")));
  const previousSource = await loadAdmittedSourceReference(contract, repositoryRoot);
  const previous = previousSource?.sourceTimetableArtifact ?? null;
  const bootstrap = previousSource === null;
  const expectedSnapshotDiff = applyStationMappingAuthority(compareSnapshotSets(
    candidateSets,
    bootstrap ? null : validateSourceSnapshotSets(previousSource),
    previous?.sha256 ?? null,
  ), stationMappingsFromSource(candidate), bootstrap ? null : stationMappingsFromSource(previousSource));
  const expectedStatus = expectedSnapshotDiff.status;
  const changed = expectedStatus === "CHANGE_REVIEW_REQUIRED";
  if (candidate.promotionStatus !== expectedStatus
    || JSON.stringify(candidate.snapshotDiff) !== JSON.stringify(expectedSnapshotDiff)) {
    throw new Error("SNAPSHOT_PROMOTION_AUTHORITY_INVALID");
  }
  const { bytes: completenessBytes } = await loadCompletenessEvidence(
    completenessPath ?? `${candidatePath}.completeness.json`,
    candidate,
    repositoryRoot,
    now,
  );
  const approvalRequired = bootstrap || changed;
  if (approvalRequired) {
    if (approvedSha256 !== candidateSha256 || !/^[a-f0-9]{64}$/.test(approvedSha256 ?? "")) {
      throw new Error(changed ? "SNAPSHOT_CHANGE_APPROVAL_INVALID" : "SNAPSHOT_BOOTSTRAP_APPROVAL_INVALID");
    }
    await verifyOwnerApproval({
      approvalUrl,
      expectedBody: `/${changed ? "approve-itx-change" : "approve-itx-bootstrap"} artifactId=${candidate.artifactId} sha256=${candidateSha256} policy=itx-snapshot-anomaly-v1`,
      observedAt: candidate.observedAt,
      fetchImpl,
      githubToken,
    });
  } else if (approvedSha256 || approvalUrl) {
    throw new Error("unchanged promotion must not include approval arguments");
  }
  const artifactRelativePath = `tools/datapack/sources/${candidate.artifactId}.json`;
  const completenessRelativePath = `tools/datapack/sources/${candidate.artifactId}-completeness-evidence.json`;
  const artifactPath = await validateSourceOutputPath(sourceOutputDir, artifactRelativePath, repositoryRoot);
  const completenessArtifactPath = await validateSourceOutputPath(
    sourceOutputDir,
    completenessRelativePath,
    repositoryRoot,
  );
  await writeImmutableArtifact(artifactPath, candidateBytes, "ADMITTED_SOURCE_ARTIFACT");
  await writeImmutableArtifact(completenessArtifactPath, completenessBytes, "ADMITTED_COMPLETENESS_EVIDENCE");
  contract.sourceTimetableArtifact = {
    status: "ADMITTED",
    admissionEligible: true,
    artifactId: candidate.artifactId,
    artifactPath: artifactRelativePath,
    sha256: candidateSha256,
    completenessEvidencePath: completenessRelativePath,
    completenessEvidenceSha256: sha256(completenessBytes),
    schemaVersion: 1,
    freshUntil: candidate.freshUntil,
    policyVersion: "itx-snapshot-anomaly-v1",
    promotion: {
      mode: bootstrap ? "BOOTSTRAP_OWNER_APPROVED" : changed ? "CHANGE_OWNER_APPROVED" : "UNCHANGED_AUTO",
      previousArtifactSha256: previous?.sha256 ?? null,
      previousArtifactPath: previous?.artifactPath ?? null,
      approvalUrl: approvalRequired ? approvalUrl : null,
      approvedArtifactSha256: approvalRequired ? candidateSha256 : null,
    },
  };
  const contractTempPath = `${coverageContractPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(contractTempPath, `${JSON.stringify(contract, null, 2)}\n`, { flag: "wx", mode: 0o644 });
    await rename(contractTempPath, coverageContractPath);
  } finally {
    await unlink(contractTempPath).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
  return {
    candidateSha256,
    artifactPath,
    completenessArtifactPath,
    sourceTimetableArtifact: contract.sourceTimetableArtifact,
  };
}

async function loadCompletenessEvidence(completenessPath, candidate, repositoryRoot, now) {
  requiredString(completenessPath, "completenessPath");
  let stat;
  try {
    stat = await lstat(completenessPath);
  } catch (error) {
    throw new Error("SOURCE_COMPLETENESS_EVIDENCE_MISMATCH", { cause: error });
  }
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("SOURCE_COMPLETENESS_EVIDENCE_MISMATCH");
  const bytes = await readFile(completenessPath);
  let completeness;
  try {
    completeness = JSON.parse(bytes);
  } catch (error) {
    throw new Error("SOURCE_COMPLETENESS_EVIDENCE_MISMATCH", { cause: error });
  }
  const { evidenceHash, ...withoutEvidenceHash } = completeness;
  if (!/^[a-f0-9]{64}$/.test(candidate.completenessEvidenceSha256 ?? "")
    || sha256(bytes) !== candidate.completenessEvidenceSha256
    || bytes.toString("utf8") !== canonicalJsonBytes(completeness).toString("utf8")
    || evidenceHash !== sha256(JSON.stringify(withoutEvidenceHash))
    || completeness?.schemaVersion !== 2
    || completeness.artifactKind !== "korail-itx-cheongchun-completeness-evidence"
    || completeness.serviceId !== "ITX_CHEONGCHUN"
    || completeness.validationMode !== "ADMISSION"
    || completeness.validationStatus !== "SUPPORTED"
    || completeness.materialization?.status !== "SUPPORTED"
    || completeness.credentialRedacted !== true) {
    throw new Error("SOURCE_COMPLETENESS_EVIDENCE_MISMATCH");
  }
  let expectedCandidate;
  try {
    expectedCandidate = await buildItxSourceCandidate({
      completeness,
      packPath: candidate.canonicalPackIdentity.path,
      now,
      repositoryRoot,
    });
  } catch (error) {
    throw new Error("SOURCE_COMPLETENESS_EVIDENCE_MISMATCH", { cause: error });
  }
  // The bundled pack may advance after admission. Its immutable identity remains protected by
  // the admitted source bytes/reference hash, while this comparison replays the completeness payload.
  const {
    canonicalPackIdentity: _expectedPackIdentity,
    evidenceHash: _expectedEvidenceHash,
    ...expectedAdmissionPayload
  } = expectedCandidate;
  const {
    canonicalPackIdentity: _admittedPackIdentity,
    evidenceHash: _admittedEvidenceHash,
    ...admittedPayload
  } = candidate;
  if (JSON.stringify(expectedAdmissionPayload) !== JSON.stringify(admittedPayload)) {
    throw new Error("SOURCE_COMPLETENESS_EVIDENCE_MISMATCH");
  }
  return { bytes, completeness };
}

async function writeImmutableArtifact(artifactPath, bytes, errorPrefix) {
  try {
    await writeFile(artifactPath, bytes, { flag: "wx", mode: 0o644 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const existingStat = await lstat(artifactPath);
    if (existingStat.isSymbolicLink() || !existingStat.isFile()) {
      throw new Error(`${errorPrefix}_INVALID`);
    }
    const existingBytes = await readFile(artifactPath);
    if (!existingBytes.equals(bytes)) throw new Error(`${errorPrefix}_CONFLICT`);
  }
}

function validateSourceFreshness(source, selectedServiceDates, now = null) {
  const value = source?.freshUntil;
  if (typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    || !Number.isFinite(Date.parse(value))
    || value !== freshUntil(selectedServiceDates)) {
    throw new Error("SOURCE_SNAPSHOT_FRESHNESS_INVALID");
  }
  if (now && now.getTime() >= Date.parse(value)) throw new Error("SOURCE_SNAPSHOT_EXPIRED");
}

function validateSourceCandidateSchema(candidate) {
  const dayCodes = ["8", "7", "9"];
  const selectedDayCodes = Object.keys(candidate?.selectedServiceDates ?? {}).sort(naturalCompare);
  const lineage = candidate?.sourceLineage;
  let serviceDatesValid = true;
  try {
    validateItxServiceDates(candidate?.selectedServiceDates, { replay: true });
  } catch {
    serviceDatesValid = false;
  }
  if (!hasClosedCandidateShape(candidate)
    || !sourceWarningsMatchTrainSets(candidate)
    || candidate?.artifactKind !== "itx-cheongchun-source-timetable" || candidate.schemaVersion !== 1
    || !/^itx-cheongchun-source-timetable-\d{17}$/.test(candidate.artifactId ?? "")
    || candidate.serviceId !== "ITX_CHEONGCHUN" || candidate.validationStatus !== "SUPPORTED"
    || candidate.policyVersion !== "itx-snapshot-anomaly-v1" || candidate.credentialRedacted !== true
    || offsetIsoEpoch(candidate.observedAt) === null
    || !["BOOTSTRAP_REVIEW_REQUIRED", "CHANGE_REVIEW_REQUIRED", "SUPPORTED"].includes(candidate.promotionStatus)
    || candidate.snapshotDiff?.policyVersion !== "itx-snapshot-anomaly-v1"
    || JSON.stringify(selectedDayCodes) !== JSON.stringify([...dayCodes].sort(naturalCompare))
    || !serviceDatesValid
    || !Array.isArray(lineage) || lineage.length !== dayCodes.length
    || !Array.isArray(candidate.warnings)) {
    throw new Error("ITX source candidate schema is invalid");
  }
  for (const dayCd of dayCodes) {
    const rows = lineage.filter((row) => row?.dayCd === dayCd);
    if (rows.length !== 1 || !/^[a-f0-9]{64}$/.test(rows[0].rosterEvidenceHash ?? "")
      || !/^[a-f0-9]{64}$/.test(rows[0].timetableEvidenceHash ?? "")) {
      throw new Error("ITX source candidate schema is invalid");
    }
  }
}

function hasClosedCandidateShape(candidate) {
  const allowed = (value, keys) => isPlainObject(value)
    && Object.keys(value).every((key) => keys.includes(key));
  const topLevel = [
    "schemaVersion", "artifactKind", "artifactId", "serviceId", "observedAt", "freshUntil",
    "policyVersion", "validationStatus", "promotionStatus", "completenessEvidenceSha256", "canonicalPackIdentity",
    "selectedServiceDates", "sourceLineage", "stationRosters", "stationSequences", "transitTrips",
    "transitStopTimes", "warnings", "normalizedSnapshotSets", "snapshotDiff", "credentialRedacted",
    "evidenceHash",
  ];
  const stationKeys = [
    "providerStationId", "providerStationName", "canonicalStationId", "nameKo", "corridorSequence", "lineId",
  ];
  const sequenceKeys = [
    "dayCd", "trainNumber", "directionId", "originStationName", "destinationStationName", "terminalVariant",
    "observedOdCount", "stopCount", "conflictingTimestampCount", "missingPairCount", "duplicateOdCount", "stops",
  ];
  const stopKeys = [
    "stationId", "nameKo", "corridorSequence", "lineId", "arrivalAt", "departureAt",
    "arrivalSeconds", "departureSeconds", "stopSequence",
  ];
  const tripKeys = ["id", "routeId", "serviceId", "directionId", "servicePattern", "tripHeadsign", "trainNo"];
  const stopTimeKeys = ["tripId", "stopSequence", "stationId", "lineId", "arrivalSeconds", "departureSeconds"];
  const summaryKeys = ["count", "added", "removed", "sha256"];
  const setNames = ["stationSet", "odSet", "trainSet", "stopSequenceSet", "timetableTupleSet"];
  if (!allowed(candidate, topLevel)
    || !allowed(candidate?.canonicalPackIdentity, ["path", "sha256"])
    || !allowed(candidate?.selectedServiceDates, ["7", "8", "9"])
    || !Array.isArray(candidate?.sourceLineage)
    || candidate.sourceLineage.some((row) => !allowed(row, ["dayCd", "rosterEvidenceHash", "timetableEvidenceHash"]))
    || !Array.isArray(candidate?.stationRosters)
    || candidate.stationRosters.some((row) => !allowed(row, ["dayCd", "stations"])
      || !Array.isArray(row.stations) || row.stations.some((station) => !allowed(station, stationKeys)))
    || !Array.isArray(candidate?.stationSequences)
    || candidate.stationSequences.some((sequence) => !allowed(sequence, sequenceKeys)
      || !Array.isArray(sequence.stops) || sequence.stops.some((stop) => !allowed(stop, stopKeys)))
    || !Array.isArray(candidate?.transitTrips)
    || candidate.transitTrips.some((trip) => !allowed(trip, tripKeys))
    || !Array.isArray(candidate?.transitStopTimes)
    || candidate.transitStopTimes.some((row) => !allowed(row, stopTimeKeys))
    || !Array.isArray(candidate?.warnings)
    || candidate.warnings.some((warning) => !allowed(warning, ["code", "dayCd", "trainNumber"])
      || !validSourceWarning(warning))
    || !Array.isArray(candidate?.normalizedSnapshotSets)
    || candidate.normalizedSnapshotSets.some((row) => !allowed(row, ["dayCd", "sets"])
      || !allowed(row.sets, setNames) || !setNames.every((name) => Array.isArray(row.sets[name])))
    || !allowed(candidate?.snapshotDiff, ["policyVersion", "threshold", "status", "previousArtifactSha256", "serviceDays"])
    || !Array.isArray(candidate.snapshotDiff.serviceDays)
    || candidate.snapshotDiff.serviceDays.some((day) => !allowed(day, ["dayCd", "blocked", "reason", "sets"])
      || !allowed(day.sets, setNames)
      || !setNames.every((name) => allowed(day.sets[name], summaryKeys)
        && Array.isArray(day.sets[name].added) && Array.isArray(day.sets[name].removed)))) {
    return false;
  }
  return true;
}

function validSourceWarning(warning) {
  if (warning.code !== "KORAIL_PLAN_NOT_AVAILABLE" || !["7", "8", "9"].includes(warning.dayCd)
    || typeof warning.trainNumber !== "string") return false;
  try {
    return normalizeTrainNumber(warning.trainNumber) === warning.trainNumber;
  } catch {
    return false;
  }
}

function sourceWarningsMatchTrainSets(candidate) {
  try {
    const trainSets = new Map(["7", "8", "9"].map((dayCd) => [
      dayCd,
      new Set(candidate.stationSequences
        .filter((sequence) => sequence.dayCd === dayCd)
        .map((sequence) => normalizeTrainNumber(sequence.trainNumber))),
    ]));
    const seen = new Set();
    return candidate.warnings.every((warning) => {
      const key = JSON.stringify([warning.code, warning.dayCd, warning.trainNumber]);
      if (seen.has(key) || !trainSets.get(warning.dayCd)?.has(warning.trainNumber)) return false;
      seen.add(key);
      return true;
    });
  } catch {
    return false;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function readCanonicalPackIdentity(packPath, repositoryRoot) {
  const absolutePath = path.resolve(repositoryRoot, packPath);
  if (absolutePath !== path.resolve(repositoryRoot, CANONICAL_PACK_PATH)) {
    throw new Error("CANONICAL_PACK_IDENTITY_INVALID");
  }
  const relativePath = path.relative(path.resolve(repositoryRoot), absolutePath).split(path.sep).join("/");
  if (relativePath.startsWith("../") || relativePath === ".." || path.isAbsolute(relativePath)) {
    throw new Error("CANONICAL_PACK_IDENTITY_INVALID");
  }
  const identity = { path: relativePath, sha256: sha256(await readFile(absolutePath)) };
  await validateCanonicalPackIdentity(identity, repositoryRoot);
  return identity;
}

async function validateCanonicalPackIdentity(identity, repositoryRoot) {
  const relativePath = identity?.path;
  if (relativePath !== CANONICAL_PACK_PATH || path.isAbsolute(relativePath)
    || path.posix.normalize(relativePath) !== relativePath || relativePath.startsWith("../")
    || !/^[a-f0-9]{64}$/.test(identity?.sha256 ?? "")) {
    throw new Error("CANONICAL_PACK_IDENTITY_INVALID");
  }
  const packPath = path.join(repositoryRoot, ...relativePath.split("/"));
  try {
    const [realRoot, realParent] = await Promise.all([realpath(repositoryRoot), realpath(path.dirname(packPath))]);
    const stat = await lstat(packPath);
    if (!realParent.startsWith(`${realRoot}${path.sep}`) || stat.isSymbolicLink() || !stat.isFile()
      || sha256(await readFile(packPath)) !== identity.sha256
      || sha256(await readFile(path.join(repoRoot, CANONICAL_PACK_PATH))) !== identity.sha256) {
      throw new Error("CANONICAL_PACK_IDENTITY_INVALID");
    }
  } catch (error) {
    if (error instanceof Error && error.message === "CANONICAL_PACK_IDENTITY_INVALID") throw error;
    throw new Error("CANONICAL_PACK_IDENTITY_INVALID", { cause: error });
  }
}

function validateMaterializedProjection(source, dayCd, errorCode) {
  const invalid = () => { throw new Error(errorCode); };
  if (!["8", "7", "9"].includes(dayCd) || !Array.isArray(source?.stationSequences)
    || !Array.isArray(source?.transitTrips) || !Array.isArray(source?.transitStopTimes)) invalid();
  const serviceId = { "8": "weekday-kric", "7": "saturday-kric", "9": "holiday-kric" }[dayCd];
  const sequences = source.stationSequences.filter((row) => row?.dayCd === undefined || row.dayCd === dayCd)
    .sort((left, right) => naturalCompare(normalizeTrainNumber(left.trainNumber), normalizeTrainNumber(right.trainNumber)));
  const trainNumbers = sequences.map(({ trainNumber }) => normalizeTrainNumber(trainNumber));
  const directions = new Set(sequences.map(({ directionId }) => directionId));
  if (sequences.length < 2 || new Set(trainNumbers).size !== sequences.length
    || directions.size !== 2 || !directions.has("up") || !directions.has("down")) invalid();
  const trips = source.transitTrips.filter(({ id }) => typeof id === "string" && id.endsWith(`-${dayCd}`));
  if (trips.length !== sequences.length) invalid();
  const tripIds = new Set(trips.map(({ id }) => id));
  if (tripIds.size !== trips.length
    || source.transitTrips.some(({ id }) => typeof id !== "string" || !id.endsWith(`-${dayCd}`))
    || source.transitStopTimes.some(({ tripId }) => !tripIds.has(tripId))) invalid();
  for (const sequence of sequences) {
    const trainNumber = normalizeTrainNumber(sequence.trainNumber);
    const directionId = sequence.directionId;
    const expectedTripId = `route-${LINE_ID}-${directionId}-${trainNumber}-${dayCd}`;
    const trip = trips.find(({ id }) => id === expectedTripId);
    if (!trip || trip.routeId !== `route-${LINE_ID}-${directionId}` || trip.serviceId !== serviceId
      || trip.directionId !== directionId || trip.servicePattern !== "EXPRESS"
      || !Array.isArray(sequence.stops) || sequence.stops.length < 2) invalid();
    const rows = source.transitStopTimes.filter(({ tripId }) => tripId === expectedTripId)
      .sort((left, right) => left.stopSequence - right.stopSequence);
    if (rows.length !== sequence.stops.length) invalid();
    rows.forEach((row, index) => {
      const stop = sequence.stops[index];
      if (row.stopSequence !== index + 1 || row.stationId !== stop.stationId || row.lineId !== stop.lineId
        || row.arrivalSeconds !== stop.arrivalSeconds || row.departureSeconds !== stop.departureSeconds) invalid();
    });
  }
  return { sequences, trips, stopTimes: source.transitStopTimes };
}

function validateCanonicalCorridorAuthority(source) {
  const canonical = readCanonicalLine(CANONICAL_PACK_PATH);
  try {
    const invalid = () => { throw new Error("CANONICAL_CORRIDOR_AUTHORITY_INVALID"); };
    const stationsById = new Map(canonical.rosterStations.map((station) => (
      [station.canonicalStationId, station]
    )));
    const matchesCanonical = (value, stationId) => {
      const expected = stationsById.get(stationId);
      return expected !== undefined && value.nameKo === expected.nameKo
        && value.corridorSequence === expected.corridorSequence && value.lineId === expected.lineId;
    };
    if (source.stationRosters.some(({ stations }) => stations.some((station) => (
      !matchesCanonical(station, station.canonicalStationId)
      || station.providerStationName !== station.nameKo
    )))) invalid();
    const sequenceByTripId = new Map();
    for (const sequence of source.stationSequences) {
      const first = sequence.stops[0];
      const last = sequence.stops.at(-1);
      if (!first || !last || sequence.originStationName !== first.nameKo
        || sequence.destinationStationName !== last.nameKo
        || sequence.terminalVariant !== `${first.nameKo}→${last.nameKo}`
        || sequence.stopCount !== sequence.stops.length
        || sequence.observedOdCount !== sequence.stops.length * (sequence.stops.length - 1) / 2
        || sequence.conflictingTimestampCount !== 0 || sequence.missingPairCount !== 0
        || sequence.duplicateOdCount !== 0) invalid();
      const serviceDate = source.selectedServiceDates?.[sequence.dayCd];
      for (const [index, stop] of sequence.stops.entries()) {
        try {
          if (!matchesCanonical(stop, stop.stationId) || stop.stopSequence !== index + 1
            || isoServiceSeconds(stop.arrivalAt, serviceDate, "arrivalAt") !== stop.arrivalSeconds
            || isoServiceSeconds(stop.departureAt, serviceDate, "departureAt") !== stop.departureSeconds
            || stop.arrivalSeconds > stop.departureSeconds) invalid();
        } catch {
          invalid();
        }
      }
      const stationIds = sequence.stops.map(({ stationId }) => stationId);
      if (new Set(stationIds).size !== stationIds.length) invalid();
      const direction = sequence.directionId === "up" ? 1 : sequence.directionId === "down" ? -1 : 0;
      for (let index = 1; index < sequence.stops.length; index += 1) {
        const previousStop = sequence.stops[index - 1];
        const currentStop = sequence.stops[index];
        if (direction === 0
          || direction * (currentStop.corridorSequence - previousStop.corridorSequence) <= 0
          || previousStop.departureSeconds > currentStop.arrivalSeconds) invalid();
      }
      sequenceByTripId.set(
        `route-${LINE_ID}-${sequence.directionId}-${normalizeTrainNumber(sequence.trainNumber)}-${sequence.dayCd}`,
        sequence,
      );
    }
    if (source.transitTrips.some((trip) => {
      const sequence = sequenceByTripId.get(trip.id);
      return sequence === undefined || trip.tripHeadsign !== sequence.stops.at(-1).nameKo;
    })) {
      invalid();
    }
  } finally {
    canonical.close();
  }
}

function validateSourceSnapshotSets(source) {
  const dayCodes = ["8", "7", "9"];
  if (!Array.isArray(source?.stationRosters) || !Array.isArray(source.stationSequences)
    || !Array.isArray(source.transitTrips) || !Array.isArray(source.transitStopTimes)
    || !Array.isArray(source.normalizedSnapshotSets)) {
    throw new Error("ITX source candidate schema is invalid");
  }
  const result = dayCodes.map((dayCd) => {
    const rosterRows = source.stationRosters.filter((row) => row?.dayCd === dayCd);
    const storedRows = source.normalizedSnapshotSets.filter((row) => row?.dayCd === dayCd);
    if (rosterRows.length !== 1 || storedRows.length !== 1) throw new Error("SOURCE_SNAPSHOT_SETS_MISMATCH");
    const stations = rosterRows[0].stations ?? [];
    const stationSet = stations.map(({ canonicalStationId }) => requiredString(canonicalStationId, "canonicalStationId"))
      .sort(naturalCompare);
    const providerStationIds = stations.map(({ providerStationId }) => requiredString(providerStationId, "providerStationId"))
      .sort(naturalCompare);
    if (stationSet.length < 2 || new Set(stationSet).size !== stationSet.length
      || new Set(providerStationIds).size !== providerStationIds.length) {
      throw new Error("SOURCE_SNAPSHOT_SETS_MISMATCH");
    }
    const { sequences, trips } = validateMaterializedProjection({
      stationSequences: source.stationSequences.filter((row) => row?.dayCd === dayCd),
      transitTrips: source.transitTrips.filter(({ id }) => typeof id === "string" && id.endsWith(`-${dayCd}`)),
      transitStopTimes: source.transitStopTimes.filter(({ tripId }) => (
        source.transitTrips.some(({ id }) => id === tripId && id.endsWith(`-${dayCd}`))
      )),
    }, dayCd, "SOURCE_SNAPSHOT_SETS_MISMATCH");
    const tripIds = new Set(trips.map(({ id }) => id));
    const stopTimes = source.transitStopTimes.filter(({ tripId }) => tripIds.has(tripId));
    const rosterStationIds = new Set(stationSet);
    if (sequences.some((sequence) => sequence.stops.some(({ stationId }) => !rosterStationIds.has(stationId)))
      || stopTimes.some(({ stationId }) => !rosterStationIds.has(stationId))) {
      throw new Error("SOURCE_SNAPSHOT_SETS_MISMATCH");
    }
    const trainSet = sequences.map(({ trainNumber }) => normalizeTrainNumber(trainNumber));
    if (trainSet.length === 0 || new Set(trainSet).size !== trainSet.length || trips.length !== sequences.length) {
      throw new Error("SOURCE_SNAPSHOT_SETS_MISMATCH");
    }
    const stopSequenceSet = [];
    const timetableTupleSet = [];
    for (const sequence of sequences) {
      const trainNumber = normalizeTrainNumber(sequence.trainNumber);
      const matchingTrips = trips.filter(({ id }) => id.endsWith(`-${trainNumber}-${dayCd}`));
      if (matchingTrips.length !== 1 || matchingTrips[0].directionId !== sequence.directionId
        || !Array.isArray(sequence.stops) || sequence.stops.length < 2) {
        throw new Error("SOURCE_SNAPSHOT_SETS_MISMATCH");
      }
      const rows = stopTimes.filter(({ tripId }) => tripId === matchingTrips[0].id)
        .sort((left, right) => left.stopSequence - right.stopSequence);
      if (rows.length !== sequence.stops.length) throw new Error("SOURCE_SNAPSHOT_SETS_MISMATCH");
      const stationIds = [];
      rows.forEach((row, index) => {
        const stop = sequence.stops[index];
        if (row.stopSequence !== index + 1 || row.stationId !== stop.stationId || row.lineId !== stop.lineId
          || row.arrivalSeconds !== stop.arrivalSeconds || row.departureSeconds !== stop.departureSeconds) {
          throw new Error("SOURCE_SNAPSHOT_SETS_MISMATCH");
        }
        stationIds.push(row.stationId);
        timetableTupleSet.push([dayCd, trainNumber, row.stationId, row.arrivalSeconds, row.departureSeconds]);
      });
      stopSequenceSet.push([dayCd, trainNumber, sequence.directionId, stationIds]);
    }
    const sets = {
      stationSet,
      odSet: providerStationIds.flatMap((departure) => providerStationIds
        .filter((arrival) => arrival !== departure)
        .map((arrival) => [dayCd, departure, arrival])),
      trainSet,
      stopSequenceSet,
      timetableTupleSet,
    };
    if (JSON.stringify(sets) !== JSON.stringify(storedRows[0].sets)) {
      throw new Error("SOURCE_SNAPSHOT_SETS_MISMATCH");
    }
    return { dayCd, sets };
  });
  if (source.stationRosters.length !== dayCodes.length
    || source.normalizedSnapshotSets.length !== dayCodes.length
    || source.stationSequences.some(({ dayCd }) => !dayCodes.includes(dayCd))
    || source.transitTrips.some(({ id }) => !dayCodes.some((dayCd) => typeof id === "string" && id.endsWith(`-${dayCd}`)))
    || source.transitStopTimes.some(({ tripId }) => !source.transitTrips.some(({ id }) => id === tripId))) {
    throw new Error("SOURCE_SNAPSHOT_SETS_MISMATCH");
  }
  return result;
}

async function validateSourceOutputPath(sourceOutputDir, artifactRelativePath, repositoryRoot) {
  const expectedDir = path.join(repositoryRoot, "tools/datapack/sources");
  if (path.resolve(sourceOutputDir) !== path.resolve(expectedDir)) {
    throw new Error("ADMITTED_SOURCE_REFERENCE_INVALID");
  }
  await mkdir(expectedDir, { recursive: true });
  const [realRoot, realDir] = await Promise.all([realpath(repositoryRoot), realpath(expectedDir)]);
  if (realDir !== path.join(realRoot, "tools/datapack/sources")) {
    throw new Error("ADMITTED_SOURCE_REFERENCE_INVALID");
  }
  return path.join(repositoryRoot, ...artifactRelativePath.split("/"));
}

function validateCoverageContractPath(contractPath, repositoryRoot) {
  const expectedPath = path.join(repositoryRoot, "tools/datapack/itx-cheongchun-coverage-contract.json");
  if (path.resolve(requiredString(contractPath, "--coverage-contract")) !== path.resolve(expectedPath)) {
    throw new Error("ITX coverage contract path must be canonical");
  }
  return expectedPath;
}

function validateCoverageContractAuthority(contract) {
  if (contract?.schemaVersion !== 2
    || contract.artifactKind !== "itx-cheongchun-coverage-contract"
    || contract.serviceId !== "ITX_CHEONGCHUN"
    || contract.canonicalLineId !== LINE_ID
    || contract.completenessAdmission?.snapshotAnomalyPolicy?.policyId !== "itx-snapshot-anomaly-v1") {
    throw new Error("ITX_COVERAGE_CONTRACT_INVALID");
  }
  return contract;
}

async function loadAdmittedSourceReference(contract, repositoryRoot) {
  const reference = contract?.sourceTimetableArtifact;
  if (reference?.status !== "ADMITTED") return null;
  const expectedPath = `tools/datapack/sources/${reference.artifactId}.json`;
  if (reference.admissionEligible !== true || reference.schemaVersion !== 1
    || reference.policyVersion !== "itx-snapshot-anomaly-v1"
    || !/^itx-cheongchun-source-timetable-\d{17}$/.test(reference.artifactId ?? "")
    || !/^[a-f0-9]{64}$/.test(reference.sha256 ?? "")
    || reference.artifactPath !== expectedPath || path.isAbsolute(reference.artifactPath)
    || path.posix.normalize(reference.artifactPath) !== reference.artifactPath) {
    throw new Error("ADMITTED_SOURCE_REFERENCE_INVALID");
  }
  const artifactPath = path.join(repositoryRoot, ...reference.artifactPath.split("/"));
  let stat;
  try {
    const [realRoot, realDir] = await Promise.all([
      realpath(repositoryRoot),
      realpath(path.dirname(artifactPath)),
    ]);
    stat = await lstat(artifactPath);
    if (realDir !== path.join(realRoot, "tools/datapack/sources")) {
      throw new Error("ADMITTED_SOURCE_REFERENCE_INVALID");
    }
  } catch (error) {
    if (error instanceof Error && error.message === "ADMITTED_SOURCE_REFERENCE_INVALID") throw error;
    throw new Error("ADMITTED_SOURCE_REFERENCE_INVALID", { cause: error });
  }
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("ADMITTED_SOURCE_REFERENCE_INVALID");
  const bytes = await readFile(artifactPath);
  if (sha256(bytes) !== reference.sha256) throw new Error("previous ADMITTED source hash mismatch");
  const source = JSON.parse(bytes);
  const { evidenceHash, ...withoutEvidenceHash } = source;
  if (source.artifactKind !== "itx-cheongchun-source-timetable" || source.schemaVersion !== 1
    || source.artifactId !== reference.artifactId || source.freshUntil !== reference.freshUntil
    || evidenceHash !== sha256(JSON.stringify(withoutEvidenceHash))
    || bytes.toString("utf8") !== `${JSON.stringify(source, null, 2)}\n`) {
    throw new Error("ADMITTED_SOURCE_REFERENCE_INVALID");
  }
  validateSourceCandidateSchema(source);
  validateSourceFreshness(source, source.selectedServiceDates);
  validateCanonicalCorridorAuthority(source);
  validateSourceSnapshotSets(source);
  if (source.completenessEvidenceSha256 !== undefined) {
    const expectedEvidencePath = `tools/datapack/sources/${source.artifactId}-completeness-evidence.json`;
    if (reference.completenessEvidencePath !== expectedEvidencePath
      || reference.completenessEvidenceSha256 !== source.completenessEvidenceSha256
      || path.isAbsolute(reference.completenessEvidencePath)
      || path.posix.normalize(reference.completenessEvidencePath) !== reference.completenessEvidencePath) {
      throw new Error("ADMITTED_SOURCE_REFERENCE_INVALID");
    }
    await loadCompletenessEvidence(
      path.join(repositoryRoot, ...reference.completenessEvidencePath.split("/")),
      source,
      repositoryRoot,
      null,
    );
  } else if (reference.completenessEvidencePath !== undefined
    || reference.completenessEvidenceSha256 !== undefined) {
    throw new Error("ADMITTED_SOURCE_REFERENCE_INVALID");
  }
  source.sourceTimetableArtifact = {
    sha256: reference.sha256,
    artifactPath: reference.artifactPath,
  };
  return source;
}

async function verifyOwnerApproval({ approvalUrl, expectedBody, observedAt, fetchImpl, githubToken }) {
  const match = /^https:\/\/github\.com\/AquilaXk\/easysubway\/(issues\/2135|pull\/2139)#issuecomment-(\d+)$/.exec(approvalUrl ?? "");
  if (!match) throw new Error("SNAPSHOT_BOOTSTRAP_APPROVAL_INVALID");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  let record;
  try {
    const response = await fetchImpl(`https://api.github.com/repos/AquilaXk/easysubway/issues/comments/${match[2]}`, {
      redirect: "error",
      signal: controller.signal,
      headers: {
        accept: "application/vnd.github+json",
        ...(githubToken ? { authorization: `Bearer ${githubToken}` } : {}),
      },
    });
    if (!response.ok) throw new Error("approval response is not OK");
    record = await response.json();
  } catch {
    throw new Error("SNAPSHOT_BOOTSTRAP_APPROVAL_INVALID");
  } finally {
    clearTimeout(timeout);
  }
  const approvalAt = offsetIsoEpoch(record.created_at);
  const candidateObservedAt = offsetIsoEpoch(observedAt);
  if (record.author_association !== "OWNER" || record.html_url !== approvalUrl || record.body !== expectedBody
    || approvalAt === null || candidateObservedAt === null || approvalAt <= candidateObservedAt) {
    throw new Error("SNAPSHOT_BOOTSTRAP_APPROVAL_INVALID");
  }
}

function offsetIsoEpoch(value) {
  if (typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const epoch = Date.parse(value);
  return Number.isFinite(epoch) ? epoch : null;
}

function snapshotSets(day) {
  const stations = day.roster?.stations ?? [];
  const stationSet = stations.map(({ canonicalStationId }) => canonicalStationId).sort(naturalCompare);
  const providerStationIds = stations.map(({ providerStationId, canonicalStationId }) => (
    providerStationId ?? canonicalStationId
  )).sort(naturalCompare);
  const odSet = providerStationIds.flatMap((departure) => providerStationIds
    .filter((arrival) => arrival !== departure)
    .map((arrival) => [day.dayCd, departure, arrival]));
  const trainSet = (day.roster?.trainNumbers ?? []).map(normalizeTrainNumber).sort(naturalCompare);
  const sequences = [...(day.timetable?.stationSequences ?? day.roster?.stationSequences ?? [])]
    .sort((left, right) => naturalCompare(normalizeTrainNumber(left.trainNumber), normalizeTrainNumber(right.trainNumber)));
  const stopSequenceSet = sequences.map((sequence) => [
    day.dayCd,
    normalizeTrainNumber(sequence.trainNumber),
    sequence.directionId,
    sequence.stops.map(({ stationId }) => stationId),
  ]);
  const timetableTupleSet = sequences.flatMap((sequence) => sequence.stops.map((stop) => [
    day.dayCd,
    normalizeTrainNumber(sequence.trainNumber),
    stop.stationId,
    stop.arrivalSeconds,
    stop.departureSeconds,
  ]));
  return {
    stationSet,
    odSet,
    trainSet,
    stopSequenceSet,
    timetableTupleSet,
  };
}

function summarizeSet(current, previous) {
  const currentValues = current.map((value) => JSON.stringify(value)).sort();
  const previousValues = previous.map((value) => JSON.stringify(value)).sort();
  const currentSet = new Set(currentValues);
  const previousSet = new Set(previousValues);
  return {
    count: currentValues.length,
    added: currentValues.filter((value) => !previousSet.has(value)).map(JSON.parse),
    removed: previousValues.filter((value) => !currentSet.has(value)).map(JSON.parse),
    sha256: sha256(JSON.stringify(currentValues.map(JSON.parse))),
  };
}

export async function collectKorailItxCheongchunPlan({
  serviceKey,
  runDate,
  kricServiceDayCode,
  trainNumberEvidence,
  fetchImpl = fetch,
  now = new Date(),
} = {}) {
  const key = decodedServiceKey(requiredString(serviceKey, "DATA_GO_KR_SERVICE_KEY"));
  if (!/^\d{8}$/.test(runDate ?? "")) throw new Error("runDate must be YYYYMMDD");
  if (!["7", "8", "9"].includes(kricServiceDayCode)) throw new Error("kricServiceDayCode must be 7, 8, or 9");
  if (trainNumberEvidence?.schemaVersion !== 2
    || trainNumberEvidence?.artifactKind !== "tago-itx-cheongchun-roster-evidence"
    || trainNumberEvidence.serviceDate !== runDate
    || trainNumberEvidence.kricServiceDayCode !== kricServiceDayCode
    || trainNumberEvidence.completedOdCount !== trainNumberEvidence.expectedOdCount
    || trainNumberEvidence.failedOdCount !== 0) {
    throw new Error("TAGO ITX materialized evidence is invalid");
  }
  const materialized = {
    trainNumbers: trainNumberEvidence.trainNumbers,
    stationSequences: trainNumberEvidence.stationSequences,
    transitTrips: trainNumberEvidence.transitTrips,
    transitStopTimes: trainNumberEvidence.transitStopTimes,
  };
  validateMaterializedProjection(materialized, kricServiceDayCode, "TAGO_OD_STOP_SEQUENCE_INVALID");
  const plans = await fetchAll({
    endpoint: `${API_ORIGIN}/B551457/run/v2/travelerTrainRunPlan2`,
    query: {
      "cond[run_ymd::GTE]": runDate,
      "cond[run_ymd::LTE]": runDate,
    },
    expectedFields: EXPECTED_FIELDS.plan,
    key,
    fetchImpl,
  });
  const selected = validateKorailItxPlans({ plans: plans.rows, materialized, runDate });
  const tagoOdTrainSetHash = sha256(JSON.stringify(materialized.trainNumbers.map(normalizeTrainNumber).sort(naturalCompare)));
  const materializedTrainSetHash = sha256(JSON.stringify(
    materialized.stationSequences.map(({ trainNumber }) => normalizeTrainNumber(trainNumber)).sort(naturalCompare),
  ));
  if (tagoOdTrainSetHash !== materializedTrainSetHash) {
    throw new Error("TAGO_OD_STOP_SEQUENCE_INVALID: train set");
  }
  const artifact = {
    schemaVersion: 2,
    artifactKind: "korail-itx-cheongchun-station-sequence-evidence",
    serviceId: "ITX_CHEONGCHUN",
    canonicalLineId: LINE_ID,
    servicePattern: "EXPRESS",
    officialSourceUrl: DETAIL_URL,
    observedAt: now.toISOString(),
    runDate,
    kricServiceDayCode,
    providerResultCode: "0",
    schemaStatus: "EXPECTED",
    requiredTrainNumberSets: ["TAGO_OD", "MATERIALIZED"],
    trainNumbers: materialized.trainNumbers.map(normalizeTrainNumber).sort(naturalCompare),
    trainNumberSets: {
      tagoOd: materialized.trainNumbers.map(normalizeTrainNumber).sort(naturalCompare),
      korailPlan: selected.trainNumbers,
      materialized: materialized.stationSequences.map(({ trainNumber }) => normalizeTrainNumber(trainNumber)).sort(naturalCompare),
    },
    trainSetHashes: {
      tagoOd: tagoOdTrainSetHash,
      korailPlan: selected.trainSetHash,
      materialized: materializedTrainSetHash,
    },
    korailPlanCorroboration: {
      availableCount: selected.trainNumbers.length,
      missingCount: selected.missingTrainNumbers.length,
      duplicateCount: 0,
      mismatchCount: 0,
      warningCodes: selected.missingTrainNumbers.length > 0 ? ["KORAIL_PLAN_NOT_AVAILABLE"] : [],
      missingTrainNumbers: selected.missingTrainNumbers,
      corroboratedTrainSetHash: selected.trainSetHash,
    },
    selectedPlans: selected.selectedPlans,
    stationSequences: materialized.stationSequences,
    transitTrips: materialized.transitTrips,
    transitStopTimes: materialized.transitStopTimes,
    reconstructionSummary: trainNumberEvidence.reconstructionSummary,
    legacyDaejeonRowCount: 0,
    legacyYongsanDaejeonTripCount: 0,
    materialization: { status: "SUPPORTED" },
    operations: [operationEvidence("travelerTrainRunPlan2", plans)],
    credentialRedacted: true,
  };
  artifact.evidenceHash = sha256(JSON.stringify(artifact));
  return artifact;
}

export async function collectKorailItxCheongchunTimetable({
  serviceKey,
  runDate,
  kricServiceDayCode,
  packPath,
  trainNumberEvidence,
  fetchImpl = fetch,
  now = new Date(),
} = {}) {
  const key = decodedServiceKey(requiredString(serviceKey, "DATA_GO_KR_SERVICE_KEY"));
  if (!/^\d{8}$/.test(runDate ?? "")) throw new Error("runDate must be YYYYMMDD");
  if (!["7", "8", "9"].includes(kricServiceDayCode)) throw new Error("kricServiceDayCode must be 7, 8, or 9");
  requiredString(packPath, "packPath");
  validateTrainNumberEvidence(trainNumberEvidence, kricServiceDayCode);

  const codes = await fetchAll({
    endpoint: `${API_ORIGIN}/B551457/run/v2/codes2`,
    query: { "cond[type::EQ]": "mrnt_cd" },
    expectedFields: EXPECTED_FIELDS.codes,
    key,
    fetchImpl,
  });
  const routeCode = uniqueGyeongchunRouteCode(codes.rows);
  const stopCodes = await fetchAll({
    endpoint: `${API_ORIGIN}/B551457/run/v2/codes2`,
    query: { "cond[type::EQ]": "stop_se_cd" },
    expectedFields: EXPECTED_FIELDS.codes,
    key,
    fetchImpl,
  });
  const passengerStopCodes = passengerStopCodeMappings(stopCodes.rows);
  const commonQuery = {
    "cond[run_ymd::GTE]": runDate,
    "cond[run_ymd::LTE]": runDate,
  };
  const plans = await fetchAll({
    endpoint: `${API_ORIGIN}/B551457/run/v2/travelerTrainRunPlan2`,
    query: commonQuery,
    expectedFields: EXPECTED_FIELDS.plan,
    key,
    fetchImpl,
  });
  const info = await fetchAll({
    endpoint: `${API_ORIGIN}/B551457/run/v2/travelerTrainRunInfo2`,
    query: { ...commonQuery, "cond[mrnt_cd::EQ]": routeCode.code },
    expectedFields: EXPECTED_FIELDS.info,
    key,
    fetchImpl,
  });
  const { legacyDaejeonRowCount, legacyYongsanDaejeonTripCount } = legacyDaejeonCounts(
    plans.rows,
    info.rows,
    trainNumberEvidence.trainNumbers,
  );
  if (legacyDaejeonRowCount !== 0 || legacyYongsanDaejeonTripCount !== 0) {
    const error = new Error("Korail ITX legacy Daejeon data must be zero");
    error.legacyDaejeonRowCount = legacyDaejeonRowCount;
    error.legacyYongsanDaejeonTripCount = legacyYongsanDaejeonTripCount;
    throw error;
  }
  const materializationInput = {
    plans: plans.rows,
    infoRows: info.rows,
    runDate,
    kricServiceDayCode,
    packPath,
    trainNumbers: trainNumberEvidence.trainNumbers,
    routeCode: routeCode.code,
    passengerStopCodes,
  };
  const analyzed = analyzeKorailItxRows(materializationInput);
  const directions = [...new Set(analyzed.stationSequences.map(({ directionCode }) => directionCode))].sort();
  if (!directions.includes("U") || !directions.includes("D")) {
    throw new Error("Korail ITX roster must include both directions");
  }
  const terminalVariants = [...new Map(analyzed.stationSequences.map((trip) => {
    const variant = {
      directionCode: trip.directionCode,
      originStationName: trip.originStationName,
      destinationStationName: trip.destinationStationName,
    };
    return [JSON.stringify(variant), variant];
  })).values()].sort((left, right) => (
    left.directionCode.localeCompare(right.directionCode)
    || naturalCompare(left.originStationName, right.originStationName)
    || naturalCompare(left.destinationStationName, right.destinationStationName)
  ));
  const materialized = analyzed.missingTimestampStopCount === 0
    ? materializeAnalyzedKorailItxRows(analyzed, kricServiceDayCode, runDate)
    : { transitTrips: [], transitStopTimes: [], trainNumbers: [], stationMappings: analyzed.stationMappings };
  if (analyzed.missingTimestampStopCount === 0) {
    validateTagoOdJoin(materialized, trainNumberEvidence, kricServiceDayCode, runDate);
  }
  const checkedStopCount = analyzed.stationSequences.reduce((total, trip) => total + trip.stops.length, 0);
  const populatedTimestampStopCount = checkedStopCount - analyzed.missingTimestampStopCount;
  let stationTimeCapabilityStatus = "SUPPORTED";
  let stationTimeCapabilityReasonCode = "OFFICIAL_OPERATION_FIELDS_POPULATED";
  if (analyzed.missingTimestampStopCount > 0) {
    stationTimeCapabilityStatus = analyzed.populatedTimestampFieldCount === 0
      ? "EXPLICITLY_UNSUPPORTED_WITH_EVIDENCE" : "MISSING";
    stationTimeCapabilityReasonCode = analyzed.populatedTimestampFieldCount === 0
      ? "OFFICIAL_OPERATION_FIELDS_EMPTY" : "PARTIAL_OFFICIAL_OPERATION_FIELDS_EMPTY";
  }

  return {
    schemaVersion: 1,
    artifactKind: "korail-itx-cheongchun-station-sequence-evidence",
    serviceId: "ITX_CHEONGCHUN",
    canonicalLineId: LINE_ID,
    servicePattern: "EXPRESS",
    officialSourceUrl: DETAIL_URL,
    observedAt: now.toISOString(),
    runDate,
    kricServiceDayCode,
    providerResultCode: "0",
    schemaStatus: "EXPECTED",
    routeCodeMapping: { providerCode: routeCode.code, providerName: routeCode.value },
    stopCodeMappings: [...passengerStopCodes].map(([providerCode, providerName]) => ({ providerCode, providerName })),
    trainNumberFilter: {
      sourceArtifactKind: trainNumberEvidence.artifactKind,
      trainNumberCount: trainNumberEvidence.trainNumbers.length,
      evidenceHash: trainNumberEvidence.evidenceHash,
    },
    trainCount: analyzed.trainNumbers.length,
    stationSequenceRowCount: checkedStopCount,
    stopTimeCount: materialized.transitStopTimes.length,
    trainNumbers: analyzed.trainNumbers,
    stationMappings: analyzed.stationMappings,
    stationSequences: analyzed.stationSequences,
    directions,
    terminalVariants,
    legacyDaejeonRowCount,
    legacyYongsanDaejeonTripCount,
    trainNumberSets: {
      roster: [...new Set(trainNumberEvidence.trainNumbers.map(normalizeTrainNumber))].sort(naturalCompare),
      plan: analyzed.trainNumbers,
      info: analyzed.trainNumbers,
      materialized: materialized.trainNumbers,
    },
    materialization: {
      status: analyzed.missingTimestampStopCount === 0 ? "SUPPORTED" : "MISSING_STATION_TIMES",
      missingTimestampStopCount: analyzed.missingTimestampStopCount,
      stationTimeCapability: {
        status: stationTimeCapabilityStatus,
        reasonCode: stationTimeCapabilityReasonCode,
        checkedStopCount,
        populatedTimestampStopCount,
        requiredTimestampFieldCount: analyzed.requiredTimestampFieldCount,
        populatedTimestampFieldCount: analyzed.populatedTimestampFieldCount,
      },
    },
    operations: [
      operationEvidence("codes2", codes),
      operationEvidence("codes2", stopCodes),
      operationEvidence("travelerTrainRunPlan2", plans),
      operationEvidence("travelerTrainRunInfo2", info),
    ],
    transitTrips: materialized.transitTrips,
    transitStopTimes: materialized.transitStopTimes,
    evidenceHash: sha256(JSON.stringify({
      runDate,
      kricServiceDayCode,
      trainNumberEvidenceHash: trainNumberEvidence.evidenceHash,
      stationMappings: analyzed.stationMappings,
      stationSequences: analyzed.stationSequences,
      plans: plans.rows,
      info: info.rows,
      transitTrips: materialized.transitTrips,
      transitStopTimes: materialized.transitStopTimes,
    })),
    credentialRedacted: true,
  };
}

export function materializeKorailItxRows({
  plans,
  infoRows,
  runDate,
  kricServiceDayCode,
  packPath,
  trainNumbers,
  routeCode,
  passengerStopCodes,
}) {
  const analyzed = analyzeKorailItxRows({
    plans,
    infoRows,
    runDate,
    kricServiceDayCode,
    packPath,
    trainNumbers,
    routeCode,
    passengerStopCodes,
  });
  if (analyzed.missingTimestampStopCount > 0) throw new Error("Korail ITX planned timestamp missing");
  return materializeAnalyzedKorailItxRows(analyzed, kricServiceDayCode, runDate);
}

export function validateKorailItxPlans({ plans, materialized, runDate }) {
  if (!Array.isArray(plans)) throw new Error("KORAIL_PLAN_MISMATCH: plans");
  const trainNumbers = (materialized?.trainNumbers ?? []).map(normalizeTrainNumber).sort(naturalCompare);
  if (trainNumbers.length === 0 || new Set(trainNumbers).size !== trainNumbers.length) {
    throw new Error("KORAIL_PLAN_MISMATCH: TAGO train set");
  }
  const stationSequences = new Map((materialized?.stationSequences ?? []).map((sequence) => (
    [normalizeTrainNumber(sequence.trainNumber), sequence]
  )));
  const selectedPlans = [];
  const missingTrainNumbers = [];
  for (const trainNumber of trainNumbers) {
    const matches = plans.filter((plan) => normalizeTrainNumber(plan?.trn_no) === trainNumber);
    if (matches.length === 0) {
      missingTrainNumbers.push(trainNumber);
      continue;
    }
    if (matches.length > 1) throw new Error(`KORAIL_PLAN_DUPLICATE: ${safeToken(trainNumber)}`);
    const plan = matches[0];
    const sequence = stationSequences.get(trainNumber);
    const first = sequence?.stops?.[0];
    const last = sequence?.stops?.at(-1);
    if (String(plan.run_ymd) !== runDate || !first || !last
      || normalizeStationName(plan.dptre_stn_nm) !== normalizeStationName(first.nameKo)
      || normalizeStationName(plan.arvl_stn_nm) !== normalizeStationName(last.nameKo)
      || [plan.dptre_stn_nm, plan.arvl_stn_nm].some((name) => normalizeStationName(name) === normalizeStationName("대전"))) {
      throw new Error(`KORAIL_PLAN_MISMATCH: ${safeToken(trainNumber)}`);
    }
    let departureSeconds;
    let arrivalSeconds;
    try {
      departureSeconds = timestampSeconds(
        plan.trn_plan_dptre_dt, runDate, `plan departure[${safeToken(trainNumber)}]`,
      );
      arrivalSeconds = timestampSeconds(
        plan.trn_plan_arvl_dt, runDate, `plan arrival[${safeToken(trainNumber)}]`,
      );
    } catch {
      throw new Error(`KORAIL_PLAN_MISMATCH: ${safeToken(trainNumber)}`);
    }
    if (departureSeconds !== first.departureSeconds || arrivalSeconds !== last.arrivalSeconds) {
      throw new Error(`KORAIL_PLAN_MISMATCH: ${safeToken(trainNumber)}`);
    }
    const normalizedPlanTrainNumber = normalizeTrainNumber(plan.trn_no);
    if (normalizedPlanTrainNumber !== trainNumber) {
      throw new Error(`KORAIL_PLAN_MISMATCH: ${safeToken(trainNumber)}`);
    }
    selectedPlans.push({ ...plan, normalizedTrainNumber: normalizedPlanTrainNumber });
  }
  const selectedTrainNumbers = selectedPlans
    .map(({ normalizedTrainNumber }) => normalizedTrainNumber)
    .sort(naturalCompare);
  return {
    trainNumbers: selectedTrainNumbers,
    missingTrainNumbers,
    selectedPlans,
    trainSetHash: sha256(JSON.stringify(selectedTrainNumbers)),
  };
}

export function analyzeKorailItxRows({
  plans,
  infoRows,
  runDate,
  packPath,
  trainNumbers,
  routeCode,
  passengerStopCodes,
}) {
  if (!Array.isArray(plans) || plans.length === 0) throw new Error("Korail run plan returned zero rows");
  if (!Array.isArray(infoRows) || infoRows.length === 0) throw new Error("Korail ITX run info returned zero rows");
  const planByTrain = uniqueRowsByTrain(plans, runDate, "run plan");
  const allowed = new Set((trainNumbers ?? []).map(normalizeTrainNumber));
  if (allowed.size === 0 || allowed.size !== trainNumbers.length) throw new Error("TAGO ITX train numbers must be non-empty and unique");
  if (!(passengerStopCodes instanceof Map) || passengerStopCodes.size === 0) {
    throw new Error("Korail passenger stop code mappings are required");
  }
  const canonical = readCanonicalLine(packPath);
  try {
    const grouped = groupKorailInfoRows({ infoRows, runDate, routeCode, allowed, planByTrain });
    const sequenceAnalysis = analyzeStationSequences({ grouped, canonical, passengerStopCodes, planByTrain, runDate });
    return {
      trainNumbers: [...grouped.keys()].sort(naturalCompare),
      stationMappings: [...sequenceAnalysis.stationMappings.values()].sort((left, right) => (
        left.lineSequence - right.lineSequence || naturalCompare(left.providerStationCode, right.providerStationCode)
      )),
      stationSequences: sequenceAnalysis.stationSequences,
      missingTimestampStopCount: sequenceAnalysis.missingTimestampStopCount,
      requiredTimestampFieldCount: sequenceAnalysis.requiredTimestampFieldCount,
      populatedTimestampFieldCount: sequenceAnalysis.populatedTimestampFieldCount,
    };
  } finally {
    canonical.close();
  }
}

function groupKorailInfoRows({ infoRows, runDate, routeCode, allowed, planByTrain }) {
  const grouped = new Map();
  for (const row of infoRows) {
    if (String(row.run_ymd) !== runDate) throw new Error("Korail ITX run info run date mismatch");
    if (normalize(row.mrnt_nm) !== normalize("경춘선") || String(row.mrnt_cd) !== routeCode) {
      throw new Error("Korail run info contains non-경춘선 row");
    }
    const trainNumber = normalizeTrainNumber(row.trn_no);
    if (!allowed.has(trainNumber)) continue;
    if (!planByTrain.has(trainNumber)) throw new Error(`Korail ITX run plan missing train: ${safeToken(trainNumber)}`);
    const rows = grouped.get(trainNumber) ?? [];
    rows.push(row);
    grouped.set(trainNumber, rows);
  }
  for (const trainNumber of allowed) {
    if (!grouped.has(trainNumber)) throw new Error(`Korail station rows missing TAGO ITX train: ${safeToken(trainNumber)}`);
  }
  return grouped;
}

function analyzeStationSequences({ grouped, canonical, passengerStopCodes, planByTrain, runDate }) {
  const stationMappings = new Map();
  const stationSequences = [];
  let missingTimestampStopCount = 0;
  let requiredTimestampFieldCount = 0;
  let populatedTimestampFieldCount = 0;
  for (const [trainNumber, trainRows] of [...grouped.entries()].sort(([left], [right]) => naturalCompare(left, right))) {
    const ordered = orderedTrainRows(trainRows, trainNumber);
    const directionCodes = new Set(ordered.map(({ row }) => korailDirectionCode(row.uppln_dn_se_cd, trainNumber)));
    if (directionCodes.size !== 1) throw new Error(`Korail ITX direction mismatch: ${safeToken(trainNumber)}`);
    const selected = selectPassengerStops({ ordered, canonical, passengerStopCodes, stationMappings, trainNumber });
    const stops = assignCanonicalLineIds(selected.stops, trainNumber);
    const plan = planByTrain.get(trainNumber);
    validateCanonicalTrip(stops, ordered, trainNumber, plan, runDate);
    missingTimestampStopCount += selected.missingTimestampStopCount;
    requiredTimestampFieldCount += selected.requiredTimestampFieldCount;
    populatedTimestampFieldCount += selected.populatedTimestampFieldCount;
    stationSequences.push({
      trainNumber,
      directionCode: [...directionCodes][0],
      originStationName: plan.dptre_stn_nm,
      destinationStationName: plan.arvl_stn_nm,
      stops,
    });
  }
  return {
    stationMappings,
    stationSequences,
    missingTimestampStopCount,
    requiredTimestampFieldCount,
    populatedTimestampFieldCount,
  };
}

function orderedTrainRows(trainRows, trainNumber) {
  const ordered = trainRows
    .map((row) => ({ row, sequence: positiveInteger(row.trn_run_sn, "trn_run_sn") }))
    .sort((left, right) => left.sequence - right.sequence);
  if (new Set(ordered.map(({ sequence }) => sequence)).size !== ordered.length) {
    throw new Error(`Korail ITX duplicate trn_run_sn: ${safeToken(trainNumber)}`);
  }
  return ordered;
}

function selectPassengerStops({ ordered, canonical, passengerStopCodes, stationMappings, trainNumber }) {
  const stops = [];
  let missingTimestampStopCount = 0;
  let requiredTimestampFieldCount = 0;
  let populatedTimestampFieldCount = 0;
  const passengerRows = ordered.flatMap(({ row, sequence }, index) => {
    const stopCode = String(row.stop_se_cd);
    const expectedStopName = passengerStopCodes.get(stopCode);
    if (!expectedStopName) return [];
    if (normalize(expectedStopName) !== normalize(row.stop_se_nm)) {
      throw new Error(`Korail ITX passenger stop name mismatch: ${safeToken(trainNumber)}/${safeLabel(row.stn_nm)}`);
    }
    const matches = canonical.byName.get(normalizeStationName(row.stn_nm)) ?? [];
    const station = matches.length === 1 ? matches[0] : null;
    return [{ row, sequence, index, station, stopCode }];
  });
  for (const [index, { row, sequence, station, stopCode }] of passengerRows.entries()) {
    if (!station) throw new Error(`Korail ITX passenger stop canonical mapping missing: ${safeToken(trainNumber)}/${safeLabel(row.stn_nm)}`);
    const arrivalTimestamp = validProviderTimestamp(row.trn_arvl_dt);
    const departureTimestamp = validProviderTimestamp(row.trn_dptre_dt);
    if (index > 0) {
      requiredTimestampFieldCount += 1;
      if (arrivalTimestamp !== null) populatedTimestampFieldCount += 1;
    }
    if (index < passengerRows.length - 1) {
      requiredTimestampFieldCount += 1;
      if (departureTimestamp !== null) populatedTimestampFieldCount += 1;
    }
    if ((index > 0 && arrivalTimestamp === null)
      || (index < passengerRows.length - 1 && departureTimestamp === null)) missingTimestampStopCount += 1;
    stationMappings.set(`${row.stn_cd}|${station.stationId}`, {
      providerStationCode: String(row.stn_cd),
      providerStationName: String(row.stn_nm),
      canonicalStationId: station.stationId,
      lineSequence: station.lineSequence,
    });
    stops.push({
      providerSequence: sequence,
      providerStationCode: String(row.stn_cd),
      providerStationName: String(row.stn_nm),
      canonicalStationId: station.stationId,
      lineSequence: station.lineSequence,
      lineMemberships: station.lineMemberships,
      stopCode,
      stopName: String(row.stop_se_nm),
      arrivalTimestamp,
      departureTimestamp,
    });
  }
  return { stops, missingTimestampStopCount, requiredTimestampFieldCount, populatedTimestampFieldCount };
}

function assignCanonicalLineIds(stops, trainNumber) {
  const resolved = stops.map((stop) => ({
    ...stop,
    canonicalLineId: Number.isInteger(stop.lineSequence) ? LINE_ID : null,
  }));
  const lineIndexes = resolved.flatMap((stop, index) => Number.isInteger(stop.lineSequence) ? [index] : []);
  const firstLineIndex = lineIndexes[0];
  const lastLineIndex = lineIndexes.at(-1);
  if (firstLineIndex === undefined || lastLineIndex === undefined) {
    throw new Error(`Korail ITX canonical line segment missing: ${safeToken(trainNumber)}`);
  }
  resolveOutsideSegmentLine(resolved, 0, firstLineIndex, trainNumber);
  resolveOutsideSegmentLine(resolved, lastLineIndex, resolved.length - 1, trainNumber);
  if (resolved.some(({ canonicalLineId }) => canonicalLineId === null)) {
    throw new Error(`Korail ITX outside-line segment mapping is incomplete: ${safeToken(trainNumber)}`);
  }
  return resolved;
}

function resolveOutsideSegmentLine(stops, start, end, trainNumber) {
  if (start === end || stops.slice(start, end + 1).every(({ canonicalLineId }) => canonicalLineId === LINE_ID)) return;
  const common = stops.slice(start, end + 1).reduce((shared, stop) => {
    const memberships = new Set(stop.lineMemberships.map(({ lineId }) => lineId));
    return shared === null ? memberships : new Set([...shared].filter((lineId) => memberships.has(lineId)));
  }, null);
  const candidates = [...(common ?? [])].filter((lineId) => lineId !== LINE_ID).sort();
  const selectedLineId = candidates.includes(CAPITAL_APPROACH_LINE_ID)
    ? CAPITAL_APPROACH_LINE_ID
    : candidates.length === 1 ? candidates[0] : null;
  if (selectedLineId === null) {
    throw new Error(`Korail ITX outside-line segment mapping is missing or ambiguous: ${safeToken(trainNumber)}`);
  }
  for (let index = start; index <= end; index += 1) {
    if (stops[index].canonicalLineId === null) stops[index].canonicalLineId = selectedLineId;
  }
}

function validateCanonicalTrip(stops, ordered, trainNumber, plan, runDate) {
  if (stops.length < 2) {
    const observed = ordered.slice(0, 30).map(({ row }) => (
      `${safeLabel(row.stn_nm)}:${safeLabel(row.stop_se_cd)}:${safeLabel(row.stop_se_nm)}`
    ));
    throw new Error(
      `Korail ITX trip must have at least 2 canonical stops: ${safeToken(trainNumber)}; observed=${observed.join(",")}`,
    );
  }
  const stationIds = stops.map(({ canonicalStationId }) => canonicalStationId);
  if (new Set(stationIds).size !== stationIds.length) {
    throw new Error(`Korail ITX duplicate canonical stop: ${safeToken(trainNumber)}`);
  }
  const lineStops = stops.filter(({ lineSequence }) => Number.isInteger(lineSequence));
  if (lineStops.length < 2) throw new Error(`Korail ITX trip must have at least 2 canonical line stops: ${safeToken(trainNumber)}`);
  if (validProviderTimestamp(plan.trn_plan_dptre_dt) === null || validProviderTimestamp(plan.trn_plan_arvl_dt) === null) {
    throw new Error(`Korail ITX plan timestamp missing: ${safeToken(trainNumber)}`);
  }
  const planDepartureSeconds = timestampSeconds(plan.trn_plan_dptre_dt, runDate, `plan departure[${safeToken(trainNumber)}]`);
  const planArrivalSeconds = timestampSeconds(plan.trn_plan_arvl_dt, runDate, `plan arrival[${safeToken(trainNumber)}]`);
  if (planDepartureSeconds > planArrivalSeconds) throw new Error(`Korail ITX plan arrival must follow departure: ${safeToken(trainNumber)}`);
  if (stops[0].departureTimestamp !== null
    && timestampSeconds(stops[0].departureTimestamp, runDate, `first stop departure[${safeToken(trainNumber)}]`)
      !== planDepartureSeconds) {
    throw new Error(`Korail ITX plan departure does not match first stop departure: ${safeToken(trainNumber)}`);
  }
  if (stops.at(-1).arrivalTimestamp !== null
    && timestampSeconds(stops.at(-1).arrivalTimestamp, runDate, `last stop arrival[${safeToken(trainNumber)}]`)
      !== planArrivalSeconds) {
    throw new Error(`Korail ITX plan arrival does not match last stop arrival: ${safeToken(trainNumber)}`);
  }
  if (normalizeStationName(stops[0].providerStationName) !== normalizeStationName(plan.dptre_stn_nm)
    || normalizeStationName(stops.at(-1).providerStationName) !== normalizeStationName(plan.arvl_stn_nm)) {
    throw new Error(`Korail ITX plan endpoint mismatch: ${safeToken(trainNumber)}`);
  }
  validateLineSequenceOnly(lineStops, trainNumber);
}

function materializeAnalyzedKorailItxRows(analyzed, kricServiceDayCode, runDate) {
  const transitTrips = [];
  const transitStopTimes = [];
  const serviceId = { "8": "weekday-kric", "7": "saturday-kric", "9": "holiday-kric" }[kricServiceDayCode];
  if (serviceId === undefined) throw new Error("kricServiceDayCode must be 7, 8, or 9");
  for (const trip of analyzed.stationSequences) {
    const rows = trip.stops.map((stop) => {
      const timestampContext = `${safeToken(trip.trainNumber)}/${safeLabel(stop.providerStationName)}/${safeLabel(stop.stopCode)}`;
      const arrivalSeconds = timestampSeconds(
        providerTimestamp(stop.arrivalTimestamp, stop.departureTimestamp, `trn_arvl_dt[${timestampContext}]`),
        runDate,
        `trn_arvl_dt[${timestampContext}]`,
      );
      const departureSeconds = timestampSeconds(
        providerTimestamp(stop.departureTimestamp, stop.arrivalTimestamp, `trn_dptre_dt[${timestampContext}]`),
        runDate,
        `trn_dptre_dt[${timestampContext}]`,
      );
      if (arrivalSeconds > departureSeconds) throw new Error(`Korail ITX arrival must precede departure: ${safeToken(trip.trainNumber)}`);
      return {
        stationId: stop.canonicalStationId,
        lineId: stop.canonicalLineId,
        trnNo: trip.trainNumber,
        dayCd: kricServiceDayCode,
        arrivalSeconds,
        departureSeconds,
        servicePattern: "EXPRESS",
        lineSequence: stop.lineSequence,
      };
    });
    validateProviderOrder(rows, trip.trainNumber);
    const lineRows = rows.filter(({ lineSequence }) => Number.isInteger(lineSequence));
    const directionId = lineRows.at(-1).lineSequence > lineRows[0].lineSequence ? "up" : "down";
    const routeId = `route-${LINE_ID}-${directionId}`;
    const tripId = `${routeId}-${trip.trainNumber}-${kricServiceDayCode}`;
    transitTrips.push({
      id: tripId,
      routeId,
      serviceId,
      tripHeadsign: trip.stops.at(-1).providerStationName,
      directionId,
      servicePattern: "EXPRESS",
      trainNo: trip.trainNumber,
    });
    rows.forEach((row, index) => transitStopTimes.push({
      tripId,
      stopSequence: index + 1,
      stationId: row.stationId,
      lineId: row.lineId,
      arrivalSeconds: row.arrivalSeconds,
      departureSeconds: row.departureSeconds,
    }));
  }
  return {
    transitTrips,
    transitStopTimes,
    trainNumbers: analyzed.trainNumbers,
    stationMappings: analyzed.stationMappings,
  };
}

function uniqueGyeongchunRouteCode(rows) {
  const matches = rows.filter((row) => row.type === "mrnt_cd" && normalize(row.value) === normalize("경춘선"));
  if (matches.length !== 1) throw new Error("Korail mrnt_cd 경춘선 mapping is missing or ambiguous");
  return {
    code: requiredString(String(matches[0].code), "mrnt_cd.code"),
    value: requiredString(String(matches[0].value), "mrnt_cd.value"),
  };
}

function passengerStopCodeMappings(rows) {
  const allowed = new Set([normalize("시발"), normalize("여객승하차"), normalize("종착")]);
  const matches = rows.filter((row) => row.type === "stop_se_cd" && allowed.has(normalize(row.value)));
  if (matches.length === 0) throw new Error("Korail passenger stop code mapping is missing");
  return new Map(matches.map((row) => [
    requiredString(String(row.code), "stop_se_cd.code"),
    requiredString(String(row.value), "stop_se_cd.value"),
  ]));
}

function validateTrainNumberEvidence(evidence, kricServiceDayCode) {
  if (evidence?.artifactKind !== "tago-itx-cheongchun-roster-evidence" || evidence?.serviceId !== "ITX_CHEONGCHUN") {
    throw new Error("TAGO ITX train number evidence is invalid");
  }
  if (evidence.kricServiceDayCode !== kricServiceDayCode) throw new Error("TAGO/Korail service day code mismatch");
  if (!Number.isInteger(evidence.expectedOdCount) || evidence.expectedOdCount <= 0
    || evidence.completedOdCount !== evidence.expectedOdCount || evidence.failedOdCount !== 0) {
    throw new Error("TAGO ITX OD matrix evidence is incomplete");
  }
  if (![evidence.stationSetHash, evidence.odMatrixHash, evidence.evidenceHash]
    .every((value) => /^[a-f0-9]{64}$/.test(value ?? ""))) {
    throw new Error("TAGO ITX roster hash is invalid");
  }
  if (!Array.isArray(evidence.trainNumbers) || !Array.isArray(evidence.itineraries)
    || evidence.trainNumbers.length === 0 || evidence.itineraries.length === 0) {
    throw new Error("TAGO ITX train number evidence is incomplete");
  }
  const roster = new Set(evidence.trainNumbers.map(normalizeTrainNumber));
  const itineraryTrains = new Set(evidence.itineraries.map(({ trainNumber }) => normalizeTrainNumber(trainNumber)));
  if (roster.size !== evidence.trainNumbers.length || !sameSet(roster, itineraryTrains)) {
    throw new Error("TAGO ITX roster/itinerary train number set mismatch");
  }
}

function validateTagoOdJoin(materialized, evidence, dayCd, runDate) {
  if (evidence.serviceDate !== runDate) throw new Error("Korail/TAGO ITX service date mismatch");
  const tripsByNumber = new Map(materialized.trainNumbers.map((trainNumber) => [
    trainNumber,
    materialized.transitTrips.find(({ id }) => id.endsWith(`-${trainNumber}-${dayCd}`)),
  ]));
  for (const [index, itinerary] of evidence.itineraries.entries()) {
    const trainNumber = normalizeTrainNumber(itinerary.trainNumber);
    const departureStationId = requiredString(itinerary.departureStationId, `itineraries[${index}].departureStationId`);
    const arrivalStationId = requiredString(itinerary.arrivalStationId, `itineraries[${index}].arrivalStationId`);
    const trip = tripsByNumber.get(trainNumber);
    if (!trip) throw new Error(`Korail trip missing TAGO ITX train: ${safeToken(trainNumber)}`);
    const stops = materialized.transitStopTimes.filter(({ tripId }) => tripId === trip.id);
    const departure = stops.filter(({ stationId }) => stationId === departureStationId);
    const arrival = stops.filter(({ stationId }) => stationId === arrivalStationId);
    if (departure.length !== 1 || arrival.length !== 1) throw new Error(`Korail ITX canonical endpoint mismatch: ${safeToken(trainNumber)}`);
    if (departure[0].departureSeconds !== isoServiceSeconds(itinerary.departureAt, runDate, `itineraries[${index}].departureAt`)
      || arrival[0].arrivalSeconds !== isoServiceSeconds(itinerary.arrivalAt, runDate, `itineraries[${index}].arrivalAt`)) {
      throw new Error(`Korail/TAGO ITX endpoint time mismatch: ${safeToken(trainNumber)}`);
    }
  }
}

function sameSet(left, right) {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function emptyTrainSetHashes(roster) {
  const emptyHash = sha256(JSON.stringify([]));
  const tagoOd = Array.isArray(roster?.trainNumbers)
    ? sha256(JSON.stringify(roster.trainNumbers.map(normalizeTrainNumber).sort(naturalCompare)))
    : emptyHash;
  const materialized = Array.isArray(roster?.stationSequences)
    ? sha256(JSON.stringify(roster.stationSequences.map(({ trainNumber }) => normalizeTrainNumber(trainNumber)).sort(naturalCompare)))
    : emptyHash;
  return { tagoOd, korailPlan: emptyHash, materialized };
}

function emptyReconstructionSummary() {
  return {
    trainCount: 0,
    stopCount: 0,
    conflictingTimestampCount: 0,
    missingPairCount: 0,
    duplicateOdCount: 0,
  };
}

function legacyDaejeonCounts(plans, infoRows, trainNumbers) {
  const allowed = new Set(trainNumbers.map(normalizeTrainNumber));
  const isAllowed = (row) => allowed.has(normalizeTrainNumber(row.trn_no));
  const legacyDaejeonRowCount = infoRows.filter((row) => (
    isAllowed(row) && normalizeStationName(row.stn_nm) === normalizeStationName("대전")
  )).length;
  const legacyYongsanDaejeonTripCount = plans.filter((row) => {
    if (!isAllowed(row)) return false;
    const endpoints = [row.dptre_stn_nm, row.arvl_stn_nm].map(normalizeStationName);
    return endpoints.includes(normalizeStationName("용산")) && endpoints.includes(normalizeStationName("대전"));
  }).length;
  return { legacyDaejeonRowCount, legacyYongsanDaejeonTripCount };
}

function completenessFailureReason(error) {
  const message = error instanceof Error ? error.message : "";
  for (const code of [
    "TAGO_QUOTA_BUDGET_EXHAUSTED",
    "TAGO_OD_DUPLICATE",
    "TAGO_OD_PAIR_COVERAGE_INCOMPLETE",
    "TAGO_OD_TIME_CONFLICT",
    "TAGO_OD_STOP_SEQUENCE_INVALID",
    "KORAIL_PLAN_DUPLICATE",
    "KORAIL_PLAN_MISMATCH",
  ]) if (message.startsWith(code)) return code;
  if (/HTTP \d+/.test(message)) return "PROVIDER_HTTP_FAILURE";
  if (/transport failure/.test(message)) return "PROVIDER_TRANSPORT_FAILURE";
  if (/pagination incomplete/.test(message)) return "PROVIDER_PAGINATION_INCOMPLETE";
  if (/schema mismatch/.test(message)) return "PROVIDER_SCHEMA_FAILURE";
  if (/provider resultCode/.test(message)) return "PROVIDER_RESULT_FAILURE";
  if (/train grade is missing or ambiguous/.test(message)) return "TRAIN_GRADE_MAPPING_INCOMPLETE";
  if (/station mapping/.test(message)) return "STATION_MAPPING_INCOMPLETE";
  if (/canonical mapping missing/.test(message)) return "CANONICAL_STATION_MAPPING_INCOMPLETE";
  if (/roster stations must be unique/.test(message)) return "ROSTER_STATION_SET_INVALID";
  if (/roster returned zero rows/.test(message)) return "ROSTER_EMPTY";
  if (/run plan returned zero rows/.test(message)) return "OFFICIAL_RUN_PLAN_EMPTY";
  if (/run info returned zero rows/.test(message)) return "OFFICIAL_RUN_INFO_EMPTY";
  if (/legacy Daejeon data must be zero/.test(message)) return "LEGACY_DAEJEON_DATA_PRESENT";
  if (/OD matrix/.test(message)) return "OD_MATRIX_INCOMPLETE";
  if (/both directions/.test(message)) return "PARTIAL_DIRECTION";
  if (/timestamp missing/.test(message)) return "PLANNED_TIME_MISSING";
  return "PROVIDER_OR_SCHEMA_FAILURE";
}

function completenessFailureContext(error) {
  const message = error instanceof Error ? error.message : "";
  const station = /station mapping is missing or ambiguous: (.+)$/.exec(message)?.[1];
  if (station) return safeLabel(station);
  const requiredStations = /^TAGO required station mapping is incomplete: ([\p{L}\p{N},._-]+)$/u.exec(message)?.[1];
  if (requiredStations) return `missingStations=${requiredStations}`;
  const plan = /^(KORAIL_PLAN_(?:MISSING|DUPLICATE|MISMATCH)): ([0-9]+)$/.exec(message);
  if (plan) return `reason=${plan[1]},trainNumber=${plan[2]}`;
  const tagoSchema = /^TAGO ([A-Za-z0-9]+) schema mismatch: (content-type|invalid JSON|body|item|totalCount)(?: bodyFields=([A-Za-z0-9_,.-]+))?$/.exec(message);
  if (tagoSchema) {
    const reason = tagoSchema[2] === "invalid JSON" ? "invalid-json" : tagoSchema[2];
    return `operation=${tagoSchema[1]},reason=schema_mismatch,${reason}`
      + (tagoSchema[3] ? `,bodyFields=${tagoSchema[3]}` : "");
  }
  const pagination = /pagination incomplete: (operation=[A-Za-z0-9]+,collected=\d+,total=(?:\d+|UNKNOWN),pages=\d+)$/.exec(message)?.[1];
  if (pagination) return pagination;
  if (/run plan returned zero rows/.test(message)) return "operation=travelerTrainRunPlan2,total=0";
  if (/run info returned zero rows/.test(message)) return "operation=travelerTrainRunInfo2,total=0";
  return null;
}

function rosterOdFailureContext(roster) {
  const failure = Array.isArray(roster?.failedOds) && roster.failedOds.length === 1 ? roster.failedOds[0] : null;
  if (!failure || !/^[A-Za-z0-9=,._-]+$/.test(failure.failureContext ?? "")) return null;
  return `${failure.failureContext},departureStationId=${safeToken(failure.departureStationId)},`
    + `arrivalStationId=${safeToken(failure.arrivalStationId)}`;
}

function isoServiceSeconds(value, runDate, label) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\+09:00$/.exec(String(value ?? ""));
  if (!match) throw new Error(`${label} must use Asia/Seoul ISO timestamp`);
  const hours = Number(match[4]);
  const minutes = Number(match[5]);
  const seconds = Number(match[6]);
  if (hours > 23 || minutes > 59 || seconds > 59) throw new Error(`${label} is invalid`);
  const timestampDate = `${match[1]}${match[2]}${match[3]}`;
  return serviceDateOffsetSeconds(timestampDate, runDate, label) + hours * 3600 + minutes * 60 + seconds;
}

function readCanonicalLine(packPath) {
  const opened = openPack(packPath, "korail-itx-canonical-");
  try {
    const lineRows = opened.db.prepare(`
      SELECT stations.id, stations.name_ko, station_lines.line_sequence
      FROM station_lines
      JOIN stations ON stations.id = station_lines.station_id
      WHERE station_lines.line_id = ?
      ORDER BY station_lines.line_sequence, stations.id
    `).all(LINE_ID);
    if (lineRows.length === 0) throw new Error(`canonical pack has no line: ${LINE_ID}`);
    const lineSequenceByStation = new Map(lineRows.map((row) => [row.id, row.line_sequence]));
    const rows = opened.db.prepare(`
      SELECT stations.id, stations.name_ko, station_lines.line_id, station_lines.line_sequence
      FROM stations
      JOIN station_lines ON station_lines.station_id = stations.id
      WHERE stations.region = '수도권'
      ORDER BY stations.id, station_lines.line_id
    `).all();
    const stationsById = new Map();
    for (const row of rows) {
      const station = stationsById.get(row.id) ?? { stationId: row.id, nameKo: row.name_ko, lineMemberships: [] };
      station.lineMemberships.push({ lineId: row.line_id, lineSequence: row.line_sequence });
      stationsById.set(row.id, station);
    }
    const byName = new Map();
    for (const station of stationsById.values()) {
      const name = normalizeStationName(station.nameKo);
      const matches = byName.get(name) ?? [];
      matches.push({
        stationId: station.stationId,
        lineSequence: lineSequenceByStation.get(station.stationId) ?? null,
        lineMemberships: station.lineMemberships,
      });
      byName.set(name, matches);
    }
    const rosterStations = [
      ...CAPITAL_APPROACH_STATIONS,
      ...lineRows.map((row) => ({
        canonicalStationId: row.id,
        nameKo: row.name_ko,
        corridorSequence: Number(row.line_sequence) + 3,
        lineId: LINE_ID,
      })),
    ];
    if (rosterStations.length !== 28 || new Set(rosterStations.map(({ canonicalStationId }) => canonicalStationId)).size !== 28) {
      throw new Error("canonical ITX corridor must contain exactly 28 unique stations");
    }
    return {
      byName,
      rosterStations,
      close() {
        opened.db.close();
        cleanupPackDir(opened.dir);
      },
    };
  } catch (error) {
    opened.db.close();
    cleanupPackDir(opened.dir);
    throw error;
  }
}

function uniqueRowsByTrain(rows, runDate, label) {
  const result = new Map();
  for (const row of rows) {
    if (String(row.run_ymd) !== runDate) throw new Error(`Korail ${label} run date mismatch`);
    const trainNumber = normalizeTrainNumber(row.trn_no);
    if (result.has(trainNumber)) throw new Error(`Korail ${label} duplicate train: ${safeToken(trainNumber)}`);
    result.set(trainNumber, row);
  }
  return result;
}

function validateProviderOrder(rows, trainNumber) {
  for (let index = 1; index < rows.length; index += 1) {
    if (rows[index - 1].departureSeconds > rows[index].arrivalSeconds) {
      throw new Error(`Korail ITX stop time is not monotonic: ${safeToken(trainNumber)}`);
    }
  }
  validateLineSequenceOnly(rows.filter(({ lineSequence }) => Number.isInteger(lineSequence)), trainNumber);
}

function validateLineSequenceOnly(rows, trainNumber) {
  let direction = 0;
  for (let index = 1; index < rows.length; index += 1) {
    const step = Math.sign(rows[index].lineSequence - rows[index - 1].lineSequence);
    if (step === 0 || (direction !== 0 && step !== direction)) {
      throw new Error(`Korail ITX stop order must follow canonical lineSequence: ${safeToken(trainNumber)}`);
    }
    direction ||= step;
  }
}

async function fetchAll({ endpoint, query, expectedFields, key, fetchImpl }) {
  const operation = new URL(endpoint).pathname.split("/").at(-1);
  const rows = [];
  const hashes = [];
  let totalCount = null;
  for (let pageNo = 1; pageNo <= 100; pageNo += 1) {
    const url = new URL(endpoint);
    for (const [name, value] of Object.entries({
      serviceKey: key,
      pageNo: String(pageNo),
      numOfRows: "1000",
      returnType: "JSON",
      ...query,
    })) url.searchParams.set(name, value);
    const response = await fetchWithRetry(url, fetchImpl);
    if (!response.ok) {
      if (response.body) await response.body.cancel().catch(() => {});
      throw new Error(`Korail train operation API HTTP ${response.status}`);
    }
    const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() ?? "";
    if (contentType !== "application/json") throw new Error(`Korail train operation API schema mismatch: content-type ${safeToken(contentType)}`);
    const raw = await response.text();
    hashes.push(sha256(raw));
    const page = parsePage(raw, expectedFields);
    totalCount ??= page.totalCount;
    if (totalCount !== page.totalCount) throw new Error("Korail train operation API schema mismatch: totalCount changed");
    rows.push(...page.rows);
    if (rows.length >= totalCount) break;
    if (page.rows.length === 0) {
      throw new Error(
        `Korail train operation API pagination incomplete: operation=${safeToken(operation)},` +
        `collected=${rows.length},total=${totalCount ?? "UNKNOWN"},pages=${hashes.length}`,
      );
    }
  }
  if (rows.length !== totalCount) {
    throw new Error(
      `Korail train operation API pagination incomplete: operation=${safeToken(operation)},` +
      `collected=${rows.length},total=${totalCount ?? "UNKNOWN"},pages=${hashes.length}`,
    );
  }
  return { endpoint, rows, pageCount: hashes.length, totalCount, rawResponseSha256: sha256(hashes.join("|")) };
}

function parsePage(raw, expectedFields) {
  let document;
  try { document = JSON.parse(raw); } catch { throw new Error("Korail train operation API schema mismatch: invalid JSON"); }
  const code = safeToken(document?.response?.header?.resultCode);
  if (code !== "0") throw new Error(`Korail train operation API provider resultCode ${code}`);
  const body = document?.response?.body;
  const item = body?.items?.item;
  const rows = item == null ? [] : Array.isArray(item) ? item : [item];
  for (const [index, row] of rows.entries()) {
    if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error(`Korail train operation API schema mismatch: item[${index}]`);
    const missing = expectedFields.filter((field) => !Object.hasOwn(row, field));
    if (missing.length > 0) throw new Error(`Korail train operation API schema mismatch: item[${index}] fields missing=${missing.join(",")}`);
  }
  const totalCount = Number(body?.totalCount);
  if (!Number.isInteger(totalCount) || totalCount < rows.length) throw new Error("Korail train operation API schema mismatch: totalCount");
  return { rows, totalCount };
}

async function fetchWithRetry(url, fetchImpl) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
        headers: { accept: "application/json" },
      });
      const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
      if (!retryable || attempt === 2) return response;
      if (response.body) await response.body.cancel().catch(() => {});
    } catch (error) {
      if (attempt === 2) throw new Error("Korail train operation API transport failure", { cause: error });
    }
  }
  throw new Error("Korail train operation API transport failure");
}

function timestampSeconds(value, runDate, label) {
  const text = requiredString(String(value), label);
  if (!/^\d{14}$/.test(text)) throw new Error(`${label} must use YYYYMMDDHHMISS`);
  const hours = Number(text.slice(8, 10));
  const minutes = Number(text.slice(10, 12));
  const seconds = Number(text.slice(12, 14));
  if (hours > 23 || minutes > 59 || seconds > 59) throw new Error(`${label} is invalid`);
  return serviceDateOffsetSeconds(text.slice(0, 8), runDate, label) + hours * 3600 + minutes * 60 + seconds;
}

function serviceDateOffsetSeconds(timestampDate, runDate, label) {
  if (timestampDate === runDate) return 0;
  if (timestampDate === nextRunDate(runDate)) return 86_400;
  throw new Error(`${label} must use runDate or the immediately following date`);
}

function nextRunDate(runDate) {
  if (!/^\d{8}$/.test(runDate)) throw new Error("runDate must be YYYYMMDD");
  const year = Number(runDate.slice(0, 4));
  const month = Number(runDate.slice(4, 6));
  const day = Number(runDate.slice(6, 8));
  const current = new Date(Date.UTC(year, month - 1, day));
  if (`${current.getUTCFullYear()}${String(current.getUTCMonth() + 1).padStart(2, "0")}${String(current.getUTCDate()).padStart(2, "0")}` !== runDate) {
    throw new Error("runDate must be a valid calendar date");
  }
  current.setUTCDate(current.getUTCDate() + 1);
  return `${current.getUTCFullYear()}${String(current.getUTCMonth() + 1).padStart(2, "0")}${String(current.getUTCDate()).padStart(2, "0")}`;
}

function freshUntil(serviceDates) {
  const latest = Object.values(serviceDates).sort((left, right) => left.localeCompare(right)).at(-1);
  const next = nextRunDate(latest);
  return `${next.slice(0, 4)}-${next.slice(4, 6)}-${next.slice(6, 8)}T00:00:00+09:00`;
}

function isoRunDate(runDate) {
  nextRunDate(runDate);
  return `${runDate.slice(0, 4)}-${runDate.slice(4, 6)}-${runDate.slice(6, 8)}`;
}

function providerTimestamp(primary, fallback, label) {
  for (const value of [primary, fallback]) {
    const text = String(value ?? "");
    if (/^\d{14}$/.test(text)) return text;
  }
  throw new Error(`${label} and fallback timestamp are missing`);
}

function validProviderTimestamp(value) {
  const text = String(value ?? "");
  return /^\d{14}$/.test(text) ? text : null;
}

function operationEvidence(operation, value) {
  return {
    operation,
    endpoint: value.endpoint,
    pageCount: value.pageCount,
    totalCount: value.totalCount,
    providerResultCode: "0",
    schemaStatus: "EXPECTED",
    rawResponseSha256: value.rawResponseSha256,
  };
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new Error(`${label} must be a positive integer`);
  return number;
}

function korailDirectionCode(value, trainNumber) {
  if (value !== "U" && value !== "D") {
    throw new Error(`Korail ITX direction code must be U or D: ${safeToken(trainNumber)}`);
  }
  return value;
}

function decodedServiceKey(value) {
  if (!/%[0-9a-f]{2}/i.test(value)) return value;
  try { return decodeURIComponent(value); } catch { return value; }
}

function normalize(value) { return String(value ?? "").toLocaleLowerCase("ko-KR").replace(/[^\p{L}\p{N}]+/gu, ""); }
function normalizeTrainNumber(value) {
  const match = /^(?:ITX-)?(\d+)$/.exec(String(value ?? ""));
  const digits = match?.[1].replace(/^0+/, "") ?? "";
  if (digits === "") throw new Error("invalid train number");
  return digits;
}
function normalizeStationName(value) { return String(value ?? "").replace(/\([^)]*\)/g, "").replace(/[^\p{L}\p{N}]+/gu, "").toLocaleLowerCase("ko-KR"); }
function requiredString(value, label) { if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} is required`); return value; }
function safeToken(value) { const text = String(value ?? "UNKNOWN"); return /^[A-Za-z0-9._/+:-]{1,64}$/.test(text) ? text : "UNKNOWN"; }
function safeLabel(value) { const text = String(value ?? "UNKNOWN"); return /^[\p{L}\p{N} ._()+/-]{1,64}$/u.test(text) ? text : "UNKNOWN"; }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function canonicalJsonBytes(value) { return Buffer.from(`${JSON.stringify(value, null, 2)}\n`); }
function naturalCompare(left, right) { return String(left).localeCompare(String(right), "ko", { numeric: true }); }
function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]?.replace(/^--/, "");
    if (!key) continue;
    if (argv[index + 1]?.startsWith("--") || argv[index + 1] === undefined) result[key] = true;
    else result[key] = argv[index += 1];
  }
  return result;
}

export async function runKorailItxCompletenessCli({
  argv = process.argv.slice(2),
  env = process.env,
  now = new Date(),
  collectImpl = collectKorailItxCheongchunCompleteness,
  promoteImpl = promoteItxSourceCandidate,
  repositoryRoot = repoRoot,
} = {}) {
  const args = parseArgs(argv);
  if (args["promote-candidate"]) {
    const coverageContractPath = validateCoverageContractPath(
      args["coverage-contract"],
      repositoryRoot,
    );
    const promotion = await promoteImpl({
      candidatePath: requiredString(args["promote-candidate"], "--promote-candidate"),
      completenessPath: requiredString(args["completeness-evidence"], "--completeness-evidence"),
      approvedSha256: args["approved-sha256"],
      approvalUrl: args["approval-url"],
      sourceOutputDir: requiredString(args["source-output-dir"], "--source-output-dir"),
      coverageContractPath,
      now,
      githubToken: env.GITHUB_TOKEN,
      repositoryRoot,
    });
    return { promotion, exitCode: 0 };
  }
  const output = requiredString(args.output, "--output");
  if (!path.isAbsolute(output)) throw new Error("--output must be absolute");
  const completenessOutputArg = args["completeness-output"];
  if (typeof completenessOutputArg === "string"
    && path.resolve(completenessOutputArg) === path.resolve(output)) {
    throw new Error("candidate and completeness output paths must differ");
  }
  const packPath = requiredString(args["canonical-pack"], "--canonical-pack");
  const serviceKey = requiredString(env.DATA_GO_KR_SERVICE_KEY, "DATA_GO_KR_SERVICE_KEY");
  const replay = args.replay === true;
  if (Object.hasOwn(args, "previous-admitted")) throw new Error("--previous-admitted is not supported");
  const contractPath = validateCoverageContractPath(
    args["coverage-contract"]
      ?? path.join(repositoryRoot, "tools/datapack/itx-cheongchun-coverage-contract.json"),
    repositoryRoot,
  );
  const previousAdmittedArtifact = await loadPromotedSourceArtifact(contractPath, repositoryRoot);
  const serviceDates = {
    "8": args["day8-date"],
    "7": args["day7-date"],
    "9": args["day9-date"],
  };
  validateItxServiceDates(serviceDates, { now, replay });
  let artifact;
  try {
    artifact = await collectImpl({
      serviceKey, serviceDates, packPath, now, replay, previousAdmittedArtifact,
    });
  } catch (error) {
    artifact = {
      schemaVersion: 2,
      artifactKind: "korail-itx-cheongchun-completeness-evidence",
      serviceId: "ITX_CHEONGCHUN",
      observedAt: now.toISOString(),
      timezone: "Asia/Seoul",
      validationMode: replay ? "REPLAY" : "ADMISSION",
      selectedServiceDates: serviceDates,
      validationStatus: "MISSING",
      admissionStatus: "MISSING",
      admissionEligible: false,
      failureReasonCode: completenessFailureReason(error),
      allowedConsumerIssues: ["#2145", "#1400", "#2098", "#2099", "#2058", "#2137"],
      legacyDaejeonRowCount: 0,
      legacyYongsanDaejeonTripCount: 0,
      serviceDays: [],
      materialization: { status: "MISSING" },
      credentialRedacted: true,
    };
    artifact.evidenceHash = sha256(JSON.stringify(artifact));
  }
  const candidate = artifact.validationStatus === "SUPPORTED" && !replay
    ? await buildItxSourceCandidate({ completeness: artifact, packPath, now, repositoryRoot })
    : null;
  let completenessEvidenceSha256 = null;
  if (candidate) {
    const completenessOutput = requiredString(completenessOutputArg, "--completeness-output");
    if (!path.isAbsolute(completenessOutput)) throw new Error("--completeness-output must be absolute");
    const completenessBytes = canonicalJsonBytes(artifact);
    completenessEvidenceSha256 = sha256(completenessBytes);
    if (completenessEvidenceSha256 !== candidate.completenessEvidenceSha256) {
      throw new Error("SOURCE_COMPLETENESS_EVIDENCE_MISMATCH");
    }
    await writeFile(completenessOutput, completenessBytes, { flag: "wx", mode: 0o600 });
  }
  const outputValue = candidate ?? artifact;
  const outputBytes = canonicalJsonBytes(outputValue);
  await writeFile(output, outputBytes, { flag: "wx", mode: 0o600 });
  return {
    artifact,
    candidate,
    outputSha256: sha256(outputBytes),
    completenessEvidenceSha256,
    exitCode: artifact.validationStatus === "SUPPORTED" ? 0 : 1,
  };
}

async function loadPromotedSourceArtifact(contractPath, repositoryRoot = repoRoot) {
  let contract;
  try {
    contract = JSON.parse(await readFile(contractPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  return loadAdmittedSourceReference(validateCoverageContractAuthority(contract), repositoryRoot);
}

async function main() {
  const result = await runKorailItxCompletenessCli();
  if (result.promotion) {
    console.log(
      `sanitized ITX source promotion ready: status=ADMITTED, artifactPath=${result.promotion.artifactPath},` +
      ` sha256=${result.promotion.candidateSha256}`,
    );
    process.exitCode = result.exitCode;
    return;
  }
  const { artifact, candidate, outputSha256, exitCode } = result;
  const totalExpectedOdCount = artifact.serviceDays.reduce((total, day) => total + (day.expectedOdCount ?? 0), 0);
  const totalCompletedOdCount = artifact.serviceDays.reduce((total, day) => total + (day.completedOdCount ?? 0), 0);
  const totalFailedOdCount = artifact.serviceDays.reduce((total, day) => total + (day.failedOdCount ?? 0), 0);
  const failureCodes = artifact.serviceDays
    .filter(({ status }) => status !== "SUPPORTED")
    .map(({ dayCd, failureStage, failureReasonCode, failureContext }) => (
      `${dayCd}:${failureStage}:${failureReasonCode}${failureContext ? `(${failureContext})` : ""}`
    ))
    .join(",");
  console.log(
    `sanitized Korail ITX-청춘 completeness evidence ready: status=${artifact.admissionStatus},` +
    ` serviceDays=${artifact.serviceDays.length}, expectedOd=${totalExpectedOdCount},` +
    ` completedOd=${totalCompletedOdCount}, failedOd=${totalFailedOdCount},` +
    ` failures=${failureCodes}, observedAt=${artifact.observedAt}, evidenceHash=${artifact.evidenceHash},` +
    ` candidateStatus=${candidate?.promotionStatus ?? "NONE"}, candidateSha256=${candidate ? outputSha256 : "NONE"}`,
  );
  process.exitCode = exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Korail ITX-청춘 collector failed");
    process.exitCode = 1;
  });
}
