import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeMolitProviderLineName,
  parseMolitSvgProviderIdentity,
} from "./molit-svg-provider-identity.mjs";

test("MOLIT SVG 식별자에서 KRIC 권역·노선·운영기관 코드를 정확히 복원한다", () => {
  assert.deepEqual(
    parseMolitSvgProviderIdentity("subway_a02_l01", "BS(부산교통공사)"),
    {
      mreaWideCd: "02",
      lnCd: "1",
      railOprIsttCd: "BS",
      operatorName: "부산교통공사",
    },
  );
  assert.deepEqual(
    parseMolitSvgProviderIdentity("subway_a01_lA1", "AR(공항철도주식회사)"),
    {
      mreaWideCd: "01",
      lnCd: "A1",
      railOprIsttCd: "AR",
      operatorName: "공항철도주식회사",
    },
  );
  assert.deepEqual(
    parseMolitSvgProviderIdentity("subway_a01_lUI", "UI(우이신설경전철주식회사)"),
    {
      mreaWideCd: "01",
      lnCd: "UI",
      railOprIsttCd: "UI",
      operatorName: "우이신설경전철주식회사",
    },
  );
  assert.deepEqual(
    parseMolitSvgProviderIdentity("subway_a01_lG1", "GM(김포골드라인에스알에스(주))"),
    {
      mreaWideCd: "01",
      lnCd: "G1",
      railOprIsttCd: "GM",
      operatorName: "김포골드라인에스알에스(주)",
    },
  );
});

test("KRIC provider 형식이 아닌 노선도 행은 provider identity로 승격하지 않는다", () => {
  assert.equal(parseMolitSvgProviderIdentity("area01", "서울교통공사"), null);
  assert.equal(parseMolitSvgProviderIdentity("subway_a1_l01", "S1(서울교통공사)"), null);
  assert.equal(parseMolitSvgProviderIdentity("subway_a01_l01", "서울교통공사"), null);
});

test("MOLIT·KRIC 노선명 동의어는 하나의 provider key로 정규화한다", () => {
  for (const [name, expected] of [
    ["수도권 경의·중앙선", "경의중앙"],
    ["경춘선", "경춘"],
    ["수인분당선", "수인분당"],
    ["공항철도", "공항"],
    ["용인경전철", "에버라인"],
    ["용인에버라인", "에버라인"],
    ["우이신설경전철", "우이신설"],
    ["의정부경전철", "의정부"],
  ]) {
    assert.equal(normalizeMolitProviderLineName(name), expected);
  }
});
