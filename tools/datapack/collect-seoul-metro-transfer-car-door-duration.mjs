#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

// #876(QA 결정 2026-10-02): 서울교통공사_서울 도시철도 환승정보(data.go.kr 15098252) 원문 파일 수집기.
// - 키 없이 받는 공식 CSV 파일이다. 원문 바이트를 그대로 보존하고(rawBytesBase64), 같은 파서로 다시 읽어 검증한다.
// - 인코딩은 CP949(WHATWG euc-kr 디코더)로 명시해 읽는다. 잘못된 바이트가 있으면 실패한다.
// - 헤더·열 수·값 형식이 계약과 다르면 실패한다(fail closed). 값은 원천 문자열 그대로 둔다.
// - "소요시간"이 빈 행은 빈 값으로 보존한다. 지표 단계에서 사용 불가로 처리한다(추정하지 않는다).
export const SOURCE_ID = "seoul-metro-transfer-car-door-duration";
export const DETAIL_URL = "https://www.data.go.kr/data/15098252/fileData.do";
export const DOWNLOAD_URL = "https://www.data.go.kr/cmm/cmm/fileDownload.do?atchFileId=FILE_000000007644508&fileDetailSn=1&insertDataPrcus=N";
export const SNAPSHOT_ARTIFACT_KIND = "seoul-metro-transfer-car-door-duration-snapshot";
export const SOURCE_HEADER = Object.freeze([
  "고유번호", "환승시작역", "환승시작역 코드", "환승시작 호선", "하차 열차 방면", "하차위치(호차)", "하차위치(문)",
  "환승종료역", "환승 열차 방면", "환승 승차위치(호차)", "환승 승차위치(문)", "소요시간",
]);
// 원천 열 → 보존 행 필드. 이름은 바꾸지만 값은 원천 문자열 그대로다.
const ROW_FIELDS = Object.freeze([
  "sourceRowNumber", "startStationName", "startStationCode", "startLine", "alightingDirection", "alightingCar", "alightingDoor",
  "endStationCode", "boardingDirection", "boardingCar", "boardingDoor", "duration",
]);
const SOURCE_FILE_NAME = /^서울교통공사_서울 도시철도 환승정보_(\d{8})\.csv$/u;
const STATION_CODE = /^[0-9A-Z]{4}$/u;
const CAR = /^(?:[1-9]|10|All)$/u;
const DOOR = /^(?:[1-9]|All)$/u;
const DIRECTION = /^\S(?:.*\S)? 방면$/u;
const DURATION = /^(?:|\d{2}:[0-5]\d)$/u;
const MAX_RAW_BYTES = 4 * 1024 * 1024;

export async function collectSeoulMetroTransferCarDoorDuration({ fetchImpl = fetch, now = new Date() } = {}) {
  const capturedAt = instant(now);
  const response = await fetchImpl(DOWNLOAD_URL, { redirect: "error" });
  if (!response?.ok) throw new Error(`Seoul transfer car-door file download failed: HTTP ${response?.status}`);
  const rawBytes = Buffer.from(await response.arrayBuffer());
  return buildSeoulMetroTransferSnapshot({
    rawBytes,
    capturedAt,
    sourceFileName: contentDispositionFileName(response.headers.get("content-disposition")),
  });
}

export function buildSeoulMetroTransferSnapshot({ rawBytes, capturedAt, sourceFileName }) {
  if (!Buffer.isBuffer(rawBytes) || rawBytes.length === 0 || rawBytes.length > MAX_RAW_BYTES) {
    throw new Error("Seoul transfer car-door raw bytes are invalid");
  }
  const observedAt = instant(capturedAt);
  const effective = SOURCE_FILE_NAME.exec(sourceFileName ?? "");
  if (!effective) throw new Error("Seoul transfer car-door source file name mismatch");
  const rows = parseSeoulMetroTransferCsv(rawBytes);
  return {
    schemaVersion: 1,
    artifactKind: SNAPSHOT_ARTIFACT_KIND,
    sourceId: SOURCE_ID,
    detailUrl: DETAIL_URL,
    endpoint: DOWNLOAD_URL,
    sourceFileName,
    sourceEffectiveDate: `${effective[1].slice(0, 4)}-${effective[1].slice(4, 6)}-${effective[1].slice(6, 8)}`,
    capturedAt: observedAt,
    observedAt,
    encoding: "cp949",
    header: [...SOURCE_HEADER],
    rawSha256: sha256(rawBytes),
    rawByteLength: rawBytes.length,
    rowCount: rows.length,
    contentSha256: seoulMetroTransferContentSha256(rows),
    schemaFingerprint: sha256(JSON.stringify(SOURCE_HEADER)),
    rows,
    rawBytesBase64: rawBytes.toString("base64"),
  };
}

// 보존된 원문 바이트를 같은 파서로 다시 읽어 snapshot 전체가 같을 때만 통과한다.
export function validateSeoulMetroTransferSnapshot(snapshot) {
  if (snapshot?.artifactKind !== SNAPSHOT_ARTIFACT_KIND || snapshot.sourceId !== SOURCE_ID || typeof snapshot.rawBytesBase64 !== "string") {
    throw new Error("Seoul transfer car-door snapshot identity mismatch");
  }
  const rawBytes = Buffer.from(snapshot.rawBytesBase64, "base64");
  if (rawBytes.toString("base64") !== snapshot.rawBytesBase64) throw new Error("Seoul transfer car-door snapshot raw encoding mismatch");
  const replay = buildSeoulMetroTransferSnapshot({ rawBytes, capturedAt: snapshot.capturedAt, sourceFileName: snapshot.sourceFileName });
  if (!isDeepStrictEqual(replay, snapshot)) throw new Error("Seoul transfer car-door snapshot replay mismatch");
  return snapshot;
}

export function parseSeoulMetroTransferCsv(rawBytes) {
  let text;
  try {
    text = new TextDecoder("euc-kr", { fatal: true }).decode(rawBytes);
  } catch {
    throw new Error("Seoul transfer car-door CSV must be valid CP949");
  }
  if (!text.endsWith("\r\n")) throw new Error("Seoul transfer car-door CSV must end with CRLF");
  const lines = text.slice(0, -2).split("\r\n");
  if (lines.some((line) => line.includes("\n") || line.includes("\r"))) throw new Error("Seoul transfer car-door CSV line terminator mismatch");
  const header = parseCsvLine(lines[0]);
  if (JSON.stringify(header) !== JSON.stringify(SOURCE_HEADER)) throw new Error("Seoul transfer car-door CSV header drift");
  if (lines.length < 2) throw new Error("Seoul transfer car-door CSV has no rows");
  let previousRowNumber = 0;
  return lines.slice(1).map((line, index) => {
    const values = parseCsvLine(line);
    if (values.length !== SOURCE_HEADER.length) throw new Error(`Seoul transfer car-door CSV column count mismatch at data line ${index + 1}`);
    const row = Object.fromEntries(ROW_FIELDS.map((field, column) => [field, values[column]]));
    validateRow(row, previousRowNumber);
    previousRowNumber = Number(row.sourceRowNumber);
    return row;
  });
}

function validateRow(row, previousRowNumber) {
  const label = `Seoul transfer car-door row ${row.sourceRowNumber}`;
  if (!/^[1-9]\d{0,5}$/u.test(row.sourceRowNumber) || Number(row.sourceRowNumber) <= previousRowNumber) {
    throw new Error(`${label} number must be a strictly increasing positive integer`);
  }
  if (row.startStationName.trim() === "" || row.startStationName !== row.startStationName.trim()) throw new Error(`${label} station name mismatch`);
  if (!STATION_CODE.test(row.startStationCode) || !STATION_CODE.test(row.endStationCode)) throw new Error(`${label} station code mismatch`);
  if (row.startLine.trim() === "" || row.startLine !== row.startLine.trim()) throw new Error(`${label} line mismatch`);
  if (!DIRECTION.test(row.alightingDirection) || !DIRECTION.test(row.boardingDirection)) throw new Error(`${label} direction mismatch`);
  if (!CAR.test(row.alightingCar) || !CAR.test(row.boardingCar) || !DOOR.test(row.alightingDoor) || !DOOR.test(row.boardingDoor)) {
    throw new Error(`${label} car-door mismatch`);
  }
  if (!DURATION.test(row.duration)) throw new Error(`${label} duration mismatch`);
}

// 따옴표 필드("..."·"" 이스케이프)와 따옴표 없는 필드만 받는다. 그 밖의 형식은 실패한다.
function parseCsvLine(line) {
  const values = [];
  let index = 0;
  for (;;) {
    if (line[index] === "\"") {
      let value = "";
      index += 1;
      for (;;) {
        if (index >= line.length) throw new Error("Seoul transfer car-door CSV has an unterminated quoted field");
        if (line[index] === "\"") {
          if (line[index + 1] === "\"") { value += "\""; index += 2; continue; }
          index += 1;
          break;
        }
        value += line[index];
        index += 1;
      }
      values.push(value);
    } else {
      const end = line.indexOf(",", index);
      const value = end === -1 ? line.slice(index) : line.slice(index, end);
      if (value.includes("\"")) throw new Error("Seoul transfer car-door CSV has a stray quote");
      values.push(value);
      index = end === -1 ? line.length : end;
    }
    if (index === line.length) return values;
    if (line[index] !== ",") throw new Error("Seoul transfer car-door CSV field separator mismatch");
    index += 1;
  }
}

export function seoulMetroTransferContentSha256(rows) {
  return sha256(JSON.stringify(rows.map((row) => ROW_FIELDS.map((field) => row[field]))));
}

// data.go.kr는 UTF-8 파일명을 따옴표 filename에 그대로 담아 보낸다. fetch 헤더 값은 바이트 문자열(latin1)이다.
export function contentDispositionFileName(value) {
  const match = /^attachment; filename="([^"]+)"$/u.exec(value ?? "");
  if (!match) throw new Error("Seoul transfer car-door content disposition mismatch");
  const bytes = Buffer.from(match[1], "latin1");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("Seoul transfer car-door file name must be UTF-8");
  }
}

function instant(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.valueOf()) || (typeof value === "string" && date.toISOString() !== value)) {
    throw new Error("Seoul transfer car-door capture time must be canonical UTC");
  }
  return date.toISOString();
}

function sha256(value) { return createHash("sha256").update(value).digest("hex"); }

async function main(argv) {
  if (argv.length !== 2 || argv[0] !== "--output" || !path.isAbsolute(argv[1])) {
    throw new Error("usage: collect-seoul-metro-transfer-car-door-duration.mjs --output <absolute absent file>");
  }
  const output = path.resolve(argv[1]);
  await lstat(output).then(() => { throw new Error("output must be absent"); }, (error) => { if (error?.code !== "ENOENT") throw error; });
  const snapshot = await collectSeoulMetroTransferCarDoorDuration();
  validateSeoulMetroTransferSnapshot(snapshot);
  await writeFile(output, `${JSON.stringify(snapshot)}\n`, { flag: "wx", mode: 0o644 });
  console.log(JSON.stringify({
    rowCount: snapshot.rowCount, rawSha256: snapshot.rawSha256, contentSha256: snapshot.contentSha256,
    sourceEffectiveDate: snapshot.sourceEffectiveDate, capturedAt: snapshot.capturedAt,
  }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
