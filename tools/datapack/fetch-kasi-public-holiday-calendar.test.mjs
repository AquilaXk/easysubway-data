import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createTransientRetryBudget } from "./lib/transient-retry.mjs";
import { readKasiHolidayCalendarFiles, collectKasiHolidayCalendarFiles, collectKasiHolidayCalendarWindowFiles, fetchKasiPublicHolidayCalendar, fetchKasiPublicHolidayCalendarObservation, parseRetainedKasiHolidayMonth } from "./fetch-kasi-public-holiday-calendar.mjs";

// 재시도 대기와 예산을 테스트마다 격리한다(실제 1·2·4·8·16초를 기다리지 않고, 프로세스 공용 예산을 소모하지 않는다).
const retryFast = (waits = []) => ({ sleepImpl: async (milliseconds) => { waits.push(milliseconds); }, retryBudget: createTransientRetryBudget() });

test("KASI calendar는 유효한 year·months에서 malformed credential을 request URL·provider 호출 전에 거부한다", async () => {
  let calls = 0;
  await assert.rejects(fetchKasiPublicHolidayCalendar({ ...retryFast(), serviceKey: "invalid%ZZ", year: 2026, months: [7], fetchImpl: async () => { calls += 1; } }), /DATA_GO_KR_SERVICE_KEY is invalid/);
  assert.equal(calls, 0);
});

const holidayXml = (items, totalCount = items.length) => `<?xml version="1.0" encoding="UTF-8"?>
<response><header><resultCode>00</resultCode><resultMsg>OK</resultMsg></header><body><items>${items.map(({ date, holiday, name }) => `<item>${name === undefined ? "" : `<dateName>${name}</dateName>`}<locdate>${date}</locdate><isHoliday>${holiday}</isHoliday></item>`).join("")}</items><numOfRows>100</numOfRows><pageNo>1</pageNo><totalCount>${totalCount}</totalCount></body></response>`;

test("KASI window collects the exact cross-year months, stops before a manifest, and rejects invalid windows", async context => {
  const root = await mkdtemp(path.join(tmpdir(), "kasi-window-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  const outputDirectory = path.join(root, "complete");
  const fetchImpl = async (url) => {
    const year = url.searchParams.get("solYear"), month = url.searchParams.get("solMonth");
    calls.push(`${year}-${month}`);
    const date = `${year}${month}${month === "12" ? "31" : "01"}`;
    return { ok: true, status: 200, arrayBuffer: async () => Buffer.from(holidayXml([{ date, holiday: "Y" }])) };
  };
  const manifest = await collectKasiHolidayCalendarWindowFiles({
    outputDirectory, startDate: "20401231", endDate: "20410101", serviceKey: "test-key", fetchImpl,
  });
  assert.deepEqual(calls, ["2040-12", "2041-01"]);
  assert.deepEqual(manifest.months.map(({ year, month, file }) => [year, month, file]), [
    [2040, 12, "2040-12.xml"], [2041, 1, "2041-01.xml"],
  ]);
  const retained = await readKasiHolidayCalendarFiles(outputDirectory);
  assert.deepEqual(retained.months.map(entry => {
    const { year, month, holidayDates } = parseRetainedKasiHolidayMonth(entry);
    return [year, month, holidayDates];
  }), [
    [2040, 12, ["20401231"]], [2041, 1, ["20410101"]],
  ]);

  const failedDirectory = path.join(root, "failed");
  await assert.rejects(collectKasiHolidayCalendarWindowFiles({
    outputDirectory: failedDirectory, startDate: "20401231", endDate: "20410101", serviceKey: "test-key",
    fetchImpl: async (url) => url.searchParams.get("solYear") === "2041"
      ? { ok: false, status: 503 }
      : { ok: true, status: 200, arrayBuffer: async () => Buffer.from(holidayXml([{ date: "20401231", holiday: "Y" }])) },
  }), /HTTP_503/);
  assert.deepEqual(await readdir(failedDirectory), []);

  let invalidCalls = 0;
  await assert.rejects(collectKasiHolidayCalendarWindowFiles({
    outputDirectory: path.join(root, "invalid"), startDate: "20410101", endDate: "20401231", serviceKey: "test-key",
    fetchImpl: async () => { invalidCalls += 1; },
  }), /window is invalid/);
  assert.equal(invalidCalls, 0);
});

test("retained KASI month binds original bytes and reuses complete month validation", () => {
  const raw = Buffer.from(holidayXml([{ date: "20400102", holiday: "Y" }, { date: "20400103", holiday: "N" }]));
  const sha256 = createHash("sha256").update(raw).digest("hex");
  const input = { raw, sha256, year: 2040, month: 1 };
  assert.deepEqual(parseRetainedKasiHolidayMonth(input), {
    year: 2040, month: 1, rawSha256: sha256, rawByteLength: raw.length, holidayDates: ["20400102"], festivalDates: [],
  });
  assert.throws(() => parseRetainedKasiHolidayMonth({ ...input, sha256: "0".repeat(64) }), /digest/);
  assert.throws(() => parseRetainedKasiHolidayMonth({ ...input, month: 2 }), /month coverage/);
  const incomplete = Buffer.from(holidayXml([], 1));
  assert.throws(() => parseRetainedKasiHolidayMonth({ ...input, raw: incomplete,
    sha256: createHash("sha256").update(incomplete).digest("hex") }), /month coverage/);
});

test("retained KASI month는 설날·추석 이름의 공휴일을 명절 날짜로 따로 돌려준다(대체공휴일은 명절이 아니다, #913)", () => {
  const raw = Buffer.from(holidayXml([
    { date: "20400924", holiday: "Y", name: "추석" }, { date: "20400925", holiday: "Y", name: "추석" },
    { date: "20400926", holiday: "Y", name: "추석" }, { date: "20400928", holiday: "Y", name: "대체공휴일(추석)" },
    { date: "20400903", holiday: "Y", name: "개천절" },
  ]));
  const sha256 = createHash("sha256").update(raw).digest("hex");
  const parsed = parseRetainedKasiHolidayMonth({ raw, sha256, year: 2040, month: 9 });
  assert.deepEqual(parsed.holidayDates, ["20400903", "20400924", "20400925", "20400926", "20400928"]);
  assert.deepEqual(parsed.festivalDates, ["20400924", "20400925", "20400926"]);
});

test("KASI observation retains reusable monthly XML without an extra request", async () => {
  let calls = 0;
  const xml = holidayXml([{ date: "20400102", holiday: "Y" }]);
  const result = await fetchKasiPublicHolidayCalendarObservation({ ...retryFast(), serviceKey: "test-key", year: 2040, months: [1, 1],
    fetchImpl: async () => { calls += 1; return { ok: true, arrayBuffer: async () => Buffer.from(xml) }; } });
  assert.equal(calls, 1);
  assert.deepEqual([...result.holidays], ["20400102"]);
  assert.equal(result.months.length, 1);
  const month = result.months[0];
  assert.equal(month.xml, xml);
  assert.deepEqual(parseRetainedKasiHolidayMonth({ raw: month.raw, sha256: month.sha256,
    year: month.year, month: month.month }).holidayDates, ["20400102"]);
  assert.equal(Number.isFinite(Date.parse(month.retrievedAt)), true);
  assert.ok(!JSON.stringify(result).includes("test-key"));
});

test("KASI observation hashes and retains the exact BOM-prefixed response bytes", async () => {
  const xml = holidayXml([{ date: "20400102", holiday: "Y" }]);
  const raw = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(xml)]);
  const observation = await fetchKasiPublicHolidayCalendarObservation({ ...retryFast(), serviceKey: "test-key", year: 2040, months: [1],
    fetchImpl: async () => ({ ok: true, arrayBuffer: async () => raw }) });
  assert.deepEqual(observation.months[0].raw, raw);
  assert.equal(observation.months[0].sha256, createHash("sha256").update(raw).digest("hex"));
  const root = await mkdtemp(path.join(tmpdir(), "kasi-bom-test-"));
  try {
    const outputDirectory = path.join(root, "collection");
    await collectKasiHolidayCalendarFiles({ outputDirectory, serviceKey: "test-key", year: 2040, months: [1],
      fetchImpl: async () => ({ ok: true, arrayBuffer: async () => raw }) });
    assert.deepEqual(await readFile(path.join(outputDirectory, "2040-01.xml")), raw);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("KASI rejects malformed UTF-8 before it writes a success manifest", async () => {
  const raw = Buffer.from([0xc3, 0x28]);
  await assert.rejects(fetchKasiPublicHolidayCalendarObservation({ ...retryFast(), serviceKey: "test-key", year: 2040, months: [1],
    fetchImpl: async () => ({ ok: true, arrayBuffer: async () => raw }) }), { failureCategory: "KASI_SCHEMA", attemptCount: 1 });
  const root = await mkdtemp(path.join(tmpdir(), "kasi-utf8-test-"));
  try {
    const outputDirectory = path.join(root, "collection");
    await assert.rejects(collectKasiHolidayCalendarFiles({ outputDirectory, serviceKey: "test-key", year: 2040, months: [1],
      fetchImpl: async () => ({ ok: true, arrayBuffer: async () => raw }) }), { failureCategory: "KASI_SCHEMA", attemptCount: 1 });
    assert.deepEqual(await readdir(outputDirectory), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("KASI collection writes reusable files once and rejects an existing output before requests", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kasi-files-test-"));
  let calls = 0;
  const outputDirectory = path.join(root, "collection");
  const input = { outputDirectory, year: 2040, months: [1], serviceKey: "test-key",
    fetchImpl: async () => { calls += 1; return { ok: true, arrayBuffer: async () => Buffer.from(holidayXml([])) }; } };
  try {
    await collectKasiHolidayCalendarFiles(input);
    const manifest = JSON.parse(await readFile(path.join(outputDirectory, "months.json"), "utf8"));
    const month = manifest.months[0];
    const raw = await readFile(path.join(outputDirectory, month.file));
    assert.deepEqual(parseRetainedKasiHolidayMonth({ ...month, raw }).holidayDates, []);
    const retained = await readKasiHolidayCalendarFiles(outputDirectory);
    assert.deepEqual(retained.months, [{ ...month, raw }]);
    assert.equal(retained.manifestSha256, createHash("sha256").update(await readFile(path.join(outputDirectory, "months.json"))).digest("hex"));
    await assert.rejects(collectKasiHolidayCalendarFiles(input));
    assert.equal(calls, 1);
    await writeFile(path.join(outputDirectory, month.file), "changed");
    await assert.rejects(readKasiHolidayCalendarFiles(outputDirectory), /digest/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("KASI 기본 전송은 내장 HTTPS request seam으로 정확한 GET 요청을 한 번 종료한다", async () => {
  const requests = [];
  const holidays = await fetchKasiPublicHolidayCalendar({ ...retryFast(),
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
    await assert.rejects(fetchKasiPublicHolidayCalendar({ ...retryFast(),
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
      // ENOTFOUND는 고정된 공식 호스트의 DNS 일시 실패라 재시도 대상이다(#1099): 첫 시도 + 5번.
      transportAttempts: [1, 2, 3, 4, 5, 6].map((attemptCount) => ({ attemptCount, failurePhase: "DNS_LOOKUP", ipv4AttemptCount: 0, ipv6AttemptCount: 0 })),
    },
    {
      error: Object.assign(new Error("raw tls provider.invalid"), { code: "CERT_HAS_EXPIRED" }),
      beforeError(socketListeners) {
        socketListeners.get("lookup")?.(null, "198.51.100.9", 4, "provider.invalid");
        socketListeners.get("connectionAttempt")?.("198.51.100.9", 443, 4);
        socketListeners.get("connect")?.();
      },
      failureCategory: "NETWORK_TLS",
      // 인증서 오류는 같은 요청을 다시 보내도 풀리지 않으므로 재시도하지 않는다.
      transportAttempts: [{ attemptCount: 1, failurePhase: "TLS_HANDSHAKE", ipv4AttemptCount: 1, ipv6AttemptCount: 0 }],
    },
  ];
  for (const { error, beforeError, failureCategory, transportAttempts } of cases) {
    let calls = 0;
    await assert.rejects(fetchKasiPublicHolidayCalendar({ ...retryFast(),
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
      assert.deepEqual(failure.transportAttempts, transportAttempts);
      assert.equal(failure.attemptCount, transportAttempts.length);
      assert.doesNotMatch(JSON.stringify(failure.transportAttempts), /198\.51\.100|provider\.invalid|raw/);
      return true;
    });
    assert.equal(calls, transportAttempts.length);
  }
});

test("KASI native HTTPS는 TLS secureConnect 전 AbortError만 connect timeout으로 한 번 재시도한다", async () => {
  let calls = 0;
  const holidays = await fetchKasiPublicHolidayCalendar({ ...retryFast(),
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

test("KASI native HTTPS 최종 connect timeout은 여섯 attempt의 closed DNS·TCP·TLS phase와 family count만 보존한다", async () => {
  let calls = 0;
  await assert.rejects(fetchKasiPublicHolidayCalendar({ ...retryFast(),
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
            if (calls >= 2) socketListeners.get("connect")?.();
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
    assert.equal(error.attemptCount, 6);
    assert.deepEqual(error.transportAttempts, [
      { attemptCount: 1, failurePhase: "TCP_CONNECT", ipv4AttemptCount: 0, ipv6AttemptCount: 1 },
      ...[2, 3, 4, 5, 6].map((attemptCount) => ({ attemptCount, failurePhase: "TLS_HANDSHAKE", ipv4AttemptCount: 1, ipv6AttemptCount: 0 })),
    ]);
    assert.doesNotMatch(JSON.stringify(error.transportAttempts), /198\.51\.100|provider\.invalid|secret-key|raw/);
    return true;
  });
  assert.equal(calls, 6);
});

test("KASI native HTTPS는 lookup 전 abort를 시도마다 DNS_LOOKUP phase로 닫는다", async () => {
  await assert.rejects(fetchKasiPublicHolidayCalendar({ ...retryFast(),
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
    assert.deepEqual(error.transportAttempts, [1, 2, 3, 4, 5, 6].map((attemptCount) => ({ attemptCount, failurePhase: "DNS_LOOKUP", ipv4AttemptCount: 0, ipv6AttemptCount: 0 })));
    return true;
  });
});

test("KASI native HTTPS는 TLS secureConnect 뒤 AbortError도 request timeout으로 같은 요청을 5번 다시 보낸 뒤 fail closed한다", async () => {
  let calls = 0;
  await assert.rejects(fetchKasiPublicHolidayCalendar({ ...retryFast(),
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
    assert.equal(error.attemptCount, 6);
    assert.deepEqual(error.transportAttempts, [1, 2, 3, 4, 5, 6].map((attemptCount) => ({ attemptCount, failurePhase: "RESPONSE_HEADERS", ipv4AttemptCount: 0, ipv6AttemptCount: 0 })));
    return true;
  });
  assert.equal(calls, 6);
});

test("KASI native HTTPS는 5xx 응답을 다시 요청하고 한도 뒤 KASI_HTTP으로 종료하며 응답마다 body를 drain한다", async () => {
  let resumed = 0;
  let endListenerRegistered = false;
  let bodyCollected = false;
  await assert.rejects(fetchKasiPublicHolidayCalendar({ ...retryFast(),
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
  assert.equal(resumed, 6);
  assert.equal(endListenerRegistered, false);
  assert.equal(bodyCollected, false);
});

test("KASI 공휴일 달력은 요청 월 전체를 HTTPS 정본에서 가져와 휴일만 반환한다", async () => {
  const requests = [];
  const holidays = await fetchKasiPublicHolidayCalendar({ ...retryFast(),
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
  await fetchKasiPublicHolidayCalendar({ ...retryFast(),
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

test("KASI calendar는 connect timeout을 다시 요청해 성공하면 그 결과를 쓴다", async () => {
  let calls = 0;
  const holidays = await fetchKasiPublicHolidayCalendar({ ...retryFast(),
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

test("KASI calendar는 connect timeout이 끝까지 이어지면 여섯 번째 시도 뒤 closed attempt metadata를 유지한다", async () => {
  let calls = 0;
  await assert.rejects(fetchKasiPublicHolidayCalendar({ ...retryFast(),
    serviceKey: "test-key",
    year: 2026,
    months: [7],
    fetchImpl: async () => {
      calls += 1;
      throw Object.assign(new Error("connect timeout"), { code: "UND_ERR_CONNECT_TIMEOUT" });
    },
  }), (error) => {
    assert.equal(error.failureCategory, "NETWORK_CONNECT_TIMEOUT");
    assert.equal(error.attemptCount, 6);
    return true;
  });
  assert.equal(calls, 6);
});

test("KASI calendar는 권한·쿼터·형식 오류를 재시도하지 않는다(HTTP 401·403·429, resultCode 22·23·30·31, XML 형식)", async () => {
  const envelope = (code) => new Response(`<response><header><resultCode>${code}</resultCode></header></response>`);
  const cases = [
    [async () => new Response("denied", { status: 401 }), /HTTP_401/],
    [async () => new Response("denied", { status: 403 }), /HTTP_403/],
    [async () => new Response("slow down", { status: 429 }), /HTTP_429/],
    [async () => envelope("22"), /provider resultCode 22/],
    [async () => envelope("23"), /provider resultCode 23/],
    [async () => envelope("30"), /provider resultCode 30/],
    [async () => envelope("31"), /provider resultCode 31/],
    [async () => new Response("not xml"), /response schema is invalid/],
  ];
  for (const [fetchImpl, expectation] of cases) {
    let calls = 0;
    const waits = [];
    await assert.rejects(fetchKasiPublicHolidayCalendar({ ...retryFast(waits),
      serviceKey: "test-key",
      year: 2026,
      months: [7],
      fetchImpl: async (...args) => {
        calls += 1;
        return fetchImpl(...args);
      },
    }), expectation);
    assert.equal(calls, 1, String(expectation));
    assert.deepEqual(waits, []);
  }
});

// #1099: 2026-10-09T17:07Z source-reverification run 37963968732가 korail-planned-timetable/calendar에서 KASI 연결 타임아웃 두 번으로 전체가 실패했다.
test("KASI 연결 타임아웃이 두 번 이어져도 같은 요청을 다시 보내 성공하면 달력을 쓴다(run 37963968732 재현)", async () => {
  let calls = 0;
  const waits = [];
  const budget = createTransientRetryBudget();
  const holidays = await fetchKasiPublicHolidayCalendar({ sleepImpl: async (ms) => { waits.push(ms); }, retryBudget: budget,
    serviceKey: "test-key",
    year: 2026,
    months: [7],
    fetchImpl: async () => {
      calls += 1;
      if (calls <= 2) throw Object.assign(new Error("connect timeout"), { code: "UND_ERR_CONNECT_TIMEOUT" });
      return new Response(holidayXml([{ date: "20260717", holiday: "Y" }]));
    },
  });
  assert.deepEqual([...holidays], ["20260717"]);
  assert.equal(calls, 3);
  assert.deepEqual(waits, [1_000, 2_000]);
  assert.ok(budget.spentMs >= 3_000 && budget.spentMs < 3_500, "대기 합계 3초 + 시도 경과(테스트에서는 ~0ms)");
});

test("KASI HTTP 5xx와 resultCode 99는 같은 요청을 다시 보낸 뒤 성공하면 그 결과를 쓴다", async () => {
  const sequence = [
    new Response("busy", { status: 503 }),
    new Response("bad gateway", { status: 502 }),
    new Response("<response><header><resultCode>99</resultCode><resultMsg>UNKNOWN_ERROR.</resultMsg></header></response>"),
    new Response(holidayXml([{ date: "20260717", holiday: "Y" }])),
  ];
  const waits = [];
  let calls = 0;
  const observation = await fetchKasiPublicHolidayCalendarObservation({ ...retryFast(waits),
    serviceKey: "test-key",
    year: 2026,
    months: [7],
    fetchImpl: async () => { calls += 1; return sequence.shift(); },
  });
  assert.equal(calls, 4);
  assert.deepEqual(waits, [1_000, 2_000, 4_000]);
  assert.deepEqual([...observation.holidays], ["20260717"]);
  // 실패한 시도의 본문은 증거에 들어가지 않는다: 보관 원문은 성공한 응답 그대로다.
  assert.equal(observation.months.length, 1);
  assert.match(observation.months[0].xml, /<locdate>20260717<\/locdate>/);
  assert.doesNotMatch(observation.months[0].xml, /UNKNOWN_ERROR/);
});

test("KASI 본문 수신 중 timeout·연결 끊김도 같은 요청을 다시 보낸다", async () => {
  const outcomes = [
    () => { throw Object.assign(new TypeError("terminated"), { cause: Object.assign(new Error("body timeout"), { code: "UND_ERR_BODY_TIMEOUT" }) }); },
    () => { throw Object.assign(new Error("reset"), { code: "ECONNRESET" }); },
  ];
  let calls = 0;
  const holidays = await fetchKasiPublicHolidayCalendar({ ...retryFast(),
    serviceKey: "test-key",
    year: 2026,
    months: [7],
    fetchImpl: async () => {
      calls += 1;
      const next = outcomes.shift();
      if (next === undefined) return new Response(holidayXml([{ date: "20260717", holiday: "Y" }]));
      return { ok: true, arrayBuffer: async () => next() };
    },
  });
  assert.equal(calls, 3);
  assert.deepEqual([...holidays], ["20260717"]);

  let bodyCalls = 0;
  await assert.rejects(fetchKasiPublicHolidayCalendar({ ...retryFast(),
    serviceKey: "test-key",
    year: 2026,
    months: [7],
    fetchImpl: async () => { bodyCalls += 1; return { ok: true, arrayBuffer: async () => { throw Object.assign(new Error("body timeout"), { code: "UND_ERR_BODY_TIMEOUT" }); } }; },
  }), (error) => {
    assert.equal(error.failureCategory, "NETWORK_REQUEST_TIMEOUT");
    assert.equal(error.attemptCount, 6);
    return true;
  });
  assert.equal(bodyCalls, 6);
});

test("KASI HTTP 5xx가 끝까지 이어지면 1·2·4·8·16초 대기 뒤 KASI_HTTP으로 끝나고 이전 값으로 채우지 않는다", async () => {
  const waits = [];
  let calls = 0;
  await assert.rejects(fetchKasiPublicHolidayCalendar({ ...retryFast(waits),
    serviceKey: "test-key",
    year: 2026,
    months: [7],
    fetchImpl: async () => { calls += 1; return new Response("busy", { status: 503 }); },
  }), (error) => {
    assert.equal(error.failureCategory, "KASI_HTTP");
    assert.equal(error.attemptCount, 6);
    assert.match(error.message, /HTTP_503$/);
    return true;
  });
  assert.equal(calls, 6);
  assert.deepEqual(waits, [1_000, 2_000, 4_000, 8_000, 16_000]);
});

test("KASI 재시도 대기 예산(5분)을 넘기는 대기는 하지 않고 마지막 전송 오류 분류로 끝난다", async () => {
  const waits = [];
  let calls = 0;
  await assert.rejects(fetchKasiPublicHolidayCalendar({ sleepImpl: async (ms) => { waits.push(ms); }, retryBudget: createTransientRetryBudget(2_500),
    serviceKey: "test-key",
    year: 2026,
    months: [7],
    fetchImpl: async () => { calls += 1; throw Object.assign(new Error("connect timeout"), { code: "UND_ERR_CONNECT_TIMEOUT" }); },
  }), (error) => {
    assert.equal(error.failureCategory, "NETWORK_CONNECT_TIMEOUT");
    assert.equal(error.attemptCount, 2);
    return true;
  });
  assert.equal(calls, 2);
  assert.deepEqual(waits, [1_000]);
});

test("KASI 공휴일 달력은 권한·HTTP·XML·resultCode·월 범위 불일치를 fail closed한다", async () => {
  const run = (response) => fetchKasiPublicHolidayCalendar({ ...retryFast(),
    serviceKey: "secret-key",
    year: 2026,
    months: [7],
    fetchImpl: async () => response,
  });
  await assert.rejects(run(new Response("denied", { status: 403 })), /KASI public holiday request failed: HTTP_403/);
  await assert.rejects(run(new Response("<response><header><resultCode>30</resultCode></header></response>")), /KASI public holiday provider resultCode 30/);
  await assert.rejects(run(new Response("not xml")), /KASI public holiday response schema is invalid/);
  await assert.rejects(run(new Response(holidayXml([{ date: "20260801", holiday: "Y" }]))), /KASI public holiday response month coverage is invalid/);
  await assert.rejects(fetchKasiPublicHolidayCalendar({ ...retryFast(), serviceKey: "", year: 2026, months: [7] }), /DATA_GO_KR_SERVICE_KEY/);
  await assert.rejects(fetchKasiPublicHolidayCalendar({ ...retryFast(), serviceKey: "one\nline", year: 2026, months: [7] }), /DATA_GO_KR_SERVICE_KEY/);
  await assert.rejects(fetchKasiPublicHolidayCalendar({ ...retryFast(), serviceKey: "secret-key", year: 2026, months: [7], fetchImpl: async () => { throw new Error("network"); } }), /NETWORK/);
});

test("KASI transport 오류는 원문을 노출하지 않고 closed category로 분류한다", async () => {
  const runFetch = (error) => fetchKasiPublicHolidayCalendar({ ...retryFast(),
    serviceKey: "secret-key",
    year: 2026,
    months: [7],
    fetchImpl: async () => { throw error; },
  });
  const runBody = (error) => fetchKasiPublicHolidayCalendar({ ...retryFast(),
    serviceKey: "secret-key",
    year: 2026,
    months: [7],
    fetchImpl: async () => ({ ok: true, arrayBuffer: async () => { throw error; } }),
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
  assert.deepEqual([...await fetchKasiPublicHolidayCalendar({ ...retryFast(), serviceKey: "test-key", year: 2026, months: [7], fetchImpl: async () => new Response(empty) })], []);
  const missingItems = empty.replace("<items/>", "").replace("<totalCount>0</totalCount>", "<totalCount>1</totalCount>");
  await assert.rejects(fetchKasiPublicHolidayCalendar({ ...retryFast(), serviceKey: "test-key", year: 2026, months: [7], fetchImpl: async () => new Response(missingItems) }), /schema is invalid/);
});

test("#919 전국 후보 공휴일 목록(HOLIDAYS_2026)은 KASI 2026년 특일 정보 보관 원문의 공휴일과 같다", async () => {
  const { HOLIDAYS_2026 } = await import("./materialize-incheon-timetable.mjs");
  // 2026-10-04 실측: getRestDeInfo solYear=2026, solMonth=1~12 응답 원문(서비스 키는 응답에 없다).
  const directory = path.join(import.meta.dirname, "release/kasi-public-holiday-2026");
  const retained = await readKasiHolidayCalendarFiles(directory);
  assert.deepEqual(retained.months.map(({ year, month }) => `${year}-${month}`),
    Array.from({ length: 12 }, (_, index) => `2026-${index + 1}`));
  const kasiHolidays = retained.months.flatMap((entry) => parseRetainedKasiHolidayMonth(entry).holidayDates).sort();
  assert.deepEqual([...HOLIDAYS_2026], kasiHolidays);
  assert.equal(kasiHolidays.length, 22);
});

// #1099 리뷰 F1: 일시 상태(HTTP 503)에서 재시도 예산이 소진돼도 NETWORK_UNKNOWN이 아니라 마지막 응답의 HTTP 분류를 남긴다.
test("KASI HTTP 503에서 재시도 예산이 소진되면 마지막 응답의 KASI_HTTP 분류와 시도 수를 남긴다", async () => {
  let calls = 0;
  await assert.rejects(fetchKasiPublicHolidayCalendar({ sleepImpl: async () => {}, retryBudget: createTransientRetryBudget(2_500),
    serviceKey: "test-key", year: 2026, months: [7],
    fetchImpl: async () => { calls += 1; return new Response("busy", { status: 503 }); },
  }), (error) => {
    assert.equal(error.failureCategory, "KASI_HTTP");
    assert.equal(error.attemptCount, 2);
    assert.match(error.message, /HTTP_503$/);
    return true;
  });
  assert.equal(calls, 2);
});
