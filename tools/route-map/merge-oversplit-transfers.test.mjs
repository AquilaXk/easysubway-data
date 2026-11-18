import assert from "node:assert/strict";
import test from "node:test";
import { MERGES, reconcileNameSub } from "./merge-oversplit-transfers.mjs";

test("reconcileNameSub는 대표의 부역명을 유지하고 없으면 흡수분에서 가져온다", () => {
  assert.equal(reconcileNameSub("돈암", "돈암"), "돈암");
  assert.equal(reconcileNameSub("", "성공회대입구"), "성공회대입구");
  assert.equal(reconcileNameSub("국립중앙박물관", ""), "국립중앙박물관");
  assert.equal(reconcileNameSub("", ""), "");
});

test("MERGES는 공식 근거로 확정한 수도권 환승역 오분리를 담는다", () => {
  const names = MERGES.map((m) => m.name).sort();
  assert.deepEqual(names, [
    "별내",
    "복정",
    "상봉",
    "석남",
    "성신여대입구",
    "온수",
    "이매",
    "이촌",
    "종로3가",
    "청량리",
  ]);
  for (const m of MERGES) {
    assert.match(m.keepId, /^station-[0-9a-f]{12}$/);
    assert.match(m.dropId, /^station-[0-9a-f]{12}$/);
    assert.notEqual(m.keepId, m.dropId);
    assert.ok(m.expectedSub, "부역명 기대값");
    assert.ok(m.evidence, "공식 근거");
  }
});
