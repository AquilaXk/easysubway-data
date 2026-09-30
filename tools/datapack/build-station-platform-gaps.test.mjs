import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildStationPlatformGaps,
  loadStationPlatformGapInputs,
  parsePlatformPosition,
  parseIntegerMm,
} from "./build-station-platform-gaps.mjs";
import { GENERATED_ACCESSIBILITY_EVIDENCE_TABLE_DDL } from "./emit-artifact-components.mjs";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

const FIXTURE_MAPPINGS = [
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
];

test("(1) 정상 행 → 테이블 행(단위 변환 포함)", () => {
  const snapshot = {
    schemaVersion: 1,
    artifactKind: "seoul-platform-gap-snapshot",
    sourceId: "seoul-metro-platform-gap",
    snapshotId: "seoul-metro-platform-gap-fixture-01",
    capturedAt: "2026-09-30T05:00:00.000Z",
    rowCount: 3,
    rows: [
      {
        LINE: "4호선",
        SBWY_STNS_OTSD_CD: "425",
        SBWY_STNS_CD: "0425",
        SBWY_STNS_NM: "회현",
        UPLN_DNLN: "상선",
        PLF_PSTN: "3-2",
        TRN_PLF_INTVL: "12cm", // cm -> mm 단위 변환
        HGT_DIFF: "1.5cm",     // cm -> mm 단위 변환
        PLF_LNR: "곡선",
      },
      {
        LINE: "4호선",
        SBWY_STNS_OTSD_CD: "425",
        SBWY_STNS_CD: "0425",
        SBWY_STNS_NM: "회현",
        UPLN_DNLN: "하선",
        PLF_PSTN: "본선 오이도 방면 1-3",
        TRN_PLF_INTVL: "95mm", // mm 단위 보존
        HGT_DIFF: "10mm",
        PLF_LNR: "직선",
      },
      {
        LINE: "2호선",
        SBWY_STNS_OTSD_CD: "201",
        SBWY_STNS_CD: "0201",
        SBWY_STNS_NM: "시청",
        UPLN_DNLN: "상선",
        PLF_PSTN: "순환 5-1",
        TRN_PLF_INTVL: "80",   // 순수 숫자 (기본 mm)
        HGT_DIFF: "5",
        PLF_LNR: "직선",
      },
    ],
  };

  const { rows, exclusions } = buildStationPlatformGaps({
    snapshot,
    canonicalMappings: FIXTURE_MAPPINGS,
  });

  assert.equal(exclusions.length, 0);
  assert.equal(rows.length, 3);

  assert.deepEqual(rows[0], {
    id: "gap:station-ae0e5bd1256d:seoul-4:UP:3-2",
    station_id: "station-ae0e5bd1256d",
    line_id: "seoul-4",
    direction: "UP",
    platform_position: "3-2",
    car_number: 3,
    door_number: 2,
    gap_mm: 120,
    height_diff_mm: 15,
    source_snapshot_id: "seoul-metro-platform-gap-fixture-01",
  });

  assert.deepEqual(rows[1], {
    id: "gap:station-ae0e5bd1256d:seoul-4:DOWN:본선 오이도 방면 1-3",
    station_id: "station-ae0e5bd1256d",
    line_id: "seoul-4",
    direction: "DOWN",
    platform_position: "본선 오이도 방면 1-3",
    car_number: 1,
    door_number: 3,
    gap_mm: 95,
    height_diff_mm: 10,
    source_snapshot_id: "seoul-metro-platform-gap-fixture-01",
  });

  assert.deepEqual(rows[2], {
    id: "gap:station-a2d54a5d63d2:seoul-2:UP:순환 5-1",
    station_id: "station-a2d54a5d63d2",
    line_id: "seoul-2",
    direction: "UP",
    platform_position: "순환 5-1",
    car_number: 5,
    door_number: 1,
    gap_mm: 80,
    height_diff_mm: 5,
    source_snapshot_id: "seoul-metro-platform-gap-fixture-01",
  });
});

test("(2) 상하선 이외 값 제외", () => {
  const snapshot = {
    schemaVersion: 1,
    artifactKind: "seoul-platform-gap-snapshot",
    sourceId: "seoul-metro-platform-gap",
    snapshotId: "seoul-metro-platform-gap-fixture-02",
    capturedAt: "2026-09-30T05:00:00.000Z",
    rowCount: 2,
    rows: [
      {
        LINE: "4호선",
        SBWY_STNS_OTSD_CD: "425",
        SBWY_STNS_CD: "0425",
        SBWY_STNS_NM: "회현",
        UPLN_DNLN: "중선",
        PLF_PSTN: "1-1",
        TRN_PLF_INTVL: "100",
        HGT_DIFF: "10",
        PLF_LNR: "곡선",
      },
      {
        LINE: "4호선",
        SBWY_STNS_OTSD_CD: "425",
        SBWY_STNS_CD: "0425",
        SBWY_STNS_NM: "회현",
        UPLN_DNLN: "",
        PLF_PSTN: "1-2",
        TRN_PLF_INTVL: "100",
        HGT_DIFF: "10",
        PLF_LNR: "곡선",
      },
    ],
  };

  const { rows, exclusions } = buildStationPlatformGaps({
    snapshot,
    canonicalMappings: FIXTURE_MAPPINGS,
  });

  assert.equal(rows.length, 0);
  assert.equal(exclusions.length, 2);
  assert.equal(exclusions[0].reason, "INVALID_DIRECTION");
  assert.equal(exclusions[1].reason, "INVALID_DIRECTION");
});

test("(3) 역코드 매핑 실패 제외", () => {
  const snapshot = {
    schemaVersion: 1,
    artifactKind: "seoul-platform-gap-snapshot",
    sourceId: "seoul-metro-platform-gap",
    snapshotId: "seoul-metro-platform-gap-fixture-03",
    capturedAt: "2026-09-30T05:00:00.000Z",
    rowCount: 1,
    rows: [
      {
        LINE: "4호선",
        SBWY_STNS_OTSD_CD: "999",
        SBWY_STNS_CD: "9999",
        SBWY_STNS_NM: "미지의역",
        UPLN_DNLN: "상선",
        PLF_PSTN: "1-1",
        TRN_PLF_INTVL: "100",
        HGT_DIFF: "10",
        PLF_LNR: "직선",
      },
    ],
  };

  const { rows, exclusions } = buildStationPlatformGaps({
    snapshot,
    canonicalMappings: FIXTURE_MAPPINGS,
  });

  assert.equal(rows.length, 0);
  assert.equal(exclusions.length, 1);
  assert.equal(exclusions[0].reason, "MAPPING_NOT_FOUND");
});

test("비었거나 숫자가 아니면 제외 (원천 정성값 및 음수 제외)", () => {
  const snapshot = {
    schemaVersion: 1,
    artifactKind: "seoul-platform-gap-snapshot",
    sourceId: "seoul-metro-platform-gap",
    snapshotId: "seoul-metro-platform-gap-fixture-qualitative",
    capturedAt: "2026-09-30T05:00:00.000Z",
    rowCount: 4,
    rows: [
      {
        LINE: "4호선",
        SBWY_STNS_OTSD_CD: "425",
        SBWY_STNS_CD: "0425",
        SBWY_STNS_NM: "회현",
        UPLN_DNLN: "하선",
        PLF_PSTN: "본선 오이도 방면 1-3",
        TRN_PLF_INTVL: "넓음",
        HGT_DIFF: "낮음",
        PLF_LNR: "곡선",
      },
      {
        LINE: "4호선",
        SBWY_STNS_OTSD_CD: "425",
        SBWY_STNS_CD: "0425",
        SBWY_STNS_NM: "회현",
        UPLN_DNLN: "하선",
        PLF_PSTN: "본선 오이도 방면 1-4",
        TRN_PLF_INTVL: "",
        HGT_DIFF: "10",
        PLF_LNR: "곡선",
      },
      {
        LINE: "4호선",
        SBWY_STNS_OTSD_CD: "425",
        SBWY_STNS_CD: "0425",
        SBWY_STNS_NM: "회현",
        UPLN_DNLN: "하선",
        PLF_PSTN: "본선 오이도 방면 2-1",
        TRN_PLF_INTVL: "100",
        HGT_DIFF: "보통",
        PLF_LNR: "곡선",
      },
      {
        LINE: "4호선",
        SBWY_STNS_OTSD_CD: "425",
        SBWY_STNS_CD: "0425",
        SBWY_STNS_NM: "회현",
        UPLN_DNLN: "하선",
        PLF_PSTN: "본선 오이도 방면 2-2",
        TRN_PLF_INTVL: "-10",
        HGT_DIFF: "10",
        PLF_LNR: "곡선",
      },
    ],
  };

  const { rows, exclusions } = buildStationPlatformGaps({
    snapshot,
    canonicalMappings: FIXTURE_MAPPINGS,
  });

  assert.equal(rows.length, 0);
  assert.equal(exclusions.length, 4);
  assert.equal(exclusions[0].reason, "NON_NUMERIC_MEASUREMENT");
  assert.equal(exclusions[1].reason, "NON_NUMERIC_MEASUREMENT");
  assert.equal(exclusions[2].reason, "NON_NUMERIC_MEASUREMENT");
  assert.equal(exclusions[3].reason, "NON_NUMERIC_MEASUREMENT");
});

test("(4) 운영 빌드에서 테이블에 행이 들어감(빌드 테스트)", async () => {
  // 1. 실제 커밋된 저장소 원천에서 loadStationPlatformGapInputs 로더 검증
  const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
  const committedInputs = await loadStationPlatformGapInputs({ repositoryRoot });
  assert.equal(committedInputs.report.snapshotId, "seoul-metro-platform-gap-20260930T051459Z");
  assert.equal(committedInputs.report.totalRawRows, 19256);
  assert.equal(committedInputs.exclusions.length, 19256);

  // 2. 운영 DDL(GENERATED_ACCESSIBILITY_EVIDENCE_TABLE_DDL.station_platform_gaps)에 정규화 행 적재 검증
  const sampleSnapshot = {
    schemaVersion: 1,
    artifactKind: "seoul-platform-gap-snapshot",
    sourceId: "seoul-metro-platform-gap",
    snapshotId: "seoul-metro-platform-gap-fixture-build",
    capturedAt: "2026-09-30T05:00:00.000Z",
    rowCount: 1,
    rows: [
      {
        LINE: "4호선",
        SBWY_STNS_OTSD_CD: "425",
        SBWY_STNS_CD: "0425",
        SBWY_STNS_NM: "회현",
        UPLN_DNLN: "상선",
        PLF_PSTN: "3-2",
        TRN_PLF_INTVL: "120",
        HGT_DIFF: "15",
        PLF_LNR: "곡선",
      },
    ],
  };

  const { rows } = buildStationPlatformGaps({
    snapshot: sampleSnapshot,
    canonicalMappings: FIXTURE_MAPPINGS,
  });
  assert.equal(rows.length, 1);

  const db = new DatabaseSync(":memory:");
  db.exec(GENERATED_ACCESSIBILITY_EVIDENCE_TABLE_DDL.station_platform_gaps);

  const insert = db.prepare(`
    INSERT INTO station_platform_gaps (
      id, station_id, line_id, direction, platform_position,
      car_number, door_number, gap_mm, height_diff_mm, source_snapshot_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const r of rows) {
    insert.run(
      r.id, r.station_id, r.line_id, r.direction, r.platform_position,
      r.car_number, r.door_number, r.gap_mm, r.height_diff_mm, r.source_snapshot_id
    );
  }

  const dbRows = db.prepare("SELECT * FROM station_platform_gaps").all();
  assert.equal(dbRows.length, 1);
  assert.deepEqual({ ...dbRows[0] }, {
    id: "gap:station-ae0e5bd1256d:seoul-4:UP:3-2",
    station_id: "station-ae0e5bd1256d",
    line_id: "seoul-4",
    direction: "UP",
    platform_position: "3-2",
    car_number: 3,
    door_number: 2,
    gap_mm: 120,
    height_diff_mm: 15,
    source_snapshot_id: "seoul-metro-platform-gap-fixture-build",
  });

  // CHECK constraint (direction IN ('UP', 'DOWN')) 검증
  assert.throws(() => {
    insert.run(
      "gap:invalid", "s1", "l1", "MIDDLE", "1-1",
      1, 1, 100, 10, "snap"
    );
  }, /CHECK constraint failed/);
});

test("(5) 스냅샷 없음 및 무결성 실패 → 빌드 실패", async (t) => {
  const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
  const temp = await mkdtemp(path.join(os.tmpdir(), "platform-gap-inputs-test-"));
  t.after(() => rm(temp, { recursive: true, force: true }));

  const manifestPath = "tools/datapack/release/station-platform-gap-inputs.json";
  const manifest = JSON.parse(await readFile(path.join(repositoryRoot, manifestPath), "utf8"));

  const copyWorkspace = async (subDir) => {
    const root = path.join(temp, subDir);
    for (const relative of [
      manifestPath,
      "tools/datapack/source-candidates.json",
      manifest.platformGap.snapshotPath,
      manifest.platformGap.rawCollectionPath,
      manifest.canonicalMapping.snapshotPath,
    ]) {
      await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
      await cp(path.join(repositoryRoot, relative), path.join(root, relative));
    }
    return root;
  };

  // 1. 매니페스트 부재
  const missingManifest = await copyWorkspace("missing-manifest");
  await rm(path.join(missingManifest, manifestPath));
  await assert.rejects(
    loadStationPlatformGapInputs({ repositoryRoot: missingManifest }),
    /platform gap inputs is missing/
  );

  // 2. 스냅샷 부재
  const missingSnapshot = await copyWorkspace("missing-snapshot");
  await rm(path.join(missingSnapshot, manifest.platformGap.snapshotPath));
  await assert.rejects(
    loadStationPlatformGapInputs({ repositoryRoot: missingSnapshot }),
    /snapshot is missing/
  );

  // 3. raw 보관본 부재
  const missingRaw = await copyWorkspace("missing-raw");
  await rm(path.join(missingRaw, manifest.platformGap.rawCollectionPath));
  await assert.rejects(
    loadStationPlatformGapInputs({ repositoryRoot: missingRaw }),
    /raw collection is missing/
  );

  // 4. raw 보관본 변조 (sha256 불일치)
  const tamperedRaw = await copyWorkspace("tampered-raw");
  const rawFile = path.join(tamperedRaw, manifest.platformGap.rawCollectionPath);
  await writeFile(rawFile, `${await readFile(rawFile, "utf8")} `);
  await assert.rejects(
    loadStationPlatformGapInputs({ repositoryRoot: tamperedRaw }),
    /platform gap raw collection sha256 mismatch/
  );

  // 5. 스냅샷 변조 (sha256 불일치)
  const tamperedSnapshot = await copyWorkspace("tampered-snapshot");
  const snapFile = path.join(tamperedSnapshot, manifest.platformGap.snapshotPath);
  await writeFile(snapFile, `${await readFile(snapFile, "utf8")} `);
  await assert.rejects(
    loadStationPlatformGapInputs({ repositoryRoot: tamperedSnapshot }),
    /platform gap snapshot sha256 mismatch/
  );

  // 6. 운영 미승격 (productionUseAllowed = false)
  const notAdmitted = await copyWorkspace("not-admitted");
  const candidatesPath = path.join(notAdmitted, "tools/datapack/source-candidates.json");
  const candidates = JSON.parse(await readFile(candidatesPath, "utf8"));
  candidates.candidates.find(({ id }) => id === "seoul-metro-platform-gap").capabilities.facility.productionUseAllowed = false;
  await writeFile(candidatesPath, JSON.stringify(candidates, null, 2));
  await assert.rejects(
    loadStationPlatformGapInputs({ repositoryRoot: notAdmitted }),
    /source is not admitted for platform gaps: seoul-metro-platform-gap/
  );
});
