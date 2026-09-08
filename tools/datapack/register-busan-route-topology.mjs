#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { admitBusanRouteTopology, collectBusanRouteTopology } from "./collect-busan-route-topology.mjs";
import { deriveFreshnessExpiresAt } from "./freshness-policy.mjs";
import { canonicalJson } from "./lib/manifest-validation.mjs";
import { SOURCE_REGISTRATION_OUTPUTS, createSourceRegistrationTransaction } from "./lib/source-registration-transaction.mjs";
import { buildSnapshotDiff, validateLineage } from "./source-snapshot-policy.mjs";
import { buildAppendOnlyGovernancePolicyRegistration, deriveRawRetentionExpiresAt, validateSourceGovernancePolicy } from "./source-governance-policy.mjs";
import { requireCurrentCapitalLiveChainOciParBaseUrl } from "./publish-object-storage.mjs";

const SOURCE_ID = "busan-transportation-route-topology";
const OUTPUTS = SOURCE_REGISTRATION_OUTPUTS;
const sha = (value) => createHash("sha256").update(value).digest("hex");
const json = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

export async function prepareBusanTopologyRegistration({ repositoryRoot, snapshotPath, now = new Date() } = {}) {
  const root = absolute(repositoryRoot, "repository root");
  const inputPath = absolute(snapshotPath, "snapshot path");
  if (!(now instanceof Date) || Number.isNaN(now.valueOf())) throw new Error("Busan topology registration time is invalid");
  const [currentBytes, candidateBytes, snapshotBytes] = await Promise.all([
    Promise.all(OUTPUTS.map((relative) => readFile(path.join(root, relative)))),
    readFile(path.join(root, "tools/datapack/source-candidates.json")),
    readFile(inputPath),
  ]);
  const [inventory, ledger, governance, freshness] = currentBytes.map((bytes) => parse(bytes, "registration output"));
  const snapshot = parse(snapshotBytes, "Busan topology snapshot");
  await replayRetainedSnapshot(snapshot);
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
    observedDataUpdatedAt: snapshot.capturedAt.slice(0, 10),
    retrievedAt: snapshot.capturedAt.slice(0, 10),
  };
  const nextInventory = { ...inventory, sources: inventory.sources.map((row) => row.id === SOURCE_ID ? nextSource : row) };
  validateSourceGovernancePolicy({ policy: projectedGovernance, inventory: nextInventory, freshnessPolicy: projectedFreshness });
  return {
    root, inputPath, snapshotBytes, snapshot, snapshotSha256, snapshotId, snapshotRelative,
    currentBytes, inventory: nextInventory, ledger, governance: projectedGovernance, freshness: projectedFreshness, candidateBytes,
    rawRetentionExpiresAt: deriveRawRetentionExpiresAt({ policy: projectedGovernance, sourceId: SOURCE_ID, retrievedAt: snapshot.capturedAt }),
  };
}

export async function buildBusanTopologyRegistrationOutputs({ receiptPath, env = process.env, ...options } = {}) {
  const prepared = await prepareBusanTopologyRegistration(options);
  const receiptFile = absolute(receiptPath, "OCI receipt path");
  const receiptBytes = await readFile(receiptFile);
  const receipt = parse(receiptBytes, "OCI receipt");
  validateReceipt({ receipt, prepared, env, now: options.now ?? new Date() });
  if (prepared.ledger.some((row) => row?.snapshotId === prepared.snapshotId)) {
    throw new Error("Busan topology snapshot already registered");
  }
  const source = select(prepared.inventory.sources, ({ id }) => id === SOURCE_ID, "registered source");
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
    schemaFingerprint: sha(canonicalJson({ artifactKind: prepared.snapshot.artifactKind, keys: Object.keys(prepared.snapshot).sort() })),
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
    { absolute: path.join(prepared.root, "tools/datapack/source-candidates.json"), bytes: prepared.candidateBytes },
    { absolute: receiptFile, bytes: receiptBytes },
    { absolute: snapshotFile, bytes: prepared.snapshotBytes },
  ];
  const values = [json(prepared.inventory), json([...prepared.ledger, row]), governanceBytes, json(prepared.freshness)];
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

async function replayRetainedSnapshot(snapshot) {
  if (!Array.isArray(snapshot?.rawResponses) || snapshot.rawResponses.length !== snapshot.scope?.length) {
    throw new Error("Busan topology retained raw responses are required");
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
  if (cursor !== snapshot.rawResponses.length || !isDeepStrictEqual(snapshot, replay)) {
    throw new Error("Busan topology retained snapshot replay mismatch");
  }
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

function validateReceipt({ receipt, prepared, env, now }) {
  const baseUrl = requireCurrentCapitalLiveChainOciParBaseUrl(env);
  const match = /^\/p\/[^/]+\/n\/([^/]+)\/b\/([^/]+)\/o\/?$/u.exec(baseUrl.pathname);
  const [, namespace, bucket] = match ?? [];
  const date = prepared.snapshot.capturedAt.slice(0, 10).replaceAll("-", "");
  const objectKey = `source-raw/${SOURCE_ID}/${date}/${prepared.snapshotSha256}.json`;
  const keys = ["schemaVersion", "artifactKind", "sourceId", "snapshotId", "capturedAt", "rawObjectUri", "rawObjectSha256", "byteSize", "storedAt", "rawRetentionExpiresAt", "ociNamespace", "bucket", "objectKey", "contentType"];
  if (JSON.stringify(Object.keys(receipt ?? {}).sort()) !== JSON.stringify(keys.sort())
    || receipt.schemaVersion !== 1 || receipt.artifactKind !== "static-network-source-raw-object-receipt"
    || receipt.sourceId !== SOURCE_ID || receipt.snapshotId !== prepared.snapshotId
    || receipt.capturedAt !== prepared.snapshot.capturedAt || receipt.rawObjectSha256 !== prepared.snapshotSha256
    || receipt.byteSize !== prepared.snapshotBytes.length || receipt.ociNamespace !== namespace || receipt.bucket !== bucket
    || receipt.objectKey !== objectKey || receipt.rawObjectUri !== `oci://${namespace}/${bucket}/${objectKey}`
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
function select(rows, predicate, label) { const matches = Array.isArray(rows) ? rows.filter(predicate) : []; if (matches.length !== 1) throw new Error(`Busan topology ${label} is invalid`); return matches[0]; }
function absolute(value, label) { if (!path.isAbsolute(value ?? "")) throw new Error(`Busan topology ${label} must be absolute`); return path.resolve(value); }
function parse(bytes, label) { try { return JSON.parse(bytes); } catch { throw new Error(`Busan topology ${label} is invalid JSON`); } }
function instant(value) { return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value; }

function parseArgs(argv) {
  if (argv.length !== 5 || argv[0] !== "register" || argv[1] !== "--snapshot" || argv[3] !== "--receipt"
    || !path.isAbsolute(argv[2]) || !path.isAbsolute(argv[4])) throw new Error("usage: register-busan-route-topology.mjs register --snapshot <absolute.json> --receipt <absolute.json>");
  return { snapshotPath: argv[2], receiptPath: argv[4] };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { await registerBusanTopology({ repositoryRoot: path.resolve(import.meta.dirname, "../.."), ...parseArgs(process.argv.slice(2)) }); }
  catch (error) { console.error(error instanceof Error ? error.message : "Busan topology registration failed"); process.exitCode = 1; }
}
