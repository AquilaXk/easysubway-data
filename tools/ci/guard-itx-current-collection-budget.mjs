import { writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { COLLECTION_REPOSITORY, COLLECTION_WINDOW_REASON, CollectionWindowError, inspectCollectionWindow } from "./collection-run-window.mjs";
import { INTERNAL_ERROR_REASON, formatReasonLine } from "./failure-reason.mjs";
import { ITX_COLLECTION_LEDGER_SCHEMA_VERSION, ITX_COLLECTION_OUTCOME, evaluateItxCollectionAllowance } from "./itx-collection-allowance.mjs";
import { readCollectionRequestCount } from "./itx-collection-evidence.mjs";

// artifactPrefix: 이 workflow가 실패해도 올리는 증거 artifact(`<prefix>-<run id>`)의 이름. 없으면 실패한 run이 보낸 요청 수를 증명할 수 없다(#1298).
const COLLECTION_CONTEXTS = [
  {
    workflowFile: "itx-current-collection.yml",
    events: ["workflow_dispatch"],
    jobName: "ITX current collection",
    collectorStepName: "ITX current collection / Collect ITX current timetable",
    artifactPrefix: "itx-current-collection",
  },
  {
    workflowFile: "current-capital-topology-refresh.yml",
    events: ["schedule", "workflow_dispatch"],
    jobName: "Current topology refresh",
    collectorStepName: "Collect current ITX timetable once",
    artifactPrefix: "current-capital-topology-refresh-itx-review",
  },
  // #977: ITX 원천 시간표 자동 승격 workflow도 같은 KST 하루 공급자 호출 예산을 나눠 쓴다.
  {
    workflowFile: "itx-current-promotion.yml",
    events: ["schedule", "workflow_dispatch"],
    jobName: "ITX current promotion",
    collectorStepName: "Collect current ITX timetable",
    artifactPrefix: "itx-current-promotion",
  },
];
const ALLOW_AFTER_FAILURE_FLAG = "--allow-after-failure";
const FAILURE_MESSAGE = "ITX current collection quota guard failed";

/**
 * 가드가 실패하는 이유의 전부. 실패마다 정확히 하나가 stderr 마지막 줄(reason=)과 실패 영수증에 남는다(2026-10-22 장애 때 모든 실패가 같은 한 줄이라 원인을 알 수 없었다).
 * 판정(허용·거부)은 사유와 무관하다: 어느 사유든 가드는 막는다(fail closed). run 창을 읽는 사유는 collection-run-window의 것을 그대로 쓴다.
 */
export const GUARD_REASON = Object.freeze({
  ...COLLECTION_WINDOW_REASON,
  ARGUMENT_INVALID: "ARGUMENT_INVALID", // CLI 인자·출력 경로가 기대와 다르다
  QUOTA_EXHAUSTED: "QUOTA_EXHAUSTED", // 정상적인 예산 거부: 같은 날 이미 수집했거나 시도·요청 예산을 썼다
  RECEIPT_WRITE_FAILED: "RECEIPT_WRITE_FAILED", // 실패 영수증을 쓰지 못했다(처음 실패의 사유는 cause=)
  LEDGER_WRITE_FAILED: "LEDGER_WRITE_FAILED", // 수집 기록 파일을 쓰지 못했다
  INTERNAL_ERROR: INTERNAL_ERROR_REASON, // 위 어디에도 속하지 않는 예기치 못한 예외(원문은 비밀이 섞일 수 있어 남기지 않는다)
});

/** 가드 실패. 메시지는 기존 고정 문구 그대로이고, 사유는 코드와 숫자·이름만 담는다. */
export class ItxCollectionGuardError extends Error {
  /** @param {string} reason GUARD_REASON 값 @param {{ httpStatus?: number, workflow?: string, allowance?: string, causeReason?: string }} details */
  constructor(reason, { httpStatus, workflow, allowance, causeReason } = {}) {
    super(FAILURE_MESSAGE);
    this.reason = reason;
    this.httpStatus = httpStatus;
    this.workflow = workflow;
    this.allowance = allowance;
    this.causeReason = causeReason;
  }
}

function failure(reason, details) {
  return new ItxCollectionGuardError(reason, details);
}

function asGuardError(error) {
  if (error instanceof ItxCollectionGuardError) return error;
  if (error instanceof CollectionWindowError) return failure(error.reason, { httpStatus: error.httpStatus, workflow: error.workflow });
  return failure(GUARD_REASON.INTERNAL_ERROR);
}

// 같은 KST 날의 ITX 수집 workflow 실행을 모두 읽어, 이 run 밖에서 collector에 들어간 실행과 그 결과를 돌려준다.
async function inspectItxCollectionWindow({ env, now, fetchImpl }) {
  try {
    return await inspectCollectionWindow({ env, now, fetchImpl, contexts: COLLECTION_CONTEXTS });
  } catch (error) {
    throw asGuardError(error);
  }
}

// 종료 시각은 collector step의 completed_at이다. run.updated_at은 재실행과 뒤이은 job 갱신으로 움직인다.
async function ledgerEntry({ run, context, outcome, completedAt }, { token, downloadArtifact }) {
  const entry = { runId: run.id, workflowFile: context.workflowFile, outcome, endedAt: null, requestCount: null };
  if (outcome !== ITX_COLLECTION_OUTCOME.FAILED) return entry;
  return {
    ...entry,
    endedAt: completedAt,
    requestCount: await readCollectionRequestCount({
      repository: COLLECTION_REPOSITORY,
      runId: run.id,
      artifactName: context.artifactPrefix === null ? null : `${context.artifactPrefix}-${run.id}`,
      token,
      downloadArtifact,
    }),
  };
}

/**
 * 같은 KST 날 이 run 밖에서 collector에 들어간 수집의 기록(#1298): 결과(성공·진행 중·실패), 실패한 수집의 종료 시각과 실제 요청 수.
 * 요청 수는 실패한 run의 증거 artifact에서만 읽고, 읽지 못하면 null로 남긴다(itx-collection-allowance가 증거 없음으로 막는다).
 */
export async function readItxCollectionLedger({ env = process.env, now = new Date(), fetchImpl = globalThis.fetch, downloadArtifact } = {}) {
  const { runId, window, token, entered } = await inspectItxCollectionWindow({ env, now, fetchImpl });
  const entries = [];
  for (const candidate of entered) entries.push(await ledgerEntry(candidate, { token, downloadArtifact }));
  entries.sort((left, right) => left.runId - right.runId);
  return { repository: COLLECTION_REPOSITORY, runId, quotaWindow: window.label, entries };
}

/**
 * 수집 직전 가드. 기본은 같은 KST 날 collector에 들어간 다른 실행이 하나라도 있으면 막는다.
 * allowAfterFailure(승격 workflow만)는 앞선 수집이 실패뿐이고 하루 시도 상한·요청 예산 안일 때 다시 허용한다. 최소 간격은 판정 단계의 정책이라 여기서는 보지 않는다.
 */
export async function guardItxCurrentCollectionBudget({
  argv = [],
  env = process.env,
  now = new Date(),
  fetchImpl = globalThis.fetch,
  allowAfterFailure = false,
  downloadArtifact,
} = {}) {
  if (!Array.isArray(argv) || argv.length !== 0 || typeof allowAfterFailure !== "boolean") throw failure(GUARD_REASON.ARGUMENT_INVALID);
  if (allowAfterFailure) {
    const { runId, quotaWindow, entries } = await readItxCollectionLedger({ env, now, fetchImpl, downloadArtifact });
    const allowance = evaluateItxCollectionAllowance({ entries, now, skipRetryGap: true });
    if (!allowance.allowed) throw failure(GUARD_REASON.QUOTA_EXHAUSTED, { allowance: allowance.reason });
    return { repository: COLLECTION_REPOSITORY, runId, quotaWindow, otherRunCount: entries.length };
  }
  const { runId, window, entered } = await inspectItxCollectionWindow({ env, now, fetchImpl });
  if (entered.length > 0) throw failure(GUARD_REASON.QUOTA_EXHAUSTED);
  return {
    repository: COLLECTION_REPOSITORY,
    runId,
    quotaWindow: window.label,
    otherRunCount: 0,
  };
}

/**
 * 오늘 ITX를 더 수집하지 않아야 하는지 실패 없이 알려 준다(#977, #1298). topology 갱신 판정이 공급자 호출 전에 이것을 보고 정상 종료(WAIT)한다.
 * collectedToday가 true인 경우: 성공·진행 중 수집이 있다, 마지막 실패 뒤 최소 간격 전이다, 하루 시도 상한·요청 예산을 썼다, 쓴 요청 수를 증명할 수 없다.
 * 승격 workflow와 같은 allowance 규칙이라, 실패만 한 날은 예산 안에서 두 workflow 모두 다시 수집한다. 읽을 수 없으면 추정하지 않고 실패한다.
 */
export async function probeItxCollectionToday({
  env = process.env,
  now = new Date(),
  fetchImpl = globalThis.fetch,
  downloadArtifact,
} = {}) {
  const { runId, quotaWindow, entries } = await readItxCollectionLedger({ env, now, fetchImpl, downloadArtifact });
  return { repository: COLLECTION_REPOSITORY, runId, quotaWindow, collectedToday: !evaluateItxCollectionAllowance({ entries, now }).allowed };
}

function absolutePath(value) {
  if (typeof value !== "string" || !path.isAbsolute(value)) throw failure(GUARD_REASON.ARGUMENT_INVALID);
  return value;
}

function receiptOutput(argv) {
  if (!Array.isArray(argv) || argv.length !== 2 || argv[0] !== "--output"
    || typeof argv[1] !== "string" || !path.isAbsolute(argv[1]) || path.basename(argv[1]) !== "freshness.json") {
    throw failure(GUARD_REASON.ARGUMENT_INVALID);
  }
  return argv[1];
}

// 영수증에는 사유 코드와 숫자·이름만 남긴다(reason, httpStatus, workflow, allowance). 값이 없는 키는 JSON에서 빠진다.
async function writeFailureReceipt(output, { reason, httpStatus, workflow, allowance }) {
  const receipt = {
    schemaVersion: 1,
    artifactKind: "itx-current-collection-preflight",
    status: "FAILED",
    operation: "KST_PROVIDER_ENTRY_QUOTA",
    providerCalls: 0,
    candidateCreated: false,
    credentialRedacted: true,
    reason,
    httpStatus,
    workflow,
    allowance,
  };
  try {
    await writeFile(output, `${JSON.stringify(receipt)}\n`, { flag: "wx", mode: 0o644 });
  } catch {
    throw failure(GUARD_REASON.RECEIPT_WRITE_FAILED, { causeReason: reason });
  }
}

// 가드 인자: --output <절대 경로>/freshness.json [--allow-after-failure]
function guardCliArgs(argv) {
  const allowAfterFailure = Array.isArray(argv) && argv.length === 3 && argv[2] === ALLOW_AFTER_FAILURE_FLAG;
  return { output: receiptOutput(allowAfterFailure ? argv.slice(0, 2) : argv), allowAfterFailure };
}

export async function runItxCurrentCollectionBudgetGuardCli({
  argv = process.argv.slice(2),
  env = process.env,
  now = new Date(),
  fetchImpl = globalThis.fetch,
  downloadArtifact,
} = {}) {
  const { output, allowAfterFailure } = guardCliArgs(argv);
  try {
    return await guardItxCurrentCollectionBudget({ argv: [], env, now, fetchImpl, allowAfterFailure, downloadArtifact });
  } catch (error) {
    const failed = asGuardError(error);
    await writeFailureReceipt(output, failed);
    throw failed;
  }
}

/**
 * 같은 KST 날 수집 기록을 파일로 쓴다(--ledger <절대 경로>). 승격 판정이 공급자 호출 전에 읽는다. 이미 있는 파일은 덮어쓰지 않는다.
 * 읽을 수 없으면 추정하지 않고 실패한다.
 */
export async function runItxCollectionLedgerCli({
  argv = process.argv.slice(2),
  env = process.env,
  now = new Date(),
  fetchImpl = globalThis.fetch,
  downloadArtifact,
} = {}) {
  if (!Array.isArray(argv) || argv.length !== 2 || argv[0] !== "--ledger") throw failure(GUARD_REASON.ARGUMENT_INVALID);
  const output = absolutePath(argv[1]);
  let ledger;
  try {
    ledger = await readItxCollectionLedger({ env, now, fetchImpl, downloadArtifact });
  } catch (error) {
    throw asGuardError(error);
  }
  const { quotaWindow, entries } = ledger;
  try {
    await writeFile(output, `${JSON.stringify({ schemaVersion: ITX_COLLECTION_LEDGER_SCHEMA_VERSION, quotaWindow, entries })}\n`, { flag: "wx", mode: 0o644 });
  } catch {
    throw failure(GUARD_REASON.LEDGER_WRITE_FAILED);
  }
  return { quotaWindow, entries };
}

// 실패하면 기존 고정 문구 줄 뒤에 사유 줄(reason=...)을 stderr에 쓴다. 문구를 읽는 쪽은 첫 줄만 보면 된다.
async function main() {
  const argv = process.argv.slice(2);
  try {
    if (argv.length === 1 && argv[0] === "--probe") {
      const { collectedToday } = await probeItxCollectionToday();
      process.stdout.write(`${collectedToday}\n`);
    } else if (argv[0] === "--ledger") {
      await runItxCollectionLedgerCli();
    } else {
      process.stdout.write(`${JSON.stringify(await runItxCurrentCollectionBudgetGuardCli())}\n`);
    }
  } catch (error) {
    process.stderr.write(`${FAILURE_MESSAGE}\n${formatReasonLine(asGuardError(error))}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main();
}
