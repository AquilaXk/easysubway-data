import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { collectGwangjuCyberstationTimetable } from "./collect-gwangju-cyberstation-timetable.mjs";

function fragment(stationId) {
  return `<div class="pd"><h4>평동역 방면</h4><ul><li>
    <strong class="hour hide">05<b>시</b></strong>
    <span class="minute WEEK SAT">25<b>분</b></span>
    <span class="minute DAYOFF">25<b>분</b></span><span class="minute HOLI">25<b>분</b></span>
    <span class="minute HOLI">99<b>분</b></span>
    <span class="minute HOLI">60<b>분</b></span>
    </li></ul></div><div class="nd"><h4>소태역 방면</h4><ul><li>
    <strong class="hour hide">06<b>시</b></strong>
    <span class="minute nd WEEK">03<b>분</b></span><span class="minute SAT">03<b>분</b></span>
    </li></ul></div><i data-station="${stationId}"></i>`;
}

test("광주 cyberstation collector는 공식 20개 역 timetable fragment를 bounded fan-out한다", async () => {
  const requests = [];
  const snapshot = await collectGwangjuCyberstationTimetable({
    now: new Date("2026-07-20T13:00:00.000Z"),
    fetchImpl: async (url, init) => {
      if (url === "https://www.grtc.co.kr/cyber") {
        requests.push({ url, init });
        return new Response("<script>var token = 'test-csrf-token'; var header = 'X-XSRF-TOKEN';</script>", {
          headers: { "content-type": "text/html;charset=UTF-8", "set-cookie": "JSESSIONID=test-session; Path=/; HttpOnly" },
        });
      }
      const body = new URLSearchParams(init.body);
      requests.push({ url, init, body });
      return new Response(fragment(body.get("subwayid")), { headers: { "content-type": "text/html;charset=UTF-8" } });
    },
  });

  assert.equal(requests.length, 21);
  assert.equal(requests[0].url, "https://www.grtc.co.kr/cyber");
  assert.equal(requests[1].url, "https://www.grtc.co.kr/cyber/portlet/subwayTimetable");
  assert.equal(requests[1].init.method, "POST");
  assert.equal(requests[1].init.headers.AJAX, "true");
  assert.equal(requests[1].init.headers["X-XSRF-TOKEN"], "test-csrf-token");
  assert.equal(requests[1].init.headers.cookie, "JSESSIONID=test-session");
  assert.deepEqual([...requests[1].body], [["lineNo", "1"], ["subwayid", "01"]]);
  assert.equal(snapshot.artifactKind, "gwangju-cyberstation-timetable-snapshot");
  assert.equal(snapshot.sourceId, "gwangju-transportation-cyberstation-timetable");
  assert.equal(snapshot.stationCount, 20);
  assert.equal(snapshot.requestCount, 21);
  assert.equal(snapshot.stationRequestCount, 20);
  assert.equal(snapshot.fragments.length, 20);
  assert.equal(snapshot.fragments.some((fragment) => "html" in fragment), false);
  assert.equal(snapshot.rowCount, 140);
  assert.equal(snapshot.excludedPlaceholderCount, 20);
  assert.equal(snapshot.normalizedBoundaryMinuteCount, 20);
  assert.equal(snapshot.rows.some((row) => row.time === "0600"), true);
  assert.equal(snapshot.rows.length, 140);
  assert.deepEqual(snapshot.dayCodes, ["DAYOFF", "HOLI", "SAT", "WEEK"]);
  assert.deepEqual(snapshot.directions, ["nd", "pd", "st"]);
  assert.deepEqual(snapshot.rows[0], {
    stationId: "01", stationCode: "119", stationName: "평동역", dayCode: "DAYOFF",
    direction: "pd", endCode: "119", endName: "평동역", time: "0525",
  });
  assert.match(snapshot.contentSha256, /^[a-f0-9]{64}$/);
  assert.match(snapshot.rawSha256, /^[a-f0-9]{64}$/);
  assert.match(snapshot.rowsSha256, /^[a-f0-9]{64}$/);
  assert.equal(snapshot.credentialRedacted, true);
  assert.doesNotMatch(JSON.stringify(snapshot), /test-csrf-token|test-session/);
});

test("광주 cyberstation collector는 fragment scope·content-type·transport 오류를 fail closed한다", async () => {
  await assert.rejects(collectGwangjuCyberstationTimetable({
    fetchImpl: async () => new Response("not html", { headers: { "content-type": "text/plain" } }),
  }), /content-type text\/plain/);
  await assert.rejects(collectGwangjuCyberstationTimetable({
    fetchImpl: async (url) => url === "https://www.grtc.co.kr/cyber"
      ? new Response("<script>var token = 'test-token'; var header = 'X-XSRF-TOKEN';</script>", {
        headers: { "content-type": "text/html", "set-cookie": "JSESSIONID=session; Path=/" },
      })
      : new Response("<div>missing timetable markers</div>", { headers: { "content-type": "text/html" } }),
  }), /schema mismatch: station \d{2}/);
  const transport = Object.assign(new Error("raw provider detail"), { code: "ENOTFOUND" });
  await assert.rejects(collectGwangjuCyberstationTimetable({
    sleepImpl: async () => {},
    fetchImpl: async () => { throw transport; },
  }), (error) => {
    assert.match(error.message, /transport failure; code=ENOTFOUND/);
    assert.doesNotMatch(error.message, /raw provider detail/);
    return true;
  });
});

test("광주 cyberstation 공식 20260720 snapshot identity와 전체 scope를 고정한다", async () => {
  const bytes = await readFile(new URL(
    "./sources/gwangju-transportation-cyberstation-timetable-20260720.json",
    import.meta.url,
  ));
  const snapshot = JSON.parse(bytes);
  const hash = (value) => createHash("sha256").update(value).digest("hex");

  assert.equal(snapshot.capturedAt, "2026-07-20T12:55:50.079Z");
  assert.equal(snapshot.rowCount, 13362);
  assert.equal(snapshot.stationCount, 20);
  assert.equal(snapshot.excludedPlaceholderCount, 1);
  assert.equal(snapshot.normalizedBoundaryMinuteCount, 1);
  assert.equal(snapshot.scopeSha256, "5f6767ee8345a9caccaf2d367019d224bf7a60bbceda846b9f84cdf8114a8de1");
  assert.equal(snapshot.contentSha256, "b050ed92cbdd555e22e987e4854a7d60b5293951992d6c14ae26c110f9b4fb5a");
  assert.equal(snapshot.rawSha256, "852b75f79ca7cccf8dfefc65ee4fe226f833e6cd2e52f5e721efdfac2efdc31a");
  assert.equal(snapshot.rowsSha256, hash(JSON.stringify(snapshot.rows)));
  assert.equal(snapshot.rowsSha256, "2eec08dc30a97c50fd349dc607e77677829881790b5ca896856caa4b9bbd3ccd");
  assert.equal(snapshot.fragments.some((fragment) => "html" in fragment), false);
  assert.deepEqual(snapshot.dayCodes, ["DAYOFF", "HOLI", "SAT", "WEEK"]);
  assert.deepEqual(snapshot.directions, ["nd", "pd", "st"]);
  assert.doesNotMatch(bytes.toString("utf8"), /JSESSIONID|X-XSRF-TOKEN|var token/i);
});
