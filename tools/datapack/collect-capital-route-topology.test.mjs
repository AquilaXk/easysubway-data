import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCapitalTopologyReverificationEvidence,
  collectMolitFullRouteCsv,
  compareCapitalRouteTopologies,
  parseSeohaeMerged,
} from "./collect-capital-route-topology.mjs";

test("MOLIT 전체노선 collector는 공개 FILE 링크의 CSV만 수집한다", async () => {
  const requests = [];
  const body = "권역,권역명,철도운영기관명,노선명,순번,역명\n01,수도권,운영사,신림선,1,샛강\n";
  const csv = await collectMolitFullRouteCsv({
    fetchImpl: async (url, init) => {
      const request = new URL(url);
      requests.push(request);
      if (requests.length === 1) {
        assert.equal(init.headers["User-Agent"], "easysubway-datapack-collector/1.0");
        return new Response('<a href="/cmm/cmm/fileDownload.do?atchFileId=FILE_123&amp;fileDetailSn=1&amp;insertDataPrcus=N">다운로드</a>');
      }
      assert.equal(init.headers.Referer, "https://www.data.go.kr/data/15122916/fileData.do");
      return new Response(body);
    },
  });

  assert.equal(requests.length, 2);
  assert.equal(requests[1].pathname, "/cmm/cmm/fileDownload.do");
  assert.deepEqual([...requests[1].searchParams], [
    ["atchFileId", "FILE_123"], ["fileDetailSn", "1"], ["insertDataPrcus", "N"],
  ]);
  assert.equal(csv.toString("utf8"), body);
});

test("서해선 병합기는 코레일 전체 파일에서 서해선 행만 사용한다", () => {
  const korail = Buffer.from([
    "철도운영기관명,선명,역명,역간거리(km)",
    "코레일,경춘선,상봉,1.7",
    "코레일,경춘선,망우,2.1",
    "코레일,서해선,일산,1.0",
    "코레일,서해선,부천종합운동장,1.0",
  ].join("\n"));
  const molit = Buffer.from([
    "권역,권역명,철도운영기관명,노선명,순번,역명",
    "01,수도권,서해철도,서해선,10,소사",
    "01,수도권,서해철도,서해선,11,원시",
  ].join("\n"));

  const parsed = parseSeohaeMerged(korail, molit, {
    slug: "seohae",
    molitRouteName: "서해선",
    molitMinSequence: 10,
  });

  assert.deepEqual(parsed.branchNames, ["서해선"]);
  assert.equal(parsed.rows.every(({ branchName, routeName }) => (branchName ?? routeName) === "서해선"), true);
});

test("capital topology 비교는 노선별 edge 변경만 보고한다", () => {
  const edge = { fromStationName: "가", toStationName: "나", distanceMeters: 100 };
  const comparison = compareCapitalRouteTopologies(
    { contentSha256: "before", lines: [{ lineId: "line-1", contentSha256: "a", edges: [edge] }] },
    { contentSha256: "after", lines: [{ lineId: "line-1", contentSha256: "b", edges: [{ ...edge, distanceMeters: 200 }] }] },
  );
  assert.deepEqual(comparison.changes, [{
    lineId: "line-1",
    added: [],
    removed: [],
    modified: [{ before: edge, after: { ...edge, distanceMeters: 200 } }],
  }]);
  assert.notEqual(comparison.baselineNormalizedLineSetSha256, comparison.candidateNormalizedLineSetSha256);
  assert.throws(() => buildCapitalTopologyReverificationEvidence(
    { contentSha256: "before", lines: [{ lineId: "line-1", contentSha256: "a", edges: [edge] }] },
    { contentSha256: "after", lines: [{ lineId: "line-1", contentSha256: "b", edges: [{ ...edge, distanceMeters: 200 }] }] },
  ), /re-admission required/);
});
