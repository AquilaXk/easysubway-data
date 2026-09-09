import assert from "node:assert/strict";
import { test } from "node:test";

import {
  collectSeoulStationLineInfo,
  parseSeoulStationLineInfoCsv,
} from "./collect-seoul-station-line-info.mjs";

// OA15442 원본의 EUC-KR 헤더 바이트를 고정한다. 실제 다운로드 파일을 읽지 않는 합성 fixture다.
const HEADER_BYTES = Buffer.from(
  "IsD8w7a/qsTateUiLCLA/MO2v6q47SIsIsD8w7a47bjtKL+1ua4pIiwiyKO8sSIsIr/cus7E2rXlIiwiwPzDtrjtuO0owd+5rikiLCLA/MO2uO247SjAz7muKSI=",
  "base64",
);

function fixture(row) {
  return Buffer.concat([HEADER_BYTES, Buffer.from(`\n${row}\n`, "latin1")]);
}

test("Seoul station-line CSV preserves raw bytes while ignoring malformed unused language columns", () => {
  const bytes = fixture('"0001","Station A","\xff","1","001","\xff","\xff"');
  const rows = parseSeoulStationLineInfoCsv(bytes);
  assert.deepEqual(rows, [{ STATION_CD: "0001", STATION_NM: "Station A", LINE_NUM: "1", FR_CODE: "001" }]);
  const snapshot = collectSeoulStationLineInfo({ csvBytes: bytes, capturedAt: new Date(0).toISOString() });
  assert.equal(snapshot.rawBytesBase64, bytes.toString("base64"));
  assert.equal(snapshot.rowCount, 1);
});

test("Seoul station-line CSV rejects malformed required text and truncated rows", () => {
  assert.throws(
    () => parseSeoulStationLineInfoCsv(fixture('"0001","\xff","English","1","001","",""')),
    /STATION_NM is not valid EUC-KR/,
  );
  assert.throws(
    () => parseSeoulStationLineInfoCsv(fixture('"0001","Station A')),
    /unclosed quote/,
  );
});
