import assert from "node:assert/strict";
import test from "node:test";

import { readZipEntry } from "./read-zip-entry.mjs";
import { METHOD_STORED, buildZip } from "./test-fixtures/zip-archive.mjs";

const LIMIT = 1024 * 1024;
const CAPTURE = JSON.stringify({ requestCount: 810, padding: "x".repeat(5000) });

test("deflate·stored 항목을 이름으로 찾아 원본 바이트를 돌려준다", () => {
  const zip = buildZip([
    { name: "freshness.json", data: "{}\n", method: METHOD_STORED },
    { name: "provider-response-capture.json", data: CAPTURE },
  ]);
  assert.equal(readZipEntry(zip, "provider-response-capture.json", { maxBytes: LIMIT }).toString("utf8"), CAPTURE);
  assert.equal(readZipEntry(zip, "freshness.json", { maxBytes: LIMIT }).toString("utf8"), "{}\n");
});

test("data descriptor 형식(GitHub artifact가 쓰는 스트리밍 ZIP)도 중앙 디렉터리 값으로 읽는다", () => {
  const zip = buildZip([{ name: "provider-response-capture.json", data: CAPTURE }], { dataDescriptor: true });
  assert.equal(readZipEntry(zip, "provider-response-capture.json", { maxBytes: LIMIT }).toString("utf8"), CAPTURE);
});

test("없는 항목은 null이다. 항목 이름은 정확히 같아야 하고 접미사 일치로 찾지 않는다", () => {
  const zip = buildZip([{ name: "nested/provider-response-capture.json", data: CAPTURE }]);
  assert.equal(readZipEntry(zip, "provider-response-capture.json", { maxBytes: LIMIT }), null);
  assert.equal(readZipEntry(buildZip([]), "freshness.json", { maxBytes: LIMIT }), null);
});

test("손상·모호한 ZIP은 추정하지 않고 실패한다", () => {
  const good = buildZip([{ name: "a.json", data: CAPTURE }]);
  const read = (zip) => readZipEntry(zip, "a.json", { maxBytes: LIMIT });
  assert.throws(() => read(Buffer.from("not a zip")), /ZIP_INVALID/u);
  assert.throws(() => read(good.subarray(0, good.length - 5)), /ZIP_INVALID/u);
  const corrupted = Buffer.from(good);
  corrupted[corrupted.indexOf(Buffer.from("a.json")) + 12] ^= 0xff;
  assert.throws(() => read(corrupted), /ZIP_/u);
  // 크기는 같고 내용만 바뀐 항목은 CRC로 거른다.
  const stored = Buffer.from(buildZip([{ name: "a.json", data: "{\"requestCount\":810}", method: METHOD_STORED }]));
  stored[stored.indexOf("810")] = "9".charCodeAt(0);
  assert.throws(() => read(stored), /ZIP_INVALID: entry a\.json does not match its checksum/u);
  assert.throws(() => read(buildZip([{ name: "a.json", data: "1" }, { name: "a.json", data: "2" }])), /ZIP_DUPLICATE_ENTRY/u);
  assert.throws(() => read(buildZip([{ name: "a.json", data: CAPTURE, flags: 0x0001 }])), /ZIP_UNSUPPORTED/u);
  assert.throws(() => read(buildZip([{ name: "a.json", data: CAPTURE, method: 9 }])), /ZIP_UNSUPPORTED/u);
});

test("압축 해제 크기가 상한을 넘으면 풀기 전에 거부한다 (압축 폭탄 방지)", () => {
  const zip = buildZip([{ name: "a.json", data: "0".repeat(10_000) }]);
  assert.equal(readZipEntry(zip, "a.json", { maxBytes: 10_000 }).length, 10_000);
  assert.throws(() => readZipEntry(zip, "a.json", { maxBytes: 9_999 }), /ZIP_ENTRY_TOO_LARGE/u);
});

test("중앙 디렉터리가 가리키는 위치가 ZIP 밖이면 실패한다", () => {
  const zip = Buffer.from(buildZip([{ name: "a.json", data: CAPTURE }]));
  zip.writeUInt32LE(zip.length, zip.length - 22 + 16);
  assert.throws(() => readZipEntry(zip, "a.json", { maxBytes: LIMIT }), /ZIP_INVALID/u);
});
