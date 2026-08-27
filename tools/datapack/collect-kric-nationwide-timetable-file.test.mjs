import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  collectKricNationwideTimetableFile,
  DEFAULT_MAXIMUM_BYTES,
  KRIC_NATIONWIDE_TIMETABLE_FILE_URL,
} from "./collect-kric-nationwide-timetable-file.mjs";

const ZIP = minimalXlsxZip();
const HEADERS = {
  "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "content-disposition": "attachment; filename=urban-timetable.xlsx",
  "content-length": `${ZIP.length}`,
};

test("#454 fixed credential-free file collector makes one HTTPS request and atomically writes only raw XLSX plus a sanitized receipt", async () => {
  await withOutput(async ({ output, root }) => {
    const calls = [];
    const receipt = await collectKricNationwideTimetableFile({
      outputDirectory: output,
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
    assert.equal(receipt.credentialRedacted, true);
    assert.deepEqual(await readFile(path.join(output, "nationwide-timetable.xlsx")), ZIP);
    assert.deepEqual(JSON.parse(await readFile(path.join(output, "receipt.json"))), receipt);
    assert.deepEqual((await stat(output)).isDirectory(), true);
    assert.equal(JSON.stringify(receipt).includes("urban-timetable.xlsx"), false);
    assert.equal((await readdir(output)).sort().join(","), "nationwide-timetable.xlsx,receipt.json");
    assert.ok(output.startsWith(root));
  });
});

test("#454 ignores absent or unusual Content-Disposition because the raw filename is fixed internally", async () => {
  await withOutput(async ({ output }) => {
    await collectKricNationwideTimetableFile({
      outputDirectory: output,
      fetchImpl: async () => new Response(ZIP, {
        status: 200,
        headers: { "content-type": HEADERS["content-type"], "content-length": HEADERS["content-length"] },
      }),
    });
    assert.deepEqual(await readFile(path.join(output, "nationwide-timetable.xlsx")), ZIP);
  });
});

test("#454 accepts KRIC application/octet-stream only with the same XLSX MIME and ZIP proof", async () => {
  await withOutput(async ({ output }) => {
    await collectKricNationwideTimetableFile({
      outputDirectory: output,
      fetchImpl: async () => new Response(ZIP, {
        status: 200,
        headers: { ...HEADERS, "content-type": "application/octet-stream" },
      }),
    });
    assert.deepEqual(await readFile(path.join(output, "nationwide-timetable.xlsx")), ZIP);
  });
});

test("#454 bounds streamed bytes before buffering and requires the XLSX central-directory entries", async () => {
  assert.equal(DEFAULT_MAXIMUM_BYTES, 128 * 1024 * 1024);
  await withOutput(async ({ output }) => {
    let bodyRead = false;
    await assert.rejects(collectKricNationwideTimetableFile({
      outputDirectory: output,
      maximumBytes: ZIP.length - 1,
      fetchImpl: async () => ({ status: 200, ok: true, redirected: false, url: "", headers: new Headers({ ...HEADERS }), body: { getReader: () => { bodyRead = true; } } }),
    }), /BODY/);
    assert.equal(bodyRead, false);
  });
  await withOutput(async ({ output }) => {
    let cancelled = false;
    await assert.rejects(collectKricNationwideTimetableFile({
      outputDirectory: output,
      maximumBytes: ZIP.length - 1,
      fetchImpl: async () => streamResponse(ZIP, { "content-type": HEADERS["content-type"] }, () => { cancelled = true; }),
    }), /BODY/);
    assert.equal(cancelled, true);
  });
  await withOutput(async ({ output }) => {
    await assert.rejects(collectKricNationwideTimetableFile({
      outputDirectory: output,
      fetchImpl: async () => new Response(minimalXlsxZip(["arbitrary.xml"]), { status: 200, headers: { ...HEADERS, "content-length": `${minimalXlsxZip(["arbitrary.xml"]).length}` } }),
    }), /BODY/);
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
      await assert.rejects(collectKricNationwideTimetableFile({ outputDirectory: output, fetchImpl: async () => { calls += 1; return entry.response; } }), entry.error, entry.label);
      assert.equal(calls, 1, entry.label);
      await assert.rejects(stat(output));
    });
  }
  await withOutput(async ({ output }) => {
    await mkdir(output);
    let calls = 0;
    await assert.rejects(collectKricNationwideTimetableFile({ outputDirectory: output, fetchImpl: async () => { calls += 1; } }), /OUTPUT_EXISTS/);
    assert.equal(calls, 0);
  });
  await withOutput(async ({ output }) => {
    await assert.rejects(collectKricNationwideTimetableFile({
      outputDirectory: output,
      fetchImpl: async () => {
        await mkdir(output);
        return new Response(ZIP, { status: 200, headers: HEADERS });
      },
    }), /KRIC_TIMETABLE_FILE_OUTPUT/);
  });
});

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
  try { await run({ root, output: path.join(root, "kric-nationwide-timetable-file-test") }); } finally { await rm(root, { recursive: true, force: true }); }
}
