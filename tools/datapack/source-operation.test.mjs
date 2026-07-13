import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  listOperations,
  operationSummary,
  providerApprovalExpirySummary,
  validateOperation,
  validateSourceCandidateDocument,
} from "./source-operation.mjs";
import * as sourceOperation from "./source-operation.mjs";

const FUTURE_APPROVAL_DATE = new Date(Date.now() + (366 * 24 * 60 * 60 * 1000)).toISOString().slice(0, 10);

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

function providerApproval(overrides = {}) {
  return {
    status: "APPROVED",
    approvalScope: "API_CREDENTIAL",
    termsStatus: "REVIEW_REQUIRED",
    quotaStatus: "REVIEW_REQUIRED",
    productionUseAllowed: false,
    serviceId: "handicapped",
    operationId: "transferMovement",
    validFrom: "2020-01-01",
    validTo: FUTURE_APPROVAL_DATE,
    renewalNoticeDays: 30,
    evidenceReferences: [{
      type: "OWNER_CONFIRMATION",
      url: "https://github.com/AquilaXk/easysubway/issues/1397#issuecomment-4956908695",
    }],
    recordedAt: "2026-07-13",
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

test("source candidate 정본은 repository 경로와 구조화된 provider 승인을 검증한다", () => {
  const document = {
    schemaVersion: 1,
    artifactKind: "production-source-candidates",
    source: "tools/datapack/source-candidates.json",
    updatedAt: "2026-07-13",
    candidates: [candidate("a", {
      providerApproval: providerApproval(),
    })],
  };

  assert.equal(validateSourceCandidateDocument(document), document);
  assert.deepEqual(operationSummary(document.candidates[0]).providerApproval, document.candidates[0].providerApproval);
});

test("provider 승인은 잘못된 기간과 secret-like field를 거부한다", () => {
  const base = {
    schemaVersion: 1,
    artifactKind: "production-source-candidates",
    source: "tools/datapack/source-candidates.json",
    updatedAt: "2026-07-13",
  };
  const approval = providerApproval({
    validFrom: "2027-07-06",
    validTo: "2026-07-06",
  });

  assert.throws(
    () => validateSourceCandidateDocument({ ...base, candidates: [candidate("a", { providerApproval: approval })] }),
    /validTo must not precede validFrom/,
  );
  assert.throws(
    () => validateSourceCandidateDocument({
      ...base,
      candidates: [candidate("a", { providerApproval: { ...approval, validTo: "2028-07-06", serviceKey: "secret" } })],
    }),
    /secret-like values are forbidden/,
  );
  assert.throws(
    () => validateSourceCandidateDocument({
      ...base,
      candidates: [candidate("a", { providerApproval: { ...approval, validTo: "2028-07-06", recordedAt: "2026-02-31" } })],
    }),
    /recordedAt must be an ISO date/,
  );
  assert.throws(
    () => validateSourceCandidateDocument({
      ...base,
      candidates: [candidate("a", {
        providerApproval: providerApproval({ termsStatus: "APPROVED", quotaStatus: "APPROVED" }),
      })],
    }),
    /productionUseAllowed must match credential, terms, and quota decisions/,
  );
  assert.throws(
    () => validateSourceCandidateDocument({
      ...base,
      candidates: [candidate("a", {
        providerApproval: providerApproval({ evidenceReferences: [{ type: "OWNER_CONFIRMATION", url: "chat-only" }] }),
      })],
    }),
    /evidenceReferences\[0\]\.url must be a valid HTTP\(S\) URL/,
  );
  const expiredApproval = {
    ...approval,
    validFrom: "2020-01-01",
    validTo: "2020-12-31",
  };
  assert.throws(
    () => validateSourceCandidateDocument({
      ...base,
      candidates: [candidate("a", { providerApproval: expiredApproval })],
    }),
    /status is APPROVED but validTo has expired/,
  );
  const historical = { ...expiredApproval, status: "EXPIRED" };
  assert.equal(
    validateSourceCandidateDocument({ ...base, candidates: [candidate("a", { providerApproval: historical })] })
      .candidates[0].providerApproval,
    historical,
  );
  const futureStart = new Date(Date.now() + (366 * 24 * 60 * 60 * 1000)).toISOString().slice(0, 10);
  const futureEnd = new Date(Date.now() + (732 * 24 * 60 * 60 * 1000)).toISOString().slice(0, 10);
  assert.throws(
    () => validateSourceCandidateDocument({
      ...base,
      candidates: [candidate("a", {
        providerApproval: { ...approval, validFrom: futureStart, validTo: futureEnd },
      })],
    }),
    /status is APPROVED but validFrom is in the future/,
  );
});

test("summary는 provider 승인에 secret-like 값이 있으면 출력 전에 거부한다", () => {
  assert.throws(
    () => operationSummary(candidate("a", {
      providerApproval: providerApproval({
        serviceKey: "actual-secret-value",
      }),
    })),
    /secret-like values are forbidden/,
  );
});

test("provider 승인은 service와 operation이 endpoint 경로와 일치해야 한다", () => {
  const endpoint = "https://provider.example/handicapped/transferMovement";
  const approval = providerApproval();
  const approvedCandidate = candidate("approved", {
    requestUrl: endpoint,
    operation: validOperation({ endpoint }),
    providerApproval: approval,
  });

  assert.equal(validateSourceCandidateDocument({
    schemaVersion: 1,
    artifactKind: "production-source-candidates",
    source: "tools/datapack/source-candidates.json",
    updatedAt: "2026-07-13",
    candidates: [approvedCandidate],
  }).candidates[0], approvedCandidate);

  for (const providerApproval of [
    { ...approval, serviceId: "different-service" },
    { ...approval, operationId: "different-operation" },
  ]) {
    assert.throws(
      () => validateSourceCandidateDocument({
        schemaVersion: 1,
        artifactKind: "production-source-candidates",
        source: "tools/datapack/source-candidates.json",
        updatedAt: "2026-07-13",
        candidates: [{ ...approvedCandidate, providerApproval }],
      }),
      /providerApproval serviceId\/operationId must match operation endpoint path/,
    );
  }
});

test("provider 승인 만료 요약은 갱신 window부터 경고한다", () => {
  const endpoint = "https://provider.example/handicapped/transferMovement";
  const document = {
    schemaVersion: 1,
    artifactKind: "production-source-candidates",
    source: "tools/datapack/source-candidates.json",
    updatedAt: "2026-07-13",
    candidates: [candidate("approved", {
      requestUrl: endpoint,
      operation: validOperation({ endpoint }),
      providerApproval: providerApproval({
        validFrom: "2026-07-06",
        validTo: "2027-07-06",
      }),
    })],
  };

  assert.equal(providerApprovalExpirySummary(document, { today: "2027-06-05" }).status, "OK");
  assert.deepEqual(providerApprovalExpirySummary(document, { today: "2027-06-06" }), {
    status: "WARNING",
    approvals: [{
      candidateId: "approved",
      validTo: "2027-07-06",
      daysUntilExpiry: 30,
      renewalNoticeDays: 30,
    }],
  });
  assert.throws(
    () => providerApprovalExpirySummary(document, { today: "2027-07-07" }),
    /status is APPROVED but validTo has expired/,
  );
});

test("KRIC key 계약은 URLSearchParams 1회 인코딩과 shell parsing 금지를 고정한다", () => {
  const operation = validOperation({
    auth: {
      env: "KRIC_SERVICE_KEY",
      placement: "query",
      parameter: "serviceKey",
      valueEncoding: "url-search-params-once",
      loadPolicy: "process-env-no-shell-parsing",
    },
    runner: {
      command: "node tools/datapack/probe-provider.mjs",
      requiredEnv: ["KRIC_SERVICE_KEY"],
    },
  });

  assert.equal(validateOperation(candidate("a", { operation })), operation);
  const summary = operationSummary(candidate("a", { operation }));
  assert.match(summary.operation.auth.loadPolicy, /no-shell-parsing/);
  assert.match(sourceOperation.operationHumanSummary(summary), /^provider approval: none$/m);
  assert.match(sourceOperation.operationHumanSummary(summary), /^auth value encoding: url-search-params-once$/m);
  assert.match(sourceOperation.operationHumanSummary(summary), /^auth load policy: process-env-no-shell-parsing$/m);
});

test("승인된 provider의 human 요약은 승인 범위와 기간을 표시한다", () => {
  const summary = operationSummary(candidate("a", {
    providerApproval: providerApproval(),
  }));

  assert.match(sourceOperation.operationHumanSummary(summary), /^provider approval: APPROVED$/m);
  assert.match(sourceOperation.operationHumanSummary(summary), /^provider operation: handicapped\/transferMovement$/m);
  assert.match(
    sourceOperation.operationHumanSummary(summary),
    new RegExp(`^approval valid: 2020-01-01\\.\\.${FUTURE_APPROVAL_DATE}$`, "m"),
  );
});

test("list는 만료 상태 오류를 candidate에 남기고 다른 provider를 계속 반환한다", () => {
  const expired = candidate("expired", {
    providerApproval: providerApproval({
      validFrom: "2020-01-01",
      validTo: "2020-12-31",
      recordedAt: "2020-01-01",
    }),
  });

  const invalidOperation = candidate("invalid-operation", {
    operation: validOperation({ endpoint: "https://provider.example/wrong" }),
  });
  const rows = listOperations({ candidates: [candidate("active"), expired, invalidOperation] });

  assert.deepEqual(rows.map(({ id }) => id), ["active", "expired", "invalid-operation"]);
  assert.equal(rows[0].providerApprovalValidationError, null);
  assert.match(rows[1].providerApprovalValidationError, /status is APPROVED but validTo has expired/);
  assert.match(sourceOperation.operationHumanSummary(rows[1]), /^provider approval validation: .*has expired$/m);
  assert.match(rows[2].operationValidationError, /endpoint must match requestUrl/);
  assert.match(sourceOperation.operationHumanSummary(rows[2]), /^operation validation: .*endpoint must match requestUrl$/m);
});

test("잘못된 operation human 요약은 TypeError 대신 validation 오류를 표시한다", () => {
  const endpoint = "https://provider.example/invalid";
  const summary = operationSummary(candidate("invalid", {
    operation: validOperation({ endpoint, auth: null }),
  }));

  assert.doesNotThrow(() => sourceOperation.operationHumanSummary(summary));
  assert.match(
    sourceOperation.operationHumanSummary(summary),
    /^operation validation: invalid\.operation\.auth must be an object$/m,
  );
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

test("validate는 structured runner 인수의 credential option을 거부한다", () => {
  for (const arguments_ of [
    ["--token", "actual-secret-value"],
    ["--service-key=actual-secret-value"],
    ["--client_secret", "actual-secret-value"],
  ]) {
    assert.throws(
      () => validateOperation(candidate("a", {
        operation: validOperation({
          runner: {
            command: "node tools/datapack/probe-provider.mjs",
            arguments: arguments_,
            requiredEnv: ["PROVIDER_SERVICE_KEY"],
          },
        }),
      })),
      /runner\.arguments must not include credential options/,
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
