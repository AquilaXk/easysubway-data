#!/usr/bin/env node
// 원천 원장 변화 게이트(#969, #975 리뷰 F5). 등록·재확인·재결속 PR이 올라가기 전에 원장(source-snapshots.json)의 변화를 판정한다.
// 2단계(데이터 전용 PR 자동 병합)도 같은 판정을 쓴다. 정책은 tools/ci/source-ledger-change-policy.json에 있고 코드에 한도 숫자를 두지 않는다.
//
// 이상 코드(체인을 멈추고 이슈로 드러난다):
//   SOURCE_SHA_DRIFT   이미 있던 행의 원천 식별(rawSha256·contentSha256·rowCount·coverageCount·previousSnapshotId)이 바뀌었다.
//                      또는 정책이 내용 변경을 막는 원천에서 새 행의 contentSha256이 직전 head와 다르다.
//   SOURCE_COUNT_DELTA 새 행의 행 수 변화가 직전 head 대비 한도(비율)를 넘거나 커버리지가 줄었다.
//   BINDING_MISMATCH   새 행의 필수 필드·직전 연결이 어긋났거나 diffSummary가 실제 차이와 다르다. 행이 사라졌다.
//
// 사용: node tools/ci/source-ledger-gate.mjs --base-sha <sha> [--policy <path>] [--ledger <path>] [--output <path>]
//   base 커밋의 원장과 작업 트리의 원장을 비교한다. 위반이 없으면 --output에 { policy, sources }를 쓴다(PR 증거 블록의 입력).
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";


const DEFAULT_LEDGER = "tools/datapack/release/source-snapshots.json";
const DEFAULT_POLICY = "tools/ci/source-ledger-change-policy.json";
const GIT = "/usr/bin/git";
const SHA = /^[0-9a-f]{40}$/u;
const IDENTITY_FIELDS = Object.freeze(["rawSha256", "contentSha256", "rowCount", "coverageCount", "previousSnapshotId"]);
const POLICY_KEYS = Object.freeze(["schemaVersion", "issue", "allowContentChange", "maxRowDeltaRatio", "allowCoverageDecrease", "sourceOverrides"]);
const OVERRIDE_KEYS = Object.freeze(["allowContentChange", "maxRowDeltaRatio", "allowCoverageDecrease"]);

function fail(code, detail = "") {
  throw new Error(detail ? `${code}: ${detail}` : code);
}

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const sameKeys = (value, keys) => isObject(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const isRatio = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
const isCount = (value) => Number.isSafeInteger(value) && value >= 0;

function validOverride(value) {
  return isObject(value) && Object.keys(value).every((key) => OVERRIDE_KEYS.includes(key))
    && (!Object.hasOwn(value, "allowContentChange") || typeof value.allowContentChange === "boolean")
    && (!Object.hasOwn(value, "allowCoverageDecrease") || typeof value.allowCoverageDecrease === "boolean")
    && (!Object.hasOwn(value, "maxRowDeltaRatio") || isRatio(value.maxRowDeltaRatio));
}

/** 알려진 키와 값만 받는다. 모르는 키·잘못된 값은 조용히 무시하지 않고 실패한다. */
export function parseLedgerChangePolicy(value) {
  const invalid = (detail) => fail("LEDGER_CHANGE_POLICY_INVALID", detail);
  if (!sameKeys(value, POLICY_KEYS)) invalid("keys");
  if (value.schemaVersion !== 1 || value.issue !== 969) invalid("schemaVersion or issue");
  if (typeof value.allowContentChange !== "boolean" || typeof value.allowCoverageDecrease !== "boolean" || !isRatio(value.maxRowDeltaRatio)) invalid("global values");
  if (!isObject(value.sourceOverrides) || !Object.values(value.sourceOverrides).every(validOverride)) invalid("sourceOverrides");
  return value;
}

const percent = (ratio) => `${(ratio * 100).toFixed(1)}%`;

/**
 * base 원장과 head 원장을 비교한다. 새 행마다 직전 head 대비 변화를 증거로 남기고 정책 위반을 모은다.
 * @returns {{ sources: object[], violations: { code: string, sourceId: string, snapshotId: string, detail: string }[] }}
 */
export function evaluateLedgerChange({ baseLedger, headLedger, policy } = {}) {
  if (!Array.isArray(baseLedger) || !Array.isArray(headLedger)) fail("LEDGER_CHANGE_INPUT_INVALID", "ledgers must be arrays");
  parseLedgerChangePolicy(policy);
  const violations = [];
  const sources = [];
  const violate = (code, row, detail) => violations.push({ code, sourceId: String(row?.sourceId), snapshotId: String(row?.snapshotId), detail });
  const head = new Map(headLedger.map((row) => [row?.snapshotId, row]));
  const base = new Map(baseLedger.map((row) => [row?.snapshotId, row]));

  for (const [snapshotId, before] of base) {
    const after = head.get(snapshotId);
    if (!after) { violate("BINDING_MISMATCH", before, "the ledger row was removed"); continue; }
    const changed = IDENTITY_FIELDS.filter((field) => before[field] !== after[field]);
    if (changed.length > 0) violate("SOURCE_SHA_DRIFT", before, `an existing row changed its source identity (${changed.join(", ")})`);
  }

  for (const row of headLedger) {
    if (base.has(row?.snapshotId)) continue;
    const effective = { ...policy, ...(policy.sourceOverrides[row?.sourceId] ?? {}) };
    if (typeof row?.sourceId !== "string" || typeof row.snapshotId !== "string" || !/^[a-f0-9]{64}$/u.test(row.rawSha256 ?? "")
      || !/^[a-f0-9]{64}$/u.test(row.contentSha256 ?? "") || !isCount(row.rowCount) || !isCount(row.coverageCount)) {
      violate("BINDING_MISMATCH", row, "a new row lacks sourceId, snapshotId, rawSha256, contentSha256, rowCount or coverageCount");
      continue;
    }
    const previousId = row.previousSnapshotId ?? null;
    const previous = previousId === null ? null : head.get(previousId);
    if (previousId !== null && (!previous || previous.sourceId !== row.sourceId)) {
      violate("BINDING_MISMATCH", row, `previousSnapshotId ${previousId} is not an earlier row of the same source`);
      continue;
    }
    let rowDelta = 0;
    let coverageDelta = 0;
    if (previous) {
      if (!isCount(previous.rowCount) || !isCount(previous.coverageCount) || !/^[a-f0-9]{64}$/u.test(previous.contentSha256 ?? "")) {
        violate("BINDING_MISMATCH", row, `the previous row ${previousId} lacks counts or contentSha256`);
        continue;
      }
      rowDelta = row.rowCount - previous.rowCount;
      coverageDelta = row.coverageCount - previous.coverageCount;
      const recorded = row.diffSummary;
      if (isObject(recorded) && ((Number.isFinite(recorded.rowDelta) && recorded.rowDelta !== rowDelta)
        || (Number.isFinite(recorded.coverageDelta) && recorded.coverageDelta !== coverageDelta))) {
        violate("BINDING_MISMATCH", row, `diffSummary (${recorded.rowDelta}, ${recorded.coverageDelta}) differs from the ledger counts (${rowDelta}, ${coverageDelta})`);
      }
      if (row.contentSha256 !== previous.contentSha256 && !effective.allowContentChange) {
        violate("SOURCE_SHA_DRIFT", row, `contentSha256 changed from ${previous.contentSha256.slice(0, 12)} to ${row.contentSha256.slice(0, 12)} and the policy does not allow content change`);
      }
      const ratio = Math.abs(rowDelta) / Math.max(previous.rowCount, 1);
      if (ratio > effective.maxRowDeltaRatio) {
        violate("SOURCE_COUNT_DELTA", row, `rowDelta ${rowDelta} (${percent(ratio)}) exceeds ${percent(effective.maxRowDeltaRatio)}`);
      }
      if (coverageDelta < 0 && !effective.allowCoverageDecrease) violate("SOURCE_COUNT_DELTA", row, `coverageDelta ${coverageDelta} decreases coverage`);
    }
    sources.push({
      sourceId: row.sourceId, snapshotId: row.snapshotId, previousSnapshotId: previousId, rawSha256: row.rawSha256, contentSha256: row.contentSha256,
      rowDelta, coverageDelta, diffStatus: previous ? (typeof row.diffSummary?.status === "string" ? row.diffSummary.status : "UNKNOWN") : "FIRST",
    });
  }
  return { sources, violations };
}

function parseArgs(argv) {
  const keys = new Map([["--base-sha", "baseSha"], ["--policy", "policy"], ["--ledger", "ledger"], ["--output", "output"]]);
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = keys.get(argv[index]);
    if (!key || Object.hasOwn(values, key) || typeof argv[index + 1] !== "string") fail("LEDGER_CHANGE_INPUT_INVALID", `argument ${String(argv[index])}`);
    values[key] = argv[index + 1];
  }
  if (!SHA.test(values.baseSha ?? "")) fail("LEDGER_CHANGE_INPUT_INVALID", "--base-sha must be a 40-hex commit");
  return values;
}

export async function main(argv, { cwd = process.cwd(), log = console.log } = {}) {
  const values = parseArgs(argv);
  const ledgerPath = values.ledger ?? DEFAULT_LEDGER;
  const policy = parseLedgerChangePolicy(JSON.parse(await readFile(path.resolve(cwd, values.policy ?? DEFAULT_POLICY), "utf8")));
  const baseLedger = JSON.parse(execFileSync(GIT, ["show", `${values.baseSha}:${ledgerPath}`], { cwd, encoding: "utf8", maxBuffer: 512 * 1024 * 1024 }));
  const headLedger = JSON.parse(await readFile(path.resolve(cwd, ledgerPath), "utf8"));
  const result = evaluateLedgerChange({ baseLedger, headLedger, policy });
  if (result.violations.length > 0) {
    throw new Error(result.violations.map(({ code, sourceId, snapshotId, detail }) => `${code}: ${sourceId} ${snapshotId}: ${detail}`).join("\n"));
  }
  if (values.output) await writeFile(path.resolve(cwd, values.output), `${JSON.stringify({ policy, sources: result.sources }, null, 2)}\n`, { flag: "wx" });
  log(`source ledger change gate passed: ${result.sources.length} new row(s)`);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2), { cwd: process.cwd() }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
