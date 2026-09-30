import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { main as buildCandidateAccessibilityInput } from "./build-current-release-candidate-accessibility-input.mjs";
import {
  retainPreAuthorityRideEdges,
  syncCanonicalAccessibilityEvidence,
} from "./apply-accessibility-evidence-to-bundled-pack.mjs";
import { buildCurrentCapitalRouteEdgeInput } from "./build-current-capital-route-edge-input.mjs";

const root = resolve(new URL("../..", import.meta.url).pathname);
const BUILD_SPEC = "tools/datapack/release/candidate-build-spec.json";
const TRACKED_STATION_INPUT = "tools/datapack/release/current-capital-accessibility-full/station-line-input.json";
const TRACKED_ROUTE_INPUT = "tools/datapack/release/current-capital-accessibility-full/route-edge-input.json";
// 후보 산출물이 커밋된 입력과 달라도 되는 필드는 후보 식별자뿐이다.
const CANDIDATE_IDENTITY_KEYS = ["candidateId", "sourceSetSha256"];

function readRepoJson(relative) {
  return JSON.parse(readFileSync(resolve(root, relative), "utf8"));
}

function withoutIdentity(row) {
  const stripped = { ...row };
  for (const key of CANDIDATE_IDENTITY_KEYS) delete stripped[key];
  return stripped;
}

// candidate 헤더와 evidenceRows의 후보 식별 필드만 제외한다. 나머지는 모두 같아야 한다.
function withoutCandidateIdentity(document) {
  return {
    ...document,
    candidate: withoutIdentity(document.candidate),
    ...(document.evidenceRows ? { evidenceRows: document.evidenceRows.map(withoutIdentity) } : {}),
  };
}

function candidateIdentities(document) {
  return new Set([document.candidate, ...(document.evidenceRows ?? [])]
    .map((row) => CANDIDATE_IDENTITY_KEYS.map((key) => row[key]).join("\0")));
}

test("committed build spec으로 release-candidate accessibility input을 만들면 커밋된 capital accessibility 입력과 같다", async () => {
  const buildSpec = readRepoJson(BUILD_SPEC);
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

    const written = Object.fromEntries(await Promise.all(Object.entries(outputs)
      .map(async ([name, target]) => [name, JSON.parse(await readFile(target, "utf8"))])));

    const trackedStation = readRepoJson(TRACKED_STATION_INPUT);
    const trackedRoute = readRepoJson(TRACKED_ROUTE_INPUT);
    assert.equal(written.stationLine.stationLines.length, trackedStation.stationLines.length);
    assert.equal(written.stationLine.evidenceRows.length, trackedStation.evidenceRows.length);
    assert.equal(written.routeEdge.routeEdges.length, trackedRoute.routeEdges.length);
    assert.equal(written.routeEdge.stationLines.length, trackedRoute.stationLines.length);
    assert.deepEqual(withoutCandidateIdentity(written.stationLine), withoutCandidateIdentity(trackedStation));
    assert.deepEqual(withoutCandidateIdentity(written.routeEdge), withoutCandidateIdentity(trackedRoute));
    assert.equal(written.stationLine.candidate.stationSetSha256, trackedStation.candidate.stationSetSha256);
    assert.equal(written.routeEdge.candidate.stationSetSha256, trackedRoute.candidate.stationSetSha256);

    // 제외한 후보 식별 필드는 committed build spec의 후보 식별자로 채워져야 한다.
    const expectedIdentity = new Set([`${buildSpec.candidateId}\0${buildSpec.sourceSnapshotSetHash}`]);
    assert.deepEqual(candidateIdentities(written.stationLine), expectedIdentity);
    assert.deepEqual(candidateIdentities(written.routeEdge), expectedIdentity);
    assert.equal(written.fixture.manifest.activePack.id, "nationwide");
    assert.deepEqual(written.fixture.packs.map(({ id }) => id), ["nationwide"]);
    assert.equal(typeof written.authority, "object");
    assert.notEqual(written.authority, null);
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
