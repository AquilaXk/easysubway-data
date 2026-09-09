#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual, promisify } from "node:util";

import { replayBusanAccessibility } from "./collect-busan-accessibility.mjs";
import { validateBusanRouteTopologySnapshot } from "./collect-busan-route-topology.mjs";
import { validateSnapshot as validateDaejeonTopology } from "./materialize-daejeon-route-topology.mjs";
import { collectDaejeonAccessibility } from "./collect-daejeon-accessibility.mjs";
import { collectDaeguAccessibility } from "./collect-daegu-accessibility.mjs";
import { collectGwangjuAccessibility } from "./collect-gwangju-accessibility.mjs";
import { DAEGU_LINES } from "./collect-daegu-datapack-sources.mjs";
import { parseCurrentMolitDaejeonStationMappings } from "./build-molit-nationwide-fixture.mjs";
import { loadCurrentMolitObservation } from "./current-molit-observation.mjs";
import { canonicalJson } from "./lib/manifest-validation.mjs";
import { createSourceRegistrationTransaction, SOURCE_REGISTRATION_OUTPUTS } from "./lib/source-registration-transaction.mjs";
import { buildAppendOnlyGovernancePolicyRegistration, deriveRawRetentionExpiresAt, validateSourceGovernancePolicy } from "./source-governance-policy.mjs";
import { deriveFreshnessExpiresAt } from "./freshness-policy.mjs";
import { buildSnapshotDiff, validateLineage } from "./source-snapshot-policy.mjs";
import { daeguAccessibilityTopologyLineageIdentity } from "./materialize-daegu-accessibility.mjs";
import { requireCurrentCapitalLiveChainOciParBaseUrl } from "./publish-object-storage.mjs";
import { publishSourceRawObject, validateSourceRawObjectReceipt } from "./lib/source-raw-object-publication.mjs";

const OUTPUTS = SOURCE_REGISTRATION_OUTPUTS;
const ACCESSIBILITY = new Map([
  ["busan-transportation-accessibility", { topology: ["busan-transportation-route-topology"] }],
  ["daejeon-transportation-accessibility", { topology: ["daejeon-station-distance-fare"] }],
  ["gwangju-transportation-accessibility", { topology: ["gwangju-transportation-route-topology"] }],
  [
    "daegu-transportation-accessibility",
    {
      topology: DAEGU_LINES.map(
        ({ lineNumber }) => `daegu-line${lineNumber}-route-topology`,
      ),
    },
  ],
]);
const sha = (value) => createHash("sha256").update(value).digest("hex");
const json = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

/** 승인 투영 전에 보존된 지역 원본 입력을 재생한다. */
export async function prepareRegionalAccessibilityRegistration(
  { repositoryRoot, snapshotPath, now = new Date() } = {},
) {
  if (
    !path.isAbsolute(repositoryRoot ?? "")
    || !path.isAbsolute(snapshotPath ?? "")
    || !Number.isFinite(now.valueOf())
  ) {
    throw new Error("regional accessibility registration requires absolute paths and time");
  }
  const root = path.resolve(repositoryRoot);
  const candidatePath = path.join(root, "tools/datapack/source-candidates.json");
  const [currentBytes, candidateBytes, snapshotBytes] = await Promise.all([
    Promise.all(OUTPUTS.map((relative) => readFile(path.join(root, relative)))),
    readFile(candidatePath),
    readFile(snapshotPath),
  ]);
  const [inventory, ledger, governance, freshness] = currentBytes.map(parse);
  const snapshot = parse(snapshotBytes);
  const config = ACCESSIBILITY.get(snapshot?.sourceId);
  if (!config) throw new Error("regional accessibility source is unsupported");
  const source = one(
    inventory.sources,
    ({ id }) => id === snapshot.sourceId,
    "inventory source",
  );
  const candidate = one(
    parse(candidateBytes).candidates,
    ({ id }) => id === snapshot.sourceId,
    "source candidate",
  );
  const topology = await loadTopologies(root, inventory, config.topology);
  const molit = snapshot.sourceId === "daejeon-transportation-accessibility"
    ? await loadCurrentMolitObservation({
      repositoryRoot: root,
      inventory,
      inventoryBytes: currentBytes[0],
      snapshots: ledger,
      snapshotsBytes: currentBytes[1],
    })
    : null;
  const replayedSnapshot = await replay(snapshot, topology, molit);
  if (!isDeepStrictEqual(snapshot, replayedSnapshot)) {
    throw new Error("regional accessibility retained snapshot replay mismatch");
  }
  if (Date.parse(snapshot.freshUntil) !== Date.parse(snapshot.capturedAt) + 86_400_000
    || now.valueOf() < Date.parse(snapshot.capturedAt) || now.valueOf() >= Date.parse(snapshot.freshUntil)) {
    throw new Error("regional accessibility native freshness is invalid");
  }
  const registration = candidate.registrationMetadata;
  const entry = registration?.governance;
  const licenseHash = sha(canonicalJson(source.license));
  if (source.productionUseAllowed !== true || source.capabilities?.facility?.productionUseAllowed !== true
    || source.license?.redistributionAllowed !== true || candidate.domain !== "accessibility_facilities"
    || !entry || entry.sourceId !== source.id || entry.sourceClassId !== "static_accessibility_facility"
    || entry.licenseReview?.status !== "APPROVED" || entry.licenseReview.termsHash !== licenseHash
    || entry.licenseReview.termsUrl !== source.license.evidenceUrl || entry.licenseReview.reviewedProvider !== source.provider
    || entry.licenseReview.reviewedDatasetUrl !== source.datasetUrl || entry.licenseReview.approvedByRole !== entry.approvalRole
    || !Number.isFinite(Date.parse(entry.licenseReview.reviewedAt))
    || !Number.isFinite(Date.parse(entry.licenseReview.nextReviewAt))
    || Date.parse(entry.licenseReview.reviewedAt) > now.valueOf()
    || Date.parse(entry.licenseReview.nextReviewAt) <= now.valueOf()) {
    throw new Error("regional accessibility recorded governance is required");
  }
  const projectedFreshness = structuredClone(freshness);
  const classRows = projectedFreshness.sourceClasses.filter(
    ({ id }) => id === entry.sourceClassId,
  );
  if (
    classRows.length !== 1
    || classRows[0].basisField !== "retrievedAt"
    || classRows[0].reverificationCadence !== "P90D"
  ) {
    throw new Error("regional accessibility freshness class is required");
  }
  if (!classRows[0].sourceIds.includes(source.id)) classRows[0].sourceIds.push(source.id);
  const retained = governance.sources.filter(({ sourceId }) => sourceId === source.id);
  if (
    retained.length > 1
    || (retained.length === 1 && canonicalJson(retained[0]) !== canonicalJson(entry))
  ) {
    throw new Error("regional accessibility governance is inconsistent");
  }
  const projectedGovernance = retained.length === 1
    ? governance
    : buildAppendOnlyGovernancePolicyRegistration({
      predecessorPolicyBytes: currentBytes[2],
      addedSources: [structuredClone(entry)],
    }).policy;
  const snapshotSha256 = sha(snapshotBytes);
  const snapshotId = `${source.id}-${sha(JSON.stringify(snapshot))}-${seoulDate(snapshot.capturedAt)}`;
  const evidence = {
    ...source.accessibilityAdmissionEvidence,
    ...requireEvidence(source.accessibilityAdmissionEvidence),
    snapshotId,
    snapshotPath: `tools/datapack/sources/${snapshotId}.json`,
    capturedAt: snapshot.capturedAt,
    freshUntil: snapshot.freshUntil,
    stationCount: snapshot.stationCount,
    rowCount: snapshot.rowCount,
    rawSha256: snapshot.rawSha256,
    rowsSha256: snapshot.rowsSha256,
    facilityCount: facilityCount(snapshot),
    ...(snapshot.datasetIds ? { datasetIds: snapshot.datasetIds } : {}),
    ...lineage(snapshot, topology),
  };
  const stagedInventory = {
    ...inventory,
    sources: inventory.sources.map((row) => row.id === source.id ? {
      ...row,
      admissionEvidence: {
        ...row.admissionEvidence,
        licenseEvidenceHash: licenseHash,
      },
      accessibilityAdmissionEvidence: evidence,
    } : row),
  };
  validateSourceGovernancePolicy({
    policy: projectedGovernance,
    inventory: stagedInventory,
    freshnessPolicy: projectedFreshness,
  });
  return {
    root,
    snapshotPath,
    snapshotBytes,
    snapshot,
    snapshotSha256,
    snapshotId,
    snapshotRelative: evidence.snapshotPath,
    currentBytes,
    candidatePath,
    candidateBytes,
    topology,
    molit,
    inventory: stagedInventory,
    ledger,
    governance: projectedGovernance,
    freshness: projectedFreshness,
    source,
    ledgerFreshnessExpiresAt: deriveFreshnessExpiresAt({
      policy: projectedFreshness,
      sourceClassId: entry.sourceClassId,
      basisAt: snapshot.capturedAt,
      evaluationAt: now.toISOString(),
    }),
    rawRetentionExpiresAt: deriveRawRetentionExpiresAt({
      policy: projectedGovernance,
      sourceId: source.id,
      retrievedAt: snapshot.capturedAt,
    }),
  };
}

/** 네트워크 효과 없이 검증된 불변 객체 영수증을 적용한다. */
export async function buildRegionalAccessibilityRegistrationOutputs(
  { receiptPath, now = new Date(), env = process.env, ...options } = {},
) {
  if (!path.isAbsolute(receiptPath ?? "")) {
    throw new Error("regional accessibility receipt path must be absolute");
  }
  const prepared = await prepareRegionalAccessibilityRegistration({ ...options, now });
  return outputsFromPrepared(prepared, receiptPath, env, now);
}

async function outputsFromPrepared(prepared, receiptPath, env, now) {
  const receiptBytes = await readFile(receiptPath);
  const receipt = parse(receiptBytes);
  validateSourceRawObjectReceipt({
    receipt,
    expected: {
      sourceId: prepared.source.id,
      snapshotId: prepared.snapshotId,
      capturedAt: prepared.snapshot.capturedAt,
      rawObjectSha256: prepared.snapshotSha256,
      byteSize: prepared.snapshotBytes.length,
      rawRetentionExpiresAt: prepared.rawRetentionExpiresAt,
    },
    target: receiptTarget(prepared, env),
    now,
    label: "regional accessibility",
  });
  if (prepared.ledger.some(({ snapshotId }) => snapshotId === prepared.snapshotId)) throw new Error("regional accessibility snapshot already registered");
  const registeredInventory = {
    ...prepared.inventory,
    sources: prepared.inventory.sources.map((row) => row.id === prepared.source.id
      ? { ...row, requiredForProductionPack: true }
      : row),
  };
  validateSourceGovernancePolicy({
    policy: prepared.governance,
    inventory: registeredInventory,
    freshnessPolicy: prepared.freshness,
  });
  const source = one(registeredInventory.sources, ({ id }) => id === prepared.source.id, "registered source");
  const heads = validateLineage(prepared.ledger).headsBySource;
  const previousId = heads[source.id] ?? null;
  const previous = previousId == null
    ? null
    : one(
      prepared.ledger,
      ({ sourceId, snapshotId }) => sourceId === source.id && snapshotId === previousId,
      "ledger head",
    );
  const governanceBytes = json(prepared.governance);
  const row = {
    schemaVersion: 1,
    artifactKind: "official-source-snapshot",
    sourceId: source.id,
    snapshotId: prepared.snapshotId,
    previousSnapshotId: previous?.snapshotId ?? null,
    capturedAt: prepared.snapshot.capturedAt,
    retrievedAt: prepared.snapshot.capturedAt,
    sourceUpdatedAt: null,
    provider: source.provider,
    rowCount: prepared.snapshot.rowCount,
    coverageCount: prepared.snapshot.stationCount,
    rawSha256: prepared.snapshot.rawSha256,
    contentSha256: prepared.snapshot.rowsSha256,
    rawObjectUri: receipt.rawObjectUri,
    rawObjectSha256: prepared.snapshotSha256,
    rawReceiptSha256: sha(receiptBytes),
    byteSize: prepared.snapshotBytes.length,
    freshUntil: prepared.snapshot.freshUntil,
    freshnessExpiresAt: prepared.ledgerFreshnessExpiresAt,
    rawRetentionExpiresAt: prepared.rawRetentionExpiresAt,
    governancePolicyVersion: prepared.governance.policyVersion,
    governancePolicySha256: sha(governanceBytes),
    schemaFingerprint: sha(canonicalJson({
      artifactKind: prepared.snapshot.artifactKind,
      keys: Object.keys(prepared.snapshot).sort(),
    })),
    redactedRequestFingerprint: sha(canonicalJson({
      endpoint: prepared.snapshot.endpoint,
      scope: prepared.snapshot.scope,
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
  validateLineage([...prepared.ledger, row]);
  const snapshotFile = path.join(prepared.root, prepared.snapshotRelative);
  await writeFile(snapshotFile, prepared.snapshotBytes, { flag: "wx", mode: 0o600 }).catch(async (error) => {
    if (error?.code !== "EEXIST" || !(await readFile(snapshotFile)).equals(prepared.snapshotBytes)) throw error;
  });
  const inputs = [
    { absolute: prepared.snapshotPath, bytes: prepared.snapshotBytes },
    { absolute: prepared.candidatePath, bytes: prepared.candidateBytes },
    { absolute: receiptPath, bytes: receiptBytes },
    { absolute: snapshotFile, bytes: prepared.snapshotBytes },
    ...prepared.topology.map(({ path: absolute, bytes }) => ({ absolute, bytes })),
  ];
  if (prepared.molit?.observationPath && prepared.molit?.observationBytes) {
    inputs.push({ absolute: path.join(prepared.root, prepared.molit.observationPath), bytes: prepared.molit.observationBytes });
  }
  const values = [json(registeredInventory), json([...prepared.ledger, row]), governanceBytes, json(prepared.freshness)];
  return OUTPUTS.map((relative, index) => ({ relative, bytes: values[index], prestateBytes: prepared.currentBytes[index], inputs }));
}

const transaction = createSourceRegistrationTransaction({
  label: "regional accessibility",
  validateOutputs(outputs) {
  const inputs = outputs?.[0]?.inputs;
  if (!Array.isArray(outputs) || JSON.stringify(outputs.map(({ relative }) => relative)) !== JSON.stringify(OUTPUTS)
    || !Array.isArray(inputs) || new Set(inputs.map(({ absolute }) => absolute)).size !== inputs.length
    || outputs.some((output) => !Buffer.isBuffer(output.bytes) || !Buffer.isBuffer(output.prestateBytes) || output.inputs !== inputs)) {
    throw new Error("regional accessibility registration outputs are invalid");
  }
  },
});

export async function registerRegionalAccessibility(options = {}) {
  const root = path.resolve(options.repositoryRoot ?? "");
  if (!path.isAbsolute(options.repositoryRoot ?? "")) throw new Error("regional accessibility repository root must be absolute");
  await transaction.recover({ repositoryRoot: root });
  return transaction.commit({ repositoryRoot: root, outputs: await buildRegionalAccessibilityRegistrationOutputs(options) });
}

export async function publishAndRegisterRegionalAccessibility(
  {
    expectedHeadSha,
    env = process.env,
    client = null,
    gitRunner = async (args, settings) => (await promisify(execFile)("git", args, settings)).stdout,
    ...options
  } = {},
) {
  const root = path.resolve(options.repositoryRoot ?? "");
  const receiptPath = options.receiptPath;
  if (
    !path.isAbsolute(options.repositoryRoot ?? "")
    || !path.isAbsolute(receiptPath ?? "")
    || !/^[a-f0-9]{40}$/u.test(expectedHeadSha ?? "")
    || String(await gitRunner(["rev-parse", "HEAD"], { cwd: root })).trim() !== expectedHeadSha
  ) {
    throw new Error("regional accessibility execution HEAD mismatch");
  }
  if (await lstat(receiptPath).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error))) {
    throw new Error("regional accessibility receipt already exists; resume registration without publication");
  }
  await transaction.recover({ repositoryRoot: root });
  const now = options.now ?? new Date();
  const prepared = await prepareRegionalAccessibilityRegistration({ ...options, now });
  const target = receiptTarget(prepared, env);
  await assertPreparedInputsUnchanged(prepared);
  await publishSourceRawObject({
    sourcePath: prepared.snapshotPath,
    sha256: prepared.snapshotSha256,
    sizeBytes: prepared.snapshotBytes.length,
    target,
    baseUrl: requireCurrentCapitalLiveChainOciParBaseUrl(env),
    client,
    label: "regional accessibility",
  });
  await writeFile(receiptPath, json({
    schemaVersion: 1,
    artifactKind: "static-network-source-raw-object-receipt",
    sourceId: prepared.source.id,
    snapshotId: prepared.snapshotId,
    capturedAt: prepared.snapshot.capturedAt,
    ...target,
    rawObjectSha256: prepared.snapshotSha256,
    byteSize: prepared.snapshotBytes.length,
    storedAt: now.toISOString(),
    rawRetentionExpiresAt: prepared.rawRetentionExpiresAt,
    contentType: "application/json",
  }), { flag: "wx", mode: 0o600 });
  return transaction.commit({ repositoryRoot: root, outputs: await outputsFromPrepared(prepared, receiptPath, env, now) });
}

// 발행 후 새 입력을 다시 준비하지 않는다. 발행한 입력과 CAS가 같은 준비 상태를 사용한다.
async function assertPreparedInputsUnchanged(prepared) {
  const inputs = [
    ...OUTPUTS.map((relative, index) => ({
      absolute: path.join(prepared.root, relative), bytes: prepared.currentBytes[index],
    })),
    { absolute: prepared.snapshotPath, bytes: prepared.snapshotBytes },
    { absolute: prepared.candidatePath, bytes: prepared.candidateBytes },
    ...prepared.topology.map(({ path: absolute, bytes }) => ({ absolute, bytes })),
  ];
  if (prepared.molit) inputs.push({
    absolute: path.join(prepared.root, prepared.molit.observationPath),
    bytes: prepared.molit.observationBytes,
  });
  for (const { absolute, bytes } of inputs) {
    if (!(await readFile(absolute)).equals(bytes)) {
      throw new Error("regional accessibility prepared input changed before publication");
    }
  }
}

function requireEvidence(value) {
  if (!Number.isInteger(value?.issue) || !value?.materializer || !value?.verificationTest) {
    throw new Error("regional accessibility metadata is required");
  }
  return {
    issue: value.issue,
    materializer: value.materializer,
    verificationTest: value.verificationTest,
  };
}
async function loadTopologies(root, inventory, ids) {
  return Promise.all(ids.map(async (id) => {
    const source = one(inventory.sources, (row) => row.id === id, "topology source");
    const evidence = source.topologyAdmissionEvidence;
    if (!/^tools\/datapack\/sources\/[^/]+\.json$/u.test(evidence?.snapshotPath ?? "")) {
      throw new Error("regional accessibility topology admission is invalid");
    }
    const absolute = path.join(root, evidence.snapshotPath);
    const bytes = await readFile(absolute);
    const snapshot = parse(bytes);
    const daejeon = id === "daejeon-station-distance-fare";
    if (daejeon) validateDaejeonTopology(snapshot);
    if (id === "busan-transportation-route-topology") validateBusanRouteTopologySnapshot(snapshot);
    const capturedAt = daejeon ? snapshot.observedAt : snapshot.capturedAt;
    const stationCount = daejeon ? snapshot.stationNumbers.length : snapshot.stationCount;
    const edgeCount = daejeon ? snapshot.rows.length : snapshot.edgeCount;
    if (snapshot.sourceId !== id || evidence.capturedAt !== capturedAt
      || evidence.rawSha256 !== snapshot.rawSha256 || evidence.contentSha256 !== snapshot.contentSha256
      || evidence.stationCount !== stationCount || evidence.edgeCount !== edgeCount
      || (id.startsWith("daegu-line") && evidence.snapshotId !== snapshotIdFor(id, snapshot))) {
      throw new Error("regional accessibility topology binding is invalid");
    }
    return { source, evidence, snapshot, path: absolute, bytes };
  }));
}
function snapshotIdFor(id, snapshot) {
  return `${id}-${sha(JSON.stringify(snapshot))}`;
}
async function replay(snapshot, topology, molit) {
  const raw = (id) => Buffer.from(one(snapshot.rawSources,
    (row) => row.datasetId === id, "retained raw").bytesBase64, "base64");
  const now = new Date(snapshot.capturedAt);
  const selected = { topologySnapshot: topology[0].snapshot, topologySource: topology[0].source, now };
  if (snapshot.sourceId === "gwangju-transportation-accessibility") {
    return collectGwangjuAccessibility({
      elevatorBytes: raw("15041385"), escalatorBytes: raw("15041362"), ...selected,
    });
  }
  if (snapshot.sourceId === "daejeon-transportation-accessibility") {
    return collectDaejeonAccessibility({
      elevatorBytes: raw("15041384"), escalatorBytes: raw("15041361"), ...selected,
      canonicalStationMappings: parseCurrentMolitDaejeonStationMappings(
        molit.observation.normalizedProjection, molit.current.rawSha256),
    });
  }
  if (snapshot.sourceId === "daegu-transportation-accessibility") {
    return collectDaeguAccessibility({
      facilitiesBytes: raw("15149872"), now,
      topologySnapshots: Object.fromEntries(DAEGU_LINES.map(({ lineNumber }) => [lineNumber,
        one(topology, ({ source }) => source.id === `daegu-line${lineNumber}-route-topology`, "Daegu topology").snapshot,
      ])),
    });
  }
  return replayBusanAccessibility({ rawResponses: snapshot.rawResponses, stationScopes: topology[0].snapshot.scope, now });
}
function lineage(snapshot, topology) {
  if (snapshot.sourceId === "daegu-transportation-accessibility") {
    return {
      topologySourceId: "daegu-transportation-accessibility-topology-lineage",
      topologyLineages: snapshot.topologyLineages,
      topologySnapshotId: daeguAccessibilityTopologyLineageIdentity(snapshot.topologyLineages),
      topologyContentSha256: sha(JSON.stringify(snapshot.topologyLineages)),
    };
  }
  return {
    topologySourceId: topology[0].source.id,
    topologySnapshotId: topology[0].evidence.snapshotId,
    topologyContentSha256: topology[0].evidence.contentSha256,
    ...(snapshot.topologyLineages ? { topologyLineages: snapshot.topologyLineages } : {}),
  };
}
function facilityCount(snapshot) {
  // admission의 facilityCount는 실제 설비 대수가 아니라 값이 관측된 설비 종류 셀 수다.
  const rows = snapshot.sourceId === "busan-transportation-accessibility"
    ? snapshot.rows.map((row) => ({ elevator: row.el_i + row.el_o, escalator: row.es, wheelchair_lift: row.wl_i + row.wl_o }))
    : snapshot.rows;
  return rows.reduce((total, row) => total + ["elevator", "escalator", "wheelchair_lift"]
    .filter((field) => Number.isInteger(row[field])).length, 0);
}
function one(rows, predicate, label) {
  const found = Array.isArray(rows) ? rows.filter(predicate) : [];
  if (found.length !== 1) {
    throw new Error(`regional accessibility ${label} is invalid`);
  }
  return found[0];
}
function parse(bytes) {
  try {
    return JSON.parse(bytes);
  } catch {
    throw new Error("regional accessibility JSON is invalid");
  }
}
function seoulDate(value) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en", {
      timeZone: "Asia/Seoul",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date(value)).map(({ type, value: part }) => [type, part]),
  );
  return `${parts.year}${parts.month}${parts.day}`;
}
function receiptTarget(prepared, env) {
  const base = requireCurrentCapitalLiveChainOciParBaseUrl(env);
  const match = /^\/p\/[^/]+\/n\/([^/]+)\/b\/([^/]+)\/o\/?$/u.exec(base.pathname);
  const [, ociNamespace, bucket] = match ?? [];
  const objectKey = `source-raw/${prepared.source.id}/${seoulDate(prepared.snapshot.capturedAt)}/${prepared.snapshotSha256}.json`;
  return {
    ociNamespace,
    bucket,
    objectKey,
    rawObjectUri: `oci://${ociNamespace}/${bucket}/${objectKey}`,
  };
}

function parseArgs(argv) {
  const publish = argv[0] === "publish-register";
  if ((!publish && argv[0] !== "register") || argv[1] !== "--snapshot" || argv[3] !== "--receipt"
    || !path.isAbsolute(argv[2] ?? "") || !path.isAbsolute(argv[4] ?? "")
    || argv.length !== (publish ? 7 : 5) || (publish && (argv[5] !== "--expected-head" || !/^[a-f0-9]{40}$/u.test(argv[6])))) {
    throw new Error("usage: register-regional-accessibility.mjs register|publish-register --snapshot <absolute.json> --receipt <absolute.json> [--expected-head <sha>]");
  }
  return { publish, snapshotPath: argv[2], receiptPath: argv[4], ...(publish ? { expectedHeadSha: argv[6] } : {}) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const { publish, ...options } = parseArgs(process.argv.slice(2));
    const inputs = { repositoryRoot: path.resolve(import.meta.dirname, "../.."), ...options };
    if (publish) await publishAndRegisterRegionalAccessibility(inputs);
    else await registerRegionalAccessibility(inputs);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "regional accessibility registration failed");
    process.exitCode = 1;
  }
}
