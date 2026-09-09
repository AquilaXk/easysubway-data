#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual, promisify } from "node:util";

import {
  DAEGU_LINES,
  daeguSourceSnapshotIdentity,
  parseDaeguRouteTopology,
  parseDaeguTrainTimetable,
} from "./collect-daegu-datapack-sources.mjs";
import { parseCurrentMolitDaeguStationMappings } from "./build-molit-nationwide-fixture.mjs";
import { loadCurrentMolitObservation } from "./current-molit-observation.mjs";
import { deriveFreshnessExpiresAt } from "./freshness-policy.mjs";
import { canonicalJson } from "./lib/manifest-validation.mjs";
import { compareStrings } from "./lib/ledger-admission-cli.mjs";
import { SOURCE_REGISTRATION_OUTPUTS, createSourceRegistrationTransaction } from "./lib/source-registration-transaction.mjs";
import { buildDaeguTopologyDependents } from "./lib/daegu-topology-dependents.mjs";
import { daeguMembershipSnapshotIdentity } from "./materialize-daegu-timetable.mjs";
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

const OUTPUTS = SOURCE_REGISTRATION_OUTPUTS;
const MOLIT_SOURCE_ID = "molit-urban-rail-full-route";
const MAP_SOURCE_ID = "daegu-transportation-route-map-positions";
const SOURCE_IDS = Object.freeze(DAEGU_LINES.flatMap(({ lineNumber }) => [
  `daegu-line${lineNumber}-route-topology`,
  `daegu-line${lineNumber}-train-timetable`,
]));
const TOPOLOGY_SOURCE_IDS = Object.freeze(DAEGU_LINES
  .map(({ lineNumber }) => `daegu-line${lineNumber}-route-topology`));
const TIMETABLE_SOURCE_IDS = Object.freeze(DAEGU_LINES
  .map(({ lineNumber }) => `daegu-line${lineNumber}-train-timetable`));
const FRESHNESS_POLICY_KEYS = [
  "basisField", "eventTriggers", "futureBasisAllowed", "id",
  "providerValidityEndField", "reverificationCadence", "sourceIds",
].sort(compareStrings);
const sha = (value) => createHash("sha256").update(value).digest("hex");
const json = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

/** Prepares six source updates without mutating the repository or OCI. */
export async function prepareDaeguSourceRegistration({
  repositoryRoot,
  inputDirectory,
  capturedAt,
  now = new Date(),
} = {}) {
  const root = absolute(repositoryRoot, "repository root");
  const inputDir = absolute(inputDirectory, "input directory");
  if (!instant(capturedAt) || !(now instanceof Date) || Number.isNaN(now.valueOf())) {
    throw new Error("Daegu source registration time is invalid");
  }
  const candidatePath = path.join(root, "tools/datapack/source-candidates.json");
  const [currentBytes, candidateBytes, rawByDataset] = await Promise.all([
    Promise.all(OUTPUTS.map((relative) => readFile(path.join(root, relative)))),
    readFile(candidatePath),
    readRawInputs(inputDir),
  ]);
  const [inventory, ledger, governance, freshness] = currentBytes.map((bytes) => parse(bytes, "registration output"));
  const snapshots = sourceSnapshotsFromRaw(rawByDataset, capturedAt);
  if (snapshots.some((snapshot) => now.valueOf() < Date.parse(snapshot.capturedAt)
    || now.valueOf() >= Date.parse(snapshot.freshUntil))) {
    throw new Error("Daegu source snapshot freshness is not current");
  }
  const candidates = parse(candidateBytes, "source candidates").candidates;
  const sources = SOURCE_IDS.map((sourceId) => select(inventory.sources, ({ id }) => id === sourceId, sourceId));
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const candidateById = new Map(SOURCE_IDS.map((sourceId) => [
    sourceId,
    select(candidates, ({ id }) => id === sourceId, `${sourceId} candidate`),
  ]));
  const projectedFreshness = projectFreshness({ freshness, candidateById });
  const governanceEntries = SOURCE_IDS.map((sourceId) => {
    const source = sourceById.get(sourceId);
    const candidate = candidateById.get(sourceId);
    const entry = candidate.registrationMetadata?.governance;
    validateRecordedGovernance({
      source,
      candidate,
      entry,
      sourceClassId: entry?.sourceClassId,
      now,
    });
    return entry;
  });
  const projectedGovernance = projectGovernance({
    governance,
    governanceBytes: currentBytes[2],
    governanceEntries,
  });
  const currentMolit = await loadCurrentMolitObservation({ repositoryRoot: root, inventory, snapshots: ledger });
  const snapshotById = new Map(snapshots.map((snapshot) => [snapshot.sourceId, snapshot]));
  const membershipByLine = new Map(DAEGU_LINES.map((config) => {
    const topology = snapshotById.get(`daegu-line${config.lineNumber}-route-topology`);
    const mappings = parseCurrentMolitDaeguStationMappings(
      currentMolit.observation.normalizedProjection,
      currentMolit.current.rawSha256,
      config.lineName,
    );
    const topologySource = select(inventory.sources,
      ({ id }) => id === `daegu-line${config.lineNumber}-route-topology`, `Daegu line ${config.lineNumber} topology`);
    const membershipSource = select(inventory.sources,
      ({ id }) => id === `${MOLIT_SOURCE_ID}-daegu-line${config.lineNumber}-membership`, `Daegu line ${config.lineNumber} membership`);
    return [config.lineNumber, {
      config,
      topology,
      membershipEvidence: refreshedMembershipEvidence({
        topologySource,
        membershipSource,
        currentMolit,
        mappings,
        stationCodes: topology.scope.map(({ stationCode }) => stationCode),
        topologySnapshotId: daeguSourceSnapshotIdentity(topology),
        topologyContentSha256: topology.contentSha256,
      }),
    }];
  }));
  const stagedInventory = {
    ...inventory,
    sources: inventory.sources.map((source) => {
      const config = DAEGU_LINES.find((line) => source.id === `daegu-line${line.lineNumber}-route-topology`
        || source.id === `daegu-line${line.lineNumber}-train-timetable`
        || source.id === `${MOLIT_SOURCE_ID}-daegu-line${line.lineNumber}-membership`);
      if (!config) return source;
      const membership = membershipByLine.get(config.lineNumber);
      if (source.id === `${MOLIT_SOURCE_ID}-daegu-line${config.lineNumber}-membership`) {
        return projectMembershipSource({ source, membershipEvidence: membership.membershipEvidence });
      }
      const topologyId = `daegu-line${config.lineNumber}-route-topology`;
      const timetableId = `daegu-line${config.lineNumber}-train-timetable`;
      const topology = snapshotById.get(topologyId);
      const timetable = snapshotById.get(timetableId);
      if (source.id === topologyId) {
        return projectTopologySource({ source, topology, membershipEvidence: membership.membershipEvidence });
      }
      return projectTimetableSource({ source, timetable, topology });
    }),
  };
  const dependents = await prepareDaeguTopologyDependents({
    root,
    inventory: stagedInventory,
    candidates,
    topologySnapshots: Object.fromEntries(DAEGU_LINES.map(({ lineNumber }) => [
      lineNumber,
      snapshotById.get(`daegu-line${lineNumber}-route-topology`),
    ])),
    topologyInputs: DAEGU_LINES.map(({ lineNumber }) => {
      const topology = snapshotById.get(`daegu-line${lineNumber}-route-topology`);
      const snapshotId = daeguSourceSnapshotIdentity(topology);
      return {
        sourceId: topology.sourceId,
        absolute: path.join(root, `tools/datapack/sources/${snapshotId}.json`),
        bytes: snapshotBytes(topology),
      };
    }),
  });
  stagedInventory = dependents.inventory;
  validateSourceGovernancePolicy({
    policy: projectedGovernance,
    inventory: stagedInventory,
    freshnessPolicy: projectedFreshness,
  });
  const sourcesById = new Map(stagedInventory.sources.map((source) => [source.id, source]));
  const registration = snapshots.map((snapshot) => {
    const source = sourcesById.get(snapshot.sourceId);
    const sourceClassId = candidateById.get(snapshot.sourceId).registrationMetadata.governance.sourceClassId;
    const evidence = snapshot.artifactKind === "daegu-route-topology-snapshot"
      ? source.topologyAdmissionEvidence : source.scheduleAdmissionEvidence;
    return {
      source,
      snapshot,
      snapshotBytes: snapshotBytes(snapshot),
      snapshotId: daeguSourceSnapshotIdentity(snapshot),
      snapshotRelative: `tools/datapack/sources/${daeguSourceSnapshotIdentity(snapshot)}.json`,
      evidence,
      sourceClassId,
      ledgerFreshnessExpiresAt: deriveFreshnessExpiresAt({
        policy: projectedFreshness,
        sourceClassId,
        basisAt: snapshot.capturedAt,
        evaluationAt: now.toISOString(),
      }),
      rawRetentionExpiresAt: deriveRawRetentionExpiresAt({
        policy: projectedGovernance,
        sourceId: snapshot.sourceId,
        retrievedAt: snapshot.capturedAt,
      }),
    };
  });
  return {
    root,
    inputDir,
    capturedAt,
    currentBytes,
    candidatePath,
    candidateBytes,
    rawByDataset,
    snapshots,
    currentMolit,
    inventory: stagedInventory,
    ledger,
    governance: projectedGovernance,
    freshness: projectedFreshness,
    registration,
    dependentSnapshot: dependents.snapshot,
    dependentInputs: dependents.inputs,
  };
}

export async function buildDaeguSourceRegistrationOutputs({ receiptPaths, env = process.env, ...options } = {}) {
  const prepared = await prepareDaeguSourceRegistration(options);
  const receipts = await readVerifiedReceipts({ receiptPaths, prepared, env, now: options.now ?? new Date() });
  return outputsFromPrepared(prepared, receipts);
}

async function outputsFromPrepared(prepared, receipts) {
  if (prepared.registration.some(({ snapshotId }) => prepared.ledger.some((row) => row.snapshotId === snapshotId))) {
    throw new Error("Daegu source snapshot is already registered");
  }
  const registeredInventory = {
    ...prepared.inventory,
    sources: prepared.inventory.sources.map((source) => SOURCE_IDS.includes(source.id)
      ? { ...source, requiredForProductionPack: true }
      : source),
  };
  validateSourceGovernancePolicy({
    policy: prepared.governance,
    inventory: registeredInventory,
    freshnessPolicy: prepared.freshness,
  });
  const governanceBytes = json(prepared.governance);
  const rows = [];
  const inputs = [
    { absolute: prepared.candidatePath, bytes: prepared.candidateBytes },
    { absolute: path.join(prepared.root, prepared.currentMolit.observationPath), bytes: prepared.currentMolit.observationBytes },
  ];
  for (const item of prepared.registration) {
    const receipt = receipts.get(item.snapshot.sourceId);
    const previous = prepared.ledger.filter(({ sourceId }) => sourceId === item.snapshot.sourceId).at(-1) ?? null;
    const row = ledgerRow({ item, receipt, receiptBytes: receipt.bytes, governanceBytes, previous });
    validateLineage([...prepared.ledger.filter(({ sourceId }) => sourceId === item.snapshot.sourceId), row]);
    rows.push(row);
    const snapshotFile = path.join(prepared.root, item.snapshotRelative);
    await writeImmutableSnapshot(snapshotFile, item.snapshotBytes);
    appendInput(inputs,
      { absolute: snapshotFile, bytes: item.snapshotBytes },
      { absolute: receipt.path, bytes: receipt.bytes },
    );
  }
  for (const [datasetId, bytes] of prepared.rawByDataset) {
    appendInput(inputs, { absolute: path.join(prepared.inputDir, `data-go-${datasetId}.csv`), bytes });
  }
  const dependentFile = path.join(prepared.root, prepared.dependentSnapshot.relative);
  await writeImmutableSnapshot(dependentFile, prepared.dependentSnapshot.bytes);
  appendInput(inputs,
    ...prepared.dependentInputs,
    { absolute: dependentFile, bytes: prepared.dependentSnapshot.bytes },
  );
  const values = [
    json(registeredInventory),
    json([...prepared.ledger, ...rows]),
    governanceBytes,
    json(prepared.freshness),
  ];
  return OUTPUTS.map((relative, index) => ({
    relative,
    bytes: values[index],
    prestateBytes: prepared.currentBytes[index],
    inputs,
  }));
}

const transaction = createSourceRegistrationTransaction({
  label: "Daegu six-source",
  validateOutputs(outputs) {
    const inputs = outputs?.[0]?.inputs;
    if (!Array.isArray(outputs) || !isDeepStrictEqual(outputs.map(({ relative }) => relative), OUTPUTS)
      || !Array.isArray(inputs) || new Set(inputs.map(({ absolute }) => absolute)).size !== inputs.length
      || outputs.some((row) => !Buffer.isBuffer(row.bytes) || !Buffer.isBuffer(row.prestateBytes) || row.inputs !== inputs)
      || inputs.some(({ absolute, bytes }) => !path.isAbsolute(absolute ?? "") || !Buffer.isBuffer(bytes))) {
      throw new Error("Daegu six-source registration outputs are invalid");
    }
  },
});

export async function registerDaeguDatapackSources(options = {}) {
  const root = absolute(options.repositoryRoot, "repository root");
  await transaction.recover({ repositoryRoot: root });
  return transaction.commit({ repositoryRoot: root, outputs: await buildDaeguSourceRegistrationOutputs(options) });
}

/** 현재 admission topology에 원문 불변 map snapshot만 다시 결속한다. */
export async function prepareDaeguDependentRebind({ repositoryRoot } = {}) {
  const root = absolute(repositoryRoot, "repository root");
  const candidatePath = path.join(root, "tools/datapack/source-candidates.json");
  const [currentBytes, candidateBytes] = await Promise.all([
    Promise.all(OUTPUTS.map((relative) => readFile(path.join(root, relative)))),
    readFile(candidatePath),
  ]);
  const inventory = parse(currentBytes[0], "registration inventory");
  const candidates = parse(candidateBytes, "source candidates").candidates;
  const topologyInputs = await admittedTopologyInputs(root, inventory);
  const topologySnapshots = Object.fromEntries(topologyInputs.map(({ snapshot }) => [
    Number(/^daegu-line(\d)-route-topology$/u.exec(snapshot.sourceId)?.[1]), snapshot,
  ]));
  const dependents = await prepareDaeguTopologyDependents({
    root, inventory, candidates, topologySnapshots, topologyInputs,
  });
  return { root, currentBytes, candidatePath, candidateBytes, ...dependents };
}

export function daeguDependentRebindOutputPlan(prepared) {
  const inputs = [];
  appendInput(inputs,
    { absolute: prepared.candidatePath, bytes: prepared.candidateBytes },
    ...prepared.inputs,
    {
      absolute: path.join(prepared.root, prepared.snapshot.relative),
      bytes: prepared.snapshot.bytes,
    },
  );
  const values = [
    json(prepared.inventory),
    prepared.currentBytes[1],
    prepared.currentBytes[2],
    prepared.currentBytes[3],
  ];
  return OUTPUTS.map((relative, index) => ({
    relative,
    bytes: values[index],
    prestateBytes: prepared.currentBytes[index],
    inputs,
  }));
}

export async function rebindDaeguDatapackDependents(options = {}) {
  const root = absolute(options.repositoryRoot, "repository root");
  await transaction.recover({ repositoryRoot: root });
  const prepared = await prepareDaeguDependentRebind({ ...options, repositoryRoot: root });
  const snapshotFile = path.join(prepared.root, prepared.snapshot.relative);
  await writeImmutableSnapshot(snapshotFile, prepared.snapshot.bytes);
  return transaction.commit({
    repositoryRoot: prepared.root,
    outputs: daeguDependentRebindOutputPlan(prepared),
  });
}

/**
 * Publishes only receipt-less immutable snapshots. 이미 검증된 receipt는 원격
 * 객체를 다시 확인하거나 덮어쓰지 않고, 이후 하나의 CAS에 그대로 결속한다.
 */
export async function publishAndRegisterDaeguDatapackSources({
  expectedHeadSha,
  gitRunner = async (args, settings) => (await promisify(execFile)("git", args, settings)).stdout,
  env = process.env,
  client = null,
  ...options
} = {}) {
  const root = absolute(options.repositoryRoot, "repository root");
  const receiptPaths = receiptPathMap(options.receiptPaths);
  const baseUrl = requireCurrentCapitalLiveChainOciParBaseUrl(env);
  if (!/^[a-f0-9]{40}$/u.test(expectedHeadSha ?? "")
    || String(await gitRunner(["rev-parse", "HEAD"], { cwd: root })).trim() !== expectedHeadSha) {
    throw new Error("Daegu six-source execution HEAD mismatch");
  }
  await transaction.recover({ repositoryRoot: root });
  const now = options.now ?? new Date();
  const prepared = await prepareDaeguSourceRegistration({ ...options, now });
  await assertPreparedInputsStable(prepared);
  const storage = client ?? preauthenticatedObjectStorageClient(baseUrl, { includeErrorBody: false });
  const receipts = new Map();
  for (const item of prepared.registration) {
    const receiptPath = receiptPaths.get(item.snapshot.sourceId);
    const existing = await readReceiptIfPresent(receiptPath);
    if (existing) {
      validateReceipt({ receipt: existing, item, env, now });
      receipts.set(item.snapshot.sourceId, existing);
      continue;
    }
    const snapshotFile = path.join(prepared.root, item.snapshotRelative);
    await writeImmutableSnapshot(snapshotFile, item.snapshotBytes);
    await assertPreparedInputsStable(prepared);
    const target = receiptTarget(item, env);
    const object = {
      objectKey: target.objectKey,
      sourcePath: path.basename(snapshotFile),
      sha256: sha(item.snapshotBytes),
      sizeBytes: item.snapshotBytes.length,
    };
    try {
      await publishImmutableObjectPlan({
        root: path.dirname(snapshotFile),
        plan: { steps: [
          { type: "put-immutable-bundle-object", ...object },
          { type: "verify-immutable-bundle-object", ...object },
        ] },
        client: {
          // Receipt가 없는 기존 원격 객체는 adopt하지 않는다. create가 실패하면
          // readback/재시도 없이 중단해 다른 등록 실행의 결과와 섞이지 않게 한다.
          putObjectIfAbsent: async (...args) => {
            if (!await storage.putObjectIfAbsent(...args)) {
              throw new Error(`Daegu ${item.snapshot.sourceId} OCI object already exists without receipt`);
            }
            return true;
          },
          readObject: (...args) => storage.readObject(...args),
        },
      });
    } catch {
      throw new Error(`Daegu ${item.snapshot.sourceId} OCI publication failed`);
    }
    const receipt = {
      schemaVersion: 1,
      artifactKind: "static-network-source-raw-object-receipt",
      sourceId: item.snapshot.sourceId,
      snapshotId: item.snapshotId,
      capturedAt: item.snapshot.capturedAt,
      ...target,
      rawObjectSha256: sha(item.snapshotBytes),
      byteSize: item.snapshotBytes.length,
      storedAt: now.toISOString(),
      rawRetentionExpiresAt: item.rawRetentionExpiresAt,
      contentType: "application/json",
    };
    const receiptBytes = json(receipt);
    await writeFile(receiptPath, receiptBytes, { flag: "wx", mode: 0o600 });
    receipts.set(item.snapshot.sourceId, { ...receipt, path: receiptPath, bytes: receiptBytes });
  }
  return transaction.commit({
    repositoryRoot: root,
    outputs: await outputsFromPrepared(prepared, receipts),
  });
}

function sourceSnapshotsFromRaw(rawByDataset, capturedAt) {
  const snapshots = [];
  for (const config of DAEGU_LINES) {
    const topology = parseDaeguRouteTopology(rawByDataset.get(config.intervalDatasetId), { lineNumber: config.lineNumber, capturedAt });
    snapshots.push(topology, parseDaeguTrainTimetable(
      rawByDataset.get(config.upDatasetId), rawByDataset.get(config.downDatasetId), topology,
      { lineNumber: config.lineNumber, capturedAt },
    ));
  }
  return snapshots;
}

async function prepareDaeguTopologyDependents({
  root,
  inventory,
  candidates,
  topologySnapshots,
  topologyInputs,
}) {
  const candidate = select(candidates, ({ id }) => id === MAP_SOURCE_ID, "Daegu route map candidate");
  const dependentInputs = candidate.registrationMetadata?.dependentInputs;
  const keys = ["line1CsvPath", "line2CsvPath", "line3CsvPath"];
  if (!dependentInputs || JSON.stringify(Object.keys(dependentInputs).sort(compareStrings)) !== JSON.stringify([...keys].sort(compareStrings))) {
    throw new Error("Daegu route map dependent inputs are required");
  }
  const mapSource = select(inventory.sources, ({ id }) => id === MAP_SOURCE_ID, "Daegu route map source");
  const mapEvidence = mapSource.routeMapAdmissionEvidence;
  const mapSnapshotAbsolute = sourceSnapshotFile(root, mapEvidence?.snapshotPath, "Daegu route map snapshot");
  const csvInputs = await Promise.all(keys.map(async (key, index) => {
    const absolutePath = rootedInput(root, dependentInputs[key], `Daegu route map ${key}`);
    return {
      datasetId: mapEvidence?.datasetIds?.[index],
      absolute: absolutePath,
      bytes: await readFile(absolutePath),
    };
  }));
  return buildDaeguTopologyDependents({
    inventory,
    topologySnapshots,
    topologyInputs,
    mapSnapshotAbsolute,
    mapSnapshotBytes: await readFile(mapSnapshotAbsolute),
    csvInputs,
  });
}

async function admittedTopologyInputs(root, inventory) {
  return Promise.all(DAEGU_LINES.map(async ({ lineNumber }) => {
    const sourceId = `daegu-line${lineNumber}-route-topology`;
    const source = select(inventory.sources, ({ id }) => id === sourceId, sourceId);
    const evidence = source.topologyAdmissionEvidence;
    const absolutePath = sourceSnapshotFile(root, evidence?.snapshotPath, sourceId);
    const bytes = await readFile(absolutePath);
    let snapshot;
    try { snapshot = JSON.parse(bytes); } catch { throw new Error(`Daegu ${sourceId} snapshot is invalid JSON`); }
    const snapshotId = daeguSourceSnapshotIdentity(snapshot);
    if (snapshot.sourceId !== sourceId || evidence.snapshotId !== snapshotId
      || evidence.snapshotPath !== `tools/datapack/sources/${snapshotId}.json`
      || evidence.contentSha256 !== snapshot.contentSha256) {
      throw new Error(`Daegu ${sourceId} selected admission binding changed`);
    }
    return { sourceId, snapshot, absolute: absolutePath, bytes };
  }));
}

async function readRawInputs(inputDir) {
  const ids = DAEGU_LINES.flatMap(({ intervalDatasetId, upDatasetId, downDatasetId }) => [
    intervalDatasetId, upDatasetId, downDatasetId,
  ]);
  if (new Set(ids).size !== 9) throw new Error("Daegu source dataset configuration is invalid");
  const entries = await Promise.all(ids.map(async (datasetId) => [
    datasetId,
    await readFile(path.join(inputDir, `data-go-${datasetId}.csv`)),
  ]));
  return new Map(entries);
}

function projectFreshness({ freshness, candidateById }) {
  const projected = structuredClone(freshness);
  const classes = projected.sourceClasses;
  if (!Array.isArray(classes)) throw new Error("Daegu source freshness policy is invalid");
  const topologyClassIds = new Set(TOPOLOGY_SOURCE_IDS.map((id) =>
    candidateById.get(id)?.registrationMetadata?.governance?.sourceClassId));
  if (topologyClassIds.size !== 1 || topologyClassIds.has(undefined)) {
    throw new Error("Daegu topology freshness class is inconsistent");
  }
  const topologyClass = select(classes, ({ id }) => id === [...topologyClassIds][0], "Daegu topology freshness class");
  if (topologyClass.basisField !== "retrievedAt" || topologyClass.reverificationCadence !== "P1D") {
    throw new Error("Daegu topology freshness class is invalid");
  }
  topologyClass.sourceIds = appendExactSourceIds(topologyClass.sourceIds, TOPOLOGY_SOURCE_IDS);

  const scheduleClassIds = new Set(TIMETABLE_SOURCE_IDS.map((id) =>
    candidateById.get(id)?.registrationMetadata?.governance?.sourceClassId));
  if (scheduleClassIds.size !== 1 || scheduleClassIds.has(undefined)) {
    throw new Error("Daegu timetable freshness class is inconsistent");
  }
  const supplied = TIMETABLE_SOURCE_IDS.map((id) => candidateById.get(id)?.registrationMetadata?.freshness)
    .filter((value) => value != null);
  if (supplied.length !== 1 || !validFreshnessPolicy(supplied[0], [...scheduleClassIds][0], TIMETABLE_SOURCE_IDS)) {
    throw new Error("Daegu timetable source-specific freshness policy is required");
  }
  const existing = classes.filter(({ id }) => id === supplied[0].id);
  if (existing.length > 1 || (existing.length === 1 && canonicalJson(existing[0]) !== canonicalJson(supplied[0]))) {
    throw new Error("Daegu timetable source-specific freshness policy is inconsistent");
  }
  if (existing.length === 0) classes.push(structuredClone(supplied[0]));
  return projected;
}

function projectGovernance({ governance, governanceBytes, governanceEntries }) {
  const retained = governance.sources?.filter(({ sourceId }) => SOURCE_IDS.includes(sourceId)) ?? [];
  if (retained.length !== new Set(retained.map(({ sourceId }) => sourceId)).size
    || retained.some((entry) => canonicalJson(entry) !== canonicalJson(governanceEntries.find(({ sourceId }) => sourceId === entry.sourceId)))) {
    throw new Error("Daegu recorded governance is inconsistent");
  }
  const additions = governanceEntries.filter(({ sourceId }) => !retained.some((entry) => entry.sourceId === sourceId));
  return additions.length === 0 ? governance : buildAppendOnlyGovernancePolicyRegistration({
    predecessorPolicyBytes: governanceBytes,
    addedSources: additions.map((entry) => structuredClone(entry)),
  }).policy;
}

function projectTopologySource({ source, topology, membershipEvidence }) {
  const prior = requiredEvidenceMetadata(source.topologyAdmissionEvidence, "topology");
  const snapshotId = daeguSourceSnapshotIdentity(topology);
  return {
    ...source,
    admissionEvidence: { ...source.admissionEvidence, licenseEvidenceHash: sha(canonicalJson(source.license)) },
    membershipAdmissionEvidence: membershipEvidence,
    topologyAdmissionEvidence: {
      ...source.topologyAdmissionEvidence,
      ...prior,
      snapshotId,
      snapshotPath: `tools/datapack/sources/${snapshotId}.json`,
      capturedAt: topology.capturedAt,
      freshUntil: topology.freshUntil,
      stationCount: topology.stationCount,
      edgeCount: topology.edgeCount,
      depotExcludedCount: topology.depotExcludedCount,
      rawSha256: topology.rawSha256,
      contentSha256: topology.contentSha256,
    },
    retrievedAt: topology.capturedAt.slice(0, 10),
  };
}

function projectTimetableSource({ source, timetable, topology }) {
  const prior = requiredEvidenceMetadata(source.scheduleAdmissionEvidence, "timetable");
  const snapshotId = daeguSourceSnapshotIdentity(timetable);
  const topologySnapshotId = daeguSourceSnapshotIdentity(topology);
  return {
    ...source,
    admissionEvidence: { ...(source.admissionEvidence ?? {}), licenseEvidenceHash: sha(canonicalJson(source.license)) },
    scheduleAdmissionEvidence: {
      ...source.scheduleAdmissionEvidence,
      ...prior,
      snapshotId,
      snapshotPath: `tools/datapack/sources/${snapshotId}.json`,
      capturedAt: timetable.capturedAt,
      freshUntil: timetable.freshUntil,
      rowCount: timetable.rowCount,
      departureCount: timetable.stopTimeCount,
      tripCount: timetable.tripCount,
      stopTimeCount: timetable.stopTimeCount,
      rawSha256: timetable.rawSha256,
      rowsSha256: timetable.tripsSha256,
      rawUpSha256: timetable.rawUpSha256,
      rawDownSha256: timetable.rawDownSha256,
      tripsSha256: timetable.tripsSha256,
      dayLabelNormalizedCount: timetable.dayLabelNormalizedCount,
      rolloverTripCount: timetable.rolloverTripCount,
      topologySourceId: topology.sourceId,
      topologySnapshotId,
      topologyContentSha256: topology.contentSha256,
      contentSha256: timetable.contentSha256,
    },
    retrievedAt: timetable.capturedAt.slice(0, 10),
  };
}

function projectMembershipSource({ source, membershipEvidence }) {
  if (source.productionUseAllowed !== true || source.license?.redistributionAllowed !== true) {
    throw new Error("Daegu current MOLIT membership source is invalid");
  }
  return { ...source, membershipAdmissionEvidence: membershipEvidence };
}

function refreshedMembershipEvidence({
  topologySource,
  membershipSource,
  currentMolit,
  mappings,
  stationCodes,
  topologySnapshotId,
  topologyContentSha256,
}) {
  const topologyMetadata = requiredEvidenceMetadata(topologySource.membershipAdmissionEvidence, "topology membership");
  const membershipMetadata = requiredEvidenceMetadata(membershipSource.membershipAdmissionEvidence, "membership");
  if (!isDeepStrictEqual(topologyMetadata, membershipMetadata)
    || membershipSource.productionUseAllowed !== true || membershipSource.license?.redistributionAllowed !== true) {
    throw new Error("Daegu current MOLIT membership metadata is inconsistent");
  }
  const mappingSha256 = sha(JSON.stringify(mappings));
  const stationCodesSha256 = sha(JSON.stringify(stationCodes));
  const snapshotId = daeguMembershipSnapshotIdentity({
    sourceId: membershipSource.id,
    molitSnapshotId: currentMolit.current.snapshotId,
    membershipSourceRawSha256: currentMolit.current.rawSha256,
    mappingSha256,
    stationCodesSha256,
  });
  return {
    ...topologyMetadata,
    snapshotId,
    lineIds: topologySource.membershipAdmissionEvidence.lineIds,
    verifiedAt: currentMolit.current.retrievedAt,
    stationCount: mappings.length,
    membershipSourceId: MOLIT_SOURCE_ID,
    membershipSourceRawSha256: currentMolit.current.rawSha256,
    membershipSourceSnapshotSha256: mappings.sourceRawSha256,
    mappingSha256,
    stationCodesSha256,
    stationCodeSourceId: topologySource.id,
    stationCodeSnapshotId: topologySnapshotId,
    stationCodeContentSha256: topologyContentSha256,
  };
}

export function ledgerRow({ item, receipt, receiptBytes, governanceBytes, previous }) {
  const { snapshot, source, evidence } = item;
  const schedule = snapshot.artifactKind === "daegu-train-timetable-snapshot";
  const row = {
    schemaVersion: 1,
    artifactKind: "official-source-snapshot",
    sourceId: snapshot.sourceId,
    snapshotId: item.snapshotId,
    previousSnapshotId: previous?.snapshotId ?? null,
    capturedAt: snapshot.capturedAt,
    retrievedAt: snapshot.capturedAt,
    sourceUpdatedAt: null,
    provider: source.provider,
    rowCount: schedule ? snapshot.rowCount : snapshot.edgeCount,
    coverageCount: schedule ? evidence.tripCount : evidence.stationCount,
    rawSha256: snapshot.rawSha256,
    contentSha256: schedule ? snapshot.tripsSha256 : snapshot.contentSha256,
    rawObjectUri: receipt.rawObjectUri,
    rawObjectSha256: item.snapshotBytes && sha(item.snapshotBytes),
    rawReceiptSha256: sha(receiptBytes),
    byteSize: item.snapshotBytes.length,
    freshUntil: evidence.freshUntil,
    freshnessExpiresAt: item.ledgerFreshnessExpiresAt,
    rawRetentionExpiresAt: item.rawRetentionExpiresAt,
    governancePolicyVersion: JSON.parse(governanceBytes).policyVersion,
    governancePolicySha256: sha(governanceBytes),
    schemaFingerprint: sha(canonicalJson({ artifactKind: snapshot.artifactKind, keys: Object.keys(snapshot).sort(compareStrings) })),
    redactedRequestFingerprint: sha(canonicalJson({ endpoint: snapshot.endpoint ?? null, datasetIds: snapshot.rawSources.map(({ datasetId }) => datasetId) })),
    snapshotStatus: "LOCKED",
    schemaStatus: "PASS",
    licenseStatus: "PASS",
    fetchStatus: "SUCCESS",
    redistributionAllowed: true,
    credentialRedacted: true,
    admissionEvidence: source.admissionEvidence,
  };
  row.diffSummary = previous ? buildSnapshotDiff(previous, row) : null;
  return row;
}

function receiptPathMap(receiptPaths) {
  if (!receiptPaths || typeof receiptPaths !== "object" || Array.isArray(receiptPaths)
    || JSON.stringify(Object.keys(receiptPaths).sort(compareStrings)) !== JSON.stringify([...SOURCE_IDS].sort(compareStrings))) {
    throw new Error("Daegu OCI receipt paths must contain exactly six source IDs");
  }
  return new Map(SOURCE_IDS.map((sourceId) => [
    sourceId,
    absolute(receiptPaths[sourceId], `OCI receipt path for ${sourceId}`),
  ]));
}

async function readVerifiedReceipts({ receiptPaths, prepared, env, now }) {
  const paths = receiptPathMap(receiptPaths);
  const entries = await Promise.all(prepared.registration.map(async (item) => {
    const receiptPath = paths.get(item.snapshot.sourceId);
    const bytes = await readFile(receiptPath);
    const receipt = parse(bytes, "OCI receipt");
    if (Object.hasOwn(receipt, "path") || Object.hasOwn(receipt, "bytes")) {
      throw new Error("Daegu OCI receipt contains reserved local fields");
    }
    const bound = { ...receipt, path: receiptPath, bytes };
    validateReceipt({ receipt: bound, item, env, now });
    return [item.snapshot.sourceId, bound];
  }));
  return new Map(entries);
}

async function readReceiptIfPresent(receiptPath) {
  const stat = await lstat(receiptPath).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
  if (stat === null) return null;
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Daegu OCI receipt path is unsafe");
  const bytes = await readFile(receiptPath);
  const receipt = parse(bytes, "OCI receipt");
  if (Object.hasOwn(receipt, "path") || Object.hasOwn(receipt, "bytes")) {
    throw new Error("Daegu OCI receipt contains reserved local fields");
  }
  return { ...receipt, path: receiptPath, bytes };
}

async function assertPreparedInputsStable(prepared) {
  const outputBytes = await Promise.all(OUTPUTS.map((relative) => readFile(path.join(prepared.root, relative))));
  if (outputBytes.some((bytes, index) => !bytes.equals(prepared.currentBytes[index]))) {
    throw new Error("Daegu six-source registration output prestate changed");
  }
  const tracked = [
    [prepared.candidatePath, prepared.candidateBytes],
    [path.join(prepared.root, prepared.currentMolit.observationPath), prepared.currentMolit.observationBytes],
    ...[...prepared.rawByDataset].map(([datasetId, bytes]) => [
      path.join(prepared.inputDir, `data-go-${datasetId}.csv`), bytes,
    ]),
    ...prepared.dependentInputs
      .filter(({ absolute: inputPath }) => !prepared.registration.some(({ snapshotRelative }) =>
        inputPath === path.join(prepared.root, snapshotRelative)))
      .map(({ absolute: inputPath, bytes }) => [inputPath, bytes]),
  ];
  for (const [file, expected] of tracked) {
    if (!(await readFile(file)).equals(expected)) {
      throw new Error("Daegu six-source registration input binding changed");
    }
  }
}

function validateReceipt({ receipt, item, env, now }) {
  const target = receiptTarget(item, env);
  const keys = [
    "schemaVersion", "artifactKind", "sourceId", "snapshotId", "capturedAt", "rawObjectUri",
    "rawObjectSha256", "byteSize", "storedAt", "rawRetentionExpiresAt", "ociNamespace",
    "bucket", "objectKey", "contentType",
  ];
  if (JSON.stringify(Object.keys(receipt ?? {}).filter((key) => key !== "path" && key !== "bytes").sort()) !== JSON.stringify(keys.sort())
    || receipt.schemaVersion !== 1 || receipt.artifactKind !== "static-network-source-raw-object-receipt"
    || receipt.sourceId !== item.snapshot.sourceId || receipt.snapshotId !== item.snapshotId
    || receipt.capturedAt !== item.snapshot.capturedAt || receipt.rawObjectSha256 !== sha(item.snapshotBytes)
    || receipt.byteSize !== item.snapshotBytes.length || receipt.ociNamespace !== target.ociNamespace
    || receipt.bucket !== target.bucket || receipt.objectKey !== target.objectKey || receipt.rawObjectUri !== target.rawObjectUri
    || receipt.contentType !== "application/json" || !instant(receipt.storedAt) || !instant(receipt.rawRetentionExpiresAt)
    || Date.parse(receipt.storedAt) < Date.parse(receipt.capturedAt) || Date.parse(receipt.storedAt) > now.valueOf()
    || receipt.rawRetentionExpiresAt !== item.rawRetentionExpiresAt) {
    throw new Error(`Daegu ${item.snapshot.sourceId} OCI receipt binding is invalid`);
  }
}

function receiptTarget(item, env) {
  const baseUrl = requireCurrentCapitalLiveChainOciParBaseUrl(env);
  const match = /^\/p\/[^/]+\/n\/([^/]+)\/b\/([^/]+)\/o\/?$/u.exec(baseUrl.pathname);
  const [, ociNamespace, bucket] = match ?? [];
  const objectKey = `source-raw/${item.snapshot.sourceId}/${compactSeoulDate(item.snapshot.capturedAt)}/${sha(item.snapshotBytes)}.json`;
  return { ociNamespace, bucket, objectKey, rawObjectUri: `oci://${ociNamespace}/${bucket}/${objectKey}` };
}

function appendExactSourceIds(sourceIds, additions) {
  if (!Array.isArray(sourceIds) || sourceIds.some((id) => typeof id !== "string" || id.length === 0)) {
    throw new Error("Daegu freshness source IDs are invalid");
  }
  return [...sourceIds, ...additions.filter((id) => !sourceIds.includes(id))];
}

function validFreshnessPolicy(policy, id, sourceIds) {
  return policy && JSON.stringify(Object.keys(policy).sort(compareStrings)) === JSON.stringify(FRESHNESS_POLICY_KEYS)
    && policy.id === id && JSON.stringify(policy.sourceIds) === JSON.stringify(sourceIds)
    && policy.basisField === "capturedAt" && policy.futureBasisAllowed === false
    && policy.reverificationCadence === "P30D"
    && (policy.providerValidityEndField === null || typeof policy.providerValidityEndField === "string")
    && Array.isArray(policy.eventTriggers) && policy.eventTriggers.length > 0
    && policy.eventTriggers.every((value) => typeof value === "string" && value.trim() !== "");
}

function validateRecordedGovernance({ source, candidate, entry, sourceClassId, now }) {
  const review = entry?.licenseReview;
  const schedule = source.id.endsWith("-train-timetable");
  if (source?.productionUseAllowed !== true || source.license?.redistributionAllowed !== true
    || (schedule && source.capabilities?.schedule?.productionUseAllowed !== true)
    || candidate?.domain !== (schedule ? "schedule_timetable" : "route_graph_topology")
    || entry?.sourceId !== source.id || typeof sourceClassId !== "string" || sourceClassId.length === 0
    || review?.status !== "APPROVED" || review.termsHash !== sha(canonicalJson(source.license))
    || review.termsUrl !== source.license.evidenceUrl || review.reviewedProvider !== source.provider
    || review.reviewedDatasetUrl !== source.datasetUrl || review.approvedByRole !== entry.approvalRole
    || !instant(review.reviewedAt) || !instant(review.nextReviewAt)
    || Date.parse(review.reviewedAt) > now.valueOf() || Date.parse(review.nextReviewAt) <= now.valueOf()) {
    throw new Error(`Daegu ${source?.id ?? "source"} recorded governance and license binding is required`);
  }
}

function requiredEvidenceMetadata(metadata, label) {
  if (!Number.isInteger(metadata?.issue) || metadata.issue <= 0
    || typeof metadata.materializer !== "string" || metadata.materializer.length === 0
    || typeof metadata.verificationTest !== "string" || metadata.verificationTest.length === 0) {
    throw new Error(`Daegu ${label} evidence metadata is required`);
  }
  return { issue: metadata.issue, materializer: metadata.materializer, verificationTest: metadata.verificationTest };
}

function snapshotBytes(snapshot) { return Buffer.from(`${JSON.stringify(snapshot)}\n`); }

function appendInput(inputs, ...additions) {
  for (const input of additions) {
    const existing = inputs.find(({ absolute }) => absolute === input.absolute);
    if (existing && !existing.bytes.equals(input.bytes)) {
      throw new Error("Daegu registration input bytes conflict");
    }
    if (!existing) inputs.push(input);
  }
}

function sourceSnapshotFile(root, relative, label) {
  if (typeof relative !== "string" || !/^tools\/datapack\/sources\/[^/]+\.json$/u.test(relative)) {
    throw new Error(`${label} path is invalid`);
  }
  return path.join(root, relative);
}

function rootedInput(root, relative, label) {
  if (typeof relative !== "string" || !relative.startsWith("tools/datapack/")) {
    throw new Error(`${label} path is invalid`);
  }
  const absolutePath = path.resolve(root, relative);
  if (!absolutePath.startsWith(`${root}${path.sep}`)) throw new Error(`${label} path escapes repository`);
  return absolutePath;
}

async function writeImmutableSnapshot(file, bytes) {
  await writeFile(file, bytes, { flag: "wx", mode: 0o600 }).catch(async (error) => {
    if (error?.code !== "EEXIST" || !(await readFile(file)).equals(bytes)) throw error;
  });
}

function compactSeoulDate(value) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(value)).map(({ type, value: part }) => [type, part]));
  return `${parts.year}${parts.month}${parts.day}`;
}

function select(rows, predicate, label) {
  const matches = Array.isArray(rows) ? rows.filter((row) => predicate(row)) : [];
  if (matches.length !== 1) throw new Error(`Daegu ${label} is invalid`);
  return matches[0];
}

function absolute(value, label) {
  if (!path.isAbsolute(value ?? "")) throw new Error(`Daegu ${label} must be absolute`);
  return path.resolve(value);
}

function parse(bytes, label) {
  try { return JSON.parse(bytes); } catch { throw new Error(`Daegu ${label} is invalid JSON`); }
}

function instant(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function parseArgs(argv) {
  if (argv.length === 1 && argv[0] === "rebind-dependents") {
    return { rebindDependents: true };
  }
  const publish = argv[0] === "publish-register";
  if ((!publish && argv[0] !== "register") || argv.length !== (publish ? 9 : 7)
    || argv[1] !== "--input-dir" || argv[3] !== "--captured-at" || argv[5] !== "--receipts"
    || !path.isAbsolute(argv[2]) || !instant(argv[4]) || !path.isAbsolute(argv[6])
    || (publish && (argv[7] !== "--expected-head" || !/^[a-f0-9]{40}$/u.test(argv[8])))) {
    throw new Error(
      "usage: register-daegu-datapack-sources.mjs rebind-dependents | register|publish-register "
        + "--input-dir <absolute.dir> --captured-at <iso> --receipts <absolute.json> [--expected-head <sha>]",
    );
  }
  return {
    publish,
    inputDirectory: argv[2],
    capturedAt: argv[4],
    receiptsPath: argv[6],
    ...(publish ? { expectedHeadSha: argv[8] } : {}),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const { rebindDependents, publish, receiptsPath, ...inputs } = parseArgs(process.argv.slice(2));
    if (rebindDependents) {
      await rebindDaeguDatapackDependents({
        repositoryRoot: path.resolve(import.meta.dirname, "../.."),
      });
    } else {
      const receiptPaths = parse(await readFile(receiptsPath), "Daegu OCI receipt mapping");
      const options = {
        repositoryRoot: path.resolve(import.meta.dirname, "../.."),
        ...inputs,
        receiptPaths,
      };
      if (publish) await publishAndRegisterDaeguDatapackSources(options);
      else await registerDaeguDatapackSources(options);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Daegu six-source registration failed");
    process.exitCode = 1;
  }
}
