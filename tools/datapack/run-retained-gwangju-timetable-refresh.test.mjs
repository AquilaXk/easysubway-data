import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { runRetainedGwangjuTimetableRefresh } from "./run-retained-gwangju-timetable-refresh.mjs";

const due = Object.freeze({ state: "DUE", sourceId: "kric-nationwide-timetable-file", snapshotId: "old", observedAt: "2040-12-01T00:00:00.000Z", freshnessExpiresAt: "2040-12-31T00:00:00.000Z" });
const current = Object.freeze({ ...due, state: "CURRENT" });
const preflight = Object.freeze({
  candidate: { id: "kric-nationwide-timetable-file" }, routePolicy: { routeNumber: "S2901" },
  governanceEntry: { sourceId: "kric-nationwide-timetable-file" }, providerValidUntil: null,
});
const env = Object.freeze({ DATA_GO_KR_SERVICE_KEY: "test-key", EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL: "https://objectstorage.ap-seoul-1.oraclecloud.com/p/test/n/axvym6vk8g7i/b/easysubway-datapacks/o" });

test("CURRENT refresh returns its decision before operation or provider effects", async () => {
  let effects = 0;
  const result = await runRetainedGwangjuTimetableRefresh({
    repositoryRoot: "/tmp/repository", operationRoot: "/tmp/not-created", env: {},
    boundaries: {
      readDecision: async () => current,
      mkdir: async () => { effects += 1; },
      collectKric: async () => { effects += 1; },
    },
  });
  assert.deepEqual(result, current);
  assert.equal(effects, 0);
});

test("DUE refresh rejects invalid preflight configuration before collection", async () => {
  let collected = 0;
  await assert.rejects(runRetainedGwangjuTimetableRefresh({
    repositoryRoot: "/tmp/repository", operationRoot: "/tmp/invalid-refresh", env: {},
    boundaries: { readDecision: async () => due, preflightDue: async () => preflight,
      collectKric: async () => { collected += 1; } },
  }), /DATA_GO_KR_SERVICE_KEY/);
  assert.equal(collected, 0);
});

test("DUE refresh rejects malformed credential before provider and filesystem effects", async () => {
  let calls = 0;
  const unexpectedEffect = async () => { calls += 1; throw new Error("unexpected effect"); };
  await assert.rejects(runRetainedGwangjuTimetableRefresh({
    repositoryRoot: "/tmp/repository", operationRoot: "/tmp/invalid-refresh",
    env: { ...env, DATA_GO_KR_SERVICE_KEY: "invalid%ZZ" },
    boundaries: {
      readDecision: async () => due, preflightDue: async () => preflight,
      mkdir: unexpectedEffect, collectKric: unexpectedEffect,
      collectKasi: unexpectedEffect, publish: unexpectedEffect, register: unexpectedEffect,
    },
  }), /DATA_GO_KR_SERVICE_KEY/);
  assert.equal(calls, 0);
});

test("DUE refresh orders retained artifacts and stops before registration after a later failure", async context => {
  const root = await mkdtemp(path.join(tmpdir(), "retained-refresh-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const operationRoot = path.join(root, "operation");
  const events = [];
  const boundary = {
    readDecision: async () => due,
    preflightDue: async () => preflight,
    collectKric: async ({ outputFile }) => {
      events.push("collect");
      await writeFile(outputFile, "raw");
      return { capturedAt: "2040-12-31T00:00:00.000Z", rawFile: path.basename(outputFile), byteLength: 3, sha256: "a".repeat(64) };
    },
    buildObservation: async () => { events.push("observation"); return { observedAt: "2040-12-31T00:00:00.000Z" }; },
    preparePublication: () => { events.push("publication-plan"); return { freshnessExpiresAt: "2041-01-08T00:00:00.000Z" }; },
    collectKasi: async ({ outputDirectory, startDate, endDate }) => {
      events.push(`kasi:${startDate}:${endDate}`);
    },
    prepareContract: async ({ inputPath, outputPath }) => {
      events.push("contract");
      const input = JSON.parse(await readFile(inputPath));
      assert.equal(input.providerValidUntil, null);
      await writeFile(outputPath, "{}\n");
    },
    publish: async () => { events.push("publish"); return { snapshotId: "new" }; },
    register: async ({ sourceInputPath }) => {
      events.push("register");
      const input = JSON.parse(await readFile(sourceInputPath));
      assert.deepEqual(Object.keys(input).sort(), ["artifactKind", "collectionReceiptPath", "governanceEntry", "observationPath", "providerValidUntil", "publicationReceiptPath", "retainedContractPath", "schemaVersion"]);
    },
  };
  const result = await runRetainedGwangjuTimetableRefresh({ repositoryRoot: root, operationRoot, env, clock: () => new Date("2041-01-01T00:00:00.000Z"), boundaries: boundary });
  assert.equal(result.state, "REGISTERED");
  assert.deepEqual(events, ["collect", "observation", "publication-plan", "kasi:20401231:20410108", "contract", "publish", "register"]);

  const failedEvents = [];
  await assert.rejects(runRetainedGwangjuTimetableRefresh({
    repositoryRoot: root, operationRoot: path.join(root, "failed-operation"), env, clock: () => new Date("2041-01-01T00:00:00.000Z"),
    boundaries: { ...boundary, collectKric: async ({ outputFile }) => {
      failedEvents.push("collect"); await writeFile(outputFile, "raw"); return { capturedAt: "2040-12-31T00:00:00.000Z", rawFile: path.basename(outputFile), byteLength: 3, sha256: "a".repeat(64) };
    }, buildObservation: async () => ({ observedAt: "2040-12-31T00:00:00.000Z" }), preparePublication: () => ({ freshnessExpiresAt: "2041-01-08T00:00:00.000Z" }), collectKasi: async () => { failedEvents.push("kasi"); throw new Error("holiday failure"); }, register: async () => { failedEvents.push("register"); } },
  }), /holiday failure/);
  assert.deepEqual(failedEvents, ["collect", "kasi"]);
});

// #913: 계약 개정(예: 운행일 달력 규칙 정정)은 정해진 갱신 시점이 아니어도 보관본을 다시 등록해야 한다.
// 계약이 실제로 바뀐 경우에만 게시·등록하고, 같은 계약이면 게시 전에 멈춘다.
test("계약 개정 trigger는 CURRENT여도 수집하고, 새 계약이 등록된 계약과 다를 때만 게시·등록한다", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "retained-revision-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const run = async (operation, contractJson, events) => runRetainedGwangjuTimetableRefresh({
    repositoryRoot: root, operationRoot: path.join(root, operation), env, trigger: "CONTRACT_REVISION",
    clock: () => new Date("2041-01-01T00:00:00.000Z"),
    boundaries: {
      readDecision: async () => current,
      readAdmittedContractSha256: async () => "c4c9a5bf3ff0b9f2dbc5d0f0e4fbd9c6de1fe2b1c5f0e1ed58b4d0ad8b7e2fe4",
      preflightDue: async () => preflight,
      collectKric: async ({ outputFile }) => { events.push("collect"); await writeFile(outputFile, "raw");
        return { capturedAt: "2040-12-31T00:00:00.000Z", rawFile: path.basename(outputFile), byteLength: 3, sha256: "a".repeat(64) }; },
      buildObservation: async () => ({ observedAt: "2040-12-31T00:00:00.000Z" }),
      preparePublication: () => ({ freshnessExpiresAt: "2041-01-08T00:00:00.000Z" }),
      collectKasi: async () => {},
      prepareContract: async ({ outputPath }) => { events.push("contract"); await writeFile(outputPath, contractJson); },
      publish: async () => { events.push("publish"); },
      register: async () => { events.push("register"); },
    },
  });
  const changed = [];
  assert.equal((await run("changed", "{\"calendar\":{\"festivalDates\":[]}}\n", changed)).state, "REGISTERED");
  assert.deepEqual(changed, ["collect", "contract", "publish", "register"]);
  const same = [];
  // 등록된 계약 sha와 같은 계약: canonicalJson({}) 의 sha를 등록 값으로 둔다.
  const { createHash } = await import("node:crypto");
  const sameSha = createHash("sha256").update("{}").digest("hex");
  await assert.rejects(runRetainedGwangjuTimetableRefresh({
    repositoryRoot: root, operationRoot: path.join(root, "same"), env, trigger: "CONTRACT_REVISION",
    clock: () => new Date("2041-01-01T00:00:00.000Z"),
    boundaries: {
      readDecision: async () => current, readAdmittedContractSha256: async () => sameSha, preflightDue: async () => preflight,
      collectKric: async ({ outputFile }) => { same.push("collect"); await writeFile(outputFile, "raw");
        return { capturedAt: "2040-12-31T00:00:00.000Z", rawFile: path.basename(outputFile), byteLength: 3, sha256: "a".repeat(64) }; },
      buildObservation: async () => ({ observedAt: "2040-12-31T00:00:00.000Z" }),
      preparePublication: () => ({ freshnessExpiresAt: "2041-01-08T00:00:00.000Z" }),
      collectKasi: async () => {},
      prepareContract: async ({ outputPath }) => { same.push("contract"); await writeFile(outputPath, "{}\n"); },
      publish: async () => { same.push("publish"); }, register: async () => { same.push("register"); },
    },
  }), /contract revision trigger requires a changed retained contract/);
  assert.deepEqual(same, ["collect", "contract"]);
  await assert.rejects(runRetainedGwangjuTimetableRefresh({ repositoryRoot: root, operationRoot: path.join(root, "bad"), env, trigger: "SOMETIME",
    boundaries: { readDecision: async () => current } }), /trigger is invalid/);
});

// #995 F1: 수집과 게시를 workflow step으로 나누려면 controller가 두 단계로 실행돼야 한다. 게시 step이 시작됐는지가 claim 정리 판정의 근거다.
test("collect 단계는 게시·등록 없이 수집·계약 준비까지만 하고, publish 단계가 같은 operation root에서 게시·등록한다", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "retained-phases-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const operationRoot = path.join(root, "operation");
  const events = [];
  const boundaries = {
    readDecision: async () => due, preflightDue: async () => preflight,
    collectKric: async ({ outputFile }) => {
      events.push("collect"); await writeFile(outputFile, "raw");
      return { capturedAt: "2040-12-31T00:00:00.000Z", rawFile: path.basename(outputFile), byteLength: 3, sha256: "a".repeat(64) };
    },
    buildObservation: async () => { events.push("observation"); return { observedAt: "2040-12-31T00:00:00.000Z" }; },
    preparePublication: () => { events.push("publication-plan"); return { freshnessExpiresAt: "2041-01-08T00:00:00.000Z" }; },
    collectKasi: async () => { events.push("kasi"); },
    prepareContract: async ({ outputPath }) => { events.push("contract"); await writeFile(outputPath, "{}\n"); },
    publish: async ({ receipt }) => { events.push(`publish:${receipt.sha256}`); },
    register: async () => { events.push("register"); },
  };
  const clock = () => new Date("2041-01-01T00:00:00.000Z");
  const collected = await runRetainedGwangjuTimetableRefresh({ repositoryRoot: root, operationRoot, env, clock, boundaries, phase: "collect" });
  assert.equal(collected.state, "COLLECTED");
  assert.deepEqual(events, ["collect", "observation", "publication-plan", "kasi", "contract"]);
  events.length = 0;
  const published = await runRetainedGwangjuTimetableRefresh({ repositoryRoot: root, operationRoot, env, clock, boundaries, phase: "publish" });
  assert.equal(published.state, "REGISTERED");
  assert.equal(published.freshnessExpiresAt, "2041-01-08T00:00:00.000Z");
  assert.deepEqual(events, ["publication-plan", `publish:${"a".repeat(64)}`, "register"], "publish 단계는 수집을 다시 하지 않는다");
});

test("publish 단계는 collect 단계의 산출물이 없으면 게시하지 않고 실패한다. 알 수 없는 phase는 거부한다", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "retained-phases-missing-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  let effects = 0;
  const effect = async () => { effects += 1; };
  await assert.rejects(runRetainedGwangjuTimetableRefresh({
    repositoryRoot: root, operationRoot: path.join(root, "never-collected"), env, phase: "publish",
    boundaries: { readDecision: async () => due, preflightDue: async () => preflight, publish: effect, register: effect, collectKric: effect },
  }), /ENOENT|collection receipt/u);
  assert.equal(effects, 0);
  await assert.rejects(runRetainedGwangjuTimetableRefresh({ repositoryRoot: root, operationRoot: path.join(root, "x"), env, phase: "both", boundaries: { readDecision: async () => due } }), /phase is invalid/);
});
