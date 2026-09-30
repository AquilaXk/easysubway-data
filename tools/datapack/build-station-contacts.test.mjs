import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  bindStationContacts,
  buildStationContacts,
  loadStationContactInputs,
  normalizePhoneNumber,
} from "./build-station-contacts.mjs";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

// 서울교통공사 역코드 membership 결속 결과("<호선>:<역번호>" → 팩 역·노선)를 손으로 적은 fixture
const FIXTURE_BINDINGS = new Map([
  ["2:201", { stationId: "station-a2d54a5d63d2", lineId: "seoul-2" }],
  ["1:151", { stationId: "station-a2d54a5d63d2", lineId: "seoul-1" }],
  ["4:425", { stationId: "station-ae0e5bd1256d", lineId: "seoul-4" }],
]);

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
    stationBindings: FIXTURE_BINDINGS,
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
    stationBindings: FIXTURE_BINDINGS,
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
    stationBindings: FIXTURE_BINDINGS,
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
    stationBindings: FIXTURE_BINDINGS,
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
    stationBindings: FIXTURE_BINDINGS,
  });

  const insert = db.prepare(
    "INSERT INTO station_contacts (station_id, line_id, phone, phone_raw, source_snapshot_id) VALUES (?, ?, ?, ?, ?)"
  );
  for (const r of rows) {
    insert.run(r.station_id, r.line_id, r.phone, r.phone_raw, r.source_snapshot_id);
  }

  const loaded = db.prepare("SELECT * FROM station_contacts").all();
  assert.equal(loaded.length, 1);
  assert.deepEqual({ ...loaded[0] }, {
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

test("같은 역·노선의 같은 번호 중복은 한 행으로 세고, 다른 번호면 빌드가 실패한다(#845 리뷰 F2)", () => {
  const snapshot = (phones) => ({
    sourceId: "seoul-metro-station-contact",
    snapshotId: "seoul-metro-station-contact-fixture-dup",
    rows: phones.map((phone, index) => ({ seq: String(index + 1), stnNo: "201", line: "2", name: "시청", phone })),
  });

  const identical = buildStationContacts({ snapshot: snapshot(["02-6110-2011", "02-6110-2011"]), stationBindings: FIXTURE_BINDINGS });
  assert.equal(identical.rows.length, 1);
  assert.equal(identical.report.duplicateIdenticalCount, 1);

  assert.throws(
    () => buildStationContacts({ snapshot: snapshot(["02-6110-2011", "02-6110-2019"]), stationBindings: FIXTURE_BINDINGS }),
    /conflicting station contact numbers for station-a2d54a5d63d2 seoul-2/,
  );
});

test("snapshotId가 없으면 합성 값으로 채우지 않고 실패한다(#845 리뷰 F2)", () => {
  assert.throws(
    () => buildStationContacts({
      snapshot: { sourceId: "seoul-metro-station-contact", rows: [] },
      stationBindings: FIXTURE_BINDINGS,
    }),
    /station contact snapshotId is required/,
  );
});

test("실제 커밋된 원천을 운영 정본 팩에 역코드 membership으로 결속하면 1~8호선이 적재된다(#845 리뷰 F1)", async () => {
  const inputs = await loadStationContactInputs({ repositoryRoot: process.cwd() });
  const pack = JSON.parse(await readFile(path.join(process.cwd(), "tools/datapack/release/nationwide-production-canonical-pack.json"), "utf8"))
    .packs.find(({ id }) => id === "nationwide");
  const result = bindStationContacts({ ...inputs, pack });
  assert.equal(result.report.totalRawRows, 289);
  assert.equal(result.report.validRowsLoaded, 276);
  assert.equal(result.report.excludedRowsTotal, 13);
  assert.equal(result.report.exclusionsByReason.MAPPING_NOT_FOUND, 13);
  assert.equal(result.rows.length, 276);
  assert.equal(result.report.uniqueStationCount, 240);
  assert.equal(result.report.uniqueLineCount, 8);
  // 미매핑은 역코드 membership에 없는 9호선 2·3단계(역번호 4126~4138)뿐이다.
  assert.deepEqual(
    result.exclusions.map(({ row }) => `${row.line}:${row.stnNo}`),
    Array.from({ length: 13 }, (_, index) => `9:${4126 + index}`),
  );

  // Phone format is guaranteed across all rows
  for (const row of result.rows) {
    assert.match(row.phone, /^0\d{1,2}-\d{3,4}-\d{4}$/);
    assert.ok(row.station_id.startsWith("station-"));
    assert.ok(row.line_id.length > 0);
  }
});

