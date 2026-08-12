import assert from "node:assert/strict";
import test from "node:test";

import {
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
    headers: { authorization: "Bearer raw-secret" },
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
});
