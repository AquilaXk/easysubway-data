import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

function parseArgs(argv) {
  const args = {
    candidates: "tools/datapack/source-candidates.json",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag.startsWith("--")) {
      throw new Error(`unexpected argument: ${flag}`);
    }
    if (!value || value.startsWith("--")) {
      throw new Error(`${flag} requires a value`);
    }
    args[flag.slice(2)] = value;
    index += 1;
  }

  if (!args.candidate) {
    throw new Error("--candidate is required");
  }
  if (!args.sample) {
    throw new Error("--sample is required");
  }

  return args;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function findCredentialLeak(value, pathParts = []) {
  if (typeof value === "string") {
    if (
      /serviceKey=(?!\[서비스키값\])[^&\s]+/i.test(value) ||
      /swopenapi\.seoul\.go\.kr\/api\/subway\/(?!\[서비스키값\]\/)(?!\{serviceKey\}\/)[^/\s<"]+\/json\//i.test(value)
    ) {
      return pathParts.join(".") || "sample";
    }
    return null;
  }

  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const leakPath = findCredentialLeak(item, [...pathParts, String(index)]);
      if (leakPath) {
        return leakPath;
      }
    }
    return null;
  }

  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (/serviceKey/i.test(key) && item !== "[서비스키값]") {
        return [...pathParts, key].join(".");
      }
      const leakPath = findCredentialLeak(item, [...pathParts, key]);
      if (leakPath) {
        return leakPath;
      }
    }
  }

  return null;
}

function renderFieldName(fieldName) {
  return JSON.stringify(fieldName).replace(
    /[\u007f-\u009f\u2028\u2029]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

function validateSample({ candidate, candidateId, sample }) {
  if (sample.candidateId !== candidateId) {
    throw new Error(`sample candidateId mismatch: expected ${candidateId}`);
  }

  if (sample.endpoint !== candidate.evidence.endpoint) {
    throw new Error(`endpoint mismatch: expected ${candidate.evidence.endpoint}`);
  }

  const supportedFormats = new Set(candidate.evidence.formats.map((format) => format.toLowerCase()));
  if (!supportedFormats.has(String(sample.format).toLowerCase())) {
    throw new Error(`format is not supported: ${sample.format}`);
  }

  if (!Array.isArray(sample.fields)) {
    throw new Error("fields must be an array");
  }

  const sampleFields = new Set(sample.fields);
  const missingFields = candidate.evidence.outputFields.filter((field) => !sampleFields.has(field));
  if (missingFields.length > 0) {
    if (findCredentialLeak(sample.fields)) {
      throw new Error("sample field names must not contain credentials");
    }
    const availableFields = [...sampleFields]
      .filter((field) => typeof field === "string")
      .sort((left, right) => left < right ? -1 : Number(left !== right));
    const expectedField = missingFields[0];
    const caseInsensitiveMatches = availableFields.filter(
      (actualField) => actualField.toLowerCase() === expectedField.toLowerCase(),
    );
    if (caseInsensitiveMatches.length === 1) {
      throw new Error(
        `output field case mismatch: expected ${renderFieldName(expectedField)}; actual ${renderFieldName(caseInsensitiveMatches[0])}`,
      );
    }
    throw new Error(
      `output field missing: ${renderFieldName(expectedField)}; available fields: ${availableFields.map(renderFieldName).join(", ")}`,
    );
  }

  const missingEdgeFields = candidate.evidence.missingConfirmedEdgeFields ?? [];
  if (candidate.automaticRouteGraphEdgeAllowed === false && sample.routeGraphEdgeAdmission === "allowed") {
    const suffix =
      missingEdgeFields.length > 0 ? `: ${missingEdgeFields.join(", ")}` : "";
    throw new Error(`route graph edge admission requires confirmed fields${suffix}`);
  }

  const leakPath = findCredentialLeak(sample);
  if (leakPath) {
    throw new Error(`sample evidence must not contain serviceKey credentials: ${leakPath}`);
  }

  validateEvidenceMetadata(sample);
}

function validateEvidenceMetadata(sample) {
  assertSha256(sample.rawSha256, "rawSha256");
  assertSha256(sample.schemaFingerprint, "schemaFingerprint");
  assertSha256(sample.evidenceHash, "evidenceHash");
  if (sample.credentialRedacted !== true) {
    throw new Error("credentialRedacted must be true");
  }
  if (!Array.isArray(sample.providerRecordHashes) || sample.providerRecordHashes.length === 0) {
    throw new Error("providerRecordHashes must be a non-empty array");
  }
  for (const [index, hash] of sample.providerRecordHashes.entries()) {
    assertSha256(hash, `providerRecordHashes.${index}`);
  }
  if (!Number.isInteger(sample.rowCount) || sample.rowCount !== sample.providerRecordHashes.length) {
    throw new Error("rowCount must match providerRecordHashes length");
  }

  const expectedSchemaFingerprint = sha256(JSON.stringify(
    [...sample.fields].sort((left, right) => left < right ? -1 : Number(left !== right)),
  ));
  if (sample.schemaFingerprint !== expectedSchemaFingerprint) {
    throw new Error("schemaFingerprint does not match fields");
  }

  const expectedEvidenceHash = sha256(JSON.stringify({
    candidateId: sample.candidateId,
    endpoint: sample.endpoint,
    format: sample.format,
    fields: sample.fields,
    rowCount: sample.rowCount,
    rawSha256: sample.rawSha256,
    schemaFingerprint: sample.schemaFingerprint,
    credentialRedacted: sample.credentialRedacted,
    providerRecordHashes: sample.providerRecordHashes,
  }));
  if (sample.evidenceHash !== expectedEvidenceHash) {
    throw new Error("evidenceHash does not match sample evidence");
  }
}

function assertSha256(value, label) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${label} must be a sha256 hex string`);
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const candidatesPath = path.resolve(args.candidates);
  const samplePath = path.resolve(args.sample);
  const candidates = await readJson(candidatesPath);
  const sample = await readJson(samplePath);
  const candidate = candidates.candidates.find(({ id }) => id === args.candidate);

  if (!candidate) {
    throw new Error(`unknown source candidate: ${args.candidate}`);
  }

  validateSample({ candidate, candidateId: args.candidate, sample });
  console.log(`source candidate sample evidence valid: ${args.candidate}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
