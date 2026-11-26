import assert from "node:assert/strict";
import test from "node:test";

import {
  collectSeoulStationContact,
  fetchSeoulMetroStationContactFile,
  parseCsvLine,
  parseSeoulMetroStationContactCsv,
} from "./collect-seoul-metro-station-contact.mjs";

const HEADER = "연번,역번호,호선,역명,역전화번호,도로명주소,지번주소";
const CAPTURED_AT = "2026-10-20T01:00:00.000Z";

// Real EUC-KR bytes for: "연번,역번호,호선,역명,역전화번호,도로명주소,지번주소\n1,150,1,Seoul,02-1111-2222,Road,Lot\n"
const EUC_KR_VALID_CSV = Buffer.from([
  191, 172, 185, 248, 44, 191, 170, 185, 248, 200, 163, 44, 200, 163, 188, 177, 44,
  191, 170, 184, 237, 44, 191, 170, 192, 252, 200, 173, 185, 248, 200, 163, 44,
  181, 181, 183, 206, 184, 237, 193, 214, 188, 210, 44, 193, 246, 185, 248, 193, 214, 188, 210, 10,
  49, 44, 49, 53, 48, 44, 49, 44, 83, 101, 111, 117, 108, 44, 48, 50, 45, 49, 49, 49, 49, 45, 50, 50, 50, 50, 44,
  82, 111, 97, 100, 44, 76, 111, 116, 10,
]);
const ASCII_COMPAT_CSV = `${HEADER}\n1,150,1,Seoul,02-1111-2222,"Road 1, Gangnam",Lot 1\n`;

test("parseSeoulMetroStationContactCsv는 헤더 불일치·열 부족·닫히지 않은 따옴표·빈 행을 Fail-Closed 거부한다", () => {
  const rows = parseSeoulMetroStationContactCsv(`\uFEFF${ASCII_COMPAT_CSV}`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].roadAddr, "Road 1, Gangnam");

  assert.throws(() => parseCsvLine('"unclosed'), /unterminated quoted field/);
  assert.throws(() => parseSeoulMetroStationContactCsv(`${HEADER}\n`), /insufficient lines/);
  assert.throws(() => parseSeoulMetroStationContactCsv("wrong,h2,h3,h4,h5,h6,h7\n1,2,3,4,5,6,7\n"), /header mismatch/);
  assert.throws(() => parseSeoulMetroStationContactCsv(`${HEADER}\n1,150,1,Seoul\n`), /column count mismatch/);
  assert.throws(() => parseSeoulMetroStationContactCsv(`${HEADER}\n1,150,1, ,02-111,a,b\n`), /missing required station name/);
});

test("fetchSeoulMetroStationContactFile과 collectSeoulStationContact는 AbortSignal·바이트 상한·fatal EUC-KR·빈 응답을 강제한다", async () => {
  const seenSignals = [];
  const { snapshot } = await collectSeoulStationContact({
    capturedAt: CAPTURED_AT,
    fetchImpl: async (_url, init) => {
      seenSignals.push(init?.signal);
      return new Response(EUC_KR_VALID_CSV, { status: 200 });
    },
  });
  assert.equal(snapshot.rowCount, 1);
  assert.ok(seenSignals[0] instanceof AbortSignal);

  await assert.rejects(
    fetchSeoulMetroStationContactFile({
      fetchImpl: async () => new Response(Buffer.alloc(0), { status: 200 }),
    }),
    /response is empty/,
  );

  await assert.rejects(
    fetchSeoulMetroStationContactFile({
      fetchImpl: async () => new Response(Buffer.from([0x31, 0xff, 0xfe, 0x0a]), { status: 200 }),
    }),
    TypeError,
  );

  await assert.rejects(
    fetchSeoulMetroStationContactFile({
      fetchImpl: async () => new Response("", {
        status: 200,
        headers: { "content-length": String(9 * 1024 * 1024) },
      }),
    }),
    /exceeds maximum size/,
  );
});
