import { createHash } from "node:crypto";
import { requiredArray, requiredString } from "./ledger-admission-cli.mjs";

export const REQUIRED_FARE_FIELDS = [
  "childCardFare",
  "childCashFare",
  "gnrlCardFare",
  "gnrlCashFare",
  "yungCardFare",
  "yungCashFare",
];
const EVIDENCE_KEYS = [
  "artifactKind",
  "attemptCounts",
  "equivalence",
  "fieldNames",
  "mappingAvailability",
  "mappingField",
  "providerId",
  "providerMappings",
  "quotes",
  "schemaVersion",
];
const MAPPING_KEYS = ["fareStationCode", "lineId", "stationId", "stationName"];
const CAPITAL_COMBINED_TARGETS = [
  "station-2af75c3d707b\u0000seoul-4\u0000서울역",
  "station-a2d54a5d63d2\u0000line-472a81add377\u0000시청",
  "station-sadang\u0000seoul-4\u0000사당",
  "station-sangnoksu\u0000seoul-4\u0000상록수",
];
const CAPITAL_DIRECTIONS = [
  "station-2af75c3d707b\u0000station-a2d54a5d63d2",
  "station-sadang\u0000station-sangnoksu",
  "station-sangnoksu\u0000station-sadang",
];
const CAPITAL_EXACT_TARGETS = [
  "station-sadang\u0000seoul-4\u0000사당",
  "station-sangnoksu\u0000seoul-4\u0000상록수",
];
const CAPITAL_EXACT_DIRECTIONS = [
  "station-sadang\u0000station-sangnoksu",
  "station-sangnoksu\u0000station-sadang",
];
const CAPITAL_CANARY_TARGETS = [
  "station-2af75c3d707b\u0000seoul-4\u0000서울역",
  "station-a2d54a5d63d2\u0000line-472a81add377\u0000시청",
];
const CAPITAL_CANARY_DIRECTIONS = [
  "station-2af75c3d707b\u0000station-a2d54a5d63d2",
];
const BUSAN_FIXED_TARGETS = [
  "station-1fc7a7c971c8\u0000line-ab1a041f6266\u0000서면",
  "station-6b611916f76a\u0000line-eb7b47920390\u0000장산",
  "station-dd45c69d3e40\u0000line-ab1a041f6266\u0000당리",
  "station-fcb7a21e5606\u0000line-ab1a041f6266\u0000하단",
];
const BUSAN_DIRECTIONS = [
  "station-1fc7a7c971c8\u0000station-6b611916f76a",
  "station-fcb7a21e5606\u0000station-6b611916f76a",
  "station-fcb7a21e5606\u0000station-dd45c69d3e40",
];
const EVIDENCE_PROFILES = [
  {
    mappingField: "dptreStnCd/arvlStnCd",
    providerId: "data-go-kr-b553766-fare2",
    providerCode: /^\d{4}$/,
    targets: CAPITAL_COMBINED_TARGETS,
    directions: CAPITAL_DIRECTIONS,
    attemptKeys: CAPITAL_DIRECTIONS.map((direction) => direction.replace("\u0000", "→")),
  },
  {
    mappingField: "dptreStnCd/arvlStnCd",
    providerId: "data-go-kr-b553766-fare2",
    providerCode: /^\d{4}$/,
    targets: CAPITAL_EXACT_TARGETS,
    directions: CAPITAL_EXACT_DIRECTIONS,
    attemptKeys: CAPITAL_EXACT_DIRECTIONS.map((direction) => direction.replace("\u0000", "→")),
  },
  {
    mappingField: "dptreStnCd/arvlStnCd",
    providerId: "data-go-kr-b553766-fare2",
    providerCode: /^\d{4}$/,
    targets: CAPITAL_CANARY_TARGETS,
    directions: CAPITAL_CANARY_DIRECTIONS,
    attemptKeys: CAPITAL_CANARY_DIRECTIONS.map((direction) => direction.replace("\u0000", "→")),
  },
  {
    mappingField: "mo_scode_s/mo_scode_e",
    providerId: "busan-transportation-cyberstation",
    providerCode: /^\d{3}$/,
    targets: BUSAN_FIXED_TARGETS,
    directions: BUSAN_DIRECTIONS,
    attemptKeys: [
      ...BUSAN_DIRECTIONS.map((direction) => direction.replace("\u0000", "→")),
      "officialFareTable",
    ],
  },
];
const ADMISSION_KEYS = [
  "approvedAt",
  "approvedBy",
  "artifactKind",
  "decision",
  "evidenceHash",
  "fareStationLineMappingLedgerHash",
  "quoteCount",
  "quoteSetHash",
  "schemaVersion",
  "snapshotId",
  "sourceId",
];

export function officialOdFareAdmissionsBySource(bundle) {
  assertObject(bundle, "official OD fare admission bundle");
  assertExactKeys(
    bundle,
    ["admissions", "artifactKind", "schemaVersion"],
    "official OD fare admission bundle",
  );
  if (bundle.schemaVersion !== 1 || bundle.artifactKind !== "official-od-fare-admission-bundle") {
    throw new Error("official OD fare admission bundle identity is invalid");
  }
  const admissions = new Map();
  for (const admission of requiredArray(bundle.admissions, "official OD fare admission bundle.admissions")) {
    validateAdmission(admission);
    const sourceId = requiredString(admission.sourceId, "official OD fare admission.sourceId");
    if (admissions.has(sourceId)) throw new Error(`duplicate official OD fare admission sourceId: ${sourceId}`);
    admissions.set(sourceId, admission);
  }
  if (admissions.size === 0) throw new Error("official OD fare admission bundle.admissions must not be empty");
  return admissions;
}

function validateAdmission(admission) {
  assertObject(admission, "official OD fare admission");
  assertExactKeys(admission, ADMISSION_KEYS, "official OD fare admission");
  if (admission.schemaVersion !== 1) throw new Error("official OD fare admission schemaVersion must be 1");
  if (admission.artifactKind !== "official-od-fare-admission") {
    throw new Error("official OD fare admission artifactKind must be official-od-fare-admission");
  }
  if (admission.decision !== "APPROVED") throw new Error('admission decision must be "APPROVED"');
  requiredString(admission.snapshotId, "official OD fare admission.snapshotId");
  requiredString(admission.approvedBy, "official OD fare admission.approvedBy");
  requiredString(admission.approvedAt, "official OD fare admission.approvedAt");
  for (const field of ["evidenceHash", "quoteSetHash", "fareStationLineMappingLedgerHash"]) {
    if (typeof admission[field] !== "string" || !/^[0-9a-f]{64}$/.test(admission[field])) {
      throw new Error(`official OD fare admission.${field} must be a sha256 hex string`);
    }
  }
  if (!Number.isSafeInteger(admission.quoteCount) || admission.quoteCount < 1) {
    throw new Error("official OD fare admission.quoteCount must be a positive safe integer");
  }
}

export function validateOfficialOdFareEvidence(evidence) {
  assertObject(evidence, "evidence");
  assertExactKeys(evidence, EVIDENCE_KEYS, "evidence");
  if (evidence.schemaVersion !== 1
    || evidence.artifactKind !== "official-od-fare-probe-evidence"
    || evidence.mappingAvailability !== "AVAILABLE") {
    throw new Error("evidence must be available official OD fare probe evidence");
  }
  const mappingField = requiredString(evidence.mappingField, "evidence.mappingField");
  const providerId = requiredString(evidence.providerId, "evidence.providerId");
  if (JSON.stringify(evidence.fieldNames) !== JSON.stringify(REQUIRED_FARE_FIELDS)) {
    throw new Error("evidence.fieldNames must contain the six official fare fields");
  }

  const mappings = requiredArray(evidence.providerMappings, "evidence.providerMappings");
  const stationIds = new Set();
  const stationLineKeys = new Set();
  const providerCodes = new Set();
  const targets = [];
  for (const mapping of mappings) {
    assertObject(mapping, "evidence.providerMappings[]");
    assertExactKeys(mapping, MAPPING_KEYS, "evidence.providerMappings[]");
    const stationId = requiredString(mapping.stationId, "providerMappings.stationId");
    const lineId = requiredString(mapping.lineId, "providerMappings.lineId");
    const stationName = requiredString(mapping.stationName, "providerMappings.stationName");
    const providerCode = requiredString(mapping.fareStationCode, "providerMappings.fareStationCode");
    const stationLineKey = `${stationId}\u0000${lineId}`;
    if (stationLineKeys.has(stationLineKey)) throw new Error("duplicate station and line mapping");
    if (providerCodes.has(providerCode)) throw new Error("duplicate provider station code");
    stationIds.add(stationId);
    stationLineKeys.add(stationLineKey);
    providerCodes.add(providerCode);
    targets.push(`${stationId}\u0000${lineId}\u0000${stationName}`);
  }
  const sortedTargets = targets.toSorted((left, right) => left.localeCompare(right));
  const profile = EVIDENCE_PROFILES.find((candidate) =>
    candidate.mappingField === mappingField
      && candidate.providerId === providerId
      && JSON.stringify(candidate.targets) === JSON.stringify(sortedTargets));
  if (!profile) {
    throw new Error("evidence.providerMappings must match fixed targets");
  }
  if ([...providerCodes].some((providerCode) => !profile.providerCode.test(providerCode))) {
    throw new Error("provider station code format is invalid");
  }

  validateEquivalence(evidence.equivalence, evidence.mappingField);
  const expectedDirections = new Set(profile.directions);
  const quotes = requiredArray(evidence.quotes, "evidence.quotes");
  if (quotes.length !== profile.directions.length) {
    throw new Error(`evidence.quotes must contain exactly ${profile.directions.length} rows`);
  }
  for (const quote of quotes) {
    assertObject(quote, "evidence.quotes[]");
    assertExactKeys(quote, ["destinationStationId", "fares", "originStationId"], "evidence.quotes[]");
    const direction = `${requiredString(quote.originStationId, "quote.originStationId")}\u0000${requiredString(quote.destinationStationId, "quote.destinationStationId")}`;
    if (!expectedDirections.delete(direction)) throw new Error("quote endpoints must match provider mappings");
    assertObject(quote.fares, "quote.fares");
    assertExactKeys(quote.fares, REQUIRED_FARE_FIELDS, "quote.fares");
    for (const field of REQUIRED_FARE_FIELDS) {
      if (!Number.isSafeInteger(quote.fares[field]) || quote.fares[field] < 0) {
        throw new Error(`quote.fares.${field} must be a non-negative safe integer`);
      }
    }
  }
  if (expectedDirections.size !== 0) throw new Error("quote endpoints must match provider mappings");
  validateAttemptCounts(evidence.attemptCounts, profile.attemptKeys);
  return { mappings, quotes };
}

export function officialOdFareQuoteSetHash(quotes) {
  const normalized = requiredArray(quotes, "official OD fare quote set").map((quote) => {
    assertObject(quote, "official OD fare quote set[]");
    const row = {
      originStationId: requiredString(quote.originStationId, "quoteSet.originStationId"),
      destinationStationId: requiredString(quote.destinationStationId, "quoteSet.destinationStationId"),
    };
    for (const field of REQUIRED_FARE_FIELDS) {
      if (!Number.isSafeInteger(quote[field]) || quote[field] < 0) {
        throw new Error(`quoteSet.${field} must be a non-negative safe integer`);
      }
      row[field] = quote[field];
    }
    return row;
  }).sort((left, right) =>
    left.originStationId.localeCompare(right.originStationId)
      || left.destinationStationId.localeCompare(right.destinationStationId));
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

function validateEquivalence(equivalence, mappingField) {
  assertObject(equivalence, "evidence.equivalence");
  if (mappingField === "mo_scode_s/mo_scode_e") {
    assertExactKeys(equivalence, ["routeForm"], "evidence.equivalence");
    const routeForm = equivalence.routeForm;
    assertObject(routeForm, "evidence.equivalence.routeForm");
    assertExactKeys(routeForm, ["cyberKinds", "destinationField", "originField", "verified"], "evidence.equivalence.routeForm");
    if (routeForm.cyberKinds !== "1" || routeForm.originField !== "mo_scode_s"
      || routeForm.destinationField !== "mo_scode_e" || routeForm.verified !== true) {
      throw new Error("evidence.equivalence.routeForm must match the verified official route form");
    }
    return;
  }
  assertExactKeys(equivalence, ["cityHallLine1", "seoulStationLine4"], "evidence.equivalence");
  for (const [key, expectedCode] of [["cityHallLine1", "0151"], ["seoulStationLine4", "0150"]]) {
    const entry = equivalence[key];
    assertObject(entry, `evidence.equivalence.${key}`);
    assertExactKeys(entry, ["fareCode", "fareResponseStationCode", "verified"], `evidence.equivalence.${key}`);
    if (entry.fareCode !== expectedCode || entry.fareResponseStationCode !== expectedCode || entry.verified !== true) {
      throw new Error(`evidence.equivalence.${key} must match the verified canary`);
    }
  }
}

function validateAttemptCounts(attemptCounts, directions) {
  assertObject(attemptCounts, "evidence.attemptCounts");
  assertExactKeys(attemptCounts, directions, "evidence.attemptCounts");
  for (const direction of directions) {
    if (!Number.isInteger(attemptCounts[direction]) || attemptCounts[direction] < 1 || attemptCounts[direction] > 2) {
      throw new Error(`evidence.attemptCounts.${direction} must be between 1 and 2`);
    }
  }
}

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
}

function assertExactKeys(value, allowedKeys, label) {
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${key} is not allowed in ${label}`);
  }
  for (const key of allowed) {
    if (!(key in value)) throw new Error(`${label}.${key} is required`);
  }
}
