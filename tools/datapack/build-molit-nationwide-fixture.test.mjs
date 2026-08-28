import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  validateKricProviderCodeCatalogIdentity,
  validateMolitProviderIdentities,
  filterRetiredSvgProviderRows,
  providerLineScopesFor,
} from "./build-molit-nationwide-fixture.mjs";

test("retired SVG provider row는 scope validation 전에 제외한다", () => {
  const row = { lineName: "자기부상", providerIdentity: { mreaWideCd: "01", operatorName: "인천교통공사" } };
  assert.deepEqual(filterRetiredSvgProviderRows([row], new Set(["line-cbe75f5287a1"])), []);
});

test("MOLIT provider identity가 coverage scope와 매칭되지 않으면 거부한다", () => {
  assert.throws(() => validateMolitProviderIdentities([{
    providerIdentity: {
      mreaWideCd: "01",
      lnCd: "4",
      railOprIsttCd: "S1",
      operatorName: "서울교통공사",
    },
    lineName: "4호선",
  }], []), /MOLIT provider scope is unmatched/);
});

test("MOLIT subway 행의 provider identity 파싱 실패를 거부한다", () => {
  assert.throws(() => validateMolitProviderIdentities([{
    svgFileName: "subway_a01_l4",
    providerIdentity: null,
    lineName: "4호선",
  }], []), /MOLIT subway provider identity is invalid/);
});

test("MOLIT provider identity는 canonical alias scope를 검증하고 코드 불일치를 거부한다", () => {
  const row = {
    providerIdentity: {
      mreaWideCd: "01",
      lnCd: "K4",
      railOprIsttCd: "KR",
      operatorName: "한국철도공사",
    },
    lineName: "경의·중앙선",
  };
  const scope = {
    regionId: "capital",
    operatorId: "korail",
    lineId: "line-6e39be0cb6e2",
    mreaWideCd: "01",
    lnCd: "K4",
    railOprIsttCd: "KR",
  };
  assert.doesNotThrow(() => validateMolitProviderIdentities([row], [scope]));
  assert.throws(() => validateMolitProviderIdentities([{
    ...row,
    providerIdentity: { ...row.providerIdentity, lnCd: "K1" },
  }], [scope]), /MOLIT\/KRIC provider code mismatch/);
});

test("KRIC provider code catalog는 공백이 있는 인천 노선명을 현재 provider scope로 해석한다", async () => {
  const catalog = JSON.parse(await readFile(
    new URL("./sources/kric-provider-code-catalog-20260228.json", import.meta.url),
    "utf8",
  ));
  const coverageScopes = new Map([
    ["capital:incheon-transit:line-98718184f016", {
      regionId: "capital", operatorId: "incheon-transit", lineId: "line-98718184f016",
    }],
    ["capital:incheon-transit:line-42b5805f3b5a", {
      regionId: "capital", operatorId: "incheon-transit", lineId: "line-42b5805f3b5a",
    }],
  ]);
  const lines = new Map([
    ["line-98718184f016", { nameKo: "인천 1호선" }],
    ["line-42b5805f3b5a", { nameKo: "인천 2호선" }],
  ]);

  assert.deepEqual(providerLineScopesFor(catalog, coverageScopes, lines), [
    {
      regionId: "capital", operatorId: "incheon-transit", lineId: "line-42b5805f3b5a",
      mreaWideCd: "01", railOprIsttCd: "IC", lnCd: "I2",
    },
    {
      regionId: "capital", operatorId: "incheon-transit", lineId: "line-98718184f016",
      mreaWideCd: "01", railOprIsttCd: "IC", lnCd: "I1",
    },
  ]);
});

test("KRIC provider code catalog identity는 source와 canonical content hash를 고정한다", async () => {
  const catalog = JSON.parse(await readFile(
    new URL("./sources/kric-provider-code-catalog-20260228.json", import.meta.url),
    "utf8",
  ));
  assert.doesNotThrow(() => validateKricProviderCodeCatalogIdentity(catalog));
  assert.throws(() => validateKricProviderCodeCatalogIdentity({
    ...catalog,
    sourceId: "unexpected",
  }), /sourceId is invalid/);
  assert.throws(() => validateKricProviderCodeCatalogIdentity({
    ...catalog,
    sourceSha256: "a".repeat(64),
  }), /sourceSha256 does not match/);
  assert.throws(() => validateKricProviderCodeCatalogIdentity({
    ...catalog,
    sourceSha256: "not-a-sha",
  }), /sourceSha256 is invalid/);
  assert.throws(() => validateKricProviderCodeCatalogIdentity({
    ...catalog,
    providerLines: catalog.providerLines.map((line, index) => (
      index === 0 ? { ...line, lnCd: "WRONG" } : line
    )),
  }), /canonical content hash does not match/);
});
