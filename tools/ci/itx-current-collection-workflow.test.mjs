import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { EventEmitter } from "node:events";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const workflowPath = path.join(root, ".github/workflows/itx-current-collection.yml");
const ciPath = path.join(root, ".github/workflows/ci.yml");
const secretSyncPath = path.join(root, "tools/ci/sync-itx-current-collection-secret.mjs");
const ownershipPath = path.join(root, "tools/ci/data-test-ownership.json");
const budgetGuardPath = path.join(root, "tools/ci/guard-itx-current-collection-budget.mjs");

function workflow() {
  assert.ok(existsSync(workflowPath), "ITX current collection workflow를 찾지 못함");
  return readFileSync(workflowPath, "utf8");
}

function step(source, name) {
  const match = source.match(new RegExp(`- name: ${name}[\\s\\S]*?(?=\\n\\s+- name:|\\n\\s*$)`));
  assert.ok(match, `${name} 스텝을 찾지 못함`);
  return match[0];
}

test("ITX current collection은 수동 전용 read-only workflow다", () => {
  const yml = workflow();
  assert.match(yml, /^on:\n\s+workflow_dispatch:\s*$/m);
  assert.doesNotMatch(yml, /^\s+(?:push|pull_request|schedule):/m);
  assert.match(yml, /^permissions:\n\s+actions: read\n\s+contents: read\s*$/m);
  assert.match(yml, /timeout-minutes:\s*60/);
  assert.match(yml, /collect:\n\s+name: ITX current collection\n\s+runs-on: macos-15\n\s+environment: itx-current-collection/);
  assert.match(yml, /concurrency:[\s\S]*?cancel-in-progress:\s*false/);
  assert.match(yml, /persist-credentials:\s*false/);
  assert.match(yml, /node-version:\s*["']24\.19\.0["']/);
  assert.doesNotMatch(yml, /workflow_dispatch:[\s\S]*?inputs:/);
});

test("KST quota guard는 no-provider preflight 뒤 sole collector 직전에 둔다", () => {
  const yml = workflow();
  const guard = step(yml, "ITX current collection / Guard KST quota window");
  assert.match(guard, /GITHUB_TOKEN:\s*\$\{\{ github\.token \}\}/);
  assert.match(guard, /--output "\$\{EASYSUBWAY_ITX_COLLECTION_OUTPUT\}\/freshness\.json"/);
  assert.equal((guard.match(/guard-itx-current-collection-budget\.mjs/g) ?? []).length, 1);
  assert.ok(yml.indexOf("Prepare temp output") < yml.indexOf("Emit station catalog pack"));
  assert.ok(yml.indexOf("Emit station catalog pack") < yml.indexOf("Guard KST quota window"));
  assert.ok(yml.indexOf("Validate provider entry preflight") < yml.indexOf("Guard KST quota window"));
  assert.ok(yml.indexOf("Guard KST quota window") < yml.indexOf("Collect ITX current timetable"));
});

test("tracked catalog·single-clock wrapper가 temp에서 정확한 current 수집을 구성한다", () => {
  const yml = workflow();
  assert.doesNotMatch(yml, /Derive KST service dates|check-timetable-snapshot-freshness\.mjs|steps\.freshness\.outputs/);

  const catalog = step(yml, "ITX current collection / Emit station catalog pack");
  assert.match(catalog, /emit-station-catalog-pack\.mjs/);
  assert.match(catalog, /\$\{\{ runner\.temp \}\}/);
  assert.match(catalog, /--catalog-pack-id "itx-current-station-catalog-v1"/);
  assert.doesNotMatch(catalog, /catalog-pack-id[^\n]*\$\{\{\s*github\.run_id\s*\}\}/);

  const preflight = step(yml, "ITX current collection / Validate provider entry preflight");
  assert.match(preflight, /DATA_GO_KR_SERVICE_KEY:\s*\$\{\{ secrets\.DATA_GO_KR_SERVICE_KEY \}\}/);
  assert.match(preflight, /must be a nonempty single line/);
  assert.match(preflight, /candidate and completeness paths must be absent/);

  const collect = step(yml, "ITX current collection / Collect ITX current timetable");
  assert.match(collect, /DATA_GO_KR_SERVICE_KEY:\s*\$\{\{ secrets\.DATA_GO_KR_SERVICE_KEY \}\}/);
  assert.equal((collect.match(/run-current-itx-collection\.mjs/g) ?? []).length, 1);
  for (const flag of ["--output", "--completeness-output", "--station-catalog-pack", "--freshness-output"]) {
    assert.match(collect, new RegExp(flag));
  }
  assert.doesNotMatch(collect, /must be a nonempty single line|candidate and completeness paths must be absent/);
  assert.doesNotMatch(collect, /(?:collect-korail-itx-cheongchun-timetable|day[789]-date|promote-candidate|previous-admitted|replay|canonical-pack)/);
});

test("실패에도 sanitized 증적만 보존하며 raw·secret·catalog·promotion 경로는 없다", () => {
  const yml = workflow();
  const upload = step(yml, "ITX current collection / Upload sanitized evidence");
  assert.match(upload, /if:\s*\$\{\{ always\(\) \}\}/);
  assert.match(upload, /actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a/);
  assert.match(upload, /retention-days:\s*14/);
  assert.match(upload, /freshness\.json/);
  assert.match(upload, /itx-result\.json/);
  assert.match(upload, /provider-response-capture\.json/);
  assert.doesNotMatch(upload, /station-catalog-pack|DATA_GO_KR_SERVICE_KEY|raw/i);
  assert.doesNotMatch(yml, /(?:git (?:add|commit|push)|gh |promotion|publish|upload-release|fallback|alternate provider)/i);
});

test("Data contracts가 ITX current workflow static contract를 실행한다", () => {
  const ci = readFileSync(ciPath, "utf8");
  assert.match(ci, /node tools\/ci\/data-test-discovery\.mjs run --class required-pr/);
  const ownership = JSON.parse(readFileSync(ownershipPath, "utf8"));
  for (const ownedPath of [
    "tools/ci/itx-current-collection-workflow.test.mjs",
    "tools/datapack/run-current-itx-collection.test.mjs",
  ]) {
    const entry = ownership.tests.find(({ path: testPath }) => testPath === ownedPath);
    assert.ok(entry, `${ownedPath} ownership entry를 찾지 못함`);
    assert.ok(entry.classes.includes("required-pr"));
  }
});

function childResult({ code = 0, signal = null, stdout = "", stderr = "", error = null } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  let input = "";
  child.stdin = {
    end(value) {
      input = value;
    },
  };
  child.input = () => input;
  child.kill = () => {
    queueMicrotask(() => child.emit("close", null, "SIGTERM"));
    return true;
  };
  queueMicrotask(() => {
    if (stdout) child.stdout.emit("data", Buffer.from(stdout));
    if (stderr) child.stderr.emit("data", Buffer.from(stderr));
    if (error) child.emit("error", error);
    else child.emit("close", code, signal);
  });
  return child;
}

async function loadSecretSync() {
  assert.ok(existsSync(secretSyncPath), "ITX current collection secret 동기화 helper를 찾지 못함");
  return import(`${pathToFileURL(secretSyncPath).href}?cacheBust=${Date.now()}`);
}

async function loadBudgetGuard() {
  assert.ok(existsSync(budgetGuardPath), "ITX current collection quota guard를 찾지 못함");
  return import(`${pathToFileURL(budgetGuardPath).href}?cacheBust=${Date.now()}`);
}

function budgetEnv(overrides = {}) {
  return {
    GITHUB_REPOSITORY: "AquilaXk/easysubway-data",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REF: "refs/heads/main",
    GITHUB_RUN_ID: "9001",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_TOKEN: "synthetic-github-token-that-must-not-leak",
    ...overrides,
  };
}

function workflowRun(id, createdAt = "2026-08-12T15:14:00.000Z") {
  return {
    id,
    created_at: createdAt,
    event: "workflow_dispatch",
    head_branch: "main",
    run_attempt: 1,
    path: ".github/workflows/itx-current-collection.yml",
  };
}

function githubResponse(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    async text() {
      return JSON.stringify(body);
    },
  };
}

function workflowJob(runId, collectorStep, jobId = runId + 10_000) {
  return {
    id: jobId,
    run_id: runId,
    name: "ITX current collection",
    status: "completed",
    conclusion: "failure",
    steps: [
      { name: "ITX current collection / Guard KST quota window", status: "completed", conclusion: "failure" },
      collectorStep,
    ],
  };
}

function collectorStep(status, conclusion) {
  return {
    name: "ITX current collection / Collect ITX current timetable",
    status,
    conclusion,
  };
}

function priorRunFetch({ runs, jobsByRun = {} }) {
  return async (url) => {
    const request = new URL(url);
    if (request.pathname.endsWith("/runs")) {
      const selected = request.pathname.includes("/itx-current-collection.yml/") ? runs : [];
      return githubResponse({ total_count: selected.length, workflow_runs: selected });
    }
    const match = request.pathname.match(/\/actions\/runs\/(\d+)\/jobs$/);
    if (!match) return githubResponse({}, { ok: false, status: 404 });
    const jobs = jobsByRun[match[1]];
    return githubResponse({ total_count: jobs?.length ?? 0, jobs: jobs ?? [] });
  };
}

test("KST quota guard는 fresh window의 exact current run과 자동 refresh ledger를 함께 확인한다", async () => {
  const { guardItxCurrentCollectionBudget } = await loadBudgetGuard();
  const calls = [];
  const result = await guardItxCurrentCollectionBudget({
    env: budgetEnv(),
    now: new Date("2026-08-12T15:15:00.000Z"),
    async fetchImpl(url, options) {
      calls.push({ url, options });
      const request = new URL(url);
      const runs = request.pathname.includes("/itx-current-collection.yml/")
        ? [workflowRun(9001)] : [];
      return githubResponse({ total_count: runs.length, workflow_runs: runs });
    },
  });

  assert.deepEqual(result, {
    repository: "AquilaXk/easysubway-data",
    runId: 9001,
    quotaWindow: "2026-08-13",
    otherRunCount: 0,
  });
  assert.equal(calls.length, 3);
  const requestUrl = new URL(calls[0].url);
  assert.equal(requestUrl.origin, "https://api.github.com");
  assert.equal(requestUrl.pathname, "/repos/AquilaXk/easysubway-data/actions/workflows/itx-current-collection.yml/runs");
  assert.equal(requestUrl.searchParams.get("event"), "workflow_dispatch");
  assert.equal(requestUrl.searchParams.get("branch"), "main");
  assert.equal(requestUrl.searchParams.get("per_page"), "100");
  assert.equal(requestUrl.searchParams.get("created"), "2026-08-12T15:00:00.000Z..2026-08-13T14:59:59.999Z");
  assert.equal(calls[0].options.headers.authorization, "Bearer synthetic-github-token-that-must-not-leak");
  assert.doesNotMatch(calls[0].url, /synthetic-github-token/);
});

test("KST quota guard는 scheduled topology refresh의 exact current run을 허용한다", async () => {
  const { guardItxCurrentCollectionBudget } = await loadBudgetGuard();
  const result = await guardItxCurrentCollectionBudget({
    env: budgetEnv({ GITHUB_EVENT_NAME: "schedule" }),
    now: new Date("2026-08-12T15:15:00.000Z"),
    async fetchImpl(url) {
      const request = new URL(url);
      const selected = request.pathname.includes("/current-capital-topology-refresh.yml/")
        && request.searchParams.get("event") === "schedule"
        ? [{
            ...workflowRun(9001),
            event: "schedule",
            path: ".github/workflows/current-capital-topology-refresh.yml",
          }]
        : [];
      return githubResponse({ total_count: selected.length, workflow_runs: selected });
    },
  });
  assert.equal(result.runId, 9001);
  assert.equal(result.otherRunCount, 0);
});

test("KST quota guard는 collector가 skipped인 same-window pre-provider failure를 소비로 세지 않는다", async () => {
  const { guardItxCurrentCollectionBudget } = await loadBudgetGuard();
  const result = await guardItxCurrentCollectionBudget({
    env: budgetEnv(),
    now: new Date("2026-08-12T15:15:00.000Z"),
    fetchImpl: priorRunFetch({
      runs: [workflowRun(9000), workflowRun(9001)],
      jobsByRun: { 9000: [workflowJob(9000, collectorStep("completed", "skipped"))] },
    }),
  });
  assert.equal(result.otherRunCount, 0);
});

test("KST quota guard는 all job attempts에서 earlier collector entry를 quota 소비로 막는다", async () => {
  const { guardItxCurrentCollectionBudget } = await loadBudgetGuard();
  const calls = [];
  await assert.rejects(() => guardItxCurrentCollectionBudget({
    env: budgetEnv(),
    now: new Date("2026-08-12T15:15:00.000Z"),
    async fetchImpl(url) {
      const request = new URL(url);
      calls.push(request);
      if (request.pathname.endsWith("/runs")) {
        const runs = request.pathname.includes("/itx-current-collection.yml/")
          ? [workflowRun(9000), workflowRun(9001)] : [];
        return githubResponse({ total_count: runs.length, workflow_runs: runs });
      }
      assert.equal(request.pathname, "/repos/AquilaXk/easysubway-data/actions/runs/9000/jobs");
      if (request.searchParams.get("filter") === "all") {
        return githubResponse({
          total_count: 2,
          jobs: [
            workflowJob(9000, collectorStep("completed", "failure"), 19_000),
            workflowJob(9000, collectorStep("completed", "skipped"), 19_001),
          ],
        });
      }
      return githubResponse({
        total_count: 1,
        jobs: [workflowJob(9000, collectorStep("completed", "skipped"))],
      });
    },
  }));
  const jobsRequest = calls.find((request) => request.pathname.endsWith("/runs/9000/jobs"));
  assert.ok(jobsRequest);
  assert.equal(jobsRequest.searchParams.get("filter"), "all");
});

test("KST quota guard는 same-window prior collector actual entry만 quota 소비로 막는다", async () => {
  const { guardItxCurrentCollectionBudget } = await loadBudgetGuard();
  for (const [status, conclusion] of [
    ["in_progress", null],
    ["completed", "success"],
    ["completed", "failure"],
    ["completed", "cancelled"],
  ]) {
    await assert.rejects(() => guardItxCurrentCollectionBudget({
      env: budgetEnv(),
      now: new Date("2026-08-12T15:15:00.000Z"),
      fetchImpl: priorRunFetch({
        runs: [workflowRun(9000), workflowRun(9001)],
        jobsByRun: { 9000: [workflowJob(9000, collectorStep(status, conclusion))] },
      }),
    }));
  }
});

test("KST quota guard는 current absent·duplicate·truncated run/job inventory를 fail closed한다", async () => {
  const { guardItxCurrentCollectionBudget } = await loadBudgetGuard();
  const fixtures = [
    [{ total_count: 1, workflow_runs: [workflowRun(9000)] }, 2],
    [{ total_count: 2, workflow_runs: [workflowRun(9001), workflowRun(9001)] }, 2],
    [{ total_count: 101, workflow_runs: Array.from({ length: 100 }, (_, index) => workflowRun(index + 1)) }, 1],
    [{
      total_count: 1,
      workflow_runs: [{ ...workflowRun(9001), path: ".github/workflows/itx-current-collection.yml@main" }],
    }, 1],
  ];

  for (const [body, expectedCalls] of fixtures) {
    let calls = 0;
    await assert.rejects(() => guardItxCurrentCollectionBudget({
      env: budgetEnv(),
      now: new Date("2026-08-12T15:15:00.000Z"),
      async fetchImpl() {
        calls += 1;
        return githubResponse(body);
      },
    }));
    assert.equal(calls, expectedCalls);
  }

  for (const jobs of [
    [],
    [workflowJob(9000, collectorStep("completed", "skipped")), workflowJob(9000, collectorStep("completed", "skipped"))],
    [workflowJob(9000, { name: "ITX current collection / Collect ITX current timetable", status: "completed", conclusion: "unknown" })],
  ]) {
    await assert.rejects(() => guardItxCurrentCollectionBudget({
      env: budgetEnv(),
      now: new Date("2026-08-12T15:15:00.000Z"),
      fetchImpl: priorRunFetch({
        runs: [workflowRun(9000), workflowRun(9001)],
        jobsByRun: { 9000: jobs },
      }),
    }));
  }
});

test("KST quota guard 실패는 provider/raw/secret 없이 sanitized preflight receipt를 남긴다", async (context) => {
  const { mkdtemp, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { runItxCurrentCollectionBudgetGuardCli } = await loadBudgetGuard();
  const directory = await mkdtemp(path.join(tmpdir(), "itx-guard-receipt-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const output = path.join(directory, "freshness.json");

  await assert.rejects(() => runItxCurrentCollectionBudgetGuardCli({
    argv: ["--output", output],
    env: budgetEnv(),
    now: new Date("2026-08-12T15:15:00.000Z"),
    fetchImpl: priorRunFetch({
      runs: [workflowRun(9000), workflowRun(9001)],
      jobsByRun: { 9000: [workflowJob(9000, collectorStep("completed", "failure"))] },
    }),
  }));

  const receipt = JSON.parse(await readFile(output, "utf8"));
  assert.deepEqual(receipt, {
    schemaVersion: 1,
    artifactKind: "itx-current-collection-preflight",
    status: "FAILED",
    operation: "KST_PROVIDER_ENTRY_QUOTA",
    providerCalls: 0,
    candidateCreated: false,
    credentialRedacted: true,
  });
});

test("KST quota guard는 rerun·wrong context와 API/schema 실패를 provider 전 sanitized 거부한다", async () => {
  const { guardItxCurrentCollectionBudget } = await loadBudgetGuard();
  for (const env of [
    budgetEnv({ GITHUB_RUN_ATTEMPT: "2" }),
    budgetEnv({ GITHUB_REPOSITORY: "AquilaXk/other" }),
    budgetEnv({ GITHUB_EVENT_NAME: "push" }),
    budgetEnv({ GITHUB_REF: "refs/heads/feature" }),
  ]) {
    let calls = 0;
    await assert.rejects(() => guardItxCurrentCollectionBudget({
      env,
      now: new Date("2026-08-12T15:15:00.000Z"),
      async fetchImpl() {
        calls += 1;
        return githubResponse({ total_count: 1, workflow_runs: [workflowRun(9001)] });
      },
    }));
    assert.equal(calls, 0);
  }

  const failures = [
    async () => githubResponse({}, { ok: false, status: 503 }),
    async () => githubResponse({ total_count: 1, workflow_runs: [workflowRun(9001, "invalid")] }),
    async () => { throw new Error("synthetic-github-token-that-must-not-leak raw failure"); },
  ];
  for (const fetchImpl of failures) {
    await assert.rejects(
      () => guardItxCurrentCollectionBudget({
        env: budgetEnv(),
        now: new Date("2026-08-12T15:15:00.000Z"),
        fetchImpl,
      }),
      (error) => {
        assert.doesNotMatch(error.message, /synthetic-github-token|raw failure|503/);
        return true;
      },
    );
  }
});

test("ITX current collection secret 동기화는 stdin으로 gh secret set을 사용한다", async () => {
  const { syncItxCurrentCollectionSecret } = await loadSecretSync();
  const calls = [];
  const serviceKey = "synthetic-itx-service-key-2026%2Bencoded";

  const result = await syncItxCurrentCollectionSecret({
    argv: [],
    env: {
      DATA_GO_KR_SERVICE_KEY: serviceKey,
      data_go_kr_service_key: "synthetic-lowercase-key",
      Data_Go_Kr_Service_Key: "synthetic-mixed-case-key",
      GH_HOST: "synthetic.example.test",
      PATH: "/usr/bin",
      SAFE_ENV: "safe",
    },
    spawnImpl(command, args, options) {
      const child = childResult();
      calls.push({ command, args, options, child });
      return child;
    },
  });

  assert.deepEqual(result, {
    secretName: "DATA_GO_KR_SERVICE_KEY",
    repository: "AquilaXk/easysubway-data",
    environment: "itx-current-collection",
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "gh");
  assert.deepEqual(calls[0].args, [
    "secret", "set", "DATA_GO_KR_SERVICE_KEY",
    "--repo", "github.com/AquilaXk/easysubway-data",
    "--env", "itx-current-collection",
  ]);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.timeout, 15_000);
  assert.equal(Object.keys(calls[0].options.env).some((key) => key.toUpperCase() === "DATA_GO_KR_SERVICE_KEY"), false);
  assert.ok(calls[0].options.env.PATH);
  assert.equal(calls[0].options.env.SAFE_ENV, undefined);
  assert.doesNotMatch(calls[0].args.join(" "), /(?:--body|synthetic-itx-service-key-2026%2Bencoded)/);
  assert.equal(calls[0].child.input(), serviceKey);
});

test("ITX current collection secret 동기화는 유효하지 않은 입력과 추가 인자를 실행 전에 거부한다", async () => {
  const { syncItxCurrentCollectionSecret } = await loadSecretSync();
  const invalidKeys = [undefined, "", "line-one\nline-two", Buffer.from([0xc3, 0x28])];

  for (const serviceKey of invalidKeys) {
    let calls = 0;
    await assert.rejects(
      () => syncItxCurrentCollectionSecret({
        argv: [],
        env: { DATA_GO_KR_SERVICE_KEY: serviceKey },
        spawnImpl() {
          calls += 1;
          return childResult();
        },
      }),
      (error) => {
        assert.doesNotMatch(error.message, /line-one|\u00c3\(/);
        return true;
      },
    );
    assert.equal(calls, 0);
  }

  let calls = 0;
  await assert.rejects(() => syncItxCurrentCollectionSecret({
    argv: ["--unexpected"],
    env: { DATA_GO_KR_SERVICE_KEY: "synthetic-itx-service-key-2026" },
    spawnImpl() {
      calls += 1;
      return childResult();
    },
  }));
  assert.equal(calls, 0);
});

test("ITX current collection secret 동기화는 gh 실행 실패를 secret과 출력 없이 보고한다", async () => {
  const { syncItxCurrentCollectionSecret } = await loadSecretSync();
  const serviceKey = "synthetic-itx-service-key-2026";
  const failures = [
    () => childResult({ error: new Error(`spawn failed: ${serviceKey}`), stdout: serviceKey, stderr: serviceKey }),
    () => childResult({ error: Object.assign(new Error(`timeout: ${serviceKey}`), { name: "TimeoutError" }), stdout: serviceKey, stderr: serviceKey }),
    () => childResult({ signal: "SIGTERM", stdout: serviceKey, stderr: serviceKey }),
    () => childResult({ code: 1, stdout: serviceKey, stderr: serviceKey }),
  ];

  for (const failure of failures) {
    await assert.rejects(
      () => syncItxCurrentCollectionSecret({
        argv: [],
        env: { DATA_GO_KR_SERVICE_KEY: serviceKey },
        spawnImpl() {
          return failure();
        },
      }),
      (error) => {
        assert.doesNotMatch(error.message, /synthetic-itx-service-key-2026/);
        assert.doesNotMatch(error.message, /spawn failed/);
        return true;
      },
    );
  }
});

test("ITX current collection secret 동기화는 SIGTERM을 무시하는 gh child를 15초 뒤 SIGKILL로 종료한다", async () => {
  const { syncItxCurrentCollectionSecret } = await loadSecretSync();
  const serviceKey = "synthetic-itx-service-key-2026%2Btimeout";
  const leakedOutput = "synthetic-gh-output-that-must-not-leak";
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { end() {} };
  const killSignals = [];
  child.kill = (signal) => {
    killSignals.push(signal);
    return true;
  };
  const timers = [];
  const clearedTimers = [];
  const pending = syncItxCurrentCollectionSecret({
    argv: [],
    env: { DATA_GO_KR_SERVICE_KEY: serviceKey },
    spawnImpl() {
      queueMicrotask(() => {
        child.stdout.emit("data", Buffer.from(leakedOutput));
        child.stderr.emit("data", Buffer.from(serviceKey));
      });
      return child;
    },
    setTimeoutImpl(callback, delay) {
      const timer = { callback, delay };
      timers.push(timer);
      return timer;
    },
    clearTimeoutImpl(timer) {
      clearedTimers.push(timer);
    },
  });
  let failureCount = 0;
  const observedPending = pending.catch((error) => {
    failureCount += 1;
    throw error;
  });

  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, 15_000);
  timers[0].callback();
  await assert.rejects(observedPending, (error) => {
    assert.doesNotMatch(error.message, /synthetic-itx-service-key-2026%2Btimeout/);
    assert.doesNotMatch(error.message, /synthetic-gh-output-that-must-not-leak/);
    return true;
  });
  assert.deepEqual(killSignals, ["SIGKILL"]);
  assert.deepEqual(clearedTimers, [timers[0]]);
  assert.equal(failureCount, 1);

  child.emit("close", 0, null);
  await new Promise(queueMicrotask);
  assert.deepEqual(killSignals, ["SIGKILL"]);
  assert.deepEqual(clearedTimers, [timers[0]]);
  assert.equal(failureCount, 1);
});
