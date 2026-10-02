#!/usr/bin/env node
// KRIC OpenAPI trainUseInfo/subwayTimetable(카탈로그 provider:kric-subway-timetable) 역별 수집기.
// 고정 바인딩의 역 × 요일코드(7 토요일, 8 평일, 9 휴일)마다 한 번 요청하고 원본 응답 바이트와 sha256을 보존한다.
// 재시도·대체 응답 없음: HTTP 실패, 거부 결과코드(00·03 외), JSON이 아닌 응답은 즉시 실패한다.
// serviceKey는 요청 URL에만 쓰고 산출물·로그에 남기지 않는다.
//
// 실행: KRIC_SERVICE_KEY=... node tools/datapack/collect-kric-station-timetables.mjs --output <absolute new file>
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { isMainModule } from "../lib/is-main-module.mjs";
import { KRIC_API_STATION_TIMETABLE_BINDINGS, buildApiStationTimetableTrips } from "./lib/kric-station-timetable-api-trips.mjs";

export const KRIC_SUBWAY_TIMETABLE_ENDPOINT = "https://openapi.kric.go.kr/openapi/trainUseInfo/subwayTimetable";
const DAY_CDS = Object.freeze(["7", "8", "9"]);
const ACCEPTED_RESULT_CODES = new Set(["00", "03"]);
const REQUEST_TIMEOUT_MS = 30_000;
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

export async function collectKricStationTimetables({
  bindings = KRIC_API_STATION_TIMETABLE_BINDINGS, serviceKey, fetchImpl = fetch, now = () => new Date(),
} = {}) {
  if (typeof serviceKey !== "string" || serviceKey.trim() === "") throw new Error("KRIC_SERVICE_KEY_REQUIRED");
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
        const response = await fetchImpl(url.href, { redirect: "error", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
        if (response.status !== 200) throw new Error(`KRIC_HTTP_FAILED: ${label} status=${response.status}`);
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.includes(Buffer.from(serviceKey))) throw new Error(`CREDENTIAL_LEAK: ${label}`);
        let parsed;
        try { parsed = JSON.parse(bytes.toString("utf8")); } catch { throw new Error(`KRIC_RESPONSE_NOT_JSON: ${label}`); }
        const resultCode = parsed?.header?.resultCode;
        if (!ACCEPTED_RESULT_CODES.has(resultCode)) throw new Error(`KRIC_RESULT_REJECTED: ${label} code=${resultCode}`);
        const rows = Array.isArray(parsed.body) ? parsed.body : [];
        responses.push({ requestKey: `subwayTimetable|${railOprIsttCd}|${binding.lnCd}|${stinCd}|${dayCd}`, params,
          httpStatus: response.status, resultCode, rowCount: rows.length, bodySha256: sha256(bytes), bodyBase64: bytes.toString("base64") });
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
  if (JSON.stringify(artifact).includes(serviceKey)) throw new Error("CREDENTIAL_LEAK: artifact");
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
} = {}) {
  if (argv.length !== 2 || argv[0] !== "--output" || !path.isAbsolute(argv[1] ?? "")) {
    throw new Error("usage: collect-kric-station-timetables.mjs --output <absolute new file>");
  }
  const artifact = await collectKricStationTimetables({ bindings, serviceKey: env.KRIC_SERVICE_KEY, fetchImpl, now });
  // 기록 전에 재구성까지 통과해야 한다. 실패한 수집본은 남기지 않는다.
  const { summary } = buildApiStationTimetableTrips({ responses: responsesFromCollection(artifact, { bindings }), bindings });
  await writeFile(argv[1], `${JSON.stringify(artifact, null, 2)}\n`, { flag: "wx" });
  return { output: argv[1], responses: artifact.responses.length, trips: summary };
}

if (isMainModule(import.meta.url)) {
  runKricStationTimetableCollection().then((summary) => console.log(JSON.stringify(summary))).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
