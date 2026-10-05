import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile as readFileBytes, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildCurrentFiveRegionSourceFanIn } from "./build-current-five-region-source-fan-in.mjs";
import { CANDIDATE_INPUT_MANIFEST_PATH, buildCandidateInputManifest, serializeCandidateInputManifest } from "./lib/candidate-input-bundle.mjs";
import { CANDIDATE_OUTPUT_PATHS, candidatePinnedReader, candidatePinnedWorkspace, candidateWorkspacePath, committedCandidateInputManifest } from "./test-fixtures/candidate-pinned-inputs.mjs";
import { NATIONWIDE_CANDIDATE_REFRESH_OUTPUTS } from "./refresh-nationwide-candidate.mjs";

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
// 후보 산출물은 커밋된 바이트(HEAD)로 읽는다. 같은 checkout에서 함께 도는 prepare 테스트가 산출물 파일을 다시 써도 영향받지 않는다.
const readCommitted = async (relative) => execFileSync("git", ["show", `HEAD:${relative}`], { cwd: root, maxBuffer: 256 * 1024 * 1024 });

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

// #942 리뷰 F1: 후보 재현 reader는 세 경로를 구분한다. 고정 입력은 고정 바이트, 후보 산출물은 커밋된 바이트,
// 그 밖의 경로는 작업 트리로 대체하지 않고 CANDIDATE_INPUT_NOT_PINNED로 실패한다.
async function fakeCandidateRoot(t, { localInventory }) {
  const fakeRoot = await mkdtemp(path.join(os.tmpdir(), "easysubway-candidate-pinned-reader-"));
  t.after(() => rm(fakeRoot, { recursive: true, force: true }));
  const pinnedInventory = Buffer.from("{\"pinned\":true}\n");
  const write = async (relative, bytes) => {
    await mkdir(path.dirname(path.join(fakeRoot, relative)), { recursive: true });
    await writeFile(path.join(fakeRoot, relative), bytes);
  };
  await write("tools/datapack/source-inventory.json", localInventory ?? pinnedInventory);
  await write(BUILD_SPEC_PATH, Buffer.from("{\"candidateId\":\"fake\"}\n"));
  await write("tools/datapack/unpinned-input.json", Buffer.from("{\"unpinned\":true}\n"));
  await write(CANDIDATE_INPUT_MANIFEST_PATH, serializeCandidateInputManifest(buildCandidateInputManifest({
    candidateId: "fake",
    candidateBuildSpecSha256: "a".repeat(64),
    preparationSha256: "b".repeat(64),
    fanInSha256: "c".repeat(64),
    entries: [{ path: "tools/datapack/source-inventory.json", sha256: sha256(pinnedInventory), byteSize: pinnedInventory.length }],
  })));
  return { fakeRoot, pinnedInventory };
}

test("후보 재현 reader는 고정 입력·후보 산출물·미고정 경로를 각각 다르게 다룬다", async (t) => {
  const localInventory = Buffer.from("{\"registered\":\"later\"}\n");
  const { fakeRoot, pinnedInventory } = await fakeCandidateRoot(t, { localInventory });
  const requested = [];
  const read = await candidatePinnedReader({
    root: fakeRoot,
    env: { EASYSUBWAY_DATA_PACK_BASE_URL: "https://objects.example.test/o" },
    cacheDirectory: path.join(fakeRoot, ".candidate-input-cache"),
    fetchImpl: async (url) => {
      requested.push(url);
      return new Response(pinnedInventory, { status: 200, headers: { "content-length": String(pinnedInventory.length) } });
    },
  });
  // 고정 입력: 작업 트리가 달라도 고정 바이트를 받는다.
  assert.deepEqual(await read("tools/datapack/source-inventory.json"), pinnedInventory);
  assert.deepEqual(requested, [`https://objects.example.test/o/candidate-inputs/sha256/${sha256(pinnedInventory)}`]);
  // 후보 산출물: 커밋된(작업 트리) 바이트를 그대로 읽는다.
  assert.deepEqual(await read(BUILD_SPEC_PATH), Buffer.from("{\"candidateId\":\"fake\"}\n"));
  // 미고정·비산출물 경로: 작업 트리에 파일이 있어도 읽지 않고 실패한다.
  await assert.rejects(read("tools/datapack/unpinned-input.json"), /CANDIDATE_INPUT_NOT_PINNED: tools\/datapack\/unpinned-input.json/);
});

// #942 리뷰 F2: 원천만 등록한 PR에서만 도는 작업 공간 분기(복사 → 받기 → 덮어쓰기 → 정리)를 CI에서 실제로 실행한다.
test("고정 입력이 작업 트리와 다르면 작업 공간은 저장소를 복사하고 그 입력만 고정 바이트로 덮어쓴 뒤 정리된다", async (t) => {
  const changed = Buffer.from("{\"registered\":\"later\"}\n");
  const { fakeRoot, pinnedInventory } = await fakeCandidateRoot(t, { localInventory: changed });
  await mkdir(path.join(fakeRoot, ".git"));
  await writeFile(path.join(fakeRoot, ".git", "HEAD"), "ref: refs/heads/main\n");
  let fetched = 0;
  const workspace = await candidatePinnedWorkspace({
    root: fakeRoot,
    env: { EASYSUBWAY_DATA_PACK_BASE_URL: "https://objects.example.test/o" },
    cacheDirectory: path.join(fakeRoot, ".candidate-input-cache"),
    fetchImpl: async () => {
      fetched += 1;
      return new Response(pinnedInventory, { status: 200, headers: { "content-length": String(pinnedInventory.length) } });
    },
  });
  t.after(() => workspace.cleanup());
  assert.notEqual(workspace.root, fakeRoot);
  assert.deepEqual(workspace.stalePaths, ["tools/datapack/source-inventory.json"]);
  assert.equal(fetched, 1);
  assert.deepEqual(await readFileBytes(path.join(workspace.root, "tools/datapack/source-inventory.json")), pinnedInventory);
  assert.deepEqual(await readFileBytes(path.join(workspace.root, "tools/datapack/unpinned-input.json")), Buffer.from("{\"unpinned\":true}\n"));
  await assert.rejects(stat(path.join(workspace.root, ".git")), { code: "ENOENT" });
  // 원래 작업 트리는 바뀌지 않는다.
  assert.deepEqual(await readFileBytes(path.join(fakeRoot, "tools/datapack/source-inventory.json")), changed);
  await workspace.cleanup();
  await assert.rejects(stat(workspace.root), { code: "ENOENT" });

  // 고정 입력이 모두 같으면 저장소 루트를 그대로 쓰고, 정리는 아무것도 지우지 않는다.
  const { fakeRoot: currentRoot } = await fakeCandidateRoot(t, {});
  const current = await candidatePinnedWorkspace({ root: currentRoot, env: {}, fetchImpl: async () => assert.fail("no fetch") });
  assert.equal(current.root, currentRoot);
  assert.deepEqual(current.stalePaths, []);
  await current.cleanup();
  assert.ok((await stat(currentRoot)).isDirectory());

  // 받지 못하면 작업 공간을 만들지 않고 실패한다.
  const { fakeRoot: brokenRoot } = await fakeCandidateRoot(t, { localInventory: changed });
  await assert.rejects(candidatePinnedWorkspace({
    root: brokenRoot,
    env: { EASYSUBWAY_DATA_PACK_BASE_URL: "https://objects.example.test/o" },
    cacheDirectory: path.join(brokenRoot, ".candidate-input-cache"),
    fetchImpl: async () => new Response("missing", { status: 404 }),
  }), /CANDIDATE_INPUT_FETCH_FAILED: tools\/datapack\/source-inventory.json/);
});

// #943 리뷰 F6: 작업 트리에서 읽어도 되는 후보 산출물 목록은 helper가 명시적으로 고정하고, 갱신 도구의 출력 목록과 같은지 여기서 확인한다.
// 갱신 도구 출력에 입력 파일이 끼어들면 이 테스트가 먼저 실패한다.
test("후보 재현 reader의 로컬 읽기 허용 목록은 갱신 도구 출력 목록과 같고, 고정 입력과는 fan-in만 겹친다", () => {
  assert.deepEqual([...CANDIDATE_OUTPUT_PATHS].sort(), [...NATIONWIDE_CANDIDATE_REFRESH_OUTPUTS].sort());
  const outputs = new Set(CANDIDATE_OUTPUT_PATHS);
  // fan-in은 후보 산출물이면서 prepare가 읽는 입력이다. 고정 입력이 우선하고, 그 sha는 매니페스트 fanInSha256과 같다.
  assert.deepEqual(manifest.files.filter(({ path: relative }) => outputs.has(relative)).map(({ path: relative }) => relative), [FAN_IN_PATH]);
  assert.equal(manifest.files.find(({ path: relative }) => relative === FAN_IN_PATH).sha256, manifest.fanInSha256);
});

// #954 리뷰 F2: 절대·상위 경로 인자는 후보 작업 공간을 무시하고 작업 트리를 읽게 하므로 막는다.
test("후보 작업 공간 경로 helper는 저장소 상대 경로만 받고 절대·상위·역슬래시 경로를 거부한다", () => {
  assert.equal(candidateWorkspacePath("/candidate", "tools/datapack/source-inventory.json"), "/candidate/tools/datapack/source-inventory.json");
  for (const bad of ["/abs/tools/datapack/source-inventory.json", "../outside.json", "tools/../outside.json", "tools//a.json", "./a.json", "tools\\a.json", "", undefined]) {
    assert.throws(() => candidateWorkspacePath("/candidate", bad), /CANDIDATE_WORKSPACE_PATH_NOT_RELATIVE/, String(bad));
  }
});
