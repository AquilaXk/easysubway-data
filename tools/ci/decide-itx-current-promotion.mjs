#!/usr/bin/env node
// ITX-청춘 원천 시간표 수집·승격 시점 판정(#977, #870 전체 자동화 3단계).
//
// 이 판정은 공급자(TAGO·KORAIL)를 부르기 전에 돈다. 공급자 호출은 KST 하루 한 번으로 제한되고 한 번에 수천 건을 쓰므로
// 매일 정기 실행해도 필요한 날에만 수집하고, 아니면 아무것도 하지 않고 PR도 열지 않는다(멱등).
//
// 신선도 규칙(collect-korail-itx-cheongchun-timetable freshUntil): 수집일(KST)부터 첫 평일·토·일 운행일 중 가장 늦은 날의
// 다음 날 00:00 KST. 그래서 수집 요일이 확보 기간을 정한다.
//   일·월 7일, 화 6일, 수 5일, 목 4일, 금·토 3일 (공휴일은 운행일을 뒤로 밀 뿐이라 이 값은 하한이다)
// 최대 7일이라 주 1회 수집은 매주 몇 시간 끊긴다. 끊기지 않으면서 재시도 여유를 두는 규칙은 세 가지다.
//   EXPIRED      이미 만료됐다. 즉시 수집한다(끊김은 lapsed로 알린다).
//   SAFETY_LEAD  만료까지 2일 이하다. 이득이 작아도 수집한다. 그날 실패해도 하루 재시도 여유가 남는다.
//   BEST_DAY     오늘이 최대 확보일(7일)이고 이번 수집이 만료를 3일 이상 늘린다.
//   FORCED       사람 dispatch가 force를 줬다(수집할 때가 아니어도 수집한다). 열린 PR·대기·이상 규칙은 그대로다.
//   REPLAY       이전 run이 받아 둔 수집분(보관 capture)을 다시 승격한다(#1127). 공급자를 부르지 않으므로 하루 한 번 제한(ITX_COLLECTED_TODAY)과
//                수집 시점 규칙을 보지 않는다. 열린 PR·중복·닫힌 PR·고아 브랜치·대기 PR 규칙은 그대로다. 복원 가능 여부는 후속 step이 검증한다.
// 결과는 대개 주 3회(금·토·일)다. 시뮬레이션 테스트가 끊김 없음과 실패 한 번 내성을 고정한다.
//
//   OPEN_PR                 이 workflow의 열린 승격 PR이 있다. 새로 수집하지 않고 CI·방치 상한만 본다.
//   WAIT                    수집할 때가 아니다.
//   COLLECT                 수집·게이트·승격 PR을 진행한다.
//   WAIT(ITX_COLLECTED_TODAY) 수집할 때지만 같은 KST 날 다른 workflow가 이미 ITX를 수집했다(공급자 호출은 하루 한 번). 이상이 아니다.
//   BLOCKED_BY_PENDING_PR   수집할 때지만 다른 자동화 PR이 열려 있다. 대기다. 만료 1일 전이면 이상이다.
// 판정할 수 없는 상태(PR 중복·PR 없는 브랜치·닫힌 PR·잘못된 입력)는 실패해 실패 이슈로 드러난다. 추정하지 않는다.
//
// 사용: node tools/ci/decide-itx-current-promotion.mjs --contract <coverage contract> --prs <collect-automation-prs.mjs 출력>
//   --branches <git ls-remote 출력> --repository <owner/repo> --pr-limit <gh pr list --limit> [--force true|false] [--itx-collected-today true|false]
//   [--replay-run-id <재생할 원본 run id>] [--github-output <path>]
import { appendFile, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { ownPullRequestsByBranch, parsePrefixedRefs, pendingLedgerWriterPullRequests, validRepository } from "./automation-pr-state.mjs";
import { REFRESH_CLAIM_PREFIXES } from "./refresh-open-pr-age.mjs";

export const ITX_PROMOTION_WORKFLOW = "itx-current-promotion.yml";
export const ITX_PROMOTION_CLAIM_PREFIX = REFRESH_CLAIM_PREFIXES[ITX_PROMOTION_WORKFLOW];
export const ITX_PROMOTION_BEST_EXTENSION_DAYS = 7;
export const ITX_PROMOTION_SAFETY_LEAD_DAYS = 2;
export const ITX_PROMOTION_MIN_GAIN_DAYS = 3;
const DAY_MS = 86_400_000;
const KST_OFFSET_MS = 9 * 3_600_000;
const FRESH_UNTIL = /^(\d{4})-(\d{2})-(\d{2})T00:00:00\+09:00$/u;

function fail(code, detail = "") {
  throw new Error(detail ? `${code}: ${detail}` : code);
}

const kstDay = (date) => Math.floor((date.getTime() + KST_OFFSET_MS) / DAY_MS);
const dayStart = (day) => new Date(day * DAY_MS - KST_OFFSET_MS);
// 1970-01-01은 목요일(4)이다.
const weekdayOfDay = (day) => (((day + 4) % 7) + 7) % 7;

/**
 * 오늘(KST) 수집하면 freshUntil이 최소 언제인가. 공휴일을 모르는 하한이다: 공휴일은 운행일을 뒤로 밀 뿐 앞당기지 않는다.
 * 첫 평일·토·일 운행일 중 가장 늦은 날의 다음 날 00:00 KST.
 */
export function weekdayFreshUntilIfCollected(now) {
  const today = kstDay(now);
  const first = (matches) => {
    for (let offset = 0; offset < 14; offset += 1) if (matches(weekdayOfDay(today + offset))) return offset;
    return fail("ITX_PROMOTION_INPUT_INVALID", "no service day in window");
  };
  const latest = Math.max(first((weekday) => weekday >= 1 && weekday <= 5), first((weekday) => weekday === 6), first((weekday) => weekday === 0));
  return dayStart(today + latest + 1);
}

/** git ls-remote --heads 출력에서 승격 브랜치만 읽는다. 다른 형식이 섞이면 실패한다. */
export function parseItxPromotionBranches(text) {
  return parsePrefixedRefs(text, ITX_PROMOTION_CLAIM_PREFIX, (detail) => fail("ITX_PROMOTION_BRANCH_INVALID", detail));
}

function admittedFreshUntilDay(contract) {
  const reference = contract?.sourceTimetableArtifact;
  const match = reference?.status === "ADMITTED" && typeof reference.freshUntil === "string" ? FRESH_UNTIL.exec(reference.freshUntil) : null;
  const millis = match ? Date.parse(reference.freshUntil) : Number.NaN;
  if (!match || !Number.isFinite(millis)) fail("ITX_PROMOTION_ADMITTED_SOURCE_MISSING", "the coverage contract has no ADMITTED source with a 00:00 KST freshUntil");
  return { millis, day: kstDay(new Date(millis)) };
}

// GitHub run id는 안전한 양의 정수다. 앞자리 0·부호·공백을 받지 않는다.
const RUN_ID = /^[1-9][0-9]{0,15}$/u;

export function decideItxCurrentPromotion({ now, contract, pullRequests, branches, repository, limits, force = false, itxCollectedToday = false, replayRunId } = {}) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime()) || !Array.isArray(pullRequests) || !Array.isArray(branches)
    || !validRepository(repository) || !Number.isSafeInteger(limits?.pullRequests) || limits.pullRequests < 1
    || typeof force !== "boolean" || typeof itxCollectedToday !== "boolean"
    || (replayRunId !== undefined && !(typeof replayRunId === "string" && RUN_ID.test(replayRunId)))
    || (replayRunId !== undefined && !Number.isSafeInteger(Number(replayRunId)))) fail("ITX_PROMOTION_INPUT_INVALID");
  const { millis: freshUntilMillis, day: expiryDay } = admittedFreshUntilDay(contract);
  const today = kstDay(now);
  const daysUntilExpiry = expiryDay - today;
  const lapsed = now.getTime() >= freshUntilMillis;
  // 목록 조회에는 개수 상한이 있다. 상한과 같은 개수면 잘렸을 수 있으므로 일부만 보고 판정하지 않는다.
  // 상한은 열린 PR에만 적용한다. 목록은 열린 PR 전체와 승격 claim 브랜치별 PR(전 상태)이고(collect-automation-prs.mjs), 닫힘·병합 이력은 쌓여도 판정에 영향이 없다(#993).
  if (pullRequests.filter(({ state }) => state === "OPEN").length >= limits.pullRequests) fail("ITX_PROMOTION_LIST_TRUNCATED", `pull request list reached its limit ${limits.pullRequests}`);

  const own = ownPullRequestsByBranch(pullRequests, ITX_PROMOTION_CLAIM_PREFIX, repository, (branch) => fail("ITX_PROMOTION_PR_DUPLICATE", branch));
  const base = { daysUntilExpiry, lapsed, freshUntil: contract.sourceTimetableArtifact.freshUntil, ...(replayRunId === undefined ? {} : { replayRunId }) };
  const open = [...own.values()].filter(({ state }) => state === "OPEN");
  if (open.length > 1) fail("ITX_PROMOTION_PR_DUPLICATE", open.map(({ number }) => `#${number}`).join(", "));
  const closed = [...own.values()].filter(({ state }) => state === "CLOSED");
  if (closed.length > 0) fail("ITX_PROMOTION_PR_CLOSED", closed.map(({ number }) => `#${number}`).join(", "));
  const orphans = branches.filter(({ branch }) => !own.has(branch));
  if (orphans.length > 0) fail("ITX_PROMOTION_ORPHAN_BRANCH", orphans.map(({ branch }) => branch).join(", "));
  if (open.length === 1) {
    const [pullRequest] = open;
    return { ...base, state: "OPEN_PR", reason: "OPEN_PR", branch: pullRequest.headRefName, number: pullRequest.number };
  }

  const projectedDay = kstDay(weekdayFreshUntilIfCollected(now));
  let reason = null;
  // #1127: 재생은 이미 받은 응답을 다시 쓰므로 수집 시점 규칙과 하루 한 번 제한을 보지 않는다.
  if (replayRunId !== undefined) reason = "REPLAY";
  else if (lapsed) reason = "EXPIRED";
  else if (daysUntilExpiry <= ITX_PROMOTION_SAFETY_LEAD_DAYS) reason = "SAFETY_LEAD";
  else if (projectedDay - today >= ITX_PROMOTION_BEST_EXTENSION_DAYS && projectedDay - expiryDay >= ITX_PROMOTION_MIN_GAIN_DAYS) reason = "BEST_DAY";
  // 사람 dispatch의 force만 수집할 때가 아닌 날에도 수집하게 한다(예: 후속 단계가 새 수집분을 기다릴 때). 이유를 덮어쓰지 않는다.
  if (reason === null && force) reason = "FORCED";
  if (reason === null) return { ...base, state: "WAIT", reason: "NOT_DUE" };

  // 같은 KST 날 다른 workflow(topology 갱신·수동 수집)가 이미 공급자를 불렀다면 오늘은 수집할 수 없다. 이상이 아니라 대기다(내일 다시 판정한다).
  if (itxCollectedToday && replayRunId === undefined) return { ...base, state: "WAIT", reason: "ITX_COLLECTED_TODAY" };
  const blockedBy = pendingLedgerWriterPullRequests(pullRequests, repository, ITX_PROMOTION_WORKFLOW);
  if (blockedBy.length > 0) {
    // 대기는 이상이 아니다. 하지만 만료 1일 전까지 풀리지 않으면 재시도 여유가 없으므로 이상으로 드러낸다.
    if (daysUntilExpiry <= 1) fail("ITX_PROMOTION_BLOCKED_NEAR_EXPIRY", `blocked by ${blockedBy.map((number) => `#${number}`).join(", ")} with ${daysUntilExpiry} day(s) left`);
    return { ...base, state: "BLOCKED_BY_PENDING_PR", reason, blockedBy };
  }
  return { ...base, state: "COLLECT", reason };
}

function parseArgs(argv) {
  const keys = new Map([
    ["--contract", "contract"], ["--prs", "prs"], ["--branches", "branches"], ["--repository", "repository"], ["--pr-limit", "prLimit"], ["--force", "force"], ["--itx-collected-today", "itxCollectedToday"], ["--replay-run-id", "replayRunId"], ["--github-output", "githubOutput"],
  ]);
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = keys.get(argv[index]);
    if (!key || Object.hasOwn(values, key) || typeof argv[index + 1] !== "string") fail("ITX_PROMOTION_INPUT_INVALID", `argument ${String(argv[index])}`);
    values[key] = argv[index + 1];
  }
  for (const key of ["contract", "prs", "branches", "repository", "prLimit"]) {
    if (!Object.hasOwn(values, key)) fail("ITX_PROMOTION_INPUT_INVALID", `missing --${key}`);
  }
  return values;
}

function booleanOption(value, name) {
  if (value === undefined) return false;
  if (value === "true") return true;
  if (value === "false") return false;
  return fail("ITX_PROMOTION_INPUT_INVALID", `${name} must be true or false`);
}

export async function main(argv, { now = new Date(), log = console.log } = {}) {
  const values = parseArgs(argv);
  const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));
  const result = decideItxCurrentPromotion({
    now,
    contract: await readJson(values.contract),
    pullRequests: await readJson(values.prs),
    branches: parseItxPromotionBranches(await readFile(values.branches, "utf8")),
    repository: values.repository,
    limits: { pullRequests: Number(values.prLimit) },
    force: booleanOption(values.force, "--force"),
    itxCollectedToday: booleanOption(values.itxCollectedToday, "--itx-collected-today"),
    // 빈 문자열은 입력 없음(정기 실행·재생이 아닌 dispatch)이다.
    replayRunId: values.replayRunId === "" ? undefined : values.replayRunId,
  });
  log(JSON.stringify(result));
  if (values.githubOutput) {
    await appendFile(values.githubOutput, [
      `state=${result.state}`, `reason=${result.reason}`, `branch=${result.branch ?? ""}`, `pr_number=${result.number ?? ""}`,
      `blocked_by=${(result.blockedBy ?? []).join(",")}`, `days_until_expiry=${result.daysUntilExpiry}`, `lapsed=${result.lapsed}`, `replay_run_id=${result.replayRunId ?? ""}`, "",
    ].join("\n"));
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
