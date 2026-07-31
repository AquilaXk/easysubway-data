import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  collectFacilityGapSourceEvidence,
  decodeCsv,
  formatGapClassification,
  resolveOfficialDownloadUrl,
} from "./collect-facility-gap-source-evidence.mjs";

const gaps = {
  schemaVersion: 1,
  artifactKind: "kric-accessibility-provider-gap-evidence",
  sourceId: "kric-station-convenience-standard",
  observedAt: "2026-07-29T20:16:45.595Z",
  workflowRunUrl: "https://github.com/AquilaXk/easysubway/actions/runs/30487251281",
  resultCodeInterpretation: "UNDEFINED_NOT_ABSENCE",
  gaps: [
    { railOprIsttCd: "GU", lnCd: "8", stinCd: "2805", resultCode: "03" },
    { railOprIsttCd: "KR", lnCd: "1", stinCd: "116", resultCode: "03" },
  ],
};

const routeRosters = {
  rosters: [{ stations: [
    { railOprIsttCd: "GU", lnCd: "8", stinCd: "2805", stinNm: "다라" },
    { railOprIsttCd: "KR", lnCd: "1", stinCd: "116", stinNm: "가나" },
  ] }],
};

test("official source는 operator·line·station이 모두 같은 gap만 결속한다", async () => {
  const sources = {
    "korail-station-facilities": { matchedCount: 0, unmatchedCount: 0, outOfScopeCount: 1, csv: [
      "역명,엘리베이터,에스컬레이터,휠체어리프트,장애인경사로",
      "가나,2,3,0,Y",
    ].join("\n") },
    "kric-capital-line8-elevators": { matchedCount: 1, unmatchedCount: 0, outOfScopeCount: 0, csv: [
      "철도운영기관명,선명,역명,출입구번호,상세위치,정원_인원,정원_중량",
      "구리도시공사,8호선,다라,1,대합실,15,1000",
      "남양주도시공사,8호선,다라,2,환승통로,15,1000",
      "구리도시공사,8호선,다라(별칭)역,3,승강장,15,1000",
    ].join("\n") },
    "kric-capital-line1-elevators": { matchedCount: 1, unmatchedCount: 0, outOfScopeCount: 0, csv: [
      "철도운영기관명,선명,역명,출입구번호,상세위치,정원_인원,정원_중량",
      "코레일,1호선,가나,1,대합실,15,1000",
      "서울교통공사,1호선,가나,2,환승통로,15,1000",
      "코레일,1호선,가나(별칭)역,3,승강장,15,1000",
    ].join("\n") },
  };
  for (const [sourceId, { matchedCount, unmatchedCount, outOfScopeCount, csv }] of Object.entries(sources)) {
    const snapshot = await collectFacilityGapSourceEvidence({
      sourceId,
      gapEvidence: gaps,
      routeRosters,
      now: new Date("2026-07-31T00:00:00.000Z"),
      fetchImpl: async (url) => url.pathname.endsWith("fileData.do")
        ? new Response(`<script type="application/ld+json">{"contentUrl":"https://www.data.go.kr/cmm/cmm/fileDownload.do?atchFileId=FILE_TEST&fileDetailSn=1&insertDataPrcus=N"}</script><dt>이용허락범위</dt><dd>이용허락범위 제한 없음</dd>`)
        : new Response(csv, { headers: { "content-type": "text/csv" } }),
    });

    assert.equal(snapshot.sourceId, sourceId);
    assert.equal(snapshot.capturedAt, "2026-07-31T00:00:00.000Z");
    assert.equal(snapshot.absenceEvidenceMode, "EXHAUSTIVE_LIST");
    assert.equal(snapshot.matchedGaps.length, matchedCount);
    assert.equal(snapshot.unmatchedGaps.length, unmatchedCount);
    assert.equal(snapshot.outOfScopeGaps.length, outOfScopeCount);
    assert.match(snapshot.rawSha256, /^[0-9a-f]{64}$/);
    assert.match(snapshot.contentSha256, /^[0-9a-f]{64}$/);
    if (matchedCount === 1) {
      assert.equal(snapshot.matchedGaps[0].providerRecords.length, 1);
      assert.match(snapshot.matchedGaps[0].providerRecordHash, /^[0-9a-f]{64}$/);
      assert.match(formatGapClassification(snapshot), new RegExp(`matched=.*${snapshot.matchedGaps[0].stationName}`));
    }
  }
});

test("official source URL·schema·exact join drift는 snapshot 전에 거부한다", async () => {
  assert.throws(
    () => resolveOfficialDownloadUrl('{"contentUrl":"https://example.com/file.csv"}'),
    /official data\.go\.kr download URL is invalid/,
  );
  await assert.rejects(() => collectFacilityGapSourceEvidence({
    sourceId: "korail-station-facilities",
    gapEvidence: gaps,
    routeRosters,
    fetchImpl: async () => new Response('{"contentUrl":"https://www.data.go.kr/cmm/cmm/fileDownload.do?atchFileId=FILE_TEST&fileDetailSn=1"}'),
  }), /official source license is invalid/);
  await assert.rejects(() => collectFacilityGapSourceEvidence({
    sourceId: "korail-station-facilities",
    gapEvidence: gaps,
    routeRosters,
    fetchImpl: async (url) => url.pathname.endsWith("fileData.do")
      ? new Response('{"contentUrl":"https://www.data.go.kr/cmm/cmm/fileDownload.do?atchFileId=FILE_TEST&fileDetailSn=1&insertDataPrcus=N"} 이용허락범위 제한 없음')
      : new Response("역명,엘리베이터\n다른역,1"),
  }), /official source columns are invalid/);
});

test("official source transport failure는 allowlisted code만 노출한다", async () => {
  const failure = Object.assign(new Error("never-print-provider-detail"), { code: "ENOTFOUND" });
  await assert.rejects(collectFacilityGapSourceEvidence({
    sourceId: "kric-capital-line1-elevators",
    gapEvidence: gaps,
    routeRosters,
    fetchImpl: async () => { throw failure; },
  }), (error) => {
    assert.match(error.message, /detail page request failed; code=ENOTFOUND/);
    assert.doesNotMatch(error.message, /never-print-provider-detail/);
    assert.equal(error.cause, undefined);
    return true;
  });
  await assert.rejects(collectFacilityGapSourceEvidence({
    sourceId: "kric-capital-line1-elevators",
    gapEvidence: gaps,
    routeRosters,
    fetchImpl: async () => { throw Object.assign(new Error("hidden"), { code: "ESECRET_TOKEN" }); },
  }), /detail page request failed; code=UNKNOWN/);
  const bodyFailure = Object.assign(new Error("never-print-provider-body"), { code: "ECONNRESET" });
  await assert.rejects(collectFacilityGapSourceEvidence({
    sourceId: "kric-capital-line1-elevators",
    gapEvidence: gaps,
    routeRosters,
    fetchImpl: async () => ({ ok: true, arrayBuffer: async () => { throw bodyFailure; } }),
  }), (error) => {
    assert.match(error.message, /detail page request failed; code=ECONNRESET/);
    assert.doesNotMatch(error.message, /never-print-provider-body/);
    assert.equal(error.cause, undefined);
    return true;
  });
  await assert.rejects(collectFacilityGapSourceEvidence({
    sourceId: "kric-capital-line1-elevators",
    gapEvidence: gaps,
    routeRosters,
    fetchImpl: async () => { throw new DOMException("timed out", "TimeoutError"); },
  }), /detail page request failed; code=ETIMEDOUT/);
});

test("CSV decoder는 UTF-8과 EUC-KR을 구분한다", () => {
  assert.deepEqual(decodeCsv(new TextEncoder().encode("station")), { text: "station", encoding: "utf-8" });
  assert.deepEqual(decodeCsv(Uint8Array.from([0xbf, 0xaa, 0xb8, 0xed])), { text: "역명", encoding: "euc-kr" });
});

test("미해결 provider evidence는 production admission을 fail closed하고 S1은 canonical station으로 결속한다", async () => {
  const evidence = JSON.parse(await readFile(new URL("./sources/facility-gap-resolution-evidence-20260731.json", import.meta.url)));
  const routeMap = JSON.parse(await readFile(new URL("./sources/seoul-metro-route-map-positions-20260724.json", import.meta.url)));
  const kricSnapshot = JSON.parse(await readFile(new URL("./sources/kric-nationwide-route-rosters-20260730T203926676Z.json", import.meta.url)));
  const guriSnapshot = JSON.parse(await readFile(new URL("./sources/guri-city-station-facility-evidence-20260731.json", import.meta.url)));
  const seoulSnapshot = JSON.parse(await readFile(new URL("./sources/seoul-metro-facility-location-20260730T214010816Z.json", import.meta.url)));
  assert.equal(evidence.admissionState, "BLOCKED");
  assert.equal(evidence.productionAdmissionAllowed, false);
  assert.deepEqual(evidence.blockedGroups.map(({ operatorCode }) => operatorCode), ["GX", "KR"]);

  const gu = evidence.resolvedGroups.find(({ operatorCode }) => operatorCode === "GU");
  assert.equal(gu.state, "OFFICIAL_SOURCE_EXACT_TUPLE_MATCHED");
  assert.deepEqual(gu.providerTuples, ["GU/8/2805", "GU/8/2807", "GU/8/2808"]);
  const guRosters = kricSnapshot.rosters.filter(({ mreaWideCd, lnCd }) => mreaWideCd === "01" && lnCd === "8");
  assert.equal(guRosters.length, 1);
  const [guRoster] = guRosters;
  assert.equal(kricSnapshot.artifactKind, "kric-nationwide-route-rosters");
  assert.equal(guRoster.resultCode, "00");
  assert.equal(guRoster.stationCount, guRoster.stations.length);
  assert.deepEqual(
    [kricSnapshot.sourceId, kricSnapshot.capturedAt, guRoster.rawSha256, guRoster.schemaFingerprint],
    [gu.kricRouteRosterObservation.sourceId, gu.kricRouteRosterObservation.capturedAt,
      gu.kricRouteRosterObservation.rawSha256, gu.kricRouteRosterObservation.schemaFingerprint],
  );
  assert.deepEqual(
    [guriSnapshot.sourceId, guriSnapshot.capturedAt, guriSnapshot.rowCount,
      guriSnapshot.contentSha256, guriSnapshot.schemaFingerprint],
    [gu.officialSourceObservation.sourceId, gu.officialSourceObservation.capturedAt,
      gu.officialSourceObservation.rowCount, gu.officialSourceObservation.contentSha256,
      gu.officialSourceObservation.schemaFingerprint],
  );
  assert.equal(guriSnapshot.rowCount, guriSnapshot.records.length);
  assert.deepEqual(
    guriSnapshot.records.map(({ providerTuple, stationName, elevatorCount }) => (
      { providerTuple, stationName, elevatorCount }
    )),
    [
      { providerTuple: "GU/8/2805", stationName: "구리", elevatorCount: 6 },
      { providerTuple: "GU/8/2807", stationName: "동구릉", elevatorCount: 4 },
      { providerTuple: "GU/8/2808", stationName: "장자호수공원", elevatorCount: 4 },
    ],
  );
  assert.equal(
    guriSnapshot.contentSha256,
    createHash("sha256").update(JSON.stringify(guriSnapshot.records)).digest("hex"),
  );
  assert.equal(
    guriSnapshot.schemaFingerprint,
    createHash("sha256").update(JSON.stringify([
      "providerTuple", "stationName", "operatorName", "elevatorCount", "escalatorCount",
      "officialUrl", "rawSha256", "providerRecordHash",
    ])).digest("hex"),
  );
  for (const record of guriSnapshot.records) {
    const providerRecords = guRoster.stations.filter(({ railOprIsttCd, lnCd, stinCd, stinNm }) => (
      `${railOprIsttCd}/${lnCd}/${stinCd}` === record.providerTuple && stinNm === record.stationName
    ));
    assert.equal(providerRecords.length, 1);
    const [providerRecord] = providerRecords;
    assert.equal(createHash("sha256").update(JSON.stringify(providerRecord)).digest("hex"), record.providerRecordHash);
    assert.equal(record.operatorName, "구리도시공사 교통사업부");
  }

  const s1 = evidence.resolvedGroups.find(({ operatorCode }) => operatorCode === "S1");
  assert.equal(s1.state, "OFFICIAL_SOURCE_CANONICAL_STATION_MATCHED");
  assert.deepEqual(s1.providerTuples, ["S1/2/234-4"]);
  assert.equal(s1.canonicalStationId, "station-b35616704ce3");
  assert.deepEqual(s1.canonicalSourceObservation, {
    sourceId: "seoul-metro-route-map-positions",
    sourceSnapshot: "seoul-metro-route-map-positions-20260724.json",
    capturedAt: "2026-07-24T02:00:00.000Z",
    rawSha256: "713d6a7353748f1f29b974cd70df9b7a24b3600b6aeb60a58ed7bfa6975e02ed",
    scopeSha256: "9d119cf23421206116e3f4c491a4ef760a9bf694f2a43a63926b0e70f3fd25fd",
    positionsSha256: "fb04a674e9e1ccf7491e1a20ac87cb79604edbbe31517d712fc290f919ee6398",
  });
  const kric = s1.kricRouteRosterObservation;
  assert.equal(kricSnapshot.credentialRedacted, true);
  assert.deepEqual(
    [kricSnapshot.sourceId, kricSnapshot.capturedAt, kricSnapshot.providerScopeCount, kricSnapshot.requestCount],
    [kric.sourceId, kric.capturedAt, kric.providerScopeCount, kric.requestCount],
  );
  assert.deepEqual(kricSnapshot.providerScopes.filter(({ lineId }) => lineId === "seoul-2"), [kric.providerScope]);
  assert.deepEqual(
    [kric.capturedAt, kric.requestRawSha256, kric.requestSchemaFingerprint, kric.providerRecordHash],
    [
      "2026-07-30T20:39:26.676Z",
      "f0a15898cd3a148a48b1338347a3287cd3c2016119a4d3ac64c35dc4d7e38367",
      "d516b09e782a9afd73eb0f921b48abdf2bac3aa2247e1b0ad9f0a4a7c371f764",
      "3673252431c48350fc774795287c496f32f83aba1113df0bbe742ebc70096974",
    ],
  );
  const roster = kricSnapshot.rosters.find(({ mreaWideCd, lnCd }) => mreaWideCd === "01" && lnCd === "2");
  assert.deepEqual([roster.rawSha256, roster.schemaFingerprint], [kric.requestRawSha256, kric.requestSchemaFingerprint]);
  const kricRecords = roster.stations.filter(({ railOprIsttCd, lnCd, stinCd }) =>
    `${railOprIsttCd}/${lnCd}/${stinCd}` === s1.providerTuples[0]);
  assert.equal(kricRecords.length, 1);
  const [kricRecord] = kricRecords;
  assert.equal(kric.providerScope.lineId, "seoul-2");
  assert.equal(
    createHash("sha256").update(JSON.stringify(kricRecord)).digest("hex"),
    kric.providerRecordHash,
  );
  assert.deepEqual(
    routeMap.positions
      .filter(({ lineId, stationName }) => lineId === kric.providerScope.lineId && stationName === kricRecord.stinNm)
      .map(({ stationId }) => stationId),
    [s1.canonicalStationId],
  );
  assert.deepEqual(
    routeMap.positions
      .filter(({ stationId }) => stationId === s1.canonicalStationId)
      .map(({ lineId, stationCode, stationName }) => ({ lineId, stationCode, stationName })),
    s1.canonicalMemberships,
  );
  const observation = s1.officialSourceObservation;
  assert.equal(seoulSnapshot.credentialRedacted, true);
  assert.deepEqual(
    [seoulSnapshot.sourceId, seoulSnapshot.snapshotId, seoulSnapshot.capturedAt, seoulSnapshot.rowCount,
      seoulSnapshot.rawSha256, seoulSnapshot.contentSha256, seoulSnapshot.schemaFingerprint],
    [observation.sourceId, observation.sourceSnapshot.replace(".json", ""), observation.capturedAt, observation.rowCount,
      observation.rawSha256, observation.contentSha256, observation.schemaFingerprint],
  );
  const seoulRecords = seoulSnapshot.stations.filter(({ stationName, lineName, providerStationCode }) =>
    stationName === kricRecord.stinNm && lineName === "5호선" && providerStationCode === "2519");
  assert.equal(seoulRecords.length, 1);
  const [seoulRecord] = seoulRecords;
  assert.equal(
    createHash("sha256").update(JSON.stringify(seoulRecord)).digest("hex"),
    s1.officialSourceRecordHash,
  );
  assert.equal(s1.officialSourceRecordHash, "022b531ce285bbf03ba6699236753d1874fd2d453d6a988e4a66e54d9978a375");
  assert.deepEqual(
    { lineName: seoulRecord.lineName, providerStationCode: seoulRecord.providerStationCode },
    { lineName: "5호선", providerStationCode: "2519" },
  );
  assert.equal(seoulRecord.facilities.length, 4);
});
