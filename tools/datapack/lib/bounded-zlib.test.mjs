import assert from "node:assert/strict";
import test from "node:test";
import { constants, gzipSync, zstdCompressSync } from "node:zlib";

import {
  gunzipWithLimit,
  readResponseBytesWithLimit,
  readResponseTextWithLimit,
  zstdDecompressWithLimit,
} from "./bounded-zlib.mjs";

test("gunzipWithLimit decompresses valid gzip within limits and rejects gzip bombs fail-closed", () => {
  const payload = Buffer.from("hello-gzip-payload", "utf8");
  const gz = gzipSync(payload, { mtime: 0 });
  assert.deepEqual(gunzipWithLimit(gz, { maxOutputLength: 64 }), payload);

  const bomb = gzipSync(Buffer.alloc(256 * 1024, 0x41), { mtime: 0 });
  assert.throws(
    () => gunzipWithLimit(bomb, { maxOutputLength: 1024, label: "test gzip" }),
    (err) => err?.cause?.code === "ERR_BUFFER_TOO_LARGE" && /test gzip exceeds maximum decompressed size \(1024 bytes\)/.test(err.message),
  );
});

test("zstdDecompressWithLimit enforces maxOutputLength on zstd decompression", () => {
  const small = zstdCompressSync(Buffer.from("valid-zstd"), {
    params: { [constants.ZSTD_c_compressionLevel]: 3 },
  });
  assert.deepEqual(zstdDecompressWithLimit(small, { maxOutputLength: 64 }), Buffer.from("valid-zstd"));

  const bomb = zstdCompressSync(Buffer.alloc(512 * 1024, 0x42), {
    params: { [constants.ZSTD_c_compressionLevel]: 10 },
  });
  assert.throws(
    () => zstdDecompressWithLimit(bomb, { maxOutputLength: 2048, label: "test zstd" }),
    (err) => err?.cause?.code === "ERR_BUFFER_TOO_LARGE" && /test zstd exceeds maximum decompressed size \(2048 bytes\)/.test(err.message),
  );
});

test("readResponseBytesWithLimit rejects oversized Content-Length and streaming HTTP bodies before buffering full payload", async () => {
  const headerOversized = new Response("ok", { status: 200, headers: { "content-length": "4096" } });
  await assert.rejects(
    readResponseBytesWithLimit(headerOversized, { maxBytes: 1024, label: "header test" }),
    /exceeds maximum size/,
  );

  let chunksEmitted = 0;
  let cancelled = false;
  const stream = new ReadableStream({
    pull(controller) {
      chunksEmitted += 1;
      controller.enqueue(new Uint8Array(600));
    },
    cancel() {
      cancelled = true;
    },
  });
  const streamedOversized = new Response(stream, { status: 200 });
  await assert.rejects(
    readResponseBytesWithLimit(streamedOversized, { maxBytes: 1000, label: "stream test" }),
    /exceeds maximum size/,
  );
  assert.equal(chunksEmitted, 2);
  assert.equal(cancelled, true);

  const okResponse = new Response(Buffer.from("abc123"), { status: 200, headers: { "content-length": "6" } });
  assert.deepEqual(await readResponseBytesWithLimit(okResponse, { maxBytes: 64 }), Buffer.from("abc123"));

  const textOnlyMock = { headers: { get: () => null }, text: async () => "x".repeat(128) };
  await assert.rejects(
    readResponseTextWithLimit(textOnlyMock, { maxBytes: 64, label: "mock text" }),
    /mock text exceeds maximum size \(64 bytes\)/,
  );
  assert.equal(await readResponseTextWithLimit({ text: async () => "hello" }, { maxBytes: 64 }), "hello");
});
