import assert from "node:assert/strict";
import test from "node:test";

import {
  DOWNLOAD_URL,
  SOURCE_HEADER,
  buildSeoulMetroTransferSnapshot,
  collectSeoulMetroTransferCarDoorDuration,
  contentDispositionFileName,
  parseSeoulMetroTransferCsv,
  validateSeoulMetroTransferSnapshot,
} from "./collect-seoul-metro-transfer-car-door-duration.mjs";

// #876: 서울교통공사_서울 도시철도 환승정보(15098252) 원문 CP949 바이트에서 고른 표본 13행(헤더 포함 14줄).
// 1~4(서울역), 77(금천구청 00:00), 144·145(성수, All 칸·문), 557(이수), 712(빈 소요시간), 713·714·716(중랑), 999(석남).
const SAMPLE = Buffer.from("IrDtwK+5+MijIiwiyK+9wr3DwNu/qiIsIsivvcK9w8Dbv6ogxNq15SIsIsivvcK9w8DbIMijvLEiLCLHz8L3IL+twvcguea46SIsIsfPwvfAp8ShKMijwvcpIiwix8/C98CnxKEoua4pIiwiyK+9wsG+t+G/qiIsIsivvcIgv63C9yC55rjpIiwiyK+9wiC9wsL3wKfEoSjIo8L3KSIsIsivvcIgvcLC98CnxKEoua4pIiwivNK/5L3DsKMiDQoxLLytv++/qiwiMDE1MCIsIjEiLL3Dw7sguea46SwiMTAiLCI0IiwiMDQyNyIsvPe068DUsbgguea46SwiMSIsIjEiLCIwMzozNCINCjIsvK2/77+qLCIwMTUwIiwiMSIss7K/tSC55rjpLCIxIiwiMiIsIjA0MjUiLMi4x/Yguea46SwiMTAiLCI0IiwiMDM6NDAiDQozLLytv++/qiwiMDE1MCIsIjEiLLOyv7Uguea46SwiMSIsIjIiLCIwNDI3Iiy897TrwNSxuCC55rjpLCIxIiwiMSIsIjAzOjM0Ig0KNCy8rb/vv6osIjAxNTAiLCIxIiy9w8O7ILnmuOksIjEwIiwiNCIsIjA0MjUiLMi4x/Yguea46SwiMTAiLCI0IiwiMDM6NDAiDQo3Nyyx3cO1sbjDuywiMTcwMyIsIjEiLLyuvPYguea46SwiNyIsIjEiLCIxNzUwIiyxpLjtILnmuOksIjciLCIxIiwiMDA6MDAiDQoxNDQsvLq89iwiMDIxMSIsIjIiLLDHtOvA1LG4ILnmuOksIjEwIiwiNCIsIjAyNDQiLL/rtOQguea46SwiMSIsIjEiLCIwMzozMiINCjE0NSy8urz2LCIwMjExIiwiMiIsttK8tiC55rjpLEFsbCxBbGwsIjAyNDQiLL/rtOQguea46SxBbGwsQWxsLCIwMDowNSINCjU1NyzAzLz2LCIyNzM4IiwiNyIss7u55iC55rjpLCIyIiwiMiIsIjA0MzEiLLW/wNsguea46SwiMSIsIjEiLCIwNToxNyINCjcxMizB37b7LCIxMjAxIiyw5sDHvLEsyLix4iC55rjpLCI1IiwiMSIsIjEzMDkiLLvzusAguea46SwiMSIsIjIiLA0KNzEzLMHftvssIjEyMDEiLLDmwMe8sSy787rAILnmuOksIjgiLCIyIiwiMTMwOSIsu/O6wCC55rjpLCIzIiwiMyIsIjAxOjAwIg0KNzE0LMHftvssIjEyMDEiLLDmwMe8sSzIuLHiILnmuOksIjEiLCIyIiwiMTMwNyIsyLix4iC55rjpLCI1IiwiMiIsIjAwOjAwIg0KNzE2LMHftvssIjEyMDEiLLDmwMe8sSzIuLHiILnmuOksIjEiLCIyIiwiMTMwNyIsyLix4iC55rjpLCI0IiwiNCIsIjAwOjAwIg0KOTk5LLyus7IsIjMyMTMiLMDOw7UyLLChwaTB377TvcPA5SC55rjpLCIyIiwiMyIsIjM3NjIiLLvqsO4guea46SwiMSIsIjQiLCIwNTo0NSINCg==", "base64");
const FILE_NAME = "서울교통공사_서울 도시철도 환승정보_20260902.csv";
const CAPTURED_AT = "2026-10-02T03:00:00.000Z";

function cp949Variant(transform) {
  // 표본은 ASCII 구분자만 바꾸므로 CP949 바이트를 latin1 문자열로 다루고 다시 바이트로 돌린다.
  return Buffer.from(transform(SAMPLE.toString("latin1")), "latin1");
}

test("CP949 원문을 명시 디코딩해 원천 문자열 그대로 행을 만든다", () => {
  const rows = parseSeoulMetroTransferCsv(SAMPLE);
  assert.equal(rows.length, 13);
  assert.deepEqual(rows[0], {
    sourceRowNumber: "1", startStationName: "서울역", startStationCode: "0150", startLine: "1",
    alightingDirection: "시청 방면", alightingCar: "10", alightingDoor: "4", endStationCode: "0427",
    boardingDirection: "숙대입구 방면", boardingCar: "1", boardingDoor: "1", duration: "03:34",
  });
  const allDoors = rows.find(({ sourceRowNumber }) => sourceRowNumber === "145");
  assert.deepEqual([allDoors.alightingCar, allDoors.alightingDoor, allDoors.boardingCar, allDoors.boardingDoor], ["All", "All", "All", "All"]);
});

test("빈 소요시간과 00:00은 서로 다른 원천 값으로 보존한다", () => {
  const rows = parseSeoulMetroTransferCsv(SAMPLE);
  assert.equal(rows.find(({ sourceRowNumber }) => sourceRowNumber === "712").duration, "");
  assert.equal(rows.find(({ sourceRowNumber }) => sourceRowNumber === "714").duration, "00:00");
});

test("UTF-8 등 CP949가 아닌 바이트는 실패한다", () => {
  const utf8 = Buffer.from(new TextDecoder("euc-kr").decode(SAMPLE), "utf8");
  assert.throws(() => parseSeoulMetroTransferCsv(utf8), /valid CP949|header drift/u);
  assert.throws(() => parseSeoulMetroTransferCsv(Buffer.concat([SAMPLE.subarray(0, 20), Buffer.from([0xff, 0xff]), SAMPLE.subarray(20)])), /valid CP949/u);
});

test("헤더가 한 글자라도 바뀌면 실패한다(fail closed)", () => {
  const text = new TextDecoder("euc-kr").decode(SAMPLE);
  assert.ok(text.startsWith(`"${SOURCE_HEADER[0]}"`));
  const reordered = cp949Variant((value) => value.replace("\"\r\n", "\",\"extra\"\r\n"));
  assert.throws(() => parseSeoulMetroTransferCsv(reordered), /header drift/u);
});

test("열 수·줄바꿈·값 형식이 계약과 다르면 실패한다", () => {
  assert.throws(() => parseSeoulMetroTransferCsv(cp949Variant((value) => value.replace(/\r\n$/u, ",x\r\n"))), /column count/u);
  assert.throws(() => parseSeoulMetroTransferCsv(cp949Variant((value) => value.replace(/\r\n$/u, ""))), /end with CRLF/u);
  assert.throws(() => parseSeoulMetroTransferCsv(cp949Variant((value) => value.replace("\"03:34\"", "\"3:34\""))), /duration mismatch/u);
  assert.throws(() => parseSeoulMetroTransferCsv(cp949Variant((value) => value.replace("\"0427\"", "\"427\""))), /station code mismatch/u);
  assert.throws(() => parseSeoulMetroTransferCsv(cp949Variant((value) => value.replace("\"10\",\"4\",\"0427\"", "\"11\",\"4\",\"0427\""))), /car-door mismatch/u);
  assert.throws(() => parseSeoulMetroTransferCsv(cp949Variant((value) => value.replace("\r\n2,", "\r\n1,"))), /strictly increasing/u);
});

test("snapshot은 원문 바이트를 보존하고 같은 파서 재생과 같을 때만 통과한다", () => {
  const snapshot = buildSeoulMetroTransferSnapshot({ rawBytes: SAMPLE, capturedAt: CAPTURED_AT, sourceFileName: FILE_NAME });
  assert.equal(snapshot.sourceEffectiveDate, "2026-09-02");
  assert.equal(snapshot.rowCount, 13);
  assert.equal(snapshot.observedAt, CAPTURED_AT);
  assert.ok(Buffer.from(snapshot.rawBytesBase64, "base64").equals(SAMPLE));
  assert.equal(validateSeoulMetroTransferSnapshot(snapshot), snapshot);
  const tampered = structuredClone(snapshot);
  tampered.rows[0].duration = "00:01";
  assert.throws(() => validateSeoulMetroTransferSnapshot(tampered), /replay mismatch/u);
  assert.throws(() => buildSeoulMetroTransferSnapshot({ rawBytes: SAMPLE, capturedAt: CAPTURED_AT, sourceFileName: "다른파일.csv" }), /file name mismatch/u);
});

test("수집기는 키 없는 고정 다운로드 URL만 호출하고 응답 파일명을 UTF-8로 읽는다", async () => {
  const calls = [];
  const header = `attachment; filename="${Buffer.from(FILE_NAME, "utf8").toString("latin1")}"`;
  const snapshot = await collectSeoulMetroTransferCarDoorDuration({
    now: new Date(CAPTURED_AT),
    fetchImpl: async (url, init) => {
      calls.push([url, init]);
      return new Response(SAMPLE, { headers: { "content-disposition": header } });
    },
  });
  assert.deepEqual(calls, [[DOWNLOAD_URL, { redirect: "error" }]]);
  assert.ok(!/serviceKey/iu.test(DOWNLOAD_URL));
  assert.equal(snapshot.sourceFileName, FILE_NAME);
  assert.equal(contentDispositionFileName(header), FILE_NAME);
  await assert.rejects(collectSeoulMetroTransferCarDoorDuration({ fetchImpl: async () => new Response("x", { status: 500 }) }), /HTTP 500/u);
});
