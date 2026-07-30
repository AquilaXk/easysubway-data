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

test("CSV decoder는 UTF-8과 EUC-KR을 구분한다", () => {
  assert.deepEqual(decodeCsv(new TextEncoder().encode("station")), { text: "station", encoding: "utf-8" });
  assert.deepEqual(decodeCsv(Uint8Array.from([0xbf, 0xaa, 0xb8, 0xed])), { text: "역명", encoding: "euc-kr" });
});

test("미해결 provider evidence는 production admission을 fail closed하고 S1은 canonical station으로 결속한다", async () => {
  const evidence = JSON.parse(await readFile(new URL("./sources/facility-gap-resolution-evidence-20260731.json", import.meta.url)));
  const routeMap = JSON.parse(await readFile(new URL("./sources/seoul-metro-route-map-positions-20260724.json", import.meta.url)));
  assert.equal(evidence.admissionState, "BLOCKED");
  assert.equal(evidence.productionAdmissionAllowed, false);
  assert.deepEqual(evidence.blockedGroups.map(({ operatorCode }) => operatorCode), ["GU", "GX", "KR"]);

  const s1 = evidence.resolvedGroups.find(({ operatorCode }) => operatorCode === "S1");
  assert.equal(s1.state, "OFFICIAL_SOURCE_CANONICAL_STATION_MATCHED");
  assert.deepEqual(s1.providerTuples, ["S1/2/234-4"]);
  assert.deepEqual(
    routeMap.positions
      .filter(({ stationId }) => stationId === s1.canonicalStationId)
      .map(({ lineId, stationCode, stationName }) => ({ lineId, stationCode, stationName })),
    s1.canonicalMemberships,
  );
  assert.equal(s1.officialSourceObservation.rowCount, 865);
  assert.equal(
    createHash("sha256").update(JSON.stringify(s1.officialSourceRecord)).digest("hex"),
    s1.officialSourceRecordHash,
  );
  assert.deepEqual(
    { lineName: s1.officialSourceRecord.lineName, providerStationCode: s1.officialSourceRecord.providerStationCode },
    { lineName: "5호선", providerStationCode: "2519" },
  );
  assert.equal(s1.officialSourceRecord.facilities.length, 4);
});
