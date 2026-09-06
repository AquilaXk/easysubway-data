import assert from "node:assert/strict";
import test from "node:test";
import { stationLabelIdentity } from "./extract-svg-geometry.mjs";

function element(dataset) {
  return { dataset };
}

test("preserves explicit SVG station-label identity without inferring missing values", () => {
  const labels = [
    element({
      stationKey: "busan-101",
      station: "서면",
      line: "1",
      labelRole: "station",
    }),
    element({
      stationKey: "busan-201",
      station: "서면",
      line: "2",
      labelRole: "station",
    }),
    element({}),
  ];
  const expected = [
    { dataStationKey: "busan-101", dataStation: "서면", dataLine: "1", labelRole: "station" },
    { dataStationKey: "busan-201", dataStation: "서면", dataLine: "2", labelRole: "station" },
    { dataStationKey: "", dataStation: "", dataLine: "", labelRole: "" },
  ];

  assert.deepEqual(labels.map(stationLabelIdentity), expected);

  const serializedHelper = Function(`return (${stationLabelIdentity.toString()});`)();
  assert.deepEqual(labels.map(serializedHelper), expected);
});
