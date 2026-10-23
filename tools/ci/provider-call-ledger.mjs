#!/usr/bin/env node
// 같은 KST 날 원천 재확인 run이 공급자에 보낸 요청 수를 원천(operation)별로 읽는다(Refs AquilaXk/easysubway#3036). ITX 수집 기록(guard-itx-current-collection-budget --ledger, #1298)과
// 같은 방식이다: 앞선 run마다 수집 step에 들어갔는지 jobs API로 보고, 들어간 run은 실패해도 올리는 증거 artifact(시도별 계측 파일)에서 요청 수를 센다.
// 이 run 자신은 세지 않는다(아직 공급자를 부르지 않았다). 판정(decide-source-reverification)이 이 기록과 예산 정책으로 묶음 시작 여부를 정한다.
//
// 읽지 못한 요청 수는 0이나 추정치가 아니라 null이다. run 창 자체를 읽지 못하면 기록 전체를 unreadableReason으로 쓴다. 어느 쪽이든 예산 대상 묶음만 막힌다.
//
// 사용: node tools/ci/provider-call-ledger.mjs --ledger <절대 경로>
//   환경: GITHUB_REPOSITORY, GITHUB_EVENT_NAME, GITHUB_REF, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT(1만), GITHUB_TOKEN(actions: read)
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { COLLECTION_OUTCOME, COLLECTION_REPOSITORY, CollectionWindowError, downloadArtifactWithGh, inspectCollectionWindow, readEvidenceFile } from "./collection-run-window.mjs";
import { INTERNAL_ERROR_REASON } from "./failure-reason.mjs";
import { PROVIDER_CALL_LEDGER_SCHEMA_VERSION } from "./provider-call-budget.mjs";

/** source-reverification이 매 run 올리는 증거 artifact(`<artifactPrefix>-<run id>`)와 그 안의 시도별 계측 파일. */
export const SOURCE_REVERIFICATION_CALL_EVIDENCE = Object.freeze({
  workflowFile: "source-reverification.yml",
  events: Object.freeze(["schedule", "workflow_dispatch"]),
  jobName: "Source reverification",
  collectorStepName: "Reverify due P7D sources",
  artifactPrefix: "source-reverification-calls",
  file: "source-fetch-telemetry.jsonl",
  // 한 run의 시도는 재시도를 다 써도 수천 건이고 한 줄은 약 200바이트다. 그보다 큰 파일은 정상 계측이 아니다.
  maxBytes: 16 * 1024 * 1024,
});

// source-fetch-telemetry의 기록 형식: 원천 id는 안전한 토큰, 시도 번호는 1부터, 결과는 네 가지다.
const SOURCE_ID = /^[A-Za-z0-9._-]{1,48}$/u;
const ATTEMPT_OUTCOMES = new Set(["success", "http_error", "retryable_result", "error"]);

function telemetryInvalid(detail) {
  throw new Error(`PROVIDER_CALL_TELEMETRY_INVALID: ${detail}`);
}

function attemptSourceId(line, index) {
  let record;
  try {
    record = JSON.parse(line);
  } catch {
    return telemetryInvalid(`line ${index + 1} is not JSON`);
  }
  if (record === null || typeof record !== "object" || Array.isArray(record)
    || typeof record.sourceId !== "string" || !SOURCE_ID.test(record.sourceId)
    || !Number.isSafeInteger(record.attempt) || record.attempt < 1 || !ATTEMPT_OUTCOMES.has(record.outcome)) {
    return telemetryInvalid(`line ${index + 1} is not an attempt record`);
  }
  return record.sourceId;
}

/** 시도별 계측 파일(JSONL)의 원천 id별 시도 수. 공급자에 닿지 못한 시도(전송 오류)도 센다. 빈 파일은 0건이고, 읽을 수 없는 줄이 하나라도 있으면 실패한다. */
export function countTelemetryRequests(bytes) {
  const text = bytes.toString("utf8");
  const counts = {};
  if (text === "") return counts;
  const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
  lines.forEach((line, index) => {
    const sourceId = attemptSourceId(line, index);
    counts[sourceId] = (counts[sourceId] ?? 0) + 1;
  });
  return counts;
}

async function readRunRequestCounts({ runId, token, downloadArtifact }) {
  const directory = await mkdtemp(path.join(tmpdir(), "provider-call-evidence-"));
  try {
    const evidence = SOURCE_REVERIFICATION_CALL_EVIDENCE;
    await downloadArtifact({ repository: COLLECTION_REPOSITORY, runId, artifactName: `${evidence.artifactPrefix}-${runId}`, directory, token });
    const bytes = await readEvidenceFile(directory, evidence.file, evidence.maxBytes);
    return bytes === null ? null : countTelemetryRequests(bytes);
  } catch {
    return null;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * 같은 KST 날 이 run 밖에서 수집 step에 들어간 source-reverification run과 그 run이 원천별로 보낸 요청 수.
 * 아직 끝나지 않은 run은 증거 업로드 전이라 요청 수가 null이다.
 */
export async function readProviderCallLedger({ env = process.env, now = new Date(), fetchImpl = globalThis.fetch, downloadArtifact = downloadArtifactWithGh } = {}) {
  const { window, token, entered } = await inspectCollectionWindow({ env, now, fetchImpl, contexts: [SOURCE_REVERIFICATION_CALL_EVIDENCE] });
  const entries = [];
  for (const { run, outcome } of entered) {
    const requestCounts = outcome === COLLECTION_OUTCOME.RUNNING ? null : await readRunRequestCounts({ runId: run.id, token, downloadArtifact }); // NOSONAR -- run마다 artifact를 하나씩 내려받아 임시 디렉터리를 바로 지운다
    entries.push({ runId: run.id, outcome, requestCounts });
  }
  entries.sort((left, right) => left.runId - right.runId);
  return { schemaVersion: PROVIDER_CALL_LEDGER_SCHEMA_VERSION, quotaWindow: window.label, entries };
}

function ledgerArguments(argv) {
  if (!Array.isArray(argv) || argv.length !== 2 || argv[0] !== "--ledger" || typeof argv[1] !== "string" || !path.isAbsolute(argv[1])) {
    throw new Error("PROVIDER_CALL_LEDGER_ARGUMENTS: usage: provider-call-ledger.mjs --ledger <absolute path>");
  }
  return argv[1];
}

// run 창을 읽지 못한 이유는 코드만 남긴다(원문에는 URL·토큰이 섞일 수 있다).
const unreadableReasonOf = (error) => (error instanceof CollectionWindowError ? error.reason : INTERNAL_ERROR_REASON);

/** 기록을 파일로 쓴다. 이미 있는 파일은 덮어쓰지 않는다. run 창을 읽지 못하면 이유를 담은 읽을 수 없는 기록을 쓰고 정상 종료한다. */
export async function runProviderCallLedgerCli({ argv = process.argv.slice(2), env = process.env, now = new Date(), fetchImpl = globalThis.fetch, downloadArtifact } = {}) {
  const output = ledgerArguments(argv);
  let ledger;
  try {
    ledger = await readProviderCallLedger({ env, now, fetchImpl, downloadArtifact });
  } catch (error) {
    ledger = { schemaVersion: PROVIDER_CALL_LEDGER_SCHEMA_VERSION, quotaWindow: null, entries: null, unreadableReason: unreadableReasonOf(error) };
  }
  try {
    await writeFile(output, `${JSON.stringify(ledger)}\n`, { flag: "wx", mode: 0o644 });
  } catch {
    throw new Error("PROVIDER_CALL_LEDGER_WRITE_FAILED: the ledger file could not be written");
  }
  return ledger;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const ledger = await runProviderCallLedgerCli();
    if (ledger.entries === null) process.stdout.write(`::warning title=Provider call ledger::the call ledger could not be read (${ledger.unreadableReason}); budget-guarded groups are blocked this run.\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
