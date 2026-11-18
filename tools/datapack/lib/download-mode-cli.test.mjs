import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { loadDataGoInputs, parseDownloadModeArgs, resolveCapturedAt } from "./download-mode-cli.mjs";
import { createDataGoPortalFetch } from "./data-go-test-portal.mjs";

const USAGE = "usage: sample";
const spec = {
  usage: USAGE,
  valueFlags: ["input", "output", "captured-at"],
  fileModeRequired: ["input", "output"],
  downloadRequired: ["output"],
  downloadForbidden: ["input", "captured-at"],
  absolute: ["output"],
};

test("다운로드 모드와 파일 입력 모드의 인자 조합을 usage 오류로 강제한다", () => {
  assert.deepEqual(parseDownloadModeArgs(["--input", "a.csv", "--output", "/tmp/o.json"], spec),
    { download: false, input: "a.csv", output: "/tmp/o.json" });
  assert.deepEqual(parseDownloadModeArgs(["--download", "--output", "/tmp/o.json"], spec),
    { download: true, output: "/tmp/o.json" });
  assert.equal(parseDownloadModeArgs(["--input", "a", "--output", "/tmp/o", "--captured-at", "2026-10-06T00:00:00Z"], spec)["captured-at"],
    "2026-10-06T00:00:00Z");
  for (const argv of [
    [],
    ["--download"],
    ["--input", "a.csv"],
    ["--input", "a.csv", "--output", "relative.json"],
    ["--download", "--input", "a.csv", "--output", "/tmp/o.json"],
    ["--download", "--captured-at", "2026-10-06T00:00:00Z", "--output", "/tmp/o.json"],
    ["--download", "--download", "--output", "/tmp/o.json"],
    ["--input", "a", "--input", "b", "--output", "/tmp/o.json"],
    ["--input", "--output", "/tmp/o.json"],
    ["--unknown", "x", "--download", "--output", "/tmp/o.json"],
  ]) {
    assert.throws(() => parseDownloadModeArgs(argv, spec), { message: USAGE }, argv.join(" "));
  }
});

test("capturedAt은 다운로드 모드에서 수신 시각, 파일 모드에서 지정값(없으면 현재)이다", () => {
  const now = () => new Date("2026-10-06T03:00:00.000Z");
  assert.equal(resolveCapturedAt({ download: true }, now).toISOString(), "2026-10-06T03:00:00.000Z");
  assert.equal(resolveCapturedAt({ download: false, "captured-at": "2026-07-24T01:00:00.000Z" }, now).toISOString(),
    "2026-07-24T01:00:00.000Z");
  assert.equal(resolveCapturedAt({ download: false }, now).toISOString(), "2026-10-06T03:00:00.000Z");
  assert.throws(() => resolveCapturedAt({ download: false, "captured-at": "not-a-date" }, now), /captured-at is invalid/);
  assert.throws(() => resolveCapturedAt({ download: true }, () => new Date("x")), /now is invalid/);
});

test("입력은 다운로드 모드면 순서대로 받고 provenance를 함께 주며 파일 모드면 지정 파일을 읽는다", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "download-mode-cli-"));
  try {
    await writeFile(path.join(dir, "a.csv"), "A");
    await writeFile(path.join(dir, "b.csv"), "B");
    const fromFiles = await loadDataGoInputs({
      args: { download: false },
      datasetIds: ["15041384", "15041361"], inputPaths: [path.join(dir, "a.csv"), path.join(dir, "b.csv")],
    });
    assert.deepEqual(fromFiles.bytes.map(String), ["A", "B"]);
    assert.equal(fromFiles.downloadProvenance, undefined);
    const downloaded = await loadDataGoInputs({
      args: { download: true },
      datasetIds: ["15041384", "15041361"], inputPaths: [],
      fetchImpl: createDataGoPortalFetch({ 15041384: "첫째", 15041361: "둘째" }),
    });
    assert.deepEqual(downloaded.bytes.map(String), ["첫째", "둘째"]);
    assert.deepEqual(downloaded.downloadProvenance.map(({ datasetId }) => datasetId), ["15041384", "15041361"]);
    await assert.rejects(loadDataGoInputs({
      args: { download: true }, datasetIds: ["15041384", "15041361"], inputPaths: [],
      fetchImpl: createDataGoPortalFetch({ 15041384: "첫째" }),
    }), /15041361 detail HTTP 404/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
