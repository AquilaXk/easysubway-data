import assert from "node:assert/strict";
import test from "node:test";

import { collectKorailItxCheongchunCompleteness } from "./collect-korail-itx-cheongchun-timetable.mjs";

test("Korail completeness는 TAGO provider failure context를 보존한다", async () => {
  for (const [message, failureContext] of [
    ["TAGO GetVhcleKndList provider resultCode 30", "operation=GetVhcleKndList,resultCode=30"],
    ["TAGO GetVhcleKndList schema mismatch: header", "operation=GetVhcleKndList,reason=schema_mismatch,header"],
    ["TAGO GetVhcleKndList schema mismatch: resultCode", "operation=GetVhcleKndList,reason=schema_mismatch,resultCode"],
  ]) {
    const artifact = await collectKorailItxCheongchunCompleteness({
      serviceKey: "key",
      serviceDates: { "8": "20260715", "7": "20260718", "9": "20260719" },
      packPath: "tools/route-map/route-map-defs/capital-s0-spike.sqlite.gz",
      now: new Date("2026-07-14T00:00:00.000Z"),
      collectRosterImpl: async () => { throw new Error(message); },
      collectTimetableImpl: async () => assert.fail("must not run"),
    });
    assert.equal(artifact.serviceDays[0].failureReasonCode,
      message.includes("schema mismatch") ? "PROVIDER_SCHEMA_FAILURE" : "PROVIDER_RESULT_FAILURE");
    assert.equal(artifact.serviceDays[0].failureContext, failureContext);
  }
});
