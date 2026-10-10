import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { collectKorailMetropolitanTimetableFile, validateKorailTimetableFileReceipt } from "./collect-korail-metropolitan-timetable-file.mjs";
import { createTransientRetryBudget } from "./lib/transient-retry.mjs";

const URL = "https://www.korail.com/file/cubedata/COMMON/jfile/metropolitan-timetable.xlsx";
const XLSX = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]);
const SHA256 = createHash("sha256").update(XLSX).digest("hex");

test("collects retained official XLSX bytes and creates the fixed receipt", async () => {
  await withDirectory(async (outputDirectory) => {
    const calls = [];
    const receipt = await collectKorailMetropolitanTimetableFile({
      url: URL, expectedSha256: SHA256, outputDirectory,
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return new Response(XLSX, { status: 200, headers: { "content-type": "application/octet-stream" } });
      },
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, URL);
    assert.equal(calls[0].init.method, "GET");
    assert.equal(calls[0].init.redirect, "error");
    assert.deepEqual(await readFile(path.join(outputDirectory, "timetable.xlsx")), XLSX);
    assert.deepEqual(await readdir(outputDirectory), ["receipt.json", "timetable.xlsx"]);
    assert.equal((await stat(path.join(outputDirectory, "receipt.json"))).isFile(), true);
    assert.deepEqual(JSON.parse(await readFile(path.join(outputDirectory, "receipt.json"), "utf8")), receipt);
    assert.deepEqual(validateKorailTimetableFileReceipt(receipt, { rawSha256: SHA256, rawByteLength: XLSX.length }), receipt);
    assert.throws(() => validateKorailTimetableFileReceipt({ ...receipt, byteLength: XLSX.length + 1 },
      { rawSha256: SHA256, rawByteLength: XLSX.length }), /RECEIPT/);
    assert.deepEqual(receipt, {
      schemaVersion: 1, artifactKind: "korail-metropolitan-timetable-file-receipt",
      sourceId: "korail-metropolitan-timetable-file", capturedAt: receipt.capturedAt,
      rawFile: "timetable.xlsx", byteLength: XLSX.length, sha256: SHA256,
      officialUrl: URL, credentialRedacted: true,
    });
  });
});

test("rejects a SHA mismatch without creating a success receipt", async () => {
  await withParent(async (parent) => {
    const outputDirectory = path.join(parent, "capture");
    await assert.rejects(collectKorailMetropolitanTimetableFile({
      url: URL, expectedSha256: "0".repeat(64), outputDirectory,
      fetchImpl: async () => new Response(XLSX, { status: 200, headers: { "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" } }),
    }), /KORAIL_METROPOLITAN_TIMETABLE_FILE_SHA256/);
    await assert.rejects(stat(path.join(outputDirectory, "receipt.json")));
  });
});

test("rejects a non-official URL before making a network call", async () => {
  await withParent(async (parent) => {
    let calls = 0;
    await assert.rejects(collectKorailMetropolitanTimetableFile({
      url: "https://www.korail.com/other.xlsx", expectedSha256: SHA256,
      outputDirectory: path.join(parent, "capture"), fetchImpl: async () => { calls += 1; },
    }), /KORAIL_METROPOLITAN_TIMETABLE_FILE_URL/);
    assert.equal(calls, 0);
  });
});

// #1099: 일시 오류(HTTP 408·5xx, 연결·본문 timeout)는 같은 요청을 1·2·4·8·16초 대기로 최대 5번 다시 보낸다. 재시도 대기와 예산은 테스트마다 격리한다.
const retryFast = (waits = []) => ({ sleepImpl: async (milliseconds) => { waits.push(milliseconds); }, retryBudget: createTransientRetryBudget() });
const XLSX_HEADERS = { "content-type": "application/octet-stream" };
const xlsxResponse = () => new Response(XLSX, { status: 200, headers: XLSX_HEADERS });
const brokenBody = (code) => new Response(new ReadableStream({
  start(controller) { controller.error(Object.assign(new TypeError("terminated"), { cause: Object.assign(new Error("transport"), { code }) })); },
}), { status: 200, headers: XLSX_HEADERS });

test("HTTP 5xx·연결 timeout·본문 수신 오류 뒤 같은 요청이 성공하면 그 파일로 수집한다", async () => {
  await withDirectory(async (outputDirectory) => {
    const outcomes = [
      () => new Response("busy", { status: 503 }),
      () => { throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("connect timeout"), { code: "UND_ERR_CONNECT_TIMEOUT" }) }); },
      () => brokenBody("UND_ERR_BODY_TIMEOUT"),
      () => brokenBody("ECONNRESET"),
      () => new Response("gateway", { status: 502 }),
    ];
    let calls = 0;
    const waits = [];
    const receipt = await collectKorailMetropolitanTimetableFile({
      url: URL, expectedSha256: SHA256, outputDirectory, ...retryFast(waits),
      fetchImpl: async () => { calls += 1; const next = outcomes.shift(); return next === undefined ? xlsxResponse() : next(); },
    });
    assert.equal(calls, 6);
    assert.deepEqual(waits, [1_000, 2_000, 4_000, 8_000, 16_000]);
    assert.deepEqual(await readdir(outputDirectory), ["receipt.json", "timetable.xlsx"]);
    assert.deepEqual(await readFile(path.join(outputDirectory, "timetable.xlsx")), XLSX);
    assert.equal(receipt.sha256, SHA256);
  });
});

test("일시 오류가 한도(5번)를 넘어 이어지면 기존 오류 코드로 실패하고 receipt를 남기지 않는다", async () => {
  const cases = [
    [() => new Response("busy", { status: 503 }), /KORAIL_METROPOLITAN_TIMETABLE_FILE_HTTP$/],
    [() => { throw Object.assign(new Error("connect timeout"), { code: "UND_ERR_CONNECT_TIMEOUT" }); }, /KORAIL_METROPOLITAN_TIMETABLE_FILE_TRANSPORT$/],
    [() => brokenBody("UND_ERR_BODY_TIMEOUT"), /KORAIL_METROPOLITAN_TIMETABLE_FILE_BODY$/],
  ];
  for (const [respond, expectation] of cases) {
    await withDirectory(async (outputDirectory) => {
      let calls = 0;
      const waits = [];
      await assert.rejects(collectKorailMetropolitanTimetableFile({
        url: URL, expectedSha256: SHA256, outputDirectory, ...retryFast(waits),
        fetchImpl: async () => { calls += 1; return respond(); },
      }), expectation);
      assert.equal(calls, 6);
      assert.deepEqual(waits, [1_000, 2_000, 4_000, 8_000, 16_000]);
      assert.deepEqual(await readdir(outputDirectory), []);
    });
  }
});

test("인증·내용 오류(HTTP 403·404·429, 형식, SHA, 리다이렉트)는 재시도하지 않는다", async () => {
  const cases = [
    [() => new Response("denied", { status: 403 }), /_HTTP$/],
    [() => new Response("missing", { status: 404 }), /_HTTP$/],
    [() => new Response("slow", { status: 429 }), /_HTTP$/],
    [() => new Response(XLSX, { status: 200, headers: { "content-type": "text/html" } }), /_CONTENT_TYPE$/],
    [() => new Response(Buffer.from("not an xlsx"), { status: 200, headers: XLSX_HEADERS }), /_XLSX$/],
    [() => xlsxResponse(), /_SHA256$/],
  ];
  for (const [respond, expectation] of cases) {
    await withDirectory(async (outputDirectory) => {
      let calls = 0;
      const waits = [];
      await assert.rejects(collectKorailMetropolitanTimetableFile({
        url: URL, expectedSha256: expectation.source.includes("SHA256") ? "0".repeat(64) : SHA256, outputDirectory, ...retryFast(waits),
        fetchImpl: async () => { calls += 1; return respond(); },
      }), expectation);
      assert.equal(calls, 1, String(expectation));
      assert.deepEqual(waits, []);
    });
  }
});

test("재시도 대기 예산을 넘기면 마지막 시도의 오류 코드로 실패한다", async () => {
  await withDirectory(async (outputDirectory) => {
    let calls = 0;
    await assert.rejects(collectKorailMetropolitanTimetableFile({
      url: URL, expectedSha256: SHA256, outputDirectory, sleepImpl: async () => {}, retryBudget: createTransientRetryBudget(2_500),
      fetchImpl: async () => { calls += 1; throw Object.assign(new Error("reset"), { code: "ECONNRESET" }); },
    }), /KORAIL_METROPOLITAN_TIMETABLE_FILE_TRANSPORT$/);
    assert.equal(calls, 2);
  });
});

async function withDirectory(run) {
  await withParent(async (parent) => run(path.join(parent, "capture")));
}

async function withParent(run) {
  const parent = await mkdtemp(path.join(os.tmpdir(), "korail-file-test-"));
  try { await run(parent); } finally { await rm(parent, { recursive: true, force: true }); }
}
