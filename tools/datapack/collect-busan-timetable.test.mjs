import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { collectBusanTimetable } from "./collect-busan-timetable.mjs";

const topology = JSON.parse(await readFile(
  new URL("./sources/busan-transportation-route-topology-20260720.json", import.meta.url),
  "utf8",
));

function response({ stationName, stationCode, line, items }) {
  const body = items.map((item) => `<item>${item}</item>`).join("");
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><response>
    <header><resultCode>00</resultCode><resultMsg>정상</resultMsg></header>
    <body><scode>${stationCode}</scode><line>${line}</line><sname>${stationName}</sname>
    <engname>Station ${stationCode}</engname>${body}</body>
    <numOfRows>${items.length}</numOfRows><pageNo>1</pageNo><totalCount>${items.length}</totalCount></response>`, {
    headers: { "content-type": "application/xml" },
  });
}

test("부산 timetable collector는 114개 역과 3개 요일을 bounded fan-out한다", async () => {
  const requested = [];
  const secret = "never-print-service-key";
  const snapshot = await collectBusanTimetable({
    serviceKey: secret,
    stationScopes: topology.scope,
    now: new Date("2026-07-20T09:00:00.000Z"),
    fetchImpl: async (url) => {
      const request = new URL(url);
      requested.push(request);
      const station = topology.scope.find(({ stationCode }) => stationCode === request.searchParams.get("scode"));
      const line = ({
        "line-ab1a041f6266": "1",
        "line-eb7b47920390": "2",
        "line-d74614a04530": "3",
        "line-d812a5bc1e5f": "4",
      })[station.lineId];
      const day = request.searchParams.get("day");
      const stationName = station.stationCode === "205" ? "벡스코 공식별칭" : station.stationName;
      return response({ stationName, stationCode: station.stationCode, line, items: ["0", "1"].map((updown) => [
        `<trainno>${line}${day}0${updown}</trainno>`,
        "<hour>05</hour><time>01</time>",
        `<day>${day}</day><updown>${updown}</updown>`,
        `<endcode>${station.stationCode}</endcode>`,
      ].join("")) });
    },
  });

  assert.equal(requested.length, 342);
  assert.equal(snapshot.requestCount, 342);
  assert.equal(snapshot.stationCount, 114);
  assert.equal(snapshot.rowCount, 684);
  assert.deepEqual(snapshot.dayTypes, ["1", "2", "3"]);
  assert.deepEqual(snapshot.lineIds, topology.lineIds);
  assert.deepEqual([...requested[0].searchParams], [
    ["serviceKey", secret], ["act", "xml"], ["scode", topology.scope[0].stationCode], ["day", "1"],
    ["pageNo", "1"], ["numOfRows", "999"],
  ]);
  assert.equal(snapshot.credentialRedacted, true);
  assert.match(snapshot.rowsSha256, /^[a-f0-9]{64}$/);
  assert.match(snapshot.rawSha256, /^[a-f0-9]{64}$/);
  assert.equal(snapshot.rows.find(({ scode }) => scode === "205").sname, "벡스코 공식별칭");
  assert.doesNotMatch(JSON.stringify(snapshot), new RegExp(secret));
});

test("부산 timetable collector는 역·요일별 양방향 누락을 fail closed한다", async () => {
  await assert.rejects(collectBusanTimetable({
    serviceKey: "key",
    stationScopes: topology.scope,
    fetchImpl: async (url) => {
      const request = new URL(url);
      const station = topology.scope.find(({ stationCode }) => stationCode === request.searchParams.get("scode"));
      const line = ({
        "line-ab1a041f6266": "1", "line-eb7b47920390": "2",
        "line-d74614a04530": "3", "line-d812a5bc1e5f": "4",
      })[station.lineId];
      const day = request.searchParams.get("day");
      const directions = station.stationCode === topology.scope[0].stationCode && day === "1" ? ["0"] : ["0", "1"];
      return response({
        stationName: station.stationName,
        stationCode: station.stationCode,
        line,
        items: directions.map((updown) => [
          `<trainno>${line}${day}0${updown}</trainno><hour>05</hour><time>01</time>`,
          `<day>${day}</day><updown>${updown}</updown><endcode>${station.stationCode}</endcode>`,
        ].join("")),
      });
    },
  }), /station\/day\/direction scope incomplete/);
});

test("부산 timetable collector는 credential 없는 transport code만 진단한다", async () => {
  const transport = Object.assign(new Error("secret-bearing transport detail"), { code: "ENOTFOUND" });
  await assert.rejects(collectBusanTimetable({
    serviceKey: "never-print-service-key",
    stationScopes: topology.scope,
    sleepImpl: async () => {},
    fetchImpl: async () => { throw transport; },
  }), (error) => {
    assert.match(error.message, /transport failure; code=ENOTFOUND/);
    assert.doesNotMatch(error.message, /never-print|secret-bearing/);
    return true;
  });
});

test("부산 timetable collector는 pagination mismatch count만 진단한다", async () => {
  await assert.rejects(collectBusanTimetable({
    serviceKey: "key",
    stationScopes: topology.scope,
    fetchImpl: async () => new Response(`<?xml version="1.0"?><response>
      <header><resultCode>00</resultCode></header><body><item>
      <sname>역</sname><engname>Station</engname><trainno>101</trainno><hour>05</hour><time>01</time>
      <day>1</day><updown>0</updown><endcode>100</endcode><scode>100</scode><line>1</line>
      </item></body><totalCount>2</totalCount></response>`, {
      headers: { "content-type": "application/xml" },
    }),
  }), /truncated items; items=1; totalCount=2; rawSha256=[a-f0-9]{64}/);
});

test("부산 timetable collector는 값 대신 실패 field만 진단한다", async () => {
  await assert.rejects(collectBusanTimetable({
    serviceKey: "key",
    stationScopes: topology.scope,
    fetchImpl: async (url) => {
      const request = new URL(url);
      const station = topology.scope.find(({ stationCode }) => stationCode === request.searchParams.get("scode"));
      const line = ({
        "line-ab1a041f6266": "1", "line-eb7b47920390": "2",
        "line-d74614a04530": "3", "line-d812a5bc1e5f": "4",
      })[station.lineId];
      const day = request.searchParams.get("day");
      return response({ stationName: station.stationName, stationCode: station.stationCode, line, items: [[
        "<trainno>INVALID</trainno><hour>05</hour><time>01</time>",
        `<day>${day}</day><updown>0</updown><endcode>${station.stationCode}</endcode>`,
      ].join("")] });
    },
  }), /item\[0\] values=trainno/);
});
