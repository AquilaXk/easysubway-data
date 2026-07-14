#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";

import {
  officialOdFareAdmissionsBySource,
  officialOdFareQuoteSetHash,
} from "./lib/official-od-fare-evidence.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const FARE_COLUMNS = [
  "gnrlCardFare", "gnrlCashFare", "yungCardFare", "yungCashFare", "childCardFare", "childCashFare",
];
const BUNDLED_CATALOG_USER_VERSION = 16;

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function validateQuotes(document, admissions) {
  if (document?.schemaVersion !== 1 || document?.artifactKind !== "official-od-fare-bounded-quotes"
    || !Array.isArray(document.quotes) || document.quotes.length === 0) {
    throw new Error("bounded quote document identity is invalid");
  }
  const grouped = new Map();
  for (const quote of document.quotes) {
    const admission = admissions.get(quote.sourceId);
    if (!admission) throw new Error(`missing admission for ${quote.sourceId}`);
    if (quote.snapshotId !== admission.snapshotId || quote.mappingLedgerHash !== admission.fareStationLineMappingLedgerHash) {
      throw new Error(`quote provenance must match admission: ${quote.sourceId}`);
    }
    for (const field of FARE_COLUMNS) {
      if (!Number.isSafeInteger(quote[field]) || quote[field] < 0) throw new Error(`${field} must be a non-negative safe integer`);
    }
    const rows = grouped.get(quote.sourceId) ?? [];
    rows.push(quote);
    grouped.set(quote.sourceId, rows);
  }
  if (grouped.size !== admissions.size) {
    throw new Error("quote source set must match admission source set");
  }
  for (const [sourceId, quotes] of grouped) {
    const admission = admissions.get(sourceId);
    if (quotes.length !== admission.quoteCount || officialOdFareQuoteSetHash(quotes) !== admission.quoteSetHash) {
      throw new Error(`quote set must match admission: ${sourceId}`);
    }
  }
  return document.quotes;
}

function applyQuotes(sqlitePath, quotes) {
  const database = new DatabaseSync(sqlitePath);
  try {
    rejectNewerCatalogVersion(database);
    database.exec("PRAGMA foreign_keys = ON");
    database.exec(`
      CREATE TABLE IF NOT EXISTS official_od_fare_quotes (
        origin_station_id TEXT NOT NULL,
        destination_station_id TEXT NOT NULL,
        source_id TEXT NOT NULL,
        snapshot_id TEXT NOT NULL,
        mapping_ledger_hash TEXT NOT NULL,
        gnrl_card_fare INTEGER NOT NULL,
        gnrl_cash_fare INTEGER NOT NULL,
        yung_card_fare INTEGER NOT NULL,
        yung_cash_fare INTEGER NOT NULL,
        child_card_fare INTEGER NOT NULL,
        child_cash_fare INTEGER NOT NULL,
        PRIMARY KEY (origin_station_id, destination_station_id),
        FOREIGN KEY (origin_station_id) REFERENCES stations(id),
        FOREIGN KEY (destination_station_id) REFERENCES stations(id),
        CHECK (origin_station_id <> destination_station_id),
        CHECK (length(mapping_ledger_hash) = 64 AND mapping_ledger_hash NOT GLOB '*[^0-9a-f]*'),
        CHECK (gnrl_card_fare >= 0), CHECK (gnrl_cash_fare >= 0),
        CHECK (yung_card_fare >= 0), CHECK (yung_cash_fare >= 0),
        CHECK (child_card_fare >= 0), CHECK (child_cash_fare >= 0)
      );
    `);
    if (JSON.stringify(storedQuotes(database)) === JSON.stringify(canonicalQuotes(quotes))) {
      if (database.prepare("PRAGMA user_version").get().user_version !== BUNDLED_CATALOG_USER_VERSION) {
        database.exec(`PRAGMA user_version = ${BUNDLED_CATALOG_USER_VERSION}`);
      }
      assertIntegrity(database);
      return;
    }
    const insert = database.prepare(`
      INSERT INTO official_od_fare_quotes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec("DELETE FROM official_od_fare_quotes");
      for (const quote of quotes) {
        insert.run(
          quote.originStationId, quote.destinationStationId, quote.sourceId, quote.snapshotId,
          quote.mappingLedgerHash, ...FARE_COLUMNS.map((field) => quote[field]),
        );
      }
      database.exec(`PRAGMA user_version = ${BUNDLED_CATALOG_USER_VERSION}`);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    assertIntegrity(database);
  } finally {
    database.close();
  }
}

function rejectNewerCatalogVersion(database) {
  const current = database.prepare("PRAGMA user_version").get().user_version;
  if (current > BUNDLED_CATALOG_USER_VERSION) {
    throw new Error(
      `official OD fare postprocessor does not support catalog user_version ${current} newer than ${BUNDLED_CATALOG_USER_VERSION}`,
    );
  }
}

function assertIntegrity(database) {
  const integrity = database.prepare("PRAGMA integrity_check").get();
  if (integrity.integrity_check !== "ok") throw new Error("bundled datapack integrity_check failed");
}

function canonicalQuotes(quotes) {
  return [...quotes].sort((left, right) => left.sourceId.localeCompare(right.sourceId)
    || left.originStationId.localeCompare(right.originStationId)
    || left.destinationStationId.localeCompare(right.destinationStationId));
}

function storedQuotes(database) {
  return database.prepare(`
    SELECT origin_station_id AS originStationId, destination_station_id AS destinationStationId,
           source_id AS sourceId, snapshot_id AS snapshotId, mapping_ledger_hash AS mappingLedgerHash,
           gnrl_card_fare AS gnrlCardFare, gnrl_cash_fare AS gnrlCashFare,
           yung_card_fare AS yungCardFare, yung_cash_fare AS yungCashFare,
           child_card_fare AS childCardFare, child_cash_fare AS childCashFare
    FROM official_od_fare_quotes ORDER BY source_id, origin_station_id, destination_station_id
  `).all().map((row) => ({ ...row }));
}

function assertStoredQuotes(sqlitePath, quotes) {
  const database = new DatabaseSync(sqlitePath, { readOnly: true });
  try {
    if (database.prepare("PRAGMA user_version").get().user_version !== BUNDLED_CATALOG_USER_VERSION) {
      throw new Error(`bundled catalog user_version must be ${BUNDLED_CATALOG_USER_VERSION}`);
    }
    assertIntegrity(database);
    if (JSON.stringify(storedQuotes(database)) !== JSON.stringify(canonicalQuotes(quotes))) {
      throw new Error("bundled official OD fare rows are stale");
    }
  } finally {
    database.close();
  }
}

async function main() {
  const packPath = path.resolve(root, option("--pack", "apps/mobile/assets/datapacks/capital.sqlite.gz"));
  const indexPath = path.resolve(root, option("--index", "apps/mobile/assets/datapacks/index.json"));
  const quotesPath = path.resolve(root, option("--quotes", "tools/datapack/official-od-fare-quotes.json"));
  const admissionPath = path.resolve(root, option("--admission", "tools/datapack/official-od-fare-admission.json"));
  const check = process.argv.includes("--check");
  const admissions = officialOdFareAdmissionsBySource(JSON.parse(await readFile(admissionPath, "utf8")));
  const quotes = validateQuotes(JSON.parse(await readFile(quotesPath, "utf8")), admissions);
  const directory = await mkdtemp(path.join(os.tmpdir(), `official-od-fare-pack-${randomUUID()}-`));
  try {
    const sqlitePath = path.join(directory, "capital.sqlite");
    const currentGzipBytes = await readFile(packPath);
    await writeFile(sqlitePath, gunzipSync(currentGzipBytes));
    if (check) {
      assertStoredQuotes(sqlitePath, quotes);
      const sqliteBytes = await readFile(sqlitePath);
      const index = JSON.parse(await readFile(indexPath, "utf8"));
      const pack = index.packs.find(({ id }) => id === "capital");
      if (!pack || pack.sha256 !== sha256(currentGzipBytes) || pack.sqliteSha256 !== sha256(sqliteBytes)
        || pack.byteSize !== currentGzipBytes.length) {
        throw new Error("bundled official OD fare pack index is stale");
      }
      return;
    }
    applyQuotes(sqlitePath, quotes);
    const sqliteBytes = await readFile(sqlitePath);
    const gzipBytes = gzipSync(sqliteBytes, { level: 9, mtime: 0 });
    const index = JSON.parse(await readFile(indexPath, "utf8"));
    const pack = index.packs.find(({ id }) => id === "capital");
    if (!pack) throw new Error("capital pack index entry is missing");
    const next = { sha256: sha256(gzipBytes), sqliteSha256: sha256(sqliteBytes), byteSize: gzipBytes.length };
    Object.assign(pack, next);
    await writeFile(packPath, gzipBytes);
    await writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
