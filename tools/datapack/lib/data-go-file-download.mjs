// data.go.kr 파일데이터 공식 다운로드 흐름(키·활용신청 없음).
// detail 페이지의 다운로드 버튼 → /tcs/dss/selectFileDataDownload.do → /cmm/cmm/fileDownload.do.
// 어느 단계든 기대한 형태가 아니면 명시적으로 실패하며 이전·추정 URL이나 본문으로 대체하지 않는다.
import { createHash } from "node:crypto";

const ORIGIN = "https://www.data.go.kr";
const USER_AGENT = "easysubway-datapack-collector/1.0";
const REQUEST_TIMEOUT_MS = 60_000;
// 포털 script_fileDetail.js의 fn_fileDataDown이 고정해 보내는 공공데이터 유형 코드.
const PUBLIC_DATA_TYPE_CODE = "PR0051";
const DATASET_ID_PATTERN = /^[1-9]\d{0,11}$/u;
const ATCH_FILE_ID_PATTERN = /^FILE_\d+$/u;
const FILE_DETAIL_SN_PATTERN = /^[1-9]\d*$/u;
// 실제 응답은 CSV 모두 application/octet-stream이며, 포털이 CSV·XLS(X)로 내려줄 수 있는 형식만 허용한다.
export const ALLOWED_DATA_GO_FILE_TYPES = Object.freeze([
  "application/octet-stream",
  "application/csv",
  "text/csv",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);
// 지금 원천의 최대 파일은 300KB 미만이다. 포털 응답이 바뀌어도 메모리를 무한히 쓰지 않는다.
export const MAX_DATA_GO_FILE_BYTES = 16 * 1024 * 1024;
const HTML_DOCUMENT_START = /^(?:<!doctype\s+html|<html[\s>])/iu;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function requireDatasetId(datasetId) {
  if (typeof datasetId !== "string" || !DATASET_ID_PATTERN.test(datasetId)) {
    throw new TypeError("data.go.kr dataset id is invalid");
  }
  return datasetId;
}

export function dataGoDetailUrl(datasetId) {
  return `${ORIGIN}/data/${requireDatasetId(datasetId)}/fileData.do`;
}

export function isCanonicalDataGoDownloadUrl(value) {
  try {
    const url = new URL(value);
    return url.origin === ORIGIN && url.pathname === "/cmm/cmm/fileDownload.do"
      && ATCH_FILE_ID_PATTERN.test(url.searchParams.get("atchFileId") ?? "")
      && FILE_DETAIL_SN_PATTERN.test(url.searchParams.get("fileDetailSn") ?? "");
  } catch {
    return false;
  }
}

// 버튼: fileDetailObj.fn_fileDataDown('<PK>', 'uddi:<상세 PK>', '<atchFileId>','<fileDetailSn>', '<이력 순번>')
const DOWNLOAD_CALL = "fn_fileDataDown(";
const DOWNLOAD_CALL_PATTERN = /fn_fileDataDown\(([^)]*)\)/gu;
const QUOTED_ARGUMENT = /^(['"])(.*)\1$/u;
const DETAIL_PK_PATTERN = /^uddi:[0-9a-f-]+$/u;

function parseDownloadCall(args) {
  const values = args.split(",").map((value) => QUOTED_ARGUMENT.exec(value.trim())?.[2]);
  if (values.length !== 5 || values.some((value) => value === undefined)) return null;
  const [publicDataPk, publicDataDetailPk, , fileDetailSn, historySn] = values;
  if (!DATASET_ID_PATTERN.test(publicDataPk) || !DETAIL_PK_PATTERN.test(publicDataDetailPk)
    || !FILE_DETAIL_SN_PATTERN.test(fileDetailSn) || !/^\d+$/u.test(historySn)) return null;
  return { publicDataPk, publicDataDetailPk, fileDetailSn };
}

export function parseDataGoDownloadAction(html, datasetId) {
  if (typeof html !== "string") throw new TypeError("data.go.kr detail HTML is required");
  requireDatasetId(datasetId);
  // 어떤 모양이든 호출 하나를 해석하지 못하면 남은 호출 중 하나를 고르지 않고 실패한다.
  const occurrences = html.split(DOWNLOAD_CALL).length - 1;
  const calls = [...html.matchAll(DOWNLOAD_CALL_PATTERN)].map(([, args]) => parseDownloadCall(args));
  if (calls.length !== occurrences || calls.some((call) => call === null)) {
    throw new Error(`data.go.kr ${datasetId} detail has an unrecognized download action`);
  }
  const actions = new Map();
  for (const call of calls) {
    if (call.publicDataPk !== datasetId) continue;
    actions.set(`${call.publicDataDetailPk}\0${call.fileDetailSn}`, call);
  }
  if (actions.size !== 1) {
    throw new Error(`data.go.kr ${datasetId} detail must contain exactly one download action`);
  }
  return [...actions.values()][0];
}

async function requestGet(fetchImpl, url, headers, label) {
  const response = await fetchImpl(url, {
    method: "GET",
    redirect: "error",
    headers: { "User-Agent": USER_AGENT, ...headers },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`data.go.kr ${label} HTTP ${response.status}`);
  return response;
}

export async function resolveDataGoFileDownload(fetchImpl, datasetId) {
  const detailUrl = dataGoDetailUrl(datasetId);
  const detail = await requestGet(fetchImpl, detailUrl, {}, `${datasetId} detail`);
  const action = parseDataGoDownloadAction(await detail.text(), datasetId);
  const lookupUrl = new URL("/tcs/dss/selectFileDataDownload.do", ORIGIN);
  lookupUrl.searchParams.set("publicDataPk", action.publicDataPk);
  lookupUrl.searchParams.set("publicDataDetailPk", action.publicDataDetailPk);
  lookupUrl.searchParams.set("atchFileId", "");
  lookupUrl.searchParams.set("fileDetailSn", action.fileDetailSn);
  lookupUrl.searchParams.set("publicDataTyCode", PUBLIC_DATA_TYPE_CODE);
  const lookup = await requestGet(fetchImpl, lookupUrl.toString(), { Referer: detailUrl }, `${datasetId} download lookup`);
  let body;
  try {
    body = JSON.parse(await lookup.text());
  } catch {
    throw new Error(`data.go.kr ${datasetId} download lookup is not JSON`);
  }
  if (body?.status !== true) throw new Error(`data.go.kr ${datasetId} download lookup rejected`);
  if (body.dpk !== action.publicDataDetailPk) {
    throw new Error(`data.go.kr ${datasetId} download lookup detail PK mismatch`);
  }
  if (typeof body.atchFileId !== "string" || !ATCH_FILE_ID_PATTERN.test(body.atchFileId)) {
    throw new Error(`data.go.kr ${datasetId} download lookup atchFileId is invalid`);
  }
  if (body.fileDetailSn !== action.fileDetailSn || !FILE_DETAIL_SN_PATTERN.test(body.fileDetailSn)) {
    throw new Error(`data.go.kr ${datasetId} download lookup fileDetailSn is invalid`);
  }
  const downloadUrl = new URL("/cmm/cmm/fileDownload.do", ORIGIN);
  downloadUrl.searchParams.set("atchFileId", body.atchFileId);
  downloadUrl.searchParams.set("fileDetailSn", body.fileDetailSn);
  downloadUrl.searchParams.set("insertDataPrcus", "N");
  return { datasetId, detailUrl, downloadUrl: downloadUrl.toString() };
}

async function readLimitedBody(response, datasetId, maxBytes) {
  const exceeds = () => new Error(`data.go.kr ${datasetId} file exceeds ${maxBytes} bytes`);
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw exceeds();
  const chunks = [];
  let received = 0;
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
    received += chunk.value.byteLength;
    if (received > maxBytes) {
      await reader.cancel();
      throw exceeds();
    }
    chunks.push(chunk.value);
  }
  return Buffer.concat(chunks);
}

export async function downloadDataGoFile(fetchImpl, datasetId, { maxBytes = MAX_DATA_GO_FILE_BYTES } = {}) {
  const { detailUrl, downloadUrl } = await resolveDataGoFileDownload(fetchImpl, datasetId);
  if (!isCanonicalDataGoDownloadUrl(downloadUrl)) {
    throw new Error(`data.go.kr ${datasetId} download URL is invalid`);
  }
  const response = await requestGet(fetchImpl, downloadUrl, { Referer: detailUrl }, `${datasetId} file`);
  const contentType = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (!ALLOWED_DATA_GO_FILE_TYPES.includes(contentType)) {
    throw new Error(`data.go.kr ${datasetId} file content-type is not allowed`);
  }
  const bytes = await readLimitedBody(response, datasetId, maxBytes);
  if (bytes.byteLength === 0) throw new Error(`data.go.kr ${datasetId} file is empty`);
  // 허용된 content-type으로 내려온 오류 페이지(HTML)도 데이터 파일로 받지 않는다.
  if (HTML_DOCUMENT_START.test(bytes.subarray(0, 512).toString("utf8").replace(/^\ufeff/u, "").trimStart())) {
    throw new Error(`data.go.kr ${datasetId} file is not a data file`);
  }
  return { datasetId, detailUrl, downloadUrl, rawSha256: sha256(bytes), bytes };
}

// 수집기가 실제로 파싱한 바이트와 기록하려는 provenance가 같은 원본인지 확인하고 정규화한다.
export function verifyDataGoDownloadProvenance(provenance, expectedDatasetIds, bytesByDatasetId) {
  if (!Array.isArray(provenance) || provenance.length !== expectedDatasetIds.length) {
    throw new Error("data.go.kr download provenance is invalid");
  }
  return expectedDatasetIds.map((datasetId, index) => {
    const entry = provenance[index];
    if (entry?.datasetId !== datasetId || entry.detailUrl !== dataGoDetailUrl(datasetId)
      || !isCanonicalDataGoDownloadUrl(entry.downloadUrl) || !SHA256_PATTERN.test(entry.rawSha256 ?? "")) {
      throw new Error(`data.go.kr ${datasetId} download provenance is invalid`);
    }
    const bytes = bytesByDatasetId[datasetId];
    if (!(bytes instanceof Uint8Array) || sha256(bytes) !== entry.rawSha256) {
      throw new Error(`data.go.kr ${datasetId} download provenance sha256 mismatch`);
    }
    return {
      datasetId,
      detailUrl: entry.detailUrl,
      downloadUrl: entry.downloadUrl,
      rawSha256: entry.rawSha256,
    };
  });
}
