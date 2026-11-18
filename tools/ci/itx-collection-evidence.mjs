// 실패한 ITX 수집 run이 공급자에게 보낸 요청 수를 그 run의 artifact에서 읽는다(#1298).
// 수집 workflow는 실패해도 sanitized 증거 artifact를 올린다(if: always()). 그 안의 provider-response-capture.json이 보낸 요청 전부를 기록한다.
// artifact는 gh run download가 새 임시 디렉터리에 풀어 주고, 이 모듈은 고정된 두 파일 이름만 평문 JSON으로 읽는다.
// 읽지 못하면 0이나 추정치를 돌려주지 않고 null이다. 호출한 쪽(itx-collection-allowance)이 null을 증거 없음으로 보고 막는다.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { parseProviderResponseCapture } from "../datapack/provider-response-capture.mjs";
import { downloadArtifactWithGh, readEvidenceFile } from "./collection-run-window.mjs";

const CAPTURE_FILE = "provider-response-capture.json";
const RECEIPT_FILE = "freshness.json";
// 기록은 본문 64MiB(base64 약 86MiB)까지 담을 수 있다. 그보다 큰 파일은 정상 capture가 아니다.
const MAX_CAPTURE_BYTES = 128 * 1024 * 1024;
const MAX_RECEIPT_BYTES = 64 * 1024;

// KASI 휴일 조회가 실패하면 수집기는 공급자(TAGO)를 부르기 전에 끝나 capture 없이 freshness.json에 실패 영수증만 남긴다.
function isProviderFreeFailureReceipt(receiptBytes) {
  if (receiptBytes === null) return false;
  const receipt = JSON.parse(receiptBytes.toString("utf8"));
  return receipt?.artifactKind === "itx-current-collection-preflight" && receipt.status === "FAILED" && receipt.operation === "KASI_PUBLIC_HOLIDAY_CALENDAR";
}

/**
 * @param {{ repository: string, runId: number, artifactName: string | null, token: string, downloadArtifact?: typeof downloadArtifactWithGh }} input artifactName이 null이면 증거 artifact가 없는 workflow다.
 * @returns {Promise<number | null>} 그 run이 공급자에게 보낸 요청 수. 증명할 수 없으면 null.
 */
export async function readCollectionRequestCount({ repository, runId, artifactName, token, downloadArtifact = downloadArtifactWithGh }) {
  if (artifactName === null) return null;
  const directory = await mkdtemp(path.join(tmpdir(), "itx-collection-evidence-"));
  try {
    await downloadArtifact({ repository, runId, artifactName, directory, token });
    const capture = await readEvidenceFile(directory, CAPTURE_FILE, MAX_CAPTURE_BYTES);
    if (capture !== null) return parseProviderResponseCapture(capture).requestCount;
    return isProviderFreeFailureReceipt(await readEvidenceFile(directory, RECEIPT_FILE, MAX_RECEIPT_BYTES)) ? 0 : null;
  } catch {
    return null;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
