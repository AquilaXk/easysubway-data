import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { buildCurrentFiveRegionSourceFanIn } from "./build-current-five-region-source-fan-in.mjs";
import { candidatePinnedReader, committedCandidateInputManifest } from "./test-fixtures/candidate-pinned-inputs.mjs";

// #942: PR CI(required-pr)는 커밋된 전국 후보의 내부 pin 일관성만 검사한다.
// 후보가 읽은 입력은 매니페스트가 sha256으로 고정하고, 그 바이트로 fan-in·spec 결속을 다시 계산한다.
// 고정 입력이 지금 작업 트리와 같은지(currency)는 release-pin-drift.test.mjs(deterministic-release)가 RC·publish에서 검사한다.
const root = path.resolve(import.meta.dirname, "../..");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const FAN_IN_PATH = "tools/datapack/release/current-five-region-source-fan-in.json";
const BUILD_SPEC_PATH = "tools/datapack/release/candidate-build-spec.json";
const PREPARATION_PATH = "tools/datapack/release/nationwide-candidate-preparation.json";
const OWNERSHIP_LEDGER_PATH = "tools/datapack/reports/nationwide-requirement-ownership-ledger.json";
const FAN_IN_INPUT_PATHS = Object.freeze({
  targets: "tools/datapack/nationwide-coverage-targets.json",
  tally: "tools/datapack/reports/nationwide-coverage-tally.json",
  ownership: "tools/datapack/release/nationwide-requirement-ownership.json",
  inventory: "tools/datapack/source-inventory.json",
  sourceSnapshots: "tools/datapack/release/source-snapshots.json",
});

const manifest = await committedCandidateInputManifest(root);
const pinnedRead = await candidatePinnedReader({ root });
const readCommitted = (relative) => readFile(path.join(root, relative));

test("후보 입력 매니페스트는 커밋된 후보 spec·preparation·fan-in 바이트와 후보 id에 결속된다", async () => {
  const [specBytes, preparationBytes, fanInBytes] = await Promise.all([BUILD_SPEC_PATH, PREPARATION_PATH, FAN_IN_PATH].map(readCommitted));
  assert.equal(manifest.candidateId, JSON.parse(specBytes).candidateId);
  assert.equal(manifest.candidateId, JSON.parse(preparationBytes).releaseIdentity.candidateId);
  assert.equal(manifest.candidateBuildSpecSha256, sha256(specBytes));
  assert.equal(manifest.preparationSha256, sha256(preparationBytes));
  assert.equal(manifest.fanInSha256, sha256(fanInBytes));
});

test("(a) fan-in이 고정한 입력 sha256은 후보 입력 매니페스트가 고정한 같은 경로의 sha256과 같다", async () => {
  const fanIn = JSON.parse(await readCommitted(FAN_IN_PATH));
  const pinned = new Map(manifest.files.map((entry) => [entry.path, entry.sha256]));
  for (const [name, { path: relative, sha256: digest }] of Object.entries(fanIn.inputs)) {
    assert.equal(pinned.get(relative), digest, `fan-in inputs.${name} (${relative})`);
    assert.equal(sha256(await pinnedRead(relative)), digest, `fan-in inputs.${name} (${relative}) pinned bytes`);
  }
});

test("(b) 후보가 고정한 입력으로 buildCurrentFiveRegionSourceFanIn을 돌린 결과가 커밋된 fan-in과 같다", async () => {
  const committedFanIn = JSON.parse(await readCommitted(FAN_IN_PATH));
  const records = Object.fromEntries(await Promise.all(Object.entries(FAN_IN_INPUT_PATHS).map(async ([name, relative]) => {
    const bytes = await pinnedRead(relative);
    return [name, { value: JSON.parse(bytes.toString("utf8")), bytes }];
  })));
  const reconstructed = buildCurrentFiveRegionSourceFanIn({
    ...Object.fromEntries(Object.entries(records).map(([name, { value }]) => [name, value])),
    inputBytes: Object.fromEntries(Object.entries(records).map(([name, { bytes }]) => [name, bytes])),
    evaluatedAt: committedFanIn.evaluatedAt,
  });
  assert.deepEqual(reconstructed, committedFanIn);
});

test("(c) 소유권 원장이 가진 fan-in 해시가 커밋된 fan-in 파일과 같다", async () => {
  const fanInBytes = await readCommitted(FAN_IN_PATH);
  const ledger = JSON.parse(await readCommitted(OWNERSHIP_LEDGER_PATH));
  assert.equal(ledger.provenance.inputs.fanIn.sha256, sha256(fanInBytes));
  assert.equal(ledger.provenance.inputs.fanIn.fanInSha256, JSON.parse(fanInBytes).fanInSha256);
});

test("(d) candidate-build-spec의 inventory 결속은 후보가 고정한 inventory 바이트와 같다", async () => {
  const spec = JSON.parse(await readCommitted(BUILD_SPEC_PATH));
  const inventoryBytes = await pinnedRead("tools/datapack/source-inventory.json");
  assert.equal(spec.sourceInventorySha256, sha256(JSON.stringify(JSON.parse(inventoryBytes))));
  assert.equal(spec.networkEdgeEvidence.sourceInventory.path, "tools/datapack/source-inventory.json");
  assert.equal(spec.networkEdgeEvidence.sourceInventory.sha256, sha256(inventoryBytes));
});
