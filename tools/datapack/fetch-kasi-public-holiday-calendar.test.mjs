import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";

import { fetchKasiPublicHolidayCalendar, fetchKasiPublicHolidayCalendarObservation, parseRetainedKasiHolidayMonth } from "./fetch-kasi-public-holiday-calendar.mjs";

test("KASI calendar는 유효한 year·months에서 malformed credential을 request URL·provider 호출 전에 거부한다", async () => {
  let calls = 0;
  await assert.rejects(fetchKasiPublicHolidayCalendar({ serviceKey: "invalid%ZZ", year: 2026, months: [7], fetchImpl: async () => { calls += 1; } }), /DATA_GO_KR_SERVICE_KEY is invalid/);
  assert.equal(calls, 0);
});

const holidayXml = (items, totalCount = items.length) => `<?xml version="1.0" encoding="UTF-8"?>
<response><header><resultCode>00</resultCode><resultMsg>OK</resultMsg></header><body><items>${items.map(({ date, holiday }) => `<item><locdate>${date}</locdate><isHoliday>${holiday}</isHoliday></item>`).join("")}</items><numOfRows>100</numOfRows><pageNo>1</pageNo><totalCount>${totalCount}</totalCount></body></response>`;

test("retained KASI month binds original bytes and reuses complete month validation", () => {
  const raw = Buffer.from(holidayXml([{ date: "20400102", holiday: "Y" }, { date: "20400103", holiday: "N" }]));
  const sha256 = createHash("sha256").update(raw).digest("hex");
  const input = { raw, sha256, year: 2040, month: 1 };
  assert.deepEqual(parseRetainedKasiHolidayMonth(input), {
    year: 2040, month: 1, rawSha256: sha256, rawByteLength: raw.length, holidayDates: ["20400102"],
  });
  assert.throws(() => parseRetainedKasiHolidayMonth({ ...input, sha256: "0".repeat(64) }), /digest/);
  assert.throws(() => parseRetainedKasiHolidayMonth({ ...input, month: 2 }), /month coverage/);
  const incomplete = Buffer.from(holidayXml([], 1));
  assert.throws(() => parseRetainedKasiHolidayMonth({ ...input, raw: incomplete,
    sha256: createHash("sha256").update(incomplete).digest("hex") }), /month coverage/);
});

test("KASI observation retains reusable monthly XML without an extra request", async () => {
  let calls = 0;
  const xml = holidayXml([{ date: "20400102", holiday: "Y" }]);
  const result = await fetchKasiPublicHolidayCalendarObservation({ serviceKey: "test-key", year: 2040, months: [1, 1],
    fetchImpl: async () => { calls += 1; return { ok: true, text: async () => xml }; } });
  assert.equal(calls, 1);
  assert.deepEqual([...result.holidays], ["20400102"]);
  assert.equal(result.months.length, 1);
  const month = result.months[0];
  assert.equal(month.xml, xml);
  assert.deepEqual(parseRetainedKasiHolidayMonth({ raw: Buffer.from(month.xml), sha256: month.sha256,
    year: month.year, month: month.month }).holidayDates, ["20400102"]);
  assert.equal(Number.isFinite(Date.parse(month.retrievedAt)), true);
  assert.ok(!JSON.stringify(result).includes("test-key"));
});

test("KASI 기본 전송은 내장 HTTPS request seam으로 정확한 GET 요청을 한 번 종료한다", async () => {
  const requests = [];
  const holidays = await fetchKasiPublicHolidayCalendar({
    serviceKey: "test-key",
    year: 2026,
    months: [7],
    httpsRequestImpl: (url, options, onResponse) => {
      const listeners = new Map();
      const request = {
        once(event, listener) {
          listeners.set(event, listener);
          return request;
        },
        end() {
          requests.push({ url, options, endCount: 1 });
          queueMicrotask(() => {
            const response = {
              statusCode: 200,
              setEncoding(encoding) { assert.equal(encoding, "utf8"); },
              once(event, listener) {
                listeners.set(`response:${event}`, listener);
                if (event === "end") queueMicrotask(listener);
                return response;
              },
              on(event, listener) {
                if (event === "data") queueMicrotask(() => listener(holidayXml([{ date: "20260717", holiday: "Y" }])));
                return response;
              },
            };
            onResponse(response);
          });
        },
      };
      return request;
    },
  });

  assert.deepEqual([...holidays], ["20260717"]);
  assert.equal(requests.length, 1);
  const [{ url, options, endCount }] = requests;
  assert.equal(url.origin, "https://apis.data.go.kr");
  assert.equal(url.pathname, "/B090041/openapi/service/SpcdeInfoService/getRestDeInfo");
  assert.equal(url.searchParams.get("ServiceKey"), "test-key");
  assert.equal(url.searchParams.get("solYear"), "2026");
  assert.equal(url.searchParams.get("solMonth"), "07");
  assert.equal(options.method, "GET");
  assert.equal(options.headers.accept, "application/xml, text/xml");
  assert.equal(options.signal.aborted, false);
  assert.equal(endCount, 1);
});

test("KASI native HTTPS non-2xx·stream·request·abort failure는 fail closed한다", async () => {
  const nativeFailure = ({ statusCode = 200, requestError, streamError, secureConnected = false } = {}) => (url, options, onResponse) => {
    const requestListeners = new Map();
    const request = {
      once(event, listener) {
        requestListeners.set(event, listener);
        return request;
      },
      end() {
        queueMicrotask(() => {
          if (secureConnected) requestListeners.get("socket")?.({ secureConnecting: false, once() { return this; } });
          if (requestError) return requestListeners.get("error")(requestError);
          const response = {
            statusCode,
            resume() {},
            setEncoding() {},
            once(event, listener) {
              if (event === "error" && streamError) queueMicrotask(() => listener(streamError));
              if (event === "end" && !streamError) queueMicrotask(listener);
              return response;
            },
            on() { return response; },
          };
          onResponse(response);
        });
      },
    };
    return request;
  };
  const cases = [
    [nativeFailure({ statusCode: 503 }), /HTTP_503$/],
    [nativeFailure({ streamError: Object.assign(new Error("stream"), { code: "ECONNRESET" }) }), /NETWORK_SOCKET$/],
    [nativeFailure({ requestError: Object.assign(new Error("request"), { code: "ENOTFOUND" }) }), /NETWORK_DNS$/],
    [nativeFailure({ requestError: Object.assign(new Error("abort"), { name: "AbortError" }), secureConnected: true }), /NETWORK_REQUEST_TIMEOUT$/],
  ];
  for (const [httpsRequestImpl, expectation] of cases) {
    await assert.rejects(fetchKasiPublicHolidayCalendar({
      serviceKey: "test-key",
      year: 2026,
      months: [7],
      httpsRequestImpl,
    }), expectation);
  }
});

test("KASI native HTTPS의 explicit DNS·TLS 오류도 closed phase와 family count를 보존한다", async () => {
  const cases = [
    {
      error: Object.assign(new Error("raw dns provider.invalid"), { code: "ENOTFOUND" }),
      beforeError() {},
      failureCategory: "NETWORK_DNS",
      transportAttempt: { attemptCount: 1, failurePhase: "DNS_LOOKUP", ipv4AttemptCount: 0, ipv6AttemptCount: 0 },
    },
    {
      error: Object.assign(new Error("raw tls provider.invalid"), { code: "CERT_HAS_EXPIRED" }),
      beforeError(socketListeners) {
        socketListeners.get("lookup")?.(null, "198.51.100.9", 4, "provider.invalid");
        socketListeners.get("connectionAttempt")?.("198.51.100.9", 443, 4);
        socketListeners.get("connect")?.();
      },
      failureCategory: "NETWORK_TLS",
      transportAttempt: { attemptCount: 1, failurePhase: "TLS_HANDSHAKE", ipv4AttemptCount: 1, ipv6AttemptCount: 0 },
    },
  ];
  for (const { error, beforeError, failureCategory, transportAttempt } of cases) {
    let calls = 0;
    await assert.rejects(fetchKasiPublicHolidayCalendar({
      serviceKey: "test-key",
      year: 2026,
      months: [7],
      httpsRequestImpl: () => {
        calls += 1;
        const requestListeners = new Map();
        const socketListeners = new Map();
        const request = {
          once(event, listener) { requestListeners.set(event, listener); return request; },
          end() {
            queueMicrotask(() => {
              const socket = {
                secureConnecting: true,
                once(event, listener) { socketListeners.set(event, listener); return socket; },
                on(event, listener) { socketListeners.set(event, listener); return socket; },
              };
              requestListeners.get("socket")?.(socket);
              beforeError(socketListeners);
              requestListeners.get("error")?.(error);
            });
          },
        };
        return request;
      },
    }), (failure) => {
      assert.equal(failure.failureCategory, failureCategory);
      assert.deepEqual(failure.transportAttempts, [transportAttempt]);
      assert.doesNotMatch(JSON.stringify(failure.transportAttempts), /198\.51\.100|provider\.invalid|raw/);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test("KASI native HTTPS는 TLS secureConnect 전 AbortError만 connect timeout으로 한 번 재시도한다", async () => {
  let calls = 0;
  const holidays = await fetchKasiPublicHolidayCalendar({
    serviceKey: "test-key",
    year: 2026,
    months: [7],
    httpsRequestImpl: (url, options, onResponse) => {
      calls += 1;
      const requestListeners = new Map();
      const request = {
        once(event, listener) { requestListeners.set(event, listener); return request; },
        end() {
          queueMicrotask(() => {
            const socket = { secureConnecting: calls !== 2, once() { return socket; } };
            requestListeners.get("socket")?.(socket);
            if (calls === 1) {
              requestListeners.get("error")(Object.assign(new Error("abort"), { name: "AbortError", code: "ABORT_ERR" }));
              return;
            }
            const response = {
              statusCode: 200,
              setEncoding() {},
              once(event, listener) { if (event === "end") queueMicrotask(listener); return response; },
              on(event, listener) {
                if (event === "data") queueMicrotask(() => listener(holidayXml([{ date: "20260717", holiday: "Y" }])));
                return response;
              },
            };
            onResponse(response);
          });
        },
      };
      return request;
    },
  });
  assert.equal(calls, 2);
  assert.deepEqual([...holidays], ["20260717"]);
});

test("KASI native HTTPS 최종 connect timeout은 두 attempt의 closed DNS·TCP·TLS phase와 family count만 보존한다", async () => {
  let calls = 0;
  await assert.rejects(fetchKasiPublicHolidayCalendar({
    serviceKey: "test-key",
    year: 2026,
    months: [7],
    httpsRequestImpl: () => {
      calls += 1;
      const requestListeners = new Map();
      const socketListeners = new Map();
      const request = {
        once(event, listener) { requestListeners.set(event, listener); return request; },
        end() {
          queueMicrotask(() => {
            const socket = {
              secureConnecting: true,
              once(event, listener) { socketListeners.set(event, listener); return socket; },
              on(event, listener) { socketListeners.set(event, listener); return socket; },
            };
            requestListeners.get("socket")?.(socket);
            socketListeners.get("lookup")?.(null, "198.51.100.7", calls === 1 ? 6 : 4, "provider.invalid");
            socketListeners.get("connectionAttempt")?.("198.51.100.7", 443, calls === 1 ? 6 : 4);
            if (calls === 2) socketListeners.get("connect")?.();
            requestListeners.get("error")?.(Object.assign(new Error("raw provider.invalid 198.51.100.7 secret-key"), {
              name: "AbortError",
              code: "ABORT_ERR",
            }));
          });
        },
      };
      return request;
    },
  }), (error) => {
    assert.equal(error.failureCategory, "NETWORK_CONNECT_TIMEOUT");
    assert.equal(error.attemptCount, 2);
    assert.deepEqual(error.transportAttempts, [
      { attemptCount: 1, failurePhase: "TCP_CONNECT", ipv4AttemptCount: 0, ipv6AttemptCount: 1 },
      { attemptCount: 2, failurePhase: "TLS_HANDSHAKE", ipv4AttemptCount: 1, ipv6AttemptCount: 0 },
    ]);
    assert.doesNotMatch(JSON.stringify(error.transportAttempts), /198\.51\.100|provider\.invalid|secret-key|raw/);
    return true;
  });
  assert.equal(calls, 2);
});

test("KASI native HTTPS는 lookup 전 두 abort를 DNS_LOOKUP phase로 닫는다", async () => {
  await assert.rejects(fetchKasiPublicHolidayCalendar({
    serviceKey: "test-key",
    year: 2026,
    months: [7],
    httpsRequestImpl: () => {
      const requestListeners = new Map();
      const request = {
        once(event, listener) { requestListeners.set(event, listener); return request; },
        end() {
          queueMicrotask(() => {
            const socket = { secureConnecting: true, once() { return socket; } };
            requestListeners.get("socket")?.(socket);
            requestListeners.get("error")?.(Object.assign(new Error("abort"), { name: "AbortError", code: "ABORT_ERR" }));
          });
        },
      };
      return request;
    },
  }), (error) => {
    assert.deepEqual(error.transportAttempts, [
      { attemptCount: 1, failurePhase: "DNS_LOOKUP", ipv4AttemptCount: 0, ipv6AttemptCount: 0 },
      { attemptCount: 2, failurePhase: "DNS_LOOKUP", ipv4AttemptCount: 0, ipv6AttemptCount: 0 },
    ]);
    return true;
  });
});

test("KASI native HTTPS는 TLS secureConnect 뒤 AbortError를 request timeout으로 fail closed하고 재시도하지 않는다", async () => {
  let calls = 0;
  await assert.rejects(fetchKasiPublicHolidayCalendar({
    serviceKey: "test-key",
    year: 2026,
    months: [7],
    httpsRequestImpl: () => {
      calls += 1;
      const requestListeners = new Map();
      const request = {
        once(event, listener) { requestListeners.set(event, listener); return request; },
        end() {
          queueMicrotask(() => {
            const socket = { secureConnecting: false, once() { return socket; } };
            requestListeners.get("socket")?.(socket);
            requestListeners.get("error")(Object.assign(new Error("abort"), { name: "AbortError", code: "ABORT_ERR" }));
          });
        },
      };
      return request;
    },
  }), (error) => {
    assert.equal(error.failureCategory, "NETWORK_REQUEST_TIMEOUT");
    assert.equal(error.attemptCount, 1);
    assert.deepEqual(error.transportAttempts, [
      { attemptCount: 1, failurePhase: "RESPONSE_HEADERS", ipv4AttemptCount: 0, ipv6AttemptCount: 0 },
    ]);
    return true;
  });
  assert.equal(calls, 1);
});

test("KASI native HTTPS는 non-2xx 응답을 즉시 KASI_HTTP으로 종료하고 body를 drain한다", async () => {
  let resumed = 0;
  let endListenerRegistered = false;
  let bodyCollected = false;
  await assert.rejects(fetchKasiPublicHolidayCalendar({
    serviceKey: "test-key",
    year: 2026,
    months: [7],
    httpsRequestImpl: (url, options, onResponse) => {
      const request = {
        once() { return request; },
        end() {
          queueMicrotask(() => onResponse({
            statusCode: 503,
            resume() { resumed += 1; },
            setEncoding() { bodyCollected = true; },
            once(event, listener) {
              if (event === "end") {
                endListenerRegistered = true;
                queueMicrotask(listener);
              }
              return this;
            },
            on() { bodyCollected = true; return this; },
          }));
        },
      };
      return request;
    },
  }), /KASI public holiday request failed: HTTP_503$/);
  assert.equal(resumed, 1);
  assert.equal(endListenerRegistered, false);
  assert.equal(bodyCollected, false);
});

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

test("KASI calendar는 connect timeout만 즉시 한 번 재시도한다", async () => {
  let calls = 0;
  const holidays = await fetchKasiPublicHolidayCalendar({
    serviceKey: "test-key",
    year: 2026,
    months: [7],
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error("connect timeout"), { code: "UND_ERR_CONNECT_TIMEOUT" });
      return new Response(holidayXml([{ date: "20260717", holiday: "Y" }]));
    },
  });
  assert.equal(calls, 2);
  assert.deepEqual([...holidays], ["20260717"]);
});

test("KASI calendar는 두 번째 connect timeout 후 closed attempt metadata를 유지한다", async () => {
  let calls = 0;
  await assert.rejects(fetchKasiPublicHolidayCalendar({
    serviceKey: "test-key",
    year: 2026,
    months: [7],
    fetchImpl: async () => {
      calls += 1;
      throw Object.assign(new Error("connect timeout"), { code: "UND_ERR_CONNECT_TIMEOUT" });
    },
  }), (error) => {
    assert.equal(error.failureCategory, "NETWORK_CONNECT_TIMEOUT");
    assert.equal(error.attemptCount, 2);
    return true;
  });
  assert.equal(calls, 2);
});

test("KASI calendar는 connect timeout 밖의 HTTP·schema·body failure를 재시도하지 않는다", async () => {
  const cases = [
    async () => new Response("denied", { status: 403 }),
    async () => new Response("not xml"),
    async () => ({ ok: true, text: async () => { throw Object.assign(new Error("raw body error"), { code: "ECONNRESET" }); } }),
  ];
  for (const fetchImpl of cases) {
    let calls = 0;
    await assert.rejects(fetchKasiPublicHolidayCalendar({
      serviceKey: "test-key",
      year: 2026,
      months: [7],
      fetchImpl: async (...args) => {
        calls += 1;
        return fetchImpl(...args);
      },
    }));
    assert.equal(calls, 1);
  }
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
