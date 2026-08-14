import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { gunzipSync } from "node:zlib";

import { buildMolitRailwayTransferMovementSnapshot } from "./collect-molit-railway-transfer-movement.mjs";
import { runCurrentMolitTransferSourceRevalidation } from "./revalidate-current-molit-transfer-source.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const serviceKey = "test+transfer/service=key";
const observedAt = "2026-08-14T00:30:00.000Z";
const providerColumns = [
  "철도운영기관코드", "선명", "역명", "환승이동순서", "이동내용상세", "환승이동내용",
];
const columnProjection = Object.freeze({
  철도운영기관코드: "RAIL_OPR_ISTT_CD",
  선명: "LN_NM",
  역명: "STIN_NM",
  환승이동순서: "CHTN_MV_TP_ORDR",
  이동내용상세: "MV_CONT_DTL",
  환승이동내용: "CHTN_MV_CONT",
});
const trackedRawBytes = gunzipSync(await readFile(
  new URL("./sources/molit-railway-transfer-movement-20250811.csv.gz", import.meta.url),
));
const trackedRows = await loadTrackedRows();

test("current ODCloud rows가 locked snapshot과 같으면 sanitized no-change evidence를 쓴다", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "molit-transfer-revalidation-"));
  try {
    const output = path.join(directory, "evidence.json");
    const calls = [];
    const evidence = await runCurrentMolitTransferSourceRevalidation({
      argv: ["--observed-at", observedAt, "--output", output],
      env: { DATA_GO_KR_SERVICE_KEY: serviceKey },
      fetchImpl: paginatedFetch(trackedRows, calls),
      repositoryRoot: root,
    });

    assert.equal(calls.length, Math.ceil(trackedRows.length / 1000));
    assert.deepEqual(calls.map(({ page }) => page), Array.from({ length: calls.length }, (_, index) => index + 1));
    assert.ok(calls.every(({ perPage, returnType, credential, redirect, signal }) =>
      perPage === "1000" && returnType === "JSON" && credential === serviceKey
      && redirect === "error" && signal instanceof AbortSignal));
    assert.equal(evidence.outcome, "NO_CHANGE_REVALIDATED");
    assert.equal(evidence.lockedSnapshot.rowCount, 8054);
    assert.equal(evidence.providerObservation.totalCount, 8054);
    assert.equal(evidence.credentialRedacted, true);
    assert.match(evidence.evidenceHash, /^[0-9a-f]{64}$/u);
    assert.deepEqual(JSON.parse(await readFile(output, "utf8")), evidence);
    assert.equal((await stat(output)).mode & 0o777, 0o600);
    assert.doesNotMatch(JSON.stringify(evidence), /test\+transfer|serviceKey|환승통로|api\.odcloud\.kr/u);

    const officialFile = path.join(directory, "official.csv");
    const officialOutput = path.join(directory, "official-evidence.json");
    await writeFile(officialFile, trackedRawBytes);
    let officialProviderCalls = 0;
    const officialEvidence = await runCurrentMolitTransferSourceRevalidation({
      argv: [
        "--observed-at", observedAt,
        "--official-file", officialFile,
        "--output", officialOutput,
      ],
      env: {},
      fetchImpl: async () => { officialProviderCalls += 1; throw new Error("must not call"); },
      repositoryRoot: root,
    });
    assert.equal(officialProviderCalls, 0);
    assert.equal(officialEvidence.operation.operationId, "15130556-fileData-20250811");
    assert.equal(officialEvidence.providerObservation.totalCount, 8054);
    assert.equal(officialEvidence.providerObservation.rawSha256, evidence.lockedSnapshot.rawSha256);
    assert.doesNotMatch(JSON.stringify(officialEvidence), /official\.csv|api\.odcloud\.kr/u);
    assert.deepEqual(JSON.parse(await readFile(officialOutput, "utf8")), officialEvidence);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }

  const fileDirectory = await mkdtemp(path.join(os.tmpdir(), "molit-transfer-official-file-"));
  try {
    const officialFile = path.join(fileDirectory, "official.csv");
    const tamperedFile = path.join(fileDirectory, "tampered.csv");
    const linkedFile = path.join(fileDirectory, "linked.csv");
    const fifoFile = path.join(fileDirectory, "fifo.csv");
    const tamperedBytes = Buffer.from(trackedRawBytes);
    tamperedBytes[tamperedBytes.length - 1] ^= 1;
    await writeFile(officialFile, trackedRawBytes);
    await writeFile(tamperedFile, tamperedBytes);
    await symlink(officialFile, linkedFile);
    assert.equal(spawnSync("mkfifo", [fifoFile]).status, 0);
    const fifoOutput = path.join(fileDirectory, "fifo-evidence.json");
    const fifoResult = spawnSync(process.execPath, [
      path.join(root, "tools/datapack/revalidate-current-molit-transfer-source.mjs"),
      "--observed-at", observedAt,
      "--official-file", fifoFile,
      "--output", fifoOutput,
    ], { encoding: "utf8", timeout: 1_000 });
    assert.equal(fifoResult.error, undefined);
    assert.equal(fifoResult.status, 1);
    assert.equal(fifoResult.stderr.trim(), "MOLIT_TRANSFER_REVALIDATION_OFFICIAL_FILE");
    await assert.rejects(stat(fifoOutput), { code: "ENOENT" });

    const growingFile = path.join(fileDirectory, "growing.csv");
    const growingOutput = path.join(fileDirectory, "growing-evidence.json");
    await writeFile(growingFile, trackedRawBytes);
    let readCapacity = 0;
    await assert.rejects(
      runCurrentMolitTransferSourceRevalidation({
        argv: ["--observed-at", observedAt, "--official-file", growingFile, "--output", growingOutput],
        env: {},
        fetchImpl: async () => { throw new Error("must not call"); },
        officialFileFixture: {
          afterStat: async () => writeFile(growingFile, Buffer.alloc(4 * 1024 * 1024), { flag: "a" }),
          onReadCapacity: (capacity) => { readCapacity = capacity; },
        },
        repositoryRoot: root,
      }),
      /MOLIT_TRANSFER_REVALIDATION_OFFICIAL_FILE/u,
    );
    assert.ok(readCapacity > 0 && readCapacity <= (4 * 1024 * 1024) + 1);
    await assert.rejects(stat(growingOutput), { code: "ENOENT" });

    for (const input of [tamperedFile, linkedFile]) {
      const output = path.join(fileDirectory, `${path.basename(input)}.evidence.json`);
      let calls = 0;
      await assert.rejects(
        runCurrentMolitTransferSourceRevalidation({
          argv: ["--observed-at", observedAt, "--official-file", input, "--output", output],
          env: {},
          fetchImpl: async () => { calls += 1; throw new Error("must not call"); },
          repositoryRoot: root,
        }),
        /MOLIT_TRANSFER_REVALIDATION_(?:CONTENT|OFFICIAL_FILE)/u,
      );
      assert.equal(calls, 0);
      await assert.rejects(stat(output), { code: "ENOENT" });
    }
  } finally {
    await rm(fileDirectory, { recursive: true, force: true });
  }
});

test("content/schema/total pagination drift는 output 없이 fail closed한다", async () => {
  const cases = [
    (rows) => { rows[0].역명 = "변조역"; },
    (rows) => { rows[0].EXTRA = "raw-provider-sentinel"; },
    (_rows, state) => { state.totalCount = 8055; },
    (_rows, state) => { state.pageOverride = 2; },
  ];
  for (const mutate of cases) {
    const directory = await mkdtemp(path.join(os.tmpdir(), "molit-transfer-invalid-"));
    try {
      const output = path.join(directory, "evidence.json");
      const rows = structuredClone(trackedRows);
      const state = {};
      mutate(rows, state);
      await assert.rejects(
        runCurrentMolitTransferSourceRevalidation({
          argv: ["--observed-at", observedAt, "--output", output],
          env: { DATA_GO_KR_SERVICE_KEY: serviceKey },
          fetchImpl: paginatedFetch(rows, [], state),
          repositoryRoot: root,
        }),
        (error) => {
          assert.match(error.message, /^MOLIT_TRANSFER_REVALIDATION_[A-Z_]+$/u);
          assert.doesNotMatch(error.message, /raw-provider-sentinel|변조역|test\+transfer/u);
          return true;
        },
      );
      await assert.rejects(stat(output), { code: "ENOENT" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  const directory = await mkdtemp(path.join(os.tmpdir(), "molit-transfer-metadata-drift-"));
  let calls = 0;
  try {
    const metadataPath = path.join(root, "tools/datapack/sources/molit-railway-transfer-movement-20250811.csv.gz.json");
    const candidatesPath = path.join(root, "tools/datapack/source-candidates.json");
    const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
    metadata.gzipSha256 = "0".repeat(64);
    const metadataBytes = Buffer.from(JSON.stringify(metadata));
    const candidates = JSON.parse(await readFile(candidatesPath, "utf8"));
    const candidate = candidates.candidates.find(({ id }) => id === "molit-railway-transfer-movement");
    candidate.rawSnapshotAdmission.metadataFileSha256 = createHash("sha256").update(metadataBytes).digest("hex");
    const candidatesBytes = Buffer.from(JSON.stringify(candidates));
    const output = path.join(directory, "evidence.json");
    await assert.rejects(
      runCurrentMolitTransferSourceRevalidation({
        argv: ["--observed-at", observedAt, "--output", output],
        env: { DATA_GO_KR_SERVICE_KEY: serviceKey },
        fetchImpl: async () => { calls += 1; throw new Error("must not call"); },
        readFileImpl: async (file) => {
          if (path.resolve(file) === metadataPath) return metadataBytes;
          if (path.resolve(file) === candidatesPath) return candidatesBytes;
          return readFile(file);
        },
        repositoryRoot: root,
      }),
      /MOLIT_TRANSFER_REVALIDATION_SNAPSHOT/u,
    );
    assert.equal(calls, 0);
    await assert.rejects(stat(output), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("credential/HTTP/transport boundary는 retry와 raw reflection 없이 실패한다", async () => {
  let oversizedCancelled = false;
  let chunkIndex = 0;
  const cases = [
    {
      env: { DATA_GO_KR_SERVICE_KEY: "invalid%ZZ" },
      fetchImpl: async () => { throw new Error("must not call"); },
      expectedCalls: 0,
      expectedCode: "MOLIT_TRANSFER_REVALIDATION_CREDENTIAL",
    },
    ...[
      [401, "PROVIDER_HTTP_AUTHORIZATION"],
      [429, "PROVIDER_HTTP_RATE_LIMIT"],
      [503, "PROVIDER_HTTP_SERVER"],
      [418, "PROVIDER_HTTP_OTHER"],
    ].map(([status, code]) => ({
      env: { DATA_GO_KR_SERVICE_KEY: serviceKey },
      fetchImpl: async () => new Response(`provider body ${serviceKey}`, {
        status,
        headers: { "content-type": "text/plain" },
      }),
      expectedCalls: 1,
      expectedCode: `MOLIT_TRANSFER_REVALIDATION_${code}`,
    })),
    {
      env: { DATA_GO_KR_SERVICE_KEY: serviceKey },
      fetchImpl: async () => new Response("not json", {
        status: 200,
        headers: { "content-type": "text/plain" },
      }),
      expectedCalls: 1,
      expectedCode: "MOLIT_TRANSFER_REVALIDATION_PROVIDER_CONTENT_TYPE",
    },
    ...[
      ["ENOTFOUND", "PROVIDER_DNS"],
      ["ERR_TLS_CERT_ALTNAME_INVALID", "PROVIDER_TLS"],
      ["SELF_SIGNED_CERT_IN_CHAIN", "PROVIDER_TLS"],
      ["UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "PROVIDER_TLS"],
    ].map(([causeCode, code]) => ({
      env: { DATA_GO_KR_SERVICE_KEY: serviceKey },
      fetchImpl: async () => { throw Object.assign(new Error(serviceKey), { cause: { code: causeCode } }); },
      expectedCalls: 1,
      expectedCode: `MOLIT_TRANSFER_REVALIDATION_${code}`,
    })),
    {
      env: { DATA_GO_KR_SERVICE_KEY: serviceKey },
      fetchImpl: async () => { throw Object.assign(new Error(serviceKey), { name: "TimeoutError" }); },
      expectedCalls: 1,
      expectedCode: "MOLIT_TRANSFER_REVALIDATION_PROVIDER_TIMEOUT",
    },
    {
      env: { DATA_GO_KR_SERVICE_KEY: serviceKey },
      fetchImpl: async () => { throw new Error(serviceKey); },
      expectedCalls: 1,
      expectedCode: "MOLIT_TRANSFER_REVALIDATION_PROVIDER_NETWORK",
    },
    {
      env: { DATA_GO_KR_SERVICE_KEY: serviceKey },
      fetchImpl: async () => new Response(new ReadableStream({
        pull(controller) { controller.error(new Error(serviceKey)); },
      }), { status: 200, headers: { "content-type": "application/json" } }),
      expectedCalls: 1,
      expectedCode: "MOLIT_TRANSFER_REVALIDATION_PROVIDER_BODY",
    },
    {
      env: { DATA_GO_KR_SERVICE_KEY: serviceKey },
      fetchImpl: async () => new Response(new ReadableStream({
        pull(controller) {
          controller.error(Object.assign(new Error(serviceKey), { name: "TimeoutError" }));
        },
      }), { status: 200, headers: { "content-type": "application/json" } }),
      expectedCalls: 1,
      expectedCode: "MOLIT_TRANSFER_REVALIDATION_PROVIDER_TIMEOUT",
    },
    {
      env: { DATA_GO_KR_SERVICE_KEY: serviceKey },
      fetchImpl: async () => new Response(new ReadableStream({
        pull(controller) {
          if (chunkIndex === 0) controller.enqueue(new Uint8Array(4 * 1024 * 1024));
          else controller.enqueue(new Uint8Array(1));
          chunkIndex += 1;
        },
        cancel() { oversizedCancelled = true; },
      }), { status: 200, headers: { "content-type": "application/json" } }),
      expectedCalls: 1,
      expectedCode: "MOLIT_TRANSFER_REVALIDATION_PROVIDER_BODY_TOO_LARGE",
      assertAfter: () => assert.equal(oversizedCancelled, true),
    },
  ];
  for (const entry of cases) {
    const directory = await mkdtemp(path.join(os.tmpdir(), "molit-transfer-boundary-"));
    let calls = 0;
    try {
      const output = path.join(directory, "evidence.json");
      await assert.rejects(
        runCurrentMolitTransferSourceRevalidation({
          argv: ["--observed-at", observedAt, "--output", output],
          env: entry.env,
          fetchImpl: async (...args) => { calls += 1; return entry.fetchImpl(...args); },
          repositoryRoot: root,
        }),
        (error) => {
          assert.equal(error.message, entry.expectedCode);
          assert.doesNotMatch(error.message, new RegExp(serviceKey.replaceAll("+", "\\+")));
          return true;
        },
      );
      assert.equal(calls, entry.expectedCalls);
      entry.assertAfter?.();
      await assert.rejects(stat(output), { code: "ENOENT" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("existing output와 symlink output은 provider 호출 전 보존한다", async () => {
  for (const kind of ["regular", "symlink"]) {
    const directory = await mkdtemp(path.join(os.tmpdir(), "molit-transfer-output-"));
    let calls = 0;
    try {
      const output = path.join(directory, "evidence.json");
      const sentinel = path.join(directory, "sentinel.json");
      await writeFile(sentinel, "sentinel\n");
      if (kind === "regular") await writeFile(output, "existing\n");
      else await symlink(sentinel, output);
      await assert.rejects(
        runCurrentMolitTransferSourceRevalidation({
          argv: ["--observed-at", observedAt, "--output", output],
          env: { DATA_GO_KR_SERVICE_KEY: serviceKey },
          fetchImpl: async () => { calls += 1; throw new Error("must not call"); },
          repositoryRoot: root,
        }),
        /MOLIT_TRANSFER_REVALIDATION_OUTPUT/u,
      );
      assert.equal(calls, 0);
      assert.equal(await readFile(sentinel, "utf8"), "sentinel\n");
      if (kind === "regular") assert.equal(await readFile(output, "utf8"), "existing\n");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  const directory = await mkdtemp(path.join(os.tmpdir(), "molit-transfer-post-link-"));
  try {
    const output = path.join(directory, "evidence.json");
    const calls = [];
    await assert.rejects(
      runCurrentMolitTransferSourceRevalidation({
        argv: ["--observed-at", observedAt, "--output", output],
        env: { DATA_GO_KR_SERVICE_KEY: serviceKey },
        fetchImpl: paginatedFetch(trackedRows, calls),
        publishFixture: { afterLink: async ({ output: linkedOutput }) => chmod(linkedOutput, 0o400) },
        repositoryRoot: root,
      }),
      /MOLIT_TRANSFER_REVALIDATION_PUBLISH/u,
    );
    assert.equal(calls.length, Math.ceil(trackedRows.length / 1000));
    await assert.rejects(stat(output), { code: "ENOENT" });
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function loadTrackedRows() {
  const [metadata, gzipBytes] = await Promise.all([
    readFile(new URL("./sources/molit-railway-transfer-movement-20250811.csv.gz.json", import.meta.url), "utf8"),
    readFile(new URL("./sources/molit-railway-transfer-movement-20250811.csv.gz", import.meta.url)),
  ]);
  const parsed = JSON.parse(metadata);
  return buildMolitRailwayTransferMovementSnapshot({
    bytes: gunzipSync(gzipBytes),
    capturedAt: parsed.capturedAt,
  }).rows.map((row) => Object.fromEntries(providerColumns.map((providerColumn) => [
    providerColumn,
    providerColumn === "환승이동순서" ? Number(row[columnProjection[providerColumn]]) : row[columnProjection[providerColumn]],
  ])));
}

function paginatedFetch(rows, calls, state = {}) {
  return async (url, options) => {
    const parsed = new URL(url);
    const page = Number(parsed.searchParams.get("page"));
    const perPage = parsed.searchParams.get("perPage");
    const returnType = parsed.searchParams.get("returnType");
    const credential = parsed.searchParams.get("serviceKey");
    calls.push({ page, perPage, returnType, credential, redirect: options.redirect, signal: options.signal });
    const pageNumber = state.pageOverride ?? page;
    const start = (page - 1) * 1000;
    const data = rows.slice(start, start + 1000);
    return new Response(JSON.stringify({
      currentCount: data.length,
      data,
      matchCount: state.totalCount ?? rows.length,
      page: pageNumber,
      perPage: 1000,
      totalCount: state.totalCount ?? rows.length,
    }), { status: 200, headers: { "content-type": "application/json;charset=UTF-8" } });
  };
}
