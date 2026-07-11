import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { gunzipSync, gzipSync } from "node:zlib";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "../..");
const buildLineTracksScript = path.resolve(import.meta.dirname, "build-route-map-line-tracks.mjs");
const applyLineTracksScript = path.resolve(import.meta.dirname, "apply-route-map-line-tracks.mjs");
const auditRouteMapScript = path.resolve(import.meta.dirname, "audit-route-map.mjs");

// audit-route-map을 temp fixture + line-tracks 문서로 실행하고 report JSON을 돌려준다.
// --fail-on으로 exit 1이 나도 stdout에 report가 있으므로 그대로 파싱한다.
async function runAuditRouteMap({ fixture, lineTracks = [], reviewedLineTracks = null, failOn = [] }) {
  const dir = await mkdtemp(path.join(tmpdir(), "easysubway-audit-tracks-"));
  try {
    const fixturePath = path.join(dir, "fixture.json");
    await writeFile(fixturePath, JSON.stringify(fixture));
    const trackArgs = [];
    for (let i = 0; i < lineTracks.length; i += 1) {
      const trackPath = path.join(dir, `line-tracks-${i}.json`);
      await writeFile(trackPath, JSON.stringify(lineTracks[i]));
      trackArgs.push("--line-tracks", trackPath);
    }
    if (reviewedLineTracks != null) {
      const reviewedPath = path.join(dir, "reviewed-line-tracks.json");
      await writeFile(reviewedPath, JSON.stringify(reviewedLineTracks));
      trackArgs.push("--reviewed-line-tracks", reviewedPath);
    }
    const failArgs = failOn.length > 0 ? ["--fail-on", failOn.join(",")] : [];
    let stdout;
    try {
      ({ stdout } = await execFileAsync(
        "node",
        [auditRouteMapScript, "--fixture", fixturePath, ...trackArgs, ...failArgs],
        { cwd: root, maxBuffer: 4 * 1024 * 1024 },
      ));
    } catch (error) {
      stdout = error.stdout; // --fail-on exit 1이어도 report는 stdout에 있다.
    }
    return JSON.parse(stdout);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// temp .gz pack(route_map_positions 라이선스 메타 포함) + index.json + tracks.json을
// 만들어 apply-route-map-line-tracks를 실행하고, 기록된 route_map_line_tracks 행을
// region 순으로 돌려준다. args로 --check 등을 전달할 수 있다.
async function runApplyLineTracks({ region, positions, tracksDocs, args = [] }) {
  const dir = await mkdtemp(path.join(tmpdir(), "easysubway-apply-tracks-"));
  try {
    const sqlitePath = path.join(dir, "capital.sqlite");
    const db = new DatabaseSync(sqlitePath);
    db.exec(
      `CREATE TABLE route_map_positions (
        station_id TEXT NOT NULL, line_id TEXT NOT NULL, region TEXT NOT NULL,
        x INTEGER NOT NULL, y INTEGER NOT NULL,
        source_id TEXT NOT NULL, source_name TEXT NOT NULL, source_url TEXT NOT NULL,
        license TEXT NOT NULL, license_status TEXT NOT NULL,
        commercial_use_allowed INTEGER NOT NULL, attribution_required INTEGER NOT NULL
      )`,
    );
    const insert = db.prepare(
      `INSERT INTO route_map_positions
       (station_id, line_id, region, x, y, source_id, source_name, source_url,
        license, license_status, commercial_use_allowed, attribution_required)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const p of positions) {
      insert.run(p.station_id, p.line_id, region, p.x ?? 0, p.y ?? 0, p.source_id, p.source_name,
        p.source_url, p.license, p.license_status, p.commercial_use_allowed, p.attribution_required);
    }
    db.close();
    const packPath = path.join(dir, "capital.sqlite.gz");
    await writeFile(packPath, gzipSync(await readFile(sqlitePath), { level: 9, mtime: 0 }));
    const indexPath = path.join(dir, "index.json");
    await writeFile(indexPath, `${JSON.stringify({ packs: [{ id: "capital", sha256: "old", sqliteSha256: "old", byteSize: 0 }] }, null, 2)}\n`);
    const trackArgs = [];
    for (let i = 0; i < tracksDocs.length; i += 1) {
      const trackPath = path.join(dir, `tracks-${i}.json`);
      await writeFile(trackPath, JSON.stringify(tracksDocs[i]));
      trackArgs.push("--tracks", trackPath);
    }
    await execFileAsync(
      "node",
      [applyLineTracksScript, "--pack", packPath, "--index", indexPath, ...trackArgs, ...args],
      { cwd: root, maxBuffer: 4 * 1024 * 1024 },
    );
    const readback = path.join(dir, "readback.sqlite");
    await writeFile(readback, gunzipSync(await readFile(packPath)));
    const verifyDb = new DatabaseSync(readback);
    let rows = [];
    try {
      const hasTable = verifyDb
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='route_map_line_tracks'")
        .get();
      if (hasTable) {
        rows = verifyDb
          .prepare("SELECT * FROM route_map_line_tracks WHERE region = ? ORDER BY line_id, track_index")
          .all(region);
      }
    } finally {
      verifyDb.close();
    }
    const index = JSON.parse(await readFile(indexPath, "utf8"));
    return { rows, indexCapital: index.packs.find((pack) => pack.id === "capital") };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// build-route-map-line-tracks를 temp pack + geometry로 실행하고 stdout JSON을 돌려준다.
// route_map_positions는 build가 SELECT하는 컬럼(station_id/line_id/region/x/y)만 만든다.
async function runBuildLineTracks({ geometry, region, stations, args = [] }) {
  const dir = await mkdtemp(path.join(tmpdir(), "easysubway-line-tracks-test-"));
  try {
    const packPath = path.join(dir, "pack.sqlite");
    const db = new DatabaseSync(packPath);
    db.exec(
      `CREATE TABLE route_map_positions (
        station_id TEXT NOT NULL,
        line_id TEXT NOT NULL,
        region TEXT NOT NULL,
        x INTEGER NOT NULL,
        y INTEGER NOT NULL
      )`,
    );
    const insert = db.prepare(
      "INSERT INTO route_map_positions (station_id, line_id, region, x, y) VALUES (?, ?, ?, ?, ?)",
    );
    for (const station of stations) {
      insert.run(station.station_id, station.line_id, region, station.x, station.y);
    }
    db.close();
    const geometryPath = path.join(dir, "geometry.json");
    await writeFile(geometryPath, JSON.stringify(geometry));
    const { stdout } = await execFileAsync(
      "node",
      [buildLineTracksScript, "--geometry", geometryPath, "--pack", packPath, "--region", region, ...args],
      { cwd: root, maxBuffer: 4 * 1024 * 1024 },
    );
    return JSON.parse(stdout);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// --source pack-down-path 모드용: route_map_positions(down_path)+station_lines(line_sequence)를
// 만들고 실행한다(앱 drift_station_repository의 조회 구조와 동일).
async function runBuildLineTracksFromPack({ region, rows, args = [] }) {
  const dir = await mkdtemp(path.join(tmpdir(), "easysubway-line-tracks-pack-"));
  try {
    const packPath = path.join(dir, "pack.sqlite");
    const db = new DatabaseSync(packPath);
    db.exec(
      `CREATE TABLE route_map_positions (
        station_id TEXT NOT NULL,
        line_id TEXT NOT NULL,
        region TEXT NOT NULL,
        x INTEGER NOT NULL,
        y INTEGER NOT NULL,
        down_path TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE station_lines (
        station_id TEXT NOT NULL,
        line_id TEXT NOT NULL,
        line_sequence INTEGER NOT NULL
      )`,
    );
    const insertPosition = db.prepare(
      "INSERT INTO route_map_positions (station_id, line_id, region, x, y, down_path) VALUES (?, ?, ?, ?, ?, ?)",
    );
    const insertLine = db.prepare(
      "INSERT INTO station_lines (station_id, line_id, line_sequence) VALUES (?, ?, ?)",
    );
    for (const row of rows) {
      insertPosition.run(row.station_id, row.line_id, region, row.x, row.y, row.down_path ?? "");
      insertLine.run(row.station_id, row.line_id, row.sequence);
    }
    db.close();
    const { stdout } = await execFileAsync(
      "node",
      [buildLineTracksScript, "--source", "pack-down-path", "--pack", packPath, "--region", region, ...args],
      { cwd: root, maxBuffer: 4 * 1024 * 1024 },
    );
    return JSON.parse(stdout);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// svg-strokes 모드 + 0표 노선 down_path 완충 검증용: route_map_positions(down_path)+
// station_lines(line_sequence)를 실제 팩 스키마대로 만들고 geometry로 실행한다.
async function runBuildLineTracksWithDownPath({ geometry, region, rows, args = [] }) {
  const dir = await mkdtemp(path.join(tmpdir(), "easysubway-line-tracks-fill-"));
  try {
    const packPath = path.join(dir, "pack.sqlite");
    const db = new DatabaseSync(packPath);
    db.exec(
      `CREATE TABLE route_map_positions (
        station_id TEXT NOT NULL, line_id TEXT NOT NULL, region TEXT NOT NULL,
        x INTEGER NOT NULL, y INTEGER NOT NULL, down_path TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE station_lines (
        station_id TEXT NOT NULL, line_id TEXT NOT NULL, line_sequence INTEGER NOT NULL
      )`,
    );
    const insertPosition = db.prepare(
      "INSERT INTO route_map_positions (station_id, line_id, region, x, y, down_path) VALUES (?, ?, ?, ?, ?, ?)",
    );
    const insertLine = db.prepare(
      "INSERT INTO station_lines (station_id, line_id, line_sequence) VALUES (?, ?, ?)",
    );
    for (const row of rows) {
      insertPosition.run(row.station_id, row.line_id, region, row.x, row.y, row.down_path ?? "");
      insertLine.run(row.station_id, row.line_id, row.sequence);
    }
    db.close();
    const geometryPath = path.join(dir, "geometry.json");
    await writeFile(geometryPath, JSON.stringify(geometry));
    const { stdout } = await execFileAsync(
      "node",
      [buildLineTracksScript, "--geometry", geometryPath, "--pack", packPath, "--region", region, ...args],
      { cwd: root, maxBuffer: 4 * 1024 * 1024 },
    );
    return JSON.parse(stdout);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("structured route map contract pins nationwide vector-rendered layers", async () => {
  const contract = JSON.parse(
    await readFile(
      path.join(root, "tools/route-map/structured-route-map-contract.json"),
      "utf8",
    ),
  );
  const schema = await readFile(
    path.join(root, "tools/datapack/schema/catalog-schema.sql"),
    "utf8",
  );
  const fixture = JSON.parse(
    await readFile(
      path.join(root, "tools/datapack/fixtures/catalog-fixture.json"),
      "utf8",
    ),
  );

  assert.equal(contract.schemaVersion, 1);
  assert.equal(contract.artifactKind, "structured-route-map-contract");
  assert.deepEqual(contract.regions, ["수도권", "부산", "대구", "광주", "대전"]);
  assert.equal(contract.releaseGate.wholePdfOrSvgZoomRendererAllowed, false);
  assert.deepEqual(
    contract.layers.map((layer) => layer.id),
    ["line_geometry", "station_nodes", "transfer_groups", "station_labels"],
  );
  assert.deepEqual(
    contract.layers.find((layer) => layer.id === "line_geometry").requiredFields,
    ["region", "line_id", "track_index", "path"],
  );
  assert.deepEqual(
    contract.layers.find((layer) => layer.id === "line_geometry").source,
    ["route_map_line_tracks"],
  );
  assert.ok(
    /track 직접 렌더/.test(
      contract.layers.find((layer) => layer.id === "line_geometry").deriveRule,
    ),
    "line_geometry deriveRule은 track 직접 렌더를 명시해야 한다",
  );
  assert.ok(
    Array.isArray(contract.routeMapLineTracksColumns) &&
      contract.routeMapLineTracksColumns.includes("path"),
    "routeMapLineTracksColumns에 path가 있어야 한다",
  );
  assert.equal(
    contract.layers.find((layer) => layer.id === "station_nodes").featureId,
    "{region}:{station_id}:{line_id}",
  );
  assert.deepEqual(
    contract.layers.find((layer) => layer.id === "station_labels").priority,
    ["transfer", "major", "regular"],
  );
  assert.equal(
    contract.layers.find((layer) => layer.id === "station_labels").majorRule,
    "환승역이 아니어도 지역별 공식 노선도에서 주요 거점으로 별도 검수된 역을 major로 둔다. 별도 검수값이 없으면 regular다.",
  );
  assert.equal(
    contract.layers.find((layer) => layer.id === "station_labels").renderRule,
    "데이터에는 역명을 보관하되 화면에는 zoom과 collision 결과로 필요한 라벨만 그린다.",
  );
  assert.equal(
    contract.packSourceOfTruth.routeMapRegionPack,
    "지역별 datapack의 route_map_positions를 우선한다.",
  );

  const lineGeometry = contract.layers.find((layer) => layer.id === "line_geometry");
  assert.deepEqual(lineGeometry.linearParameter.range, [0, 1]);
  assert.deepEqual(lineGeometry.linearParameter.directions, ["up", "down"]);
  assert.equal(lineGeometry.linearParameter.field, "t");
  assert.ok(
    /shape_dist_traveled/.test(lineGeometry.linearParameter.basis),
    "linearParameter must anchor to GTFS shape_dist_traveled 방식",
  );

  assert.deepEqual(
    contract.lineStationProgression.requiredFields,
    ["region", "line_id", "station_id", "direction", "t"],
  );
  assert.equal(
    contract.lineStationProgression.featureId,
    "{region}:{line_id}:{direction}:{station_id}",
  );
  assert.ok(
    /line path 선형 파라미터만으로 좌표 계산 가능/.test(
      contract.lineStationProgression.rendererContract,
    ),
    "renderer가 line path + 역별 t만으로 좌표를 계산할 수 있어야 함",
  );

  assert.match(
    contract.realtimeOverlayHook.joinPath.line,
    /realtime_provider_line_mappings/,
  );
  assert.match(
    contract.realtimeOverlayHook.joinPath.station,
    /realtime_provider_station_mappings/,
  );
  assert.ok(
    /datapack 밖/.test(contract.realtimeOverlayHook.payloadLocation),
    "실시간 payload는 datapack 밖이어야 함",
  );
  for (const providerTable of [
    "realtime_provider_line_mappings",
    "realtime_provider_station_mappings",
  ]) {
    assert.match(
      schema,
      new RegExp(`CREATE TABLE ${providerTable} \\(`),
      `${providerTable} join 대상 테이블이 스키마에 존재해야 함`,
    );
  }

  const routeMapPositionsTable = schema.match(
    /CREATE TABLE route_map_positions \(([\s\S]*?)\);/,
  );
  assert.ok(routeMapPositionsTable, "route_map_positions table definition not found");
  const routeMapPositionsDdl = routeMapPositionsTable[1];
  for (const column of contract.routeMapPositionsColumns) {
    assert.match(routeMapPositionsDdl, new RegExp(`\\b${column}\\b`));
  }
  assert.ok(fixture.packs[0].requiredTables.includes("route_map_positions"));
  assert.ok(fixture.packs[0].minimumTableRows.route_map_positions > 0);
});

test("SVG geometry extractor returns transformed visible text polygons", async () => {
  const fixture = "tools/route-map/fixtures/geometry-fixture.svg";
  const { stdout } = await execFileAsync(
    process.execPath,
    ["tools/route-map/extract-svg-geometry.mjs", fixture, "--region", "fixture"],
    { cwd: root, maxBuffer: 1024 * 1024 },
  );
  const output = JSON.parse(stdout);
  const source = await readFile(path.join(root, fixture), "utf8");

  assert.equal(output.schemaVersion, 1);
  assert.equal(output.region, "fixture");
  assert.equal(output.extractorVersion, "route-map-svg-geometry-v3");
  assert.equal(output.sourceSvgSha256, createHash("sha256").update(source).digest("hex"));
  assert.deepEqual(output.sourceViewBox, [0, 0, 200, 120]);
  assert.match(output.browser.version, /Chrome|Chromium/i);

  const texts = output.labels.map((label) => label.sourceText).sort();
  assert.deepEqual(texts, ["1호선", "Not to scale", "알파역", "회전역"]);
  for (const hiddenText of ["숨김역", "투명역", "비가시역", "레이어숨김역", "템플릿역"]) {
    assert.equal(output.labels.find((label) => label.sourceText === hiddenText), undefined);
  }

  const line = output.labels.find((label) => label.sourceText === "1호선");
  assert.equal(line.classification, "LINE_LABEL");
  const notice = output.labels.find((label) => label.sourceText === "Not to scale");
  assert.equal(notice.classification, "NOTICE");

  const alpha = output.labels.find((label) => label.sourceText === "알파역");
  assert.equal(alpha.classification, "STATION_LABEL");
  assert.match(alpha.sourceElementKey, /^[a-f0-9]{64}$/);
  assert.equal(alpha.polygon.length, 4);
  assert.ok(alpha.bounds.maxX > alpha.bounds.minX);
  assert.ok(alpha.bounds.maxY > alpha.bounds.minY);

  const rotated = output.labels.find((label) => label.sourceText === "회전역");
  assert.notEqual(rotated.polygon[0].y, rotated.polygon[1].y);
  assert.notEqual(rotated.polygon[0].x, rotated.polygon[3].x);

  // v3: 역 노드(data-station+data-node-role)를 조상 transform 체인 정규화한 root 중심으로.
  const nodesByName = new Map(output.stationNodes.map((node) => [node.dataStation, node]));
  assert.equal(output.stationNodes.length, 2);
  const ordinary = nodesByName.get("노드역");
  assert.equal(ordinary.nodeRole, "ordinary");
  assert.equal(ordinary.dataLine, "1");
  // scaled-nodes transform translate(4 6) scale(2): cx10,cy20 → (4+20, 6+40)=(24,46).
  assert.equal(ordinary.x, 24);
  assert.equal(ordinary.y, 46);
  assert.match(ordinary.sourceElementKey, /^[a-f0-9]{64}$/);
  const transfer = nodesByName.get("환승노드");
  assert.equal(transfer.nodeRole, "transfer");
  assert.equal(transfer.dataLine, "2");
  // 회전 그룹 중심(30,30)은 회전 pivot이라 root에서 (4+60, 6+60)=(64,66) 근처.
  assert.ok(Math.abs(transfer.x - 64) < 2 && Math.abs(transfer.y - 66) < 2);
  // 결정적 정렬: dataLine 사전순(1 < 2).
  assert.deepEqual(output.stationNodes.map((node) => node.dataLine), ["1", "2"]);
});

test("SVG label polygon join applies only unambiguous station labels", async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), "easysubway-route-map-join-"));
  try {
    const geometryPath = path.join(tmp, "geometry.json");
    const fixturePath = path.join(tmp, "catalog-fixture.json");
    const outputPath = path.join(tmp, "joined-fixture.json");
    const reportPath = path.join(tmp, "join-report.json");
    const failedOutputPath = path.join(tmp, "failed-joined-fixture.json");
    const failedReportPath = path.join(tmp, "failed-join-report.json");
    const reviewedMatchesPath = path.join(tmp, "reviewed-matches.json");
    const reviewedOutputPath = path.join(tmp, "reviewed-joined-fixture.json");
    const reviewedReportPath = path.join(tmp, "reviewed-join-report.json");
    const fixture = JSON.parse(
      await readFile(
        path.join(root, "tools/datapack/fixtures/catalog-fixture.json"),
        "utf8",
      ),
    );
    fixture.packs[0].stations.find(
      (station) => station.id === "station-jeongja",
    ).nameKo = "정자(신분당선)";
    fixture.packs[0].routeMapPositions.push({
      stationId: "station-jeongja",
      lineId: "shinbundang",
      region: "부산",
      x: 620,
      y: 310,
    });
    await writeFile(fixturePath, JSON.stringify(fixture), "utf8");
    const jeongjaPolygon = [
      { x: 610, y: 286 },
      { x: 662, y: 286 },
      { x: 662, y: 306 },
      { x: 610, y: 306 },
    ];
    await writeFile(
      geometryPath,
      JSON.stringify({
        schemaVersion: 1,
        region: "수도권",
        sourceSvgSha256: "b".repeat(64),
        extractorVersion: "route-map-svg-geometry-v1",
        labels: [
          {
            sourceText: "정 자역",
            normalizedText: "정 자",
            classification: "STATION_LABEL",
            polygon: jeongjaPolygon,
            polygonIndex: 0,
            sourceElementKey: "c".repeat(64),
          },
          {
            sourceText: "사당역",
            normalizedText: "사당",
            classification: "STATION_LABEL",
            polygon: [
              { x: 410, y: 186 },
              { x: 462, y: 186 },
              { x: 462, y: 206 },
              { x: 410, y: 206 },
            ],
            polygonIndex: 1,
            sourceElementKey: "d".repeat(64),
          },
          {
            sourceText: "없는역",
            normalizedText: "없는",
            classification: "STATION_LABEL",
            polygon: [
              { x: 1, y: 1 },
              { x: 2, y: 1 },
              { x: 2, y: 2 },
              { x: 1, y: 2 },
            ],
            polygonIndex: 2,
            sourceElementKey: "e".repeat(64),
          },
          {
            sourceText: "2호선",
            normalizedText: "2호선",
            classification: "LINE_LABEL",
            polygon: [
              { x: 1, y: 1 },
              { x: 2, y: 1 },
              { x: 2, y: 2 },
              { x: 1, y: 2 },
            ],
            polygonIndex: 3,
            sourceElementKey: "f".repeat(64),
          },
        ],
      }),
      "utf8",
    );

    const { stdout } = await execFileAsync(
      process.execPath,
      [
        "tools/route-map/join-svg-label-polygons.mjs",
        "--fixture",
        fixturePath,
        "--geometry",
        geometryPath,
        "--output",
        outputPath,
        "--report",
        reportPath,
      ],
      { cwd: root, maxBuffer: 1024 * 1024 },
    );
    const report = JSON.parse(stdout);
    const reportFile = JSON.parse(await readFile(reportPath, "utf8"));
    const joined = JSON.parse(await readFile(outputPath, "utf8"));
    const jeongja = joined.packs[0].routeMapPositions.find(
      (row) => row.stationId === "station-jeongja",
    );
    const sadangRows = joined.packs[0].routeMapPositions.filter(
      (row) => row.stationId === "station-sadang",
    );

    assert.deepEqual(report, reportFile);
    assert.equal(report.summary.matched, 1);
    assert.equal(report.summary.ambiguous, 1);
    assert.equal(report.summary.unmatched, 1);
    assert.equal(report.summary.missingRouteMapPositions, 7);
    assert.ok(report.missingRouteMapPositions.every((row) => row.region === "수도권"));
    assert.deepEqual(jeongja.labelPolygon, jeongjaPolygon);
    assert.equal(jeongja.labelPolygonSourceSvgSha256, "b".repeat(64));
    assert.equal(jeongja.labelPolygonSourceElementKey, "c".repeat(64));
    assert.equal(jeongja.labelPolygonIndex, 0);
    assert.ok(sadangRows.every((row) => row.labelPolygon == null));
    assert.deepEqual(report.ambiguous[0].stationIds, ["station-sadang"]);
    assert.deepEqual(report.ambiguous[0].lineIds, ["seoul-2", "seoul-4"]);
    assert.equal(report.unmatched[0].sourceText, "없는역");

    await writeFile(
      reviewedMatchesPath,
      JSON.stringify({
        schemaVersion: 1,
        artifactKind: "route-map-label-polygon-reviewed-matches",
        matches: [
          {
            region: "수도권",
            stationId: "station-sadang",
            lineId: "seoul-2",
            sourceElementKey: "d".repeat(64),
            reviewedAt: "2026-06-26T00:00:00.000Z",
            reviewedBy: "QA",
            reason: "fixture transfer station label reviewed for seoul-2 row",
          },
        ],
      }),
      "utf8",
    );
    const reviewed = await execFileAsync(
      process.execPath,
      [
        "tools/route-map/join-svg-label-polygons.mjs",
        "--fixture",
        fixturePath,
        "--geometry",
        geometryPath,
        "--output",
        reviewedOutputPath,
        "--report",
        reviewedReportPath,
        "--reviewed-matches",
        reviewedMatchesPath,
      ],
      { cwd: root, maxBuffer: 1024 * 1024 },
    );
    const reviewedReport = JSON.parse(reviewed.stdout);
    const reviewedReportFile = JSON.parse(await readFile(reviewedReportPath, "utf8"));
    const reviewedJoined = JSON.parse(await readFile(reviewedOutputPath, "utf8"));
    const reviewedSadang = reviewedJoined.packs[0].routeMapPositions.find(
      (row) => row.stationId === "station-sadang" && row.lineId === "seoul-2",
    );
    const unreviewedSadang = reviewedJoined.packs[0].routeMapPositions.find(
      (row) => row.stationId === "station-sadang" && row.lineId === "seoul-4",
    );
    assert.deepEqual(reviewedReport, reviewedReportFile);
    assert.equal(reviewedReport.summary.reviewedMatched, 1);
    assert.equal(reviewedReport.summary.matched, 1);
    assert.equal(reviewedReport.summary.ambiguous, 0);
    assert.equal(reviewedReport.summary.unmatched, 1);
    assert.equal(reviewedReport.summary.missingRouteMapPositions, 6);
    assert.deepEqual(reviewedSadang.labelPolygon, [
      { x: 410, y: 186 },
      { x: 462, y: 186 },
      { x: 462, y: 206 },
      { x: 410, y: 206 },
    ]);
    assert.equal(reviewedSadang.labelPolygonSourceElementKey, "d".repeat(64));
    assert.equal(unreviewedSadang.labelPolygon, undefined);
    assert.equal(reviewedReport.reviewedMatched[0].reviewedBy, "QA");

    const multiPackFixturePath = path.join(tmp, "multi-pack-catalog-fixture.json");
    const multiPackFixture = JSON.parse(JSON.stringify(fixture));
    multiPackFixture.packs.push({
      ...JSON.parse(JSON.stringify(fixture.packs[0])),
      id: "empty-capital",
      routeMapPositions: [],
    });
    await writeFile(multiPackFixturePath, JSON.stringify(multiPackFixture), "utf8");
    const multiPackReviewed = await execFileAsync(
      process.execPath,
      [
        "tools/route-map/join-svg-label-polygons.mjs",
        "--fixture",
        multiPackFixturePath,
        "--geometry",
        geometryPath,
        "--output",
        path.join(tmp, "multi-pack-reviewed-joined-fixture.json"),
        "--reviewed-matches",
        reviewedMatchesPath,
      ],
      { cwd: root, maxBuffer: 1024 * 1024 },
    );
    assert.equal(JSON.parse(multiPackReviewed.stdout).summary.reviewedMatched, 1);

    await writeFile(
      reviewedMatchesPath,
      JSON.stringify({
        matches: [
          {
            region: "수도권",
            stationId: "station-sadang",
            lineId: "seoul-2",
            sourceElementKey: "z".repeat(64),
          },
        ],
      }),
      "utf8",
    );
    await assert.rejects(
      () =>
        execFileAsync(
          process.execPath,
          [
            "tools/route-map/join-svg-label-polygons.mjs",
            "--fixture",
            fixturePath,
            "--geometry",
            geometryPath,
            "--output",
            reviewedOutputPath,
            "--reviewed-matches",
            reviewedMatchesPath,
          ],
          { cwd: root, maxBuffer: 1024 * 1024 },
        ),
      /sourceElementKey not found/,
    );
    await writeFile(
      reviewedMatchesPath,
      JSON.stringify({
        matches: [
          {
            region: "수도권",
            stationId: "station-missing",
            lineId: "seoul-2",
            sourceElementKey: "d".repeat(64),
          },
        ],
      }),
      "utf8",
    );
    await assert.rejects(
      () =>
        execFileAsync(
          process.execPath,
          [
            "tools/route-map/join-svg-label-polygons.mjs",
            "--fixture",
            fixturePath,
            "--geometry",
            geometryPath,
            "--output",
            reviewedOutputPath,
            "--reviewed-matches",
            reviewedMatchesPath,
          ],
          { cwd: root, maxBuffer: 1024 * 1024 },
        ),
      /station-line row not found/,
    );
    await writeFile(
      reviewedMatchesPath,
      JSON.stringify({
        matches: [
          {
            region: "수도권",
            stationId: "station-sadang",
            lineId: "seoul-2",
            sourceElementKey: "e".repeat(64),
          },
        ],
      }),
      "utf8",
    );
    await assert.rejects(
      () =>
        execFileAsync(
          process.execPath,
          [
            "tools/route-map/join-svg-label-polygons.mjs",
            "--fixture",
            fixturePath,
            "--geometry",
            geometryPath,
            "--output",
            reviewedOutputPath,
            "--reviewed-matches",
            reviewedMatchesPath,
          ],
          { cwd: root, maxBuffer: 1024 * 1024 },
        ),
      /label mismatch/,
    );
    for (const [malformedMatches, message] of [
      [[], /must be a JSON object/],
      [{}, /matches must be an array/],
      [
        {
          matches: [
            {
              region: "수도권",
              stationId: "station-sadang",
              lineId: "seoul-2",
            },
          ],
        },
        /missing sourceElementKey/,
      ],
    ]) {
      await writeFile(reviewedMatchesPath, JSON.stringify(malformedMatches), "utf8");
      await assert.rejects(
        () =>
          execFileAsync(
            process.execPath,
            [
              "tools/route-map/join-svg-label-polygons.mjs",
              "--fixture",
              fixturePath,
              "--geometry",
              geometryPath,
              "--output",
              reviewedOutputPath,
              "--reviewed-matches",
              reviewedMatchesPath,
            ],
            { cwd: root, maxBuffer: 1024 * 1024 },
          ),
        message,
      );
    }
    await writeFile(
      reviewedMatchesPath,
      JSON.stringify({
        matches: [
          {
            region: "수도권",
            stationId: "station-sadang",
            lineId: "seoul-2",
            sourceElementKey: "d".repeat(64),
          },
          {
            region: "수도권",
            stationId: "station-sadang",
            lineId: "seoul-4",
            sourceElementKey: "d".repeat(64),
          },
        ],
      }),
      "utf8",
    );
    await assert.rejects(
      () =>
        execFileAsync(
          process.execPath,
          [
            "tools/route-map/join-svg-label-polygons.mjs",
            "--fixture",
            fixturePath,
            "--geometry",
            geometryPath,
            "--output",
            reviewedOutputPath,
            "--reviewed-matches",
            reviewedMatchesPath,
          ],
          { cwd: root, maxBuffer: 1024 * 1024 },
        ),
      /duplicate reviewed match sourceElementKey/,
    );
    await writeFile(
      reviewedMatchesPath,
      JSON.stringify({
        matches: [
          {
            region: "수도권",
            stationId: "station-sadang",
            lineId: "seoul-2",
            sourceElementKey: "d".repeat(64),
          },
          {
            region: "수도권",
            stationId: "station-sadang",
            lineId: "seoul-2",
            sourceElementKey: "e".repeat(64),
          },
        ],
      }),
      "utf8",
    );
    await assert.rejects(
      () =>
        execFileAsync(
          process.execPath,
          [
            "tools/route-map/join-svg-label-polygons.mjs",
            "--fixture",
            fixturePath,
            "--geometry",
            geometryPath,
            "--output",
            reviewedOutputPath,
            "--reviewed-matches",
            reviewedMatchesPath,
          ],
          { cwd: root, maxBuffer: 1024 * 1024 },
        ),
      /duplicate reviewed match target/,
    );

    let failedStdout = "";
    await assert.rejects(
      () =>
        execFileAsync(
          process.execPath,
          [
            "tools/route-map/join-svg-label-polygons.mjs",
            "--fixture",
            fixturePath,
            "--geometry",
            geometryPath,
            "--output",
            failedOutputPath,
            "--report",
            failedReportPath,
            "--fail-on",
            "AMBIGUOUS,UNMATCHED,MISSING_ROUTE_MAP_POSITIONS",
          ],
          { cwd: root, maxBuffer: 1024 * 1024 },
        ),
      (error) => {
        failedStdout = error.stdout;
        assert.match(error.stderr, /ambiguous=1/);
        assert.match(error.stderr, /unmatched=1/);
        assert.match(error.stderr, /missingRouteMapPositions=7/);
        return true;
      },
    );
    const failedReport = JSON.parse(failedStdout);
    const failedReportFile = JSON.parse(await readFile(failedReportPath, "utf8"));
    const failedJoined = JSON.parse(await readFile(failedOutputPath, "utf8"));
    assert.deepEqual(failedReport, failedReportFile);
    assert.equal(failedReport.summary.matched, 1);
    assert.equal(failedReport.summary.ambiguous, 1);
    assert.equal(failedReport.summary.unmatched, 1);
    assert.equal(failedReport.summary.missingRouteMapPositions, 7);
    assert.equal(
      failedJoined.packs[0].routeMapPositions.find(
        (row) => row.stationId === "station-jeongja",
      ).labelPolygonSourceSvgSha256,
      "b".repeat(64),
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("SVG label polygon join rejects input and output path collisions", async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), "easysubway-route-map-join-path-"));
  try {
    const fixturePath = path.join(root, "tools/datapack/fixtures/catalog-fixture.json");
    const geometryPath = path.join(tmp, "geometry.json");
    const outputPath = path.join(tmp, "joined-fixture.json");
    await writeFile(
      geometryPath,
      JSON.stringify({
        schemaVersion: 1,
        region: "수도권",
        labels: [],
      }),
      "utf8",
    );

    for (const args of [
      ["--output", geometryPath],
      ["--output", outputPath, "--report", fixturePath],
      ["--output", outputPath, "--report", outputPath],
    ]) {
      await assert.rejects(
        () =>
          execFileAsync(
            process.execPath,
            [
              "tools/route-map/join-svg-label-polygons.mjs",
              "--fixture",
              fixturePath,
              "--geometry",
              geometryPath,
              ...args,
            ],
            { cwd: root, maxBuffer: 1024 * 1024 },
          ),
        /must not use the same path/,
      );
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("SVG label polygon join reports duplicate source labels as ambiguous", async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), "easysubway-route-map-join-duplicate-"));
  try {
    const geometryPath = path.join(tmp, "geometry.json");
    const outputPath = path.join(tmp, "joined-fixture.json");
    const reviewedMatchesPath = path.join(tmp, "reviewed-matches.json");
    const reviewedOutputPath = path.join(tmp, "reviewed-joined-fixture.json");
    await writeFile(
      geometryPath,
      JSON.stringify({
        schemaVersion: 1,
        region: "수도권",
        labels: [
          {
            sourceText: "정자역",
            normalizedText: "정자",
            classification: "STATION_LABEL",
            polygon: [
              { x: 10, y: 10 },
              { x: 20, y: 10 },
              { x: 20, y: 20 },
            ],
            polygonIndex: 0,
            sourceElementKey: "a".repeat(64),
          },
          {
            sourceText: "정자역",
            normalizedText: "정자",
            classification: "STATION_LABEL",
            polygon: [
              { x: 30, y: 30 },
              { x: 40, y: 30 },
              { x: 40, y: 40 },
            ],
            polygonIndex: 1,
            sourceElementKey: "b".repeat(64),
          },
        ],
      }),
      "utf8",
    );

    const { stdout } = await execFileAsync(
      process.execPath,
      [
        "tools/route-map/join-svg-label-polygons.mjs",
        "--fixture",
        "tools/datapack/fixtures/catalog-fixture.json",
        "--geometry",
        geometryPath,
        "--output",
        outputPath,
      ],
      { cwd: root, maxBuffer: 1024 * 1024 },
    );
    const report = JSON.parse(stdout);
    const joined = JSON.parse(await readFile(outputPath, "utf8"));
    const jeongja = joined.packs[0].routeMapPositions.find(
      (row) => row.stationId === "station-jeongja",
    );

    assert.equal(report.summary.matched, 0);
    assert.equal(report.summary.ambiguous, 1);
    assert.equal(report.summary.unmatched, 0);
    assert.equal(report.summary.missingRouteMapPositions, 8);
    assert.equal(report.ambiguous[0].duplicateLabelCount, 2);
    assert.deepEqual(report.ambiguous[0].polygonIndexes, [0, 1]);
    assert.deepEqual(report.ambiguous[0].stationIds, ["station-jeongja"]);
    assert.equal(jeongja.labelPolygon, undefined);

    await writeFile(
      reviewedMatchesPath,
      JSON.stringify({
        matches: [
          {
            region: "수도권",
            stationId: "station-jeongja",
            lineId: "shinbundang",
            sourceElementKey: "a".repeat(64),
          },
        ],
      }),
      "utf8",
    );
    const reviewed = await execFileAsync(
      process.execPath,
      [
        "tools/route-map/join-svg-label-polygons.mjs",
        "--fixture",
        "tools/datapack/fixtures/catalog-fixture.json",
        "--geometry",
        geometryPath,
        "--output",
        reviewedOutputPath,
        "--reviewed-matches",
        reviewedMatchesPath,
      ],
      { cwd: root, maxBuffer: 1024 * 1024 },
    );
    const reviewedReport = JSON.parse(reviewed.stdout);
    const reviewedJoined = JSON.parse(await readFile(reviewedOutputPath, "utf8"));
    const reviewedJeongja = reviewedJoined.packs[0].routeMapPositions.find(
      (row) => row.stationId === "station-jeongja" && row.lineId === "shinbundang",
    );
    assert.equal(reviewedReport.summary.reviewedMatched, 1);
    assert.equal(reviewedReport.summary.matched, 0);
    assert.equal(reviewedReport.summary.ambiguous, 0);
    assert.equal(reviewedReport.summary.unmatched, 1);
    assert.equal(reviewedReport.summary.missingRouteMapPositions, 7);
    assert.deepEqual(reviewedJeongja.labelPolygon, [
      { x: 10, y: 10 },
      { x: 20, y: 10 },
      { x: 20, y: 20 },
    ]);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("route map position audit passes clean catalog fixture", async () => {
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      "tools/route-map/audit-route-map.mjs",
      "--fixture",
      "tools/datapack/fixtures/catalog-fixture.json",
      "--fail-on",
      "BLOCKER,HIGH",
    ],
    { cwd: root, maxBuffer: 1024 * 1024 },
  );
  const output = JSON.parse(stdout);

  assert.equal(output.schemaVersion, 1);
  assert.equal(output.artifactKind, "route-map-position-audit");
  assert.equal(output.summary.packCount, 1);
  assert.equal(output.summary.findingsBySeverity.BLOCKER, 0);
  assert.equal(output.summary.findingsBySeverity.HIGH, 0);
  assert.equal(output.summary.findingsBySeverity.INFO, 1);
  assert.equal(output.packs[0].summary.stationLineCount, 9);
  assert.equal(output.packs[0].summary.routeMapPositionCount, 9);
  assert.equal(output.packs[0].summary.coverageRatio, 1);
  assert.equal(output.packs[0].summary.labelPolygonCount, 1);
  assert.equal(output.packs[0].summary.labelPolygonCoverageRatio, 0.1111);
  assert.equal(output.findings[0].code, "MISSING_ROUTE_MAP_LABEL_POLYGON");
  assert.deepEqual(output.packs[0].summary.regions, [
    {
      region: "수도권",
      stationLineCount: 9,
      routeMapPositionCount: 9,
      coveredStationLineCount: 9,
      coverageRatio: 1,
      labelPolygonCount: 1,
      labelPolygonCoverageRatio: 0.1111,
    },
  ]);
});

test("route map position audit does not require coordinates for packs without route map claim", async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), "easysubway-route-map-no-claim-"));
  try {
    const fixture = JSON.parse(
      await readFile("tools/datapack/fixtures/catalog-fixture.json", "utf8"),
    );
    const pack = fixture.packs[0];
    pack.routeMapPositions = [];
    pack.sourceInventory = pack.sourceInventory.map((source) => ({
      ...source,
      fields: (source.fields ?? []).filter((field) => field !== "route_map_positions"),
    }));
    const fixturePath = path.join(tmp, "fixture.json");
    await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");

    const { stdout } = await execFileAsync(
      process.execPath,
      [
        "tools/route-map/audit-route-map.mjs",
        "--fixture",
        fixturePath,
        "--fail-on",
        "BLOCKER,HIGH",
      ],
      { cwd: root, maxBuffer: 1024 * 1024 },
    );
    const output = JSON.parse(stdout);

    assert.equal(output.summary.findingsBySeverity.BLOCKER, 0);
    assert.equal(output.packs[0].summary.routeMapPositionCount, 0);
    assert.equal(output.packs[0].summary.coverageRatio, 0);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("route map position audit can require label polygons", async () => {
  await assert.rejects(
    () =>
      execFileAsync(
        process.execPath,
        [
          "tools/route-map/audit-route-map.mjs",
          "--fixture",
          "tools/datapack/fixtures/catalog-fixture.json",
          "--require-label-polygons",
          "--fail-on",
          "HIGH",
        ],
        { cwd: root, maxBuffer: 1024 * 1024 },
      ),
    (error) => {
      const output = JSON.parse(error.stdout);
      assert.equal(output.summary.findingsBySeverity.BLOCKER, 0);
      assert.equal(output.summary.findingsBySeverity.HIGH, 1);
      assert.equal(output.summary.findingsBySeverity.INFO, 0);
      assert.equal(output.packs[0].summary.labelPolygonCount, 1);
      assert.equal(output.packs[0].summary.labelPolygonCoverageRatio, 0.1111);
      assert.equal(output.findings[0].code, "MISSING_ROUTE_MAP_LABEL_POLYGON");
      assert.equal(output.findings[0].severity, "HIGH");
      return true;
    },
  );
});

test("route map position audit reports label polygon coverage", async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), "easysubway-route-map-audit-"));
  try {
    const fixturePath = path.join(tmp, "label-polygon-coverage-fixture.json");
    const fixture = JSON.parse(
      await readFile(
        path.join(root, "tools/datapack/fixtures/catalog-fixture.json"),
        "utf8",
      ),
    );
    fixture.packs[0].routeMapPositions[1].labelPolygon = [
      { x: 10, y: 10 },
      { x: 50, y: 10 },
      { x: 50, y: 30 },
      { x: 10, y: 30 },
    ];
    await writeFile(fixturePath, JSON.stringify(fixture), "utf8");

    const { stdout } = await execFileAsync(
      process.execPath,
      [
        "tools/route-map/audit-route-map.mjs",
        "--fixture",
        fixturePath,
        "--fail-on",
        "BLOCKER,HIGH",
      ],
      { cwd: root, maxBuffer: 1024 * 1024 },
    );
    const output = JSON.parse(stdout);

    assert.equal(output.summary.findingsBySeverity.BLOCKER, 0);
    assert.equal(output.summary.findingsBySeverity.HIGH, 0);
    assert.equal(output.summary.findingsBySeverity.INFO, 1);
    assert.equal(output.packs[0].summary.labelPolygonCount, 2);
    assert.equal(output.packs[0].summary.labelPolygonCoverageRatio, 0.2222);
    assert.equal(output.packs[0].summary.regions[0].labelPolygonCount, 2);
    assert.equal(
      output.packs[0].summary.regions[0].labelPolygonCoverageRatio,
      0.2222,
    );
    assert.equal(
      output.findings.find(
        (finding) => finding.code === "MISSING_ROUTE_MAP_LABEL_POLYGON",
      ).region,
      "수도권",
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("route map position audit allows same station-line in another region", async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), "easysubway-route-map-audit-"));
  try {
    const fixturePath = path.join(tmp, "multi-region-catalog-fixture.json");
    const fixture = JSON.parse(
      await readFile(
        path.join(root, "tools/datapack/fixtures/catalog-fixture.json"),
        "utf8",
      ),
    );
    const pack = fixture.packs[0];
    const sangnoksu = pack.routeMapPositions.find(
      (row) => row.stationId === "station-sangnoksu",
    );
    pack.routeMapPositions.push({
      ...sangnoksu,
      region: "전국",
      x: sangnoksu.x + 1000,
      y: sangnoksu.y + 1000,
    });
    await writeFile(fixturePath, JSON.stringify(fixture), "utf8");

    const { stdout } = await execFileAsync(
      process.execPath,
      [
        "tools/route-map/audit-route-map.mjs",
        "--fixture",
        fixturePath,
        "--fail-on",
        "BLOCKER,HIGH",
      ],
      { cwd: root, maxBuffer: 1024 * 1024 },
    );
    const output = JSON.parse(stdout);

    assert.equal(output.summary.findingsBySeverity.BLOCKER, 0);
    assert.equal(output.summary.findingsBySeverity.HIGH, 0);
    assert.equal(output.packs[0].summary.stationLineCount, 9);
    assert.equal(output.packs[0].summary.routeMapPositionCount, 10);
    assert.equal(output.packs[0].summary.coverageRatio, 1);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("route map position audit reports wrong-region coverage gaps", async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), "easysubway-route-map-audit-"));
  try {
    const fixturePath = path.join(tmp, "wrong-region-catalog-fixture.json");
    const fixture = JSON.parse(
      await readFile(
        path.join(root, "tools/datapack/fixtures/catalog-fixture.json"),
        "utf8",
      ),
    );
    const routePosition = fixture.packs[0].routeMapPositions.find(
      (row) => row.stationId === "station-sadang" && row.lineId === "seoul-2",
    );
    routePosition.region = "전국";
    await writeFile(fixturePath, JSON.stringify(fixture), "utf8");

    await assert.rejects(
      execFileAsync(
        process.execPath,
        [
          "tools/route-map/audit-route-map.mjs",
          "--fixture",
          fixturePath,
          "--fail-on",
          "BLOCKER,HIGH",
        ],
        { cwd: root, maxBuffer: 1024 * 1024 },
      ),
      (error) => {
        const output = JSON.parse(error.stdout);
        assert.equal(output.summary.findingsBySeverity.BLOCKER, 1);
        assert.equal(output.findings[0].code, "MISSING_ROUTE_MAP_POSITION");
        assert.equal(output.packs[0].summary.coveredStationLineCount, 8);
        assert.equal(output.packs[0].summary.coverageRatio, 0.8889);
        const missingLabelPolygon = output.findings.find(
          (finding) => finding.code === "MISSING_ROUTE_MAP_LABEL_POLYGON",
        );
        assert.match(missingLabelPolygon.message, /^7 station-line/);
        assert.deepEqual(output.packs[0].summary.regions, [
          {
            region: "수도권",
            stationLineCount: 9,
            routeMapPositionCount: 8,
            coveredStationLineCount: 8,
            coverageRatio: 0.8889,
            labelPolygonCount: 1,
            labelPolygonCoverageRatio: 0.1111,
          },
          {
            region: "전국",
            stationLineCount: 0,
            routeMapPositionCount: 1,
            coveredStationLineCount: 0,
            coverageRatio: 1,
            labelPolygonCount: 0,
            labelPolygonCoverageRatio: 1,
          },
        ]);
        return true;
      },
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("route map position audit falls back for regionless stations", async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), "easysubway-route-map-audit-"));
  try {
    const fixturePath = path.join(tmp, "regionless-station-catalog-fixture.json");
    const fixture = JSON.parse(
      await readFile(
        path.join(root, "tools/datapack/fixtures/catalog-fixture.json"),
        "utf8",
      ),
    );
    delete fixture.packs[0].stations[0].region;
    await writeFile(fixturePath, JSON.stringify(fixture), "utf8");

    const { stdout } = await execFileAsync(
      process.execPath,
      [
        "tools/route-map/audit-route-map.mjs",
        "--fixture",
        fixturePath,
        "--fail-on",
        "BLOCKER,HIGH",
      ],
      { cwd: root, maxBuffer: 1024 * 1024 },
    );
    const output = JSON.parse(stdout);

    assert.equal(output.summary.findingsBySeverity.BLOCKER, 0);
    assert.equal(output.packs[0].summary.coveredStationLineCount, 9);
    assert.equal(output.packs[0].summary.coverageRatio, 1);
    assert.equal(output.packs[0].summary.regions[0].stationLineCount, 8);
    assert.equal(output.packs[0].summary.regions[0].routeMapPositionCount, 9);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("route map position audit reports region coverage gaps", async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), "easysubway-route-map-audit-"));
  try {
    const fixturePath = path.join(tmp, "region-gap-catalog-fixture.json");
    const fixture = JSON.parse(
      await readFile(
        path.join(root, "tools/datapack/fixtures/catalog-fixture.json"),
        "utf8",
      ),
    );
    fixture.packs[0].routeMapPositions = fixture.packs[0].routeMapPositions.filter(
      (row) => !(row.stationId === "station-sadang" && row.lineId === "seoul-2"),
    );
    await writeFile(fixturePath, JSON.stringify(fixture), "utf8");

    await assert.rejects(
      execFileAsync(
        process.execPath,
        [
          "tools/route-map/audit-route-map.mjs",
          "--fixture",
          fixturePath,
          "--fail-on",
          "BLOCKER,HIGH",
        ],
        { cwd: root, maxBuffer: 1024 * 1024 },
      ),
      (error) => {
        const output = JSON.parse(error.stdout);
        assert.equal(output.summary.findingsBySeverity.BLOCKER, 1);
        assert.deepEqual(output.packs[0].summary.regions, [
          {
            region: "수도권",
            stationLineCount: 9,
            routeMapPositionCount: 8,
            coveredStationLineCount: 8,
            coverageRatio: 0.8889,
            labelPolygonCount: 1,
            labelPolygonCoverageRatio: 0.1111,
          },
        ]);
        return true;
      },
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("route map position audit reports whole-line region coverage gaps", async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), "easysubway-route-map-audit-"));
  try {
    const fixturePath = path.join(tmp, "region-line-gap-catalog-fixture.json");
    const fixture = JSON.parse(
      await readFile(
        path.join(root, "tools/datapack/fixtures/catalog-fixture.json"),
        "utf8",
      ),
    );
    fixture.packs[0].routeMapPositions = fixture.packs[0].routeMapPositions.filter(
      (row) => row.lineId !== "seoul-2-branch",
    );
    await writeFile(fixturePath, JSON.stringify(fixture), "utf8");

    await assert.rejects(
      execFileAsync(
        process.execPath,
        [
          "tools/route-map/audit-route-map.mjs",
          "--fixture",
          fixturePath,
          "--fail-on",
          "BLOCKER,HIGH",
        ],
        { cwd: root, maxBuffer: 1024 * 1024 },
      ),
      (error) => {
        const output = JSON.parse(error.stdout);
        assert.equal(output.summary.findingsBySeverity.BLOCKER, 2);
        assert.deepEqual(output.packs[0].summary.regions, [
          {
            region: "수도권",
            stationLineCount: 9,
            routeMapPositionCount: 7,
            coveredStationLineCount: 7,
            coverageRatio: 0.7778,
            labelPolygonCount: 1,
            labelPolygonCoverageRatio: 0.1111,
          },
        ]);
        return true;
      },
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("route map position audit keeps duplicate rows in region counts", async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), "easysubway-route-map-audit-"));
  try {
    const fixturePath = path.join(tmp, "duplicate-region-count-fixture.json");
    const fixture = JSON.parse(
      await readFile(
        path.join(root, "tools/datapack/fixtures/catalog-fixture.json"),
        "utf8",
      ),
    );
    fixture.packs[0].routeMapPositions.push({
      ...fixture.packs[0].routeMapPositions[0],
    });
    await writeFile(fixturePath, JSON.stringify(fixture), "utf8");

    await assert.rejects(
      execFileAsync(
        process.execPath,
        [
          "tools/route-map/audit-route-map.mjs",
          "--fixture",
          fixturePath,
          "--fail-on",
          "BLOCKER,HIGH",
        ],
        { cwd: root, maxBuffer: 1024 * 1024 },
      ),
      (error) => {
        const output = JSON.parse(error.stdout);
        assert.equal(output.findings[0].code, "DUPLICATE_ROUTE_MAP_POSITION");
        assert.equal(output.packs[0].summary.routeMapPositionCount, 10);
        assert.equal(
          output.packs[0].summary.regions[0].routeMapPositionCount,
          10,
        );
        assert.equal(
          output.packs[0].summary.regions[0].coveredStationLineCount,
          9,
        );
        return true;
      },
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("route map position audit reports missing source snapshot hash", async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), "easysubway-route-map-audit-"));
  try {
    const fixturePath = path.join(tmp, "missing-source-sha-fixture.json");
    const fixture = JSON.parse(
      await readFile(
        path.join(root, "tools/datapack/fixtures/catalog-fixture.json"),
        "utf8",
      ),
    );
    delete fixture.packs[0].routeMapPositions[0].sourceSha256;
    await writeFile(fixturePath, JSON.stringify(fixture), "utf8");

    await assert.rejects(
      execFileAsync(
        process.execPath,
        [
          "tools/route-map/audit-route-map.mjs",
          "--fixture",
          fixturePath,
          "--fail-on",
          "BLOCKER,HIGH",
        ],
        { cwd: root, maxBuffer: 1024 * 1024 },
      ),
      (error) => {
        const output = JSON.parse(error.stdout);
        assert.equal(output.summary.findingsBySeverity.HIGH, 1);
        assert.equal(output.findings[0].code, "MISSING_ROUTE_MAP_SOURCE_SHA");
        return true;
      },
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("route map position audit downgrades reviewed duplicate coordinates", async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), "easysubway-route-map-audit-"));
  try {
    const fixturePath = path.join(tmp, "duplicate-coordinate-fixture.json");
    const reviewedPath = path.join(tmp, "reviewed-ambiguities.json");
    const fixture = JSON.parse(
      await readFile(
        path.join(root, "tools/datapack/fixtures/catalog-fixture.json"),
        "utf8",
      ),
    );
    const pack = fixture.packs[0];
    const sadangLine2 = pack.routeMapPositions.find(
      (row) => row.stationId === "station-sadang" && row.lineId === "seoul-2",
    );
    const gangnamLine2 = pack.routeMapPositions.find(
      (row) => row.stationId === "station-gangnam" && row.lineId === "seoul-2",
    );
    gangnamLine2.x = sadangLine2.x;
    gangnamLine2.y = sadangLine2.y;
    await writeFile(fixturePath, JSON.stringify(fixture), "utf8");

    await assert.rejects(
      execFileAsync(
        process.execPath,
        [
          "tools/route-map/audit-route-map.mjs",
          "--fixture",
          fixturePath,
          "--fail-on",
          "BLOCKER,HIGH",
        ],
        { cwd: root, maxBuffer: 1024 * 1024 },
      ),
      (error) => {
        const output = JSON.parse(error.stdout);
        assert.equal(output.summary.findingsBySeverity.HIGH, 1);
        assert.equal(output.findings[0].code, "DUPLICATE_SOURCE_COORDINATE");
        return true;
      },
    );

    await writeFile(
      reviewedPath,
      JSON.stringify({
        reviewedAmbiguities: [
          {
            region: "수도권",
            lineId: "seoul-2",
            x: sadangLine2.x,
            y: sadangLine2.y,
            stationIds: ["station-gangnam", "station-sadang"],
            reason: "fixture 검수에서 같은 source 좌표가 의도된 경우로 확인",
            reviewedAt: "2026-06-26T00:00:00.000Z",
            reviewedBy: "QA",
            reviewSource: "fixture-review-note",
          },
        ],
      }),
      "utf8",
    );

    const { stdout } = await execFileAsync(
      process.execPath,
      [
        "tools/route-map/audit-route-map.mjs",
        "--fixture",
        fixturePath,
        "--reviewed-ambiguities",
        reviewedPath,
        "--fail-on",
        "BLOCKER,HIGH",
      ],
      { cwd: root, maxBuffer: 1024 * 1024 },
    );
    const output = JSON.parse(stdout);

    assert.equal(output.summary.findingsBySeverity.HIGH, 0);
    assert.equal(output.summary.findingsBySeverity.INFO, 2);
    const reviewedFinding = output.findings.find(
      (finding) => finding.code === "REVIEWED_AMBIGUITY",
    );
    assert.ok(reviewedFinding);
    assert.match(reviewedFinding.message, /QA/);
    assert.match(reviewedFinding.message, /fixture-review-note/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("route map position audit rejects reviewed ambiguity without provenance", async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), "easysubway-route-map-audit-"));
  try {
    const fixturePath = path.join(tmp, "duplicate-coordinate-fixture.json");
    const reviewedPath = path.join(tmp, "reviewed-ambiguities.json");
    const fixture = JSON.parse(
      await readFile(
        path.join(root, "tools/datapack/fixtures/catalog-fixture.json"),
        "utf8",
      ),
    );
    const pack = fixture.packs[0];
    const sadangLine2 = pack.routeMapPositions.find(
      (row) => row.stationId === "station-sadang" && row.lineId === "seoul-2",
    );
    const gangnamLine2 = pack.routeMapPositions.find(
      (row) => row.stationId === "station-gangnam" && row.lineId === "seoul-2",
    );
    gangnamLine2.x = sadangLine2.x;
    gangnamLine2.y = sadangLine2.y;
    await writeFile(fixturePath, JSON.stringify(fixture), "utf8");
    await writeFile(
      reviewedPath,
      JSON.stringify({
        reviewedAmbiguities: [
          {
            region: "수도권",
            lineId: "seoul-2",
            x: sadangLine2.x,
            y: sadangLine2.y,
            stationIds: ["station-gangnam", "station-sadang"],
            reason: "fixture 검수에서 같은 source 좌표가 의도된 경우로 확인",
            reviewedAt: "2026-06-26T00:00:00.000Z",
          },
        ],
      }),
      "utf8",
    );

    await assert.rejects(
      execFileAsync(
        process.execPath,
        [
          "tools/route-map/audit-route-map.mjs",
          "--fixture",
          fixturePath,
          "--reviewed-ambiguities",
          reviewedPath,
          "--fail-on",
          "BLOCKER,HIGH",
        ],
        { cwd: root, maxBuffer: 1024 * 1024 },
      ),
      (error) => {
        assert.match(
          error.stderr,
          /must include reason, reviewedAt, reviewedBy, and reviewSource/,
        );
        return true;
      },
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("route map position audit reports broken production geometry rows", async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), "easysubway-route-map-audit-"));
  try {
    const fixturePath = path.join(tmp, "broken-catalog-fixture.json");
    const fixture = JSON.parse(
      await readFile(
        path.join(root, "tools/datapack/fixtures/catalog-fixture.json"),
        "utf8",
      ),
    );
    const pack = fixture.packs[0];
    const removedPosition = pack.routeMapPositions.shift();
    pack.routeMapPositions.push({
      ...removedPosition,
      stationId: "station-ghost",
    });
    const sadangLine2 = pack.routeMapPositions.find(
      (row) => row.stationId === "station-sadang" && row.lineId === "seoul-2",
    );
    const gangnamLine2 = pack.routeMapPositions.find(
      (row) => row.stationId === "station-gangnam" && row.lineId === "seoul-2",
    );
    gangnamLine2.x = sadangLine2.x;
    gangnamLine2.y = sadangLine2.y;
    const jeongja = pack.routeMapPositions.find(
      (row) => row.stationId === "station-jeongja",
    );
    jeongja.x = -1;
    jeongja.sourceId = "";
    jeongja.sourceUrl = "";
    delete jeongja.reviewedAt;
    gangnamLine2.labelPolygon = [
      { x: 1, y: 1 },
      { x: 2, y: 2 },
    ];
    await writeFile(fixturePath, JSON.stringify(fixture), "utf8");

    await assert.rejects(
      execFileAsync(
        process.execPath,
        [
          "tools/route-map/audit-route-map.mjs",
          "--fixture",
          fixturePath,
          "--fail-on",
          "BLOCKER,HIGH",
        ],
        { cwd: root, maxBuffer: 1024 * 1024 },
      ),
      (error) => {
        const output = JSON.parse(error.stdout);
        assert.equal(output.summary.findingsBySeverity.BLOCKER, 4);
        assert.equal(output.summary.findingsBySeverity.HIGH, 3);
        assert.deepEqual(
          output.findings.map((finding) => finding.code).sort(),
          [
            "DUPLICATE_SOURCE_COORDINATE",
            "INVALID_ROUTE_MAP_COORDINATE",
            "INVALID_ROUTE_MAP_LABEL_POLYGON",
            "MISSING_ROUTE_MAP_LABEL_POLYGON",
            "MISSING_ROUTE_MAP_POSITION",
            "MISSING_ROUTE_MAP_REVIEW",
            "MISSING_ROUTE_MAP_SOURCE",
            "ROUTE_MAP_POSITION_WITHOUT_STATION_LINE",
          ],
        );
        return true;
      },
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("route map position audit reports overlapping label polygons as medium", async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), "easysubway-route-map-audit-"));
  try {
    const fixturePath = path.join(tmp, "overlap-catalog-fixture.json");
    const fixture = JSON.parse(
      await readFile(
        path.join(root, "tools/datapack/fixtures/catalog-fixture.json"),
        "utf8",
      ),
    );
    const pack = fixture.packs[0];
    const sadangLine2 = pack.routeMapPositions.find(
      (row) => row.stationId === "station-sadang" && row.lineId === "seoul-2",
    );
    const gangnamLine2 = pack.routeMapPositions.find(
      (row) => row.stationId === "station-gangnam" && row.lineId === "seoul-2",
    );
    sadangLine2.labelPolygon = [
      { x: 100, y: 100 },
      { x: 140, y: 100 },
      { x: 140, y: 120 },
      { x: 100, y: 120 },
    ];
    gangnamLine2.labelPolygon = [
      { x: 130, y: 110 },
      { x: 170, y: 110 },
      { x: 170, y: 130 },
      { x: 130, y: 130 },
    ];
    await writeFile(fixturePath, JSON.stringify(fixture), "utf8");

    const { stdout } = await execFileAsync(
      process.execPath,
      [
        "tools/route-map/audit-route-map.mjs",
        "--fixture",
        fixturePath,
        "--fail-on",
        "BLOCKER,HIGH",
      ],
      { cwd: root, maxBuffer: 1024 * 1024 },
    );
    const output = JSON.parse(stdout);

    assert.equal(output.summary.findingsBySeverity.BLOCKER, 0);
    assert.equal(output.summary.findingsBySeverity.HIGH, 0);
    assert.equal(output.summary.findingsBySeverity.MEDIUM, 1);
    assert.equal(output.findings[0].code, "OVERLAPPING_ROUTE_MAP_LABEL_POLYGON");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("route map position audit reports ambiguous label polygon hit simulation as medium", async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), "easysubway-route-map-audit-"));
  try {
    const fixturePath = path.join(tmp, "ambiguous-hit-catalog-fixture.json");
    const fixture = JSON.parse(
      await readFile(
        path.join(root, "tools/datapack/fixtures/catalog-fixture.json"),
        "utf8",
      ),
    );
    const pack = fixture.packs[0];
    const sadangLine2 = pack.routeMapPositions.find(
      (row) => row.stationId === "station-sadang" && row.lineId === "seoul-2",
    );
    const gangnamLine2 = pack.routeMapPositions.find(
      (row) => row.stationId === "station-gangnam" && row.lineId === "seoul-2",
    );
    sadangLine2.labelPolygon = [
      { x: 100, y: 100 },
      { x: 140, y: 100 },
      { x: 140, y: 120 },
      { x: 100, y: 120 },
    ];
    gangnamLine2.labelPolygon = [
      { x: 110, y: 105 },
      { x: 130, y: 105 },
      { x: 130, y: 115 },
      { x: 110, y: 115 },
    ];
    await writeFile(fixturePath, JSON.stringify(fixture), "utf8");

    const { stdout } = await execFileAsync(
      process.execPath,
      [
        "tools/route-map/audit-route-map.mjs",
        "--fixture",
        fixturePath,
        "--fail-on",
        "BLOCKER,HIGH",
      ],
      { cwd: root, maxBuffer: 1024 * 1024 },
    );
    const output = JSON.parse(stdout);

    assert.equal(output.summary.findingsBySeverity.BLOCKER, 0);
    assert.equal(output.summary.findingsBySeverity.HIGH, 0);
    assert.ok(
      output.findings.some(
        (finding) =>
          finding.code === "AMBIGUOUS_ROUTE_MAP_LABEL_POLYGON_HIT" &&
          finding.severity === "MEDIUM" &&
          finding.stationId === "station-sadang",
      ),
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("route map position audit compares fallback label center for hit simulation", async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), "easysubway-route-map-audit-"));
  try {
    const fixturePath = path.join(tmp, "fallback-label-hit-catalog-fixture.json");
    const fixture = JSON.parse(
      await readFile(
        path.join(root, "tools/datapack/fixtures/catalog-fixture.json"),
        "utf8",
      ),
    );
    const pack = fixture.packs[0];
    const sadangLine2 = pack.routeMapPositions.find(
      (row) => row.stationId === "station-sadang" && row.lineId === "seoul-2",
    );
    const gangnamLine2 = pack.routeMapPositions.find(
      (row) => row.stationId === "station-gangnam" && row.lineId === "seoul-2",
    );
    sadangLine2.labelPolygon = [
      { x: 100, y: 100 },
      { x: 140, y: 100 },
      { x: 140, y: 120 },
      { x: 100, y: 120 },
    ];
    delete gangnamLine2.labelPolygon;
    gangnamLine2.x = 200;
    gangnamLine2.y = 200;
    gangnamLine2.labelDx = -80;
    gangnamLine2.labelDy = -90;
    gangnamLine2.sourceId = "fixture-cyberstation";
    await writeFile(fixturePath, JSON.stringify(fixture), "utf8");

    const { stdout } = await execFileAsync(
      process.execPath,
      [
        "tools/route-map/audit-route-map.mjs",
        "--fixture",
        fixturePath,
        "--fail-on",
        "BLOCKER,HIGH",
      ],
      { cwd: root, maxBuffer: 1024 * 1024 },
    );
    const output = JSON.parse(stdout);

    assert.equal(output.summary.findingsBySeverity.BLOCKER, 0);
    assert.equal(output.summary.findingsBySeverity.HIGH, 0);
    assert.ok(
      output.findings.some(
        (finding) =>
          finding.code === "AMBIGUOUS_ROUTE_MAP_LABEL_POLYGON_HIT" &&
          finding.severity === "MEDIUM" &&
          finding.stationId === "station-sadang" &&
          finding.message.includes("station-gangnam:seoul-2"),
      ),
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("route map position audit compares generated fallback label center", async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), "easysubway-route-map-audit-"));
  try {
    const fixturePath = path.join(tmp, "generated-fallback-hit-catalog-fixture.json");
    const fixture = JSON.parse(
      await readFile(
        path.join(root, "tools/datapack/fixtures/catalog-fixture.json"),
        "utf8",
      ),
    );
    const pack = fixture.packs[0];
    const sadangLine2 = pack.routeMapPositions.find(
      (row) => row.stationId === "station-sadang" && row.lineId === "seoul-2",
    );
    const gangnamLine2 = pack.routeMapPositions.find(
      (row) => row.stationId === "station-gangnam" && row.lineId === "seoul-2",
    );
    sadangLine2.labelPolygon = [
      { x: 100, y: 100 },
      { x: 140, y: 100 },
      { x: 140, y: 120 },
      { x: 100, y: 120 },
    ];
    delete gangnamLine2.labelPolygon;
    gangnamLine2.x = 112;
    gangnamLine2.y = 107;
    gangnamLine2.labelDx = 0;
    gangnamLine2.labelDy = 0;
    gangnamLine2.upPath = "";
    gangnamLine2.downPath = "";
    await writeFile(fixturePath, JSON.stringify(fixture), "utf8");

    const { stdout } = await execFileAsync(
      process.execPath,
      [
        "tools/route-map/audit-route-map.mjs",
        "--fixture",
        fixturePath,
        "--fail-on",
        "BLOCKER,HIGH",
      ],
      { cwd: root, maxBuffer: 1024 * 1024 },
    );
    const output = JSON.parse(stdout);

    assert.equal(output.summary.findingsBySeverity.BLOCKER, 0);
    assert.equal(output.summary.findingsBySeverity.HIGH, 0);
    assert.ok(
      output.findings.some(
        (finding) =>
          finding.code === "AMBIGUOUS_ROUTE_MAP_LABEL_POLYGON_HIT" &&
          finding.severity === "MEDIUM" &&
          finding.stationId === "station-sadang" &&
          finding.message.includes("station-gangnam:seoul-2"),
      ),
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("route map position audit reports source label mismatch as high", async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), "easysubway-route-map-audit-"));
  try {
    const fixturePath = path.join(tmp, "source-label-mismatch-fixture.json");
    const fixture = JSON.parse(
      await readFile(
        path.join(root, "tools/datapack/fixtures/catalog-fixture.json"),
        "utf8",
      ),
    );
    const pack = fixture.packs[0];
    const sangnoksuLine4 = pack.routeMapPositions.find(
      (row) => row.stationId === "station-sangnoksu" && row.lineId === "seoul-4",
    );
    const gangnamLine2 = pack.routeMapPositions.find(
      (row) => row.stationId === "station-gangnam" && row.lineId === "seoul-2",
    );
    sangnoksuLine4.sourceLabel = "상록수역";
    gangnamLine2.sourceLabel = "사당";
    await writeFile(fixturePath, JSON.stringify(fixture), "utf8");

    await assert.rejects(
      execFileAsync(
        process.execPath,
        [
          "tools/route-map/audit-route-map.mjs",
          "--fixture",
          fixturePath,
          "--fail-on",
          "BLOCKER,HIGH",
        ],
        { cwd: root, maxBuffer: 1024 * 1024 },
      ),
      (error) => {
        const output = JSON.parse(error.stdout);
        assert.equal(output.summary.findingsBySeverity.BLOCKER, 0);
        assert.equal(output.summary.findingsBySeverity.HIGH, 1);
        assert.equal(output.findings[0].code, "ROUTE_MAP_SOURCE_LABEL_MISMATCH");
        assert.equal(output.findings[0].stationId, "station-gangnam");
        return true;
      },
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("MOLIT nationwide fixture builder emits route map source hashes", async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), "easysubway-route-map-source-sha-"));
  try {
    const fixturePath = path.join(tmp, "generated-production-fixture.json");
    await execFileAsync(
      process.execPath,
      [
        "tools/datapack/build-molit-nationwide-fixture.mjs",
        "--csv",
        "tools/datapack/sources/molit-urban-rail-full-route-20251211.csv",
        "--svg-csv",
        "tools/datapack/sources/molit-rail-station-svg-route-20250811.csv",
        "--seoulmetro-js",
        "tools/datapack/sources/seoulmetro-cyberstation-line-data-20260623.js",
        "--humetro-html",
        "tools/datapack/sources/humetro-cyberstation-map-20260623.html",
        "--humetro-css",
        "tools/datapack/sources/humetro-cyber-station-20250310c.css",
        "--grtc-html",
        "tools/datapack/sources/grtc-cyber-simple-20260623.html",
        "--dtro-html",
        "tools/datapack/sources/dtro-cyberstation-20260623.html",
        "--djtc-html",
        "tools/datapack/sources/djtc-cyberstation-20260623.html",
        "--djtc-css",
        "tools/datapack/sources/djtc-content-20260623.css",
        "--output",
        fixturePath,
      ],
      { cwd: root, maxBuffer: 1024 * 1024 },
    );

    const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
    const pack = fixture.packs[0];
    const routePosition = pack.routeMapPositions.find(
      (row) => row.sourceId === "seoulmetro-cyberstation",
    );
    const routeStation = pack.stations.find(
      (row) => row.id === routePosition.stationId,
    );
    const svgRoutePosition = pack.routeMapPositions.find(
      (row) => row.sourceId === "molit-rail-station-svg-route",
    );
    const svgRouteStation = pack.stations.find(
      (row) => row.id === svgRoutePosition.stationId,
    );
    const interpolatedRoutePosition = pack.routeMapPositions.find(
      (row) => row.sourceId === "molit-urban-rail-full-route",
    );
    const interpolatedRouteStation = pack.stations.find(
      (row) => row.id === interpolatedRoutePosition.stationId,
    );
    const source = pack.sourceInventory.find(
      (row) => row.id === "seoulmetro-cyberstation",
    );
    const expectedSha = createHash("sha256")
      .update(
        await readFile(
          path.join(root, "tools/datapack/sources/seoulmetro-cyberstation-line-data-20260623.js"),
        ),
      )
      .digest("hex");

    assert.match(routePosition.sourceSha256, /^[a-f0-9]{64}$/);
    assert.equal(routePosition.sourceSha256, expectedSha);
    assert.equal(routePosition.sourceLabel, routeStation.nameKo);
    assert.equal(svgRoutePosition.sourceLabel, svgRouteStation.nameKo);
    assert.equal(
      interpolatedRoutePosition.sourceLabel,
      interpolatedRouteStation.nameKo,
    );
    assert.equal(source.sourceSha256, expectedSha);

    const { stdout } = await execFileAsync(
      process.execPath,
      [
        "tools/route-map/audit-route-map.mjs",
        "--fixture",
        fixturePath,
        "--reviewed-ambiguities",
        "tools/route-map/fixtures/reviewed-ambiguities.json",
        "--fail-on",
        "BLOCKER,HIGH",
      ],
      { cwd: root, maxBuffer: 1024 * 1024 },
    );
    const audit = JSON.parse(stdout);

    assert.equal(audit.packs[0].summary.coverageRatio, 1);
    assert.equal(audit.packs[0].summary.labelPolygonCount, 0);
    assert.equal(audit.packs[0].summary.labelPolygonCoverageRatio, 0);
    assert.equal(audit.summary.findingsBySeverity.BLOCKER, 0);
    assert.equal(audit.summary.findingsBySeverity.HIGH, 0);
    assert.ok(
      audit.findings.some(
        (finding) => finding.code === "MISSING_ROUTE_MAP_LABEL_POLYGON",
      ),
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

// #1951 작업 ①: 부산·대구·광주·대전 4권역 audit을 CI 상시 게이트로 편입한다.
// 커밋된 원본 소스에서 build-molit-nationwide-fixture로 전국 fixture를 만들고
// audit-route-map을 --fail-on BLOCKER,HIGH로 돌려, 4권역 각각이 BLOCKER/HIGH 0이며
// 확정 노선 목록(#1951 "대상 노선 목록 확정" 코멘트)만큼의 station-line 커버리지를
// 유지하는지 검증한다. 기존 MOLIT 테스트는 수도권 source-sha·label polygon에
// 초점을 두므로, 4권역 게이트를 별도 테스트로 못박아 회귀를 막는다.
const nationwideAuditSourceArgs = [
  "--csv",
  "tools/datapack/sources/molit-urban-rail-full-route-20251211.csv",
  "--svg-csv",
  "tools/datapack/sources/molit-rail-station-svg-route-20250811.csv",
  "--seoulmetro-js",
  "tools/datapack/sources/seoulmetro-cyberstation-line-data-20260623.js",
  "--humetro-html",
  "tools/datapack/sources/humetro-cyberstation-map-20260623.html",
  "--humetro-css",
  "tools/datapack/sources/humetro-cyber-station-20250310c.css",
  "--grtc-html",
  "tools/datapack/sources/grtc-cyber-simple-20260623.html",
  "--dtro-html",
  "tools/datapack/sources/dtro-cyberstation-20260623.html",
  "--djtc-html",
  "tools/datapack/sources/djtc-cyberstation-20260623.html",
  "--djtc-css",
  "tools/datapack/sources/djtc-content-20260623.css",
];

// 확정 노선 목록의 지역별 station-line 커버리지 하한(#1951 대상 노선 목록 확정 코멘트:
// 부산 6노선/158역, 대구 4노선(1·2·3호선+대경선)/101, 광주 1/20, 대전 1/22).
const nationwideRegionAuditExpectations = {
  부산권: 158,
  대구권: 101,
  광주권: 20,
  대전권: 22,
};

test("route map audit gates 부산·대구·광주·대전 4권역 at BLOCKER/HIGH 0", async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), "easysubway-route-map-4region-audit-"));
  try {
    const fixturePath = path.join(tmp, "nationwide-fixture.json");
    await execFileAsync(
      process.execPath,
      [
        "tools/datapack/build-molit-nationwide-fixture.mjs",
        ...nationwideAuditSourceArgs,
        "--output",
        fixturePath,
      ],
      { cwd: root, maxBuffer: 16 * 1024 * 1024 },
    );

    const { stdout, code } = await execFileAsync(
      process.execPath,
      [
        "tools/route-map/audit-route-map.mjs",
        "--fixture",
        fixturePath,
        "--reviewed-ambiguities",
        "tools/route-map/fixtures/reviewed-ambiguities.json",
        "--fail-on",
        "BLOCKER,HIGH",
      ],
      { cwd: root, maxBuffer: 16 * 1024 * 1024 },
    )
      .then((result) => ({ ...result, code: 0 }))
      .catch((error) => ({ stdout: error.stdout ?? "", code: error.code ?? 1 }));

    assert.ok(
      stdout.trim().length > 0,
      `audit 출력이 비어 있음(비정상 종료 의심): code=${code}`,
    );
    const audit = JSON.parse(stdout);
    // --fail-on BLOCKER,HIGH가 걸려 있으므로 4권역 중 하나라도 위반이면 exit 1.
    assert.equal(code, 0, "4권역 audit이 BLOCKER/HIGH 없이 통과해야 함(exit 0)");
    assert.equal(audit.summary.findingsBySeverity.BLOCKER, 0);
    assert.equal(audit.summary.findingsBySeverity.HIGH, 0);

    const regionsById = new Map(
      (audit.packs[0].summary.regions ?? []).map((row) => [row.region, row]),
    );
    for (const [region, expectedStationLines] of Object.entries(
      nationwideRegionAuditExpectations,
    )) {
      const summary = regionsById.get(region);
      assert.ok(summary, `${region} audit 요약이 존재해야 함`);
      assert.equal(
        summary.stationLineCount,
        expectedStationLines,
        `${region} station-line 커버리지가 확정 노선 목록과 일치해야 함`,
      );
      assert.equal(
        summary.coverageRatio,
        1,
        `${region} 모든 station-line에 routeMapPosition 좌표가 있어야 함`,
      );
    }

    // 권역별 findings에도 BLOCKER/HIGH가 없어야 한다(요약 카운트 회귀 이중 가드).
    const gatedRegions = new Set(Object.keys(nationwideRegionAuditExpectations));
    const regionBlockerHigh = audit.findings.filter(
      (finding) =>
        gatedRegions.has(finding.region) &&
        (finding.severity === "BLOCKER" || finding.severity === "HIGH"),
    );
    assert.deepEqual(
      regionBlockerHigh,
      [],
      "4권역에 BLOCKER/HIGH finding이 없어야 함",
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("build-route-map-line-tracks stitches touching fragments and reports proximity", async () => {
  // 같은 색 두 조각: (0,0)-(10,0) 와 (10.5,0)-(20,0) → tolerance 1.5로 한 조각.
  const geometry = {
    extractorVersion: 2,
    strokes: [
      { tag: "polyline", stroke: "#ff0000", dashed: false, points: [{ x: 0, y: 0 }, { x: 10, y: 0 }] },
      { tag: "polyline", stroke: "#ff0000", dashed: false, points: [{ x: 10.5, y: 0 }, { x: 20, y: 0 }] },
    ],
  };
  const result = await runBuildLineTracks({
    geometry,
    region: "테스트권",
    stations: [
      { station_id: "s1", line_id: "line-a", x: 2, y: 5 },
      { station_id: "s2", line_id: "line-a", x: 18, y: 5 },
    ],
  });
  assert.equal(result.lines.length, 1);
  assert.equal(result.lines[0].trackCount, 1); // 2 조각 → 1 (stitched)
  assert.equal(result.lines[0].paths[0], "M 0 0 L 10 0 L 20 0");
  assert.equal(result.stationProximityRatio, 1); // 2/2 역이 반경 내
});

test("build-route-map-line-tracks refines surplus colors (achromatic drop + similar merge)", async () => {
  // 노선 2개(line-a, line-b). 색 4개 = 빨강·빨강변종(line-a)·파랑(line-b)·검정(무채색 외곽선).
  // 정제: 빨강 변종 병합 + 무채색 검정 제외 → 색2 = 노선2.
  const geometry = {
    extractorVersion: 2,
    strokes: [
      { tag: "polyline", stroke: "#ff0000", dashed: false, points: [{ x: 0, y: 0 }, { x: 100, y: 0 }] },
      { tag: "polyline", stroke: "#fe0202", dashed: false, points: [{ x: 100, y: 0 }, { x: 200, y: 0 }] },
      { tag: "polyline", stroke: "#0000ff", dashed: false, points: [{ x: 0, y: 100 }, { x: 100, y: 100 }] },
      { tag: "polyline", stroke: "#1a1a1a", dashed: false, points: [{ x: 0, y: 400 }, { x: 200, y: 400 }] },
    ],
  };
  const result = await runBuildLineTracks({
    geometry,
    region: "테스트권",
    stations: [
      { station_id: "a1", line_id: "line-a", x: 5, y: 5 },
      { station_id: "a2", line_id: "line-a", x: 195, y: 5 },
      { station_id: "b1", line_id: "line-b", x: 5, y: 105 },
      { station_id: "b2", line_id: "line-b", x: 95, y: 105 },
    ],
  });
  assert.equal(result.lines.length, 2);
  assert.equal(result.colorCount, 2); // 정제 후 색 수 = 노선 수
  assert.equal(result.refinement.originalColorCount, 4);
  assert.ok(result.refinement.dropped.some((drop) => drop.color === "#1a1a1a" && drop.achromatic)); // 무채색 제외
  assert.ok(result.refinement.merged.some((pair) => pair.includes("#fe0202"))); // 유사색 병합
  // 빨강 노선은 병합으로 한 조각(0→200), 파랑은 별도.
  const redLine = result.lines.find((line) => line.svgColor === "#ff0000");
  assert.ok(redLine, "대표색 #ff0000 노선이 있어야 한다");
});

test("build-route-map-line-tracks --source pack-down-path chains existing segments", async () => {
  // down_path "M 0 0 L 10 0" → "M 10 0 L 20 0": 끝점=시작점이라 한 조각으로 이어진다.
  const result = await runBuildLineTracksFromPack({
    region: "테스트권",
    rows: [
      { station_id: "s1", line_id: "line-a", sequence: 1, x: 0, y: 0, down_path: "" },
      { station_id: "s2", line_id: "line-a", sequence: 2, x: 10, y: 0, down_path: "M 0 0 L 10 0" },
      { station_id: "s3", line_id: "line-a", sequence: 3, x: 20, y: 0, down_path: "M 10 0 L 20 0" },
    ],
  });
  assert.equal(result.source, "pack-down-path");
  assert.equal(result.lines.length, 1);
  assert.equal(result.lines[0].lineId, "line-a");
  assert.equal(result.lines[0].trackCount, 1);
  assert.equal(result.lines[0].paths[0], "M 0 0 L 10 0 L 20 0");
});

test("build-route-map-line-tracks completes zero-vote svg lines from pack down_path", async () => {
  // line-a: 빨강 track 근처 역 → 득표. line-b: 어느 track과도 멀어 0표지만
  // down_path 보유 → SVG 고아 색 대신 down_path 완충(Route B 로직 재사용).
  const geometry = {
    extractorVersion: 2,
    strokes: [
      { tag: "polyline", stroke: "#ff0000", dashed: false,
        points: [{ x: 0, y: 0 }, { x: 100, y: 0 }] },
      // 고아 주황 track — 어느 역과도 멀어 0표. 소거법으로 line-b에 배정될 후보.
      { tag: "polyline", stroke: "#f58921", dashed: false,
        points: [{ x: 0, y: 500 }, { x: 100, y: 500 }] },
    ],
  };
  const result = await runBuildLineTracksWithDownPath({
    geometry,
    region: "테스트권",
    rows: [
      { station_id: "a1", line_id: "line-a", sequence: 1, x: 10, y: 5, down_path: "" },
      { station_id: "a2", line_id: "line-a", sequence: 2, x: 90, y: 5, down_path: "M 10 5 L 90 5" },
      { station_id: "b1", line_id: "line-b", sequence: 1, x: 10, y: 1000, down_path: "" },
      { station_id: "b2", line_id: "line-b", sequence: 2, x: 90, y: 1000, down_path: "M 10 1000 L 90 1000" },
    ],
  });
  assert.equal(result.source, "svg-strokes");
  assert.equal(result.colorCount, result.lineCount, "완충 후에도 색=노선 전제 유지");
  const lineB = result.lines.find((line) => line.lineId === "line-b");
  assert.ok(lineB, "line-b 존재");
  assert.equal(lineB.matchVotes, null, "완충 노선은 SVG 득표가 아니므로 matchVotes=null");
  assert.equal(lineB.svgColor, "", "완충 노선은 SVG 색을 버린다(고아 색 미방출)");
  assert.equal(lineB.source, "pack-down-path", "노선 단위 down_path 완충 표시");
  assert.equal(lineB.trackCount, 1);
  assert.equal(lineB.paths[0], "M 10 1000 L 90 1000", "down_path 실측 track");
  const lineA = result.lines.find((line) => line.lineId === "line-a");
  assert.ok(lineA.matchVotes > 0, "정상 매칭 노선은 SVG track 유지");
  assert.equal(lineA.svgColor, "#ff0000");
});

test("apply-route-map-line-tracks writes tracks with inherited license metadata", async () => {
  const positions = [{
    station_id: "s1", line_id: "line-a", x: 0, y: 0,
    source_id: "src-official", source_name: "공식 노선도", source_url: "https://example.test",
    license: "public-reference", license_status: "reviewed",
    commercial_use_allowed: 0, attribution_required: 1,
  }];
  const tracksDocs = [{
    region: "테스트권", source: "svg-strokes",
    lines: [{ lineId: "line-a", svgColor: "#ff0000", paths: ["M 0 0 L 10 0", "M 20 0 L 30 0"] }],
  }];
  const { rows, indexCapital } = await runApplyLineTracks({ region: "테스트권", positions, tracksDocs });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].track_index, 0);
  assert.equal(rows[1].track_index, 1);
  assert.equal(rows[0].svg_color, "#ff0000");
  assert.equal(rows[0].license, "public-reference"); // 라이선스 승계
  assert.equal(rows[0].attribution_required, 1);
  assert.equal(rows[0].source_id, "src-official");
  assert.match(rows[0].path, /^M -?\d/);
  assert.notEqual(indexCapital.sqliteSha256, "old"); // index sha 갱신

  // 재실행(같은 region)은 기존 행 DELETE 후 INSERT — 중복 없음.
  const rerun = await runApplyLineTracks({ region: "테스트권", positions, tracksDocs });
  assert.equal(rerun.rows.length, 2);
});

test("audit-route-map flags line-track gaps as blockers", async () => {
  const fixture = {
    packs: [{
      id: "test",
      routeMapPositions: [
        { stationId: "s1", lineId: "line-a", region: "테스트권", x: 0, y: 0 },
        { stationId: "s2", lineId: "line-b", region: "테스트권", x: 10, y: 10 },
      ],
    }],
  };
  // tracks에 line-a만(line-b 누락) + 색≠노선.
  const lineTracks = [{
    region: "테스트권", source: "svg-strokes", colorCount: 1, lineCount: 2,
    lines: [{ lineId: "line-a", svgColor: "#ff0000", matchVotes: 5, paths: ["M 0 0 L 1 0"] }],
  }];
  const report = await runAuditRouteMap({ fixture, lineTracks });
  const codes = report.findings.map((finding) => finding.code);
  assert.ok(codes.includes("LINE_TRACKS_MISSING_LINE"), "누락 노선 blocker");
  assert.ok(codes.includes("LINE_TRACKS_COLOR_LINE_MISMATCH"), "색≠노선 blocker");
  const missing = report.findings.find((finding) => finding.code === "LINE_TRACKS_MISSING_LINE");
  assert.equal(missing.severity, "BLOCKER");
  assert.equal(missing.lineId, "line-b");
});

test("audit-route-map flags zero-vote tracks as HIGH for manual review", async () => {
  const fixture = {
    packs: [{
      id: "test",
      routeMapPositions: [{ stationId: "s1", lineId: "line-a", region: "테스트권", x: 0, y: 0 }],
    }],
  };
  const lineTracks = [{
    region: "테스트권", source: "svg-strokes", colorCount: 1, lineCount: 1,
    lines: [{ lineId: "line-a", svgColor: "#ff0000", matchVotes: 0, paths: ["M 0 0 L 1 0"] }],
  }];
  const report = await runAuditRouteMap({ fixture, lineTracks });
  const zeroVote = report.findings.find((finding) => finding.code === "LINE_TRACKS_ZERO_VOTE");
  assert.ok(zeroVote, "0표 노선 finding");
  assert.equal(zeroVote.severity, "HIGH");
  assert.equal(zeroVote.lineId, "line-a");
});

test("audit-route-map downgrades reviewed zero-vote tracks to INFO", async () => {
  const fixture = {
    packs: [{
      id: "test",
      routeMapPositions: [{ stationId: "s1", lineId: "line-a", region: "테스트권", x: 0, y: 0 }],
    }],
  };
  const lineTracks = [{
    region: "테스트권", source: "svg-strokes", colorCount: 1, lineCount: 1,
    lines: [{ lineId: "line-a", svgColor: "#f58921", matchVotes: 0, paths: ["M 0 0 L 1 0"] }],
  }];
  const reviewedLineTracks = {
    reviewedLineTracks: [{
      region: "테스트권",
      lineId: "line-a",
      reason: "공용 색 노선이라 근접 역 0표지만 SVG 육안 대조로 track 정합 확인",
      reviewedAt: "2026-07-05T00:00:00.000Z",
      reviewedBy: "QA",
      reviewSource: "https://github.com/AquilaXk/easysubway/issues/1638",
    }],
  };
  const report = await runAuditRouteMap({ fixture, lineTracks, reviewedLineTracks });
  assert.equal(
    report.findings.find((finding) => finding.code === "LINE_TRACKS_ZERO_VOTE"),
    undefined,
    "검수된 0표는 HIGH finding으로 남지 않는다",
  );
  const reviewed = report.findings.find(
    (finding) => finding.code === "REVIEWED_LINE_TRACK_ZERO_VOTE",
  );
  assert.ok(reviewed, "검수 기록 finding");
  assert.equal(reviewed.severity, "INFO");
  assert.equal(reviewed.lineId, "line-a");
  assert.match(reviewed.message, /육안 대조/);
});

test("audit-route-map keeps unreviewed zero-vote as HIGH when reviewed list covers a different line", async () => {
  const fixture = {
    packs: [{
      id: "test",
      routeMapPositions: [{ stationId: "s1", lineId: "line-a", region: "테스트권", x: 0, y: 0 }],
    }],
  };
  const lineTracks = [{
    region: "테스트권", source: "svg-strokes", colorCount: 1, lineCount: 1,
    lines: [{ lineId: "line-a", svgColor: "#f58921", matchVotes: 0, paths: ["M 0 0 L 1 0"] }],
  }];
  const reviewedLineTracks = {
    reviewedLineTracks: [{
      region: "테스트권",
      lineId: "line-other",
      reason: "다른 노선 검수 — line-a는 미검수",
      reviewedAt: "2026-07-05T00:00:00.000Z",
      reviewedBy: "QA",
      reviewSource: "https://github.com/AquilaXk/easysubway/issues/1638",
    }],
  };
  const report = await runAuditRouteMap({ fixture, lineTracks, reviewedLineTracks });
  const zeroVote = report.findings.find((finding) => finding.code === "LINE_TRACKS_ZERO_VOTE");
  assert.ok(zeroVote, "미검수 0표는 HIGH로 남는다");
  assert.equal(zeroVote.severity, "HIGH");
  assert.equal(
    report.findings.find((finding) => finding.code === "REVIEWED_LINE_TRACK_ZERO_VOTE"),
    undefined,
    "다른 노선 검수는 line-a에 적용되지 않는다",
  );
});

test("apply-route-map-line-tracks --check does not write and flags missing line license", async () => {
  const positions = [{
    station_id: "s1", line_id: "line-a", x: 0, y: 0,
    source_id: "src", source_name: "공식", source_url: "https://example.test",
    license: "public-reference", license_status: "reviewed",
    commercial_use_allowed: 0, attribution_required: 1,
  }];
  // --check: 파일 미기록 → route_map_line_tracks 없음(빈 rows).
  const checkRun = await runApplyLineTracks({
    region: "테스트권", positions,
    tracksDocs: [{ region: "테스트권", source: "svg-strokes", lines: [{ lineId: "line-a", svgColor: "#ff0000", paths: ["M 0 0 L 10 0"] }] }],
    args: ["--check"],
  });
  assert.equal(checkRun.rows.length, 0);
  assert.equal(checkRun.indexCapital.sqliteSha256, "old"); // --check는 index도 안 건드림

  // route_map_positions에 없는 노선을 tracks가 참조하면 실패.
  await assert.rejects(
    runApplyLineTracks({
      region: "테스트권", positions,
      tracksDocs: [{ region: "테스트권", source: "svg-strokes", lines: [{ lineId: "line-ghost", svgColor: "#00ff00", paths: ["M 0 0 L 1 0"] }] }],
    }),
    /line-ghost/,
  );
});
