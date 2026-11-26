import assert from "node:assert/strict";
import test from "node:test";

import { collectSeoulPlatformGap, fetchSeoulPlatformGapPage } from "./collect-seoul-metro-platform-gap.mjs";

const CAPTURED_AT = "2026-10-20T01:00:00.000Z";

function okPage(totalCount, rows) {
  return new Response(
    JSON.stringify({
      TbSubwayLineInfo: {
        list_total_count: totalCount,
        RESULT: { CODE: "INFO-000", MESSAGE: "정상 처리되었습니다." },
        row: rows,
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

test("fetchSeoulPlatformGapPage는 AbortSignal·바이트 상한·빈 목록 Fail-Closed를 강제한다", async () => {
  const seenSignals = [];
  const page = await fetchSeoulPlatformGapPage({
    serviceKey: "gap-secret-key",
    fetchImpl: async (_url, init) => {
      seenSignals.push(init?.signal);
      return okPage(1, [{ STTN: "서울역" }]);
    },
  });
  assert.equal(page.totalCount, 1);
  assert.equal(page.rows.length, 1);
  assert.ok(seenSignals[0] instanceof AbortSignal);

  await assert.rejects(
    fetchSeoulPlatformGapPage({
      serviceKey: "gap-secret-key",
      fetchImpl: async () => new Response("{}", {
        status: 200,
        headers: { "content-length": String(17 * 1024 * 1024) },
      }),
    }),
    /exceeds maximum size/,
  );

  await assert.rejects(
    fetchSeoulPlatformGapPage({
      serviceKey: "gap-secret-key",
      fetchImpl: async () => okPage(0, []),
    }),
    /list_total_count is missing or not positive/,
  );

  await assert.rejects(
    fetchSeoulPlatformGapPage({
      serviceKey: "gap-secret-key",
      fetchImpl: async () => okPage(1, []),
    }),
    /row is empty/,
  );
});

test("collectSeoulPlatformGap은 다중 페이지를 합산하고 키를 마스킹하며 잘못된 limit을 거부한다", async () => {
  await assert.rejects(
    collectSeoulPlatformGap({ serviceKey: "gap-secret-key", capturedAt: CAPTURED_AT, limit: 0 }),
    /limit must be a positive integer/,
  );
  await assert.rejects(
    collectSeoulPlatformGap({ serviceKey: "gap-secret-key", capturedAt: CAPTURED_AT, limit: 100_000 }),
    /limit must be a positive integer/,
  );

  let pageCalls = 0;
  const result = await collectSeoulPlatformGap({
    serviceKey: "gap-secret-key",
    capturedAt: CAPTURED_AT,
    fetchImpl: async (url) => {
      pageCalls += 1;
      if (url.endsWith("/1/1000/")) {
        return okPage(1002, Array.from({ length: 1000 }, (_, i) => ({ idx: i + 1 })));
      }
      assert.ok(url.endsWith("/1001/1002/"), `unexpected page URL ${url}`);
      return okPage(1002, [{ idx: 1001 }, { idx: 1002 }]);
    },
  });
  assert.equal(pageCalls, 2);
  assert.equal(result.snapshot.rowCount, 1002);
  assert.equal(result.rawBytes.toString("utf8").includes("gap-secret-key"), false);
  assert.ok(result.rawBytes.toString("utf8").includes("[REDACTED]"));
});
