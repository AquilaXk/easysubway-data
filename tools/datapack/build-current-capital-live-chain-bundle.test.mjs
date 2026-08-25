import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildCurrentCapitalLiveChainBundle, CURRENT_CAPITAL_LIVE_CHAIN_OUTPUT_PATHS, readCurrentCapitalLiveChainBundle } from "./build-current-capital-live-chain-bundle.mjs";
import { CURRENT_CAPITAL_LIVE_CHAIN_FAN_IN_COMPONENT_PATHS, canonicalCurrentCapitalLiveChainFanInBoundaryJson } from "./build-current-capital-live-chain-boundary.mjs";

test("composite bundle embeds canonical fan-in evidence without expanding the output allowlist", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "live-chain-bundle-"));
  const outputPaths = CURRENT_CAPITAL_LIVE_CHAIN_OUTPUT_PATHS;
  const entryBytes = new Map();
  for (const [index, relative] of outputPaths.entries()) {
    const bytes = Buffer.from(`{\"component\":${index}}`);
    entryBytes.set(relative, bytes);
    await mkdir(path.dirname(path.join(root, "out", relative)), { recursive: true });
    await writeFile(path.join(root, "out", relative), bytes);
  }
  const options = { root, outputDirectory: path.join(root, "out"), repository: "AquilaXk/easysubway-data", repositorySha: "b".repeat(40), operationId: "current-capital-560", boundaryBytes: boundaryFor(entryBytes) };
  const bytes = await buildCurrentCapitalLiveChainBundle(options);
  const readOptions = omit(options, "root", "outputDirectory", "boundaryBytes");
  const bundle = readCurrentCapitalLiveChainBundle(bytes, readOptions);
  assert.equal(bundle.entries.length, 16);
  assert.equal(bundle.entries.some((entry) => entry.path === "tools/datapack/release/current-capital-live-chain-fan-in.json"), false);
  assert.throws(() => readCurrentCapitalLiveChainBundle(bytes, { ...readOptions, repositorySha: "c".repeat(40) }), /identity mismatch/);

  const tamperedBoundary = JSON.parse(bytes);
  tamperedBoundary.boundaryBytesBase64 = Buffer.from("{}", "utf8").toString("base64");
  assert.throws(() => readCurrentCapitalLiveChainBundle(Buffer.from(JSON.stringify(tamperedBoundary)), readOptions), /boundary|keys mismatch/i);
  await assert.rejects(() => buildCurrentCapitalLiveChainBundle({ ...options, boundaryBytes: boundaryFor(entryBytes, { candidateBuildSpec: "0".repeat(64) }) }), /boundary.*output binding/i);
  await assert.rejects(() => buildCurrentCapitalLiveChainBundle({ ...options, outputDirectory: path.join(root, "missing") }), /ENOENT/);
});

function boundaryFor(entryBytes, overrides = {}) {
  const components = Object.fromEntries(Object.entries(CURRENT_CAPITAL_LIVE_CHAIN_FAN_IN_COMPONENT_PATHS).map(([name, relative]) => [name, { path: relative, sha256: overrides[name] ?? sha256(entryBytes.get(relative)) }]));
  return Buffer.from(canonicalCurrentCapitalLiveChainFanInBoundaryJson({ artifactKind: "current-capital-live-chain-fan-in", components, currentCandidateSourceSetSha256: "a".repeat(64), evidenceSourceSetSha256: "a".repeat(64), kind: "CURRENT_CAPITAL_LIVE_CHAIN_FAN_IN", schemaVersion: 1 }));
}
function omit(value, ...keys) { return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key))); }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
