import assert from "node:assert/strict";
import test from "node:test";

import { planNodeFix, resolvePrimarySlug } from "./fix-svg-station-line-membership.mjs";

// #2068 Phase C: data-line 오표기 감지 순수 함수 계약. 고촌(gtx-a로 오기, 진짜는
// 김포골드라인) 실측 사례를 고정한다.

const config = {
  canonicalRules: (svgName) => {
    const colon = svgName.indexOf(":");
    if (colon >= 0) return { name: svgName.slice(0, colon), disambiguateByLine: true };
    return { name: svgName };
  },
};

test("declared와 true가 같으면 패치 없음", () => {
  const node = { dataStation: "가산디지털단지", dataLine: "1", transferLines: "1 7" };
  const plan = planNodeFix(node, new Set(["1", "7"]), config);
  assert.equal(plan, null);
});

test("고촌: gtx-a 오기 → gimpo-goldline 진본 감지", () => {
  const node = { dataStation: "고촌", dataLine: "gtx-a", transferLines: "" };
  const plan = planNodeFix(node, new Set(["gimpo-goldline"]), config);
  assert.deepEqual(plan, {
    canonName: "고촌",
    declared: ["gtx-a"],
    trueSlugs: ["gimpo-goldline"],
  });
});

test("콜론 동명이역(disambiguateByLine)은 slug가 신원 근거라 제외", () => {
  const node = { dataStation: "신촌:2호선", dataLine: "2", transferLines: "" };
  const plan = planNodeFix(node, new Set(["2", "gyeongui-jungang"]), config);
  assert.equal(plan, null);
});

test("팩에 소속 노선이 0개면(위상 예외 등) 자동수정 대상 아님", () => {
  const node = { dataStation: "도라산", dataLine: "gyeongui-jungang", transferLines: "" };
  const plan = planNodeFix(node, new Set(), config);
  assert.equal(plan, null);
});

test("transferLines 다중 slug도 declared 집합에 합산", () => {
  const node = { dataStation: "청량리", dataLine: "gyeongchun", transferLines: "gyeongchun 1" };
  // true가 declared와 순서 무관 동일 집합이면 패치 없음.
  assert.equal(planNodeFix(node, new Set(["1", "gyeongchun"]), config), null);
  // true가 다르면 감지.
  const plan = planNodeFix(node, new Set(["1", "gyeongchun", "suin-bundang"]), config);
  assert.deepEqual(plan.trueSlugs, ["1", "gyeongchun", "suin-bundang"]);
});

test("resolvePrimarySlug: 기존 data-line이 진본 목록에 있으면 정렬 첫 slug가 아니어도 유지", () => {
  // 진본 소속 노선 {4, suin-bundang}(정렬됨), 기존 data-line "suin-bundang"이
  // 유효 → 정렬 첫 slug "4"로 교체하지 않고 유지한다.
  assert.equal(resolvePrimarySlug("suin-bundang", ["4", "suin-bundang"]), "suin-bundang");
});

test("resolvePrimarySlug: 기존 data-line이 진본 목록에 없으면 정렬 첫 slug로 교체", () => {
  assert.equal(resolvePrimarySlug("9", ["4", "suin-bundang"]), "4");
});
