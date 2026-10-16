// 실패한 ITX 수집 run이 공급자에게 보낸 요청 수를 그 run의 artifact에서 읽는다(#1298).
// 수집 workflow는 실패해도 sanitized 증거 artifact를 올린다(if: always()). 그 안의 provider-response-capture.json이 보낸 요청 전부를 기록한다.
// 읽지 못하면 0이나 추정치를 돌려주지 않고 null이다. 호출한 쪽(itx-collection-allowance)이 null을 증거 없음으로 보고 막는다.
import { parseProviderResponseCapture } from "../datapack/provider-response-capture.mjs";
import { readZipEntry } from "./read-zip-entry.mjs";

const CAPTURE_ENTRY = "provider-response-capture.json";
const RECEIPT_ENTRY = "freshness.json";
// 기록은 본문 64MiB(base64 약 86MiB)까지 담을 수 있다. 그보다 큰 항목은 정상 capture가 아니다.
const MAX_CAPTURE_ENTRY_BYTES = 128 * 1024 * 1024;
const MAX_RECEIPT_ENTRY_BYTES = 64 * 1024;
const MAX_ARTIFACT_ZIP_BYTES = 128 * 1024 * 1024;
const REQUEST_TIMEOUT_MILLIS = 60_000;
const API = "https://api.github.com";

const headers = (token) => ({ accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "x-github-api-version": "2026-03-10" });

async function fetchBytes({ fetchImpl, url, token, redirect }) {
  const response = await fetchImpl(url, { method: "GET", redirect, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MILLIS), headers: headers(token) });
  if (response?.status !== 200) throw new Error("artifact request failed");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_ARTIFACT_ZIP_BYTES) throw new Error("artifact response is too large");
  return bytes;
}

async function liveArtifactId({ repository, runId, artifactName, token, fetchImpl }) {
  const url = new URL(`${API}/repos/${repository}/actions/runs/${runId}/artifacts`);
  url.searchParams.set("name", artifactName);
  const listing = JSON.parse((await fetchBytes({ fetchImpl, url: url.href, token, redirect: "error" })).toString("utf8"));
  const live = (listing?.artifacts ?? []).filter((artifact) => artifact?.name === artifactName && artifact.expired === false);
  return live.length === 1 && Number.isSafeInteger(live[0].id) ? live[0].id : null;
}

// KASI 휴일 조회가 실패하면 수집기는 공급자(TAGO)를 부르기 전에 끝나 capture 없이 freshness.json에 실패 영수증만 남긴다.
function isProviderFreeFailureReceipt(receiptBytes) {
  if (receiptBytes === null) return false;
  const receipt = JSON.parse(receiptBytes.toString("utf8"));
  return receipt?.artifactKind === "itx-current-collection-preflight" && receipt.status === "FAILED" && receipt.operation === "KASI_PUBLIC_HOLIDAY_CALENDAR";
}

/**
 * @param {{ repository: string, runId: number, artifactName: string | null, token: string, fetchImpl: typeof fetch }} input artifactName이 null이면 증거 artifact가 없는 workflow다.
 * @returns {Promise<number | null>} 그 run이 공급자에게 보낸 요청 수. 증명할 수 없으면 null.
 */
export async function readCollectionRequestCount({ repository, runId, artifactName, token, fetchImpl }) {
  if (artifactName === null) return null;
  try {
    const artifactId = await liveArtifactId({ repository, runId, artifactName, token, fetchImpl });
    if (artifactId === null) return null;
    const zip = await fetchBytes({ fetchImpl, url: `${API}/repos/${repository}/actions/artifacts/${artifactId}/zip`, token, redirect: "follow" });
    const capture = readZipEntry(zip, CAPTURE_ENTRY, { maxBytes: MAX_CAPTURE_ENTRY_BYTES });
    if (capture !== null) return parseProviderResponseCapture(capture).requestCount;
    return isProviderFreeFailureReceipt(readZipEntry(zip, RECEIPT_ENTRY, { maxBytes: MAX_RECEIPT_ENTRY_BYTES })) ? 0 : null;
  } catch {
    return null;
  }
}
