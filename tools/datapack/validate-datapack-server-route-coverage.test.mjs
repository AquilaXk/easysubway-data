import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { canonicalJson, sha256 } from "./lib/manifest-validation.mjs";
import { candidatePinnedJson, candidatePinnedReader } from "./test-fixtures/candidate-pinned-inputs.mjs";
import {
  assertClaimedStationLinesHaveRouteEndpoints,
  assertLaunchScopeLinesHaveTimetableTrips,
  assertServerRouteCoverageConsumed,
  isAuthorizedServerRouteCoverageGap,
  parseArgs,
  parseServerRouteCoverageProvenance,
  parseServerRouteCoverageEvidence,
  resolveRoutePresenceScope,
} from "./validate-datapack.mjs";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const pinnedReadPromise = candidatePinnedReader({ root: repositoryRoot });

// #866 PR-B: 인정 경로는 capital@1·213·30·456 상수가 아니라 pack의 비RIDE 간선에서 분모를 유도한다.
// D1: 환승(역 안·역 밖)은 양끝 TRANSFER cell이 닫혀야 한다.
// #873: authority·팩에는 ENTRY/EXIT 간선이 없고 coverage 필수 쌍은 환승뿐이다.
// #866 PR-C: 수도권 live chain(legacy) authority의 ENTRY/EXIT 열거가 없어졌다. pack id·후보 id와 무관하게 같은 규칙이다.
const SHAPES = [
  ["capital@1(수도권 후보 id, 환승 30)", { id: "capital", transfers: 30, outOfStation: 0 }],
  ["nationwide@1", { id: "nationwide", transfers: 6, outOfStation: 2 }],
  ["다른 pack id", { id: "fixture-national-network", transfers: 2, outOfStation: 2 }],
];
const NATIONWIDE = { id: "nationwide", transfers: 6, outOfStation: 2 };

for (const [label, shape] of SHAPES) {
  test(`server route coverage authority는 ${label}의 pack 유도 분모·1:1 결속·provenance를 한 번 소비한다`, () => {
    const report = authorityReport(shape);
    const bytes = Buffer.from(canonicalJson(report));
    assert.deepEqual(parseServerRouteCoverageEvidence(bytes), report);
    assert.throws(() => parseServerRouteCoverageEvidence(Buffer.concat([bytes, Buffer.from("\n")])), /canonical/);
    assert.throws(() => parseServerRouteCoverageEvidence(Buffer.from(canonicalJson({ ...report, authoritySha256: "b".repeat(64) }))), /hash/);
    const args = authorizationArgs(report, shape);
    assert.equal(isAuthorizedServerRouteCoverageGap(args), true);
    assert.equal(isAuthorizedServerRouteCoverageGap({ ...args, pack: { ...args.pack, version: "2" } }), false);
    assert.equal(isAuthorizedServerRouteCoverageGap({ ...args, pack: { ...args.pack, artifactKind: "fixture" } }), false);
    assert.equal(isAuthorizedServerRouteCoverageGap({ ...args, provenance: { ...args.provenance, candidateFixtureSha256: "0".repeat(64) } }), false);
    assert.equal(isAuthorizedServerRouteCoverageGap({ ...args, unverifiedAccessibilityCoverageEdges: ["edge-entry-000"] }), false);
    assert.equal(isAuthorizedServerRouteCoverageGap({ ...args, coverage: { ...args.coverage, transfer: { ...args.coverage.transfer, missingCount: args.coverage.transfer.missingCount - 1 } } }), false);
  });
}

test("authority에 없는 비RIDE 간선·누락 간선·시간·거리·끝점·상태 불일치는 인정하지 않는다", () => {
  const shape = NATIONWIDE;
  const report = authorityReport(shape);
  const args = authorizationArgs(report, shape);
  const rows = args.edgeRows;
  const index = rows.findIndex(({ edge_type: type }) => type === "OUT_OF_STATION_TRANSFER");
  const cases = [
    ["authority에 없는 ENTRY", [...rows, accessRow("ENTRY")]],
    ["authority에 없는 EXIT", [...rows, accessRow("EXIT")]],
    ["authority에 없는 역 밖 환승", [...rows, { ...rows[index], id: "edge-out-extra" }]],
    ["pack에서 빠진 간선", rows.filter((_, position) => position !== index)],
    ["중복 간선", [...rows, rows[index]]],
    ["시간 불일치", rows.map((row, position) => position === index ? { ...row, duration_seconds: row.duration_seconds + 1 } : row)],
    ["거리 불일치", rows.map((row, position) => position === index ? { ...row, distance_meters: row.distance_meters + 1 } : row)],
    ["끝점 불일치", rows.map((row, position) => position === index ? { ...row, to_node_id: "station-999:line-x" } : row)],
    ["type 불일치", rows.map((row, position) => position === index ? { ...row, edge_type: "IN_STATION_TRANSFER" } : row)],
    ["검증 상태 혼입", rows.map((row, position) => position === index ? { ...row, verification_status: "NOT_VERIFIED" } : row)],
  ];
  for (const [label, edgeRows] of cases) {
    assert.equal(isAuthorizedServerRouteCoverageGap({ ...args, edgeRows }), false, label);
  }
});

test("edgeCounts가 pack 간선 수와 다르면 재봉인해도 인정하지 않는다", () => {
  const shape = NATIONWIDE;
  const report = authorityReport(shape);
  const args = authorizationArgs(report, shape);
  // authority 자체는 edgeCounts와 실제 간선이 어긋나면 파싱에서 거부된다.
  const forged = structuredClone(report);
  forged.edgeCounts.IN_STATION_TRANSFER += 1;
  forged.edgeCounts.total += 1;
  reseal(forged);
  assert.throws(() => parseServerRouteCoverageEvidence(Buffer.from(canonicalJson(forged))), /denominator/);
  // pack에만 간선이 더 있는 경우(authority 분모 밖)도 인정하지 않는다.
  const extraTransfer = { ...args.edgeRows.find(({ edge_type: type }) => type === "IN_STATION_TRANSFER"), id: "edge-in-station-transfer-zzz" };
  assert.equal(isAuthorizedServerRouteCoverageGap({ ...args, edgeRows: [...args.edgeRows, extraTransfer] }), false);
});

test("coverage 필수 쌍이 authority 간선으로 뒷받침되지 않으면 인정하지 않는다", () => {
  const shape = NATIONWIDE;
  const report = authorityReport(shape);
  const args = authorizationArgs(report, shape);
  const transfer = new Set(args.requiredPairs.transfer);
  transfer.add("station-000:line-a->station-001:line-a");
  assert.equal(isAuthorizedServerRouteCoverageGap({
    ...args,
    requiredPairs: { ...args.requiredPairs, transfer },
    coverage: { ...args.coverage, transfer: { denominator: transfer.size, missingCount: transfer.size } },
  }), false);
  const { requiredPairs: _ignored, ...withoutPairs } = args;
  assert.equal(isAuthorizedServerRouteCoverageGap(withoutPairs), false);
});

test("authority edge/cell/candidate/provenance drift는 canonical hash를 다시 봉인해도 거부된다", () => {
  const shape = NATIONWIDE;
  const transferIndex = (value) => value.edges.findIndex(({ edgeType }) => edgeType === "OUT_OF_STATION_TRANSFER");
  for (const [label, mutate, pattern] of [
    ["edge denominator", (value) => { value.edges.pop(); }, /denominator|coverage/i],
    ["환승 끝점 UNKNOWN", (value) => { value.edges[transferIndex(value)].requiredCells[0].state = "UNKNOWN"; }, /cell|state/i],
    ["환승 cell 누락", (value) => { value.edges[transferIndex(value)].requiredCells.pop(); }, /required cell denominator/i],
    ["전국 ENTRY 간선 추가", (value) => { addAuthorityEdge(value, edge("ENTRY", 0)); }, /nationwide authority must not contain ENTRY\/EXIT edges/],
    ["전국 EXIT 간선 추가", (value) => { addAuthorityEdge(value, edge("EXIT", 0)); }, /nationwide authority must not contain ENTRY\/EXIT edges/],
    ["cell endpoint", (value) => { value.edges[transferIndex(value)].requiredCells[0].lineId = "seoul-4"; }, /cell endpoint/i],
    ["route hash", (value) => { value.edges[0].routeEdgeSha256 = "0".repeat(64); }, /route edge hash/i],
    ["candidate", (value) => { value.candidate.sourceSetSha256 = "0".repeat(64); }, /candidate|binding/i],
    ["build input", (value) => { value.buildInput.candidateFixtureSha256 = "0".repeat(64); }, /binding|provenance/i],
  ]) {
    const report = authorityReport(shape);
    mutate(report);
    reseal(report);
    if (label === "candidate" || label === "build input") {
      const parsed = parseServerRouteCoverageEvidence(Buffer.from(canonicalJson(report)));
      assert.equal(isAuthorizedServerRouteCoverageGap({
        ...authorizationArgs(parsed, shape),
        provenance: parseServerRouteCoverageProvenance(provenanceBytes(authorityReport(shape))),
      }), false, label);
    } else {
      assert.throws(() => parseServerRouteCoverageEvidence(Buffer.from(canonicalJson(report))), pattern, label);
    }
  }
});

test("#873 coverage는 환승 필수 쌍만 요구하고, 환승 coverage가 빠지거나 덜 미검증이면 인정하지 않는다", () => {
  const report = authorityReport(NATIONWIDE);
  const args = authorizationArgs(report, NATIONWIDE);
  assert.deepEqual(Object.keys(args.coverage), ["transfer"]);
  assert.equal(isAuthorizedServerRouteCoverageGap(args), true);
  const { transfer: _transfer, ...withoutTransferCoverage } = args.coverage;
  assert.equal(isAuthorizedServerRouteCoverageGap({ ...args, coverage: withoutTransferCoverage }), false);
  assert.equal(isAuthorizedServerRouteCoverageGap({ ...args, requiredPairs: {} }), false);
  assert.equal(isAuthorizedServerRouteCoverageGap({
    ...args,
    coverage: { transfer: { ...args.coverage.transfer, denominator: args.coverage.transfer.denominator + 1 } },
  }), false);
  // 환승 authority 간선이 빠지면 필수 쌍을 뒷받침하지 못한다.
  const withoutTransferEdges = args.edgeRows.filter(({ edge_type: type }) => type !== "IN_STATION_TRANSFER");
  assert.equal(isAuthorizedServerRouteCoverageGap({ ...args, edgeRows: withoutTransferEdges }), false);
});

// #866 PR-C: 예전에는 수도권 후보 id authority가 ENTRY·EXIT를 증거 cell 없이 열거할 수 있었다(둘 다 있거나 둘 다 없음).
// 이제 후보 id와 무관하게 ENTRY/EXIT가 하나라도 있으면 파싱에서 명시적으로 실패한다.
test("#866 PR-C authority는 후보 id와 무관하게 ENTRY/EXIT 간선을 거부한다", () => {
  for (const id of ["capital", "nationwide"]) {
    const shape = { id, transfers: 2, outOfStation: 0 };
    assert.doesNotThrow(() => parseServerRouteCoverageEvidence(Buffer.from(canonicalJson(authorityReport(shape)))), id);
    for (const edgeTypes of [["ENTRY"], ["EXIT"], ["ENTRY", "EXIT"]]) {
      const report = authorityReport(shape);
      for (const edgeType of edgeTypes) addAuthorityEdge(report, edge(edgeType, 0));
      reseal(report);
      assert.throws(() => parseServerRouteCoverageEvidence(Buffer.from(canonicalJson(report))),
        /nationwide authority must not contain ENTRY\/EXIT edges/, `${id} ${edgeTypes.join("+")}`);
    }
  }
});

// #873 리뷰 F1: ENTRY coverage가 함께 확인하던 청구 역-노선 존재성을 승강장 기준으로 옮긴다.
// 전국 팩은 RIDE·환승 간선 끝점만 인정하고, legacy(비전국) 팩만 ENTRY/EXIT 끝점도 인정한다(PR-D(#866)에서 제거).
function presenceRows() {
  const pack = { id: "nationwide", version: "1" };
  const stationLineRows = [
    { station_id: "station-a", line_id: "line-1" },
    { station_id: "station-a", line_id: "line-2" },
    { station_id: "station-b", line_id: "line-1" },
  ];
  const edgeRows = [
    { edge_type: "RIDE", from_node_id: "station-a:line-1", to_node_id: "station-b:line-1", service_class: "SUBWAY", service_pattern: "LOCAL" },
    { edge_type: "IN_STATION_TRANSFER", from_node_id: "station-a:line-1", to_node_id: "station-a:line-2", service_class: "SUBWAY", service_pattern: "" },
  ];
  return { pack, stationLineRows, edgeRows };
}

test("#873 F1 전국 팩은 청구 역-노선이 RIDE·환승 간선 끝점이면 통과하고 아니면 실패한다", () => {
  const { pack, stationLineRows, edgeRows } = presenceRows();
  assert.doesNotThrow(() => assertClaimedStationLinesHaveRouteEndpoints({ pack, stationLineRows, edgeRows, nationwide: true }));
  // RIDE를 빼면 station-b:line-1은 어떤 간선 끝점도 아니다.
  assert.throws(() => assertClaimedStationLinesHaveRouteEndpoints({
    pack, stationLineRows, edgeRows: edgeRows.filter(({ edge_type: type }) => type !== "RIDE"), nationwide: true,
  }), /claimed station-line has no route edge endpoint: 1 \(station-b:line-1\)/);
  // ITX 급행 노드(:EXPRESS)는 ITX RIDE일 때만 그 승강장 노드로 인정한다.
  const itxOnly = [{ edge_type: "RIDE", from_node_id: "station-a:line-1:EXPRESS", to_node_id: "station-b:line-1:EXPRESS", service_class: "ITX_CHEONGCHUN", service_pattern: "EXPRESS" }, edgeRows[1]];
  assert.doesNotThrow(() => assertClaimedStationLinesHaveRouteEndpoints({ pack, stationLineRows, edgeRows: itxOnly, nationwide: true }));
  const fakeItx = [{ ...itxOnly[0], service_class: "SUBWAY", service_pattern: "LOCAL" }, edgeRows[1]];
  assert.throws(() => assertClaimedStationLinesHaveRouteEndpoints({ pack, stationLineRows, edgeRows: fakeItx, nationwide: true }),
    /claimed station-line has no route edge endpoint: 1 \(station-b:line-1\)/);
});

test("#873 F1 전국 팩에서 ENTRY/EXIT로만 존재하는 청구 역-노선은 실패하고, legacy 팩만 인정한다", () => {
  const { pack, stationLineRows, edgeRows } = presenceRows();
  const accessOnly = [
    edgeRows[1],
    { edge_type: "ENTRY", from_node_id: "station-b", to_node_id: "station-b:line-1", service_class: "SUBWAY", service_pattern: "" },
    { edge_type: "EXIT", from_node_id: "station-b:line-1", to_node_id: "station-b", service_class: "SUBWAY", service_pattern: "" },
  ];
  assert.throws(() => assertClaimedStationLinesHaveRouteEndpoints({ pack, stationLineRows, edgeRows: accessOnly, nationwide: true }),
    /claimed station-line has no route edge endpoint: 1 \(station-b:line-1\)/);
  assert.doesNotThrow(() => assertClaimedStationLinesHaveRouteEndpoints({
    pack: { id: "capital", version: "1" }, stationLineRows, edgeRows: accessOnly, nationwide: false,
  }));
  // legacy 팩도 어떤 간선 끝점도 아니면 실패한다.
  assert.throws(() => assertClaimedStationLinesHaveRouteEndpoints({
    pack: { id: "capital", version: "1" }, stationLineRows, edgeRows: [edgeRows[1]], nationwide: false,
  }), /capital@1 claimed station-line has no route edge endpoint: 1 \(station-b:line-1\)/);
  assert.throws(() => assertClaimedStationLinesHaveRouteEndpoints({ pack, stationLineRows, edgeRows }), /nationwide flag is required/);
});

// #873 리뷰 후속(메인 결정 (a)): provenance가 빠졌다고 legacy(약한 경로)로 내려가지 않는다.
// legacy 판정은 provenance 후보 id가 legacy이거나, fixture 빌드 legacy 팩에 --legacy-fixture-production을 명시한 경우뿐이다.
test("#873 --require-production은 provenance 또는 명시 legacy 플래그 없이 실패한다", () => {
  const legacyProvenance = { candidateId: "capital-pilot-candidate-20260816" };
  const nationwideProvenance = { candidateId: "nationwide-candidate-20261001-seq123" };
  assert.deepEqual(resolveRoutePresenceScope({ requireProduction: true, provenance: nationwideProvenance, legacyFixtureProduction: false, nationwideArtifact: true }), { nationwide: true });
  assert.deepEqual(resolveRoutePresenceScope({ requireProduction: true, provenance: legacyProvenance, legacyFixtureProduction: false, nationwideArtifact: false }), { nationwide: false });
  assert.deepEqual(resolveRoutePresenceScope({ requireProduction: true, provenance: null, legacyFixtureProduction: true, nationwideArtifact: false }), { nationwide: false });
  // 플래그 없음 + provenance 없음 + --require-production
  assert.throws(() => resolveRoutePresenceScope({ requireProduction: true, provenance: null, legacyFixtureProduction: false, nationwideArtifact: false }),
    /--require-production requires server route coverage provenance/);
  // 플래그 + provenance
  assert.throws(() => resolveRoutePresenceScope({ requireProduction: true, provenance: legacyProvenance, legacyFixtureProduction: true, nationwideArtifact: false }),
    /--legacy-fixture-production cannot be combined with server route coverage provenance/);
  // 플래그 + 전국 후보 팩
  assert.throws(() => resolveRoutePresenceScope({ requireProduction: true, provenance: null, legacyFixtureProduction: true, nationwideArtifact: true }),
    /--legacy-fixture-production cannot validate a nationwide candidate artifact/);
  // --require-production이 아니면 출시 게이트 판정이 없다.
  assert.equal(resolveRoutePresenceScope({ requireProduction: false, provenance: null, legacyFixtureProduction: false, nationwideArtifact: false }), null);
  // 인자 조합: 플래그는 --require-production이 필요하고 evidence·provenance와 함께 쓸 수 없다.
  assert.equal(parseArgs(["--manifest", "m.json", "--root", "out", "--require-production", "--legacy-fixture-production"])["legacy-fixture-production"], true);
  assert.throws(() => parseArgs(["--manifest", "m.json", "--root", "out", "--legacy-fixture-production"]), /--legacy-fixture-production requires --require-production/);
  assert.throws(() => parseArgs(["--manifest", "m.json", "--root", "out", "--require-production", "--legacy-fixture-production",
    "--server-route-coverage-evidence", "a.json", "--server-route-coverage-provenance", "p.json"]), /--legacy-fixture-production cannot be combined with server route coverage provenance/);
});

test("server route coverage evidence는 provenance와 --require-production이 함께여야 하고 한 번만 소비된다", () => {
  const parsedArgs = parseArgs(["--manifest", "manifest.json", "--root", "out", "--require-production", "--server-route-coverage-evidence", "authority.json", "--server-route-coverage-provenance", "provenance.json"]);
  assert.equal(parsedArgs["server-route-coverage-evidence"], "authority.json");
  assert.throws(() => parseArgs(["--manifest", "manifest.json", "--root", "out", "--require-production", "--server-route-coverage-evidence", "authority.json"]), /evidence and provenance/);
  assert.doesNotThrow(() => assertServerRouteCoverageConsumed(null));
  assert.doesNotThrow(() => assertServerRouteCoverageConsumed({ consumptionCount: 1 }));
  assert.throws(() => assertServerRouteCoverageConsumed({ consumptionCount: 0 }), /not consumed exactly once/);
});

test("#900 전국 출시 범위 노선은 transit_trips·transit_stop_times가 모두 있어야 통과하고 0-trip 노선은 차단한다", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(`
      CREATE TABLE lines (id TEXT PRIMARY KEY);
      CREATE TABLE transit_routes (id TEXT PRIMARY KEY, line_id TEXT NOT NULL);
      CREATE TABLE transit_trips (id TEXT PRIMARY KEY, route_id TEXT NOT NULL);
      CREATE TABLE transit_stop_times (trip_id TEXT NOT NULL, line_id TEXT NOT NULL);
    `);
    database.exec(`
      INSERT INTO lines (id) VALUES ('seoul-4'), ('seoul-1'), ('arex');
      INSERT INTO transit_routes (id, line_id) VALUES ('route-seoul-4', 'seoul-4'), ('route-seoul-1', 'seoul-1'), ('route-arex', 'arex');
      INSERT INTO transit_trips (id, route_id) VALUES ('trip-seoul-4-1', 'route-seoul-4');
      INSERT INTO transit_stop_times (trip_id, line_id) VALUES ('trip-seoul-4-1', 'seoul-4');
    `);
    const pack = {
      id: "nationwide",
      version: "1",
      lines: [{ id: "seoul-4" }, { id: "seoul-1" }],
      verifiedAccessibilityScope: { includedLineIds: ["seoul-4", "arex", "shinbundang"] },
    };

    assert.throws(
      () => assertLaunchScopeLinesHaveTimetableTrips({ database, pack }),
      /launch-scope line timetable presence nationwide flag is required/,
    );
    assert.doesNotThrow(() => assertLaunchScopeLinesHaveTimetableTrips({ database, pack, nationwide: false }));
    assert.throws(
      () => assertLaunchScopeLinesHaveTimetableTrips({ database, pack, nationwide: true }),
      /nationwide@1 launch-scope line has 0 transit_trips: 3 \(arex, seoul-1, shinbundang\)/,
    );

    database.exec(`
      INSERT INTO lines (id) VALUES ('shinbundang');
      INSERT INTO transit_routes (id, line_id) VALUES ('route-shinbundang', 'shinbundang');
      INSERT INTO transit_trips (id, route_id) VALUES
        ('trip-seoul-1-1', 'route-seoul-1'),
        ('trip-arex-1', 'route-arex'),
        ('trip-shinbundang-1', 'route-shinbundang');
      INSERT INTO transit_stop_times (trip_id, line_id) VALUES
        ('trip-seoul-1-1', 'seoul-1'),
        ('trip-arex-1', 'arex');
    `);
    // shinbundang은 trip은 있으나 stop_times가 0건이므로 차단된다.
    assert.throws(
      () => assertLaunchScopeLinesHaveTimetableTrips({ database, pack, nationwide: true }),
      /nationwide@1 launch-scope line has 0 transit_trips: 1 \(shinbundang\)/,
    );

    database.exec(`INSERT INTO transit_stop_times (trip_id, line_id) VALUES ('trip-shinbundang-1', 'shinbundang');`);
    assert.doesNotThrow(() => assertLaunchScopeLinesHaveTimetableTrips({ database, pack, nationwide: true }));
  } finally {
    database.close();
  }

  // seq 124 재현 픽스처(capital-production-canonical-pack.json)의 33개 0-trip 노선 상태를 전국 게이트에서 차단한다.
  const pinnedRead = await pinnedReadPromise;
  const seq124Doc = await candidatePinnedJson(pinnedRead, "tools/datapack/release/capital-production-canonical-pack.json");
  const seq124Pack = seq124Doc.packs ? seq124Doc.packs[0] : seq124Doc;
  const seq124Db = new DatabaseSync(":memory:");
  try {
    seq124Db.exec(`
      CREATE TABLE lines (id TEXT PRIMARY KEY);
      CREATE TABLE transit_routes (id TEXT PRIMARY KEY, line_id TEXT NOT NULL);
      CREATE TABLE transit_trips (id TEXT PRIMARY KEY, route_id TEXT NOT NULL);
      CREATE TABLE transit_stop_times (trip_id TEXT NOT NULL, line_id TEXT NOT NULL);
    `);
    const insertLine = seq124Db.prepare("INSERT OR IGNORE INTO lines (id) VALUES (?)");
    for (const line of seq124Doc.lines ?? seq124Pack.lines ?? []) insertLine.run(line.id);
    const insertRoute = seq124Db.prepare("INSERT OR IGNORE INTO transit_routes (id, line_id) VALUES (?, ?)");
    for (const route of seq124Doc.transitRoutes ?? seq124Pack.transitRoutes ?? []) insertRoute.run(route.id, route.lineId ?? route.line_id);
    const insertTrip = seq124Db.prepare("INSERT OR IGNORE INTO transit_trips (id, route_id) VALUES (?, ?)");
    for (const trip of seq124Doc.transitTrips ?? seq124Pack.transitTrips ?? []) insertTrip.run(trip.id, trip.routeId ?? trip.route_id);
    const insertStopTime = seq124Db.prepare("INSERT INTO transit_stop_times (trip_id, line_id) VALUES (?, ?)");
    for (const stopTime of seq124Doc.transitStopTimes ?? seq124Pack.transitStopTimes ?? []) {
      insertStopTime.run(stopTime.tripId ?? stopTime.trip_id, stopTime.lineId ?? stopTime.line_id);
    }
    assert.throws(
      () => assertLaunchScopeLinesHaveTimetableTrips({
        database: seq124Db,
        pack: {
          id: "capital",
          version: "1",
          lines: seq124Doc.lines ?? seq124Pack.lines ?? [],
          verifiedAccessibilityScope: seq124Doc.verifiedAccessibilityScope ?? seq124Pack.verifiedAccessibilityScope,
        },
        nationwide: true,
      }),
      /capital@1 launch-scope line has 0 transit_trips: 33 \(line-051552e50435, line-0ffaa95b1b5d, .*seoul-2, shinbundang\)/,
    );
  } finally {
    seq124Db.close();
  }
});

test("#1262 report-coverage-gaps는 --manifest 검증에서 schedule_timetable 공백을 던지지 않고 report에 기록한다(시간표 0건 차단은 assertLaunchScopeLinesHaveTimetableTrips 몫)", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "easysubway-900-coverage-gap-"));
  try {
    const targets = JSON.parse(await readFile(path.join(repositoryRoot, "tools/datapack/nationwide-coverage-targets.json"), "utf8"));
    const regionNames = new Map(targets.regions.map((region) => [region.id, region.displayName]));
    const inventory = {
      schemaVersion: 1,
      region: "nationwide",
      artifactKind: "production-source-inventory",
      retrievedAt: "2026-06-22",
      sources: targets.activeLineScopes.flatMap((scope) =>
        targets.requiredSourceDomains.map((domain) => ({
          id: `${scope.regionId}-${scope.operatorId}-${scope.lineId}-${domain.id}`,
          displayName: `${regionNames.get(scope.regionId)} ${scope.operatorId} ${scope.lineId} ${domain.id}`,
          owner: "테스트 운영기관",
          provider: "테스트 운영기관",
          providerDepartment: "테스트",
          sourceSystem: "테스트",
          datasetUrl: `https://example.invalid/${scope.regionId}/${scope.operatorId}/${scope.lineId}/${domain.id}`,
          datasetKind: "fixture-only",
          coverageScope: {
            regionIds: [scope.regionId],
            operatorIds: [scope.operatorId],
            lineIds: [scope.lineId],
            sourceDomains: [domain.id],
          },
          requiredForProductionPack: true,
          updateFrequency: "daily",
          observedDataUpdatedAt: "2026-06-22",
          retrievedAt: "2026-06-22",
          license: {
            type: "KOGL-1",
            name: "공공누리 1유형",
            attribution: "테스트",
            commercialUseAllowed: true,
            derivativeWorkAllowed: true,
            redistributionAllowed: true,
            evidenceUrl: "https://example.invalid/license",
          },
          capabilities: {
            schedule: { status: "UNSUPPORTED", productionUseAllowed: false, coverageStatus: "NOT_PROVIDED_BY_SOURCE", updateFrequency: "daily", unsupportedNotes: "none" },
            realtime: { status: "UNSUPPORTED", productionUseAllowed: false, liveEtaEligible: false, rateLimitStatus: "NOT_APPLICABLE", coverageStatus: "NOT_PROVIDED_BY_SOURCE", updateFrequency: "daily", unsupportedNotes: "none" },
            facility: { status: "UNSUPPORTED", productionUseAllowed: false, coverageStatus: "NOT_PROVIDED_BY_SOURCE", updateFrequency: "daily", unsupportedNotes: "none" },
          },
          fieldsProvided: domain.requiredFields,
        })),
      ),
    };
    const scheduleSrc = inventory.sources.find(
      (source) =>
        source.coverageScope.operatorIds?.includes("daejeon-transportation") &&
        source.coverageScope.lineIds?.includes("line-7051a9c2525c") &&
        source.coverageScope.sourceDomains?.includes("schedule_timetable"),
    );
    delete scheduleSrc.coverageScope.lineIds;

    const manifestObj = {
      manifestVersion: 2,
      activePack: { id: "capital", version: "1" },
      packs: [{ id: "capital", version: "1", artifactKind: "production", sqliteSha256: "a".repeat(64) }],
    };
    const manifestBytes = Buffer.from(`${JSON.stringify(manifestObj, null, 2)}\n`);
    const provenanceObj = {
      schemaVersion: 1,
      artifactKind: "datapack-field-provenance",
      manifestSha256: sha256(manifestBytes),
      packs: [{
        id: "capital",
        version: "1",
        artifactKind: "production",
        sqliteSha256: "a".repeat(64),
        records: inventory.sources.flatMap((source) =>
          source.fieldsProvided.map((field) => ({
            entityType: "station_line",
            entityId: `${source.id}:${field}`,
            field,
            sourceId: source.id,
            verifiedAt: "2026-06-22T00:00:00.000Z",
            derivationKind: "OFFICIAL",
            coverageScope: {
              regionIds: source.coverageScope.regionIds,
              operatorIds: source.coverageScope.operatorIds,
              ...(source.coverageScope.lineIds ? { lineIds: source.coverageScope.lineIds } : {}),
              sourceDomains: source.coverageScope.sourceDomains,
            },
          })),
        ),
      }],
    };
    const scopeObj = {
      decision: { currentLaunchDecision: "NO_GO", blocker: "RELEASE_EVIDENCE_PENDING" },
      verifiedAccessibilityScope: {
        id: "daejeon_pilot_candidate_scope",
        regionIds: ["daejeon"],
        includedOperatorIds: ["daejeon-transportation"],
        includedLineIds: ["line-7051a9c2525c"],
      },
    };
    const inventoryPath = path.join(workspace, "inventory.json");
    const manifestPath = path.join(workspace, "current.json");
    const provenancePath = path.join(workspace, "current.provenance.json");
    const scopePath = path.join(workspace, "scope.json");
    const outputPath = path.join(workspace, "gap-report.json");
    await writeFile(inventoryPath, JSON.stringify(inventory));
    await writeFile(manifestPath, manifestBytes);
    await writeFile(provenancePath, JSON.stringify(provenanceObj));
    await writeFile(scopePath, JSON.stringify(scopeObj));

    // 시간표 존재 차단은 validate-datapack의 assertLaunchScopeLinesHaveTimetableTrips가 후보 sqlite를 직접 세어 맡는다.
    // 이 도구는 field provenance 기준 공백을 막지 않고 숨기지도 않는다: 종료 코드 0, report에 MISSING으로 남는다.
    await execFileAsync(process.execPath, [
      "tools/datapack/report-coverage-gaps.mjs",
      "--output", outputPath,
      "--release-scope", scopePath,
      "--inventory", inventoryPath,
      "--provenance", provenancePath,
      "--manifest", manifestPath,
      "--release-targets", "tools/datapack/nationwide-coverage-targets.json",
      "--targets", "tools/datapack/nationwide-coverage-targets.json",
    ], { cwd: repositoryRoot });
    const report = JSON.parse(await readFile(outputPath, "utf8"));
    const scheduleGap = report.releaseScopeRequirements.find(
      (entry) => entry.sourceDomain === "schedule_timetable" && entry.lineId === "line-7051a9c2525c",
    );
    assert.ok(scheduleGap, "출시 범위 schedule_timetable 요구가 report에 있어야 한다");
    assert.notEqual(scheduleGap.status, "covered");
    assert.notEqual(scheduleGap.status, "SUPPORTED");
    assert.ok(scheduleGap.missingFields.length > 0, "공백 필드가 report에 기록돼야 한다");
    assert.ok(report.summary.missingRequirements > 0, "전국 공백 수치가 report에 기록돼야 한다");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

function authorizationArgs(report, shape) {
  const edgeRows = sqliteRows(report);
  const requiredPairs = requiredPairsFrom(report);
  return {
    pack: { id: shape.id, version: "1", artifactKind: "production" },
    report,
    provenance: parseServerRouteCoverageProvenance(provenanceBytes(report)),
    coverage: Object.fromEntries(Object.entries(requiredPairs)
      .map(([kind, pairs]) => [kind, { denominator: pairs.size, missingCount: pairs.size }])),
    requiredPairs,
    edgeRows,
    unverifiedAccessibilityCoverageEdges: [],
  };
}

// validate-datapack은 claimed scope의 역-노선에서 환승 필수 쌍만 만든다(#873). 여기서는 authority 간선과 같은 쌍을 쓴다.
function requiredPairsFrom(report) {
  const pairs = { transfer: new Set() };
  for (const edge of report.edges) {
    if (edge.edgeType === "IN_STATION_TRANSFER") pairs.transfer.add(`${edge.fromNodeId}->${edge.toNodeId}`);
  }
  return pairs;
}

function accessRow(edgeType) {
  const value = edge(edgeType, 999);
  return {
    id: value.edgeId,
    from_node_id: value.fromNodeId,
    to_node_id: value.toNodeId,
    edge_type: value.edgeType,
    duration_seconds: value.durationSeconds,
    distance_meters: value.distanceMeters,
    verification_status: "UNKNOWN",
    stair_access_state: "UNKNOWN",
    accessibility_status: "UNKNOWN",
  };
}

function addAuthorityEdge(report, value) {
  report.edges = [...report.edges, value].sort((left, right) => Buffer.compare(Buffer.from(left.edgeId), Buffer.from(right.edgeId)));
  report.edgeCounts = { ...report.edgeCounts, [value.edgeType]: (report.edgeCounts[value.edgeType] ?? 0) + 1, total: report.edges.length };
}

function authorityReport({ id, transfers, outOfStation }) {
  const candidate = {
    candidateId: id === "capital" ? "current-capital-candidate-20260816" : "nationwide-candidate-20261001-seq900",
    mappingContractVersion: "station-line-v1",
    materializerVersion: "1",
    sourceSetSha256: "a".repeat(64),
    stationSetSha256: "b".repeat(64),
  };
  const edges = [
    ...Array.from({ length: transfers }, (_, index) => edge("IN_STATION_TRANSFER", index)),
    ...Array.from({ length: outOfStation }, (_, index) => edge("OUT_OF_STATION_TRANSFER", index)),
  ].sort((left, right) => Buffer.compare(Buffer.from(left.edgeId), Buffer.from(right.edgeId)));
  const edgeCounts = Object.fromEntries(Object.entries({
    IN_STATION_TRANSFER: transfers, OUT_OF_STATION_TRANSFER: outOfStation,
  }).filter(([, count]) => count > 0));
  const payload = {
    schemaVersion: 1,
    artifactKind: "server-route-coverage-authority",
    candidate,
    buildInput: {
      buildSpecSha256: "c".repeat(64),
      sourceFixtureSha256: "d".repeat(64),
      candidateFixtureSha256: "e".repeat(64),
      stationLineInputSha256: "f".repeat(64),
      routeEdgeInputSha256: "1".repeat(64),
      transferMetricsSha256: sha(Buffer.from("fixture-transfer-metrics")),
      materializationDigest: "2".repeat(64),
      observedAt: "2026-08-16T00:00:00.000Z",
    },
    edgeCounts: { ...edgeCounts, total: edges.length },
    edges,
  };
  return JSON.parse(canonicalJson({ ...payload, authoritySha256: sha(canonicalJson(payload)) }));
}

function edge(edgeType, index) {
  const suffix = String(index).padStart(3, "0");
  const stationId = `station-${suffix}`;
  const nextStationId = `station-${String(index + 1).padStart(3, "0")}`;
  const nodes = {
    ENTRY: [stationId, `${stationId}:line-a`],
    EXIT: [`${stationId}:line-a`, stationId],
    IN_STATION_TRANSFER: [`${stationId}:line-a`, `${stationId}:line-b`],
    OUT_OF_STATION_TRANSFER: [`${stationId}:line-a`, `${nextStationId}:line-c`],
  }[edgeType];
  const transfer = edgeType.endsWith("_TRANSFER");
  const value = {
    edgeId: `edge-${edgeType.toLowerCase().replaceAll("_", "-")}-${suffix}`,
    edgeType,
    fromNodeId: nodes[0],
    toNodeId: nodes[1],
    durationSeconds: transfer ? 120 : 0,
    distanceMeters: transfer ? 150 : 0,
    // ENTRY/EXIT 간선은 거부 회귀용으로만 만든다(증거 cell 없음). authority는 이를 받지 않는다(#873, #866 PR-C).
    requiredCells: transfer
      ? [
        cell(...nodes[0].split(":"), "TRANSFER", "VERIFIED_PRESENT"),
        cell(...nodes[1].split(":"), "TRANSFER", index === 0 ? "NOT_APPLICABLE" : "VERIFIED_PRESENT"),
      ]
      : [],
  };
  return {
    ...value,
    routeEdgeSha256: sha(canonicalJson({
      edgeId: value.edgeId,
      edgeType: value.edgeType,
      fromNodeId: value.fromNodeId,
      toNodeId: value.toNodeId,
      durationSeconds: value.durationSeconds,
      distanceMeters: value.distanceMeters,
      servicePattern: "",
      serviceClass: "SUBWAY",
    })),
  };
}

function cell(stationId, lineId, domain, state) {
  return { stationId, lineId, domain, state, rowSha256: sha(`${stationId}:${lineId}:${domain}:${state}`) };
}

function provenanceBytes(report) {
  return Buffer.from(JSON.stringify({
    candidateBuild: {
      candidateId: report.candidate.candidateId,
      sourceSnapshotSetHash: report.candidate.sourceSetSha256,
      buildSpecSha256: report.buildInput.buildSpecSha256,
      sourceFixtureSha256: report.buildInput.sourceFixtureSha256,
      candidateFixtureSha256: report.buildInput.candidateFixtureSha256,
      serverRouteCoverageAuthoritySha256: report.authoritySha256,
    },
  }));
}

function sqliteRows(report) {
  return report.edges.map((edge) => ({
    id: edge.edgeId,
    from_node_id: edge.fromNodeId,
    to_node_id: edge.toNodeId,
    edge_type: edge.edgeType,
    duration_seconds: edge.durationSeconds,
    distance_meters: edge.distanceMeters,
    verification_status: "UNKNOWN",
    stair_access_state: "UNKNOWN",
    accessibility_status: "UNKNOWN",
  }));
}

function reseal(report) {
  report.authoritySha256 = sha(canonicalJson(without(report, "authoritySha256")));
}

function without(value, key) {
  const { [key]: _ignored, ...rest } = value;
  return rest;
}

function sha(value) {
  return createHash("sha256").update(value).digest("hex");
}
