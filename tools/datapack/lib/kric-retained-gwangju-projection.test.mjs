import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import {
  RETAINED_GWANGJU_PROJECTION_EVIDENCE_KEY,
  projectRetainedGwangjuRecords,
  retainedGwangjuProjectionEvidence,
  validateRetainedGwangjuProjection,
} from "./kric-retained-gwangju-projection.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const RETAINED = { snapshotId: "kric-nationwide-timetable-file-retained", observedAt: "2026-10-01T04:19:25.298Z", recordsSha256: "a".repeat(64) };
const record = (routeNumber, sourceRowNumber) => ({ routeNumber, trainNumber: `${sourceRowNumber}`, sourceRowNumber });

function retained() {
  return {
    observation: { records: [record("S2901", 2), record("I4108", 3), record("S2901", 4)] },
    routeNumber: "S2901",
  };
}

test("보관본 관측에서 계약 노선 행만 원문 그대로 골라 결정적 projection을 만든다", () => {
  const snapshot = projectRetainedGwangjuRecords({ retained: retained(), retainedEvidence: RETAINED, observationRawObjectSha256: "b".repeat(64) });
  assert.deepEqual(snapshot.records.map(({ sourceRowNumber }) => sourceRowNumber), [2, 4]);
  assert.equal(snapshot.recordCount, 2);
  assert.equal(snapshot.recordsSha256, sha(`${JSON.stringify(snapshot.records)}\n`));
  assert.equal(snapshot.retainedSnapshotId, RETAINED.snapshotId);
  assert.equal(snapshot.observedAt, RETAINED.observedAt);
  assert.match(snapshot.snapshotId, /^kric-nationwide-timetable-file-gwangju-[a-f0-9]{64}$/u);
  // 스냅샷 식별자는 projection 본문의 독립 계산 해시와 같아야 한다(입력 순서와 무관한 결정적 바이트).
  const { snapshotId, contentSha256, ...body } = snapshot;
  const canonical = (value) => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
    : value && typeof value === "object" ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`
      : JSON.stringify(value);
  assert.equal(contentSha256, sha(canonical(body)));
  assert.equal(snapshotId, `kric-nationwide-timetable-file-gwangju-${contentSha256}`);
  assert.throws(() => projectRetainedGwangjuRecords({ retained: { ...retained(), routeNumber: "S9999" }, retainedEvidence: RETAINED, observationRawObjectSha256: "b".repeat(64) }),
    /RETAINED_GWANGJU_PROJECTION_ROUTE_EMPTY/u);
});

test("projection은 내용 해시·inventory evidence·현재 보관본 head와 모두 맞을 때만 통과한다", () => {
  const snapshot = projectRetainedGwangjuRecords({ retained: retained(), retainedEvidence: RETAINED, observationRawObjectSha256: "b".repeat(64) });
  const evidence = retainedGwangjuProjectionEvidence(snapshot);
  assert.equal(RETAINED_GWANGJU_PROJECTION_EVIDENCE_KEY, "retainedGwangjuProjectionEvidence");
  assert.equal(evidence.snapshotPath, `tools/datapack/sources/${snapshot.snapshotId}.json`);
  const HEAD = { snapshotId: RETAINED.snapshotId, rawObjectSha256: "b".repeat(64) };
  assert.deepEqual(validateRetainedGwangjuProjection({ snapshot, evidence, retainedEvidence: RETAINED, retainedHead: HEAD }), snapshot);

  const tampered = structuredClone(snapshot);
  tampered.records[0].trainNumber = "x";
  assert.throws(() => validateRetainedGwangjuProjection({ snapshot: tampered, evidence, retainedEvidence: RETAINED, retainedHead: HEAD }), /RETAINED_GWANGJU_PROJECTION_CONTENT/u);
  for (const change of [{ snapshotId: "other" }, { contentSha256: "0".repeat(64) }, { recordCount: 3 }, { retainedSnapshotId: "old" }]) {
    assert.throws(() => validateRetainedGwangjuProjection({ snapshot, evidence: { ...evidence, ...change }, retainedEvidence: RETAINED, retainedHead: HEAD }),
      /RETAINED_GWANGJU_PROJECTION_EVIDENCE/u);
  }
  // 보관본 head가 갱신됐는데 projection을 다시 만들지 않았으면 실패한다.
  assert.throws(() => validateRetainedGwangjuProjection({ snapshot, evidence, retainedEvidence: { ...RETAINED, snapshotId: "kric-nationwide-timetable-file-newer" },
    retainedHead: { ...HEAD, snapshotId: "kric-nationwide-timetable-file-newer" } }), /RETAINED_GWANGJU_PROJECTION_STALE/u);

  // 리뷰 F3: snapshot과 evidence를 함께 바꿔 내부 해시를 다시 맞춰도, 원장 head의 관측 객체 sha와 다르면 실패한다.
  const forged = projectRetainedGwangjuRecords({ retained: retained(), retainedEvidence: RETAINED, observationRawObjectSha256: "c".repeat(64) });
  assert.throws(() => validateRetainedGwangjuProjection({ snapshot: forged, evidence: retainedGwangjuProjectionEvidence(forged), retainedEvidence: RETAINED, retainedHead: HEAD }),
    /RETAINED_GWANGJU_PROJECTION_LEDGER/u);
  assert.throws(() => validateRetainedGwangjuProjection({ snapshot, evidence, retainedEvidence: RETAINED, retainedHead: { ...HEAD, snapshotId: "other" } }),
    /RETAINED_GWANGJU_PROJECTION_LEDGER/u);
});
