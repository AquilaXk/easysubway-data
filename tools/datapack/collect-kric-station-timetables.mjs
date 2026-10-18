#!/usr/bin/env node
// KRIC OpenAPI trainUseInfo/subwayTimetable(카탈로그 provider:kric-subway-timetable) 역별 수집기.
// 고정 바인딩의 역 × 요일코드(7 토요일, 8 평일, 9 휴일)마다 한 번 요청하고 원본 응답 바이트와 sha256을 보존한다.
// 같은 요청(멱등 GET)만 원천 수집 표준 정책(lib/source-collection-retry.mjs)으로 최대 3회 시도한다: 연결·헤더·본문 timeout, 소켓 끊김,
// HTTP 429·500·502·503·504, KRIC 일시 resultCode(01·02·04·05·99). 대체 응답은 없고, 소진하거나 결정적인 실패(HTTP 403, 그 밖의 결과코드, JSON이 아닌 응답)는 기존 오류로 실패한다.
// 요청 하나의 최악 시간은 3 × (헤더 30초 + 본문 60초) + 2 × 20초이고, 한 실행의 재시도 시간은 transient-retry의 프로세스 예산(5분)으로 막힌다.
// serviceKey는 요청 URL에만 쓰고 산출물·로그에 남기지 않는다.
//
// 실행: KRIC_SERVICE_KEY=... node tools/datapack/collect-kric-station-timetables.mjs --output <absolute new file>
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { isMainModule } from "../lib/is-main-module.mjs";
import { KRIC_API_EXPECTED_OBSERVATION, KRIC_API_STATION_TIMETABLE_BINDINGS, assertExpectedApiObservation, buildApiStationTimetableTrips } from "./lib/kric-station-timetable-api-trips.mjs";
import { sha256 } from "../lib/hash.mjs";
import { isRetryAfterExceedsCap, isTransientKricResultCode, withSourceCollectionRetry } from "./lib/source-collection-retry.mjs";
import { isTransientTransportError, unwrapTransientRetryFailure } from "./lib/transient-retry.mjs";

export const KRIC_SUBWAY_TIMETABLE_ENDPOINT = "https://openapi.kric.go.kr/openapi/trainUseInfo/subwayTimetable";
const DAY_CDS = Object.freeze(["7", "8", "9"]);
const ACCEPTED_RESULT_CODES = new Set(["00", "03"]);
// #997: 헤더 대기(연결·TLS·응답 헤더)와 본문 전체 수신 시간을 분리한다.
// 헤더가 도착하면 헤더 타이머를 끄고, 본문은 관측 상한(90,000B)과 하한 처리량(1,500B/s)에서 유도한 별도 시간 안에 읽는다.
export const HEADER_TIMEOUT_MS = 30_000;
export const REQUEST_TIMEOUT_MS = HEADER_TIMEOUT_MS;
export const OBSERVED_RESPONSE_BYTES = 90_000;
export const MIN_BODY_THROUGHPUT_BYTES_PER_SECOND = 1_500;
export const BODY_TIMEOUT_MS = 60_000;

/** 요청 URL에 실릴 수 있는 키 표현 전부(원문, percent 인코딩, form 인코딩). */
export function credentialForms(serviceKey) {
  return [...new Set([serviceKey, encodeURIComponent(serviceKey), new URLSearchParams({ k: serviceKey }).toString().slice(2)])];
}

/** CLI 출력용: 오류 문구에서 키 표현을 모두 가린다. */
export function formatCollectionError(error, env = process.env) {
  let text = error instanceof Error ? error.message : String(error);
  const key = env.KRIC_SERVICE_KEY;
  if (typeof key === "string" && key !== "") for (const form of credentialForms(key)) text = text.split(form).join("[REDACTED]");
  return text;
}

// 전송 오류 문구에는 요청 URL(키 포함)이 들어갈 수 있어 원문을 버리고 식별자만 남긴다. transient는 재시도 여부 판정용이다.
const kricFailure = (code, label, transient) => Object.assign(new Error(`${code}: ${label}`), { kricTransient: transient });
const isTimeoutFailure = (error) => error?.kricTimeout === true || error?.name === "TimeoutError" || error?.name === "AbortError";
const transportFailure = (error, label) => (isTimeoutFailure(error)
  ? kricFailure("KRIC_TIMEOUT", label, true)
  : kricFailure("KRIC_FETCH_FAILED", label, isTransientTransportError(error)));

async function readResponseBytes(response, label, bodyTimeoutMs) {
  let bodyTimer = null;
  let cancelStream = () => response.body?.cancel?.();
  try {
    return await Promise.race([
      (async () => {
        if (typeof response.body?.getReader === "function") {
          const reader = response.body.getReader();
          cancelStream = () => reader.cancel();
          const chunks = [];
          let total = 0;
          while (true) {
            const { done, value } = await reader.read();
            if (done) return Buffer.concat(chunks, total);
            const chunk = Buffer.from(value);
            total += chunk.byteLength;
            chunks.push(chunk);
          }
        }
        return Buffer.from(await response.arrayBuffer());
      })(),
      new Promise((_, reject) => {
        bodyTimer = setTimeout(() => {
          Promise.resolve().then(() => cancelStream()).catch(() => {});
          reject(Object.assign(new Error(`KRIC_TIMEOUT: ${label}`), { kricTimeout: true }));
        }, bodyTimeoutMs);
        bodyTimer.unref?.();
      }),
    ]);
  } catch (error) {
    throw transportFailure(error, label);
  } finally {
    clearTimeout(bodyTimer);
  }
}

async function requestHeaders({ url, label, fetchImpl, headerTimeoutMs }) {
  const controller = new AbortController();
  let headerTimedOut = false;
  const headerTimer = setTimeout(() => {
    headerTimedOut = true;
    controller.abort();
  }, headerTimeoutMs);
  headerTimer.unref?.();
  try {
    return await fetchImpl(url, { redirect: "error", signal: controller.signal });
  } catch (error) {
    throw headerTimedOut ? kricFailure("KRIC_TIMEOUT", label, true) : transportFailure(error, label);
  } finally {
    clearTimeout(headerTimer);
  }
}

const parseResultCode = (bytes) => {
  try { return JSON.parse(bytes.toString("utf8"))?.header?.resultCode; } catch { return undefined; }
};

// 요청과 본문 읽기를 한 시도로 묶어 표준 정책으로 재시도한다. 200이 아닌 응답은 본문을 읽지 않고 상태로 판정한다.
async function fetchTimetableWithRetry({ url, label, fetchImpl, headerTimeoutMs, bodyTimeoutMs, retry }) {
  try {
    const { response, bytes } = await withSourceCollectionRetry(async () => {
      const received = await requestHeaders({ url, label, fetchImpl, headerTimeoutMs });
      return received.status === 200 ? { response: received, bytes: await readResponseBytes(received, label, bodyTimeoutMs) } : { response: received };
    }, {
      label: `KRIC subwayTimetable ${label}`,
      isTransientError: (error) => error?.kricTransient === true,
      isTransientResult: ({ bytes }) => bytes !== undefined && isTransientKricResultCode(parseResultCode(bytes)),
      sleep: retry.sleep, budget: retry.budget, random: retry.random,
    });
    if (response.status !== 200) throw new Error(`KRIC_HTTP_FAILED: ${label} status=${response.status}`);
    return bytes;
  } catch (error) {
    throw isRetryAfterExceedsCap(error) ? error : unwrapTransientRetryFailure(error);
  }
}

export async function collectKricStationTimetables({
  bindings = KRIC_API_STATION_TIMETABLE_BINDINGS, serviceKey, fetchImpl = fetch, now = () => new Date(),
  headerTimeoutMs = HEADER_TIMEOUT_MS, bodyTimeoutMs = BODY_TIMEOUT_MS,
  retrySleepImpl, retryBudget, retryRandomImpl,
} = {}) {
  if (typeof serviceKey !== "string" || serviceKey.trim() === "") throw new Error("KRIC_SERVICE_KEY_REQUIRED");
  if (!Number.isSafeInteger(headerTimeoutMs) || headerTimeoutMs < 1
    || !Number.isSafeInteger(bodyTimeoutMs) || bodyTimeoutMs < 1) {
    throw new Error("KRIC_TIMEOUT_INVALID");
  }
  const forms = credentialForms(serviceKey);
  const responses = [];
  let capturedAt = null;
  for (const binding of bindings) {
    for (const [railOprIsttCd, stinCd] of binding.stations) {
      for (const dayCd of DAY_CDS) {
        const label = `${binding.lnCd} ${stinCd} dayCd=${dayCd}`;
        const params = { railOprIsttCd, lnCd: binding.lnCd, stinCd, dayCd, format: "json" };
        const url = new URL(KRIC_SUBWAY_TIMETABLE_ENDPOINT);
        url.searchParams.set("serviceKey", serviceKey);
        for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
        capturedAt ??= now().toISOString();
        const bytes = await fetchTimetableWithRetry({ url: url.href, label, fetchImpl, headerTimeoutMs, bodyTimeoutMs,
          retry: { sleep: retrySleepImpl, budget: retryBudget, random: retryRandomImpl } });
        if (forms.some((form) => bytes.includes(Buffer.from(form)))) throw new Error(`CREDENTIAL_LEAK: ${label}`);
        let parsed;
        try { parsed = JSON.parse(bytes.toString("utf8")); } catch { throw new Error(`KRIC_RESPONSE_NOT_JSON: ${label}`); }
        const resultCode = parsed?.header?.resultCode;
        if (!ACCEPTED_RESULT_CODES.has(resultCode)) throw new Error(`KRIC_RESULT_REJECTED: ${label} code=${resultCode}`);
        const rows = Array.isArray(parsed.body) ? parsed.body : [];
        responses.push({ requestKey: `subwayTimetable|${railOprIsttCd}|${binding.lnCd}|${stinCd}|${dayCd}`, params,
          httpStatus: 200, resultCode, rowCount: rows.length, bodySha256: sha256(bytes), bodyBase64: bytes.toString("base64") });
      }
    }
  }
  const artifact = {
    schemaVersion: 1, artifactKind: "kric-station-timetable-collection", sourceId: "kric-subway-timetable",
    operation: "subwayTimetable", endpoint: KRIC_SUBWAY_TIMETABLE_ENDPOINT, capturedAt, collectedAt: now().toISOString(),
    credentialRedacted: true,
    lines: bindings.map(({ mreaWideCd, lnCd, lineId, stations }) => ({ mreaWideCd, lnCd, lineId,
      stations: stations.map(([railOprIsttCd, stinCd, stinNm]) => ({ railOprIsttCd, stinCd, stinNm })) })),
    responses,
  };
  const serialized = JSON.stringify(artifact);
  if (forms.some((form) => serialized.includes(form))) throw new Error("CREDENTIAL_LEAK: artifact");
  return artifact;
}

/** 보관한 수집본을 재구성 lib 입력으로 되돌린다. 본문 해시와 요청 식별을 다시 검증한다. */
export function responsesFromCollection(artifact, { bindings = KRIC_API_STATION_TIMETABLE_BINDINGS } = {}) {
  if (artifact?.schemaVersion !== 1 || artifact.artifactKind !== "kric-station-timetable-collection"
    || artifact.sourceId !== "kric-subway-timetable" || artifact.credentialRedacted !== true
    || artifact.endpoint !== KRIC_SUBWAY_TIMETABLE_ENDPOINT || !Array.isArray(artifact.responses)) {
    throw new Error("COLLECTION_ENVELOPE_INVALID");
  }
  const stationNames = new Map(bindings.flatMap(({ lnCd, stations }) => stations.map(([railOprIsttCd, stinCd, stinNm]) => [`${lnCd}|${stinCd}`, { railOprIsttCd, stinNm }])));
  return artifact.responses.map((entry) => {
    const { railOprIsttCd, lnCd, stinCd, dayCd } = entry?.params ?? {};
    const label = `${lnCd} ${stinCd} dayCd=${dayCd}`;
    const station = stationNames.get(`${lnCd}|${stinCd}`);
    if (!station || station.railOprIsttCd !== railOprIsttCd) throw new Error(`RESPONSE_STATION_UNBOUND: ${lnCd} ${stinCd}`);
    const bytes = Buffer.from(entry.bodyBase64 ?? "", "base64");
    if (sha256(bytes) !== entry.bodySha256) throw new Error(`RESPONSE_BODY_DIGEST_MISMATCH: ${label}`);
    const parsed = JSON.parse(bytes.toString("utf8"));
    if (parsed?.header?.resultCode !== entry.resultCode) throw new Error(`RESPONSE_RESULT_CODE_MISMATCH: ${label}`);
    return { railOprIsttCd, lnCd, stinCd, stinNm: station.stinNm, dayCd, resultCode: entry.resultCode,
      rows: Array.isArray(parsed.body) ? parsed.body : [] };
  });
}

export async function runKricStationTimetableCollection(argv = process.argv.slice(2), {
  env = process.env, bindings = KRIC_API_STATION_TIMETABLE_BINDINGS, fetchImpl = fetch, now = () => new Date(),
  expected = KRIC_API_EXPECTED_OBSERVATION,
} = {}) {
  if (argv.length !== 2 || argv[0] !== "--output" || !path.isAbsolute(argv[1] ?? "")) {
    throw new Error("usage: collect-kric-station-timetables.mjs --output <absolute new file>");
  }
  const artifact = await collectKricStationTimetables({ bindings, serviceKey: env.KRIC_SERVICE_KEY, fetchImpl, now });
  // 기록 전에 재구성까지 통과해야 한다. 실패한 수집본은 남기지 않는다.
  const result = buildApiStationTimetableTrips({ responses: responsesFromCollection(artifact, { bindings }), bindings });
  // 고정 기대값과 다르면(제공처 시간표 변경 포함) 수집본을 쓰지 않고 실패한다.
  assertExpectedApiObservation(result, { expected, lineIds: bindings === KRIC_API_STATION_TIMETABLE_BINDINGS ? null : bindings.map(({ lineId }) => lineId) });
  const { summary } = result;
  await writeFile(argv[1], `${JSON.stringify(artifact, null, 2)}\n`, { flag: "wx" });
  return { output: argv[1], responses: artifact.responses.length, trips: summary };
}

if (isMainModule(import.meta.url)) {
  runKricStationTimetableCollection().then((summary) => console.log(JSON.stringify(summary))).catch((error) => {
    console.error(formatCollectionError(error));
    process.exitCode = 1;
  });
}
