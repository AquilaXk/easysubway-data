import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import { applyTimetableRefresh } from "./apply-timetable-refresh.mjs";
import { canonicalJson, sha256 } from "./lib/manifest-validation.mjs";

const execFileAsync = promisify(execFile);

const CONTRACT_PATH = "tools/datapack/itx-cheongchun-coverage-contract.json";
const TOPOLOGY_EVIDENCE_PATH = "tools/datapack/itx-cheongchun-topology-evidence.json";
const EVIDENCE_PATH = "tools/datapack/server-timetable-snapshot-evidence.json";
const RUNTIME_EVIDENCE_PATH = "backend/src/main/resources/timetable/server-timetable-snapshot-evidence.json";
const SEED_PATH = "backend/src/main/resources/timetable/line4-timetable-seed.sql.gz";
const RECEIPT_PATH = "tools/datapack/timetable-refresh-transaction-receipt.json";

const SOURCE_A = "itx-cheongchun-source-timetable-A";
const SOURCE_B = "itx-cheongchun-source-timetable-B";
const FRESH_A = "2026-07-20T00:00:00+09:00";
const FRESH_B = "2026-07-27T00:00:00+09:00";

function sourcePathFor(sourceId) {
  return `tools/datapack/sources/${sourceId}.json`;
}

function completenessPathFor(sourceId) {
  return `tools/datapack/sources/${sourceId}-completeness-evidence.json`;
}

async function git(cwd, args) {
  return execFileAsync("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 });
}

function contractFor(sourceId, freshUntil) {
  const sourceBytes = Buffer.from(sourceFor(sourceId, freshUntil), "utf8");
  const completenessBytes = Buffer.from(completenessFor(sourceId), "utf8");
  return `${JSON.stringify({
    schemaVersion: 2,
    artifactKind: "itx-cheongchun-coverage-contract",
    serviceId: "ITX_CHEONGCHUN",
    sourceTimetableArtifact: {
      status: "ADMITTED",
      admissionEligible: true,
      artifactId: sourceId,
      artifactPath: sourcePathFor(sourceId),
      sha256: sha256(sourceBytes),
      completenessEvidencePath: completenessPathFor(sourceId),
      completenessEvidenceSha256: sha256(completenessBytes),
      freshUntil,
      policyVersion: "itx-snapshot-anomaly-v1",
    },
  }, null, 2)}\n`;
}

function sourceFor(sourceId, freshUntil) {
  return `${JSON.stringify({
    schemaVersion: 1,
    artifactKind: "itx-cheongchun-source-timetable",
    artifactId: sourceId,
    freshUntil,
  }, null, 2)}\n`;
}

function completenessFor(sourceId) {
  return `${JSON.stringify({
    schemaVersion: 1,
    artifactKind: "korail-itx-cheongchun-completeness-evidence",
    artifactId: sourceId,
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

function topologyEvidenceFor(sourceId, freshUntil) {
  return `${JSON.stringify({
    schemaVersion: 1,
    artifactKind: "itx-cheongchun-mobile-topology-evidence",
    sourceArtifact: {
      id: sourceId,
      sha256: sha256(Buffer.from(sourceFor(sourceId, freshUntil), "utf8")),
      completenessEvidenceSha256: sha256(
        Buffer.from(completenessFor(sourceId), "utf8"),
      ),
      freshUntil,
    },
  }, null, 2)}\n`;
}

function extensionResultFor(sourceId, currentFreshUntil, extendedFreshUntil) {
  const unsigned = {
    schemaVersion: 1,
    artifactKind: "source-freshness-extension-result",
    decision: "EXTENDED",
    reasonCode: "POSITIVE_OBSERVATION_EXTENDED",
    sourceId,
    snapshotId: `snapshot-${sourceId}`,
    snapshotSha256: "1".repeat(64),
    rawEvidenceSha256: "2".repeat(64),
    sourceClassId: "itx-timetable",
    policySha256: "3".repeat(64),
    observationEvidenceSha256: "4".repeat(64),
    currentFreshUntil,
    extendedFreshUntil,
    evaluatedAt: "2026-07-21T00:00:00.000Z",
    observedAt: "2026-07-20T00:00:00.000Z",
  };
  return {
    ...unsigned,
    resultSha256: sha256(Buffer.from(canonicalJson(unsigned), "utf8")),
  };
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
  await writeFile(
    path.join(dir, sourcePathFor(SOURCE_A)),
    sourceFor(SOURCE_A, FRESH_A),
  );
  await writeFile(path.join(dir, completenessPathFor(SOURCE_A)), completenessFor(SOURCE_A));
  await writeFile(path.join(dir, CONTRACT_PATH), contractFor(SOURCE_A, FRESH_A));
  await writeFile(path.join(dir, TOPOLOGY_EVIDENCE_PATH), topologyEvidenceFor(SOURCE_A, FRESH_A));
  await writeFile(path.join(dir, SEED_PATH), "seed-gz-placeholder-A\n");
  await writeFile(path.join(dir, EVIDENCE_PATH), evidenceFor(SOURCE_A, FRESH_A));
  await writeFile(path.join(dir, RUNTIME_EVIDENCE_PATH), evidenceFor(SOURCE_A, FRESH_A));
  await git(dir, ["add", "."]);
  await git(dir, ["commit", "-qm", "seed"]);
  return dir;
}

// 워크플로가 만드는 promotion.patch를 흉내: source-B 추가 + contract를 B로 repoint.
async function buildPromotionPatch(dir, { ancillaryPath = null } = {}) {
  await writeFile(
    path.join(dir, sourcePathFor(SOURCE_B)),
    sourceFor(SOURCE_B, FRESH_B),
  );
  await writeFile(path.join(dir, completenessPathFor(SOURCE_B)), completenessFor(SOURCE_B));
  await writeFile(path.join(dir, CONTRACT_PATH), contractFor(SOURCE_B, FRESH_B));
  await writeFile(path.join(dir, TOPOLOGY_EVIDENCE_PATH), topologyEvidenceFor(SOURCE_B, FRESH_B));
  if (ancillaryPath != null) {
    await writeFile(path.join(dir, ancillaryPath), "ancillary\n");
  }
  await git(dir, ["add", "-N", "tools/datapack/sources", CONTRACT_PATH, TOPOLOGY_EVIDENCE_PATH]);
  const { stdout } = await git(dir, ["diff", "--", "tools/datapack/sources", CONTRACT_PATH, TOPOLOGY_EVIDENCE_PATH]);
  // 클린 트리로 복원한다.
  await git(dir, ["reset", "-q"]);
  await rm(path.join(dir, sourcePathFor(SOURCE_B)));
  await rm(path.join(dir, completenessPathFor(SOURCE_B)));
  if (ancillaryPath != null) {
    await rm(path.join(dir, ancillaryPath));
  }
  await git(dir, ["checkout", "--", CONTRACT_PATH]);
  await git(dir, ["checkout", "--", TOPOLOGY_EVIDENCE_PATH]);
  const patchPath = path.join(dir, "promotion.patch");
  await writeFile(patchPath, stdout);
  return patchPath;
}

async function writeForgedCurrentReceipt(dir, patchPath) {
  const outputPaths = [
    sourcePathFor(SOURCE_A),
    completenessPathFor(SOURCE_A),
    CONTRACT_PATH,
    TOPOLOGY_EVIDENCE_PATH,
    SEED_PATH,
    EVIDENCE_PATH,
    RUNTIME_EVIDENCE_PATH,
  ].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  const outputs = await Promise.all(outputPaths.map(async (outputPath) => {
    const bytes = await readFile(path.join(dir, outputPath));
    return { path: outputPath, sha256: sha256(bytes), byteSize: bytes.length };
  }));
  const unsigned = {
    schemaVersion: 1,
    artifactKind: "timetable-refresh-transaction-receipt",
    status: "APPLIED",
    inputPatchSha256: sha256(await readFile(patchPath)),
    sourceArtifactIdBefore: SOURCE_A,
    sourceArtifactIdAfter: SOURCE_A,
    sourceArtifactSha256: sha256(await readFile(path.join(dir, sourcePathFor(SOURCE_A)))),
    completenessEvidenceSha256: sha256(
      await readFile(path.join(dir, completenessPathFor(SOURCE_A))),
    ),
    policyVersion: "itx-snapshot-anomaly-v1",
    freshUntilBefore: FRESH_A,
    freshUntilAfter: FRESH_A,
    freshnessExtensionResultSha256: null,
    outputs,
  };
  await writeFile(path.join(dir, RECEIPT_PATH), `${JSON.stringify({
    ...unsigned,
    transactionSha256: sha256(Buffer.from(canonicalJson(unsigned), "utf8")),
  }, null, 2)}\n`);
}

async function buildSameSourceFreshnessPatch(dir) {
  const sourcePath = sourcePathFor(SOURCE_A);
  await writeFile(path.join(dir, sourcePath), sourceFor(SOURCE_A, FRESH_B));
  await writeFile(path.join(dir, CONTRACT_PATH), contractFor(SOURCE_A, FRESH_B));
  await writeFile(
    path.join(dir, TOPOLOGY_EVIDENCE_PATH),
    topologyEvidenceFor(SOURCE_A, FRESH_B),
  );
  const { stdout } = await git(dir, [
    "diff",
    "--",
    sourcePath,
    CONTRACT_PATH,
    TOPOLOGY_EVIDENCE_PATH,
  ]);
  await git(dir, ["checkout", "--", sourcePath, CONTRACT_PATH, TOPOLOGY_EVIDENCE_PATH]);
  const patchPath = path.join(dir, "same-source-freshness.patch");
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
  assert.equal(summary.status, "APPLIED");
  assert.equal(summary.freshUntilBefore, FRESH_A);
  assert.equal(summary.freshUntilAfter, FRESH_B);
  assert.equal(summary.sourceArtifactId, SOURCE_B);
  assert.ok(summary.changedFiles.includes(CONTRACT_PATH));
  assert.ok(summary.changedFiles.includes(TOPOLOGY_EVIDENCE_PATH));
  assert.ok(summary.changedFiles.some((file) => file.includes(SOURCE_B)));
  // tracked 산출물이 실제로 갱신됐다.
  const evidence = JSON.parse(await readFile(path.join(dir, EVIDENCE_PATH), "utf8"));
  assert.equal(evidence.freshUntil, FRESH_B);
  assert.equal(evidence.sourceArtifact.id, SOURCE_B);
  const contract = JSON.parse(await readFile(path.join(dir, CONTRACT_PATH), "utf8"));
  assert.equal(contract.sourceTimetableArtifact.artifactId, SOURCE_B);
  const receipt = JSON.parse(await readFile(path.join(dir, RECEIPT_PATH), "utf8"));
  assert.equal(receipt.artifactKind, "timetable-refresh-transaction-receipt");
  assert.equal(receipt.sourceArtifactIdBefore, SOURCE_A);
  assert.equal(receipt.sourceArtifactIdAfter, SOURCE_B);
  assert.equal(receipt.freshnessExtensionResultSha256, null);
  assert.deepEqual(
    receipt.outputs.map((entry) => entry.path),
    [...receipt.outputs.map((entry) => entry.path)].sort(),
  );
});

test("동일 source freshness patch는 reviewed extension result 없이는 적용하지 않는다", async (t) => {
  const dir = await makeFixture(t);
  const patchPath = await buildSameSourceFreshnessPatch(dir);
  const build = makeBuildStub(dir);

  await assert.rejects(
    applyTimetableRefresh({ patchPath, repoRoot: dir, runSnapshotBuild: build.run }),
    /freshness extension|EXTENDED/i,
  );
  assert.equal(build.calls.count, 0);
  assert.equal(
    JSON.parse(await readFile(path.join(dir, CONTRACT_PATH), "utf8"))
      .sourceTimetableArtifact.artifactId,
    SOURCE_A,
  );
});

test("동일 source freshness patch는 exact Data #57 result로만 receipt를 만든다", async (t) => {
  const dir = await makeFixture(t);
  const patchPath = await buildSameSourceFreshnessPatch(dir);
  const extensionResult = extensionResultFor(SOURCE_A, FRESH_A, FRESH_B);
  const extensionResultPath = path.join(dir, "freshness-extension-result.json");
  await writeFile(extensionResultPath, `${JSON.stringify(extensionResult, null, 2)}\n`);
  const build = makeBuildStub(dir);

  const summary = await applyTimetableRefresh({
    patchPath,
    freshnessExtensionResultPath: extensionResultPath,
    repoRoot: dir,
    runSnapshotBuild: build.run,
  });

  assert.equal(summary.status, "APPLIED");
  assert.equal(build.calls.count, 1);
  const receipt = JSON.parse(await readFile(path.join(dir, RECEIPT_PATH), "utf8"));
  assert.equal(receipt.sourceArtifactIdBefore, SOURCE_A);
  assert.equal(receipt.sourceArtifactIdAfter, SOURCE_A);
  assert.equal(receipt.freshnessExtensionResultSha256, extensionResult.resultSha256);
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

test("재산출 실패는 patch와 snapshot 산출물을 적용 전 bytes로 복원한다", async (t) => {
  const dir = await makeFixture(t);
  const patchPath = await buildPromotionPatch(dir);
  const failingBuild = async () => {
    throw new Error("snapshot rebuild boom");
  };

  await assert.rejects(
    applyTimetableRefresh({ patchPath, repoRoot: dir, runSnapshotBuild: failingBuild }),
    (error) => {
      assert.match(error.message, /재산출|snapshot rebuild boom/);
      assert.match(error.message, /복원/);
      return true;
    },
  );
  const contract = JSON.parse(await readFile(path.join(dir, CONTRACT_PATH), "utf8"));
  assert.equal(contract.sourceTimetableArtifact.artifactId, SOURCE_A);
  await assert.rejects(readFile(path.join(dir, sourcePathFor(SOURCE_B))), { code: "ENOENT" });
  assert.deepEqual(
    JSON.parse(await readFile(path.join(dir, TOPOLOGY_EVIDENCE_PATH), "utf8")),
    JSON.parse(topologyEvidenceFor(SOURCE_A, FRESH_A)),
  );
});

test("복원 자체가 실패해도 원래 재산출 오류를 주 원인으로 보존한다", async (t) => {
  const dir = await makeFixture(t);
  const patchPath = await buildPromotionPatch(dir);
  const failingBuild = async () => {
    await rm(dir, { recursive: true, force: true });
    await writeFile(dir, "restore boundary blocker\n");
    throw new Error("snapshot rebuild boom");
  };

  await assert.rejects(
    applyTimetableRefresh({ patchPath, repoRoot: dir, runSnapshotBuild: failingBuild }),
    (error) => {
      assert.match(error.message, /재산출|snapshot rebuild boom/);
      assert.match(error.message, /복원 실패|부분 적용/);
      assert.ok(error.cause instanceof Error);
      return true;
    },
  );
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
  assert.equal(
    JSON.parse(await readFile(path.join(dir, CONTRACT_PATH), "utf8")).sourceTimetableArtifact.artifactId,
    SOURCE_A,
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
  assert.equal(
    JSON.parse(await readFile(path.join(dir, CONTRACT_PATH), "utf8")).sourceTimetableArtifact.artifactId,
    SOURCE_A,
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

test("current admission patch가 topology evidence를 함께 갱신하지 않으면 적용 전에 fail closed", async (t) => {
  const dir = await makeFixture(t);
  const build = makeBuildStub(dir);
  await writeFile(path.join(dir, sourcePathFor(SOURCE_B)), sourceFor(SOURCE_B, FRESH_B));
  await writeFile(path.join(dir, CONTRACT_PATH), contractFor(SOURCE_B, FRESH_B));
  await git(dir, ["add", "-N", "tools/datapack/sources", CONTRACT_PATH]);
  const { stdout } = await git(dir, ["diff", "--", "tools/datapack/sources", CONTRACT_PATH]);
  await git(dir, ["reset", "-q"]);
  await rm(path.join(dir, sourcePathFor(SOURCE_B)));
  await git(dir, ["checkout", "--", CONTRACT_PATH]);
  const patchPath = path.join(dir, "missing-topology-evidence.patch");
  await writeFile(patchPath, stdout);

  await assert.rejects(
    applyTimetableRefresh({ patchPath, repoRoot: dir, runSnapshotBuild: build.run }),
    /source·coverage contract·topology evidence/,
  );
  assert.equal(build.calls.count, 0);
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

test("멱등성: 동일 patch와 verified receipt 재실행은 명시적 NO_OP이다", async (t) => {
  const dir = await makeFixture(t);
  const patchPath = await buildPromotionPatch(dir);
  const build = makeBuildStub(dir);

  const first = await applyTimetableRefresh({
    patchPath,
    repoRoot: dir,
    runSnapshotBuild: build.run,
  });
  assert.equal(build.calls.count, 1);

  const second = await applyTimetableRefresh({
    patchPath,
    repoRoot: dir,
    runSnapshotBuild: build.run,
  });
  assert.equal(first.status, "APPLIED");
  assert.equal(second.status, "NO_OP");
  assert.equal(second.transactionSha256, first.transactionSha256);
  assert.equal(build.calls.count, 1, "재실행에서 재산출은 호출되지 않아야 한다");
});

test("미적용 patch SHA로 만든 self-consistent receipt는 NO_OP을 만들 수 없다", async (t) => {
  const dir = await makeFixture(t);
  const patchPath = await buildPromotionPatch(dir);
  const build = makeBuildStub(dir);
  await writeForgedCurrentReceipt(dir, patchPath);

  await assert.rejects(
    applyTimetableRefresh({ patchPath, repoRoot: dir, runSnapshotBuild: build.run }),
    /receipt.*patch.*applied|reverse apply/i,
  );
  assert.equal(build.calls.count, 0);
  assert.equal(
    JSON.parse(await readFile(path.join(dir, CONTRACT_PATH), "utf8"))
      .sourceTimetableArtifact.artifactId,
    SOURCE_A,
  );
});

test("receipt inventory가 증명하지 않는 ancillary source path는 patch에서 거부한다", async (t) => {
  const dir = await makeFixture(t);
  const ancillaryPath = "tools/datapack/sources/ancillary-evidence.json";
  const patchPath = await buildPromotionPatch(dir, { ancillaryPath });
  const build = makeBuildStub(dir);

  await assert.rejects(
    applyTimetableRefresh({ patchPath, repoRoot: dir, runSnapshotBuild: build.run }),
    /patch output inventory|unexpected patch path/i,
  );
  await assert.rejects(readFile(path.join(dir, ancillaryPath)), { code: "ENOENT" });
  assert.equal(build.calls.count, 0);
});

test("동일 receipt의 output drift는 재적용 없이 fail closed한다", async (t) => {
  const dir = await makeFixture(t);
  const patchPath = await buildPromotionPatch(dir);
  const build = makeBuildStub(dir);
  await applyTimetableRefresh({ patchPath, repoRoot: dir, runSnapshotBuild: build.run });
  await writeFile(path.join(dir, SEED_PATH), "foreign-drift\n");

  await assert.rejects(
    applyTimetableRefresh({ patchPath, repoRoot: dir, runSnapshotBuild: build.run }),
    /receipt output drift/i,
  );
  assert.equal(await readFile(path.join(dir, SEED_PATH), "utf8"), "foreign-drift\n");
  assert.equal(build.calls.count, 1);
});

test("동일 patch의 receipt output inventory 축소는 자기 해시를 다시 계산해도 거부한다", async (t) => {
  const dir = await makeFixture(t);
  const patchPath = await buildPromotionPatch(dir);
  const build = makeBuildStub(dir);
  await applyTimetableRefresh({ patchPath, repoRoot: dir, runSnapshotBuild: build.run });

  const receiptPath = path.join(dir, RECEIPT_PATH);
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  receipt.outputs = receipt.outputs.slice(1);
  const unsigned = { ...receipt };
  delete unsigned.transactionSha256;
  receipt.transactionSha256 = sha256(Buffer.from(canonicalJson(unsigned), "utf8"));
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);

  await assert.rejects(
    applyTimetableRefresh({ patchPath, repoRoot: dir, runSnapshotBuild: build.run }),
    /receipt output inventory/i,
  );
  assert.equal(build.calls.count, 1, "invalid receipt 재실행에서 재산출하지 않아야 한다");
});

test("completeness identity 또는 receipt publish 실패는 전체 mutation boundary를 복원한다", async (t) => {
  const dir = await makeFixture(t);
  const patchPath = await buildPromotionPatch(dir);
  const build = makeBuildStub(dir);
  const tamperedBuild = async () => {
    await build.run();
    await writeFile(path.join(dir, completenessPathFor(SOURCE_B)), "tampered\n");
  };

  await assert.rejects(
    applyTimetableRefresh({ patchPath, repoRoot: dir, runSnapshotBuild: tamperedBuild }),
    /completeness evidence raw identity mismatch/i,
  );
  assert.equal(
    JSON.parse(await readFile(path.join(dir, CONTRACT_PATH), "utf8"))
      .sourceTimetableArtifact.artifactId,
    SOURCE_A,
  );
  await assert.rejects(readFile(path.join(dir, RECEIPT_PATH)), { code: "ENOENT" });

  await assert.rejects(
    applyTimetableRefresh({
      patchPath,
      repoRoot: dir,
      runSnapshotBuild: build.run,
      writeReceipt: async () => {
        throw new Error("receipt publish boom");
      },
    }),
    /receipt publish boom/,
  );
  assert.equal(
    JSON.parse(await readFile(path.join(dir, CONTRACT_PATH), "utf8"))
      .sourceTimetableArtifact.artifactId,
    SOURCE_A,
  );
  await assert.rejects(readFile(path.join(dir, RECEIPT_PATH)), { code: "ENOENT" });
});

test("--patch 경로 미지정 시 명시적으로 실패한다", async (t) => {
  const dir = await makeFixture(t);
  await assert.rejects(
    applyTimetableRefresh({ repoRoot: dir, runSnapshotBuild: async () => {} }),
    /patch/i,
  );
});
