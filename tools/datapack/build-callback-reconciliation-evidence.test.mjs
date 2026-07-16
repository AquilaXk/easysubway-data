import assert from "node:assert/strict";
import { createHash, createSign, generateKeyPairSync } from "node:crypto";
import test from "node:test";

import {
  buildCallbackReconciliationEvidence,
  prepareCallbackReconciliationIdentity,
  wrapCallbackReconciliationGateEvidence,
  validateCallbackReconciliationEvidence,
} from "./build-callback-reconciliation-evidence.mjs";
import { canonicalJson, withoutSignature } from "./lib/manifest-validation.mjs";

const manifestSha256 = "a".repeat(64);
const releaseRequestId = "release-request-2057";
const releaseSequence = 42;
const idempotencyKeySha256 = createHash("sha256")
  .update(`${releaseRequestId}:${releaseSequence}:${manifestSha256}`)
  .digest("hex");
const { privateKey: bindingPrivateKey, publicKey: bindingPublicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});

function releaseRequestBinding(overrides = {}) {
  const unsigned = {
    schemaVersion: 1,
    artifactKind: "datapack-release-request-binding",
    releaseRequestId,
    releaseSequence,
    channel: "production",
    manifestSha256,
    keyId: "production-v1",
    releaseOutcome: "PUBLISHED_AND_VERIFIED",
    ...overrides,
  };
  return {
    ...unsigned,
    signature: {
      algorithm: "rsa-sha256-release-request-v1",
      value: createSign("RSA-SHA256")
        .update(canonicalJson(withoutSignature(unsigned)))
        .sign(bindingPrivateKey)
        .toString("base64url"),
    },
  };
}

function withBindingPublicKey(run) {
  const previousPem = process.env.EASYSUBWAY_DATAPACK_SIGNING_PUBLIC_KEY_PEM;
  const previousKeyId = process.env.EASYSUBWAY_DATAPACK_SIGNING_KEY_ID;
  process.env.EASYSUBWAY_DATAPACK_SIGNING_PUBLIC_KEY_PEM = bindingPublicKey.export({
    type: "spki", format: "pem",
  });
  process.env.EASYSUBWAY_DATAPACK_SIGNING_KEY_ID = "production-v1";
  try {
    return run();
  } finally {
    if (previousPem === undefined) delete process.env.EASYSUBWAY_DATAPACK_SIGNING_PUBLIC_KEY_PEM;
    else process.env.EASYSUBWAY_DATAPACK_SIGNING_PUBLIC_KEY_PEM = previousPem;
    if (previousKeyId === undefined) delete process.env.EASYSUBWAY_DATAPACK_SIGNING_KEY_ID;
    else process.env.EASYSUBWAY_DATAPACK_SIGNING_KEY_ID = previousKeyId;
  }
}

function raw(overrides = {}) {
  return {
    schemaVersion: 1,
    environment: "production-like-isolated-h2",
    deliveryIdentity: { releaseRequestId, releaseSequence, manifestSha256, idempotencyKeySha256 },
    virtualEventTimeline: {
      candidatePublishedAt: "2026-07-16T00:00Z",
      callbackBackendUnavailableAt: "2026-07-16T00:00Z",
      reconciliationConvergedAt: "2026-07-16T00:10Z",
      terminalBoundaryAt: "2026-07-16T01:10Z",
    },
    metrics: { controlPlaneConvergenceP95Ms: 600_000, terminalDispositionMaxMs: 4_200_000 },
    observations: {
      candidateNoChange: false,
      callbackDelivery: {
        state: "RECONCILIATION_REQUIRED",
        attempts: [1, 2, 3, 4].map((attempt) => ({ attempt, httpClass: "5XX" })),
      },
      virtualRetryDelaysSeconds: [60, 480, 3600],
      convergedState: "DELIVERED",
      convergedHttpClass: "RECONCILED",
      terminalState: "DEAD_LETTER",
      terminalHttpClass: "UNAVAILABLE",
      terminalReason: "CATALOG_UNAVAILABLE",
    },
    sensitiveMaterialStored: false,
    ...overrides,
  };
}

const testCases = {
  rehearsal: "callback backend unavailable publish가 10분에 수렴하고 catalog 장애는 70분에 dead-letter된다",
  duplicate: "동일 payload 10회는 delivery와 release 상태를 한 번만 적용한다",
  concurrent: "동시 claim은 delivery 한 건을 한 worker에게만 준다",
  identityMismatch: "catalog identity 불일치는 각각의 sanitized reason으로 DEAD_LETTER다",
  invalidSignature: "catalog signature mismatch는 자동 apply 없이 DEAD_LETTER다",
  missingRequest: "존재하지 않는 release request callback은 자동 적용 없이 DEAD_LETTER로 보존한다",
  redaction: "목록은 sanitized callback delivery와 reconciliation blocker를 렌더한다",
  manualRepair: "production approve 관리자는 dead letter를 repair하고 before/after·identity hash를 감사한다",
};

function junit(name) {
  return `<?xml version="1.0"?><testsuite tests="1" skipped="0" failures="0" errors="0"><testcase name="${name}" classname="fixture"/></testsuite>`;
}

function junitXmlByCheck() {
  return Object.fromEntries(Object.entries(testCases).map(([key, name]) => [key, junit(name)]));
}

const workflow = `
- name: block rollout
  run: |
    if (( ROLLOUT_PERCENTAGE > 10 )); then
      echo "CALLBACK_RECONCILIATION_REQUIRED"
      exit 1
    fi
`;

test("isolated rehearsal과 canonical checks로 #2056 소비 evidence를 만든다", () => {
  const built = buildCallbackReconciliationEvidence({
    raw: raw(), junitXmlByCheck: junitXmlByCheck(), workflow,
    expectedIdentity: { releaseRequestId, releaseSequence, manifestSha256 },
  });

  assert.deepEqual(built.evidence.deliveryIdentity,
    { releaseRequestId, releaseSequence, manifestSha256, idempotencyKeySha256 });
  assert.equal(Object.keys(built.evidence.checks).length, 10);
  assert.ok(Object.values(built.evidence.checks).every(Boolean));
  assert.equal(built.attestation.schemaVersion, 1);
  validateCallbackReconciliationEvidence(built.evidence);
});

test("final RC identity가 raw rehearsal과 다르면 fail closed한다", () => {
  assert.throws(() => buildCallbackReconciliationEvidence({
    raw: raw(), junitXmlByCheck: junitXmlByCheck(), workflow,
    expectedIdentity: { releaseRequestId, releaseSequence: 43, manifestSha256 },
  }), /final RC identity mismatch/);
});

test("10분/70분 virtual boundary 초과를 거부한다", () => {
  for (const metrics of [
    { controlPlaneConvergenceP95Ms: 600_001, terminalDispositionMaxMs: 4_200_000 },
    { controlPlaneConvergenceP95Ms: 600_000, terminalDispositionMaxMs: 4_200_001 },
  ]) {
    assert.throws(() => buildCallbackReconciliationEvidence({
      raw: raw({ metrics }), junitXmlByCheck: junitXmlByCheck(), workflow,
      expectedIdentity: { releaseRequestId, releaseSequence, manifestSha256 },
    }), /virtual time metric exceeds/);
  }
});

test("production sender 5xx와 candidate publish가 없는 rehearsal을 거부한다", () => {
  for (const observations of [
    { ...raw().observations, candidateNoChange: true },
    { ...raw().observations, callbackDelivery: { state: "DELIVERED", attempts: [] } },
    { ...raw().observations, virtualRetryDelaysSeconds: [60, 480] },
  ]) {
    assert.throws(() => buildCallbackReconciliationEvidence({
      raw: raw({ observations }), junitXmlByCheck: junitXmlByCheck(), workflow,
      expectedIdentity: { releaseRequestId, releaseSequence, manifestSha256 },
    }), /production sender outage rehearsal is invalid/);
  }
});

test("누락·실패·skip JUnit check와 rollout cap 부재를 거부한다", () => {
  const failed = junitXmlByCheck();
  failed.concurrent = failed.concurrent.replace('failures="0"', 'failures="1"');
  assert.throws(() => buildCallbackReconciliationEvidence({
    raw: raw(), junitXmlByCheck: failed, workflow,
    expectedIdentity: { releaseRequestId, releaseSequence, manifestSha256 },
  }), /JUnit evidence did not pass/);
  assert.throws(() => buildCallbackReconciliationEvidence({
    raw: raw(), junitXmlByCheck: junitXmlByCheck(), workflow: "rollout allowed",
    expectedIdentity: { releaseRequestId, releaseSequence, manifestSha256 },
  }), /rollout cap contract missing/);
});

test("raw artifact의 secret·token·header 계열 필드를 거부한다", () => {
  assert.throws(() => buildCallbackReconciliationEvidence({
    raw: raw({ callbackToken: "do-not-store" }), junitXmlByCheck: junitXmlByCheck(), workflow,
    expectedIdentity: { releaseRequestId, releaseSequence, manifestSha256 },
  }), /sensitive field/);
});

test("canonical check false와 malformed evidence reference를 거부한다", () => {
  const { evidence } = buildCallbackReconciliationEvidence({
    raw: raw(), junitXmlByCheck: junitXmlByCheck(), workflow,
    expectedIdentity: { releaseRequestId, releaseSequence, manifestSha256 },
  });
  assert.throws(() => validateCallbackReconciliationEvidence({
    ...evidence, checks: { ...evidence.checks, manualRepairAudited: false },
  }), /canonical checks/);
  assert.throws(() => validateCallbackReconciliationEvidence({
    ...evidence, evidenceReferences: [{ artifactId: "raw", sha256: "not-a-sha" }],
  }), /evidence reference/);
});

test("#2056 final manifest의 전체 RC identity로 canonical gate envelope를 감싼다", () => {
  const { evidence } = buildCallbackReconciliationEvidence({
    raw: raw(), junitXmlByCheck: junitXmlByCheck(), workflow,
    expectedIdentity: { releaseRequestId, releaseSequence, manifestSha256 },
  });
  const rcIdentity = {
    gitSha: "b".repeat(40),
    dataPackManifestSha256: manifestSha256,
    releaseSequence,
    backendArtifactSha256: "c".repeat(64),
  };
  const envelope = wrapCallbackReconciliationGateEvidence({
    result: evidence,
    rcManifest: {
      schemaVersion: 1,
      phase: "FINAL",
      gitSha: rcIdentity.gitSha,
      datapackGates: [{ id: "callback_reconciliation", sourceIssue: 2057, rcIdentity }],
    },
    evaluatedAt: "2026-07-16T12:00:00.000Z",
  });

  assert.equal(envelope.gateId, "callback_reconciliation");
  assert.equal(envelope.sourceIssue, 2057);
  assert.deepEqual(envelope.rcIdentity, rcIdentity);
  assert.equal(envelope.evidenceValidity.expiresAt, "2026-07-30T12:00:00.000Z");
  assert.deepEqual(envelope.result, evidence);
});

test("result identity가 #2056 final RC identity와 다르면 envelope 생성을 거부한다", () => {
  const { evidence } = buildCallbackReconciliationEvidence({
    raw: raw(), junitXmlByCheck: junitXmlByCheck(), workflow,
    expectedIdentity: { releaseRequestId, releaseSequence, manifestSha256 },
  });
  assert.throws(() => wrapCallbackReconciliationGateEvidence({
    result: evidence,
    rcManifest: {
      schemaVersion: 1,
      phase: "FINAL",
      gitSha: "b".repeat(40),
      datapackGates: [{ id: "callback_reconciliation", sourceIssue: 2057, rcIdentity: {
        gitSha: "b".repeat(40), dataPackManifestSha256: "d".repeat(64), releaseSequence,
      } }],
    },
    evaluatedAt: "2026-07-16T12:00:00.000Z",
  }), /#2056 final RC identity mismatch/);
});

test("#2056 final manifest에서 rehearsal 입력 identity를 안전하게 추출한다", () => {
  const prepared = withBindingPublicKey(() => prepareCallbackReconciliationIdentity({
    rcManifest: {
      schemaVersion: 1,
      phase: "FINAL",
      gitSha: "b".repeat(40),
      datapackGates: [{ id: "callback_reconciliation", sourceIssue: 2057, rcIdentity: {
        gitSha: "b".repeat(40), dataPackManifestSha256: manifestSha256, releaseSequence,
      } }],
    },
    releaseRequestId,
    releaseRequestBinding: releaseRequestBinding(),
    expectedGitSha: "b".repeat(40),
  }));
  assert.deepEqual(prepared, { releaseRequestId, releaseSequence, manifestSha256 });
});

test("unsafe request ID와 다른 workflow SHA의 final manifest를 거부한다", () => {
  const rcManifest = {
    schemaVersion: 1,
    phase: "FINAL",
    gitSha: "b".repeat(40),
    datapackGates: [{ id: "callback_reconciliation", sourceIssue: 2057, rcIdentity: {
      gitSha: "b".repeat(40), dataPackManifestSha256: manifestSha256, releaseSequence,
    } }],
  };
  assert.throws(() => prepareCallbackReconciliationIdentity({
    rcManifest, releaseRequestId: "unsafe\nGITHUB_ENV=injected",
    releaseRequestBinding: releaseRequestBinding(), expectedGitSha: "b".repeat(40),
  }), /release request ID/);
  assert.throws(() => prepareCallbackReconciliationIdentity({
    rcManifest, releaseRequestId, releaseRequestBinding: releaseRequestBinding(),
    expectedGitSha: "c".repeat(40),
  }), /workflow SHA/);
});

test("signed publish binding이 request·sequence·manifest를 FINAL RC에 결속한다", () => {
  const rcManifest = {
    schemaVersion: 1,
    phase: "FINAL",
    gitSha: "b".repeat(40),
    datapackGates: [{ id: "callback_reconciliation", sourceIssue: 2057, rcIdentity: {
      gitSha: "b".repeat(40), dataPackManifestSha256: manifestSha256, releaseSequence,
    } }],
  };
  for (const binding of [
    releaseRequestBinding({ releaseRequestId: "another-request" }),
    releaseRequestBinding({ releaseSequence: releaseSequence + 1 }),
    releaseRequestBinding({ manifestSha256: "f".repeat(64) }),
  ]) {
    assert.throws(() => withBindingPublicKey(() => prepareCallbackReconciliationIdentity({
      rcManifest, releaseRequestId, releaseRequestBinding: binding,
      expectedGitSha: "b".repeat(40),
    })), /published release request binding mismatch/);
  }

  const forged = releaseRequestBinding();
  const replacement = forged.signature.value.startsWith("A") ? "B" : "A";
  forged.signature.value = `${replacement}${forged.signature.value.slice(1)}`;
  assert.throws(() => withBindingPublicKey(() => prepareCallbackReconciliationIdentity({
    rcManifest, releaseRequestId, releaseRequestBinding: forged,
    expectedGitSha: "b".repeat(40),
  })), /signature is invalid/);
});

test("#2056 final manifest의 callback gate source issue가 다르면 거부한다", () => {
  const { evidence } = buildCallbackReconciliationEvidence({
    raw: raw(), junitXmlByCheck: junitXmlByCheck(), workflow,
    expectedIdentity: { releaseRequestId, releaseSequence, manifestSha256 },
  });
  assert.throws(() => wrapCallbackReconciliationGateEvidence({
    result: evidence,
    rcManifest: {
      schemaVersion: 1,
      phase: "FINAL",
      gitSha: "b".repeat(40),
      datapackGates: [{ id: "callback_reconciliation", sourceIssue: 9999, rcIdentity: {
        gitSha: "b".repeat(40), dataPackManifestSha256: manifestSha256, releaseSequence,
      } }],
    },
    evaluatedAt: "2026-07-16T12:00:00.000Z",
  }), /source issue/);
});
