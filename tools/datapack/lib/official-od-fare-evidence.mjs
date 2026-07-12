import { createHash } from "node:crypto";
import { requiredArray, requiredString } from "./ledger-admission-cli.mjs";

const REQUIRED_FARE_FIELDS = [
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
  "providerMappings",
  "quotes",
  "schemaVersion",
];
const MAPPING_KEYS = ["fareStationCode", "lineId", "stationId", "stationName"];
const FIXED_TARGETS = [
  "station-sadang\u0000seoul-4\u0000사당",
  "station-sangnoksu\u0000seoul-4\u0000상록수",
];

export function validateOfficialOdFareEvidence(evidence) {
  assertObject(evidence, "evidence");
  assertExactKeys(evidence, EVIDENCE_KEYS, "evidence");
  if (evidence.schemaVersion !== 1
    || evidence.artifactKind !== "official-od-fare-probe-evidence"
    || evidence.mappingAvailability !== "AVAILABLE"
    || evidence.mappingField !== "dptreStnCd/arvlStnCd") {
    throw new Error("evidence must be available official OD fare probe evidence");
  }
  if (JSON.stringify(evidence.fieldNames) !== JSON.stringify(REQUIRED_FARE_FIELDS)) {
    throw new Error("evidence.fieldNames must contain the six official fare fields");
  }

  const mappings = requiredArray(evidence.providerMappings, "evidence.providerMappings");
  if (mappings.length !== 2) throw new Error("evidence.providerMappings must contain exactly two rows");
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
    if (lineId !== "seoul-4") throw new Error("provider mapping lineId must be seoul-4");
    if (!/^\d{4}$/.test(providerCode)) throw new Error("provider station code must be four digits");
    const stationLineKey = `${stationId}\u0000${lineId}`;
    if (stationLineKeys.has(stationLineKey)) throw new Error("duplicate station and line mapping");
    if (providerCodes.has(providerCode)) throw new Error("duplicate provider station code");
    stationIds.add(stationId);
    stationLineKeys.add(stationLineKey);
    providerCodes.add(providerCode);
    targets.push(`${stationId}\u0000${lineId}\u0000${stationName}`);
  }
  const sortedTargets = targets.toSorted((left, right) => left.localeCompare(right));
  if (JSON.stringify(sortedTargets) !== JSON.stringify(FIXED_TARGETS)) {
    throw new Error("evidence.providerMappings must match fixed targets");
  }

  validateEquivalence(evidence.equivalence);
  const expectedDirections = new Set();
  for (const origin of stationIds) {
    for (const destination of stationIds) {
      if (origin !== destination) expectedDirections.add(`${origin}\u0000${destination}`);
    }
  }
  const quotes = requiredArray(evidence.quotes, "evidence.quotes");
  if (quotes.length !== 2) throw new Error("evidence.quotes must contain exactly two rows");
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
  validateAttemptCounts(evidence.attemptCounts, stationIds);
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

function validateEquivalence(equivalence) {
  assertObject(equivalence, "evidence.equivalence");
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

function validateAttemptCounts(attemptCounts, stationIds) {
  assertObject(attemptCounts, "evidence.attemptCounts");
  const [left, right] = stationIds;
  const directions = [`${left}→${right}`, `${right}→${left}`];
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
