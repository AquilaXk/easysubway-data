import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";

import {
  formatSecretSyncReasonLine,
  SECRET_SYNC_REASON,
} from "./failure-reason.mjs";
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

test("인자·누락·invalid token·불일치 key pair는 sync 전에 같은 sanitized error와 비기밀 사유 코드로 닫는다", async () => {
  const base = fixtureEnv();
  const cases = [
    {
      argv: ["unexpected"],
      env: base,
      expectedReason: SECRET_SYNC_REASON.ARGUMENT_INVALID,
      expectedSecret: undefined,
      expectedLine: "reason=ARGUMENT_INVALID",
    },
    {
      argv: [],
      env: null,
      expectedReason: SECRET_SYNC_REASON.ARGUMENT_INVALID,
      expectedSecret: undefined,
      expectedLine: "reason=ARGUMENT_INVALID",
    },
    {
      argv: [],
      env: { ...base, KRIC_SERVICE_KEY: "" },
      expectedReason: SECRET_SYNC_REASON.SECRET_INVALID,
      expectedSecret: "KRIC_SERVICE_KEY",
      expectedLine: "reason=SECRET_INVALID secret=KRIC_SERVICE_KEY",
    },
    {
      argv: [],
      env: { ...base, DATA_GO_KR_SERVICE_KEY: "bad\nvalue" },
      expectedReason: SECRET_SYNC_REASON.SECRET_INVALID,
      expectedSecret: "DATA_GO_KR_SERVICE_KEY",
      expectedLine: "reason=SECRET_INVALID secret=DATA_GO_KR_SERVICE_KEY",
    },
    {
      argv: [],
      env: { ...base, EASYSUBWAY_DATAPACK_SIGNING_KEY_ID: "bad\rvalue" },
      expectedReason: SECRET_SYNC_REASON.SECRET_INVALID,
      expectedSecret: "EASYSUBWAY_DATAPACK_SIGNING_KEY_ID",
      expectedLine: "reason=SECRET_INVALID secret=EASYSUBWAY_DATAPACK_SIGNING_KEY_ID",
    },
    {
      argv: [],
      env: { ...base, EASYSUBWAY_SEOUL_TOPIS_SERVICE_KEY: "bad\nvalue" },
      expectedReason: SECRET_SYNC_REASON.SECRET_INVALID,
      expectedSecret: "EASYSUBWAY_SEOUL_TOPIS_SERVICE_KEY",
      expectedLine: "reason=SECRET_INVALID secret=EASYSUBWAY_SEOUL_TOPIS_SERVICE_KEY",
    },
    {
      argv: [],
      env: { ...base, EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM: "not-a-key" },
      expectedReason: SECRET_SYNC_REASON.SECRET_INVALID,
      expectedSecret: "EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM",
      expectedLine: "reason=SECRET_INVALID secret=EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM",
    },
    {
      argv: [],
      env: {
        ...base,
        EASYSUBWAY_DATAPACK_SIGNING_PUBLIC_KEY_PEM:
          base.EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM,
      },
      expectedReason: SECRET_SYNC_REASON.SECRET_INVALID,
      expectedSecret: "EASYSUBWAY_DATAPACK_SIGNING_PUBLIC_KEY_PEM",
      expectedLine: "reason=SECRET_INVALID secret=EASYSUBWAY_DATAPACK_SIGNING_PUBLIC_KEY_PEM",
    },
    {
      argv: [],
      env: {
        ...base,
        EASYSUBWAY_DATAPACK_SIGNING_PUBLIC_KEY_PEM:
          fixtureEnv().EASYSUBWAY_DATAPACK_SIGNING_PUBLIC_KEY_PEM,
      },
      expectedReason: SECRET_SYNC_REASON.SECRET_INVALID,
      expectedSecret: "EASYSUBWAY_DATAPACK_SIGNING_PUBLIC_KEY_PEM",
      expectedLine: "reason=SECRET_INVALID secret=EASYSUBWAY_DATAPACK_SIGNING_PUBLIC_KEY_PEM",
    },
  ];

  for (const fixture of cases) {
    let syncCount = 0;
    await assert.rejects(
      syncDatapackReleaseCheckSecrets({
        argv: fixture.argv,
        env: fixture.env,
        syncImpl: async () => { syncCount += 1; },
      }),
      (error) => {
        assert.equal(error.message, "Data Pack candidate secret synchronization failed");
        assert.equal(error.reason, fixture.expectedReason);
        assert.equal(error.secret, fixture.expectedSecret);
        const reasonLine = formatSecretSyncReasonLine(error, secretNames);
        assert.equal(reasonLine, fixture.expectedLine);
        for (const value of Object.values(fixture.env ?? {})) {
          if (value) {
            assert.equal(error.message.includes(value), false);
            assert.equal(reasonLine.includes(value), false);
          }
        }
        return true;
      },
    );
    assert.equal(syncCount, 0);
  }
});

test("gh secret set 실패는 secret 값과 하위 오류를 숨기고 GH_SYNC_FAILED와 secret 이름으로 구분한다", async () => {
  const env = fixtureEnv();
  await assert.rejects(
    syncDatapackReleaseCheckSecrets({
      env,
      syncImpl: async ({ secretName }) => {
        if (secretName === "DATA_GO_KR_SERVICE_KEY") {
          throw new Error(`gh failed for ${env.DATA_GO_KR_SERVICE_KEY}`);
        }
      },
    }),
    (error) => {
      assert.equal(error.message, "Data Pack candidate secret synchronization failed");
      assert.equal(error.reason, SECRET_SYNC_REASON.GH_SYNC_FAILED);
      assert.equal(error.secret, "DATA_GO_KR_SERVICE_KEY");
      const reasonLine = formatSecretSyncReasonLine(error, secretNames);
      assert.equal(reasonLine, "reason=GH_SYNC_FAILED secret=DATA_GO_KR_SERVICE_KEY");
      assert.equal(error.message.includes(env.DATA_GO_KR_SERVICE_KEY), false);
      assert.equal(reasonLine.includes(env.DATA_GO_KR_SERVICE_KEY), false);
      return true;
    },
  );

  assert.equal(
    formatSecretSyncReasonLine({ reason: "UNKNOWN_REASON", secret: env.KRIC_SERVICE_KEY }, secretNames),
    "reason=INTERNAL_ERROR",
  );
});

