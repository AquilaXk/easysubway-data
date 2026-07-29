import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { gzipSync } from "node:zlib";

import {
  buildKricAccessibilityRoster,
  collectKricAccessibilitySnapshots,
  loadCanonicalStationLinesFromBundledIndex,
} from "./collect-kric-accessibility-snapshots.mjs";

const operation = {
  sourceId: "kric-station-elevator",
  endpoint: "https://openapi.kric.go.kr/openapi/convenientInfo/stationElevator",
  responseFields: ["railOprIsttCd", "lnCd", "stinCd", "dtlLoc"],
};
const roster = [
  { stationId: "station-b", lineId: "line-2", railOprIsttCd: "S1", lnCd: "2", stinCd: "202" },
  { stationId: "station-a", lineId: "line-1", railOprIsttCd: "S1", lnCd: "1", stinCd: "101" },
];

test("canonical fixture와 official route roster를 station-line tuple로 결속한다", () => {
  const fixture = {
    providerLineScopes: [
      { lineId: "line-1", mreaWideCd: "01", lnCd: "1", railOprIsttCd: "S1" },
    ],
  };
  const canonicalStationLines = [
    { artifactId: "bundled-capital", stationId: "station-a", lineId: "line-1", stationCode: "101", names: ["구가나"] },
    { artifactId: "bundled-capital", stationId: "station-b", lineId: "line-1", stationCode: "102", names: ["다라"] },
    { artifactId: "bundled-core", stationId: "station-a", lineId: "line-1", stationCode: "101", names: ["구가나"] },
  ];
  const routeRosters = {
    rosters: [{
      mreaWideCd: "01",
      lnCd: "1",
      resultCode: "00",
      stations: [
        { railOprIsttCd: "S1", lnCd: "1", stinCd: "102", stinNm: "다라" },
        { railOprIsttCd: "S1", lnCd: "1", stinCd: "101", stinNm: "새가나" },
      ],
    }],
  };

  assert.deepEqual(buildKricAccessibilityRoster({ fixture, canonicalStationLines, routeRosters }), [
    { stationId: "station-a", lineId: "line-1", railOprIsttCd: "S1", lnCd: "1", stinCd: "101", canonicalMappings: [
      { artifactId: "bundled-capital", stationId: "station-a", lineId: "line-1" },
      { artifactId: "bundled-core", stationId: "station-a", lineId: "line-1" },
    ] },
    { stationId: "station-b", lineId: "line-1", railOprIsttCd: "S1", lnCd: "1", stinCd: "102", canonicalMappings: [{ artifactId: "bundled-capital", stationId: "station-b", lineId: "line-1" }] },
  ]);
  canonicalStationLines.push({ artifactId: "bundled-capital", stationId: "station-duplicate", lineId: "line-1", stationCode: "101", names: ["새가나"] });
  assert.throws(
    () => buildKricAccessibilityRoster({ fixture, canonicalStationLines, routeRosters }),
    /ambiguous canonical KRIC station join/,
  );
  assert.throws(
    () => buildKricAccessibilityRoster({
      fixture,
      canonicalStationLines: canonicalStationLines.filter(({ stationId }) => stationId !== "station-duplicate")
        .concat({ artifactId: "bundled-capital", stationId: "station-missing", lineId: "line-1", stationCode: "999", names: ["없는역"] }),
      routeRosters,
    }),
    /canonical KRIC station join missing: bundled-capital\|station-missing\|line-1/,
  );
  assert.throws(
    () => buildKricAccessibilityRoster({
      fixture,
      canonicalStationLines: [],
      routeRosters: {
        ...routeRosters,
        providerScopes: [{ lineId: "line-x", mreaWideCd: "01", lnCd: "9", railOprIsttCd: "SX" }],
      },
    }),
    /KRIC active provider scope missing from fixture: line-x\/SX/,
  );
});

test("현재 standard source claim도 다음 snapshot roster 입력으로 다시 읽는다", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "easysubway-kric-current-claim-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sqlitePath = path.join(directory, "capital.sqlite");
  const gzipPath = `${sqlitePath}.gz`;
  const database = new DatabaseSync(sqlitePath);
  database.exec(`
    CREATE TABLE stations (id TEXT PRIMARY KEY, name_ko TEXT);
    CREATE TABLE station_lines (station_id TEXT, line_id TEXT, station_code TEXT);
    CREATE TABLE station_aliases (station_id TEXT, alias TEXT);
    CREATE TABLE station_facility_evidence (station_id TEXT, line_id TEXT, source_id TEXT);
  `);
  database.prepare("INSERT INTO stations VALUES (?,?)").run("station-a", "현재역");
  database.prepare("INSERT INTO station_lines VALUES (?,?,?)").run("station-a", "line-a", "101");
  database.prepare("INSERT INTO station_aliases VALUES (?,?)").run("station-a", "옛이름역");
  database.prepare("INSERT INTO station_facility_evidence VALUES (?,?,?)").run("station-a", "line-a", "kric-station-convenience-standard");
  database.close();
  const sqliteBytes = await readFile(sqlitePath);
  await writeFile(gzipPath, gzipSync(sqliteBytes));

  const memberships = await loadCanonicalStationLinesFromBundledIndex({
    bundledIndex: { packs: [{ id: "capital", asset: path.basename(gzipPath), sqliteSha256: createHash("sha256").update(sqliteBytes).digest("hex") }] },
    bundledRoot: directory,
  });

  assert.deepEqual(memberships, [{
    artifactId: "bundled-capital", stationId: "station-a", lineId: "line-a", stationCode: "101", names: ["옛이름역", "현재역"],
  }]);
});

test("KRIC accessibility snapshot은 tuple을 정렬하고 present/explicit-zero를 보존한다", async () => {
  const seen = [];
  const snapshots = await collectKricAccessibilitySnapshots({
    roster,
    operations: [operation],
    serviceKey: "super-secret",
    now: new Date("2026-07-28T00:00:00.000Z"),
    fetchImpl: async (url) => {
      seen.push(url.searchParams.get("stinCd"));
      const tuple = Object.fromEntries(url.searchParams);
      return response(200, tuple.stinCd === "101" ? [{ ...tuple, dtlLoc: "승강장" }] : []);
    },
  });

  assert.deepEqual(seen, ["101", "202"]);
  assert.deepEqual(snapshots[0].queries.map(({ status }) => status), ["PRESENT", "ABSENT_EXPLICIT_ZERO"]);
  assert.equal(snapshots[0].capturedAt, "2026-07-28T00:00:00.000Z");
  assert.equal(snapshots[0].observedAt, "2026-07-28T00:00:00.000Z");
  assert.equal(snapshots[0].snapshotId, "kric-station-elevator-20260728T000000000Z");
  assert.match(snapshots[0].schemaFingerprint, /^[0-9a-f]{64}$/);
  assert.equal(snapshots[0].freshUntil, "2026-07-29T00:00:00.000Z");
  assert.doesNotMatch(JSON.stringify(snapshots), /super-secret|serviceKey/);
});

test("표준 편의정보 row는 request tuple envelope로 provenance를 보존한다", async () => {
  const standardOperation = {
    sourceId: "kric-station-convenience-standard",
    endpoint: "https://openapi.kric.go.kr/openapi/handicapped/stationCnvFacl",
    responseFields: ["dtlLoc", "grndDvCd", "gubun", "imgPath", "mlFmlDvCd", "stinFlor", "trfcWeakDvCd"],
    tupleIdentityFields: [],
  };
  const standardRoster = [{
    ...roster[0],
    canonicalMappings: [{ artifactId: "bundled-capital", stationId: "station-b", lineId: "line-2" }],
  }];
  const snapshots = await collectKricAccessibilitySnapshots({
    roster: standardRoster,
    operations: [standardOperation],
    serviceKey: "key",
    fetchImpl: async () => response(200, [{
      dtlLoc: "대합실",
      grndDvCd: "U",
      gubun: "엘리베이터",
      imgPath: "",
      mlFmlDvCd: "",
      stinFlor: "B1",
      trfcWeakDvCd: "01",
    }]),
  });

  assert.equal(snapshots[0].queries[0].status, "PRESENT");
  assert.deepEqual(snapshots[0].queries[0].canonicalMappings, standardRoster[0].canonicalMappings);
});

test("소비하지 않는 provider 필드 drift는 raw hash만 바꾼다", async () => {
  const tuple = roster[0];
  const collect = (providerNotice) => collectKricAccessibilitySnapshots({
    roster: [tuple],
    operations: [operation],
    serviceKey: "key",
    now: new Date("2026-07-28T00:00:00.000Z"),
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        header: { resultCode: "00", resultMsg: "redacted" },
        providerNotice,
        body: [{ railOprIsttCd: tuple.railOprIsttCd, lnCd: tuple.lnCd, stinCd: tuple.stinCd, dtlLoc: "대합실" }],
      }),
    }),
  });

  const [left, right] = await Promise.all([collect("before"), collect("after")]);

  assert.notEqual(left[0].rawSha256, right[0].rawSha256);
  assert.equal(left[0].contentSha256, right[0].contentSha256);
});

test("duplicate station tuple은 호출 전에 거부한다", async () => {
  let calls = 0;
  await assert.rejects(() => collectKricAccessibilitySnapshots({
    roster: [roster[0], { ...roster[0], stationId: "duplicate" }],
    operations: [operation],
    serviceKey: "key",
    fetchImpl: async () => { calls += 1; },
  }), /duplicate KRIC station tuple/);
  assert.equal(calls, 0);
});

test("provider result 실패와 schema drift는 retry하지 않는다", async () => {
  for (const payload of [
    { header: { resultCode: "03" }, body: [] },
    { header: { resultCode: "00" }, body: [{ railOprIsttCd: "S1" }] },
  ]) {
    let calls = 0;
    await assert.rejects(() => collectKricAccessibilitySnapshots({
      roster: roster.slice(0, 1),
      operations: [operation],
      serviceKey: "key",
      fetchImpl: async () => { calls += 1; return response(200, payload.body, payload.header.resultCode); },
    }), /KRIC accessibility (provider result|schema) invalid/);
    assert.equal(calls, 1);
  }
});

test("header 없는 provider resultCode 00도 absence evidence로 인정하지 않는다", async () => {
  await assert.rejects(() => collectKricAccessibilitySnapshots({
    roster: roster.slice(0, 1),
    operations: [operation],
    serviceKey: "key",
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ resultCode: "00", resultMsg: "redacted" }),
    }),
  }), /KRIC accessibility provider result invalid/);
});

test("resultCode가 없는 bare array는 absence evidence로 인정하지 않는다", async () => {
  await assert.rejects(() => collectKricAccessibilitySnapshots({
    roster: roster.slice(0, 1),
    operations: [operation],
    serviceKey: "key",
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => [] }),
  }), /KRIC accessibility provider result invalid/);
});

test("provider resultCode 00 body array envelope는 표준 rows로 검증한다", async () => {
  const tuple = roster[0];
  const snapshots = await collectKricAccessibilitySnapshots({
    roster: [tuple],
    operations: [operation],
    serviceKey: "key",
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        header: { resultCode: "00", resultMsg: "redacted" },
        body: [{ railOprIsttCd: tuple.railOprIsttCd, lnCd: tuple.lnCd, stinCd: tuple.stinCd, dtlLoc: "대합실" }],
      }),
    }),
  });

  assert.equal(snapshots[0].queries[0].status, "PRESENT");
});

test("transport와 5xx는 정확히 한 번만 retry한다", async () => {
  for (const firstFailure of [new Error("timeout"), response(503, [])]) {
    let calls = 0;
    const snapshots = await collectKricAccessibilitySnapshots({
      roster: roster.slice(0, 1),
      operations: [operation],
      serviceKey: "key",
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) {
          if (firstFailure instanceof Error) throw firstFailure;
          return firstFailure;
        }
        return response(200, []);
      },
    });
    assert.equal(calls, 2);
    assert.equal(snapshots[0].queries[0].status, "ABSENT_EXPLICIT_ZERO");
  }
});

test("두 번째 transport 실패 뒤에는 fail closed다", async () => {
  let calls = 0;
  await assert.rejects(() => collectKricAccessibilitySnapshots({
    roster: roster.slice(0, 1),
    operations: [operation],
    serviceKey: "key",
    fetchImpl: async () => { calls += 1; throw new Error("timeout"); },
  }), /KRIC accessibility request failed/);
  assert.equal(calls, 2);
});

function response(status, body, resultCode = "00") {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => resultCode === "00"
      ? { header: { resultCode, resultMsg: "redacted" }, body }
      : { resultCode, resultMsg: "redacted" },
  };
}
