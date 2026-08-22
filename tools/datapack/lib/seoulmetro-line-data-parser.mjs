import { createHash } from "node:crypto";

const MAX_BYTES = 1_000_000;
const MAX_NESTING = 64;
const MAX_NODES = 100_000;
const MAX_LINES = 50_000;
const MAX_STRING = 16_384;
const SHA256 = /^[0-9a-f]{64}$/u;

/** Parse the provider's data literal without evaluating provider JavaScript. */
export function parseSeoulMetroLineData(source) {
  if (typeof source !== "string" || Buffer.byteLength(source, "utf8") > MAX_BYTES) {
    throw new Error("SeoulMetro line data size is invalid");
  }
  const prefix = /^\s*var\s+lines\s*=\s*/u.exec(source);
  if (!prefix) {
    throw new Error("SeoulMetro line data must be one data declaration");
  }
  let body = source.slice(prefix[0].length).trim();
  if (body.endsWith(";")) body = body.slice(0, -1).trimEnd();
  const literal = normalizeTrailingCommas(body);
  let value;
  try { value = JSON.parse(literal); } catch { throw new Error("SeoulMetro line data is not JSON-like data"); }
  validateTree(value);
  if (value == null || Array.isArray(value) || typeof value !== "object") {
    throw new Error("SeoulMetro line data root is invalid");
  }
  return value;
}

export function projectSeoulMetroConsumedFields(source) {
  const lines = parseSeoulMetroLineData(source);
  const projection = [];
  for (const [lineKey, line] of Object.entries(lines)) {
    const attr = requiredObject(line?.attr, "line attributes");
    const stations = Array.isArray(line?.stations) ? line.stations : fail("stations");
    projection.push({
      lineKey: requiredString(lineKey, "line key"),
      label: requiredString(attr["data-label"], "line label"),
      color: requiredString(attr["data-color"], "line color"),
      stations: stations.map((station, index) => projectStation(station, index)),
    });
  }
  return projection;
}

export function buildLegacySampleToFullConsumedFieldsMigration({ legacyHead, baselineRawBytes, freshRawBytes, snapshotId }) {
  if (!legacyHead || legacyHead.sourceId !== "seoulmetro-cyberstation-route-map"
    || !SHA256.test(legacyHead.rawSha256 ?? "") || !SHA256.test(legacyHead.schemaFingerprint ?? "")
    || !Array.isArray(legacyHead.providerRecordHashes) || legacyHead.providerRecordHashes.length !== 5
    || legacyHead.providerRecordHashes.some((hash) => !SHA256.test(hash ?? ""))
    || typeof legacyHead.snapshotId !== "string" || legacyHead.snapshotId === "") {
    throw new Error("SeoulMetro legacy route-map identity is invalid");
  }
  if (!Buffer.isBuffer(baselineRawBytes) || !Buffer.isBuffer(freshRawBytes)
    || typeof snapshotId !== "string" || snapshotId === "") {
    throw new Error("SeoulMetro route-map migration arguments are invalid");
  }
  const baseline = Buffer.from(`${JSON.stringify(projectSeoulMetroConsumedFields(baselineRawBytes.toString("utf8")))}\n`);
  const fresh = Buffer.from(`${JSON.stringify(projectSeoulMetroConsumedFields(freshRawBytes.toString("utf8")))}\n`);
  if (!baseline.equals(fresh)) throw new Error("SeoulMetro route-map MATERIAL_CHANGE");
  const rowCount = JSON.parse(baseline).reduce((count, line) => count + line.stations.length, 0);
  return {
    schemaVersion: 1,
    artifactKind: "source-projection-migration-evidence",
    migrationKind: "LEGACY_SAMPLE_TO_FULL_CONSUMED_FIELDS",
    sourceId: legacyHead.sourceId,
    legacySnapshotId: legacyHead.snapshotId,
    legacyRawSha256: legacyHead.rawSha256,
    legacySchemaFingerprint: legacyHead.schemaFingerprint,
    legacyProviderRecordHashes: [...legacyHead.providerRecordHashes],
    retainedBaselineRawSha256: sha256(baselineRawBytes),
    fullProjectionSha256: sha256(baseline),
    fullProjectionSchemaFingerprint: sha256(JSON.stringify([
      "lineKey", "label", "color", "stations", "index", "code", "name", "coordinates",
      "marker", "labelPosition", "direction", "moveTo",
    ])),
    fullProjectionRowCount: rowCount,
    newSnapshotId: snapshotId,
  };
}

function projectStation(station, index) {
  const input = requiredObject(station, "station");
  const coordinates = optionalString(input["data-coords"], "station coordinates");
  if (coordinates !== "" && !/^-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?$/u.test(coordinates)) fail("station coordinates");
  return {
    index,
    code: optionalString(input["station-cd"], "station code"),
    name: optionalString(input["station-nm"], "station name"),
    coordinates,
    marker: optionalString(input["data-marker"], "station marker"),
    labelPosition: optionalString(input["data-labelPos"], "station label position"),
    direction: optionalString(input["data-dir"], "station direction"),
    moveTo: optionalString(input["data-moveTo"], "station move-to"),
  };
}

function requiredObject(value, label) {
  if (value == null || typeof value !== "object" || Array.isArray(value)) fail(label);
  return value;
}
function requiredString(value, label) {
  if (typeof value !== "string" || value === "") fail(label);
  return value;
}
function optionalString(value, label) {
  if (value == null) return "";
  if (typeof value !== "string") fail(label);
  return value;
}
function fail(label) { throw new Error(`SeoulMetro line data ${label} is invalid`); }
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeTrailingCommas(value) {
  let out = ""; let quote = false; let escaped = false; let stringLength = 0;
  if (value.split("\n").length > MAX_LINES) throw new Error("SeoulMetro line data line limit exceeded");
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quote) {
      out += char;
      stringLength += 1;
      if (stringLength > MAX_STRING) throw new Error("SeoulMetro line data string limit exceeded");
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quote = false;
      continue;
    }
    if (char === '"') { quote = true; stringLength = 0; out += char; continue; }
    if (char === "/" && (value[index + 1] === "/" || value[index + 1] === "*")) throw new Error("SeoulMetro line data comments are invalid");
    if (char === ",") {
      let cursor = index + 1;
      while (/\s/u.test(value[cursor] ?? "")) cursor += 1;
      if (value[cursor] === "}" || value[cursor] === "]") continue;
    }
    out += char;
  }
  if (quote || escaped) throw new Error("SeoulMetro line data string is invalid");
  return out;
}

function validateTree(root) {
  const pending = [[root, 1]]; let nodes = 0;
  while (pending.length) {
    const [value, depth] = pending.pop();
    nodes += 1;
    if (nodes > MAX_NODES || depth > MAX_NESTING) throw new Error("SeoulMetro line data limits exceeded");
    if (value == null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") continue;
    if (typeof value !== "object") throw new Error("SeoulMetro line data type is invalid");
    for (const child of Object.values(value)) pending.push([child, depth + 1]);
  }
}
