import { rmSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import path from "node:path";
import { main as buildDatapack } from "../build-datapack.mjs";
import {
  main as buildCurrentReleaseCandidateAccessibilityInput,
} from "../build-current-release-candidate-accessibility-input.mjs";
import { candidateWorkspaceAccess } from "./candidate-pinned-inputs.mjs";
import { testPrivateKeyPem, testPublicKeyPem } from "./datapack-tools-signing.mjs";

export const productionEnv = {
  ...process.env,
  EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM: testPrivateKeyPem,
  EASYSUBWAY_DATAPACK_SIGNING_PUBLIC_KEY_PEM: testPublicKeyPem,
  EASYSUBWAY_DATAPACK_PRODUCTION_FIXTURE_VALIDATION_ONLY: "true",
};
const currentProductionBuildEnv = {
  ...productionEnv,
  EASYSUBWAY_DATAPACK_PRODUCTION_FIXTURE_VALIDATION_ONLY: undefined,
  EASYSUBWAY_DATAPACK_BUILD_SPEC_VALIDATION_ONLY: undefined,
};

// #866 PR-C: production 게이트 회귀는 수도권 live chain 합성 저장소 대신 release workflow와 같은 RC 경로로 만든다.
// 커밋된 전국 후보 build spec → build-current-release-candidate-accessibility-input(전국 후보 준비가 sha로 결속한
// 전국 입력, authority D1) → build-datapack(override·authority) 순서다. RC 입력은 결정적이므로 프로세스당 한 번 만들고
// 팩은 테스트마다 새로 빌드한다(각 테스트가 자기 출력만 변조한다).
let currentReleaseCandidateArtifactPromise = null;

// #942: 커밋된 후보의 production 빌드 재현은 후보가 고정한 입력 바이트를 담은 작업 공간에서 한다(원천만 등록한 PR에서도 같은 결과).
// #954: 현재 ITX·Incheon 후보 빌드 입력도 같은 작업 공간에서 읽는다(원천 갱신 PR이 바꾼 작업 트리 inventory·canonical pack과 섞지 않는다).
export const { root: currentCandidateRoot, read: readCandidateFile } = candidateWorkspaceAccess();

async function currentReleaseCandidateArtifact() {
  currentReleaseCandidateArtifactPromise ??= (async () => {
    const candidateRoot = await currentCandidateRoot();
    const directory = await mkdtemp(path.join(tmpdir(), "easysubway-current-rc-artifact-"));
    process.once("exit", () => rmSync(directory, { recursive: true, force: true }));
    const buildSpecPath = "tools/datapack/release/candidate-build-spec.json";
    const buildSpec = JSON.parse(await readFile(path.join(candidateRoot, buildSpecPath), "utf8"));
    const files = {
      stationLine: path.join(directory, "candidate-station-line-input.json"),
      routeEdge: path.join(directory, "candidate-route-edge-input.json"),
      fixture: path.join(directory, "candidate-fixture.json"),
      authority: path.join(directory, "server-route-coverage-authority.json"),
    };
    await buildCurrentReleaseCandidateAccessibilityInput([
      "--fixture", buildSpec.fixturePath,
      "--build-spec", buildSpecPath,
      "--station-line-output", files.stationLine,
      "--route-edge-output", files.routeEdge,
      "--fixture-output", files.fixture,
      "--authority-output", files.authority,
    ], { repositoryRoot: candidateRoot });
    return { buildSpec, buildSpecPath, files };
  })();
  return currentReleaseCandidateArtifactPromise;
}

export async function buildCurrentProductionArtifact(context, { buildEnv = {} } = {}) {
  const outputRoot = await mkdtemp(path.join(tmpdir(), "easysubway-current-production-artifact-output-"));
  context.after(() => rm(outputRoot, { recursive: true, force: true }));
  const { buildSpec, buildSpecPath, files } = await currentReleaseCandidateArtifact();
  const candidateRoot = await currentCandidateRoot();
  const output = path.join(outputRoot, "pack");
  await runDatapackInRepository({
    argv: [
      "--build-spec", buildSpecPath,
      "--candidate-fixture-override", files.fixture,
      "--server-route-coverage-authority", files.authority,
      "--current-capital-station-line-input", files.stationLine,
      "--current-capital-route-edge-input", files.routeEdge,
      "--output", output,
    ],
    repositoryRoot: candidateRoot,
    env: {
      ...currentProductionBuildEnv,
      ...buildEnv,
      EASYSUBWAY_DATAPACK_BUILD_NOW: buildSpec.publishedAt,
    },
  });
  const manifest = JSON.parse(await readFile(path.join(output, "current.json"), "utf8"));
  assert.deepEqual(manifest.packs.map(({ artifactKind }) => artifactKind), ["production"]);
  return { output, repositoryRoot: candidateRoot, routeCoverageAuthority: files.authority };
}

export function representativeRouteRegressionPayload(routes) {
  return JSON.stringify(
    routes.map((route) => ({
      id: route.id,
      pattern: route.pattern,
      fromNodeId: route.fromNodeId,
      toNodeId: route.toNodeId,
      requiredEdgeIds: route.requiredEdgeIds,
    })),
  );
}

export async function runDatapackInRepository({ argv, env = productionEnv, repositoryRoot }) {
  const keys = [
    "EASYSUBWAY_DATAPACK_BUILD_NOW",
    "EASYSUBWAY_DATAPACK_BUILD_SPEC_VALIDATION_ONLY",
    "EASYSUBWAY_DATAPACK_PRODUCTION_FIXTURE_VALIDATION_ONLY",
    "EASYSUBWAY_DATAPACK_SIGNING_KEY_ID",
    "EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM",
    "EASYSUBWAY_DATAPACK_SIGNING_PUBLIC_KEY_PEM",
    "GITHUB_RUN_NUMBER",
  ];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) {
      if (env[key] === undefined) delete process.env[key];
      else process.env[key] = env[key];
    }
    return await buildDatapack(argv, { repositoryRoot });
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
