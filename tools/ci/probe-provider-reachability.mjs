#!/usr/bin/env node
// 공급자 도달성 읽기 전용 측정(#984, #969 위험 항목 1).
//
// P7D 재확인 recipe가 부르는 공급자(grtc·humetro·data.go.kr·korail.com·kric)가 GitHub 호스팅 runner에서 열리는지 잰다.
// - GET만 하고 키·토큰·쿠키를 보내지 않는다. 저장소도 바꾸지 않는다.
// - 응답이 왔다는 것만으로 열렸다고 하지 않는다. 필수 점검은 실제 사용 경로의 응답 모양(JSON 배열·xlsx 서명·다운로드 본문)을 본다.
// - 닿지 않거나(DNS·연결·시간 초과) 막힌(차단 페이지·4xx/5xx·잘못된 본문) 공급자는 그대로 보고하고 job을 실패시킨다.
//   대체 경로(고정 IP runner 등)는 인프라 결정이라 이 도구가 정하지 않는다. 대체 값이나 stale 응답으로 덮지 않는다.
//
// 사용: node tools/ci/probe-provider-reachability.mjs   (환경: GITHUB_STEP_SUMMARY가 있으면 요약 표를 덧붙인다)
import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const PROBE_PROVIDERS = Object.freeze(["grtc", "humetro", "data.go.kr", "korail.com", "kric"]);
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_READ_BYTES = 8 * 1024 * 1024;
const XLSX_SIGNATURE = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const KRIC_STATION_LINE_FILE_URL = "https://data.kric.go.kr/rips/dataset/download.file?type=filedata&id=1294&operation=1";
const DATA_GO_PROBE_DATASET = "15041384";

function fail(code, detail = "") {
  throw new Error(detail ? `${code}: ${detail}` : code);
}

async function readJson(repositoryRoot, relative) {
  return JSON.parse(await readFile(path.join(repositoryRoot, relative), "utf8"));
}

/** 프로브 목록. 광주 역 범위와 코레일 원본 URL은 저장소에 등록된 증거에서 읽는다(손으로 적은 값을 쓰지 않는다). */
export async function buildProbes({ repositoryRoot }) {
  const inventory = await readJson(repositoryRoot, "tools/datapack/source-inventory.json");
  const evidenceOf = (sourceId) => {
    const source = inventory.sources.find(({ id }) => id === sourceId);
    if (!source?.topologyAdmissionEvidence?.snapshotPath) fail("PROBE_INPUT_INVALID", `${sourceId} has no topology admission evidence`);
    return source.topologyAdmissionEvidence;
  };
  const gwangju = await readJson(repositoryRoot, evidenceOf("gwangju-transportation-route-topology").snapshotPath);
  const stationId = String(gwangju.scope?.[0]?.providerStationId ?? "");
  if (!/^[A-Za-z0-9]+$/u.test(stationId)) fail("PROBE_INPUT_INVALID", "the Gwangju topology scope has no usable station id");
  const korail = await readJson(repositoryRoot, evidenceOf("korail-metropolitan-timetable-file").snapshotPath);
  const korailUrl = korail.observation?.sources?.timetable?.collectionReceipt?.officialUrl;
  if (typeof korailUrl !== "string" || !korailUrl.startsWith("https://www.korail.com/")) fail("PROBE_INPUT_INVALID", "the Korail collection receipt has no official URL");
  return [
    { provider: "grtc", id: "station-time-info", kind: "http", required: true, url: `https://www.grtc.co.kr/subway/openapi/json/stationTimeInfomation?station_id=${stationId}`, expect: "json-array" },
    // 키 없이 부르면 부산교통공사 응용 서버가 자기 오류 페이지(HTTP 500, /voc/admin/images/error1.jpg)로 답한다(로컬에서도 같다).
    // 그 응답이 오는 것이 도달성의 증거다. 데이터 경로(서비스 키)는 이 측정이 아니라 첫 재확인 dispatch가 확인한다.
    { provider: "humetro", id: "open-api-host", kind: "http", required: true, url: "http://data.humetro.busan.kr/voc/api/open_api_distance.tnn", expect: "any-response", providerErrorPage: "/voc/admin/images/error1.jpg" }, // NOSONAR -- provider contract is HTTP-only
    { provider: "humetro", id: "official-page", kind: "http", required: false, url: "https://www2.humetro.busan.kr/homepage/chs/page/subLocation.do?menu_no=1001010501", expect: "any-response" },
    { provider: "data.go.kr", id: "portal-file-detail", kind: "http", required: true, url: `https://www.data.go.kr/data/${DATA_GO_PROBE_DATASET}/fileData.do`, expect: "ok-html" },
    { provider: "data.go.kr", id: "file-download", kind: "data-go-download", required: true, datasetId: DATA_GO_PROBE_DATASET },
    { provider: "data.go.kr", id: "open-api-gateway", kind: "http", required: true, url: "https://apis.data.go.kr/B554695/TimeDistSVC/getTimeDist01", expect: "any-response" },
    { provider: "korail.com", id: "timetable-page", kind: "http", required: false, url: "https://www.korail.com/ticket/reserve/train-timeTable", expect: "any-response" },
    { provider: "korail.com", id: "timetable-file", kind: "http", required: true, url: korailUrl, expect: "xlsx" },
    { provider: "kric", id: "station-line-file", kind: "http", required: true, url: KRIC_STATION_LINE_FILE_URL, expect: "xlsx" },
    { provider: "kric", id: "open-api-host", kind: "http", required: false, url: "https://openapi.kric.go.kr/openapi/convenientInfo/stationInfo", expect: "any-response" },
  ];
}

// 요약·로그에는 query를 남기지 않는다(키가 섞일 수 있는 자리다).
const redactedUrl = (value) => {
  try { const url = new URL(value); return `${url.origin}${url.pathname}`; } catch { return "-"; }
};

const errorCode = (error) => String(error?.cause?.code ?? error?.code ?? error?.cause?.name ?? error?.name ?? "ERROR");

async function readBody(res) {
  const reader = res.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    chunks.push(Buffer.from(value));
    if (total > MAX_READ_BYTES) { await reader.cancel(); break; }
  }
  return Buffer.concat(chunks);
}

const verdictOf = (ok, note = "ok") => ({ ok, note: ok ? "ok" : note });

function judgeAnyResponse(status, body, providerErrorPage) {
  // 5xx는 공급자 응용 서버가 자기 오류 페이지로 답한 경우만 도달로 본다(CDN·프록시·차단 페이지의 5xx와 구분한다).
  if (status < 500) return body.length > 0 ? verdictOf(true) : verdictOf(false, "empty body");
  const providerPage = Boolean(providerErrorPage) && body.toString("latin1").includes(providerErrorPage);
  return providerPage ? { ok: true, note: "provider error page (no service key)" } : verdictOf(false, `HTTP ${status}`);
}

function judgeJsonArray(body) {
  try {
    return Array.isArray(JSON.parse(body.toString("utf8"))) && body.length > 2 ? verdictOf(true) : verdictOf(false, "the body is not a non-empty JSON array");
  } catch {
    return verdictOf(false, "the body is not JSON");
  }
}

const BODY_JUDGES = Object.freeze({
  "ok-html": (body) => (body.length > 0 ? verdictOf(true) : verdictOf(false, "empty body")),
  xlsx: (body) => verdictOf(body.subarray(0, 4).equals(XLSX_SIGNATURE), "the body is not an xlsx workbook"),
  "json-array": judgeJsonArray,
});

const EXPECTATIONS = new Set(["any-response", ...Object.keys(BODY_JUDGES)]);

function judge(expect, status, body, providerErrorPage = null) {
  if (expect === "any-response") return judgeAnyResponse(status, body, providerErrorPage);
  return status === 200 ? BODY_JUDGES[expect](body) : verdictOf(false, `HTTP ${status}`);
}

/** 점검 하나를 실행한다. 어떤 실패도 던지지 않고 결과로 돌려준다(다른 공급자 측정을 막지 않는다). */
export async function runProbe(probe, { fetchImpl = fetch, timeoutMs = REQUEST_TIMEOUT_MS, downloader = null } = {}) {
  // 프로브 정의의 오류는 응답 없음(UNREACHABLE)으로 위장하지 않고 바로 드러낸다.
  if (probe.kind !== "data-go-download" && !EXPECTATIONS.has(probe.expect)) fail("PROBE_INPUT_INVALID", `unknown expectation ${String(probe.expect)}`);
  const base = { provider: probe.provider, id: probe.id, required: probe.required, url: redactedUrl(probe.url ?? "") };
  const started = Date.now();
  try {
    if (probe.kind === "data-go-download") {
      const download = downloader ?? (await import("../datapack/lib/data-go-file-download.mjs")).downloadDataGoFile;
      const { bytes } = await download(fetchImpl, probe.datasetId);
      return { ...base, url: `https://www.data.go.kr/data/${probe.datasetId}/fileData.do`, ok: bytes.length > 0, status: 200, bytes: bytes.length, ms: Date.now() - started, note: bytes.length > 0 ? "ok" : "empty body" };
    }
    const res = await fetchImpl(probe.url, { method: "GET", redirect: "follow", signal: AbortSignal.timeout(timeoutMs), headers: { "user-agent": "easysubway-datapack-reachability-probe/1.0", "accept-encoding": "identity" } });
    const body = await readBody(res);
    return { ...base, ...judge(probe.expect, res.status, body, probe.providerErrorPage), status: res.status, bytes: body.length, ms: Date.now() - started };
  } catch (error) {
    return { ...base, ok: false, status: null, bytes: null, ms: Date.now() - started, error: probe.kind === "data-go-download" ? String(error?.message ?? error) : errorCode(error), note: "no usable response" };
  }
}

// 점검은 서로 독립이고 하나가 실패해도 던지지 않으므로 함께 실행한다(결과 순서는 프로브 순서 그대로다).
export async function probeProviders({ probes, fetchImpl = fetch, timeoutMs = REQUEST_TIMEOUT_MS, downloader = null } = {}) {
  return Promise.all(probes.map((probe) => runProbe(probe, { fetchImpl, timeoutMs, downloader })));
}

/**
 * 공급자 판정: 필수 점검이 모두 ok면 REACHABLE. 응답을 못 받은 필수 점검이 있으면 UNREACHABLE(DNS·연결·시간 초과),
 * 응답은 받았지만 기대와 다른 필수 점검이 있으면 BLOCKED(차단 페이지·4xx/5xx·잘못된 본문)다.
 */
function providerVerdict(checks) {
  const required = checks.filter(({ required: isRequired }) => isRequired);
  if (required.length === 0 || required.some(({ ok, status }) => !ok && status === null)) return "UNREACHABLE";
  return required.every(({ ok }) => ok) ? "REACHABLE" : "BLOCKED";
}

export function summarizeProbes(results) {
  const providers = PROBE_PROVIDERS.map((provider) => {
    const checks = results.filter((entry) => entry.provider === provider);
    return { provider, verdict: providerVerdict(checks), checks };
  });
  return { reachable: providers.every(({ verdict }) => verdict === "REACHABLE"), providers };
}

function summaryRow(provider, verdict, check) {
  const noResponse = check.status === null;
  const state = noResponse ? "UNREACHABLE" : check.status;
  const result = noResponse ? check.error : (check.error ?? (check.ok ? "ok" : check.note));
  return `| ${provider} | ${check.id}${check.required ? "" : " (선택)"} | ${state} | ${result} | ${check.bytes ?? "-"} | ${verdict} |`;
}

export function renderSummary(summary) {
  const lines = ["## Provider reachability from this runner", "", "| 공급자 | 점검 | 상태 | 결과 | 바이트 | 판정 |", "| --- | --- | --- | --- | --- | --- |"];
  for (const { provider, verdict, checks } of summary.providers) lines.push(...checks.map((check) => summaryRow(provider, verdict, check)));
  const bad = summary.providers.filter(({ verdict }) => verdict !== "REACHABLE");
  lines.push("", summary.reachable ? "ALL REACHABLE" : bad.map(({ provider, verdict }) => `${verdict}: ${provider}`).join("\n"), "");
  return lines.join("\n");
}

export async function main(argv, {
  repositoryRoot = path.resolve(import.meta.dirname, "../.."), fetchImpl = fetch, downloader = null, env = process.env, write = (text) => process.stdout.write(text),
} = {}) {
  if (argv.length !== 0) fail("PROBE_ARGUMENTS", "usage: probe-provider-reachability.mjs");
  const summary = summarizeProbes(await probeProviders({ probes: await buildProbes({ repositoryRoot }), fetchImpl, downloader }));
  const markdown = renderSummary(summary);
  write(`${markdown}\n`);
  if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
  const bad = summary.providers.filter(({ verdict }) => verdict !== "REACHABLE");
  if (bad.length > 0) fail("PROVIDER_UNREACHABLE", bad.map(({ provider, verdict }) => `${provider} (${verdict})`).join(", "));
  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
