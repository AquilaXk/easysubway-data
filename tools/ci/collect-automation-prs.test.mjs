import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { PR_FIELDS, collectAutomationPullRequests, main } from "./collect-automation-prs.mjs";
import { ITX_PROMOTION_CLAIM_PREFIX, decideItxCurrentPromotion } from "./decide-itx-current-promotion.mjs";

// #993: 자동화 판정이 받는 PR 목록은 PR 이력 길이와 무관해야 한다. 열린 PR 전체(상한에 닿으면 실패)와
// 판정이 보는 claim 브랜치별 PR(전 상태)만 받는다. 닫힘·병합 PR 이력이 아무리 쌓여도 같은 결과여야 한다.
const REPOSITORY = "AquilaXk/easysubway-data";
const SHA = "b".repeat(40);
const CLAIM = "automation/984-source-reverification-";
const refs = (...branches) => branches.map((branch) => `${SHA}\trefs/heads/${branch}\n`).join("");
const pr = (number, state, headRefName) => ({
  number, state, isDraft: false, headRefName, baseRefName: "main", isCrossRepository: false, headRepository: { nameWithOwner: REPOSITORY },
});

/**
 * GitHub의 `gh pr list`를 흉내 낸다: 최신 PR이 먼저 오고 --limit 개수에서 잘린다. 호출 인자를 기록한다.
 * `all`은 전 상태, `open`은 열린 PR만, --head는 그 브랜치만 거른다.
 */
function fakeGitHub(pullRequests) {
  const calls = [];
  const newestFirst = [...pullRequests].sort((left, right) => right.number - left.number);
  const runGh = async (args) => {
    calls.push(args);
    const option = (name) => { const index = args.indexOf(name); return index === -1 ? undefined : args[index + 1]; };
    assert.deepEqual(args.slice(0, 2), ["pr", "list"]);
    assert.equal(option("--repo"), REPOSITORY);
    assert.equal(option("--json"), PR_FIELDS);
    const state = option("--state");
    const head = option("--head");
    const rows = newestFirst.filter((item) => (state === "all" || item.state === state.toUpperCase()) && (head === undefined || item.headRefName === head));
    return JSON.stringify(rows.slice(0, Number(option("--limit"))));
  };
  return { runGh, calls };
}

const collect = async (input) => (await collectAutomationPullRequests(input)).pullRequests;
const history = (count, firstNumber = 1) => Array.from({ length: count }, (_, index) => {
  const number = firstNumber + index;
  return pr(number, index % 2 === 0 ? "MERGED" : "CLOSED", `feat/old-${number}`);
});

test("조회 필드는 판정이 읽는 필드 전부다", () => {
  assert.equal(PR_FIELDS, "number,state,isDraft,headRefName,baseRefName,headRepository,isCrossRepository");
});

test("닫힘·병합 PR이 5000건 쌓여도 열린 PR과 claim 브랜치의 PR(전 상태)을 정확히 돌려준다", async () => {
  // claim의 병합 PR(#5)은 가장 오래된 PR이라 최신 1000건 목록에는 없다. 예전 방식(--state all --limit 1000)이 잘못 보는 바로 그 경우다.
  const claimPr = pr(5, "MERGED", `${CLAIM}5`);
  const dataset = [...history(5000, 6), claimPr, pr(6001, "OPEN", `${CLAIM}6001`), pr(6002, "OPEN", "dependabot/npm_and_yarn/x")];
  const github = fakeGitHub(dataset);
  const legacy = JSON.parse(await github.runGh(["pr", "list", "--repo", REPOSITORY, "--state", "all", "--limit", "1000", "--json", PR_FIELDS]));
  assert.equal(legacy.length, 1000, "예전 방식은 목록이 상한에 닿는다");
  assert.equal(legacy.some(({ number }) => number === 5), false, "예전 방식은 오래된 claim PR을 놓친다");

  const result = await collect({ repository: REPOSITORY, refsText: refs(`${CLAIM}5`, `${CLAIM}6001`), limit: 1000, runGh: github.runGh });
  assert.deepEqual(result.map(({ number }) => number).sort((left, right) => left - right), [5, 6001, 6002]);
  assert.equal(result.find(({ number }) => number === 5).state, "MERGED");
});

test("열린 PR 목록은 상한을 두고 상한과 같은 개수면 잘린 것으로 보고 실패한다", async () => {
  const open = (count) => Array.from({ length: count }, (_, index) => pr(100 + index, "OPEN", `feat/open-${index}`));
  const attempt = (count) => collect({ repository: REPOSITORY, refsText: "", limit: 3, runGh: fakeGitHub([...history(5000, 1000), ...open(count)]).runGh });
  assert.equal((await attempt(2)).length, 2);
  await assert.rejects(attempt(3), /AUTOMATION_PR_LIST_TRUNCATED: open pull request list reached its limit 3/u);
  await assert.rejects(attempt(4), /AUTOMATION_PR_LIST_TRUNCATED/u);
});

test("claim 브랜치 하나에 묶인 PR이 상한(100건)에 닿으면 잘린 것으로 보고 실패한다", async () => {
  const same = Array.from({ length: 100 }, (_, index) => pr(10 + index, "CLOSED", `${CLAIM}9`));
  await assert.rejects(
    collect({ repository: REPOSITORY, refsText: refs(`${CLAIM}9`), limit: 1000, runGh: fakeGitHub(same).runGh }),
    /AUTOMATION_PR_LIST_TRUNCATED: pull request list for refs\/heads\/automation\/984-source-reverification-9 reached its limit 100/u,
  );
});

test("claim 브랜치의 PR이 열려 있기도 하면 한 번만 담고, 나중에 읽은 브랜치별 상태를 쓴다", async () => {
  const github = fakeGitHub([pr(70, "OPEN", `${CLAIM}70`)]);
  let first = true;
  const runGh = async (args) => {
    const body = JSON.parse(await github.runGh(args));
    if (!first && body.length > 0) body[0] = { ...body[0], state: "MERGED" };
    first = false;
    return JSON.stringify(body);
  };
  const result = await collect({ repository: REPOSITORY, refsText: refs(`${CLAIM}70`), limit: 1000, runGh });
  assert.deepEqual(result.map(({ number, state }) => [number, state]), [[70, "MERGED"]]);
});

test("브랜치별 조회는 refs의 브랜치마다 한 번이고 PR이 없는 브랜치는 목록에 아무것도 더하지 않는다", async () => {
  const github = fakeGitHub([pr(1, "MERGED", `${CLAIM}1`)]);
  const result = await collect({ repository: REPOSITORY, refsText: refs(`${CLAIM}1`, `${CLAIM}2`), limit: 1000, runGh: github.runGh });
  assert.deepEqual(result.map(({ number }) => number), [1]);
  const heads = github.calls.map((args) => args[args.indexOf("--head") + 1]).filter((value) => value.startsWith("automation/"));
  assert.deepEqual(heads, [`${CLAIM}1`, `${CLAIM}2`]);
  assert.equal(github.calls.filter((args) => args.includes("--head")).every((args) => args[args.indexOf("--state") + 1] === "all"), true);
  assert.equal(github.calls.filter((args) => !args.includes("--head")).every((args) => args[args.indexOf("--state") + 1] === "open"), true);
});

test("gh가 실패하거나 목록이 아닌 것을 돌려주면 대체하지 않고 실패한다", async () => {
  const failing = async () => { throw new Error("gh: HTTP 502"); };
  await assert.rejects(collect({ repository: REPOSITORY, refsText: "", limit: 1000, runGh: failing }), /gh: HTTP 502/u);
  const notList = async () => JSON.stringify({ message: "x" });
  await assert.rejects(collect({ repository: REPOSITORY, refsText: "", limit: 1000, runGh: notList }), /AUTOMATION_PR_LIST_INVALID/u);
  const garbage = async () => "not json";
  await assert.rejects(collect({ repository: REPOSITORY, refsText: "", limit: 1000, runGh: garbage }), /AUTOMATION_PR_LIST_INVALID/u);
});

test("입력이 잘못되면 조회하지 않고 실패한다", async () => {
  const runGh = async () => { throw new Error("must not be called"); };
  const collectWith = (overrides) => collect({ repository: REPOSITORY, refsText: "", limit: 1000, runGh, ...overrides });
  await assert.rejects(collectWith({ repository: "x" }), /AUTOMATION_PR_INPUT_INVALID/u);
  await assert.rejects(collectWith({ limit: 0 }), /AUTOMATION_PR_INPUT_INVALID/u);
  await assert.rejects(collectWith({ limit: "1000" }), /AUTOMATION_PR_INPUT_INVALID/u);
  await assert.rejects(collectWith({ runGh: undefined }), /AUTOMATION_PR_INPUT_INVALID/u);
  await assert.rejects(collectWith({ refsText: `${SHA} refs/heads/automation/x\n` }), /AUTOMATION_PR_REFS_INVALID/u);
  await assert.rejects(collectWith({ refsText: `${SHA}\trefs/tags/automation/x\n` }), /AUTOMATION_PR_REFS_INVALID/u);
  await assert.rejects(collectWith({ refsText: `${SHA}\trefs/heads/-bad\n` }), /AUTOMATION_PR_REFS_INVALID/u);
  await assert.rejects(collectWith({ refsText: refs(`${CLAIM}1`, `${CLAIM}1`) }), /AUTOMATION_PR_REFS_INVALID: duplicate/u);
});

test("5000건 이력에서 모은 목록으로 ITX 승격 판정이 이력 없을 때와 같은 결과를 낸다(예전 방식 목록은 병합 PR을 놓쳐 고아 브랜치로 실패한다)", async () => {
  const claim = `${ITX_PROMOTION_CLAIM_PREFIX}5`;
  const claimPr = pr(5, "MERGED", claim);
  const github = fakeGitHub([...history(5000, 6), claimPr]);
  const collected = await collect({ repository: REPOSITORY, refsText: refs(claim), limit: 1000, runGh: github.runGh });
  const legacy = JSON.parse(await github.runGh(["pr", "list", "--repo", REPOSITORY, "--state", "all", "--limit", "1000", "--json", PR_FIELDS]));
  const decide = (pullRequests) => decideItxCurrentPromotion({
    now: new Date("2026-10-05T15:00:00Z"), contract: { sourceTimetableArtifact: { status: "ADMITTED", freshUntil: "2026-10-30T00:00:00+09:00" } },
    pullRequests, branches: [{ sha: SHA, branch: claim }], repository: REPOSITORY, limits: { pullRequests: 1000 },
  });
  assert.deepEqual(decide(collected), decide([claimPr]));
  assert.equal(decide(collected).state, "WAIT");
  assert.throws(() => decide(legacy), /ITX_PROMOTION_LIST_TRUNCATED|ITX_PROMOTION_ORPHAN_BRANCH/u);
});

test("CLI는 ls-remote 출력 파일을 읽어 목록 JSON을 쓰고 gh 인자를 기록한다", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "collect-automation-prs-"));
  try {
    const refsFile = path.join(dir, "claims.txt");
    const output = path.join(dir, "prs.json");
    await writeFile(refsFile, refs(`${CLAIM}3`));
    const github = fakeGitHub([...history(10, 10), pr(3, "MERGED", `${CLAIM}3`), pr(50, "OPEN", "feat/x")]);
    const lines = [];
    await main(["--repository", REPOSITORY, "--refs", refsFile, "--pr-limit", "1000", "--output", output], { runGh: github.runGh, log: (line) => lines.push(line) });
    const written = JSON.parse(await readFile(output, "utf8"));
    assert.deepEqual(written.map(({ number }) => number).sort((left, right) => left - right), [3, 50]);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /open=1 claims=1 total=2/u);
    assert.deepEqual(github.calls[0], ["pr", "list", "--repo", REPOSITORY, "--state", "open", "--limit", "1000", "--json", PR_FIELDS]);
    assert.deepEqual(github.calls[1], ["pr", "list", "--repo", REPOSITORY, "--state", "all", "--head", `${CLAIM}3`, "--limit", "100", "--json", PR_FIELDS]);
    await assert.rejects(main(["--repository", REPOSITORY, "--refs", refsFile, "--pr-limit", "1000"], { runGh: github.runGh }), /AUTOMATION_PR_INPUT_INVALID: missing --output/u);
    await assert.rejects(main(["--repository", REPOSITORY, "--refs", refsFile, "--pr-limit", "x", "--output", output], { runGh: github.runGh }), /AUTOMATION_PR_INPUT_INVALID/u);
    await assert.rejects(main(["--bogus", "1"], { runGh: github.runGh }), /AUTOMATION_PR_INPUT_INVALID/u);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
