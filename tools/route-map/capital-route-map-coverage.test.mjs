import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "../..");

// #1638/#1639 회귀 가드: 커밋된 오프라인 팩(capital.sqlite.gz) 안의 각 지역이
// 구조화 노선도 커버리지(노선 선 path·라벨 폴리곤·환승 그룹·LOD)를 유지하는지
// 검증한다. enrich 도구를 --check(읽기 전용)로 실행해 CI에도 배선한다. 누군가
// enrich 단계 없이 build-datapack으로 팩을 재생성하면 up/down_path·label_polygon
// 이 0으로 떨어지는데, 이 테스트가 그 회귀를 잡는다.
async function regionCoverage(region) {
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      "tools/route-map/enrich-capital-route-map-layer.mjs",
      "--pack",
      "apps/mobile/assets/datapacks/capital.sqlite.gz",
      "--index",
      "apps/mobile/assets/datapacks/index.json",
      "--region",
      region,
      "--check",
    ],
    { cwd: root, maxBuffer: 16 * 1024 * 1024 },
  );
  return JSON.parse(stdout);
}

// region → 최소 기대치(실측 기준). enrich 도구의 expectedCountsByRegion가 정확한
// exact-count를 이미 강제하므로 여기서는 하한과 layer 정합만 확인한다.
const regionExpectations = {
  "수도권": { minPositions: 796, lines: 24 },
  "부산권": { minPositions: 158, lines: 6 },
};

for (const [region, expected] of Object.entries(regionExpectations)) {
  test(`${region} route map pack retains structured coverage`, async () => {
    const report = await regionCoverage(region);
    const after = report.after;

    assert.equal(after.region, region);
    assert.ok(
      after.positions >= expected.minPositions,
      `${region} 역 point는 ${expected.minPositions} 이상 (실측 ${after.positions})`,
    );
    assert.equal(after.lines, expected.lines, `${region} 노선 수`);

    // 노선 선 path와 라벨 폴리곤이 채워져 있어야 한다(enrich 전 갭 회귀 방지).
    const expectedSegments = after.positions - after.lines;
    assert.equal(after.upPaths, expectedSegments, `${region} up_path 커버리지`);
    assert.equal(
      after.downPaths,
      expectedSegments,
      `${region} down_path 커버리지`,
    );
    assert.equal(
      after.labelPolygons,
      after.positions,
      `${region} 모든 역에 label_polygon`,
    );

    // 환승 그룹과 LOD 정합.
    assert.ok(after.transferGroups > 0, `${region} 환승 그룹 도출`);
    assert.equal(after.lod.zoom0, "lines_only");
    assert.equal(
      after.lod.zoom1MajorLabels,
      after.transferGroups,
      `${region} zoom1 major 라벨 = 환승 그룹 수`,
    );
    assert.equal(
      after.lod.zoom2StationLabels,
      after.positions,
      `${region} zoom2 라벨 = 전체 역 수`,
    );

    // zoom-out(환승·주요역) 라벨은 서로 겹치지 않아야 한다.
    assert.equal(
      report.labelCollisionQa.zoom1.overlapCount,
      0,
      `${region} zoom1 라벨 무충돌`,
    );
  });
}
