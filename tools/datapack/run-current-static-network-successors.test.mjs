import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { runPublicStaticNetworkV2Transition } from "./run-current-static-network-successors.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
test("current runner exposes only the input-only v2 transition", async () => {
  const module = await import("./run-current-static-network-successors.mjs");
  assert.deepEqual(Object.keys(module).sort(), ["runPublicStaticNetworkV2Transition"]);
});

test("v2 transition is input-only, builds once, exact-main fences registration, and registers once", async () => {
  const calls = []; const positionRawBytes = Buffer.from("position"); const molitRawBytes = Buffer.from("molit");
  const result = await runPublicStaticNetworkV2Transition({ repositoryRoot, positionRawBytes, molitRawBytes, positionReceipt: { receipt: "position" }, molitReceipt: { receipt: "molit" }, capturedAt: "2026-08-25T00:00:00.000Z",
    assertExactMain: async () => { calls.push("main"); return "a".repeat(40); },
    produceImpl: (input) => { calls.push(input); return { output: true }; },
    registerImpl: async (input) => { calls.push(input); return { outputs: ["ok"] }; },
  });
  assert.deepEqual(result, { outputs: ["ok"] }); assert.equal(calls.filter((value) => value === "main").length, 2);
  assert.equal(calls[1].positionRawBytes, positionRawBytes); assert.equal(calls[1].molitRawBytes, molitRawBytes);
  assert.deepEqual(calls[3].rawBytesBySource, { "seoul-metro-route-map-positions": positionRawBytes, "molit-urban-rail-full-route": molitRawBytes });
});

test("retired runner has no public entrypoint", async () => {
  const module = await import("./run-current-static-network-successors.mjs");
  assert.equal("runCurrentStaticNetworkSuccessors" in module, false);
  assert.equal("runRetiredCurrentStaticNetworkSuccessorsCli" in module, false);
});
