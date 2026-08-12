import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseTagoTrainDateSemanticsCliArguments, probeTagoTrainDateSemantics } from "./probe-tago-train-date-semantics.mjs";

const SECRET = "never-print-this-service-key";
const TARGET = Object.freeze({
  serviceDate: "20260815",
  depPlaceId: "NAT010000",
  arrPlaceId: "NAT020000",
  trainGradeCode: "KTX",
});

async function temporaryDirectory(prefix) {
  return mkdtemp(path.join(await realpath(os.tmpdir()), prefix));
}

test("TAGO date semantics probe는 malformed credential에서 provider를 호출하지 않는다", async () => {
  const directory = await temporaryDirectory("tago-date-invalid-credential-");
  let calls = 0;
  try {
    await assert.rejects(probeTagoTrainDateSemantics({
      ...TARGET,
      serviceKey: "invalid%ZZ",
      outputPath: path.join(directory, "evidence.json"),
      now: new Date("2026-08-11T00:00:00.000Z"),
      fetchImpl: async () => { calls += 1; },
    }), /DATA_GO_KR_SERVICE_KEY is invalid/);
    assert.equal(calls, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("TAGO date semantics probe는 provider·schema·transport 실패를 sanitized artifact 하나로 닫고 나머지 call을 중단한다", async (context) => {
  const cases = [
    ["HTTP", async () => new Response("sensitive response text", { status: 503 }), "http"],
    ["provider", async () => new Response(JSON.stringify({ response: { header: { resultCode: "30", resultMsg: "sensitive provider message" }, body: {} } }), { headers: { "content-type": "application/json" } }), "provider"],
    ["invalid JSON", async () => new Response("not json 20260815070000", { headers: { "content-type": "application/json" } }), "schema"],
    ["invalid timestamp", async () => responseFor({ timestamps: ["20260230070000"] }), "schema"],
    ["transport", async () => { throw new Error("https://secret.example/?serviceKey=never-print-this-service-key"); }, "transport"],
    ["timeout", async () => { throw new DOMException("request timed out", "TimeoutError"); }, "transport"],
  ];
  for (const [name, fetchImpl, stage] of cases) {
    await context.test(name, async () => {
      const directory = await temporaryDirectory("tago-date-failure-");
      const outputPath = path.join(directory, "evidence.json");
      let calls = 0;
      try {
        await assert.rejects(probeTagoTrainDateSemantics({
          ...TARGET,
          serviceKey: SECRET,
          outputPath,
          now: new Date("2026-08-11T00:00:00.000Z"),
          fetchImpl: async (...arguments_) => {
            calls += 1;
            return fetchImpl(...arguments_);
          },
        }), /TAGO train date semantics probe failed/);
        assert.equal(calls, 1);
        const artifact = JSON.parse(await readFile(outputPath, "utf8"));
        assert.equal(artifact.diagnosticStatus, "FAILED");
        assert.deepEqual(Object.keys(artifact.failure), ["stage", "offset", "httpStatus", "providerResultCode"]);
        assert.equal(artifact.failure.stage, stage);
        assert.equal(artifact.calls.length, 1);
        const serialized = JSON.stringify(artifact);
        for (const forbidden of [SECRET, TARGET.depPlaceId, TARGET.arrPlaceId, TARGET.trainGradeCode, "20260815070000", "sensitive", "secret.example"]) {
          assert.equal(serialized.includes(forbidden), false, `failure artifact must redact ${forbidden}`);
        }
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
});

test("TAGO date semantics probe는 206 response의 malformed timestamp failure에 실제 status와 provider code를 보존한다", async () => {
  const directory = await temporaryDirectory("tago-date-206-");
  const outputPath = path.join(directory, "evidence.json");
  try {
    await assert.rejects(probeTagoTrainDateSemantics({
      ...TARGET,
      serviceKey: SECRET,
      outputPath,
      now: new Date("2026-08-11T00:00:00.000Z"),
      fetchImpl: async () => new Response(JSON.stringify({
        response: {
          header: { resultCode: "00" },
          body: { items: { item: [{ depplandtime: "malformed" }] }, totalCount: 1 },
        },
      }), { status: 206, headers: { "content-type": "application/json" } }),
    }), /TAGO train date semantics probe failed/);
    const artifact = JSON.parse(await readFile(outputPath, "utf8"));
    assert.deepEqual(artifact.failure, { stage: "schema", offset: -1, httpStatus: 206, providerResultCode: "00" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("TAGO date semantics probe는 partial temp write failure에서 owned temp만 정리한다", async () => {
  const directory = await temporaryDirectory("tago-date-partial-write-");
  const outputPath = path.join(directory, "evidence.json");
  try {
    await assert.rejects(probeTagoTrainDateSemantics({
      ...TARGET,
      serviceKey: SECRET,
      outputPath,
      now: new Date("2026-08-11T00:00:00.000Z"),
      fetchImpl: async () => responseFor({ timestamps: ["20260814070000"] }),
      testHooks: {
        writeTemporary: async (handle, bytes) => {
          await handle.write(bytes.subarray(0, 7));
          throw new Error("partial write failure");
        },
      },
    }), /sanitized diagnostic artifact could not be written/);
    await assert.rejects(access(outputPath));
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("TAGO date semantics probe의 target tuple hash와 request는 service date를 제외한 canonical target만 고정한다", async () => {
  const directory = await temporaryDirectory("tago-date-contract-");
  const outputPath = path.join(directory, "evidence.json");
  const calls = [];
  try {
    const artifact = await probeTagoTrainDateSemantics({
      ...TARGET,
      serviceKey: SECRET,
      outputPath,
      now: new Date("2026-08-11T00:00:00.000Z"),
      fetchImpl: async (input) => {
        calls.push(new URL(input));
        return responseFor({ timestamps: ["20260814070000"] });
      },
    });
    assert.equal(artifact.targetTupleSha256, createHash("sha256").update(JSON.stringify([TARGET.depPlaceId, TARGET.arrPlaceId, TARGET.trainGradeCode])).digest("hex"));
    assert.equal(artifact.targetTupleSha256.includes(TARGET.serviceDate), false);
    const nonDateQueries = calls.map((url) => {
      const query = new URLSearchParams(url.search);
      query.delete("depPlandTime");
      return query.toString();
    });
    assert.deepEqual(nonDateQueries, [nonDateQueries[0], nonDateQueries[0], nonDateQueries[0]]);
    assert.equal(calls[0].searchParams.get("pageNo"), "1");
    assert.equal(calls[0].searchParams.get("numOfRows"), "999");
    assert.equal(calls[0].searchParams.get("_type"), "json");
    for (const invalidTarget of [
      { depPlaceId: "BAD010000" }, { arrPlaceId: "NAT010000" }, { trainGradeCode: "ktx" }, { trainGradeCode: "KTX!" },
    ]) {
      await assert.rejects(probeTagoTrainDateSemantics({ ...TARGET, ...invalidTarget, serviceKey: SECRET, outputPath: path.join(directory, `${calls.length}.json`), now: new Date("2026-08-11T00:00:00.000Z") }));
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("TAGO date semantics probe는 call 간 relation category 불일치를 OBSERVED_INCONCLUSIVE로 닫는다", async () => {
  const directory = await temporaryDirectory("tago-date-cross-call-");
  try {
    const artifact = await probeTagoTrainDateSemantics({
      ...TARGET,
      serviceKey: SECRET,
      outputPath: path.join(directory, "evidence.json"),
      now: new Date("2026-08-11T00:00:00.000Z"),
      fetchImpl: async (input) => {
        const date = new URL(input).searchParams.get("depPlandTime");
        return responseFor({ timestamps: [date === "20260815" ? "20260814070000" : `${date}070000`] });
      },
    });
    assert.equal(artifact.diagnosticStatus, "OBSERVED_INCONCLUSIVE");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("TAGO date semantics probe는 publish 경쟁과 parent drift에서 output overwrite·temp residue 없이 중단한다", async (context) => {
  await context.test("temp write 직전 parent replacement", async () => {
    const container = await temporaryDirectory("tago-date-prewrite-drift-");
    const directory = path.join(container, "parent");
    const previousDirectory = path.join(container, "previous-parent");
    const outputPath = path.join(directory, "evidence.json");
    await mkdir(directory);
    try {
      await assert.rejects(probeTagoTrainDateSemantics({
        ...TARGET, serviceKey: SECRET, outputPath, now: new Date("2026-08-11T00:00:00.000Z"),
        fetchImpl: async () => responseFor({ timestamps: ["20260814070000"] }),
        testHooks: { beforeTempWrite: async () => { await rename(directory, previousDirectory); await mkdir(directory); } },
      }), /sanitized diagnostic artifact could not be written/);
      assert.deepEqual(await readdir(directory), []);
      assert.deepEqual(await readdir(previousDirectory), []);
    } finally {
      await rm(container, { recursive: true, force: true });
    }
  });
  await context.test("concurrent output", async () => {
    const directory = await temporaryDirectory("tago-date-concurrent-");
    const outputPath = path.join(directory, "evidence.json");
    try {
      await assert.rejects(probeTagoTrainDateSemantics({
        ...TARGET, serviceKey: SECRET, outputPath, now: new Date("2026-08-11T00:00:00.000Z"),
        fetchImpl: async () => responseFor({ timestamps: ["20260814070000"] }),
        testHooks: { beforeLink: async () => writeFile(outputPath, "concurrent-owner") },
      }), /sanitized diagnostic artifact could not be written/);
      assert.equal(await readFile(outputPath, "utf8"), "concurrent-owner");
      assert.deepEqual(await readdir(directory), ["evidence.json"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  await context.test("temp rename 뒤 symlink substitution", async () => {
    const directory = await temporaryDirectory("tago-date-temp-substitution-");
    const outputPath = path.join(directory, "evidence.json");
    const replacementPath = path.join(directory, "replacement.tmp");
    const externalPath = path.join(directory, "external.txt");
    let temporaryPath;
    await writeFile(externalPath, "external-owner");
    const externalMode = (await stat(externalPath)).mode & 0o777;
    try {
      await assert.rejects(probeTagoTrainDateSemantics({
        ...TARGET, serviceKey: SECRET, outputPath, now: new Date("2026-08-11T00:00:00.000Z"),
        fetchImpl: async () => responseFor({ timestamps: ["20260814070000"] }),
        testHooks: {
          beforeLink: async ({ temporaryPath: path_ }) => {
            temporaryPath = path_;
            await rename(temporaryPath, replacementPath);
            await symlink(externalPath, temporaryPath);
          },
        },
      }), /sanitized diagnostic artifact could not be written/);
      assert.equal(await readFile(externalPath, "utf8"), "external-owner");
      assert.equal((await stat(externalPath)).mode & 0o777, externalMode);
      assert.equal((await lstat(temporaryPath)).isSymbolicLink(), true);
      assert.equal((await lstat(replacementPath)).isFile(), true);
      await assert.rejects(access(outputPath));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  await context.test("parent drift", async () => {
    const directory = await temporaryDirectory("tago-date-drift-");
    const outputPath = path.join(directory, "evidence.json");
    try {
      await assert.rejects(probeTagoTrainDateSemantics({
        ...TARGET, serviceKey: SECRET, outputPath, now: new Date("2026-08-11T00:00:00.000Z"),
        fetchImpl: async () => responseFor({ timestamps: ["20260814070000"] }),
        testHooks: { beforePublish: async () => chmod(directory, 0o755) },
      }), /sanitized diagnostic artifact could not be written/);
      const entries = await readdir(directory);
      assert.equal(entries.length, 1);
      assert.match(entries[0], /^\.evidence\.json\.[0-9a-f-]+\.tmp$/u);
      await assert.rejects(access(outputPath));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

test("TAGO date semantics CLI parser는 다섯 flag만 order-independent로 해석하고 값을 오류에 노출하지 않는다", () => {
  const parsed = parseTagoTrainDateSemanticsCliArguments(["--output", "/tmp/absent.json", "--train-grade-code", "KTX", "--arr-place-id", "NAT020000", "--service-date", "20260815", "--dep-place-id", "NAT010000"]);
  assert.deepEqual(parsed, { serviceDate: "20260815", depPlaceId: "NAT010000", arrPlaceId: "NAT020000", trainGradeCode: "KTX", outputPath: "/tmp/absent.json" });
  for (const argv of [
    ["--output", "/tmp/secret-output", "--output", "/tmp/duplicate", "--train-grade-code", "KTX", "--arr-place-id", "NAT020000", "--service-date", "20260815", "--dep-place-id", "NAT010000"],
    ["--unknown", "sensitive-value", "--train-grade-code", "KTX", "--arr-place-id", "NAT020000", "--service-date", "20260815", "--dep-place-id", "NAT010000"],
    ["--output", "/tmp/secret-output", "--train-grade-code", "KTX", "--arr-place-id", "NAT020000", "--service-date", "20260815"],
  ]) {
    assert.throws(() => parseTagoTrainDateSemanticsCliArguments(argv), (error) => error.message === "invalid arguments" && !error.message.includes("sensitive-value"));
  }
});

test("TAGO date semantics probe는 invalid input과 unsafe output을 provider 호출·output mutation 없이 거부한다", async () => {
  const directory = await temporaryDirectory("tago-date-output-");
  const existing = path.join(directory, "existing.json");
  const linkedParent = path.join(directory, "linked");
  await writeFile(existing, "preserve");
  await symlink(directory, linkedParent);
  let calls = 0;
  const base = { ...TARGET, serviceKey: SECRET, now: new Date("2026-08-11T00:00:00.000Z"), fetchImpl: async () => { calls += 1; } };
  try {
    for (const options of [
      { ...base, serviceDate: "20260230", outputPath: path.join(directory, "invalid-date.json") },
      { ...base, outputPath: "relative.json" },
      { ...base, outputPath: existing },
      { ...base, outputPath: path.join(linkedParent, "output.json") },
    ]) {
      await assert.rejects(probeTagoTrainDateSemantics(options));
    }
    assert.equal(calls, 0);
    assert.equal(await readFile(existing, "utf8"), "preserve");
    await assert.rejects(access(path.join(directory, "invalid-date.json")));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("TAGO date semantics probe는 zero-row·mixed relation을 OBSERVED_INCONCLUSIVE로 기록하고 schema boundary를 닫는다", async (context) => {
  for (const [name, responseFactory, expected] of [
    ["zero rows", () => tagoResponse({ totalCount: 0 }), "OBSERVED_INCONCLUSIVE"],
    ["zero rows without items", () => new Response(JSON.stringify({ response: { header: { resultCode: "00" }, body: { totalCount: 0 } } }), { headers: { "content-type": "application/json" } }), "OBSERVED_INCONCLUSIVE"],
    ["zero rows with null items", () => new Response(JSON.stringify({ response: { header: { resultCode: "00" }, body: { items: null, totalCount: 0 } } }), { headers: { "content-type": "application/json" } }), "OBSERVED_INCONCLUSIVE"],
    ["mixed relation", () => responseFor({ timestamps: ["20260814070000", "20260815070000"] }), "OBSERVED_INCONCLUSIVE"],
    ["content type", () => new Response("provider body", { headers: { "content-type": "text/plain" } }), "FAILED"],
    ["body", () => new Response(JSON.stringify({ response: { header: { resultCode: "00" }, body: null } }), { headers: { "content-type": "application/json" } }), "FAILED"],
    ["item", () => new Response(JSON.stringify({ response: { header: { resultCode: "00" }, body: { items: { item: "invalid" }, totalCount: 1 } } }), { headers: { "content-type": "application/json" } }), "FAILED"],
    ["totalCount", () => new Response(JSON.stringify({ response: { header: { resultCode: "00" }, body: { items: { item: [{ depplandtime: "20260814070000" }] }, totalCount: 2 } } }), { headers: { "content-type": "application/json" } }), "FAILED"],
    ["missing totalCount", () => new Response(JSON.stringify({ response: { header: { resultCode: "00" }, body: { items: { item: [] } } } }), { headers: { "content-type": "application/json" } }), "FAILED"],
    ["string totalCount", () => tagoResponse({ items: null, totalCount: "0" }), "FAILED"],
    ["whitespace totalCount", () => tagoResponse({ items: null, totalCount: " " }), "FAILED"],
    ["boolean totalCount", () => tagoResponse({ items: null, totalCount: false }), "FAILED"],
    ["array totalCount", () => tagoResponse({ items: null, totalCount: [] }), "FAILED"],
    ["null totalCount", () => tagoResponse({ items: null, totalCount: null }), "FAILED"],
    ["zero empty items wrapper", () => tagoResponse({ items: {}, totalCount: 0 }), "FAILED"],
    ["zero null item wrapper", () => tagoResponse({ items: { item: null }, totalCount: 0 }), "FAILED"],
    ["zero empty item wrapper", () => tagoResponse({ items: { item: [] }, totalCount: 0 }), "FAILED"],
    ["positive empty items wrapper", () => tagoResponse({ items: {}, totalCount: 1 }), "FAILED"],
    ["positive null item wrapper", () => tagoResponse({ items: { item: null }, totalCount: 1 }), "FAILED"],
  ]) {
    await context.test(name, async () => {
      const directory = await temporaryDirectory("tago-date-schema-");
      const outputPath = path.join(directory, "evidence.json");
      try {
        if (expected === "FAILED") {
          await assert.rejects(probeTagoTrainDateSemantics({ ...TARGET, serviceKey: SECRET, outputPath, now: new Date("2026-08-11T00:00:00.000Z"), fetchImpl: responseFactory }));
        } else {
          const artifact = await probeTagoTrainDateSemantics({ ...TARGET, serviceKey: SECRET, outputPath, now: new Date("2026-08-11T00:00:00.000Z"), fetchImpl: responseFactory });
          assert.equal(artifact.diagnosticStatus, expected);
        }
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
});

function responseFor({ date, timestamps }) {
  return new Response(JSON.stringify({
    response: {
      header: { resultCode: "00", resultMsg: "sensitive provider message" },
      body: {
        items: { item: timestamps.map((depplandtime) => ({ depplandtime, rawTarget: "must-not-leak" })) },
        totalCount: timestamps.length,
      },
    },
  }), { headers: { "content-type": "application/json; charset=utf-8" } });
}

function tagoResponse({ items, totalCount }) {
  return new Response(JSON.stringify({
    response: { header: { resultCode: "00" }, body: { items, totalCount } },
  }), { headers: { "content-type": "application/json" } });
}

test("TAGO date semantics probe는 동일 target을 D-1/D/D+1 세 번만 조회하고 sanitized artifact를 만든다", async () => {
  const directory = await temporaryDirectory("tago-date-probe-");
  const outputPath = path.join(directory, "evidence.json");
  const calls = [];
  try {
    const evidence = await probeTagoTrainDateSemantics({
      ...TARGET,
      serviceKey: SECRET,
      outputPath,
      now: new Date("2026-08-11T00:00:00.000Z"),
      fetchImpl: async (input, init) => {
        const url = new URL(input);
        calls.push({ url, init });
        const date = url.searchParams.get("depPlandTime");
        return responseFor({
          date,
          timestamps: date === "20260814"
            ? ["20260814020000", "20260814120000"]
            : date === "20260815" ? ["20260815070000"] : ["20260816080000"],
        });
      },
    });

    assert.equal(calls.length, 3);
    assert.deepEqual(calls.map(({ url }) => url.searchParams.get("depPlandTime")), ["20260814", "20260815", "20260816"]);
    for (const { url, init } of calls) {
      assert.equal(url.searchParams.get("depPlaceId"), TARGET.depPlaceId);
      assert.equal(url.searchParams.get("arrPlaceId"), TARGET.arrPlaceId);
      assert.equal(url.searchParams.get("trainGradeCode"), TARGET.trainGradeCode);
      assert.equal(url.searchParams.get("serviceKey"), SECRET);
      assert.equal(init.redirect, "error");
      assert.ok(init.signal instanceof AbortSignal);
    }
    assert.deepEqual(Object.keys(evidence), ["schemaVersion", "artifactKind", "contractVersion", "targetTupleSha256", "serviceDate", "comparisonOffsets", "operation", "calls", "diagnosticStatus", "failure", "credentialRedacted"]);
    assert.deepEqual(evidence.comparisonOffsets, [-1, 0, 1]);
    assert.equal(evidence.diagnosticStatus, "OBSERVED");
    assert.equal(evidence.failure, null);
    assert.deepEqual(evidence.calls.map((call) => Object.keys(call)), Array.from({ length: 3 }, () => ["offset", "httpStatus", "providerResultCode", "schemaStatus", "rowCount", "totalCount", "departureCalendarRelationCounts"]));
    assert.deepEqual(evidence.calls.map(({ offset, rowCount, totalCount, departureCalendarRelationCounts }) => ({ offset, rowCount, totalCount, departureCalendarRelationCounts })), [
      { offset: -1, rowCount: 2, totalCount: 2, departureCalendarRelationCounts: { previousCalendarDay: 0, sameCalendarDay: 2, nextCalendarDay: 0, otherCalendarDay: 0 } },
      { offset: 0, rowCount: 1, totalCount: 1, departureCalendarRelationCounts: { previousCalendarDay: 0, sameCalendarDay: 1, nextCalendarDay: 0, otherCalendarDay: 0 } },
      { offset: 1, rowCount: 1, totalCount: 1, departureCalendarRelationCounts: { previousCalendarDay: 0, sameCalendarDay: 1, nextCalendarDay: 0, otherCalendarDay: 0 } },
    ]);
    const serialized = JSON.stringify(evidence);
    for (const forbidden of [SECRET, TARGET.depPlaceId, TARGET.arrPlaceId, TARGET.trainGradeCode, "20260814020000", "sensitive provider message", "must-not-leak", "apis.data.go.kr"]) {
      assert.equal(serialized.includes(forbidden), false, `artifact must redact ${forbidden}`);
    }
    assert.deepEqual(JSON.parse(await readFile(outputPath, "utf8")), evidence);
    assert.equal((await stat(outputPath)).mode & 0o777, 0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
