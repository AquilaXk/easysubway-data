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
  assert.match(yml, /^permissions:\n\s+contents: read\s*$/m);
  assert.match(yml, /timeout-minutes:\s*60/);
  assert.match(yml, /collect:\n\s+name: ITX current collection\n\s+runs-on: macos-15\n\s+environment: itx-current-collection/);
  assert.match(yml, /concurrency:[\s\S]*?cancel-in-progress:\s*false/);
  assert.match(yml, /persist-credentials:\s*false/);
  assert.match(yml, /node-version:\s*["']24\.19\.0["']/);
  assert.doesNotMatch(yml, /workflow_dispatch:[\s\S]*?inputs:/);
});

test("tracked catalog·single-clock wrapper가 temp에서 정확한 current 수집을 구성한다", () => {
  const yml = workflow();
  assert.doesNotMatch(yml, /Derive KST service dates|check-timetable-snapshot-freshness\.mjs|steps\.freshness\.outputs/);

  const catalog = step(yml, "ITX current collection / Emit station catalog pack");
  assert.match(catalog, /emit-station-catalog-pack\.mjs/);
  assert.match(catalog, /\$\{\{ runner\.temp \}\}/);
  assert.match(catalog, /--catalog-pack-id "itx-current-station-catalog-v1"/);
  assert.doesNotMatch(catalog, /catalog-pack-id[^\n]*\$\{\{\s*github\.run_id\s*\}\}/);

  const collect = step(yml, "ITX current collection / Collect ITX current timetable");
  assert.match(collect, /DATA_GO_KR_SERVICE_KEY:\s*\$\{\{ secrets\.DATA_GO_KR_SERVICE_KEY \}\}/);
  assert.match(collect, /must be a nonempty single line/);
  assert.equal((collect.match(/run-current-itx-collection\.mjs/g) ?? []).length, 1);
  for (const flag of ["--output", "--completeness-output", "--station-catalog-pack", "--freshness-output"]) {
    assert.match(collect, new RegExp(flag));
  }
  assert.match(collect, /candidate and completeness paths must be absent/);
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
  assert.match(ci, /tools\/ci\/itx-current-collection-workflow\.test\.mjs/);
  assert.match(ci, /tools\/datapack\/run-current-itx-collection\.test\.mjs/);
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
  assert.equal(calls[0].options.env.SAFE_ENV, "safe");
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
