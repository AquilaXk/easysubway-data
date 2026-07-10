import assert from "node:assert/strict";
import test from "node:test";

import { validateFareSample } from "./probe-seoul-fare-api.mjs";

const officialSample = {
  dptreStnCd: "0150",
  dptreStnNm: "서울역",
  arvlStnCd: "0151",
  arvlStnNm: "시청",
  gnrlCardFare: 1550,
  gnrlCashFare: 1650,
  yungCardFare: 900,
  yungCashFare: 1650,
  childCardFare: 550,
  childCashFare: 550,
};

test("서울역-시청 공식 요금 응답 계약을 검증한다", () => {
  assert.doesNotThrow(() => validateFareSample(officialSample));
  assert.throws(
    () => validateFareSample({ ...officialSample, yungCashFare: "1650" }),
    /yungCashFare/,
  );
  const { childCashFare: _, ...missingFare } = officialSample;
  assert.throws(() => validateFareSample(missingFare), /childCashFare/);
});
