import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createProviderResponseRecorder,
  parseProviderResponseCapture,
  providerResponseCaptureBytes,
} from "./provider-response-capture.mjs";
import { runContinueCurrentItxCollectionCli } from "./continue-current-itx-collection.mjs";

const OBSERVED_AT = "2026-08-12T15:00:49.084Z";
const NOW = new Date("2026-08-13T01:00:00.000Z");
const SERVICE_DATES = Object.freeze({ "7": "20260822", "8": "20260813", "9": "20260816" });

function tagoRequest(operation, key = "capture-secret") {
  return `https://apis.data.go.kr/1613000/TrainInfo/${operation}?serviceKey=${key}&_type=json`;
}

function korailRequest(operation, date, pageNo = 1, key = "runtime-secret") {
  const url = new URL(`https://apis.data.go.kr/B551457/run/v2/${operation}`);
  for (const [name, value] of Object.entries({
    serviceKey: key,
    pageNo: String(pageNo),
    numOfRows: "1000",
    returnType: "JSON",
    "cond[run_ymd::GTE]": date,
    "cond[run_ymd::LTE]": date,
  })) url.searchParams.set(name, value);
  return url.href;
}

async function baseCaptureBytes() {
  const recorder = createProviderResponseRecorder({
    observedAt: OBSERVED_AT,
    selectedServiceDates: SERVICE_DATES,
    fetchImpl: async (url) => new Response(new URL(url).pathname.split("/").at(-1), {
      headers: { "content-type": "application/json" },
    }),
  });
  await recorder.fetchImpl(tagoRequest("GetVhcleKndList"));
  await recorder.fetchImpl(tagoRequest("GetCtyCodeList"));
  return providerResponseCaptureBytes(recorder.captureArtifact());
}

function cliPaths(directory) {
  return {
    capture: path.join(directory, "capture.json"),
    stationCatalogPack: path.join(directory, "station-catalog-pack"),
    output: path.join(directory, "candidate.json"),
    completenessOutput: path.join(directory, "completeness.json"),
    extendedCaptureOutput: path.join(directory, "extended-capture.json"),
  };
}

function cliArgv(paths) {
  return [
    "--capture", paths.capture,
    "--station-catalog-pack", paths.stationCatalogPack,
    "--output", paths.output,
    "--completeness-output", paths.completenessOutput,
    "--extended-capture-output", paths.extendedCaptureOutput,
  ];
}

async function absent(target) {
  await assert.rejects(readFile(target), /ENOENT/);
}

test("preserved TAGO records를 interleaved exact-once replay하고 Korail suffix만 live capture한다", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "itx-capture-continuation-"));
  const paths = cliPaths(directory);
  await writeFile(paths.capture, await baseCaptureBytes());
  const livePaths = [];
  try {
    const result = await runContinueCurrentItxCollectionCli({
      argv: cliArgv(paths),
      env: { DATA_GO_KR_SERVICE_KEY: "runtime-secret" },
      now: NOW,
      repositoryRoot: directory,
      providerFetchImpl: async (url) => {
        livePaths.push(new URL(url).pathname);
        return new Response("suffix", { headers: { "content-type": "application/json" } });
      },
      runCompletenessImpl: async (options) => {
        assert.equal(await (await options.fetchImpl(tagoRequest("GetCtyCodeList", "runtime-secret"))).text(), "GetCtyCodeList");
        assert.equal(await (await options.fetchImpl(korailRequest("travelerTrainRunPlan2", SERVICE_DATES["8"]))).text(), "suffix");
        assert.equal(await (await options.fetchImpl(tagoRequest("GetVhcleKndList", "runtime-secret"))).text(), "GetVhcleKndList");
        assert.equal(await (await options.fetchImpl(korailRequest("travelerTrainRunInfo2", SERVICE_DATES["8"]))).text(), "suffix");
        const output = options.argv[options.argv.indexOf("--output") + 1];
        const completeness = options.argv[options.argv.indexOf("--completeness-output") + 1];
        await writeFile(output, "candidate\n");
        await writeFile(completeness, "completeness\n");
        return {
          artifact: { validationMode: "ADMISSION", validationStatus: "SUPPORTED", selectedServiceDates: SERVICE_DATES },
          candidate: { promotionStatus: "CANDIDATE" },
          outputSha256: "a".repeat(64),
          completenessEvidenceSha256: "b".repeat(64),
          exitCode: 0,
        };
      },
    });

    assert.deepEqual(livePaths, [
      "/B551457/run/v2/travelerTrainRunPlan2",
      "/B551457/run/v2/travelerTrainRunInfo2",
    ]);
    assert.equal(await readFile(paths.output, "utf8"), "candidate\n");
    assert.equal(await readFile(paths.completenessOutput, "utf8"), "completeness\n");
    const extendedBytes = await readFile(paths.extendedCaptureOutput);
    const extended = parseProviderResponseCapture(extendedBytes);
    assert.equal(extended.requestCount, 4);
    assert.equal(result.continuation.baseRequestCount, 2);
    assert.equal(result.continuation.liveRequestCount, 2);
    assert.equal(result.continuation.extendedContentSha256, extended.contentSha256);
    assert.doesNotMatch(extendedBytes.toString("utf8"), /runtime-secret|capture-secret|serviceKey/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("allowed suffix transport failure는 sanitized result와 extended capture만 보존한다", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "itx-capture-continuation-failure-"));
  const paths = cliPaths(directory);
  await writeFile(paths.capture, await baseCaptureBytes());
  try {
    const result = await runContinueCurrentItxCollectionCli({
      argv: cliArgv(paths),
      env: { DATA_GO_KR_SERVICE_KEY: "runtime-secret" },
      now: NOW,
      repositoryRoot: directory,
      providerFetchImpl: async () => { throw new Error("raw-runtime-secret-provider-failure"); },
      runCompletenessImpl: async (options) => {
        await options.fetchImpl(tagoRequest("GetVhcleKndList", "runtime-secret"));
        await options.fetchImpl(tagoRequest("GetCtyCodeList", "runtime-secret"));
        await assert.rejects(
          options.fetchImpl(korailRequest("travelerTrainRunPlan2", SERVICE_DATES["8"])),
          /raw-runtime-secret-provider-failure/,
        );
        const output = options.argv[options.argv.indexOf("--output") + 1];
        await writeFile(output, "sanitized failure\n");
        return {
          artifact: { validationMode: "ADMISSION", validationStatus: "MISSING", selectedServiceDates: SERVICE_DATES },
          candidate: null,
          exitCode: 1,
        };
      },
    });

    assert.equal(result.exitCode, 1);
    assert.equal(await readFile(paths.output, "utf8"), "sanitized failure\n");
    await absent(paths.completenessOutput);
    const extendedBytes = await readFile(paths.extendedCaptureOutput);
    const extended = parseProviderResponseCapture(extendedBytes);
    assert.deepEqual(extended.records.at(-1).outcome, { kind: "TRANSPORT_FAILURE" });
    assert.doesNotMatch(extendedBytes.toString("utf8"), /raw-runtime-secret|provider-failure/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("unconsumed base, denied identity, suffix 0/19와 path collision은 final output 0이다", async (context) => {
  const runScenario = async (name, operation) => {
    let observedUpstreamCalls = 0;
    await context.test(name, async () => {
      const directory = await mkdtemp(path.join(tmpdir(), `itx-capture-continuation-${name}-`));
      const paths = cliPaths(directory);
      await writeFile(paths.capture, await baseCaptureBytes());
      let upstreamCalls = 0;
      try {
        await assert.rejects(runContinueCurrentItxCollectionCli({
          argv: cliArgv(paths),
          env: { DATA_GO_KR_SERVICE_KEY: "runtime-secret" },
          now: NOW,
          repositoryRoot: directory,
          providerFetchImpl: async () => {
            upstreamCalls += 1;
            return new Response("suffix", { headers: { "content-type": "application/json" } });
          },
          runCompletenessImpl: async (options) => {
            await operation(options);
            const output = options.argv[options.argv.indexOf("--output") + 1];
            await writeFile(output, "must not publish\n");
            return {
              artifact: { validationMode: "ADMISSION", validationStatus: "MISSING", selectedServiceDates: SERVICE_DATES },
              candidate: null,
              exitCode: 1,
            };
          },
        }));
        await absent(paths.output);
        await absent(paths.completenessOutput);
        await absent(paths.extendedCaptureOutput);
        observedUpstreamCalls = upstreamCalls;
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
    return observedUpstreamCalls;
  };

  await runScenario("unconsumed", async ({ fetchImpl }) => {
    await fetchImpl(tagoRequest("GetVhcleKndList", "runtime-secret"));
    await fetchImpl(korailRequest("travelerTrainRunPlan2", SERVICE_DATES["8"]));
  });
  await runScenario("denied", async ({ fetchImpl }) => {
    await fetchImpl(tagoRequest("GetVhcleKndList", "runtime-secret"));
    await fetchImpl(tagoRequest("GetCtyCodeList", "runtime-secret"));
    await assert.rejects(fetchImpl(tagoRequest("GetStrtpntAlocFndTrainInfo", "runtime-secret")));
  });
  await runScenario("suffix-zero", async ({ fetchImpl }) => {
    await fetchImpl(tagoRequest("GetVhcleKndList", "runtime-secret"));
    await fetchImpl(tagoRequest("GetCtyCodeList", "runtime-secret"));
  });
  const overflowCalls = await runScenario("suffix-overflow", async ({ fetchImpl }) => {
    await fetchImpl(tagoRequest("GetVhcleKndList", "runtime-secret"));
    await fetchImpl(tagoRequest("GetCtyCodeList", "runtime-secret"));
    for (let pageNo = 1; pageNo <= 19; pageNo += 1) {
      try {
        await fetchImpl(korailRequest("travelerTrainRunPlan2", SERVICE_DATES["8"], pageNo));
      } catch {
        break;
      }
    }
  });
  assert.equal(overflowCalls, 18);

  await context.test("path-collision", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "itx-capture-continuation-collision-"));
    const paths = cliPaths(directory);
    await writeFile(paths.capture, await baseCaptureBytes());
    await writeFile(paths.output, "outside\n");
    try {
      await assert.rejects(runContinueCurrentItxCollectionCli({
        argv: cliArgv(paths),
        env: { DATA_GO_KR_SERVICE_KEY: "runtime-secret" },
        now: NOW,
        repositoryRoot: directory,
        runCompletenessImpl: async () => { throw new Error("must not run"); },
      }), /absent/);
      assert.equal(await readFile(paths.output, "utf8"), "outside\n");
      await absent(paths.extendedCaptureOutput);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

test("세 publication output은 provider 실행 전에 같은 parent로 닫는다", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "itx-capture-continuation-parent-"));
  const otherDirectory = await mkdtemp(path.join(tmpdir(), "itx-capture-continuation-other-"));
  const paths = cliPaths(directory);
  paths.completenessOutput = path.join(otherDirectory, "completeness.json");
  await writeFile(paths.capture, await baseCaptureBytes());
  let upstreamCalls = 0;
  try {
    await assert.rejects(runContinueCurrentItxCollectionCli({
      argv: cliArgv(paths),
      env: { DATA_GO_KR_SERVICE_KEY: "runtime-secret" },
      now: NOW,
      repositoryRoot: directory,
      providerFetchImpl: async () => {
        upstreamCalls += 1;
        return new Response("unexpected");
      },
      runCompletenessImpl: async () => { throw new Error("collector must not run"); },
    }), /publication outputs must share one parent/);
    assert.equal(upstreamCalls, 0);
    await absent(paths.output);
    await absent(paths.completenessOutput);
    await absent(paths.extendedCaptureOutput);
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(otherDirectory, { recursive: true, force: true });
  }
});
