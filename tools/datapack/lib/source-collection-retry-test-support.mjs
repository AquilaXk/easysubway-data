// 원천 수집기 테스트가 공유하는 재시도 계약 헬퍼(data #1334). 수집기마다 같은 세 행을 복붙하지 않고 defineSourceCollectionRetryTests 한 번으로 등록한다.
//   1. 요청이 timeout으로 한 번 실패한 뒤 성공하면 재시도 없던 수집과 같은 결과를 낸다.
//   2. 본문 수신 중 timeout으로 한 번 실패한 뒤 성공해도 같다(재시도 단위가 요청 + 본문 읽기여야 한다).
//   3. 비일시 오류(HTTP 403)는 재시도하지 않고 즉시 실패한다.
import assert from "node:assert/strict";
import test from "node:test";

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

/** 첫 호출만 failure로 바꾸고 나머지는 delegate에 넘긴다. */
export function fetchWithFirstFailure(delegate, failureKind, headers) {
  const state = { calls: 0 };
  const fetchImpl = async (...args) => {
    state.calls += 1;
    return state.calls === 1 ? FIRST_FAILURES[failureKind](headers) : delegate(...args);
  };
  return { fetchImpl, state };
}

/**
 * @param {object} options
 * @param {string} options.name 수집기 이름(테스트 제목).
 * @param {(io: { fetchImpl: Function, sleepImpl: Function }) => Promise<unknown>} options.run 수집기를 실행하고 비교할 결과를 돌려준다. now·난수 같은 비결정 입력은 고정한다.
 * @param {Function} options.delegate 성공 응답을 만드는 fetch.
 * @param {Record<string, string>} [options.headers] 본문 timeout 응답에 붙일 헤더.
 */
export function defineSourceCollectionRetryTests({ name, run, delegate, headers }) {
  const noSleep = async () => {};
  for (const [failureKind, label] of [["requestTimeout", "요청 timeout"], ["bodyTimeout", "본문 수신 timeout"]]) {
    test(`${name}: ${label} 1회 뒤 성공하면 정상 수집한다`, async () => {
      const expected = await run({ fetchImpl: delegate, sleepImpl: noSleep });
      const { fetchImpl, state } = fetchWithFirstFailure(delegate, failureKind, headers);
      assert.deepEqual(await run({ fetchImpl, sleepImpl: noSleep }), expected);
      assert.ok(state.calls >= 2, "첫 호출 실패 뒤 같은 요청을 다시 보내야 한다");
    });
  }
  test(`${name}: 비일시 오류(HTTP 403)는 재시도 없이 즉시 실패한다`, async () => {
    const { fetchImpl } = fetchWithFirstFailure(delegate, "forbidden", headers);
    await assert.rejects(run({ fetchImpl, sleepImpl: noSleep }));
  });
}
