import assert from "node:assert/strict";
import test from "node:test";

import { simulateCallbackBackendUnavailable } from "./run-callback-backend-outage-rehearsal.mjs";

test("production sender의 1분·8분·1시간 retry가 5xx 뒤 reconciliation으로 전환된다", async () => {
  const result = await simulateCallbackBackendUnavailable({
    releaseRequestId: "release-request-2057",
    releaseSequence: 42,
    manifestSha256: "a".repeat(64),
  });

  assert.deepEqual(result.deliveryIdentity, {
    releaseRequestId: "release-request-2057",
    releaseSequence: 42,
    manifestSha256: "a".repeat(64),
  });
  assert.equal(result.candidate.noChange, false);
  assert.equal(result.callbackDelivery.state, "RECONCILIATION_REQUIRED");
  assert.deepEqual(result.callbackDelivery.attempts.map((attempt) => attempt.httpClass),
    ["5XX", "5XX", "5XX", "5XX"]);
  assert.deepEqual(result.virtualRetryDelaysSeconds, [60, 480, 3600]);
});

test("invalid identity는 sender를 실행하기 전에 거부한다", async () => {
  await assert.rejects(() => simulateCallbackBackendUnavailable({
    releaseRequestId: "unsafe\nrequest",
    releaseSequence: 0,
    manifestSha256: "invalid",
  }), /callback rehearsal identity is invalid/);
});
