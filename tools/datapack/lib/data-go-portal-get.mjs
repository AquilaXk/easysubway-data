// data.go.kr 포털(detail 페이지·FILE 다운로드) GET 한 건을 원천 수집 표준 재시도(lib/source-collection-retry.mjs)로 받는다.
// 수집기마다 같은 User-Agent·Referer·timeout 배선을 복붙하지 않도록 모았다. HTTP 상태 판정은 호출자의 기존 오류 경로에 맡긴다.
import { fetchBytesWithSourceRetry, transportFailureWithCode } from "./source-collection-retry.mjs";

const USER_AGENT = "easysubway-datapack-collector/1.0";
// data-go-file-download.mjs의 헤더 대기 한도(HEADER_TIMEOUT_MS)와 같다. 요청 하나(헤더+본문)의 한도로 쓴다.
const REQUEST_TIMEOUT_MS = 60_000;

/**
 * @param {object} options
 * @param {string} options.url
 * @param {Function} options.fetchImpl
 * @param {string} options.label 오류 메시지의 원천 이름.
 * @param {string} [options.referer] FILE 다운로드가 요구하는 detail 페이지 주소.
 * @param {{ sleepImpl?: Function, randomImpl?: () => number }} [options.retry] 테스트용 대기·난수 주입.
 * @returns {Promise<{ response: Response, bytes: Buffer }>}
 */
export function getDataGoPortalBytes({ url, fetchImpl, label, referer, retry = {} }) {
  return fetchBytesWithSourceRetry({
    url,
    fetchImpl,
    accept: "*/*",
    headers: { "User-Agent": USER_AGENT, ...(referer === undefined ? {} : { Referer: referer }) },
    label,
    timeoutMs: REQUEST_TIMEOUT_MS,
    transportFailure: transportFailureWithCode(label),
    sleep: retry.sleepImpl,
    random: retry.randomImpl,
  });
}
