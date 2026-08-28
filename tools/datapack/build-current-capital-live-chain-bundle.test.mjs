import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildCurrentCapitalLiveChainBundle, currentCapitalLiveChainOutputPaths, readCurrentCapitalLiveChainBundle } from "./build-current-capital-live-chain-bundle.mjs";
import { CURRENT_CAPITAL_LIVE_CHAIN_FAN_IN_COMPONENT_PATHS, canonicalCurrentCapitalLiveChainFanInBoundaryJson } from "./build-current-capital-live-chain-boundary.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");

test("composite bundle embeds canonical fan-in evidence without expanding the output allowlist", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "live-chain-bundle-"));
  const authorityPaths = ["tools/datapack/release/candidate-build-spec.json", "tools/datapack/source-inventory.json", "tools/datapack/release/source-snapshots.json"];
  const authorityBytes = new Map(await Promise.all(authorityPaths.map(async (relative) => [relative, await readFile(path.join(ROOT, relative))])));
  const outputPaths = currentCapitalLiveChainOutputPaths({
    candidate: JSON.parse(authorityBytes.get(authorityPaths[0])),
    sourceInventory: JSON.parse(authorityBytes.get(authorityPaths[1])),
    sourceSnapshotLedger: JSON.parse(authorityBytes.get(authorityPaths[2])),
  });
  const entryBytes = new Map();
  for (const [index, relative] of outputPaths.entries()) {
    const bytes = authorityBytes.get(relative) ?? Buffer.from(`{\"component\":${index}}`);
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

test("composite bundle reads a valid large source snapshot ledger", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "live-chain-large-ledger-"));
  const authorityPaths = ["tools/datapack/release/candidate-build-spec.json", "tools/datapack/source-inventory.json", "tools/datapack/release/source-snapshots.json"];
  const authorityBytes = new Map(await Promise.all(authorityPaths.map(async (relative) => [relative, await readFile(path.join(ROOT, relative))])));
  const outputPaths = currentCapitalLiveChainOutputPaths({
    candidate: JSON.parse(authorityBytes.get(authorityPaths[0])),
    sourceInventory: JSON.parse(authorityBytes.get(authorityPaths[1])),
    sourceSnapshotLedger: JSON.parse(authorityBytes.get(authorityPaths[2])),
  });
  const entryBytes = new Map();
  for (const [index, relative] of outputPaths.entries()) {
    const bytes = authorityBytes.get(relative) ?? Buffer.from(`{\"component\":${index}}`);
    const payload = relative === "tools/datapack/release/source-snapshots.json"
      ? Buffer.concat([bytes, Buffer.alloc(2_066_759, 0x20)])
      : bytes;
    entryBytes.set(relative, payload);
    await mkdir(path.dirname(path.join(root, "out", relative)), { recursive: true });
    await writeFile(path.join(root, "out", relative), payload);
  }
  const repositorySha = sha256(Buffer.from("large-source-snapshot-ledger-regression")).slice(0, 40);
  const options = { root, outputDirectory: path.join(root, "out"), repository: "AquilaXk/easysubway-data", repositorySha, operationId: "current-capital-large-ledger", boundaryBytes: boundaryFor(entryBytes) };
  const bundle = readCurrentCapitalLiveChainBundle(await buildCurrentCapitalLiveChainBundle(options), omit(options, "root", "outputDirectory", "boundaryBytes"));
  assert.ok(bundle.entries.find((entry) => entry.path === "tools/datapack/release/source-snapshots.json").bytesBase64.length > 2_700_000);
});

function boundaryFor(entryBytes, overrides = {}) {
  const components = Object.fromEntries(Object.entries(CURRENT_CAPITAL_LIVE_CHAIN_FAN_IN_COMPONENT_PATHS).map(([name, relative]) => [name, { path: relative, sha256: overrides[name] ?? sha256(entryBytes.get(relative)) }]));
  return Buffer.from(canonicalCurrentCapitalLiveChainFanInBoundaryJson({ artifactKind: "current-capital-live-chain-fan-in", components, currentCandidateSourceSetSha256: "a".repeat(64), evidenceSourceSetSha256: "a".repeat(64), kind: "CURRENT_CAPITAL_LIVE_CHAIN_FAN_IN", schemaVersion: 1 }));
}
function omit(value, ...keys) { return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key))); }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
