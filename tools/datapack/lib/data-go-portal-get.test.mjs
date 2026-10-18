import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { REQUEST_TIMEOUT_MS, USER_AGENT } from "./data-go-file-download.mjs";
import { getDataGoPortalBytes } from "./data-go-portal-get.mjs";

const retry = { sleepImpl: async () => {}, randomImpl: () => 0 };

test("포털 GET은 리다이렉트를 따르지 않는 요청 옵션과 60초 timeout, 공용 User-Agent·Referer를 보낸다", async (context) => {
  const timeouts = [];
  const realTimeout = AbortSignal.timeout.bind(AbortSignal);
  context.mock.method(AbortSignal, "timeout", (milliseconds) => { timeouts.push(milliseconds); return realTimeout(milliseconds); });
  let sent;
  const { bytes } = await getDataGoPortalBytes({
    url: "https://www.data.go.kr/cmm/cmm/fileDownload.do", label: "Sample", referer: "https://www.data.go.kr/data/1/fileData.do", retry,
    fetchImpl: async (_url, init) => { sent = init; return new Response("ok"); },
  });
  assert.equal(bytes.toString("utf8"), "ok");
  assert.equal(REQUEST_TIMEOUT_MS, 60_000);
  assert.deepEqual(timeouts, [REQUEST_TIMEOUT_MS]);
  assert.equal(sent.redirect, "error");
  assert.ok(sent.signal instanceof AbortSignal);
  assert.deepEqual(sent.headers, { accept: "*/*", "User-Agent": USER_AGENT, Referer: "https://www.data.go.kr/data/1/fileData.do" });
});

test("포털이 리다이렉트(3xx)로 답하면 따라가지 않고 재시도 없이 명시적으로 실패한다", async (context) => {
  let requests = 0;
  const server = createServer((request, response) => {
    requests += 1;
    response.writeHead(302, { location: "https://elsewhere.invalid/file" }).end();
  });
  await new Promise((resolve) => { server.listen(0, "127.0.0.1", resolve); });
  context.after(() => server.close());
  const failure = await getDataGoPortalBytes({
    url: `http://127.0.0.1:${server.address().port}/cmm/cmm/fileDownload.do`, fetchImpl: fetch, label: "Sample", retry,
  }).catch((error) => error);
  assert.match(failure.message, /^Sample transport failure; code=/u);
  assert.equal(requests, 1);
});
