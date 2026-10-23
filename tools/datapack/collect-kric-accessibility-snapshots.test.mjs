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
  collectKricStandardAccessibilityObservation,
  collectKricAccessibilitySnapshots,
  KRIC_ACCESSIBILITY_OPERATIONS,
  loadCanonicalStationLinesFromBundledIndex,
  validateKricAccessibilityRawCollection,
  validateKricAccessibilitySnapshotIdentity,
  validateKricAccessibilityProviderGapEvidence,
  writeKricStandardAccessibilityObservation,
} from "./collect-kric-accessibility-snapshots.mjs";
import { defineSourceCollectionRetryTests } from "./lib/source-collection-retry-test-support.mjs";
import { createTransientRetryBudget } from "./lib/transient-retry.mjs";

// 재시도 대기와 예산을 테스트마다 격리한다(실제 대기 없이, 프로세스 공용 예산을 소모하지 않는다). 난수 0.5로 full jitter 대기는 1·2초(base 2초·cap 20초)가 된다.
const retryFast = (waits = []) => ({
  retrySleepImpl: async (milliseconds) => { waits.push(milliseconds); },
  retryBudget: createTransientRetryBudget(),
  retryRandomImpl: () => 0.5,
});

const operation = {
  sourceId: "kric-station-convenience-standard",
  endpoint: "https://openapi.kric.go.kr/openapi/handicapped/stationCnvFacl",
  responseFields: ["railOprIsttCd", "lnCd", "stinCd", "dtlLoc"],
};
const roster = [
  { stationId: "station-b", lineId: "line-2", railOprIsttCd: "S1", lnCd: "2", stinCd: "202" },
  { stationId: "station-a", lineId: "line-1", railOprIsttCd: "S1", lnCd: "1", stinCd: "101" },
];

// #3036 QA 승인 2026-10-23: stationEscalator를 퇴역 id(kric-station-escalator)가 아닌 새 원천 id로 다시 받는다.
// 응답 필드는 hub API 카탈로그 provider:kric-station-escalator의 실측 필드와 같다.
const escalatorOperation = {
  sourceId: "kric-station-escalator-detailed",
  endpoint: "https://openapi.kric.go.kr/openapi/convenientInfo/stationEscalator",
  responseFields: ["dtlLoc", "exitNo", "grndDvNmFr", "grndDvNmTo", "lnCd", "railOprIsttCd", "runStinFlorFr", "runStinFlorTo", "stinCd", "updnDvNm"],
  tupleIdentityFields: ["railOprIsttCd", "lnCd", "stinCd"],
};

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
    operations: [KRIC_ACCESSIBILITY_OPERATIONS[0]],
    serviceKey: "super-secret",
    fetchImpl: async (url) => {
      assert.equal(url.pathname, new URL(standardOperation.endpoint).pathname);
      return response(200, [Object.fromEntries(standardOperation.responseFields.map((field) => [field, "대합실"]))]);
    },
  });

  assert.deepEqual(KRIC_ACCESSIBILITY_OPERATIONS.map(({ terminalResult03Policy: _policy, ...rest }) => rest), [standardOperation, escalatorOperation]);
  assert.deepEqual(KRIC_ACCESSIBILITY_OPERATIONS.map(({ terminalResult03Policy }) => terminalResult03Policy), [
    "EXACT_TUPLE_PROVIDER_RESULT_03", "ANY_TUPLE_PROVIDER_RESULT_03",
  ]);
  assert.equal(snapshots[0].sourceId, standardOperation.sourceId);
  assert.deepEqual(validateKricAccessibilitySnapshotIdentity(snapshots[0]), snapshots[0]);
  assert.doesNotMatch(JSON.stringify(snapshots), /super-secret|serviceKey/);
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
  await assert.rejects(
    loadCanonicalStationLinesFromBundledIndex({
      bundledIndex: {
        packs: [
          { id: "missing", url: "catalog/missing.sqlite.gz", sqliteSha256: createHash("sha256").update(sqliteBytes).digest("hex") },
          { id: "invalid", url: "../capital.sqlite.gz", sqliteSha256: createHash("sha256").update(sqliteBytes).digest("hex") },
        ],
      },
      bundledRoot: directory,
    }),
    /invalid: pack url is invalid/,
  );
  for (const invalidUrl of [gzipPath, "catalog/capital.sqlite"]) {
    await assert.rejects(
      loadCanonicalStationLinesFromBundledIndex({
        bundledIndex: { packs: [{ id: "capital", url: invalidUrl, sqliteSha256: createHash("sha256").update(sqliteBytes).digest("hex") }] },
        bundledRoot: directory,
      }),
      /pack url is invalid/,
    );
  }
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
      delete tuple.serviceKey;
      delete tuple.format;
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
  assert.equal(snapshots[0].snapshotId, "kric-station-convenience-standard-20260728T000000000Z");
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
    message: "KRIC accessibility provider gaps: count=1; tuples=kric-station-convenience-standard/S1/2/202/03",
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
    message: "KRIC accessibility provider gaps: count=2; tuples=kric-station-convenience-standard/S1/1/101/03,kric-station-convenience-standard/S1/2/202/03",
  });
  assert.equal(calls, 2);
});

test("standard observation은 exact S1/2/234-4의 단일 03을 raw와 함께 terminal mixed snapshot으로 보존한다", async () => {
  const terminal = {
    stationId: "station-b35616704ce3", lineId: "seoul-2", railOprIsttCd: "S1", lnCd: "2", stinCd: "234-4",
    canonicalMappings: [{ artifactId: "bundled-capital", stationId: "station-b35616704ce3", lineId: "seoul-2" }],
  };
  const normal = ["normal-a", "normal-b"].map((stinCd, index) => ({
    stationId: `station-${index}`, lineId: `line-${index}`, railOprIsttCd: "S1", lnCd: "2", stinCd,
    canonicalMappings: [{ artifactId: "bundled-capital", stationId: `station-${index}`, lineId: `line-${index}` }],
  }));
  const observation = await collectKricStandardAccessibilityObservation({
    roster: [terminal, ...normal], serviceKey: "key",
    fetchImpl: async (url) => url.searchParams.get("stinCd") === "234-4"
      ? { ok: true, status: 200, json: async () => ({ header: { resultCode: "03" }, body: [] }) }
      : response(200, []),
  });
  const blocked = observation.snapshot.queries.find(({ stinCd }) => stinCd === "234-4");
  assert.equal(observation.snapshot.providerResultCode, "MIXED");
  assert.equal(observation.snapshot.queryCount, observation.snapshot.queries.length);
  assert.equal(observation.rawArtifact.requestCount, observation.snapshot.queries.length);
  assert.equal(observation.snapshot.absenceEvidenceMode, "EXHAUSTIVE_LIST_WITH_UNVERIFIED_EVIDENCE_BLOCKED");
  assert.deepEqual(blocked, {
    ...terminal, providerResultCode: "03", status: "UNVERIFIED_EVIDENCE_BLOCKED",
    terminalPolicy: "EXACT_TUPLE_PROVIDER_RESULT_03", rows: [], providerRecordHash: null,
    rawResponseSha256: blocked.rawResponseSha256,
  });
  assert.equal(observation.rawArtifact.responses.filter(({ providerResultCode }) => providerResultCode === "03").length, 1);
  assert.deepEqual(validateKricAccessibilityRawCollection(observation.rawArtifact, observation.snapshot), observation.rawArtifact);

  for (const resultCodeFor of [
    (stinCd) => stinCd === "normal-a" ? "03" : "00",
    (stinCd) => stinCd === "234-4" || stinCd === "normal-a" ? "03" : "00",
  ]) {
    await assert.rejects(collectKricStandardAccessibilityObservation({
      roster: [terminal, ...normal], serviceKey: "key",
      fetchImpl: async (url) => resultCodeFor(url.searchParams.get("stinCd")) === "03"
        ? { ok: true, status: 200, json: async () => ({ header: { resultCode: "03" }, body: [] }) }
        : response(200, []),
    }), /provider gaps/u);
  }
  const drifted = structuredClone(observation);
  drifted.snapshot.queries.find(({ stinCd }) => stinCd === "234-4").lineId = "seoul-9";
  assert.throws(() => validateKricAccessibilityRawCollection(drifted.rawArtifact, drifted.snapshot), /snapshot identity/u);
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

test("일시 오류(전송 오류·503)가 끝까지 이어지면 첫 시도 + 2번 재시도 뒤 fail closed한다", async () => {
  for (const failure of [Object.assign(new Error("timeout"), { code: "UND_ERR_CONNECT_TIMEOUT" }), response(503, [])]) {
    let calls = 0;
    const delays = [];
    const retryWaits = [];
    await assert.rejects(collectKricAccessibilitySnapshots({
      roster: roster.slice(0, 1),
      operations: [operation],
      serviceKey: "key",
      requestIntervalMs: 250,
      delayImpl: async (milliseconds) => { delays.push(milliseconds); },
      ...retryFast(retryWaits),
      fetchImpl: async () => {
        calls += 1;
        if (failure instanceof Error) throw failure;
        return failure;
      },
    }), /KRIC accessibility (request failed: NETWORK_TIMEOUT|HTTP 503): kric-station-convenience-standard\/S1\/2\/202/);
    assert.equal(calls, 3);
    assert.deepEqual(delays, [], "요청 간격 pacing은 논리 요청 하나에 한 번이다");
    assert.deepEqual(retryWaits, [1_000, 2_000]);
  }
});

// #1099: 2026-10-09T14:17Z kric-current-facility-refresh run 37943008782가 요청 한 건의 DNS 일시 실패로 시설 갱신 전체를 실패시켰다.
test("DNS 일시 실패·502·본문 timeout 뒤 같은 요청이 성공하면 그 응답으로 수집한다(run 37943008782 재현)", async () => {
  const failures = [
    () => { throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("getaddrinfo EAI_AGAIN openapi.kric.go.kr"), { code: "EAI_AGAIN" }) }); },
    () => response(502, []),
    () => ({ ok: true, status: 200, json: async () => { throw Object.assign(new Error("body timeout"), { code: "UND_ERR_BODY_TIMEOUT" }); } }),
  ];
  const row = Object.fromEntries(operation.responseFields.map((field) => [field, field === "railOprIsttCd" ? "S1" : field === "lnCd" ? "2" : field === "stinCd" ? "202" : "대합실"]));
  for (const failure of failures) {
    let calls = 0;
    const waits = [];
    const retry = retryFast(waits);
    const snapshots = await collectKricAccessibilitySnapshots({
      roster: roster.slice(0, 1),
      operations: [operation],
      serviceKey: "key",
      ...retry,
      fetchImpl: async () => {
        calls += 1;
        return calls === 1 ? failure() : response(200, [row]);
      },
    });
    assert.equal(calls, 2);
    assert.deepEqual(waits, [1_000]);
    assert.equal(retry.retryBudget.spentMs >= 1_000 && retry.retryBudget.spentMs < 1_500, true, "대기 1초 + 시도 경과(테스트에서는 ~0ms)");
    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0].queries[0].rows.length, 1);
  }
});

test("인증·형식 오류는 재시도하지 않는다(HTTP 401·403·501, 잘못된 JSON, provider resultCode)", async () => {
  const cases = [
    [() => response(401, []), /KRIC accessibility HTTP 401/],
    [() => response(403, []), /KRIC accessibility HTTP 403/],
    [() => response(501, []), /KRIC accessibility HTTP 501/],
    [() => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("malformed provider JSON"); } }), /KRIC accessibility schema invalid/],
    [() => ({ ok: true, status: 200, json: async () => ({ header: { resultCode: "99" }, body: [] }) }), /provider result invalid: kric-station-convenience-standard\/S1\/2\/202\/99/],
    [() => ({ ok: true, status: 200, json: async () => ({ header: { resultCode: "22" }, body: [] }) }), /provider result invalid: kric-station-convenience-standard\/S1\/2\/202\/22/],
  ];
  for (const [respond, expectation] of cases) {
    let calls = 0;
    const waits = [];
    await assert.rejects(collectKricAccessibilitySnapshots({
      roster: roster.slice(0, 1), operations: [operation], serviceKey: "key", ...retryFast(waits),
      fetchImpl: async () => { calls += 1; return respond(); },
    }), expectation);
    assert.equal(calls, 1, String(expectation));
    assert.deepEqual(waits, []);
  }
});

test("재시도 대기 예산을 넘기면 마지막 전송 오류 분류로 실패한다", async () => {
  let calls = 0;
  const waits = [];
  await assert.rejects(collectKricAccessibilitySnapshots({
    roster: roster.slice(0, 1), operations: [operation], serviceKey: "key",
    retrySleepImpl: async (milliseconds) => { waits.push(milliseconds); },
    retryBudget: createTransientRetryBudget(2_500),
    retryRandomImpl: () => 0.5,
    fetchImpl: async () => { calls += 1; throw Object.assign(new Error("reset"), { code: "ECONNRESET" }); },
  }), { message: "KRIC accessibility request failed: NETWORK_SOCKET: kric-station-convenience-standard/S1/2/202" });
  assert.equal(calls, 2);
  assert.deepEqual(waits, [1_000]);
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
    message: "KRIC accessibility request failed: NETWORK_UNKNOWN: kric-station-convenience-standard/S1/2/202",
  });
  assert.equal(calls, 1);
});

test("transport 실패는 bounded cause에서 비밀 없는 closed 원인만 분류한다", async () => {
  const secret = "must-not-reflect-provider-credential";
  const cases = [
    [new Error(secret, { cause: { code: "ENOTFOUND" } }), "NETWORK_DNS", 3],
    [Object.assign(new Error(secret), { code: "ERR_TLS_CERT_ALTNAME_INVALID" }), "NETWORK_TLS", 1],
    [Object.assign(new Error(secret), { code: "UNABLE_TO_GET_ISSUER_CERT_LOCALLY" }), "NETWORK_TLS", 1],
    [Object.assign(new Error(secret), { code: "ERR_SSL_WRONG_VERSION_NUMBER" }), "NETWORK_TLS", 1],
    [new Error(secret, { cause: { name: "TimeoutError", code: "UND_ERR_CONNECT_TIMEOUT" } }), "NETWORK_TIMEOUT", 3],
    [new Error(secret, { cause: new Error(secret, { cause: { code: "ECONNRESET" } }) }), "NETWORK_SOCKET", 3],
    [new Error(secret), "NETWORK_UNKNOWN", 1],
  ];

  // 일시 오류(DNS·timeout·소켓)는 같은 요청을 2번 다시 보낸 뒤, 인증서·알 수 없는 오류는 바로 같은 closed 원인으로 실패한다.
  for (const [failure, classification, expectedCalls] of cases) {
    let calls = 0;
    await assert.rejects(() => collectKricAccessibilitySnapshots({
      roster: roster.slice(0, 1),
      operations: [operation],
      serviceKey: secret,
      ...retryFast(),
      fetchImpl: async () => { calls += 1; throw failure; },
    }), (error) => {
      assert.equal(
        error.message,
        `KRIC accessibility request failed: ${classification}: kric-station-convenience-standard/S1/2/202`,
      );
      assert.doesNotMatch(error.message, new RegExp(secret));
      return true;
    });
    assert.equal(calls, expectedCalls, classification);
  }
});

test("response body transport 실패만 closed network 원인으로 분류한다", async () => {
  await assert.rejects(() => collectKricAccessibilitySnapshots({
    roster: roster.slice(0, 1),
    operations: [operation],
    serviceKey: "key",
    ...retryFast(),
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => { throw Object.assign(new Error("redacted"), { code: "UND_ERR_BODY_TIMEOUT" }); },
    }),
  }), {
    name: "Error",
    message: "KRIC accessibility request failed: NETWORK_TIMEOUT: kric-station-convenience-standard/S1/2/202",
  });

  await assert.rejects(() => collectKricAccessibilitySnapshots({
    roster: roster.slice(0, 1),
    operations: [operation],
    serviceKey: "key",
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => { throw new SyntaxError("malformed provider JSON"); },
    }),
  }), /KRIC accessibility schema invalid: kric-station-convenience-standard\/S1\/2\/202/);
});

test("standard observation은 snapshot과 canonical raw inventory를 absent directory에 함께 게시한다", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "easysubway-kric-observation-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const outputRoot = path.join(directory, "observation");
  const tuple = {
    ...roster[0],
    canonicalMappings: [{ artifactId: "bundled-capital", stationId: roster[0].stationId, lineId: roster[0].lineId }],
  };
  const observation = await collectKricStandardAccessibilityObservation({
    roster: [tuple],
    serviceKey: "must-not-appear",
    now: new Date("2026-08-14T00:00:00.000Z"),
    fetchImpl: async () => response(200, [{
      dtlLoc: "대합실", grndDvCd: "1", gubun: "EV", imgPath: "", mlFmlDvCd: "", stinFlor: 1, trfcWeakDvCd: "01",
    }]),
  });

  assert.equal(observation.snapshot.sourceId, "kric-station-convenience-standard");
  assert.equal(observation.rawArtifact.requestCount, 1);
  assert.equal(observation.rawArtifact.snapshotId, observation.snapshot.snapshotId);
  assert.equal(observation.rawArtifact.snapshotRawSha256, observation.snapshot.rawSha256);
  assert.equal(observation.rawArtifact.responses[0].rawResponseSha256, observation.snapshot.queries[0].rawResponseSha256);
  const mismatched = structuredClone(observation);
  const rawResponseRecord = mismatched.rawArtifact.responses[0];
  const payload = JSON.parse(Buffer.from(rawResponseRecord.bodyBase64, "base64"));
  payload.header.resultMsg = "changed but still provider-valid";
  const changedBytes = Buffer.from(JSON.stringify(payload));
  rawResponseRecord.bodyBase64 = changedBytes.toString("base64");
  rawResponseRecord.byteSize = changedBytes.length;
  rawResponseRecord.rawResponseSha256 = createHash("sha256").update(changedBytes).digest("hex");
  mismatched.rawArtifact.inventorySha256 = hashForTest(mismatched.rawArtifact.responses.map((item) => {
    const { bodyBase64: _, ...identity } = item;
    return identity;
  }));
  assert.throws(
    () => validateKricAccessibilityRawCollection(mismatched.rawArtifact, mismatched.snapshot),
    /raw collection/u,
  );
  assert.doesNotMatch(JSON.stringify(observation), /must-not-appear|serviceKey/u);

  await assert.rejects(
    collectKricStandardAccessibilityObservation({
      roster: [tuple],
      serviceKey: "reflected-secret",
      fetchImpl: async () => response(200, [{
        dtlLoc: "reflected-secret", grndDvCd: "1", gubun: "EV", imgPath: "", mlFmlDvCd: "", stinFlor: 1, trfcWeakDvCd: "01",
      }]),
    }),
    /credential reflection rejected/u,
  );

  const embeddedOutputRoot = path.join(directory, "embedded-observation");
  await assert.rejects(
    (async () => {
      const embedded = await collectKricStandardAccessibilityObservation({
        roster: [tuple],
        serviceKey: "reflected-secret",
        fetchImpl: async () => response(200, [{
          dtlLoc: "url-prefix-reflected-secret-suffix",
          grndDvCd: "1",
          gubun: "EV",
          imgPath: "",
          mlFmlDvCd: "",
          stinFlor: 1,
          trfcWeakDvCd: "01",
          "diagnostic-reflected-secret-key": "redacted",
        }]),
      });
      await writeKricStandardAccessibilityObservation({ outputRoot: embeddedOutputRoot, observation: embedded });
    })(),
    /credential reflection rejected/u,
  );
  await assert.rejects(readFile(path.join(embeddedOutputRoot, "observation.json")), { code: "ENOENT" });

  await writeKricStandardAccessibilityObservation({ outputRoot, observation });
  const manifest = JSON.parse(await readFile(path.join(outputRoot, "observation.json"), "utf8"));
  assert.equal(manifest.snapshotId, observation.snapshot.snapshotId);
  assert.equal(manifest.snapshotRawSha256, observation.snapshot.rawSha256);
  assert.equal(manifest.credentialRedacted, true);
  await assert.rejects(
    writeKricStandardAccessibilityObservation({ outputRoot, observation }),
    /output root already exists/u,
  );
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

test("HTTP 503에서 재시도 예산이 소진되면 마지막 응답의 HTTP 코드로 실패한다(#1099 리뷰 F1)", async () => {
  let calls = 0;
  await assert.rejects(collectKricAccessibilitySnapshots({
    roster: roster.slice(0, 1), operations: [operation], serviceKey: "key",
    retrySleepImpl: async () => {}, retryBudget: createTransientRetryBudget(2_500), retryRandomImpl: () => 0.5,
    fetchImpl: async () => { calls += 1; return response(503, []); },
  }), { message: "KRIC accessibility HTTP 503: kric-station-convenience-standard/S1/2/202" });
  assert.equal(calls, 2);
});

const kricRetryRow = Object.fromEntries(operation.responseFields.map((field) => [field, field === "railOprIsttCd" ? "S1" : field === "lnCd" ? "2" : field === "stinCd" ? "202" : "대합실"]));
defineSourceCollectionRetryTests({
  name: "KRIC 접근성 수집기",
  // 수집기가 fetch 결과에서 ok·status·json()만 읽으므로 같은 모양의 객체를 돌려준다. 본문 timeout 응답(ReadableStream 기반)의 json()도 같은 계약이다.
  httpError: /KRIC accessibility HTTP 403/,
  delegate: async () => response(200, [kricRetryRow]),
  run: ({ fetchImpl, sleepImpl }) => collectKricAccessibilitySnapshots({
    roster: roster.slice(0, 1), operations: [operation], serviceKey: "key", now: new Date("2026-07-20T09:00:00.000Z"),
    fetchImpl, retrySleepImpl: sleepImpl, retryBudget: createTransientRetryBudget(), retryRandomImpl: () => 0,
  }),
});

const escalatorTuple = (stationId, lineId, stinCd) => ({
  stationId, lineId, railOprIsttCd: "S1", lnCd: "1", stinCd,
  canonicalMappings: [{ artifactId: "bundled-capital", stationId, lineId }],
});
const escalatorRoster = [
  escalatorTuple("station-a", "line-1", "101"), escalatorTuple("station-b", "line-1", "102"), escalatorTuple("station-c", "line-1", "103"),
];
const escalatorProviderRow = (url, dtlLoc) => ({
  dtlLoc, exitNo: "2", grndDvNmFr: "지하", grndDvNmTo: "지상", lnCd: url.searchParams.get("lnCd"),
  railOprIsttCd: url.searchParams.get("railOprIsttCd"), runStinFlorFr: "1", runStinFlorTo: "1",
  stinCd: url.searchParams.get("stinCd"), updnDvNm: "상행",
});
const terminal03 = () => ({ ok: true, status: 200, json: async () => ({ header: { resultCode: "03" }, body: [] }) });
const escalatorFetch = (terminalStations = []) => async (url) => {
  assert.equal(url.pathname, "/openapi/convenientInfo/stationEscalator");
  const stinCd = url.searchParams.get("stinCd");
  if (terminalStations.includes(stinCd)) return terminal03();
  return response(200, stinCd === "101" ? [escalatorProviderRow(url, "1번 출구"), escalatorProviderRow(url, "환승통로")] : []);
};
const collectEscalator = (options) => collectKricStandardAccessibilityObservation({
  sourceId: "kric-station-escalator-detailed", roster: escalatorRoster, serviceKey: "key", now: new Date("2026-10-23T00:00:00.000Z"), ...options,
});

test("#3036 에스컬레이터 observation은 stationEscalator 행을 tuple 결속으로 검증하고 결과 03이 없으면 조회별 코드 없는 snapshot이다", async () => {
  const { snapshot, rawArtifact } = await collectEscalator({ fetchImpl: escalatorFetch() });

  assert.equal(snapshot.sourceId, "kric-station-escalator-detailed");
  assert.equal(snapshot.snapshotId, "kric-station-escalator-detailed-20261023T000000000Z");
  assert.deepEqual([snapshot.providerResultCode, snapshot.absenceEvidenceMode], ["00", "EXHAUSTIVE_LIST"]);
  assert.deepEqual(snapshot.queries.map(({ stinCd, status, rows }) => [stinCd, status, rows.length]), [
    ["101", "PRESENT", 2], ["102", "ABSENT_EXPLICIT_ZERO", 0], ["103", "ABSENT_EXPLICIT_ZERO", 0],
  ]);
  assert.equal(snapshot.queries.some((query) => "providerResultCode" in query), false);
  assert.deepEqual(validateKricAccessibilitySnapshotIdentity(snapshot), snapshot);
  assert.deepEqual(validateKricAccessibilityRawCollection(rawArtifact, snapshot), rawArtifact);

  await assert.rejects(collectEscalator({
    fetchImpl: async (url) => response(200, [{ ...escalatorProviderRow(url, "다른 역 행"), stinCd: "999" }]),
  }), /KRIC accessibility schema invalid: kric-station-escalator-detailed\/S1\/1\/101/);
  await assert.rejects(collectEscalator({
    fetchImpl: async (url) => {
      const { updnDvNm: _missing, ...row } = escalatorProviderRow(url, "필드 누락");
      return response(200, [row]);
    },
  }), /KRIC accessibility schema invalid/);
});

test("#3036 에스컬레이터 observation은 어느 tuple의 결과 03도 조회별 코드와 함께 혼합 snapshot으로 남긴다", async () => {
  const { snapshot, rawArtifact } = await collectEscalator({ fetchImpl: escalatorFetch(["102", "103"]) });

  assert.deepEqual([snapshot.providerResultCode, snapshot.absenceEvidenceMode], ["MIXED", "EXHAUSTIVE_LIST_WITH_UNVERIFIED_EVIDENCE_BLOCKED"]);
  assert.deepEqual(snapshot.queries.map(({ stinCd, providerResultCode, status, terminalPolicy, providerRecordHash }) => [
    stinCd, providerResultCode, status, terminalPolicy, providerRecordHash === null,
  ]), [
    ["101", "00", "PRESENT", null, false],
    ["102", "03", "UNVERIFIED_EVIDENCE_BLOCKED", "ANY_TUPLE_PROVIDER_RESULT_03", true],
    ["103", "03", "UNVERIFIED_EVIDENCE_BLOCKED", "ANY_TUPLE_PROVIDER_RESULT_03", true],
  ]);
  assert.deepEqual(validateKricAccessibilitySnapshotIdentity(snapshot), snapshot);
  assert.deepEqual(validateKricAccessibilityRawCollection(rawArtifact, snapshot), rawArtifact);
  assert.deepEqual(rawArtifact.responses.map(({ providerResultCode }) => providerResultCode), ["00", "03", "03"]);

  await assert.rejects(collectKricAccessibilitySnapshots({
    roster: escalatorRoster, operations: [KRIC_ACCESSIBILITY_OPERATIONS[1]], serviceKey: "key", fetchImpl: escalatorFetch(["102"]),
  }), /KRIC accessibility provider gaps: count=1; tuples=kric-station-escalator-detailed\/S1\/1\/102\/03/);
});

// 혼합 snapshot 식별 검증의 각 항을 하나씩 어긴 사본이다. 식별 hash는 다시 계산해 hash 검사가 아니라 그 항이 막는지 본다.
function rehashedSnapshot(snapshot) {
  const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const mixed = snapshot.providerResultCode === "MIXED";
  const rawIdentity = (query) => {
    const identity = Object.fromEntries(["stationId", "lineId", "railOprIsttCd", "lnCd", "stinCd", "rawResponseSha256"].map((field) => [field, query[field]]));
    return mixed ? { ...identity, providerResultCode: query.providerResultCode, terminalPolicy: query.terminalPolicy, providerRecordHash: query.providerRecordHash } : identity;
  };
  return {
    ...snapshot,
    queryCount: snapshot.queries.length,
    rowCount: snapshot.queries.reduce((sum, query) => sum + query.rows.length, 0),
    contentSha256: digest(snapshot.queries.map(({ rawResponseSha256: _, ...query }) => query)),
    rawSha256: digest(snapshot.queries.map(rawIdentity)),
  };
}

test("#3036 에스컬레이터 혼합 snapshot 식별 검증은 결과 03 조회의 정책·행·hash·상태와 결과 03 존재를 하나씩 강제한다", async () => {
  const { snapshot } = await collectEscalator({ fetchImpl: escalatorFetch(["102"]) });
  const tamperTerminal = (mutate) => {
    const copy = structuredClone(snapshot);
    mutate(copy.queries.find(({ stinCd }) => stinCd === "102"), copy);
    return rehashedSnapshot(copy);
  };
  assert.deepEqual(validateKricAccessibilitySnapshotIdentity(rehashedSnapshot(structuredClone(snapshot))), rehashedSnapshot(structuredClone(snapshot)));
  for (const [term, mutate] of [
    ["표준 원천의 정확 tuple 정책", (query) => { query.terminalPolicy = "EXACT_TUPLE_PROVIDER_RESULT_03"; }],
    ["정책 없음", (query) => { query.terminalPolicy = null; }],
    ["결과 03 조회의 행", (query) => { query.rows = [{ ...snapshot.queries[0].rows[0], stinCd: "102" }]; }],
    ["결과 03 조회의 provider hash", (query) => { query.providerRecordHash = "0".repeat(64); }],
    ["결과 03 조회의 상태", (query) => { query.status = "ABSENT_EXPLICIT_ZERO"; }],
    ["결과 03이 없는 혼합 snapshot", (query) => {
      Object.assign(query, { providerResultCode: "00", status: "ABSENT_EXPLICIT_ZERO", terminalPolicy: null, providerRecordHash: createHash("sha256").update("[]").digest("hex") });
    }],
    ["다른 원천 id", (_query, copy) => {
      copy.sourceId = "kric-station-convenience-standard";
      copy.snapshotId = copy.snapshotId.replaceAll("kric-station-escalator-detailed", "kric-station-convenience-standard");
    }],
  ]) {
    assert.throws(() => validateKricAccessibilitySnapshotIdentity(tamperTerminal(mutate)), /snapshot identity is invalid/, term);
  }
});

test("#3036 표준 원천은 결과 03을 정확 tuple 하나에만 허용하고 에스컬레이터 정책 표기를 받지 않는다", async () => {
  const terminal = {
    stationId: "station-b35616704ce3", lineId: "seoul-2", railOprIsttCd: "S1", lnCd: "2", stinCd: "234-4",
    canonicalMappings: [{ artifactId: "bundled-capital", stationId: "station-b35616704ce3", lineId: "seoul-2" }],
  };
  const { snapshot } = await collectKricStandardAccessibilityObservation({
    roster: [terminal, { ...escalatorRoster[0], lnCd: "2" }], serviceKey: "key",
    fetchImpl: async (url) => (url.searchParams.get("stinCd") === "234-4" ? terminal03() : response(200, [])),
  });
  assert.equal(snapshot.providerResultCode, "MIXED");
  const relabeled = structuredClone(snapshot);
  relabeled.queries.find(({ stinCd }) => stinCd === "234-4").terminalPolicy = "ANY_TUPLE_PROVIDER_RESULT_03";
  assert.throws(() => validateKricAccessibilitySnapshotIdentity(rehashedSnapshot(relabeled)), /snapshot identity is invalid/);
  await assert.rejects(collectKricStandardAccessibilityObservation({ sourceId: "kric-station-escalator", roster: [terminal], serviceKey: "key", fetchImpl: escalatorFetch() }),
    /KRIC accessibility operation is not registered: kric-station-escalator/);
});
