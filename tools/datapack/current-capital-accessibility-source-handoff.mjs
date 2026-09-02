import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  buildCurrentCapitalFacilitySourceAdmission,
  canonicalCurrentCapitalFacilitySourceAdmissionJson,
} from "./build-current-capital-facility-source-admission.mjs";
import { collectSeoulAccessibilityObservation, writeSeoulAccessibilityObservation } from "./collect-seoul-accessibility-evidence.mjs";
import { canonicalJson } from "./lib/manifest-validation.mjs";
import { publishKricAccessibilityRawArtifact } from "./publish-kric-accessibility-raw.mjs";
import { publishSeoulAccessibilityRawArtifact } from "./publish-seoul-accessibility-raw.mjs";
import { normalizeDataGoKrServiceKey } from "./lib/provider-call-integrity.mjs";
import { rebindCurrentCandidateSourceSnapshots } from "./rebind-current-candidate-source-snapshots.mjs";
import { registerCurrentSeoulAccessibilitySnapshot } from "./register-current-seoul-accessibility-snapshot.mjs";
import { registerKricStandardAccessibilitySnapshot } from "./register-kric-standard-accessibility-snapshot.mjs";
import { collectCurrentCapitalFacilityOperation, prepareCurrentCapitalFacilityOperation } from "./run-current-capital-facility-operation.mjs";
import { validateLineage } from "./source-snapshot-policy.mjs";
import { codepointCompare } from "../lib/codepoint-compare.mjs";

const SHA40 = /^[a-f0-9]{40}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const OPERATION = /^[a-z0-9][a-z0-9-]{7,127}$/u;
const RECEIPT_KEYS = Object.freeze([
  "artifactKind", "byteSize", "capturedAt", "rawObjectSha256", "rawObjectUri",
  "rawRetentionExpiresAt", "schemaVersion", "snapshotFileSha256", "snapshotId",
  "snapshotRawSha256", "sourceId", "storedAt",
]);
const SOURCE_CONTRACTS = Object.freeze(new Map([
  ["seoul-metro-accessibility", {
    receiptKind: "seoul-accessibility-raw-object-receipt",
    path: /^tools\/datapack\/sources\/seoul-metro-accessibility-[0-9TZ]+\.json$/u,
  }],
  ["kric-station-convenience-standard", {
    receiptKind: "kric-accessibility-raw-object-receipt",
    path: /^tools\/datapack\/sources\/kric-station-convenience-standard-[0-9TZ]+\.json$/u,
  }],
]));
const SOURCE_IDS = Object.freeze([...SOURCE_CONTRACTS.keys()].sort(codepointCompare));

export const CURRENT_CAPITAL_ACCESSIBILITY_SOURCE_FIXED_OUTPUTS = Object.freeze([
  "tools/datapack/inputs/capital-pilot-production-source-input.json",
  "tools/datapack/release/candidate-build-spec.json",
  "tools/datapack/release/current-capital-facility-source-admission.json",
  "tools/datapack/release/hash-evidence.json",
  "tools/datapack/release/release-request.json",
  "tools/datapack/release/source-snapshots.json",
  "tools/datapack/source-inventory.json",
].sort(codepointCompare));

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function requiredText(value, label) {
  if (typeof value !== "string" || value === "") throw new Error(`${label} mismatch`);
  return value;
}

function requiredInstant(value, label) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) throw new Error(`${label} mismatch`);
  return parsed;
}

function requiredRoot(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value)) throw new Error(`${label} mismatch`);
  return path.resolve(value);
}

async function assertDirectory(root, label) {
  const stat = await lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} mismatch`);
}

async function regularBytes(root, relative, label) {
  const target = path.resolve(root, relative);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error(`${label} path mismatch`);
  const stat = await lstat(target);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} file mismatch`);
  return readFile(target);
}

async function optionalBytes(root, relative, label) {
  try { return await regularBytes(root, relative, label); }
  catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}

function parseJson(bytes, label) {
  try { return JSON.parse(Buffer.from(bytes).toString("utf8")); }
  catch { throw new Error(`${label} JSON mismatch`); }
}

function validateReceipt(receipt, source, snapshotSha256) {
  const contract = SOURCE_CONTRACTS.get(source.sourceId);
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)
    || JSON.stringify(Object.keys(receipt).sort(codepointCompare)) !== JSON.stringify(RECEIPT_KEYS)
    || receipt.schemaVersion !== 1 || receipt.artifactKind !== contract.receiptKind
    || receipt.sourceId !== source.sourceId || receipt.snapshotId !== source.snapshotId
    || receipt.snapshotFileSha256 !== snapshotSha256
    || !SHA256.test(receipt.snapshotRawSha256 ?? "") || !SHA256.test(receipt.rawObjectSha256 ?? "")
    || typeof receipt.rawObjectUri !== "string" || !receipt.rawObjectUri.startsWith("oci://")
    || !Number.isSafeInteger(receipt.byteSize) || receipt.byteSize < 1) {
    throw new Error("source receipt identity mismatch");
  }
  const capturedAt = requiredInstant(receipt.capturedAt, "source receipt capturedAt");
  const storedAt = requiredInstant(receipt.storedAt, "source receipt storedAt");
  const retention = requiredInstant(receipt.rawRetentionExpiresAt, "source receipt retention");
  if (storedAt < capturedAt || retention <= storedAt) throw new Error("source receipt time mismatch");
}

function validateSource(source, operationNow) {
  const contract = SOURCE_CONTRACTS.get(source?.sourceId);
  const refreshKeys = [
    "action", "rawReceiptSha256", "snapshotId", "snapshotPath", "snapshotSha256", "sourceId",
  ];
  const retainKeys = ["action", "snapshotId", "snapshotPath", "snapshotSha256", "sourceId"];
  const expectedKeys = source?.action === "REFRESH" ? refreshKeys : retainKeys;
  if (!contract || !source || typeof source !== "object" || Array.isArray(source)
    || !["REFRESH", "RETAIN"].includes(source.action)
    || JSON.stringify(Object.keys(source).sort(codepointCompare)) !== JSON.stringify(expectedKeys)) {
    throw new Error("source set mismatch");
  }
  if (!contract.path.test(source.snapshotPath ?? "") || source.snapshotId !== path.basename(source.snapshotPath, ".json")
    || !SHA256.test(source.snapshotSha256 ?? "")) {
    throw new Error("source snapshot binding mismatch");
  }
  if (source.action === "REFRESH") {
    if (!SHA256.test(source.rawReceiptSha256 ?? "")) throw new Error("source receipt digest mismatch");
  }
}

function validatePayload(value, expected = undefined) {
  const keys = [
    "artifactKind", "facility", "handoffSha256", "operationId", "operationNow", "outputs",
    "protectedCandidateId", "providerStartedAt", "repository", "schemaVersion", "sourceMainGitSha", "sources",
  ];
  if (!value || typeof value !== "object" || Array.isArray(value)
    || JSON.stringify(Object.keys(value).sort(codepointCompare)) !== JSON.stringify(keys)
    || value.schemaVersion !== 2 || value.artifactKind !== "current-capital-accessibility-source-handoff"
    || value.repository !== "AquilaXk/easysubway-data" || !OPERATION.test(value.operationId ?? "")
    || !SHA40.test(value.sourceMainGitSha ?? "") || !SHA40.test(value.facility?.headSha ?? "")
    || !/^automation\/629-kric-facility-refresh-[0-9]+$/u.test(value.facility?.branch ?? "")
    || typeof value.protectedCandidateId !== "string" || value.protectedCandidateId === ""
    || !SHA256.test(value.handoffSha256 ?? "") || !Array.isArray(value.sources) || !Array.isArray(value.outputs)) {
    throw new Error("accessibility source handoff mismatch");
  }
  const { handoffSha256, ...payload } = value;
  if (handoffSha256 !== sha256(Buffer.from(canonicalJson(payload)))) throw new Error("accessibility source handoff digest mismatch");
  const providerStartedAt = requiredInstant(value.providerStartedAt, "accessibility source providerStartedAt");
  const operationNow = requiredInstant(value.operationNow, "accessibility source operationNow");
  if (providerStartedAt > operationNow) throw new Error("accessibility source operation clock mismatch");
  const sources = [...value.sources].sort((left, right) => codepointCompare(left.sourceId, right.sourceId));
  if (JSON.stringify(sources.map(({ sourceId }) => sourceId))
    !== JSON.stringify([...SOURCE_CONTRACTS.keys()].sort(codepointCompare))) throw new Error("source set mismatch");
  sources.forEach((source) => validateSource(source, operationNow));
  const refreshed = sources.filter(({ action }) => action === "REFRESH");
  const expectedPaths = [...CURRENT_CAPITAL_ACCESSIBILITY_SOURCE_FIXED_OUTPUTS,
    ...refreshed.map(({ snapshotPath }) => snapshotPath)].sort(codepointCompare);
  if (value.outputs.length !== expectedPaths.length
    || JSON.stringify(value.outputs.map(({ relativePath }) => relativePath)) !== JSON.stringify(expectedPaths)
    || new Set(value.outputs.map(({ relativePath }) => relativePath)).size !== value.outputs.length
    || value.outputs.some((output) => !output || typeof output !== "object" || Array.isArray(output)
      || JSON.stringify(Object.keys(output).sort(codepointCompare)) !== JSON.stringify([
        "afterSha256", "beforeSha256", "operation", "relativePath",
      ])
      || !SHA256.test(output.afterSha256 ?? "")
      || (CURRENT_CAPITAL_ACCESSIBILITY_SOURCE_FIXED_OUTPUTS.includes(output.relativePath)
        ? output.operation !== "replace" || !SHA256.test(output.beforeSha256 ?? "")
        : output.operation !== "create" || output.beforeSha256 !== null))) {
    throw new Error("accessibility source output manifest mismatch");
  }
  if (expected && (value.repository !== expected.repository || value.operationId !== expected.operationId
    || value.sourceMainGitSha !== expected.sourceMainGitSha || value.facility.branch !== expected.facilityBranch
    || value.facility.headSha !== expected.facilityHeadGitSha
    || value.protectedCandidateId !== expected.protectedCandidateId)) {
    throw new Error("accessibility source handoff expected identity mismatch");
  }
  return value;
}

export function validateCurrentCapitalAccessibilitySourceHandoff(value, expected = undefined) {
  return validatePayload(value, expected);
}

export function canonicalCurrentCapitalAccessibilitySourceHandoffJson(value) {
  return canonicalJson(validatePayload(value));
}

export function changedCurrentCapitalAccessibilitySourceOutputPaths(value) {
  return validatePayload(value).outputs
    .filter((output) => output.operation === "create" || output.beforeSha256 !== output.afterSha256)
    .map(({ relativePath }) => relativePath);
}

function normalizeRefreshSourceIds(refreshSourceIds) {
  if (!Array.isArray(refreshSourceIds) || new Set(refreshSourceIds).size !== refreshSourceIds.length
    || refreshSourceIds.some((sourceId) => !SOURCE_CONTRACTS.has(sourceId))) {
    throw new Error("accessibility source refresh set mismatch");
  }
  return [...refreshSourceIds].sort(codepointCompare);
}

async function readSelectedAccessibilitySourceSet(root, label) {
  const [inventory, candidate, ledger] = await Promise.all([
    regularBytes(root, "tools/datapack/source-inventory.json", `${label} source inventory`).then((bytes) => parseJson(bytes, `${label} source inventory`)),
    regularBytes(root, "tools/datapack/release/candidate-build-spec.json", `${label} candidate build spec`).then((bytes) => parseJson(bytes, `${label} candidate build spec`)),
    regularBytes(root, "tools/datapack/release/source-snapshots.json", `${label} source snapshot ledger`).then((bytes) => parseJson(bytes, `${label} source snapshot ledger`)),
  ]);
  const heads = validateLineage(ledger).headsBySource;
  const sources = new Map();
  for (const sourceId of SOURCE_IDS) {
    const inventorySources = inventory.sources?.filter(({ id }) => id === sourceId) ?? [];
    const projections = candidate.sourceSnapshots?.filter(({ sourceId: selected }) => selected === sourceId) ?? [];
    const source = inventorySources[0];
    const evidence = source?.accessibilityAdmissionEvidence;
    const selectedIndex = candidate.sourceSnapshots?.findIndex(({ sourceId: selected }) => selected === sourceId) ?? -1;
    const snapshotId = evidence?.snapshotId;
    const ledgerEntries = ledger.filter((entry) => entry?.sourceId === sourceId && entry.snapshotId === snapshotId);
    const ledgerEntry = ledgerEntries[0];
    const contract = SOURCE_CONTRACTS.get(sourceId);
    if (inventorySources.length !== 1 || projections.length !== 1 || selectedIndex < 0
      || typeof snapshotId !== "string" || snapshotId === ""
      || candidate.sourceSnapshotIds?.[selectedIndex] !== snapshotId
      || projections[0].snapshotId !== snapshotId || heads[sourceId] !== snapshotId
      || ledgerEntries.length !== 1 || !contract.path.test(evidence?.snapshotPath ?? "")
      || path.basename(evidence.snapshotPath, ".json") !== snapshotId) {
      throw new Error(`selected accessibility source identity mismatch: ${sourceId}`);
    }
    const snapshotBytes = await regularBytes(root, evidence.snapshotPath, `${label} ${sourceId} snapshot`);
    const snapshot = parseJson(snapshotBytes, `${label} ${sourceId} snapshot`);
    const snapshotSha256 = sha256(snapshotBytes);
    const capturedAt = requiredInstant(evidence.capturedAt, `${sourceId} capturedAt`);
    const observedAt = requiredInstant(evidence.observedAt, `${sourceId} observedAt`);
    const freshUntil = requiredInstant(evidence.freshUntil, `${sourceId} freshUntil`);
    const rawRetentionExpiresAt = requiredInstant(ledgerEntry.rawRetentionExpiresAt, `${sourceId} rawRetentionExpiresAt`);
    const rawReceipt = {
      schemaVersion: 1,
      artifactKind: contract.receiptKind,
      sourceId,
      snapshotId,
      snapshotRawSha256: ledgerEntry.rawReceipt?.snapshotRawSha256,
      capturedAt: ledgerEntry.rawReceipt?.capturedAt,
      snapshotFileSha256: ledgerEntry.rawReceipt?.snapshotFileSha256,
      rawObjectUri: ledgerEntry.rawObjectUri,
      rawObjectSha256: ledgerEntry.rawReceipt?.rawObjectSha256,
      byteSize: ledgerEntry.rawReceipt?.byteSize,
      storedAt: ledgerEntry.rawReceipt?.storedAt,
      rawRetentionExpiresAt: ledgerEntry.rawRetentionExpiresAt,
    };
    if (snapshot?.sourceId !== sourceId || snapshot.snapshotId !== snapshotId
      || snapshot.capturedAt !== evidence.capturedAt || snapshot.observedAt !== evidence.observedAt
      || snapshot.freshUntil !== evidence.freshUntil
      || evidence.snapshotFileSha256 !== snapshotSha256
      || evidence.rawSha256 !== snapshot.rawSha256
      || ledgerEntry.rawReceipt?.snapshotRawSha256 !== snapshot.rawSha256
      || ledgerEntry.rawReceipt?.snapshotFileSha256 !== snapshotSha256
      || !SHA256.test(ledgerEntry.rawSha256 ?? "")
      || ledgerEntry.rawReceipt?.rawObjectSha256 !== ledgerEntry.rawSha256
      || typeof ledgerEntry.rawObjectUri !== "string" || !ledgerEntry.rawObjectUri.startsWith("oci://")) {
      throw new Error(`selected accessibility source provenance mismatch: ${sourceId}`);
    }
    validateReceipt(rawReceipt, { sourceId, snapshotId }, snapshotSha256);
    const storedAt = requiredInstant(rawReceipt.storedAt, `${sourceId} storedAt`);
    sources.set(sourceId, Object.freeze({
      sourceId, snapshotId, snapshotPath: evidence.snapshotPath, snapshotSha256,
      snapshotBytes, capturedAt, observedAt, freshUntil, storedAt, rawRetentionExpiresAt, rawReceipt,
      rawReceiptSha256: sha256(Buffer.from(canonicalJson(rawReceipt))),
    }));
  }
  return Object.freeze({ candidateId: candidate.candidateId, sources });
}

export async function decideCurrentCapitalAccessibilitySourceRefresh({
  repositoryRoot,
  now = new Date(),
} = {}) {
  const root = requiredRoot(repositoryRoot, "repository root");
  if (!(now instanceof Date) || Number.isNaN(now.valueOf())) throw new Error("accessibility refresh clock mismatch");
  const selected = await readSelectedAccessibilitySourceSet(root, "current");
  const sources = SOURCE_IDS.map((sourceId) => {
    const source = selected.sources.get(sourceId);
    const { capturedAt, observedAt, freshUntil } = source;
    if (capturedAt > now.valueOf() || observedAt > now.valueOf() || freshUntil <= capturedAt) {
      throw new Error(`selected accessibility source time mismatch: ${sourceId}`);
    }
    return Object.freeze({
      sourceId,
      snapshotId: source.snapshotId,
      freshUntil: new Date(freshUntil).toISOString(),
      state: freshUntil <= now.valueOf() ? "EXPIRED" : "CURRENT",
    });
  });
  const refreshSourceIds = sources.filter(({ state }) => state === "EXPIRED").map(({ sourceId }) => sourceId);
  return Object.freeze({
    schemaVersion: 1,
    state: refreshSourceIds.length === 0 ? "CURRENT" : "EXPIRED",
    operationNow: now.toISOString(),
    sources: Object.freeze(sources),
    refreshSourceIds: Object.freeze(refreshSourceIds),
  });
}

export async function collectCurrentCapitalTerminalAccessibilitySources({
  repositoryRoot,
  operationRoot,
  expectedMainSha,
  expectedFacilityHeadSha,
  providerStartedAt,
  refreshSourceIds,
  env = process.env,
  collectSeoulImpl = collectSeoulAccessibilityObservation,
  writeSeoulImpl = writeSeoulAccessibilityObservation,
  publishSeoulImpl = publishSeoulAccessibilityRawArtifact,
  prepareKricImpl = prepareCurrentCapitalFacilityOperation,
  collectKricImpl = collectCurrentCapitalFacilityOperation,
  publishKricImpl = publishKricAccessibilityRawArtifact,
} = {}) {
  const repository = requiredRoot(repositoryRoot, "repository root");
  const operation = requiredRoot(operationRoot, "accessibility operation root");
  if (!(providerStartedAt instanceof Date) || Number.isNaN(providerStartedAt.valueOf())) {
    throw new Error("accessibility source collection inputs mismatch");
  }
  await Promise.all([assertDirectory(repository, "repository root"), assertDirectory(path.dirname(operation), "accessibility operation parent")]);
  const [realRepository, realOperationParent] = await Promise.all([realpath(repository), realpath(path.dirname(operation))]);
  if (realOperationParent === realRepository || realOperationParent.startsWith(`${realRepository}${path.sep}`)) {
    throw new Error("accessibility operation root must be external to repository");
  }
  const decision = await decideCurrentCapitalAccessibilitySourceRefresh({ repositoryRoot: repository, now: providerStartedAt });
  const refreshed = normalizeRefreshSourceIds(refreshSourceIds);
  if (JSON.stringify(refreshed) !== JSON.stringify(decision.refreshSourceIds)) {
    throw new Error("accessibility source refresh decision changed");
  }
  try { await lstat(operation); throw new Error("accessibility operation root already exists"); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
  await mkdir(operation, { mode: 0o700 });
  const selected = await readSelectedAccessibilitySourceSet(repository, "provider-start");
  let seoul = null;
  if (refreshed.includes("seoul-metro-accessibility")) {
    const serviceKey = normalizeDataGoKrServiceKey(env.DATA_GO_KR_SERVICE_KEY);
    const observationRoot = path.join(operation, "seoul-observation");
    const receiptPath = path.join(operation, "seoul-raw-receipt.json");
    const previousSnapshot = parseJson(selected.sources.get("seoul-metro-accessibility").snapshotBytes, "current Seoul snapshot");
    const observation = await collectSeoulImpl({
      serviceKey,
      previousSnapshot,
      requestAttempts: 1,
      retrievedAt: providerStartedAt.toISOString(),
    });
    await writeSeoulImpl({ outputRoot: observationRoot, observation });
    await publishSeoulImpl({ observationRoot, receiptPath, repositoryRoot: repository, env });
    seoul = Object.freeze({
      snapshotPath: path.join(observationRoot, `${observation.snapshot.snapshotId}.json`),
      receiptPath,
    });
  }
  const kricOperationRoot = path.join(operation, "kric-operation");
  await prepareKricImpl({
    repositoryRoot: repository,
    operationRoot: kricOperationRoot,
    expectedMainSha,
    expectedFacilityHeadSha,
    now: providerStartedAt,
  });
  let kric = null;
  if (refreshed.includes("kric-station-convenience-standard")) {
    await collectKricImpl({
      repositoryRoot: repository,
      operationRoot: kricOperationRoot,
      replacingSourceIds: refreshed,
      serviceKey: env.KRIC_SERVICE_KEY,
      env,
      now: providerStartedAt,
    });
    const observationRoot = path.join(kricOperationRoot, "observation");
    const receiptPath = path.join(operation, "kric-raw-receipt.json");
    const manifest = parseJson(await regularBytes(observationRoot, "observation.json", "KRIC observation manifest"), "KRIC observation manifest");
    await publishKricImpl({ observationRoot, receiptPath, repositoryRoot: repository, env });
    kric = Object.freeze({ snapshotPath: path.join(observationRoot, requiredText(manifest.snapshotFile, "KRIC snapshot file")), receiptPath });
  }
  return Object.freeze({
    schemaVersion: 1,
    providerStartedAt: providerStartedAt.toISOString(),
    refreshSourceIds: Object.freeze(refreshed),
    kricPlanPath: path.join(kricOperationRoot, "plan.json"),
    seoul,
    kric,
  });
}

export async function buildCurrentCapitalAccessibilitySourceHandoff({
  repository,
  operationId,
  sourceMainGitSha,
  facilityBranch,
  facilityHeadGitSha,
  providerStartedAt,
  operationNow,
  protectedCandidateId,
  retainedRoot,
  preparedRoot,
  sources,
} = {}) {
  const retained = requiredRoot(retainedRoot, "retained root");
  const prepared = requiredRoot(preparedRoot, "prepared root");
  if (retained === prepared || !(providerStartedAt instanceof Date) || Number.isNaN(providerStartedAt.valueOf())
    || !(operationNow instanceof Date) || Number.isNaN(operationNow.valueOf())
    || providerStartedAt.valueOf() > operationNow.valueOf()) {
    throw new Error("accessibility source handoff roots mismatch");
  }
  await Promise.all([assertDirectory(retained, "retained root"), assertDirectory(prepared, "prepared root")]);
  if (!Array.isArray(sources) || sources.length !== SOURCE_CONTRACTS.size) throw new Error("source set mismatch");
  const requested = new Map(sources.map((source) => [source?.sourceId, source]));
  if (requested.size !== SOURCE_IDS.length || SOURCE_IDS.some((sourceId) => !requested.has(sourceId))) {
    throw new Error("source set mismatch");
  }
  const [retainedSet, preparedSet, admission] = await Promise.all([
    readSelectedAccessibilitySourceSet(retained, "retained"),
    readSelectedAccessibilitySourceSet(prepared, "prepared"),
    regularBytes(
      prepared,
      "tools/datapack/release/current-capital-facility-source-admission.json",
      "prepared FACILITY admission",
    ).then((bytes) => parseJson(bytes, "prepared FACILITY admission")),
  ]);
  if (retainedSet.candidateId !== protectedCandidateId || preparedSet.candidateId !== protectedCandidateId) {
    throw new Error("protected candidate identity mismatch");
  }
  if (requiredInstant(admission?.observedAt, "prepared FACILITY admission observedAt") !== operationNow.valueOf()) {
    throw new Error("accessibility source operation clock mismatch");
  }
  const builtSources = await Promise.all(SOURCE_IDS.map(async (sourceId) => {
    const requestedSource = requested.get(sourceId);
    const retainedSource = retainedSet.sources.get(sourceId);
    const preparedSource = preparedSet.sources.get(sourceId);
    if (requestedSource.action === "RETAIN") {
      if (JSON.stringify(Object.keys(requestedSource).sort(codepointCompare)) !== JSON.stringify(["action", "sourceId"])
        || retainedSource.snapshotId !== preparedSource.snapshotId
        || retainedSource.snapshotPath !== preparedSource.snapshotPath
        || !retainedSource.snapshotBytes.equals(preparedSource.snapshotBytes)
        || retainedSource.freshUntil <= operationNow.valueOf()
        || retainedSource.rawRetentionExpiresAt <= operationNow.valueOf()) {
        throw new Error(`retained accessibility source mismatch: ${sourceId}`);
      }
      const source = {
        action: "RETAIN", sourceId, snapshotId: retainedSource.snapshotId,
        snapshotPath: retainedSource.snapshotPath, snapshotSha256: retainedSource.snapshotSha256,
      };
      validateSource(source, operationNow.valueOf());
      return source;
    }
    if (requestedSource.action !== "REFRESH" || retainedSource.freshUntil > providerStartedAt.valueOf()) {
      throw new Error(`accessibility source refresh decision mismatch: ${sourceId}`);
    }
    const { snapshotId, relativePath, bytes, receiptBytes } = requestedSource;
    if (preparedSource.snapshotId !== snapshotId || preparedSource.snapshotPath !== relativePath
      || !Buffer.isBuffer(bytes) || !preparedSource.snapshotBytes.equals(bytes)) {
      throw new Error("prepared output digest mismatch");
    }
    const snapshot = parseJson(bytes, "prepared source snapshot");
    if (snapshot?.sourceId !== sourceId || snapshot.snapshotId !== snapshotId
      || requiredInstant(snapshot.capturedAt, "source capturedAt") > operationNow.valueOf()
      || requiredInstant(snapshot.freshUntil, "source freshUntil") <= operationNow.valueOf()) {
      throw new Error("source snapshot identity mismatch");
    }
    const rawReceipt = parseJson(receiptBytes, "source receipt");
    validateReceipt(rawReceipt, { sourceId, snapshotId }, sha256(bytes));
    if (requiredInstant(rawReceipt.capturedAt, "source receipt capturedAt") > operationNow.valueOf()
      || requiredInstant(rawReceipt.storedAt, "source receipt storedAt") > operationNow.valueOf()) {
      throw new Error("source receipt is from the future");
    }
    const rawReceiptSha256 = sha256(Buffer.from(canonicalJson(rawReceipt)));
    if (preparedSource.rawReceiptSha256 !== rawReceiptSha256) throw new Error("prepared source receipt digest mismatch");
    const source = {
      action: "REFRESH", sourceId, snapshotId, snapshotPath: relativePath,
      snapshotSha256: sha256(bytes), rawReceiptSha256,
    };
    validateSource(source, operationNow.valueOf());
    return source;
  }));
  if (new Set(builtSources.map(({ sourceId }) => sourceId)).size !== SOURCE_CONTRACTS.size
    || builtSources.some(({ sourceId }) => !SOURCE_CONTRACTS.has(sourceId))) throw new Error("source set mismatch");
  const sourcePaths = builtSources.filter(({ action }) => action === "REFRESH").map(({ snapshotPath }) => snapshotPath);
  const outputs = await Promise.all([
    ...CURRENT_CAPITAL_ACCESSIBILITY_SOURCE_FIXED_OUTPUTS.map(async (relativePath) => ({
      relativePath,
      operation: "replace",
      beforeSha256: sha256(await regularBytes(retained, relativePath, "retained facility output")),
      afterSha256: sha256(await regularBytes(prepared, relativePath, "prepared facility output")),
    })),
    ...sourcePaths.map(async (relativePath) => {
      if (await optionalBytes(retained, relativePath, "retained source snapshot") != null) {
        throw new Error("source snapshot create-once prestate mismatch");
      }
      return {
        relativePath,
        operation: "create",
        beforeSha256: null,
        afterSha256: sha256(await regularBytes(prepared, relativePath, "prepared source snapshot")),
      };
    }),
  ]).then((entries) => entries.sort((left, right) => codepointCompare(left.relativePath, right.relativePath)));
  const payload = {
    schemaVersion: 2,
    artifactKind: "current-capital-accessibility-source-handoff",
    repository,
    operationId,
    sourceMainGitSha,
    facility: { branch: facilityBranch, headSha: facilityHeadGitSha },
    providerStartedAt: providerStartedAt.toISOString(),
    operationNow: operationNow.toISOString(),
    protectedCandidateId,
    sources: builtSources.sort((left, right) => codepointCompare(left.sourceId, right.sourceId)),
    outputs,
  };
  return validatePayload({ ...payload, handoffSha256: sha256(Buffer.from(canonicalJson(payload))) });
}

export async function rebuildCurrentCapitalAccessibilitySourceHandoffFromRoots({
  repository,
  operationId,
  sourceMainGitSha,
  facilityBranch,
  facilityHeadGitSha,
  providerStartedAt,
  operationNow,
  protectedCandidateId,
  retainedRoot,
  preparedRoot,
} = {}) {
  const retained = requiredRoot(retainedRoot, "retained root");
  const prepared = requiredRoot(preparedRoot, "prepared root");
  if (retained === prepared || !(providerStartedAt instanceof Date) || Number.isNaN(providerStartedAt.valueOf())
    || !(operationNow instanceof Date) || Number.isNaN(operationNow.valueOf())
    || providerStartedAt.valueOf() > operationNow.valueOf()) {
    throw new Error("accessibility source handoff roots mismatch");
  }
  await Promise.all([assertDirectory(retained, "retained root"), assertDirectory(prepared, "prepared root")]);
  const [retainedSet, preparedSet] = await Promise.all([
    readSelectedAccessibilitySourceSet(retained, "retained"),
    readSelectedAccessibilitySourceSet(prepared, "prepared"),
  ]);
  if (retainedSet.candidateId !== protectedCandidateId || preparedSet.candidateId !== protectedCandidateId) {
    throw new Error("protected candidate identity mismatch");
  }
  const sources = SOURCE_IDS.map((sourceId) => {
    const retainedSource = retainedSet.sources.get(sourceId);
    const preparedSource = preparedSet.sources.get(sourceId);
    if (retainedSource.snapshotId === preparedSource.snapshotId) {
      return { action: "RETAIN", sourceId };
    }
    if (preparedSource.capturedAt !== providerStartedAt.valueOf()) {
      throw new Error(`accessibility source provider clock mismatch: ${sourceId}`);
    }
    return {
      action: "REFRESH",
      sourceId,
      snapshotId: preparedSource.snapshotId,
      relativePath: preparedSource.snapshotPath,
      bytes: preparedSource.snapshotBytes,
      receiptBytes: Buffer.from(canonicalJson(preparedSource.rawReceipt)),
    };
  });
  return buildCurrentCapitalAccessibilitySourceHandoff({
    repository,
    operationId,
    sourceMainGitSha,
    facilityBranch,
    facilityHeadGitSha,
    providerStartedAt,
    operationNow,
    protectedCandidateId,
    retainedRoot: retained,
    preparedRoot: prepared,
    sources,
  });
}

export async function verifyCurrentCapitalAccessibilitySourceHandoff({
  handoffBytes,
  retainedRoot,
  preparedRoot,
  expected,
} = {}) {
  const retained = requiredRoot(retainedRoot, "retained root");
  const prepared = requiredRoot(preparedRoot, "prepared root");
  await Promise.all([assertDirectory(retained, "retained root"), assertDirectory(prepared, "prepared root")]);
  const value = validatePayload(parseJson(handoffBytes, "accessibility source handoff"), expected);
  if (!Buffer.from(handoffBytes).equals(Buffer.from(`${canonicalJson(value)}\n`))) {
    throw new Error("accessibility source handoff bytes mismatch");
  }
  for (const output of value.outputs) {
    const after = await regularBytes(prepared, output.relativePath, "prepared facility output");
    if (sha256(after) !== output.afterSha256) throw new Error("prepared output digest mismatch");
    const before = await optionalBytes(retained, output.relativePath, "retained facility output");
    if (output.operation === "create" ? before != null
      : before == null || sha256(before) !== output.beforeSha256) {
      throw new Error("retained output digest mismatch");
    }
  }
  const [retainedSet, preparedSet] = await Promise.all([
    readSelectedAccessibilitySourceSet(retained, "retained"),
    readSelectedAccessibilitySourceSet(prepared, "prepared"),
  ]);
  const providerStartedAt = requiredInstant(value.providerStartedAt, "accessibility source providerStartedAt");
  const operationNow = requiredInstant(value.operationNow, "accessibility source operationNow");
  if (retainedSet.candidateId !== value.protectedCandidateId || preparedSet.candidateId !== value.protectedCandidateId) {
    throw new Error("protected candidate identity mismatch");
  }
  for (const source of value.sources) {
    const retainedSource = retainedSet.sources.get(source.sourceId);
    const preparedSource = preparedSet.sources.get(source.sourceId);
    if (preparedSource.snapshotId !== source.snapshotId || preparedSource.snapshotPath !== source.snapshotPath
      || preparedSource.snapshotSha256 !== source.snapshotSha256 || preparedSource.freshUntil <= operationNow) {
      throw new Error(`prepared accessibility source mismatch: ${source.sourceId}`);
    }
    if (source.action === "RETAIN"
      ? retainedSource.snapshotId !== source.snapshotId || !retainedSource.snapshotBytes.equals(preparedSource.snapshotBytes)
        || retainedSource.freshUntil <= operationNow || retainedSource.rawRetentionExpiresAt <= operationNow
      : retainedSource.freshUntil > providerStartedAt || preparedSource.rawReceiptSha256 !== source.rawReceiptSha256) {
      throw new Error(`accessibility source action mismatch: ${source.sourceId}`);
    }
  }
  return Object.freeze(value);
}

export async function stageCurrentCapitalTerminalAccessibilitySources({
  repository,
  operationId,
  sourceMainGitSha,
  facilityBranch,
  facilityHeadGitSha,
  providerStartedAt,
  operationNow,
  refreshSourceIds,
  protectedCandidateId,
  retainedRoot,
  preparedRoot,
  seoulSnapshotPath,
  seoulReceiptPath,
  kricSnapshotPath,
  kricReceiptPath,
  kricPlanPath,
} = {}) {
  const prepared = requiredRoot(preparedRoot, "prepared root");
  const retained = requiredRoot(retainedRoot, "retained root");
  const refreshed = normalizeRefreshSourceIds(refreshSourceIds);
  if (prepared === retained || !(providerStartedAt instanceof Date) || Number.isNaN(providerStartedAt.valueOf())
    || !(operationNow instanceof Date) || Number.isNaN(operationNow.valueOf())
    || providerStartedAt.valueOf() > operationNow.valueOf()
    || typeof kricPlanPath !== "string" || !path.isAbsolute(kricPlanPath)) {
    throw new Error("accessibility source staging inputs mismatch");
  }
  const refreshSet = new Set(refreshed);
  const requireExternalPair = (sourceId, values) => {
    const present = values.every((value) => typeof value === "string" && path.isAbsolute(value));
    const absent = values.every((value) => value == null);
    if (refreshSet.has(sourceId) ? !present : !absent) throw new Error("accessibility source staging inputs mismatch");
  };
  requireExternalPair("seoul-metro-accessibility", [seoulSnapshotPath, seoulReceiptPath]);
  requireExternalPair("kric-station-convenience-standard", [kricSnapshotPath, kricReceiptPath]);
  await Promise.all([assertDirectory(prepared, "prepared root"), assertDirectory(retained, "retained root")]);
  const [retainedCandidate, preparedCandidate] = await Promise.all([
    regularBytes(retained, "tools/datapack/release/candidate-build-spec.json", "retained candidate").then((bytes) => parseJson(bytes, "retained candidate")),
    regularBytes(prepared, "tools/datapack/release/candidate-build-spec.json", "prepared candidate").then((bytes) => parseJson(bytes, "prepared candidate")),
  ]);
  if (retainedCandidate.candidateId !== protectedCandidateId || preparedCandidate.candidateId !== protectedCandidateId) {
    throw new Error("protected candidate identity mismatch");
  }
  const kricPlanBytes = await regularBytes(path.dirname(path.resolve(kricPlanPath)), path.basename(kricPlanPath), "KRIC plan");
  let kricRefresh;
  if (refreshSet.has("kric-station-convenience-standard")) {
    const bytes = await regularBytes(path.dirname(path.resolve(kricSnapshotPath)), path.basename(kricSnapshotPath), "KRIC snapshot");
    const snapshot = parseJson(bytes, "KRIC snapshot");
    const receiptBytes = await regularBytes(path.dirname(path.resolve(kricReceiptPath)), path.basename(kricReceiptPath), "KRIC receipt");
    await registerKricStandardAccessibilitySnapshot({
      snapshotFilePath: path.resolve(kricSnapshotPath), snapshotFileSha256: sha256(bytes),
      snapshotTargetPath: path.join(prepared, "tools/datapack/sources", `${snapshot.snapshotId}.json`),
      rawReceipt: parseJson(receiptBytes, "KRIC receipt"), capitalFacilityPlanPath: path.resolve(kricPlanPath),
      capitalCanonicalPackPath: path.join(prepared, "tools/datapack/release/capital-production-canonical-pack.json"),
      producerNeutralFullRegistration: true, repositoryRoot: prepared, now: operationNow,
    });
    await rebindCurrentCandidateSourceSnapshots({ repositoryRoot: prepared, now: operationNow });
    kricRefresh = { action: "REFRESH", sourceId: "kric-station-convenience-standard", snapshotId: snapshot.snapshotId,
      relativePath: `tools/datapack/sources/${snapshot.snapshotId}.json`, bytes, receiptBytes };
  }
  let seoulRefresh;
  if (refreshSet.has("seoul-metro-accessibility")) {
    const bytes = await regularBytes(path.dirname(path.resolve(seoulSnapshotPath)), path.basename(seoulSnapshotPath), "Seoul snapshot");
    const snapshot = parseJson(bytes, "Seoul snapshot");
    const receiptBytes = await regularBytes(path.dirname(path.resolve(seoulReceiptPath)), path.basename(seoulReceiptPath), "Seoul receipt");
    await registerCurrentSeoulAccessibilitySnapshot({ repositoryRoot: prepared, snapshotPath: path.resolve(seoulSnapshotPath), receiptPath: path.resolve(seoulReceiptPath), now: operationNow });
    seoulRefresh = { action: "REFRESH", sourceId: "seoul-metro-accessibility", snapshotId: snapshot.snapshotId,
      relativePath: `tools/datapack/sources/${snapshot.snapshotId}.json`, bytes, receiptBytes };
  }
  const releasePaths = {
    candidate: "tools/datapack/release/candidate-build-spec.json",
    inventory: "tools/datapack/source-inventory.json",
    snapshots: "tools/datapack/release/source-snapshots.json",
    governance: "tools/datapack/source-governance-policy.json",
    freshness: "release/product-gates/datapack-freshness-sla.json",
    canonical: "tools/datapack/release/capital-production-canonical-pack.json",
  };
  const release = Object.fromEntries(await Promise.all(Object.entries(releasePaths).map(async ([key, relative]) => [key, await regularBytes(prepared, relative, `prepared ${key}`)])));
  const candidate = parseJson(release.candidate, "prepared candidate");
  if (candidate.candidateId !== protectedCandidateId) throw new Error("protected candidate identity mismatch");
  const selectedKric = (await readSelectedAccessibilitySourceSet(prepared, "prepared")).sources.get("kric-station-convenience-standard");
  const admission = buildCurrentCapitalFacilitySourceAdmission({
    observedAt: operationNow.toISOString(),
    candidateEvaluationAt: candidate.publishedAt,
    planBytes: kricPlanBytes,
    canonicalPackBytes: release.canonical,
    snapshotBytes: selectedKric.snapshotBytes,
    candidateBuildSpec: candidate,
    sourceInventoryBytes: release.inventory,
    sourceSnapshots: parseJson(release.snapshots, "prepared source ledger"),
    governancePolicy: parseJson(release.governance, "prepared governance policy"),
    governancePolicyBytes: release.governance,
    freshnessPolicy: parseJson(release.freshness, "prepared freshness policy"),
  });
  await writeFile(
    path.join(prepared, "tools/datapack/release/current-capital-facility-source-admission.json"),
    canonicalCurrentCapitalFacilitySourceAdmissionJson(admission),
    { flag: "w", mode: 0o600 },
  );
  return buildCurrentCapitalAccessibilitySourceHandoff({
    repository, operationId, sourceMainGitSha, facilityBranch, facilityHeadGitSha,
    providerStartedAt, operationNow, protectedCandidateId, retainedRoot, preparedRoot: prepared,
    sources: [
      seoulRefresh ?? { action: "RETAIN", sourceId: "seoul-metro-accessibility" },
      kricRefresh ?? { action: "RETAIN", sourceId: "kric-station-convenience-standard" },
    ],
  });
}
