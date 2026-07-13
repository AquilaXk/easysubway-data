import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  listOperations,
  operationSummary,
  validateOperation,
} from "./source-operation.mjs";
import * as sourceOperation from "./source-operation.mjs";

function candidate(id, overrides = {}) {
  return {
    id,
    admissionStatus: "admitted_to_production_inventory",
    requestUrl: `https://provider.example/${id}`,
    evidence: {
      outputFields: ["fieldA"],
      sampleUrl: `https://provider.example/${id}?serviceKey=[서비스키값]`,
    },
    ...overrides,
  };
}

function validOperation(overrides = {}) {
  return {
    method: "GET",
    endpoint: "https://provider.example/a",
    auth: {
      env: "PROVIDER_SERVICE_KEY",
      placement: "query",
      parameter: "serviceKey",
    },
    requiredParameters: ["serviceKey"],
    responseEnvelope: "response.body.items.item",
    runner: {
      command: "node tools/datapack/probe-provider.mjs",
      requiredEnv: ["PROVIDER_SERVICE_KEY"],
    },
    secretPolicy: "env-only-redacted-output",
    ...overrides,
  };
}

test("list는 requestUrl이 있는 source를 ID 순으로 반환한다", () => {
  const document = {
    candidates: [candidate("b"), { id: "local-file" }, candidate("a")],
  };

  assert.deepEqual(
    listOperations(document).map((row) => row.id),
    ["a", "b"],
  );
});

test("show는 operation이 없어도 기존 endpoint와 response fields를 반환한다", () => {
  const summary = operationSummary(candidate("a"));

  assert.equal(summary.endpoint, "https://provider.example/a");
  assert.equal(
    summary.sampleUrl,
    "https://provider.example/a?serviceKey=[서비스키값]",
  );
  assert.deepEqual(summary.responseFields, ["fieldA"]);
  assert.equal(summary.operation, null);
});

test("show는 operation이 없어도 sample URL credential을 출력 전에 거부한다", () => {
  for (const sampleUrl of [
    "https://provider.example/actual-secret/items",
    "https://provider.example/items?X-Amz-Security-Token=actual-secret",
  ]) {
    const invalid = candidate("a", {
      requestUrl: "https://provider.example/{serviceKey}/items",
      evidence: { outputFields: ["fieldA"], sampleUrl },
    });

    assert.throws(
      () => operationSummary(invalid),
      /credential values are forbidden/,
    );
  }
});

test("show는 operation이 없어도 request URL credential을 출력 전에 거부한다", () => {
  for (const requestUrl of [
    "https://provider.example/items?serviceKey=actual-secret",
    "https://provider.example/items?key=actual-secret",
    "https://user:password@provider.example/items",
  ]) {
    assert.throws(
      () => operationSummary(candidate("a", {
        requestUrl,
        evidence: { outputFields: ["fieldA"] },
      })),
      /credential values are forbidden/,
    );
  }
});

test("validate는 credential 값을 거부한다", () => {
  const invalid = candidate("a", {
    operation: validOperation({ credentialValue: "actual-secret-value" }),
  });

  assert.throws(
    () => validateOperation(invalid),
    /credential values are forbidden/,
  );
});

test("validate는 nested auth credential 값도 거부한다", () => {
  for (const field of ["token", "client_secret", "refresh_token", "x-api-key"]) {
    const operation = validOperation();
    operation.auth[field] = "actual-secret-value";
    const invalid = candidate("a", { operation });

    assert.throws(
      () => validateOperation(invalid),
      /credential values are forbidden/,
    );
  }
});

test("validate는 endpoint URL과 runner 문자열의 credential을 거부한다", () => {
  for (const operation of [
    validOperation({
      endpoint: "https://provider.example/a?client_secret=actual-secret",
    }),
    validOperation({
      endpoint: "https://user:password@provider.example/a",
    }),
    validOperation({
      runner: {
        command: "node tools/datapack/probe-provider.mjs --token actual-secret",
        requiredEnv: ["PROVIDER_SERVICE_KEY"],
      },
    }),
  ]) {
    assert.throws(
      () => validateOperation(candidate("a", { requestUrl: operation.endpoint, operation })),
      /credential values are forbidden|literal repository Node command/,
    );
  }
});

test("validate는 credential-free operation을 명시적으로 허용한다", () => {
  const publicOperation = validOperation({
    auth: { placement: "none" },
    requiredParameters: [],
    runner: {
      command: "node tools/datapack/probe-provider.mjs",
      requiredEnv: [],
    },
    secretPolicy: "credential-free-output",
  });

  assert.equal(
    validateOperation(candidate("a", { operation: publicOperation })),
    publicOperation,
  );
});

test("validate는 operation endpoint mismatch를 거부한다", () => {
  const invalid = candidate("a", {
    operation: validOperation({ endpoint: "https://provider.example/wrong" }),
  });

  assert.throws(
    () => validateOperation(invalid),
    /endpoint must match requestUrl/,
  );
});

test("validate는 실행할 수 없는 provider URL을 거부한다", () => {
  for (const endpoint of ["https://", "http:// not-a-host", "ftp://provider.example/a"]) {
    assert.throws(
      () => validateOperation(candidate("a", {
        requestUrl: endpoint,
        operation: validOperation({ endpoint }),
      })),
      /valid HTTP\(S\) URL/,
    );
  }
});

test("validate는 requiredEnv의 실제 환경변수 이름만 허용한다", () => {
  const invalid = candidate("a", {
    operation: validOperation({
      runner: {
        command: "node tools/datapack/probe-provider.mjs",
        requiredEnv: ["PROVIDER_SERVICE_KEY", "actual-secret-value"],
      },
    }),
  });

  assert.throws(
    () => validateOperation(invalid),
    /requiredEnv must contain environment variable names/,
  );
});

test("credential-free operation human 출력은 auth env가 불필요함을 표시한다", () => {
  assert.equal(typeof sourceOperation.operationHumanSummary, "function");
  const summary = operationSummary(candidate("a", {
    operation: validOperation({
      auth: { placement: "none" },
      requiredParameters: [],
      runner: {
        command: "node tools/datapack/probe-provider.mjs",
        requiredEnv: [],
      },
      secretPolicy: "credential-free-output",
    }),
  }));

  assert.match(sourceOperation.operationHumanSummary(summary), /^auth env: not required$/m);
});

test("공식 OD fare source는 재현 가능한 operation과 조회 명령을 고정한다", async () => {
  const candidates = JSON.parse(
    await readFile(new URL("./source-candidates.json", import.meta.url), "utf8"),
  );
  const runbook = JSON.parse(
    await readFile(new URL("./source-admission-runbook.json", import.meta.url), "utf8"),
  );
  const fare = candidates.candidates.find(
    (entry) => entry.id === "seoul-metro-official-od-fares",
  );

  assert.deepEqual(fare.operation.auth, {
    env: "DATA_GO_KR_SERVICE_KEY",
    placement: "query",
    parameter: "serviceKey",
  });
  assert.deepEqual(fare.operation.requiredParameters, [
    "serviceKey",
    "pageNo",
    "numOfRows",
    "dataType",
    "dptreStnNm",
    "arvlStnNm",
  ]);
  assert.equal(fare.operation.responseEnvelope, "response.body.items.item");
  assert.deepEqual(fare.operation.runner, {
    command: "node tools/datapack/probe-seoul-fare-api.mjs",
    requiredEnv: ["DATA_GO_KR_SERVICE_KEY", "FARE_API_PROBE_OUTPUT"],
  });
  assert.equal(
    runbook.operationLookupCommand,
    "node tools/ci/api-catalog.mjs show provider:<sourceId>",
  );
});
