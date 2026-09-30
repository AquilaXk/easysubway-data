import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import {
  normalizeSeoulMetroCongestion,
  parseTimeSlotMinutes,
  parsePermille,
  buildCongestionCoverageReport,
} from "./normalize-seoul-metro-congestion.mjs";
import {
  selectLatestOasUddi,
  collectSeoulMetroCongestion,
} from "./collect-seoul-metro-congestion.mjs";
import { buildSqlitePack } from "./build-datapack.mjs";

const SCHEMA_PATH = path.resolve(import.meta.dirname, "schema/catalog-schema.sql");
const POSITIONS_SNAPSHOT_PATH = path.resolve(
  import.meta.dirname,
  "sources/seoul-metro-route-map-positions-20260724.json",
);

// Hand-crafted standard row fixture with authentic Korean keys
function createSampleRow(overrides = {}) {
  return {
    "구분": "평일",
    "상하구분": "상선",
    "호선": "1호선",
    "역번호": "150",
    "역명": "서울역",
    "5시30분": "12.3",
    "6시00분": "20.0",
    "6시30분": "25.5",
    "7시00분": "30.0",
    "7시30분": "35.2",
    "8시00분": "40.0",
    "8시30분": "45.7",
    "9시00분": "50.0",
    "9시30분": "45.0",
    "10시00분": "40.0",
    "10시30분": "35.0",
    "11시00분": "30.0",
    "11시30분": "25.0",
    "12시00분": "20.0",
    "12시30분": "22.0",
    "13시00분": "24.0",
    "13시30분": "26.0",
    "14시00분": "28.0",
    "14시30분": "30.0",
    "15시00분": "32.0",
    "15시30분": "34.0",
    "16시00분": "36.0",
    "16시30분": "38.0",
    "17시00분": "40.0",
    "17시30분": "45.0",
    "18시00분": "50.0",
    "18시30분": "55.0",
    "19시00분": "48.0",
    "19시30분": "42.0",
    "20시00분": "36.0",
    "20시30분": "30.0",
    "21시00분": "25.0",
    "21시30분": "20.0",
    "22시00분": "18.0",
    "22시30분": "15.0",
    "23시00분": "12.0",
    "23시30분": "10.0",
    "00시00분": "8.0",
    "00시30분": "39.50",
    ...overrides,
  };
}

test("(1) 정상 행 → 39개 칸, 분·천분율 변환 정확(예: 00시30분 → 1470, 39.50 → 395)", async () => {
  const row = createSampleRow();
  const positionsSnapshot = JSON.parse(await readFile(POSITIONS_SNAPSHOT_PATH, "utf8"));
  const { stats, sources, report } = normalizeSeoulMetroCongestion({
    snapshot: {
      snapshotId: "seoul-metro-congestion-test-snapshot",
      datasetLabel: "서울교통공사_지하철혼잡도정보_20260630",
      capturedAt: "2026-09-30T00:00:00.000Z",
      rows: [row],
    },
    positions: positionsSnapshot.positions,
  });

  assert.equal(sources.length, 1);
  assert.equal(sources[0].source_snapshot_id, "seoul-metro-congestion-test-snapshot");
  assert.equal(sources[0].dataset_label, "서울교통공사_지하철혼잡도정보_20260630");
  assert.equal(sources[0].captured_at, "2026-09-30T00:00:00.000Z");

  assert.equal(stats.length, 39);

  // Check 5시30분 -> 330, "12.3" -> 123
  const slot330 = stats.find((s) => s.slot_start_minute === 330);
  assert.ok(slot330);
  assert.equal(slot330.station_id, "station-7457934cef72");
  assert.equal(slot330.line_id, "line-472a81add377");
  assert.equal(slot330.direction, "UP");
  assert.equal(slot330.day_type, "WEEKDAY");
  assert.equal(slot330.congestion_permille, 123);

  // Check 23시30분 -> 1410, "10.0" -> 100
  const slot1410 = stats.find((s) => s.slot_start_minute === 1410);
  assert.ok(slot1410);
  assert.equal(slot1410.congestion_permille, 100);

  // Check 00시00분 -> 1440, "8.0" -> 80
  const slot1440 = stats.find((s) => s.slot_start_minute === 1440);
  assert.ok(slot1440);
  assert.equal(slot1440.congestion_permille, 80);

  // Check 00시30분 -> 1470, "39.50" -> 395
  const slot1470 = stats.find((s) => s.slot_start_minute === 1470);
  assert.ok(slot1470);
  assert.equal(slot1470.congestion_permille, 395);
  assert.equal(slot1470.source_snapshot_id, "seoul-metro-congestion-test-snapshot");

  // Direct utility check
  assert.equal(parseTimeSlotMinutes("5시30분"), 330);
  assert.equal(parseTimeSlotMinutes("23시30분"), 1410);
  assert.equal(parseTimeSlotMinutes("00시00분"), 1440);
  assert.equal(parseTimeSlotMinutes("00시30분"), 1470);
  assert.equal(parsePermille("39.50"), 395);
  assert.equal(parsePermille("43.0"), 430);
});

test("(2) 내선·외선 방향 매핑", async () => {
  const positionsSnapshot = JSON.parse(await readFile(POSITIONS_SNAPSHOT_PATH, "utf8"));
  // Station 201 (시청, 2호선)
  const innerRow = createSampleRow({ "호선": "2호선", "역번호": "201", "상하구분": "내선" });
  const outerRow = createSampleRow({ "호선": "2호선", "역번호": "201", "상하구분": "외선" });

  const { stats } = normalizeSeoulMetroCongestion({
    snapshot: {
      snapshotId: "test-snapshot",
      datasetLabel: "test",
      capturedAt: "2026-09-30T00:00:00.000Z",
      rows: [innerRow, outerRow],
    },
    positions: positionsSnapshot.positions,
  });

  assert.equal(stats.length, 78);
  const innerSlots = stats.filter((s) => s.direction === "INNER");
  const outerSlots = stats.filter((s) => s.direction === "OUTER");
  assert.equal(innerSlots.length, 39);
  assert.equal(outerSlots.length, 39);
});

test("(3) 알 수 없는 방향·요일 제외와 개수", async () => {
  const positionsSnapshot = JSON.parse(await readFile(POSITIONS_SNAPSHOT_PATH, "utf8"));
  const badDirRow = createSampleRow({ "상하구분": "모름" });
  const badDayRow = createSampleRow({ "구분": "공휴일" });
  const validRow = createSampleRow();

  const { stats, report } = normalizeSeoulMetroCongestion({
    snapshot: {
      snapshotId: "test-snapshot",
      datasetLabel: "test",
      capturedAt: "2026-09-30T00:00:00.000Z",
      rows: [badDirRow, badDayRow, validRow],
    },
    positions: positionsSnapshot.positions,
  });

  assert.equal(stats.length, 39);
  assert.equal(report.excludedDirectionCount, 1);
  assert.equal(report.excludedDayTypeCount, 1);
  assert.equal(report.rawRowCount, 3);
  assert.equal(report.loadedCellCount, 39);
});

test("(4) 역번호 매핑 실패 제외", async () => {
  const positionsSnapshot = JSON.parse(await readFile(POSITIONS_SNAPSHOT_PATH, "utf8"));
  // Station 9999 does not exist
  const unmappedRow = createSampleRow({ "호선": "1호선", "역번호": "9999", "역명": "없는역" });
  const validRow = createSampleRow();

  const { stats, report } = normalizeSeoulMetroCongestion({
    snapshot: {
      snapshotId: "test-snapshot",
      datasetLabel: "test",
      capturedAt: "2026-09-30T00:00:00.000Z",
      rows: [unmappedRow, validRow],
    },
    positions: positionsSnapshot.positions,
  });

  assert.equal(stats.length, 39);
  assert.equal(report.unmappedStationCount, 1);
  assert.equal(report.unmappedStations[0].stationCode, "9999");
  assert.equal(report.unmappedStations[0].stationName, "없는역");
});

test("(5) 중복 키 → 실패", async () => {
  const positionsSnapshot = JSON.parse(await readFile(POSITIONS_SNAPSHOT_PATH, "utf8"));
  const row1 = createSampleRow();
  const row2 = createSampleRow(); // Exactly duplicate key

  assert.throws(
    () => normalizeSeoulMetroCongestion({
      snapshot: {
        snapshotId: "test-snapshot",
        datasetLabel: "test",
        capturedAt: "2026-09-30T00:00:00.000Z",
        rows: [row1, row2],
      },
      positions: positionsSnapshot.positions,
    }),
    /duplicate key/i,
  );
});

test("(6) OAS 최신 버전 선택(옛 형식 summary 무시, 날짜 최대 선택)", () => {
  const oasDoc = {
    paths: {
      "/api/15071311/v1/uddi:old-format": {
        get: { summary: "서울교통공사_ 혼잡도_20171231" },
      },
      "/api/15071311/v1/uddi:earlier-version": {
        get: { summary: "서울교통공사_지하철혼잡도정보_20251231" },
      },
      "/api/15071311/v1/uddi:target-latest": {
        get: { summary: "서울교통공사_지하철혼잡도정보_20260630" },
      },
      "/api/15071311/v1/uddi:unrelated": {
        get: { summary: "기타_요약_20260701" },
      },
    },
  };

  const selected = selectLatestOasUddi(oasDoc);
  assert.equal(selected.summary, "서울교통공사_지하철혼잡도정보_20260630");
  assert.equal(selected.uddi, "uddi:target-latest");
  assert.equal(selected.date, "20260630");

  // Empty or non-matching paths throws
  assert.throws(
    () => selectLatestOasUddi({ paths: {} }),
    /no matching path/i,
  );
});

test("(7) 받은 행 수 ≠ totalCount → 실패", async () => {
  const fetchImpl = async () => new Response(
    JSON.stringify({
      currentCount: 2,
      matchCount: 3,
      page: 1,
      perPage: 10,
      totalCount: 3, // claims 3
      data: [createSampleRow(), createSampleRow({ "상하구분": "하선" })], // only 2 rows
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

  await assert.rejects(
    () => collectSeoulMetroCongestion({
      serviceKey: "test-valid-key",
      fetchImpl,
      targetUddi: "uddi:test",
      datasetLabel: "test",
    }),
    /received row count.*totalCount/i,
  );
});

test("(8) 운영 빌드에서 두 테이블에 행이 들어감", async () => {
  const schema = await readFile(SCHEMA_PATH, "utf8");
  const tempDir = await mkdtemp(path.join(tmpdir(), "congestion-build-test-"));
  const dbPath = path.join(tempDir, "test.sqlite");

  try {
    const pack = {
      id: "capital",
      version: 1,
      artifactKind: "production",
      operators: [{ id: "op-1", nameKo: "서울교통공사" }],
      lines: [{ id: "line-472a81add377", operatorId: "op-1", nameKo: "1호선" }],
      stations: [
        {
          id: "station-7457934cef72",
          nameKo: "서울역",
          normalizedName: "서울역",
        },
      ],
      stationLines: [
        {
          stationId: "station-7457934cef72",
          lineId: "line-472a81add377",
          lineSequence: 1,
        },
      ],
    };

    // buildSqlitePack in production mode reads the congestion snapshot and inserts rows
    buildSqlitePack(dbPath, schema, pack, new Map(), {
      repositoryRoot: path.resolve(import.meta.dirname, "../.."),
    });

    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const statsCount = db.prepare("SELECT COUNT(*) AS cnt FROM station_congestion_stats").get().cnt;
      const sourcesCount = db.prepare("SELECT COUNT(*) AS cnt FROM station_congestion_sources").get().cnt;
      assert.ok(statsCount > 0, "station_congestion_stats must have rows");
      assert.ok(sourcesCount > 0, "station_congestion_sources must have rows");
    } finally {
      db.close();
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("(9) 스냅샷 없음 → 빌드 실패", async () => {
  const schema = await readFile(SCHEMA_PATH, "utf8");
  const tempDir = await mkdtemp(path.join(tmpdir(), "congestion-empty-test-"));
  const emptySourcesDir = path.join(tempDir, "tools/datapack/sources");
  const dbPath = path.join(tempDir, "test.sqlite");

  try {
    const pack = {
      id: "capital",
      version: 1,
      artifactKind: "production",
      operators: [{ id: "op-1", nameKo: "서울교통공사" }],
      lines: [{ id: "line-472a81add377", operatorId: "op-1", nameKo: "1호선" }],
      stations: [
        {
          id: "station-7457934cef72",
          nameKo: "서울역",
          normalizedName: "서울역",
        },
      ],
      stationLines: [
        {
          stationId: "station-7457934cef72",
          lineId: "line-472a81add377",
          lineSequence: 1,
        },
      ],
    };

    // With tempDir as repositoryRoot where sources/ has no congestion snapshot
    assert.throws(
      () => buildSqlitePack(dbPath, schema, pack, new Map(), { repositoryRoot: tempDir }),
      /missing.*congestion.*snapshot/i,
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("malformed DATA_GO_KR_SERVICE_KEY는 provider 호출과 output 전에 거부한다", async () => {
  let calls = 0;
  await assert.rejects(
    () => collectSeoulMetroCongestion({
      serviceKey: "invalid%ZZ",
      fetchImpl: async () => { calls += 1; },
    }),
    /DATA_GO_KR_SERVICE_KEY is invalid/,
  );
  assert.equal(calls, 0);
});
