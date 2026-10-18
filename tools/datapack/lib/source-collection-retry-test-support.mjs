// 원천 수집기 테스트가 공유하는 재시도 계약 헬퍼(data #1334). 수집기마다 같은 세 행을 복붙하지 않고 defineSourceCollectionRetryTests 한 번으로 등록한다.
//   1. 요청이 timeout으로 한 번 실패한 뒤 성공하면 재시도 없던 수집과 같은 결과를 낸다.
//   2. 본문 수신 중 timeout으로 한 번 실패한 뒤 성공해도 같다(재시도 단위가 요청 + 본문 읽기여야 한다).
//   3. 비일시 오류(HTTP 403)는 재시도하지 않고 즉시 실패한다.
// defineResultCodeRetryTests는 resultCode 표 기반 재시도 계약을 한 곳에 두고, defineKricResultCodeRetryTests(KRIC: 일시 01·02·04·05·99)와
// defineDataGoKrResultCodeRetryTests(공공데이터포털: 일시 01·02·04·05·30·99), defineBusanHumetroResultCodeRetryTests(부산교통공사: 일시 30·99)가 원천별 행만 넘겨 수집기들이 함께 쓰게 한다.
import assert from "node:assert/strict";
import test from "node:test";
import { inspect } from "node:util";

export const abortedByTimeout = () => Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });

/** 상태 줄은 정상인데 본문을 읽으면 timeout으로 끊기는 응답(계기가 된 부산 시간표 실패 모양). */
export const responseWithTimingOutBody = (headers = {}) => new Response(
  new ReadableStream({ pull(controller) { controller.error(abortedByTimeout()); } }),
  { status: 200, headers },
);

const FIRST_FAILURES = Object.freeze({
  requestTimeout: () => { throw abortedByTimeout(); },
  bodyTimeout: (headers) => responseWithTimingOutBody(headers),
  forbidden: () => new Response("forbidden", { status: 403 }),
});

/** 첫 호출만 failure로 바꾸고 나머지는 delegate에 넘긴다. state.failedRequestCalls는 실패시킨 요청(URL)을 보낸 횟수다. */
export function fetchWithFirstFailure(delegate, failureKind, headers) {
  const state = { calls: 0, failedRequest: undefined, failedRequestCalls: 0 };
  const fetchImpl = async (...args) => {
    state.calls += 1;
    if (state.calls === 1) state.failedRequest = String(args[0]);
    if (String(args[0]) === state.failedRequest) state.failedRequestCalls += 1;
    return state.calls === 1 ? FIRST_FAILURES[failureKind](headers) : delegate(...args);
  };
  return { fetchImpl, state };
}

/**
 * @param {object} options
 * @param {string} options.name 수집기 이름(테스트 제목).
 * @param {(io: { fetchImpl: Function, sleepImpl: Function }) => Promise<unknown>} options.run 수집기를 실행하고 비교할 결과를 돌려준다. 결과를 deepEqual로 비교하므로 now(observedAt 등)·난수 같은 비결정 입력은 반드시 고정한다. 고정하지 않으면 간헐 실패한다(#1341 F1).
 * @param {Function} options.delegate 성공 응답을 만드는 fetch.
 * @param {Record<string, string>} [options.headers] 본문 timeout 응답에 붙일 헤더.
 * @param {RegExp} options.httpError 이 수집기가 HTTP 403에 던지는 오류의 메시지 matcher.
 */
export function defineSourceCollectionRetryTests({ name, run, delegate, headers, httpError }) {
  const noSleep = async () => {};
  for (const [failureKind, label] of [["requestTimeout", "요청 timeout"], ["bodyTimeout", "본문 수신 timeout"]]) {
    test(`${name}: ${label} 1회 뒤 성공하면 정상 수집한다`, async () => {
      const expected = await run({ fetchImpl: delegate, sleepImpl: noSleep });
      const { fetchImpl, state } = fetchWithFirstFailure(delegate, failureKind, headers);
      assert.deepEqual(await run({ fetchImpl, sleepImpl: noSleep }), expected);
      assert.equal(state.failedRequestCalls, 2, "첫 호출 실패 뒤 같은 요청을 한 번 다시 보내야 한다");
    });
  }
  test(`${name}: 비일시 오류(HTTP 403)는 재시도 없이 즉시 실패한다`, async () => {
    const { fetchImpl, state } = fetchWithFirstFailure(delegate, "forbidden", headers);
    await assert.rejects(run({ fetchImpl, sleepImpl: noSleep }), httpError);
    assert.equal(state.failedRequestCalls, 1, "403을 받은 요청은 다시 보내지 않는다");
  });
}

/** 오류의 메시지와 inspect 출력(cause·속성 포함)에 비밀 값이 없는지 확인한다. */
export function assertErrorOmitsSecrets(error, secrets) {
  const surfaces = [String(error?.message), inspect(error, { depth: 6, showHidden: true })];
  for (const secret of secrets) {
    for (const surface of surfaces) assert.equal(surface.includes(secret), false, `오류에 비밀 값이 실리면 안 된다: ${secret.slice(0, 3)}...`);
  }
}

// [resultCode, 일시 여부]. 일시 코드는 KRIC 공용 코드표(isTransientKricResultCode)가 정한다.
export const KRIC_RESULT_CODE_ROWS = Object.freeze([
  ["01", true], ["02", true], ["04", true], ["05", true], ["99", true],
  ["10", false], ["11", false], ["12", false], ["20", false], ["21", false], ["22", false], ["30", false], ["31", false], ["32", false], ["33", false], ["41", false],
]);
// 공공데이터포털 OpenAPI 게이트웨이: 30(SERVICE_KEY_IS_NOT_REGISTERED_ERROR)은 키 동기화 지연으로 간헐 발생해 일시로 본다. 23은 표에 없는 코드라 즉시 실패한다.
export const DATA_GO_KR_RESULT_CODE_ROWS = Object.freeze([
  ["01", true], ["02", true], ["04", true], ["05", true], ["30", true], ["99", true],
  ["10", false], ["11", false], ["12", false], ["20", false], ["21", false], ["22", false], ["23", false], ["31", false], ["32", false], ["33", false],
]);
// 부산교통공사 OpenAPI(data.humetro.busan.kr): data.go.kr 게이트웨이가 아니라 30·99만 일시, 나머지는 즉시 실패한다.
export const BUSAN_HUMETRO_RESULT_CODE_ROWS = Object.freeze([
  ["99", true], ["30", true],
  ["01", false], ["02", false], ["04", false], ["05", false], ["10", false], ["20", false], ["22", false], ["31", false],
]);
const EXHAUSTED_TRANSIENT_RESULT_CODE = "99";

/** 첫 요청(URL)을 보낸 횟수를 세는 fetch. respond(callNumber, url)이 응답을 만든다. */
function countingFetch(respond) {
  const state = { firstUrl: undefined, firstUrlCalls: 0 };
  const fetchImpl = async (...args) => {
    const url = String(args[0]);
    state.firstUrl ??= url;
    if (url === state.firstUrl) state.firstUrlCalls += 1;
    return respond(state.firstUrlCalls, args);
  };
  return { fetchImpl, state };
}

/**
 * resultCode 재시도 계약을 수집기들이 한 표로 검증한다.
 *   - 일시 코드: 첫 요청이 코드를 받은 뒤 성공하면 assertRecovered, 첫 요청은 정확히 2번 보낸다.
 *   - 일시 코드 소진: 계속 99를 받으면 3번만 보내고 assertFinal에 맡긴다(수집기의 명시 실패 또는 호출자에게 넘기는 응답).
 *   - 그 밖의 코드: 한 번만 보내고 assertFinal에 맡긴다.
 * @param {object} options
 * @param {string} options.name 수집기 이름(테스트 제목).
 * @param {ReadonlyArray<[string, boolean]>} options.rows [resultCode, 일시 여부]. 원천의 코드표 행이다.
 * @param {(resultCode: string) => Response} options.rejectedResponse 해당 resultCode를 담은 응답.
 * @param {Function} options.delegate 성공 응답을 만드는 fetch.
 * @param {(io: { fetchImpl: Function }) => Promise<unknown>} options.run 수집기를 실행한다(대기는 즉시 지나가게 주입).
 * @param {(result: unknown) => void} options.assertRecovered 재시도 뒤 성공한 결과를 확인한다.
 * @param {(outcome: Promise<unknown>, resultCode: string) => Promise<void>} options.assertFinal 재시도를 더 하지 않고 끝난 결과를 확인한다.
 */
export function defineResultCodeRetryTests({ name, rows, rejectedResponse, delegate, run, assertRecovered, assertFinal }) {
  for (const [resultCode, transient] of rows) {
    test(`${name}: resultCode ${resultCode}는 ${transient ? "재시도 뒤 성공한다" : "재시도 없이 끝난다"}`, async () => {
      const { fetchImpl, state } = countingFetch((call, args) => (call === 1 ? rejectedResponse(resultCode) : delegate(...args)));
      if (transient) {
        assertRecovered(await run({ fetchImpl }));
        assert.equal(state.firstUrlCalls, 2);
      } else {
        await assertFinal(run({ fetchImpl }), resultCode);
        assert.equal(state.firstUrlCalls, 1);
      }
    });
  }
  test(`${name}: 일시 resultCode ${EXHAUSTED_TRANSIENT_RESULT_CODE}가 계속되면 3회 시도 뒤 끝난다`, async () => {
    const { fetchImpl, state } = countingFetch(() => rejectedResponse(EXHAUSTED_TRANSIENT_RESULT_CODE));
    await assertFinal(run({ fetchImpl }), EXHAUSTED_TRANSIENT_RESULT_CODE);
    assert.equal(state.firstUrlCalls, 3);
  });
}

/** KRIC 코드표(KRIC_RESULT_CODE_ROWS)로 defineResultCodeRetryTests를 등록한다. */
export const defineKricResultCodeRetryTests = (options) => defineResultCodeRetryTests({ rows: KRIC_RESULT_CODE_ROWS, ...options });

/** 공공데이터포털 코드표(DATA_GO_KR_RESULT_CODE_ROWS)로 defineResultCodeRetryTests를 등록한다. */
export const defineDataGoKrResultCodeRetryTests = (options) => defineResultCodeRetryTests({ rows: DATA_GO_KR_RESULT_CODE_ROWS, ...options });

/** 부산교통공사 코드표(BUSAN_HUMETRO_RESULT_CODE_ROWS)로 defineResultCodeRetryTests를 등록한다. */
export const defineBusanHumetroResultCodeRetryTests = (options) => defineResultCodeRetryTests({ rows: BUSAN_HUMETRO_RESULT_CODE_ROWS, ...options });
