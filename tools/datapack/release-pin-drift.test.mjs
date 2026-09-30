import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import {
  buildCurrentFiveRegionSourceFanIn,
  canonicalCurrentFiveRegionSourceFanInJson,
} from "./build-current-five-region-source-fan-in.mjs";

const root = resolve(new URL("../..", import.meta.url).pathname);

function sha256Bytes(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

test("(a) fan-in의 inputs.*.path 파일 원바이트 sha256이 inputs.*.sha256과 같다", () => {
  const fanInPath = resolve(root, "tools/datapack/release/current-five-region-source-fan-in.json");
  const fanIn = JSON.parse(readFileSync(fanInPath, "utf8"));

  for (const [name, inputInfo] of Object.entries(fanIn.inputs)) {
    const filePath = resolve(root, inputInfo.path);
    const fileBytes = readFileSync(filePath);
    const actualSha256 = sha256Bytes(fileBytes);
    assert.equal(
      actualSha256,
      inputInfo.sha256,
      `fan-in inputs.${name} (${inputInfo.path}) sha256이 일치해야 한다`,
    );
  }
});

test("(b) 현재 입력으로 buildCurrentFiveRegionSourceFanIn을 돌린 결과가 커밋된 fan-in과 같다", () => {
  const fanInPath = resolve(root, "tools/datapack/release/current-five-region-source-fan-in.json");
  const fanInBytes = readFileSync(fanInPath);
  const committedFanIn = JSON.parse(fanInBytes.toString("utf8"));

  const inputNames = ["targets", "tally", "ownership", "inventory", "sourceSnapshots"];
  const inputPaths = {
    targets: "tools/datapack/nationwide-coverage-targets.json",
    tally: "tools/datapack/reports/nationwide-coverage-tally.json",
    ownership: "tools/datapack/release/nationwide-requirement-ownership.json",
    inventory: "tools/datapack/source-inventory.json",
    sourceSnapshots: "tools/datapack/release/source-snapshots.json",
  };

  const records = Object.fromEntries(
    inputNames.map((name) => {
      const bytes = readFileSync(resolve(root, inputPaths[name]));
      return [name, { value: JSON.parse(bytes.toString("utf8")), bytes }];
    }),
  );

  const input = {
    ...Object.fromEntries(inputNames.map((name) => [name, records[name].value])),
    inputBytes: Object.fromEntries(inputNames.map((name) => [name, records[name].bytes])),
    evaluatedAt: committedFanIn.evaluatedAt,
  };

  const reconstructed = buildCurrentFiveRegionSourceFanIn(input);
  assert.equal(
    canonicalCurrentFiveRegionSourceFanInJson(reconstructed),
    canonicalCurrentFiveRegionSourceFanInJson(committedFanIn),
    "재생성된 fan-in과 커밋된 fan-in이 정확히 일치해야 한다",
  );
});

test("(c) 원장이 가진 fan-in 해시가 현재 fan-in 파일과 같다", () => {
  const fanInPath = resolve(root, "tools/datapack/release/current-five-region-source-fan-in.json");
  const fanInBytes = readFileSync(fanInPath);
  const fanIn = JSON.parse(fanInBytes.toString("utf8"));
  const actualRawSha256 = sha256Bytes(fanInBytes);

  const ledgerPath = resolve(root, "tools/datapack/reports/nationwide-requirement-ownership-ledger.json");
  const ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));

  assert.equal(
    ledger.provenance.inputs.fanIn.sha256,
    actualRawSha256,
    "원장의 fan-in raw sha256이 현재 fan-in 파일의 sha256과 같아야 한다",
  );
  assert.equal(
    ledger.provenance.inputs.fanIn.fanInSha256,
    fanIn.fanInSha256,
    "원장의 fan-in fanInSha256이 현재 fan-in의 fanInSha256과 같아야 한다",
  );
});

test("(d) candidate-build-spec.json의 sourceInventorySha256이 sha256(JSON.stringify(inventory))와 같다", () => {
  const inventoryPath = resolve(root, "tools/datapack/source-inventory.json");
  const inventory = JSON.parse(readFileSync(inventoryPath, "utf8"));
  const expectedHash = createHash("sha256").update(JSON.stringify(inventory)).digest("hex");

  const buildSpecPath = resolve(root, "tools/datapack/release/candidate-build-spec.json");
  const buildSpec = JSON.parse(readFileSync(buildSpecPath, "utf8"));

  assert.equal(
    buildSpec.sourceInventorySha256,
    expectedHash,
    "candidate-build-spec.json의 sourceInventorySha256이 source-inventory.json의 JSON.stringify sha256과 같아야 한다",
  );
});
