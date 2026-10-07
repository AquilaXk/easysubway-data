import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { checkSchedulerHeartbeat, main, parseMaxAge, validateHeartbeatPolicy } from "./check-scheduler-heartbeat.mjs";

// #1001: 외부 스케줄러(OCI k3s CronJob)가 App(easysubway-release-chain[bot])으로 data workflow를 dispatch한다.
// 이 점검은 정책에 적힌 workflow마다 그 App의 가장 최근 dispatch run이 maxAge 안에 있는지 본다. 없거나 늦으면 실패해 실패 이슈(#926)로 드러난다.
const root = path.resolve(import.meta.dirname, "../..");
const repository = "AquilaXk/easysubway-data";
const APP = "easysubway-release-chain[bot]";
const now = new Date("2026-10-07T12:00:00.000Z");
const hoursAgo = (hours) => new Date(now.getTime() - hours * 3_600_000).toISOString();
const policy = {
  schemaVersion: 1,
  artifactKind: "external-scheduler-heartbeat-policy",
  dispatcher: { login: APP, type: "Bot" },
  workflows: [
    { workflow: "kric-current-facility-refresh.yml", maxAge: "PT5H" },
    { workflow: "itx-current-promotion.yml", maxAge: "PT27H" },
  ],
};
const run = (login, createdAt, extra = {}) => ({ id: 1, created_at: createdAt, event: "workflow_dispatch", head_branch: "main", actor: { login, type: "Bot" }, ...extra });

test("정책의 모든 workflow에 App의 최근 dispatch run이 maxAge 안에 있으면 통과한다", () => {
  const result = checkSchedulerHeartbeat({
    policy,
    now,
    runsByWorkflow: {
      "kric-current-facility-refresh.yml": [run("AquilaXk", hoursAgo(0.5)), run(APP, hoursAgo(1.9))],
      "itx-current-promotion.yml": [run(APP, hoursAgo(20))],
    },
  });
  assert.deepEqual(result.violations, []);
  assert.deepEqual(result.results.map(({ workflow, ageMinutes }) => [workflow, ageMinutes]), [
    ["kric-current-facility-refresh.yml", 114],
    ["itx-current-promotion.yml", 1200],
  ]);
});

test("App의 dispatch run이 없으면 사람 dispatch가 최근이어도 MISSING으로 실패한다", () => {
  const { violations } = checkSchedulerHeartbeat({
    policy,
    now,
    runsByWorkflow: { "kric-current-facility-refresh.yml": [run("AquilaXk", hoursAgo(0.1))], "itx-current-promotion.yml": [run(APP, hoursAgo(1))] },
  });
  assert.equal(violations.length, 1);
  assert.match(violations[0], /^SCHEDULER_HEARTBEAT_MISSING: kric-current-facility-refresh\.yml/u);
});

test("가장 최근 App dispatch가 maxAge를 넘으면 STALE로 실패하고 정확히 maxAge인 run은 통과한다", () => {
  const stale = checkSchedulerHeartbeat({
    policy,
    now,
    runsByWorkflow: { "kric-current-facility-refresh.yml": [run(APP, hoursAgo(5.01))], "itx-current-promotion.yml": [run(APP, hoursAgo(27))] },
  });
  assert.equal(stale.violations.length, 1);
  assert.match(stale.violations[0], /^SCHEDULER_HEARTBEAT_STALE: kric-current-facility-refresh\.yml.*PT5H/u);
});

test("App 이름만 같고 type이 Bot이 아니거나 main이 아닌 run은 인정하지 않는다", () => {
  const { violations } = checkSchedulerHeartbeat({
    policy,
    now,
    runsByWorkflow: {
      "kric-current-facility-refresh.yml": [run(APP, hoursAgo(1), { actor: { login: APP, type: "User" } }), run(APP, hoursAgo(1), { head_branch: "feature" }), run(APP, hoursAgo(1), { event: "schedule" })],
      "itx-current-promotion.yml": [run(APP, hoursAgo(1))],
    },
  });
  assert.equal(violations.length, 1);
  assert.match(violations[0], /MISSING: kric-current-facility-refresh\.yml/u);
});

test("run 시각이 미래이거나 깨진 응답은 통과가 아니라 실패한다", () => {
  assert.throws(() => checkSchedulerHeartbeat({
    policy: { ...policy, workflows: [policy.workflows[0]] }, now, runsByWorkflow: { "kric-current-facility-refresh.yml": [run(APP, "not-a-time")] },
  }), /SCHEDULER_HEARTBEAT_RUN_INVALID/u);
  assert.throws(() => checkSchedulerHeartbeat({
    policy: { ...policy, workflows: [policy.workflows[0]] }, now, runsByWorkflow: { "kric-current-facility-refresh.yml": [run(APP, new Date(now.getTime() + 3_600_000).toISOString())] },
  }), /SCHEDULER_HEARTBEAT_RUN_INVALID/u);
  assert.throws(() => checkSchedulerHeartbeat({ policy, now, runsByWorkflow: {} }), /SCHEDULER_HEARTBEAT_RUN_INVALID/u);
});

test("5분 이내의 시계 차이는 받아주고 나이는 0분으로 센다", () => {
  const { violations, results } = checkSchedulerHeartbeat({
    policy: { ...policy, workflows: [policy.workflows[0]] }, now, runsByWorkflow: { "kric-current-facility-refresh.yml": [run(APP, new Date(now.getTime() + 60_000).toISOString())] },
  });
  assert.deepEqual(violations, []);
  assert.equal(results[0].ageMinutes, 0);
});

test("maxAge는 PT<시간>H·PT<분>M·P<일>D만 읽고 나머지는 거절한다", () => {
  assert.equal(parseMaxAge("PT5H"), 5 * 3_600_000);
  assert.equal(parseMaxAge("PT90M"), 90 * 60_000);
  assert.equal(parseMaxAge("P1D"), 86_400_000);
  for (const value of ["", "5h", "PT0H", "PT1S", "P1DT1H", "PT-1H", undefined, 5]) assert.throws(() => parseMaxAge(value), /SCHEDULER_HEARTBEAT_POLICY/u, String(value));
});

test("정책은 닫힌 형식이어야 한다", () => {
  assert.doesNotThrow(() => validateHeartbeatPolicy(policy));
  const bad = [
    { ...policy, schemaVersion: 2 },
    { ...policy, artifactKind: "x" },
    { ...policy, extra: true },
    { ...policy, dispatcher: { login: APP } },
    { ...policy, dispatcher: { login: "AquilaXk", type: "Bot" } },
    { ...policy, workflows: [] },
    { ...policy, workflows: [policy.workflows[0], policy.workflows[0]] },
    { ...policy, workflows: [{ workflow: "../x.yml", maxAge: "PT1H" }] },
    { ...policy, workflows: [{ workflow: "x.yml", maxAge: "PT1H", extra: 1 }] },
  ];
  for (const value of bad) assert.throws(() => validateHeartbeatPolicy(value), /SCHEDULER_HEARTBEAT_POLICY/u, JSON.stringify(value).slice(0, 80));
});

test("main은 workflow마다 dispatch run 목록을 gh api로 읽고 위반이 있으면 모든 workflow를 점검한 뒤 실패한다", async () => {
  const calls = [];
  const lines = [];
  const policyText = JSON.stringify(policy);
  const runGh = async (args) => {
    calls.push(args);
    const file = /workflows\/([^/]+)\/runs/u.exec(args[1])[1];
    return JSON.stringify({ workflow_runs: file === "kric-current-facility-refresh.yml" ? [] : [run(APP, hoursAgo(1))] });
  };
  await assert.rejects(main(["--repository", repository, "--policy", "policy.json"], { runGh, now: () => now, readPolicy: async () => policyText, log: (line) => lines.push(line) }), /SCHEDULER_HEARTBEAT_MISSING: kric-current-facility-refresh\.yml/u);
  assert.deepEqual(calls.map((args) => args[1]), [
    `repos/${repository}/actions/workflows/kric-current-facility-refresh.yml/runs?event=workflow_dispatch&branch=main&per_page=100`,
    `repos/${repository}/actions/workflows/itx-current-promotion.yml/runs?event=workflow_dispatch&branch=main&per_page=100`,
  ]);
  assert.ok(calls.every((args) => args[0] === "api"));
  assert.ok(lines.some((line) => line.startsWith("OK itx-current-promotion.yml")));
});

test("main은 API 오류와 깨진 응답을 통과로 바꾸지 않는다", async () => {
  const base = { now: () => now, readPolicy: async () => JSON.stringify(policy), log: () => {} };
  await assert.rejects(main(["--repository", repository, "--policy", "p"], { ...base, runGh: async () => { throw new Error("gh api failed: HTTP 502"); } }), /HTTP 502/u);
  await assert.rejects(main(["--repository", repository, "--policy", "p"], { ...base, runGh: async () => "{\"workflow_runs\":null}" }), /SCHEDULER_HEARTBEAT_API/u);
  await assert.rejects(main(["--repository", repository, "--policy", "p"], { ...base, runGh: async () => "not json" }), /SCHEDULER_HEARTBEAT_API/u);
  await assert.rejects(main(["--repository", "bad", "--policy", "p"], { ...base, runGh: async () => "{}" }), /SCHEDULER_HEARTBEAT_ARGUMENTS/u);
  await assert.rejects(main(["--repository", repository], { ...base, runGh: async () => "{}" }), /SCHEDULER_HEARTBEAT_ARGUMENTS/u);
});

test("실제 정책 파일은 닫힌 형식이고 정책의 workflow는 정기 실행과 dispatch를 가진다", () => {
  const actual = JSON.parse(readFileSync(path.join(root, "release/product-gates/external-scheduler-heartbeat.json"), "utf8"));
  validateHeartbeatPolicy(actual);
  assert.deepEqual(actual.workflows.map(({ workflow }) => workflow), [
    "current-capital-topology-refresh.yml",
    "current-capital-topology-registration.yml",
    "datapack-expiry-alert.yml",
    "itx-current-promotion.yml",
    "kric-current-facility-refresh.yml",
    "retained-gwangju-timetable-refresh.yml",
    "seoul-current-accessibility-refresh.yml",
    "source-derivative-rebinding.yml",
    "source-reverification.yml",
  ]);
  for (const { workflow, maxAge } of actual.workflows) {
    const yml = readFileSync(path.join(root, ".github/workflows", workflow), "utf8");
    assert.match(yml, /\n  schedule:\n/u, `${workflow} keeps the GitHub schedule as the backup path`);
    assert.match(yml, /\n  workflow_dispatch:/u, `${workflow} accepts workflow_dispatch`);
    parseMaxAge(maxAge);
  }
  // 정기 주기의 두 배보다 크게 잡아 스케줄러가 한 번 늦은 것만으로는 알리지 않는다(2시간 workflow는 5시간).
  const maxAge = Object.fromEntries(actual.workflows.map((item) => [item.workflow, parseMaxAge(item.maxAge)]));
  const hours = (value) => value * 3_600_000;
  for (const workflow of ["current-capital-topology-refresh.yml", "current-capital-topology-registration.yml", "kric-current-facility-refresh.yml", "retained-gwangju-timetable-refresh.yml", "seoul-current-accessibility-refresh.yml", "source-reverification.yml"]) {
    assert.equal(maxAge[workflow], hours(5), workflow);
  }
  assert.equal(maxAge["datapack-expiry-alert.yml"], hours(9));
  assert.equal(maxAge["source-derivative-rebinding.yml"], hours(13));
  assert.equal(maxAge["itx-current-promotion.yml"], hours(27));
});
