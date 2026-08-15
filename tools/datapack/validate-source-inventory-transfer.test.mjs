import assert from "node:assert/strict";
import test from "node:test";

import { validateCapabilities } from "./validate-source-inventory.mjs";

const SOURCE = {
  id: "seoul-metro-transfer-distance-duration",
  requiredForProductionPack: true,
  license: { commercialUseAllowed: true, redistributionAllowed: true },
};

const unsupported = (notes) => ({
  status: "UNSUPPORTED",
  productionUseAllowed: false,
  coverageStatus: "NOT_PROVIDED_BY_SOURCE",
  updateFrequency: "provider realtime; production cadence not admitted",
  unsupportedNotes: notes,
});

test("TRANSFER source alone closes the transfer capability contract", () => {
  assert.doesNotThrow(() => validateCapabilities({
    schedule: unsupported("schedule unavailable"),
    realtime: { ...unsupported("realtime unavailable"), liveEtaEligible: false, rateLimitStatus: "NOT_APPLICABLE" },
    facility: unsupported("facility unavailable"),
    transfer: {
      status: "SUPPORTED",
      productionUseAllowed: true,
      coverageStatus: "CAPITAL_SEOUL_METRO_15_PAIRS_30_DIRECTED_METRICS",
      updateFrequency: "annual file snapshot",
      unsupportedNotes: "공식 소요시간은 reference-only이며 runtime 환승시간은 거리와 선택한 보행속도로 계산한다",
    },
  }, SOURCE, SOURCE.id));
});

test("other sources cannot declare the closed TRANSFER capability", () => {
  assert.throws(() => validateCapabilities({
    schedule: unsupported("schedule unavailable"),
    realtime: { ...unsupported("realtime unavailable"), liveEtaEligible: false, rateLimitStatus: "NOT_APPLICABLE" },
    facility: unsupported("facility unavailable"),
    transfer: {
      status: "SUPPORTED", productionUseAllowed: true,
      coverageStatus: "CAPITAL_SEOUL_METRO_15_PAIRS_30_DIRECTED_METRICS",
      updateFrequency: "annual file snapshot",
      unsupportedNotes: "공식 소요시간은 reference-only이며 runtime 환승시간은 거리와 선택한 보행속도로 계산한다",
    },
  }, { ...SOURCE, id: "another-source" }, "another-source"));
});

test("unregistered transfer source retains the exact legacy three-capability state", () => {
  assert.doesNotThrow(() => validateCapabilities({
    schedule: unsupported("schedule unavailable"),
    realtime: { ...unsupported("realtime unavailable"), liveEtaEligible: false, rateLimitStatus: "NOT_APPLICABLE" },
    facility: unsupported("facility unavailable"),
  }, { ...SOURCE, requiredForProductionPack: false }, SOURCE.id));
});
