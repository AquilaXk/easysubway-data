import assert from "node:assert/strict";
import test from "node:test";
import { canonicalStationName } from "./apply-sma-svg-positions.mjs";
import { octolinearizeChain, stitchToPaths, SVG_COLOR_TO_SLUG } from "./build-sma-tracks.mjs";
import { diffExtractions } from "./diff-sma-versions.mjs";

test("canonicalStationName: 콜론 동명이역·역 접미·이수 별칭 규칙", () => {
  // 콜론 동명이역은 이름만 취하고 노선 disambiguate 플래그를 세운다.
  assert.deepEqual(canonicalStationName("신촌:2호선"), {
    name: "신촌",
    disambiguateByLine: true,
  });
  assert.deepEqual(canonicalStationName("양평:경의중앙선"), {
    name: "양평",
    disambiguateByLine: true,
  });
  // 하남검단산 → 역 접미.
  assert.deepEqual(canonicalStationName("하남검단산"), { name: "하남검단산역" });
  // 이수 → 총신대입구 별칭.
  assert.deepEqual(canonicalStationName("이수"), { name: "총신대입구" });
  // 일반 역은 그대로.
  assert.deepEqual(canonicalStationName("용인중앙시장"), { name: "용인중앙시장" });
});

test("SVG_COLOR_TO_SLUG: 24 노선색이 슬러그와 1:1", () => {
  const slugs = new Set(Object.values(SVG_COLOR_TO_SLUG));
  assert.equal(Object.keys(SVG_COLOR_TO_SLUG).length, 24);
  assert.equal(slugs.size, 24);
  assert.equal(SVG_COLOR_TO_SLUG["#a49d87"], "9"); // 저채도 9호선 gold
  assert.equal(SVG_COLOR_TO_SLUG["#5eac41"], "seohae");
});

test("octolinearizeChain: 비축 세그먼트를 최근접 8방향으로 스냅", () => {
  // 수평 후 약간 어긋난 대각 → 순수 8방향(수평·45°)으로 정렬.
  const snapped = octolinearizeChain([
    { x: 0, y: 0 },
    { x: 100, y: 2 }, // ≈수평
    { x: 150, y: 53 }, // ≈45°
  ]);
  // 각 세그먼트가 0/45/90/135°인지 확인.
  for (let i = 1; i < snapped.length; i += 1) {
    const dx = snapped[i].x - snapped[i - 1].x;
    const dy = snapped[i].y - snapped[i - 1].y;
    const angle = ((Math.atan2(dy, dx) * 180) / Math.PI) % 45;
    assert.ok(Math.min(Math.abs(angle), 45 - Math.abs(angle)) < 1e-6, `세그먼트 ${i} 비축`);
  }
});

test("stitchToPaths: 끝점 근접 조각을 하나의 chain으로 잇는다", () => {
  const paths = stitchToPaths(
    [
      [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
      ],
      [
        { x: 100, y: 0 },
        { x: 100, y: 100 },
      ],
    ],
    6,
  );
  assert.equal(paths.length, 1); // 한 chain으로 이어짐
  assert.match(paths[0], /^M /);
});

test("diffExtractions: 역 추가/삭제/이동/노선 변화 요약", () => {
  const old = {
    sourceSvgSha256: "a",
    stationNodes: [
      { dataStation: "가", dataLine: "1", x: 0, y: 0 },
      { dataStation: "나", dataLine: "1", x: 10, y: 0 },
    ],
  };
  const next = {
    sourceSvgSha256: "b",
    stationNodes: [
      { dataStation: "가", dataLine: "1", x: 0, y: 0 }, // 동일
      { dataStation: "다", dataLine: "2", x: 20, y: 0 }, // 추가
    ],
  };
  const report = diffExtractions(old, next, { moveThreshold: 4 });
  assert.equal(report.addedCount, 1);
  assert.equal(report.added[0].station, "다");
  assert.equal(report.removedCount, 1);
  assert.equal(report.removed[0].station, "나");
  assert.equal(report.movedCount, 0);
  // 노선 노드 수 변화: 1호선 2→1, 2호선 0→1.
  assert.ok(report.lineNodeCountChanges.some((c) => c.line === "1" && c.before === 2 && c.after === 1));
});

test("diffExtractions: moveThreshold 초과 이동을 moved로 감지", () => {
  const old = {
    sourceSvgSha256: "a",
    stationNodes: [
      { dataStation: "가", dataLine: "1", x: 0, y: 0 }, // 이동 없음
      { dataStation: "나", dataLine: "1", x: 10, y: 0 }, // 임계 초과 이동
    ],
  };
  const next = {
    sourceSvgSha256: "b",
    stationNodes: [
      { dataStation: "가", dataLine: "1", x: 0, y: 0 }, // 동일
      { dataStation: "나", dataLine: "1", x: 20, y: 0 }, // dist 10 > threshold 4
    ],
  };
  const report = diffExtractions(old, next, { moveThreshold: 4 });
  assert.equal(report.addedCount, 0);
  assert.equal(report.removedCount, 0);
  assert.equal(report.movedCount, 1);
  assert.equal(report.moved[0].station, "나");
  assert.equal(report.moved[0].distance, 10);
  assert.deepEqual(report.moved[0].from, { x: 10, y: 0 });
  assert.deepEqual(report.moved[0].to, { x: 20, y: 0 });
  // 임계 이하 이동(가: dist 0)은 moved에 포함되지 않는다.
  assert.ok(!report.moved.some((m) => m.station === "가"));
});
