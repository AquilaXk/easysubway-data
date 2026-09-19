import { createHash } from "node:crypto";

import { parseKricCurrentStationLineWorkbook } from "./collect-kric-nationwide-timetable-file.mjs";
import { loadCurrentMolitObservation } from "./current-molit-observation.mjs";

const SOURCE_ID = "kric-current-station-line-file";
const DENOMINATOR_SOURCE_ID = "molit-urban-rail-full-route";

export async function projectKricStationLineMembership({ workbookBytes, repositoryRoot } = {}) {
  if (!(Buffer.isBuffer(workbookBytes) || workbookBytes instanceof Uint8Array) || workbookBytes.length === 0) {
    throw new Error("KRIC_STATION_LINE_WORKBOOK_REQUIRED");
  }
  const currentMolit = await loadCurrentMolitObservation({ repositoryRoot });
  const denominator = validateDenominator(currentMolit.observation);
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
    denominatorRawSha256: currentMolit.current.rawSha256,
    denominatorContentSha256: currentMolit.current.contentSha256,
    records,
    recordsSha256: createHash("sha256").update(JSON.stringify(records)).digest("hex"),
  };
}

function validateDenominator(observation) {
  // 원문·snapshot·ledger 결속은 공통 로더가 검증한다. 여기서는 membership 행 구조만 확인한다.
  if (observation?.artifactKind !== "public-static-network-v2-observation"
    || observation.sourceId !== DENOMINATOR_SOURCE_ID
    || !Number.isInteger(observation.rowCount) || observation.rowCount <= 0 || !Array.isArray(observation.normalizedProjection)
    || observation.normalizedProjection.length !== observation.rowCount) throw new Error("KRIC_STATION_LINE_DENOMINATOR_IDENTITY");
  for (const row of observation.normalizedProjection) {
    for (const field of ["region_code", "region_name", "operator_name", "line_name", "station_name"]) {
      if (typeof row?.[field] !== "string" || row[field].normalize("NFC").trim() === "") throw new Error("KRIC_STATION_LINE_DENOMINATOR_ROW");
    }
    if (!Number.isInteger(row.station_sequence) || row.station_sequence < 1) throw new Error("KRIC_STATION_LINE_DENOMINATOR_ROW");
  }
  return observation;
}

function membershipKey(operator, line, station) {
  return [operator, line, station].map((value) => {
    if (typeof value !== "string" || value.normalize("NFC").trim() === "") throw new Error("KRIC_STATION_LINE_KEY");
    return value.normalize("NFC").trim();
  }).join("\u0000");
}
