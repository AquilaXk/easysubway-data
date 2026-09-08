#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual, promisify } from "node:util";

import { parseCurrentMolitDaejeonStationMappings } from "./build-molit-nationwide-fixture.mjs";
import { loadCurrentMolitObservation } from "./current-molit-observation.mjs";
import { deriveFreshnessExpiresAt } from "./freshness-policy.mjs";
import { canonicalJson } from "./lib/manifest-validation.mjs";
import { compareStrings } from "./lib/ledger-admission-cli.mjs";
import { SOURCE_REGISTRATION_OUTPUTS, createSourceRegistrationTransaction } from "./lib/source-registration-transaction.mjs";
import { deriveDaejeonTimetableCounts } from "./materialize-daejeon-timetable.mjs";
import { validateSnapshot as validateTopologySnapshot } from "./materialize-daejeon-route-topology.mjs";
import { probeDaejeonCoverageApi } from "./probe-daejeon-coverage-api.mjs";
import {
  preauthenticatedObjectStorageClient,
  publishImmutableObjectPlan,
  requireCurrentCapitalLiveChainOciParBaseUrl,
} from "./publish-object-storage.mjs";
import { buildSnapshotDiff, validateLineage } from "./source-snapshot-policy.mjs";
import {
  buildAppendOnlyGovernancePolicyRegistration,
  deriveRawRetentionExpiresAt,
  validateSourceGovernancePolicy,
} from "./source-governance-policy.mjs";

const SOURCE_ID = "daejeon-train-timetable";
const TOPOLOGY_SOURCE_ID = "daejeon-station-distance-fare";
const OUTPUTS = SOURCE_REGISTRATION_OUTPUTS;
const DAY_MS = 24 * 60 * 60 * 1_000;
const FRESHNESS_POLICY_KEYS = [
  "basisField", "eventTriggers", "futureBasisAllowed", "id",
  "providerValidityEndField", "reverificationCadence", "sourceIds",
].sort(compareStrings);
const sha = (value) => createHash("sha256").update(value).digest("hex");
const json = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

/** Replays one retained timetable response and binds it to selected topology/MOLIT inputs. */
export async function prepareDaejeonTimetableRegistration({ repositoryRoot, snapshotPath, now = new Date() } = {}) {
  const root = absolute(repositoryRoot, "repository root");
  const inputPath = absolute(snapshotPath, "snapshot path");
  if (!(now instanceof Date) || Number.isNaN(now.valueOf())) {
    throw new Error("Daejeon timetable registration time is invalid");
  }
  const candidatePath = path.join(root, "tools/datapack/source-candidates.json");
  const [currentBytes, candidateBytes, snapshotBytes] = await Promise.all([
    Promise.all(OUTPUTS.map((relative) => readFile(path.join(root, relative)))),
    readFile(candidatePath),
    readFile(inputPath),
  ]);
  const [inventory, ledger, governance, freshness] = currentBytes.map((bytes) => parse(bytes, "registration output"));
  const snapshot = parse(snapshotBytes, "Daejeon timetable snapshot");
  await replayRetainedSnapshot(snapshot);

  const source = select(inventory.sources, ({ id }) => id === SOURCE_ID, "inventory source");
  const topologySource = select(inventory.sources, ({ id }) => id === TOPOLOGY_SOURCE_ID, "topology source");
  const candidate = select(parse(candidateBytes, "source candidates").candidates, ({ id }) => id === SOURCE_ID, "source candidate");
  const governanceEntry = candidate.registrationMetadata?.governance;
  const candidateFreshness = requireSourceSpecificFreshnessPolicy(candidate);
  const projectedFreshness = structuredClone(freshness);
  const existingFreshness = projectedFreshness.sourceClasses.filter(({ id }) => id === candidateFreshness.id);
  if (existingFreshness.length > 1 || (existingFreshness.length === 1
    && canonicalJson(existingFreshness[0]) !== canonicalJson(candidateFreshness))) {
    throw new Error("Daejeon timetable source-specific freshness policy is inconsistent");
  }
  if (existingFreshness.length === 0) projectedFreshness.sourceClasses.push(candidateFreshness);
  const licenseHash = sha(canonicalJson(source.license));
  validateRecordedGovernance({ source, candidate, governanceEntry, freshnessPolicy: candidateFreshness, licenseHash, now });

  const topologyEvidence = topologySource.topologyAdmissionEvidence;
  const topologyPath = admittedSnapshotPath(root, topologyEvidence?.snapshotPath, "topology");
  const topologyBytes = await readFile(topologyPath);
  const topologySnapshot = parse(topologyBytes, "Daejeon topology snapshot");
  validateTopologySnapshot(topologySnapshot);
  validateTopologyBinding({ topologySource, topologyEvidence, topologySnapshot });

  const currentMolit = await loadCurrentMolitObservation({ repositoryRoot: root, inventory, snapshots: ledger });
  const mappings = parseCurrentMolitDaejeonStationMappings(
    currentMolit.observation.normalizedProjection,
    currentMolit.current.rawSha256,
  );
  const counts = deriveDaejeonTimetableCounts({
    timetableSnapshot: snapshot,
    topologySnapshot,
    canonicalStationMappings: mappings,
  });
  const priorEvidence = requireScheduleEvidenceMetadata(source.scheduleAdmissionEvidence);
  const scheduleFreshnessMillis = Date.parse(source.scheduleAdmissionEvidence.freshUntil)
    - Date.parse(source.scheduleAdmissionEvidence.capturedAt);
  if (scheduleFreshnessMillis !== DAY_MS) {
    throw new Error("Daejeon timetable schedule freshness contract is invalid");
  }
  const scheduleFreshUntil = new Date(Date.parse(snapshot.observedAt) + scheduleFreshnessMillis).toISOString();
  if (now.valueOf() < Date.parse(snapshot.observedAt) || now.valueOf() >= Date.parse(scheduleFreshUntil)) {
    throw new Error("Daejeon timetable schedule freshness is not current");
  }
  const ledgerFreshnessExpiresAt = deriveFreshnessExpiresAt({
    policy: projectedFreshness,
    sourceClassId: candidateFreshness.id,
    basisAt: snapshot.observedAt,
    evaluationAt: now.toISOString(),
  });
  const retainedGovernance = governance.sources?.filter(({ sourceId }) => sourceId === SOURCE_ID) ?? [];
  if (retainedGovernance.length > 1 || (retainedGovernance.length === 1
    && canonicalJson(retainedGovernance[0]) !== canonicalJson(governanceEntry))) {
    throw new Error("Daejeon timetable recorded governance is inconsistent");
  }
  const projectedGovernance = retainedGovernance.length === 1
    ? governance
    : buildAppendOnlyGovernancePolicyRegistration({
      predecessorPolicyBytes: currentBytes[2],
      addedSources: [structuredClone(governanceEntry)],
    }).policy;
  const snapshotId = `${SOURCE_ID}-${compactSeoulDate(snapshot.observedAt)}`;
  const snapshotRelative = `tools/datapack/sources/${snapshotId}.json`;
  const nextEvidence = {
    ...priorEvidence,
    snapshotId,
    snapshotPath: snapshotRelative,
    capturedAt: snapshot.observedAt,
    freshUntil: scheduleFreshUntil,
    rowCount: snapshot.rowCount,
    ...counts,
    rawSha256: snapshot.rawSha256,
    rowsSha256: snapshot.rowsSha256,
    topologySourceId: TOPOLOGY_SOURCE_ID,
    topologySnapshotId: topologyEvidence.snapshotId,
    topologyContentSha256: topologySnapshot.contentSha256,
  };
  const stagedInventory = {
    ...inventory,
    sources: inventory.sources.map((row) => row.id === SOURCE_ID ? {
      ...row,
      ...(row.admissionEvidence ? { admissionEvidence: { ...row.admissionEvidence, licenseEvidenceHash: licenseHash } } : {}),
      scheduleAdmissionEvidence: nextEvidence,
      observedDataUpdatedAt: snapshot.observedAt.slice(0, 10),
      retrievedAt: snapshot.observedAt.slice(0, 10),
    } : row),
  };
  validateSourceGovernancePolicy({
    policy: projectedGovernance,
    inventory: stagedInventory,
    freshnessPolicy: projectedFreshness,
  });
  return {
    root,
    inputPath,
    snapshotBytes,
    snapshot,
    snapshotSha256: sha(snapshotBytes),
    snapshotId,
    snapshotRelative,
    currentBytes,
    candidatePath,
    candidateBytes,
    topologyPath,
    topologyBytes,
    topologySnapshot,
    currentMolit,
    inventory: stagedInventory,
    ledger,
    governance: projectedGovernance,
    freshness: projectedFreshness,
    ledgerFreshnessExpiresAt,
    rawRetentionExpiresAt: deriveRawRetentionExpiresAt({
      policy: projectedGovernance,
      sourceId: SOURCE_ID,
      retrievedAt: snapshot.observedAt,
    }),
  };
}

export async function buildDaejeonTimetableRegistrationOutputs({ receiptPath, env = process.env, ...options } = {}) {
  const prepared = await prepareDaejeonTimetableRegistration(options);
  return outputsFromPrepared(prepared, receiptPath, env, options.now ?? new Date());
}

async function outputsFromPrepared(prepared, receiptPath, env, now) {
  const receiptFile = absolute(receiptPath, "OCI receipt path");
  const receiptBytes = await readFile(receiptFile);
  const receipt = parse(receiptBytes, "OCI receipt");
  validateReceipt({ receipt, prepared, env, now });
  if (prepared.ledger.some(({ snapshotId }) => snapshotId === prepared.snapshotId)) {
    throw new Error("Daejeon timetable snapshot already registered");
  }
  const registeredInventory = {
    ...prepared.inventory,
    sources: prepared.inventory.sources.map((row) => row.id === SOURCE_ID
      ? { ...row, requiredForProductionPack: true }
      : row),
  };
  validateSourceGovernancePolicy({
    policy: prepared.governance,
    inventory: registeredInventory,
    freshnessPolicy: prepared.freshness,
  });
  const source = select(registeredInventory.sources, ({ id }) => id === SOURCE_ID, "registered source");
  const previous = prepared.ledger.filter(({ sourceId }) => sourceId === SOURCE_ID).at(-1) ?? null;
  const governanceBytes = json(prepared.governance);
  const evidence = source.scheduleAdmissionEvidence;
  const row = {
    schemaVersion: 1,
    artifactKind: "official-source-snapshot",
    sourceId: SOURCE_ID,
    snapshotId: prepared.snapshotId,
    previousSnapshotId: previous?.snapshotId ?? null,
    observedAt: prepared.snapshot.observedAt,
    capturedAt: prepared.snapshot.observedAt,
    retrievedAt: prepared.snapshot.observedAt,
    sourceUpdatedAt: null,
    provider: source.provider,
    rowCount: prepared.snapshot.rowCount,
    coverageCount: evidence.tripCount,
    rawSha256: prepared.snapshot.rawSha256,
    contentSha256: prepared.snapshot.rowsSha256,
    rawObjectUri: receipt.rawObjectUri,
    rawObjectSha256: prepared.snapshotSha256,
    rawReceiptSha256: sha(receiptBytes),
    byteSize: prepared.snapshotBytes.length,
    freshUntil: evidence.freshUntil,
    freshnessExpiresAt: prepared.ledgerFreshnessExpiresAt,
    rawRetentionExpiresAt: prepared.rawRetentionExpiresAt,
    governancePolicyVersion: prepared.governance.policyVersion,
    governancePolicySha256: sha(governanceBytes),
    schemaFingerprint: sha(canonicalJson({
      artifactKind: prepared.snapshot.artifactKind,
      keys: Object.keys(prepared.snapshot).sort(compareStrings),
    })),
    redactedRequestFingerprint: sha(canonicalJson({
      endpoint: prepared.snapshot.endpoint,
      outputFields: prepared.snapshot.outputFields,
    })),
    snapshotStatus: "LOCKED",
    schemaStatus: "PASS",
    licenseStatus: "PASS",
    fetchStatus: "SUCCESS",
    redistributionAllowed: true,
    credentialRedacted: true,
    admissionEvidence: source.admissionEvidence,
  };
  row.diffSummary = previous ? buildSnapshotDiff(previous, row) : null;
  validateLineage([...prepared.ledger.filter(({ sourceId }) => sourceId === SOURCE_ID), row]);
  const snapshotFile = path.join(prepared.root, prepared.snapshotRelative);
  await writeImmutableSnapshot(snapshotFile, prepared.snapshotBytes);
  const inputs = [
    { absolute: prepared.inputPath, bytes: prepared.snapshotBytes },
    { absolute: prepared.candidatePath, bytes: prepared.candidateBytes },
    { absolute: prepared.topologyPath, bytes: prepared.topologyBytes },
    { absolute: path.join(prepared.root, prepared.currentMolit.observationPath), bytes: prepared.currentMolit.observationBytes },
    { absolute: receiptFile, bytes: receiptBytes },
    { absolute: snapshotFile, bytes: prepared.snapshotBytes },
  ];
  const values = [json(registeredInventory), json([...prepared.ledger, row]), governanceBytes, json(prepared.freshness)];
  return OUTPUTS.map((relative, index) => ({
    relative,
    bytes: values[index],
    prestateBytes: prepared.currentBytes[index],
    inputs,
  }));
}

const transaction = createSourceRegistrationTransaction({
  label: "Daejeon timetable",
  validateOutputs(outputs) {
    const inputs = outputs?.[0]?.inputs;
    if (!Array.isArray(outputs) || !isDeepStrictEqual(outputs.map(({ relative }) => relative), OUTPUTS)
      || !Array.isArray(inputs) || new Set(inputs.map(({ absolute }) => absolute)).size !== inputs.length
      || outputs.some((row) => !Buffer.isBuffer(row.bytes) || !Buffer.isBuffer(row.prestateBytes) || row.inputs !== inputs)
      || inputs.some(({ absolute, bytes }) => !path.isAbsolute(absolute ?? "") || !Buffer.isBuffer(bytes))) {
      throw new Error("Daejeon timetable registration outputs are invalid");
    }
  },
});

export async function registerDaejeonTimetable(options = {}) {
  const root = absolute(options.repositoryRoot, "repository root");
  await transaction.recover({ repositoryRoot: root });
  return transaction.commit({ repositoryRoot: root, outputs: await buildDaejeonTimetableRegistrationOutputs(options) });
}

/** Publishes the immutable retained snapshot only after all local admission inputs validate. */
export async function publishAndRegisterDaejeonTimetable({
  expectedHeadSha,
  gitRunner = async (args, settings) => (await promisify(execFile)("git", args, settings)).stdout,
  env = process.env,
  client = null,
  ...options
} = {}) {
  const root = absolute(options.repositoryRoot, "repository root");
  const receiptPath = absolute(options.receiptPath, "OCI receipt path");
  const baseUrl = requireCurrentCapitalLiveChainOciParBaseUrl(env);
  if (!/^[a-f0-9]{40}$/u.test(expectedHeadSha ?? "")
    || String(await gitRunner(["rev-parse", "HEAD"], { cwd: root })).trim() !== expectedHeadSha) {
    throw new Error("Daejeon timetable execution HEAD mismatch");
  }
  const existing = await lstat(receiptPath).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
  if (existing) throw new Error("Daejeon timetable receipt already exists; resume registration without publication");
  await transaction.recover({ repositoryRoot: root });
  const now = options.now ?? new Date();
  const prepared = await prepareDaejeonTimetableRegistration({ ...options, now });
  const target = receiptTarget(prepared, env);
  const storage = client ?? preauthenticatedObjectStorageClient(baseUrl, { includeErrorBody: false });
  const object = {
    objectKey: target.objectKey,
    sourcePath: path.basename(prepared.inputPath),
    sha256: prepared.snapshotSha256,
    sizeBytes: prepared.snapshotBytes.length,
  };
  try {
    await publishImmutableObjectPlan({
      root: path.dirname(prepared.inputPath),
      plan: { steps: [
        { type: "put-immutable-bundle-object", ...object },
        { type: "verify-immutable-bundle-object", ...object },
      ] },
      client: {
        putObjectIfAbsent: async (...args) => {
          if (!await storage.putObjectIfAbsent(...args)) throw new Error("Daejeon timetable object already exists");
          return true;
        },
        readObject: (...args) => storage.readObject(...args),
      },
    });
  } catch {
    throw new Error("Daejeon timetable OCI publication failed");
  }
  const receipt = {
    schemaVersion: 1,
    artifactKind: "static-network-source-raw-object-receipt",
    sourceId: SOURCE_ID,
    snapshotId: prepared.snapshotId,
    capturedAt: prepared.snapshot.observedAt,
    ...target,
    rawObjectSha256: prepared.snapshotSha256,
    byteSize: prepared.snapshotBytes.length,
    storedAt: now.toISOString(),
    rawRetentionExpiresAt: prepared.rawRetentionExpiresAt,
    contentType: "application/json",
  };
  await writeFile(receiptPath, json(receipt), { flag: "wx", mode: 0o600 });
  return transaction.commit({
    repositoryRoot: root,
    outputs: await outputsFromPrepared(prepared, receiptPath, env, now),
  });
}

async function replayRetainedSnapshot(snapshot) {
  if (typeof snapshot?.rawResponseBase64 !== "string"
    || Buffer.from(snapshot.rawResponseBase64, "base64").toString("base64") !== snapshot.rawResponseBase64) {
    throw new Error("Daejeon timetable retained raw response is required");
  }
  const bytes = Buffer.from(snapshot.rawResponseBase64, "base64");
  const replay = await probeDaejeonCoverageApi({
    sourceId: SOURCE_ID,
    serviceKey: "retained-replay",
    now: new Date(snapshot.observedAt),
    fetchImpl: async () => new Response(bytes, { headers: { "content-type": "application/xml" } }),
  });
  if (!isDeepStrictEqual(snapshot, replay)) {
    throw new Error("Daejeon timetable retained snapshot replay mismatch");
  }
}

function validateTopologyBinding({ topologySource, topologyEvidence, topologySnapshot }) {
  if (topologySource?.productionUseAllowed !== true || topologySource.license?.redistributionAllowed !== true
    || topologySnapshot.sourceId !== TOPOLOGY_SOURCE_ID
    || topologyEvidence?.snapshotPath !== `tools/datapack/sources/${topologyEvidence.snapshotId}.json`
    || topologyEvidence?.capturedAt !== topologySnapshot.observedAt
    || topologyEvidence.rawSha256 !== topologySnapshot.rawSha256
    || topologyEvidence.contentSha256 !== topologySnapshot.contentSha256
    || topologyEvidence.stationCount !== topologySnapshot.stationNumbers.length
    || topologyEvidence.edgeCount !== topologySnapshot.rowCount) {
    throw new Error("Daejeon timetable selected topology binding is invalid");
  }
}

function requireScheduleEvidenceMetadata(metadata) {
  if (!Number.isInteger(metadata?.issue) || metadata.issue <= 0
    || typeof metadata.materializer !== "string" || metadata.materializer.length === 0
    || typeof metadata.verificationTest !== "string" || metadata.verificationTest.length === 0) {
    throw new Error("Daejeon timetable schedule metadata is required");
  }
  return {
    issue: metadata.issue,
    materializer: metadata.materializer,
    verificationTest: metadata.verificationTest,
  };
}

function requireSourceSpecificFreshnessPolicy(candidate) {
  const policy = candidate?.registrationMetadata?.freshness;
  if (!policy || JSON.stringify(Object.keys(policy).sort(compareStrings)) !== JSON.stringify(FRESHNESS_POLICY_KEYS)
    || typeof policy.id !== "string" || policy.id.length === 0
    || JSON.stringify(policy.sourceIds) !== JSON.stringify([SOURCE_ID])
    || policy.basisField !== "observedAt" || policy.futureBasisAllowed !== false
    || typeof policy.reverificationCadence !== "string" || policy.reverificationCadence.length === 0
    || !(policy.providerValidityEndField === null || typeof policy.providerValidityEndField === "string")
    || !Array.isArray(policy.eventTriggers) || policy.eventTriggers.length === 0
    || policy.eventTriggers.some((value) => typeof value !== "string" || value.trim() === "")) {
    throw new Error("Daejeon timetable source-specific freshness policy is required");
  }
  return structuredClone(policy);
}

function validateRecordedGovernance({ source, candidate, governanceEntry, freshnessPolicy, licenseHash, now }) {
  const review = governanceEntry?.licenseReview;
  if (source?.productionUseAllowed !== true || source.license?.redistributionAllowed !== true
    || candidate?.domain !== "schedule_timetable" || governanceEntry?.sourceId !== SOURCE_ID
    || governanceEntry.sourceClassId !== freshnessPolicy.id || review?.status !== "APPROVED"
    || review.termsHash !== licenseHash || review.termsUrl !== source.license.evidenceUrl
    || review.reviewedProvider !== source.provider || review.reviewedDatasetUrl !== source.datasetUrl
    || review.approvedByRole !== governanceEntry.approvalRole
    || !instant(review.reviewedAt) || !instant(review.nextReviewAt)
    || Date.parse(review.reviewedAt) > now.valueOf() || Date.parse(review.nextReviewAt) <= now.valueOf()) {
    throw new Error("Daejeon timetable recorded governance and license binding is required");
  }
}

function receiptTarget(prepared, env) {
  const baseUrl = requireCurrentCapitalLiveChainOciParBaseUrl(env);
  const match = /^\/p\/[^/]+\/n\/([^/]+)\/b\/([^/]+)\/o\/?$/u.exec(baseUrl.pathname);
  const [, ociNamespace, bucket] = match ?? [];
  const date = compactSeoulDate(prepared.snapshot.observedAt);
  const objectKey = `source-raw/${SOURCE_ID}/${date}/${prepared.snapshotSha256}.json`;
  return { ociNamespace, bucket, objectKey, rawObjectUri: `oci://${ociNamespace}/${bucket}/${objectKey}` };
}

function validateReceipt({ receipt, prepared, env, now }) {
  const target = receiptTarget(prepared, env);
  const keys = [
    "schemaVersion", "artifactKind", "sourceId", "snapshotId", "capturedAt", "rawObjectUri",
    "rawObjectSha256", "byteSize", "storedAt", "rawRetentionExpiresAt", "ociNamespace",
    "bucket", "objectKey", "contentType",
  ];
  if (JSON.stringify(Object.keys(receipt ?? {}).sort()) !== JSON.stringify(keys.sort())
    || receipt.schemaVersion !== 1 || receipt.artifactKind !== "static-network-source-raw-object-receipt"
    || receipt.sourceId !== SOURCE_ID || receipt.snapshotId !== prepared.snapshotId
    || receipt.capturedAt !== prepared.snapshot.observedAt || receipt.rawObjectSha256 !== prepared.snapshotSha256
    || receipt.byteSize !== prepared.snapshotBytes.length || receipt.ociNamespace !== target.ociNamespace
    || receipt.bucket !== target.bucket || receipt.objectKey !== target.objectKey || receipt.rawObjectUri !== target.rawObjectUri
    || receipt.contentType !== "application/json" || !instant(receipt.storedAt) || !instant(receipt.rawRetentionExpiresAt)
    || Date.parse(receipt.storedAt) < Date.parse(receipt.capturedAt) || Date.parse(receipt.storedAt) > now.valueOf()
    || receipt.rawRetentionExpiresAt !== prepared.rawRetentionExpiresAt) {
    throw new Error("Daejeon timetable OCI receipt binding is invalid");
  }
}

async function writeImmutableSnapshot(file, bytes) {
  await writeFile(file, bytes, { flag: "wx", mode: 0o600 }).catch(async (error) => {
    if (error?.code !== "EEXIST" || !(await readFile(file)).equals(bytes)) throw error;
  });
}

function admittedSnapshotPath(root, relative, label) {
  if (typeof relative !== "string" || !/^tools\/datapack\/sources\/[^/]+\.json$/u.test(relative)) {
    throw new Error(`Daejeon timetable ${label} admitted snapshot path is invalid`);
  }
  return path.join(root, relative);
}

function compactSeoulDate(value) {
  if (!instant(value)) throw new Error("Daejeon timetable snapshot observedAt is invalid");
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(value)).map(({ type, value: part }) => [type, part]));
  return `${parts.year}${parts.month}${parts.day}`;
}

function select(rows, predicate, label) {
  const matches = Array.isArray(rows) ? rows.filter((row) => predicate(row)) : [];
  if (matches.length !== 1) throw new Error(`Daejeon timetable ${label} is invalid`);
  return matches[0];
}

function absolute(value, label) {
  if (!path.isAbsolute(value ?? "")) throw new Error(`Daejeon timetable ${label} must be absolute`);
  return path.resolve(value);
}

function parse(bytes, label) {
  try { return JSON.parse(bytes); } catch { throw new Error(`Daejeon timetable ${label} is invalid JSON`); }
}

function instant(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function parseArgs(argv) {
  const publish = argv[0] === "publish-register";
  if ((!publish && argv[0] !== "register") || argv.length !== (publish ? 7 : 5)
    || argv[1] !== "--snapshot" || argv[3] !== "--receipt"
    || !path.isAbsolute(argv[2]) || !path.isAbsolute(argv[4])
    || (publish && (argv[5] !== "--expected-head" || !/^[a-f0-9]{40}$/u.test(argv[6])))) {
    throw new Error(
      "usage: register-daejeon-timetable.mjs register|publish-register "
        + "--snapshot <absolute.json> --receipt <absolute.json> [--expected-head <sha>]",
    );
  }
  return { publish, snapshotPath: argv[2], receiptPath: argv[4], ...(publish ? { expectedHeadSha: argv[6] } : {}) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const { publish, ...inputs } = parseArgs(process.argv.slice(2));
    const options = { repositoryRoot: path.resolve(import.meta.dirname, "../.."), ...inputs };
    if (publish) await publishAndRegisterDaejeonTimetable(options);
    else await registerDaejeonTimetable(options);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Daejeon timetable registration failed");
    process.exitCode = 1;
  }
}
