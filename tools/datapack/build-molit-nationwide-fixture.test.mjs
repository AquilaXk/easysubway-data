import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as currentMolit from "./current-molit-observation.mjs";

import {
  validateKricProviderCodeCatalogIdentity,
  validateMolitProviderIdentities,
  filterRetiredSvgProviderRows,
  providerLineScopesFor,
  parseCurrentMolitGwangjuStationMappings,
  parseCurrentMolitLineOperatorRosters,
} from "./build-molit-nationwide-fixture.mjs";

test("current MOLIT rosters preserve source operator-line membership without KRIC codes", () => {
  const rows = ["첫역", "다음역"].map((station_name, index) => ({
    region_code: "01", region_name: "수도권", operator_name: "공항철도주식회사",
    line_name: "공항", station_sequence: index + 1, station_name,
  }));
  const rosters = [...parseCurrentMolitLineOperatorRosters(rows).values()];
  assert.equal(rosters.length, 1);
  assert.equal(rosters[0].operatorName, rows[0].operator_name);
  assert.deepEqual(rosters[0].stationNames, rows.map(({ station_name }) => station_name));
  assert.throws(() => parseCurrentMolitLineOperatorRosters([]), /no line-operator rosters/);
});

test("current MOLIT membership coverage binds exact pairs to observation bytes", () => {
  const projection = [
    { region_code: "01", region_name: "수도권", operator_name: "공항철도주식회사", line_name: "공항", station_sequence: 1, station_name: "가" },
    { region_code: "04", region_name: "광주", operator_name: "광주교통공사", line_name: "1호선", station_sequence: 1, station_name: "나" },
  ];
  const hash = (value) => createHash("sha256").update(value).digest("hex");
  const observation = {
    sourceId: "molit-urban-rail-full-route", snapshotId: "test-molit-observation",
    capturedAt: new Date(0).toISOString(), rawSha256: hash("official test raw"),
    contentSha256: hash(`${JSON.stringify(projection)}\n`), schemaFingerprint: hash("test schema"),
    rowCount: projection.length, normalizedProjection: projection,
    providerRecordHashes: projection.map((row) => hash(JSON.stringify(row))),
  };
  const observationBytes = Buffer.from(`${JSON.stringify(observation)}\n`);
  const current = { ...observation, retrievedAt: observation.capturedAt,
    normalizedObservationSha256: hash(observationBytes) };
  const evidence = currentMolit.deriveCurrentMolitMembershipCoverage({ observation, observationBytes, current });
  assert.deepEqual(evidence.lineOperatorScopes, [...parseCurrentMolitLineOperatorRosters(projection).values()]
    .map(({ regionId, operatorId, lineId }) => ({ regionId, operatorId, lineId }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b), "en")));
  assert.equal(evidence.lineOperatorScopes.length, projection.length);
  assert.equal(evidence.snapshotId, current.snapshotId);
  assert.equal(evidence.rawSha256, current.rawSha256);
  assert.equal(evidence.normalizedObservationSha256, hash(observationBytes));
  assert.throws(() => currentMolit.deriveCurrentMolitMembershipCoverage({
    observation: { ...observation, normalizedProjection: projection.slice(1) }, observationBytes, current,
  }), /normalized observation binding/);
});

test("Gwangju membership binds the complete admitted projection without a fixed national count", () => {
  const projection = ["가", "나"].map((station_name, index) => ({
    region_code: "04", region_name: "광주", operator_name: "광주교통공사",
    line_name: "1호선", station_sequence: index + 1, station_name,
  }));
  const rawSha256 = createHash("sha256").update("retained synthetic source").digest("hex");
  const current = { sourceId: "molit-urban-rail-full-route", rawSha256, rowCount: projection.length,
    contentSha256: createHash("sha256").update(`${JSON.stringify(projection)}\n`).digest("hex") };
  const topology = { scope: projection.map((row, index) => ({ stationName: row.station_name, stationCode: `s${index}` })) };
  const mappings = parseCurrentMolitGwangjuStationMappings(projection, rawSha256, topology, current);
  assert.deepEqual(mappings.map(({ stationNumber }) => stationNumber), topology.scope.map(({ stationCode }) => stationCode));
  for (const rows of [projection.slice(0, 1), projection.map((row) => ({ ...row, station_name: `${row.station_name}변경` }))]) {
    assert.throws(() => parseCurrentMolitGwangjuStationMappings(rows, rawSha256, topology, current), /ledger projection binding/);
  }
  assert.throws(() => parseCurrentMolitGwangjuStationMappings(projection, "0".repeat(64), topology, current), /ledger projection binding/);
  assert.throws(() => parseCurrentMolitGwangjuStationMappings(projection, rawSha256, topology), /ledger projection binding/);
});

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
