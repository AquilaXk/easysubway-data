import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  AUTOMATION_PR_EVIDENCE_MARKER,
  AUTOMATION_PR_STAGES,
  automationPrEvidenceBlock,
  parseAutomationPrEvidence,
  refreshEvidenceBlock,
  refreshPullRequestBody,
} from "./automation-pr-evidence.mjs";
import { main as policyMain } from "./automation-pr-policy.mjs";
import { buildRefreshPullRequest, main } from "./refresh-automation-pr.mjs";
import { REFRESH_CLAIM_PREFIXES } from "./refresh-open-pr-age.mjs";
import { REFRESH_STAGES, evaluateRefreshStage } from "./refresh-stage-contracts.mjs";
import { INVENTORY_PATH, LEDGER_PATH, POLICY, RECORDED, filenames, recordedTrees, runsOf } from "../datapack/test-fixtures/refresh-recorded-runs.mjs";

// #1012: 정기 갱신 4종의 증거 블록·PR 본문·emitter. 증거는 기록된 실제 갱신 PR의 base·head에서 만든다.
const RUN_URL = "https://github.com/AquilaXk/easysubway-data/actions/runs/123";
const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const STAGES = ["gwangju-timetable-refresh", "capital-topology-refresh", "kric-facility-refresh", "seoul-accessibility-refresh"];
const block = (value) => `<!-- ${AUTOMATION_PR_EVIDENCE_MARKER} ${JSON.stringify(value)} -->`;

async function evidenceOf(run) {
  const trees = recordedTrees(run);
  const files = {
    readTree: async (relative) => trees.head.get(relative),
    readBase: async (_sha, relative) => trees.base.get(relative),
  };
  const { rows, violations } = await evaluateRefreshStage({ stage: run.stage, paths: filenames(run), baseSha: run.baseSha, policy: POLICY, files });
  assert.deepEqual(violations, [], run.label);
  return { stage: run.stage, runUrl: RUN_URL, baseSha: BASE, headSha: HEAD, policy: POLICY, sources: rows, paths: filenames(run) };
}

const stored = async (run) => JSON.parse(refreshEvidenceBlock(await evidenceOf(run)).slice(`<!-- ${AUTOMATION_PR_EVIDENCE_MARKER} `.length, -" -->".length));

test("단계는 기존 다섯에 갱신 4종이 뒤에 더해진다(기존 단계의 순서·이름은 그대로)", () => {
  assert.deepEqual([...AUTOMATION_PR_STAGES], ["registration", "candidate-refresh", "derivative-rebinding", "itx-promotion", "source-reverification", ...STAGES]);
});

test("갱신 단계 증거 블록은 원천별 sha·snapshot·delta와 정책, base/head, 정확한 경로 allowlist를 남기고 그대로 읽힌다", async () => {
  for (const run of RECORDED) {
    const input = await evidenceOf(run);
    const text = refreshEvidenceBlock(input);
    assert.doesNotMatch(text, /\n/u);
    const parsed = parseAutomationPrEvidence(`본문\n${text}\n`, { headSha: HEAD });
    assert.equal(parsed.stage, run.stage, run.label);
    assert.deepEqual(parsed.policy, POLICY, run.label);
    assert.deepEqual(parsed.sources, input.sources, run.label);
    assert.deepEqual(parsed.steps, [{ id: REFRESH_STAGES[run.stage].stepId, changed: true, paths: filenames(run) }], run.label);
    assert.equal(parsed.candidate, null, run.label);
    assert.equal(parsed.baseSha, BASE);
    assert.equal(parsed.headSha, HEAD);
    // 일반 생성기로 만든 블록과 같다: 블록 생성 경로는 하나다.
    assert.equal(text, automationPrEvidenceBlock({ stage: run.stage, runUrl: RUN_URL, baseSha: BASE, headSha: HEAD, policy: POLICY, sources: input.sources, steps: [{ id: run.stage, changed: true, paths: filenames(run) }], candidate: null }));
  }
});

test("반증: 갱신 단계 증거에 허용 밖 경로·빠진 경로·정렬되지 않은 경로·잘못된 step이 있으면 파싱 오류", async () => {
  for (const run of RECORDED) {
    const good = await stored(run);
    const paths = filenames(run);
    const mutations = {
      "extra path": { steps: [{ ...good.steps[0], paths: [...paths, ".github/workflows/ci.yml"].sort() }] },
      "governance path": { steps: [{ ...good.steps[0], paths: [...paths, "tools/datapack/source-governance-policy.json"].sort() }] },
      "sla path": { steps: [{ ...good.steps[0], paths: [...paths, "release/product-gates/datapack-freshness-sla.json"].sort() }] },
      "missing path": { steps: [{ ...good.steps[0], paths: paths.slice(1) }] },
      "unsorted paths": { steps: [{ ...good.steps[0], paths: [...paths].reverse() }] },
      "duplicate path": { steps: [{ ...good.steps[0], paths: [paths[0], ...paths] }] },
      "wrong step id": { steps: [{ ...good.steps[0], id: "registration" }] },
      "step not changed": { steps: [{ id: good.steps[0].id, changed: false, paths: [] }] },
      "two steps": { steps: [good.steps[0], { id: good.steps[0].id, changed: true, paths: paths.slice(0, 1) }] },
      "no steps": { steps: [] },
      "no policy": { policy: null },
      "candidate present": { candidate: { candidateId: "x", releaseSequence: 1, sourceSnapshotSetHash: "a".repeat(64), paths: ["tools/datapack/release/candidate-build-spec.json"] } },
      "no sources": { sources: [] },
      "unexpected source": { sources: [...good.sources, { ...good.sources[0], sourceId: "extra-source" }] },
      "wrong source": { sources: [{ ...good.sources[0], sourceId: "capital-pilot-source" }, ...good.sources.slice(1)] },
      "duplicate source": { sources: [good.sources[0], good.sources[0], ...good.sources.slice(1)] },
    };
    for (const [label, change] of Object.entries(mutations)) {
      assert.throws(() => parseAutomationPrEvidence(block({ ...good, ...change })), /AUTOMATION_PR_EVIDENCE_INVALID/u, `${run.label} ${label}`);
    }
  }
  // 다른 단계의 경로 집합은 이 단계의 증거가 될 수 없다.
  const seoul = await stored(runsOf("seoul-accessibility-refresh")[0]);
  const kric = await stored(runsOf("kric-facility-refresh")[0]);
  assert.throws(() => parseAutomationPrEvidence(block({ ...seoul, steps: kric.steps })), /AUTOMATION_PR_EVIDENCE_INVALID/u);
});

test("갱신 단계 블록 생성기도 같은 검증을 한다(허용 밖 경로나 모르는 단계는 만들지 않는다)", async () => {
  const input = await evidenceOf(runsOf("kric-facility-refresh")[0]);
  assert.throws(() => refreshEvidenceBlock({ ...input, paths: [...input.paths, "tools/ci/automation-pr-policy.mjs"].sort() }), /AUTOMATION_PR_EVIDENCE_INVALID/u);
  assert.throws(() => refreshEvidenceBlock({ ...input, stage: "registration" }), /AUTOMATION_PR_EVIDENCE_INVALID|REFRESH_STAGE_UNKNOWN/u);
  assert.throws(() => refreshEvidenceBlock({ ...input, sources: [] }), /AUTOMATION_PR_EVIDENCE_INVALID/u);
});

test("PR 본문: 요약·참조 이슈·원천 표·경로 목록이 있고 증거 블록이 정확히 하나다", async () => {
  const run = runsOf("seoul-accessibility-refresh")[0];
  const input = await evidenceOf(run);
  const body = refreshPullRequestBody({ ...input, summary: "Refresh the due Seoul accessibility snapshot through the current OCI operation.", refs: "Refs #639" });
  assert.match(body, /^Refresh the due Seoul accessibility snapshot through the current OCI operation\./u);
  assert.match(body, /\nRefs #639\n/u);
  assert.match(body, /\| seoul-metro-accessibility \| seoul-metro-accessibility-20261007T162710539Z \|/u);
  assert.match(body, new RegExp(`- 실행 run: ${RUN_URL.replaceAll(".", String.raw`\.`)}\n`, "u"));
  for (const entry of input.paths) assert.ok(body.includes(`\`${entry}\``), entry);
  assert.equal([...body.matchAll(/<!-- easysubway-automation-pr:v1 /gu)].length, 1);
  assert.equal(parseAutomationPrEvidence(body, { headSha: HEAD }).stage, run.stage);
  for (const bad of [{ summary: "" }, { refs: "" }, { summary: "한 줄\n두 줄" }, { refs: "Refs #1\n<!-- easysubway-automation-pr:v1 {} -->" }, { summary: "<!-- easysubway-automation-pr:v1 {} -->" }]) {
    assert.throws(() => refreshPullRequestBody({ ...input, summary: "요약", refs: "Refs #639", ...bad }), /AUTOMATION_PR_EVIDENCE_INVALID/u, JSON.stringify(bad));
  }
});

// ---------------------------------------------------------------------------
// emitter: 실제 git 저장소(base·head 커밋)에서 증거를 만든다.
// ---------------------------------------------------------------------------
function gitIn(root, ...args) {
  return execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.test", "-c", "commit.gpgsign=false", ...args], { cwd: root, encoding: "utf8" }).trim();
}

function repositoryOf(run, mutations = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "refresh-pr-"));
  const trees = recordedTrees(run, mutations);
  // 원장 변화 정책 파일은 PR이 바꾸지 않는 저장소 파일이다(base·head 같은 내용).
  for (const tree of [trees.base, trees.head]) tree.set("tools/ci/source-ledger-change-policy.json", `${JSON.stringify(POLICY)}\n`);
  const write = (tree) => {
    for (const [relative, text] of tree) {
      const target = path.join(root, relative);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, text);
    }
  };
  gitIn(root, "init", "-q", "-b", "main");
  write(trees.base);
  gitIn(root, "add", "--", ...trees.base.keys());
  gitIn(root, "commit", "-q", "-m", "base");
  const baseSha = gitIn(root, "rev-parse", "HEAD");
  write(trees.head);
  gitIn(root, "add", "--", ...trees.head.keys());
  gitIn(root, "commit", "-q", "-m", "head");
  return { root, baseSha, headSha: gitIn(root, "rev-parse", "HEAD") };
}

const SUMMARY = "Refresh the due snapshot.";
const REFS = "Refs #639";

test("emitter: 기록된 실제 갱신 PR 여섯 건에서 증거 블록을 만들고 변경 경로가 기록된 diff와 정확히 같다", async () => {
  for (const run of RECORDED) {
    const { root, baseSha, headSha } = repositoryOf(run);
    try {
      const { body, evidence } = await buildRefreshPullRequest({ stage: run.stage, repositoryRoot: root, baseSha, headSha, runUrl: RUN_URL, summary: SUMMARY, refs: REFS });
      const parsed = parseAutomationPrEvidence(body, { headSha });
      assert.equal(parsed.baseSha, baseSha, run.label);
      assert.deepEqual(parsed.steps[0].paths, filenames(run), `${run.label}: 증거 경로 == 기록된 변경 경로`);
      assert.deepEqual(parsed, evidence, run.label);
      const trees = recordedTrees(run);
      const expected = await evaluateRefreshStage({
        stage: run.stage, paths: filenames(run), baseSha, policy: POLICY,
        files: { readTree: async (relative) => trees.head.get(relative), readBase: async (_sha, relative) => trees.base.get(relative) },
      });
      assert.deepEqual(parsed.sources, expected.rows, run.label);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("emitter 반증: 허용 밖 변경·소유하지 않은 항목·원장 변조는 PR 본문을 만들지 않고 위반 코드로 실패한다", async () => {
  const cases = [
    ["kric-facility-refresh", { mutateInventory: (inventory) => { inventory.sources.find(({ id }) => id === "kric-station-convenience-standard").productionUseAllowed = false; } }, /INVENTORY_GATE/u],
    ["seoul-accessibility-refresh", { mutateInventory: (inventory) => { inventory.sources[0].datasetUrl = "https://evil.test"; } }, /INVENTORY_GATE/u],
    ["gwangju-timetable-refresh", { mutateLedger: (rows) => { rows[0].rawSha256 = "0".repeat(64); } }, /LEDGER_GATE/u],
    ["capital-topology-refresh", { mutateFiles: (head) => { head.set(LEDGER_PATH, "[]"); } }, /허용 밖 경로/u],
    ["kric-facility-refresh", { mutateFiles: (head) => { head.set(".github/workflows/ci.yml", "name: x\n"); } }, /허용 밖 경로/u],
    ["seoul-accessibility-refresh", { mutateFiles: (head) => { head.set("tools/datapack/source-governance-policy.json", "{}\n"); } }, /허용 밖 경로/u],
    // 리뷰 F5: 관측된 적 없는 경로는 사람 경로가 아니라 push 전 거부(본문 없음, workflow 실패)다.
    ["capital-topology-refresh", { mutateFiles: (head) => { head.set("tools/datapack/release/capital-production-reviewed-pack.json", "{}\n"); } }, /AUTOMATION_PR_PATHS: 허용 밖 경로: tools\/datapack\/release\/capital-production-reviewed-pack\.json/u],
    ["capital-topology-refresh", { mutateFiles: (head) => { head.set("tools/datapack/itx-current-network-edge-admission-20261007.json", "{}\n"); } }, /AUTOMATION_PR_PATHS: 허용 밖 경로: tools\/datapack\/itx-current-network-edge-admission-20261007\.json/u],
  ];
  for (const [stage, mutations, pattern] of cases) {
    const run = runsOf(stage)[0];
    const { root, baseSha, headSha } = repositoryOf(run, mutations);
    try {
      await assert.rejects(buildRefreshPullRequest({ stage, repositoryRoot: root, baseSha, headSha, runUrl: RUN_URL, summary: SUMMARY, refs: REFS }), pattern, `${stage} ${String(pattern)}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("emitter 반증: 파일 상태가 규칙과 다르면(새 파일을 고쳐 쓴 것처럼 보이는 경우 포함) 실패한다", async () => {
  const run = runsOf("kric-facility-refresh")[0];
  // base에도 같은 이름의 snapshot 파일이 있으면 added가 아니라 modified다.
  const { root, baseSha, headSha } = repositoryOf(run, { mutateFiles: (head, base) => { const [snapshot] = run.files.filter(({ status }) => status === "added"); base.set(snapshot.filename, "{}"); head.set(snapshot.filename, head.get(snapshot.filename)); } });
  try {
    await assert.rejects(buildRefreshPullRequest({ stage: run.stage, repositoryRoot: root, baseSha, headSha, runUrl: RUN_URL, summary: SUMMARY, refs: REFS }), /변경 종류/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("emitter 입력 검증: 알 수 없는 단계·잘못된 sha·잘못된 run URL은 거부한다", async () => {
  const run = runsOf("gwangju-timetable-refresh")[0];
  const { root, baseSha, headSha } = repositoryOf(run);
  try {
    const ok = { stage: run.stage, repositoryRoot: root, baseSha, headSha, runUrl: RUN_URL, summary: SUMMARY, refs: REFS };
    await assert.rejects(buildRefreshPullRequest({ ...ok, stage: "registration" }), /REFRESH_STAGE_UNKNOWN/u);
    await assert.rejects(buildRefreshPullRequest({ ...ok, baseSha: "abc" }), /REFRESH_PR_INPUT/u);
    await assert.rejects(buildRefreshPullRequest({ ...ok, headSha: "HEAD" }), /REFRESH_PR_INPUT/u);
    await assert.rejects(buildRefreshPullRequest({ ...ok, runUrl: "https://example.com/x" }), /AUTOMATION_PR_EVIDENCE_INVALID/u);
    await assert.rejects(buildRefreshPullRequest({ ...ok, baseSha: "0".repeat(40) }), /.+/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI body: 본문 파일을 새로 쓰고(덮어쓰지 않는다) 정확한 인자만 받는다", async () => {
  const run = runsOf("seoul-accessibility-refresh")[0];
  const { root, baseSha, headSha } = repositoryOf(run);
  const output = path.join(root, "pr-body.md");
  const args = ["body", "--stage", run.stage, "--repository-root", root, "--base-sha", baseSha, "--head-sha", headSha, "--run-url", RUN_URL, "--summary", SUMMARY, "--refs", REFS, "--output", output];
  try {
    await main(args);
    const body = readFileSync(output, "utf8");
    assert.equal(parseAutomationPrEvidence(body, { headSha }).stage, run.stage);
    assert.ok(body.startsWith(`${SUMMARY}\n`));
    await assert.rejects(main(args), /EEXIST/u, "기존 본문 파일을 덮어쓰지 않는다");
    await assert.rejects(main(["body", ...args.slice(1, -2)]), /REFRESH_PR_INPUT/u, "--output 없음");
    await assert.rejects(main([...args, "--extra", "x"]), /REFRESH_PR_INPUT/u, "모르는 인자");
    await assert.rejects(main(["publish", ...args.slice(1)]), /REFRESH_PR_INPUT/u, "모르는 명령");
    await assert.rejects(main([...args.slice(0, -2), "--output", path.join(root, "x.md"), "--stage", "registration"]), /REFRESH_PR_INPUT/u, "같은 인자 중복");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("emitter 입력의 head가 base 뒤의 커밋이 아니면(거꾸로·같음) 변경 경로가 없어 실패한다", async () => {
  const run = runsOf("gwangju-timetable-refresh")[0];
  const { root, baseSha, headSha } = repositoryOf(run);
  try {
    await assert.rejects(buildRefreshPullRequest({ stage: run.stage, repositoryRoot: root, baseSha: headSha, headSha, runUrl: RUN_URL, summary: SUMMARY, refs: REFS }), /변경 경로가 비어 있다/u);
    assert.ok(baseSha !== headSha);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("원장 경로·inventory 경로 상수는 helper와 계약이 같다", () => {
  assert.equal(LEDGER_PATH, "tools/datapack/release/source-snapshots.json");
  assert.equal(INVENTORY_PATH, "tools/datapack/source-inventory.json");
});

// CI의 Automation PR gates job은 prepare -> (base fetch) -> gates 순서로 같은 CLI를 부른다. 단계마다 따로 배선하지 않으므로 4종 모두 같은 경로로 재계산된다.
test("CI 게이트 명령(prepare·gates)이 emitter가 만든 증거를 4종 단계 모두에서 같은 계산으로 통과시키고, 트리가 증거와 어긋나면 막는다", async () => {
  for (const run of RECORDED) {
    const { root, baseSha, headSha } = repositoryOf(run);
    const branch = `${REFRESH_CLAIM_PREFIXES[REFRESH_STAGES[run.stage].workflow]}9100`;
    try {
      const { body, evidence } = await buildRefreshPullRequest({ stage: run.stage, repositoryRoot: root, baseSha, headSha, runUrl: RUN_URL, summary: SUMMARY, refs: REFS });
      const pullFile = path.join(root, "..", `pull-${path.basename(root)}.json`);
      const output = path.join(root, "..", `output-${path.basename(root)}.txt`);
      const digest = path.join(root, "..", `digest-${path.basename(root)}.json`);
      writeFileSync(pullFile, JSON.stringify({ head: { ref: branch, sha: headSha }, body }));
      await policyMain(["prepare", "--pull-request", pullFile, "--github-output", output], { log: () => {} });
      assert.equal(readFileSync(output, "utf8"), `applicable=true\nbase_sha=${baseSha}\n`, run.label);
      await policyMain(["gates", "--pull-request", pullFile, "--repository-root", root, "--digest-output", digest], { log: () => {} });
      assert.equal(JSON.parse(readFileSync(digest, "utf8")).stage, run.stage, run.label);
      for (const file of [pullFile, output, digest]) rmSync(file, { force: true });

      // 위조: 소유하지 않은 inventory 항목이 바뀐 head에 원래 증거(원천 행·경로)를 그대로 붙였다. 게이트가 트리에서 다시 계산해 막는다.
      const tampered = repositoryOf(run, { mutateInventory: (inventory) => { inventory.sources[0].datasetUrl = "https://evil.test/x"; } });
      try {
        const forged = `위조\n\n${refreshEvidenceBlock({ stage: run.stage, runUrl: RUN_URL, baseSha: tampered.baseSha, headSha: tampered.headSha, policy: evidence.policy, sources: evidence.sources, paths: evidence.steps[0].paths })}\n`;
        const forgedFile = path.join(tampered.root, "..", `forged-${path.basename(tampered.root)}.json`);
        writeFileSync(forgedFile, JSON.stringify({ head: { ref: branch, sha: tampered.headSha }, body: forged }));
        await assert.rejects(policyMain(["gates", "--pull-request", forgedFile, "--repository-root", tampered.root], { log: () => {} }), /AUTOMATION_PR_INVENTORY_GATE/u, run.label);
        rmSync(forgedFile, { force: true });
        // 작업 트리 head가 PR head와 다르면(체크아웃이 어긋남) 재계산하지 않고 막는다.
        const moved = path.join(tampered.root, "..", `moved-${path.basename(tampered.root)}.json`);
        writeFileSync(moved, JSON.stringify({ head: { ref: branch, sha: headSha }, body }));
        await assert.rejects(policyMain(["gates", "--pull-request", moved, "--repository-root", tampered.root], { log: () => {} }), /AUTOMATION_PR_EVIDENCE_HEAD_MISMATCH|AUTOMATION_PR_HEAD_MISMATCH/u, run.label);
        rmSync(moved, { force: true });
      } finally {
        rmSync(tampered.root, { recursive: true, force: true });
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});
