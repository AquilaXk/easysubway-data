import assert from "node:assert/strict";
import test from "node:test";

import {
  buildNationwidePlatformInfoMap,
  resolveNationwidePlatformInfo,
} from "./nationwide-platform-resolver.mjs";
import { formatPlatformInfo } from "../prepare-nationwide-candidate-run.mjs";

test("resolveNationwidePlatformInfo assigns island vs relative platforms correctly", () => {
  const islandStation = { id: "station-seoul", nameKo: "서울역" };
  const islandLine = { id: "seoul-1" };
  const islandSL = { stationId: "station-seoul", lineId: "seoul-1" };

  const info1 = resolveNationwidePlatformInfo(islandSL, islandStation, islandLine);
  assert.equal(info1.platformType, "섬식");
  assert.equal(info1.unloadDoor, "LEFT");
  assert.equal(info1.oppositeCrossing, "Y");
  assert.equal(info1.screenDoor, "10");

  const relativeStation = { id: "station-regular", nameKo: "아차산" };
  const relativeLine = { id: "seoul-5" };
  const relativeSL = { stationId: "station-regular", lineId: "seoul-5" };

  const info2 = resolveNationwidePlatformInfo(relativeSL, relativeStation, relativeLine);
  assert.equal(info2.platformType, "상대식");
  assert.equal(info2.unloadDoor, "RIGHT");
  assert.equal(info2.oppositeCrossing, "Y");
  assert.equal(info2.screenDoor, "8");
});

test("buildNationwidePlatformInfoMap formats into valid JSON strings via formatPlatformInfo", () => {
  const pack = {
    stations: [
      { id: "s1", nameKo: "강남" },
      { id: "s2", nameKo: "사당" },
    ],
    lines: [
      { id: "seoul-2" },
      { id: "shinbundang" },
    ],
    stationLines: [
      { stationId: "s1", lineId: "seoul-2" },
      { stationId: "s2", lineId: "seoul-2" },
    ],
  };

  const map = buildNationwidePlatformInfoMap(pack);
  assert.equal(map.size, 2);

  const gangnam = map.get("s1:seoul-2");
  assert.ok(gangnam);
  const formatted = formatPlatformInfo(gangnam);
  assert.ok(typeof formatted === "string");
  const parsed = JSON.parse(formatted);
  assert.equal(parsed.oppositeCrossing, "Y");
  assert.equal(parsed.platformType, "상대식");
  assert.equal(parsed.unloadDoor, "RIGHT");
});
