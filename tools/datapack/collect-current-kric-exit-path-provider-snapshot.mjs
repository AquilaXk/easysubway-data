#!/usr/bin/env node
import { link, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { readRegularSnapshot } from "./build-current-kric-exit-collection-plan.mjs";
import {
  buildKricExitPathObservation,
  buildKricExitPathRawCollection,
  canonicalKricExitPathProviderSnapshotJson,
  collectKricExitPathProviderSnapshot,
  KRIC_EXIT_PATH_SOURCES,
} from "./collect-kric-exit-path-provider-snapshot.mjs";
import {
  assertKricControlOperation,
  resolveKricCandidateRequest,
} from "./collect-kric-source-candidate-evidence.mjs";
import {
  assertProviderCredentialIntegrity,
  resolveProviderCallIntegrity,
} from "./lib/provider-call-integrity.mjs";
import {
  CANDIDATES_PATH,
  requiredText,
  sanitizeErrorMessage,
} from "./lib/source-candidate-evidence-collector.mjs";
import { canonicalKricExitPathCollectionPlanJson } from "./plan-kric-exit-path-collection.mjs";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_REQUEST_INTERVAL_MS = 250;
const MAX_REQUEST_TIMEOUT_MS = 60_000;
const MAX_REQUEST_INTERVAL_MS = 60_000;
const PROVIDER_ID = "kric";
const RESULT_STATES = Object.freeze([
  "EXPLICIT_ZERO",
  "PROVIDER_NO_DATA",
  "PROVIDER_RESULT_UNVERIFIED",
  "ROWS_OBSERVED",
]);

export async function main(argv, {
  candidatesDocument,
  delayImpl,
  env = process.env,
  fetchImpl = fetch,
  linkImpl = link,
  log = console.log,
  mkdtempImpl = mkdtemp,
  now = new Date(),
  removeImpl = rm,
  writeFileImpl = writeFile,
} = {}) {
  const args = parseArgs(argv);
  const serviceKey = requiredText(env.KRIC_SERVICE_KEY, "KRIC_SERVICE_KEY");
  const runnerTemp = path.resolve(requiredAbsolutePath(env.RUNNER_TEMP, "RUNNER_TEMP"));
  if (path.dirname(args.output) !== runnerTemp) {
    throw new Error("output must be a direct RUNNER_TEMP child");
  }
  const tempBefore = await lstat(runnerTemp);
  if (!tempBefore.isDirectory() || tempBefore.isSymbolicLink()) {
    throw new Error("RUNNER_TEMP must be a regular directory");
  }
  await outputMustBeAbsent(args.output);
  if (args.observationRoot !== undefined) {
    if (path.dirname(args.observationRoot) !== runnerTemp) {
      throw new Error("observation root must be a direct RUNNER_TEMP child");
    }
    await outputMustBeAbsent(args.observationRoot);
  }

  const planSnapshot = await readRegularSnapshot(args.collectionPlan, "collection-plan");
  const collectionPlan = parseCanonicalPlan(planSnapshot.bytes);
  const document = candidatesDocument ?? JSON.parse(await readFile(CANDIDATES_PATH, "utf8"));
  validateProviderBoundary({ document, serviceKey, sourceId: args.sourceId });

  const rawResponses = [];
  const snapshot = await collectKricExitPathProviderSnapshot({
    collectionPlan,
    sourceId: args.sourceId,
    serviceKey,
    fetchImpl,
    now,
    requestTimeoutMs: args.requestTimeoutMs,
    requestIntervalMs: args.requestIntervalMs,
    ...(delayImpl === undefined ? {} : { delayImpl }),
    ...(args.observationRoot === undefined ? {} : { onRawResponse: (entry) => rawResponses.push(entry) }),
  });
  const bytes = Buffer.from(canonicalKricExitPathProviderSnapshotJson(snapshot));

  await assertSnapshotUnchanged(planSnapshot);
  const tempAfter = await lstat(runnerTemp);
  if (!sameIdentity(tempBefore, tempAfter) || !tempAfter.isDirectory() || tempAfter.isSymbolicLink()) {
    throw new Error("RUNNER_TEMP changed during collection");
  }
  await outputMustBeAbsent(args.output);
  await publishAtomicSnapshot({
    bytes,
    linkImpl,
    mkdtempImpl,
    output: args.output,
    removeImpl,
    runnerTemp,
    writeFileImpl,
  });
  if (args.observationRoot !== undefined) {
    await writeObservation({ observationRoot: args.observationRoot, rawResponses, serviceKey, snapshot, snapshotBytes: bytes });
  }
  log(`current KRIC EXIT raw snapshot ready: ${sanitizedReceiptJson(snapshot)}`);
  return snapshot;
}

// #834: snapshot과 같은 수집 회차의 키 없는 raw 보관본·observation manifest를 한 디렉터리로 원자 공개한다.
async function writeObservation({ observationRoot, rawResponses, serviceKey, snapshot, snapshotBytes }) {
  const rawCollection = buildKricExitPathRawCollection({ snapshot, rawResponses });
  const rawCollectionBytes = Buffer.from(JSON.stringify(canonicalValue(rawCollection)));
  const observation = buildKricExitPathObservation({ snapshot, snapshotBytes, rawCollectionBytes });
  const observationBytes = Buffer.from(`${JSON.stringify(observation, null, 2)}\n`);
  for (const value of [rawCollectionBytes, observationBytes]) {
    if (value.includes(serviceKey) || value.includes(encodeURIComponent(serviceKey))) {
      throw new Error("KRIC EXIT credential appeared in observation output");
    }
  }
  const temporary = `${observationRoot}.tmp-${process.pid}`;
  await mkdir(temporary, { mode: 0o700 });
  try {
    await writeFile(path.join(temporary, observation.snapshotFile), snapshotBytes, { flag: "wx", mode: 0o600 });
    await writeFile(path.join(temporary, observation.rawArtifactFile), rawCollectionBytes, { flag: "wx", mode: 0o600 });
    await writeFile(path.join(temporary, "observation.json"), observationBytes, { flag: "wx", mode: 0o600 });
    await outputMustBeAbsent(observationRoot);
    await rename(temporary, observationRoot);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))
      .map((key) => [key, canonicalValue(value[key])]));
  }
  return value;
}

async function publishAtomicSnapshot({
  bytes,
  linkImpl,
  mkdtempImpl,
  output,
  removeImpl,
  runnerTemp,
  writeFileImpl,
}) {
  const stagingDirectory = await mkdtempImpl(path.join(runnerTemp, ".current-kric-exit-"));
  const stagedOutput = path.join(stagingDirectory, "snapshot.json");
  try {
    await writeFileImpl(stagedOutput, bytes, { flag: "wx", mode: 0o600 });
    await outputMustBeAbsent(output);
    await linkImpl(stagedOutput, output);
  } finally {
    await removeImpl(stagingDirectory, { force: true, recursive: true });
  }
}

function sanitizedReceiptJson(snapshot) {
  const resultStateCounts = Object.fromEntries(RESULT_STATES.map((state) => [state, 0]));
  for (const result of snapshot.results) {
    if (!Object.hasOwn(resultStateCounts, result.state)) {
      throw new Error("KRIC EXIT result state mismatch");
    }
    resultStateCounts[result.state] += 1;
  }
  return JSON.stringify({
    result: "PASS",
    sourceId: snapshot.sourceId,
    queryCount: snapshot.queryPlan.length,
    resultCount: snapshot.results.length,
    resultStateCounts,
    snapshotDigest: snapshot.snapshotDigest,
    capturedAt: snapshot.capturedAt,
    freshUntil: snapshot.freshUntil,
  });
}

function parseArgs(argv) {
  const pathFlags = new Set(["collection-plan", "output", "observation-root"]);
  const allowed = new Set([
    ...pathFlags, "source-id", "request-timeout-ms", "request-interval-ms",
  ]);
  if (!Array.isArray(argv) || argv.length < 6 || argv.length % 2 !== 0) {
    throw new Error("KRIC EXIT live collection arguments mismatch");
  }
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const token = argv[index];
    const flag = typeof token === "string" ? token.replace(/^--/, "") : "";
    const value = argv[index + 1];
    if (!allowed.has(flag) || values[flag] !== undefined || typeof value !== "string" || value === "") {
      throw new Error("KRIC EXIT live collection arguments mismatch");
    }
    values[flag] = pathFlags.has(flag) ? requiredAbsolutePath(value, `--${flag}`) : value;
  }
  for (const flag of ["collection-plan", "source-id", "output"]) {
    if (values[flag] === undefined) throw new Error("KRIC EXIT live collection arguments mismatch");
  }
  return {
    collectionPlan: values["collection-plan"],
    sourceId: values["source-id"],
    output: values.output,
    observationRoot: values["observation-root"],
    requestTimeoutMs: boundedInteger(
      values["request-timeout-ms"] ?? String(DEFAULT_REQUEST_TIMEOUT_MS),
      1,
      MAX_REQUEST_TIMEOUT_MS,
      "KRIC EXIT request timeout",
    ),
    requestIntervalMs: boundedInteger(
      values["request-interval-ms"] ?? String(DEFAULT_REQUEST_INTERVAL_MS),
      0,
      MAX_REQUEST_INTERVAL_MS,
      "KRIC EXIT request interval",
    ),
  };
}

export function validateProviderBoundary({ document, serviceKey, sourceId }) {
  const source = KRIC_EXIT_PATH_SOURCES[sourceId];
  if (!source) throw new Error(`unsupported KRIC EXIT source: ${sourceId}`);
  const integrity = resolveProviderCallIntegrity(document, PROVIDER_ID, { required: true });
  if (integrity.credential.env !== "KRIC_SERVICE_KEY") {
    throw new Error("KRIC credential environment contract mismatch");
  }
  assertProviderCredentialIntegrity({ providerId: PROVIDER_ID, credential: serviceKey, contract: integrity.credential });
  assertKricControlOperation(document, integrity.controlOperation);
  const request = resolveKricCandidateRequest(document, sourceId);
  const candidate = document.candidates.find(({ id }) => id === sourceId);
  const formats = new Set((candidate?.evidence?.formats ?? []).map((value) => String(value).toLowerCase()));
  const responseFields = candidate?.operation?.responseFields ?? candidate?.evidence?.outputFields;
  if (request.endpoint !== source.endpoint || !formats.has("json")
    || JSON.stringify(responseFields) !== JSON.stringify(source.responseFields)) {
    throw new Error("KRIC EXIT source catalog mismatch");
  }
}

export function parseCanonicalPlan(bytes) {
  let value;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("collection plan must be strict UTF-8 JSON");
  }
  const canonical = canonicalKricExitPathCollectionPlanJson(value);
  if (!Buffer.from(bytes).equals(Buffer.from(canonical))) {
    throw new Error("collection plan must be canonical JSON");
  }
  return value;
}

function requiredAbsolutePath(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new Error(`${label} must be an absolute path`);
  }
  return path.resolve(value);
}

function boundedInteger(value, minimum, maximum, label) {
  if (!/^(?:0|[1-9]\d*)$/.test(value)) throw new Error(`${label} is invalid`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw new Error(`${label} is invalid`);
  }
  return number;
}

async function outputMustBeAbsent(target) {
  try {
    await lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error("output must be absent");
}

async function assertSnapshotUnchanged(snapshot) {
  const current = await lstat(snapshot.target);
  if (!current.isFile() || current.isSymbolicLink() || !sameIdentity(snapshot.identity, current)) {
    throw new Error(`${snapshot.label} changed during collection`);
  }
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.mode === right.mode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(sanitizeErrorMessage(error, process.env.KRIC_SERVICE_KEY ?? ""));
    process.exitCode = 1;
  });
}
