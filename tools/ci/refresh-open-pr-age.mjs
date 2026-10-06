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
  "current-capital-topology-registration.yml": "automation/456-capital-topology-registration-",
  "nationwide-candidate-refresh.yml": "automation/927-nationwide-candidate-refresh-",
  "source-derivative-rebinding.yml": "automation/969-derivative-rebinding-",
});
// #969: source-snapshots.json·source-inventory.json에 행을 덧붙이는 자동화 workflow. 이 PR들은 같은 파일을 바꾸므로 동시에 하나만 연다.
// 후보 갱신은 원장을 쓰지 않아 여기에 넣지 않는다.
export const LEDGER_WRITER_WORKFLOWS = Object.freeze([
  "current-capital-topology-refresh.yml",
  "kric-current-facility-refresh.yml",
  "retained-gwangju-timetable-refresh.yml",
  "seoul-current-accessibility-refresh.yml",
  "current-capital-topology-registration.yml",
  "source-derivative-rebinding.yml",
]);
const LEDGER_PATH = "tools/datapack/release/source-snapshots.json";
// refresh-pr-required-ci가 돌려주는 열린 PR의 required CI 상태
const CI_STATES = Object.freeze(["ATTACHED", "PENDING", "REOPENED"]);
// PATH 검색 없이 고정 경로의 git을 쓴다(data-test-discovery와 같은 기준). GitHub Ubuntu runner와 macOS 모두 이 경로다.
const GIT_EXECUTABLE = "/usr/bin/git";
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

// 달력에 있는 UTC 시각만 받는다. 각 성분을 Date.UTC로 다시 만들어 같은 값인지 확인한다(2026-02-30 같은 값은 거부).
const UTC_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/u;
function instant(value) {
  const match = typeof value === "string" ? UTC_INSTANT.exec(value) : null;
  if (!match) fail("LIST_INVALID", `createdAt ${String(value)}`);
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const millis = Date.UTC(year, month - 1, day, hour, minute, second, Number((match[7] ?? "0").padEnd(3, "0")));
  const date = new Date(millis);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day
    || date.getUTCHours() !== hour || date.getUTCMinutes() !== minute || date.getUTCSeconds() !== second) {
    fail("LIST_INVALID", `createdAt ${value}`);
  }
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

function ledgerRows(ledger) {
  if (!Array.isArray(ledger) || ledger.some((row) => typeof row?.snapshotId !== "string")) fail("LEDGER_INVALID");
  return ledger;
}

// 원장 행의 원천 식별. claim 행에 있는 필드는 main 행에서도 같아야 한다(rebind가 바꾸는 결속 필드는 보지 않는다).
const ROW_IDENTITY_FIELDS = Object.freeze(["sourceId", "rawSha256", "contentSha256", "rawObjectSha256", "capturedAt"]);
const SNAPSHOT_REFERENCE = /"snapshotId"\s*:\s*"([^"]+)"/gu;
const references = (buffer) => new Set([...buffer.toString("utf8").matchAll(SNAPSHOT_REFERENCE)].map(([, id]) => id));

function fileReflected({ status, base, claim, main }) {
  if (status === "A") return Buffer.isBuffer(claim) && Buffer.isBuffer(main) && claim.equals(main);
  if (status === "D") return main === null;
  // 변경 파일(inventory 등): claim이 새로 넣은 snapshot 참조를 main도 모두 가리켜야 한다.
  if (!Buffer.isBuffer(claim) || !Buffer.isBuffer(base) || !Buffer.isBuffer(main)) return false;
  const before = references(base);
  const after = references(main);
  return [...references(claim)].filter((id) => !before.has(id)).every((id) => after.has(id));
}

/**
 * claim 브랜치의 갱신이 다른 PR(통합 PR 등)로 main에 반영됐는지 판정한다. 모두 만족할 때만 반영이다.
 * - claim이 원장에 추가한 행이 하나 이상 있고, 각 행이 main 원장에 같은 원천 식별(rawSha256 등)로 있다.
 * - claim이 추가한 파일은 main에 같은 바이트로 있고, 지운 파일은 main에도 없다.
 * - claim이 바꾼 파일(inventory 등)에 새로 넣은 snapshot 참조를 main 파일도 모두 가리킨다.
 */
export function claimReflectedInMain({ baseLedger, claimLedger, mainLedger, files }) {
  const base = new Set(ledgerRows(baseLedger).map(({ snapshotId }) => snapshotId));
  const main = new Map(ledgerRows(mainLedger).map((row) => [row.snapshotId, row]));
  const added = ledgerRows(claimLedger).filter(({ snapshotId }) => !base.has(snapshotId));
  if (!Array.isArray(files) || files.some((file) => typeof file?.path !== "string" || !["A", "M", "D"].includes(file.status))) {
    fail("FILES_INVALID");
  }
  const missingSnapshotIds = added.filter(({ snapshotId }) => !main.has(snapshotId)).map(({ snapshotId }) => snapshotId);
  const mismatchedSnapshotIds = added.filter((row) => main.has(row.snapshotId)
    && ROW_IDENTITY_FIELDS.some((field) => Object.hasOwn(row, field) && main.get(row.snapshotId)[field] !== row[field]))
    .map(({ snapshotId }) => snapshotId);
  const unreflectedPaths = files.filter((file) => !fileReflected(file)).map(({ path: relative }) => relative);
  return {
    reflected: added.length > 0 && missingSnapshotIds.length === 0 && mismatchedSnapshotIds.length === 0 && unreflectedPaths.length === 0,
    addedSnapshotIds: added.map(({ snapshotId }) => snapshotId),
    missingSnapshotIds,
    mismatchedSnapshotIds,
    unreflectedPaths,
  };
}

export function staleOpenRefreshPullRequestMessage({ stale, repository, reflection }) {
  const prefix = stale.branch.slice(0, stale.branch.lastIndexOf("-") + 1);
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
        : `Not yet on main — snapshots missing: ${reflection.missingSnapshotIds.join(", ") || "none"}; snapshots with different source identity: ${reflection.mismatchedSnapshotIds.join(", ") || "none"}; files: ${reflection.unreflectedPaths.join(", ") || "none"}.`,
      "Review and merge the pull request, or integrate it into another data pull request and then close it with --delete-branch.",
    );
  }
  return lines.join("\n");
}

/** origin의 main과 claim 브랜치를 받아, 둘의 merge-base(claim의 원본 main)와 비교해 반영 여부를 판정한다. */
export function inspectClaimReflection(branch, { cwd = process.cwd() } = {}) {
  const git = (args, encoding = "utf8") => execFileSync(GIT_EXECUTABLE, args, { cwd, encoding, maxBuffer: 512 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  const show = (ref, relative) => {
    try { return git(["show", `${ref}:${relative}`], "buffer"); } catch { return null; }
  };
  git(["fetch", "--no-tags", "origin", "refs/heads/main:refs/remotes/origin/main", `refs/heads/${branch}:refs/remotes/origin/${branch}`]);
  const claimRef = `origin/${branch}`;
  const base = git(["merge-base", "origin/main", claimRef]).trim();
  const readLedger = (ref) => JSON.parse(show(ref, LEDGER_PATH)?.toString("utf8") ?? "null");
  const files = git(["diff", "--no-renames", "--name-status", base, claimRef]).split("\n").filter(Boolean)
    .map((line) => line.split("\t"))
    .filter(([, relative]) => relative !== LEDGER_PATH)
    .map(([status, relative]) => ({
      path: relative, status, base: show(base, relative), claim: show(claimRef, relative), main: show("origin/main", relative),
    }));
  return claimReflectedInMain({
    baseLedger: readLedger(base), claimLedger: readLedger(claimRef), mainLedger: readLedger("origin/main"), files,
  });
}

function parseArgs(argv) {
  const keys = new Map([["--workflow", "workflow"], ["--prs", "prs"], ["--policy", "policy"], ["--repository", "repository"], ["--ci-state", "ciState"]]);
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = keys.get(argv[index]);
    if (!key || Object.hasOwn(values, key) || typeof argv[index + 1] !== "string") fail("CLI");
    values[key] = argv[index + 1];
  }
  if (!["workflow", "prs", "policy", "repository"].every((key) => Object.hasOwn(values, key))) fail("CLI");
  if (values.ciState !== undefined && !CI_STATES.includes(values.ciState)) fail("CLI", `--ci-state ${values.ciState}`);
  return values;
}

export async function main(argv, { now = new Date(), inspect = inspectClaimReflection, log = console.log } = {}) {
  const { workflow, prs, policy, repository, ciState } = parseArgs(argv);
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
  const message = staleOpenRefreshPullRequestMessage({ stale: result, repository, reflection: inspect(result.branch) });
  throw new Error(ciState ? `${message}\nRequired CI (pull_request) on the head: ${ciState}` : message);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
