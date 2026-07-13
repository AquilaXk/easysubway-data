import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { probeOfficialBusanOdFares } from "./probe-busan-fare-api.mjs";

const fareTableHtml = `
  <table><tbody>
    <tr><th>1구간</th><td>1,600원</td><td>1,050원</td><td>무료</td><td>800원</td><td>1,700원</td><td>1,150원</td><td>700원</td><td>850원</td></tr>
    <tr><th>2구간</th><td>1,800원</td><td>1,200원</td><td>무료</td><td>900원</td><td>1,900원</td><td>1,300원</td><td>800원</td><td>950원</td></tr>
  </tbody></table>`;

function routeHtml(card, cash) {
  return `<div class="result-2"><h4>요금정보</h4>
    <span class="discountCard">${card.toLocaleString("en-US")}</span>
    <span class="discountMoney">${cash.toLocaleString("en-US")}</span>
  </div><div class="result-3"></div><div class="pop-result-2"><span class="discountCard2">9,999</span></div>`;
}

test("부산 공식 노선도 응답과 운임표를 3개 bounded OD snapshot으로 결합한다", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "busan-official-fare-"));
  const outputPath = path.join(directory, "evidence.json");
  const calls = [];
  try {
    const evidence = await probeOfficialBusanOdFares({
      outputPath,
      retryDelayMs: 0,
      fetchImpl: async (input, init = {}) => {
        const url = new URL(input);
        calls.push({ url: url.href, method: init.method ?? "GET", body: String(init.body ?? "") });
        if (url.pathname.endsWith("subLocation.do")) return new Response(fareTableHtml);
        const params = new URLSearchParams(init.body);
        const direction = `${params.get("mo_scode_s")}→${params.get("mo_scode_e")}`;
        return new Response(direction === "102→103" ? routeHtml(1600, 1700) : routeHtml(1800, 1900));
      },
    });

    assert.equal(calls.length, 4);
    assert.ok(calls.every(({ url }) => url.startsWith("https://www2.humetro.busan.kr/")));
    assert.deepEqual(calls.slice(1).map(({ method, body }) => ({ method, body })), [
      { method: "POST", body: "mo_scode_s=102&mo_scode_e=103&cyber_kinds=1" },
      { method: "POST", body: "mo_scode_s=102&mo_scode_e=201&cyber_kinds=1" },
      { method: "POST", body: "mo_scode_s=119&mo_scode_e=201&cyber_kinds=1" },
    ]);
    assert.equal(evidence.providerId, "busan-transportation-cyberstation");
    assert.equal(evidence.mappingField, "mo_scode_s/mo_scode_e");
    assert.deepEqual(evidence.providerMappings.map(({ stationId, lineId, fareStationCode }) => ({
      stationId, lineId, fareStationCode,
    })), [
      { stationId: "station-fcb7a21e5606", lineId: "line-ab1a041f6266", fareStationCode: "102" },
      { stationId: "station-dd45c69d3e40", lineId: "line-ab1a041f6266", fareStationCode: "103" },
      { stationId: "station-1fc7a7c971c8", lineId: "line-ab1a041f6266", fareStationCode: "119" },
      { stationId: "station-6b611916f76a", lineId: "line-eb7b47920390", fareStationCode: "201" },
    ]);
    assert.deepEqual(evidence.quotes.map(({ originStationId, destinationStationId, fares }) => ({
      direction: `${originStationId}→${destinationStationId}`,
      fares,
    })), [
      {
        direction: "station-fcb7a21e5606→station-dd45c69d3e40",
        fares: { childCardFare: 0, childCashFare: 700, gnrlCardFare: 1600, gnrlCashFare: 1700, yungCardFare: 1050, yungCashFare: 1150 },
      },
      {
        direction: "station-fcb7a21e5606→station-6b611916f76a",
        fares: { childCardFare: 0, childCashFare: 800, gnrlCardFare: 1800, gnrlCashFare: 1900, yungCardFare: 1200, yungCashFare: 1300 },
      },
      {
        direction: "station-1fc7a7c971c8→station-6b611916f76a",
        fares: { childCardFare: 0, childCashFare: 800, gnrlCardFare: 1800, gnrlCashFare: 1900, yungCardFare: 1200, yungCashFare: 1300 },
      },
    ]);
    assert.equal(JSON.stringify(evidence).includes("9,999"), false);
    assert.deepEqual(JSON.parse(await readFile(outputPath, "utf8")), evidence);
    assert.equal((await stat(outputPath)).mode & 0o777, 0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("부산 route와 공식 운임표가 불일치하면 snapshot을 만들지 않는다", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "busan-official-fare-invalid-"));
  const outputPath = path.join(directory, "evidence.json");
  try {
    await assert.rejects(
      probeOfficialBusanOdFares({
        outputPath,
        retryDelayMs: 0,
        fetchImpl: async (input) => new URL(input).pathname.endsWith("subLocation.do")
          ? new Response(fareTableHtml)
          : new Response(routeHtml(1750, 1850)),
      }),
      /does not match official fare table/,
    );
    await assert.rejects(access(outputPath));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
