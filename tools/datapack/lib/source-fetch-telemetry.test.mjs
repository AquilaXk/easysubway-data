import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { assertErrorOmitsSecrets } from "./source-collection-retry-test-support.mjs";
import { fetchBytesWithSourceRetry, withSourceCollectionRetry } from "./source-collection-retry.mjs";
import {
  SOURCE_FETCH_TELEMETRY_PATH_ENV,
  buildAttemptRecord,
  emitAttemptRecord,
  errorCodeOf,
  hostOf,
  sourceIdFromLabel,
  stageOfErrorCode,
} from "./source-fetch-telemetry.mjs";
import { createTransientRetryBudget } from "./transient-retry.mjs";

const SECRET = "SECRET-KEY-9";
const SECRET_URL = `https://user:pw@apis.example.test:8443/path/to/api?serviceKey=${SECRET}&x=1#frag`;
const noSleep = async () => {};
const connectTimeout = () => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(`connect timeout ${SECRET_URL}`), { code: "UND_ERR_CONNECT_TIMEOUT" }) });

/** 계측 파일을 임시 경로에 연결해 body를 실행하고 기록된 줄들을 돌려준다. */
async function withTelemetryFile(body) {
  const directory = mkdtempSync(path.join(tmpdir(), "source-fetch-telemetry-"));
  const file = path.join(directory, "telemetry.jsonl");
  const previous = process.env[SOURCE_FETCH_TELEMETRY_PATH_ENV];
  process.env[SOURCE_FETCH_TELEMETRY_PATH_ENV] = file;
  try {
    await body();
    const text = (() => { try { return readFileSync(file, "utf8"); } catch { return ""; } })();
    return { text, records: text.split("\n").filter(Boolean).map((line) => JSON.parse(line)) };
  } finally {
    if (previous === undefined) delete process.env[SOURCE_FETCH_TELEMETRY_PATH_ENV]; else process.env[SOURCE_FETCH_TELEMETRY_PATH_ENV] = previous;
    rmSync(directory, { recursive: true, force: true });
  }
}

test("hostOf는 호스트만 남기고 경로·쿼리·포트·사용자 정보를 버린다", () => {
  assert.equal(hostOf(SECRET_URL), "apis.example.test");
  assert.equal(hostOf(new URL("https://openapi.kric.go.kr/a?b=c")), "openapi.kric.go.kr");
  assert.equal(hostOf("not a url"), "unknown");
});

test("errorCodeOf는 cause 사슬의 가장 깊은 코드를, 없으면 오류 이름을 쓰고 메시지는 읽지 않는다", () => {
  assert.equal(errorCodeOf(connectTimeout()), "UND_ERR_CONNECT_TIMEOUT");
  assert.equal(errorCodeOf(Object.assign(new Error("x"), { name: "TimeoutError" })), "TimeoutError");
  assert.equal(errorCodeOf(Object.assign(new Error("x"), { code: "bad code with spaces" })), "UNKNOWN");
  assert.equal(errorCodeOf(new Error(SECRET)), "UNKNOWN");
});

test("stageOfErrorCode는 undici·Node 코드에서 dns·connect·headers·body를 유추하고 모르면 unknown이다", () => {
  assert.deepEqual(
    ["ENOTFOUND", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "ECONNRESET", "TimeoutError"].map(stageOfErrorCode),
    ["dns", "connect", "headers", "body", "unknown", "unknown"],
  );
});

test("buildAttemptRecord는 성공·HTTP 오류·전송 오류를 안전한 필드만으로 기록한다", () => {
  const base = { sourceId: "kric-timetable", url: SECRET_URL, attempt: 2, durationMs: 123.6, nextDelayMs: null };
  assert.deepEqual(buildAttemptRecord({ ...base, response: { status: 200 } }), {
    sourceId: "kric-timetable", host: "apis.example.test", attempt: 2, outcome: "success", status: 200, durationMs: 124, nextDelayMs: null,
  });
  assert.equal(buildAttemptRecord({ ...base, response: { status: 503 }, nextDelayMs: 1500 }).outcome, "http_error");
  assert.deepEqual(buildAttemptRecord({ ...base, error: connectTimeout(), nextDelayMs: 900 }), {
    sourceId: "kric-timetable", host: "apis.example.test", attempt: 2, outcome: "error", errorCode: "UND_ERR_CONNECT_TIMEOUT", stage: "connect", durationMs: 124, nextDelayMs: 900,
  });
});

test("emitAttemptRecord는 환경 변수가 없으면 쓰지 않고, 쓰기에 실패해도 던지지 않는다", async () => {
  emitAttemptRecord({ a: 1 }, {});
  emitAttemptRecord({ a: 1 }, { [SOURCE_FETCH_TELEMETRY_PATH_ENV]: "/nonexistent-dir-for-telemetry/x.jsonl" });
  const { records } = await withTelemetryFile(async () => { emitAttemptRecord({ a: 1 }); });
  assert.deepEqual(records, [{ a: 1 }]);
});

test("sourceIdFromLabel은 label을 안전한 식별자로 바꾼다", () => {
  assert.equal(sourceIdFromLabel("KRIC subwayTimetable 서울역"), "kric-subwaytimetable");
  assert.equal(sourceIdFromLabel("한글"), "unknown");
});

test("withSourceCollectionRetry는 시도마다 한 줄을 남기고 다음 대기와 마지막 시도의 null을 기록한다", async () => {
  const outcomes = [() => { throw connectTimeout(); }, () => ({ response: new Response(null, { status: 503 }) }), () => ({ response: new Response(null, { status: 200 }) })];
  let call = 0;
  const { records, text } = await withTelemetryFile(async () => {
    await withSourceCollectionRetry(async () => outcomes[call++](), {
      label: "Example source", url: SECRET_URL, sleep: noSleep, budget: createTransientRetryBudget(), random: () => 0.5,
    });
  });
  assert.deepEqual(records.map(({ attempt, outcome, status, errorCode, stage, host, sourceId }) => ({ attempt, outcome, status, errorCode, stage, host, sourceId })), [
    { attempt: 1, outcome: "error", status: undefined, errorCode: "UND_ERR_CONNECT_TIMEOUT", stage: "connect", host: "apis.example.test", sourceId: "example-source" },
    { attempt: 2, outcome: "http_error", status: 503, errorCode: undefined, stage: undefined, host: "apis.example.test", sourceId: "example-source" },
    { attempt: 3, outcome: "success", status: 200, errorCode: undefined, stage: undefined, host: "apis.example.test", sourceId: "example-source" },
  ]);
  assert.deepEqual(records.map((record) => record.nextDelayMs), [1000, 2000, null]);
  assert.ok(records.every((record) => Number.isInteger(record.durationMs) && record.durationMs >= 0));
  assertErrorOmitsSecrets(new Error(text), [SECRET, "serviceKey", "user:pw", "/path/to/api"]);
});

test("소진된 전송 오류도 마지막 시도를 nextDelayMs null로 남기고 오류는 그대로 던진다", async () => {
  const { records } = await withTelemetryFile(async () => {
    await assert.rejects(withSourceCollectionRetry(async () => { throw connectTimeout(); }, {
      label: "Example source", url: SECRET_URL, sleep: noSleep, budget: createTransientRetryBudget(), random: () => 0,
    }), (error) => error.cause?.code === "UND_ERR_CONNECT_TIMEOUT");
  });
  assert.deepEqual(records.map((record) => [record.attempt, record.nextDelayMs]), [[1, 0], [2, 0], [3, null]]);
});

test("fetchBytesWithSourceRetry는 url의 호스트만 계측하고 serviceKey를 남기지 않는다", async () => {
  const { records, text } = await withTelemetryFile(async () => {
    const fetchImpl = async () => new Response("ok", { status: 200 });
    await fetchBytesWithSourceRetry({
      url: SECRET_URL, fetchImpl, accept: "application/json", label: "Example fetch", sourceId: "example-fetch", transportFailure: (failure) => failure, sleep: noSleep,
    });
  });
  assert.equal(records.length, 1);
  assert.equal(records[0].sourceId, "example-fetch");
  assert.equal(records[0].host, "apis.example.test");
  assertErrorOmitsSecrets(new Error(text), [SECRET, "serviceKey", "user:pw", "/path/to/api"]);
});

test("계측 환경 변수가 없으면 아무 파일도 만들지 않고 결과를 바꾸지 않는다", async () => {
  const previous = process.env[SOURCE_FETCH_TELEMETRY_PATH_ENV];
  delete process.env[SOURCE_FETCH_TELEMETRY_PATH_ENV];
  try {
    const result = await withSourceCollectionRetry(async () => ({ response: new Response(null, { status: 200 }) }), { label: "Quiet" });
    assert.equal(result.response.status, 200);
  } finally {
    if (previous !== undefined) process.env[SOURCE_FETCH_TELEMETRY_PATH_ENV] = previous;
  }
});
