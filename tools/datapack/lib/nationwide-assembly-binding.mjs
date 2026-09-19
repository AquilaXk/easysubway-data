import { createHash } from "node:crypto";

const SHA256 = /^[a-f0-9]{64}$/u;

export function buildNationwideAssemblyInputs({
  baseFixtureBytes,
  selectedSources,
  auxiliaryInputs,
} = {}) {
  const selectedSourceHeads = normalizeSelectedSourceHeads(selectedSources, "selectedSources");
  const inputHashes = normalizeAuxiliaryInputs(auxiliaryInputs);
  return {
    schemaVersion: 1,
    baseFixtureSha256: sha256(requiredBytes(baseFixtureBytes, "baseFixtureBytes")),
    selectedSourceHeads,
    inputHashes,
  };
}

export function assertNationwideAssemblyInputs({
  assemblyInputs,
  expectedSourceIds,
  selectedSources,
} = {}) {
  const expected = normalizeSourceIds(expectedSourceIds, "expectedSourceIds");
  const assembly = normalizeAssemblyInputs(assemblyInputs);
  const supplied = normalizeSelectedSourceHeads(selectedSources, "selectedSources");
  if (JSON.stringify(assembly.selectedSourceHeads.map(({ sourceId }) => sourceId)) !== JSON.stringify(expected)) {
    throw new Error("nationwide assembly expected source roster mismatch");
  }
  const suppliedBySourceId = new Map(supplied.map((entry) => [entry.sourceId, entry]));
  for (const entry of assembly.selectedSourceHeads) {
    const selected = suppliedBySourceId.get(entry.sourceId);
    if (!selected || JSON.stringify(selected) !== JSON.stringify(entry)) {
      throw new Error(`nationwide assembly selected source tuple mismatch: ${entry.sourceId}`);
    }
  }
  return assemblyInputs;
}

function normalizeAssemblyInputs(value) {
  if (!isRecord(value) || value.schemaVersion !== 1 || !SHA256.test(value.baseFixtureSha256 ?? "")) {
    throw new Error("nationwide assembly inputs are invalid");
  }
  const selectedSourceHeads = normalizeSelectedSourceHeads(value.selectedSourceHeads, "assembly selectedSourceHeads");
  if (JSON.stringify(value.selectedSourceHeads) !== JSON.stringify(selectedSourceHeads)) {
    throw new Error("nationwide assembly selectedSourceHeads are not sorted");
  }
  const inputHashes = normalizeInputHashes(value.inputHashes);
  if (JSON.stringify(value.inputHashes) !== JSON.stringify(inputHashes)) {
    throw new Error("nationwide assembly inputHashes are not sorted");
  }
  return { selectedSourceHeads, inputHashes };
}

function normalizeSelectedSourceHeads(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must contain selected source heads`);
  }
  const entries = value.map((entry) => {
    if (!isRecord(entry)) throw new Error(`${label} entry is invalid`);
    const sourceId = requiredName(entry.sourceId, `${label}.sourceId`);
    const snapshotId = requiredName(entry.snapshotId, `${label}.snapshotId`);
    const rawSha256 = requiredHash(entry.rawSha256, `${label}.rawSha256`);
    const freshnessExpiresAt = requiredInstant(entry.freshnessExpiresAt, `${label}.freshnessExpiresAt`);
    return { sourceId, snapshotId, rawSha256, freshnessExpiresAt };
  }).sort(compareSourceHeads);
  if (new Set(entries.map(({ sourceId }) => sourceId)).size !== entries.length) {
    throw new Error(`${label} sourceId values must be unique`);
  }
  return entries;
}

function normalizeAuxiliaryInputs(value) {
  if (!isRecord(value)) throw new Error("auxiliaryInputs must be an object");
  return Object.fromEntries(Object.entries(value)
    .map(([name, bytes]) => [requiredName(name, "auxiliary input name"), sha256(requiredBytes(bytes, name))])
    .sort(([left], [right]) => compareText(left, right)));
}

function normalizeInputHashes(value) {
  if (!isRecord(value)) throw new Error("nationwide assembly inputHashes are invalid");
  return Object.fromEntries(Object.entries(value)
    .map(([name, hash]) => [requiredName(name, "assembly input hash name"), requiredHash(hash, name)])
    .sort(([left], [right]) => compareText(left, right)));
}

function normalizeSourceIds(value, label) {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${label} must be nonempty`);
  const ids = value.map((sourceId) => requiredName(sourceId, label)).sort(compareText);
  if (new Set(ids).size !== ids.length) throw new Error(`${label} values must be unique`);
  return ids;
}

function requiredName(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} is invalid`);
  return value;
}

function requiredHash(value, label) {
  if (typeof value !== "string" || !SHA256.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function requiredInstant(value, label) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function requiredBytes(value, label) {
  if (!(Buffer.isBuffer(value) || value instanceof Uint8Array)) throw new Error(`${label} must be bytes`);
  return value;
}

function compareSourceHeads(left, right) {
  return compareText(left.sourceId, right.sourceId);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
