import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  buildKorailTopologyRegistrationOutputs,
  commitKorailTopologyRegistrationOutputs,
  parseKorailTopologyRegistrationArgs,
  publishAndRegisterKorailRouteTopology,
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

// #862: CLI는 명시 main·HEAD SHA를 요구하고, 후손이 아닌 HEAD에서는 준비·게시 전에 멈춘다.
test("publish-register CLI requires explicit SHAs and the selected-head guard runs before preparation", async () => {
  const main = "a".repeat(40); const head = "b".repeat(40);
  assert.throws(() => parseKorailTopologyRegistrationArgs(["publish-register", "--source-input", "/tmp/input.json", "--operation-directory", "/tmp/op"]), /KORAIL_TOPOLOGY_REGISTRATION_CLI/);
  assert.deepEqual(parseKorailTopologyRegistrationArgs(["publish-register", "--source-input", "/tmp/input.json", "--operation-directory", "/tmp/op", "--expected-main-sha", main, "--expected-head-sha", head]),
    { "source-input": "/tmp/input.json", "operation-directory": "/tmp/op", "expected-main-sha": main, "expected-head-sha": head });
  await assert.rejects(publishAndRegisterKorailRouteTopology({ repositoryRoot: path.resolve("."), sourceInputPath: "/nonexistent/input.json", operationDirectory: "/nonexistent/op",
    expectedMainSha: main, expectedHeadSha: head,
    gitRunner: async (args) => { if (args[0] === "status") return ""; if (args[0] === "merge-base") throw new Error("not ancestor"); return args[1] === "HEAD" ? head : main; } }),
  /selected-head preflight failed/);
});
