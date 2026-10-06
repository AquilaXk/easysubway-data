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

export async function downloadDataGoFile(fetchImpl, datasetId) {
  const { detailUrl, downloadUrl } = await resolveDataGoFileDownload(fetchImpl, datasetId);
  if (!isCanonicalDataGoDownloadUrl(downloadUrl)) {
    throw new Error(`data.go.kr ${datasetId} download URL is invalid`);
  }
  const response = await requestGet(fetchImpl, downloadUrl, { Referer: detailUrl }, `${datasetId} file`);
  if ((response.headers.get("content-type") ?? "").toLowerCase().includes("text/html")) {
    throw new Error(`data.go.kr ${datasetId} file is not a data file`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength === 0) throw new Error(`data.go.kr ${datasetId} file is empty`);
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
