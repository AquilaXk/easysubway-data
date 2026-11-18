import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { normalizeTransferDistanceDurationRows } from "./normalize-transfer-distance-duration-rows.mjs";

const execFileAsync = promisify(execFile);

function transferRow(overrides = {}) {
  return {
    연번: 1,
    호선: 2,
    환승거리: 74,
    환승노선: "4호선",
    환승소요시간: "01:02",
    환승역명: "사당",
    ...overrides,
  };
}

test("정수 호선 → \"N호선\" 문자열, MM:SS → 초 정수", () => {
  const { normalizedRows, malformed } = normalizeTransferDistanceDurationRows([transferRow()]);
  assert.equal(malformed.length, 0);
  assert.equal(normalizedRows.length, 1);
  assert.equal(normalizedRows[0].호선, "2호선");
  assert.equal(normalizedRows[0].환승소요시간, 62);
  // 나머지 필드는 원형 유지.
  assert.equal(normalizedRows[0].환승노선, "4호선");
  assert.equal(normalizedRows[0].환승거리, 74);
  assert.equal(normalizedRows[0].환승역명, "사당");
});

test("MM:SS 파싱: \"02:13\" → 133", () => {
  const { normalizedRows } = normalizeTransferDistanceDurationRows([transferRow({ 환승소요시간: "02:13" })]);
  assert.equal(normalizedRows[0].환승소요시간, 133);
});

test("비호선 환승노선(공항철도 등)은 변환 성공 — 매칭은 importer 몫이라 필터링하지 않는다", () => {
  const rows = [
    transferRow({ 환승노선: "공항철도" }),
    transferRow({ 환승노선: "경의중앙선" }),
    transferRow({ 환승노선: "GTX-A" }),
    transferRow({ 환승노선: "우이신설선" }),
  ];
  const { normalizedRows, malformed } = normalizeTransferDistanceDurationRows(rows);
  assert.equal(malformed.length, 0);
  assert.equal(normalizedRows.length, 4);
  assert.deepEqual(
    normalizedRows.map((row) => row.환승노선),
    ["공항철도", "경의중앙선", "GTX-A", "우이신설선"],
  );
});

test("콜론 없는 환승소요시간 → malformed(필터링 아님)", () => {
  const { normalizedRows, malformed } = normalizeTransferDistanceDurationRows([transferRow({ 환승소요시간: "62" })]);
  assert.equal(normalizedRows.length, 0);
  assert.equal(malformed.length, 1);
  assert.match(malformed[0].reason, /환승소요시간 format invalid/);
});

test("빈 콜론(\":\") 환승소요시간 → malformed", () => {
  const { normalizedRows, malformed } = normalizeTransferDistanceDurationRows([transferRow({ 환승소요시간: ":" })]);
  assert.equal(normalizedRows.length, 0);
  assert.equal(malformed.length, 1);
  assert.equal(typeof malformed[0].reason, "string");
  assert.match(malformed[0].reason, /환승소요시간 format invalid/);
});

test("초 범위 초과(\"09:99\") → malformed(0-59 검증)", () => {
  const { normalizedRows, malformed } = normalizeTransferDistanceDurationRows([transferRow({ 환승소요시간: "09:99" })]);
  assert.equal(normalizedRows.length, 0);
  assert.equal(malformed.length, 1);
  assert.equal(typeof malformed[0].reason, "string");
  assert.match(malformed[0].reason, /out of range/);
});

test("분 범위 초과(\"99:00\") → malformed", () => {
  const { normalizedRows, malformed } = normalizeTransferDistanceDurationRows([transferRow({ 환승소요시간: "99:00" })]);
  assert.equal(normalizedRows.length, 0);
  assert.equal(malformed.length, 1);
  assert.equal(typeof malformed[0].reason, "string");
  assert.match(malformed[0].reason, /out of range/);
});

test("최대 유효 시간 59:59 → 3599초", () => {
  const { normalizedRows, malformed } = normalizeTransferDistanceDurationRows([
    transferRow({ 환승소요시간: "59:59" }),
  ]);
  assert.equal(malformed.length, 0);
  assert.equal(normalizedRows[0].환승소요시간, 3599);
});

test("호선이 정수도 문자열도 아니면 malformed", () => {
  const invalidLineValues = [null, true, 2.5, {}, []];
  const { normalizedRows, malformed } = normalizeTransferDistanceDurationRows(
    invalidLineValues.map((호선) => transferRow({ 호선 })),
  );
  assert.equal(normalizedRows.length, 0);
  assert.equal(malformed.length, invalidLineValues.length);
  for (const entry of malformed) {
    assert.equal(typeof entry.reason, "string");
    assert.match(entry.reason, /호선 must be/);
  }
});

test("이미 문자열인 호선은 그대로 통과", () => {
  const { normalizedRows, malformed } = normalizeTransferDistanceDurationRows([transferRow({ 호선: "4호선" })]);
  assert.equal(malformed.length, 0);
  assert.equal(normalizedRows[0].호선, "4호선");
});

test("N호선 전체 형식이 아닌 문자열은 malformed", () => {
  const { normalizedRows, malformed } = normalizeTransferDistanceDurationRows([
    transferRow({ 호선: "4호선abc" }),
  ]);
  assert.equal(normalizedRows.length, 0);
  assert.equal(malformed.length, 1);
  assert.match(malformed[0].reason, /호선 must be/);
});

test("0호선·선행 0 호선 문자열은 malformed", () => {
  const { normalizedRows, malformed } = normalizeTransferDistanceDurationRows([
    transferRow({ 호선: "0호선" }),
    transferRow({ 호선: "04호선" }),
  ]);
  assert.equal(normalizedRows.length, 0);
  assert.equal(malformed.length, 2);
  for (const entry of malformed) assert.match(entry.reason, /호선 must be/);
});

test("MM:SS의 분이 한 자리인 시간은 malformed", () => {
  const { normalizedRows, malformed } = normalizeTransferDistanceDurationRows([
    transferRow({ 환승소요시간: "9:02" }),
  ]);
  assert.equal(normalizedRows.length, 0);
  assert.equal(malformed.length, 1);
  assert.match(malformed[0].reason, /format invalid/);
});

test("객체 아닌 행 → malformed", () => {
  const { normalizedRows, malformed } = normalizeTransferDistanceDurationRows(["not-an-object", null]);
  assert.equal(normalizedRows.length, 0);
  assert.equal(malformed.length, 2);
  for (const entry of malformed) assert.equal(typeof entry.reason, "string");
});

test("빈 입력 → 빈 결과", () => {
  const { normalizedRows, malformed } = normalizeTransferDistanceDurationRows([]);
  assert.equal(normalizedRows.length, 0);
  assert.equal(malformed.length, 0);
});

test("CLI 상대경로 실행은 --output 파일을 생성한다", async () => {
  const outputDir = await mkdtemp(path.join(tmpdir(), "transfer-normalizer-"));
  const rowsPath = path.join(outputDir, "rows.json");
  const outputPath = path.join(outputDir, "normalized.json");
  try {
    await writeFile(rowsPath, `${JSON.stringify([transferRow()])}\n`);
    await execFileAsync(
      process.execPath,
      ["tools/datapack/normalize-transfer-distance-duration-rows.mjs", "--rows", rowsPath, "--output", outputPath],
      { cwd: process.cwd() },
    );
    const result = JSON.parse(await readFile(outputPath, "utf8"));
    assert.equal(result.normalizedRows[0].환승소요시간, 62);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("CLI URL 인코딩 경로 실행도 --output 파일을 생성한다", async () => {
  const outputDir = await mkdtemp(path.join(tmpdir(), "transfer normalizer-"));
  const scriptDir = path.join(outputDir, "script path");
  const scriptPath = path.join(scriptDir, "normalize rows.mjs");
  const rowsPath = path.join(outputDir, "rows.json");
  const outputPath = path.join(outputDir, "normalized.json");
  try {
    await mkdir(path.join(scriptDir, "lib"), { recursive: true });
    await copyFile("tools/datapack/normalize-transfer-distance-duration-rows.mjs", scriptPath);
    await copyFile("tools/datapack/lib/ledger-admission-cli.mjs", path.join(scriptDir, "lib/ledger-admission-cli.mjs"));
    await writeFile(rowsPath, `${JSON.stringify([transferRow()])}\n`);
    const canonicalScriptPath = await realpath(scriptPath);
    await execFileAsync(process.execPath, [canonicalScriptPath, "--rows", rowsPath, "--output", outputPath]);
    const result = JSON.parse(await readFile(outputPath, "utf8"));
    assert.equal(result.normalizedRows[0].환승소요시간, 62);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});
