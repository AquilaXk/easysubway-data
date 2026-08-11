import assert from "node:assert/strict";
import test from "node:test";

import { fetchKasiPublicHolidayCalendar } from "./fetch-kasi-public-holiday-calendar.mjs";

test("KASI calendar는 유효한 year·months에서 malformed credential을 request URL·provider 호출 전에 거부한다", async () => {
  let calls = 0;
  await assert.rejects(fetchKasiPublicHolidayCalendar({ serviceKey: "invalid%ZZ", year: 2026, months: [7], fetchImpl: async () => { calls += 1; } }), /DATA_GO_KR_SERVICE_KEY is invalid/);
  assert.equal(calls, 0);
});

const holidayXml = (items, totalCount = items.length) => `<?xml version="1.0" encoding="UTF-8"?>
<response><header><resultCode>00</resultCode><resultMsg>OK</resultMsg></header><body><items>${items.map(({ date, holiday }) => `<item><locdate>${date}</locdate><isHoliday>${holiday}</isHoliday></item>`).join("")}</items><numOfRows>100</numOfRows><pageNo>1</pageNo><totalCount>${totalCount}</totalCount></body></response>`;

test("KASI 공휴일 달력은 요청 월 전체를 HTTPS 정본에서 가져와 휴일만 반환한다", async () => {
  const requests = [];
  const holidays = await fetchKasiPublicHolidayCalendar({
    serviceKey: "test-key",
    year: 2026,
    months: [7, 8],
    fetchImpl: async (url, options) => {
      const parsed = new URL(url);
      requests.push({ parsed, options });
      return new Response(holidayXml(parsed.searchParams.get("solMonth") === "07"
        ? [{ date: "20260717", holiday: "Y" }, { date: "20260720", holiday: "N" }]
        : [{ date: "20260817", holiday: "Y" }]));
    },
  });

  assert.deepEqual([...holidays].sort(), ["20260717", "20260817"]);
  assert.deepEqual(requests.map(({ parsed: request, options }) => ({
    origin: request.origin,
    pathname: request.pathname,
    serviceKey: request.searchParams.get("ServiceKey"),
    pageNo: request.searchParams.get("pageNo"),
    numOfRows: request.searchParams.get("numOfRows"),
    solYear: request.searchParams.get("solYear"),
    solMonth: request.searchParams.get("solMonth"),
    redirect: options.redirect,
    accept: options.headers.accept,
    aborted: options.signal.aborted,
  })), [
    { origin: "https://apis.data.go.kr", pathname: "/B090041/openapi/service/SpcdeInfoService/getRestDeInfo", serviceKey: "test-key", pageNo: "1", numOfRows: "100", solYear: "2026", solMonth: "07", redirect: "error", accept: "application/xml, text/xml", aborted: false },
    { origin: "https://apis.data.go.kr", pathname: "/B090041/openapi/service/SpcdeInfoService/getRestDeInfo", serviceKey: "test-key", pageNo: "1", numOfRows: "100", solYear: "2026", solMonth: "08", redirect: "error", accept: "application/xml, text/xml", aborted: false },
  ]);
});

test("KASI 공휴일 달력은 percent-encoded portal key를 한 번만 decode해 전송한다", async () => {
  let receivedKey;
  await fetchKasiPublicHolidayCalendar({
    serviceKey: "abc%2Bdef%3D%3D",
    year: 2026,
    months: [7],
    fetchImpl: async (url) => {
      receivedKey = new URL(url).searchParams.get("ServiceKey");
      return new Response(holidayXml([]));
    },
  });
  assert.equal(receivedKey, "abc+def==");
});

test("KASI 공휴일 달력은 권한·HTTP·XML·resultCode·월 범위 불일치를 fail closed한다", async () => {
  const run = (response) => fetchKasiPublicHolidayCalendar({
    serviceKey: "secret-key",
    year: 2026,
    months: [7],
    fetchImpl: async () => response,
  });
  await assert.rejects(run(new Response("denied", { status: 403 })), /KASI public holiday request failed: HTTP_403/);
  await assert.rejects(run(new Response("<response><header><resultCode>30</resultCode></header></response>")), /KASI public holiday provider resultCode 30/);
  await assert.rejects(run(new Response("not xml")), /KASI public holiday response schema is invalid/);
  await assert.rejects(run(new Response(holidayXml([{ date: "20260801", holiday: "Y" }]))), /KASI public holiday response month coverage is invalid/);
  await assert.rejects(fetchKasiPublicHolidayCalendar({ serviceKey: "", year: 2026, months: [7] }), /DATA_GO_KR_SERVICE_KEY/);
  await assert.rejects(fetchKasiPublicHolidayCalendar({ serviceKey: "one\nline", year: 2026, months: [7] }), /DATA_GO_KR_SERVICE_KEY/);
  await assert.rejects(fetchKasiPublicHolidayCalendar({ serviceKey: "secret-key", year: 2026, months: [7], fetchImpl: async () => { throw new Error("network"); } }), /NETWORK/);
});

test("KASI transport 오류는 원문을 노출하지 않고 closed category로 분류한다", async () => {
  const runFetch = (error) => fetchKasiPublicHolidayCalendar({
    serviceKey: "secret-key",
    year: 2026,
    months: [7],
    fetchImpl: async () => { throw error; },
  });
  const runBody = (error) => fetchKasiPublicHolidayCalendar({
    serviceKey: "secret-key",
    year: 2026,
    months: [7],
    fetchImpl: async () => ({ ok: true, text: async () => { throw error; } }),
  });
  const transportError = ({ name = "Error", code, cause } = {}) => Object.assign(new Error("https://apis.data.go.kr/?ServiceKey=secret-key raw diagnostic"), { name, code, cause });
  const cases = [
    [{ code: "ENOTFOUND" }, "NETWORK_DNS"],
    [{ code: "EAI_AGAIN" }, "NETWORK_DNS"],
    [{ code: "ERR_TLS_CERT_ALTNAME_INVALID" }, "NETWORK_TLS"],
    [{ code: "CERT_HAS_EXPIRED" }, "NETWORK_TLS"],
    [{ code: "DEPTH_ZERO_SELF_SIGNED_CERT" }, "NETWORK_TLS"],
    [{ code: "SELF_SIGNED_CERT_IN_CHAIN" }, "NETWORK_TLS"],
    [{ code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" }, "NETWORK_TLS"],
    [{ code: "UNABLE_TO_GET_ISSUER_CERT_LOCALLY" }, "NETWORK_TLS"],
    [{ code: "ERR_SSL_WRONG_VERSION_NUMBER" }, "NETWORK_TLS"],
    [{ code: "ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION" }, "NETWORK_TLS"],
    [{ code: "ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE" }, "NETWORK_TLS"],
    [{ code: "UND_ERR_CONNECT_TIMEOUT" }, "NETWORK_CONNECT_TIMEOUT"],
    [{ name: "TimeoutError" }, "NETWORK_REQUEST_TIMEOUT"],
    [{ name: "AbortError" }, "NETWORK_REQUEST_TIMEOUT"],
    [{ code: "ABORT_ERR" }, "NETWORK_REQUEST_TIMEOUT"],
    [{ code: "UND_ERR_HEADERS_TIMEOUT" }, "NETWORK_REQUEST_TIMEOUT"],
    [{ code: "UND_ERR_BODY_TIMEOUT" }, "NETWORK_REQUEST_TIMEOUT"],
    [{ code: "ECONNRESET" }, "NETWORK_SOCKET"],
    [{ code: "ECONNREFUSED" }, "NETWORK_SOCKET"],
    [{ code: "EPIPE" }, "NETWORK_SOCKET"],
    [{ code: "ETIMEDOUT" }, "NETWORK_SOCKET"],
    [{ code: "UND_ERR_SOCKET" }, "NETWORK_SOCKET"],
  ];
  for (const [options, category] of cases) {
    await assert.rejects(runFetch(transportError(options)), new RegExp(`KASI public holiday request failed: ${category}$`));
  }
  await assert.rejects(runBody(transportError({ code: "ECONNRESET" })), /KASI public holiday request failed: NETWORK_SOCKET$/);

  let nested = transportError({ code: "ENOTFOUND" });
  for (let depth = 1; depth <= 4; depth += 1) {
    nested = transportError({ cause: nested });
    await assert.rejects(runFetch(nested), /KASI public holiday request failed: NETWORK_DNS$/);
  }
  const tooDeep = transportError({ cause: nested });
  await assert.rejects(runFetch(tooDeep), /KASI public holiday request failed: NETWORK_UNKNOWN$/);
  const cyclic = transportError({ code: "ENOTFOUND" });
  cyclic.cause = cyclic;
  await assert.rejects(runFetch(cyclic), /KASI public holiday request failed: NETWORK_UNKNOWN$/);

  await assert.rejects(runFetch(transportError({ code: "UNLISTED_RAW_CODE" })), (error) => {
    assert.equal(error.message, "KASI public holiday request failed: NETWORK_UNKNOWN");
    assert.doesNotMatch(error.message, /secret-key|apis\.data\.go\.kr|UNLISTED_RAW_CODE|raw diagnostic/);
    return true;
  });
});

test("KASI 공휴일 달력은 totalCount=0의 empty/self-closing items만 유효한 빈 월로 인정한다", async () => {
  const empty = `<?xml version="1.0"?><response><header><resultCode>00</resultCode></header><body><items/><numOfRows>100</numOfRows><pageNo>1</pageNo><totalCount>0</totalCount></body></response>`;
  assert.deepEqual([...await fetchKasiPublicHolidayCalendar({ serviceKey: "test-key", year: 2026, months: [7], fetchImpl: async () => new Response(empty) })], []);
  const missingItems = empty.replace("<items/>", "").replace("<totalCount>0</totalCount>", "<totalCount>1</totalCount>");
  await assert.rejects(fetchKasiPublicHolidayCalendar({ serviceKey: "test-key", year: 2026, months: [7], fetchImpl: async () => new Response(missingItems) }), /schema is invalid/);
});
