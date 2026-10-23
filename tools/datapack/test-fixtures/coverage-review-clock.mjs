// report-coverage-gaps.mjs의 nextReviewAt 만료 판정에 넘기는 고정 평가 시각(--now).
// 실제 resolutions 문서(2026-07-25 재감사)의 nextReviewAt(2026-10-23) 이전이라 문서가 가리키는 판정이 시간이 흘러도 바뀌지 않는다.
export const COVERAGE_REVIEW_NOW = "2026-10-01T00:00:00.000Z";
