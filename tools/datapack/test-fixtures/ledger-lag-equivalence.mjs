import assert from "node:assert/strict";

import { validateLineage } from "../source-snapshot-policy.mjs";

// #1005·#1007: 정기 갱신 PR은 원장에 새 head를 덧붙이고, 그 head에 결속된 팩·후보·projection은 병합 뒤 후속 단계가 다시 만든다.
// 그 사이 required-pr 계약 테스트가 "팩·후보가 가리키는 행이 head보다 앞선다"는 사실만으로 실패하면 정당한 갱신이 모두 막힌다.
// 반대로 사슬 구성원이기만 하면 통과시키면 내용이 바뀐 head 뒤에 낡은 팩이 남아도 어디서도 실패하지 않는다.
// 그래서 뒤처짐은 "가리키는 행부터 head까지 경로의 모든 행이 내용상 같을 때"만 허용한다. 내용이 하나라도 바뀌었으면
// 팩·후보는 head와 같아야 하고, 아니면 실패한다.
//
// release 게이트와의 관계: validate-candidate-source-set.mjs(114행 `candidate source is not the active ledger head`)는
// release-candidate·candidate-create에서 후보 원천이 head와 정확히 같을 것을 내용 동등과 무관하게 요구한다(fail-closed).
// 이 헬퍼는 그 게이트를 완화하지 않는다. required-pr에서만 "내용이 같은 재확인"에 한해 뒤처짐을 허용한다.

/**
 * 기본 내용 키: snapshot 수준 원본 sha256(`rawReceipt.snapshotRawSha256`)과 정규화한 내용 sha256. 둘 중 하나라도 바뀌면 내용이 바뀐 것이다.
 * 원장 행의 `rawSha256`은 수집 시각이 들어간 OCI 원본 객체의 sha라서 내용이 같아도 갱신마다 달라지므로 쓰지 않는다
 * (rawReceipt가 없는 행만 `rawSha256`로 되돌아간다). 원천이 다른 기준이 필요하면 contentKeyOf를 넘긴다.
 */
export const defaultContentKey = (row) => JSON.stringify({
  rawSha256: row.rawReceipt?.snapshotRawSha256 ?? row.rawSha256,
  contentSha256: row.contentSha256,
});

/**
 * 원장 head를 계보(validateLineage)로 고른다. 같은 원천의 head가 없으면 실패한다.
 * @returns {string} head snapshotId
 */
export function ledgerHeadOf(ledger, sourceId) {
  const head = validateLineage(ledger).headsBySource[sourceId];
  assert.ok(typeof head === "string" && head !== "", `LAG_NO_HEAD: ${sourceId}`);
  return head;
}

/**
 * `snapshotId`(팩·후보·projection이 가리키는 행)에서 `headSnapshotId`까지 previousSnapshotId 경로를 걸어
 * 경로의 모든 행이 `snapshotId` 행과 내용 키가 같을 때만 통과한다. snapshotId가 head이면 항상 통과한다.
 * 실패 코드: LAG_NOT_IN_LEDGER(원장에 없음), LAG_OFF_CHAIN(head 경로 밖), LAG_CONTENT_CHANGED(경로 중 내용 변경).
 * @returns {string[]} snapshotId에서 head까지의 경로(snapshotId 포함, head 포함)
 */
export function assertLagIsContentEquivalent({ ledger, sourceId, snapshotId, headSnapshotId, contentKeyOf = defaultContentKey, label = "snapshot" }) {
  const rows = new Map(ledger.filter((row) => row.sourceId === sourceId).map((row) => [row.snapshotId, row]));
  assert.ok(rows.has(snapshotId), `LAG_NOT_IN_LEDGER: ${label} ${snapshotId}은 ${sourceId} 원장 행이어야 한다`);
  assert.ok(rows.has(headSnapshotId), `LAG_NOT_IN_LEDGER: ${label}의 head ${headSnapshotId}은 ${sourceId} 원장 행이어야 한다`);
  const path = [];
  for (let id = headSnapshotId; id !== undefined && id !== null; id = rows.get(id)?.previousSnapshotId) {
    assert.ok(!path.includes(id), `LAG_OFF_CHAIN: ${sourceId} 원장 previousSnapshotId 경로에 순환이 없어야 한다`);
    path.push(id);
    if (id === snapshotId) break;
    assert.ok(rows.has(id), `LAG_OFF_CHAIN: ${label} ${snapshotId}은 head ${headSnapshotId}에서 previousSnapshotId로 이어져야 한다`);
  }
  assert.ok(path.at(-1) === snapshotId, `LAG_OFF_CHAIN: ${label} ${snapshotId}은 head ${headSnapshotId}에서 previousSnapshotId로 이어져야 한다`);
  const expected = contentKeyOf(rows.get(snapshotId));
  for (const id of path) {
    assert.equal(contentKeyOf(rows.get(id)), expected, `LAG_CONTENT_CHANGED: ${label} ${snapshotId}부터 head ${headSnapshotId}까지 ${id}에서 내용이 바뀌었다. 이 경우 head와 같아야 한다`);
  }
  return path.reverse();
}
