#!/usr/bin/env node
// #939: 정기 원천 갱신 workflow의 열린 갱신 PR 상한.
// decide/classify는 열린 갱신 PR이 있으면 OPEN_PR로 판단하고 이후 단계를 건너뛴 채 성공한다. 그 PR이 방치되면 원천 갱신이
// 신호 없이 멈춘다. 이 검사는 PR이 열린 지 상한을 넘으면 job을 실패시킨다. 그러면 failure() 단계의 report-refresh-failure가
// 실패 이슈를 만들거나 갱신하고 하루 한 번 댓글로 알린다(#926 경로).
//
// 상한 = 신선도 정책 monitoring.manualCheckCadence(현재 P1D). 근거:
// - 갱신 workflow는 원천 만료 monitoring.alertBeforePackExpiry(PT6H) 전에 DUE가 되어 PR을 만든다.
//   PR이 그 창을 넘겨 열려 있으면 main의 원천은 이미 만료됐거나 곧 만료된다.
// - 정책은 사람이 하루 한 번 확인한다고 정한다(manualCheckCadence). 자동 PR이 한 확인 주기 안에 처리되지 않으면 멈춤으로 본다.
// - 정책 값을 그대로 읽어 상수를 새로 만들지 않는다. 정책이 바뀌면 상한도 함께 바뀐다.
//
// 사용: node tools/ci/refresh-open-pr-age.mjs --workflow <file> --prs <open PR list JSON> --policy <freshness policy JSON> --repository <owner/repo>
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const REFRESH_CLAIM_PREFIXES = Object.freeze({
  "current-capital-topology-refresh.yml": "automation/636-current-topology-refresh-",
  "kric-current-facility-refresh.yml": "automation/629-kric-facility-refresh-",
  "retained-gwangju-timetable-refresh.yml": "automation/504-retained-gwangju-timetable-refresh-",
  "seoul-current-accessibility-refresh.yml": "automation/639-seoul-accessibility-refresh-",
});
const LEDGER_PATH = "tools/datapack/release/source-snapshots.json";
const DURATION = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/u;

function fail(code, detail = "") {
  throw new Error(detail ? `REFRESH_OPEN_PR_${code}: ${detail}` : `REFRESH_OPEN_PR_${code}`);
}

export function isoDurationMs(value) {
  const match = typeof value === "string" ? DURATION.exec(value) : null;
  if (!match || value === "P" || value.endsWith("T") || match.slice(1).every((part) => part === undefined)) fail("POLICY_INVALID", String(value));
  const [days, hours, minutes, seconds] = match.slice(1).map((part) => Number(part ?? 0));
  return (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1_000;
}

export function openRefreshPullRequestLimitMs(policy) {
  const limit = isoDurationMs(policy?.monitoring?.manualCheckCadence);
  if (limit <= 0) fail("POLICY_INVALID", "monitoring.manualCheckCadence must be positive");
  return limit;
}

function instant(value) {
  const millis = typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== new Date(value).toISOString()
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(value)) fail("LIST_INVALID", `createdAt ${String(value)}`);
  return millis;
}

export function evaluateOpenRefreshPullRequest({ pullRequests, prefix, repository, policy, now = new Date() }) {
  if (!Object.values(REFRESH_CLAIM_PREFIXES).includes(prefix)) fail("PREFIX_INVALID", String(prefix));
  if (!Array.isArray(pullRequests) || typeof repository !== "string") fail("LIST_INVALID");
  const limitMs = openRefreshPullRequestLimitMs(policy);
  const owned = pullRequests.filter((item) => typeof item?.headRefName === "string" && item.headRefName.startsWith(prefix)
    && item.baseRefName === "main" && item.isCrossRepository === false);
  if (owned.length === 0) return { state: "NONE" };
  if (owned.length > 1) fail("DUPLICATE", owned.map(({ number }) => `#${number}`).join(", "));
  const [open] = owned;
  if (!Number.isSafeInteger(open.number) || open.number < 1 || typeof open.url !== "string"
    || !open.url.startsWith(`https://github.com/${repository}/pull/`)) fail("LIST_INVALID", "number/url");
  const openedMillis = instant(open.createdAt);
  const nowMillis = now instanceof Date ? now.getTime() : Number.NaN;
  if (!Number.isFinite(nowMillis)) fail("CLOCK_INVALID");
  const deadlineMillis = openedMillis + limitMs;
  if (nowMillis < deadlineMillis) return { state: "WITHIN_LIMIT", number: open.number, deadline: new Date(deadlineMillis).toISOString() };
  return {
    state: "STALE",
    number: open.number,
    url: open.url,
    branch: open.headRefName,
    openedAt: new Date(openedMillis).toISOString(),
    limit: policy.monitoring.manualCheckCadence,
    deadline: new Date(deadlineMillis).toISOString(),
  };
}

function snapshotIds(ledger) {
  if (!Array.isArray(ledger) || ledger.some((row) => typeof row?.snapshotId !== "string")) fail("LEDGER_INVALID");
  return ledger.map(({ snapshotId }) => snapshotId);
}

/** claim 브랜치가 원장에 추가한 snapshot이 모두 main 원장에 있으면, 그 갱신은 다른 PR(통합 PR 등)로 main에 반영된 것이다. */
export function claimReflectedInMain({ baseLedger, claimLedger, mainLedger }) {
  const base = new Set(snapshotIds(baseLedger));
  const main = new Set(snapshotIds(mainLedger));
  const addedSnapshotIds = snapshotIds(claimLedger).filter((id) => !base.has(id));
  const missingSnapshotIds = addedSnapshotIds.filter((id) => !main.has(id));
  return { reflected: addedSnapshotIds.length > 0 && missingSnapshotIds.length === 0, addedSnapshotIds, missingSnapshotIds };
}

export function staleOpenRefreshPullRequestMessage({ stale, repository, reflection }) {
  const prefix = stale.branch.replace(/[0-9]+$/u, "");
  const lines = [
    `REFRESH_OPEN_PR_STALE: #${stale.number} (${stale.branch}) opened at ${stale.openedAt} exceeded the open refresh PR limit ${stale.limit} (deadline ${stale.deadline}).`,
    `The scheduled refresh stays paused while this pull request is open: ${stale.url}`,
  ];
  if (reflection.reflected) {
    lines.push(
      `Every source snapshot this claim registered is already on main (${reflection.addedSnapshotIds.join(", ")}). Close it and delete the claim branch so the next scheduled run can claim a new refresh:`,
      `  gh pr close ${stale.number} --repo ${repository} --delete-branch --comment "이 갱신은 이미 main에 반영됐다. claim 브랜치를 지워 다음 정기 실행이 새 claim으로 진행하게 한다."`,
      `  git ls-remote --heads https://github.com/${repository} 'refs/heads/${prefix}*'   # must print nothing`,
    );
  } else {
    lines.push(
      reflection.addedSnapshotIds.length === 0
        ? "The claim branch registered no source snapshot, so whether main already has this refresh cannot be determined."
        : `Snapshots not yet on main: ${reflection.missingSnapshotIds.join(", ")}.`,
      "Review and merge the pull request, or integrate it into another data pull request and then close it with --delete-branch.",
    );
  }
  return lines.join("\n");
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 512 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
}

function readLedgerAt(ref) {
  return JSON.parse(git(["show", `${ref}:${LEDGER_PATH}`]));
}

export function inspectClaimReflection(branch) {
  git(["fetch", "--no-tags", "origin", `refs/heads/main:refs/remotes/origin/main`, `refs/heads/${branch}:refs/remotes/origin/${branch}`]);
  const base = git(["merge-base", "origin/main", `origin/${branch}`]).trim();
  return claimReflectedInMain({
    baseLedger: readLedgerAt(base),
    claimLedger: readLedgerAt(`origin/${branch}`),
    mainLedger: readLedgerAt("origin/main"),
  });
}

function parseArgs(argv) {
  const keys = new Map([["--workflow", "workflow"], ["--prs", "prs"], ["--policy", "policy"], ["--repository", "repository"]]);
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = keys.get(argv[index]);
    if (!key || Object.hasOwn(values, key) || typeof argv[index + 1] !== "string") fail("CLI");
    values[key] = argv[index + 1];
  }
  if (Object.keys(values).length !== keys.size) fail("CLI");
  return values;
}

export async function main(argv, { now = new Date(), inspect = inspectClaimReflection, log = console.log } = {}) {
  const { workflow, prs, policy, repository } = parseArgs(argv);
  const prefix = REFRESH_CLAIM_PREFIXES[workflow];
  if (!prefix) fail("WORKFLOW_INVALID", workflow);
  const result = evaluateOpenRefreshPullRequest({
    pullRequests: JSON.parse(await readFile(prs, "utf8")),
    prefix,
    repository,
    policy: JSON.parse(await readFile(policy, "utf8")),
    now,
  });
  // decide/classify가 OPEN_PR라고 판단했는데 열린 PR을 찾지 못하면 판단 근거가 어긋난 것이다.
  if (result.state === "NONE") fail("MISSING", `no open ${prefix}* pull request`);
  if (result.state === "WITHIN_LIMIT") {
    log(`open refresh pull request #${result.number} is within its limit until ${result.deadline}`);
    return result;
  }
  throw new Error(staleOpenRefreshPullRequestMessage({ stale: result, repository, reflection: inspect(result.branch) }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
