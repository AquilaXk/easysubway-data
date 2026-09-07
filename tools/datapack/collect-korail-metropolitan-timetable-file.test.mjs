import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { collectKorailMetropolitanTimetableFile } from "./collect-korail-metropolitan-timetable-file.mjs";

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

async function withDirectory(run) {
  await withParent(async (parent) => run(path.join(parent, "capture")));
}

async function withParent(run) {
  const parent = await mkdtemp(path.join(os.tmpdir(), "korail-file-test-"));
  try { await run(parent); } finally { await rm(parent, { recursive: true, force: true }); }
}
