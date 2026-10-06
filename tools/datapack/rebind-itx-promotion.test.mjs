// #979: 다음 ITX 수집이 승격되면 파생 결속(증거·spec·alignment fixture·mobile fixture 파생)까지 사람 손 없이 이어지는지 종단으로 본다.
// 실제 공급자 호출·dispatch 없이, 커밋된 HEAD의 격리 worktree에 합성 수집을 승격한 뒤 재결속 도구와 CI의 fixture 파생 경로를 그대로 돌린다.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { promoteItxSourceCandidate } from "./collect-korail-itx-cheongchun-timetable.mjs";
import { ALIGNMENT_FIXTURES, rebindItxPromotion } from "./rebind-itx-promotion.mjs";
import { verifyCurrentItxPromotion } from "./lib/itx-promotion-authority.mjs";
import { synthesizeNextItxCollection } from "./test-fixtures/itx-synthetic-collection.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const json = (file) => JSON.parse(readFileSync(file, "utf8"));
const CONTRACT = "tools/datapack/itx-cheongchun-coverage-contract.json";
const EVIDENCE = "tools/datapack/itx-cheongchun-topology-evidence.json";
const SPEC = "tools/datapack/release/candidate-build-spec.json";

function git(args, cwd = root) {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
}

// mobile fixture(.external/mobile)는 required-pr mobile-v19 job이 고정 커밋으로 checkout한다. 없으면 건너뛰지 않고 실패한다.
const inputFixtureRoot = path.join(root, ".external/mobile/apps/mobile");

function stageInputFixture(destination) {
  mkdirSync(path.join(destination, "assets/datapacks"), { recursive: true });
  for (const name of ["capital.sqlite.gz", "index.json"]) cpSync(path.join(inputFixtureRoot, "assets/datapacks", name), path.join(destination, "assets/datapacks", name));
}

test("승격 뒤 재결속은 사람 손 없이 CI가 확인하는 파생 결속 전부를 맞춘다", { timeout: 20 * 60_000 }, async (context) => {
  assert.ok(existsSync(path.join(inputFixtureRoot, "assets/datapacks/capital.sqlite.gz")), "pinned Mobile 입력 fixture가 필요함");
  const scratch = realpathSync(mkdtempSync(path.join(os.tmpdir(), "itx-rebind-")));
  const worktree = path.join(scratch, "repo");
  git(["worktree", "add", "--detach", worktree, "HEAD"]);
  context.after(() => {
    try { git(["worktree", "remove", "--force", worktree]); } catch { /* 이미 정리됨 */ }
    rmSync(scratch, { recursive: true, force: true });
  });

  // 1. 다음 주 수집을 합성해 승격한다(실제 게이트·승격 경로).
  const collection = await synthesizeNextItxCollection({ repositoryRoot: worktree, outputDirectory: path.join(scratch, "collection") });
  const before = json(path.join(worktree, CONTRACT)).sourceTimetableArtifact;
  const promoted = await promoteItxSourceCandidate({
    candidatePath: collection.candidatePath,
    completenessPath: collection.completenessPath,
    gate: { capturePath: collection.capturePath, replayEvidencePath: collection.replayEvidencePath },
    sourceOutputDir: path.join(worktree, "tools/datapack/sources"),
    coverageContractPath: path.join(worktree, CONTRACT),
    stationCatalogPackPath: collection.stationCatalogPackPath,
    repositoryRoot: worktree,
    now: collection.now,
  });
  const reference = promoted.sourceTimetableArtifact;
  assert.notEqual(reference.sha256, before.sha256, "승격이 새 원천으로 바뀌어야 함");
  assert.equal(reference.promotion.mode, "CURRENT_CANDIDATE_GATE_PASSED");
  const promotedPaths = git(["status", "--porcelain", "-uall"], worktree).split("\n").filter(Boolean).map((line) => line.slice(3)).sort();
  assert.equal(promotedPaths.length, 4, `승격 PR은 4개 경로만 바꾼다: ${promotedPaths}`);

  // 승격만으로는 파생 결속이 어긋나 있다(재결속이 필요한 이유).
  assert.notEqual(json(path.join(worktree, EVIDENCE)).sourceArtifact.sha256, reference.sha256);

  // 2. 재결속(승격 workflow가 같은 job에서 돌리는 도구)
  const buildNow = new Date(collection.now.getTime() + 30 * 60_000).toISOString();
  // CI staging과 같다: 고정 입력 fixture를 저장소 안 apps/mobile로 복사한다.
  const stagedFixture = path.join(worktree, "apps/mobile");
  stageInputFixture(stagedFixture);
  const changed = await rebindItxPromotion({ repositoryRoot: worktree, buildNow });
  const versionedEvidence = `tools/datapack/itx-cheongchun-topology-evidence-${reference.artifactId.replace("itx-cheongchun-source-timetable-", "")}.json`;
  assert.ok(changed.includes(EVIDENCE) && changed.includes(SPEC) && changed.includes(versionedEvidence), changed.join("\n"));
  const allowed = new Set([EVIDENCE, SPEC, versionedEvidence, ...ALIGNMENT_FIXTURES]);
  for (const file of changed) assert.ok(allowed.has(file), `예상 밖 변경: ${file}`);

  // 3. 결속 검증: 증거·버전 증거·spec pin·alignment fixture가 새 원천과 새 팩에 맞는다.
  const evidence = json(path.join(worktree, EVIDENCE));
  assert.equal(evidence.sourceArtifact.sha256, reference.sha256);
  assert.equal(evidence.pack.inputSha256, json(path.join(worktree, CONTRACT)).officialEvidence.korailCompletenessAdmission.topologyInputPackIdentity.sha256);
  assert.equal(readFileSync(path.join(worktree, versionedEvidence), "utf8"), readFileSync(path.join(worktree, EVIDENCE), "utf8"));
  const spec = json(path.join(worktree, SPEC));
  assert.equal(spec.itxTopologyEvidencePath, versionedEvidence);
  assert.equal(spec.itxTopologyEvidenceSha256, sha256(readFileSync(path.join(worktree, EVIDENCE))));
  assert.equal(spec.networkEdgeEvidence.itxCoverageContract.sha256, sha256(readFileSync(path.join(worktree, CONTRACT))));
  assert.doesNotThrow(() => verifyCurrentItxPromotion({ reference, repositoryRoot: worktree }));
  const outputPack = readFileSync(path.join(stagedFixture, "assets/datapacks/capital.sqlite.gz"));
  assert.equal(sha256(outputPack), evidence.pack.outputSha256);
  for (const relative of ALIGNMENT_FIXTURES) assert.equal(json(path.join(worktree, relative)).generatedFrom.packSha256, evidence.pack.outputSha256, relative);

  // 4. CI가 하는 일을 그대로 한다: 입력 fixture를 stage한 뒤 --derive-fixture로 같은 팩을 파생하고 증거와 대조한다.
  const staged = path.join(scratch, "ci-staged");
  stageInputFixture(staged);
  execFileSync(process.execPath, [path.join(worktree, "tools/datapack/apply-itx-topology-to-bundled-pack.mjs"), "--derive-fixture", staged], { cwd: worktree, encoding: "utf8" });
  assert.equal(sha256(readFileSync(path.join(staged, "assets/datapacks/capital.sqlite.gz"))), evidence.pack.outputSha256);
  assert.deepEqual(readFileSync(path.join(staged, "assets/datapacks/index.json")), readFileSync(path.join(stagedFixture, "assets/datapacks/index.json")));

  // 5. 재결속하지 않은 승격은 파생이 거부한다(결속이 실제로 검사된다).
  const stale = path.join(scratch, "stale-staged");
  stageInputFixture(stale);
  git(["restore", "--source=HEAD", "--", EVIDENCE], worktree);
  let rejection = "";
  try {
    execFileSync(process.execPath, [path.join(worktree, "tools/datapack/apply-itx-topology-to-bundled-pack.mjs"), "--derive-fixture", stale], { cwd: worktree, stdio: "pipe", encoding: "utf8" });
  } catch (error) {
    rejection = String(error.stderr);
  }
  assert.match(rejection, /ITX_FIXTURE_DERIVATION_MISMATCH/u);
});
