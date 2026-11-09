import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { ISO_HMS_DURATION_PATTERN, parseIsoDurationMs } from "./iso-duration.mjs";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "../..");

test("parseIsoDurationMs는 시·분·초 ISO 8601 duration을 밀리초 정수로 변환한다", () => {
  assert.equal(parseIsoDurationMs("PT1S"), 1_000);
  assert.equal(parseIsoDurationMs("PT30M"), 30 * 60_000);
  assert.equal(parseIsoDurationMs("PT6H"), 6 * 3_600_000);
  assert.equal(parseIsoDurationMs("PT1H30M45S"), (3_600 + 1_800 + 45) * 1_000);
  assert.equal(ISO_HMS_DURATION_PATTERN.test("PT6H"), true);
});

test("parseIsoDurationMs는 빈 PT, 0 이하, 형식 불일치, 비문자열, 안전 정수 초과 입력을 거부한다", () => {
  for (const invalid of [
    undefined,
    null,
    6,
    "",
    "PT",
    "PT0S",
    "PT0H0M0S",
    "P1D",
    "PT-1H",
    "PT1.5H",
    "PT6H ",
    "pt6h",
    `PT${"9".repeat(20)}H`,
  ]) {
    assert.throws(
      () => parseIsoDurationMs(invalid, "alertBeforePackExpiry"),
      /alertBeforePackExpiry must be a positive ISO-8601 duration/,
      String(invalid),
    );
  }
  assert.throws(
    () => parseIsoDurationMs("PT"),
    /duration must be a positive ISO-8601 duration/,
  );
});

test("check-datapack-expiry-alert는 공용 duration 파서로 경보 임계치를 계산하고 잘못된 duration 정책을 거부한다", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "expiry-alert-test-"));
  try {
    const manifestPath = path.join(dir, "manifest.json");
    const outputPath = path.join(dir, "evidence.json");
    const badPolicyPath = path.join(dir, "bad-policy.json");
    await writeFile(manifestPath, JSON.stringify({
      channel: "production",
      releaseSequence: 42,
      publishedAt: "2026-07-01T18:00:00.000Z",
      expiresAt: "2026-07-02T05:30:00.000Z",
    }));
    await execFileAsync(process.execPath, [
      "tools/datapack/check-datapack-expiry-alert.mjs",
      "--manifest", manifestPath,
      "--output", outputPath,
      "--now", "2026-07-02T00:00:00.000Z",
    ], { cwd: root });
    const evidence = JSON.parse(await readFile(outputPath, "utf8"));
    assert.equal(evidence.policy.thresholdSeconds, 21_600);
    assert.equal(evidence.alert.status, "FIRING");
    assert.equal(evidence.alert.secondsUntilExpiry, 19_800);

    await writeFile(badPolicyPath, JSON.stringify({ monitoring: { alertBeforePackExpiry: "PT0S" } }));
    await assert.rejects(execFileAsync(process.execPath, [
      "tools/datapack/check-datapack-expiry-alert.mjs",
      "--manifest", manifestPath,
      "--policy", badPolicyPath,
      "--output", outputPath,
      "--now", "2026-07-02T00:00:00.000Z",
    ], { cwd: root }), /alertBeforePackExpiry must be a positive ISO-8601 duration/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
