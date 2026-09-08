#!/usr/bin/env node
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import path from "node:path";

import { isMainModule } from "../lib/is-main-module.mjs";
import { buildKricRetainedFilePendingHandoff } from "./build-kric-retained-file-pending-handoff.mjs";
import { objectStorageClient } from "./publish-object-storage.mjs";

const SHA256 = /^[a-f0-9]{64}$/u;
const MAXIMUM_BUNDLE_BYTES = 64 * 1024;
const SOURCE_IDS = ["kric-nationwide-timetable-file", "kric-current-station-line-file"];
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value)
    .sort((left, right) => left.localeCompare(right))
    .map((key) => [key, canonical(value[key])]));
}
const jsonBytes = (value) => Buffer.from(`${JSON.stringify(canonical(value))}\n`);
const fail = (code) => { throw new Error(`KRIC_RETAINED_FILE_OBSERVATION_READER_${code}`); };

// 검증된 관측 행의 명시적 키만 연결한다. 시간·역 정체성·정차 순서를 추론하지 않는다.
export function readIndexedKricStopFields(record) {
  if (!record || !SHA256.test(record.sourceRowSha256 ?? "")) fail("INDEXED_ROW");
  const stations = indexedFields(record.stationName);
  const times = [record.arrivalTime, record.departureTime].map((cell) => {
    if (!cell || cell.cellType !== "s") fail("INDEXED_CELL_GRAMMAR");
    const fields = indexedFields(cell.value);
    for (const key of fields.keys()) if (!stations.has(key)) fail("INDEXED_UNKNOWN_KEY");
    return fields;
  });
  return {
    sourceRowSha256: record.sourceRowSha256,
    stops: [...stations].map(([sourceStopKey, stationName]) => ({
      sourceStopKey, stationName,
      arrivalLiteral: times[0].get(sourceStopKey) ?? null,
      departureLiteral: times[1].get(sourceStopKey) ?? null,
    })),
  };
}

function indexedFields(value) {
  if (typeof value !== "string" || value.length === 0) fail("INDEXED_CELL_GRAMMAR");
  const result = new Map();
  for (const token of value.split("+")) {
    const match = /^([A-Za-z0-9]+)-(.+)$/u.exec(token);
    if (!match || !match[2].trim()) fail("INDEXED_CELL_GRAMMAR");
    if (result.has(match[1])) fail("INDEXED_DUPLICATE_KEY");
    result.set(match[1], match[2]);
  }
  return result;
}

/** Reads and verifies the exact retained PENDING evidence without publishing it. */
export async function readKricRetainedFileObservations({
  bundleSha256, handoffSha256, reader, outputDir,
} = {}) {
  const bundleHash = requiredSha(bundleSha256, "BUNDLE_SHA256");
  const expectedHandoff = requiredSha(handoffSha256, "HANDOFF_SHA256");
  if (!reader || typeof reader.readObject !== "function") fail("READER");
  const bundleKey = `kric-retained-file-operations/${bundleHash}.json`;
  const bundleBytes = await readExact(reader, bundleKey, MAXIMUM_BUNDLE_BYTES, bundleHash, "BUNDLE");
  const bundle = parseCanonicalBundle(bundleBytes);
  validateBundleHeader(bundle, expectedHandoff);

  const sources = sourceMap(bundle.provenance);
  const timetable = await readObservation(reader, sources.get(SOURCE_IDS[0]), SOURCE_IDS[0]);
  const stationLine = await readObservation(reader, sources.get(SOURCE_IDS[1]), SOURCE_IDS[1]);
  const handoff = buildHandoff(bundle, timetable.value, stationLine.value);
  if (!sameJson(bundle.handoff, handoff) || handoff.handoffSha256 !== expectedHandoff) fail("HANDOFF");
  validateProvenance(timetable.value, stationLine.value, sources);
  validateReleaseTuple(bundle.releaseTuple, bundle.provenance, handoff);

  const result = Object.freeze({
    bundle: Object.freeze(bundle), bundleBytes: Buffer.from(bundleBytes), handoff: Object.freeze(handoff),
    observations: Object.freeze({
      timetable: Object.freeze({ value: Object.freeze(timetable.value), bytes: Buffer.from(timetable.bytes) }),
      stationLine: Object.freeze({ value: Object.freeze(stationLine.value), bytes: Buffer.from(stationLine.bytes) }),
    }),
    timetable: Object.freeze({ value: Object.freeze(timetable.value), bytes: Buffer.from(timetable.bytes) }),
    stationLine: Object.freeze({ value: Object.freeze(stationLine.value), bytes: Buffer.from(stationLine.bytes) }),
  });
  if (outputDir !== undefined) await writeOutput(outputDir, result);
  return result;
}

async function readObservation(reader, source, sourceId) {
  const identity = source?.observation;
  if (!identity || source.sourceId !== sourceId) fail("PROVENANCE");
  const bytes = await readExact(reader, identity.objectKey, identity.sizeBytes, identity.sha256, "OBSERVATION");
  if (bytes.length !== identity.sizeBytes) fail("OBSERVATION");
  const value = parseJson(bytes, "OBSERVATION");
  if (value?.sourceId !== sourceId) fail("OBSERVATION");
  return { value, bytes };
}

function parseCanonicalBundle(bytes) {
  const bundle = parseJson(bytes, "BUNDLE");
  if (!bytes.equals(jsonBytes(bundle))) fail("BUNDLE_CANONICAL");
  return bundle;
}

function validateBundleHeader(bundle, handoffSha256) {
  exactKeys(bundle, ["artifactKind", "decision", "handoff", "provenance", "receipts", "releaseEligible", "releaseTuple", "schemaVersion", "status"], "BUNDLE");
  if (bundle.schemaVersion !== 1 || bundle.artifactKind !== "kric-retained-file-operation-bundle"
    || bundle.status !== "PENDING" || bundle.decision !== "CONTRACT_GAP" || bundle.releaseEligible !== false
    || !bundle.handoff || bundle.handoff.handoffSha256 !== handoffSha256) fail("BUNDLE");
}

function sourceMap(provenance) {
  exactKeys(provenance, ["mainSha", "operationId", "repository", "sources"], "PROVENANCE");
  if (provenance.repository !== "AquilaXk/easysubway-data" || !/^[a-f0-9]{40}$/u.test(provenance.mainSha)
    || !/^[a-z0-9][a-z0-9-]{0,127}$/u.test(provenance.operationId) || !Array.isArray(provenance.sources)
    || provenance.sources.length !== SOURCE_IDS.length) fail("PROVENANCE");
  const values = new Map();
  for (const source of provenance.sources) {
    exactKeys(source, ["observation", "raw", "sourceId"], "PROVENANCE");
    if (!SOURCE_IDS.includes(source.sourceId) || values.has(source.sourceId)) fail("PROVENANCE");
    validateIdentity(source.raw, "RAW"); validateIdentity(source.observation, "OBSERVATION");
    values.set(source.sourceId, source);
  }
  if (values.size !== SOURCE_IDS.length) fail("PROVENANCE");
  return values;
}

function validateProvenance(timetable, stationLine, sources) {
  for (const observation of [timetable, stationLine]) {
    const source = sources.get(observation.sourceId); const date = observation.observedAt?.slice(0, 10)?.replaceAll("-", "");
    const raw = { objectKey: `source-raw/${observation.sourceId}/${date}/${observation.rawSha256}.xlsx`, sizeBytes: observation.rawByteLength, sha256: observation.rawSha256 };
    const expectedObservationKey = `source-observation/${observation.sourceId}/${date}/${observation.recordsSha256}.json`;
    if (!sameJson(source.raw, raw) || source.observation.objectKey !== expectedObservationKey) fail("PROVENANCE");
  }
}

function buildHandoff(bundle, timetableObservation, stationLineObservation) {
  try {
    return buildKricRetainedFilePendingHandoff({
      timetableObservation, timetableReceipt: bundle.receipts?.timetable,
      stationLineObservation, stationLineReceipt: bundle.receipts?.stationLine,
    });
  } catch { fail("HANDOFF"); }
}

function validateReleaseTuple(tuple, provenance, handoff) {
  exactKeys(tuple, ["artifactKind", "decision", "handoffSha256", "provenanceSha256", "releaseEligible", "status"], "RELEASE_TUPLE");
  const expected = canonical({ artifactKind: "kric-retained-file-pending-release-tuple", status: "PENDING", decision: "CONTRACT_GAP", releaseEligible: false, provenanceSha256: sha256(jsonBytes(provenance)), handoffSha256: handoff.handoffSha256 });
  if (!sameJson(tuple, expected)) fail("RELEASE_TUPLE");
}

async function readExact(reader, key, maximumBytes, expectedHash, label) {
  let result; try { result = await reader.readObject(key, { maxResponseBytes: maximumBytes }); } catch { fail(label); }
  if (!result?.exists || !(result.body instanceof Uint8Array) || result.body.byteLength < 1 || result.body.byteLength > maximumBytes
    || sha256(result.body) !== expectedHash) fail(label);
  return Buffer.from(result.body);
}

async function writeOutput(outputDir, result) {
  const target = requiredOutputDirectory(outputDir);
  try {
    await lstat(target);
    fail("OUTPUT_EXISTS");
  } catch (error) {
    if (error?.message?.startsWith("KRIC_RETAINED_FILE_OBSERVATION_READER_")) throw error;
    if (error?.code !== "ENOENT") fail("OUTPUT_DIR");
  }
  const parent = path.dirname(target);
  let physicalParent;
  try { physicalParent = await realpath(parent); } catch { fail("OUTPUT_DIR"); }
  if (physicalParent !== parent) fail("OUTPUT_DIR");
  try { await mkdir(target, { mode: 0o700 }); } catch { fail("OUTPUT_DIR"); }
  await writePrivate(path.join(target, "bundle.json"), result.bundleBytes);
  await writePrivate(path.join(target, "timetable-observation.json"), result.observations.timetable.bytes);
  await writePrivate(path.join(target, "station-line-observation.json"), result.observations.stationLine.bytes);
}

async function writePrivate(target, bytes) {
  let handle; try { handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); await handle.writeFile(bytes); } catch { fail("OUTPUT_WRITE"); } finally { await handle?.close(); }
}

function requiredOutputDirectory(value) {
  if (typeof value !== "string" || !path.isAbsolute(value)) fail("OUTPUT_DIR");
  const resolved = path.resolve(value);
  if (resolved === path.parse(resolved).root) fail("OUTPUT_DIR");
  return resolved;
}
function requiredSha(value, label) {
  if (typeof value !== "string" || !SHA256.test(value)) fail(label);
  return value;
}
function parseJson(bytes, label) {
  try {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!value || typeof value !== "object" || Array.isArray(value)) fail(label);
    return value;
  } catch (error) {
    if (error?.message?.startsWith("KRIC_RETAINED_FILE_OBSERVATION_READER_")) throw error;
    fail(label);
  }
}
function validateIdentity(value, label) { exactKeys(value, ["objectKey", "sha256", "sizeBytes"], label); if (typeof value.objectKey !== "string" || value.objectKey === "" || value.objectKey.startsWith("/") || value.objectKey.includes("..") || !Number.isSafeInteger(value.sizeBytes) || value.sizeBytes < 1 || !SHA256.test(value.sha256)) fail(label); }
function exactKeys(value, keys, label) { if (!value || typeof value !== "object" || Array.isArray(value) || JSON.stringify(Object.keys(value).sort((left, right) => left.localeCompare(right))) !== JSON.stringify([...keys].sort((left, right) => left.localeCompare(right)))) fail(label); }
function sameJson(left, right) { return jsonBytes(left).equals(jsonBytes(right)); }

export function parseKricRetainedFileObservationReaderArgs(argv) {
  const names = ["bundle-sha256", "handoff-sha256", "output-dir"];
  if (argv.length !== names.length * 2) fail("ARGUMENTS");
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]?.slice(2); const value = argv[index + 1];
    if (!argv[index]?.startsWith("--") || !names.includes(name) || name in values || typeof value !== "string" || value.startsWith("--")) fail("ARGUMENTS");
    values[name] = value;
  }
  if (names.some((name) => !(name in values))) fail("ARGUMENTS");
  return values;
}

export function sanitizedObservationReaderError(error) { return typeof error?.message === "string" && error.message.startsWith("KRIC_RETAINED_FILE_OBSERVATION_READER_") ? error.message : "KRIC_RETAINED_FILE_OBSERVATION_READER_FAILED"; }

async function main() {
  const args = parseKricRetainedFileObservationReaderArgs(process.argv.slice(2));
  const result = await readKricRetainedFileObservations({ ...args, bundleSha256: args["bundle-sha256"], handoffSha256: args["handoff-sha256"], outputDir: args["output-dir"], reader: objectStorageClient(process.env) });
  process.stdout.write(`${JSON.stringify({ outputDir: args["output-dir"], observations: 2, status: result.bundle.status, decision: result.bundle.decision })}\n`);
}

if (isMainModule(import.meta.url)) main().catch((error) => { console.error(sanitizedObservationReaderError(error)); process.exitCode = 1; });
