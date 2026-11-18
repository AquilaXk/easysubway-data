import assert from "node:assert/strict";
import test from "node:test";
import { applyOverrideGroup } from "./apply-coordinate-overrides.mjs";

test("applyOverrideGroup은 override targetSpan으로 수렴하고 maxDist를 splice에 전달", () => {
  // 멤버 2개가 100px 벌어짐(대변위), 정점은 track 끝점에서 60px(기본 maxDist 30 밖)
  const group = {
    stationId: "hub",
    members: [{ lineId: "A", x: 0, y: 100 }, { lineId: "B", x: 100, y: 100 }],
  };
  const override = { targetSpan: 13, axis: "auto", maxDist: 80 };
  const tracksByLine = new Map([
    ["A", [{ trackIndex: 0, verts: [{ x: 0, y: 100 }, { x: 0, y: 0 }] }]],
    ["B", [{ trackIndex: 0, verts: [{ x: 100, y: 100 }, { x: 100, y: 0 }] }]],
  ]);
  const r = applyOverrideGroup(group, override, tracksByLine);
  // 두 멤버가 targetSpan(13)으로 수렴
  const dx = Math.abs(r.positionUpdates[0].x - r.positionUpdates[1].x);
  assert.ok(Math.abs(dx - 13) < 1e-6, `수렴 스팬 ${dx}`);
  assert.equal(r.trackUpdates.length, 2);
});

test("applyOverrideGroup: maxDist 밖 멤버는 position 미이동(원자성)", () => {
  const group = { stationId: "h", members: [{ lineId: "A", x: 0, y: 0 }, { lineId: "B", x: 20, y: 0 }] };
  const override = { targetSpan: 13, axis: "auto", maxDist: 5 }; // track 정점 500px 밖 → 부착 실패
  const tracksByLine = new Map([
    ["A", [{ trackIndex: 0, verts: [{ x: 500, y: 500 }, { x: 600, y: 500 }] }]],
    ["B", [{ trackIndex: 0, verts: [{ x: 520, y: 500 }, { x: 620, y: 500 }] }]],
  ]);
  const r = applyOverrideGroup(group, override, tracksByLine);
  assert.equal(r.positionUpdates.length, 0); // 아무도 부착 못함 → position 미발행
});
