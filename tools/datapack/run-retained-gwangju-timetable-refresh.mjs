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

const SOURCE_ID = "kric-nationwide-timetable-file";
const ROOT = path.resolve(import.meta.dirname, "../..");

/**
 * 승인된 head가 갱신 시점에 도달했을 때만 한 번 실행한다.
 * CURRENT는 디렉터리 생성·자격 증명 조회·외부 호출 전에 종료한다.
 */
export async function runRetainedGwangjuTimetableRefresh({
  repositoryRoot = ROOT, operationRoot, env = process.env, clock = () => new Date(), boundaries = {},
} = {}) {
  const root = requiredAbsolute(repositoryRoot, "repositoryRoot");
  const now = requiredClock(clock);
  const readDecision = boundaries.readDecision ?? readRetainedGwangjuTimetableRefreshDecision;
  const decision = await readDecision({ repositoryRoot: root, now });
  if (decision?.state === "CURRENT") return decision;
  if (decision?.state !== "DUE") throw new Error("retained Gwangju refresh decision is invalid");

  const operation = requiredAbsolute(operationRoot, "operationRoot");
  const preflightDue = boundaries.preflightDue ?? defaultPreflightDue;
  const preflight = await preflightDue({ repositoryRoot: root, now, boundaries });
  const serviceKey = normalizeDataGoKrServiceKey(env?.DATA_GO_KR_SERVICE_KEY, { label: "DATA_GO_KR_SERVICE_KEY" });
  requireOciParBaseUrl(env);

  const fsMkdir = boundaries.mkdir ?? mkdir;
  const fsWriteFile = boundaries.writeFile ?? writeFile;
  await fsMkdir(operation, { mode: 0o700 });
  const rawPath = path.join(operation, "kric-nationwide-timetable-file-refresh.xlsx");
  const collectionReceiptPath = path.join(operation, "collection-receipt.json");
  const observationPath = path.join(operation, "observation.json");
  const holidayDirectory = path.join(operation, "kasi-holidays");
  const preparationInputPath = path.join(operation, "prepare-input.json");
  const retainedContractPath = path.join(operation, "retained-contract.json");
  const publicationReceiptPath = path.join(operation, "publication-receipt.json");
  const registrationInputPath = path.join(operation, "registration-input.json");
  const collectKric = boundaries.collectKric ?? collectKricNationwideTimetableFile;
  const buildObservation = boundaries.buildObservation ?? buildKricNationwideTimetableObservation;
  const preparePublication = boundaries.preparePublication ?? prepareRetainedKricTimetablePublication;
  const collectKasi = boundaries.collectKasi ?? collectKasiHolidayCalendarWindowFiles;
  const prepareContract = boundaries.prepareContract ?? defaultPrepareContract;
  const publish = boundaries.publish ?? publishRetainedKricTimetable;
  const register = boundaries.register ?? registerRetainedKricTimetable;

  const receipt = await collectKric({ outputFile: rawPath, now: requiredClock(clock) });
  await writeJson(fsWriteFile, collectionReceiptPath, receipt);
  const observation = await buildObservation({ inputFile: rawPath, receipt });
  await writeJson(fsWriteFile, observationPath, observation);
  const observationBytes = await (boundaries.readFile ?? readFile)(observationPath);
  const publicationPlan = preparePublication({
    candidate: preflight.candidate, observationBytes, receipt, routeNumber: preflight.routePolicy.routeNumber,
    sourcePath: path.basename(observationPath), evaluationAt: requiredClock(clock).toISOString(), providerValidUntil: null,
  });
  const window = retainedGwangjuConfirmationWindowDates({
    observedAt: receipt.capturedAt, freshnessExpiresAt: publicationPlan.freshnessExpiresAt,
  });
  await collectKasi({ outputDirectory: holidayDirectory, startDate: window.startDate, endDate: window.endDate, serviceKey });
  await writeJson(fsWriteFile, preparationInputPath, {
    observationPath, receiptPath: collectionReceiptPath, holidayDirectory, providerValidUntil: null,
  });
  await prepareContract({ repositoryRoot: root, inputPath: preparationInputPath, outputPath: retainedContractPath, now: requiredClock(clock) });
  await publish({
    inputPath: observationPath, receiptPath: publicationReceiptPath, receipt,
    routeNumber: preflight.routePolicy.routeNumber, candidate: preflight.candidate,
    governancePolicy: preflight.governancePolicy, providerValidUntil: null, env, now: requiredClock(clock),
  });
  await writeJson(fsWriteFile, registrationInputPath, {
    schemaVersion: 1, artifactKind: "retained-kric-timetable-registration-input",
    observationPath, collectionReceiptPath, publicationReceiptPath, retainedContractPath,
    governanceEntry: preflight.governanceEntry, providerValidUntil: null,
  });
  await register({ repositoryRoot: root, sourceInputPath: registrationInputPath, env, now: requiredClock(clock) });
  return { state: "REGISTERED", sourceId: SOURCE_ID, operationRoot: operation, freshnessExpiresAt: publicationPlan.freshnessExpiresAt };
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
  const matches = Array.isArray(items) ? items.filter(predicate) : [];
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
  if (argv.length !== 2 || argv[0] !== "--operation-root" || !path.isAbsolute(argv[1])) {
    throw new Error("usage: --operation-root <absolute-directory>");
  }
  return { operationRoot: argv[1] };
}

if (isMainModule(import.meta.url)) {
  try { process.stdout.write(`${JSON.stringify(await runRetainedGwangjuTimetableRefresh(parseArgs(process.argv.slice(2))))}\n`); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
