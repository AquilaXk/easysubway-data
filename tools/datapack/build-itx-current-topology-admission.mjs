#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "../..");
const SHA256 = /^[a-f0-9]{64}$/u;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function requiredSha256(value, label) {
  if (!SHA256.test(value ?? "")) throw new Error(`${label} must be sha256`);
  return value;
}

function requiredUtcInstant(value, label) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must be a timestamp`);
  }
  return value;
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function pairTuples(stationSequences, label) {
  if (!Array.isArray(stationSequences) || stationSequences.length !== 2) {
    throw new Error(`${label} must contain exactly one up and one down station sequence`);
  }
  const directions = [...new Set(stationSequences.map(({ directionId }) => directionId))].sort(compareStrings);
  if (!same(directions, ["down", "up"])) {
    throw new Error(`${label} must contain exact up/down directions`);
  }
  const tuples = [];
  for (const sequence of stationSequences) {
    if (!Array.isArray(sequence.stops) || sequence.stops.length < 2) {
      throw new Error(`${label}.${sequence.directionId} stops are incomplete`);
    }
    const stationIds = sequence.stops.map(({ stationId }) => stationId);
    if (stationIds.some((stationId) => typeof stationId !== "string" || stationId.length === 0)
      || new Set(stationIds).size !== stationIds.length) {
      throw new Error(`${label}.${sequence.directionId} station identity is invalid`);
    }
    for (let index = 0; index < stationIds.length - 1; index += 1) {
      tuples.push([stationIds[index], stationIds[index + 1], "ITX_CHEONGCHUN"]);
    }
  }
  return [...new Map(tuples.map((tuple) => [JSON.stringify(tuple), tuple])).values()]
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right), "en"));
}

function canonicalStationSet(stationSequences, label) {
  const stationIds = new Set();
  for (const sequence of stationSequences ?? []) {
    for (const stop of sequence.stops ?? []) {
      if (typeof stop?.stationId !== "string" || stop.stationId.length === 0) {
        throw new Error(`${label} station identity is invalid`);
      }
      stationIds.add(stop.stationId);
    }
  }
  if (stationIds.size === 0) throw new Error(`${label} station set is empty`);
  return [...stationIds].sort(compareStrings);
}

function nextDayMidnightKst(serviceDate) {
  if (!/^\d{8}$/u.test(serviceDate ?? "")) throw new Error("weekday serviceDate must be YYYYMMDD");
  const date = new Date(Date.UTC(
    Number(serviceDate.slice(0, 4)),
    Number(serviceDate.slice(4, 6)) - 1,
    Number(serviceDate.slice(6, 8)),
  ));
  const actual = `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}${String(date.getUTCDate()).padStart(2, "0")}`;
  if (actual !== serviceDate) throw new Error("weekday serviceDate is invalid");
  date.setUTCDate(date.getUTCDate() + 1);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}T00:00:00+09:00`;
}

function validateOperations(operations) {
  if (!Array.isArray(operations) || operations.length === 0) {
    throw new Error("weekday operation evidence is missing");
  }
  for (const operation of operations) {
    if (typeof operation?.operation !== "string" || operation.operation.length === 0
      || operation.providerResultCode !== "00"
      || operation.schemaStatus !== "EXPECTED"
      || !Number.isInteger(operation.requestCount) || operation.requestCount <= 0
      || !Number.isInteger(operation.pageCount) || operation.pageCount <= 0
      || !Number.isInteger(operation.totalCount) || operation.totalCount < 0
      || !SHA256.test(operation.rawResponseSha256 ?? "")) {
      throw new Error("weekday operation evidence is invalid");
    }
  }
}

function validateReconstruction(summary) {
  if (summary?.conflictingTimestampCount !== 0
    || summary.missingPairCount !== 0
    || summary.duplicateOdCount !== 0) {
    throw new Error("weekday reconstruction evidence is not exact");
  }
}

export function buildItxCurrentTopologyAdmission({
  collection,
  collectionSha256,
  previousSource,
  previousSha256,
}) {
  requiredSha256(collectionSha256, "collectionSha256");
  requiredSha256(previousSha256, "previousSha256");
  if (collection?.schemaVersion !== 2
    || collection.artifactKind !== "korail-itx-cheongchun-completeness-evidence"
    || collection.serviceId !== "ITX_CHEONGCHUN"
    || collection.validationStatus !== "MISSING"
    || collection.admissionStatus !== "MISSING"
    || collection.credentialRedacted !== true) {
    throw new Error("current ITX collection identity is invalid");
  }
  const observedAt = requiredUtcInstant(collection.observedAt, "collection.observedAt");
  const weekday = collection.serviceDays?.find(({ dayCd }) => dayCd === "8");
  const failedDays = (collection.serviceDays ?? []).filter(({ dayCd }) => ["7", "9"].includes(dayCd));
  if (collection.serviceDays?.length !== 3
    || weekday?.status !== "SUPPORTED"
    || weekday.serviceDate !== collection.selectedServiceDates?.["8"]
    || weekday.expectedOdCount !== 306
    || weekday.completedOdCount !== 306
    || weekday.failedOdCount !== 0
    || failedDays.length !== 2
    || failedDays.some(({ status, failureStage, failureReasonCode }) => status !== "MISSING"
      || failureStage !== "OD_MATERIALIZATION" || failureReasonCode !== "OD_MATRIX_INCOMPLETE")) {
    throw new Error("current ITX topology-only service-day boundary is invalid");
  }
  const roster = weekday.roster;
  if (roster?.schemaVersion !== 2
    || roster.artifactKind !== "tago-itx-cheongchun-roster-evidence"
    || roster.serviceDate !== weekday.serviceDate
    || roster.kricServiceDayCode !== "8"
    || roster.expectedOdCount !== 306
    || roster.completedOdCount !== 306
    || roster.failedOdCount !== 0) {
    throw new Error("current weekday roster identity is invalid");
  }
  requiredSha256(weekday.stationSetHash, "weekday.stationSetHash");
  requiredSha256(weekday.odMatrixHash, "weekday.odMatrixHash");
  validateReconstruction(weekday.reconstructionSummary);
  validateReconstruction(roster.reconstructionSummary);
  validateOperations(roster.operations);

  if (previousSource?.schemaVersion !== 1
    || previousSource.artifactKind !== "itx-cheongchun-source-timetable"
    || previousSource.serviceId !== "ITX_CHEONGCHUN"
    || previousSource.validationStatus !== "SUPPORTED") {
    throw new Error("previous admitted ITX source identity is invalid");
  }
  const currentPairs = pairTuples(roster.stationSequences, "current weekday");
  const previousPairs = pairTuples(previousSource.stationSequences, "previous admitted source");
  const currentStations = canonicalStationSet(roster.stationSequences, "current weekday");
  const previousStations = canonicalStationSet(previousSource.stationSequences, "previous admitted source");
  if (!same(currentStations, previousStations)) {
    throw new Error("current ITX canonical station set mismatch");
  }
  const currentKeys = new Set(currentPairs.map((tuple) => JSON.stringify(tuple)));
  const previousKeys = new Set(previousPairs.map((tuple) => JSON.stringify(tuple)));
  const added = [...currentKeys].filter((key) => !previousKeys.has(key));
  const removed = [...previousKeys].filter((key) => !currentKeys.has(key));
  const freshUntil = nextDayMidnightKst(weekday.serviceDate);
  if (Date.parse(freshUntil) <= Date.parse(observedAt)) {
    throw new Error("current ITX topology admission is already stale");
  }
  const artifactId = `itx-current-network-edge-admission-${weekday.serviceDate}`;
  const artifact = {
    schemaVersion: 1,
    artifactKind: "itx-current-network-edge-admission",
    artifactId,
    serviceId: "ITX_CHEONGCHUN",
    sourceIssue: 2776,
    status: "ADMITTED",
    scheduleAdmissionStatus: "MISSING",
    topologyMode: "UNCHANGED_AUTO_STATION_SET",
    serviceDate: weekday.serviceDate,
    observedAt,
    freshUntil,
    collectionSha256,
    previousArtifactSha256: previousSha256,
    stationSetHash: weekday.stationSetHash,
    odMatrixHash: weekday.odMatrixHash,
    operationEvidenceSha256: sha256(Buffer.from(JSON.stringify(roster.operations))),
    stationSequenceSha256: sha256(Buffer.from(JSON.stringify(roster.stationSequences))),
    canonicalStationSetSha256: sha256(Buffer.from(JSON.stringify(currentStations))),
    observedPairSetSha256: sha256(Buffer.from(JSON.stringify(currentPairs))),
    admittedPairSetSha256: sha256(Buffer.from(JSON.stringify(previousPairs))),
    observedPairChange: {
      addedCount: added.length,
      removedCount: removed.length,
      addedSha256: sha256(Buffer.from(JSON.stringify(added))),
      removedSha256: sha256(Buffer.from(JSON.stringify(removed))),
    },
    pairHashes: previousPairs.map((tuple) => sha256(Buffer.from(JSON.stringify(tuple)))),
    reconstructionSummary: structuredClone(roster.reconstructionSummary),
    credentialRedacted: true,
  };
  artifact.evidenceHash = sha256(Buffer.from(JSON.stringify(artifact)));
  return artifact;
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!["--collection", "--coverage-contract", "--output"].includes(key) || !argv[index + 1]) {
      throw new Error(`invalid argument: ${key}`);
    }
    result[key.slice(2).replaceAll("-", "_")] = argv[index + 1];
    index += 1;
  }
  for (const key of ["collection", "coverage_contract", "output"]) {
    if (!result[key]) throw new Error(`--${key.replaceAll("_", "-")} is required`);
  }
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const collectionBytes = await readFile(path.resolve(args.collection));
  const collection = JSON.parse(collectionBytes);
  const contract = JSON.parse(await readFile(path.resolve(root, args.coverage_contract), "utf8"));
  const reference = contract.sourceTimetableArtifact;
  const previousPath = path.resolve(root, reference?.artifactPath ?? "");
  if (!previousPath.startsWith(`${root}${path.sep}`)) throw new Error("previous artifact path escapes repository root");
  const previousBytes = await readFile(previousPath);
  if (sha256(previousBytes) !== reference?.sha256) throw new Error("previous admitted source bytes mismatch");
  const artifact = buildItxCurrentTopologyAdmission({
    collection,
    collectionSha256: sha256(collectionBytes),
    previousSource: JSON.parse(previousBytes),
    previousSha256: reference.sha256,
  });
  await writeFile(path.resolve(args.output), `${JSON.stringify(artifact, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  console.log(`current ITX topology admission ready: ${artifact.artifactId} ${artifact.evidenceHash}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
