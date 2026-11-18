import assert from "node:assert/strict";
import test from "node:test";
import { deflateRawSync } from "node:zlib";

import { unzipXlsx } from "./zip-xlsx.mjs";

function makeZip(entries) {
  return Buffer.concat(entries.map(({
    name,
    data = Buffer.alloc(0),
    method = 0,
    flags = 0,
    compSizeOverride,
    uncompSizeOverride,
    signature = 0x04034b50,
  }) => {
    const nameBytes = Buffer.from(name, "utf8");
    const payload = method === 8 && Buffer.isBuffer(data) && compSizeOverride === undefined
      ? deflateRawSync(data)
      : Buffer.from(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(signature, 0);
    header.writeUInt16LE(flags, 6);
    header.writeUInt16LE(method, 8);
    header.writeUInt32LE(compSizeOverride ?? payload.length, 18);
    header.writeUInt32LE(uncompSizeOverride ?? data.length, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    return Buffer.concat([header, nameBytes, payload]);
  }));
}

function validWorkbookEntries(extra = []) {
  return [
    ...extra,
    { name: "xl/sharedStrings.xml", method: 8, data: Buffer.from("<sst/>", "utf8") },
    { name: "xl/worksheets/sheet1.xml", method: 8, data: Buffer.from("<worksheet/>", "utf8") },
  ];
}

test("unzipXlsx extracts stored and deflated local entries within byte and entry budgets", () => {
  const archive = makeZip([
    { name: "xl/sharedStrings.xml", method: 0, data: Buffer.from("<sst><si><t>역</t></si></sst>", "utf8") },
    { name: "xl/worksheets/sheet1.xml", method: 8, data: Buffer.from("<worksheet><sheetData/></worksheet>", "utf8") },
  ]);
  const out = unzipXlsx(archive, {
    maxArchiveBytes: 4096,
    maxEntries: 8,
    maxEntryBytes: 128,
    maxTotalBytes: 256,
  });
  assert.equal(out.get("xl/sharedStrings.xml").toString("utf8"), "<sst><si><t>역</t></si></sst>");
  assert.equal(out.get("xl/worksheets/sheet1.xml").toString("utf8"), "<worksheet><sheetData/></worksheet>");
});

test("unzipXlsx rejects deflate bombs via inflateRawSync maxOutputLength even when header lies about uncompressedSize", () => {
  const realPayload = Buffer.alloc(1024 * 1024, 0x41);
  const deflated = deflateRawSync(realPayload);
  const forged = makeZip([
    {
      name: "xl/sharedStrings.xml",
      method: 8,
      data: deflated,
      compSizeOverride: deflated.length,
      uncompSizeOverride: 16,
    },
    { name: "xl/worksheets/sheet1.xml", method: 0, data: Buffer.from("<worksheet/>") },
  ]);
  assert.throws(
    () => unzipXlsx(forged, { maxEntryBytes: 4096, maxTotalBytes: 8192 }),
    (err) => err?.cause?.code === "ERR_BUFFER_TOO_LARGE" && /decompressed size limit/i.test(err.message),
  );
});

test("unzipXlsx rejects cumulative decompressed overflow, maxEntry count, duplicates, flags, and zip-slip paths", () => {
  const overTotal = makeZip([
    { name: "xl/sharedStrings.xml", method: 8, data: Buffer.alloc(60, 0x61) },
    { name: "xl/worksheets/sheet1.xml", method: 8, data: Buffer.alloc(60, 0x62) },
  ]);
  assert.throws(
    () => unzipXlsx(overTotal, { maxEntryBytes: 80, maxTotalBytes: 100 }),
    /decompressed size limit/i,
  );

  const tooManyEntries = makeZip(validWorkbookEntries([
    { name: "docProps/a.xml", method: 0, data: Buffer.from("<a/>") },
    { name: "docProps/b.xml", method: 0, data: Buffer.from("<b/>") },
  ]));
  assert.throws(
    () => unzipXlsx(tooManyEntries, { maxEntries: 3 }),
    /entry count/i,
  );

  const duplicate = makeZip([
    { name: "xl/sharedStrings.xml", method: 0, data: Buffer.from("<sst/>") },
    { name: "xl/sharedStrings.xml", method: 0, data: Buffer.from("<sst/>") },
    { name: "xl/worksheets/sheet1.xml", method: 0, data: Buffer.from("<worksheet/>") },
  ]);
  assert.throws(() => unzipXlsx(duplicate), /duplicate zip entry/i);

  for (const unsafe of ["../evil.xml", "xl/../../evil.xml", "/abs/path.xml", "xl\\bad.xml", "xl/\0bad.xml", "C:drive.xml", "xl//empty.xml"]) {
    const zip = makeZip(validWorkbookEntries([{ name: unsafe, method: 0, data: Buffer.from("x") }]));
    assert.throws(() => unzipXlsx(zip), /unsafe zip entry path/i, unsafe);
  }

  const encrypted = makeZip(validWorkbookEntries([{ name: "a.xml", method: 0, flags: 0x0001, data: Buffer.from("x") }]));
  assert.throws(() => unzipXlsx(encrypted), /encrypted/i);

  const descriptor = makeZip(validWorkbookEntries([{ name: "a.xml", method: 0, flags: 0x0008, data: Buffer.from("x") }]));
  assert.throws(() => unzipXlsx(descriptor), /data descriptor/i);

  const storedOversized = makeZip(validWorkbookEntries([{ name: "a.xml", method: 0, data: Buffer.alloc(200, 1) }]));
  assert.throws(() => unzipXlsx(storedOversized, { maxEntryBytes: 100 }), /limit/i);
});
