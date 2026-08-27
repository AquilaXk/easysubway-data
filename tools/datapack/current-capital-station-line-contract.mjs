const compareBytes = (left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right));
const CANDIDATE_KEYS = [
  "candidateId", "mappingContractVersion", "materializerVersion", "sourceSetSha256", "stationSetSha256",
];

export function canonicalCurrentCapitalStationLineInputJson(value) {
  assertKeys(
    value,
    ["candidate", "stationLines", "evidenceRows"],
    "full-capital station-line output",
  );
  assertKeys(value.candidate, CANDIDATE_KEYS, "full-capital station-line candidate");
  if (!Array.isArray(value.stationLines) || !Array.isArray(value.evidenceRows)) {
    throw new Error("full-capital station-line arrays are required");
  }
  return canonicalJson(value);
}

function assertKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || canonicalJson(Object.keys(value).sort(compareBytes))
      !== canonicalJson([...keys].sort(compareBytes))) {
    throw new Error(`${label} keys mismatch`);
  }
}

function canonicalJson(value) {
  return JSON.stringify(canonicalObject(value));
}

function canonicalObject(value) {
  if (Array.isArray(value)) return value.map(canonicalObject);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort(compareBytes)
    .map((key) => [key, canonicalObject(value[key])]));
}
