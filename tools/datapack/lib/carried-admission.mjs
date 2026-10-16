import { STATION_LINES_TIMETABLE_SOURCE_ID } from "./kric-station-lines-timetable.mjs";

// #1276이 넣은 무인 갱신의 "승인 이월"을 판정하는 단일 규칙이다.
// 등록기(register-kric-station-timetables)가 새 snapshot을 쓰기 전에, 5권역 fan-in이 head를 고르기 전에 같은 함수로 판정한다.
// 이월은 사람이 승인한 admissionEvidence가 가리키는 옛 snapshot이 현재 head의 조상이고, 승인 당시 스키마·약관 그대로일 때만 인정한다.
// 새 snapshot을 사람이 승인했다고 쓰지 않는다. 이월한 값은 승인 당시 snapshot을 가리키는 채로 남는다.

const SHA256 = /^[a-f0-9]{64}$/u;

/** 승인 이월을 허용하는 원천. 사람 검토 파일 없이 무인 갱신하는 원천만 둔다. */
export const CARRY_FORWARD_ADMISSION_SOURCE_IDS = Object.freeze([STATION_LINES_TIMETABLE_SOURCE_ID]);

/**
 * 현재 head에서 previousSnapshotId로 거슬러 승인된 snapshot에 닿는지 판정한다.
 * 이월할 수 있으면 { chainLength }(head부터 승인 snapshot까지의 snapshot 수, 둘 포함), 아니면 { violation }을 돌려준다.
 * 원장에는 여러 원천의 행이 섞여 있으므로 계보는 대상 원천의 행만으로 따라가고, 거치는 모든 행의 sourceId를 확인한다.
 */
export function carriedAdmissionLineage({ sourceId, approved, ledger, head, schemaFingerprint }) {
  if (!CARRY_FORWARD_ADMISSION_SOURCE_IDS.includes(sourceId)) return { violation: "SOURCE_NOT_ELIGIBLE" };
  if (approved?.decision !== "APPROVED" || approved.sourceId !== sourceId) return { violation: "NOT_APPROVED" };
  if (!SHA256.test(approved.licenseEvidenceHash ?? "")) return { violation: "LICENSE_EVIDENCE_MISSING" };
  if (!SHA256.test(schemaFingerprint ?? "") || approved.schemaFingerprint !== schemaFingerprint) return { violation: "SCHEMA_CHANGED" };
  const bySnapshotId = new Map(ledger.filter((row) => row.sourceId === sourceId).map((row) => [row.snapshotId, row]));
  // 이월의 시간 한도는 약관 nextReviewAt(사람 재검토) 하나다. 무인 갱신이 매일 snapshot을 쌓으므로 체인 깊이는 정책 한도가 아니다.
  // 탐색은 방문 집합이 막으므로 원장 행 수를 넘지 못한다.
  const visited = new Set();
  for (let row = head; row; row = bySnapshotId.get(row.previousSnapshotId)) {
    if (row.sourceId !== sourceId) return { violation: "LINEAGE_SOURCE_MISMATCH" };
    if (visited.has(row.snapshotId)) return { violation: "LINEAGE_CYCLE" };
    visited.add(row.snapshotId);
    if (row.snapshotId !== approved.snapshotId) continue;
    return row.rawSha256 === approved.rawSha256 ? { chainLength: visited.size } : { violation: "APPROVED_RAW_MISMATCH" };
  }
  return { violation: "NOT_ANCESTOR" };
}

/** 약관 재검토 기한(nextReviewAt)이 판정 시각(UTC 밀리초)까지 지나지 않았는지. 이월과 등록의 시간 한도는 이 규칙 하나다. */
export function governanceReviewCurrent(governanceEntry, evaluatedAt) {
  return Date.parse(governanceEntry?.licenseReview?.nextReviewAt ?? "") > evaluatedAt;
}

/** 이월한 승인의 약관 결속을 거버넌스 항목으로 판정한다. 위반이 없으면 null이다. */
export function carriedAdmissionGovernanceViolation({ licenseEvidenceHash, governanceEntry, evaluatedAt }) {
  if (!SHA256.test(licenseEvidenceHash ?? "") || governanceEntry?.licenseReview?.termsHash !== licenseEvidenceHash) return "LICENSE_CHANGED";
  return governanceReviewCurrent(governanceEntry, evaluatedAt) ? null : "REVIEW_EXPIRED";
}
