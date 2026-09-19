#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual, promisify } from "node:util";

import { parseCurrentMolitDaejeonStationMappings } from "./build-molit-nationwide-fixture.mjs";
import { collectDaejeonRouteTopology } from "./collect-daejeon-route-topology.mjs";
import { loadCurrentMolitObservation } from "./current-molit-observation.mjs";
import { deriveFreshnessExpiresAt } from "./freshness-policy.mjs";
import { canonicalJson } from "./lib/manifest-validation.mjs";
import { buildDaejeonTopologyDependents } from "./lib/daejeon-topology-dependents.mjs";
import { compareStrings } from "./lib/ledger-admission-cli.mjs";
import { SOURCE_REGISTRATION_OUTPUTS, createSourceRegistrationTransaction } from "./lib/source-registration-transaction.mjs";
import { validateSnapshot } from "./materialize-daejeon-route-topology.mjs";
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

const SOURCE_ID = "daejeon-station-distance-fare";
const MEMBERSHIP_SOURCE_ID = "molit-urban-rail-full-route-daejeon-membership";
const LINE_ID = "line-7051a9c2525c";
const OUTPUTS = SOURCE_REGISTRATION_OUTPUTS;
const sha = (value) => createHash("sha256").update(value).digest("hex");
const json = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const DEPENDENT_INPUT_KEYS = Object.freeze([
  "mapXlsxPath", "schematicCanvasPath", "elevatorPath", "escalatorPath",
]);

/** 재수집 없이 보존한 topology 원문과 현재 MOLIT membership을 하나의 등록 입력으로 묶는다. */
export async function prepareDaejeonTopologyRegistration({ repositoryRoot, snapshotPath, now = new Date() } = {}) {
  const root = absolute(repositoryRoot, "repository root");
  const inputPath = absolute(snapshotPath, "snapshot path");
  if (!(now instanceof Date) || Number.isNaN(now.valueOf())) {
    throw new Error("Daejeon topology registration time is invalid");
  }
  const candidatePath = path.join(root, "tools/datapack/source-candidates.json");
  const [currentBytes, candidateBytes, snapshotBytes] = await Promise.all([
    Promise.all(OUTPUTS.map((relative) => readFile(path.join(root, relative)))),
    readFile(candidatePath),
    readFile(inputPath),
  ]);
  const [inventory, ledger, governance, freshness] = currentBytes.map((bytes) => parse(bytes, "registration output"));
  const snapshot = parse(snapshotBytes, "Daejeon topology snapshot");
  validateSnapshot(snapshot);
  await replayRetainedSnapshot(snapshot);

  const source = select(inventory.sources, ({ id }) => id === SOURCE_ID, "inventory source");
  const membershipSource = select(inventory.sources, ({ id }) => id === MEMBERSHIP_SOURCE_ID, "membership source");
  const candidate = select(parse(candidateBytes, "source candidates").candidates, ({ id }) => id === SOURCE_ID, "source candidate");
  const dependentInputs = candidate.registrationMetadata?.dependentInputs;
  if (!DEPENDENT_INPUT_KEYS.every((key) => typeof dependentInputs?.[key] === "string")) {
    throw new Error("Daejeon topology dependent inputs are required");
  }
  const dependentPaths = Object.fromEntries(DEPENDENT_INPUT_KEYS.map((key) => [
    key,
    dependentInputPath(root, dependentInputs[key]),
  ]));
  const timetableSource = select(inventory.sources, ({ id }) => id === "daejeon-train-timetable", "timetable source");
  const timetablePath = admittedSnapshotPath(root, timetableSource.scheduleAdmissionEvidence?.snapshotPath);
  const [mapXlsxBytes, schematicCanvasBytes, elevatorBytes, escalatorBytes, timetableSnapshotBytes] = await Promise.all([
    readFile(dependentPaths.mapXlsxPath),
    readFile(dependentPaths.schematicCanvasPath),
    readFile(dependentPaths.elevatorPath),
    readFile(dependentPaths.escalatorPath),
    readFile(timetablePath),
  ]);
  const registrationInputs = [
    { absolute: candidatePath, bytes: candidateBytes },
    { absolute: dependentPaths.mapXlsxPath, bytes: mapXlsxBytes },
    { absolute: dependentPaths.schematicCanvasPath, bytes: schematicCanvasBytes },
    { absolute: dependentPaths.elevatorPath, bytes: elevatorBytes },
    { absolute: dependentPaths.escalatorPath, bytes: escalatorBytes },
    { absolute: timetablePath, bytes: timetableSnapshotBytes },
  ];
  const governanceEntry = candidate.registrationMetadata?.governance;
  const projectedFreshness = structuredClone(freshness);
  const sourceClass = select(projectedFreshness.sourceClasses, ({ id }) => id === governanceEntry?.sourceClassId, "freshness class");
  if (!sourceClass.sourceIds.includes(SOURCE_ID)) sourceClass.sourceIds.push(SOURCE_ID);
  const licenseHash = sha(canonicalJson(source.license));
  validateRecordedGovernance({ source, candidate, governanceEntry, sourceClass, licenseHash, now });
  const freshUntil = deriveFreshnessExpiresAt({
    policy: projectedFreshness,
    sourceClassId: sourceClass.id,
    basisAt: snapshot.observedAt,
    evaluationAt: now.toISOString(),
  });
  if (now.valueOf() < Date.parse(snapshot.observedAt) || now.valueOf() >= Date.parse(freshUntil)) {
    throw new Error("Daejeon topology freshness is not current");
  }
  const retainedGovernance = governance.sources?.filter(({ sourceId }) => sourceId === SOURCE_ID) ?? [];
  if (retainedGovernance.length > 1 || (retainedGovernance.length === 1
    && canonicalJson(retainedGovernance[0]) !== canonicalJson(governanceEntry))) {
    throw new Error("Daejeon topology recorded governance is inconsistent");
  }
  const projectedGovernance = retainedGovernance.length === 1
    ? governance
    : buildAppendOnlyGovernancePolicyRegistration({
      predecessorPolicyBytes: currentBytes[2],
      addedSources: [structuredClone(governanceEntry)],
    }).policy;
  const snapshotSha256 = sha(snapshotBytes);
  const snapshotId = `${SOURCE_ID}-${snapshotSha256}`;
  const snapshotRelative = `tools/datapack/sources/${snapshotId}.json`;
  const nextTopologyEvidence = {
    ...requireEvidenceMetadata(source.topologyAdmissionEvidence, "topology"),
    snapshotId,
    snapshotPath: snapshotRelative,
    capturedAt: snapshot.observedAt,
    freshUntil,
    stationCount: snapshot.stationNumbers.length,
    edgeCount: snapshot.rowCount,
    excludedTransferCount: snapshot.excludedTransferCount,
    rawSha256: snapshot.rawSha256,
    contentSha256: snapshot.contentSha256,
  };
  let stagedInventory = {
    ...inventory,
    sources: inventory.sources.map((row) => row.id === SOURCE_ID
      ? {
        ...row,
        admissionEvidence: { ...row.admissionEvidence, licenseEvidenceHash: licenseHash },
        topologyAdmissionEvidence: nextTopologyEvidence,
        observedDataUpdatedAt: snapshot.observedAt.slice(0, 10),
        retrievedAt: snapshot.observedAt.slice(0, 10),
      }
      : row),
  };
  const currentMolit = await loadCurrentMolitObservation({
    repositoryRoot: root,
    inventory: stagedInventory,
    snapshots: ledger,
  });
  const mappings = parseCurrentMolitDaejeonStationMappings(
    currentMolit.observation.normalizedProjection,
    currentMolit.current.rawSha256,
  );
  const membership = refreshedMembershipEvidence({
    topologySource: source,
    membershipSource,
    currentMolit,
    mappings,
    topologySnapshotId: snapshotId,
    topologyContentSha256: snapshot.contentSha256,
  });
  stagedInventory = {
    ...stagedInventory,
    sources: stagedInventory.sources.map((row) => [SOURCE_ID, MEMBERSHIP_SOURCE_ID].includes(row.id)
      ? { ...row, membershipAdmissionEvidence: membership }
      : row),
  };
  const dependents = buildDaejeonTopologyDependents({
    inventory: stagedInventory,
    topologySnapshot: snapshot,
    topologySource: select(stagedInventory.sources, ({ id }) => id === SOURCE_ID, "staged topology source"),
    mapXlsxBytes,
    schematicCanvas: parse(schematicCanvasBytes, "Daejeon schematic canvas"),
    elevatorBytes,
    escalatorBytes,
    canonicalStationMappings: mappings,
    timetableSnapshotBytes,
  });
  stagedInventory = dependents.inventory;
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
    snapshotSha256,
    snapshotId,
    snapshotRelative,
    currentBytes,
    candidatePath,
    candidateBytes,
    registrationInputs,
    dependentSnapshots: dependents.snapshots,
    inventory: stagedInventory,
    ledger,
    governance: projectedGovernance,
    freshness: projectedFreshness,
    currentMolit,
    rawRetentionExpiresAt: deriveRawRetentionExpiresAt({
      policy: projectedGovernance,
      sourceId: SOURCE_ID,
      retrievedAt: snapshot.observedAt,
    }),
  };
}

export async function buildDaejeonTopologyRegistrationOutputs({ receiptPath, env = process.env, ...options } = {}) {
  const prepared = await prepareDaejeonTopologyRegistration(options);
  return outputsFromPrepared(prepared, receiptPath, env, options.now ?? new Date());
}

async function outputsFromPrepared(prepared, receiptPath, env, now) {
  const receiptFile = absolute(receiptPath, "OCI receipt path");
  const receiptBytes = await readFile(receiptFile);
  const receipt = parse(receiptBytes, "OCI receipt");
  validateReceipt({ receipt, prepared, env, now });
  if (prepared.ledger.some(({ snapshotId }) => snapshotId === prepared.snapshotId)) {
    throw new Error("Daejeon topology snapshot already registered");
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
  const row = {
    schemaVersion: 1,
    artifactKind: "official-source-snapshot",
    sourceId: SOURCE_ID,
    snapshotId: prepared.snapshotId,
    previousSnapshotId: previous?.snapshotId ?? null,
    capturedAt: prepared.snapshot.observedAt,
    retrievedAt: prepared.snapshot.observedAt,
    sourceUpdatedAt: null,
    provider: source.provider,
    rowCount: prepared.snapshot.rowCount,
    coverageCount: prepared.snapshot.stationNumbers.length,
    rawSha256: prepared.snapshot.rawSha256,
    contentSha256: prepared.snapshot.contentSha256,
    rawObjectUri: receipt.rawObjectUri,
    rawObjectSha256: prepared.snapshotSha256,
    rawReceiptSha256: sha(receiptBytes),
    byteSize: prepared.snapshotBytes.length,
    freshUntil: prepared.inventory.sources.find(({ id }) => id === SOURCE_ID).topologyAdmissionEvidence.freshUntil,
    freshnessExpiresAt: prepared.inventory.sources.find(({ id }) => id === SOURCE_ID).topologyAdmissionEvidence.freshUntil,
    rawRetentionExpiresAt: prepared.rawRetentionExpiresAt,
    governancePolicyVersion: prepared.governance.policyVersion,
    governancePolicySha256: sha(governanceBytes),
    schemaFingerprint: sha(canonicalJson({ artifactKind: prepared.snapshot.artifactKind, keys: Object.keys(prepared.snapshot).sort(compareStrings) })),
    redactedRequestFingerprint: sha(canonicalJson({
      endpoint: prepared.snapshot.endpoint,
      stationNumbers: prepared.snapshot.stationNumbers,
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
  for (const dependent of prepared.dependentSnapshots) {
    await writeImmutableSnapshot(path.join(prepared.root, dependent.relative), dependent.bytes);
  }
  const inputs = [
    { absolute: prepared.inputPath, bytes: prepared.snapshotBytes },
    ...prepared.registrationInputs,
    { absolute: path.join(prepared.root, prepared.currentMolit.observationPath), bytes: prepared.currentMolit.observationBytes },
    { absolute: receiptFile, bytes: receiptBytes },
    { absolute: snapshotFile, bytes: prepared.snapshotBytes },
    ...prepared.dependentSnapshots.map((dependent) => ({
      absolute: path.join(prepared.root, dependent.relative), bytes: dependent.bytes,
    })),
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
  label: "Daejeon topology",
  validateOutputs(outputs) {
    const inputs = outputs?.[0]?.inputs;
    if (!Array.isArray(outputs) || !isDeepStrictEqual(outputs.map(({ relative }) => relative), OUTPUTS)
      || !Array.isArray(inputs) || new Set(inputs.map(({ absolute }) => absolute)).size !== inputs.length
      || outputs.some((row) => !Buffer.isBuffer(row.bytes) || !Buffer.isBuffer(row.prestateBytes) || row.inputs !== inputs)
      || inputs.some(({ absolute, bytes }) => !path.isAbsolute(absolute ?? "") || !Buffer.isBuffer(bytes))) {
      throw new Error("Daejeon topology registration outputs are invalid");
    }
  },
});

export async function registerDaejeonTopology(options = {}) {
  const root = absolute(options.repositoryRoot, "repository root");
  await transaction.recover({ repositoryRoot: root });
  return transaction.commit({ repositoryRoot: root, outputs: await buildDaejeonTopologyRegistrationOutputs(options) });
}

/** 원문 재수집 없이 동일한 snapshot bytes를 OCI에 한 번 발행하고 등록한다. */
export async function publishAndRegisterDaejeonTopology({
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
    throw new Error("Daejeon topology execution HEAD mismatch");
  }
  const existing = await lstat(receiptPath).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
  if (existing) throw new Error("Daejeon topology receipt already exists; resume registration without publication");
  await transaction.recover({ repositoryRoot: root });
  const now = options.now ?? new Date();
  const prepared = await prepareDaejeonTopologyRegistration({ ...options, now });
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
          if (!await storage.putObjectIfAbsent(...args)) throw new Error("Daejeon topology object already exists");
          return true;
        },
        readObject: (...args) => storage.readObject(...args),
      },
    });
  } catch {
    throw new Error("Daejeon topology OCI publication failed");
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
  if (!Array.isArray(snapshot.rawResponses) || snapshot.rawResponses.length !== snapshot.rowCount) {
    throw new Error("Daejeon topology retained raw responses are required");
  }
  let cursor = 0;
  const replay = await collectDaejeonRouteTopology({
    serviceKey: "retained-replay",
    now: new Date(snapshot.observedAt),
    fetchImpl: async (url) => {
      const response = snapshot.rawResponses[cursor++];
      const bytes = Buffer.from(response?.bytesBase64 ?? "", "base64");
      if (response?.fromStationNumber !== new URL(url).searchParams.get("strstnno")
        || response?.toStationNumber !== new URL(url).searchParams.get("endstnno")
        || bytes.toString("base64") !== response.bytesBase64) {
        throw new Error("Daejeon topology retained raw response binding mismatch");
      }
      return new Response(bytes, { headers: { "content-type": "application/xml" } });
    },
  });
  if (cursor !== snapshot.rawResponses.length || !isDeepStrictEqual(snapshot, replay)) {
    throw new Error("Daejeon topology retained snapshot replay mismatch");
  }
}

function refreshedMembershipEvidence({
  topologySource,
  membershipSource,
  currentMolit,
  mappings,
  topologySnapshotId,
  topologyContentSha256,
}) {
  const topologyMetadata = requireEvidenceMetadata(topologySource.membershipAdmissionEvidence, "membership");
  const membershipMetadata = requireEvidenceMetadata(membershipSource.membershipAdmissionEvidence, "membership");
  if (!isDeepStrictEqual(topologyMetadata, membershipMetadata)) {
    throw new Error("Daejeon membership metadata pair mismatch");
  }
  const mappingSha256 = sha(JSON.stringify(mappings));
  const stationCodesSha256 = sha(JSON.stringify(mappings.map(({ stationNumber }) => stationNumber)));
  const snapshotId = `${MEMBERSHIP_SOURCE_ID}-${sha(canonicalJson({
    molitSnapshotId: currentMolit.current.snapshotId,
    membershipSourceRawSha256: currentMolit.current.rawSha256,
    mappingSha256,
    stationCodesSha256,
  }))}`;
  return {
    ...topologyMetadata,
    snapshotId,
    lineIds: [LINE_ID],
    verifiedAt: currentMolit.current.retrievedAt,
    stationCount: mappings.length,
    membershipSourceId: "molit-urban-rail-full-route",
    membershipSourceRawSha256: currentMolit.current.rawSha256,
    membershipSourceSnapshotSha256: mappings.sourceRawSha256,
    mappingSha256,
    stationCodesSha256,
    stationCodeSourceId: SOURCE_ID,
    stationCodeSnapshotId: topologySnapshotId,
    stationCodeContentSha256: topologyContentSha256,
  };
}

function validateRecordedGovernance({ source, candidate, governanceEntry, sourceClass, licenseHash, now }) {
  const review = governanceEntry?.licenseReview;
  if (source?.productionUseAllowed !== true || source.license?.redistributionAllowed !== true
    || candidate?.domain !== "route_graph_topology" || governanceEntry?.sourceId !== SOURCE_ID
    || governanceEntry.sourceClassId !== sourceClass.id || review?.status !== "APPROVED"
    || review.termsHash !== licenseHash || review.termsUrl !== source.license.evidenceUrl
    || review.reviewedProvider !== source.provider || review.reviewedDatasetUrl !== source.datasetUrl
    || review.approvedByRole !== governanceEntry.approvalRole
    || !instant(review.reviewedAt) || !instant(review.nextReviewAt)
    || Date.parse(review.reviewedAt) > now.valueOf() || Date.parse(review.nextReviewAt) <= now.valueOf()) {
    throw new Error("Daejeon topology recorded governance and license binding is required");
  }
}

function requireEvidenceMetadata(metadata, label) {
  if (!Number.isInteger(metadata?.issue) || metadata.issue <= 0
    || typeof metadata.materializer !== "string" || metadata.materializer.length === 0
    || typeof metadata.verificationTest !== "string" || metadata.verificationTest.length === 0) {
    throw new Error(`Daejeon ${label} metadata is required`);
  }
  return {
    issue: metadata.issue,
    materializer: metadata.materializer,
    verificationTest: metadata.verificationTest,
  };
}

function receiptTarget(prepared, env) {
  const baseUrl = requireCurrentCapitalLiveChainOciParBaseUrl(env);
  const match = /^\/p\/[^/]+\/n\/([^/]+)\/b\/([^/]+)\/o\/?$/u.exec(baseUrl.pathname);
  const [, ociNamespace, bucket] = match ?? [];
  const date = prepared.snapshot.observedAt.slice(0, 10).replaceAll("-", "");
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
    throw new Error("Daejeon topology OCI receipt binding is invalid");
  }
}

async function writeImmutableSnapshot(file, bytes) {
  await writeFile(file, bytes, { flag: "wx", mode: 0o600 }).catch(async (error) => {
    if (error?.code !== "EEXIST" || !(await readFile(file)).equals(bytes)) throw error;
  });
}

function dependentInputPath(root, relative) {
  if (typeof relative !== "string" || !relative || path.isAbsolute(relative)
    || relative.split(/[\\/]/u).includes("..")) {
    throw new Error("Daejeon topology dependent input path is invalid");
  }
  return path.join(root, relative);
}

function admittedSnapshotPath(root, relative) {
  if (typeof relative !== "string" || !/^tools\/datapack\/sources\/[^/]+\.json$/u.test(relative)) {
    throw new Error("Daejeon timetable admitted snapshot path is invalid");
  }
  return path.join(root, relative);
}

function select(rows, predicate, label) {
  const matches = Array.isArray(rows) ? rows.filter((row) => predicate(row)) : [];
  if (matches.length !== 1) throw new Error(`Daejeon topology ${label} is invalid`);
  return matches[0];
}

function absolute(value, label) {
  if (!path.isAbsolute(value ?? "")) throw new Error(`Daejeon topology ${label} must be absolute`);
  return path.resolve(value);
}

function parse(bytes, label) {
  try { return JSON.parse(bytes); } catch { throw new Error(`Daejeon topology ${label} is invalid JSON`); }
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
      "usage: register-daejeon-route-topology.mjs register|publish-register "
        + "--snapshot <absolute.json> --receipt <absolute.json> [--expected-head <sha>]",
    );
  }
  return { publish, snapshotPath: argv[2], receiptPath: argv[4], ...(publish ? { expectedHeadSha: argv[6] } : {}) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const { publish, ...inputs } = parseArgs(process.argv.slice(2));
    const options = { repositoryRoot: path.resolve(import.meta.dirname, "../.."), ...inputs };
    if (publish) await publishAndRegisterDaejeonTopology(options);
    else await registerDaejeonTopology(options);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Daejeon topology registration failed");
    process.exitCode = 1;
  }
}
