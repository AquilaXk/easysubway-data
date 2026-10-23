import { readFileSync } from "node:fs";

// report-coverage-gaps.mjs의 nextReviewAt 만료 판정에 넘기는 고정 평가 시각(--now)을 실제 resolutions 문서에서 유도한다.
// COVERAGE_REVIEW_NOW는 가장 이른 checkedAt(재감사 시각)이라 모든 nextReviewAt보다 앞서므로, 재검토로 문서가 갱신돼도 시간이 흘러도 판정이 바뀌지 않는다.
// COVERAGE_REVIEW_DUE_AT은 가장 이른 nextReviewAt(첫 만료 경계)이다.
const { entries } = JSON.parse(readFileSync(
  new URL("../release/nationwide-public-api-coverage-resolutions-20260725.json", import.meta.url),
  "utf8",
));
const earliestInstant = (field) => new Date(Math.min(...entries.map((entry) => Date.parse(entry[field])))).toISOString();

export const COVERAGE_REVIEW_NOW = earliestInstant("checkedAt");
export const COVERAGE_REVIEW_DUE_AT = earliestInstant("nextReviewAt");
