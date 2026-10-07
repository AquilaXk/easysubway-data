import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { isMainModule } from "../lib/is-main-module.mjs";
import { readRetainedGwangjuTimetableRefreshDecision } from "../ci/decide-retained-gwangju-timetable-refresh.mjs";
import { buildKricNationwideTimetableObservation } from "./build-kric-nationwide-timetable-observation.mjs";
import { collectKricNationwideTimetableFile } from "./collect-kric-nationwide-timetable-file.mjs";
import { loadCurrentMolitGwangjuStationMappings } from "./current-molit-observation.mjs";
import { collectKasiHolidayCalendarWindowFiles } from "./fetch-kasi-public-holiday-calendar.mjs";
import { requireOciParBaseUrl } from "./lib/kric-raw-object-storage.mjs";
import { normalizeDataGoKrServiceKey } from "./lib/provider-call-integrity.mjs";
import { retainedGwangjuConfirmationWindowDates, retainedRoutePolicy, runRetainedGwangjuContractPreparation } from "./prepare-retained-gwangju-contract.mjs";
import { prepareRetainedKricTimetablePublication, requireRetainedTimetableConfirmationPolicy } from "./prepare-retained-kric-timetable-publication.mjs";
import { publishRetainedKricTimetable } from "./publish-retained-kric-timetable.mjs";
import { registerRetainedKricTimetable, verifiedGovernanceEntry } from "./register-retained-kric-timetable.mjs";
import { validateSourceGovernancePolicy } from "./source-governance-policy.mjs";
import { canonicalJson } from "./lib/manifest-validation.mjs";

const SOURCE_ID = "kric-nationwide-timetable-file";
const ROOT = path.resolve(import.meta.dirname, "../..");

const TRIGGERS = Object.freeze(["DUE", "CONTRACT_REVISION"]);

// #995: 수집·계약 준비("collect")와 OCI 게시·등록("publish")을 workflow step으로 나눌 수 있게 두 단계로 실행한다. "all"은 한 번에 둘 다 한다.
// 게시 step이 시작됐는지가 PR 없는 claim 정리의 판정 근거라서(claim-orphans.mjs) 둘은 서로 다른 step이어야 한다.
const PHASES = Object.freeze(["all", "collect", "publish"]);

/**
 * 승인된 head가 갱신 시점에 도달했을 때만 한 번 실행한다.
 * CURRENT는 디렉터리 생성·자격 증명 조회·외부 호출 전에 종료한다.
 * #913: trigger CONTRACT_REVISION(계약 개정, 예: 운행일 달력 규칙 정정)은 CURRENT여도 수집하되,
 * 새로 만든 계약이 등록된 계약(retainedContractSha256)과 다를 때만 게시·등록한다.
 */
export async function runRetainedGwangjuTimetableRefresh({
  repositoryRoot = ROOT, operationRoot, env = process.env, clock = () => new Date(), boundaries = {}, trigger = "DUE", phase = "all",
} = {}) {
  if (!TRIGGERS.includes(trigger)) throw new Error("retained Gwangju refresh trigger is invalid");
  if (!PHASES.includes(phase)) throw new Error("retained Gwangju refresh phase is invalid");
  const root = requiredAbsolute(repositoryRoot, "repositoryRoot");
  const now = requiredClock(clock);
  const readDecision = boundaries.readDecision ?? readRetainedGwangjuTimetableRefreshDecision;
  const decision = await readDecision({ repositoryRoot: root, now });
  if (decision?.state === "CURRENT" && trigger === "DUE") return decision;
  if (decision?.state !== "DUE" && decision?.state !== "CURRENT") throw new Error("retained Gwangju refresh decision is invalid");
  const admittedContractSha256 = trigger === "CONTRACT_REVISION"
    ? await (boundaries.readAdmittedContractSha256 ?? readAdmittedContractSha256)({ repositoryRoot: root })
    : null;

  const operation = requiredAbsolute(operationRoot, "operationRoot");
  const preflightDue = boundaries.preflightDue ?? defaultPreflightDue;
  const preflight = await preflightDue({ repositoryRoot: root, now, boundaries });
  const serviceKey = normalizeDataGoKrServiceKey(env?.DATA_GO_KR_SERVICE_KEY, { label: "DATA_GO_KR_SERVICE_KEY" });
  requireOciParBaseUrl(env);

  const paths = {
    raw: path.join(operation, "kric-nationwide-timetable-file-refresh.xlsx"),
    collectionReceipt: path.join(operation, "collection-receipt.json"),
    observation: path.join(operation, "observation.json"),
    holidayDirectory: path.join(operation, "kasi-holidays"),
    preparationInput: path.join(operation, "prepare-input.json"),
    retainedContract: path.join(operation, "retained-contract.json"),
    publicationReceipt: path.join(operation, "publication-receipt.json"),
    registrationInput: path.join(operation, "registration-input.json"),
  };
  const context = { root, operation, boundaries, env, clock, preflight, serviceKey, paths };
  let collected = null;
  if (phase !== "publish") collected = await collectPhase({ ...context, trigger, admittedContractSha256 });
  if (phase === "collect") return { state: "COLLECTED", sourceId: SOURCE_ID, operationRoot: operation, freshnessExpiresAt: collected.freshnessExpiresAt };
  return publishPhase({ ...context, collected });
}

async function collectPhase({ root, operation, boundaries, clock, preflight, serviceKey, paths, trigger, admittedContractSha256 }) {
  const fsMkdir = boundaries.mkdir ?? mkdir;
  const fsWriteFile = boundaries.writeFile ?? writeFile;
  await fsMkdir(operation, { mode: 0o700 });
  const collectKric = boundaries.collectKric ?? collectKricNationwideTimetableFile;
  const buildObservation = boundaries.buildObservation ?? buildKricNationwideTimetableObservation;
  const preparePublication = boundaries.preparePublication ?? prepareRetainedKricTimetablePublication;
  const collectKasi = boundaries.collectKasi ?? collectKasiHolidayCalendarWindowFiles;
  const prepareContract = boundaries.prepareContract ?? defaultPrepareContract;
  const receipt = await collectKric({ outputFile: paths.raw, now: requiredClock(clock) });
  await writeJson(fsWriteFile, paths.collectionReceipt, receipt);
  const observation = await buildObservation({ inputFile: paths.raw, receipt });
  await writeJson(fsWriteFile, paths.observation, observation);
  const observationBytes = await (boundaries.readFile ?? readFile)(paths.observation);
  const publicationPlan = planPublication({ boundaries, clock, preflight, observationPath: paths.observation, observationBytes, receipt });
  const window = retainedGwangjuConfirmationWindowDates({
    observedAt: receipt.capturedAt, freshnessExpiresAt: publicationPlan.freshnessExpiresAt,
  });
  await collectKasi({ outputDirectory: paths.holidayDirectory, startDate: window.startDate, endDate: window.endDate, serviceKey });
  await writeJson(fsWriteFile, paths.preparationInput, {
    observationPath: paths.observation, receiptPath: paths.collectionReceipt, holidayDirectory: paths.holidayDirectory, providerValidUntil: null,
  });
  await prepareContract({ repositoryRoot: root, inputPath: paths.preparationInput, outputPath: paths.retainedContract, now: requiredClock(clock) });
  if (trigger === "CONTRACT_REVISION") {
    const contract = JSON.parse(await (boundaries.readFile ?? readFile)(paths.retainedContract, "utf8"));
    if (createHash("sha256").update(canonicalJson(contract)).digest("hex") === admittedContractSha256) {
      throw new Error("contract revision trigger requires a changed retained contract");
    }
  }
  return { receipt, publicationPlan };
}

function planPublication({ boundaries, clock, preflight, observationPath, observationBytes, receipt }) {
  const preparePublication = boundaries.preparePublication ?? prepareRetainedKricTimetablePublication;
  return preparePublication({
    candidate: preflight.candidate, observationBytes, receipt, routeNumber: preflight.routePolicy.routeNumber,
    sourcePath: path.basename(observationPath), evaluationAt: requiredClock(clock).toISOString(), providerValidUntil: null,
  });
}

async function publishPhase({ root, operation, boundaries, env, clock, preflight, paths, collected }) {
  const fsWriteFile = boundaries.writeFile ?? writeFile;
  const publish = boundaries.publish ?? publishRetainedKricTimetable;
  const register = boundaries.register ?? registerRetainedKricTimetable;
  const readBytes = boundaries.readFile ?? readFile;
  // 게시 단계는 수집 단계가 남긴 파일만 읽는다. 수집을 다시 하지 않는다.
  let { receipt, publicationPlan } = collected ?? {};
  if (!collected) {
    receipt = JSON.parse(await readBytes(paths.collectionReceipt, "utf8"));
    publicationPlan = planPublication({ boundaries, clock, preflight, observationPath: paths.observation, observationBytes: await readBytes(paths.observation), receipt });
  }
  await publish({
    inputPath: paths.observation, receiptPath: paths.publicationReceipt, receipt,
    routeNumber: preflight.routePolicy.routeNumber, candidate: preflight.candidate,
    governancePolicy: preflight.governancePolicy, providerValidUntil: null, env, now: requiredClock(clock),
  });
  await writeJson(fsWriteFile, paths.registrationInput, {
    schemaVersion: 1, artifactKind: "retained-kric-timetable-registration-input",
    observationPath: paths.observation, collectionReceiptPath: paths.collectionReceipt, publicationReceiptPath: paths.publicationReceipt, retainedContractPath: paths.retainedContract,
    governanceEntry: preflight.governanceEntry, providerValidUntil: null,
  });
  await register({ repositoryRoot: root, sourceInputPath: paths.registrationInput, env, now: requiredClock(clock) });
  return { state: "REGISTERED", sourceId: SOURCE_ID, operationRoot: operation, freshnessExpiresAt: publicationPlan.freshnessExpiresAt };
}

async function readAdmittedContractSha256({ repositoryRoot }) {
  const inventory = await readJson(repositoryRoot, "tools/datapack/source-inventory.json");
  const sha = exactlyOne(inventory.sources, ({ id }) => id === SOURCE_ID).retainedScheduleAdmissionEvidence?.retainedContractSha256;
  if (!/^[a-f0-9]{64}$/u.test(sha ?? "")) throw new Error("retained Gwangju admitted contract identity is invalid");
  return sha;
}

async function defaultPreflightDue({ repositoryRoot, now, boundaries }) {
  const [candidates, inventory, governancePolicy, freshnessPolicy] = await Promise.all([
    readJson(repositoryRoot, "tools/datapack/source-candidates.json"),
    readJson(repositoryRoot, "tools/datapack/source-inventory.json"),
    readJson(repositoryRoot, "tools/datapack/source-governance-policy.json"),
    readJson(repositoryRoot, "release/product-gates/datapack-freshness-sla.json"),
  ]);
  const candidate = exactlyOne(candidates.candidates, ({ id }) => id === SOURCE_ID);
  requireRetainedTimetableConfirmationPolicy(candidate);
  const routePolicy = retainedRoutePolicy(candidate);
  validateSourceGovernancePolicy({ policy: governancePolicy, inventory, freshnessPolicy });
  const governanceEntry = verifiedGovernanceEntry(
    exactlyOne(governancePolicy.sources, ({ sourceId }) => sourceId === SOURCE_ID), candidate, now,
  );
  const loadCurrentMolit = boundaries.loadCurrentMolit ?? loadCurrentMolitGwangjuStationMappings;
  await loadCurrentMolit({ repositoryRoot, inventory });
  return { candidate, routePolicy, governancePolicy, governanceEntry, providerValidUntil: null };
}

async function defaultPrepareContract({ repositoryRoot, inputPath, outputPath, now }) {
  return runRetainedGwangjuContractPreparation(["--input", inputPath, "--output", outputPath], { repositoryRoot, now });
}

async function readJson(root, relative) { return JSON.parse(await readFile(path.join(root, relative), "utf8")); }
async function writeJson(write, target, value) {
  await write(target, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}
function exactlyOne(items, predicate) {
  const matches = Array.isArray(items) ? items.filter((item) => predicate(item)) : [];
  if (matches.length !== 1) throw new Error("retained Gwangju refresh canonical input is invalid");
  return matches[0];
}
function requiredAbsolute(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value)) throw new Error(`${label} must be absolute`);
  return path.resolve(value);
}
function requiredClock(clock) {
  const value = clock();
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) throw new Error("retained Gwangju refresh clock is invalid");
  return value;
}

function parseArgs(argv) {
  const usage = "usage: --operation-root <absolute-directory> [--trigger contract-revision] [--phase collect|publish]";
  if (argv[0] !== "--operation-root" || !path.isAbsolute(argv[1] ?? "")) throw new Error(usage);
  const values = { operationRoot: argv[1], trigger: "DUE", phase: "all" };
  for (let index = 2; index < argv.length; index += 2) {
    if (argv[index] === "--trigger" && argv[index + 1] === "contract-revision" && values.trigger === "DUE") values.trigger = "CONTRACT_REVISION";
    else if (argv[index] === "--phase" && ["collect", "publish"].includes(argv[index + 1]) && values.phase === "all") values.phase = argv[index + 1];
    else throw new Error(usage);
  }
  return values;
}

if (isMainModule(import.meta.url)) {
  try { process.stdout.write(`${JSON.stringify(await runRetainedGwangjuTimetableRefresh(parseArgs(process.argv.slice(2))))}\n`); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
