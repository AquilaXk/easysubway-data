// #979: 다음 ITX 수집이 승격되면 파생 결속(증거·alignment fixture·mobile fixture 파생)까지 사람 손 없이 이어지는지 종단으로 본다.
// 실제 공급자 호출·dispatch 없이, 커밋된 HEAD의 격리 worktree에 합성 수집을 승격한 뒤 재결속 도구와 CI의 fixture 파생 경로를 그대로 돌린다.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { gunzipSync } from "node:zlib";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
const PIN_FILES = [SPEC, "tools/datapack/release/nationwide-candidate-input-manifest.json", "tools/datapack/release/nationwide-candidate-preparation.json"];

function git(args, cwd = root) {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
}

// mobile fixture(.external/mobile)는 required-pr mobile-v19 job이 고정 커밋으로 checkout한다. 없으면 건너뛰지 않고 실패한다.
const inputFixtureRoot = path.join(root, ".external/mobile/apps/mobile");

function stageInputFixture(destination) {
  mkdirSync(path.join(destination, "assets/datapacks"), { recursive: true });
  for (const name of ["capital.sqlite.gz", "index.json"]) cpSync(path.join(inputFixtureRoot, "assets/datapacks", name), path.join(destination, "assets/datapacks", name));
}

// 시나리오: 수집 시각이 직전 수집의 7일 뒤인 경우(기본), 운행일은 7일 뒤지만 수집 시각이 다른 원천의 신선도 시계와 같은 날인 경우(build 시계가
// 원천들의 수집 시각 최댓값에 묶인 테스트까지 함께 돌려 보는 전체 시뮬레이션이 쓴다), 그리고 운행역이 바뀐 경우 둘(#980 F3).
// 운행역이 바뀐 수집은 자동 게이트가 막으므로 사람 승인 경로(OWNER_APPROVED)로 승격하고, 같은 재결속 도구가 그 승격도 처리해야 한다.
// "현재 원천들과 같은 날" 시각은 리터럴 날짜로 고정하지 않고 현재 ITX 증거의 수집 시각에서 상대값으로 구한다.
// 리터럴이면 승격이 ITX 증거를 새로 수집할 때마다 운행일이 밀려 "오늘~13일" 승격 창을 벗어난다(#1108, #1124).
// 현재 수집 시각 1시간 뒤는 같은 KST 날(자정 직전이면 다음 날) 안에 있고, 운행일(수집 시각 이후 최대 6일)을 7일 옮겨도 창 안에 남는다.
const currentItxObservedAt = Date.parse(json(path.join(root, json(path.join(root, CONTRACT)).sourceTimetableArtifact.completenessEvidencePath)).observedAt);
assert.ok(Number.isFinite(currentItxObservedAt), "현재 ITX 완결성 증거의 observedAt을 읽지 못했다(파일·형식 확인 필요)");
// 기준은 현재 ITX 증거의 수집 시각이다. ITX는 하루 1회 수집되는 가장 짧은 주기 원천이라 대개 현재 원천들 중 가장 최신이고,
// 그때 "현재 원천들과 같은 날"과 같은 뜻이 된다. 다른 원천이 더 최신이어도 사례가 확인하는 승격 창 판정은 ITX 수집 시각 기준이다.
const SAME_DAY_AS_CURRENT_SOURCES_MS = 60 * 60 * 1000;
const SCENARIOS = [
  { label: "수집 시각이 직전 수집 7일 뒤", synthesisOptions: {} },
  { label: "수집 시각이 현재 원천들과 같은 날", synthesisOptions: { observedAtOverride: currentItxObservedAt + SAME_DAY_AS_CURRENT_SOURCES_MS } },
  { label: "운행역 하나가 빠진 수집(사람 승인 승격)", synthesisOptions: { topologyChange: "remove-served-station" } },
  { label: "운행역 하나가 늘어난 수집(사람 승인 승격)", synthesisOptions: { topologyChange: "add-served-station" } },
];
for (const scenario of SCENARIOS) {
  test(`승격 뒤 재결속은 사람 손 없이 CI가 확인하는 파생 결속 전부를 맞춘다 (${scenario.label})`, { timeout: 20 * 60_000 }, (context) => rebindScenario(context, scenario.synthesisOptions));
}

// 원천 stationSequences·stationRosters에서 증거 도구와 다른 방식(단순 집합 계산)으로 센 topology 개수.
function independentTopologyCounts(source) {
  const rosterKeys = new Set(source.stationRosters.flatMap((roster) => roster.stations.map((station) => `${station.canonicalStationId}:${station.lineId}`)));
  const servedKeys = new Set();
  const directedEdges = new Set();
  for (const sequence of source.stationSequences) {
    sequence.stops.forEach((stop, index) => {
      servedKeys.add(`${stop.stationId}:${stop.lineId}`);
      if (index > 0) directedEdges.add(`${sequence.stops[index - 1].stationId}>${stop.stationId}`);
    });
  }
  return { stationMembershipCount: rosterKeys.size, servedStationCount: servedKeys.size, edgeCount: directedEdges.size };
}

function itxEdgesTouching(packBytes, stationId) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "itx-pack-"));
  try {
    const sqlitePath = path.join(directory, "capital.sqlite");
    writeFileSync(sqlitePath, gunzipSync(packBytes));
    const database = new DatabaseSync(sqlitePath, { readOnly: true });
    try {
      return database.prepare("SELECT COUNT(*) AS count FROM network_edges WHERE service_class = 'ITX_CHEONGCHUN' AND (from_node_id LIKE ? OR to_node_id LIKE ?)")
        .get(`${stationId}:%`, `${stationId}:%`).count;
    } finally {
      database.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

async function rebindScenario(context, synthesisOptions) {
  assert.ok(existsSync(path.join(inputFixtureRoot, "assets/datapacks/capital.sqlite.gz")), "pinned Mobile 입력 fixture가 필요함");
  const scratch = realpathSync(mkdtempSync(path.join(os.tmpdir(), "itx-rebind-")));
  const worktree = path.join(scratch, "repo");
  git(["worktree", "add", "--detach", worktree, "HEAD"]);
  context.after(() => {
    try { git(["worktree", "remove", "--force", worktree]); } catch { /* 이미 정리됨 */ }
    rmSync(scratch, { recursive: true, force: true });
  });

  // 1. 다음 주 수집을 합성해 승격한다(실제 게이트·승격 경로).
  const collection = await synthesizeNextItxCollection({ repositoryRoot: worktree, outputDirectory: path.join(scratch, "collection"), ...synthesisOptions });
  const beforeContract = json(path.join(worktree, CONTRACT));
  const before = beforeContract.sourceTimetableArtifact;
  const beforeCounts = independentTopologyCounts(json(path.join(worktree, before.artifactPath)));
  const common = {
    candidatePath: collection.candidatePath,
    completenessPath: collection.completenessPath,
    sourceOutputDir: path.join(worktree, "tools/datapack/sources"),
    coverageContractPath: path.join(worktree, CONTRACT),
    stationCatalogPackPath: collection.stationCatalogPackPath,
    repositoryRoot: worktree,
    now: collection.now,
  };
  const gate = { capturePath: collection.capturePath, replayEvidencePath: collection.replayEvidencePath };
  const topologyChanged = collection.topologyChangeSummary !== null;
  let promoted;
  if (topologyChanged) {
    // 운행역이 바뀐 수집은 자동 게이트가 막는다. 아무것도 쓰지 않는다.
    await assert.rejects(promoteItxSourceCandidate({ ...common, gate }), /ITX_PROMOTION_GATE_BLOCKED/u);
    assert.equal(git(["status", "--porcelain"], worktree), "");
    const candidateSha256 = sha256(readFileSync(collection.candidatePath));
    const approvalUrl = "https://github.com/AquilaXk/easysubway-data/issues/636#issuecomment-1";
    const approval = {
      author_association: "OWNER", user: { login: "AquilaXk" }, html_url: approvalUrl,
      body: `/approve-itx-current artifactId=${collection.artifactId} sha256=${candidateSha256} policy=itx-snapshot-anomaly-v1`,
      created_at: new Date(collection.now.getTime() + 1000).toISOString(),
    };
    promoted = await promoteItxSourceCandidate({
      ...common, approvedSha256: candidateSha256, approvalUrl, githubToken: "synthetic",
      fetchImpl: async () => new Response(JSON.stringify(approval), { status: 200, headers: { "content-type": "application/json" } }),
    });
  } else {
    promoted = await promoteItxSourceCandidate({ ...common, gate });
  }
  const reference = promoted.sourceTimetableArtifact;
  assert.notEqual(reference.sha256, before.sha256, "승격이 새 원천으로 바뀌어야 함");
  assert.equal(reference.promotion.mode, topologyChanged ? "CURRENT_CANDIDATE_OWNER_APPROVED" : "CURRENT_CANDIDATE_GATE_PASSED");
  const promotedPaths = git(["status", "--porcelain", "-uall"], worktree).split("\n").filter(Boolean).map((line) => line.slice(3)).sort();
  // 게이트 승격은 영수증까지 4개, 사람 승인 승격은 영수증 없이 3개다.
  assert.equal(promotedPaths.length, topologyChanged ? 3 : 4, `승격은 원천 경로만 바꾼다: ${promotedPaths}`);

  // 승격만으로는 파생 결속이 어긋나 있다(재결속이 필요한 이유).
  assert.notEqual(json(path.join(worktree, EVIDENCE)).sourceArtifact.sha256, reference.sha256);

  // 2. 재결속(승격 workflow가 같은 job에서 돌리는 도구)
  const buildNow = new Date(collection.now.getTime() + 30 * 60_000).toISOString();
  // CI staging과 같다: 고정 입력 fixture를 저장소 안 apps/mobile로 복사한다.
  const stagedFixture = path.join(worktree, "apps/mobile");
  stageInputFixture(stagedFixture);
  const changed = await rebindItxPromotion({ repositoryRoot: worktree, buildNow });
  const versionedEvidence = `tools/datapack/itx-cheongchun-topology-evidence-${reference.artifactId.replace("itx-cheongchun-source-timetable-", "")}.json`;
  assert.ok(changed.includes(EVIDENCE) && changed.includes(versionedEvidence), changed.join("\n"));
  const allowed = new Set([EVIDENCE, versionedEvidence, ...ALIGNMENT_FIXTURES]);
  for (const file of changed) assert.ok(allowed.has(file), `예상 밖 변경: ${file}`);

  // 3. 결속 검증: 증거·버전 증거·alignment fixture가 새 원천과 새 팩에 맞는다.
  const evidence = json(path.join(worktree, EVIDENCE));
  assert.equal(evidence.sourceArtifact.sha256, reference.sha256);
  assert.equal(evidence.pack.inputSha256, json(path.join(worktree, CONTRACT)).officialEvidence.korailCompletenessAdmission.topologyInputPackIdentity.sha256);
  assert.equal(readFileSync(path.join(worktree, versionedEvidence), "utf8"), readFileSync(path.join(worktree, EVIDENCE), "utf8"));
  // 후보 pin은 승격 PR이 건드리지 않는다(게시된 입력을 가리키고, 병합 뒤 전국 후보 준비가 다시 묶는다).
  for (const file of PIN_FILES) assert.equal(git(["status", "--porcelain", "--", file], worktree), "", file);
  assert.doesNotThrow(() => verifyCurrentItxPromotion({ reference, repositoryRoot: worktree }));
  const outputPack = readFileSync(path.join(stagedFixture, "assets/datapacks/capital.sqlite.gz"));
  assert.equal(sha256(outputPack), evidence.pack.outputSha256);
  // gzip 헤더의 OS 바이트는 플랫폼(macOS 19, Linux 3)이 아니라 고정값이다. 그래야 Linux CI가 파생한 팩이 개발 환경에서 만든 증거와 같다.
  assert.equal(outputPack[9], 19);
  for (const relative of ALIGNMENT_FIXTURES) assert.equal(json(path.join(worktree, relative)).generatedFrom.packSha256, evidence.pack.outputSha256, relative);

  // 3-1. topology 변경이 실제로 반영된다: 증거의 개수는 승격된 원천에서 독립 계산한 값과 같고, 바뀐 정차역은 파생 팩의 ITX 간선에 따라간다.
  const afterCounts = independentTopologyCounts(json(path.join(worktree, reference.artifactPath)));
  assert.deepEqual({
    stationMembershipCount: evidence.topology.stationMembershipCount,
    servedStationCount: evidence.topology.servedStationCount,
    edgeCount: evidence.topology.edgeCount,
  }, afterCounts);
  if (topologyChanged) {
    const { change, stationId } = collection.topologyChangeSummary;
    const beforeEdgesTouching = itxEdgesTouching(readFileSync(path.join(inputFixtureRoot, "assets/datapacks/capital.sqlite.gz")), stationId);
    const afterEdgesTouching = itxEdgesTouching(outputPack, stationId);
    if (change === "remove-served-station") {
      assert.equal(afterCounts.servedStationCount, beforeCounts.servedStationCount - 1);
      assert.ok(beforeEdgesTouching > 0 && afterEdgesTouching === 0, `removed station edges ${beforeEdgesTouching} -> ${afterEdgesTouching}`);
    } else {
      assert.equal(afterCounts.servedStationCount, beforeCounts.servedStationCount + 1);
      assert.ok(beforeEdgesTouching === 0 && afterEdgesTouching > 0, `added station edges ${beforeEdgesTouching} -> ${afterEdgesTouching}`);
    }
    assert.notEqual(afterCounts.edgeCount, beforeCounts.edgeCount);
  } else {
    assert.deepEqual(afterCounts, beforeCounts);
  }

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
}
