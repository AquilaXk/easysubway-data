import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  validateKricProviderCodeCatalogIdentity,
  validateMolitProviderIdentities,
} from "./build-molit-nationwide-fixture.mjs";

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
