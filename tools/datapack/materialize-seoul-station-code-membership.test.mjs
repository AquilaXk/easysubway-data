import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { materializeSeoulStationCodeMembership } from "./materialize-seoul-station-code-membership.mjs";

const ARTIFACT_PATH = path.resolve(import.meta.dirname, "sources/seoul-station-code-membership-20260909T041501Z.json");

// The OA-15442 sheet CSV is EUC-KR and Node has no encoder, so build a syllable table by decoding the KS X 1001 Hangul block.
const EUC_KR_HANGUL = (() => {
  const decoder = new TextDecoder("euc-kr", { fatal: true });
  const table = new Map();
  for (let lead = 0xb0; lead <= 0xc8; lead += 1) {
    for (let trail = 0xa1; trail <= 0xfe; trail += 1) {
      try { table.set(decoder.decode(Uint8Array.of(lead, trail)), [lead, trail]); } catch { /* unassigned cell */ }
    }
  }
  return table;
})();

function eucKr(text) {
  const bytes = [];
  for (const char of text) {
    if (char.charCodeAt(0) < 0x80) bytes.push(char.charCodeAt(0));
    else if (EUC_KR_HANGUL.has(char)) bytes.push(...EUC_KR_HANGUL.get(char));
    else throw new Error(`fixture character is not a KS X 1001 Hangul syllable: ${char}`);
  }
  return Buffer.from(bytes);
}

test("committed membership artifact replays from its own stored CSV bytes", async () => {
  const committed = JSON.parse(await readFile(ARTIFACT_PATH, "utf8"));
  const dir = await mkdtemp(path.join(tmpdir(), "membership-replay-"));
  try {
    const csvPath = path.join(dir, "oa15442.csv");
    const outputPath = path.join(dir, "membership.json");
    await writeFile(csvPath, Buffer.from(committed.snapshot.rawBytesBase64, "base64"));
    const replayed = await materializeSeoulStationCodeMembership({ csvPath, capturedAt: committed.capturedAt, outputPath });
    assert.equal(replayed.snapshot.rowCount, 799);
    assert.equal(replayed.records.length, 277);
    assert.deepEqual(replayed.records, committed.records);
    assert.equal(replayed.recordsSha256, committed.recordsSha256);
    assert.equal(replayed.artifactSha256, committed.artifactSha256);
    assert.deepEqual(JSON.parse(await readFile(outputPath, "utf8")), replayed);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a tiny CSV that does not cover the current roster fails closed and writes no artifact", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "membership-tiny-"));
  try {
    const csvPath = path.join(dir, "tiny.csv");
    const outputPath = path.join(dir, "membership.json");
    await writeFile(csvPath, eucKr([
      "전철역코드,전철역명,전철명명(영문),호선,외부코드,전철명명(중문),전철명명(일문)",
      "150,서울,Seoul,1호선,133,Seoul,Seoul",
    ].join("\n") + "\n"));
    await assert.rejects(
      () => materializeSeoulStationCodeMembership({ csvPath, capturedAt: "2026-09-09T04:15:01.000Z", outputPath }),
      /unmatched roster station/,
    );
    await assert.rejects(() => stat(outputPath), { code: "ENOENT" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("missing arguments are rejected before any read", async () => {
  await assert.rejects(() => materializeSeoulStationCodeMembership({}), /csvPath, capturedAt and outputPath are required/);
});
