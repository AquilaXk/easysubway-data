import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { collectBusanAccessibility } from "./collect-busan-accessibility.mjs";

const topology = JSON.parse(await readFile(
  new URL("./sources/busan-transportation-route-topology-20260720.json", import.meta.url),
  "utf8",
));

const FIELDS = {
  wl_i: "0", wl_o: "0", el_i: "2", el_o: "1", es: "3", blindroad: "1",
  ourbridge: "1", helptake: "2", toilet: "1", toilet_gubun: "분리",
};

function response(stationName, values = FIELDS) {
  const fields = Object.entries({ sname: stationName, ...values })
    .map(([name, value]) => `<${name}>${value}</${name}>`).join("");
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><response>
    <header><resultCode>00</resultCode><resultMsg>정상</resultMsg></header>
    <body>${fields}</body></response>`, { headers: { "content-type": "application/xml" } });
}

test("부산 accessibility collector는 topology 114개 역을 bounded fan-out한다", async () => {
  const requested = [];
  const secret = "never-print-service-key";
  const snapshot = await collectBusanAccessibility({
    serviceKey: secret,
    stationScopes: topology.scope,
    now: new Date("2026-07-20T10:30:00.000Z"),
    fetchImpl: async (url) => {
      const request = new URL(url);
      requested.push(request);
      const station = topology.scope.find(({ stationCode }) => stationCode === request.searchParams.get("scode"));
      return response(station.stationName);
    },
  });

  assert.equal(requested.length, 114);
  assert.equal(snapshot.requestCount, 114);
  assert.equal(snapshot.stationCount, 114);
  assert.equal(snapshot.rowCount, 114);
  assert.deepEqual([...requested[0].searchParams], [
    ["serviceKey", secret], ["act", "xml"], ["scode", topology.scope[0].stationCode],
  ]);
  assert.deepEqual(snapshot.lineIds, topology.lineIds);
  assert.equal(snapshot.credentialRedacted, true);
  assert.match(snapshot.rowsSha256, /^[a-f0-9]{64}$/);
  assert.match(snapshot.rawSha256, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(snapshot), new RegExp(secret));
  assert.deepEqual(snapshot.rows[0], {
    stationCode: topology.scope[0].stationCode,
    stationName: topology.scope[0].stationName,
    lineId: topology.scope[0].lineId,
    ...Object.fromEntries(Object.entries(FIELDS).map(([name, value]) => [name, name === "toilet_gubun" ? value : Number(value)])),
  });
});

test("부산 accessibility collector는 누락·음수 시설 값을 fail closed한다", async () => {
  await assert.rejects(collectBusanAccessibility({
    serviceKey: "key",
    stationScopes: topology.scope,
    fetchImpl: async () => response("역", { ...FIELDS, el_i: "-1" }),
  }), /values=el_i/);
  const { toilet: _toilet, ...missing } = FIELDS;
  await assert.rejects(collectBusanAccessibility({
    serviceKey: "key",
    stationScopes: topology.scope,
    fetchImpl: async () => response("역", missing),
  }), /fields=toilet/);
});

test("부산 accessibility collector는 빈 count 필드를 0으로 정규화한다", async () => {
  const snapshot = await collectBusanAccessibility({
    serviceKey: "key",
    stationScopes: topology.scope,
    now: new Date("2026-07-24T00:00:00.000Z"),
    fetchImpl: async () => response("다대포해수욕장", {
      ...FIELDS,
      wl_i: "",
      wl_o: "",
      ourbridge: "",
      helptake: "",
    }),
  });
  assert.equal(snapshot.rows[0].wl_i, 0);
  assert.equal(snapshot.rows[0].wl_o, 0);
  assert.equal(snapshot.rows[0].ourbridge, 0);
  assert.equal(snapshot.rows[0].helptake, 0);
  assert.equal(snapshot.rows[0].el_i, 2);
});

test("부산 accessibility collector는 credential 없는 provider·transport 진단만 남긴다", async () => {
  const secret = "never-print-service-key";
  await assert.rejects(collectBusanAccessibility({
    serviceKey: secret,
    stationScopes: topology.scope,
    fetchImpl: async () => new Response(`<?xml version="1.0"?><response>
      <header><resultCode>30</resultCode><resultMsg>${secret}</resultMsg></header></response>`, {
      headers: { "content-type": "application/xml" },
    }),
  }), (error) => {
    assert.match(error.message, /provider resultCode 30/);
    assert.doesNotMatch(error.message, new RegExp(secret));
    return true;
  });
  const transport = Object.assign(new Error(`secret ${secret}`), { code: "ENOTFOUND" });
  await assert.rejects(collectBusanAccessibility({
    serviceKey: secret,
    stationScopes: topology.scope,
    sleepImpl: async () => {},
    fetchImpl: async () => { throw transport; },
  }), (error) => {
    assert.match(error.message, /transport failure; code=ENOTFOUND/);
    assert.doesNotMatch(error.message, new RegExp(secret));
    return true;
  });
});
