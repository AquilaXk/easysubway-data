import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  bindStationPlatformGaps,
  buildStationPlatformGaps,
  loadStationPlatformGapInputs,
  parsePlatformPosition,
} from "./build-station-platform-gaps.mjs";
import { GENERATED_ACCESSIBILITY_EVIDENCE_TABLE_DDL } from "./emit-artifact-components.mjs";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const MANIFEST_PATH = "tools/datapack/release/station-platform-gap-inputs.json";

// 손으로 만든 역 결속: "<호선 번호>:<역코드 숫자>" → 팩 station/line id
const BINDINGS = new Map([
  ["4:425", { stationId: "station-hoehyeon", lineId: "seoul-4" }],
  ["2:201", { stationId: "station-sicheong", lineId: "seoul-2" }],
]);

function row(overrides = {}) {
  return {
    LINE: "4호선",
    SBWY_STNS_OTSD_CD: "425",
    SBWY_STNS_CD: "0425",
    SBWY_STNS_NM: "회현",
    UPLN_DNLN: "상선",
    PLF_PSTN: "본선 오이도 방면 1-3",
    TRN_PLF_INTVL: "좁음",
    HGT_DIFF: "낮음",
    PLF_LNR: "직선",
    ...overrides,
  };
}

function snapshotOf(rows, snapshotId = "seoul-metro-platform-gap-fixture") {
  return {
    schemaVersion: 1,
    artifactKind: "seoul-platform-gap-snapshot",
    sourceId: "seoul-metro-platform-gap",
    snapshotId,
    capturedAt: "2026-09-30T05:00:00.000Z",
    rowCount: rows.length,
    rows,
  };
}

test("연단 간격·높이차 등급은 공식 등급 그대로 영문 코드로 옮긴다", () => {
  const pairs = [
    ["좁음", "낮음", "NARROW", "LOW", "1-1"],
    ["보통", "보통", "NORMAL", "NORMAL", "1-2"],
    ["넓음", "높음", "WIDE", "HIGH", "1-3"],
  ];
  const { rows, exclusions } = buildStationPlatformGaps({
    snapshot: snapshotOf(pairs.map(([gap, height, , , position]) => row({ TRN_PLF_INTVL: gap, HGT_DIFF: height, PLF_PSTN: `본선 ${position}` }))),
    stationBindings: BINDINGS,
  });
  assert.deepEqual(exclusions, []);
  assert.deepEqual(rows.map((r) => [r.gap_grade, r.height_diff_grade]), pairs.map(([, , g, h]) => [g, h]));
  assert.deepEqual(rows[2], {
    id: "gap:station-hoehyeon:seoul-4:UP:본선 1-3",
    station_id: "station-hoehyeon",
    line_id: "seoul-4",
    direction: "UP",
    platform_position: "본선 1-3",
    car_number: 1,
    door_number: 3,
    gap_grade: "WIDE",
    height_diff_grade: "HIGH",
    curved: 0,
    source_snapshot_id: "seoul-metro-platform-gap-fixture",
  });
  assert.equal("gap_mm" in rows[0], false);
  assert.equal("height_diff_mm" in rows[0], false);
});

test("알 수 없는 등급 값은 제외하고 사유별 개수를 센다", () => {
  const { rows, exclusions, report } = buildStationPlatformGaps({
    snapshot: snapshotOf([
      row({ TRN_PLF_INTVL: "매우넓음", PLF_PSTN: "본선 1-1" }),
      row({ TRN_PLF_INTVL: "", PLF_PSTN: "본선 1-2" }),
      row({ HGT_DIFF: "12", PLF_PSTN: "본선 1-3" }),
      row({ HGT_DIFF: undefined, PLF_PSTN: "본선 1-4" }),
      row({ PLF_PSTN: "본선 1-5" }),
    ]),
    stationBindings: BINDINGS,
  });
  assert.equal(rows.length, 1);
  assert.deepEqual(exclusions.map((e) => e.reason), [
    "UNKNOWN_GAP_GRADE", "UNKNOWN_GAP_GRADE", "UNKNOWN_HEIGHT_DIFF_GRADE", "UNKNOWN_HEIGHT_DIFF_GRADE",
  ]);
  assert.deepEqual(report.exclusionsByReason, { UNKNOWN_GAP_GRADE: 2, UNKNOWN_HEIGHT_DIFF_GRADE: 2 });
  assert.equal(report.validRowsLoaded, 1);
  assert.equal(report.excludedRowsTotal, 4);
});

test("곡선 승강장 여부: 곡선=1, 직선=0, 그 밖은 제외", () => {
  const { rows, exclusions } = buildStationPlatformGaps({
    snapshot: snapshotOf([
      row({ PLF_LNR: "곡선", PLF_PSTN: "본선 1-1" }),
      row({ PLF_LNR: "직선", PLF_PSTN: "본선 1-2" }),
      row({ PLF_LNR: "완만", PLF_PSTN: "본선 1-3" }),
      row({ PLF_LNR: "", PLF_PSTN: "본선 1-4" }),
    ]),
    stationBindings: BINDINGS,
  });
  assert.deepEqual(rows.map((r) => [r.platform_position, r.curved]), [["본선 1-1", 1], ["본선 1-2", 0]]);
  assert.deepEqual(exclusions.map((e) => e.reason), ["UNKNOWN_PLATFORM_LINEARITY", "UNKNOWN_PLATFORM_LINEARITY"]);
});

test("승강장 위치는 원문을 보존하고 끝의 N-M이 정확할 때만 칸·문을 채운다", () => {
  assert.deepEqual(parsePlatformPosition("본선 오이도 방면 1-3"), { position: "본선 오이도 방면 1-3", carNumber: 1, doorNumber: 3 });
  assert.deepEqual(parsePlatformPosition("3-2"), { position: "3-2", carNumber: 3, doorNumber: 2 });
  assert.deepEqual(parsePlatformPosition("순환 10-4"), { position: "순환 10-4", carNumber: 10, doorNumber: 4 });
  assert.deepEqual(parsePlatformPosition("본선 1-3 앞"), { position: "본선 1-3 앞", carNumber: null, doorNumber: null });
  assert.deepEqual(parsePlatformPosition("본선 1-3-2"), { position: "본선 1-3-2", carNumber: null, doorNumber: null });
  assert.deepEqual(parsePlatformPosition("본선"), { position: "본선", carNumber: null, doorNumber: null });
  // 원문 보존: 공백 정규화 없이 원문 그대로
  assert.equal(parsePlatformPosition("본선  오이도 방면 1-3").position, "본선  오이도 방면 1-3");
  const { rows } = buildStationPlatformGaps({
    snapshot: snapshotOf([row({ PLF_PSTN: "본선 오이도 방면 1-3" }), row({ PLF_PSTN: "승강장 중앙" })]),
    stationBindings: BINDINGS,
  });
  assert.deepEqual(rows.map((r) => [r.platform_position, r.car_number, r.door_number]), [
    ["본선 오이도 방면 1-3", 1, 3],
    ["승강장 중앙", null, null],
  ]);
});

test("상하선 방향 매핑: 상선=UP, 하선=DOWN, 그 밖은 제외", () => {
  const { rows, exclusions, report } = buildStationPlatformGaps({
    snapshot: snapshotOf([
      row({ UPLN_DNLN: "상선", PLF_PSTN: "본선 1-1" }),
      row({ UPLN_DNLN: "하선", PLF_PSTN: "본선 1-1" }),
      row({ UPLN_DNLN: "내선", PLF_PSTN: "본선 1-1" }),
      row({ UPLN_DNLN: "", PLF_PSTN: "본선 1-1" }),
    ]),
    stationBindings: BINDINGS,
  });
  assert.deepEqual(rows.map((r) => r.direction), ["UP", "DOWN"]);
  assert.deepEqual(exclusions.map((e) => e.reason), ["UNKNOWN_DIRECTION", "UNKNOWN_DIRECTION"]);
  assert.equal(report.exclusionsByReason.UNKNOWN_DIRECTION, 2);
});

test("역코드 결속 실패 행은 이름 조인 없이 제외하고 역별 개수를 보고한다", () => {
  const { rows, exclusions, report } = buildStationPlatformGaps({
    snapshot: snapshotOf([
      row({ PLF_PSTN: "본선 1-1" }),
      // 이름은 같지만 역코드가 결속 대상이 아님 → 이름으로 붙이지 않는다
      row({ SBWY_STNS_CD: "9999", SBWY_STNS_OTSD_CD: "999", PLF_PSTN: "본선 1-1" }),
      row({ SBWY_STNS_CD: "9999", SBWY_STNS_OTSD_CD: "999", PLF_PSTN: "본선 1-2" }),
      // 같은 역코드라도 호선이 다르면 결속되지 않는다
      row({ LINE: "5호선", PLF_PSTN: "본선 1-1" }),
    ]),
    stationBindings: BINDINGS,
  });
  assert.equal(rows.length, 1);
  assert.deepEqual(exclusions.map((e) => e.reason), ["UNMAPPED_STATION", "UNMAPPED_STATION", "UNMAPPED_STATION"]);
  assert.deepEqual(report.unmappedStations, [
    { line: "4", stationCode: "9999", stationName: "회현", rowCount: 2 },
    { line: "5", stationCode: "0425", stationName: "회현", rowCount: 1 },
  ]);
  assert.equal(report.exclusionsByReason.UNMAPPED_STATION, 3);
});

test("커버리지 리포트는 등급·곡선 분포와 역·노선 수를 센다", () => {
  const { report } = buildStationPlatformGaps({
    snapshot: snapshotOf([
      row({ PLF_PSTN: "본선 1-1", TRN_PLF_INTVL: "넓음", HGT_DIFF: "높음", PLF_LNR: "곡선" }),
      row({ PLF_PSTN: "본선 1-2", TRN_PLF_INTVL: "넓음", HGT_DIFF: "낮음" }),
      row({ LINE: "2호선", SBWY_STNS_CD: "0201", SBWY_STNS_NM: "시청", PLF_PSTN: "순환 1-1", TRN_PLF_INTVL: "보통", HGT_DIFF: "보통" }),
    ]),
    stationBindings: BINDINGS,
  });
  assert.equal(report.totalRawRows, 3);
  assert.equal(report.validRowsLoaded, 3);
  assert.deepEqual(report.gapGradeCounts, { NARROW: 0, NORMAL: 1, WIDE: 2 });
  assert.deepEqual(report.heightDiffGradeCounts, { LOW: 1, NORMAL: 1, HIGH: 1 });
  assert.deepEqual(report.curvedCounts, { 0: 2, 1: 1 });
  assert.equal(report.stationLineCount, 2);
  assert.deepEqual(report.rowsByLine, { "seoul-2": 1, "seoul-4": 2 });
});

test("같은 승강장 위치가 서로 다른 값으로 중복되면 임의로 고르지 않고 실패한다", () => {
  assert.throws(() => buildStationPlatformGaps({
    snapshot: snapshotOf([row({ TRN_PLF_INTVL: "좁음" }), row({ TRN_PLF_INTVL: "넓음" })]),
    stationBindings: BINDINGS,
  }), /duplicate platform gap key with conflicting values/);
});

test("station_platform_gaps DDL은 등급·곡선·방향 CHECK를 강제하고 mm 열이 없다", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(GENERATED_ACCESSIBILITY_EVIDENCE_TABLE_DDL.station_platform_gaps);
  assert.deepEqual(db.prepare("PRAGMA table_info(station_platform_gaps)").all().map(({ name, type, notnull, pk }) => [name, type, notnull, pk]), [
    ["id", "TEXT", 0, 1],
    ["station_id", "TEXT", 1, 0],
    ["line_id", "TEXT", 1, 0],
    ["direction", "TEXT", 0, 0],
    ["platform_position", "TEXT", 1, 0],
    ["car_number", "INTEGER", 0, 0],
    ["door_number", "INTEGER", 0, 0],
    ["gap_grade", "TEXT", 1, 0],
    ["height_diff_grade", "TEXT", 1, 0],
    ["curved", "INTEGER", 1, 0],
    ["source_snapshot_id", "TEXT", 1, 0],
  ]);
  const insert = db.prepare("INSERT INTO station_platform_gaps VALUES(?,?,?,?,?,?,?,?,?,?,?)");
  insert.run("ok", "s", "l", "UP", "1-1", 1, 1, "WIDE", "HIGH", 1, "snap");
  for (const [label, values] of [
    ["direction", ["d1", "s", "l", "MIDDLE", "1-1", null, null, "WIDE", "HIGH", 1, "snap"]],
    ["gap_grade", ["d2", "s", "l", "UP", "1-1", null, null, "넓음", "HIGH", 1, "snap"]],
    ["height_diff_grade", ["d3", "s", "l", "UP", "1-1", null, null, "WIDE", "MEDIUM", 1, "snap"]],
    ["curved", ["d4", "s", "l", "UP", "1-1", null, null, "WIDE", "HIGH", 2, "snap"]],
  ]) {
    assert.throws(() => insert.run(...values), /CHECK constraint failed/, label);
  }
});

test("운영 입력은 커밋된 스냅샷·역코드 membership에서 실제 행을 만든다", async () => {
  const inputs = await loadStationPlatformGapInputs({ repositoryRoot: REPOSITORY_ROOT });
  assert.equal(inputs.snapshot.snapshotId, "seoul-metro-platform-gap-20260930T051459Z");
  assert.equal(inputs.snapshot.rows.length, 19256);
  assert.equal(inputs.membership.artifactKind, "seoul-station-code-membership-binding");
  // 운영 팩과 같은 형태의 station/line 목록으로 결속하면 행이 실제로 생긴다
  const pack = {
    stations: [{ id: "station-hoehyeon", nameKo: "회현", nameSub: "남대문시장" }],
    stationLines: [{ stationId: "station-hoehyeon", lineId: "seoul-4" }],
  };
  const { rows, report } = bindStationPlatformGaps({ ...inputs, pack });
  assert.ok(rows.length > 0);
  assert.ok(rows.every((r) => r.station_id === "station-hoehyeon" && r.line_id === "seoul-4"));
  assert.equal(report.totalRawRows, 19256);
  assert.equal(report.validRowsLoaded + report.excludedRowsTotal, 19256);
});

test("운영 정본 팩에 결속하면 커밋된 원천 19,256행이 모두 적재되고 원천 등급 분포와 일치한다", async () => {
  const inputs = await loadStationPlatformGapInputs({ repositoryRoot: REPOSITORY_ROOT });
  const pack = JSON.parse(await readFile(path.join(REPOSITORY_ROOT, "tools/datapack/release/nationwide-production-canonical-pack.json"), "utf8"))
    .packs.find(({ id }) => id === "nationwide");
  const { rows, exclusions, report } = bindStationPlatformGaps({ ...inputs, pack });
  assert.equal(rows.length, 19256);
  assert.deepEqual(exclusions, []);
  // 원천 값 분포(스냅샷 행을 직접 센 값)와 같아야 한다.
  assert.deepEqual(report.gapGradeCounts, { NARROW: 14589, NORMAL: 4109, WIDE: 558 });
  assert.deepEqual(report.heightDiffGradeCounts, { LOW: 8165, NORMAL: 10579, HIGH: 512 });
  assert.deepEqual(report.curvedCounts, { 0: 10200, 1: 9056 });
  assert.equal(report.stationLineCount, 275);
  assert.equal(new Set(rows.map((r) => r.id)).size, rows.length);
});

test("스냅샷·매니페스트가 없거나 변조되거나 운영 승격 근거가 없으면 빌드 실패", async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "platform-gap-inputs-test-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const manifest = JSON.parse(await readFile(path.join(REPOSITORY_ROOT, MANIFEST_PATH), "utf8"));
  const copyWorkspace = async (name) => {
    const root = path.join(temp, name);
    for (const relative of [
      MANIFEST_PATH,
      "tools/datapack/source-candidates.json",
      manifest.platformGap.snapshotPath,
      manifest.platformGap.rawCollectionPath,
      manifest.stationCodeMembership.snapshotPath,
    ]) {
      await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
      await cp(path.join(REPOSITORY_ROOT, relative), path.join(root, relative));
    }
    return root;
  };
  const editCandidate = async (root, edit) => {
    const file = path.join(root, "tools/datapack/source-candidates.json");
    const candidates = JSON.parse(await readFile(file, "utf8"));
    edit(candidates.candidates.find(({ id }) => id === "seoul-metro-platform-gap"));
    await writeFile(file, JSON.stringify(candidates, null, 2));
  };

  const missingManifest = await copyWorkspace("missing-manifest");
  await rm(path.join(missingManifest, MANIFEST_PATH));
  await assert.rejects(loadStationPlatformGapInputs({ repositoryRoot: missingManifest }), /platform gap inputs is missing/);

  const missingSnapshot = await copyWorkspace("missing-snapshot");
  await rm(path.join(missingSnapshot, manifest.platformGap.snapshotPath));
  await assert.rejects(loadStationPlatformGapInputs({ repositoryRoot: missingSnapshot }), /snapshot is missing/);

  const missingRaw = await copyWorkspace("missing-raw");
  await rm(path.join(missingRaw, manifest.platformGap.rawCollectionPath));
  await assert.rejects(loadStationPlatformGapInputs({ repositoryRoot: missingRaw }), /raw collection is missing/);

  const missingMembership = await copyWorkspace("missing-membership");
  await rm(path.join(missingMembership, manifest.stationCodeMembership.snapshotPath));
  await assert.rejects(loadStationPlatformGapInputs({ repositoryRoot: missingMembership }), /station code membership is missing/);

  const tamperedRaw = await copyWorkspace("tampered-raw");
  const rawFile = path.join(tamperedRaw, manifest.platformGap.rawCollectionPath);
  await writeFile(rawFile, `${await readFile(rawFile, "utf8")} `);
  await assert.rejects(loadStationPlatformGapInputs({ repositoryRoot: tamperedRaw }), /platform gap raw collection sha256 mismatch/);

  const tamperedSnapshot = await copyWorkspace("tampered-snapshot");
  const snapFile = path.join(tamperedSnapshot, manifest.platformGap.snapshotPath);
  await writeFile(snapFile, `${await readFile(snapFile, "utf8")} `);
  await assert.rejects(loadStationPlatformGapInputs({ repositoryRoot: tamperedSnapshot }), /platform gap snapshot sha256 mismatch/);

  const tamperedMembership = await copyWorkspace("tampered-membership");
  const membershipFile = path.join(tamperedMembership, manifest.stationCodeMembership.snapshotPath);
  await writeFile(membershipFile, `${await readFile(membershipFile, "utf8")} `);
  await assert.rejects(loadStationPlatformGapInputs({ repositoryRoot: tamperedMembership }), /station code membership sha256 mismatch/);

  // 운영 승격 게이트: 승인 기록이 없거나·거부이거나·범위가 다르거나·스냅샷을 덮지 않으면 실패
  const notAdmitted = await copyWorkspace("not-admitted");
  await editCandidate(notAdmitted, (candidate) => { candidate.capabilities.facility.productionUseAllowed = false; });
  await assert.rejects(loadStationPlatformGapInputs({ repositoryRoot: notAdmitted }), /source is not admitted for platform gaps: seoul-metro-platform-gap/);

  const noAdmissionRecord = await copyWorkspace("no-admission-record");
  await editCandidate(noAdmissionRecord, (candidate) => { delete candidate.evidence.productionUseAdmission; });
  await assert.rejects(loadStationPlatformGapInputs({ repositoryRoot: noAdmissionRecord }), /source is not admitted for platform gaps: seoul-metro-platform-gap/);

  const rejected = await copyWorkspace("rejected");
  await editCandidate(rejected, (candidate) => { candidate.evidence.productionUseAdmission.decision = "REJECTED"; });
  await assert.rejects(loadStationPlatformGapInputs({ repositoryRoot: rejected }), /source is not admitted for platform gaps: seoul-metro-platform-gap/);

  const wrongScope = await copyWorkspace("wrong-scope");
  await editCandidate(wrongScope, (candidate) => { candidate.evidence.productionUseAdmission.scope = "OTHER"; });
  await assert.rejects(loadStationPlatformGapInputs({ repositoryRoot: wrongScope }), /source is not admitted for platform gaps: seoul-metro-platform-gap/);

  const staleApproval = await copyWorkspace("stale-approval");
  await editCandidate(staleApproval, (candidate) => { candidate.evidence.productionUseAdmission.contentSha256 = "0".repeat(64); });
  await assert.rejects(loadStationPlatformGapInputs({ repositoryRoot: staleApproval }), /approval does not cover snapshot/);
});
