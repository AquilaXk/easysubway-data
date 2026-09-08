import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual, promisify } from "node:util";
import { pathToFileURL } from "node:url";

import { collectGwangjuRouteTopology } from "./collect-gwangju-route-topology.mjs";
import { canonicalJson } from "./lib/manifest-validation.mjs";
import { createSourceRegistrationTransaction, SOURCE_REGISTRATION_OUTPUTS } from "./lib/source-registration-transaction.mjs";
import { deriveFreshnessExpiresAt } from "./freshness-policy.mjs";
import { buildSnapshotDiff, validateLineage } from "./source-snapshot-policy.mjs";
import { buildAppendOnlyGovernancePolicyRegistration, deriveRawRetentionExpiresAt, validateSourceGovernancePolicy } from "./source-governance-policy.mjs";
import { preauthenticatedObjectStorageClient, publishImmutableObjectPlan, requireCurrentCapitalLiveChainOciParBaseUrl } from "./publish-object-storage.mjs";

const SOURCE_ID = "gwangju-transportation-route-topology";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const parse = (bytes) => JSON.parse(bytes.toString("utf8"));
const select = (rows, predicate) => {
  const matches = rows.filter(predicate);
  if (matches.length !== 1) throw new Error("Gwangju topology selection mismatch");
  return matches[0];
};

/** 재수집 없이 보존 원문을 해석하고 기존 정책의 등록 입력을 준비한다. */
export async function prepareGwangjuTopologyRegistration({ repositoryRoot, snapshotPath, now = new Date() }) {
  if (!path.isAbsolute(repositoryRoot ?? "") || !path.isAbsolute(snapshotPath ?? "") || !Number.isFinite(now.valueOf())) {
    throw new Error("Gwangju topology registration requires absolute input paths and time");
  }
  const root = path.resolve(repositoryRoot);
  const currentBytes = await Promise.all(SOURCE_REGISTRATION_OUTPUTS.map((relative) => readFile(path.join(root, relative))));
  const [inventory, ledger, governance, freshness] = currentBytes.map(parse);
  const source = select(inventory.sources, ({ id }) => id === SOURCE_ID);
  const snapshotBytes = await readFile(snapshotPath), snapshot = parse(snapshotBytes);
  if (!Array.isArray(snapshot.rawResponses) || snapshot.rawResponses.length !== snapshot.scope?.length) {
    throw new Error("Gwangju topology collected raw responses are required");
  }
  let cursor = 0;
  const replay = await collectGwangjuRouteTopology({ stationScope: snapshot.scope, now: new Date(snapshot.capturedAt),
    fetchImpl: async (url) => {
      const response = snapshot.rawResponses[cursor++];
      const bytes = Buffer.from(response?.bytesBase64 ?? "", "base64");
      if (response?.providerStationId !== new URL(url).searchParams.get("station_id") || bytes.toString("base64") !== response.bytesBase64) {
        throw new Error("Gwangju topology raw response binding mismatch");
      }
      return new Response(bytes);
    },
  });
  if (!isDeepStrictEqual(snapshot, replay)) throw new Error("Gwangju topology collected snapshot mismatch");

  const licenseHash = sha(canonicalJson(source.license));
  const retainedEntry = governance.sources.find(({ sourceId }) => sourceId === SOURCE_ID);
  const registrationInputs = [];
  let entry = retainedEntry;
  if (!entry) {
    const absolute = path.join(root, "tools/datapack/source-candidates.json");
    const bytes = await readFile(absolute);
    entry = select(parse(bytes).candidates, ({ id }) => id === SOURCE_ID).registrationMetadata?.governance;
    registrationInputs.push({ absolute, bytes });
  }
  const review = entry?.licenseReview;
  if (source.productionUseAllowed !== true || source.license?.redistributionAllowed !== true
    || entry?.sourceId !== SOURCE_ID || entry.sourceClassId !== "route_graph_topology"
    || review?.status !== "APPROVED" || review.termsHash !== licenseHash
    || review.termsUrl !== source.license.evidenceUrl || review.reviewedProvider !== source.provider
    || review.reviewedDatasetUrl !== source.datasetUrl || review.approvedByRole !== entry.approvalRole
    || !Number.isFinite(Date.parse(review.reviewedAt)) || !Number.isFinite(Date.parse(review.nextReviewAt))
    || Date.parse(review.reviewedAt) > now.valueOf() || Date.parse(review.nextReviewAt) <= now.valueOf()) {
    throw new Error("Gwangju topology recorded license review binding is required");
  }
  const projectedFreshness = structuredClone(freshness);
  const sourceClass = select(projectedFreshness.sourceClasses, ({ id }) => id === entry.sourceClassId);
  if (!sourceClass.sourceIds.includes(SOURCE_ID)) sourceClass.sourceIds.push(SOURCE_ID);
  const freshUntil = deriveFreshnessExpiresAt({ policy: projectedFreshness, sourceClassId: sourceClass.id,
    basisAt: snapshot.capturedAt, evaluationAt: now.toISOString() });
  if (freshUntil !== snapshot.freshUntil || now.valueOf() >= Date.parse(freshUntil) || now.valueOf() < Date.parse(snapshot.capturedAt)) {
    throw new Error("Gwangju topology freshness mismatch");
  }
  const projectedGovernance = retainedEntry ? governance : buildAppendOnlyGovernancePolicyRegistration({
    predecessorPolicyBytes: currentBytes[2], addedSources: [structuredClone(entry)],
  }).policy;
  const nextSource = { ...source, admissionEvidence: { ...source.admissionEvidence, licenseEvidenceHash: licenseHash } };
  const projectedInventory = { ...inventory, sources: inventory.sources.map((row) => row.id === SOURCE_ID ? nextSource : row) };
  validateSourceGovernancePolicy({ policy: projectedGovernance, freshnessPolicy: projectedFreshness, inventory: projectedInventory });
  const snapshotSha256 = sha(snapshotBytes), snapshotId = `${SOURCE_ID}-${snapshotSha256}`;
  const rawRetentionExpiresAt = deriveRawRetentionExpiresAt({ policy: projectedGovernance, sourceId: SOURCE_ID, retrievedAt: snapshot.capturedAt });
  const objectKey = `source-raw/${SOURCE_ID}/${snapshotSha256}.json`;
  return { root, snapshotPath, snapshotBytes, snapshot, snapshotId, snapshotSha256, currentBytes, ledger, registrationInputs,
    inventory: projectedInventory, governance: projectedGovernance, freshness: projectedFreshness,
    rawRetentionExpiresAt, objectKey,
    publishPlan: { steps: [
      { type: "put-immutable-bundle-object", objectKey, sourcePath: path.basename(snapshotPath), sha256: snapshotSha256, sizeBytes: snapshotBytes.length },
      { type: "verify-immutable-bundle-object", objectKey, sourcePath: path.basename(snapshotPath), sha256: snapshotSha256, sizeBytes: snapshotBytes.length },
    ] },
  };
}

/** 실제 OCI PUT/GET receipt를 받은 뒤에만 정본 등록 결과를 만든다. */
export async function buildGwangjuTopologyRegistrationOutputs({ receiptPath, ...options }) {
  const prepared = await prepareGwangjuTopologyRegistration(options);
  return outputsFromPrepared(prepared, receiptPath, options.now ?? new Date());
}

async function outputsFromPrepared(prepared, receiptPath, now) {
  if (!path.isAbsolute(receiptPath ?? "")) throw new Error("Gwangju topology receipt path is required");
  const receiptBytes = await readFile(receiptPath), receipt = parse(receiptBytes);
  const { snapshot, snapshotId, snapshotSha256, root, inventory, ledger, governance, freshness } = prepared;
  if (receipt.sourceId !== SOURCE_ID || receipt.snapshotId !== snapshotId
    || receipt.rawObjectSha256 !== snapshotSha256 || receipt.byteSize !== prepared.snapshotBytes.length
    || receipt.rawObjectUri !== `oci://axvym6vk8g7i/easysubway-datapacks/${prepared.objectKey}`
    || receipt.rawRetentionExpiresAt !== prepared.rawRetentionExpiresAt
    || !Number.isFinite(Date.parse(receipt.storedAt)) || Date.parse(receipt.storedAt) < Date.parse(snapshot.capturedAt)
    || Date.parse(receipt.storedAt) > now.valueOf()) {
    throw new Error("Gwangju topology OCI receipt binding mismatch");
  }
  if (ledger.some((row) => row.snapshotId === snapshotId)) throw new Error("Gwangju topology snapshot already registered");
  const previous = ledger.filter((row) => row.sourceId === SOURCE_ID).at(-1);
  const relative = `tools/datapack/sources/${snapshotId}.json`;
  const source = select(inventory.sources, ({ id }) => id === SOURCE_ID);
  source.topologyAdmissionEvidence = { ...source.topologyAdmissionEvidence, snapshotId, snapshotPath: relative,
    capturedAt: snapshot.capturedAt, freshUntil: snapshot.freshUntil, stationCount: snapshot.stationCount,
    edgeCount: snapshot.edgeCount, rawSha256: snapshot.rawSha256, contentSha256: snapshot.contentSha256 };
  source.observedDataUpdatedAt = snapshot.capturedAt.slice(0, 10);
  source.retrievedAt = snapshot.capturedAt.slice(0, 10);
  const governanceBytes = json(governance);
  const row = { schemaVersion: 1, artifactKind: "official-source-snapshot", sourceId: SOURCE_ID, snapshotId,
    previousSnapshotId: previous?.snapshotId ?? null, capturedAt: snapshot.capturedAt, retrievedAt: snapshot.capturedAt,
    sourceUpdatedAt: null, provider: source.provider, rowCount: snapshot.edgeCount, coverageCount: snapshot.stationCount,
    rawSha256: snapshot.rawSha256, contentSha256: snapshot.contentSha256, rawObjectUri: receipt.rawObjectUri,
    rawObjectSha256: snapshotSha256, rawReceiptSha256: sha(receiptBytes), byteSize: prepared.snapshotBytes.length,
    freshUntil: snapshot.freshUntil, freshnessExpiresAt: snapshot.freshUntil,
    rawRetentionExpiresAt: prepared.rawRetentionExpiresAt, governancePolicyVersion: governance.policyVersion,
    governancePolicySha256: sha(governanceBytes),
    schemaFingerprint: sha(canonicalJson({ artifactKind: snapshot.artifactKind, keys: Object.keys(snapshot).sort() })),
    redactedRequestFingerprint: sha(canonicalJson({ endpoint: snapshot.endpoint, scope: snapshot.scope.map(({ providerStationId }) => providerStationId) })),
    snapshotStatus: "LOCKED", schemaStatus: "PASS", licenseStatus: "PASS", fetchStatus: "SUCCESS",
    redistributionAllowed: true, credentialRedacted: true, admissionEvidence: source.admissionEvidence };
  row.diffSummary = previous ? buildSnapshotDiff(previous, row) : null;
  validateLineage([...ledger.filter((entry) => entry.sourceId === SOURCE_ID), row]);
  // 실패 후 같은 입력으로 재개할 수 있으나 다른 immutable bytes는 덮어쓰지 않는다.
  const snapshotFile = path.join(root, relative);
  try { await writeFile(snapshotFile, prepared.snapshotBytes, { flag: "wx", mode: 0o600 }); }
  catch (error) {
    if (error.code !== "EEXIST" || !(await readFile(snapshotFile)).equals(prepared.snapshotBytes)) throw error;
  }
  const inputs = [
    ...prepared.registrationInputs,
    { absolute: prepared.snapshotPath, bytes: prepared.snapshotBytes },
    { absolute: receiptPath, bytes: receiptBytes },
    { absolute: path.join(root, relative), bytes: prepared.snapshotBytes },
  ];
  const values = [json(inventory), json([...ledger, row]), governanceBytes, json(freshness)];
  return SOURCE_REGISTRATION_OUTPUTS.map((relative, index) => ({ relative, bytes: values[index], prestateBytes: prepared.currentBytes[index], inputs }));
}

const transaction = createSourceRegistrationTransaction({ label: "Gwangju topology", validateOutputs(outputs) {
  if (!Array.isArray(outputs) || !isDeepStrictEqual(outputs.map(({ relative }) => relative), SOURCE_REGISTRATION_OUTPUTS)
    || outputs.some((row) => !Buffer.isBuffer(row.bytes) || !Buffer.isBuffer(row.prestateBytes) || row.inputs !== outputs[0].inputs)) {
    throw new Error("Gwangju topology registration outputs mismatch");
  }
} });
export async function registerGwangjuTopology(options) {
  await transaction.recover({ repositoryRoot: options.repositoryRoot });
  const outputs = await buildGwangjuTopologyRegistrationOutputs(options);
  return transaction.commit({ repositoryRoot: options.repositoryRoot, outputs });
}

/** 같은 prepared 입력을 발행과 등록에 사용한다. API 원문은 재수집하지 않는다. */
export async function publishAndRegisterGwangjuTopology({ expectedHeadSha, gitRunner = async (args, settings) => (await promisify(execFile)("git", args, settings)).stdout, env = process.env, client = null, ...options }) {
  const baseUrl = requireCurrentCapitalLiveChainOciParBaseUrl(env);
  if (!path.isAbsolute(options.repositoryRoot ?? "") || !/^[a-f0-9]{40}$/.test(expectedHeadSha ?? "")
    || String(await gitRunner(["rev-parse", "HEAD"], { cwd: options.repositoryRoot })).trim() !== expectedHeadSha) {
    throw new Error("Gwangju topology execution HEAD mismatch");
  }
  if (!path.isAbsolute(options.receiptPath ?? "")) throw new Error("Gwangju topology receipt path is required");
  const existing = await lstat(options.receiptPath).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (existing) throw new Error("Gwangju topology receipt already exists; resume registration without publication");
  const now = options.now ?? new Date();
  const prepared = await prepareGwangjuTopologyRegistration({ ...options, now });
  const storage = client ?? preauthenticatedObjectStorageClient(baseUrl, { includeErrorBody: false });
  try {
    await publishImmutableObjectPlan({ root: path.dirname(options.snapshotPath), plan: prepared.publishPlan,
      client: {
        putObjectIfAbsent: async (...args) => {
          if (!await storage.putObjectIfAbsent(...args)) throw new Error("Gwangju topology object already exists");
          return true;
        },
        readObject: (...args) => storage.readObject(...args),
      },
    });
  } catch { throw new Error("Gwangju topology OCI publication failed"); }
  const receipt = { schemaVersion: 1, artifactKind: "static-network-source-raw-object-receipt", sourceId: SOURCE_ID,
    snapshotId: prepared.snapshotId, capturedAt: prepared.snapshot.capturedAt,
    rawObjectUri: `oci://axvym6vk8g7i/easysubway-datapacks/${prepared.objectKey}`,
    rawObjectSha256: prepared.snapshotSha256, byteSize: prepared.snapshotBytes.length,
    storedAt: now.toISOString(), rawRetentionExpiresAt: prepared.rawRetentionExpiresAt };
  await writeFile(options.receiptPath, json(receipt), { flag: "wx", mode: 0o600 });
  const outputs = await outputsFromPrepared(prepared, options.receiptPath, now);
  return transaction.commit({ repositoryRoot: options.repositoryRoot, outputs });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const [mode, flag, inputPath] = process.argv.slice(2);
    if (process.argv.length !== 5 || !["publish-register", "register"].includes(mode)
      || flag !== "--input" || !path.isAbsolute(inputPath ?? "")) {
      throw new Error("usage: register-gwangju-route-topology.mjs <publish-register|register> --input <absolute.json>");
    }
    const options = parse(await readFile(inputPath));
    if (mode === "publish-register") await publishAndRegisterGwangjuTopology(options);
    else await registerGwangjuTopology(options);
    console.log("Gwangju topology source registration completed");
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Gwangju topology registration failed");
    process.exitCode = 1;
  }
}
