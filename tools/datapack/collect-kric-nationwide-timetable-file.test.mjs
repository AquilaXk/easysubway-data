import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { deflateRawSync } from "node:zlib";

import {
  collectKricCurrentStationLineFile,
  collectKricNationwideTimetableFile,
  BODY_TIMEOUT_MS,
  DEFAULT_MAXIMUM_BYTES,
  HEADER_TIMEOUT_MS,
  KRIC_CURRENT_STATION_LINE_FILE_URL,
  KRIC_NATIONWIDE_TIMETABLE_FILE_URL,
  MIN_BODY_THROUGHPUT_BYTES_PER_SECOND,
  OBSERVED_FILE_BYTES,
  parseKricCurrentStationLineWorkbook,
} from "./collect-kric-nationwide-timetable-file.mjs";
import { createTransientRetryBudget } from "./lib/transient-retry.mjs";

// #1099: 일시 오류는 같은 요청을 1·2·4·8·16초 대기로 최대 5번 다시 보낸다. 재시도 대기와 예산은 테스트마다 격리한다.
const retryFast = (waits = []) => ({ sleepImpl: async (milliseconds) => { waits.push(milliseconds); }, retryBudget: createTransientRetryBudget() });

const ZIP = minimalXlsxZip();
const HEADERS = {
  "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "content-disposition": "attachment; filename=urban-timetable.xlsx",
  "content-length": `${ZIP.length}`,
};

test("#454 fixed credential-free file collector makes one HTTPS request and atomically writes one raw XLSX file", async () => {
  await withOutput(async ({ output, root }) => {
    const calls = [];
    const receipt = await collectKricNationwideTimetableFile({
      outputFile: output,
      now: new Date("2026-08-27T00:00:00.000Z"),
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return new Response(ZIP, { status: 200, headers: HEADERS });
      },
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, KRIC_NATIONWIDE_TIMETABLE_FILE_URL);
    assert.equal(calls[0].init.method, "GET");
    assert.equal(calls[0].init.redirect, "error");
    assert.equal(calls[0].init.headers["accept-encoding"], "identity");
    assert.equal(receipt.credentialRedacted, true);
    assert.deepEqual(await readFile(output), ZIP);
    assert.equal((await stat(output)).isFile(), true);
    assert.equal(receipt.rawFile, path.basename(output));
    assert.equal(JSON.stringify(receipt).includes("urban-timetable.xlsx"), false);
    assert.equal((await readdir(root)).sort().join(","), path.basename(output));
    assert.ok(output.startsWith(root));
  });
});

test("#455 fixed current station-line profile requests only KRIC FILE id=1294 through the shared bounded collector", async () => {
  assert.equal(
    KRIC_CURRENT_STATION_LINE_FILE_URL,
    "https://data.kric.go.kr/rips/dataset/download.file?type=filedata&id=1294&operation=1",
  );
  await withOutput(async ({ root }) => {
    const output = path.join(root, "kric-current-station-line-file-test.xlsx");
    const calls = [];
    const receipt = await collectKricCurrentStationLineFile({
      outputFile: output,
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return new Response(ZIP, { status: 200, headers: HEADERS });
      },
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, KRIC_CURRENT_STATION_LINE_FILE_URL);
    assert.equal(calls[0].init.method, "GET");
    assert.equal(receipt.artifactKind, "kric-current-station-line-file-receipt");
    assert.equal(receipt.sourceId, "kric-current-station-line-file");
    assert.deepEqual(await readFile(output), ZIP);
  });
});

test("#455 bounds ZIP entry inflation before a compressed workbook entry can expand", () => {
  const payload = Buffer.alloc(65, 0x61);
  const name = Buffer.from("xl/bomb.xml");
  const compressed = deflateRawSync(payload);
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(8, 8);
  header.writeUInt32LE(compressed.length, 18);
  header.writeUInt32LE(payload.length, 22);
  header.writeUInt16LE(name.length, 26);
  const bytes = Buffer.concat([header, name, compressed, ZIP]);
  assert.throws(() => parseKricCurrentStationLineWorkbook(bytes, { maximumInflatedBytes: 64 }), /WORKBOOK/);
});

test("#454 ignores absent or unusual Content-Disposition because the raw filename is fixed internally", async () => {
  await withOutput(async ({ output }) => {
    await collectKricNationwideTimetableFile({
      outputFile: output,
      fetchImpl: async () => new Response(ZIP, {
        status: 200,
        headers: { "content-type": HEADERS["content-type"], "content-length": HEADERS["content-length"] },
      }),
    });
    assert.deepEqual(await readFile(output), ZIP);
  });
});

test("#454 accepts KRIC application/octet-stream only with the same XLSX MIME and ZIP proof", async () => {
  await withOutput(async ({ output }) => {
    await collectKricNationwideTimetableFile({
      outputFile: output,
      fetchImpl: async () => new Response(ZIP, {
        status: 200,
        headers: { ...HEADERS, "content-type": "application/octet-stream" },
      }),
    });
    assert.deepEqual(await readFile(output), ZIP);
  });
});

test("#454 accepts decoded XLSX bytes when a provider ignores identity and returns non-identity Content-Encoding", async () => {
  await withOutput(async ({ output }) => {
    await collectKricNationwideTimetableFile({
      outputFile: output,
      fetchImpl: async () => new Response(ZIP, {
        status: 200,
        headers: { ...HEADERS, "content-encoding": "gzip", "content-length": `${ZIP.length - 1}` },
      }),
    });
    assert.deepEqual(await readFile(output), ZIP);
  });
});

test("#454 bounds streamed bytes before buffering and requires the XLSX central-directory entries", async () => {
  assert.equal(DEFAULT_MAXIMUM_BYTES, 128 * 1024 * 1024);
  await withOutput(async ({ output }) => {
    let bodyRead = false;
    await assert.rejects(collectKricNationwideTimetableFile({
      outputFile: output,
      maximumBytes: ZIP.length - 1,
      fetchImpl: async () => ({ status: 200, ok: true, redirected: false, url: "", headers: new Headers({ ...HEADERS }), body: { getReader: () => { bodyRead = true; } } }),
    }), /BODY/);
    assert.equal(bodyRead, false);
  });
  await withOutput(async ({ output }) => {
    let cancelled = false;
    await assert.rejects(collectKricNationwideTimetableFile({
      outputFile: output,
      maximumBytes: ZIP.length - 1,
      fetchImpl: async () => streamResponse(ZIP, { "content-type": HEADERS["content-type"] }, () => { cancelled = true; }),
    }), /BODY/);
    assert.equal(cancelled, true);
  });
  await withOutput(async ({ output }) => {
    await assert.rejects(collectKricNationwideTimetableFile({
      outputFile: output,
      fetchImpl: async () => new Response(minimalXlsxZip(["arbitrary.xml"]), { status: 200, headers: { ...HEADERS, "content-length": `${minimalXlsxZip(["arbitrary.xml"]).length}` } }),
    }), /BODY/);
  });
});

// #995: 504 run 37399282636(2026-10-06 01:28:56Z~01:29:27Z)이 정확히 30초 만에 KRIC_TIMETABLE_FILE_BODY로 실패했다.
// 원인: 연결과 본문 수신 전체에 같은 30초 한도(AbortSignal.timeout)를 걸었고, 17.9MB 파일이 느린 KRIC 서버에서 30초를 넘으면 본문 읽기가 중단됐다.
// 중단 오류는 BODY로 바뀌어 원인도 가려졌다. 연결·헤더 한도와 본문 한도를 나누고 본문 시간 초과는 TIMEOUT으로 드러낸다.
test("#995 timeout defaults separate the connection/header limit from the body transfer limit", () => {
  assert.equal(HEADER_TIMEOUT_MS, 30_000);
  assert.equal(BODY_TIMEOUT_MS, 5 * 60_000);
});

// 5분의 근거: 관측한 파일 크기를 최소 처리량으로 받는 데 걸리는 시간을 분 단위로 올림한 값이다.
// 실패한 두 run은 30초 안에 17.9MB를 받지 못했다(runner 처리량 < 약 0.6MB/s). 하한은 그 상한의 10분의 1(60KB/s)로 둔다.
test("#995 the body limit is derived from the observed size and a minimum throughput floor", () => {
  assert.equal(OBSERVED_FILE_BYTES, 17_949_564);
  assert.equal(MIN_BODY_THROUGHPUT_BYTES_PER_SECOND, 60_000);
  assert.ok(BODY_TIMEOUT_MS / 1000 * MIN_BODY_THROUGHPUT_BYTES_PER_SECOND >= OBSERVED_FILE_BYTES, "하한 처리량으로도 관측한 크기를 받을 수 있다");
  assert.ok(BODY_TIMEOUT_MS / 1000 * MIN_BODY_THROUGHPUT_BYTES_PER_SECOND - OBSERVED_FILE_BYTES < 60 * MIN_BODY_THROUGHPUT_BYTES_PER_SECOND, "분 단위 올림 이상으로 느슨하지 않다");
});

test("#995 a body that takes longer than the header limit still completes within the body limit", { timeout: 5000 }, async () => {
  await withOutput(async ({ output }) => {
    await collectKricNationwideTimetableFile({
      outputFile: output, headerTimeoutMs: 40, bodyTimeoutMs: 5000,
      fetchImpl: async (url, init) => slowResponse(ZIP, { delayMs: 80, chunks: 2, signal: init.signal }),
    });
    assert.deepEqual(await readFile(output), ZIP);
  });
});

test("#995 a body that exceeds the body limit fails as TIMEOUT, not BODY, and the stream is cancelled", { timeout: 5000 }, async () => {
  await withOutput(async ({ output, root }) => {
    await assert.rejects(collectKricNationwideTimetableFile({
      outputFile: output, bodyTimeoutMs: 50,
      fetchImpl: async () => slowResponse(ZIP, { delayMs: 400, chunks: 2 }),
    }), /KRIC_TIMETABLE_FILE_TIMEOUT/);
    assert.deepEqual(await readdir(root), [], "부분 본문을 남기지 않는다");
  });
});

test("#995 a request that gets no response within the header limit fails as TIMEOUT", { timeout: 5000 }, async () => {
  await withOutput(async ({ output }) => {
    await assert.rejects(collectKricNationwideTimetableFile({
      outputFile: output, headerTimeoutMs: 30, ...retryFast(),
      fetchImpl: (url, init) => new Promise((resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason))),
    }), /KRIC_TIMETABLE_FILE_TIMEOUT/);
  });
});

test("#995 a transport failure that is not a timeout stays TRANSPORT and invalid limits are rejected", async () => {
  await withOutput(async ({ output }) => {
    await assert.rejects(collectKricNationwideTimetableFile({ outputFile: output, fetchImpl: async () => { throw new Error("connection reset"); } }), /KRIC_TIMETABLE_FILE_TRANSPORT/);
    for (const bad of [0, -1, 1.5, "30"]) {
      await assert.rejects(collectKricNationwideTimetableFile({ outputFile: output, headerTimeoutMs: bad, fetchImpl: async () => new Response(ZIP, { status: 200, headers: HEADERS }) }), /KRIC_TIMETABLE_FILE_HEADERTIMEOUTMS_INVALID/);
      await assert.rejects(collectKricNationwideTimetableFile({ outputFile: output, bodyTimeoutMs: bad, fetchImpl: async () => new Response(ZIP, { status: 200, headers: HEADERS }) }), /KRIC_TIMETABLE_FILE_BODYTIMEOUTMS_INVALID/);
    }
  });
});

const streamBroken = (code) => {
  const body = new ReadableStream({ start(controller) { controller.error(Object.assign(new TypeError("terminated"), { cause: Object.assign(new Error("transport"), { code }) })); } });
  return { status: 200, ok: true, redirected: false, url: "", headers: new Headers({ ...HEADERS }), body };
};

test("#1099 HTTP 5xx·연결 timeout·헤더 한도·본문 중 연결 끊김 뒤 같은 요청이 성공하면 그 파일을 쓴다", { timeout: 5000 }, async () => {
  await withOutput(async ({ output, root }) => {
    const outcomes = [
      () => new Response("busy", { status: 503 }),
      () => { throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("connect timeout"), { code: "UND_ERR_CONNECT_TIMEOUT" }) }); },
      (init) => new Promise((resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason))),
      () => streamBroken("ECONNRESET"),
      () => new Response("bad gateway", { status: 502 }),
    ];
    let calls = 0;
    const waits = [];
    const receipt = await collectKricNationwideTimetableFile({
      outputFile: output, headerTimeoutMs: 30, ...retryFast(waits),
      fetchImpl: async (url, init) => { calls += 1; const next = outcomes.shift(); return next === undefined ? new Response(ZIP, { status: 200, headers: HEADERS }) : next(init); },
    });
    assert.equal(calls, 6);
    assert.deepEqual(waits, [1_000, 2_000, 4_000, 8_000, 16_000]);
    assert.deepEqual(await readFile(output), ZIP);
    assert.equal(receipt.byteLength, ZIP.length);
    assert.equal((await readdir(root)).sort().join(","), path.basename(output), "실패한 시도의 부분 본문을 남기지 않는다");
  });
});

test("#1099 일시 오류가 한도(5번)를 넘어 이어지면 기존 오류 코드로 실패하고 아무것도 쓰지 않는다", { timeout: 5000 }, async () => {
  const cases = [
    [() => new Response("busy", { status: 503 }), /KRIC_TIMETABLE_FILE_HTTP/],
    [() => { throw Object.assign(new Error("connect timeout"), { code: "UND_ERR_CONNECT_TIMEOUT" }); }, /KRIC_TIMETABLE_FILE_TRANSPORT/],
    [(init) => new Promise((resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason))), /KRIC_TIMETABLE_FILE_TIMEOUT/],
    [() => streamBroken("UND_ERR_SOCKET"), /KRIC_TIMETABLE_FILE_BODY/],
  ];
  for (const [respond, expectation] of cases) {
    await withOutput(async ({ output, root }) => {
      let calls = 0;
      const waits = [];
      await assert.rejects(collectKricNationwideTimetableFile({
        outputFile: output, headerTimeoutMs: 30, ...retryFast(waits),
        fetchImpl: async (url, init) => { calls += 1; return respond(init); },
      }), expectation);
      assert.equal(calls, 6, String(expectation));
      assert.deepEqual(waits, [1_000, 2_000, 4_000, 8_000, 16_000]);
      assert.deepEqual(await readdir(root), []);
    });
  }
});

// 본문 한도(5분)는 최소 처리량(60KB/s) 하한이다(#995). 재시도하면 한도가 6배가 되어 workflow timeout(45분)을 넘길 수 있고, 하한 아래로 느린 서버는 다시 받아도 같다.
test("#1099 본문 한도(처리량 하한)를 넘긴 TIMEOUT은 재시도하지 않는다", { timeout: 5000 }, async () => {
  await withOutput(async ({ output }) => {
    let calls = 0;
    const waits = [];
    await assert.rejects(collectKricNationwideTimetableFile({
      outputFile: output, bodyTimeoutMs: 50, ...retryFast(waits),
      fetchImpl: async () => { calls += 1; return slowResponse(ZIP, { delayMs: 400, chunks: 2 }); },
    }), /KRIC_TIMETABLE_FILE_TIMEOUT/);
    assert.equal(calls, 1);
    assert.deepEqual(waits, []);
  });
});

test("#1099 인증·쿼터·내용 오류(HTTP 401·403·429)는 재시도하지 않고, 현재 역-노선 파일도 같은 정책이다", async () => {
  for (const status of [401, 403, 429]) {
    await withOutput(async ({ root }) => {
      let calls = 0;
      await assert.rejects(collectKricCurrentStationLineFile({
        outputFile: path.join(root, "kric-current-station-line-file-test.xlsx"), ...retryFast(),
        fetchImpl: async () => { calls += 1; return new Response("denied", { status, headers: HEADERS }); },
      }), /KRIC_TIMETABLE_FILE_HTTP/);
      assert.equal(calls, 1, String(status));
    });
  }
  await withOutput(async ({ root }) => {
    let calls = 0;
    const output = path.join(root, "kric-current-station-line-file-test.xlsx");
    await collectKricCurrentStationLineFile({
      outputFile: output, ...retryFast(),
      fetchImpl: async () => { calls += 1; return calls === 1 ? new Response("busy", { status: 503 }) : new Response(ZIP, { status: 200, headers: HEADERS }); },
    });
    assert.equal(calls, 2);
    assert.deepEqual(await readFile(output), ZIP);
  });
});

test("#1099 재시도 대기 예산을 넘기면 마지막 시도의 오류 코드로 실패한다", async () => {
  await withOutput(async ({ output }) => {
    let calls = 0;
    await assert.rejects(collectKricNationwideTimetableFile({
      outputFile: output, sleepImpl: async () => {}, retryBudget: createTransientRetryBudget(2_500),
      fetchImpl: async () => { calls += 1; throw Object.assign(new Error("reset"), { code: "ECONNRESET" }); },
    }), /KRIC_TIMETABLE_FILE_TRANSPORT/);
    assert.equal(calls, 2);
  });
});

test("#454 rejects redirects, non-XLSX/partial bodies, and an existing output without retries or provider-body output", async () => {
  const cases = [
    { label: "redirect", response: new Response(ZIP, { status: 200, headers: HEADERS }), mutate: (value) => Object.defineProperty(value, "redirected", { value: true }), error: /REDIRECT/ },
    { label: "html", response: new Response("<html>credential=secret</html>", { status: 200, headers: { "content-type": "text/html", "content-disposition": "attachment; filename=bad.xlsx" } }), error: /CONTENT_TYPE/ },
    { label: "partial", response: new Response(ZIP.subarray(0, -1), { status: 200, headers: { ...HEADERS, "content-length": `${ZIP.length}` } }), error: /PARTIAL/ },
    { label: "not-found", response: new Response("provider private body", { status: 404, headers: HEADERS }), error: /HTTP/ },
  ];
  for (const entry of cases) {
    await withOutput(async ({ output }) => {
      entry.mutate?.(entry.response);
      let calls = 0;
      await assert.rejects(collectKricNationwideTimetableFile({ outputFile: output, fetchImpl: async () => { calls += 1; return entry.response; } }), entry.error, entry.label);
      assert.equal(calls, 1, entry.label);
      await assert.rejects(stat(output));
    });
  }
  await withOutput(async ({ output }) => {
    await writeFile(output, "foreign", { flag: "wx" });
    let calls = 0;
    await assert.rejects(collectKricNationwideTimetableFile({ outputFile: output, fetchImpl: async () => { calls += 1; } }), /OUTPUT_EXISTS/);
    assert.equal(calls, 0);
  });
  await withOutput(async ({ output }) => {
    await assert.rejects(collectKricNationwideTimetableFile({
      outputFile: output,
      fetchImpl: async () => {
        await writeFile(output, "foreign", { flag: "wx" });
        return new Response(ZIP, { status: 200, headers: HEADERS });
      },
    }), /KRIC_TIMETABLE_FILE_OUTPUT/);
  });
});

test("#454 preserves foreign bytes when the output appears at the no-replace publish boundary", async () => {
  await withOutput(async ({ output, root }) => {
    const foreign = Buffer.from("foreign XLSX target bytes");
    await assert.rejects(collectKricNationwideTimetableFile({
      outputFile: output,
      fetchImpl: async () => new Response(ZIP, { status: 200, headers: HEADERS }),
      beforePublish: async () => writeFile(output, foreign, { flag: "wx" }),
    }), /OUTPUT/);
    assert.deepEqual(await readFile(output), foreign);
    assert.equal((await readdir(root)).sort().join(","), path.basename(output));
  });
});

// 본문이 천천히 도착하는 응답. signal을 받으면 실제 fetch처럼 중단되면 읽기가 실패한다.
function slowResponse(bytes, { delayMs, chunks = 2, signal } = {}) {
  let sent = 0;
  const size = Math.ceil(bytes.length / chunks);
  const body = new ReadableStream({
    async pull(controller) {
      if (sent >= chunks) { controller.close(); return; }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      signal?.throwIfAborted();
      controller.enqueue(bytes.subarray(sent * size, (sent + 1) * size));
      sent += 1;
    },
  });
  return { status: 200, ok: true, redirected: false, url: "", headers: new Headers({ ...HEADERS }), body };
}

function streamResponse(bytes, headers, onCancel) {
  const stream = new ReadableStream({
    start(controller) { controller.enqueue(bytes); },
    cancel() { onCancel(); },
  });
  return { status: 200, ok: true, redirected: false, url: "", headers: new Headers(headers), body: stream };
}

function minimalXlsxZip(names = ["[Content_Types].xml", "xl/workbook.xml"]) {
  let offset = 0;
  const locals = names.map((name) => {
    const filename = Buffer.from(name);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(filename.length, 26);
    const entry = Buffer.concat([header, filename]);
    const value = { filename, offset, entry };
    offset += entry.length;
    return value;
  });
  const central = locals.map(({ filename, offset: localOffset }) => {
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(filename.length, 28);
    header.writeUInt32LE(localOffset, 42);
    return Buffer.concat([header, filename]);
  });
  const centralBytes = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(names.length, 8);
  eocd.writeUInt16LE(names.length, 10);
  eocd.writeUInt32LE(centralBytes.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals.map(({ entry }) => entry), centralBytes, eocd]);
}

async function withOutput(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "kric-file-test-"));
  try { await run({ root, output: path.join(root, "kric-nationwide-timetable-file-test.xlsx") }); } finally { await rm(root, { recursive: true, force: true }); }
}
