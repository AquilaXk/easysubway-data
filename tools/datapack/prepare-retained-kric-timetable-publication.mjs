import { createHash } from "node:crypto";
import path from "node:path";
import { selectRetainedKricTimetable } from "./build-kric-retained-file-pending-handoff.mjs";
import { deriveFreshnessExpiresAt } from "./freshness-policy.mjs";

const SOURCE_ID = "kric-nationwide-timetable-file";
const POLICY_KEYS = [
  "basisField", "eventTriggers", "futureBasisAllowed", "id",
  "providerValidityEndField", "reverificationCadence", "sourceIds",
].sort();

// 보관 원문 검증과 publication 입력만 준비한다. 등록·업로드·관측 시각 갱신은 하지 않는다.
export function prepareRetainedKricTimetablePublication({
  candidate, observationBytes, receipt, routeNumber, sourcePath,
  evaluationAt, providerValidUntil,
}) {
  const policy = candidate?.confirmationPolicy;
  if (candidate?.id !== SOURCE_ID || candidate.domain !== "schedule_timetable"
    || !policy || JSON.stringify(Object.keys(policy).sort()) !== JSON.stringify(POLICY_KEYS)
    || typeof policy.id !== "string" || policy.id.length === 0
    || JSON.stringify(policy.sourceIds) !== JSON.stringify([SOURCE_ID])
    || policy.basisField !== "observedAt" || policy.futureBasisAllowed !== false
    || policy.providerValidityEndField !== "serviceEffectiveUntil"
    || !Array.isArray(policy.eventTriggers) || policy.eventTriggers.length === 0
    || policy.eventTriggers.some((event) => typeof event !== "string" || event.trim() === "")) {
    throw new Error("RETAINED_TIMETABLE_CONFIRMATION_POLICY_INVALID");
  }
  if (typeof sourcePath !== "string" || sourcePath.length === 0
    || path.posix.isAbsolute(sourcePath) || sourcePath.includes("\\")
    || sourcePath.split("/").some((part) => ["", ".", ".."].includes(part))) {
    throw new Error("RETAINED_TIMETABLE_PUBLICATION_PATH_INVALID");
  }
  if (!Buffer.isBuffer(observationBytes) || observationBytes.length === 0) {
    throw new Error("RETAINED_TIMETABLE_OBSERVATION_BYTES_INVALID");
  }
  const observation = JSON.parse(observationBytes.toString("utf8"));
  const { summary } = selectRetainedKricTimetable({ observation, receipt, routeNumber });
  const freshnessExpiresAt = deriveFreshnessExpiresAt({
    policy: { sourceClasses: [policy] }, sourceClassId: policy.id,
    basisAt: observation.observedAt, providerValidUntil, evaluationAt,
  });
  if (Date.parse(evaluationAt) >= Date.parse(freshnessExpiresAt)) {
    throw new Error("RETAINED_TIMETABLE_OBSERVATION_STALE");
  }
  // XLSX 취득 SHA를 JSON object SHA로 대체하지 않는다. 실제 저장 bytes를 별도로 결속한다.
  const observationSha256 = createHash("sha256").update(observationBytes).digest("hex");
  const object = {
    objectKey: `sources/${SOURCE_ID}/${observationSha256}/observation.json`,
    sourcePath, sha256: observationSha256, sizeBytes: observationBytes.length,
  };
  return {
    source: summary, observationSha256, freshnessExpiresAt,
    confirmationPolicy: structuredClone(policy),
    plan: { steps: [
      { type: "put-immutable-bundle-object", ...object },
      { type: "verify-immutable-bundle-object", ...object },
    ] },
  };
}
