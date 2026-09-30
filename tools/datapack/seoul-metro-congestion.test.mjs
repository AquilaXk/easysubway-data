import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import {
  normalizeSeoulMetroCongestion,
  parseTimeSlotMinutes,
  parsePermille,
  buildCongestionCoverageReport,
  buildStationBindings,
} from "./normalize-seoul-metro-congestion.mjs";
import {
  selectLatestOasUddi,
  collectSeoulMetroCongestion,
} from "./collect-seoul-metro-congestion.mjs";
import { buildSqlitePack } from "./build-datapack.mjs";

const SCHEMA_PATH = path.resolve(import.meta.dirname, "schema/catalog-schema.sql");
const CANONICAL_PACK_PATH = path.resolve(import.meta.dirname, "release/nationwide-production-canonical-pack.json");
const MEMBERSHIP_PATH = path.resolve(
  import.meta.dirname,
  "sources/seoul-station-code-membership-20260909T041501Z.json",
);
const CONGESTION_SNAPSHOT_PATH = path.resolve(
  import.meta.dirname,
  "sources/seoul-metro-congestion-20260930T020244Z.json",
);

// Hand-crafted standard row fixture with authentic Korean keys
async function canonicalPack() {
  const doc = JSON.parse(await readFile(CANONICAL_PACK_PATH, "utf8"));
  return doc.packs.find(({ id }) => id === "nationwide");
}

async function loadBindings() {
  return buildStationBindings({
    membership: JSON.parse(await readFile(MEMBERSHIP_PATH, "utf8")),
    pack: await canonicalPack(),
  });
}

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
  const stationBindings = await loadBindings();
  const { stats, sources, report } = normalizeSeoulMetroCongestion({
    snapshot: {
      snapshotId: "seoul-metro-congestion-test-snapshot",
      datasetLabel: "서울교통공사_지하철혼잡도정보_20260630",
      capturedAt: "2026-09-30T00:00:00.000Z",
      rows: [row],
    },
    stationBindings,
  });

  assert.equal(sources.length, 1);
  assert.equal(sources[0].source_snapshot_id, "seoul-metro-congestion-test-snapshot");
  assert.equal(sources[0].dataset_label, "서울교통공사_지하철혼잡도정보_20260630");
  assert.equal(sources[0].captured_at, "2026-09-30T00:00:00.000Z");

  assert.equal(stats.length, 39);

  // Check 5시30분 -> 330, "12.3" -> 123
  const slot330 = stats.find((s) => s.slot_start_minute === 330);
  assert.ok(slot330);
  assert.equal(slot330.station_id, "station-2af75c3d707b");
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
  const stationBindings = await loadBindings();
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
    stationBindings,
  });

  assert.equal(stats.length, 78);
  const innerSlots = stats.filter((s) => s.direction === "INNER");
  const outerSlots = stats.filter((s) => s.direction === "OUTER");
  assert.equal(innerSlots.length, 39);
  assert.equal(outerSlots.length, 39);
});

test("(3) 알 수 없는 방향·요일 제외와 개수", async () => {
  const stationBindings = await loadBindings();
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
    stationBindings,
  });

  assert.equal(stats.length, 39);
  assert.equal(report.excludedDirectionCount, 1);
  assert.equal(report.excludedDayTypeCount, 1);
  assert.equal(report.rawRowCount, 3);
  assert.equal(report.loadedCellCount, 39);
});

test("(4) 역번호 매핑 실패 제외", async () => {
  const stationBindings = await loadBindings();
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
    stationBindings,
  });

  assert.equal(stats.length, 39);
  assert.equal(report.unmappedStationCount, 1);
  assert.equal(report.unmappedStations[0].stationCode, "9999");
  assert.equal(report.unmappedStations[0].stationName, "없는역");
});

test("(5) 중복 키 → 실패", async () => {
  const stationBindings = await loadBindings();
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
      stationBindings,
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
    // buildSqlitePack in production mode reads the congestion snapshot and inserts rows
    buildSqlitePack(dbPath, schema, await canonicalPackSubset(), new Map(), {
      repositoryRoot: path.resolve(import.meta.dirname, "../.."),
    });

    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const statsCount = db.prepare("SELECT COUNT(*) AS cnt FROM station_congestion_stats").get().cnt;
      const sourcesCount = db.prepare("SELECT COUNT(*) AS cnt FROM station_congestion_sources").get().cnt;
      assert.ok(statsCount > 0, "station_congestion_stats must have rows");
      assert.equal(sourcesCount, 1);
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
          id: "station-2af75c3d707b",
          nameKo: "서울역",
          normalizedName: "서울역",
        },
      ],
      stationLines: [
        {
          stationId: "station-2af75c3d707b",
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

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

test("F1 마곡·발산·암사역사공원은 승인된 역번호 membership으로 현재 팩 station_id를 얻는다", async () => {
  const stationBindings = await loadBindings();
  const rows = [
    createSampleRow({ "호선": "5호선", "역번호": "2515", "역명": "마곡" }),
    createSampleRow({ "호선": "5호선", "역번호": "2516", "역명": "발산" }),
    createSampleRow({ "호선": "8호선", "역번호": "2810", "역명": "암사역사공원" }),
  ];
  const { stats, report } = normalizeSeoulMetroCongestion({
    snapshot: { snapshotId: "test-snapshot", datasetLabel: "test", capturedAt: "2026-09-30T00:00:00.000Z", rows },
    stationBindings,
  });
  assert.equal(report.unmappedStationCount, 0);
  assert.deepEqual([...new Set(stats.map((s) => `${s.station_id}|${s.line_id}`))].sort(), [
    "station-4f3000848d11|line-80fc4d5350d4",
    "station-51cc5043a2d8|line-2b2d9eaa53d0",
    "station-e034b2889e71|line-80fc4d5350d4",
  ]);
});

test("F1 membership 위변조(records 해시 불일치)와 팩에 없는 역은 즉시 실패한다", async () => {
  const membership = JSON.parse(await readFile(MEMBERSHIP_PATH, "utf8"));
  const pack = await canonicalPack();
  const tampered = structuredClone(membership);
  tampered.records[0].canonicalStationName = "다른역";
  assert.throws(() => buildStationBindings({ membership: tampered, pack }), /recordsSha256/);
  const emptyPack = { ...pack, stations: pack.stations.filter(({ id }) => id !== "station-e034b2889e71") };
  assert.throws(() => buildStationBindings({ membership, pack: emptyPack }), /마곡.*exactly one pack station/);
});

test("F1 실제 스냅샷의 매핑 불가 코드는 손으로 검증한 6개뿐이다(2호선 까치산 260은 원천 membership에 없음)", async () => {
  const stationBindings = await loadBindings();
  const snapshot = JSON.parse(await readFile(CONGESTION_SNAPSHOT_PATH, "utf8"));
  const { report } = normalizeSeoulMetroCongestion({
    snapshot,
    stationBindings,
  });
  assert.deepEqual(
    report.unmappedStations.map((u) => `${u.line}:${u.stationCode}:${u.stationName}`).sort(),
    ["2:260:까치산", "2:9001:성수E", "2:9002:성수", "2:9003:신도림", "5:9005:강동(마천)", "6:9006:응암S"],
  );
});

test("F3 capturedAt 또는 datasetLabel이 없으면 합성값 대신 실패한다", async () => {
  const stationBindings = await loadBindings();
  const base = { snapshotId: "test-snapshot", rows: [createSampleRow()] };
  assert.throws(() => normalizeSeoulMetroCongestion({
    snapshot: { ...base, datasetLabel: "test" }, stationBindings,
  }), /capturedAt/);
  assert.throws(() => normalizeSeoulMetroCongestion({
    snapshot: { ...base, capturedAt: "2026-09-30T00:00:00.000Z" }, stationBindings,
  }), /datasetLabel/);
  assert.throws(() => normalizeSeoulMetroCongestion({
    snapshot: { ...base, capturedAt: "2026-09-30T00:00:00.000Z", datasetLabel: "  " }, stationBindings,
  }), /datasetLabel/);
});

function odcloudResponse(body) {
  return async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

test("F4 totalCount가 없거나 숫자가 아니면 수집이 실패한다", async () => {
  for (const totalCount of [undefined, "1", null]) {
    const body = { data: [createSampleRow()], matchCount: 1 };
    if (totalCount !== undefined) body.totalCount = totalCount;
    await assert.rejects(
      () => collectSeoulMetroCongestion({
        serviceKey: "test-valid-key", fetchImpl: odcloudResponse(body), targetUddi: "uddi:test", datasetLabel: "test",
      }),
      /totalCount/,
    );
  }
});

test("F4 원본 응답 본문을 스냅샷 옆에 보관하고 rawSha256과 일치시킨다", async () => {
  const outputDir = await mkdtemp(path.join(tmpdir(), "congestion-raw-"));
  try {
    const body = { currentCount: 1, matchCount: 1, page: 1, perPage: 2000, totalCount: 1, data: [createSampleRow()] };
    const rawText = JSON.stringify(body);
    const snap = await collectSeoulMetroCongestion({
      serviceKey: "test-valid-key",
      fetchImpl: async () => new Response(rawText, { status: 200, headers: { "content-type": "application/json" } }),
      targetUddi: "uddi:test",
      datasetLabel: "test",
      outputDir,
      now: new Date("2026-09-30T01:49:33.343Z"),
    });
    assert.equal(snap.rawSha256, sha256(rawText));
    assert.deepEqual((await readdir(outputDir)).sort(), [
      "seoul-metro-congestion-20260930T014933Z.json",
      "seoul-metro-congestion-20260930T014933Z.raw.json",
    ]);
    const archived = await readFile(path.join(outputDir, "seoul-metro-congestion-20260930T014933Z.raw.json"), "utf8");
    assert.equal(archived, rawText);
    assert.equal(sha256(archived), snap.rawSha256);
    assert.ok(!archived.includes("test-valid-key"));
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("F4 응답 본문에 서비스 키가 들어 있으면 보관하지 않고 실패한다", async () => {
  const outputDir = await mkdtemp(path.join(tmpdir(), "congestion-leak-"));
  try {
    const body = { totalCount: 1, data: [createSampleRow({ "역명": "test-valid-key" })] };
    await assert.rejects(
      () => collectSeoulMetroCongestion({
        serviceKey: "test-valid-key", fetchImpl: odcloudResponse(body), targetUddi: "uddi:test", datasetLabel: "test", outputDir,
      }),
      /credential/i,
    );
    assert.deepEqual(await readdir(outputDir).catch(() => []), []);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

async function buildFixtureRoot({ mutateSnapshot, mutateRaw, dropRaw } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "congestion-root-"));
  const sourcesDir = path.join(root, "tools/datapack/sources");
  await mkdir(sourcesDir, { recursive: true });
  await writeFile(path.join(sourcesDir, path.basename(MEMBERSHIP_PATH)), await readFile(MEMBERSHIP_PATH));
  const snapshot = JSON.parse(await readFile(CONGESTION_SNAPSHOT_PATH, "utf8"));
  const rawName = `${snapshot.snapshotId}.raw.json`;
  const rawText = await readFile(path.join(path.dirname(CONGESTION_SNAPSHOT_PATH), rawName), "utf8");
  if (mutateSnapshot) mutateSnapshot(snapshot);
  await writeFile(path.join(sourcesDir, `${snapshot.snapshotId}.json`), `${JSON.stringify(snapshot)}\n`);
  if (!dropRaw) await writeFile(path.join(sourcesDir, rawName), mutateRaw ? mutateRaw(rawText) : rawText);
  return root;
}

async function canonicalPackSubset() {
  const capital = await canonicalPack();
  return {
    id: "nationwide", version: 1, artifactKind: "production",
    operators: capital.operators, lines: capital.lines, stations: capital.stations, stationLines: capital.stationLines,
  };
}

async function buildWith(root, packOverride) {
  const schema = await readFile(SCHEMA_PATH, "utf8");
  const tempDir = await mkdtemp(path.join(tmpdir(), "congestion-db-"));
  try {
    const pack = packOverride ?? await canonicalPackSubset();
    buildSqlitePack(path.join(tempDir, "test.sqlite"), schema, pack, new Map(), { repositoryRoot: root });
    const db = new DatabaseSync(path.join(tempDir, "test.sqlite"), { readOnly: true });
    try {
      return db.prepare("SELECT COUNT(*) AS cnt FROM station_congestion_stats").get().cnt;
    } finally {
      db.close();
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
}

test("F5 정상 스냅샷은 실제 canonical 팩에 전부 적재되고 마곡이 포함된다", async () => {
  const root = await buildFixtureRoot();
  const count = await buildWith(root);
  assert.ok(count > 60000, `expected full load, got ${count}`);
});

test("F5 contentSha256이 어긋난 스냅샷은 빌드가 실패한다", async () => {
  const root = await buildFixtureRoot({ mutateSnapshot: (s) => { s.rows[0]["5시30분"] = "99.9"; } });
  await assert.rejects(async () => buildWith(root), /contentSha256/);
});

test("F5 rowCount가 어긋난 스냅샷은 빌드가 실패한다", async () => {
  const root = await buildFixtureRoot({ mutateSnapshot: (s) => { s.rowCount += 1; } });
  await assert.rejects(async () => buildWith(root), /rowCount/);
});

test("F5 원본 응답 보관본이 없거나 rawSha256과 다르면 빌드가 실패한다", async () => {
  const missing = await buildFixtureRoot({ dropRaw: true });
  await assert.rejects(async () => buildWith(missing), /raw/i);
  const tampered = await buildFixtureRoot({ mutateRaw: (t) => `${t} ` });
  await assert.rejects(async () => buildWith(tampered), /rawSha256/);
});

test("F5 팩 stations에 없는 station_id가 있으면 빌드가 실패한다", async () => {
  const root = await buildFixtureRoot();
  const pack = await canonicalPackSubset();
  pack.stations = pack.stations.filter(({ id }) => id !== "station-e034b2889e71");
  pack.stationLines = pack.stationLines.filter(({ stationId }) => stationId !== "station-e034b2889e71");
  await assert.rejects(async () => buildWith(root, pack), /마곡.*exactly one pack station/);
});

test("F5 팩 station_lines에 없는 (station, line) 쌍이 있으면 빌드가 실패한다", async () => {
  const root = await buildFixtureRoot();
  const pack = await canonicalPackSubset();
  pack.stationLines = pack.stationLines.filter(
    ({ stationId, lineId }) => !(stationId === "station-e034b2889e71" && lineId === "line-80fc4d5350d4"),
  );
  await assert.rejects(async () => buildWith(root, pack), /마곡.*exactly one pack station/);
});

test("F5 비운영 팩이 싣는 혼잡도 행도 팩 테이블에 없는 id면 실패한다", async () => {
  const root = await buildFixtureRoot();
  const pack = await canonicalPackSubset();
  pack.artifactKind = "fixture";
  const stat = (stationId, lineId) => ({
    station_id: stationId, line_id: lineId, direction: "UP", day_type: "WEEKDAY",
    slot_start_minute: 330, congestion_permille: 100, source_snapshot_id: "s",
  });
  pack.stationCongestionSources = [{ source_snapshot_id: "s", dataset_label: "d", captured_at: "2026-09-30T00:00:00.000Z", attribution: "a" }];
  pack.stationCongestionStats = [stat("station-2af75c3d707b", "line-472a81add377"), stat("station-missing", "line-472a81add377")];
  await assert.rejects(async () => buildWith(root, pack), /station station-missing/);
  const root2 = await buildFixtureRoot();
  pack.stationCongestionStats = [stat("station-2af75c3d707b", "line-missing")];
  await assert.rejects(async () => buildWith(root2, pack), /line line-missing/);
  const root3 = await buildFixtureRoot();
  pack.stationCongestionStats = [stat("station-e034b2889e71", "line-472a81add377")];
  await assert.rejects(async () => buildWith(root3, pack), /station_lines station-e034b2889e71\|line-472a81add377/);
});

test("F5 팩 lines에 없는 line_id가 있으면 빌드가 실패한다", async () => {
  const root = await buildFixtureRoot();
  const pack = await canonicalPackSubset();
  pack.lines = pack.lines.filter(({ id }) => id !== "line-472a81add377");
  pack.stationLines = pack.stationLines.filter(({ lineId }) => lineId !== "line-472a81add377");
  await assert.rejects(async () => buildWith(root, pack), /line-472a81add377/);
});
