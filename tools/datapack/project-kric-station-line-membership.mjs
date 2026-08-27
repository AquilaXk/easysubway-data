import { createHash } from "node:crypto";

import { parseKricCurrentStationLineWorkbook } from "./collect-kric-nationwide-timetable-file.mjs";

const SOURCE_ID = "kric-current-station-line-file";
const DENOMINATOR_SOURCE_ID = "molit-urban-rail-full-route";
const DENOMINATOR_ARTIFACT_KIND = "public-static-network-v2-observation";
const DENOMINATOR_SNAPSHOT_ID = "molit-urban-rail-full-route-current-20260826T035408251Z";
const DENOMINATOR_RAW_SHA256 = "8a60490ea582a62ce859877380e4b96b34416c536d96b1dcb1a869426bedc363";
const DENOMINATOR_CONTENT_SHA256 = "f5b689252d77d83a4856a9615182d062fab247920dcddb40451d5d7db0fd51c6";

export function projectKricStationLineMembership({ workbookBytes, denominator } = {}) {
  validateDenominator(denominator);
  const sourceRows = parseKricCurrentStationLineWorkbook(workbookBytes);
  const denominatorByKey = new Map();
  for (const row of denominator.normalizedProjection) {
    const key = membershipKey(row.operator_name, row.line_name, row.station_name);
    if (denominatorByKey.has(key)) throw new Error("KRIC_STATION_LINE_DENOMINATOR_AMBIGUOUS");
    denominatorByKey.set(key, row);
  }
  const records = [];
  const seen = new Set();
  for (const source of sourceRows) {
    const key = membershipKey(source.operator, source.line, source.stationName);
    if (seen.has(key)) throw new Error("KRIC_STATION_LINE_SOURCE_DUPLICATE");
    seen.add(key);
    const matched = denominatorByKey.get(key);
    if (!matched) throw new Error("KRIC_STATION_LINE_UNMATCHED");
    records.push({
      region_code: matched.region_code,
      region_name: matched.region_name,
      operator_name: matched.operator_name,
      line_name: matched.line_name,
      station_name: matched.station_name,
      source_station_code: source.stationCode,
    });
  }
  if (seen.size !== denominatorByKey.size) throw new Error("KRIC_STATION_LINE_COVERAGE_INCOMPLETE");
  return {
    artifactKind: "kric-station-line-membership-projection",
    projectionOnly: true,
    sourceId: SOURCE_ID,
    denominatorRawSha256: DENOMINATOR_RAW_SHA256,
    denominatorContentSha256: DENOMINATOR_CONTENT_SHA256,
    records,
    recordsSha256: createHash("sha256").update(JSON.stringify(records)).digest("hex"),
  };
}

function validateDenominator(value) {
  if (value?.artifactKind !== DENOMINATOR_ARTIFACT_KIND || value.sourceId !== DENOMINATOR_SOURCE_ID
    || value.snapshotId !== DENOMINATOR_SNAPSHOT_ID
    || value.rowCount !== 1103 || value.rawSha256 !== DENOMINATOR_RAW_SHA256
    || !Array.isArray(value.normalizedProjection)
    || value.normalizedProjection.length !== 1103) throw new Error("KRIC_STATION_LINE_DENOMINATOR_IDENTITY");
  if (value.contentSha256 !== DENOMINATOR_CONTENT_SHA256
    || sha256(Buffer.from(`${JSON.stringify(value.normalizedProjection)}\n`)) !== value.contentSha256) {
    throw new Error("KRIC_STATION_LINE_DENOMINATOR_CONTENT_HASH");
  }
  for (const row of value.normalizedProjection) {
    for (const field of ["region_code", "region_name", "operator_name", "line_name", "station_name"]) {
      if (typeof row?.[field] !== "string" || row[field].normalize("NFC").trim() === "") throw new Error("KRIC_STATION_LINE_DENOMINATOR_ROW");
    }
    if (!Number.isInteger(row.station_sequence) || row.station_sequence < 1) throw new Error("KRIC_STATION_LINE_DENOMINATOR_ROW");
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function membershipKey(operator, line, station) {
  return [operator, line, station].map((value) => {
    if (typeof value !== "string" || value.normalize("NFC").trim() === "") throw new Error("KRIC_STATION_LINE_KEY");
    return value.normalize("NFC").trim();
  }).join("\u0000");
}
