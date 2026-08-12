import assert from "node:assert/strict";
import test from "node:test";

import {
  createProviderResponseContinuation,
  createProviderResponseRecorder,
  createProviderResponseReplay,
  providerResponseCaptureBytes,
} from "./provider-response-capture.mjs";

const OBSERVED_AT = "2026-08-12T00:00:00.000Z";
const SERVICE_DATES = Object.freeze({ "7": "20260822", "8": "20260812", "9": "20260816" });

function request(operation, serviceKey = "secret-key") {
  return `https://apis.data.go.kr/1613000/TrainInfo/${operation}?serviceKey=${serviceKey}&_type=json&depPlandTime=20260812&arrPlaceId=NAT1401&depPlaceId=NAT1301`;
}

test("provider response를 한 번 기록하고 exact 순서로 network 0 replay한다", async () => {
  let upstreamCalls = 0;
  const recorder = createProviderResponseRecorder({
    observedAt: OBSERVED_AT,
    selectedServiceDates: SERVICE_DATES,
    fetchImpl: async () => {
      upstreamCalls += 1;
      return new Response(JSON.stringify({ response: { header: { resultCode: "00" }, body: { items: { item: [{ trainno: "2001" }] } } } }), {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "x-provider-secret": "must-not-be-captured",
        },
      });
    },
  });

  const liveResponse = await recorder.fetchImpl(request("GetStrtpntAlocFndTrainInfo"), {
    method: "GET",
    headers: { "x-client-mode": "capture" },
  });
  assert.equal(liveResponse.status, 200);
  assert.match(await liveResponse.text(), /2001/);
  assert.equal(upstreamCalls, 1);

  const capture = recorder.captureArtifact();
  const bytes = providerResponseCaptureBytes(capture);
  assert.equal(capture.requestCount, 1);
  assert.equal(capture.selectedServiceDates["8"], "20260812");
  assert.doesNotMatch(bytes.toString("utf8"), /secret-key|raw-secret|x-provider-secret|must-not-be-captured|serviceKey/);

  const replay = createProviderResponseReplay({ captureBytes: bytes });
  const replayed = await replay.fetchImpl(request("GetStrtpntAlocFndTrainInfo", "different-runtime-key"), { method: "GET" });
  assert.equal(replayed.status, 200);
  assert.match(await replayed.text(), /2001/);
  replay.assertExhausted();
  assert.equal(upstreamCalls, 1);
});

test("continuation은 capture를 identity별 exact-once replay하고 uncaptured Korail만 live 허용한다", async () => {
  const recorder = createProviderResponseRecorder({
    observedAt: OBSERVED_AT,
    selectedServiceDates: SERVICE_DATES,
    fetchImpl: async (url) => new Response(new URL(url).pathname.split("/").at(-1)),
  });
  await recorder.fetchImpl(request("GetVhcleKndList"));
  await recorder.fetchImpl(request("GetCtyCodeList"));
  await recorder.fetchImpl(request("GetVhcleKndList"));

  let liveCalls = 0;
  const continuation = createProviderResponseContinuation({
    captureBytes: providerResponseCaptureBytes(recorder.captureArtifact()),
    allowLiveRequest: ({ path: requestPath }) => [
      "/B551457/run/v2/codes2",
      "/B551457/run/v2/travelerTrainRunPlan2",
      "/B551457/run/v2/travelerTrainRunInfo2",
    ].includes(requestPath),
    liveFetchImpl: async (url) => {
      liveCalls += 1;
      return new Response(`live:${new URL(url).pathname}`);
    },
  });

  assert.equal(await (await continuation.fetchImpl(request("GetCtyCodeList", "runtime-key"))).text(), "GetCtyCodeList");
  assert.equal(await (await continuation.fetchImpl(request("GetVhcleKndList", "runtime-key"))).text(), "GetVhcleKndList");
  assert.equal(await (await continuation.fetchImpl(request("GetVhcleKndList", "runtime-key"))).text(), "GetVhcleKndList");
  await assert.rejects(
    continuation.fetchImpl(request("GetVhcleKndList", "runtime-key")),
    /captured request over-consumed/,
  );
  assert.equal(liveCalls, 0);

  const korailUrl = "https://apis.data.go.kr/B551457/run/v2/codes2?serviceKey=runtime-key&returnType=JSON";
  assert.equal(await (await continuation.fetchImpl(korailUrl)).text(), "live:/B551457/run/v2/codes2");
  assert.equal(liveCalls, 1);
  await assert.rejects(
    continuation.fetchImpl(request("GetStrtpntAlocFndTrainInfo", "runtime-key")),
    /uncaptured request is not allowed/,
  );
  assert.equal(liveCalls, 1);
  continuation.assertExhausted();
  assert.deepEqual(continuation.summary(), {
    baseContentSha256: recorder.captureArtifact().contentSha256,
    baseRequestCount: 3,
    replayedRequestCount: 3,
    liveRequestCount: 1,
  });
});

test("replay는 reordered, missing, extra request와 capture tamper를 fail closed한다", async () => {
  const recorder = createProviderResponseRecorder({
    observedAt: OBSERVED_AT,
    selectedServiceDates: SERVICE_DATES,
    fetchImpl: async (url) => new Response(JSON.stringify({ path: new URL(url).pathname }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  });
  await recorder.fetchImpl(request("GetVhcleKndList"));
  await recorder.fetchImpl(request("GetCtyCodeList"));
  const capture = recorder.captureArtifact();
  const bytes = providerResponseCaptureBytes(capture);

  const reordered = createProviderResponseReplay({ captureBytes: bytes });
  await assert.rejects(reordered.fetchImpl(request("GetCtyCodeList")), /provider replay request mismatch/);

  const missing = createProviderResponseReplay({ captureBytes: bytes });
  await missing.fetchImpl(request("GetVhcleKndList"));
  assert.throws(() => missing.assertExhausted(), /provider replay has 1 unconsumed record/);

  const extra = createProviderResponseReplay({ captureBytes: bytes });
  await extra.fetchImpl(request("GetVhcleKndList"));
  await extra.fetchImpl(request("GetCtyCodeList"));
  await assert.rejects(extra.fetchImpl(request("GetCtyCodeList")), /provider replay is exhausted/);

  const digestTamper = structuredClone(capture);
  digestTamper.records[0].outcome.response.status = 503;
  assert.throws(
    () => createProviderResponseReplay({ captureBytes: Buffer.from(`${JSON.stringify(digestTamper, null, 2)}\n`) }),
    /provider capture content digest mismatch/,
  );

  const bodyTamper = structuredClone(capture);
  bodyTamper.records[0].outcome.response.bodyBase64 = Buffer.from("tampered").toString("base64");
  bodyTamper.contentSha256 = capture.contentSha256;
  assert.throws(
    () => createProviderResponseReplay({ captureBytes: Buffer.from(`${JSON.stringify(bodyTamper, null, 2)}\n`) }),
    /provider capture content digest mismatch|provider capture body digest mismatch/,
  );
});

test("recorder는 official GET와 bounded record/body만 허용한다", async () => {
  const recorder = createProviderResponseRecorder({
    observedAt: OBSERVED_AT,
    selectedServiceDates: SERVICE_DATES,
    maxRecords: 1,
    maxBodyBytes: 8,
    fetchImpl: async () => new Response("12345678", { status: 200, headers: { "content-type": "text/plain" } }),
  });

  await assert.rejects(recorder.fetchImpl("https://example.com/provider?serviceKey=secret"), /provider request origin is not allowed/);
  await assert.rejects(recorder.fetchImpl(request("GetVhcleKndList"), { method: "POST" }), /provider request method must be GET/);
  await recorder.fetchImpl(request("GetVhcleKndList"));
  await assert.rejects(recorder.fetchImpl(request("GetCtyCodeList")), /provider capture record limit exceeded/);

  const oversized = createProviderResponseRecorder({
    observedAt: OBSERVED_AT,
    selectedServiceDates: SERVICE_DATES,
    maxBodyBytes: 7,
    fetchImpl: async () => new Response("12345678", { status: 200, headers: { "content-type": "text/plain" } }),
  });
  await assert.rejects(oversized.fetchImpl(request("GetVhcleKndList")), /provider capture body limit exceeded/);
  assert.equal(oversized.captureArtifact().bodyBytes, 0);
  assert.equal(oversized.captureArtifact().records[0].outcome.kind, "TRANSPORT_FAILURE");

  const credentialEcho = createProviderResponseRecorder({
    observedAt: OBSERVED_AT,
    selectedServiceDates: SERVICE_DATES,
    fetchImpl: async () => new Response("provider echoed secret-key", {
      status: 200,
      headers: { "content-type": "text/plain" },
    }),
  });
  await assert.rejects(
    credentialEcho.fetchImpl(request("GetVhcleKndList")),
    /provider capture credential echo rejected/,
  );
  const rejectedCapture = credentialEcho.captureArtifact();
  assert.equal(rejectedCapture.bodyBytes, 0);
  assert.equal(rejectedCapture.records[0].outcome.kind, "TRANSPORT_FAILURE");
});

test("recorder는 credential header를 upstream 전에 거부한다", async () => {
  let upstreamCalls = 0;
  const recorder = createProviderResponseRecorder({
    observedAt: OBSERVED_AT,
    selectedServiceDates: SERVICE_DATES,
    fetchImpl: async () => {
      upstreamCalls += 1;
      return new Response("Bearer raw-header-secret");
    },
  });

  await assert.rejects(
    recorder.fetchImpl(request("GetVhcleKndList"), { headers: { authorization: "Bearer raw-header-secret" } }),
    /provider request credential header is not allowed/,
  );
  assert.equal(upstreamCalls, 0);
  const capture = recorder.captureArtifact();
  assert.equal(capture.requestCount, 0);
  assert.doesNotMatch(providerResponseCaptureBytes(capture).toString("utf8"), /raw-header-secret|authorization/i);
});

test("concurrent capture는 invocation order로 slot을 예약하고 record limit을 지킨다", async () => {
  const completions = [];
  const recorder = createProviderResponseRecorder({
    observedAt: OBSERVED_AT,
    selectedServiceDates: SERVICE_DATES,
    maxRecords: 2,
    fetchImpl: async () => new Promise((resolve) => completions.push(resolve)),
  });

  const first = recorder.fetchImpl(request("GetVhcleKndList"));
  const second = recorder.fetchImpl(request("GetCtyCodeList"));
  await assert.rejects(recorder.fetchImpl(request("GetStrtpntAlocFndTrainInfo")), /provider capture record limit exceeded/);
  completions[1](new Response("second"));
  await second;
  completions[0](new Response("first"));
  await first;

  const capture = recorder.captureArtifact();
  assert.deepEqual(capture.records.map(({ request: value }) => value.path.split("/").at(-1)), [
    "GetVhcleKndList",
    "GetCtyCodeList",
  ]);
  const replay = createProviderResponseReplay({ captureBytes: providerResponseCaptureBytes(capture) });
  assert.equal(await (await replay.fetchImpl(request("GetVhcleKndList"))).text(), "first");
  assert.equal(await (await replay.fetchImpl(request("GetCtyCodeList"))).text(), "second");
  replay.assertExhausted();
});

test("response body stream 실패도 sanitized transport failure로 capture한다", async () => {
  const recorder = createProviderResponseRecorder({
    observedAt: OBSERVED_AT,
    selectedServiceDates: SERVICE_DATES,
    fetchImpl: async () => new Response(new ReadableStream({
      start(controller) {
        controller.error(new Error("provider body stream failed"));
      },
    })),
  });

  await assert.rejects(recorder.fetchImpl(request("GetVhcleKndList")), /provider body stream failed/);
  const capture = recorder.captureArtifact();
  assert.equal(capture.requestCount, 1);
  assert.equal(capture.bodyBytes, 0);
  assert.deepEqual(capture.records[0].outcome, { kind: "TRANSPORT_FAILURE" });
});
