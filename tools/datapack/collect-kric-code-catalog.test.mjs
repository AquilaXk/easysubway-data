import assert from "node:assert/strict";
import test from "node:test";

import { downloadKricCodeCatalog, parseArgs } from "./collect-kric-code-catalog.mjs";

const XLSX_PREFIX = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);

test("KRIC 코드 정본 CLI는 두 absolute output 인자를 요구한다", () => {
  assert.deepEqual(parseArgs([
    "--output", "/tmp/catalog.xlsx",
    "--metadata-output", "/tmp/catalog.json",
  ]), { output: "/tmp/catalog.xlsx", metadataOutput: "/tmp/catalog.json" });
  assert.throws(() => parseArgs(["--output", "/tmp/catalog.xlsx"]), /usage/);
  assert.throws(() => parseArgs([
    "--metadata-output", "/tmp/catalog.json",
    "--output", "/tmp/catalog.xlsx",
  ]), /usage/);
  assert.throws(() => parseArgs([
    "--output", "catalog.xlsx",
    "--metadata-output", "/tmp/catalog.json",
  ]), /absolute/);
});

test("KRIC 최신 코드 정본은 XLSX 경계와 sanitized metadata를 검증한다", async () => {
  const catalog = await downloadKricCodeCatalog({
    now: new Date("2026-07-19T00:00:00.000Z"),
    fetchImpl: async (url) => {
      assert.equal(
        String(url),
        "https://data.kric.go.kr/rips/download.file?answerId=395&fileId=1&id=395&type=N",
      );
      return new Response(XLSX_PREFIX, {
        status: 200,
        headers: { "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
      });
    },
  });

  assert.equal(catalog.metadata.artifactKind, "kric-provider-code-catalog-download");
  assert.equal(catalog.metadata.capturedAt, "2026-07-19T00:00:00.000Z");
  assert.equal(catalog.metadata.byteCount, XLSX_PREFIX.length);
  assert.match(catalog.metadata.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(catalog.bytes, XLSX_PREFIX);
});

test("KRIC 코드 정본은 HTTP·schema·크기 오류를 fail closed 한다", async (context) => {
  await context.test("HTTP", async () => {
    let attempts = 0;
    await assert.rejects(downloadKricCodeCatalog({
      fetchImpl: async () => {
        attempts += 1;
        return new Response("unavailable", { status: 503 });
      },
    }), /HTTP 503/);
    assert.equal(attempts, 2);
  });
  await context.test("HTTP 5xx recovery", async () => {
    let attempts = 0;
    const catalog = await downloadKricCodeCatalog({
      fetchImpl: async () => {
        attempts += 1;
        return attempts === 1
          ? new Response("unavailable", { status: 503 })
          : new Response(XLSX_PREFIX, { status: 200, headers: { "content-type": "application/octet-stream" } });
      },
    });
    assert.equal(attempts, 2);
    assert.deepEqual(catalog.bytes, XLSX_PREFIX);
  });
  await context.test("HTTP 4xx", async () => {
    let attempts = 0;
    await assert.rejects(downloadKricCodeCatalog({
      fetchImpl: async () => {
        attempts += 1;
        return new Response("not found", { status: 404 });
      },
    }), /HTTP 404/);
    assert.equal(attempts, 1);
  });
  await context.test("schema", async () => {
    await assert.rejects(downloadKricCodeCatalog({
      fetchImpl: async () => new Response("<html/>", { status: 200, headers: { "content-type": "text/html" } }),
    }), /schema mismatch/);
  });
  await context.test("size", async () => {
    let cancelled = false;
    await assert.rejects(downloadKricCodeCatalog({
      maximumBytes: 5,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/octet-stream" }),
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(XLSX_PREFIX.subarray(0, 4));
            controller.enqueue(XLSX_PREFIX.subarray(4));
          },
          cancel() {
            cancelled = true;
          },
        }),
        async arrayBuffer() {
          assert.fail("response body must be consumed as a bounded stream");
        },
      }),
    }), /size limit/);
    assert.equal(cancelled, true);
  });
});

test("KRIC 코드 정본은 동일 host HTTPS redirect만 한 번 따른다", async () => {
  const requests = [];
  const catalog = await downloadKricCodeCatalog({
    fetchImpl: async (url) => {
      requests.push(String(url));
      if (requests.length === 1) {
        return new Response(null, {
          status: 302,
          headers: { location: "/rips/files/catalog.xlsx" },
        });
      }
      return new Response(XLSX_PREFIX, {
        status: 200,
        headers: { "content-type": "application/octet-stream" },
      });
    },
  });
  assert.equal(catalog.metadata.byteCount, XLSX_PREFIX.length);
  assert.deepEqual(requests, [
    "https://data.kric.go.kr/rips/download.file?answerId=395&fileId=1&id=395&type=N",
    "https://data.kric.go.kr/rips/files/catalog.xlsx",
  ]);

  await assert.rejects(downloadKricCodeCatalog({
    fetchImpl: async () => new Response(null, {
      status: 302,
      headers: { location: "https://example.com/catalog.xlsx" },
    }),
  }), /redirect origin/);
});

test("KRIC transport 실패는 비밀 없는 원인 코드만 노출한다", async () => {
  const secret = "never-print-provider-value";
  await assert.rejects(downloadKricCodeCatalog({
    fetchImpl: async () => {
      throw new Error(`fetch failed ${secret}`, { cause: { code: "ECONNRESET" } });
    },
  }), (error) => {
    assert.match(error.message, /transport failure \(ECONNRESET\)/);
    assert.doesNotMatch(error.message, new RegExp(secret));
    return true;
  });
});
