import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { gzipSync } from "node:zlib";

import {
  buildKricAccessibilityRoster,
  collectKricAccessibilitySnapshots,
  KRIC_ACCESSIBILITY_OPERATIONS,
  KRIC_APPROVED_ACCESSIBILITY_OPERATIONS,
  loadCanonicalStationLinesFromBundledIndex,
  validateKricAccessibilitySnapshotIdentity,
  validateKricAccessibilityProviderGapEvidence,
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

test("production 기본 KRIC 접근성 수집은 historical standard operation을 유지한다", async () => {
  const standardOperation = {
    sourceId: "kric-station-convenience-standard",
    endpoint: "https://openapi.kric.go.kr/openapi/handicapped/stationCnvFacl",
    responseFields: ["dtlLoc", "grndDvCd", "gubun", "imgPath", "mlFmlDvCd", "stinFlor", "trfcWeakDvCd"],
    tupleIdentityFields: [],
  };
  const snapshots = await collectKricAccessibilitySnapshots({
    roster: [{
      ...roster[0],
      canonicalMappings: [{ artifactId: "bundled-capital", stationId: "station-b", lineId: "line-2" }],
    }],
    serviceKey: "super-secret",
    fetchImpl: async (url) => {
      assert.equal(url.pathname, new URL(standardOperation.endpoint).pathname);
      return response(200, [Object.fromEntries(standardOperation.responseFields.map((field) => [field, "대합실"]))]);
    },
  });

  assert.deepEqual(KRIC_ACCESSIBILITY_OPERATIONS, [standardOperation]);
  assert.equal(snapshots[0].sourceId, standardOperation.sourceId);
  assert.deepEqual(validateKricAccessibilitySnapshotIdentity(snapshots[0]), snapshots[0]);
  assert.doesNotMatch(JSON.stringify(snapshots), /super-secret|serviceKey/);
});

test("승인된 KRIC 접근성 profile은 표준 편의정보 없이 exact 다섯 operation을 한 tuple에 한 번씩 수집한다", async () => {
  const expectedOperations = [
    {
      sourceId: "kric-station-elevator",
      endpoint: "https://openapi.kric.go.kr/openapi/convenientInfo/stationElevator",
      responseFields: ["dtlLoc", "exitNo", "grndDvNmFr", "grndDvNmTo", "lnCd", "railOprIsttCd", "rglnPsno", "rglnWgt", "runStinFlorFr", "runStinFlorTo", "stinCd"],
    },
    {
      sourceId: "kric-station-escalator",
      endpoint: "https://openapi.kric.go.kr/openapi/convenientInfo/stationEscalator",
      responseFields: ["dtlLoc", "exitNo", "grndDvNmFr", "grndDvNmTo", "lnCd", "railOprIsttCd", "runStinFlorFr", "runStinFlorTo", "stinCd", "updnDvNm"],
    },
    {
      sourceId: "kric-wheelchair-lift-location",
      endpoint: "https://openapi.kric.go.kr/openapi/vulnerableUserInfo/stationWheelchairLiftLocation",
      responseFields: ["bndWgt", "dtlLoc", "exitNo", "grndDvNmFr", "grndDvNmTo", "len", "lnCd", "railOprIsttCd", "runStinFlorFr", "runStinFlorTo", "stinCd", "wd"],
    },
    {
      sourceId: "kric-station-elevator-movement",
      endpoint: "https://openapi.kric.go.kr/openapi/vulnerableUserInfo/stationElevatorMovement",
      responseFields: ["lnCd", "mvContDtl", "mvDst", "mvPathDvCd", "mvPathDvNm", "mvPathMgNo", "mvTpOrdr", "railOprIsttCd", "stinCd"],
    },
    {
      sourceId: "kric-wheelchair-lift-movement",
      endpoint: "https://openapi.kric.go.kr/openapi/vulnerableUserInfo/stationWheelchairLiftMovement",
      responseFields: ["lnCd", "mvContDtl", "mvDst", "mvPathDvCd", "mvPathDvNm", "mvPathMgNo", "mvTpOrdr", "railOprIsttCd", "stinCd"],
    },
  ];
  const tuple = roster[0];
  const seen = [];
  const snapshots = await collectKricAccessibilitySnapshots({
    roster: [tuple],
    operations: KRIC_APPROVED_ACCESSIBILITY_OPERATIONS,
    serviceKey: "super-secret",
    now: new Date("2026-08-04T00:00:00.000Z"),
    fetchImpl: async (url) => {
      seen.push(`${url.pathname}/${url.searchParams.get("railOprIsttCd")}/${url.searchParams.get("lnCd")}/${url.searchParams.get("stinCd")}`);
      const expected = expectedOperations.find(({ endpoint }) => new URL(endpoint).pathname === url.pathname);
      return response(200, [Object.fromEntries(expected.responseFields.map((field) => [field, tuple[field] ?? field]))]);
    },
  });

  assert.deepEqual(KRIC_APPROVED_ACCESSIBILITY_OPERATIONS, expectedOperations.map((operation) => ({
    ...operation,
    tupleIdentityFields: ["railOprIsttCd", "lnCd", "stinCd"],
  })));
  assert.deepEqual(snapshots.map(({ sourceId, capturedAt }) => ({ sourceId, capturedAt })), expectedOperations.map(({ sourceId }) => ({
    sourceId,
    capturedAt: "2026-08-04T00:00:00.000Z",
  })));
  assert.deepEqual(seen, expectedOperations.map(({ endpoint }) => `${new URL(endpoint).pathname}/S1/2/202`));
  assert.doesNotMatch(JSON.stringify(snapshots), /super-secret|serviceKey/);
});

test("승인 profile snapshot은 row tuple이 query와 다르면 내부 hash가 일치해도 거부한다", async () => {
  const tuple = {
    ...roster[0],
    canonicalMappings: [{ artifactId: "bundled-capital", stationId: "station-b", lineId: "line-2" }],
  };
  const [snapshot] = await collectKricAccessibilitySnapshots({
    roster: [tuple],
    operations: KRIC_APPROVED_ACCESSIBILITY_OPERATIONS.slice(0, 1),
    serviceKey: "super-secret",
    fetchImpl: async () => response(200, [Object.fromEntries(
      KRIC_APPROVED_ACCESSIBILITY_OPERATIONS[0].responseFields.map((field) => [field, tuple[field] ?? field]),
    )]),
  });
  const tampered = structuredClone(snapshot);
  tampered.queries[0].rows[0].stinCd = "999";
  tampered.queries[0].providerRecordHash = hashForTest(tampered.queries[0].rows);
  tampered.contentSha256 = hashForTest(tampered.queries.map(({ rawResponseSha256: _, ...query }) => query));

  assert.throws(
    () => validateKricAccessibilitySnapshotIdentity(tampered),
    /KRIC accessibility snapshot identity is invalid/,
  );
});

test("기본 다섯 operation 중간 실패는 부분 snapshot 없이 즉시 거부한다", async () => {
  const tuple = roster[0];
  const seen = [];
  await assert.rejects(() => collectKricAccessibilitySnapshots({
    roster: [tuple],
    operations: KRIC_APPROVED_ACCESSIBILITY_OPERATIONS,
    serviceKey: "super-secret",
    fetchImpl: async (url) => {
      const sourceId = KRIC_APPROVED_ACCESSIBILITY_OPERATIONS.find(({ endpoint }) => new URL(endpoint).pathname === url.pathname).sourceId;
      seen.push(sourceId);
      if (sourceId === "kric-station-escalator") throw new Error("timeout");
      const operationForRequest = KRIC_APPROVED_ACCESSIBILITY_OPERATIONS.find(({ sourceId: id }) => id === sourceId);
      return response(200, [Object.fromEntries(operationForRequest.responseFields.map((field) => [field, tuple[field] ?? field]))]);
    },
  }), /KRIC accessibility request failed: kric-station-escalator\/S1\/2\/202/);
  assert.deepEqual(seen, [
    "kric-station-elevator",
    "kric-station-escalator",
  ]);
});

test("canonical fixture와 official route roster를 station-line tuple로 결속한다", () => {
  const activeLineScopes = [{ lineId: "line-1", regionId: "capital", operatorId: "operator-1" }];
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
    providerScopes: [{ ...activeLineScopes[0], mreaWideCd: "01", lnCd: "1", railOprIsttCd: "S1" }],
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

  assert.deepEqual(buildKricAccessibilityRoster({ activeLineScopes, fixture, canonicalStationLines, routeRosters }), [
    { stationId: "station-a", lineId: "line-1", railOprIsttCd: "S1", lnCd: "1", stinCd: "101", canonicalMappings: [
      { artifactId: "bundled-capital", stationId: "station-a", lineId: "line-1" },
      { artifactId: "bundled-core", stationId: "station-a", lineId: "line-1" },
    ] },
    { stationId: "station-b", lineId: "line-1", railOprIsttCd: "S1", lnCd: "1", stinCd: "102", canonicalMappings: [{ artifactId: "bundled-capital", stationId: "station-b", lineId: "line-1" }] },
  ]);
  canonicalStationLines.push({ artifactId: "bundled-capital", stationId: "station-duplicate", lineId: "line-1", stationCode: "101", names: ["새가나"] });
  assert.throws(
    () => buildKricAccessibilityRoster({ activeLineScopes, fixture, canonicalStationLines, routeRosters }),
    /ambiguous canonical KRIC station join/,
  );
  assert.throws(
    () => buildKricAccessibilityRoster({
      fixture,
      activeLineScopes,
      canonicalStationLines: canonicalStationLines.filter(({ stationId }) => stationId !== "station-duplicate")
        .concat({ artifactId: "bundled-capital", stationId: "station-missing", lineId: "line-1", stationCode: "999", names: ["없는역"] }),
      routeRosters,
    }),
    /canonical KRIC station join missing: bundled-capital\|station-missing\|line-1/,
  );
  assert.throws(
    () => buildKricAccessibilityRoster({
      fixture,
      activeLineScopes: [{ lineId: "line-x", regionId: "capital", operatorId: "operator-x" }],
      canonicalStationLines: [],
      routeRosters: {
        ...routeRosters,
        providerScopes: [{
          lineId: "line-x",
          regionId: "capital",
          operatorId: "operator-x",
          mreaWideCd: "01",
          lnCd: "9",
          railOprIsttCd: "SX",
        }],
      },
    }),
    /KRIC active provider scope missing from fixture: line-x\/SX/,
  );
  assert.throws(
    () => buildKricAccessibilityRoster({
      activeLineScopes: [],
      fixture,
      canonicalStationLines: canonicalStationLines.filter(({ stationId }) => stationId !== "station-duplicate"),
      routeRosters,
    }),
    /KRIC active provider scope set mismatch/,
  );
  const divergentIdentities = buildKricAccessibilityRoster({
    activeLineScopes,
    fixture,
    canonicalStationLines: canonicalStationLines.filter(({ stationId }) => stationId !== "station-duplicate").concat({
      artifactId: "bundled-core",
      stationId: "station-different",
      lineId: "line-1",
      stationCode: "102",
      names: ["다라"],
    }),
    routeRosters,
  }).filter(({ stinCd }) => stinCd === "102");
  assert.deepEqual(divergentIdentities.map(({ stationId, canonicalMappings }) => ({
    stationId,
    artifactIds: canonicalMappings.map(({ artifactId }) => artifactId),
  })), [
    { stationId: "station-b", artifactIds: ["bundled-capital"] },
    { stationId: "station-different", artifactIds: ["bundled-core"] },
  ]);
});

test("공식 KRIC 개명 tuple correction을 station id와 provider code로 결속한다", () => {
  const lineId = "line-828f04afc588";
  assert.deepEqual(buildKricAccessibilityRoster({
    activeLineScopes: [{ lineId, regionId: "capital", operatorId: "operator-b2d80436b438" }],
    fixture: { providerLineScopes: [{ lineId, mreaWideCd: "01", lnCd: "E1", railOprIsttCd: "EV" }] },
    canonicalStationLines: [{
      artifactId: "bundled-capital",
      stationId: "station-9d261727e400",
      lineId,
      stationCode: "11",
      names: ["운동장.송담대"],
    }],
    routeRosters: {
      providerScopes: [{
        lineId,
        regionId: "capital",
        operatorId: "operator-b2d80436b438",
        mreaWideCd: "01",
        lnCd: "E1",
        railOprIsttCd: "EV",
      }],
      rosters: [{
      mreaWideCd: "01",
      lnCd: "E1",
      resultCode: "00",
      stations: [{ railOprIsttCd: "EV", lnCd: "E1", stinCd: "Y120", stinNm: "용인중앙시장(용인예술과학대)" }],
      }],
    },
  }), [{
    stationId: "station-9d261727e400",
    lineId,
    railOprIsttCd: "EV",
    lnCd: "E1",
    stinCd: "Y120",
    canonicalMappings: [{ artifactId: "bundled-capital", stationId: "station-9d261727e400", lineId }],
  }]);
});

test("전체 station-line을 다음 snapshot roster 입력으로 읽는다", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "easysubway-kric-current-claim-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sqlitePath = path.join(directory, "capital.sqlite");
  const catalogDirectory = path.join(directory, "catalog");
  const gzipPath = path.join(catalogDirectory, "capital.sqlite.gz");
  await mkdir(catalogDirectory);
  const database = new DatabaseSync(sqlitePath);
  database.exec(`
    CREATE TABLE stations (id TEXT PRIMARY KEY, name_ko TEXT);
    CREATE TABLE station_lines (station_id TEXT, line_id TEXT, station_code TEXT);
    CREATE TABLE station_aliases (station_id TEXT, alias TEXT);
    CREATE TABLE station_facility_evidence (station_id TEXT, line_id TEXT, source_id TEXT);
  `);
  database.prepare("INSERT INTO stations VALUES (?,?)").run("station-a", "현재역");
  database.prepare("INSERT INTO stations VALUES (?,?)").run("station-b", "미평가역");
  database.prepare("INSERT INTO station_lines VALUES (?,?,?)").run("station-a", "line-a", "101");
  database.prepare("INSERT INTO station_lines VALUES (?,?,?)").run("station-b", "line-a", "102");
  database.prepare("INSERT INTO station_aliases VALUES (?,?)").run("station-a", "옛이름역");
  database.prepare("INSERT INTO station_facility_evidence VALUES (?,?,?)").run("station-a", "line-a", "kric-station-convenience-standard");
  database.close();
  const sqliteBytes = await readFile(sqlitePath);
  await writeFile(gzipPath, gzipSync(sqliteBytes));

  const memberships = await loadCanonicalStationLinesFromBundledIndex({
    bundledIndex: { packs: [{ id: "capital", url: `catalog/${path.basename(gzipPath)}`, sqliteSha256: createHash("sha256").update(sqliteBytes).digest("hex") }] },
    bundledRoot: directory,
  });

  assert.deepEqual(memberships, [{
    artifactId: "bundled-capital", stationId: "station-a", lineId: "line-a", stationCode: "101", names: ["현재역"],
  }, {
    artifactId: "bundled-capital", stationId: "station-b", lineId: "line-a", stationCode: "102", names: ["미평가역"],
  }]);

  await assert.rejects(
    loadCanonicalStationLinesFromBundledIndex({
      bundledIndex: { packs: [{ id: "capital", asset: path.basename(gzipPath), sqliteSha256: createHash("sha256").update(sqliteBytes).digest("hex") }] },
      bundledRoot: directory,
    }),
    /pack url is invalid/,
  );
  await assert.rejects(
    loadCanonicalStationLinesFromBundledIndex({
      bundledIndex: { packs: [{ id: "capital", url: "../capital.sqlite.gz", sqliteSha256: createHash("sha256").update(sqliteBytes).digest("hex") }] },
      bundledRoot: directory,
    }),
    /pack url is invalid/,
  );
});

test("KRIC accessibility snapshot은 tuple을 정렬하고 present/explicit-zero를 보존한다", async () => {
  const seen = [];
  const delays = [];
  const snapshots = await collectKricAccessibilitySnapshots({
    roster: [...roster, { ...roster[0], stationId: "station-c" }],
    operations: [operation],
    serviceKey: "super-secret",
    now: new Date("2026-07-28T00:00:00.000Z"),
    requestIntervalMs: 250,
    delayImpl: async (milliseconds) => { delays.push(milliseconds); },
    fetchImpl: async (url) => {
      seen.push(url.searchParams.get("stinCd"));
      const tuple = Object.fromEntries(url.searchParams);
      return response(200, tuple.stinCd === "101" ? [{ ...tuple, dtlLoc: "승강장" }] : []);
    },
  });

  assert.deepEqual(seen, ["101", "202"]);
  assert.deepEqual(delays, [250]);
  assert.deepEqual(snapshots[0].queries.map(({ status }) => status), [
    "PRESENT", "ABSENT_EXPLICIT_ZERO", "ABSENT_EXPLICIT_ZERO",
  ]);
  assert.equal(snapshots[0].capturedAt, "2026-07-28T00:00:00.000Z");
  assert.equal(snapshots[0].observedAt, "2026-07-28T00:00:00.000Z");
  assert.equal(snapshots[0].snapshotId, "kric-station-elevator-20260728T000000000Z");
  assert.match(snapshots[0].schemaFingerprint, /^[0-9a-f]{64}$/);
  assert.equal(snapshots[0].freshUntil, "2026-07-29T00:00:00.000Z");
  assert.doesNotMatch(JSON.stringify(snapshots), /super-secret|serviceKey/);
});

test("기본 elevator row는 request tuple envelope로 provenance를 보존한다", async () => {
  const elevatorRoster = [{
    ...roster[0],
    canonicalMappings: [{ artifactId: "bundled-capital", stationId: "station-b", lineId: "line-2" }],
  }];
  const snapshots = await collectKricAccessibilitySnapshots({
    roster: elevatorRoster,
    operations: [operation],
    serviceKey: "key",
    fetchImpl: async () => response(200, [Object.fromEntries(operation.responseFields.map((field) => [
      field,
      elevatorRoster[0][field] ?? "대합실",
    ]))]),
  });

  assert.equal(snapshots[0].queries[0].status, "PRESENT");
  assert.deepEqual(snapshots[0].queries[0].canonicalMappings, elevatorRoster[0].canonicalMappings);
  assert.throws(
    () => validateKricAccessibilitySnapshotIdentity({ ...snapshots[0], schemaVersion: 2 }),
    /KRIC accessibility snapshot identity is invalid/,
  );
  assert.throws(
    () => validateKricAccessibilitySnapshotIdentity({ ...snapshots[0], absenceEvidenceMode: "PARTIAL_LIST" }),
    /KRIC accessibility snapshot identity is invalid/,
  );
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
    roster: [roster[0], { ...roster[0] }],
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

test("provider result 실패는 exact tuple만 진단한다", async () => {
  await assert.rejects(() => collectKricAccessibilitySnapshots({
    roster: roster.slice(0, 1),
    operations: [operation],
    serviceKey: "key",
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ header: { resultCode: "03" } }),
    }),
  }), {
    name: "Error",
    message: "KRIC accessibility provider gaps: count=1; tuples=kric-station-elevator/S1/2/202/03",
  });
});

test("provider 03은 전체 safe tuple을 모은 뒤 fail closed한다", async () => {
  let calls = 0;
  await assert.rejects(() => collectKricAccessibilitySnapshots({
    roster,
    operations: [operation],
    serviceKey: "key",
    fetchImpl: async () => {
      calls += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({ header: { resultCode: "03" } }),
      };
    },
  }), {
    name: "Error",
    message: "KRIC accessibility provider gaps: count=2; tuples=kric-station-elevator/S1/1/101/03,kric-station-elevator/S1/2/202/03",
  });
  assert.equal(calls, 2);
});

test("provider gap evidence는 exact 24 tuple과 operator 분포를 고정한다", async () => {
  const evidence = JSON.parse(await readFile(new URL(
    "./sources/kric-station-convenience-provider-gaps-20260729.json",
    import.meta.url,
  ), "utf8"));

  assert.deepEqual(validateKricAccessibilityProviderGapEvidence(evidence), {
    count: 24,
    operatorCounts: { GU: 3, GX: 5, KR: 15, S1: 1 },
  });
  assert.throws(() => validateKricAccessibilityProviderGapEvidence({
    ...evidence,
    gaps: [...evidence.gaps, evidence.gaps[0]],
  }), /duplicate KRIC accessibility provider gap/);
  assert.throws(() => validateKricAccessibilityProviderGapEvidence({
    ...evidence,
    gaps: evidence.gaps.map((gap, index) => index === 0 ? { ...gap, resultCode: "00" } : gap),
  }), /provider gap resultCode must be 03/);
  assert.throws(() => validateKricAccessibilityProviderGapEvidence({
    ...evidence,
    resultCodeInterpretation: undefined,
  }), /provider gap evidence is invalid/);
  assert.throws(() => validateKricAccessibilityProviderGapEvidence({
    ...evidence,
    resultCodeInterpretation: "ABSENCE",
  }), /provider gap evidence is invalid/);
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

test("transport와 5xx는 한 번 요청 후 fail closed한다", async () => {
  for (const firstFailure of [new Error("timeout"), response(503, [])]) {
    let calls = 0;
    const delays = [];
    await assert.rejects(collectKricAccessibilitySnapshots({
      roster: roster.slice(0, 1),
      operations: [operation],
      serviceKey: "key",
      requestIntervalMs: 250,
      delayImpl: async (milliseconds) => { delays.push(milliseconds); },
      fetchImpl: async () => {
        calls += 1;
        if (firstFailure instanceof Error) throw firstFailure;
        return firstFailure;
      },
    }));
    assert.equal(calls, 1);
    assert.deepEqual(delays, []);
  }
});

test("transport 실패는 한 번 요청 후 fail closed다", async () => {
  let calls = 0;
  await assert.rejects(() => collectKricAccessibilitySnapshots({
    roster: roster.slice(0, 1),
    operations: [operation],
    serviceKey: "key",
    fetchImpl: async () => { calls += 1; throw new Error("timeout"); },
  }), {
    name: "Error",
    message: "KRIC accessibility request failed: kric-station-elevator/S1/2/202",
  });
  assert.equal(calls, 1);
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

function hashForTest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
