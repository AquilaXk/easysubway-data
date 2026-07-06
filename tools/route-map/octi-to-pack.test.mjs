import assert from "node:assert/strict";
import test from "node:test";
import {
  snapUnit8,
  rdpSimplify,
  rectifyPolyline,
  offsetPolyline,
  chainEdgesForLine,
  segmentAngleDeg8Dev,
} from "./octi-to-pack.mjs";

test("snapUnit8은 근사 방향을 가장 가까운 8방향 단위벡터로 스냅한다", () => {
  // 44° → 45° 대각
  const d = snapUnit8(Math.cos((44 * Math.PI) / 180), Math.sin((44 * Math.PI) / 180));
  assert.ok(Math.abs(d.ux - Math.SQRT1_2) < 1e-9, `ux=${d.ux}`);
  assert.ok(Math.abs(d.uy - Math.SQRT1_2) < 1e-9, `uy=${d.uy}`);
  // 2° → 수평
  const h = snapUnit8(Math.cos((2 * Math.PI) / 180), Math.sin((2 * Math.PI) / 180));
  assert.deepEqual({ ux: Math.round(h.ux), uy: Math.round(h.uy) }, { ux: 1, uy: 0 });
  // -88° → 수직(아래)
  const v = snapUnit8(Math.cos((-88 * Math.PI) / 180), Math.sin((-88 * Math.PI) / 180));
  assert.deepEqual({ ux: Math.round(v.ux), uy: Math.round(v.uy) }, { ux: 0, uy: -1 });
});

test("rdpSimplify는 서브픽셀 계단 지터를 제거하고 끝점을 보존한다", () => {
  // 수평선 위에 ±1px 계단 노이즈가 얹힌 점열
  const pts = [
    { x: 0, y: 0 }, { x: 10, y: 1 }, { x: 20, y: 0 }, { x: 30, y: 1 }, { x: 40, y: 0 },
  ];
  const out = rdpSimplify(pts, 2);
  assert.deepEqual(out[0], { x: 0, y: 0 });
  assert.deepEqual(out[out.length - 1], { x: 40, y: 0 });
  assert.ok(out.length < pts.length, `${out.length} 정점 (단순화 안 됨)`);
});

test("rdpSimplify는 폐곡선(start==end)을 단일 점으로 붕괴시키지 않는다(순환선)", () => {
  // 2호선 순환선처럼 끝점이 시작점과 동일한 사각 루프
  const loop = [
    { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }, { x: 0, y: 0 },
  ];
  const out = rdpSimplify(loop, 2);
  assert.ok(out.length >= 3, `폐곡선이 ${out.length}점으로 붕괴`);
  // 점-점거리 폴백으로 반대편 코너가 보존되어야 한다
  assert.ok(Math.max(...out.map((p) => p.x)) >= 100);
  assert.ok(Math.max(...out.map((p) => p.y)) >= 100);
});

test("rectifyPolyline은 8선형 근사 폴리라인을 위반 0으로 만들고 끝점을 고정한다", () => {
  // 수평 근사(1.5° 기울기) → 45° 근사(43°) 코너, 서브픽셀 지터 섞임
  const pts = [
    { x: 0, y: 0 },
    { x: 50, y: 1.3 }, // ~1.5° off horizontal
    { x: 51, y: 1.0 }, // jitter
    { x: 100, y: 47 }, // ~43° diagonal
    { x: 150, y: 97 },
  ];
  const out = rectifyPolyline(pts, { eps: 2, tol: 0.5 });
  // 끝점 보존
  assert.deepEqual(out[0], { x: 0, y: 0 });
  assert.deepEqual(out[out.length - 1], { x: 150, y: 97 });
  // 모든 세그먼트 8선형(±0.5°)
  for (let i = 1; i < out.length; i += 1) {
    assert.ok(
      segmentAngleDeg8Dev(out[i - 1], out[i]) <= 0.5,
      `세그먼트 ${i} 위반: dev=${segmentAngleDeg8Dev(out[i - 1], out[i])}`,
    );
  }
});

test("offsetPolyline은 폴리라인을 진행방향 왼쪽으로 수직 이동한다(거리 보존)", () => {
  // from→to 가 +x 방향인 수평선. 왼쪽(위) offset = -y (design y는 아래로 증가).
  const pts = [{ x: 0, y: 100 }, { x: 100, y: 100 }];
  const out = offsetPolyline(pts, 10);
  assert.equal(out.length, 2);
  assert.ok(Math.abs(out[0].y - 90) < 1e-9, `y=${out[0].y}`);
  assert.ok(Math.abs(out[1].y - 90) < 1e-9);
  // offset 0은 항등
  assert.deepEqual(offsetPolyline(pts, 0), pts);
});

test("chainEdgesForLine은 인접 에지를 순서대로 잇고 분기점에서 체인을 분리한다", () => {
  // 선형 체인 a-b-c
  const straight = chainEdgesForLine([
    { from: "a", to: "b", pts: [{ x: 0, y: 0 }, { x: 10, y: 0 }] },
    { from: "b", to: "c", pts: [{ x: 10, y: 0 }, { x: 20, y: 0 }] },
  ]);
  assert.equal(straight.length, 1, "선형은 체인 1개");
  assert.deepEqual(straight[0].map((p) => p.x), [0, 10, 20]);

  // 분기: a-b, b-c, b-d (b가 차수 3) → 체인 여러 개, 각 끝점은 분기점 포함
  const branched = chainEdgesForLine([
    { from: "a", to: "b", pts: [{ x: 0, y: 0 }, { x: 10, y: 0 }] },
    { from: "b", to: "c", pts: [{ x: 10, y: 0 }, { x: 20, y: 0 }] },
    { from: "b", to: "d", pts: [{ x: 10, y: 0 }, { x: 10, y: 10 }] },
  ]);
  // 3개의 에지가 분기점 b에서 갈리므로 최소 2개의 체인으로 분해된다.
  assert.ok(branched.length >= 2, `체인 ${branched.length}개`);
  // 모든 원본 에지 정점이 어떤 체인엔가 포함
  const allX = new Set(branched.flat().map((p) => `${p.x},${p.y}`));
  assert.ok(allX.has("20,0") && allX.has("10,10"));
});

test("chainEdgesForLine은 전 노드 차수2인 폐루프(순환선)를 하나의 체인으로 닫는다", () => {
  // 2호선처럼 모든 노드가 차수2인 순환선 — 첫 루프(차수≠2)를 건너뛰고 fallback 경로로만 처리
  const loop = chainEdgesForLine([
    { from: "a", to: "b", pts: [{ x: 0, y: 0 }, { x: 10, y: 0 }] },
    { from: "b", to: "c", pts: [{ x: 10, y: 0 }, { x: 10, y: 10 }] },
    { from: "c", to: "a", pts: [{ x: 10, y: 10 }, { x: 0, y: 0 }] },
  ]);
  assert.equal(loop.length, 1, "순환선은 체인 1개");
  assert.deepEqual(loop[0][0], loop[0][loop[0].length - 1], "시작점==끝점");
});
