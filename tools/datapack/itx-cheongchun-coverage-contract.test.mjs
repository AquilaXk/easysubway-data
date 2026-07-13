import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const contract = JSON.parse(await readFile(new URL("./itx-cheongchun-coverage-contract.json", import.meta.url), "utf8"));

test("ITX-청춘 coverage contract는 OD 성공을 stop-sequence 지원으로 과장하지 않는다", () => {
  assert.deepEqual(contract.coverageStates, {
    station_line_membership: "SUPPORTED",
    route_graph_topology: "MISSING",
    schedule_timetable: "MISSING",
  });
  assert.equal(contract.officialEvidence.tagoTrainOd.providerResultCode, "00");
  assert.equal(contract.officialEvidence.tagoTrainOd.rowCount, 18);
  assert.equal(contract.officialEvidence.tagoTrainOd.query.kricServiceDayCode, "8");
  assert.equal(contract.officialEvidence.tagoTrainOd.limitation, "OD 결과는 완전한 trip stop sequence가 아니다.");
  assert.equal(contract.officialEvidence.kricUrbanTimetable.trainNumberJoinCount, 0);
  assert.equal(contract.officialEvidence.kricStationTimetable.providerResultCode, "30");
  assert.equal(contract.materialization.status, "MISSING_STATION_LEVEL_ITX_ROWS");
  assert.equal(contract.claimGate.supportClaimAllowed, false);
  assert.equal(contract.claimGate.currentStatus, "NO_GO");
});

test("ITX-청춘 evidence는 공식 URL·schema/hash·재검토 시점을 갖고 credential을 포함하지 않는다", () => {
  const serialized = JSON.stringify(contract);
  for (const evidence of Object.values(contract.officialEvidence)) {
    assert.match(evidence.officialSourceUrl, /^https:\/\/(?:data\.kric\.go\.kr|www\.data\.go\.kr)\//);
    assert.match(evidence.endpoint, /^https:\/\/(?:openapi\.kric\.go\.kr|apis\.data\.go\.kr)\//);
  }
  assert.match(contract.officialEvidence.kricRouteRoster.schemaFingerprint, /^[a-f0-9]{64}$/);
  assert.match(contract.officialEvidence.tagoTrainOd.evidenceHash, /^[a-f0-9]{64}$/);
  assert.equal(new Date(contract.freshness.nextReviewAt).toISOString(), contract.freshness.nextReviewAt);
  assert.doesNotMatch(serialized, /serviceKey=|KRIC_SERVICE_KEY|DATA_GO_KR_SERVICE_KEY/);
});
