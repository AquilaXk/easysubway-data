import assert from "node:assert/strict";
import test from "node:test";
import { stationLabelIdentity } from "./extract-svg-geometry.mjs";

function element(attributes) {
  return { getAttribute: (name) => attributes[name] ?? null };
}

test("preserves explicit SVG station-label identity without inferring missing values", () => {
  const labels = [
    element({
      "data-station-key": "busan-101",
      "data-station": "서면",
      "data-line": "1",
      "data-label-role": "station",
    }),
    element({
      "data-station-key": "busan-201",
      "data-station": "서면",
      "data-line": "2",
      "data-label-role": "station",
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
