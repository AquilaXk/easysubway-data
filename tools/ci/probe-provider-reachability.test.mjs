import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { PROBE_PROVIDERS, buildProbes, main, probeProviders, renderSummary, runProbe, summarizeProbes } from "./probe-provider-reachability.mjs";

// #984: P7D 재확인 recipe가 부르는 공급자(grtc·humetro·data.go.kr·korail.com·kric)가 GitHub 호스팅 runner에서 열리는지 읽기 전용으로 잰다.
// 키·토큰을 보내지 않고 GET만 한다. 닿지 않는 공급자는 대체 경로 없이 그대로 보고한다(인프라 결정은 이 도구가 하지 않는다).
const root = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const XLSX = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]);

const response = (status, body = "", headers = {}) => new Response(body, { status, headers });
const refused = () => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }) });

// 요청 URL로 가짜 공급자를 흉내 낸다. 데이터 파일 다운로드(data.go.kr 3단계)는 실제 공용 모듈이 부르므로 같은 흐름을 따라 준다.
function providerFetch({ down = [], overrides = {} } = {}) {
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    const url = String(input instanceof URL ? input.href : input);
    calls.push({ url, init });
    const host = new URL(url).hostname;
    if (down.includes(host)) throw refused();
    if (url in overrides) return overrides[url]();
    if (host === "www.grtc.co.kr") return response(200, JSON.stringify([{ ok: 1 }]), { "content-type": "application/json" });
    // 부산교통공사 응용 서버는 키 없는 요청에 자기 오류 페이지(HTTP 500)로 답한다. 실제 runner 측정과 로컬 curl이 같았다.
    if (host === "data.humetro.busan.kr") return response(500, '<html><body><img src="/voc/admin/images/error1.jpg" alt="Error Page!"/></body></html>', { "content-type": "text/html; charset=euc-kr" });
    if (host === "www2.humetro.busan.kr") return response(200, "<html>ok</html>", { "content-type": "text/html" });
    if (host === "www.data.go.kr") return response(200, "<html>detail</html>", { "content-type": "text/html" });
    if (host === "apis.data.go.kr") return response(401, "Unauthorized");
    if (host === "www.korail.com") return url.endsWith(".xlsx") ? response(200, XLSX, { "content-type": "application/octet-stream" }) : response(200, "<html>ok</html>", { "content-type": "text/html" });
    if (host === "data.kric.go.kr") return response(200, XLSX, { "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    if (host === "openapi.kric.go.kr") return response(200, "<error/>", { "content-type": "text/xml" });
    throw new Error(`unexpected request ${url}`);
  };
  return { fetchImpl, calls };
}

test("공급자는 recipe가 부르는 다섯 곳이다", () => {
  assert.deepEqual([...PROBE_PROVIDERS], ["grtc", "humetro", "data.go.kr", "korail.com", "kric"]);
});

test("프로브 목록은 저장소의 실제 원천 증거(광주 역 범위·코레일 원본 URL)에서 만들고 공급자마다 하나 이상이다", async () => {
  const probes = await buildProbes({ repositoryRoot: root });
  assert.deepEqual([...new Set(probes.map(({ provider }) => provider))], [...PROBE_PROVIDERS]);
  const byId = new Map(probes.map((probe) => [`${probe.provider}/${probe.id}`, probe]));
  assert.match(byId.get("grtc/station-time-info").url, /^https:\/\/www\.grtc\.co\.kr\/subway\/openapi\/json\/stationTimeInfomation\?station_id=[A-Za-z0-9]+$/u);
  assert.match(byId.get("korail.com/timetable-file").url, /^https:\/\/www\.korail\.com\/file\/cubedata\/COMMON\/jfile\/.+\.xlsx$/u);
  assert.equal(byId.get("kric/station-line-file").url, "https://data.kric.go.kr/rips/dataset/download.file?type=filedata&id=1294&operation=1");
  assert.equal(byId.get("data.go.kr/file-download").kind, "data-go-download");
  assert.equal(byId.get("data.go.kr/file-download").datasetId, "15041384");
  assert.equal(byId.get("humetro/open-api-host").url.startsWith("http://data.humetro.busan.kr/"), true);
  // 키·토큰을 URL에 넣지 않는다.
  for (const { url } of probes.filter(({ url: value }) => value)) assert.doesNotMatch(url, /service[_-]?key|api[_-]?key|token|authorization/iu, url);
});

test("모든 공급자가 열리면 REACHABLE이고, 요청에는 인증 정보가 없다", async () => {
  const probes = await buildProbes({ repositoryRoot: root });
  const { fetchImpl, calls } = providerFetch();
  const results = await probeProviders({ probes: probes.filter(({ kind }) => kind !== "data-go-download"), fetchImpl });
  const summary = summarizeProbes(results);
  assert.equal(summary.reachable, true);
  assert.deepEqual(summary.providers.map(({ provider, verdict }) => [provider, verdict]), [["grtc", "REACHABLE"], ["humetro", "REACHABLE"], ["data.go.kr", "REACHABLE"], ["korail.com", "REACHABLE"], ["kric", "REACHABLE"]]);
  for (const { init } of calls) {
    assert.equal(init.method ?? "GET", "GET");
    assert.equal(Object.keys(init.headers ?? {}).some((name) => /authorization|cookie|x-api-key/iu.test(name)), false);
  }
});

test("DNS·연결 실패는 오류 코드와 함께 UNREACHABLE로 드러나고 다른 공급자 측정은 계속된다", async () => {
  const probes = (await buildProbes({ repositoryRoot: root })).filter(({ kind }) => kind !== "data-go-download");
  const { fetchImpl } = providerFetch({ down: ["www.grtc.co.kr"] });
  const summary = summarizeProbes(await probeProviders({ probes, fetchImpl }));
  assert.equal(summary.reachable, false);
  const grtc = summary.providers.find(({ provider }) => provider === "grtc");
  assert.equal(grtc.verdict, "UNREACHABLE");
  assert.equal(grtc.checks[0].error, "ENOTFOUND");
  assert.equal(summary.providers.filter(({ verdict }) => verdict === "REACHABLE").length, 4);
});

test("받은 응답이 기대와 다르면(차단 페이지·5xx·잘못된 서명) BLOCKED다. 응답이 왔다는 것만으로 열렸다고 하지 않는다", async () => {
  const probes = (await buildProbes({ repositoryRoot: root })).filter(({ kind }) => kind !== "data-go-download");
  const korailFile = probes.find(({ provider, id }) => provider === "korail.com" && id === "timetable-file");
  for (const [label, override] of [
    ["403", () => response(403, "<html>Access Denied</html>", { "content-type": "text/html" })],
    ["html instead of xlsx", () => response(200, "<html>blocked</html>", { "content-type": "text/html" })],
    ["503", () => response(503, "unavailable")],
  ]) {
    const { fetchImpl } = providerFetch({ overrides: { [korailFile.url]: override } });
    const summary = summarizeProbes(await probeProviders({ probes, fetchImpl }));
    const korail = summary.providers.find(({ provider }) => provider === "korail.com");
    assert.equal(korail.verdict, "BLOCKED", label);
    assert.equal(summary.reachable, false, label);
  }
  const { fetchImpl } = providerFetch({ overrides: { [probes.find(({ provider, id }) => provider === "grtc" && id === "station-time-info").url]: () => response(200, "{}") } });
  assert.equal(summarizeProbes(await probeProviders({ probes, fetchImpl })).providers[0].verdict, "BLOCKED");
});

test("공급자 응용 서버의 자기 오류 페이지(5xx)는 도달로 보지만 CDN·프록시의 5xx는 BLOCKED다", async () => {
  const probes = (await buildProbes({ repositoryRoot: root })).filter(({ kind }) => kind !== "data-go-download");
  const humetro = probes.find(({ provider, id }) => provider === "humetro" && id === "open-api-host");
  const verdict = async (override) => summarizeProbes(await probeProviders({ probes, fetchImpl: providerFetch({ overrides: { [humetro.url]: override } }).fetchImpl })).providers.find(({ provider }) => provider === "humetro").verdict;
  assert.equal(await verdict(() => response(500, '<img src="/voc/admin/images/error1.jpg"/>')), "REACHABLE");
  assert.equal(await verdict(() => response(502, "<html>Bad Gateway</html>")), "BLOCKED");
  assert.equal(await verdict(() => response(500, "<html>Internal Server Error</html>")), "BLOCKED");
  assert.equal(await verdict(() => response(200, "<response/>")), "REACHABLE");
});

test("프로브 정의의 기대값이 알 수 없는 값이면 응답 없음으로 위장하지 않고 바로 실패한다", async () => {
  await assert.rejects(runProbe({ provider: "grtc", id: "x", kind: "http", required: true, url: "https://www.grtc.co.kr/x", expect: "typo" }, { fetchImpl: providerFetch().fetchImpl }), /PROBE_INPUT_INVALID: unknown expectation typo/u);
});

test("선택 점검(required: false)이 실패해도 공급자 판정은 필수 점검만 본다", async () => {
  const probes = (await buildProbes({ repositoryRoot: root })).filter(({ kind }) => kind !== "data-go-download");
  const page = probes.find(({ provider, id }) => provider === "korail.com" && id === "timetable-page");
  assert.equal(page.required, false);
  const { fetchImpl } = providerFetch({ overrides: { [page.url]: () => { throw refused(); } } });
  const korail = summarizeProbes(await probeProviders({ probes, fetchImpl })).providers.find(({ provider }) => provider === "korail.com");
  assert.equal(korail.verdict, "REACHABLE");
  assert.equal(korail.checks.find(({ id }) => id === "timetable-page").ok, false);
});

test("data.go.kr 파일 다운로드 점검은 공용 다운로드 모듈의 결과(바이트 수)를 남기고 실패는 원인 메시지와 함께 드러낸다", async () => {
  const result = await runProbe({ provider: "data.go.kr", id: "file-download", kind: "data-go-download", datasetId: "15041384", required: true }, {
    fetchImpl: async () => { throw refused(); },
    downloader: async (fetchImpl, datasetId) => ({ bytes: Buffer.from("csv,body\n"), downloadProvenance: { datasetId } }),
  });
  assert.deepEqual({ ok: result.ok, status: result.status, bytes: result.bytes }, { ok: true, status: 200, bytes: 9 });
  const failed = await runProbe({ provider: "data.go.kr", id: "file-download", kind: "data-go-download", datasetId: "15041384", required: true }, {
    fetchImpl: async () => { throw refused(); },
    downloader: async () => { throw new Error("data.go.kr download action was not found"); },
  });
  assert.equal(failed.ok, false);
  assert.match(failed.error, /download action was not found/u);
});

test("요약 표는 공급자·점검·상태·바이트·판정을 한 줄씩 보여 주고 URL의 query는 남기지 않는다", async () => {
  const probes = (await buildProbes({ repositoryRoot: root })).filter(({ kind }) => kind !== "data-go-download");
  const { fetchImpl } = providerFetch({ down: ["data.kric.go.kr"] });
  const summary = summarizeProbes(await probeProviders({ probes, fetchImpl }));
  const markdown = renderSummary(summary);
  assert.match(markdown, /^## Provider reachability from this runner/mu);
  assert.match(markdown, /\| kric \| station-line-file \| UNREACHABLE \| ENOTFOUND \| - \|/u);
  assert.match(markdown, /\| grtc \| station-time-info \| 200 \| ok \|/u);
  assert.doesNotMatch(markdown, /\?station_id=|\?type=filedata/u);
  assert.match(markdown, /UNREACHABLE: kric/u);
});

test("CLI는 요약을 stdout과 GITHUB_STEP_SUMMARY에 남기고 닿지 않는 공급자가 있으면 실패한다", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "probe-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const summaryFile = path.join(directory, "summary.md");
  await writeFile(summaryFile, "");
  const out = [];
  const downloader = async (fetchImpl, datasetId) => ({ bytes: Buffer.from("csv\n"), downloadProvenance: { datasetId } });
  const ok = providerFetch();
  const reachable = await main([], { repositoryRoot: root, fetchImpl: ok.fetchImpl, downloader, env: { GITHUB_STEP_SUMMARY: summaryFile }, write: (line) => out.push(line) });
  assert.equal(reachable.reachable, true);
  assert.match(await readFile(summaryFile, "utf8"), /ALL REACHABLE/u);
  const down = providerFetch({ down: ["www.grtc.co.kr"] });
  await assert.rejects(main([], { repositoryRoot: root, fetchImpl: down.fetchImpl, downloader, env: {}, write: (line) => out.push(line) }), /PROVIDER_UNREACHABLE: grtc/u);
  assert.ok(out.join("").includes("grtc"));
});
