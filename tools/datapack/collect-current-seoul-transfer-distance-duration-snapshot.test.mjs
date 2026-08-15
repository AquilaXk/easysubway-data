import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { collectCurrentSeoulTransferDistanceDurationSnapshot } from "./collect-current-seoul-transfer-distance-duration-snapshot.mjs";

const SERVICE_KEY = "test/key+with-symbol";
const CAPTURED_AT = new Date("2026-08-15T00:00:00.000Z");

test("145-row ODCloud 페이지를 완전 수집해 credential-free immutable snapshot directory로 원자 기록한다", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "seoul-transfer-snapshot-"));
  try {
    const output = path.join(root, "snapshot");
    const calls = [];
    const receipt = await collectCurrentSeoulTransferDistanceDurationSnapshot({
      output,
      runnerTemp: root,
      serviceKey: SERVICE_KEY,
      now: CAPTURED_AT,
      fetchImpl: async (url, options) => {
        calls.push(url);
        assert.equal(options.redirect, "error");
        assert.equal(url.searchParams.get("serviceKey"), SERVICE_KEY);
        return jsonResponse(pagePayload(Number(url.searchParams.get("page")), 100));
      },
    });
    assert.deepEqual(calls.map((url) => [url.searchParams.get("page"), url.searchParams.get("perPage"), url.searchParams.get("returnType")]), [["1", "100", "JSON"], ["2", "100", "JSON"]]);
    assert.deepEqual(await readdir(output), ["manifest.json", "observation.json", "raw-snapshot.json"]);
    const manifest = JSON.parse(await readFile(path.join(output, "manifest.json"), "utf8"));
    const raw = JSON.parse(await readFile(path.join(output, "raw-snapshot.json"), "utf8"));
    const observation = JSON.parse(await readFile(path.join(output, "observation.json"), "utf8"));
    assert.equal(receipt.rowCount, 145);
    assert.equal(manifest.rowCount, 145);
    assert.equal(manifest.credentialRedacted, true);
    assert.equal(raw.pages.length, 2);
    const firstPageBytes = Buffer.from(JSON.stringify(pagePayload(1, 100)));
    assert.equal(raw.pages[0].sha256, createHash("sha256").update(firstPageBytes).digest("hex"));
    assert.equal(raw.pages[0].base64, firstPageBytes.toString("base64"));
    assert.equal(observation.rows.length, 145);
    assert.equal(typeof observation.rows[0]["연번"], "number");
    assert.equal(typeof observation.rows[0]["호선"], "number");
    assert.equal(typeof observation.rows[0]["환승거리"], "number");
    assert.equal(observation.capturedAt, CAPTURED_AT.toISOString());
    assert.match(manifest.endpointSha256, /^[0-9a-f]{64}$/);
    assert.match(manifest.rawSha256, /^[0-9a-f]{64}$/);
    assert.match(manifest.contentSha256, /^[0-9a-f]{64}$/);
    assert.match(manifest.schemaSha256, /^[0-9a-f]{64}$/);
    assert.equal(manifest.endpointSha256, sha256("https://api.odcloud.kr/api/15044419/v1/uddi:7008c675-928f-41d6-9a01-b3541f78466b"));
    assert.equal(manifest.rawSha256, sha256(await readFile(path.join(output, "raw-snapshot.json"))));
    assert.equal(manifest.contentSha256, sha256(canonicalBytes(observation.rows)));
    assert.equal(manifest.schemaSha256, sha256(canonicalBytes({ fields: ["연번", "호선", "환승역명", "환승노선", "환승거리", "환승소요시간"] })));
    for (const name of await readdir(output)) assert.equal((await stat(path.join(output, name))).mode & 0o777, 0o600);
    assert.doesNotMatch(await readFile(path.join(output, "manifest.json"), "utf8"), /serviceKey|test%2Fkey|test\/key/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("partial/duplicate/page-total drift, provider failure, malformed schema, timeout 및 output collision은 output 없이 fail closed한다", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "seoul-transfer-snapshot-failure-"));
  try {
    const cases = [
      () => pagePayload(1, 99),
      () => ({ ...pagePayload(1, 100), data: [...rows(1, 100), rows(1, 1)[0]] }),
      () => ({ ...pagePayload(1, 100), totalCount: 144 }),
      () => ({ ...pagePayload(1, 100), matchCount: 144 }),
      () => ({ ...pagePayload(1, 100), data: [{ ...rows(1, 1)[0], "환승거리": "" }] }),
      () => ({ ...pagePayload(1, 100), data: undefined }),
      () => ({ currentCount: 0, data: [], matchCount: 0, page: 1, perPage: 100, totalCount: 0 }),
    ];
    for (const [index, response] of cases.entries()) {
      const output = path.join(root, `failure-${index}`);
      await assert.rejects(() => collectCurrentSeoulTransferDistanceDurationSnapshot({ output, runnerTemp: root, serviceKey: SERVICE_KEY, now: CAPTURED_AT, fetchImpl: async () => jsonResponse(response()) }));
      await assert.rejects(() => readFile(path.join(output, "manifest.json")), { code: "ENOENT" });
    }
    const timeoutOutput = path.join(root, "timeout");
    await assert.rejects(() => collectCurrentSeoulTransferDistanceDurationSnapshot({ output: timeoutOutput, runnerTemp: root, serviceKey: SERVICE_KEY, now: CAPTURED_AT, fetchImpl: async () => { throw new Error(`timeout ${SERVICE_KEY}`); } }), /request failed: timeout \[REDACTED\]/);
    await assert.rejects(() => readFile(path.join(timeoutOutput, "manifest.json")), { code: "ENOENT" });
    const collision = path.join(root, "collision");
    await writeFile(collision, "preserve");
    await assert.rejects(() => collectCurrentSeoulTransferDistanceDurationSnapshot({ output: collision, runnerTemp: root, serviceKey: SERVICE_KEY, fetchImpl: async () => { throw new Error("must not call"); } }), /output directory must be absent/);
    const duplicateOutput = path.join(root, "cross-page-duplicate");
    await assert.rejects(() => collectCurrentSeoulTransferDistanceDurationSnapshot({
      output: duplicateOutput,
      runnerTemp: root,
      serviceKey: SERVICE_KEY,
      now: CAPTURED_AT,
      fetchImpl: async (url) => {
        const page = Number(url.searchParams.get("page"));
        const payload = pagePayload(page, 100);
        if (page === 2) payload.data[0] = rows(1, 1)[0];
        return jsonResponse(payload);
      },
    }), /serial set mismatch/);
    await assert.rejects(() => readFile(path.join(duplicateOutput, "manifest.json")), { code: "ENOENT" });
    const reflectionOutput = path.join(root, "credential-reflection");
    await assert.rejects(() => collectCurrentSeoulTransferDistanceDurationSnapshot({
      output: reflectionOutput,
      runnerTemp: root,
      serviceKey: SERVICE_KEY,
      now: CAPTURED_AT,
      fetchImpl: async () => jsonResponse({ ...pagePayload(1, 100), data: rows(1, 100).map((row, index) => index === 0 ? { ...row, "환승역명": SERVICE_KEY } : row) }),
    }), /credential reflection/);
    await assert.rejects(() => readFile(path.join(reflectionOutput, "raw-snapshot.json")), { code: "ENOENT" });
    const formReflectionOutput = path.join(root, "form-credential-reflection");
    const formCredential = "test~key";
    await assert.rejects(() => collectCurrentSeoulTransferDistanceDurationSnapshot({
      output: formReflectionOutput,
      runnerTemp: root,
      serviceKey: formCredential,
      now: CAPTURED_AT,
      fetchImpl: async () => jsonResponse({ ...pagePayload(1, 100), data: rows(1, 100).map((row, index) => index === 0 ? { ...row, "환승역명": "test%7Ekey" } : row) }),
    }), /credential reflection/);
    for (const duration of ["62", "09:99", "99:00"]) {
      const durationOutput = path.join(root, `duration-${duration.replaceAll(":", "-")}`);
      await assert.rejects(() => collectCurrentSeoulTransferDistanceDurationSnapshot({
        output: durationOutput,
        runnerTemp: root,
        serviceKey: SERVICE_KEY,
        now: CAPTURED_AT,
        fetchImpl: async (url) => jsonResponse(Number(url.searchParams.get("page")) === 1
          ? { ...pagePayload(1, 100), data: rows(1, 100).map((row, index) => index === 0 ? { ...row, "환승소요시간": duration } : row) }
          : pagePayload(2, 100)),
      }), /required field type mismatch/);
    }
    const serialOutput = path.join(root, "serial-146");
    await assert.rejects(() => collectCurrentSeoulTransferDistanceDurationSnapshot({
      output: serialOutput,
      runnerTemp: root,
      serviceKey: SERVICE_KEY,
      now: CAPTURED_AT,
      fetchImpl: async (url) => {
        const page = Number(url.searchParams.get("page"));
        const payload = pagePayload(page, 100);
        if (page === 2) payload.data[payload.data.length - 1] = { ...payload.data[payload.data.length - 1], "연번": 146 };
        return jsonResponse(payload);
      },
    }), /serial set mismatch/);
    const bodyTimeoutOutput = path.join(root, "body-timeout");
    let aborted = false;
    await assert.rejects(() => collectCurrentSeoulTransferDistanceDurationSnapshot({
      output: bodyTimeoutOutput,
      runnerTemp: root,
      serviceKey: SERVICE_KEY,
      requestTimeoutMs: 0,
      fetchImpl: async (_url, { signal }) => ({
        ok: true,
        arrayBuffer: () => new Promise((_resolve, reject) => signal.addEventListener("abort", () => { aborted = true; reject(new Error("body aborted")); }, { once: true })),
      }),
    }), /request failed: body aborted/);
    assert.equal(aborted, true);
    await assert.rejects(() => readFile(path.join(bodyTimeoutOutput, "manifest.json")), { code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

function rows(page, perPage) {
  const start = (page - 1) * perPage + 1;
  return Array.from({ length: Math.max(0, Math.min(perPage, 146 - start)) }, (_, index) => {
    const number = start + index;
    return { "연번": number, "호선": (number % 9) + 1, "환승역명": `역${number}`, "환승노선": `${((number + 1) % 9) + 1}호선`, "환승거리": number * 10, "환승소요시간": `${String(number % 60).padStart(2, "0")}:${String((number * 5) % 60).padStart(2, "0")}` };
  });
}
function pagePayload(page, perPage) { const data = rows(page, perPage); return { currentCount: data.length, data, matchCount: 145, page, perPage, totalCount: 145 }; }
function jsonResponse(value) { return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } }); }
function canonicalBytes(value) { return Buffer.from(`${JSON.stringify(value)}\n`, "utf8"); }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
