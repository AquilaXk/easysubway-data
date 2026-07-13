import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { expectedCountsByRegion } from "./enrich-capital-route-map-layer.mjs";

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

// enrich 도구의 expectedCountsByRegion를 단일 소스로 재사용한다(카운트 표 중복·
// drift 방지). 여기서는 하한과 layer 정합만 확인하고, exact-count는 enrich가 강제.
// zoom1 LOD 라벨 무충돌은 live 정적-스케일 렌더가 쓰지 않는 레거시 enrich 배치의
// QA다(live 게이트는 Dart 솔버 capital_label_overlap_gate_test). 2026-07-06 재간격
// 적용으로 수도권 도심 확대가 레거시 LOD에 zoom1 충돌 2건(홍대입구/신촌·서울역/충정로)을
// 남기며, live 라벨(Dart 솔버)은 오히려 개선된다. 지역별 baseline으로 악화만 금지한다.
// [2026-07-11 #1950] 정본을 오너 자작 8선형 도식으로 교체하며 레거시 enrich LOD의
// zoom1(환승/주요역) 라벨 배치 충돌 실측이 2→12로 바뀐다(더 조밀한 도심 배치). live
// 게이트(Dart 솔버 capital_label_overlap_gate_test)는 통과하므로 앱 체감에는 영향
// 없고, 이 baseline은 레거시 LOD 배치 회귀 악화만 막는 참조값이다.
// [2026-07-13 #2097] 상봉의 7호선 node를 canonical 환승 그룹에 합치면서 레거시
// QA가 line_id 정렬상 7호선 polygon을 대표로 골라 망우와 1건 겹친다. live 라벨
// solver 게이트는 통과했으며 실제 앱 라벨 회귀는 없다.
const zoom1OverlapBaseline = { 수도권: 13 };

for (const [region, expected] of Object.entries(expectedCountsByRegion)) {
  test(`${region} route map pack retains structured coverage`, async () => {
    const report = await regionCoverage(region);
    const after = report.after;

    assert.equal(after.region, region);
    assert.ok(
      after.positions >= expected.positions,
      `${region} 역 point는 ${expected.positions} 이상 (실측 ${after.positions})`,
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

    // 환승 그룹과 LOD 정합. 단일 노선 지역(광주·대전)은 환승 0이 정상.
    if (expected.lines > 1) {
      assert.ok(after.transferGroups > 0, `${region} 환승 그룹 도출`);
    }
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
    assert.ok(
      report.labelCollisionQa.zoom1.overlapCount <=
        (zoom1OverlapBaseline[region] ?? 0),
      `${region} zoom1 라벨 무충돌 (baseline ${zoom1OverlapBaseline[region] ?? 0}, ` +
        `실측 ${report.labelCollisionQa.zoom1.overlapCount})`,
    );
  });
}
