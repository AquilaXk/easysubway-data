#!/usr/bin/env node
// 번들 datapack(capital.sqlite.gz)에 빠른하차 차량·출입문 힌트(station_car_door_hints)를
// 반입한다. catalog-schema.sql v16은 이미 이 테이블을 정의하지만(#2033) 번들 팩엔 rows만
// 누락되어 실사용자에게 힌트가 보이지 않았다(#2066/#2039 맥락). 이 스크립트는 시간 데이터가
// 아니라 admission·검증 완료된 정적 힌트 행을 번들 팩에 idempotent하게 반입한다.
// catalog user_version은 16을 유지한다(증가 금지).
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";

const root = path.resolve(import.meta.dirname, "../..");
const BUNDLED_CATALOG_USER_VERSION = 16;
const FACILITY_TYPES = new Set(["STAIR", "ELEVATOR", "ESCALATOR", "TRANSFER"]);

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function validateHints(hints) {
  if (!Array.isArray(hints) || hints.length === 0) {
    throw new Error("station car door hints must be a non-empty array");
  }
  const seen = new Set();
  for (const hint of hints) {
    if (typeof hint.id !== "string" || hint.id.length === 0) {
      throw new Error("car door hint id must be a non-empty string");
    }
    if (seen.has(hint.id)) throw new Error(`duplicate car door hint id: ${hint.id}`);
    seen.add(hint.id);
    for (const field of ["stationId", "lineId", "direction"]) {
      if (typeof hint[field] !== "string" || hint[field].length === 0) {
        throw new Error(`car door hint ${field} must be a non-empty string: ${hint.id}`);
      }
    }
    if (!FACILITY_TYPES.has(hint.targetFacilityType)) {
      throw new Error(`car door hint targetFacilityType is invalid: ${hint.id}`);
    }
    if (!Number.isSafeInteger(hint.carNumber) || hint.carNumber < 1 || hint.carNumber > 10) {
      throw new Error(`car door hint carNumber must be 1..10: ${hint.id}`);
    }
    if (!Number.isSafeInteger(hint.doorNumber) || hint.doorNumber < 1 || hint.doorNumber > 4) {
      throw new Error(`car door hint doorNumber must be 1..4: ${hint.id}`);
    }
    if (typeof hint.verificationStatus !== "string" || hint.verificationStatus.length === 0) {
      throw new Error(`car door hint verificationStatus must be a non-empty string: ${hint.id}`);
    }
  }
  return hints;
}

function canonicalHints(hints) {
  return [...hints].sort((left, right) => left.id.localeCompare(right.id)).map((hint) => ({
    id: hint.id,
    stationId: hint.stationId,
    lineId: hint.lineId,
    direction: hint.direction,
    targetFacilityType: hint.targetFacilityType,
    carNumber: hint.carNumber,
    doorNumber: hint.doorNumber,
    sourceId: hint.sourceId ?? "",
    sourceSnapshotId: hint.sourceSnapshotId ?? "",
    providerRecordHash: hint.providerRecordHash ?? "",
    provenanceKind: hint.provenanceKind ?? "UNKNOWN",
    verificationStatus: hint.verificationStatus,
    lastVerifiedAt: 0,
    evidenceHash: "",
  }));
}

function storedHints(database) {
  return database.prepare(`
    SELECT id, station_id AS stationId, line_id AS lineId, direction,
           target_facility_type AS targetFacilityType, car_number AS carNumber,
           door_number AS doorNumber, source_id AS sourceId,
           source_snapshot_id AS sourceSnapshotId, provider_record_hash AS providerRecordHash,
           provenance_kind AS provenanceKind, verification_status AS verificationStatus,
           last_verified_at AS lastVerifiedAt, evidence_hash AS evidenceHash
    FROM station_car_door_hints ORDER BY id
  `).all().map((row) => ({ ...row }));
}

function ensureSchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS station_car_door_hints (
      id TEXT NOT NULL PRIMARY KEY,
      station_id TEXT NOT NULL,
      line_id TEXT NOT NULL,
      direction TEXT NOT NULL DEFAULT '',
      target_facility_type TEXT NOT NULL,
      car_number INTEGER NOT NULL CHECK (car_number >= 1 AND car_number <= 10),
      door_number INTEGER NOT NULL CHECK (door_number >= 1 AND door_number <= 4),
      source_id TEXT NOT NULL DEFAULT '',
      source_snapshot_id TEXT NOT NULL DEFAULT '',
      provider_record_hash TEXT NOT NULL DEFAULT '',
      provenance_kind TEXT NOT NULL DEFAULT 'UNKNOWN',
      verification_status TEXT NOT NULL DEFAULT 'UNKNOWN',
      last_verified_at INTEGER NOT NULL DEFAULT 0,
      evidence_hash TEXT NOT NULL DEFAULT '',
      CHECK (target_facility_type IN ('STAIR', 'ELEVATOR', 'ESCALATOR', 'TRANSFER')),
      FOREIGN KEY (station_id, line_id) REFERENCES station_lines(station_id, line_id)
    );
  `);
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_station_car_door_hints_station
      ON station_car_door_hints(station_id, line_id);
  `);
}

function applyHints(sqlitePath, hints) {
  const canonical = canonicalHints(hints);
  const database = new DatabaseSync(sqlitePath);
  try {
    database.exec("PRAGMA foreign_keys = ON");
    ensureSchema(database);
    if (JSON.stringify(storedHints(database)) === JSON.stringify(canonical)) {
      if (database.prepare("PRAGMA user_version").get().user_version !== BUNDLED_CATALOG_USER_VERSION) {
        database.exec(`PRAGMA user_version = ${BUNDLED_CATALOG_USER_VERSION}`);
      }
      assertIntegrity(database);
      return;
    }
    const insert = database.prepare(`
      INSERT INTO station_car_door_hints VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec("DELETE FROM station_car_door_hints");
      for (const hint of canonical) {
        insert.run(
          hint.id, hint.stationId, hint.lineId, hint.direction, hint.targetFacilityType,
          hint.carNumber, hint.doorNumber, hint.sourceId, hint.sourceSnapshotId,
          hint.providerRecordHash, hint.provenanceKind, hint.verificationStatus,
          hint.lastVerifiedAt, hint.evidenceHash,
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

function assertIntegrity(database) {
  const integrity = database.prepare("PRAGMA integrity_check").get();
  if (integrity.integrity_check !== "ok") throw new Error("bundled datapack integrity_check failed");
}

function assertStoredHints(sqlitePath, hints) {
  const database = new DatabaseSync(sqlitePath, { readOnly: true });
  try {
    if (database.prepare("PRAGMA user_version").get().user_version !== BUNDLED_CATALOG_USER_VERSION) {
      throw new Error(`bundled catalog user_version must be ${BUNDLED_CATALOG_USER_VERSION}`);
    }
    assertIntegrity(database);
    if (JSON.stringify(storedHints(database)) !== JSON.stringify(canonicalHints(hints))) {
      throw new Error("bundled station car door hint rows are stale");
    }
  } finally {
    database.close();
  }
}

async function main() {
  const packPath = path.resolve(root, option("--pack", "apps/mobile/assets/datapacks/capital.sqlite.gz"));
  const indexPath = path.resolve(root, option("--index", "apps/mobile/assets/datapacks/index.json"));
  const fixturePath = path.resolve(root, option("--fixture", "tools/datapack/fixtures/catalog-fixture.json"));
  const check = process.argv.includes("--check");
  const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
  const hints = validateHints(fixture?.packs?.[0]?.stationCarDoorHints);
  const directory = await mkdtemp(path.join(os.tmpdir(), `car-door-hints-pack-${randomUUID()}-`));
  try {
    const sqlitePath = path.join(directory, "capital.sqlite");
    const currentGzipBytes = await readFile(packPath);
    await writeFile(sqlitePath, gunzipSync(currentGzipBytes));
    if (check) {
      assertStoredHints(sqlitePath, hints);
      const sqliteBytes = await readFile(sqlitePath);
      const index = JSON.parse(await readFile(indexPath, "utf8"));
      const pack = index.packs.find(({ id }) => id === "capital");
      if (!pack || pack.sha256 !== sha256(currentGzipBytes) || pack.sqliteSha256 !== sha256(sqliteBytes)
        || pack.byteSize !== currentGzipBytes.length) {
        throw new Error("bundled station car door hint pack index is stale");
      }
      return;
    }
    applyHints(sqlitePath, hints);
    const sqliteBytes = await readFile(sqlitePath);
    const gzipBytes = gzipSync(sqliteBytes, { level: 9, mtime: 0 });
    const index = JSON.parse(await readFile(indexPath, "utf8"));
    const pack = index.packs.find(({ id }) => id === "capital");
    if (!pack) throw new Error("capital pack index entry is missing");
    Object.assign(pack, { sha256: sha256(gzipBytes), sqliteSha256: sha256(sqliteBytes), byteSize: gzipBytes.length });
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
