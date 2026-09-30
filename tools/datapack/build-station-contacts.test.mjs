import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildStationContacts,
  loadStationContactInputs,
  normalizePhoneNumber,
} from "./build-station-contacts.mjs";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

const FIXTURE_MAPPINGS = [
  {
    stationId: "station-a2d54a5d63d2",
    lineId: "seoul-2",
    railOprIsttCd: "S1",
    lnCd: "2",
    stinCd: "201",
    canonicalMappings: [
      {
        artifactId: "bundled-capital",
        stationId: "station-a2d54a5d63d2",
        lineId: "seoul-2",
      },
    ],
  },
  {
    stationId: "station-a2d54a5d63d2",
    lineId: "seoul-1",
    railOprIsttCd: "S1",
    lnCd: "1",
    stinCd: "151",
    canonicalMappings: [
      {
        artifactId: "bundled-capital",
        stationId: "station-a2d54a5d63d2",
        lineId: "seoul-1",
      },
    ],
  },
  {
    stationId: "station-ae0e5bd1256d",
    lineId: "seoul-4",
    railOprIsttCd: "S1",
    lnCd: "4",
    stinCd: "425",
    canonicalMappings: [
      {
        artifactId: "bundled-capital",
        stationId: "station-ae0e5bd1256d",
        lineId: "seoul-4",
      },
    ],
  },
];

test("(1) 정상 행 → station_contacts 행", () => {
  const snapshot = {
    schemaVersion: 1,
    artifactKind: "seoul-station-contact-snapshot",
    sourceId: "seoul-metro-station-contact",
    snapshotId: "seoul-metro-station-contact-fixture-01",
    capturedAt: "2026-09-30T05:00:00.000Z",
    rowCount: 2,
    rows: [
      {
        seq: "11",
        stnNo: "201",
        line: "2",
        name: "시청",
        phone: "02-6110-2011",
        roadAddr: "서울특별시 중구 서소문로 125",
        jibunAddr: "서울특별시 중구 서소문동 37",
      },
      {
        seq: "95",
        stnNo: "425",
        line: "4",
        name: "회현",
        phone: "02-6110-4251",
        roadAddr: "서울특별시 중구 퇴계로 지하54",
        jibunAddr: "서울특별시 중구 남창동 64-1",
      },
    ],
  };

  const { rows, exclusions } = buildStationContacts({
    snapshot,
    canonicalMappings: FIXTURE_MAPPINGS,
  });

  assert.equal(exclusions.length, 0);
  assert.equal(rows.length, 2);

  assert.deepEqual(rows[0], {
    station_id: "station-a2d54a5d63d2",
    line_id: "seoul-2",
    phone: "02-6110-2011",
    phone_raw: "02-6110-2011",
    source_snapshot_id: "seoul-metro-station-contact-fixture-01",
  });

  assert.deepEqual(rows[1], {
    station_id: "station-ae0e5bd1256d",
    line_id: "seoul-4",
    phone: "02-6110-4251",
    phone_raw: "02-6110-4251",
    source_snapshot_id: "seoul-metro-station-contact-fixture-01",
  });
});

test("(2) 환승역 노선별 저장 (같은 station_id에 여러 노선)", () => {
  const snapshot = {
    schemaVersion: 1,
    artifactKind: "seoul-station-contact-snapshot",
    sourceId: "seoul-metro-station-contact",
    snapshotId: "seoul-metro-station-contact-fixture-02",
    capturedAt: "2026-09-30T05:00:00.000Z",
    rowCount: 2,
    rows: [
      {
        seq: "2",
        stnNo: "151",
        line: "1",
        name: "시청",
        phone: "02-6110-1321",
        roadAddr: "서울특별시 중구 세종대로 지하101",
        jibunAddr: "서울특별시 중구 정동 5-5",
      },
      {
        seq: "11",
        stnNo: "201",
        line: "2",
        name: "시청",
        phone: "02-6110-2011",
        roadAddr: "서울특별시 중구 서소문로 125",
        jibunAddr: "서울특별시 중구 서소문동 37",
      },
    ],
  };

  const { rows, exclusions } = buildStationContacts({
    snapshot,
    canonicalMappings: FIXTURE_MAPPINGS,
  });

  assert.equal(exclusions.length, 0);
  assert.equal(rows.length, 2);

  // Both have same station_id, but different line_id
  assert.equal(rows[0].station_id, "station-a2d54a5d63d2");
  assert.equal(rows[0].line_id, "seoul-1");
  assert.equal(rows[0].phone, "02-6110-1321");

  assert.equal(rows[1].station_id, "station-a2d54a5d63d2");
  assert.equal(rows[1].line_id, "seoul-2");
  assert.equal(rows[1].phone, "02-6110-2011");
});

test("(3) 매핑 실패 제외", () => {
  const snapshot = {
    schemaVersion: 1,
    artifactKind: "seoul-station-contact-snapshot",
    sourceId: "seoul-metro-station-contact",
    snapshotId: "seoul-metro-station-contact-fixture-03",
    capturedAt: "2026-09-30T05:00:00.000Z",
    rowCount: 1,
    rows: [
      {
        seq: "999",
        stnNo: "9999",
        line: "9",
        name: "미지의역",
        phone: "02-1234-5678",
        roadAddr: "주소",
        jibunAddr: "지번",
      },
    ],
  };

  const { rows, exclusions } = buildStationContacts({
    snapshot,
    canonicalMappings: FIXTURE_MAPPINGS,
  });

  assert.equal(rows.length, 0);
  assert.equal(exclusions.length, 1);
  assert.equal(exclusions[0].reason, "MAPPING_NOT_FOUND");
});

test("(4) 전화번호 형식 실패 제외", () => {
  const snapshot = {
    schemaVersion: 1,
    artifactKind: "seoul-station-contact-snapshot",
    sourceId: "seoul-metro-station-contact",
    snapshotId: "seoul-metro-station-contact-fixture-04",
    capturedAt: "2026-09-30T05:00:00.000Z",
    rowCount: 3,
    rows: [
      {
        seq: "11",
        stnNo: "201",
        line: "2",
        name: "시청",
        phone: "전화번호없음",
        roadAddr: "주소",
        jibunAddr: "지번",
      },
      {
        seq: "12",
        stnNo: "201",
        line: "2",
        name: "시청",
        phone: "12345",
        roadAddr: "주소",
        jibunAddr: "지번",
      },
      {
        seq: "13",
        stnNo: "201",
        line: "2",
        name: "시청",
        phone: "",
        roadAddr: "주소",
        jibunAddr: "지번",
      },
    ],
  };

  const { rows, exclusions } = buildStationContacts({
    snapshot,
    canonicalMappings: FIXTURE_MAPPINGS,
  });

  assert.equal(rows.length, 0);
  assert.equal(exclusions.length, 3);
  assert.equal(exclusions[0].reason, "INVALID_PHONE_FORMAT");
  assert.equal(exclusions[1].reason, "INVALID_PHONE_FORMAT");
  assert.equal(exclusions[2].reason, "INVALID_PHONE_FORMAT");
});

test("(5) 운영 빌드 적재 (SQLite table DDL 및 삽입 검증)", () => {
  const DDL = "CREATE TABLE station_contacts (station_id TEXT NOT NULL, line_id TEXT NOT NULL, phone TEXT NOT NULL, phone_raw TEXT NOT NULL, source_snapshot_id TEXT NOT NULL, PRIMARY KEY(station_id, line_id))";
  const db = new DatabaseSync(":memory:");
  db.exec(DDL);

  const snapshot = {
    schemaVersion: 1,
    artifactKind: "seoul-station-contact-snapshot",
    sourceId: "seoul-metro-station-contact",
    snapshotId: "seoul-metro-station-contact-fixture-05",
    capturedAt: "2026-09-30T05:00:00.000Z",
    rowCount: 1,
    rows: [
      {
        seq: "11",
        stnNo: "201",
        line: "2",
        name: "시청",
        phone: "02-6110-2011",
        roadAddr: "서울특별시 중구 서소문로 125",
        jibunAddr: "서울특별시 중구 서소문동 37",
      },
    ],
  };

  const { rows } = buildStationContacts({
    snapshot,
    canonicalMappings: FIXTURE_MAPPINGS,
  });

  const insert = db.prepare(
    "INSERT INTO station_contacts (station_id, line_id, phone, phone_raw, source_snapshot_id) VALUES (?, ?, ?, ?, ?)"
  );
  for (const r of rows) {
    insert.run(r.station_id, r.line_id, r.phone, r.phone_raw, r.source_snapshot_id);
  }

  const loaded = db.prepare("SELECT * FROM station_contacts").all();
  assert.equal(loaded.length, 1);
  assert.deepEqual(loaded[0], {
    station_id: "station-a2d54a5d63d2",
    line_id: "seoul-2",
    phone: "02-6110-2011",
    phone_raw: "02-6110-2011",
    source_snapshot_id: "seoul-metro-station-contact-fixture-05",
  });
});

test("(6) 스냅샷 없음 → 빌드 실패", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "station-contact-test-"));
  try {
    await assert.rejects(
      () => loadStationContactInputs({ repositoryRoot: tempDir }),
      /station contact inputs is missing/
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
