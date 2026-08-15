#!/usr/bin/env node
import { createHash } from "node:crypto";
import { link, lstat, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { readRegularSnapshot } from "./build-current-kric-exit-collection-plan.mjs";
import { canonicalKricExitPathProviderSnapshotJson } from "./collect-kric-exit-path-provider-snapshot.mjs";
import { canonicalKricExitPathCollectionPlanJson } from "./plan-kric-exit-path-collection.mjs";

const SOURCE_ID = "kric-station-movement-standard";
const SELECTOR = "capital-seoul-metro-production";
const CAPITAL_LINE_NAMES = new Map([
  ["seoul-2", "수도권 2호선"], ["seoul-4", "수도권 4호선"],
  ["line-80fc4d5350d4", "수도권 5호선"], ["line-3f41718e0833", "수도권 6호선"],
  ["shinbundang", "수도권 신분당"],
]);
const RESULT_KEYS = ["queryId", "state", "providerResultCode", "rawResponseSha256", "rawResponseByteSize", "providerRecordHash", "rows"];
const ROW_KEYS = ["edMovePath", "elvtSttCd", "elvtTpCd", "exitMvTpOrdr", "imgPath", "mvContDtl", "mvPathMgNo", "stMovePath"];
const SNAPSHOT_KEYS = ["schemaVersion", "artifactKind", "sourceId", "snapshotId", "capturedAt", "freshUntil", "credentialRedacted", "collectionPlanDigest", "queryPlanSha256", "coverage", "queryPlan", "results", "snapshotDigest"];

export function buildCurrentKricExitCollectionReceipt({ collectionPlanBytes, providerSnapshotBytes, repository, repositorySha, workflowRunId }) {
  const planBytes = bytes(collectionPlanBytes, "collection plan");
  const snapshotBytes = bytes(providerSnapshotBytes, "provider snapshot");
  const plan = parseCanonicalPlan(planBytes);
  const snapshot = parseCanonicalSnapshot(snapshotBytes);
  validateSemanticPair(plan, snapshot);
  if (repository !== "AquilaXk/easysubway-data") throw new Error("repository identity mismatch");
  if (!/^[a-f0-9]{40}$/.test(repositorySha ?? "")) throw new Error("repository SHA mismatch");
  if (!Number.isSafeInteger(workflowRunId) || workflowRunId <= 0) throw new Error("workflow run ID mismatch");
  const payload = canonicalObject({
    schemaVersion: 1,
    artifactKind: "kric-exit-path-collection-receipt",
    repository,
    repositorySha,
    workflowRunId,
    coverageSelector: SELECTOR,
    sourceId: SOURCE_ID,
    providerMappingCount: 213,
    stationLineQueryCount: 213,
    stationCount: 199,
    routeEdgeCount: 420,
    queryCount: 420,
    collectionPlanSha256: sha256(planBytes),
    providerSnapshotSha256: sha256(snapshotBytes),
    collectionPlanDigest: plan.collectionPlanDigest,
    queryPlanSha256: plan.queryPlanSha256,
    providerSnapshotDigest: snapshot.snapshotDigest,
  });
  return canonicalObject({ ...payload, receiptSha256: sha256(canonicalJson(payload)) });
}

export function canonicalCurrentKricExitCollectionReceiptJson(receipt) {
  assertKeys(receipt, [
    "schemaVersion", "artifactKind", "repository", "repositorySha", "workflowRunId", "coverageSelector", "sourceId",
    "providerMappingCount", "stationLineQueryCount", "stationCount", "routeEdgeCount", "queryCount",
    "collectionPlanSha256", "providerSnapshotSha256", "collectionPlanDigest", "queryPlanSha256", "providerSnapshotDigest", "receiptSha256",
  ], "collection receipt keys");
  const { receiptSha256, ...payload } = receipt;
  if (receipt.schemaVersion !== 1 || receipt.artifactKind !== "kric-exit-path-collection-receipt"
    || receipt.repository !== "AquilaXk/easysubway-data" || !/^[a-f0-9]{40}$/.test(receipt.repositorySha)
    || !Number.isSafeInteger(receipt.workflowRunId) || receipt.workflowRunId <= 0
    || receipt.coverageSelector !== SELECTOR || receipt.sourceId !== SOURCE_ID
    || !Number.isSafeInteger(receipt.providerMappingCount) || receipt.providerMappingCount !== 213
    || !Number.isSafeInteger(receipt.stationLineQueryCount) || receipt.stationLineQueryCount !== 213
    || !Number.isSafeInteger(receipt.stationCount) || receipt.stationCount !== 199
    || !Number.isSafeInteger(receipt.routeEdgeCount) || receipt.routeEdgeCount !== 420
    || !Number.isSafeInteger(receipt.queryCount) || receipt.queryCount !== 420) {
    throw new Error("collection receipt identity mismatch");
  }
  for (const key of ["collectionPlanSha256", "providerSnapshotSha256", "collectionPlanDigest", "queryPlanSha256", "providerSnapshotDigest", "receiptSha256"]) assertSha256(receipt[key], key);
  if (sha256(canonicalJson(payload)) !== receiptSha256) throw new Error("collection receipt digest mismatch");
  return canonicalJson(receipt);
}

export function buildCurrentKricExitCollectionBundle({ collectionPlanBytes, providerSnapshotBytes, receipt }) {
  const planBytes = bytes(collectionPlanBytes, "collection plan");
  const snapshotBytes = bytes(providerSnapshotBytes, "provider snapshot");
  const plan = parseCanonicalPlan(planBytes);
  const snapshot = parseCanonicalSnapshot(snapshotBytes);
  const receiptBytes = Buffer.from(canonicalCurrentKricExitCollectionReceiptJson(receipt));
  assertReceiptBinds({ plan, snapshot, receipt });
  const payload = canonicalObject({
    schemaVersion: 1,
    artifactKind: "kric-exit-path-collection-bundle",
    collectionPlanJson: new TextDecoder("utf-8", { fatal: true }).decode(planBytes),
    providerSnapshotJson: new TextDecoder("utf-8", { fatal: true }).decode(snapshotBytes),
    collectionReceiptJson: new TextDecoder("utf-8", { fatal: true }).decode(receiptBytes),
  });
  return canonicalObject({ ...payload, bundleSha256: sha256(canonicalJson(payload)) });
}

export function canonicalCurrentKricExitCollectionBundleJson(bundle) {
  assertKeys(bundle, ["schemaVersion", "artifactKind", "collectionPlanJson", "providerSnapshotJson", "collectionReceiptJson", "bundleSha256"], "collection bundle keys");
  const { bundleSha256, ...payload } = bundle;
  if (bundle.schemaVersion !== 1 || bundle.artifactKind !== "kric-exit-path-collection-bundle" || [bundle.collectionPlanJson, bundle.providerSnapshotJson, bundle.collectionReceiptJson].some((value) => typeof value !== "string" || value === "")) throw new Error("collection bundle identity mismatch");
  assertSha256(bundleSha256, "bundle SHA");
  if (sha256(canonicalJson(payload)) !== bundleSha256) throw new Error("collection bundle digest mismatch");
  const planBytes = Buffer.from(bundle.collectionPlanJson);
  const snapshotBytes = Buffer.from(bundle.providerSnapshotJson);
  const receiptBytes = Buffer.from(bundle.collectionReceiptJson);
  const plan = parseCanonicalPlan(planBytes);
  const snapshot = parseCanonicalSnapshot(snapshotBytes);
  const receipt = parseJson(receiptBytes, "collection receipt");
  if (!receiptBytes.equals(Buffer.from(canonicalCurrentKricExitCollectionReceiptJson(receipt)))) throw new Error("collection receipt must be canonical JSON");
  assertReceiptBinds({ plan, snapshot, receipt });
  return canonicalJson(bundle);
}

function assertReceiptBinds({ plan, snapshot, receipt }) {
  canonicalCurrentKricExitCollectionReceiptJson(receipt);
  if (receipt.collectionPlanSha256 !== sha256(Buffer.from(canonicalKricExitPathCollectionPlanJson(plan)))
    || receipt.providerSnapshotSha256 !== sha256(Buffer.from(canonicalKricExitPathProviderSnapshotJson(snapshot)))
    || receipt.collectionPlanDigest !== plan.collectionPlanDigest
    || receipt.queryPlanSha256 !== plan.queryPlanSha256
    || receipt.providerSnapshotDigest !== snapshot.snapshotDigest
    || snapshot.collectionPlanDigest !== plan.collectionPlanDigest
    || snapshot.queryPlanSha256 !== plan.queryPlanSha256) throw new Error("collection receipt binding mismatch");
}

export async function main(argv, { env = process.env, log = console.log } = {}) {
  const args = parseArgs(argv);
  const runnerTemp = absolute(env.RUNNER_TEMP, "RUNNER_TEMP");
  if (path.dirname(args.output) !== runnerTemp) throw new Error("output must be a direct RUNNER_TEMP child");
  await absent(args.output, "output");
  const [plan, snapshot] = await Promise.all([
    readRegularSnapshot(args.collectionPlan, "collection plan"),
    readRegularSnapshot(args.providerSnapshot, "provider snapshot"),
  ]);
  const receipt = buildCurrentKricExitCollectionReceipt({
    collectionPlanBytes: plan.bytes, providerSnapshotBytes: snapshot.bytes,
    repository: args.repository, repositorySha: args.repositorySha, workflowRunId: args.workflowRunId,
  });
  await assertUnchanged(plan);
  await assertUnchanged(snapshot);
  const bundle = buildCurrentKricExitCollectionBundle({ collectionPlanBytes: plan.bytes, providerSnapshotBytes: snapshot.bytes, receipt });
  await publishBundle({ output: args.output, bytes: Buffer.from(canonicalCurrentKricExitCollectionBundleJson(bundle)) });
  log(JSON.stringify({ result: "PASS", sourceId: SOURCE_ID, receiptSha256: receipt.receiptSha256, queryCount: 420 }));
  return receipt;
}

function parseCanonicalPlan(input) {
  const value = parseJson(input, "collection plan");
  const canonical = canonicalKricExitPathCollectionPlanJson(value);
  if (!input.equals(Buffer.from(canonical))) throw new Error("collection plan must be canonical JSON");
  validatePlanSemantics(value);
  return value;
}

function parseCanonicalSnapshot(input) {
  const value = parseJson(input, "provider snapshot");
  assertKeys(value, SNAPSHOT_KEYS, "provider snapshot keys");
  const canonical = canonicalKricExitPathProviderSnapshotJson(value);
  if (!input.equals(Buffer.from(canonical))) throw new Error("provider snapshot must be canonical JSON");
  validateSnapshotSemantics(value);
  return value;
}

function validatePlanSemantics(plan) {
  assertKeys(plan, ["schemaVersion", "artifactKind", "candidate", "providerMappings", "routeEdges", "queryPlan", "stationLineQueries", "queryPlanSha256", "collectionPlanDigest"], "collection plan keys");
  if (plan.schemaVersion !== 1 || plan.artifactKind !== "kric-exit-path-collection-plan") throw new Error("collection plan identity mismatch");
  assertKeys(plan.candidate, ["candidateId", "stationSetSha256", "stationLineSetSha256", "stationLineMappingSha256", "providerMappingSha256", "topologySha256"], "collection plan candidate keys");
  if (typeof plan.candidate.candidateId !== "string" || plan.candidate.candidateId.trim() === "") throw new Error("collection candidate mismatch");
  for (const value of Object.values(plan.candidate).slice(1)) assertSha256(value, "collection candidate hash");
  const mappings = plan.providerMappings;
  const stationQueries = plan.stationLineQueries;
  const edges = plan.routeEdges;
  const queries = plan.queryPlan;
  if (![mappings, stationQueries, edges, queries].every(Array.isArray) || mappings.length !== 213 || stationQueries.length !== 213 || edges.length !== 420 || queries.length !== 420) throw new Error("collection plan coverage mismatch");
  const stationLines = new Set(); const providerTuples = new Set(); const mappingByStationLine = new Map();
  for (const mapping of mappings) {
    assertKeys(mapping, ["stationId", "lineId", "providerOperatorId", "providerLineId", "providerStationId"], "provider mapping keys");
    if (Object.values(mapping).some((value) => typeof value !== "string" || value.trim() === "")) throw new Error("provider mapping mismatch");
    const stationLine = `${mapping.stationId}\0${mapping.lineId}`; const tuple = `${mapping.providerOperatorId}\0${mapping.providerLineId}\0${mapping.providerStationId}`;
    if (stationLines.has(stationLine) || providerTuples.has(tuple)) throw new Error("duplicate provider mapping");
    stationLines.add(stationLine); providerTuples.add(tuple); mappingByStationLine.set(stationLine, mapping);
  }
  if (plan.candidate.providerMappingSha256 !== sha256(canonicalJson(mappings)) || plan.candidate.topologySha256 !== sha256(canonicalJson(edges))) throw new Error("collection candidate inventory mismatch");
  if (new Set(mappings.map(({ stationId }) => stationId)).size !== 199 || canonicalJson(mappings) !== canonicalJson([...mappings].sort((a, b) => compare(`${a.stationId}\0${a.lineId}`, `${b.stationId}\0${b.lineId}`)))) throw new Error("provider mapping order mismatch");
  const stationIds = [...new Set(mappings.map(({ stationId }) => stationId))].sort(compare);
  if (plan.candidate.stationSetSha256 !== sha256(canonicalJson(stationIds))) throw new Error("collection candidate station set mismatch");
  const queryIds = new Set(); const queryTuple = new Set(); const queryById = new Map();
  for (const query of queries) {
    assertKeys(query, ["queryId", "routeEdgeId", "providerOperatorId", "providerLineId", "providerStationId", "providerNextStationId", "operatorName", "lineName", "stationName", "regionId"], "provider query keys");
    if (Object.values(query).some((value) => typeof value !== "string" || value.trim() === "")) throw new Error("provider query mismatch");
    const identity = canonicalObject({ providerLineId: query.providerLineId, providerNextStationId: query.providerNextStationId, providerOperatorId: query.providerOperatorId, providerStationId: query.providerStationId, routeEdgeId: query.routeEdgeId });
    if (query.queryId !== sha256(canonicalJson(identity))) throw new Error("provider query identity mismatch");
    const tuple = `${query.providerOperatorId}\0${query.providerLineId}\0${query.providerStationId}\0${query.providerNextStationId}`;
    if (queryIds.has(query.queryId) || queryTuple.has(tuple)) throw new Error("duplicate provider query");
    queryIds.add(query.queryId); queryTuple.add(tuple); queryById.set(query.queryId, query);
  }
  if (canonicalJson(queries) !== canonicalJson([...queries].sort(compareQuery))) throw new Error("provider query order mismatch");
  const stationQueryIds = new Set(); const edgeById = new Map(edges.map((edge) => [edge.routeEdgeId, edge]));
  for (const entry of stationQueries) {
    assertKeys(entry, ["stationLineId", "queryIds"], "station-line query keys");
    if (typeof entry.stationLineId !== "string" || !stationLines.has(entry.stationLineId.replace(":", "\0")) || !Array.isArray(entry.queryIds) || entry.queryIds.length === 0) throw new Error("station-line query relation mismatch");
    if (canonicalJson(entry.queryIds) !== canonicalJson([...entry.queryIds].sort((a, b) => compareQuery(queryById.get(a), queryById.get(b))))) throw new Error("station-line query order mismatch");
    const mapping = mappingByStationLine.get(entry.stationLineId.replace(":", "\0"));
    for (const id of entry.queryIds) {
      const query = queryById.get(id); const edge = query && edgeById.get(query.routeEdgeId);
      if (!query || !edge || stationQueryIds.has(id) || query.providerOperatorId !== mapping.providerOperatorId || query.providerLineId !== mapping.providerLineId || query.providerStationId !== mapping.providerStationId || edge.fromStationId !== mapping.stationId || edge.lineId !== mapping.lineId) throw new Error("station-line query relation mismatch");
      const next = mappingByStationLine.get(`${edge.toStationId}\0${edge.lineId}`);
      if (!next || query.providerNextStationId !== next.providerStationId) throw new Error("route edge query relation mismatch");
      stationQueryIds.add(id);
    }
  }
  if (stationQueryIds.size !== 420 || canonicalJson(stationQueries) !== canonicalJson([...stationQueries].sort((a, b) => compare(a.stationLineId, b.stationLineId)))) throw new Error("station-line query coverage mismatch");
  const edgeIds = new Set();
  for (const edge of edges) {
    assertKeys(edge, ["routeEdgeId", "fromStationId", "toStationId", "lineId", "edgeType", "servicePattern", "serviceClass"], "route edge keys");
    if (Object.values(edge).some((value) => typeof value !== "string" || value.trim() === "") || edge.edgeType !== "RIDE" || edge.servicePattern !== "LOCAL" || edge.serviceClass !== "SUBWAY" || edge.fromStationId === edge.toStationId || edgeIds.has(edge.routeEdgeId) || !stationLines.has(`${edge.fromStationId}\0${edge.lineId}`) || !stationLines.has(`${edge.toStationId}\0${edge.lineId}`)) throw new Error("route edge relation mismatch");
    edgeIds.add(edge.routeEdgeId);
  }
  for (const query of queries) {
    const edge = edgeIds.has(query.routeEdgeId) ? edges.find(({ routeEdgeId }) => routeEdgeId === query.routeEdgeId) : undefined;
    if (!edge || query.lineName !== CAPITAL_LINE_NAMES.get(edge.lineId)) throw new Error("provider query line identity mismatch");
  }
  if (canonicalJson(edges) !== canonicalJson([...edges].sort((a, b) => compare(a.routeEdgeId, b.routeEdgeId))) || new Set(queries.map(({ routeEdgeId }) => routeEdgeId)).size !== 420 || [...queryById.values()].some(({ routeEdgeId }) => !edgeIds.has(routeEdgeId))) throw new Error("route edge coverage mismatch");
}

function validateSnapshotSemantics(snapshot) {
  if (snapshot.snapshotId !== `${SOURCE_ID}-${snapshot.capturedAt.replaceAll(/[-:.]/g, "")}`) throw new Error("provider snapshot ID mismatch");
  for (const key of ["capturedAt", "freshUntil"]) if (typeof snapshot[key] !== "string" || new Date(snapshot[key]).toISOString() !== snapshot[key]) throw new Error("provider snapshot time mismatch");
  if (Date.parse(snapshot.freshUntil) !== Date.parse(snapshot.capturedAt) + 24 * 60 * 60 * 1000) throw new Error("provider snapshot freshness mismatch");
}

function validateSemanticPair(plan, snapshot) {
  if (snapshot.schemaVersion !== 1 || snapshot.artifactKind !== "kric-exit-path-provider-snapshot" || snapshot.sourceId !== SOURCE_ID || snapshot.credentialRedacted !== true
    || snapshot.collectionPlanDigest !== plan.collectionPlanDigest || snapshot.queryPlanSha256 !== plan.queryPlanSha256) throw new Error("plan/snapshot identity mismatch");
  if (!Array.isArray(plan.providerMappings) || !Array.isArray(plan.stationLineQueries) || !Array.isArray(plan.routeEdges) || !Array.isArray(plan.queryPlan)
    || plan.providerMappings.length !== 213 || plan.stationLineQueries.length !== 213 || plan.routeEdges.length !== 420 || plan.queryPlan.length !== 420
    || new Set(plan.providerMappings.map(({ stationId }) => stationId)).size !== 199) throw new Error("collection plan coverage mismatch");
  const lineCounts = new Map();
  for (const query of plan.queryPlan) lineCounts.set(query.lineName, (lineCounts.get(query.lineName) ?? 0) + 1);
  if (canonicalJson([...lineCounts].sort(([a], [b]) => compare(a, b))) !== canonicalJson([["수도권 2호선", 102], ["수도권 4호선", 100], ["수도권 5호선", 110], ["수도권 6호선", 78], ["수도권 신분당", 30]])) throw new Error("capital selector coverage mismatch");
  if (!snapshot.coverage || snapshot.coverage.requestPlanComplete !== true || !Array.isArray(snapshot.coverage.queryIds)
    || canonicalJson(snapshot.queryPlan) !== canonicalJson(plan.queryPlan)
    || canonicalJson(snapshot.coverage.queryIds) !== canonicalJson(plan.queryPlan.map(({ queryId }) => queryId))) throw new Error("provider snapshot query coverage mismatch");
  if (!Array.isArray(snapshot.results) || snapshot.results.length !== 420) throw new Error("provider snapshot result coverage mismatch");
  const ids = plan.queryPlan.map(({ queryId }) => queryId);
  const seen = new Set();
  for (let index = 0; index < snapshot.results.length; index += 1) {
    const result = snapshot.results[index];
    assertKeys(result, RESULT_KEYS, "provider result keys");
    if (result.queryId !== ids[index] || seen.has(result.queryId)) throw new Error("provider result order mismatch");
    seen.add(result.queryId);
    assertSha256(result.rawResponseSha256, "provider raw response SHA");
    assertSha256(result.providerRecordHash, "provider record hash");
    if (!Number.isSafeInteger(result.rawResponseByteSize) || result.rawResponseByteSize < 1 || result.rawResponseByteSize > 1024 * 1024 || !Array.isArray(result.rows)) throw new Error("provider result shape mismatch");
    const rows = result.rows.map((row) => {
      assertKeys(row, ROW_KEYS, "provider row keys");
      for (const value of Object.values(row)) if (value !== null && (!["string", "number", "boolean"].includes(typeof value) || (typeof value === "number" && !Number.isFinite(value)))) throw new Error("provider row scalar mismatch");
      for (const key of ["mvPathMgNo", "exitMvTpOrdr"]) if (!((typeof row[key] === "string" || typeof row[key] === "number") && String(row[key]).trim() !== "")) throw new Error("provider row ordering identity missing");
      return row;
    });
    if (canonicalJson(rows) !== canonicalJson([...rows].sort(compareRow)) || new Set(rows.map(canonicalJson)).size !== rows.length) throw new Error("provider row order mismatch");
    if (sha256(canonicalJson(rows)) !== result.providerRecordHash) throw new Error("provider row hash mismatch");
    const valid = (result.state === "ROWS_OBSERVED" && result.providerResultCode === "00" && rows.length > 0)
      || (result.state === "EXPLICIT_ZERO" && result.providerResultCode === "00" && rows.length === 0)
      || (result.state === "PROVIDER_NO_DATA" && result.providerResultCode === "03" && rows.length === 0)
      || (result.state === "PROVIDER_RESULT_UNVERIFIED" && result.providerResultCode === null);
    if (!valid) throw new Error("provider result state mismatch");
  }
}

async function publishBundle({ output, bytes: bundleBytes }) {
  const parent = path.dirname(output);
  const parentBefore = await lstat(parent);
  if (!parentBefore.isDirectory() || parentBefore.isSymbolicLink() || path.dirname(output) !== parent) throw new Error("output parent mismatch");
  await absent(output, "output");
  const staging = await mkdtemp(path.join(parent, ".kric-exit-bundle-"));
  const stagedOutput = path.join(staging, "bundle.json");
  let stagedIdentity;
  try {
    await writeFile(stagedOutput, bundleBytes, { flag: "wx", mode: 0o600 });
    const staged = await readRegularSnapshot(stagedOutput, "staged bundle");
    if (staged.bytes.length === 0 || (staged.identity.mode & 0o777) !== 0o600 || !staged.bytes.equals(bundleBytes)) throw new Error("staged bundle mismatch");
    stagedIdentity = staged.identity;
    const parentAfter = await lstat(parent);
    if (!sameDirectory(parentBefore, parentAfter)) throw new Error("output parent changed during build");
    await link(stagedOutput, output);
    const final = await readRegularSnapshot(output, "output bundle");
    if (final.bytes.length === 0 || (final.identity.mode & 0o777) !== 0o600 || !final.bytes.equals(bundleBytes)) throw new Error("output bundle mismatch");
    await unlink(stagedOutput);
  } catch (error) {
    if (stagedIdentity) {
      try {
        const current = await lstat(output);
        if (sameIdentity(stagedIdentity, current)) await unlink(output);
      } catch (cleanupError) { if (cleanupError?.code !== "ENOENT") throw cleanupError; }
    }
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
  await rm(staging, { recursive: true, force: true });
}

function parseArgs(argv) {
  const paths = new Set(["collection-plan", "provider-snapshot", "output"]);
  const allowed = new Set([...paths, "repository", "repository-sha", "workflow-run-id"]);
  if (!Array.isArray(argv) || argv.length !== 12) throw new Error("collection receipt arguments mismatch");
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = String(argv[index] ?? "").replace(/^--/, ""); const value = argv[index + 1];
    if (!allowed.has(key) || values[key] !== undefined || typeof value !== "string" || value === "") throw new Error("collection receipt arguments mismatch");
    values[key] = paths.has(key) ? absolute(value, `--${key}`) : value;
  }
  if ([...allowed].some((key) => values[key] === undefined)) throw new Error("collection receipt arguments mismatch");
  if (!/^[1-9]\d*$/.test(values["workflow-run-id"]) || !Number.isSafeInteger(Number(values["workflow-run-id"]))) throw new Error("workflow run ID mismatch");
  return { collectionPlan: values["collection-plan"], providerSnapshot: values["provider-snapshot"], output: values.output, repository: values.repository, repositorySha: values["repository-sha"], workflowRunId: Number(values["workflow-run-id"]) };
}

function parseJson(input, label) { try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input)); } catch { throw new Error(`${label} must be strict UTF-8 JSON`); } }
function bytes(value, label) { if (!(value instanceof Uint8Array) || value.byteLength === 0) throw new Error(`${label} must be non-empty bytes`); return Buffer.from(value); }
function absolute(value, label) { if (!path.isAbsolute(value)) throw new Error(`${label} must be absolute`); return path.resolve(value); }
async function absent(target, label) { try { await lstat(target); } catch (error) { if (error?.code === "ENOENT") return; throw error; } throw new Error(`${label} must be absent`); }
async function assertUnchanged(snapshot) { const current = await lstat(snapshot.target); if (!current.isFile() || current.isSymbolicLink() || !sameIdentity(snapshot.identity, current)) throw new Error(`${snapshot.label} changed during read`); }
function sameIdentity(left, right) { return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs && left.mode === right.mode; }
function sameDirectory(left, right) { return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && right.isDirectory() && !right.isSymbolicLink(); }
function assertKeys(value, expected, label) { if (!value || typeof value !== "object" || Array.isArray(value) || canonicalJson(Object.keys(value).sort(compare)) !== canonicalJson([...expected].sort(compare))) throw new Error(`${label} mismatch`); }
function assertSha256(value, label) { if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`${label} mismatch`); }
function canonicalObject(value) { if (Array.isArray(value)) return value.map(canonicalObject); if (!value || typeof value !== "object") return value; return Object.fromEntries(Object.keys(value).sort(compare).map((key) => [key, canonicalObject(value[key])])); }
function canonicalJson(value) { return JSON.stringify(canonicalObject(value)); }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function compare(left, right) { return Buffer.compare(Buffer.from(left), Buffer.from(right)); }
function compareQuery(left, right) { if (!left || !right) return 1; return compare(left.providerStationId, right.providerStationId) || compare(left.providerNextStationId, right.providerNextStationId) || compare(left.routeEdgeId, right.routeEdgeId) || compare(left.queryId, right.queryId); }
function compareRow(left, right) { return compare(String(left.mvPathMgNo), String(right.mvPathMgNo)) || compare(String(left.exitMvTpOrdr), String(right.exitMvTpOrdr)) || compare(canonicalJson(left), canonicalJson(right)); }

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main(process.argv.slice(2)).catch((error) => { console.error(error instanceof Error ? error.message : "collection receipt failed"); process.exitCode = 1; });
