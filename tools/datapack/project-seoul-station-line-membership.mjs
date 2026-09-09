import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { parseCurrentMolitLineOperatorRosters } from "./build-molit-nationwide-fixture.mjs";
import { collectSeoulStationLineInfo } from "./collect-seoul-station-line-info.mjs";
import { loadCurrentMolitObservation } from "./current-molit-observation.mjs";
import { requireExactPublicStaticNetworkV2SnapshotBinding } from "./public-static-network-v2-admission.mjs";
import { validateLineage } from "./source-snapshot-policy.mjs";
import { normalizeStationName } from "./lib/station-roster.mjs";

const SOURCE_ID = "seoulmetro-station-line-info";
const POSITION_SOURCE_ID = "seoul-metro-route-map-positions";
const hash = (value) => createHash("sha256").update(value).digest("hex");

function numeric(value, label) {
  if (typeof value !== "string" || !/^\d+$/u.test(value)) throw new Error(`${label} must be numeric`);
  return value.replace(/^0+(?=\d)/u, "");
}

function lineOrdinal(value, label) {
  const match = /^(\d+)호선$/u.exec(String(value ?? "").trim());
  if (!match) throw new Error(`${label} must be an n호선 line`);
  return numeric(match[1], label);
}

function sourceLineOrdinal(value) {
  return /^(\d+)호선$/u.test(String(value ?? "").trim())
    ? lineOrdinal(value, "source LINE_NUM")
    : null;
}

function explicitTokens(name) {
  return [...String(name).matchAll(/[\(\[]([^\)\]]+)[\)\]]/gu)]
    .map((match) => normalizeStationName(match[1]))
    .filter(Boolean);
}

function positionConjunction(source, molitName, line, positionRows) {
  const sourceCode = numeric(source.STATION_CD, "source STATION_CD");
  const molitPrimary = normalizeStationName(molitName);
  return positionRows.some((position) => numeric(position?.line, "position line") === line
    && numeric(position?.stationCode, "position stationCode") === sourceCode
    && normalizeStationName(position.stationName) === molitPrimary);
}

export function bindSeoulStationLineMembership({ rows, molitProjection, positionRows, provider } = {}) {
  if (!Array.isArray(rows) || !Array.isArray(molitProjection) || !Array.isArray(positionRows)
    || typeof provider !== "string" || provider.trim() === "") throw new Error("Seoul membership binding inputs are required");
  const selectedMolit = molitProjection.filter((row) =>
    row?.region_name === "수도권" && row.operator_name === provider);
  if (selectedMolit.length === 0) throw new Error("Seoul membership roster is empty");
  const sourcesByLine = new Map();
  for (const row of rows) {
    const line = sourceLineOrdinal(row?.LINE_NUM);
    if (line == null) continue;
    const list = sourcesByLine.get(line) ?? [];
    list.push(row);
    sourcesByLine.set(line, list);
  }
  const records = [];
  const usedSourceHashes = new Set();
  const scopeGroups = [];
  const molitGroups = new Map();
  for (const row of selectedMolit) {
    const group = molitGroups.get(row.line_name) ?? [];
    group.push(row);
    molitGroups.set(row.line_name, group);
  }
  for (const rosterRows of molitGroups.values()) {
    const scopes = [...parseCurrentMolitLineOperatorRosters(rosterRows).values()];
    if (scopes.length !== 1) throw new Error("MOLIT line group has ambiguous scope");
    const [roster] = scopes;
    const line = lineOrdinal(rosterRows[0].line_name, "MOLIT line");
    const groupRecords = [];
    for (const molit of rosterRows) {
      const primary = normalizeStationName(molit.station_name);
      const aliases = new Set(explicitTokens(molit.station_name));
      const matches = (sourcesByLine.get(line) ?? []).filter((source) => {
        const sourceName = normalizeStationName(source.STATION_NM);
        if (sourceName === primary) return true;
        return aliases.has(sourceName) && positionConjunction(source, molit.station_name, line, positionRows);
      });
      if (matches.length === 0) throw new Error(`unmatched roster station: ${molit.station_name}`);
      if (matches.length !== 1) throw new Error(`ambiguous source matches: ${molit.station_name}`);
      const source = matches[0];
      const sourceRowSha256 = hash(JSON.stringify(source));
      if (usedSourceHashes.has(sourceRowSha256)) throw new Error(`source row maps to multiple roster stations: ${source.STATION_CD}`);
      usedSourceHashes.add(sourceRowSha256);
      const record = {
        regionId: roster.regionId,
        operatorId: roster.operatorId,
        lineId: roster.lineId,
        canonicalStationName: molit.station_name,
        sourceStationCode: source.STATION_CD,
        externalStationCode: source.FR_CODE,
        sourceRowSha256,
      };
      records.push(record);
      groupRecords.push(record);
    }
    scopeGroups.push({ regionId: roster.regionId, operatorId: roster.operatorId, lineId: roster.lineId, rowCount: groupRecords.length });
  }
  return {
    artifactKind: "seoul-station-line-membership-projection",
    projectionOnly: true,
    sourceId: SOURCE_ID,
    records,
    scopeGroups,
    recordsSha256: hash(JSON.stringify(records)),
  };
}

export async function projectSeoulStationLineMembership({
  repositoryRoot = path.resolve(import.meta.dirname, "../.."), snapshotPath, now = new Date(),
} = {}) {
  if (typeof snapshotPath !== "string" || snapshotPath === "") throw new Error("snapshotPath is required");
  const root = path.resolve(repositoryRoot);
  const inventoryPath = path.join(root, "tools/datapack/source-inventory.json");
  const ledgerPath = path.join(root, "tools/datapack/release/source-snapshots.json");
  const [inventoryBytes, ledgerBytes, snapshotBytes] = await Promise.all([
    readFile(inventoryPath), readFile(ledgerPath), readFile(path.resolve(root, snapshotPath)),
  ]);
  const inventory = JSON.parse(inventoryBytes);
  const ledger = JSON.parse(ledgerBytes);
  const source = inventory.sources?.find(({ id }) => id === SOURCE_ID);
  const suppliedSnapshot = JSON.parse(snapshotBytes);
  const sourceBytes = Buffer.from(suppliedSnapshot?.rawBytesBase64 ?? "", "base64");
  const snapshot = collectSeoulStationLineInfo({ csvBytes: sourceBytes, capturedAt: suppliedSnapshot?.capturedAt });
  if (!isDeepStrictEqual(snapshot, suppliedSnapshot)) throw new Error("Seoul source snapshot replay does not match its stored bytes");

  const molit = await loadCurrentMolitObservation({
    repositoryRoot: root, inventory, inventoryBytes, snapshots: ledger, snapshotsBytes: ledgerBytes,
  });
  const positionSource = inventory.sources?.find(({ id }) => id === POSITION_SOURCE_ID);
  const positionSnapshotId = positionSource?.admissionEvidence?.snapshotId;
  const heads = validateLineage(ledger).headsBySource;
  if (heads[POSITION_SOURCE_ID] !== positionSnapshotId) throw new Error("current Seoul positions admission is not the ledger head");
  const positionLedgerRow = ledger.find((row) => row.sourceId === POSITION_SOURCE_ID && row.snapshotId === positionSnapshotId);
  if (!positionLedgerRow) throw new Error("current Seoul positions ledger snapshot is missing");
  requireExactPublicStaticNetworkV2SnapshotBinding({
    snapshot: positionLedgerRow, source: positionSource, now, requireCurrentFreshness: false,
  });
  const positionsPath = path.join(root, "tools/datapack/sources", `${positionSnapshotId}.json`);
  const positionsBytes = await readFile(positionsPath);
  if (hash(positionsBytes) !== positionLedgerRow.normalizedObservationSha256) {
    throw new Error("current Seoul positions bytes do not match the ledger snapshot");
  }
  const positions = JSON.parse(positionsBytes);
  const projection = bindSeoulStationLineMembership({
    rows: snapshot.rows,
    molitProjection: molit.observation.normalizedProjection,
    positionRows: positions.normalizedProjection,
    provider: source.provider,
  });
  return {
    projection,
    snapshot,
    inputs: {
      snapshot: { path: path.resolve(root, snapshotPath), bytes: snapshotBytes, sha256: hash(snapshotBytes) },
      inventory: { path: inventoryPath, bytes: inventoryBytes, sha256: hash(inventoryBytes) },
      ledger: { path: ledgerPath, bytes: ledgerBytes, sha256: hash(ledgerBytes) },
      molit: { path: path.join(root, molit.observationPath), snapshotId: molit.current.snapshotId, rawSha256: molit.current.rawSha256, bytes: molit.observationBytes, sha256: hash(molit.observationBytes) },
      positions: { path: positionsPath, snapshotId: positionSnapshotId, rawSha256: positionLedgerRow.rawSha256, bytes: positionsBytes, sha256: hash(positionsBytes) },
    },
  };
}
