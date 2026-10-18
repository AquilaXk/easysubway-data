import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  assertErrorOmitsSecrets,
  defineBusanHumetroResultCodeRetryTests,
  defineSourceCollectionRetryTests,
} from "./lib/source-collection-retry-test-support.mjs";
import {
  collectBusanAccessibility,
  observedBusanAccessibilityRows,
  replayBusanAccessibility,
} from "./collect-busan-accessibility.mjs";

const topology = JSON.parse(await readFile(
  new URL("./sources/busan-transportation-route-topology-20260720.json", import.meta.url),
  "utf8",
));

const FIELDS = {
  wl_i: "0", wl_o: "0", el_i: "2", el_o: "1", es: "3", blindroad: "1",
  ourbridge: "1", helptake: "2", toilet: "1", toilet_gubun: "분리",
};

test("부산 accessibility collector는 malformed credential로 provider를 호출하지 않는다", async () => {
  let calls = 0;
  await assert.rejects(collectBusanAccessibility({ serviceKey: "invalid%ZZ", stationScopes: topology.scope, fetchImpl: async () => { calls += 1; } }), /DATA_GO_KR_SERVICE_KEY is invalid/);
  assert.equal(calls, 0);
});

function response(stationName, values = FIELDS) {
  const fields = Object.entries({ sname: stationName, ...values })
    .map(([name, value]) => `<${name}>${value}</${name}>`).join("");
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><response>
    <header><resultCode>00</resultCode><resultMsg>정상</resultMsg></header>
    <body>${fields}</body></response>`, { headers: { "content-type": "application/xml" } });
}

test("부산 accessibility collector는 topology 114개 역을 bounded fan-out한다", async () => {
  const requested = [];
  const originalBytes = new Map();
  const secret = "never-print-service-key";
  const snapshot = await collectBusanAccessibility({
    serviceKey: secret,
    stationScopes: topology.scope,
    now: new Date("2026-07-20T10:30:00.000Z"),
    fetchImpl: async (url) => {
      const request = new URL(url);
      requested.push(request);
      const station = topology.scope.find(({ stationCode }) => stationCode === request.searchParams.get("scode"));
      const result = response(station.stationName);
      originalBytes.set(station.stationCode, Buffer.from(await result.clone().arrayBuffer()));
      return result;
    },
  });

  assert.equal(requested.length, 114);
  assert.equal(snapshot.requestCount, 114);
  assert.equal(snapshot.stationCount, 114);
  assert.equal(snapshot.rowCount, 114);
  assert.deepEqual([...requested[0].searchParams], [
    ["serviceKey", secret], ["act", "xml"], ["scode", topology.scope[0].stationCode],
  ]);
  assert.deepEqual(snapshot.lineIds, topology.lineIds);
  assert.equal(snapshot.credentialRedacted, true);
  assert.match(snapshot.rowsSha256, /^[a-f0-9]{64}$/);
  assert.match(snapshot.rawSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(snapshot.rawResponses.map(({ stationCode }) => stationCode), snapshot.scope.map(({ stationCode }) => stationCode));
  for (const retained of snapshot.rawResponses) {
    const original = originalBytes.get(retained.stationCode);
    assert.deepEqual(Buffer.from(retained.bytesBase64, "base64"), original);
    assert.equal(retained.rawSha256, createHash("sha256").update(original).digest("hex"));
  }
  assert.equal(snapshot.rawSha256, createHash("sha256").update(JSON.stringify(
    snapshot.rawResponses.map(({ stationCode, rawSha256 }) => ({ stationCode, rawSha256 })),
  )).digest("hex"));
  assert.doesNotMatch(JSON.stringify(snapshot), new RegExp(secret));
  assert.deepEqual(replayBusanAccessibility({
    rawResponses: snapshot.rawResponses, stationScopes: topology.scope, now: new Date(snapshot.capturedAt),
  }), snapshot);
  assert.deepEqual(snapshot.rows[0], {
    stationCode: topology.scope[0].stationCode,
    stationName: topology.scope[0].stationName,
    lineId: topology.scope[0].lineId,
    ...Object.fromEntries(Object.entries(FIELDS).map(([name, value]) => [name, name === "toilet_gubun" ? value : Number(value)])),
  });
});

test("부산 accessibility collector는 누락·음수 시설 값을 fail closed한다", async () => {
  await assert.rejects(collectBusanAccessibility({
    serviceKey: "key",
    stationScopes: topology.scope,
    fetchImpl: async () => response("역", { ...FIELDS, el_i: "-1" }),
  }), /values=el_i/);
  const { toilet: _toilet, ...missing } = FIELDS;
  await assert.rejects(collectBusanAccessibility({
    serviceKey: "key",
    stationScopes: topology.scope,
    fetchImpl: async () => response("역", missing),
  }), /fields=toilet/);
});

test("부산 accessibility collector는 빈 count 필드를 0이 아닌 미관측(null)으로 남긴다", async () => {
  const snapshot = await collectBusanAccessibility({
    serviceKey: "key",
    stationScopes: topology.scope,
    now: new Date("2026-07-24T00:00:00.000Z"),
    fetchImpl: async () => response("다대포해수욕장", {
      ...FIELDS,
      wl_i: "",
      wl_o: "",
      ourbridge: "",
      helptake: "",
    }),
  });
  assert.equal(snapshot.rows[0].wl_i, null);
  assert.equal(snapshot.rows[0].wl_o, null);
  assert.equal(snapshot.rows[0].ourbridge, null);
  assert.equal(snapshot.rows[0].helptake, null);
  assert.equal(snapshot.rows[0].el_i, 2);
  assert.equal(snapshot.rows[0].es, 3);
});

test("부산 보존 원문 재판정은 명시적 0과 빈 필드를 구분하고 저장 row 변조를 거부한다", async () => {
  const snapshot = await collectBusanAccessibility({
    serviceKey: "key",
    stationScopes: topology.scope,
    now: new Date("2026-07-24T00:00:00.000Z"),
    fetchImpl: async () => response("다대포해수욕장", { ...FIELDS, wl_i: "", wl_o: "" }),
  });
  const observed = observedBusanAccessibilityRows(snapshot);
  assert.equal(observed[0].wl_i, null);
  assert.equal(observed[0].el_i, 2);

  // 이전 수집기는 빈 필드를 0으로 저장했다. 원문이 빈 값이면 그 0은 관측값이 아니다.
  const legacy = structuredClone(snapshot);
  legacy.rows = legacy.rows.map((row) => ({ ...row, wl_i: 0, wl_o: 0 }));
  assert.equal(observedBusanAccessibilityRows(legacy)[0].wl_i, null);

  const tampered = structuredClone(snapshot);
  tampered.rows[0].el_i = 0;
  assert.throws(() => observedBusanAccessibilityRows(tampered), /retained raw count mismatch/);
  const missingRaw = structuredClone(snapshot);
  delete missingRaw.rawResponses;
  assert.throws(() => observedBusanAccessibilityRows(missingRaw), /retained raw responses are required/);
});

test("부산 accessibility collector는 credential 없는 provider·transport 진단만 남긴다", async () => {
  const secret = "never-print-service-key";
  const providerDetail = "SERVICE_KEY_NOT_REGISTERED";
  await assert.rejects(collectBusanAccessibility({
    serviceKey: secret,
    stationScopes: topology.scope,
    fetchImpl: async () => new Response((await response("역").text()).replace("정상", secret), {
      headers: { "content-type": "application/xml" },
    }),
  }), (error) => {
    assert.match(error.message, /credential echo/);
    assert.doesNotMatch(error.message, new RegExp(secret));
    return true;
  });
  await assert.rejects(collectBusanAccessibility({
    serviceKey: secret,
    stationScopes: topology.scope,
    sleepImpl: async () => {},
    fetchImpl: async () => new Response(`<?xml version="1.0"?><response>
      <header><resultCode>30</resultCode><resultMsg>${providerDetail}</resultMsg></header></response>`, {
      headers: { "content-type": "application/xml" },
    }),
  }), (error) => {
    assert.match(error.message, /provider resultCode 30/);
    assert.doesNotMatch(error.message, new RegExp(secret));
    assert.doesNotMatch(error.message, new RegExp(providerDetail));
    return true;
  });
  const transport = Object.assign(new Error(`secret ${secret}`), { code: "ENOTFOUND" });
  await assert.rejects(collectBusanAccessibility({
    serviceKey: secret,
    stationScopes: topology.scope,
    sleepImpl: async () => {},
    fetchImpl: async () => { throw transport; },
  }), (error) => {
    assert.match(error.message, /transport failure; code=ENOTFOUND/);
    assert.doesNotMatch(error.message, new RegExp(secret));
    return true;
  });
});

const stationResponse = (url) => response(topology.scope.find(({ stationCode }) => stationCode === new URL(url).searchParams.get("scode")).stationName);
const collectWith = ({ fetchImpl, sleepImpl = async () => {}, serviceKey = "fixture-key" }) => collectBusanAccessibility({
  serviceKey,
  concurrency: 1,
  stationScopes: topology.scope,
  now: new Date("2026-07-20T10:30:00.000Z"),
  fetchImpl,
  sleepImpl,
  randomImpl: () => 0,
});

defineSourceCollectionRetryTests({
  name: "부산 accessibility collector",
  httpError: /Busan accessibility HTTP 403/,
  delegate: stationResponse,
  headers: { "content-type": "application/xml" },
  run: ({ fetchImpl, sleepImpl }) => collectWith({ fetchImpl, sleepImpl }),
});

const envelopeResponse = (code) => new Response(
  `<?xml version="1.0"?><response><header><resultCode>${code}</resultCode><resultMsg>x</resultMsg></header></response>`,
  { headers: { "content-type": "application/xml" } },
);

// 부산교통공사 게이트웨이는 data.go.kr가 아니라 resultCode 30·99만 일시로 본다.
defineBusanHumetroResultCodeRetryTests({
  name: "부산 accessibility collector",
  delegate: stationResponse,
  rejectedResponse: envelopeResponse,
  run: ({ fetchImpl }) => collectWith({ fetchImpl }),
  assertRecovered: (snapshot) => assert.equal(snapshot.requestCount, 114),
  assertFinal: (outcome, resultCode) => assert.rejects(outcome, new RegExp(`provider resultCode ${resultCode}; rawSha256=[a-f0-9]{64}`)),
});

test("부산 accessibility collector는 HTTP 429를 Retry-After 유무로 가른다: 힌트가 없으면 1회만, cap(20초) 초과면 기다리지 않고 실패한다", async () => {
  let unhinted = 0;
  await assert.rejects(collectWith({ fetchImpl: async () => { unhinted += 1; return new Response("slow", { status: 429 }); } }), /Busan accessibility HTTP 429/);
  assert.equal(unhinted, 2);

  const waits = [];
  let hinted = 0;
  await assert.rejects(collectWith({
    sleepImpl: async (milliseconds) => { waits.push(milliseconds); },
    fetchImpl: async () => { hinted += 1; return new Response("slow", { status: 429, headers: { "retry-after": "21" } }); },
  }), /RETRY_AFTER_EXCEEDS_CAP/);
  assert.equal(hinted, 1);
  assert.deepEqual(waits, []);
});

test("부산 accessibility collector는 소진된 재시도 오류에 인증키·URL을 싣지 않는다", async () => {
  const serviceKey = "SECRETKEY0123456789abcdef";
  const echoed = (url) => new Response(`busy ${url}`, { status: 503 });
  const exhaustedStatus = await collectWith({ serviceKey, fetchImpl: async (url) => echoed(url) }).catch((error) => error);
  assert.match(exhaustedStatus.message, /Busan accessibility HTTP 503; rawBytes=\d+; rawSha256=[a-f0-9]{64}/);
  assertErrorOmitsSecrets(exhaustedStatus, [serviceKey, encodeURIComponent(serviceKey), "data.humetro.busan.kr"]);

  const leaky = async (url) => { throw Object.assign(new Error(`connect failed ${url}`), { code: "ECONNRESET", cause: { url: String(url) } }); };
  const exhaustedTransport = await collectWith({ serviceKey, fetchImpl: leaky }).catch((error) => error);
  assert.match(exhaustedTransport.message, /transport failure; code=ECONNRESET/);
  assertErrorOmitsSecrets(exhaustedTransport, [serviceKey, encodeURIComponent(serviceKey), "data.humetro.busan.kr"]);
});
