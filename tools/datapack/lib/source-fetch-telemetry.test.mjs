import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { countTelemetryRequests } from "../../ci/provider-call-ledger.mjs";
import { assertErrorOmitsSecrets } from "./source-collection-retry-test-support.mjs";
import { fetchBytesWithSourceRetry, withSourceCollectionRetry } from "./source-collection-retry.mjs";
import {
  SOURCE_FETCH_TELEMETRY_PATH_ENV,
  TELEMETRY_WRITE_FAILED_MARKER,
  buildAttemptRecord,
  emitAttemptRecord,
  errorCodeOf,
  hostOf,
  sourceIdFromLabel,
  stageOfErrorCode,
} from "./source-fetch-telemetry.mjs";
import { causeChainDetails, createTransientRetryBudget } from "./transient-retry.mjs";

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

test("emitAttemptRecord는 환경 변수가 없으면 쓰지 않고, 있으면 기록 한 줄을 덧붙인다", async () => {
  emitAttemptRecord({ a: 1 }, {});
  const { records } = await withTelemetryFile(async () => { emitAttemptRecord({ a: 1 }); });
  assert.deepEqual(records, [{ a: 1 }]);
});

test("sourceIdFromLabel은 label을 안전한 식별자로 바꾼다", () => {
  assert.equal(sourceIdFromLabel("KRIC subwayTimetable 서울역"), "kric-subwaytimetable");
  assert.equal(sourceIdFromLabel("한글"), "unknown");
});

test("sourceIdFromLabel은 양끝의 구분자를 지우고 연속 구분자를 하나로 줄인다", () => {
  assert.equal(sourceIdFromLabel("--KRIC__  Timetable!!"), "kric-timetable");
  assert.equal(sourceIdFromLabel("---"), "unknown");
  assert.equal(sourceIdFromLabel("a".repeat(60)), "a".repeat(48));
  assert.equal(sourceIdFromLabel("a!".repeat(100_000)).length, 48);
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

// F2(#1370): 코드를 가진 cause가 여러 층이면 가장 깊은 코드를 쓴다. 첫 코드를 고르는 mutant는 여기서 죽는다.
test("errorCodeOf는 코드를 가진 cause가 여러 층이면 가장 깊은 코드를 고른다", () => {
  const innermost = Object.assign(new Error("inner"), { code: "UND_ERR_CONNECT_TIMEOUT" });
  const middle = Object.assign(new Error("middle", { cause: innermost }), { code: "FETCH_FAILED" });
  const outer = Object.assign(new Error("outer", { cause: middle }), { code: "COLLECTOR_TRANSPORT" });
  assert.equal(errorCodeOf(outer), "UND_ERR_CONNECT_TIMEOUT");
  assert.equal(errorCodeOf(Object.assign(new Error("outer", { cause: new Error("no code") }), { code: "COLLECTOR_TRANSPORT" })), "COLLECTOR_TRANSPORT");
});

// F5: 순회는 transient-retry의 helper 하나다. 순환·읽다가 던지는 getter에서 멈춘다.
test("causeChainDetails는 순환에서 멈추고 던지는 getter 앞까지만 돌려준다", () => {
  const first = new Error("first");
  const second = Object.assign(new Error("second", { cause: first }), { code: "B" });
  first.cause = second;
  assert.deepEqual(causeChainDetails(second).map(({ code }) => code), ["B", ""]);
  const hostile = Object.defineProperty(new Error("hostile"), "code", { get() { throw new Error("getter"); } });
  assert.deepEqual(causeChainDetails(new Error("wrapper", { cause: hostile })).length, 1);
  assert.equal(errorCodeOf(hostile), "UNKNOWN");
});

// F1: 관측은 결과를 바꾸지 않는다.
test("계측 중 예외가 나도 원래 오류와 결과가 그대로 나온다", async () => {
  const hostile = Object.defineProperty(new TypeError("original failure"), "code", { get() { throw new Error("getter boom"); } });
  await withTelemetryFile(async () => {
    await assert.rejects(withSourceCollectionRetry(async () => { throw hostile; }, {
      label: "Hostile", sleep: noSleep, budget: createTransientRetryBudget(), isTransientError: () => false,
    }), (error) => error === hostile);
    const hostileUrl = Object.defineProperty(new Response(null, { status: 200 }), "url", { get() { throw new Error("url boom"); } });
    const result = await withSourceCollectionRetry(async () => ({ response: hostileUrl }), { label: "Hostile url", budget: createTransientRetryBudget() });
    assert.equal(result.response, hostileUrl);
    await assert.rejects(withSourceCollectionRetry(async () => { throw hostile; }, { label: "Throwing result code", resultCodeOf: () => { throw new Error("rc boom"); }, isTransientError: () => false }), (error) => error === hostile);
    const retried = await withSourceCollectionRetry(async () => ({ response: new Response(null, { status: 200 }) }), {
      label: "Throwing result code", isTransientResult: () => { throw new Error("predicate boom"); }, budget: createTransientRetryBudget(),
    }).catch((error) => error);
    assert.equal(retried.message, "predicate boom", "재시도 판정이 던지는 오류는 계측과 무관하게 원래대로 전파된다");
  });
});

// F3: 2xx지만 본문 resultCode 때문에 재시도한 시도는 success가 아니다.
test("본문 resultCode 때문에 재시도한 2xx 시도는 retryable_result와 resultCode로 남기고 소진된 마지막 시도도 같다", async () => {
  const codes = ["99", "99", "SECRET-KEY-9 with spaces"];
  let call = 0;
  const { records, text } = await withTelemetryFile(async () => {
    await withSourceCollectionRetry(async () => ({ response: new Response(null, { status: 200 }), code: codes[call++] }), {
      label: "Provider body", url: SECRET_URL, sleep: noSleep, budget: createTransientRetryBudget(), random: () => 0,
      isTransientResult: () => true, resultCodeOf: ({ code }) => code,
    });
  });
  assert.deepEqual(records.map(({ outcome, status, resultCode, nextDelayMs }) => ({ outcome, status, resultCode, nextDelayMs })), [
    { outcome: "retryable_result", status: 200, resultCode: "99", nextDelayMs: 0 },
    { outcome: "retryable_result", status: 200, resultCode: "99", nextDelayMs: 0 },
    { outcome: "retryable_result", status: 200, resultCode: undefined, nextDelayMs: null },
  ]);
  assertErrorOmitsSecrets(new Error(text), [SECRET]);
});

// 쓰기 실패는 치명적이다(PR #1452 F3). 이 파일이 하루 호출 예산의 증거라서, 잃어버린 기록은 요청 수를 적게 세어 예산을 부당하게 풀어준다.
// 실패하면 collector가 던진 오류를 삼켜도 프로세스가 이름 있는 코드로 0이 아닌 상태로 끝난다. 종료 상태를 보려면 자식 프로세스가 필요하다.
const UNWRITABLE_TELEMETRY = "/nonexistent-dir-for-telemetry/x.jsonl";
const telemetryModuleUrl = JSON.stringify(new URL("./source-fetch-telemetry.mjs", import.meta.url).href);
const retryModuleUrl = JSON.stringify(new URL("./source-collection-retry.mjs", import.meta.url).href);
const runChild = (script) => spawnSync(process.execPath, ["--input-type=module", "-e", script], {
  encoding: "utf8", env: { ...process.env, [SOURCE_FETCH_TELEMETRY_PATH_ENV]: UNWRITABLE_TELEMETRY },
});

test("계측 쓰기가 실패하면 emitAttemptRecord가 SOURCE_FETCH_TELEMETRY_WRITE_FAILED로 던지고 프로세스는 0이 아닌 상태로 끝난다", () => {
  const child = runChild(`
    const { emitAttemptRecord } = await import(${telemetryModuleUrl});
    try { emitAttemptRecord({ a: 1 }); } catch (error) { process.stdout.write(error.code); }
    try { emitAttemptRecord({ a: 2 }); } catch { /* 두 번째 실패도 센다 */ }
  `);
  assert.equal(child.stdout, "SOURCE_FETCH_TELEMETRY_WRITE_FAILED");
  assert.equal(child.status, 1);
  assert.equal(child.stderr.trim().split("\n").length, 1);
  assert.match(child.stderr, /^::error title=Source fetch telemetry::SOURCE_FETCH_TELEMETRY_WRITE_FAILED: 2 attempt records could not be written/u);
});

test("수집 재시도 래퍼는 계측 쓰기 실패를 삼키지 않고, collector가 그 오류를 잡아도 프로세스는 0이 아닌 상태로 끝난다", () => {
  const child = runChild(`
    const { withSourceCollectionRetry } = await import(${retryModuleUrl});
    try {
      await withSourceCollectionRetry(async () => ({ response: new Response(null, { status: 200 }) }), { label: "Lost telemetry" });
      process.stdout.write("RESOLVED");
    } catch (error) { process.stdout.write(error.code); }
  `);
  assert.equal(child.stdout, "SOURCE_FETCH_TELEMETRY_WRITE_FAILED");
  assert.equal(child.status, 1);
});

// 실패한 run도 계측 artifact를 올린다. 일부만 쓰인 파일이 정확한 요청 수로 읽히면 예산이 부당하게 풀리므로, 기록을 잃은 파일은 호출 기록이 증명 불가로 거부한다.
test("기록을 잃은 파일에는 표지 줄이 남아 호출 기록이 그 파일의 요청 수를 증명하지 않는다", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "source-fetch-telemetry-lost-"));
  try {
    const file = path.join(directory, "telemetry.jsonl");
    const attempt = { sourceId: "kept-source", host: "example.test", attempt: 1, outcome: "success" };
    // 첫 기록은 쓰고, 그 뒤 시도 기록의 쓰기만 실패하게 한다(표지 줄은 쓸 수 있는 일시 오류).
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import fs from "node:fs";
      import { syncBuiltinESMExports } from "node:module";
      const append = fs.appendFileSync;
      let failing = false;
      fs.appendFileSync = (target, data) => { if (failing && !data.includes("telemetryWriteFailed")) throw new Error("disk full"); return append(target, data); };
      syncBuiltinESMExports();
      const { emitAttemptRecord } = await import(${telemetryModuleUrl});
      emitAttemptRecord(${JSON.stringify(attempt)});
      failing = true;
      try { emitAttemptRecord(${JSON.stringify({ ...attempt, attempt: 2 })}); } catch { /* 오류 전파는 위 테스트가 본다 */ }
    `], { encoding: "utf8", env: { ...process.env, [SOURCE_FETCH_TELEMETRY_PATH_ENV]: file } });
    assert.equal(child.status, 1);
    const lines = readFileSync(file, "utf8").trim().split("\n");
    assert.equal(lines.length, 2);
    assert.equal(lines[1], TELEMETRY_WRITE_FAILED_MARKER);
    assert.throws(() => countTelemetryRequests(readFileSync(file)), /^Error: PROVIDER_CALL_TELEMETRY_INVALID/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("계측 파일이 쓸 수 있으면 같은 래퍼가 결과를 그대로 돌려주고 프로세스는 0으로 끝난다", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "source-fetch-telemetry-ok-"));
  try {
    const file = path.join(directory, "telemetry.jsonl");
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
      const { withSourceCollectionRetry } = await import(${retryModuleUrl});
      const result = await withSourceCollectionRetry(async () => ({ response: new Response(null, { status: 200 }) }), { label: "Kept telemetry" });
      process.stdout.write(String(result.response.status));
    `], { encoding: "utf8", env: { ...process.env, [SOURCE_FETCH_TELEMETRY_PATH_ENV]: file } });
    assert.equal(child.stdout, "200");
    assert.equal(child.status, 0);
    assert.equal(readFileSync(file, "utf8").trim().split("\n").length, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
