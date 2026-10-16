import { STATION_LINES_TIMETABLE_SOURCE_ID } from "./kric-station-lines-timetable.mjs";

// #1276이 넣은 무인 갱신의 "승인 이월"을 판정하는 단일 규칙이다.
// 등록기(register-kric-station-timetables)가 새 snapshot을 쓰기 전에, 5권역 fan-in이 head를 고르기 전에 같은 함수로 판정한다.
// 이월은 사람이 승인한 admissionEvidence가 가리키는 옛 snapshot이 현재 head의 조상이고, 승인 당시 스키마·약관 그대로일 때만 인정한다.
// 새 snapshot을 사람이 승인했다고 쓰지 않는다. 이월한 값은 승인 당시 snapshot을 가리키는 채로 남는다.

const SHA256 = /^[a-f0-9]{64}$/u;

/** 승인 이월을 허용하는 원천. 사람 검토 파일 없이 무인 갱신하는 원천만 둔다. */
export const CARRY_FORWARD_ADMISSION_SOURCE_IDS = Object.freeze([STATION_LINES_TIMETABLE_SOURCE_ID]);

/**
 * 한 번의 사람 승인이 무인 이월로 이어질 수 있는 후속 snapshot 수의 상한이다.
 * planned_timetable 재확인 주기(P30D)로 약관 검토 주기(1년)를 채워도 12~13번이라 2배 여유를 둔다.
 */
export const MAXIMUM_CARRY_FORWARD_CHAIN_DEPTH = 24;

/**
 * 현재 head에서 previousSnapshotId로 거슬러 승인된 snapshot에 닿는지 판정한다.
 * 이월할 수 있으면 { chain }(head부터 승인 snapshot까지의 snapshotId), 아니면 { violation }을 돌려준다.
 * ledger는 호출자가 계보를 검증한 원장(validateLineage·terminalHead)이어야 한다. 한 원천의 행만 서로 이어진다는 전제를 여기서 다시 확인하지 않는다.
 */
export function carriedAdmissionLineage({ sourceId, approved, ledger, head, schemaFingerprint }) {
  if (!CARRY_FORWARD_ADMISSION_SOURCE_IDS.includes(sourceId)) return { violation: "SOURCE_NOT_ELIGIBLE" };
  if (approved?.decision !== "APPROVED" || approved.sourceId !== sourceId) return { violation: "NOT_APPROVED" };
  if (!SHA256.test(approved.licenseEvidenceHash ?? "")) return { violation: "LICENSE_EVIDENCE_MISSING" };
  if (!SHA256.test(schemaFingerprint ?? "") || approved.schemaFingerprint !== schemaFingerprint) return { violation: "SCHEMA_CHANGED" };
  const bySnapshotId = new Map(ledger.map((row) => [row.snapshotId, row]));
  const chain = [];
  for (let row = head; row && !chain.includes(row.snapshotId); row = bySnapshotId.get(row.previousSnapshotId)) {
    chain.push(row.snapshotId);
    if (row.snapshotId !== approved.snapshotId) continue;
    if (row.rawSha256 !== approved.rawSha256) return { violation: "APPROVED_RAW_MISMATCH" };
    return chain.length - 1 > MAXIMUM_CARRY_FORWARD_CHAIN_DEPTH ? { violation: "CHAIN_TOO_DEEP" } : { chain };
  }
  return { violation: "NOT_ANCESTOR" };
}

/**
 * 이월한 승인의 약관 결속을 거버넌스 항목으로 판정한다. 위반이 없으면 null이다.
 * evaluatedAt은 판정 시각(UTC 밀리초)이다. 이월의 시간 한도는 약관 항목의 nextReviewAt 하나다.
 */
export function carriedAdmissionGovernanceViolation({ licenseEvidenceHash, governanceEntry, evaluatedAt }) {
  const review = governanceEntry?.licenseReview;
  if (!SHA256.test(licenseEvidenceHash ?? "") || review?.termsHash !== licenseEvidenceHash) return "LICENSE_CHANGED";
  if (!(Date.parse(review.nextReviewAt ?? "") > evaluatedAt)) return "REVIEW_EXPIRED";
  return null;
}
