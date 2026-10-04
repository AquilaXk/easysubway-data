import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { main as buildCandidateAccessibilityInput } from "./build-current-release-candidate-accessibility-input.mjs";
import {
  retainPreAuthorityRideEdges,
  syncCanonicalAccessibilityEvidence,
} from "./apply-accessibility-evidence-to-bundled-pack.mjs";
import { candidatePinnedReader, candidatePinnedWorkspace } from "./test-fixtures/candidate-pinned-inputs.mjs";

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
  // #942: 후보 재현은 후보가 고정한 입력 바이트를 담은 작업 공간에서 한다(원천만 등록한 PR에서도 같은 결과).
  const { root: candidateRoot } = await candidatePinnedWorkspace();
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
    ], { repositoryRoot: candidateRoot });

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
    // #866 PR-C: 삭제한 "합성 current public successor" 테스트가 수도권 사본으로 보던 authority 불변식을 실데이터
    // 전국 입력에 건다. ENTRY/EXIT가 없고, authority cell은 모두 TRANSFER이며 그 집합은 환승 간선 끝점 집합과 같다.
    assert.equal(routeEdge.routeEdges.some(({ edgeType }) => edgeType === "ENTRY" || edgeType === "EXIT"), false);
    assert.ok(nonRide.length > 0);
    assert.ok(nonRide.every(({ edgeType }) => edgeType.endsWith("_TRANSFER")));
    const authorityCells = authority.edges.flatMap(({ requiredCells }) => requiredCells);
    assert.ok(authorityCells.every(({ domain }) => domain === "TRANSFER"));
    assert.deepEqual(
      [...new Set(authorityCells.map(({ stationId, lineId }) => `${stationId}:${lineId}`))].sort(),
      [...new Set(nonRide.flatMap(({ fromNodeId, toNodeId }) => [fromNodeId, toNodeId]))].sort(),
    );
    assert.equal(fixture.packs[0].networkEdges.length, routeEdge.routeEdges.length);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
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
}

test("retainPreAuthorityRideEdges는 manifest.activePack.id로 고른 팩의 RIDE 간선만 남긴다", () => {
  const fixture = productionFixture({ activePack: { id: "nationwide", version: "1" }, packIds: ["nationwide"] });
  retainPreAuthorityRideEdges(fixture, "projected");
  assert.deepEqual(fixture.packs[0].networkEdges, [{ id: "nationwide-ride", edgeType: "RIDE" }]);
});
