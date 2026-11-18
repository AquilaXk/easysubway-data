import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeXmlBytes,
  decodeXmlEntities,
} from "./xml-decode.mjs";

test("decodeXmlEntities decodes named and numeric entities in a single pass without double decoding", () => {
  assert.equal(decodeXmlEntities("&lt;&gt;&quot;&apos;&#39;&#x27;&amp;"), "<>\"'''&");
  assert.equal(
    decodeXmlEntities("&amp;lt;&amp;gt;&amp;quot;&amp;apos;&amp;#39;&amp;x27;&amp;amp;"),
    "&lt;&gt;&quot;&apos;&#39;&x27;&amp;",
  );
  assert.equal(decodeXmlEntities("&#44032;&#xB098;&#x1F687;"), "가나🚇");
});

test("decodeXmlEntities rejects invalid numeric references, raw NUL bytes, and oversized strings fail-closed", () => {
  for (const invalid of ["&#0;", "&#x0;", "&#x00;", "&#xD800;", "&#xDFFF;", "&#x110000;", "&#99999999;", "&#xFFFE;", "&#xFFFF;", "&#7;"]) {
    assert.throws(
      () => decodeXmlEntities(`prefix-${invalid}-suffix`),
      /XML numeric character reference/,
      `expected rejection for ${invalid}`,
    );
  }
  assert.throws(() => decodeXmlEntities("abc\u0000def"), /NUL byte/);
  assert.throws(
    () => decodeXmlEntities("a".repeat(65), { maxInputLength: 64, label: "cell XML" }),
    /cell XML exceeds maximum length \(64 chars\)/,
  );
});

test("decodeXmlEntities stripControlChars normalizes literal C0/C1 controls while still blocking &#0;/surrogates", () => {
  assert.equal(decodeXmlEntities("서울\u0007역\u007f &amp;lt;1호선&amp;gt;"), "서울\u0007역\u007f &lt;1호선&gt;");
  assert.equal(
    decodeXmlEntities("서울\u0007역\u0000\u0085 &lt;1호선&gt;", { stripControlChars: true }),
    "서울 역   <1호선>",
  );
  assert.throws(
    () => decodeXmlEntities("서울&#0;역", { stripControlChars: true }),
    /XML numeric character reference/,
  );
});

test("decodeXmlBytes enforces maxBytes, strict declared encodings, EUC-KR fallback, and rejects corrupt or U+FFFD payloads", () => {
  const utf8Xml = Buffer.from('<?xml version="1.0" encoding="UTF-8"?><response><name>서울역</name></response>', "utf8");
  assert.deepEqual(decodeXmlBytes(utf8Xml), { raw: utf8Xml.toString("utf8"), responseEncoding: "utf-8" });

  // UTF-8으로 잘못 선언됐거나 선언 없는 EUC-KR 바이트 ("서울역" in EUC-KR = bc ad bf ef bf aa)
  const eucKrBytes = Buffer.concat([
    Buffer.from('<?xml version="1.0" encoding="UTF-8"?><response><name>', "latin1"),
    Buffer.from([0xbc, 0xad, 0xbf, 0xef, 0xbf, 0xaa]),
    Buffer.from("</name></response>", "latin1"),
  ]);
  assert.equal(decodeXmlBytes(eucKrBytes).responseEncoding, "euc-kr");
  assert.match(decodeXmlBytes(eucKrBytes).raw, /<name>서울역<\/name>/);

  const strictEuc = decodeXmlBytes(eucKrBytes, { respectDeclaredEncoding: true });
  assert.equal(strictEuc.responseEncoding, "euc-kr-after-invalid-utf8");
  assert.match(strictEuc.raw, /<name>서울역<\/name>/);

  assert.throws(
    () => decodeXmlBytes(Buffer.from('<?xml version="1.0" encoding="latin1"?><response/>', "latin1"), { respectDeclaredEncoding: true }),
    /XML encoding latin1/,
  );
  assert.throws(
    () => decodeXmlBytes(Buffer.from("<response>\uFFFD</response>", "utf8"), { rejectReplacementChar: true }),
    /replacement character/,
  );
  assert.throws(
    () => decodeXmlBytes(Buffer.from("x".repeat(65), "utf8"), { maxBytes: 64, label: "XML body" }),
    /XML body exceeds maximum size \(64 bytes\)/,
  );
  assert.throws(
    () => decodeXmlBytes(Buffer.from([0xff, 0xfe, 0x80, 0x81])),
    /XML .*decoding/,
  );
});
