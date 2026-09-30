import { readFile } from "node:fs/promises";
import path from "node:path";

// ITX-청춘 station-catalog evidence 계약이 어떤 팩을 검사하는지 release mode별로 고정한다.
// - release-candidate: EASYSUBWAY_DATAPACK_OUTPUT에 새로 빌드한 production 후보 팩
// - 모드 없음(PR CI)·exploratory: 저장소에 고정된 bundled capital 팩
//   (exploratory는 tools/datapack/fixtures/catalog-fixture.json으로 만든 fixture 팩이라 운영 ITX admission을 싣지 않는다)
// 그 밖의 모드는 이 계약을 실행하지 않으므로 대상을 추정하지 않고 거부한다.
const BUNDLED_MODES = new Set(["", "exploratory"]);

export async function resolveItxStationCatalogEvidenceTarget({ env, repositoryRoot }) {
  const releaseMode = env.EASYSUBWAY_DATAPACK_RELEASE_MODE ?? "";
  if (releaseMode === "release-candidate") {
    return releaseCandidateTarget(env.EASYSUBWAY_DATAPACK_OUTPUT);
  }
  if (BUNDLED_MODES.has(releaseMode)) {
    return bundledTarget(repositoryRoot);
  }
  throw new Error(`ITX 검사 대상을 정할 수 없는 release mode: ${releaseMode}`);
}

async function releaseCandidateTarget(output) {
  if (!output) {
    throw new Error("release-candidate 모드는 EASYSUBWAY_DATAPACK_OUTPUT 후보 팩이 필요하다");
  }
  const manifest = JSON.parse(await readFile(path.join(output, "current.json"), "utf8"));
  const activePack = manifest.packs?.find((pack) => pack.id === manifest.activePack?.id
    && pack.version === manifest.activePack?.version);
  if (!activePack) {
    throw new Error("release candidate active pack을 찾지 못함");
  }
  if (activePack.artifactKind !== "production") {
    throw new Error(`release-candidate ITX 검사 대상은 production 후보 팩이어야 한다: ${activePack.artifactKind}`);
  }
  const packBytes = await readFile(path.join(output, "catalog", `${activePack.id}-v${activePack.version}.sqlite.gz`));
  return {
    kind: "release-candidate-pack",
    label: `release-candidate 후보 팩 ${activePack.id}-v${activePack.version}`,
    activePack,
    packBytes,
  };
}

async function bundledTarget(repositoryRoot) {
  const datapacksDir = path.join(repositoryRoot, "apps/mobile/assets/datapacks");
  const index = JSON.parse(await readFile(path.join(datapacksDir, "index.json"), "utf8"));
  const activePack = index.packs?.find((pack) => pack.id === "capital");
  if (!activePack) {
    throw new Error("bundled capital pack을 찾지 못함");
  }
  const packBytes = await readFile(path.join(datapacksDir, "capital.sqlite.gz"));
  return { kind: "bundled-pack", label: "bundled capital 팩", activePack, packBytes };
}
