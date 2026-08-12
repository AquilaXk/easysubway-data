import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { runContinueCurrentItxCollectionCli } from "./continue-current-itx-collection.mjs";
import {
  createProviderResponseRecorder,
  parseProviderResponseCapture,
  providerResponseCaptureBytes,
} from "./provider-response-capture.mjs";

const OBSERVED_AT = "2026-08-12T15:00:48.000Z";
const RESUMED_AT = "2026-08-12T16:30:00.000Z";
const SERVICE_DATES = Object.freeze({ "7": "20260822", "8": "20260812", "9": "20260816" });
const ENV = Object.freeze({ DATA_GO_KR_SERVICE_KEY: "continuation-secret-key" });

function tagoRequest(operation, key = "capture-key") {
  return `https://apis.data.go.kr/1613000/TrainInfo/${operation}?serviceKey=${key}&_type=json`;
}

function korailRequest(key = "continuation-secret-key") {
  return `https://apis.data.go.kr/B551457/run/v2/codes2?serviceKey=${key}&returnType=JSON`;
}

async function baseCapture() {
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

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function args(directory, capture, contentSha256) {
  return [
    "--capture", capture,
    "--expected-capture-content-sha256", contentSha256,
    "--station-catalog-pack", path.join(directory, "station-catalog-pack"),
    "--output", path.join(directory, "itx-result.json"),
    "--completeness-output", path.join(directory, "itx-completeness.json"),
    "--suffix-capture-output", path.join(directory, "provider-response-suffix-capture.json"),
    "--continuation-receipt-output", path.join(directory, "continuation-receipt.json"),
  ];
}

test("retained TAGO capture를 identity replay하고 Korail suffix만 live capture한다", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "itx-capture-continuation-"));
  const capturePath = path.join(directory, "provider-response-capture.json");
  const captureBytes = await baseCapture();
  const capture = parseProviderResponseCapture(captureBytes);
  await writeFile(capturePath, captureBytes);
  let liveCalls = 0;
  try {
    const result = await runContinueCurrentItxCollectionCli({
      argv: args(directory, capturePath, capture.contentSha256),
      env: ENV,
      now: new Date(RESUMED_AT),
      repositoryRoot: directory,
      liveFetchImpl: async (url) => {
        liveCalls += 1;
        return new Response(JSON.stringify({ path: new URL(url).pathname, resultCode: "00" }), {
          headers: { "content-type": "application/json" },
        });
      },
      runCompletenessImpl: async (options) => {
        assert.equal(await (await options.fetchImpl(tagoRequest("GetCtyCodeList", "runtime-key"))).text(), "GetCtyCodeList");
        assert.match(await (await options.fetchImpl(korailRequest())).text(), /codes2/);
        assert.equal(await (await options.fetchImpl(tagoRequest("GetVhcleKndList", "runtime-key"))).text(), "GetVhcleKndList");
        assert.equal(options.now.toISOString(), OBSERVED_AT);
        assert.equal(options.providerServiceKey, ENV.DATA_GO_KR_SERVICE_KEY);
        assert.deepEqual(options.env, {});
        const output = options.argv[options.argv.indexOf("--output") + 1];
        const completeness = options.argv[options.argv.indexOf("--completeness-output") + 1];
        const candidateBytes = Buffer.from('{"artifactKind":"itx-source-candidate"}\n');
        const completenessBytes = Buffer.from('{"validationMode":"ADMISSION"}\n');
        await writeFile(output, candidateBytes);
        await writeFile(completeness, completenessBytes);
        return {
          artifact: {
            validationMode: "ADMISSION",
            selectedServiceDates: SERVICE_DATES,
            observedAt: OBSERVED_AT,
          },
          candidate: { artifactKind: "itx-source-candidate" },
          outputSha256: sha256(candidateBytes),
          completenessEvidenceSha256: sha256(completenessBytes),
          exitCode: 0,
        };
      },
    });

    assert.equal(result.exitCode, 0);
    assert.equal(liveCalls, 1);
    const suffixBytes = await readFile(path.join(directory, "provider-response-suffix-capture.json"));
    const suffix = parseProviderResponseCapture(suffixBytes);
    assert.equal(suffix.requestCount, 1);
    assert.equal(suffix.records[0].request.path, "/B551457/run/v2/codes2");
    const receipt = JSON.parse(await readFile(path.join(directory, "continuation-receipt.json"), "utf8"));
    assert.deepEqual(receipt, {
      schemaVersion: 1,
      artifactKind: "itx-provider-capture-continuation",
      contractVersion: "itx-provider-capture-continuation-v1",
      baseCapture: {
        contentSha256: capture.contentSha256,
        requestCount: 2,
        replayedRequestCount: 2,
      },
      suffixCapture: { contentSha256: suffix.contentSha256, requestCount: 1 },
      selectedServiceDates: SERVICE_DATES,
      observedAt: OBSERVED_AT,
      resumedAt: RESUMED_AT,
      result: {
        status: "CANDIDATE_READY",
        outputSha256: result.outputSha256,
        completenessEvidenceSha256: result.completenessEvidenceSha256,
      },
      credentialRedacted: true,
    });
    for (const file of ["itx-result.json", "itx-completeness.json", "provider-response-suffix-capture.json", "continuation-receipt.json"]) {
      assert.equal((await readFile(path.join(directory, file))).length > 0, true);
    }
    assert.doesNotMatch(`${suffixBytes}${JSON.stringify(receipt)}`, /continuation-secret-key|capture-key|serviceKey/);
    assert.deepEqual((await readdir(directory)).filter((name) => name.startsWith(".itx-continuation-")), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("uncaptured TAGO와 unconsumed base capture는 live call·output 없이 닫힌다", async () => {
  for (const mode of ["uncaptured-tago", "unconsumed-base"]) {
    const directory = await mkdtemp(path.join(tmpdir(), `itx-capture-continuation-${mode}-`));
    const capturePath = path.join(directory, "provider-response-capture.json");
    const captureBytes = await baseCapture();
    const capture = parseProviderResponseCapture(captureBytes);
    await writeFile(capturePath, captureBytes);
    let liveCalls = 0;
    try {
      await assert.rejects(runContinueCurrentItxCollectionCli({
        argv: args(directory, capturePath, capture.contentSha256),
        env: ENV,
        now: new Date(RESUMED_AT),
        repositoryRoot: directory,
        liveFetchImpl: async () => {
          liveCalls += 1;
          return new Response("must-not-run");
        },
        runCompletenessImpl: async ({ argv: receivedArgv, fetchImpl }) => {
          if (mode === "uncaptured-tago") {
            await fetchImpl(tagoRequest("GetStrtpntAlocFndTrainInfo"));
          } else {
            await fetchImpl(tagoRequest("GetVhcleKndList"));
            const output = receivedArgv[receivedArgv.indexOf("--output") + 1];
            await writeFile(output, "partial\n");
            return {
              artifact: { validationMode: "ADMISSION", selectedServiceDates: SERVICE_DATES, observedAt: OBSERVED_AT },
              candidate: null,
              outputSha256: sha256(Buffer.from("partial\n")),
              completenessEvidenceSha256: null,
              exitCode: 1,
            };
          }
        },
      }), mode === "uncaptured-tago" ? /uncaptured request is not allowed/ : /unconsumed base record/);
      assert.equal(liveCalls, 0);
      for (const file of ["itx-result.json", "itx-completeness.json", "provider-response-suffix-capture.json", "continuation-receipt.json"]) {
        await assert.rejects(readFile(path.join(directory, file)), /ENOENT/);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("malformed DATA_GO_KR_SERVICE_KEY는 collector와 provider 전에 거부한다", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "itx-capture-continuation-credential-"));
  const capturePath = path.join(directory, "provider-response-capture.json");
  const captureBytes = await baseCapture();
  const capture = parseProviderResponseCapture(captureBytes);
  await writeFile(capturePath, captureBytes);
  let calls = 0;
  try {
    await assert.rejects(runContinueCurrentItxCollectionCli({
      argv: args(directory, capturePath, capture.contentSha256),
      env: { DATA_GO_KR_SERVICE_KEY: "invalid%ZZ" },
      liveFetchImpl: async () => {
        calls += 1;
        return new Response("must-not-run");
      },
      runCompletenessImpl: async () => {
        calls += 1;
        throw new Error("must-not-run");
      },
    }), /DATA_GO_KR_SERVICE_KEY is invalid/);
    assert.equal(calls, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
