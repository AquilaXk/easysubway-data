import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import { applyTimetableRefresh } from "./apply-timetable-refresh.mjs";

const execFileAsync = promisify(execFile);

const CONTRACT_PATH = "tools/datapack/itx-cheongchun-coverage-contract.json";
const EVIDENCE_PATH = "tools/datapack/server-timetable-snapshot-evidence.json";
const RUNTIME_EVIDENCE_PATH = "backend/src/main/resources/timetable/server-timetable-snapshot-evidence.json";
const SEED_PATH = "backend/src/main/resources/timetable/line4-timetable-seed.sql.gz";

const SOURCE_A = "itx-cheongchun-source-timetable-A";
const SOURCE_B = "itx-cheongchun-source-timetable-B";
const FRESH_A = "2026-07-20T00:00:00+09:00";
const FRESH_B = "2026-07-27T00:00:00+09:00";

async function git(cwd, args) {
  return execFileAsync("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 });
}

function contractFor(sourceId, freshUntil) {
  return `${JSON.stringify({
    schemaVersion: 2,
    artifactKind: "itx-cheongchun-coverage-contract",
    serviceId: "ITX_CHEONGCHUN",
    sourceTimetableArtifact: {
      artifactId: sourceId,
      artifactPath: `tools/datapack/sources/${sourceId}.json`,
      completenessEvidencePath: `tools/datapack/sources/${sourceId}-completeness.json`,
      freshUntil,
    },
  }, null, 2)}\n`;
}

function evidenceFor(sourceId, freshUntil) {
  return `${JSON.stringify({
    schemaVersion: 1,
    artifactKind: "server-timetable-snapshot-evidence",
    freshUntil,
    sourceArtifact: { id: sourceId },
  }, null, 2)}\n`;
}

// 초기 tracked 상태: source-A가 승격돼 있고 evidence의 freshUntil이 FRESH_A인 클린 트리.
async function makeFixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "apply-timetable-refresh-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await git(dir, ["init", "-q"]);
  await git(dir, ["config", "user.email", "test@example.com"]);
  await git(dir, ["config", "user.name", "test"]);
  await git(dir, ["config", "commit.gpgsign", "false"]);
  for (const relative of [
    "tools/datapack/sources",
    "backend/src/main/resources/timetable",
  ]) {
    await mkdir(path.join(dir, relative), { recursive: true });
  }
  await writeFile(path.join(dir, `tools/datapack/sources/${SOURCE_A}.json`), `${JSON.stringify({ artifactId: SOURCE_A })}\n`);
  await writeFile(path.join(dir, `tools/datapack/sources/${SOURCE_A}-completeness.json`), `${JSON.stringify({ id: SOURCE_A })}\n`);
  await writeFile(path.join(dir, CONTRACT_PATH), contractFor(SOURCE_A, FRESH_A));
  await writeFile(path.join(dir, SEED_PATH), "seed-gz-placeholder-A\n");
  await writeFile(path.join(dir, EVIDENCE_PATH), evidenceFor(SOURCE_A, FRESH_A));
  await writeFile(path.join(dir, RUNTIME_EVIDENCE_PATH), evidenceFor(SOURCE_A, FRESH_A));
  await git(dir, ["add", "."]);
  await git(dir, ["commit", "-qm", "seed"]);
  return dir;
}

// 워크플로가 만드는 promotion.patch를 흉내: source-B 추가 + contract를 B로 repoint.
async function buildPromotionPatch(dir) {
  await writeFile(path.join(dir, `tools/datapack/sources/${SOURCE_B}.json`), `${JSON.stringify({ artifactId: SOURCE_B })}\n`);
  await writeFile(path.join(dir, `tools/datapack/sources/${SOURCE_B}-completeness.json`), `${JSON.stringify({ id: SOURCE_B })}\n`);
  await writeFile(path.join(dir, CONTRACT_PATH), contractFor(SOURCE_B, FRESH_B));
  await git(dir, ["add", "-N", "tools/datapack/sources", CONTRACT_PATH]);
  const { stdout } = await git(dir, ["diff", "--", "tools/datapack/sources", CONTRACT_PATH]);
  // 클린 트리로 복원한다.
  await git(dir, ["reset", "-q"]);
  await rm(path.join(dir, `tools/datapack/sources/${SOURCE_B}.json`));
  await rm(path.join(dir, `tools/datapack/sources/${SOURCE_B}-completeness.json`));
  await git(dir, ["checkout", "--", CONTRACT_PATH]);
  const patchPath = path.join(dir, "promotion.patch");
  await writeFile(patchPath, stdout);
  return patchPath;
}

// 재산출 성공 스텁: 적용된 contract에서 freshUntil/artifactId를 읽어 evidence 3종을 갱신한다.
function makeBuildStub(dir, overrides = {}) {
  const calls = { count: 0 };
  const run = async () => {
    calls.count += 1;
    const contract = JSON.parse(await readFile(path.join(dir, CONTRACT_PATH), "utf8"));
    const freshUntil = overrides.freshUntil ?? contract.sourceTimetableArtifact.freshUntil;
    const sourceId = overrides.sourceId ?? contract.sourceTimetableArtifact.artifactId;
    const evidence = evidenceFor(sourceId, freshUntil);
    await writeFile(path.join(dir, EVIDENCE_PATH), evidence);
    await writeFile(path.join(dir, RUNTIME_EVIDENCE_PATH), evidence);
    await writeFile(path.join(dir, SEED_PATH), `seed-gz-placeholder-${sourceId}\n`);
  };
  return { run, calls };
}

test("정상 경로: 클린 트리에서 patch 적용→재산출→검증까지 완주한다", async (t) => {
  const dir = await makeFixture(t);
  const patchPath = await buildPromotionPatch(dir);
  const build = makeBuildStub(dir);

  const summary = await applyTimetableRefresh({
    patchPath,
    repoRoot: dir,
    runSnapshotBuild: build.run,
  });

  assert.equal(build.calls.count, 1);
  assert.equal(summary.freshUntilBefore, FRESH_A);
  assert.equal(summary.freshUntilAfter, FRESH_B);
  assert.equal(summary.sourceArtifactId, SOURCE_B);
  assert.ok(summary.changedFiles.includes(CONTRACT_PATH));
  assert.ok(summary.changedFiles.some((file) => file.includes(SOURCE_B)));
  // tracked 산출물이 실제로 갱신됐다.
  const evidence = JSON.parse(await readFile(path.join(dir, EVIDENCE_PATH), "utf8"));
  assert.equal(evidence.freshUntil, FRESH_B);
  assert.equal(evidence.sourceArtifact.id, SOURCE_B);
  const contract = JSON.parse(await readFile(path.join(dir, CONTRACT_PATH), "utf8"));
  assert.equal(contract.sourceTimetableArtifact.artifactId, SOURCE_B);
});

test("더티 트리: 가드 경로에 uncommitted 변경이 있으면 patch를 적용하지 않고 fail closed", async (t) => {
  const dir = await makeFixture(t);
  const patchPath = await buildPromotionPatch(dir);
  const build = makeBuildStub(dir);
  // 가드 경로 하나를 더럽힌다.
  await writeFile(path.join(dir, CONTRACT_PATH), contractFor(SOURCE_A, FRESH_A).replace("2", "3"));

  await assert.rejects(
    applyTimetableRefresh({ patchPath, repoRoot: dir, runSnapshotBuild: build.run }),
    /클린 트리|uncommitted|더티/,
  );
  assert.equal(build.calls.count, 0, "재산출은 호출되지 않아야 한다");
});

test("patch 불일치: git apply --check 실패 시 재산출 없이 fail closed", async (t) => {
  const dir = await makeFixture(t);
  const patchPath = await buildPromotionPatch(dir);
  const build = makeBuildStub(dir);
  // 컨텍스트가 어긋나도록 base contract를 손질해 patch가 더 이상 적용되지 않게 한다.
  await writeFile(path.join(dir, CONTRACT_PATH), contractFor("itx-cheongchun-source-timetable-X", FRESH_A));
  await git(dir, ["add", CONTRACT_PATH]);
  await git(dir, ["commit", "-qm", "drift"]);

  await assert.rejects(
    applyTimetableRefresh({ patchPath, repoRoot: dir, runSnapshotBuild: build.run }),
    /patch|apply/i,
  );
  assert.equal(build.calls.count, 0);
});

test("재산출 실패 전파: patch 적용 후 빌드가 실패하면 상태와 복구 안내를 담아 fail closed", async (t) => {
  const dir = await makeFixture(t);
  const patchPath = await buildPromotionPatch(dir);
  const failingBuild = async () => {
    throw new Error("snapshot rebuild boom");
  };

  await assert.rejects(
    applyTimetableRefresh({ patchPath, repoRoot: dir, runSnapshotBuild: failingBuild }),
    (error) => {
      assert.match(error.message, /재산출|snapshot rebuild boom/);
      assert.match(error.message, /git (checkout|stash|reset|restore)/i);
      return true;
    },
  );
  // patch는 이미 적용된 상태로 남는다(자동 롤백하지 않음).
  const contract = JSON.parse(await readFile(path.join(dir, CONTRACT_PATH), "utf8"));
  assert.equal(contract.sourceTimetableArtifact.artifactId, SOURCE_B);
});

test("검증 실패: 재산출 evidence의 freshUntil이 연장되지 않으면 fail closed", async (t) => {
  const dir = await makeFixture(t);
  const patchPath = await buildPromotionPatch(dir);
  // freshUntil을 적용 전과 동일하게 남기는 스텁.
  const build = makeBuildStub(dir, { freshUntil: FRESH_A });

  await assert.rejects(
    applyTimetableRefresh({ patchPath, repoRoot: dir, runSnapshotBuild: build.run }),
    /freshUntil|연장/,
  );
});

test("검증 실패: evidence sourceArtifact가 patch의 신규 source와 불일치하면 fail closed", async (t) => {
  const dir = await makeFixture(t);
  const patchPath = await buildPromotionPatch(dir);
  const build = makeBuildStub(dir, { sourceId: "itx-cheongchun-source-timetable-STALE" });

  await assert.rejects(
    applyTimetableRefresh({ patchPath, repoRoot: dir, runSnapshotBuild: build.run }),
    /source|sourceArtifact/,
  );
});

test("guard-scope: patch가 가드 경로 밖 파일을 건드리면 적용 전에 fail closed", async (t) => {
  const dir = await makeFixture(t);
  const build = makeBuildStub(dir);
  // 가드 경로 밖(tools/out-of-scope.txt)을 추가하는 patch를 만든다.
  await writeFile(path.join(dir, "tools/out-of-scope.txt"), "not-guarded\n");
  await git(dir, ["add", "-N", "tools/out-of-scope.txt"]);
  const { stdout } = await git(dir, ["diff", "--", "tools/out-of-scope.txt"]);
  await git(dir, ["reset", "-q"]);
  await rm(path.join(dir, "tools/out-of-scope.txt"));
  const patchPath = path.join(dir, "out-of-scope.patch");
  await writeFile(patchPath, stdout);

  await assert.rejects(
    applyTimetableRefresh({ patchPath, repoRoot: dir, runSnapshotBuild: build.run }),
    (error) => {
      assert.match(error.message, /guard-scope|가드 경로/);
      assert.match(error.message, /out-of-scope\.txt/);
      return true;
    },
  );
  assert.equal(build.calls.count, 0, "재산출은 호출되지 않아야 한다");
});

test("evidence 사본 불일치: 재산출 후 runtime 사본이 tools 사본과 다르면 fail closed", async (t) => {
  const dir = await makeFixture(t);
  const patchPath = await buildPromotionPatch(dir);
  // freshUntil·source는 정상 갱신하되 runtime 사본만 일부러 다르게 쓴다(사본 동기 깨짐).
  const desyncBuild = async () => {
    const contract = JSON.parse(await readFile(path.join(dir, CONTRACT_PATH), "utf8"));
    const freshUntil = contract.sourceTimetableArtifact.freshUntil;
    const sourceId = contract.sourceTimetableArtifact.artifactId;
    await writeFile(path.join(dir, EVIDENCE_PATH), evidenceFor(sourceId, freshUntil));
    await writeFile(path.join(dir, RUNTIME_EVIDENCE_PATH), `${evidenceFor(sourceId, freshUntil)}\n`);
    await writeFile(path.join(dir, SEED_PATH), `seed-gz-placeholder-${sourceId}\n`);
  };

  await assert.rejects(
    applyTimetableRefresh({ patchPath, repoRoot: dir, runSnapshotBuild: desyncBuild }),
    /사본|바이트 동일|불일치/,
  );
});

test("멱등성: 성공 후 재실행하면 더티 트리 가드가 재적용을 차단한다", async (t) => {
  const dir = await makeFixture(t);
  const patchPath = await buildPromotionPatch(dir);
  const build = makeBuildStub(dir);

  await applyTimetableRefresh({ patchPath, repoRoot: dir, runSnapshotBuild: build.run });
  assert.equal(build.calls.count, 1);

  // 재실행: 첫 실행이 남긴 uncommitted 변경(가드 경로)으로 클린 트리 게이트가 막아야 한다.
  await assert.rejects(
    applyTimetableRefresh({ patchPath, repoRoot: dir, runSnapshotBuild: build.run }),
    /클린 트리|uncommitted|더티/,
  );
  assert.equal(build.calls.count, 1, "재실행에서 재산출은 호출되지 않아야 한다");
});

test("--patch 경로 미지정 시 명시적으로 실패한다", async (t) => {
  const dir = await makeFixture(t);
  await assert.rejects(
    applyTimetableRefresh({ repoRoot: dir, runSnapshotBuild: async () => {} }),
    /patch/i,
  );
});
