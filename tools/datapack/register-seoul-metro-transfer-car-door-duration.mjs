#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual, promisify } from "node:util";

import { SOURCE_ID, validateSeoulMetroTransferSnapshot } from "./collect-seoul-metro-transfer-car-door-duration.mjs";
import { deriveFreshnessExpiresAt } from "./freshness-policy.mjs";
import { canonicalJson } from "./lib/manifest-validation.mjs";
import { SOURCE_REGISTRATION_OUTPUTS, createSourceRegistrationTransaction } from "./lib/source-registration-transaction.mjs";
import { publishSourceRawObject, validateSourceRawObjectReceipt } from "./lib/source-raw-object-publication.mjs";
import { requireCurrentCapitalLiveChainOciParBaseUrl } from "./publish-object-storage.mjs";
import { buildSnapshotDiff, validateLineage } from "./source-snapshot-policy.mjs";
import { buildAppendOnlyGovernancePolicyRegistration, deriveRawRetentionExpiresAt, validateSourceGovernancePolicy } from "./source-governance-policy.mjs";

// #876(QA 결정 2026-10-02): 서울교통공사_서울 도시철도 환승정보(15098252) 원문 snapshot을 OCI source-raw에 한 번 발행하고,
// 같은 준비 입력으로 inventory admission·원장 행·governance·신선도 정책을 원자 등록한다.
// - 승인 근거는 후보의 registrationMetadata.approval(QA 채택 결정, data#876)만 쓴다. 다른 승인을 만들지 않는다.
// - 이 원천은 fan-in 선택 집합 밖이다(requiredForProductionPack=false). 후보 생성기가 inventory·원장에서 직접 해석한다.
const OUTPUTS = SOURCE_REGISTRATION_OUTPUTS;
const LABEL = "Seoul transfer car-door";
const sha = (value) => createHash("sha256").update(value).digest("hex");
const json = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

export async function prepareSeoulMetroTransferRegistration({ repositoryRoot, snapshotPath, now = new Date() } = {}) {
  const root = absolute(repositoryRoot, "repository root");
  const inputPath = absolute(snapshotPath, "snapshot path");
  if (!(now instanceof Date) || Number.isNaN(now.valueOf())) throw new Error(`${LABEL} registration time is invalid`);
  const [currentBytes, candidateBytes, snapshotBytes] = await Promise.all([
    Promise.all(OUTPUTS.map((relative) => readFile(path.join(root, relative)))),
    readFile(path.join(root, "tools/datapack/source-candidates.json")),
    readFile(inputPath),
  ]);
  const [inventory, ledger, governance, freshness] = currentBytes.map((bytes) => parse(bytes, "registration output"));
  const snapshot = validateSeoulMetroTransferSnapshot(parse(snapshotBytes, "snapshot"));
  if (Date.parse(snapshot.capturedAt) > now.valueOf()) throw new Error(`${LABEL} snapshot is captured after the registration clock`);
  const source = select(inventory.sources, ({ id }) => id === SOURCE_ID, "inventory source");
  const candidate = select(parse(candidateBytes, "source candidates").candidates, ({ id }) => id === SOURCE_ID, "source candidate");
  const approval = candidate.registrationMetadata?.approval;
  const governanceEntry = resolveGovernanceEntry({ candidate, governance });
  const projectedFreshness = structuredClone(freshness);
  const sourceClass = select(projectedFreshness.sourceClasses, ({ id }) => id === governanceEntry.sourceClassId, "freshness class");
  if (!sourceClass.sourceIds.includes(SOURCE_ID)) sourceClass.sourceIds.push(SOURCE_ID);
  validateRecordedAdmission({ source, candidate, approval, governanceEntry, freshness: projectedFreshness, now });
  const projectedGovernance = governance.sources.some(({ sourceId }) => sourceId === SOURCE_ID)
    ? governance
    : buildAppendOnlyGovernancePolicyRegistration({ predecessorPolicyBytes: currentBytes[2], addedSources: [governanceEntry] }).policy;
  const snapshotSha256 = sha(snapshotBytes);
  const snapshotId = `${SOURCE_ID}-${snapshotSha256}`;
  const freshUntil = deriveFreshnessExpiresAt({
    policy: projectedFreshness, sourceClassId: governanceEntry.sourceClassId, basisAt: snapshot[sourceClass.basisField], evaluationAt: now.toISOString(),
  });
  return {
    root, inputPath, snapshotBytes, snapshot, snapshotSha256, snapshotId, snapshotRelative: `tools/datapack/sources/${snapshotId}.json`,
    currentBytes, inventory, ledger, governance: projectedGovernance, freshness: projectedFreshness, candidateBytes, source, approval, freshUntil,
    rawRetentionExpiresAt: deriveRawRetentionExpiresAt({ policy: projectedGovernance, sourceId: SOURCE_ID, retrievedAt: snapshot.capturedAt }),
  };
}

export async function buildSeoulMetroTransferRegistrationOutputs({ receiptPath, env = process.env, ...options } = {}) {
  const prepared = await prepareSeoulMetroTransferRegistration(options);
  return outputsFromPrepared(prepared, receiptPath, env, options.now ?? new Date());
}

async function outputsFromPrepared(prepared, receiptPath, env, now) {
  const receiptFile = absolute(receiptPath, "OCI receipt path");
  const receiptBytes = await readFile(receiptFile);
  const receipt = parse(receiptBytes, "OCI receipt");
  validateSourceRawObjectReceipt({
    receipt, target: receiptTarget(prepared, env), now, label: LABEL,
    expected: {
      sourceId: SOURCE_ID, snapshotId: prepared.snapshotId, capturedAt: prepared.snapshot.capturedAt,
      rawObjectSha256: prepared.snapshotSha256, byteSize: prepared.snapshotBytes.length, rawRetentionExpiresAt: prepared.rawRetentionExpiresAt,
    },
  });
  if (prepared.ledger.some((row) => row?.snapshotId === prepared.snapshotId)) throw new Error(`${LABEL} snapshot already registered`);
  const { source, snapshot, approval } = prepared;
  const admissionEvidence = {
    artifactKind: "official-file-source-admission",
    issue: 876,
    candidateId: SOURCE_ID,
    sourceId: SOURCE_ID,
    snapshotId: prepared.snapshotId,
    decision: approval.decision,
    approvedBy: approval.approvedBy,
    approvedAt: approval.approvedAt,
    rawSha256: snapshot.rawSha256,
    schemaFingerprint: snapshot.schemaFingerprint,
    rawObjectUri: receipt.rawObjectUri,
    licenseEvidenceHash: sha(canonicalJson(source.license)),
    productionUseNoteKo: approval.noteKo,
  };
  const registeredSource = {
    ...source,
    observedDataUpdatedAt: snapshot.sourceEffectiveDate,
    retrievedAt: snapshot.capturedAt.slice(0, 10),
    admissionEvidence,
  };
  const registeredInventory = { ...prepared.inventory, sources: prepared.inventory.sources.map((row) => row.id === SOURCE_ID ? registeredSource : row) };
  validateSourceGovernancePolicy({ policy: prepared.governance, inventory: registeredInventory, freshnessPolicy: prepared.freshness });
  const previous = prepared.ledger.filter(({ sourceId }) => sourceId === SOURCE_ID).at(-1) ?? null;
  const governanceBytes = json(prepared.governance);
  const row = {
    schemaVersion: 1,
    artifactKind: "official-source-snapshot",
    sourceId: SOURCE_ID,
    snapshotId: prepared.snapshotId,
    previousSnapshotId: previous?.snapshotId ?? null,
    capturedAt: snapshot.capturedAt,
    retrievedAt: snapshot.capturedAt,
    sourceUpdatedAt: null,
    provider: source.provider,
    rowCount: snapshot.rowCount,
    coverageCount: new Set(snapshot.rows.map(({ startStationCode }) => startStationCode)).size,
    rawSha256: snapshot.rawSha256,
    contentSha256: snapshot.contentSha256,
    rawObjectUri: receipt.rawObjectUri,
    rawObjectSha256: prepared.snapshotSha256,
    rawReceiptSha256: sha(receiptBytes),
    byteSize: prepared.snapshotBytes.length,
    freshUntil: prepared.freshUntil,
    freshnessExpiresAt: prepared.freshUntil,
    rawRetentionExpiresAt: prepared.rawRetentionExpiresAt,
    governancePolicyVersion: prepared.governance.policyVersion,
    governancePolicySha256: sha(governanceBytes),
    schemaFingerprint: snapshot.schemaFingerprint,
    redactedRequestFingerprint: sha(canonicalJson({ endpoint: snapshot.endpoint })),
    snapshotStatus: "LOCKED",
    schemaStatus: "PASS",
    licenseStatus: "PASS",
    fetchStatus: "SUCCESS",
    redistributionAllowed: true,
    credentialRedacted: true,
    admissionEvidence,
  };
  row.diffSummary = previous ? buildSnapshotDiff(previous, row) : null;
  validateLineage([...prepared.ledger, row]);
  const snapshotFile = path.join(prepared.root, prepared.snapshotRelative);
  await writeImmutableSnapshot(snapshotFile, prepared.snapshotBytes);
  const inputs = [
    { absolute: prepared.inputPath, bytes: prepared.snapshotBytes },
    { absolute: path.join(prepared.root, "tools/datapack/source-candidates.json"), bytes: prepared.candidateBytes },
    { absolute: receiptFile, bytes: receiptBytes },
    { absolute: snapshotFile, bytes: prepared.snapshotBytes },
  ];
  const values = [json(registeredInventory), json([...prepared.ledger, row]), governanceBytes, json(prepared.freshness)];
  return OUTPUTS.map((relative, index) => ({ relative, bytes: values[index], prestateBytes: prepared.currentBytes[index], inputs }));
}

const transaction = createSourceRegistrationTransaction({
  label: LABEL,
  validateOutputs(outputs) {
    const inputs = outputs?.[0]?.inputs;
    if (!Array.isArray(outputs) || !isDeepStrictEqual(outputs.map(({ relative }) => relative), OUTPUTS)
      || !Array.isArray(inputs) || new Set(inputs.map(({ absolute }) => absolute)).size !== inputs.length
      || outputs.some((row) => !Buffer.isBuffer(row.bytes) || !Buffer.isBuffer(row.prestateBytes) || row.inputs !== inputs)
      || inputs.some(({ absolute, bytes }) => !path.isAbsolute(absolute ?? "") || !Buffer.isBuffer(bytes))) {
      throw new Error(`${LABEL} registration outputs are invalid`);
    }
  },
});

export async function registerSeoulMetroTransfer(options = {}) {
  await transaction.recover({ repositoryRoot: absolute(options.repositoryRoot, "repository root") });
  return transaction.commit({ repositoryRoot: options.repositoryRoot, outputs: await buildSeoulMetroTransferRegistrationOutputs(options) });
}

/** 원문 snapshot을 한 번 발행하고 동일한 준비 입력을 원자 등록한다. */
export async function publishAndRegisterSeoulMetroTransfer({
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
    throw new Error(`${LABEL} execution HEAD mismatch`);
  }
  const existing = await lstat(receiptPath).catch((error) => (error.code === "ENOENT" ? null : Promise.reject(error)));
  if (existing) throw new Error(`${LABEL} receipt already exists; resume registration without publication`);
  await transaction.recover({ repositoryRoot: root });
  const now = options.now ?? new Date();
  const prepared = await prepareSeoulMetroTransferRegistration({ ...options, now });
  const target = receiptTarget(prepared, env);
  await publishSourceRawObject({
    sourcePath: prepared.inputPath, sha256: prepared.snapshotSha256, sizeBytes: prepared.snapshotBytes.length,
    target, baseUrl, client, label: LABEL,
  });
  const receipt = {
    schemaVersion: 1,
    artifactKind: "static-network-source-raw-object-receipt",
    sourceId: SOURCE_ID,
    snapshotId: prepared.snapshotId,
    capturedAt: prepared.snapshot.capturedAt,
    ...target,
    rawObjectSha256: prepared.snapshotSha256,
    byteSize: prepared.snapshotBytes.length,
    storedAt: now.toISOString(),
    rawRetentionExpiresAt: prepared.rawRetentionExpiresAt,
    contentType: "application/json",
  };
  await writeFile(receiptPath, json(receipt), { flag: "wx", mode: 0o600 });
  return transaction.commit({ repositoryRoot: root, outputs: await outputsFromPrepared(prepared, receiptPath, env, now) });
}

function validateRecordedAdmission({ source, candidate, approval, governanceEntry, freshness, now }) {
  const review = governanceEntry?.licenseReview;
  const sourceClass = freshness?.sourceClasses?.filter(({ id }) => id === governanceEntry?.sourceClassId) ?? [];
  if (source?.productionUseAllowed !== true || source.requiredForProductionPack !== false
    || source.license?.redistributionAllowed !== true || source.license.commercialUseAllowed !== true
    || candidate?.productionInventoryReferenceId !== SOURCE_ID || governanceEntry?.sourceId !== SOURCE_ID
    || approval?.decision !== "APPROVED" || typeof approval.approvedBy !== "string" || approval.approvedBy === ""
    || !instant(approval.approvedAt) || Date.parse(approval.approvedAt) > now.valueOf()
    || typeof approval.noteKo !== "string" || approval.noteKo === ""
    || review?.status !== "APPROVED" || review.termsHash !== sha(canonicalJson(source.license))
    || review.termsUrl !== source.license.evidenceUrl || review.reviewedProvider !== source.provider
    || review.reviewedDatasetUrl !== source.datasetUrl || review.approvedByRole !== governanceEntry.approvalRole
    || !instant(review.reviewedAt) || !instant(review.nextReviewAt)
    || Date.parse(review.reviewedAt) > now.valueOf() || Date.parse(review.nextReviewAt) <= now.valueOf()
    || sourceClass.length !== 1 || !sourceClass[0].sourceIds?.includes(SOURCE_ID)) {
    throw new Error(`${LABEL} recorded approval, governance and freshness binding is required`);
  }
}

function resolveGovernanceEntry({ candidate, governance }) {
  const current = governance?.sources?.filter(({ sourceId }) => sourceId === SOURCE_ID) ?? [];
  if (current.length > 1) throw new Error(`${LABEL} governance selection is ambiguous`);
  return current[0] ?? candidate?.registrationMetadata?.governance ?? (() => { throw new Error(`${LABEL} recorded governance is required`); })();
}

function receiptTarget(prepared, env) {
  const baseUrl = requireCurrentCapitalLiveChainOciParBaseUrl(env);
  const match = /^\/p\/[^/]+\/n\/([^/]+)\/b\/([^/]+)\/o\/?$/u.exec(baseUrl.pathname);
  const [, ociNamespace, bucket] = match ?? [];
  const date = prepared.snapshot.capturedAt.slice(0, 10).replaceAll("-", "");
  const objectKey = `source-raw/${SOURCE_ID}/${date}/${prepared.snapshotSha256}.json`;
  return { ociNamespace, bucket, objectKey, rawObjectUri: `oci://${ociNamespace}/${bucket}/${objectKey}` };
}

async function writeImmutableSnapshot(file, bytes) {
  await writeFile(file, bytes, { flag: "wx", mode: 0o644 }).catch(async (error) => {
    if (error?.code !== "EEXIST" || !(await readFile(file)).equals(bytes)) throw error;
  });
}
function select(rows, predicate, label) {
  const matches = Array.isArray(rows) ? rows.filter((row) => predicate(row)) : [];
  if (matches.length !== 1) throw new Error(`${LABEL} ${label} is invalid`);
  return matches[0];
}
function absolute(value, label) { if (!path.isAbsolute(value ?? "")) throw new Error(`${LABEL} ${label} must be absolute`); return path.resolve(value); }
function parse(bytes, label) { try { return JSON.parse(bytes); } catch { throw new Error(`${LABEL} ${label} is invalid JSON`); } }
function instant(value) { return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value; }

function parseArgs(argv) {
  const publish = argv[0] === "publish-register";
  if ((!publish && argv[0] !== "register") || argv.length !== (publish ? 7 : 5)
    || argv[1] !== "--snapshot" || argv[3] !== "--receipt" || !path.isAbsolute(argv[2]) || !path.isAbsolute(argv[4])
    || (publish && (argv[5] !== "--expected-head" || !/^[a-f0-9]{40}$/u.test(argv[6])))) {
    throw new Error("usage: register-seoul-metro-transfer-car-door-duration.mjs register|publish-register --snapshot <absolute.json> --receipt <absolute.json> [--expected-head <sha>]");
  }
  return { publish, snapshotPath: argv[2], receiptPath: argv[4], ...(publish ? { expectedHeadSha: argv[6] } : {}) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const { publish, ...inputs } = parseArgs(process.argv.slice(2));
    const options = { repositoryRoot: path.resolve(import.meta.dirname, "../.."), ...inputs };
    if (publish) await publishAndRegisterSeoulMetroTransfer(options);
    else await registerSeoulMetroTransfer(options);
    console.log(JSON.stringify({ registered: SOURCE_ID }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : `${LABEL} registration failed`);
    process.exitCode = 1;
  }
}
