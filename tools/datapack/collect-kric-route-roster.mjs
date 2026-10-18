#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { codepointCompare } from "../lib/codepoint-compare.mjs";
import { sha256 } from "../lib/hash.mjs";
import { fetchBytesWithSourceRetry, isTransientKricResultCode } from "./lib/source-collection-retry.mjs";

const ENDPOINT = "https://openapi.kric.go.kr/openapi/trainUseInfo/subwayRouteInfo";
const FIELDS = ["lnCd", "mreaWideCd", "railOprIsttCd", "routCd", "routNm", "stinCd", "stinConsOrdr", "stinNm"];
const TRANSPORT_CODES = new Set([
  "CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET",
  "EHOSTUNREACH", "ENETUNREACH", "ENOTFOUND", "ETIMEDOUT", "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);

export async function collectKricRouteRoster({
  mreaWideCd, lnCd, serviceKey, fetchImpl = fetch, now = new Date(), retrySleepImpl, retryBudget, retryRandomImpl,
} = {}) {
  const key = requiredString(serviceKey, "KRIC_SERVICE_KEY");
  const url = new URL(ENDPOINT);
  for (const [name, value] of Object.entries({ serviceKey: key, format: "xml", mreaWideCd, lnCd })) {
    url.searchParams.set(name, requiredString(value, name));
  }
  const { response, bytes } = await fetchRosterWithRetry(url, fetchImpl, { sleep: retrySleepImpl, budget: retryBudget, random: retryRandomImpl });
  if (!response.ok) throw new Error(`KRIC route roster HTTP ${response.status}`);
  const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (!new Set(["application/xml", "text/xml"]).has(contentType)) {
    throw new Error(`KRIC route roster schema mismatch: content-type ${contentType ?? "missing"}`);
  }
  const raw = bytes.toString("utf8");
  const resultCode = scalar(raw, "resultCode");
  if (resultCode !== "00") {
    const safeCode = /^[A-Za-z0-9._-]{1,32}$/.test(resultCode ?? "") ? resultCode : "UNKNOWN";
    throw new Error(`KRIC route roster provider resultCode ${safeCode}`);
  }
  const stations = [...raw.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)].map(([, item], index) => {
    const values = Object.fromEntries(FIELDS.map((field) => [field, scalar(item, field)]));
    for (const field of FIELDS) requiredString(values[field], `item[${index}].${field}`);
    const order = Number(values.stinConsOrdr);
    if (!Number.isInteger(order) || order < 1) throw new Error(`KRIC route roster schema mismatch: item[${index}].stinConsOrdr`);
    if (values.lnCd !== lnCd || values.mreaWideCd !== mreaWideCd) {
      throw new Error(`KRIC route roster schema mismatch: item[${index}] scope`);
    }
    return { ...values, stinConsOrdr: order };
  }).sort((left, right) => left.stinConsOrdr - right.stinConsOrdr || codepointCompare(left.stinCd, right.stinCd));
  if (stations.length === 0) throw new Error("KRIC route roster returned zero stations");
  const stationCodes = new Map();
  for (const station of stations) {
    const stationKey = `${station.railOprIsttCd}:${station.routCd}:${station.stinCd}`;
    if (stationCodes.has(stationKey)) {
      const previous = stationCodes.get(stationKey);
      throw new Error(
        `KRIC route roster duplicate station: previous=${previous.railOprIsttCd}/${previous.routCd}/${previous.stinCd}/${previous.stinConsOrdr}/${previous.stinNm} ` +
          `current=${station.railOprIsttCd}/${station.routCd}/${station.stinCd}/${station.stinConsOrdr}/${station.stinNm}`,
      );
    }
    stationCodes.set(stationKey, station);
  }
  return {
    schemaVersion: 1,
    artifactKind: "kric-route-roster",
    sourceId: "kric-subway-route-info",
    endpoint: ENDPOINT,
    mreaWideCd,
    lnCd,
    capturedAt: now.toISOString(),
    resultCode: "00",
    schemaFingerprint: sha256(JSON.stringify(FIELDS)),
    rawSha256: sha256(raw),
    stationCount: stations.length,
    credentialRedacted: true,
    stations,
  };
}

// 요청과 본문 읽기를 한 번의 시도로 묶어 원천 수집 표준 정책으로 재시도한다(lib/source-collection-retry.mjs, Refs #870).
// 소진한 전송 오류는 원문(요청 URL·키가 실릴 수 있음)을 버리고 분류된 코드만 남긴다.
function fetchRosterWithRetry(url, fetchImpl, retry) {
  return fetchBytesWithSourceRetry({
    url,
    fetchImpl,
    accept: "application/xml,text/xml",
    label: "KRIC route roster",
    isTransientResult: ({ bytes }) => isTransientKricResultCode(scalar(bytes.toString("utf8"), "resultCode")),
    transportFailure: (failure) => new Error(`KRIC route roster transport failure; code=${transportCode(failure)}`),
    ...retry,
  });
}

function transportCode(error) {
  const code = error?.cause?.code ?? error?.code;
  return TRANSPORT_CODES.has(code) ? code : "UNKNOWN";
}

function scalar(raw, field) {
  const match = new RegExp(`<${field}\\b[^>]*>([^<]{0,2048})<\\/${field}>`, "i").exec(raw);
  return match ? decodeXml(match[1].trim()) : null;
}

function decodeXml(value) {
  return value.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'").replaceAll("&amp;", "&").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} is required`);
  return value;
}

function args(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) values[argv[index]?.replace(/^--/, "")] = argv[index + 1];
  return values;
}

async function main() {
  const options = args(process.argv.slice(2));
  const output = requiredString(options.output, "--output");
  if (!path.isAbsolute(output)) throw new Error("--output must be absolute");
  const roster = await collectKricRouteRoster({
    mreaWideCd: requiredString(options["mrea-wide-cd"], "--mrea-wide-cd"),
    lnCd: requiredString(options["ln-cd"], "--ln-cd"),
    serviceKey: process.env.KRIC_SERVICE_KEY,
  });
  await writeFile(output, `${JSON.stringify(roster, null, 2)}\n`, { mode: 0o600 });
  console.log(`sanitized KRIC route roster ready: line=${roster.lnCd} stations=${roster.stationCount}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "KRIC route roster failed");
    process.exitCode = 1;
  });
}
