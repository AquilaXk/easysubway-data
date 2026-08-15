import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";

import {
  syncDatapackReleaseCheckSecrets,
} from "./sync-datapack-release-check-secrets.mjs";

const secretNames = [
  "EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM",
  "EASYSUBWAY_DATAPACK_SIGNING_PUBLIC_KEY_PEM",
  "EASYSUBWAY_DATAPACK_SIGNING_KEY_ID",
  "EASYSUBWAY_SEOUL_TOPIS_SERVICE_KEY",
  "DATA_GO_KR_SERVICE_KEY",
  "KRIC_SERVICE_KEY",
];

function fixtureEnv() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM: privateKey.export({
      type: "pkcs8",
      format: "pem",
    }).toString(),
    EASYSUBWAY_DATAPACK_SIGNING_PUBLIC_KEY_PEM: publicKey.export({
      type: "spki",
      format: "pem",
    }).toString(),
    EASYSUBWAY_DATAPACK_SIGNING_KEY_ID: "production-v1",
    EASYSUBWAY_SEOUL_TOPIS_SERVICE_KEY: "topis-test-key",
    DATA_GO_KR_SERVICE_KEY: "data-go-test-key",
    KRIC_SERVICE_KEY: "kric-test-key",
  };
}

test("candidate release environment의 exact six secrets를 값 비노출 sync 경계로 전달한다", async () => {
  const env = fixtureEnv();
  const calls = [];

  const result = await syncDatapackReleaseCheckSecrets({
    env,
    syncImpl: async (input) => calls.push(input),
  });

  assert.deepEqual(result, {
    repository: "AquilaXk/easysubway-data",
    environment: "datapack-release-check",
    secretNames,
  });
  assert.deepEqual(calls.map(({ secretName }) => secretName), secretNames);
  for (const call of calls) {
    assert.equal(call.ghRepository, "github.com/AquilaXk/easysubway-data");
    assert.equal(call.environment, "datapack-release-check");
    assert.equal(call.serviceKey, env[call.secretName]);
    assert.equal(call.env, env);
    assert.equal(call.failureMessage, "Data Pack candidate secret synchronization failed");
  }
  const publicResult = JSON.stringify(result);
  for (const value of Object.values(env)) assert.equal(publicResult.includes(value), false);
});

test("percent-encoded DATA_GO/KRIC key는 canonical decoded 값으로 sync한다", async () => {
  const env = {
    ...fixtureEnv(),
    DATA_GO_KR_SERVICE_KEY: "data%2Bgo",
    KRIC_SERVICE_KEY: "kric%2Fkey",
  };
  const calls = [];

  await syncDatapackReleaseCheckSecrets({
    env,
    syncImpl: async (input) => calls.push(input),
  });

  assert.equal(
    calls.find(({ secretName }) => secretName === "DATA_GO_KR_SERVICE_KEY").serviceKey,
    "data+go",
  );
  assert.equal(
    calls.find(({ secretName }) => secretName === "KRIC_SERVICE_KEY").serviceKey,
    "kric/key",
  );
});

test("인자·누락·invalid token·불일치 key pair는 sync 전에 같은 sanitized error로 닫는다", async () => {
  const base = fixtureEnv();
  const cases = [
    { argv: ["unexpected"], env: base },
    { argv: [], env: { ...base, KRIC_SERVICE_KEY: "" } },
    { argv: [], env: { ...base, DATA_GO_KR_SERVICE_KEY: "bad\nvalue" } },
    { argv: [], env: { ...base, EASYSUBWAY_DATAPACK_SIGNING_KEY_ID: "bad\rvalue" } },
    { argv: [], env: { ...base, EASYSUBWAY_SEOUL_TOPIS_SERVICE_KEY: "bad\nvalue" } },
    { argv: [], env: { ...base, EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM: "not-a-key" } },
    {
      argv: [],
      env: {
        ...base,
        EASYSUBWAY_DATAPACK_SIGNING_PUBLIC_KEY_PEM:
          base.EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM,
      },
    },
    {
      argv: [],
      env: {
        ...base,
        EASYSUBWAY_DATAPACK_SIGNING_PUBLIC_KEY_PEM:
          fixtureEnv().EASYSUBWAY_DATAPACK_SIGNING_PUBLIC_KEY_PEM,
      },
    },
  ];

  for (const fixture of cases) {
    let syncCount = 0;
    await assert.rejects(
      syncDatapackReleaseCheckSecrets({
        ...fixture,
        syncImpl: async () => { syncCount += 1; },
      }),
      (error) => {
        assert.equal(error.message, "Data Pack candidate secret synchronization failed");
        for (const value of Object.values(fixture.env)) {
          if (value) assert.equal(error.message.includes(value), false);
        }
        return true;
      },
    );
    assert.equal(syncCount, 0);
  }
});
