import assert from "node:assert/strict";
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
  gaps: [
    { railOprIsttCd: "GU", lnCd: "8", stinCd: "2805", resultCode: "03" },
    { railOprIsttCd: "KR", lnCd: "K1", stinCd: "K209", resultCode: "03" },
  ],
};

const routeRosters = {
  rosters: [{ stations: [
    { railOprIsttCd: "GU", lnCd: "8", stinCd: "2805", stinNm: "다라" },
    { railOprIsttCd: "KR", lnCd: "K1", stinCd: "K209", stinNm: "가나" },
  ] }],
};

test("official KR·GU source는 exact gap station을 immutable evidence로 결속한다", async () => {
  const sources = {
    "korail-station-facilities": [
      "역명,엘리베이터,에스컬레이터,휠체어리프트,장애인경사로",
      "가나,2,3,0,Y",
    ].join("\n"),
    "kric-capital-line8-elevators": [
      "철도운영기관명,선명,역명,출입구번호,상세위치,정원_인원,정원_중량",
      "구리도시공사,8호선,다라,1,대합실,15,1000",
    ].join("\n"),
    "kric-capital-line1-elevators": [
      "철도운영기관명,선명,역명,출입구번호,상세위치,정원_인원,정원_중량",
      "한국철도공사,1호선,가나,1,대합실,15,1000",
    ].join("\n"),
  };
  for (const [sourceId, csv] of Object.entries(sources)) {
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
    assert.equal(snapshot.rowCount, 1);
    assert.equal(snapshot.matchedGaps.length, 1);
    assert.deepEqual(snapshot.unmatchedGaps, []);
    assert.equal(snapshot.matchedGaps[0].providerRecords.length, 1);
    assert.match(snapshot.rawSha256, /^[0-9a-f]{64}$/);
    assert.match(snapshot.contentSha256, /^[0-9a-f]{64}$/);
    assert.match(snapshot.matchedGaps[0].providerRecordHash, /^[0-9a-f]{64}$/);
    assert.match(formatGapClassification(snapshot), new RegExp(`matched=.*${snapshot.matchedGaps[0].stationName}`));
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

test("미해결 GX·S1 evidence는 production admission을 fail closed한다", async () => {
  const evidence = JSON.parse(await readFile(new URL("./sources/facility-gap-resolution-evidence-20260731.json", import.meta.url)));
  assert.equal(evidence.admissionState, "BLOCKED");
  assert.equal(evidence.productionAdmissionAllowed, false);
  assert.deepEqual(evidence.blockedGroups.map(({ operatorCode }) => operatorCode), ["GX", "S1"]);
});
