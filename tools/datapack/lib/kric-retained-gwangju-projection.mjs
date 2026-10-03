import { createHash } from "node:crypto";

import { canonicalJson } from "./manifest-validation.mjs";

// #913: 광주 1호선 시간표는 원장 head가 결속한 KRIC 보관본(kric-nationwide-timetable-file,
// retainedScheduleAdmissionEvidence)에서 만든다. 보관본 관측(observation.json, 약 231MB)은 저장소에 두지 않으므로,
// 관측 바이트를 원장 head의 rawObjectSha256으로 확인한 등록 시점에 계약 노선 행만 원문 그대로 골라 projection으로 커밋한다.
// 후보 생성은 이 projection을 내용 해시와 inventory evidence, 현재 보관본 head로 다시 확인한 뒤에만 쓴다.

export const RETAINED_GWANGJU_PROJECTION_SOURCE_ID = "kric-nationwide-timetable-file";
export const RETAINED_GWANGJU_PROJECTION_EVIDENCE_KEY = "retainedGwangjuProjectionEvidence";
export const RETAINED_GWANGJU_PROJECTION_KIND = "kric-retained-gwangju-timetable-projection";
const SNAPSHOT_PREFIX = `${RETAINED_GWANGJU_PROJECTION_SOURCE_ID}-gwangju-`;
const SHA256 = /^[a-f0-9]{64}$/u;
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const fail = (code, detail = "") => { throw new Error(`RETAINED_GWANGJU_PROJECTION_${code}${detail ? `: ${detail}` : ""}`); };

function content({ retainedEvidence, observationRawObjectSha256, routeNumber, records }) {
  return {
    schemaVersion: 1,
    artifactKind: RETAINED_GWANGJU_PROJECTION_KIND,
    sourceId: RETAINED_GWANGJU_PROJECTION_SOURCE_ID,
    retainedSnapshotId: retainedEvidence.snapshotId,
    observedAt: retainedEvidence.observedAt,
    observationRecordsSha256: retainedEvidence.recordsSha256,
    observationRawObjectSha256,
    routeNumber,
    recordCount: records.length,
    recordsSha256: sha256(`${JSON.stringify(records)}\n`),
    records,
  };
}

/**
 * restoreAdmittedGwangjuTimetable이 원장 head와 결속을 확인한 보관본(계약 + 관측)에서 계약 노선 행만 고른다.
 * @param {{ retained: { observation: { records: object[] }, routeNumber: string }, retainedEvidence: object, observationRawObjectSha256: string }} input
 */
export function projectRetainedGwangjuRecords({ retained, retainedEvidence, observationRawObjectSha256 }) {
  if (!retained?.observation || !Array.isArray(retained.observation.records) || typeof retained.routeNumber !== "string"
    || typeof retainedEvidence?.snapshotId !== "string" || typeof retainedEvidence.observedAt !== "string"
    || !SHA256.test(retainedEvidence.recordsSha256 ?? "") || !SHA256.test(observationRawObjectSha256 ?? "")) fail("INPUT");
  const records = retained.observation.records
    .filter((record) => record.routeNumber === retained.routeNumber)
    .sort((left, right) => left.sourceRowNumber - right.sourceRowNumber);
  if (records.length === 0) fail("ROUTE_EMPTY", retained.routeNumber);
  const value = content({ retainedEvidence, observationRawObjectSha256, routeNumber: retained.routeNumber, records });
  const contentSha256 = sha256(canonicalJson(value));
  return { snapshotId: `${SNAPSHOT_PREFIX}${contentSha256}`, contentSha256, ...value };
}

/** inventory에 남길 evidence(스냅샷 경로·내용 해시·보관본 head 결속). */
export function retainedGwangjuProjectionEvidence(snapshot) {
  return {
    snapshotId: snapshot.snapshotId,
    snapshotPath: `tools/datapack/sources/${snapshot.snapshotId}.json`,
    contentSha256: snapshot.contentSha256,
    retainedSnapshotId: snapshot.retainedSnapshotId,
    observationRawObjectSha256: snapshot.observationRawObjectSha256,
    routeNumber: snapshot.routeNumber,
    recordCount: snapshot.recordCount,
    recordsSha256: snapshot.recordsSha256,
  };
}

/**
 * projection 자기 결속, inventory evidence 결속, 현재 보관본 head 결속을 모두 확인한다.
 * 리뷰 F3: projection이 가리키는 관측 객체 sha를 원장 head 행(rawObjectSha256)과 대조한다. evidence와 snapshot만으로는
 * 같은 저장소 안의 값이라 함께 바꿀 수 있다. 원장 head는 append-only 원장과 OCI 영수증에 결속된 값이다.
 */
export function validateRetainedGwangjuProjection({ snapshot, evidence, retainedEvidence, retainedHead }) {
  const { snapshotId, contentSha256, ...value } = snapshot ?? {};
  if (value.schemaVersion !== 1 || value.artifactKind !== RETAINED_GWANGJU_PROJECTION_KIND
    || value.sourceId !== RETAINED_GWANGJU_PROJECTION_SOURCE_ID || !Array.isArray(value.records)
    || value.recordCount !== value.records.length || value.recordsSha256 !== sha256(`${JSON.stringify(value.records)}\n`)
    || value.records.some((record) => record?.routeNumber !== value.routeNumber)
    || contentSha256 !== sha256(canonicalJson(value)) || snapshotId !== `${SNAPSHOT_PREFIX}${contentSha256}`) fail("CONTENT");
  if (canonicalJson(evidence ?? null) !== canonicalJson(retainedGwangjuProjectionEvidence(snapshot))) fail("EVIDENCE");
  if (value.retainedSnapshotId !== retainedEvidence?.snapshotId || value.observedAt !== retainedEvidence.observedAt
    || value.observationRecordsSha256 !== retainedEvidence.recordsSha256) fail("STALE", value.retainedSnapshotId);
  if (retainedHead?.snapshotId !== value.retainedSnapshotId || !SHA256.test(retainedHead.rawObjectSha256 ?? "")
    || value.observationRawObjectSha256 !== retainedHead.rawObjectSha256) fail("LEDGER", value.retainedSnapshotId);
  return snapshot;
}
