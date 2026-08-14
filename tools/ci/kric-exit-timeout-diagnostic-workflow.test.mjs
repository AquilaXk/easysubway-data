import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import test from "node:test";
import { EventEmitter } from "node:events";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const workflowPath = path.join(root, ".github/workflows/kric-exit-timeout-diagnostic.yml");
const ciPath = path.join(root, ".github/workflows/ci.yml");
const secretSyncPath = path.join(root, "tools/ci/sync-kric-exit-diagnostic-secret.mjs");
const queryId = "dd25f07bd2351a43024b0aae0cd6a8f6075c565b43606fb84771e0f3ca20868c";

function childResult({ code = 0, signal = null, error = null } = {}) {
  const child = new EventEmitter();
  let input = "";
  child.stdin = {
    end(value) {
      input = value;
    },
  };
  child.input = () => input;
  child.kill = () => true;
  queueMicrotask(() => {
    if (error) child.emit("error", error);
    else child.emit("close", code, signal);
  });
  return child;
}

async function loadSecretSync() {
  assert.ok(existsSync(secretSyncPath), "KRIC EXIT diagnostic secret 동기화 helper를 찾지 못함");
  return import(`${pathToFileURL(secretSyncPath).href}?cacheBust=${Date.now()}`);
}

function workflow() {
  assert.ok(existsSync(workflowPath), "KRIC EXIT timeout diagnostic workflow를 찾지 못함");
  return readFileSync(workflowPath, "utf8");
}

test("hosted diagnostic은 no-input manual read-only single job이다", () => {
  const yml = workflow();
  assert.match(yml, /^on:\n\s+workflow_dispatch:\s*$/m);
  assert.doesNotMatch(yml, /workflow_dispatch:[\s\S]*?inputs:/);
  assert.doesNotMatch(yml, /^\s+(?:push|pull_request|schedule|repository_dispatch):/m);
  assert.match(yml, /^permissions:\n\s+contents: read\s*$/m);
  assert.match(yml, /concurrency:[\s\S]*?cancel-in-progress:\s*false/);
  assert.match(yml, /runs-on:\s*ubuntu-latest/);
  assert.match(yml, /timeout-minutes:\s*5/);
  assert.match(yml, /persist-credentials:\s*false/);
  assert.match(yml, /node-version:\s*["']24\.19\.0["']/);
  assert.doesNotMatch(yml, /strategy:|matrix:/);
});

test("workflow는 tracked plan과 fixed correlated diagnostic만 secret env로 실행한다", () => {
  const yml = workflow();
  assert.match(yml, /KRIC_SERVICE_KEY:\s*\$\{\{ secrets\.KRIC_SERVICE_KEY \}\}/);
  assert.equal((yml.match(/build-current-kric-exit-collection-plan\.mjs/g) ?? []).length, 1);
  assert.equal((yml.match(/diagnose-current-kric-exit-path-query\.mjs/g) ?? []).length, 1);
  for (const flag of [
    "--canonical-pack", "--coverage-targets", "--provider-code-catalog", "--route-rosters",
    "--source-inventory", "--incheon-topology", "--output",
  ]) assert.match(yml, new RegExp(flag));
  assert.match(yml, new RegExp(`--query-id ${queryId}`));
  assert.match(yml, /--source-id kric-station-movement-standard/);
  assert.match(yml, /--request-timeout-ms 30000/);
  assert.doesNotMatch(yml, /collect-current-kric-exit-path-provider-snapshot|request-interval|retry|continue-on-error/i);
});

test("workflow는 raw/artifact/fallback과 untracked network tooling을 사용하지 않는다", () => {
  const yml = workflow();
  assert.doesNotMatch(yml, /upload-artifact|download-artifact|artifact|curl|wget|jq|source |set -a|fallback|alternate|format xml/i);
  assert.doesNotMatch(yml, /git (?:add|commit|push)|gh |serviceKey=|echo .*KRIC|printf .*KRIC/i);
  assert.equal((yml.match(/\bnode tools\//g) ?? []).length, 2);
});

test("Data CI는 hosted diagnostic workflow contract를 실행한다", () => {
  const ci = readFileSync(ciPath, "utf8");
  assert.match(ci, /tools\/ci\/kric-exit-timeout-diagnostic-workflow\.test\.mjs/);
});

test("KRIC EXIT secret 동기화는 fixed repository secret을 stdin으로만 전달한다", async () => {
  const { syncKricExitDiagnosticSecret } = await loadSecretSync();
  const serviceKey = "synthetic-kric-service-key-2026%2Bencoded";
  const calls = [];

  const result = await syncKricExitDiagnosticSecret({
    argv: [],
    env: {
      KRIC_SERVICE_KEY: serviceKey,
      kric_service_key: "lowercase-secret",
      DATA_GO_KR_SERVICE_KEY: "other-provider-secret",
      PATH: "/usr/bin",
      GH_HOST: "github.example.test",
      GH_CONFIG_DIR: "/tmp/synthetic-gh-config",
      SAFE_ENV: "must-not-be-forwarded",
    },
    spawnImpl(command, args, options) {
      const child = childResult();
      calls.push({ command, args, options, child });
      return child;
    },
  });

  assert.deepEqual(result, {
    secretName: "KRIC_SERVICE_KEY",
    repository: "AquilaXk/easysubway-data",
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "gh");
  assert.deepEqual(calls[0].args, [
    "secret", "set", "KRIC_SERVICE_KEY",
    "--repo", "github.com/AquilaXk/easysubway-data",
  ]);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.timeout, 15_000);
  assert.deepEqual(calls[0].options.env, {
    PATH: "/usr/bin",
    GH_HOST: "github.example.test",
    GH_CONFIG_DIR: "/tmp/synthetic-gh-config",
  });
  assert.doesNotMatch(calls[0].args.join(" "), /synthetic-kric|DATA_GO_KR/);
  assert.equal(calls[0].child.input(), serviceKey);
});

test("KRIC EXIT secret 동기화는 invalid input과 gh 실패를 sanitized fail-closed 처리한다", async () => {
  const { syncKricExitDiagnosticSecret } = await loadSecretSync();
  for (const serviceKey of [undefined, "", "line-one\nline-two", Buffer.from([0xc3, 0x28])]) {
    let calls = 0;
    await assert.rejects(() => syncKricExitDiagnosticSecret({
      argv: [],
      env: { KRIC_SERVICE_KEY: serviceKey },
      spawnImpl() {
        calls += 1;
        return childResult();
      },
    }), (error) => {
      assert.doesNotMatch(error.message, /line-one|synthetic|\u00c3/);
      return true;
    });
    assert.equal(calls, 0);
  }

  let calls = 0;
  await assert.rejects(() => syncKricExitDiagnosticSecret({
    argv: ["--unexpected"],
    env: { KRIC_SERVICE_KEY: "synthetic-kric-service-key-2026" },
    spawnImpl() {
      calls += 1;
      return childResult();
    },
  }));
  assert.equal(calls, 0);

  await assert.rejects(() => syncKricExitDiagnosticSecret({
    argv: [],
    env: { KRIC_SERVICE_KEY: "synthetic-kric-service-key-2026" },
    spawnImpl() {
      return childResult({ error: new Error("raw synthetic-kric-service-key-2026") });
    },
  }), (error) => {
    assert.doesNotMatch(error.message, /raw|synthetic-kric/);
    return true;
  });
});
