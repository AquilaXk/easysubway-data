import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import * as manifestValidation from "./lib/manifest-validation.mjs";

const { selectEffectiveDataPack, selectPackWithoutEmergencyOverride } = manifestValidation;

test("(1) activePack 없음 -> null", () => {
  const manifest = {
    ttlSeconds: 3600,
    packs: [{ id: "capital", version: "1" }],
  };
  assert.equal(selectEffectiveDataPack(manifest), null);
});

test("(2) 수도권·전국 팩이 같은 버전으로 공존하고 activePack이 없음 -> null (배열 순서와 무관)", () => {
  const capitalPack = { id: "capital", version: "1" };
  const nationwidePack = { id: "nationwide", version: "1" };

  const orderA = {
    ttlSeconds: 3600,
    packs: [capitalPack, nationwidePack],
  };
  const orderB = {
    ttlSeconds: 3600,
    packs: [nationwidePack, capitalPack],
  };

  assert.equal(selectEffectiveDataPack(orderA), null);
  assert.equal(selectEffectiveDataPack(orderB), null);
});

test("(3) activePack: { id: 'nationwide', version: '1' } -> 전국 팩", () => {
  const capitalPack = { id: "capital", version: "1" };
  const nationwidePack = { id: "nationwide", version: "1" };

  const manifest = {
    ttlSeconds: 3600,
    activePack: { id: "nationwide", version: "1" },
    packs: [capitalPack, nationwidePack],
  };

  const selected = selectEffectiveDataPack(manifest);
  assert.deepEqual(selected, nationwidePack);
});

test("(4) emergencyOverride가 activePack보다 우선", () => {
  const capitalPack = { id: "capital", version: "1" };
  const nationwidePack = { id: "nationwide", version: "1" };

  const manifest = {
    ttlSeconds: 3600,
    activePack: { id: "capital", version: "1" },
    emergencyOverride: { id: "nationwide", version: "1", reason: "incident-mitigation" },
    packs: [capitalPack, nationwidePack],
  };

  const selected = selectEffectiveDataPack(manifest);
  assert.deepEqual(selected, nationwidePack);
});

test("(5) selectPackWithoutEmergencyOverride는 우회를 무시하고 activePack을 선택", () => {
  assert.equal(typeof selectPackWithoutEmergencyOverride, "function", "selectPackWithoutEmergencyOverride must be exported");

  const capitalPack = { id: "capital", version: "1" };
  const nationwidePack = { id: "nationwide", version: "1" };

  const manifest = {
    ttlSeconds: 3600,
    activePack: { id: "capital", version: "1" },
    emergencyOverride: { id: "nationwide", version: "1", reason: "incident-mitigation" },
    packs: [capitalPack, nationwidePack],
  };

  const selected = selectPackWithoutEmergencyOverride(manifest);
  assert.deepEqual(selected, capitalPack);
});

test("(6) 실제 매니페스트 파일마다 선택 결과가 변경 전과 같다 (기대값은 파일별로 하드코딩)", () => {
  const repoRoot = path.resolve(".");

  const expectations = [
    {
      filePath: "tools/datapack/fixtures/catalog-fixture.json",
      expectedId: "capital",
      expectedVersion: "1",
    },
    {
      filePath: "tools/datapack/release/capital-production-canonical-pack.json",
      expectedId: "capital",
      expectedVersion: "1",
    },
    {
      filePath: "tools/datapack/release/capital-production-reviewed-pack.json",
      expectedId: "capital",
      expectedVersion: "1",
    },
    {
      filePath: "tools/datapack/release/nationwide-production-canonical-pack.json",
      expectedId: "nationwide",
      expectedVersion: "1",
    },
  ];

  for (const { filePath, expectedId, expectedVersion } of expectations) {
    const raw = readFileSync(path.join(repoRoot, filePath), "utf8");
    const json = JSON.parse(raw);
    const manifest = { ...json.manifest, packs: json.packs };
    const selected = selectEffectiveDataPack(manifest);
    assert.ok(selected, `Failed to select pack for ${filePath}`);
    assert.equal(selected.id, expectedId, `id mismatch for ${filePath}`);
    assert.equal(String(selected.version), expectedVersion, `version mismatch for ${filePath}`);
  }
});
