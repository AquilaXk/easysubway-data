import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { parseArgs, runKorailTopologyRegistration } from "./run-korail-route-topology-registration.mjs";

const root = path.resolve(".");
const sourceInputPath = path.join(root, "input.json");
const operationDirectory = path.join(root, "operation");

test("accepts closed publication and retained-receipt commands without a clock override", () => {
  assert.deepEqual(parseArgs(["publish-and-register", "--repository-root", root,
    "--source-input", sourceInputPath, "--operation-directory", operationDirectory]), {
    mode: "publish-and-register", repositoryRoot: root, sourceInputPath, operationDirectory,
  });
  assert.equal(parseArgs(["register-published", "--repository-root", root,
    "--source-input", sourceInputPath, "--receipt", path.join(operationDirectory, "receipt.json")]).mode,
  "register-published");
  assert.throws(() => parseArgs(["register-published", "--now", "2040-01-01"]), /ARGUMENTS/);
  assert.throws(() => parseArgs(["publish-and-register", "--repository-root", root,
    "--source-input", sourceInputPath, "--operation-directory", "relative"]), /ARGUMENTS/);
});

test("stops after publication failure and never republishes during registration recovery", async () => {
  let publications = 0, registrations = 0;
  const dependencies = {
    prepare: async () => ({ preparation: {}, sourceInput: { collectionDirectory: root } }),
    publish: async () => { publications += 1; throw new Error("publication failed"); },
    register: async (options) => { registrations += 1; return { targets: [options.receiptPath] }; },
  };
  await assert.rejects(runKorailTopologyRegistration({ mode: "publish-and-register",
    repositoryRoot: root, sourceInputPath, operationDirectory }, dependencies), /publication failed/);
  assert.equal(publications, 1);
  assert.equal(registrations, 0);
  const receiptPath = path.join(operationDirectory, "receipt.json");
  const result = await runKorailTopologyRegistration({ mode: "register-published",
    repositoryRoot: root, sourceInputPath, receiptPath }, {
    ...dependencies, prepare: async () => { throw new Error("recovery must use registrar preparation"); },
  });
  assert.deepEqual(result.targets, [receiptPath]);
  assert.equal(publications, 1);
  assert.equal(registrations, 1);
});
