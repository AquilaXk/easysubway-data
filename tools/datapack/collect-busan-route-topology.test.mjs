import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  admitBusanRouteTopology,
  collectBusanRouteTopology,
  extractBusanTransferRows,
  parseBusanRouteTopologyScope,
  validateBusanRouteTopologySnapshot,
} from "./collect-busan-route-topology.mjs";
import { createTransientRetryBudget } from "./lib/transient-retry.mjs";

// #1099: 일시 오류는 같은 요청을 1·2·4·8·16초 대기로 최대 5번 다시 보낸다. 재시도 대기와 예산은 테스트마다 격리한다.
const retryFast = (delays = []) => ({ sleepImpl: async (delay) => { delays.push(delay); }, retryBudget: createTransientRetryBudget() });

const XML_ITEMS = `
  <item><startSn>신평</startSn><startSc>101</startSc><endSn>하단</endSn><endSc>102</endSc><dist>16</dist><time>140</time><stoppingTime>0</stoppingTime><exchange></exchange></item>
  <item><startSn>장산</startSn><startSc>201</startSc><endSn>중동</endSn><endSc>202</endSc><dist>9</dist><time>90</time><stoppingTime>20</stoppingTime><exchange>N</exchange></item>
  <item><startSn>수영</startSn><startSc>301</startSc><endSn>망미</endSn><endSc>302</endSc><dist>7</dist><time>80</time><stoppingTime>20</stoppingTime><exchange>N</exchange></item>
  <item><startSn>미남</startSn><startSc>401</startSc><endSn>동래</endSn><endSc>402</endSc><dist>8</dist><time>85</time><stoppingTime>20</stoppingTime><exchange></exchange></item>`;
const XML = successXml(XML_ITEMS);

test("부산 topology collector는 malformed credential로 provider를 호출하지 않는다", async () => {
  let calls = 0;
  await assert.rejects(collect({ serviceKey: "invalid%ZZ", stationCode: "101", fetchImpl: async () => { calls += 1; } }), /DATA_GO_KR_SERVICE_KEY is invalid/);
  assert.equal(calls, 0);
});

const SCOPE_HTML = `
<div class="s101 s-1"><a onclick="one_point('101', '1', '신평', event )"></a></div>
<div class="l101-102 l102-101 w-1"></div>
<div class="s102 s-1"><a onclick="one_point('102', '1', '하단역', event )"></a></div>
<div class="s201 s-2"><a onclick="one_point('201', '2', '장산', event )"></a></div>
<div class="l201-202 l202-201 w-2"></div>
<div class="s202 s-2"><a onclick="one_point('202', '2', '중동', event )"></a></div>
<div class="s301 s-3"><a onclick="one_point('301', '3', '수영', event )"></a></div>
<div class="l301-302 l302-301 w-3"></div>
<div class="s302 s-3"><a onclick="one_point('302', '3', '망미', event )"></a></div>
<div class="s401 s-4"><a onclick="one_point('401', '4', '미남', event )"></a></div>
<div class="l401-402 l402-401 w-4"></div>
<div class="s402 s-4"><a onclick="one_point('402', '4', '동래', event )"></a></div>`;

function response(body = XML, { status = 200, contentType = "application/xml", headers = {} } = {}) {
  return new Response(body, { status, headers: { "content-type": contentType, ...headers } });
}

function successXml(items) {
  const count = [...items.matchAll(/<item\b/g)].length;
  return `<?xml version="1.0" encoding="UTF-8"?><response><header><resultCode>00</resultCode><resultMsg>정상</resultMsg></header><body>${items}</body><numOfRows>${Math.max(1, count)}</numOfRows><pageNo>1</pageNo><totalCount>${Math.max(1, count)}</totalCount></response>`;
}

function contentHash(edges, scope) {
  return createHash("sha256").update(JSON.stringify({ scope, edges })).digest("hex");
}

function collect(options = {}) {
  return collectBusanRouteTopology({ serviceKey: "key", ...options });
}

test("부산 topology collector는 공식 XML operation을 4개 노선 edge로 정규화한다", async () => {
  let requestUrl;
  const secret = "never-print-service-key";
  const snapshot = await collect({
    serviceKey: secret,
    now: new Date("2026-07-20T00:00:00.000Z"),
    fetchImpl: async (url, init) => {
      requestUrl = new URL(url);
      assert.equal(init.redirect, "error");
      assert.equal(init.headers.accept, "application/xml,text/xml");
      return response();
    },
  });

  assert.equal(requestUrl.origin, "http://data.humetro.busan.kr");
  assert.equal(requestUrl.pathname, "/voc/api/open_api_distance.tnn");
  assert.deepEqual([...requestUrl.searchParams], [["serviceKey", secret], ["act", "xml"]]);
  assert.equal(snapshot.sourceId, "busan-transportation-route-topology");
  assert.equal(snapshot.capturedAt, "2026-07-20T00:00:00.000Z");
  assert.equal(snapshot.rowCount, 4);
  assert.deepEqual(snapshot.responseEncodings, ["utf-8"]);
  assert.equal(snapshot.edgeCount, 4);
  assert.deepEqual(snapshot.lineIds, [
    "line-ab1a041f6266",
    "line-d74614a04530",
    "line-d812a5bc1e5f",
    "line-eb7b47920390",
  ]);
  assert.deepEqual(snapshot.edges, [
    {
      edgeId: "busan:1:101:102", lineId: "line-ab1a041f6266", fromStationCode: "101",
      fromStationName: "신평", toStationCode: "102", toStationName: "하단",
      distanceMeters: 1600, durationSeconds: 140, stoppingSeconds: 0, exchange: null,
    },
    {
      edgeId: "busan:2:201:202", lineId: "line-eb7b47920390", fromStationCode: "201",
      fromStationName: "장산", toStationCode: "202", toStationName: "중동",
      distanceMeters: 900, durationSeconds: 90, stoppingSeconds: 20, exchange: "N",
    },
    {
      edgeId: "busan:3:301:302", lineId: "line-d74614a04530", fromStationCode: "301",
      fromStationName: "수영", toStationCode: "302", toStationName: "망미",
      distanceMeters: 700, durationSeconds: 80, stoppingSeconds: 20, exchange: "N",
    },
    {
      edgeId: "busan:4:401:402", lineId: "line-d812a5bc1e5f", fromStationCode: "401",
      fromStationName: "미남", toStationCode: "402", toStationName: "동래",
      distanceMeters: 800, durationSeconds: 85, stoppingSeconds: 20, exchange: null,
    },
  ]);
  assert.equal(snapshot.license.type, "KOGL-1");
  assert.equal(snapshot.license.redistributionAllowed, true);
  const originalBytes = Buffer.from(XML);
  assert.deepEqual(snapshot.rawResponses, [{
    stationCode: null,
    bytesBase64: originalBytes.toString("base64"),
  }]);
  assert.equal(snapshot.rawSha256, createHash("sha256").update(JSON.stringify([{
    stationCode: null,
    rawSha256: createHash("sha256").update(originalBytes).digest("hex"),
  }])).digest("hex"));
  assert.equal(snapshot.scope, null);
  assert.match(snapshot.contentSha256, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(snapshot), new RegExp(secret));
});

test("부산 topology collector는 공식 scode 필터만 추가로 허용한다", async () => {
  let requestUrl;
  const firstItemOnly = successXml(XML.match(/<item>[\s\S]*?<\/item>/)[0]);
  await assert.rejects(collect({
    stationCode: "101",
    fetchImpl: async (url) => {
      requestUrl = new URL(url);
      return response(firstItemOnly);
    },
  }), /line scope: lines=line-ab1a041f6266; edges=1/);
  assert.deepEqual([...requestUrl.searchParams], [["serviceKey", "key"], ["act", "xml"], ["scode", "101"]]);
  await assert.rejects(collect({ stationCode: "10", fetchImpl: async () => response() }), /stationCode/);
  await assert.rejects(collectBusanRouteTopology({ fetchImpl: async () => response() }), /DATA_GO_KR_SERVICE_KEY/);
  await assert.rejects(
    collect({ stationCode: "101", fetchImpl: async () => response(firstItemOnly) }),
    /line scope: lines=line-ab1a041f6266; edges=1.*rawSha256=[a-f0-9]{64}/,
  );
});

test("부산 topology collector는 1호선 95~99 두 자리 역 코드를 보존한다", async () => {
  const body = XML.replace("<startSc>101</startSc>", "<startSc>100</startSc>")
    .replace("<endSc>102</endSc>", "<endSc>99</endSc>");
  const snapshot = await collect({ fetchImpl: async () => response(body) });
  assert.equal(snapshot.edges[0].edgeId, "busan:1:100:99");
  assert.equal(snapshot.edges[0].lineId, "line-ab1a041f6266");
});

test("부산 topology collector는 UTF-8로 잘못 선언된 EUC-KR 역명을 손실 없이 디코딩한다", async () => {
  const template = `<?xml version="1.0" encoding="UTF-8"?><response>
    <header><resultCode>00</resultCode><resultMsg>OK</resultMsg></header><body>
    <item><startSn>{START}</startSn><startSc>101</startSc><endSn>{END}</endSn><endSc>102</endSc><dist>16</dist><time>140</time><stoppingTime>0</stoppingTime><exchange>N</exchange></item>
    <item><startSn>L2A</startSn><startSc>201</startSc><endSn>L2B</endSn><endSc>202</endSc><dist>9</dist><time>90</time><stoppingTime>20</stoppingTime><exchange>N</exchange></item>
    <item><startSn>L3A</startSn><startSc>301</startSc><endSn>L3B</endSn><endSc>302</endSc><dist>7</dist><time>80</time><stoppingTime>20</stoppingTime><exchange>N</exchange></item>
    <item><startSn>L4A</startSn><startSc>401</startSc><endSn>L4B</endSn><endSc>402</endSc><dist>8</dist><time>85</time><stoppingTime>20</stoppingTime><exchange>N</exchange></item>
    </body><numOfRows>4</numOfRows><pageNo>1</pageNo><totalCount>4</totalCount></response>`;
  const [beforeStart, afterStart] = template.split("{START}");
  const [beforeEnd, afterEnd] = afterStart.split("{END}");
  const bytes = Buffer.concat([
    Buffer.from(beforeStart, "ascii"), Buffer.from("bdc5c6f2", "hex"),
    Buffer.from(beforeEnd, "ascii"), Buffer.from("c7cfb4dc", "hex"), Buffer.from(afterEnd, "ascii"),
  ]);
  const snapshot = await collect({ fetchImpl: async () => response(bytes) });
  assert.equal(snapshot.edges[0].fromStationName, "신평");
  assert.equal(snapshot.edges[0].toStationName, "하단");
  assert.deepEqual(snapshot.responseEncodings, ["euc-kr-after-invalid-utf8"]);
  assert.doesNotMatch(JSON.stringify(snapshot), /�/);
});

test("부산 topology collector는 exchange=Y인 범위 밖 환승 edge만 분리한다", async () => {
  const transfer = "<item><startSn>부전</startSn><startSc>120</startSc><endSn>부전</endSn><endSc>801</endSc>"
    + "<dist></dist><time></time><stoppingTime></stoppingTime><exchange>Y</exchange></item>";
  const snapshot = await collect({ fetchImpl: async () => response(XML.replace("</body>", `${transfer}</body>`)) });
  assert.equal(snapshot.edgeCount, 4);
  assert.equal(snapshot.excludedTransferCount, 1);
  await assert.rejects(collect({
    fetchImpl: async () => response(XML.replace("</body>", `${transfer.replace("<exchange>Y", "<exchange>N")}</body>`)),
  }), /station scope/);
});

// #872 S3: 수집기는 exchange=Y 환승 행을 세기만 하고 버렸다. 이제 원천 값(역 코드·dist·time·stoppingTime)을
// 그대로 보존해 환승 지표 빌더가 쓰게 한다. 역명(EUC-KR)은 매핑에 쓰지 않으므로 보존 행에 넣지 않는다.
test("#872 S3 부산 topology collector는 exchange=Y 환승 행을 역 코드와 원천 값 그대로 보존한다", async () => {
  const internal = "<item><startSn>서면</startSn><startSc>119</startSc><endSn>서면</endSn><endSc>219</endSc>"
    + "<dist>1</dist><time>120</time><stoppingTime>0</stoppingTime><exchange>Y</exchange></item>";
  const external = "<item><startSn>부전</startSn><startSc>120</startSc><endSn>부전</endSn><endSc>801</endSc>"
    + "<dist></dist><time></time><stoppingTime></stoppingTime><exchange>Y</exchange></item>";
  const body = XML.replace("</body>", `${internal}${external}</body>`);
  const snapshot = await collect({ fetchImpl: async () => response(body) });
  assert.equal(snapshot.edgeCount, 4);
  assert.equal(snapshot.excludedTransferCount, 2);

  const rows = extractBusanTransferRows(snapshot);
  const rawResponseSha256 = createHash("sha256").update(Buffer.from(body)).digest("hex");
  assert.deepEqual(rows, [
    { requestStationCode: null, rawResponseSha256, fromStationCode: "119", toStationCode: "219", dist: "1", time: "120", stoppingTime: "0" },
    { requestStationCode: null, rawResponseSha256, fromStationCode: "120", toStationCode: "801", dist: "", time: "", stoppingTime: "" },
  ]);
  assert.equal(rows.some((row) => Object.hasOwn(row, "fromStationName") || Object.hasOwn(row, "startSn")), false);
});

test("#872 S3 커밋된 fan-in 선택 부산 snapshot의 raw 응답에서 환승 18행을 다시 꺼내고, raw가 바뀌면 거부한다", async () => {
  const snapshotPath = "./sources/busan-transportation-route-topology-31fc36651cdb7859ac3c0171c2ee26af8808809b8443899905908960d295d275.json";
  const snapshot = JSON.parse(await readFile(new URL(snapshotPath, import.meta.url), "utf8"));
  const rows = extractBusanTransferRows(snapshot);
  assert.equal(rows.length, snapshot.excludedTransferCount);
  assert.equal(rows.length, 18);
  const seomyeon = rows.find(({ fromStationCode, toStationCode }) => fromStationCode === "119" && toStationCode === "219");
  assert.deepEqual({ ...seomyeon, rawResponseSha256: undefined },
    { requestStationCode: "119", rawResponseSha256: undefined, fromStationCode: "119", toStationCode: "219", dist: "1", time: "120", stoppingTime: "0" });
  assert.match(seomyeon.rawResponseSha256, /^[a-f0-9]{64}$/);
  for (const row of rows) assert.equal(row.requestStationCode, row.fromStationCode, "환승 행은 요청 역 코드의 응답에서 나온다");

  const tampered = structuredClone(snapshot);
  const index = tampered.rawResponses.findIndex(({ stationCode }) => stationCode === "119");
  tampered.rawResponses[index].bytesBase64 = Buffer.from(
    Buffer.from(tampered.rawResponses[index].bytesBase64, "base64").toString("latin1").replace("<time>120</time>", "<time>060</time>"),
    "latin1",
  ).toString("base64");
  assert.throws(() => extractBusanTransferRows(tampered), /raw hash mismatch/);

  const withoutRaw = structuredClone(snapshot);
  delete withoutRaw.rawResponses;
  assert.throws(() => extractBusanTransferRows(withoutRaw), /raw responses are required/);
});

test("부산 topology collector는 공식 station/adjacency scope 전체를 bounded fan-out한다", async () => {
  const scope = parseBusanRouteTopologyScope(SCOPE_HTML);
  assert.equal(scope.length, 8);
  assert.deepEqual(scope[0], {
    stationCode: "101", stationName: "신평", lineId: "line-ab1a041f6266", neighborCodes: ["102"],
  });
  const names = new Map(scope.map(({ stationCode, stationName }) => [stationCode, stationName]));
  const byCode = new Map(scope.map((entry) => [entry.stationCode, entry]));
  const requested = [];
  const snapshot = await collect({
    stationScopes: scope,
    now: new Date("2026-07-20T00:00:00.000Z"),
    fetchImpl: async (url) => {
      const stationCode = new URL(url).searchParams.get("scode");
      requested.push(stationCode);
      const station = byCode.get(stationCode);
      const items = station.neighborCodes.map((neighborCode) => `<item>
        <startSn>${station.stationName}</startSn><startSc>${stationCode}</startSc>
        <endSn>${names.get(neighborCode).replace(/역$/, "")}</endSn><endSc>${neighborCode}</endSc>
        <dist>10</dist><time>60</time><stoppingTime>20</stoppingTime><exchange></exchange>
      </item>`).join("");
      return response(successXml(items));
    },
  });
  assert.deepEqual(requested.sort(), scope.map(({ stationCode }) => stationCode));
  assert.equal(snapshot.stationCount, 8);
  assert.equal(snapshot.requestCount, 8);
  assert.equal(snapshot.edgeCount, 8);
  assert.deepEqual(snapshot.scope, scope);
  assert.equal(admitBusanRouteTopology(snapshot, { now: new Date("2026-07-20T12:00:00.000Z") }).status, "ADMITTED");

  await assert.rejects(collect({
    stationScopes: scope,
    fetchImpl: async (url) => {
      const stationCode = new URL(url).searchParams.get("scode");
      const station = byCode.get(stationCode);
      const neighborCode = stationCode === "101" ? "103" : station.neighborCodes[0];
      return response(successXml(`<item>
        <startSn>${station.stationName}</startSn><startSc>${stationCode}</startSc>
        <endSn>역</endSn><endSc>${neighborCode}</endSc><dist>10</dist><time>60</time>
        <stoppingTime>20</stoppingTime><exchange></exchange>
      </item>`));
    },
  }), /adjacency scope/);

  await assert.rejects(collect({
    stationScopes: scope,
    fetchImpl: async (url) => {
      const stationCode = new URL(url).searchParams.get("scode");
      const station = byCode.get(stationCode);
      const neighborCode = station.neighborCodes[0];
      return response(successXml(`<item><startSn>${station.stationName}</startSn><startSc>${stationCode}</startSc>
        <endSn>${stationCode === "101" ? "완전다름" : names.get(neighborCode)}</endSn><endSc>${neighborCode}</endSc>
        <dist>10</dist><time>60</time><stoppingTime>20</stoppingTime><exchange>N</exchange></item>`));
    },
  }), /station name mismatch/);
});

test("부산 topology scope parser는 duplicate·cross-line·고립 station을 거부한다", () => {
  assert.throws(() => parseBusanRouteTopologyScope(`${SCOPE_HTML}${SCOPE_HTML}`), /duplicate station/);
  assert.throws(() => parseBusanRouteTopologyScope(SCOPE_HTML.replace("l101-102 l102-101", "l101-202 l202-101")), /cross-line/);
  assert.throws(() => parseBusanRouteTopologyScope(SCOPE_HTML.replace('<div class="l401-402 l402-401 w-4"></div>', "")), /isolated station/);
});

test("부산 topology collector는 실제 response/header/body envelope와 단일 field를 강제한다", async () => {
  const item = XML.match(/<item>[\s\S]*?<\/item>/)[0];
  await assert.rejects(
    collect({ fetchImpl: async () => response(`<?xml version="1.0"?><response>${item}</response>`) }),
    /envelope/,
  );
  await assert.rejects(
    collect({ fetchImpl: async () => response(XML.replace("<dist>16</dist>", "<dist>16</dist><dist>17</dist>")) }),
    /duplicate field/,
  );
});

test("부산 topology scope parser는 보존된 공식 노선도에서 4개 노선 114개 역을 고정한다", async () => {
  const html = await readFile(new URL("./sources/humetro-cyberstation-map-20260623.html", import.meta.url), "utf8");
  const scope = parseBusanRouteTopologyScope(html);
  assert.equal(scope.length, 114);
  assert.equal(scope.reduce((sum, station) => sum + station.neighborCodes.length, 0), 220);
  assert.deepEqual([...new Set(scope.map(({ lineId }) => lineId))].sort(), [
    "line-ab1a041f6266",
    "line-d74614a04530",
    "line-d812a5bc1e5f",
    "line-eb7b47920390",
  ]);
});

test("부산 topology collector는 XML schema·숫자·노선 scope를 fail closed한다", async (context) => {
  const invalidCases = [
    ["missing field", XML.replace("<dist>16</dist>", "")],
    ["invalid station code", XML.replace("<startSc>101</startSc>", "<startSc>501</startSc>")],
    ["cross line", XML.replace("<endSc>102</endSc>", "<endSc>202</endSc>")],
    ["invalid distance", XML.replace("<dist>16</dist>", "<dist>1.6</dist>")],
    ["invalid duration", XML.replace("<time>140</time>", "<time>-1</time>")],
    ["duplicate edge", XML.replace("</body>", `${XML.match(/<item>[\s\S]*?<\/item>/)[0]}</body>`) ],
    ["unmatched node", "<response><message>none</message></response>"],
  ];
  for (const [name, body] of invalidCases) {
    await context.test(name, async () => {
      await assert.rejects(collect({ fetchImpl: async () => response(body) }), /schema mismatch/);
    });
  }
  await assert.rejects(
    collect({ fetchImpl: async () => response("<?xml version=\"1.0\"?><distance><row/></distance>") }),
    /tags=distance,row.*rawSha256=[a-f0-9]{64}/,
  );
});

test("부산 topology collector는 HTTP/content-type/transport failure를 bounded 처리한다", async (context) => {
  await context.test("transport retry", async () => {
    let calls = 0;
    const snapshot = await collect({
      ...retryFast(),
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) throw Object.assign(new Error("temporary"), { code: "ECONNRESET" });
        return response();
      },
    });
    assert.equal(calls, 2);
    assert.equal(snapshot.edgeCount, 4);
  });
  await context.test("rate-limit retry delay", async () => {
    let calls = 0;
    const delays = [];
    const snapshot = await collect({
      sleepImpl: async (delay) => delays.push(delay),
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) return response("rate limited", {
          status: 429,
          contentType: "text/plain",
          headers: { "retry-after": "10" },
        });
        return response();
      },
    });
    assert.equal(calls, 2);
    assert.deepEqual(delays, [2_000]);
    assert.equal(snapshot.edgeCount, 4);
  });
  await context.test("HTTP", async () => {
    await assert.rejects(
      collect({ fetchImpl: async () => response("forbidden", { status: 403 }) }),
      /HTTP 403.*rawSha256=[a-f0-9]{64}/,
    );
  });
  await context.test("content type", async () => {
    await assert.rejects(
      collect({ fetchImpl: async () => response(XML, { contentType: "text/html" }) }),
      /schema mismatch: content-type text\/html/,
    );
  });
  await context.test("provider error", async () => {
    const body = "<?xml version=\"1.0\"?><response><header><resultCode>30</resultCode><resultMsg>인증 정보가 없습니다</resultMsg></header></response>";
    await assert.rejects(
      collect({ fetchImpl: async () => response(body) }),
      /provider resultCode 30; classification=authorization.*rawSha256=[a-f0-9]{64}/,
    );
  });
  await context.test("provider success code", async () => {
    for (const resultCode of ["0", "SUCCESS", ""]) {
      const body = XML.replace("<resultCode>00</resultCode>", `<resultCode>${resultCode}</resultCode>`);
      await assert.rejects(
        collect({ fetchImpl: async () => response(body) }),
        /provider resultCode/,
      );
    }
  });
});

test("부산 topology는 컷오버(2026-10-03T00:00Z) 이후 수집분을 P7D 창으로 만들고 정확히 그 창만 허용한다", async () => {
  const scope = parseBusanRouteTopologyScope(SCOPE_HTML);
  const names = new Map(scope.map(({ stationCode, stationName }) => [stationCode, stationName]));
  const byCode = new Map(scope.map((entry) => [entry.stationCode, entry]));
  const collectAt = (now) => collect({
    now,
    stationScopes: scope,
    fetchImpl: async (url) => {
      const stationCode = new URL(url).searchParams.get("scode");
      const station = byCode.get(stationCode);
      const items = station.neighborCodes.map((neighborCode) => `<item>
        <startSn>${station.stationName}</startSn><startSc>${stationCode}</startSc>
        <endSn>${names.get(neighborCode)}</endSn><endSc>${neighborCode}</endSc>
        <dist>10</dist><time>60</time><stoppingTime>20</stoppingTime><exchange></exchange>
      </item>`).join("");
      return response(successXml(items));
    },
  });
  const day = 86_400_000;
  const cutover = Date.parse("2026-10-03T00:00:00.000Z");
  const snapshot = await collectAt(new Date(cutover));
  assert.equal(snapshot.freshUntil, new Date(cutover + 7 * day).toISOString());
  assert.equal(admitBusanRouteTopology(snapshot, { now: new Date(cutover + 7 * day - 1) }).status, "ADMITTED");
  assert.throws(() => admitBusanRouteTopology(snapshot, { now: new Date(cutover + 7 * day) }), /stale/);
  assert.throws(
    () => validateBusanRouteTopologySnapshot({ ...snapshot, freshUntil: new Date(cutover + day).toISOString() }),
    /freshness contract/,
  );
  const legacy = await collectAt(new Date(cutover - 1));
  assert.equal(legacy.freshUntil, new Date(cutover - 1 + day).toISOString());
  assert.equal(validateBusanRouteTopologySnapshot(legacy), legacy);
});

test("부산 topology admission은 4개 노선 full snapshot만 허용하고 stale·partial·fixture를 거부한다", async () => {
  const scope = parseBusanRouteTopologyScope(SCOPE_HTML);
  const names = new Map(scope.map(({ stationCode, stationName }) => [stationCode, stationName]));
  const byCode = new Map(scope.map((entry) => [entry.stationCode, entry]));
  const snapshot = await collect({
    now: new Date("2026-07-20T00:00:00.000Z"),
    stationScopes: scope,
    fetchImpl: async (url) => {
      const stationCode = new URL(url).searchParams.get("scode");
      const station = byCode.get(stationCode);
      const items = station.neighborCodes.map((neighborCode) => `<item>
        <startSn>${station.stationName}</startSn><startSc>${stationCode}</startSc>
        <endSn>${names.get(neighborCode)}</endSn><endSc>${neighborCode}</endSc>
        <dist>10</dist><time>60</time><stoppingTime>20</stoppingTime><exchange></exchange>
      </item>`).join("");
      return response(successXml(items));
    },
  });
  const admit = (candidate) => admitBusanRouteTopology(candidate, { now: new Date("2026-07-20T23:59:59.999Z") });
  assert.equal(validateBusanRouteTopologySnapshot(snapshot), snapshot);
  assert.equal(admit(snapshot).status, "ADMITTED");
  assert.throws(() => admit({ ...snapshot, fixture: true }), /fixture/);
  assert.throws(() => admit({ ...snapshot, lineIds: snapshot.lineIds.slice(1) }), /line scope/);
  const changedContent = { ...snapshot, contentSha256: "0".repeat(64) };
  assert.throws(() => validateBusanRouteTopologySnapshot(changedContent), /content hash/);
  assert.throws(() => admit(changedContent), /content hash/);
  assert.throws(() => admit({ ...snapshot, scope: snapshot.scope.slice(1) }), /scope/);
  assert.throws(() => admit({ ...snapshot, credentialRedacted: false }), /identity/);
  assert.throws(() => admit({ ...snapshot, endpoint: "https://example.invalid" }), /identity/);
  assert.throws(() => admit({ ...snapshot, fieldsProvided: ["network_edges"] }), /fields/);
  assert.throws(() => admit({ ...snapshot, responseEncodings: ["unknown"] }), /encoding/);
  assert.throws(() => admit({ ...snapshot, excludedTransferCount: -1 }), /excluded transfer/);
  assert.throws(() => admit({ ...snapshot, freshUntil: snapshot.capturedAt }), /freshness/);
  const edges = structuredClone(snapshot.edges);
  edges[0].distanceMeters = -1;
  assert.throws(() => admit({
    ...snapshot,
    edges,
    contentSha256: contentHash(edges, snapshot.scope),
  }), /edge/);
  const reversed = [...snapshot.edges].reverse();
  assert.throws(() => admit({
    ...snapshot,
    edges: reversed,
    contentSha256: contentHash(reversed, snapshot.scope),
  }), /edge/);
  assert.throws(
    () => admitBusanRouteTopology(snapshot, { now: new Date("2026-07-21T00:00:00.001Z") }),
    /stale/,
  );
  assert.equal(validateBusanRouteTopologySnapshot(snapshot), snapshot);
});

test("부산 topology collector는 5xx·resultCode 99·연결 timeout·본문 수신 오류 뒤 같은 요청이 성공하면 그 응답을 쓴다", async () => {
  const unknownError = "<?xml version=\"1.0\"?><response><header><resultCode>99</resultCode><resultMsg>UNKNOWN_ERROR.</resultMsg></header></response>";
  const outcomes = [
    () => response("busy", { status: 503, contentType: "text/plain" }),
    () => response(unknownError),
    () => { throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("connect timeout"), { code: "UND_ERR_CONNECT_TIMEOUT" }) }); },
    () => ({ ok: true, status: 200, headers: new Headers(), arrayBuffer: async () => { throw Object.assign(new Error("body timeout"), { code: "UND_ERR_BODY_TIMEOUT" }); } }),
  ];
  let calls = 0;
  const delays = [];
  const snapshot = await collect({
    ...retryFast(delays),
    fetchImpl: async () => { calls += 1; const next = outcomes.shift(); return next === undefined ? response() : next(); },
  });
  assert.equal(calls, 5);
  assert.deepEqual(delays, [1_000, 2_000, 4_000, 8_000]);
  assert.equal(snapshot.edgeCount, 4);
});

test("부산 topology collector는 일시 오류가 한도(5번)를 넘으면 기존 오류로 끝나고 원본 증거를 남긴다", async () => {
  const delays = [];
  let calls = 0;
  await assert.rejects(collect({
    ...retryFast(delays),
    fetchImpl: async () => { calls += 1; return response("busy", { status: 503, contentType: "text/plain" }); },
  }), /HTTP 503.*rawSha256=[a-f0-9]{64}/);
  assert.equal(calls, 6);
  assert.deepEqual(delays, [1_000, 2_000, 4_000, 8_000, 16_000]);

  let transportCalls = 0;
  await assert.rejects(collect({
    ...retryFast(),
    fetchImpl: async () => { transportCalls += 1; throw Object.assign(new Error("reset"), { code: "ECONNRESET" }); },
  }), /Busan route topology transport failure/);
  assert.equal(transportCalls, 6);

  let budgetCalls = 0;
  await assert.rejects(collect({
    sleepImpl: async () => {}, retryBudget: createTransientRetryBudget(2_500),
    fetchImpl: async () => { budgetCalls += 1; throw Object.assign(new Error("reset"), { code: "ECONNRESET" }); },
  }), /Busan route topology transport failure/);
  assert.equal(budgetCalls, 2);
});

test("부산 topology collector는 인증·쿼터·형식 오류를 재시도하지 않고 429만 기존처럼 한 번 다시 요청한다", async () => {
  for (const [status, expectedCalls] of [[401, 1], [403, 1], [404, 1], [429, 2]]) {
    let calls = 0;
    const delays = [];
    await assert.rejects(collect({
      ...retryFast(delays),
      fetchImpl: async () => { calls += 1; return response("denied", { status, contentType: "text/plain" }); },
    }), new RegExp(`HTTP ${status}`));
    assert.equal(calls, expectedCalls, String(status));
    assert.equal(delays.length, expectedCalls - 1);
  }
  for (const code of ["22", "23", "30", "31"]) {
    let calls = 0;
    const body = `<?xml version="1.0"?><response><header><resultCode>${code}</resultCode><resultMsg>x</resultMsg></header></response>`;
    await assert.rejects(collect({ ...retryFast(), fetchImpl: async () => { calls += 1; return response(body); } }), new RegExp(`provider resultCode ${code}`));
    assert.equal(calls, 1, code);
  }
});
