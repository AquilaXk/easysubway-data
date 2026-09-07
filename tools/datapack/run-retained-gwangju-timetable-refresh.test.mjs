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
