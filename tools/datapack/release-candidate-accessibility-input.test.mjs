import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, relative, resolve } from "node:path";

import { main as buildCandidateAccessibilityInput } from "./build-current-release-candidate-accessibility-input.mjs";
import {
  retainPreAuthorityRideEdges,
  syncCanonicalAccessibilityEvidence,
} from "./apply-accessibility-evidence-to-bundled-pack.mjs";
import { buildCurrentCapitalRouteEdgeInput } from "./build-current-capital-route-edge-input.mjs";

const root = resolve(new URL("../..", import.meta.url).pathname);
const BUILD_SPEC = "tools/datapack/release/candidate-build-spec.json";
const PREPARATION = "tools/datapack/release/nationwide-candidate-preparation.json";

function readRepoJson(relativePath) {
  return JSON.parse(readFileSync(resolve(root, relativePath), "utf8"));
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

// #866 PR-B: release-candidate 입력은 전국 후보 준비(nationwide-candidate-preparation.json)가
// sha로 결속한 전국 입력을 그대로 쓴다. 수도권 live chain 재생성(213 역-노선)을 거치지 않는다.
// 실데이터가 authority(D1: 환승 양끝 TRANSFER cell 닫힘)를 만족하지 못하면 이 테스트는 명시적으로 실패한다.
test("committed build spec으로 release-candidate accessibility input을 만들면 preparation이 결속한 전국 입력과 바이트가 같다", async () => {
  const buildSpec = readRepoJson(BUILD_SPEC);
  const preparation = readRepoJson(PREPARATION);
  const tmpDir = await mkdtemp(resolve(tmpdir(), "rc-accessibility-input-"));
  const outputs = {
    stationLine: resolve(tmpDir, "station-line-input.json"),
    routeEdge: resolve(tmpDir, "route-edge-input.json"),
    fixture: resolve(tmpDir, "candidate-fixture.json"),
    authority: resolve(tmpDir, "accessibility-authority.json"),
  };
  try {
    await buildCandidateAccessibilityInput([
      "--fixture", buildSpec.fixturePath,
      "--build-spec", BUILD_SPEC,
      "--station-line-output", outputs.stationLine,
      "--route-edge-output", outputs.routeEdge,
      "--fixture-output", outputs.fixture,
      "--authority-output", outputs.authority,
    ], { repositoryRoot: root });

    const [stationLineBytes, routeEdgeBytes] = await Promise.all([
      readFile(outputs.stationLine),
      readFile(outputs.routeEdge),
    ]);
    const boundStationLineBytes = readFileSync(resolve(root, preparation.stationLineInput.path));
    const boundRouteEdgeBytes = readFileSync(resolve(root, preparation.routeEdgeInput.path));
    const stationLine = JSON.parse(stationLineBytes);
    const routeEdge = JSON.parse(routeEdgeBytes);
    assert.equal(stationLine.stationLines.length, JSON.parse(boundStationLineBytes).stationLines.length);
    assert.equal(routeEdge.routeEdges.length, JSON.parse(boundRouteEdgeBytes).routeEdges.length);
    assert.equal(sha256(stationLineBytes), preparation.stationLineInput.sha256);
    assert.equal(sha256(routeEdgeBytes), preparation.routeEdgeInput.sha256);
    assert.ok(stationLineBytes.equals(boundStationLineBytes));
    assert.ok(routeEdgeBytes.equals(boundRouteEdgeBytes));
    for (const candidate of [stationLine.candidate, routeEdge.candidate]) {
      assert.equal(candidate.candidateId, buildSpec.candidateId);
      assert.equal(candidate.sourceSetSha256, buildSpec.sourceSnapshotSetHash);
    }

    const fixture = JSON.parse(await readFile(outputs.fixture, "utf8"));
    const authority = JSON.parse(await readFile(outputs.authority, "utf8"));
    assert.equal(fixture.manifest.activePack.id, "nationwide");
    assert.deepEqual(fixture.packs.map(({ id }) => id), ["nationwide"]);
    assert.equal(authority.buildInput.stationLineInputSha256, preparation.stationLineInput.sha256);
    assert.equal(authority.buildInput.routeEdgeInputSha256, preparation.routeEdgeInput.sha256);
    const nonRide = routeEdge.routeEdges.filter(({ edgeType }) => edgeType !== "RIDE");
    assert.equal(authority.edgeCounts.total, nonRide.length);
    assert.equal(authority.edges.length, nonRide.length);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

// 전국 발행 경로 모듈은 수도권 live chain 모듈을 정적으로(동적 import 문자열 포함) 끌어오지 않는다.
const RELEASE_PATH_MODULES = [
  "tools/datapack/build-current-release-candidate-accessibility-input.mjs",
  "tools/datapack/build-datapack.mjs",
  "tools/datapack/emit-artifact-components.mjs",
  "tools/datapack/nationwide-candidate-input-binding.mjs",
  "tools/datapack/prepare-current-server-route-bundle-final.mjs",
  "tools/datapack/prepare-nationwide-candidate-run.mjs",
  "tools/datapack/refresh-nationwide-candidate.mjs",
  "tools/datapack/stage-current-server-route-bundle-candidate.mjs",
  "tools/datapack/validate-datapack.mjs",
];
const LIVE_CHAIN_MODULES = [
  "tools/datapack/build-current-capital-live-chain-boundary.mjs",
  "tools/datapack/refresh-current-capital-accessibility-full.mjs",
  "tools/datapack/run-current-capital-live-chain.mjs",
];
const IMPORT_SPECIFIER = /(?:\bimport|\bexport)\s[^'"`;]*?\bfrom\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|\bimport\s*["']([^"']+)["']/gu;

function relativeImportGraph(entries) {
  const parents = new Map();
  const pending = entries.map((entry) => [resolve(root, entry), null]);
  while (pending.length > 0) {
    const [file, parent] = pending.pop();
    if (parents.has(file)) continue;
    parents.set(file, parent);
    for (const match of readFileSync(file, "utf8").matchAll(IMPORT_SPECIFIER)) {
      const specifier = match[1] ?? match[2] ?? match[3];
      if (!specifier.startsWith(".")) continue;
      const target = resolve(dirname(file), specifier);
      assert.ok(existsSync(target), `${relative(root, file)} imports missing ${specifier}`);
      pending.push([target, file]);
    }
  }
  return parents;
}

test("전국 발행 경로 모듈은 수도권 live chain 모듈을 정적 import 그래프에 포함하지 않는다", () => {
  for (const module of [...RELEASE_PATH_MODULES, ...LIVE_CHAIN_MODULES]) {
    assert.ok(existsSync(resolve(root, module)), module);
  }
  const graph = relativeImportGraph(RELEASE_PATH_MODULES);
  // 검사기가 실제로 그래프를 따라가는지 확인한다(live chain 쪽에서 시작하면 반드시 걸린다).
  assert.ok(relativeImportGraph(["tools/datapack/refresh-current-capital-accessibility-full.mjs"])
    .has(resolve(root, "tools/datapack/build-current-capital-live-chain-boundary.mjs")));
  const offenders = LIVE_CHAIN_MODULES.map((module) => resolve(root, module))
    .filter((module) => graph.has(module))
    .map((module) => {
      const chain = [];
      for (let current = module; current; current = graph.get(current)) chain.push(relative(root, current));
      return chain.join(" <- ");
    });
  assert.deepEqual(offenders, []);
});

function productionFixture({ activePack, packIds }) {
  return {
    manifest: { channel: "production", ...(activePack === undefined ? {} : { activePack }) },
    packs: packIds.map((id) => ({
      id,
      version: "1",
      networkEdges: [
        { id: `${id}-ride`, edgeType: "RIDE" },
        { id: `${id}-entry`, edgeType: "ENTRY" },
      ],
    })),
  };
}

const UNRESOLVED_ACTIVE_PACKS = [
  ["activePack이 없으면", { activePack: undefined, packIds: ["nationwide"] }],
  ["activePack.id가 packs에 없으면", { activePack: { id: "capital", version: "1" }, packIds: ["nationwide"] }],
  ["activePack.id가 두 팩과 맞으면", { activePack: { id: "nationwide", version: "1" }, packIds: ["nationwide", "nationwide"] }],
];

for (const [label, shape] of UNRESOLVED_ACTIVE_PACKS) {
  test(`retainPreAuthorityRideEdges: ${label} 오류로 드러낸다`, () => {
    assert.throws(
      () => retainPreAuthorityRideEdges(productionFixture(shape), "projected"),
      /current projected pre-authority edge contract is invalid/u,
    );
  });

  test(`syncCanonicalAccessibilityEvidence: ${label} 오류로 드러낸다`, () => {
    assert.throws(
      () => syncCanonicalAccessibilityEvidence(productionFixture(shape), { sourceInventory: [] }),
      /canonical capital pack is missing/u,
    );
  });

  test(`buildCurrentCapitalRouteEdgeInput: ${label} 오류로 드러낸다`, () => {
    assert.throws(
      () => buildCurrentCapitalRouteEdgeInput({ canonicalPack: productionFixture(shape) }),
      /full-capital projected fixture mismatch/u,
    );
  });
}

test("retainPreAuthorityRideEdges는 manifest.activePack.id로 고른 팩의 RIDE 간선만 남긴다", () => {
  const fixture = productionFixture({ activePack: { id: "nationwide", version: "1" }, packIds: ["nationwide"] });
  retainPreAuthorityRideEdges(fixture, "projected");
  assert.deepEqual(fixture.packs[0].networkEdges, [{ id: "nationwide-ride", edgeType: "RIDE" }]);
});
