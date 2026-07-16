import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { sendReleaseCallback } from "./send-release-callback.mjs";
import { buildReleaseCallback, canonicalCallbackMessage } from "./build-release-callback.mjs";

const secret = "callback-secret-never-log-1234567890";
const token = "bearer-token-never-log";
const callbackEnv = {
  RELEASE_SEQUENCE: "42",
  RELEASE_REQUEST_ID: "req-2057",
  TARGET_CHANNEL: "production",
  WORKFLOW_RUN_URL: "https://github.com/AquilaXk/easysubway/actions/runs/1",
  MANIFEST_SHA256: "a".repeat(64),
  SQLITE_SHA256: "b".repeat(64),
  GZIP_SHA256: "c".repeat(64),
  EVIDENCE_BUNDLE_SHA256: "d".repeat(64),
  VALIDATOR_STATUS: "PASS",
  ROUTE_REGRESSION_STATUS: "PASS",
  PUBLISH_STATUS: "PASS",
  EASYSUBWAY_DATAPACK_CALLBACK_HMAC_KEY: secret,
};
const payload = buildReleaseCallback(callbackEnv);

test("release request id의 구분자 문자는 idempotency identity 생성 전에 거부한다", () => {
  assert.throws(
    () => buildReleaseCallback({ ...callbackEnv, RELEASE_REQUEST_ID: "req:2057" }),
    /RELEASE_REQUEST_ID must not contain ':'/,
  );
});

async function withServer(handler, callback) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await callback(`http://127.0.0.1:${server.address().port}/callback`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("500 뒤 재시도해 전달하고 artifact에서 secret을 제거한다", async () => {
  let requests = 0;
  await withServer((request, response) => {
    requests += 1;
    response.writeHead(requests === 1 ? 500 : 200).end();
  }, async (endpoint) => {
    const slept = [];
    const artifact = await sendReleaseCallback({
      payload,
      endpoint,
      token,
      retryDelaysSeconds: [60, 480, 3600],
      sleep: async (seconds) => slept.push(seconds),
    });

    assert.equal(artifact.state, "DELIVERED");
    assert.equal(artifact.attempts.length, 2);
    assert.deepEqual(slept, [60]);
    assert.equal(artifact.attempts[0].httpClass, "5XX");
    assert.equal(
      artifact.payloadSha256,
      createHash("sha256").update(canonicalCallbackMessage(payload)).digest("hex"),
      "producer와 consumer가 verifier를 제외한 동일 canonical payload hash를 사용해야 한다",
    );
    const serialized = JSON.stringify(artifact);
    assert.equal(serialized.includes(secret), false);
    assert.equal(serialized.includes(token), false);
    assert.equal(serialized.includes("Authorization"), false);
  });
});

test("400은 재시도하지 않고 reconciliation 대상으로 남긴다", async () => {
  await withServer((_request, response) => response.writeHead(400).end(), async (endpoint) => {
    const artifact = await sendReleaseCallback({ payload, endpoint, token, sleep: async () => {} });
    assert.equal(artifact.state, "RECONCILIATION_REQUIRED");
    assert.equal(artifact.attempts.length, 1);
    assert.equal(artifact.attempts[0].httpClass, "4XX");
  });
});

test("Bearer 전송 전 non-loopback HTTP endpoint를 거부한다", async () => {
  await assert.rejects(
    sendReleaseCallback({ payload, endpoint: "http://example.com/callback", token }),
    /must use HTTPS/,
  );
});

test("callback producer는 safe integer가 아닌 release sequence를 거부한다", () => {
  assert.throws(() => buildReleaseCallback({
    RELEASE_SEQUENCE: "9007199254740992",
  }), /positive safe integer/);
});

test("callback producer는 서명 전 required gate와 hash를 검증한다", () => {
  const env = callbackEnv;
  assert.equal(buildReleaseCallback(env).releaseRequestId, "req-2057");
  assert.throws(() => buildReleaseCallback({ ...env, MANIFEST_SHA256: "invalid" }), /SHA-256/);
  assert.throws(() => buildReleaseCallback({ ...env, VALIDATOR_STATUS: "UNKNOWN" }), /is invalid/);
});

test("callback producer는 32바이트보다 짧은 HMAC key를 거부한다", () => {
  assert.throws(() => buildReleaseCallback({
    ...callbackEnv,
    EASYSUBWAY_DATAPACK_CALLBACK_HMAC_KEY: "short-key",
  }), /at least 32 bytes/);
});

test("Node producer와 Java consumer는 공유 canonical payload hash를 사용한다", async () => {
  const vector = JSON.parse(await readFile(
    new URL("./fixtures/release-callback-signature-vector.json", import.meta.url),
    "utf8",
  ));
  assert.equal(
    createHash("sha256").update(canonicalCallbackMessage(vector.fields)).digest("hex"),
    vector.expectedPayloadSha256,
  );
});

test("transient failure를 모두 소진하면 bounded retry 계획을 기록한다", async () => {
  await withServer((_request, response) => response.writeHead(503).end(), async (endpoint) => {
    const slept = [];
    const artifact = await sendReleaseCallback({
      payload,
      endpoint,
      token,
      retryDelaysSeconds: [60, 480, 3600],
      sleep: async (seconds) => slept.push(seconds),
    });
    assert.equal(artifact.state, "RECONCILIATION_REQUIRED");
    assert.equal(artifact.attempts.length, 4);
    assert.deepEqual(slept, [60, 480, 3600]);
  });
});

test("재시도 전에 current가 후속 release로 전진하면 stale callback을 보내지 않는다", async () => {
  const currentBytes = Buffer.from(JSON.stringify({
    channel: "production",
    releaseSequence: 42,
  }));
  const guardedPayload = {
    ...payload,
    manifestSha256: createHash("sha256").update(currentBytes).digest("hex"),
  };
  let currentChecks = 0;
  let callbackRequests = 0;
  const artifact = await sendReleaseCallback({
    payload: guardedPayload,
    endpoint: "https://api.example.com/callback",
    token,
    currentManifestUrl: "https://datapack.example.com/catalog/current.json",
    retryDelaysSeconds: [60],
    sleep: async () => {},
    fetchImpl: async (url) => {
      if (url.includes("current.json")) {
        currentChecks += 1;
        const body = currentChecks === 1
          ? currentBytes
          : Buffer.from(JSON.stringify({ channel: "production", releaseSequence: 43 }));
        return new Response(body, { status: 200 });
      }
      callbackRequests += 1;
      return new Response(null, { status: 503 });
    },
  });

  assert.equal(artifact.state, "STALE_SUPERSEDED");
  assert.equal(artifact.terminalReason, "CURRENT_RELEASE_ADVANCED");
  assert.equal(callbackRequests, 1);
});

test("FAIL callback은 current manifest가 없어도 backend에 전달한다", async () => {
  const failedPayload = buildReleaseCallback({ ...callbackEnv, PUBLISH_STATUS: "FAIL" });
  let currentChecks = 0;
  let callbackRequests = 0;
  const artifact = await sendReleaseCallback({
    payload: failedPayload,
    endpoint: "https://api.example.com/callback",
    token,
    currentManifestUrl: "https://datapack.example.com/catalog/current.json",
    retryDelaysSeconds: [],
    sleep: async () => {},
    fetchImpl: async (url) => {
      if (url.includes("current.json")) {
        currentChecks += 1;
        return new Response(null, { status: 404 });
      }
      callbackRequests += 1;
      return new Response(null, { status: 200 });
    },
  });

  assert.equal(artifact.state, "DELIVERED");
  assert.equal(currentChecks, 0);
  assert.equal(callbackRequests, 1);
});

test("validator FAIL callback은 current manifest가 없어도 backend에 전달한다", async () => {
  const failedPayload = buildReleaseCallback({
    ...callbackEnv,
    PUBLISH_STATUS: "PASS",
    VALIDATOR_STATUS: "FAIL",
  });
  let currentChecks = 0;
  let callbackRequests = 0;
  const artifact = await sendReleaseCallback({
    payload: failedPayload,
    endpoint: "https://api.example.com/callback",
    token,
    currentManifestUrl: "https://datapack.example.com/catalog/current.json",
    retryDelaysSeconds: [],
    sleep: async () => {},
    fetchImpl: async (url) => {
      if (url.includes("current.json")) {
        currentChecks += 1;
        return new Response(null, { status: 404 });
      }
      callbackRequests += 1;
      return new Response(null, { status: 200 });
    },
  });

  assert.equal(artifact.state, "DELIVERED");
  assert.equal(currentChecks, 0);
  assert.equal(callbackRequests, 1);
});

test("route regression FAIL callback은 current manifest가 없어도 backend에 전달한다", async () => {
  const failedPayload = buildReleaseCallback({
    ...callbackEnv,
    PUBLISH_STATUS: "PASS",
    ROUTE_REGRESSION_STATUS: "FAIL",
  });
  let currentChecks = 0;
  let callbackRequests = 0;
  const artifact = await sendReleaseCallback({
    payload: failedPayload,
    endpoint: "https://api.example.com/callback",
    token,
    currentManifestUrl: "https://datapack.example.com/catalog/current.json",
    retryDelaysSeconds: [],
    sleep: async () => {},
    fetchImpl: async (url) => {
      if (url.includes("current.json")) {
        currentChecks += 1;
        return new Response(null, { status: 404 });
      }
      callbackRequests += 1;
      return new Response(null, { status: 200 });
    },
  });

  assert.equal(artifact.state, "DELIVERED");
  assert.equal(currentChecks, 0);
  assert.equal(callbackRequests, 1);
});

test("current identity 불일치는 조회 장애로 재시도하지 않고 reconciliation으로 종결한다", async () => {
  let callbackRequests = 0;
  const artifact = await sendReleaseCallback({
    payload,
    endpoint: "https://api.example.com/callback",
    token,
    currentManifestUrl: "https://datapack.example.com/catalog/current.json",
    retryDelaysSeconds: [60],
    sleep: async () => assert.fail("identity mismatch must not retry"),
    fetchImpl: async (url) => {
      if (url.includes("current.json")) {
        return new Response(JSON.stringify({
          channel: payload.channel,
          releaseSequence: payload.releaseSequence,
        }), { status: 200 });
      }
      callbackRequests += 1;
      return new Response(null, { status: 200 });
    },
  });

  assert.equal(artifact.state, "RECONCILIATION_REQUIRED");
  assert.equal(artifact.terminalReason, "CURRENT_RELEASE_IDENTITY_MISMATCH");
  assert.equal(callbackRequests, 0);
});

test("current가 callback sequence보다 뒤면 publish 전파를 기다렸다가 다시 확인한다", async () => {
  const previousBytes = Buffer.from(JSON.stringify({
    channel: payload.channel,
    releaseSequence: payload.releaseSequence - 1,
  }));
  const currentBytes = Buffer.from(JSON.stringify({
    channel: payload.channel,
    releaseSequence: payload.releaseSequence,
  }));
  const guardedPayload = {
    ...payload,
    manifestSha256: createHash("sha256").update(currentBytes).digest("hex"),
  };
  const slept = [];
  let currentChecks = 0;
  let callbackRequests = 0;

  const artifact = await sendReleaseCallback({
    payload: guardedPayload,
    endpoint: "https://api.example.com/callback",
    token,
    currentManifestUrl: "https://datapack.example.com/catalog/current.json",
    retryDelaysSeconds: [60],
    sleep: async (seconds) => slept.push(seconds),
    fetchImpl: async (url) => {
      if (url.includes("current.json")) {
        currentChecks += 1;
        return new Response(currentChecks === 1 ? previousBytes : currentBytes, { status: 200 });
      }
      callbackRequests += 1;
      return new Response(null, { status: 200 });
    },
  });

  assert.equal(artifact.state, "DELIVERED");
  assert.equal(currentChecks, 2);
  assert.equal(callbackRequests, 1);
  assert.deepEqual(slept, [60]);
  assert.equal(artifact.attempts[0].httpClass, "CURRENT_UNAVAILABLE");
});

test("CLI는 delivery state를 GitHub output에 기록한다", async () => {
  const currentBytes = Buffer.from(JSON.stringify({ channel: payload.channel, releaseSequence: payload.releaseSequence }));
  await withServer((request, response) => {
    if (request.url === "/catalog/current.json") return response.writeHead(200).end(currentBytes);
    return response.writeHead(200).end();
  }, async (endpoint) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "callback-sender-"));
    const stage = path.join(directory, "easysubway-datapack-stage");
    const payloadPath = path.join(stage, "release-callback.json");
    const artifactPath = path.join(stage, "release-callback-delivery.json");
    const githubOutputPath = path.join(directory, "github-output");
    await mkdir(stage, { recursive: true });
    await writeFile(payloadPath, JSON.stringify({
      ...payload,
      manifestSha256: createHash("sha256").update(currentBytes).digest("hex"),
    }));

    const exitCode = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [
        new URL("./send-release-callback.mjs", import.meta.url).pathname,
      ], {
        env: {
          ...process.env,
          RUNNER_TEMP: directory,
          GITHUB_OUTPUT: githubOutputPath,
          EASYSUBWAY_DATAPACK_CALLBACK_URL: endpoint,
          EASYSUBWAY_DATAPACK_WORKFLOW_TOKEN: token,
          EASYSUBWAY_DATA_PACK_BASE_URL: new URL(endpoint).origin,
        },
      });
      child.once("error", reject);
      child.once("exit", resolve);
    });

    assert.equal(exitCode, 0);
    assert.equal(await readFile(githubOutputPath, "utf8"), "state=DELIVERED\n");
    assert.equal(JSON.parse(await readFile(artifactPath, "utf8")).state, "DELIVERED");
  });
});

test("CLI는 terminal failure를 exit 2와 reconciliation output으로 기록한다", async () => {
  const currentBytes = Buffer.from(JSON.stringify({ channel: payload.channel, releaseSequence: payload.releaseSequence }));
  await withServer((request, response) => {
    if (request.url === "/catalog/current.json") return response.writeHead(200).end(currentBytes);
    return response.writeHead(400).end();
  }, async (endpoint) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "callback-sender-failure-"));
    const stage = path.join(directory, "easysubway-datapack-stage");
    const payloadPath = path.join(stage, "release-callback.json");
    const artifactPath = path.join(stage, "release-callback-delivery.json");
    const githubOutputPath = path.join(directory, "github-output");
    await mkdir(stage, { recursive: true });
    await writeFile(payloadPath, JSON.stringify({
      ...payload,
      manifestSha256: createHash("sha256").update(currentBytes).digest("hex"),
    }));

    const exitCode = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [
        new URL("./send-release-callback.mjs", import.meta.url).pathname,
      ], {
        env: {
          ...process.env,
          RUNNER_TEMP: directory,
          GITHUB_OUTPUT: githubOutputPath,
          EASYSUBWAY_DATAPACK_CALLBACK_URL: endpoint,
          EASYSUBWAY_DATAPACK_WORKFLOW_TOKEN: token,
          EASYSUBWAY_DATA_PACK_BASE_URL: new URL(endpoint).origin,
        },
      });
      child.once("error", reject);
      child.once("exit", resolve);
    });

    assert.equal(exitCode, 2);
    assert.equal(await readFile(githubOutputPath, "utf8"), "state=RECONCILIATION_REQUIRED\n");
    assert.equal(JSON.parse(await readFile(artifactPath, "utf8")).state, "RECONCILIATION_REQUIRED");
  });
});

test("CLI는 RUNNER_TEMP 밖의 GitHub output 경로를 거부한다", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "callback-sender-boundary-"));
  const outside = path.join(os.tmpdir(), `github-output-${path.basename(directory)}`);
  const stderr = [];
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      new URL("./send-release-callback.mjs", import.meta.url).pathname,
    ], {
      env: {
        ...process.env,
        RUNNER_TEMP: directory,
        GITHUB_OUTPUT: outside,
      },
    });
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("exit", resolve);
  });

  assert.equal(exitCode, 1);
  assert.match(Buffer.concat(stderr).toString("utf8"), /GITHUB_OUTPUT must be inside RUNNER_TEMP/);
});
