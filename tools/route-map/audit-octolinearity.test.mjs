import assert from "node:assert/strict";
import test from "node:test";

import {
  isOctolinearAngle,
  parsePathVertices,
  pointToPolylinesDistance,
  pointToSegmentDistance,
  segmentAngleDeg,
} from "./audit-octolinearity.mjs";

// #1789 Stage 0: octolinearity·노드정합 판정 로직 단위 테스트. Stage 3 CI가
// 이 순수 함수들을 5지역 팩 강제 판정에 재사용하므로 계약으로 고정한다.

test("segmentAngleDeg는 [0,180)로 정규화한다", () => {
  assert.equal(segmentAngleDeg({ x: 0, y: 0 }, { x: 10, y: 0 }), 0);
  assert.equal(segmentAngleDeg({ x: 0, y: 0 }, { x: 10, y: 10 }), 45);
  assert.equal(segmentAngleDeg({ x: 0, y: 0 }, { x: 0, y: 10 }), 90);
  assert.equal(segmentAngleDeg({ x: 0, y: 0 }, { x: -10, y: 10 }), 135);
  // 반대 방향은 같은 선(180 mod).
  assert.equal(segmentAngleDeg({ x: 0, y: 0 }, { x: -10, y: 0 }), 0);
  assert.equal(segmentAngleDeg({ x: 5, y: 5 }, { x: 5, y: 5 }), null);
});

test("isOctolinearAngle은 8방향 ±허용오차만 통과", () => {
  assert.equal(isOctolinearAngle(0), true);
  assert.equal(isOctolinearAngle(45), true);
  assert.equal(isOctolinearAngle(90), true);
  assert.equal(isOctolinearAngle(135), true);
  assert.equal(isOctolinearAngle(44.6, 0.5), true); // 오차 내
  assert.equal(isOctolinearAngle(30), false);
  assert.equal(isOctolinearAngle(44, 0.5), false); // 오차 밖
  assert.equal(isOctolinearAngle(null), true); // 길이 0은 제외
});

test("pointToSegmentDistance는 선분 위/끝점 clamp", () => {
  // 선분 (0,0)-(10,0). 점 (5,3) → 수직거리 3.
  assert.equal(pointToSegmentDistance({ x: 5, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 }), 3);
  // 점이 선분 밖(왼쪽) → 끝점 (0,0)까지 거리.
  assert.equal(pointToSegmentDistance({ x: -3, y: 4 }, { x: 0, y: 0 }, { x: 10, y: 0 }), 5);
  // 점이 선분 위 → 0.
  assert.equal(pointToSegmentDistance({ x: 4, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 0 }), 0);
});

test("pointToPolylinesDistance는 여러 조각 중 최소", () => {
  const polylines = [
    [{ x: 0, y: 0 }, { x: 10, y: 0 }],
    [{ x: 0, y: 100 }, { x: 10, y: 100 }],
  ];
  assert.equal(pointToPolylinesDistance({ x: 5, y: 2 }, polylines), 2);
  assert.equal(pointToPolylinesDistance({ x: 5, y: 98 }, polylines), 2);
  assert.equal(pointToPolylinesDistance({ x: 5, y: 2 }, []), Infinity);
});

test("parsePathVertices는 M/L 절대 경로에서 정점쌍만 추출", () => {
  assert.deepEqual(parsePathVertices("M 1656 5004 L 1836 4824"), [
    { x: 1656, y: 5004 },
    { x: 1836, y: 4824 },
  ]);
  assert.deepEqual(parsePathVertices(""), []);
  // 짝 안 맞는 마지막 숫자는 버린다.
  assert.deepEqual(parsePathVertices("M 1 2 L 3"), [{ x: 1, y: 2 }]);
});
