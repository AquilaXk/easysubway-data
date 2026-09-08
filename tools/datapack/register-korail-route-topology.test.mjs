import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  buildKorailTopologyRegistrationOutputs,
  commitKorailTopologyRegistrationOutputs,
} from "./register-korail-route-topology.mjs";

test("requires absolute immutable source and raw receipt inputs before registration", async () => {
  await assert.rejects(buildKorailTopologyRegistrationOutputs({
    repositoryRoot: ".", sourceInputPath: "source.json", receiptPath: "receipt.json",
  }), /KORAIL_TOPOLOGY_REGISTRATION_ROOT/);
  await assert.rejects(buildKorailTopologyRegistrationOutputs({
    repositoryRoot: path.resolve("."), sourceInputPath: "source.json", receiptPath: path.resolve("receipt.json"),
  }), /KORAIL_TOPOLOGY_REGISTRATION_SOURCE_INPUT/);
});

test("rejects arbitrary output sets before a transaction can mutate targets", async () => {
  await assert.rejects(commitKorailTopologyRegistrationOutputs({
    repositoryRoot: path.resolve("."), outputs: [],
  }), /KORAIL_TOPOLOGY_REGISTRATION_OUTPUTS/);
});
