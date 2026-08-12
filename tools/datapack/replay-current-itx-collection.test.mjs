import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createProviderResponseRecorder,
  providerResponseCaptureBytes,
} from "./provider-response-capture.mjs";
import { runReplayCurrentItxCollectionCli } from "./replay-current-itx-collection.mjs";

const SERVICE_DATES = Object.freeze({ "7": "20260822", "8": "20260812", "9": "20260816" });

function request(operation, key = "capture-key") {
  return `https://apis.data.go.kr/1613000/TrainInfo/${operation}?serviceKey=${key}&_type=json`;
}

async function capturedBytes() {
  const recorder = createProviderResponseRecorder({
    observedAt: "2026-08-12T00:00:00.000Z",
    selectedServiceDates: SERVICE_DATES,
    fetchImpl: async (url) => new Response(JSON.stringify({ operation: new URL(url).pathname.split("/").at(-1) }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  });
  await recorder.fetchImpl(request("GetVhcleKndList"));
  await recorder.fetchImpl(request("GetCtyCodeList"));
  return providerResponseCaptureBytes(recorder.captureArtifact());
}

test("current capture를 runtime credential과 network 없이 exact 순서로 replay한다", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "itx-provider-replay-"));
  const capture = path.join(directory, "capture.json");
  const output = path.join(directory, "replay.json");
  const stationCatalogPack = path.join(directory, "station-catalog-pack");
  await writeFile(capture, await capturedBytes());
  let received;
  let replayCalls = 0;
  try {
    const result = await runReplayCurrentItxCollectionCli({
      argv: ["--capture", capture, "--output", output, "--station-catalog-pack", stationCatalogPack],
      repositoryRoot: directory,
      runCompletenessImpl: async (options) => {
        received = options;
        for (const operation of ["GetVhcleKndList", "GetCtyCodeList"]) {
          const response = await options.fetchImpl(request(operation, "different-runtime-key"));
          assert.match(await response.text(), new RegExp(operation));
          replayCalls += 1;
        }
        await writeFile(options.argv.at(-1), `${JSON.stringify({ validationMode: "REPLAY" })}\n`);
        return {
          artifact: { validationMode: "REPLAY", selectedServiceDates: SERVICE_DATES },
          candidate: null,
          exitCode: 0,
        };
      },
    });

    assert.equal(replayCalls, 2);
    assert.deepEqual(received.argv, [
      "--replay",
      "--day8-date", SERVICE_DATES["8"],
      "--day7-date", SERVICE_DATES["7"],
      "--day9-date", SERVICE_DATES["9"],
      "--station-catalog-pack", stationCatalogPack,
      "--output", received.argv.at(-1),
    ]);
    assert.deepEqual(received.env, {});
    assert.notEqual(received.argv.at(-1), output);
    assert.equal(path.dirname(path.dirname(received.argv.at(-1))), directory);
    assert.equal(received.providerServiceKey, "offline-provider-replay-key");
    assert.equal(received.now.toISOString(), "2026-08-12T00:00:00.000Z");
    assert.equal(typeof received.collectImpl, "function");
    assert.equal(result.candidate, null);
    assert.deepEqual(JSON.parse(await readFile(output, "utf8")), { validationMode: "REPLAY" });
    assert.deepEqual((await readdir(directory)).filter((name) => name.startsWith(".provider-replay-")), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("replay가 capture record를 덜 소비하면 output을 보존하지 않는다", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "itx-provider-replay-incomplete-"));
  const capture = path.join(directory, "capture.json");
  const output = path.join(directory, "replay.json");
  await writeFile(capture, await capturedBytes());
  try {
    await assert.rejects(runReplayCurrentItxCollectionCli({
      argv: ["--capture", capture, "--output", output, "--station-catalog-pack", path.join(directory, "station-catalog-pack")],
      repositoryRoot: directory,
      runCompletenessImpl: async ({ argv: receivedArgv, fetchImpl }) => {
        await fetchImpl(request("GetVhcleKndList"));
        await writeFile(receivedArgv.at(-1), "partial\n");
        return { artifact: { validationMode: "REPLAY", selectedServiceDates: SERVICE_DATES }, candidate: null, exitCode: 1 };
      },
    }), /provider replay has 1 unconsumed record/);
    await assert.rejects(readFile(output), /ENOENT/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("replay는 다른 process가 생성한 requested output을 삭제하지 않는다", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "itx-provider-replay-replacement-"));
  const capture = path.join(directory, "capture.json");
  const output = path.join(directory, "replay.json");
  await writeFile(capture, await capturedBytes());
  try {
    await assert.rejects(runReplayCurrentItxCollectionCli({
      argv: ["--capture", capture, "--output", output, "--station-catalog-pack", path.join(directory, "station-catalog-pack")],
      repositoryRoot: directory,
      runCompletenessImpl: async ({ argv: receivedArgv, fetchImpl }) => {
        for (const operation of ["GetVhcleKndList", "GetCtyCodeList"]) await fetchImpl(request(operation));
        await writeFile(receivedArgv.at(-1), "owned staging output\n");
        await writeFile(output, "outside replacement\n", { flag: "wx" });
        return {
          artifact: { validationMode: "REPLAY", selectedServiceDates: SERVICE_DATES },
          candidate: null,
          exitCode: 0,
        };
      },
    }), /EEXIST/);
    assert.equal(await readFile(output, "utf8"), "outside replacement\n");
    assert.deepEqual((await readdir(directory)).filter((name) => name.startsWith(".provider-replay-")), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
