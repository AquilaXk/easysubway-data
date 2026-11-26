import assert from "node:assert/strict";
import test from "node:test";
import { crc32, deflateRawSync } from "node:zlib";

import { unzipXlsx } from "./zip-xlsx.mjs";

function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const {
    name,
    data = Buffer.alloc(0),
    method = 0,
    flags = 0,
    compSizeOverride,
    uncompSizeOverride,
    crcOverride,
    signature = 0x04034b50,
  } of entries) {
    const nameBytes = Buffer.from(name, "utf8");
    const rawData = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const payload = method === 8 && compSizeOverride === undefined
      ? deflateRawSync(rawData)
      : rawData;
    const compSize = compSizeOverride ?? payload.length;
    const uncompSize = uncompSizeOverride ?? rawData.length;
    const checksum = crcOverride ?? (crc32(rawData) >>> 0);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(signature, 0);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compSize, 18);
    local.writeUInt32LE(uncompSize, 22);
    local.writeUInt16LE(nameBytes.length, 26);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(flags, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt32LE(checksum, 16);
    cd.writeUInt32LE(compSize, 20);
    cd.writeUInt32LE(uncompSize, 24);
    cd.writeUInt16LE(nameBytes.length, 28);
    cd.writeUInt32LE(offset, 42);

    const localEntry = Buffer.concat([local, nameBytes, payload]);
    locals.push(localEntry);
    centrals.push(Buffer.concat([cd, nameBytes]));
    offset += localEntry.length;
  }
  const cdBuffer = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuffer.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cdBuffer, eocd]);
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

test("unzipXlsx rejects missing EOCD, CRC32 checksum mismatch, and Central Directory parity mismatch", () => {
  const valid = makeZip(validWorkbookEntries());
  assert.throws(() => unzipXlsx(valid.subarray(0, valid.length - 10)), /end-of-central-directory/i);

  const badCrc = makeZip([
    { name: "xl/sharedStrings.xml", method: 0, data: Buffer.from("<sst/>"), crcOverride: 0xdeadbeef },
    { name: "xl/worksheets/sheet1.xml", method: 0, data: Buffer.from("<worksheet/>") },
  ]);
  assert.throws(() => unzipXlsx(badCrc), /CRC32 checksum mismatch/i);

  const tamperedHeader = Buffer.from(valid);
  const nameOffset = 30;
  tamperedHeader.write("Y", nameOffset);
  assert.throws(() => unzipXlsx(tamperedHeader), /central directory mismatch/i);
});
