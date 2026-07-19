import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  DAEJEON_LINE1_STATION_NUMBERS,
  collectDaejeonRouteTopology,
} from "./collect-daejeon-route-topology.mjs";

test("대전 topology collector는 22개 역 인접 21구간을 양방향으로 검증한다", async () => {
  const secret = "do-not-store-daejeon-key";
  const requests = [];
  const artifact = await collectDaejeonRouteTopology({
    serviceKey: secret,
    now: new Date("2026-07-20T00:00:00.000Z"),
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      requests.push({
        from: parsed.searchParams.get("strstnno"),
        to: parsed.searchParams.get("endstnno"),
        key: parsed.searchParams.get("serviceKey"),
      });
      return new Response(
        "<response><header><resultCode>00</resultCode></header><body><items><item>"
          + "<distfloat>1.2</distfloat><fee>1400</fee><min>2</min><sec>30</sec>"
          + "</item></items></body></response>",
        { status: 200, headers: { "content-type": "application/xml" } },
      );
    },
  });

  assert.deepEqual(DAEJEON_LINE1_STATION_NUMBERS,
    Array.from({ length: 22 }, (_, index) => String(101 + index)));
  assert.equal(requests.length, 42);
  assert.ok(requests.every(({ key }) => key === secret));
  assert.equal(artifact.rowCount, 42);
  assert.equal(artifact.rows.length, 42);
  assert.deepEqual(artifact.rows[0], {
    fromStationNumber: "101",
    toStationNumber: "102",
    distanceKilometers: 1.2,
    fareWon: 1400,
    travelTimeSeconds: 150,
    responseSha256: artifact.rows[0].responseSha256,
  });
  assert.deepEqual(artifact.rows[1], {
    fromStationNumber: "102",
    toStationNumber: "101",
    distanceKilometers: 1.2,
    fareWon: 1400,
    travelTimeSeconds: 150,
    responseSha256: artifact.rows[1].responseSha256,
  });
  assert.equal(artifact.rowsSha256,
    createHash("sha256").update(JSON.stringify(artifact.rows)).digest("hex"));
  assert.equal(artifact.contentSha256, artifact.rowsSha256);
  assert.equal(artifact.rawSha256, createHash("sha256")
    .update(JSON.stringify(artifact.rows.map(({ responseSha256 }) => responseSha256))).digest("hex"));
  assert.equal(artifact.excludedTransferCount, 0);
  assert.equal(artifact.credentialRedacted, true);
  assert.doesNotMatch(JSON.stringify(artifact), new RegExp(secret));
});

test("대전 topology collector는 인접 OD가 단일 row가 아니면 fail closed한다", async () => {
  await assert.rejects(collectDaejeonRouteTopology({
    serviceKey: "key",
    fetchImpl: async () => new Response(
      "<response><header><resultCode>00</resultCode></header><body><items>"
        + "<item><distfloat>1</distfloat><fee>1400</fee><min>2</min><sec>0</sec></item>"
        + "<item><distfloat>2</distfloat><fee>1400</fee><min>4</min><sec>0</sec></item>"
        + "</items></body></response>",
      { status: 200, headers: { "content-type": "application/xml" } },
    ),
  }), /must return exactly one row/);
});
