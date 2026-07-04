import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "../..");

// #1638 회귀 가드: 커밋된 수도권 오프라인 팩(capital.sqlite.gz)이 구조화 노선도
// 커버리지(노선 선 path·라벨 폴리곤·환승 그룹·LOD)를 유지하는지 검증한다.
// enrich 도구를 --check(읽기 전용)로 실행해 CI에도 배선한다. 누군가 enrich
// 단계 없이 build-datapack으로 팩을 재생성하면 up/down_path가 0으로 떨어지는데,
// 이 테스트가 그 회귀를 잡는다.
test("committed capital route map pack retains structured coverage (#1638 guard)", async () => {
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      "tools/route-map/enrich-capital-route-map-layer.mjs",
      "--pack",
      "apps/mobile/assets/datapacks/capital.sqlite.gz",
      "--index",
      "apps/mobile/assets/datapacks/index.json",
      "--check",
    ],
    { cwd: root, maxBuffer: 16 * 1024 * 1024 },
  );

  const report = JSON.parse(stdout);
  const after = report.after;

  assert.equal(after.region, "수도권");
  // 역 point 796 / 24개 노선 (#1638 실측 기준).
  assert.ok(
    after.positions >= 796,
    `capital 역 point는 796 이상이어야 함 (실측 ${after.positions})`,
  );
  assert.equal(after.lines, 24, "capital 노선 수는 24여야 함");

  // 이 이슈의 최대 갭이었던 노선 선 path가 채워져 있어야 한다(과거 0건).
  assert.ok(
    after.upPaths >= 700,
    `capital up_path 커버리지가 있어야 함 (실측 ${after.upPaths})`,
  );
  assert.ok(
    after.downPaths >= 700,
    `capital down_path 커버리지가 있어야 함 (실측 ${after.downPaths})`,
  );

  // 라벨 폴리곤이 전 역에 채워져 있어야 한다(과거 1건).
  assert.equal(
    after.labelPolygons,
    after.positions,
    "모든 capital 역에 label_polygon이 있어야 함",
  );

  // 환승 그룹과 LOD가 구조화되어 있고 서로 정합한다.
  assert.ok(after.transferGroups > 0, "환승 그룹이 도출되어야 함");
  assert.equal(after.lod.zoom0, "lines_only");
  assert.equal(
    after.lod.zoom1MajorLabels,
    after.transferGroups,
    "zoom1 major 라벨 수는 환승 그룹 수와 일치해야 함",
  );
  assert.equal(
    after.lod.zoom2StationLabels,
    after.positions,
    "zoom2 라벨 수는 전체 역 수와 일치해야 함",
  );

  // zoom-out(환승·주요역) 라벨은 서로 겹치지 않아야 한다.
  assert.equal(
    report.labelCollisionQa.zoom1.overlapCount,
    0,
    "zoom1 환승/주요역 라벨은 겹치면 안 됨",
  );
});
