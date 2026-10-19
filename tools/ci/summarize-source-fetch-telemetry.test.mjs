import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { parseTelemetry, percentile, renderSummary, summarizeByHost, summarizeFile } from "./summarize-source-fetch-telemetry.mjs";

const line = (record) => JSON.stringify(record);
const attempt = (host, durationMs, extra = {}) => line({ sourceId: "s", host, attempt: 1, outcome: "success", status: 200, durationMs, nextDelayMs: null, ...extra });
const timeout = (host, durationMs) => attempt(host, durationMs, { outcome: "error", status: undefined, errorCode: "UND_ERR_CONNECT_TIMEOUT", stage: "connect" });
const http503 = (host, durationMs) => attempt(host, durationMs, { outcome: "http_error", status: 503 });

test("percentile은 nearest-rank로 p50·p95를 고른다", () => {
  const values = Array.from({ length: 20 }, (_, index) => (index + 1) * 10);
  assert.equal(percentile(values, 50), 100);
  assert.equal(percentile(values, 95), 190);
  assert.equal(percentile([7], 95), 7);
});

test("parseTelemetry는 읽을 수 없는 줄을 건너뛰고 개수를 센다", () => {
  const { records, skipped } = parseTelemetry([attempt("a.test", 5), "not json", line({ host: "b.test" }), ""].join("\n"));
  assert.equal(records.length, 1);
  assert.equal(skipped, 2);
});

test("summarizeByHost는 호스트별 시도·실패·오류 코드별 개수·p50·p95를 센다", () => {
  const text = [attempt("b.test", 100), timeout("a.test", 15000), timeout("a.test", 15010), http503("a.test", 200), attempt("a.test", 300)].join("\n");
  assert.deepEqual(summarizeByHost(parseTelemetry(text).records), [
    { host: "a.test", attempts: 4, failures: 3, errorCodes: "HTTP 503 1, UND_ERR_CONNECT_TIMEOUT 2", p50Ms: 300, p95Ms: 15010 },
    { host: "b.test", attempts: 1, failures: 0, errorCodes: "", p50Ms: 100, p95Ms: 100 },
  ]);
});

test("renderSummary는 Markdown 표를 만들고 실패가 없으면 오류 코드 칸에 -를 쓴다", () => {
  const markdown = renderSummary([timeout("a.test", 15000), attempt("b.test", 100), "garbage"].join("\n"));
  assert.match(markdown, /\| 호스트 \| 시도 \| 실패 \| 오류 코드별 \| p50 ms \| p95 ms \|/u);
  assert.match(markdown, /\| a\.test \| 1 \| 1 \| UND_ERR_CONNECT_TIMEOUT 1 \| 15000 \| 15000 \|/u);
  assert.match(markdown, /\| b\.test \| 1 \| 0 \| - \| 100 \| 100 \|/u);
  assert.match(markdown, /읽을 수 없는 계측 1줄/u);
});

test("계측이 비어 있거나 파일이 없으면 기록이 없다고 쓴다", async () => {
  assert.match(renderSummary(""), /기록된 수집 시도가 없다/u);
  assert.match(await summarizeFile("/nonexistent-dir-for-telemetry/none.jsonl"), /기록된 수집 시도가 없다/u);
});

test("CLI는 --input 파일을 읽어 표를 stdout으로 내고, 인자가 없으면 2로 끝난다", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "summarize-telemetry-"));
  try {
    const file = path.join(directory, "t.jsonl");
    writeFileSync(file, `${attempt("a.test", 10)}\n`);
    const script = path.join(import.meta.dirname, "summarize-source-fetch-telemetry.mjs");
    assert.match(execFileSync("node", [script, "--input", file], { encoding: "utf8" }), /\| a\.test \| 1 \| 0 \| - \| 10 \| 10 \|/u);
    assert.throws(() => execFileSync("node", [script], { stdio: "pipe" }), (error) => error.status === 2);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
