import assert from "node:assert/strict";
import test from "node:test";

import {
  assertProviderBlockerPromotable,
  assertProviderCredentialIntegrity,
  classifyProviderFailure,
  CONTROL_OPERATION_STATUSES,
  formatProviderFailureEvidence,
  PROVIDER_FAILURE_CLASSIFICATIONS,
  providerCredentialShape,
  requiresControlOperation,
  resolveProviderCallIntegrity,
  validateProviderBlockedEvidence,
} from "./provider-call-integrity.mjs";

const CREDENTIAL = "Aa0$Aa0$Aa0$Aa0$";

const CREDENTIAL_CONTRACT = Object.freeze({
  env: "KRIC_SERVICE_KEY",
  length: 16,
  characterClasses: ["digit", "lower", "symbol", "upper"],
  fingerprintAlgorithm: "sha256-12",
  fingerprint: null,
});

const CONTROL_OPERATION = Object.freeze({
  candidateId: "kric-station-convenience-standard",
  endpoint: "https://openapi.kric.go.kr/openapi/handicapped/stationCnvFacl",
  sampleUrl: "https://openapi.kric.go.kr/openapi/handicapped/stationCnvFacl?serviceKey=[서비스키값]&format=json&railOprIsttCd=S1&lnCd=3&stinCd=322",
  expectedSuccess: { minimumRowCount: 1, requiredFields: ["dtlLoc", "gubun", "stinFlor"] },
  verifiedAt: "2026-08-02",
});

// 실제 자격증명처럼 보이지 않는 명백한 더미. 실키는 어떤 형태로도 두지 않는다.
const DUMMY_CREDENTIAL = "DUMMY-NOT-A-CREDENTIAL";

function document(overrides = {}) {
  return documentWithControlOperation(
    { ...CONTROL_OPERATION, ...overrides.controlOperation },
    { ...CREDENTIAL_CONTRACT, ...overrides.credential },
  );
}

const CREDENTIAL_SIGNAL_RESULT_CODES = Object.freeze(["30"]);

const PROVIDER_BLOCKED_EVIDENCE = Object.freeze({
  providerId: "kric",
  sourceId: "kric-station-elevator",
  failureClassification: "authorization-missing",
  lastVerifiedAt: "2026-08-04T00:00:00.000Z",
  reverifyAfter: "2026-08-05T00:00:00.000Z",
  expiresAt: "2026-08-06T00:00:00.000Z",
  controlOperationId: "kric-station-convenience-standard",
  credentialFingerprint: null,
  sanitizedEvidenceSha256: "a".repeat(64),
});

function documentWithControlOperation(controlOperation, credential = CREDENTIAL_CONTRACT) {
  return {
    providers: {
      kric: { credential, controlOperation, credentialSignalResultCodes: [...CREDENTIAL_SIGNAL_RESULT_CODES] },
    },
  };
}

test("provider credential shape는 값이 아니라 길이·문자 클래스·지문만 노출한다", () => {
  const shape = providerCredentialShape(CREDENTIAL);
  assert.deepEqual(Object.keys(shape).sort(), ["characterClasses", "fingerprint", "length"]);
  assert.equal(shape.length, 16);
  assert.deepEqual(shape.characterClasses, ["digit", "lower", "symbol", "upper"]);
  assert.match(shape.fingerprint, /^[0-9a-f]{12}$/);
  assert.equal(shape.fingerprint, providerCredentialShape(CREDENTIAL).fingerprint);
  assert.notEqual(shape.fingerprint, providerCredentialShape(`${CREDENTIAL}x`).fingerprint);
  assert.doesNotMatch(JSON.stringify(shape), new RegExp(CREDENTIAL.replace(/\$/g, "\\$")));
});

test("provider credential 사전 검사는 절단·따옴표 유실·셸 확장을 호출 전에 막는다", () => {
  const contract = CREDENTIAL_CONTRACT;
  assert.deepEqual(
    assertProviderCredentialIntegrity({ providerId: "kric", credential: CREDENTIAL, contract }),
    { length: 16, characterClasses: ["digit", "lower", "symbol", "upper"], fingerprintPinned: false },
  );

  assert.throws(
    () => assertProviderCredentialIntegrity({ providerId: "kric", credential: CREDENTIAL.slice(0, 15), contract }),
    /kric credential length does not match the catalog contract/,
  );
  assert.throws(
    () => assertProviderCredentialIntegrity({ providerId: "kric", credential: `"${CREDENTIAL}"`, contract }),
    /kric credential length does not match the catalog contract/,
  );
  assert.throws(
    () => assertProviderCredentialIntegrity({ providerId: "kric", credential: "aaaaaaaaaaaaaaaa", contract }),
    /kric credential character classes do not match the catalog contract/,
  );
  assert.throws(
    () => assertProviderCredentialIntegrity({ providerId: "kric", credential: `${CREDENTIAL.slice(0, 15)}\n`, contract }),
    /kric credential shape is invalid/,
  );
  assert.throws(
    () => assertProviderCredentialIntegrity({ providerId: "kric", credential: "", contract }),
    /kric credential shape is invalid/,
  );
});

test("pinned fingerprint는 형상이 같은 다른 키를 거부하고 오류에 값을 남기지 않는다", () => {
  const fingerprint = providerCredentialShape(CREDENTIAL).fingerprint;
  const contract = { ...CREDENTIAL_CONTRACT, fingerprint };
  const rotated = "Bb1$Bb1$Bb1$Bb1$";
  assert.equal(providerCredentialShape(rotated).length, 16);

  assert.equal(
    assertProviderCredentialIntegrity({ providerId: "kric", credential: CREDENTIAL, contract }).fingerprintPinned,
    true,
  );
  assert.throws(
    () => assertProviderCredentialIntegrity({ providerId: "kric", credential: rotated, contract }),
    (error) => {
      assert.match(error.message, /kric credential fingerprint does not match the catalog contract/);
      assert.doesNotMatch(error.message, /Bb1/);
      return true;
    },
  );
});

test("provider 호출 정합성 계약은 카탈로그에서만 나오고 형상이 어긋나면 fail-closed한다", () => {
  const resolved = resolveProviderCallIntegrity(document(), "kric");
  assert.deepEqual(resolved.credential, CREDENTIAL_CONTRACT);
  assert.equal(resolved.controlOperation.candidateId, CONTROL_OPERATION.candidateId);
  assert.equal(resolved.controlOperation.format, "json");
  assert.deepEqual(resolved.controlOperation.expectedSuccess, CONTROL_OPERATION.expectedSuccess);
  assert.deepEqual(resolved.credentialSignalResultCodes, CREDENTIAL_SIGNAL_RESULT_CODES);

  assert.equal(resolveProviderCallIntegrity({}, "kric", { required: false }), null);
  assert.throws(
    () => resolveProviderCallIntegrity({}, "kric"),
    /provider call integrity contract is missing: kric/,
  );
  assert.throws(
    () => resolveProviderCallIntegrity(document({ credential: { fingerprint: "ZZZ" } }), "kric"),
    /kric.credential.fingerprint must be a 12 character hex fingerprint or null/,
  );
  assert.throws(
    () => resolveProviderCallIntegrity(document({ credential: { characterClasses: ["upper", "digit"] } }), "kric"),
    /kric.credential.characterClasses must be sorted/,
  );
  assert.throws(
    () => resolveProviderCallIntegrity(document({ controlOperation: { sampleUrl: `${CONTROL_OPERATION.endpoint}?format=json` } }), "kric"),
    /kric.controlOperation.sampleUrl must contain exactly one redacted serviceKey/,
  );
  assert.throws(
    () => resolveProviderCallIntegrity(document({ controlOperation: { endpoint: "https://openapi.kric.go.kr/openapi/handicapped/stationMovement" } }), "kric"),
    /kric.controlOperation.sampleUrl must use the control operation endpoint/,
  );
});

test("실패 분류는 5개 값과 근거를 함께 남긴다", () => {
  assert.deepEqual(PROVIDER_FAILURE_CLASSIFICATIONS, [
    "request-error",
    "authentication-error",
    "authorization-missing",
    "no-data",
    "transport-error",
  ]);
  assert.deepEqual(CONTROL_OPERATION_STATUSES, ["succeeded", "failed", "not-run", "self-succeeded"]);

  assert.equal(classifyProviderFailure({ httpStatus: null }).classification, "transport-error");
  assert.equal(classifyProviderFailure({ httpStatus: 503 }).classification, "transport-error");
  assert.equal(classifyProviderFailure({ httpStatus: 404 }).classification, "request-error");
  assert.equal(
    classifyProviderFailure({ httpStatus: 200, providerResultSignal: "invalid-parameter" }).classification,
    "request-error",
  );
  assert.equal(
    classifyProviderFailure({ httpStatus: 200, providerResultSignal: "no-data" }).classification,
    "no-data",
  );
  assert.equal(
    classifyProviderFailure({ httpStatus: 200, providerResultSignal: "parser-shape" }).classification,
    "request-error",
  );

  const diagnosis = classifyProviderFailure({
    httpStatus: 200,
    providerResultCode: "30",
    providerResultSignal: "authorization",
    controlOperationStatus: "succeeded",
  });
  assert.deepEqual(diagnosis, {
    classification: "authorization-missing",
    controlOperationStatus: "succeeded",
    httpStatus: 200,
    providerResultCode: "30",
    providerResultSignal: "authorization",
  });
  assert.equal(
    formatProviderFailureEvidence(diagnosis),
    "failureClass=authorization-missing controlOperation=succeeded",
  );
});

test("권한 미보유 판정은 같은 실행의 대조군 성공을 전제조건으로 요구한다", () => {
  assert.equal(requiresControlOperation({ httpStatus: 200, providerResultSignal: "authorization" }), true);
  assert.equal(requiresControlOperation({ httpStatus: 401, providerResultSignal: null }), true);
  assert.equal(requiresControlOperation({ httpStatus: 403, providerResultSignal: null }), true);
  assert.equal(requiresControlOperation({ httpStatus: 200, providerResultSignal: "no-data" }), false);

  assert.equal(
    classifyProviderFailure({
      httpStatus: 200,
      providerResultCode: "30",
      providerResultSignal: "authorization",
      controlOperationStatus: "failed",
    }).classification,
    "authentication-error",
  );
  assert.throws(
    () => classifyProviderFailure({
      httpStatus: 200,
      providerResultCode: "30",
      providerResultSignal: "authorization",
      controlOperationStatus: "not-run",
    }),
    /provider credential signal requires a same-run control operation result/,
  );

  // 자기 대조군: 같은 operation이 같은 실행에서 성공했으므로 권한 미보유가 성립하지 않는다.
  const selfControl = classifyProviderFailure({
    httpStatus: 200,
    providerResultCode: "30",
    providerResultSignal: "authorization",
    controlOperationStatus: "self-succeeded",
  });
  assert.equal(selfControl.classification, "request-error");
  assert.throws(
    () => assertProviderBlockerPromotable(selfControl),
    /provider blocker promotion requires the authorization-missing classification/,
  );
});

test("분류와 근거 없이는 provider blocker로 승격할 수 없다", () => {
  const promotable = classifyProviderFailure({
    httpStatus: 200,
    providerResultCode: "30",
    providerResultSignal: "authorization",
    controlOperationStatus: "succeeded",
  });
  assert.equal(assertProviderBlockerPromotable(promotable), promotable);

  assert.throws(
    () => assertProviderBlockerPromotable(classifyProviderFailure({
      httpStatus: 200,
      providerResultCode: "30",
      providerResultSignal: "authorization",
      controlOperationStatus: "failed",
    })),
    /provider blocker promotion requires the authorization-missing classification/,
  );
  assert.throws(
    () => assertProviderBlockerPromotable({
      classification: "authorization-missing",
      controlOperationStatus: "not-run",
      httpStatus: 200,
      providerResultCode: "30",
      providerResultSignal: "authorization",
    }),
    /provider blocker promotion requires a succeeded control operation/,
  );
  assert.throws(
    () => assertProviderBlockerPromotable({
      classification: "authorization-missing",
      controlOperationStatus: "succeeded",
      httpStatus: null,
      providerResultCode: null,
      providerResultSignal: "authorization",
    }),
    /provider blocker promotion requires HTTP status and provider result code evidence/,
  );
  assert.throws(() => assertProviderBlockerPromotable(null), /provider blocker promotion requires/);
});

test("provider blocked evidence는 폐쇄된 수명주기 증거만 허용하고 만료 경계에서 닫힌다", () => {
  const evaluationAt = "2026-08-05T12:00:00.000Z";
  const actual = validateProviderBlockedEvidence(PROVIDER_BLOCKED_EVIDENCE, { evaluationAt });
  assert.deepEqual(actual, PROVIDER_BLOCKED_EVIDENCE);
  assert.notEqual(actual, PROVIDER_BLOCKED_EVIDENCE);
  assert.deepEqual(Object.keys(actual).sort(), [
    "controlOperationId",
    "credentialFingerprint",
    "expiresAt",
    "failureClassification",
    "lastVerifiedAt",
    "providerId",
    "reverifyAfter",
    "sanitizedEvidenceSha256",
    "sourceId",
  ]);
  assert.doesNotThrow(() => validateProviderBlockedEvidence(
    PROVIDER_BLOCKED_EVIDENCE,
    { evaluationAt: "2026-08-05T23:59:59.999Z" },
  ));
  assert.doesNotThrow(() => validateProviderBlockedEvidence({
    ...PROVIDER_BLOCKED_EVIDENCE,
    reverifyAfter: PROVIDER_BLOCKED_EVIDENCE.expiresAt,
  }, { evaluationAt }));
  for (const failureClassification of PROVIDER_FAILURE_CLASSIFICATIONS) {
    assert.doesNotThrow(() => validateProviderBlockedEvidence(
      { ...PROVIDER_BLOCKED_EVIDENCE, failureClassification },
      { evaluationAt },
    ));
  }

  assert.throws(
    () => validateProviderBlockedEvidence({ ...PROVIDER_BLOCKED_EVIDENCE, failureClassification: "unknown" }, { evaluationAt }),
    /failureClassification must be a provider failure classification/,
  );
  for (const failureClassification of ["", null]) {
    assert.throws(
      () => validateProviderBlockedEvidence({ ...PROVIDER_BLOCKED_EVIDENCE, failureClassification }, { evaluationAt }),
      /failureClassification/,
    );
  }
  for (const [field, value] of [
    ["providerId", ""],
    ["sourceId", ""],
    ["controlOperationId", ""],
    ["credentialFingerprint", "A".repeat(12)],
    ["sanitizedEvidenceSha256", "A".repeat(64)],
  ]) {
    assert.throws(
      () => validateProviderBlockedEvidence({ ...PROVIDER_BLOCKED_EVIDENCE, [field]: value }, { evaluationAt }),
      new RegExp(field),
    );
  }
  assert.doesNotThrow(() => validateProviderBlockedEvidence({
    ...PROVIDER_BLOCKED_EVIDENCE,
    credentialFingerprint: "a".repeat(12),
  }, { evaluationAt }));
  for (const [field, value] of [
    ["credentialFingerprint", "a".repeat(11)],
    ["credentialFingerprint", "a".repeat(13)],
    ["sanitizedEvidenceSha256", "a".repeat(63)],
    ["sanitizedEvidenceSha256", "a".repeat(65)],
  ]) {
    assert.throws(
      () => validateProviderBlockedEvidence({ ...PROVIDER_BLOCKED_EVIDENCE, [field]: value }, { evaluationAt }),
      new RegExp(field),
    );
  }
  for (const field of Object.keys(PROVIDER_BLOCKED_EVIDENCE)) {
    const missing = { ...PROVIDER_BLOCKED_EVIDENCE };
    delete missing[field];
    assert.throws(() => validateProviderBlockedEvidence(missing, { evaluationAt }), new RegExp(`${field}`));
  }
  assert.throws(
    () => validateProviderBlockedEvidence({ ...PROVIDER_BLOCKED_EVIDENCE, unexpected: true }, { evaluationAt }),
    /provider blocked evidence has unsupported fields: unexpected/,
  );
  const inheritedSourceId = { ...PROVIDER_BLOCKED_EVIDENCE };
  delete inheritedSourceId.sourceId;
  Object.setPrototypeOf(inheritedSourceId, { sourceId: PROVIDER_BLOCKED_EVIDENCE.sourceId });
  assert.throws(
    () => validateProviderBlockedEvidence(inheritedSourceId, { evaluationAt }),
    /provider blocked evidence.sourceId is required/,
  );
  for (const field of ["lastVerifiedAt", "reverifyAfter", "expiresAt"]) {
    for (const value of ["2026-08-05", "2026-08-05T00:00:00.000+09:00"]) {
      assert.throws(
        () => validateProviderBlockedEvidence({ ...PROVIDER_BLOCKED_EVIDENCE, [field]: value }, { evaluationAt }),
        new RegExp(`${field} must be an RFC 3339 UTC timestamp`),
      );
    }
  }
  for (const [field, value] of [
    ["lastVerifiedAt", "2026-08-05T00:00:00.000Z"],
    ["reverifyAfter", "2026-08-04T00:00:00.000Z"],
    ["expiresAt", "2026-08-04T00:00:00.000Z"],
    ["lastVerifiedAt", "2026-08-05T00:00:00.001Z"],
  ]) {
    assert.throws(
      () => validateProviderBlockedEvidence({ ...PROVIDER_BLOCKED_EVIDENCE, [field]: value }, { evaluationAt }),
      /lastVerifiedAt < reverifyAfter <= expiresAt/,
    );
  }
  assert.throws(
    () => validateProviderBlockedEvidence(PROVIDER_BLOCKED_EVIDENCE, { evaluationAt: "2026-08-06T00:00:00.000Z" }),
    /expiresAt must be after evaluationAt/,
  );
  assert.throws(
    () => validateProviderBlockedEvidence(PROVIDER_BLOCKED_EVIDENCE, { evaluationAt: "2026-08-05" }),
    /evaluationAt must be an RFC 3339 UTC timestamp/,
  );
});

test("endpoint는 query 자격증명을 거부하고 sampleUrl은 정확한 redaction 자리표시자만 허용한다", () => {
  for (const parameter of ["serviceKey", "apiKey", "key", "token", "access_token", "secret", "clientSecret"]) {
    assert.throws(
      () => resolveProviderCallIntegrity(
        document({ controlOperation: { endpoint: `${CONTROL_OPERATION.endpoint}?${parameter}=${DUMMY_CREDENTIAL}` } }),
        "kric",
      ),
      new RegExp(`kric\\.controlOperation\\.endpoint must not carry a credential query parameter: ${parameter}`),
    );
  }

  // endpoint에는 redaction 자리표시자도 허용하지 않는다. endpoint는 자격증명을 실을 자리가 아니다.
  assert.throws(
    () => resolveProviderCallIntegrity(
      document({ controlOperation: { endpoint: `${CONTROL_OPERATION.endpoint}?serviceKey=[서비스키값]` } }),
      "kric",
    ),
    /kric\.controlOperation\.endpoint must not carry a credential query parameter: serviceKey/,
  );

  assert.throws(
    () => resolveProviderCallIntegrity(
      document({ controlOperation: { sampleUrl: `${CONTROL_OPERATION.sampleUrl}&apiKey=${DUMMY_CREDENTIAL}` } }),
      "kric",
    ),
    /kric\.controlOperation\.sampleUrl must not carry a credential query parameter: apiKey/,
  );

  // 자격증명이 아닌 query 파라미터는 그대로 통과한다.
  assert.doesNotThrow(() => resolveProviderCallIntegrity(
    document({ controlOperation: { endpoint: `${CONTROL_OPERATION.endpoint}?format=json&lnCd=3` } }),
    "kric",
  ));
});

test("대조군 계약은 기대 성공 형태를 선언해야 한다", () => {
  const withoutExpectedSuccess = { ...CONTROL_OPERATION };
  delete withoutExpectedSuccess.expectedSuccess;
  assert.throws(
    () => resolveProviderCallIntegrity(documentWithControlOperation(withoutExpectedSuccess), "kric"),
    /kric\.controlOperation\.expectedSuccess must be an object/,
  );

  const cases = [
    [{ minimumRowCount: 0, requiredFields: ["gubun"] }, /minimumRowCount must be a positive integer/],
    [{ minimumRowCount: 1, requiredFields: [] }, /requiredFields must be a sorted non-empty provider field name array/],
    [{ minimumRowCount: 1, requiredFields: ["gubun", "dtlLoc"] }, /requiredFields must be a sorted non-empty provider field name array/],
    [{ minimumRowCount: 1, requiredFields: ["not-a-field"] }, /requiredFields must be a sorted non-empty provider field name array/],
    [{ minimumRowCount: 1, requiredFields: ["gubun"], unexpected: true }, /expectedSuccess has unsupported fields: unexpected/],
  ];
  for (const [expectedSuccess, pattern] of cases) {
    assert.throws(
      () => resolveProviderCallIntegrity(document({ controlOperation: { expectedSuccess } }), "kric"),
      pattern,
    );
  }
});

test("provider 계약은 credential 신호 result code를 선언해야 한다", () => {
  const withoutCodes = documentWithControlOperation(CONTROL_OPERATION);
  delete withoutCodes.providers.kric.credentialSignalResultCodes;
  assert.throws(
    () => resolveProviderCallIntegrity(withoutCodes, "kric"),
    /kric\.credentialSignalResultCodes must be a sorted non-empty provider result code array/,
  );

  const invalid = [[], ["30", "30"], ["31", "30"], ["코드"], ["x".repeat(33)], "30"];
  for (const credentialSignalResultCodes of invalid) {
    const document = documentWithControlOperation(CONTROL_OPERATION);
    document.providers.kric.credentialSignalResultCodes = credentialSignalResultCodes;
    assert.throws(
      () => resolveProviderCallIntegrity(document, "kric"),
      /kric\.credentialSignalResultCodes must be a sorted non-empty provider result code array/,
      JSON.stringify(credentialSignalResultCodes),
    );
  }
});
