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
    const result = await main([
      "--contract", path.join(dir, "contract.json"), "--prs", path.join(dir, "prs.json"), "--branches", path.join(dir, "branches.txt"),
      "--repository", REPOSITORY, "--pr-limit", "1000", "--github-output", output,
    ], { now: kst("2026-10-10"), log: (line) => logs.push(line) });
    assert.equal(result.state, "COLLECT");
    assert.deepEqual((await readFile(output, "utf8")).trim().split("\n"), [
      "state=COLLECT", "reason=SAFETY_LEAD", "branch=", "pr_number=", "blocked_by=", "days_until_expiry=2", "lapsed=false",
    ]);
    assert.equal(logs.length, 1);
    await assert.rejects(main(["--contract", path.join(dir, "contract.json")], { now: kst("2026-10-10") }), /ITX_PROMOTION_INPUT_INVALID/u);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
