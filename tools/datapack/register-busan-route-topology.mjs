#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual, promisify } from "node:util";

import { admitBusanRouteTopology, collectBusanRouteTopology } from "./collect-busan-route-topology.mjs";
import { deriveFreshnessExpiresAt } from "./freshness-policy.mjs";
import { canonicalJson } from "./lib/manifest-validation.mjs";
import { compareStrings } from "./lib/ledger-admission-cli.mjs";
import { canonicalStationMappingHash, parseCanonicalBusanStationMappings } from "./materialize-busan-route-topology.mjs";
import { SOURCE_REGISTRATION_OUTPUTS, createSourceRegistrationTransaction } from "./lib/source-registration-transaction.mjs";
import { buildSnapshotDiff, validateLineage } from "./source-snapshot-policy.mjs";
import { buildAppendOnlyGovernancePolicyRegistration, deriveRawRetentionExpiresAt, validateSourceGovernancePolicy } from "./source-governance-policy.mjs";
import { preauthenticatedObjectStorageClient, publishImmutableObjectPlan, requireCurrentCapitalLiveChainOciParBaseUrl } from "./publish-object-storage.mjs";

const SOURCE_ID = "busan-transportation-route-topology";
const OUTPUTS = SOURCE_REGISTRATION_OUTPUTS;
const sha = (value) => createHash("sha256").update(value).digest("hex");
const json = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

export async function prepareBusanTopologyRegistration({ repositoryRoot, snapshotPath, stationMapPath, now = new Date() } = {}) {
  const root = absolute(repositoryRoot, "repository root");
  const inputPath = absolute(snapshotPath, "snapshot path");
  const stationMapInputPath = absolute(stationMapPath, "station map path");
  if (!(now instanceof Date) || Number.isNaN(now.valueOf())) throw new Error("Busan topology registration time is invalid");
  const [currentBytes, candidateBytes, snapshotBytes, stationMapBytes] = await Promise.all([
    Promise.all(OUTPUTS.map((relative) => readFile(path.join(root, relative)))),
    readFile(path.join(root, "tools/datapack/source-candidates.json")),
    readFile(inputPath),
    readFile(stationMapInputPath),
  ]);
  const [inventory, ledger, governance, freshness] = currentBytes.map((bytes) => parse(bytes, "registration output"));
  const snapshot = parse(snapshotBytes, "Busan topology snapshot");
  const canonicalStationMappings = parseCanonicalBusanStationMappings(stationMapBytes.toString("utf8"));
  await replayRetainedSnapshot(snapshot, now);
  admitBusanRouteTopology(snapshot, { now });
  const source = select(inventory.sources, ({ id }) => id === SOURCE_ID, "inventory source");
  const candidate = select(parse(candidateBytes, "source candidates").candidates, ({ id }) => id === SOURCE_ID, "source candidate");
  const governanceEntry = resolveGovernanceEntry({ candidate, governance });
  const projectedFreshness = structuredClone(freshness);
  const sourceClass = select(projectedFreshness.sourceClasses, ({ id }) => id === governanceEntry.sourceClassId, "freshness class");
  if (!sourceClass.sourceIds.includes(SOURCE_ID)) sourceClass.sourceIds.push(SOURCE_ID);
  validateRecordedAdmission({ source, candidate, governanceEntry, freshness: projectedFreshness, snapshot, now });
  const projectedGovernance = governance.sources.some(({ sourceId }) => sourceId === SOURCE_ID)
    ? governance
    : buildAppendOnlyGovernancePolicyRegistration({ predecessorPolicyBytes: currentBytes[2], addedSources: [governanceEntry] }).policy;
  const snapshotSha256 = sha(snapshotBytes);
  const snapshotId = `${SOURCE_ID}-${snapshotSha256}`;
  const snapshotRelative = `tools/datapack/sources/${snapshotId}.json`;
  const membership = refreshedMembershipAdmissionEvidence({
    source,
    snapshot,
    snapshotId,
    canonicalStationMappings,
  });
  const nextSource = {
    ...source,
    admissionEvidence: { ...source.admissionEvidence, licenseEvidenceHash: sha(canonicalJson(source.license)) },
    topologyAdmissionEvidence: {
      ...source.topologyAdmissionEvidence,
      snapshotId,
      snapshotPath: snapshotRelative,
      capturedAt: snapshot.capturedAt,
      freshUntil: snapshot.freshUntil,
      stationCount: snapshot.stationCount,
      edgeCount: snapshot.edgeCount,
      excludedTransferCount: snapshot.excludedTransferCount,
      rawSha256: snapshot.rawSha256,
      contentSha256: snapshot.contentSha256,
    },
    membershipAdmissionEvidence: membership,
    observedDataUpdatedAt: snapshot.capturedAt.slice(0, 10),
    retrievedAt: snapshot.capturedAt.slice(0, 10),
  };
  const nextInventory = { ...inventory, sources: inventory.sources.map((row) => row.id === SOURCE_ID ? nextSource : row) };
  validateSourceGovernancePolicy({ policy: projectedGovernance, inventory: nextInventory, freshnessPolicy: projectedFreshness });
  return {
    root, inputPath, stationMapInputPath, snapshotBytes, stationMapBytes, snapshot, snapshotSha256, snapshotId, snapshotRelative,
    currentBytes, inventory: nextInventory, ledger, governance: projectedGovernance, freshness: projectedFreshness, candidateBytes,
    rawRetentionExpiresAt: deriveRawRetentionExpiresAt({ policy: projectedGovernance, sourceId: SOURCE_ID, retrievedAt: snapshot.capturedAt }),
  };
}

export async function buildBusanTopologyRegistrationOutputs({ receiptPath, env = process.env, ...options } = {}) {
  const prepared = await prepareBusanTopologyRegistration(options);
  return outputsFromPrepared(prepared, receiptPath, env, options.now ?? new Date());
}

async function outputsFromPrepared(prepared, receiptPath, env, now) {
  const receiptFile = absolute(receiptPath, "OCI receipt path");
  const receiptBytes = await readFile(receiptFile);
  const receipt = parse(receiptBytes, "OCI receipt");
  validateReceipt({ receipt, prepared, env, now });
  if (prepared.ledger.some((row) => row?.snapshotId === prepared.snapshotId)) {
    throw new Error("Busan topology snapshot already registered");
  }
  const source = select(prepared.inventory.sources, ({ id }) => id === SOURCE_ID, "registered source");
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
  const previous = prepared.ledger.filter(({ sourceId }) => sourceId === SOURCE_ID).at(-1) ?? null;
  const governanceBytes = json(prepared.governance);
  const row = {
    schemaVersion: 1,
    artifactKind: "official-source-snapshot",
    sourceId: SOURCE_ID,
    snapshotId: prepared.snapshotId,
    previousSnapshotId: previous?.snapshotId ?? null,
    capturedAt: prepared.snapshot.capturedAt,
    retrievedAt: prepared.snapshot.capturedAt,
    sourceUpdatedAt: null,
    provider: source.provider,
    rowCount: prepared.snapshot.edgeCount,
    coverageCount: prepared.snapshot.stationCount,
    rawSha256: prepared.snapshot.rawSha256,
    contentSha256: prepared.snapshot.contentSha256,
    rawObjectUri: receipt.rawObjectUri,
    rawObjectSha256: prepared.snapshotSha256,
    rawReceiptSha256: sha(receiptBytes),
    byteSize: prepared.snapshotBytes.length,
    freshUntil: prepared.snapshot.freshUntil,
    freshnessExpiresAt: prepared.snapshot.freshUntil,
    rawRetentionExpiresAt: prepared.rawRetentionExpiresAt,
    governancePolicyVersion: prepared.governance.policyVersion,
    governancePolicySha256: sha(governanceBytes),
    schemaFingerprint: sha(canonicalJson({ artifactKind: prepared.snapshot.artifactKind, keys: Object.keys(prepared.snapshot).sort(compareStrings) })),
    redactedRequestFingerprint: sha(canonicalJson({ endpoint: prepared.snapshot.endpoint, scope: prepared.snapshot.scope })),
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
    { absolute: prepared.stationMapInputPath, bytes: prepared.stationMapBytes },
    { absolute: path.join(prepared.root, "tools/datapack/source-candidates.json"), bytes: prepared.candidateBytes },
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
  label: "Busan topology",
  validateOutputs(outputs) {
    const inputs = outputs?.[0]?.inputs;
    if (!Array.isArray(outputs) || !isDeepStrictEqual(outputs.map(({ relative }) => relative), OUTPUTS)
      || !Array.isArray(inputs) || new Set(inputs.map(({ absolute }) => absolute)).size !== inputs.length
      || outputs.some((row) => !Buffer.isBuffer(row.bytes) || !Buffer.isBuffer(row.prestateBytes) || row.inputs !== inputs)
      || inputs.some(({ absolute, bytes }) => !path.isAbsolute(absolute ?? "") || !Buffer.isBuffer(bytes))) {
      throw new Error("Busan topology registration outputs are invalid");
    }
  },
});

export async function registerBusanTopology(options = {}) {
  await transaction.recover({ repositoryRoot: absolute(options.repositoryRoot, "repository root") });
  return transaction.commit({ repositoryRoot: options.repositoryRoot, outputs: await buildBusanTopologyRegistrationOutputs(options) });
}

/** 원문 재수집 없이 한 번 발행하고 동일한 준비 입력을 원자 등록한다. */
export async function publishAndRegisterBusanTopology({
  expectedHeadSha,
  gitRunner = async (args, settings) => (await promisify(execFile)("git", args, settings)).stdout,
  env = process.env, client = null, ...options
} = {}) {
  const root = absolute(options.repositoryRoot, "repository root");
  const receiptPath = absolute(options.receiptPath, "OCI receipt path");
  const baseUrl = requireCurrentCapitalLiveChainOciParBaseUrl(env);
  if (!/^[a-f0-9]{40}$/u.test(expectedHeadSha ?? "")
    || String(await gitRunner(["rev-parse", "HEAD"], { cwd: root })).trim() !== expectedHeadSha) {
    throw new Error("Busan topology execution HEAD mismatch");
  }
  const existing = await lstat(receiptPath).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (existing) throw new Error("Busan topology receipt already exists; resume registration without publication");
  await transaction.recover({ repositoryRoot: root });
  const now = options.now ?? new Date();
  const prepared = await prepareBusanTopologyRegistration({ ...options, now });
  const target = receiptTarget(prepared, env);
  const storage = client ?? preauthenticatedObjectStorageClient(baseUrl, { includeErrorBody: false });
  const object = { objectKey: target.objectKey, sourcePath: path.basename(prepared.inputPath),
    sha256: prepared.snapshotSha256, sizeBytes: prepared.snapshotBytes.length };
  try {
    await publishImmutableObjectPlan({ root: path.dirname(prepared.inputPath), plan: { steps: [
      { type: "put-immutable-bundle-object", ...object },
      { type: "verify-immutable-bundle-object", ...object },
    ] }, client: {
      putObjectIfAbsent: async (...args) => {
        if (!await storage.putObjectIfAbsent(...args)) throw new Error("Busan topology object already exists");
        return true;
      },
      readObject: (...args) => storage.readObject(...args),
    } });
  } catch { throw new Error("Busan topology OCI publication failed"); }
  const receipt = { schemaVersion: 1, artifactKind: "static-network-source-raw-object-receipt",
    sourceId: SOURCE_ID, snapshotId: prepared.snapshotId, capturedAt: prepared.snapshot.capturedAt,
    ...target, rawObjectSha256: prepared.snapshotSha256, byteSize: prepared.snapshotBytes.length,
    storedAt: now.toISOString(), rawRetentionExpiresAt: prepared.rawRetentionExpiresAt, contentType: "application/json" };
  await writeFile(receiptPath, json(receipt), { flag: "wx", mode: 0o600 });
  const outputs = await outputsFromPrepared(prepared, receiptPath, env, now);
  return transaction.commit({ repositoryRoot: root, outputs });
}

async function replayRetainedSnapshot(snapshot, registrationNow) {
  if (!Array.isArray(snapshot?.rawResponses) || snapshot.rawResponses.length !== snapshot.scope?.length) {
    throw new Error("Busan topology retained raw responses are required");
  }
  const admittedAt = snapshot.admission?.admittedAt;
  if (!instant(snapshot.capturedAt) || !instant(admittedAt) || Date.parse(snapshot.capturedAt) > Date.parse(admittedAt)
    || Date.parse(admittedAt) > registrationNow.valueOf()) {
    throw new Error("Busan topology retained admission clock is invalid");
  }
  let cursor = 0;
  const replay = await collectBusanRouteTopology({
    serviceKey: "retained-replay",
    stationScopes: snapshot.scope,
    now: new Date(snapshot.capturedAt),
    fetchImpl: async (url) => {
      const response = snapshot.rawResponses[cursor++];
      const bytes = Buffer.from(response?.bytesBase64 ?? "", "base64");
      if (response?.stationCode !== new URL(url).searchParams.get("scode")
        || bytes.toString("base64") !== response.bytesBase64) {
        throw new Error("Busan topology retained raw response binding mismatch");
      }
      return new Response(bytes, { headers: { "content-type": "application/xml" } });
    },
  });
  const expected = {
    ...replay,
    admission: admitBusanRouteTopology(replay, { now: new Date(admittedAt) }),
  };
  if (cursor !== snapshot.rawResponses.length || !isDeepStrictEqual(snapshot, expected)) {
    throw new Error("Busan topology retained snapshot replay mismatch");
  }
}

function refreshedMembershipAdmissionEvidence({ source, snapshot, snapshotId, canonicalStationMappings }) {
  const metadata = source?.membershipAdmissionEvidence;
  if (!Number.isInteger(metadata?.issue) || metadata.issue <= 0
    || typeof metadata.materializer !== "string" || metadata.materializer.length === 0
    || typeof metadata.verificationTest !== "string" || metadata.verificationTest.length === 0) {
    throw new Error("Busan topology membership metadata is required");
  }
  return {
    issue: metadata.issue,
    materializer: metadata.materializer,
    verificationTest: metadata.verificationTest,
    snapshotId,
    verifiedAt: snapshot.capturedAt,
    stationCount: snapshot.stationCount,
    lineIds: structuredClone(snapshot.lineIds),
    membershipSourceId: SOURCE_ID,
    membershipSourceRawSha256: snapshot.rawSha256,
    membershipSourceSnapshotSha256: snapshot.scopeSha256,
    mappingSha256: canonicalStationMappingHash(canonicalStationMappings, snapshot.scope),
    stationCodesSha256: sha(JSON.stringify(snapshot.scope.map(({ stationCode }) => stationCode))),
    stationCodeSourceId: SOURCE_ID,
    stationCodeSnapshotId: snapshotId,
    stationCodeContentSha256: snapshot.contentSha256,
  };
}

function validateRecordedAdmission({ source, candidate, governanceEntry, freshness, snapshot, now }) {
  const review = governanceEntry?.licenseReview;
  const classId = governanceEntry?.sourceClassId;
  const sourceClass = freshness?.sourceClasses?.filter(({ id }) => id === classId) ?? [];
  const licenseHash = sha(canonicalJson(source?.license));
  if (source?.productionUseAllowed !== true || source.license?.redistributionAllowed !== true
    || candidate?.domain !== classId || governanceEntry?.sourceId !== SOURCE_ID
    || review?.status !== "APPROVED" || review.termsHash !== licenseHash
    || review.termsUrl !== source.license.evidenceUrl || review.reviewedProvider !== source.provider
    || review.reviewedDatasetUrl !== source.datasetUrl || review.approvedByRole !== governanceEntry.approvalRole
    || !instant(review.reviewedAt) || !instant(review.nextReviewAt)
    || Date.parse(review.reviewedAt) > now.valueOf() || Date.parse(review.nextReviewAt) <= now.valueOf()
    || sourceClass.length !== 1 || !sourceClass[0].sourceIds?.includes(SOURCE_ID)
    || deriveFreshnessExpiresAt({ policy: freshness, sourceClassId: classId, basisAt: snapshot.capturedAt,
      evaluationAt: now.toISOString() }) !== snapshot.freshUntil) {
    throw new Error("Busan topology recorded governance and freshness binding is required");
  }
}

function resolveGovernanceEntry({ candidate, governance }) {
  const current = governance?.sources?.filter(({ sourceId }) => sourceId === SOURCE_ID) ?? [];
  if (current.length > 1) throw new Error("Busan topology governance selection is ambiguous");
  return current[0] ?? candidate?.registrationMetadata?.governance ?? (() => { throw new Error("Busan topology recorded governance is required"); })();
}

function receiptTarget(prepared, env) {
  const baseUrl = requireCurrentCapitalLiveChainOciParBaseUrl(env);
  const match = /^\/p\/[^/]+\/n\/([^/]+)\/b\/([^/]+)\/o\/?$/u.exec(baseUrl.pathname);
  const [, namespace, bucket] = match ?? [];
  const date = prepared.snapshot.capturedAt.slice(0, 10).replaceAll("-", "");
  const objectKey = `source-raw/${SOURCE_ID}/${date}/${prepared.snapshotSha256}.json`;
  return { ociNamespace: namespace, bucket, objectKey, rawObjectUri: `oci://${namespace}/${bucket}/${objectKey}` };
}

function validateReceipt({ receipt, prepared, env, now }) {
  const { ociNamespace: namespace, bucket, objectKey, rawObjectUri } = receiptTarget(prepared, env);
  const keys = ["schemaVersion", "artifactKind", "sourceId", "snapshotId", "capturedAt", "rawObjectUri", "rawObjectSha256", "byteSize", "storedAt", "rawRetentionExpiresAt", "ociNamespace", "bucket", "objectKey", "contentType"];
  if (JSON.stringify(Object.keys(receipt ?? {}).sort()) !== JSON.stringify(keys.sort())
    || receipt.schemaVersion !== 1 || receipt.artifactKind !== "static-network-source-raw-object-receipt"
    || receipt.sourceId !== SOURCE_ID || receipt.snapshotId !== prepared.snapshotId
    || receipt.capturedAt !== prepared.snapshot.capturedAt || receipt.rawObjectSha256 !== prepared.snapshotSha256
    || receipt.byteSize !== prepared.snapshotBytes.length || receipt.ociNamespace !== namespace || receipt.bucket !== bucket
    || receipt.objectKey !== objectKey || receipt.rawObjectUri !== rawObjectUri
    || receipt.contentType !== "application/json" || !instant(receipt.storedAt) || !instant(receipt.rawRetentionExpiresAt)
    || Date.parse(receipt.storedAt) < Date.parse(receipt.capturedAt) || Date.parse(receipt.storedAt) > now.valueOf()
    || receipt.rawRetentionExpiresAt !== prepared.rawRetentionExpiresAt) {
    throw new Error("Busan topology OCI receipt binding is invalid");
  }
}

async function writeImmutableSnapshot(file, bytes) {
  await writeFile(file, bytes, { flag: "wx", mode: 0o600 }).catch(async (error) => {
    if (error?.code !== "EEXIST" || !(await readFile(file)).equals(bytes)) throw error;
  });
}
function select(rows, predicate, label) {
  const matches = Array.isArray(rows) ? rows.filter((row) => predicate(row)) : [];
  if (matches.length !== 1) throw new Error(`Busan topology ${label} is invalid`);
  return matches[0];
}
function absolute(value, label) { if (!path.isAbsolute(value ?? "")) throw new Error(`Busan topology ${label} must be absolute`); return path.resolve(value); }
function parse(bytes, label) { try { return JSON.parse(bytes); } catch { throw new Error(`Busan topology ${label} is invalid JSON`); } }
function instant(value) { return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value; }

function parseArgs(argv) {
  const publish = argv[0] === "publish-register";
  if ((!publish && argv[0] !== "register") || argv.length !== (publish ? 9 : 7)
    || argv[1] !== "--snapshot" || argv[3] !== "--station-map" || argv[5] !== "--receipt"
    || !path.isAbsolute(argv[2]) || !path.isAbsolute(argv[4]) || !path.isAbsolute(argv[6])
    || (publish && (argv[7] !== "--expected-head" || !/^[a-f0-9]{40}$/u.test(argv[8])))) {
    throw new Error("usage: register-busan-route-topology.mjs register|publish-register --snapshot <absolute.json> --station-map <absolute.csv> --receipt <absolute.json> [--expected-head <sha>]");
  }
  return {
    publish,
    snapshotPath: argv[2],
    stationMapPath: argv[4],
    receiptPath: argv[6],
    ...(publish ? { expectedHeadSha: argv[8] } : {}),
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const { publish, ...inputs } = parseArgs(process.argv.slice(2));
    const options = { repositoryRoot: path.resolve(import.meta.dirname, "../.."), ...inputs };
    if (publish) await publishAndRegisterBusanTopology(options);
    else await registerBusanTopology(options);
  }
  catch (error) { console.error(error instanceof Error ? error.message : "Busan topology registration failed"); process.exitCode = 1; }
}
