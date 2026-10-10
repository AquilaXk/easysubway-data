import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ITX_PROMOTION_BEST_EXTENSION_DAYS,
  ITX_PROMOTION_CLAIM_PREFIX,
  ITX_PROMOTION_MIN_GAIN_DAYS,
  ITX_PROMOTION_SAFETY_LEAD_DAYS,
  ITX_PROMOTION_WORKFLOW,
  decideItxCurrentPromotion,
  main,
  parseItxPromotionBranches,
  weekdayFreshUntilIfCollected,
} from "./decide-itx-current-promotion.mjs";
import { LEDGER_WRITER_WORKFLOWS, REFRESH_CLAIM_PREFIXES } from "./refresh-open-pr-age.mjs";

const REPOSITORY = "AquilaXk/easysubway-data";
const DAY_MS = 86_400_000;
const kst = (isoDate, time = "03:00:00") => new Date(`${isoDate}T${time}+09:00`);
const contractWith = (freshUntilDate) => ({
  sourceTimetableArtifact: {
    status: "ADMITTED",
    artifactId: "itx-cheongchun-source-timetable-20261004151519524",
    freshUntil: `${freshUntilDate}T00:00:00+09:00`,
  },
});
const decide = (overrides = {}) => decideItxCurrentPromotion({
  now: kst("2026-10-06"),
  contract: contractWith("2026-10-12"),
  pullRequests: [],
  branches: [],
  repository: REPOSITORY,
  limits: { pullRequests: 1000 },
  ...overrides,
});
const pr = (overrides = {}) => ({
  number: 990,
  state: "OPEN",
  isDraft: true,
  headRefName: `${ITX_PROMOTION_CLAIM_PREFIX}123`,
  baseRefName: "main",
  isCrossRepository: false,
  headRepository: { nameWithOwner: REPOSITORY },
  ...overrides,
});

test("신선도 규칙에서 계산한 요일별 확보 기간: 일·월 7일, 화 6일, 수 5일, 목 4일, 금·토 3일", () => {
  // 2026-10-04는 일요일이다. 첫 평일·토·일 운행일 중 가장 늦은 날의 다음 날 00:00 KST가 freshUntil이다.
  const expected = { "2026-10-04": 7, "2026-10-05": 7, "2026-10-06": 6, "2026-10-07": 5, "2026-10-08": 4, "2026-10-09": 3, "2026-10-10": 3 };
  for (const [date, days] of Object.entries(expected)) {
    const projected = weekdayFreshUntilIfCollected(kst(date));
    assert.equal((projected.getTime() - kst(date, "00:00:00").getTime()) / DAY_MS, days, date);
    assert.equal(projected.toISOString().slice(11), "15:00:00.000Z", `${date} must end at 00:00 KST`);
  }
  // 실제 승격 이력과 일치한다: 2026-10-05(월) 00:15 KST 수집은 2026-10-12 00:00 KST까지.
  assert.equal(weekdayFreshUntilIfCollected(new Date("2026-10-04T15:15:19.524Z")).toISOString(), "2026-10-11T15:00:00.000Z");
});

test("상수는 규칙에서 나온 값이다: 최대 확보 7일, 안전 여유 2일(재시도 하루), 최소 이득 3일", () => {
  assert.equal(ITX_PROMOTION_BEST_EXTENSION_DAYS, 7);
  assert.equal(ITX_PROMOTION_SAFETY_LEAD_DAYS, 2);
  assert.equal(ITX_PROMOTION_MIN_GAIN_DAYS, 3);
  assert.equal(ITX_PROMOTION_WORKFLOW, "itx-current-promotion.yml");
  assert.equal(REFRESH_CLAIM_PREFIXES[ITX_PROMOTION_WORKFLOW], "automation/977-itx-promotion-");
  assert.ok(LEDGER_WRITER_WORKFLOWS.includes(ITX_PROMOTION_WORKFLOW));
});

test("만료까지 여유가 있고 오늘이 최대 확보일이 아니면 공급자를 부르지 않는다", () => {
  for (const date of ["2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09"]) {
    const result = decide({ now: kst(date) });
    assert.equal(result.state, "WAIT", date);
  }
});

test("만료 2일 안에 들어서면 이득이 작아도 수집한다: 하루 재시도 여유", () => {
  assert.deepEqual(
    (({ state, reason, daysUntilExpiry }) => ({ state, reason, daysUntilExpiry }))(decide({ now: kst("2026-10-10") })),
    { state: "COLLECT", reason: "SAFETY_LEAD", daysUntilExpiry: 2 },
  );
  assert.equal(decide({ now: kst("2026-10-11") }).reason, "SAFETY_LEAD");
  assert.equal(decide({ now: kst("2026-10-11", "23:59:59") }).state, "COLLECT");
});

test("만료 3일 전이면 아직 기다린다 (한도+1 경계)", () => {
  assert.equal(decide({ now: kst("2026-10-09", "23:59:59") }).state, "WAIT");
});

test("이미 만료됐으면 EXPIRED로 수집하고 신선도가 끊겼음을 lapsed로 알린다", () => {
  const result = decide({ now: kst("2026-10-12", "00:00:00") });
  assert.deepEqual({ state: result.state, reason: result.reason, lapsed: result.lapsed }, { state: "COLLECT", reason: "EXPIRED", lapsed: true });
  assert.equal(decide({ now: kst("2026-10-20") }).lapsed, true);
  assert.equal(decide({ now: kst("2026-10-11") }).lapsed, false);
});

test("일·월요일처럼 7일을 확보하는 날 이득이 3일 이상이면 여유가 있어도 수집한다", () => {
  // 만료 3일 뒤(수요일 2026-10-14)인 일요일 2026-10-11: 수집하면 2026-10-18까지, 이득 4일.
  assert.deepEqual(
    (({ state, reason }) => ({ state, reason }))(decide({ now: kst("2026-10-11"), contract: contractWith("2026-10-15") })),
    { state: "COLLECT", reason: "BEST_DAY" },
  );
  // 이득이 2일뿐이면 기다린다: 일요일 2026-10-11, 만료 2026-10-16 -> 2026-10-18까지 이득 2일.
  assert.equal(decide({ now: kst("2026-10-11"), contract: contractWith("2026-10-16") }).state, "WAIT");
  // 같은 이득이어도 화요일(6일 확보)은 최대 확보일이 아니라 기다린다.
  assert.equal(decide({ now: kst("2026-10-13"), contract: contractWith("2026-10-17") }).state, "WAIT");
});

test("사람 dispatch의 force는 수집할 때가 아니어도 수집하게 하지만 열린 PR·대기·이상 규칙은 그대로다", () => {
  assert.deepEqual(
    (({ state, reason }) => ({ state, reason }))(decide({ now: kst("2026-10-06"), force: true })),
    { state: "COLLECT", reason: "FORCED" },
  );
  // 이미 수집할 이유가 있으면 이유를 덮어쓰지 않는다.
  assert.equal(decide({ now: kst("2026-10-10"), force: true }).reason, "SAFETY_LEAD");
  assert.equal(decide({ now: kst("2026-10-06"), force: false }).state, "WAIT");
  assert.equal(decide({ now: kst("2026-10-06"), pullRequests: [pr()], force: true }).state, "OPEN_PR");
  const other = pr({ number: 980, headRefName: "automation/456-capital-topology-registration-55" });
  assert.equal(decide({ now: kst("2026-10-06"), pullRequests: [other], force: true }).state, "BLOCKED_BY_PENDING_PR");
  assert.throws(() => decide({ now: kst("2026-10-06"), force: "yes" }), /ITX_PROMOTION_INPUT_INVALID/u);
});

test("같은 KST 날 다른 workflow가 이미 ITX를 수집했으면 수집할 때여도 WAIT로 정상 종료한다 (F4, 이상 아님)", () => {
  for (const [name, overrides] of [
    ["SAFETY_LEAD", { now: kst("2026-10-10") }],
    ["EXPIRED", { now: kst("2026-10-12", "03:00:00") }],
    ["FORCED", { now: kst("2026-10-06"), force: true }],
  ]) {
    const result = decide({ ...overrides, itxCollectedToday: true });
    assert.deepEqual({ state: result.state, reason: result.reason }, { state: "WAIT", reason: "ITX_COLLECTED_TODAY" }, name);
  }
  // 수집할 때가 아니면 그대로 NOT_DUE, 열린 PR이 있으면 그대로 OPEN_PR이다.
  assert.equal(decide({ now: kst("2026-10-06"), itxCollectedToday: true }).reason, "NOT_DUE");
  assert.equal(decide({ now: kst("2026-10-10"), itxCollectedToday: true, pullRequests: [pr()] }).state, "OPEN_PR");
  // 다음 날에는 다시 수집한다.
  assert.equal(decide({ now: kst("2026-10-11"), itxCollectedToday: false }).state, "COLLECT");
  assert.throws(() => decide({ now: kst("2026-10-10"), itxCollectedToday: "yes" }), /ITX_PROMOTION_INPUT_INVALID/u);
});

// #1127: 하루 한 번만 받을 수 있는 수집분이 승격 PR과 함께 사라졌을 때, 보관 capture를 재생해 승격한다. 재생은 공급자를 부르지 않는다.
test("재생 요청은 수집할 때가 아니어도, 같은 KST 날 이미 수집했어도 COLLECT로 진행한다 (공급자 호출 없음)", () => {
  const notDue = decide({ now: kst("2026-10-06"), replayRunId: "38062621511" });
  assert.deepEqual(
    (({ state, reason, replayRunId }) => ({ state, reason, replayRunId }))(notDue),
    { state: "COLLECT", reason: "REPLAY", replayRunId: "38062621511" },
  );
  const collectedToday = decide({ now: kst("2026-10-10"), itxCollectedToday: true, replayRunId: "38062621511" });
  assert.deepEqual(
    (({ state, reason, replayRunId }) => ({ state, reason, replayRunId }))(collectedToday),
    { state: "COLLECT", reason: "REPLAY", replayRunId: "38062621511" },
  );
  // 재생이 아니면 같은 조건은 그대로 WAIT이다.
  assert.equal(decide({ now: kst("2026-10-10"), itxCollectedToday: true }).reason, "ITX_COLLECTED_TODAY");
  assert.equal(decide({ now: kst("2026-10-10") }).replayRunId, undefined);
});

test("재생 요청도 열린 PR·중복·닫힌 PR·고아 브랜치·대기 PR 판정은 그대로 받는다", () => {
  const replayRunId = "38062621511";
  assert.equal(decide({ replayRunId, pullRequests: [pr()], branches: [{ branch: `${ITX_PROMOTION_CLAIM_PREFIX}123` }] }).state, "OPEN_PR");
  assert.throws(() => decide({ replayRunId, pullRequests: [pr(), pr({ number: 991, headRefName: `${ITX_PROMOTION_CLAIM_PREFIX}124` })], branches: [{ branch: `${ITX_PROMOTION_CLAIM_PREFIX}123` }, { branch: `${ITX_PROMOTION_CLAIM_PREFIX}124` }] }), /ITX_PROMOTION_PR_DUPLICATE/u);
  assert.throws(() => decide({ replayRunId, pullRequests: [pr({ state: "CLOSED" })], branches: [] }), /ITX_PROMOTION_PR_CLOSED/u);
  assert.throws(() => decide({ replayRunId, branches: [{ branch: `${ITX_PROMOTION_CLAIM_PREFIX}123` }] }), /ITX_PROMOTION_ORPHAN_BRANCH/u);
  const other = pr({ number: 980, headRefName: "automation/456-capital-topology-registration-55" });
  assert.deepEqual(
    (({ state, blockedBy }) => ({ state, blockedBy }))(decide({ now: kst("2026-10-06"), pullRequests: [other], replayRunId })),
    { state: "BLOCKED_BY_PENDING_PR", blockedBy: [980] },
  );
});

test("재생 요청의 run id는 양의 정수 문자열만 받는다. 아니면 추정하지 않고 실패한다", () => {
  for (const replayRunId of ["0", "-1", "01", "12a", " 123", "1.5", 123, null]) {
    assert.throws(() => decide({ replayRunId }), /ITX_PROMOTION_INPUT_INVALID/u, String(replayRunId));
  }
  assert.throws(() => decide({ replayRunId: "9".repeat(20) }), /ITX_PROMOTION_INPUT_INVALID/u);
});

test("열린 승격 PR이 있으면 새로 수집하지 않고 그 PR을 돌려준다", () => {
  const result = decide({ now: kst("2026-10-11"), pullRequests: [pr()], branches: [{ sha: "a".repeat(40), branch: `${ITX_PROMOTION_CLAIM_PREFIX}123` }] });
  assert.deepEqual({ state: result.state, branch: result.branch, number: result.number }, { state: "OPEN_PR", branch: `${ITX_PROMOTION_CLAIM_PREFIX}123`, number: 990 });
});

test("열린 승격 PR이 둘이면 하나를 고르지 않고 실패한다", () => {
  assert.throws(() => decide({ pullRequests: [pr(), pr({ number: 991, headRefName: `${ITX_PROMOTION_CLAIM_PREFIX}124` })] }), /ITX_PROMOTION_PR_DUPLICATE/u);
});

test("PR 없는 승격 브랜치와 닫힌(병합되지 않은) 승격 PR은 이상이다", () => {
  assert.throws(() => decide({ branches: [{ sha: "a".repeat(40), branch: `${ITX_PROMOTION_CLAIM_PREFIX}123` }] }), /ITX_PROMOTION_ORPHAN_BRANCH/u);
  assert.throws(() => decide({ pullRequests: [pr({ state: "CLOSED" })] }), /ITX_PROMOTION_PR_CLOSED/u);
  // 병합된 PR의 남은 브랜치와 병합 기록은 이상이 아니다.
  const merged = pr({ state: "MERGED" });
  assert.equal(decide({ pullRequests: [merged], branches: [{ sha: "a".repeat(40), branch: merged.headRefName }] }).state, "WAIT");
});

test("다른 자동화 PR(원장 쓰기)이 열려 있으면 수집하지 않고 기다린다. 만료 1일 전이면 이상이다", () => {
  const other = pr({ number: 980, headRefName: "automation/456-capital-topology-registration-55" });
  assert.deepEqual(
    (({ state, blockedBy }) => ({ state, blockedBy }))(decide({ now: kst("2026-10-10"), pullRequests: [other] })),
    { state: "BLOCKED_BY_PENDING_PR", blockedBy: [980] },
  );
  assert.equal(decide({ now: kst("2026-10-08"), pullRequests: [other] }).state, "WAIT");
  assert.throws(() => decide({ now: kst("2026-10-11"), pullRequests: [other] }), /ITX_PROMOTION_BLOCKED_NEAR_EXPIRY/u);
  assert.throws(() => decide({ now: kst("2026-10-12", "01:00:00"), pullRequests: [other] }), /ITX_PROMOTION_BLOCKED_NEAR_EXPIRY/u);
});

test("입력이 잘못되면 추정하지 않고 실패한다", () => {
  assert.throws(() => decide({ contract: { sourceTimetableArtifact: { status: "MISSING" } } }), /ITX_PROMOTION_ADMITTED_SOURCE_MISSING/u);
  assert.throws(() => decide({ contract: contractWith("2026-10-12T00") }), /ITX_PROMOTION_ADMITTED_SOURCE_MISSING/u);
  assert.throws(() => decide({ contract: { sourceTimetableArtifact: { status: "ADMITTED", freshUntil: "2026-10-12T01:00:00+09:00" } } }), /ITX_PROMOTION_ADMITTED_SOURCE_MISSING/u);
  assert.throws(() => decide({ now: new Date("invalid") }), /ITX_PROMOTION_INPUT_INVALID/u);
  assert.throws(() => decide({ repository: "x" }), /ITX_PROMOTION_INPUT_INVALID/u);
  assert.throws(() => decide({ pullRequests: [pr()], limits: { pullRequests: 1 } }), /ITX_PROMOTION_LIST_TRUNCATED/u);
});

// #993: 상한은 열린 PR 목록에만 건다. 닫힘·병합 PR 이력은 자동화가 매일 PR을 열어 계속 쌓인다.
test("닫힘·병합 PR 이력이 상한을 훨씬 넘게 있어도 실패하지 않고 열린 PR이 상한에 닿을 때만 실패한다", () => {
  const history = (count, state, prefix) => Array.from({ length: count }, (_, index) => pr({ number: 3000 + index, state, headRefName: `${prefix}${state}-${index}` }));
  const merged = history(2500, "MERGED", "feat/old-");
  const closedElsewhere = history(2500, "CLOSED", "feat/old-");
  assert.equal(decide({ pullRequests: [...merged, ...closedElsewhere] }).state, "WAIT");
  assert.equal(decide({ pullRequests: [...merged, ...closedElsewhere, pr()], branches: [{ sha: "b".repeat(40), branch: `${ITX_PROMOTION_CLAIM_PREFIX}123` }] }).state, "OPEN_PR");
  assert.throws(() => decide({ pullRequests: [...merged, ...history(1000, "OPEN", "feat/open-")] }), /ITX_PROMOTION_LIST_TRUNCATED: pull request list reached its limit 1000/u);
  assert.equal(decide({ pullRequests: [...merged, ...history(999, "OPEN", "feat/open-")] }).state, "WAIT");
});

test("ls-remote 출력에서 승격 브랜치만 읽고 다른 형식이 섞이면 실패한다", () => {
  const sha = "b".repeat(40);
  assert.deepEqual(parseItxPromotionBranches(`${sha}\trefs/heads/${ITX_PROMOTION_CLAIM_PREFIX}9\n`), [{ sha, branch: `${ITX_PROMOTION_CLAIM_PREFIX}9` }]);
  assert.deepEqual(parseItxPromotionBranches(""), []);
  assert.throws(() => parseItxPromotionBranches(`${sha}\trefs/heads/${ITX_PROMOTION_CLAIM_PREFIX}x\n`), /ITX_PROMOTION_BRANCH_INVALID/u);
});

// ---------------------------------------------------------------------------
// 일정 시뮬레이션: 수집이 성공하면 freshUntil이 규칙대로 늘어난다. 끊기지 않아야 한다.
// ---------------------------------------------------------------------------
function simulate({ days = 140, failOn = new Set(), startFreshUntil = "2026-10-12" } = {}) {
  let freshUntil = new Date(`${startFreshUntil}T00:00:00+09:00`);
  const collections = [];
  const lapsed = [];
  let minLeadDays = Infinity;
  for (let offset = 0; offset < days; offset += 1) {
    const now = new Date(kst("2026-10-06").getTime() + offset * DAY_MS);
    const contract = contractWith(new Date(freshUntil.getTime() + 9 * 3_600_000).toISOString().slice(0, 10));
    let result;
    try {
      result = decideItxCurrentPromotion({ now, contract, pullRequests: [], branches: [], repository: REPOSITORY, limits: { pullRequests: 1000 } });
    } catch (error) {
      throw new Error(`day ${offset}: ${error.message}`);
    }
    if (result.state === "COLLECT") {
      collections.push(offset);
      if (!failOn.has(offset)) {
        minLeadDays = Math.min(minLeadDays, result.daysUntilExpiry);
        const projected = weekdayFreshUntilIfCollected(now);
        if (projected > freshUntil) freshUntil = projected;
      }
    }
    // 그날 24시 직전에도 아직 신선해야 한다(만료는 freshUntil 00:00 KST).
    if (new Date(now.getTime() + 20 * 3_600_000) >= freshUntil) lapsed.push(offset);
  }
  return { collections, lapsed, minLeadDays };
}

test("일정 시뮬레이션: 모든 수집이 성공하면 140일 동안 신선도가 끊기지 않고 주 3회, 만료 2일 전 안에 수집한다", () => {
  const { collections, lapsed, minLeadDays } = simulate();
  assert.deepEqual(lapsed, []);
  assert.ok(minLeadDays >= 2, `collections must keep two days of lead, got ${minLeadDays}`);
  const perWeek = collections.length / (140 / 7);
  assert.ok(perWeek >= 2 && perWeek <= 3.5, `collections per week ${perWeek}`);
});

test("일정 시뮬레이션: 어떤 한 번의 수집이 실패해도(공급자 장애·게이트 차단) 다음 날 재시도로 끊기지 않는다", () => {
  const baseline = simulate().collections;
  assert.ok(baseline.length >= 40);
  for (const failing of baseline.slice(0, 40)) {
    const { lapsed } = simulate({ failOn: new Set([failing]) });
    assert.deepEqual(lapsed, [], `failure on day ${failing}`);
  }
});

test("일정 시뮬레이션: 연속 두 번 실패하면 끊긴다 (안전 여유가 정확히 하루 재시도임을 보인다)", () => {
  const baseline = simulate().collections;
  const consecutive = baseline.find((day, index) => baseline[index + 1] === day + 1);
  assert.notEqual(consecutive, undefined);
  const { lapsed } = simulate({ failOn: new Set([consecutive, consecutive + 1, consecutive + 2]) });
  assert.ok(lapsed.length > 0);
});

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
test("CLI는 판정을 GITHUB_OUTPUT에 쓴다", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "decide-itx-promotion-"));
  try {
    await writeFile(path.join(dir, "contract.json"), JSON.stringify(contractWith("2026-10-12")));
    await writeFile(path.join(dir, "prs.json"), "[]");
    await writeFile(path.join(dir, "branches.txt"), "");
    const output = path.join(dir, "output.txt");
    const logs = [];
    const forced = await main([
      "--contract", path.join(dir, "contract.json"), "--prs", path.join(dir, "prs.json"), "--branches", path.join(dir, "branches.txt"),
      "--repository", REPOSITORY, "--pr-limit", "1000", "--force", "true",
    ], { now: kst("2026-10-06"), log: () => {} });
    assert.equal(forced.reason, "FORCED");
    await assert.rejects(main([
      "--contract", path.join(dir, "contract.json"), "--prs", path.join(dir, "prs.json"), "--branches", path.join(dir, "branches.txt"),
      "--repository", REPOSITORY, "--pr-limit", "1000", "--force", "maybe",
    ], { now: kst("2026-10-06"), log: () => {} }), /ITX_PROMOTION_INPUT_INVALID/u);
    const result = await main([
      "--contract", path.join(dir, "contract.json"), "--prs", path.join(dir, "prs.json"), "--branches", path.join(dir, "branches.txt"),
      "--repository", REPOSITORY, "--pr-limit", "1000", "--github-output", output,
    ], { now: kst("2026-10-10"), log: (line) => logs.push(line) });
    assert.equal(result.state, "COLLECT");
    assert.deepEqual((await readFile(output, "utf8")).trim().split("\n"), [
      "state=COLLECT", "reason=SAFETY_LEAD", "branch=", "pr_number=", "blocked_by=", "days_until_expiry=2", "lapsed=false", "replay_run_id=",
    ]);
    assert.equal(logs.length, 1);
    const waiting = await main([
      "--contract", path.join(dir, "contract.json"), "--prs", path.join(dir, "prs.json"), "--branches", path.join(dir, "branches.txt"),
      "--repository", REPOSITORY, "--pr-limit", "1000", "--itx-collected-today", "true",
    ], { now: kst("2026-10-10"), log: () => {} });
    assert.deepEqual({ state: waiting.state, reason: waiting.reason }, { state: "WAIT", reason: "ITX_COLLECTED_TODAY" });
    await assert.rejects(main([
      "--contract", path.join(dir, "contract.json"), "--prs", path.join(dir, "prs.json"), "--branches", path.join(dir, "branches.txt"),
      "--repository", REPOSITORY, "--pr-limit", "1000", "--itx-collected-today", "maybe",
    ], { now: kst("2026-10-10"), log: () => {} }), /ITX_PROMOTION_INPUT_INVALID/u);
    await assert.rejects(main(["--contract", path.join(dir, "contract.json")], { now: kst("2026-10-10") }), /ITX_PROMOTION_INPUT_INVALID/u);
    // #1127: --replay-run-id는 재생 모드를 연다. 빈 문자열은 입력 없음(정기 실행)과 같다.
    const replaying = await main([
      "--contract", path.join(dir, "contract.json"), "--prs", path.join(dir, "prs.json"), "--branches", path.join(dir, "branches.txt"),
      "--repository", REPOSITORY, "--pr-limit", "1000", "--itx-collected-today", "true", "--replay-run-id", "38062621511", "--github-output", output,
    ], { now: kst("2026-10-10"), log: () => {} });
    assert.deepEqual({ state: replaying.state, reason: replaying.reason }, { state: "COLLECT", reason: "REPLAY" });
    assert.match(await readFile(output, "utf8"), /state=COLLECT\nreason=REPLAY\nbranch=\npr_number=\nblocked_by=\ndays_until_expiry=2\nlapsed=false\nreplay_run_id=38062621511\n$/u);
    const empty = await main([
      "--contract", path.join(dir, "contract.json"), "--prs", path.join(dir, "prs.json"), "--branches", path.join(dir, "branches.txt"),
      "--repository", REPOSITORY, "--pr-limit", "1000", "--itx-collected-today", "true", "--replay-run-id", "",
    ], { now: kst("2026-10-10"), log: () => {} });
    assert.equal(empty.reason, "ITX_COLLECTED_TODAY");
    await assert.rejects(main([
      "--contract", path.join(dir, "contract.json"), "--prs", path.join(dir, "prs.json"), "--branches", path.join(dir, "branches.txt"),
      "--repository", REPOSITORY, "--pr-limit", "1000", "--replay-run-id", "abc",
    ], { now: kst("2026-10-10"), log: () => {} }), /ITX_PROMOTION_INPUT_INVALID/u);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
