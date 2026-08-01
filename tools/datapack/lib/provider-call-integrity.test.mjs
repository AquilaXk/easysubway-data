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
  verifiedAt: "2026-08-02",
});

function document(overrides = {}) {
  return {
    providers: {
      kric: {
        credential: { ...CREDENTIAL_CONTRACT, ...overrides.credential },
        controlOperation: { ...CONTROL_OPERATION, ...overrides.controlOperation },
      },
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
    () => resolveProviderCallIntegrity(document({ controlOperation: { sampleUrl: `${CONTROL_OPERATION.endpoint}?serviceKey=live-key&format=json` } }), "kric"),
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
  assert.deepEqual(CONTROL_OPERATION_STATUSES, ["succeeded", "failed", "not-run"]);

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
