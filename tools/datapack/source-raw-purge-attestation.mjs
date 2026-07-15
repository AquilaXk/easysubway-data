import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
} from "node:crypto";

const ALGORITHM = "Ed25519";

export function assertPurgeAttestationPrivateKey(privateKeyText) {
  const key = createPrivateKey(privateKeyText);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("purge attestation key must be Ed25519");
  return key;
}

export function attachPurgeAttestation(report, {
  privateKey,
  ledgerText,
  snapshotText,
  policyBindings,
}) {
  const publicKey = createPublicKey(privateKey);
  report.attestation = {
    schemaVersion: 1,
    algorithm: ALGORITHM,
    ledgerSha256: sha256(ledgerText),
    snapshotEvidenceSha256: sha256(snapshotText),
    policyBindings: normalizedPolicyBindings(policyBindings),
    publicKeySha256: publicKeyFingerprint(publicKey),
  };
  report.attestation.signature = sign(
    null,
    Buffer.from(attestationPayload(report)),
    privateKey,
  ).toString("base64");
}

export function verifyPurgeAttestation(report, {
  journalText,
  ledgerText,
  snapshotText,
  governancePolicyVersion,
  governancePolicySha256,
  publicKeyText,
  trustedPublicKeySha256,
}) {
  if (typeof journalText !== "string"
    || typeof ledgerText !== "string"
    || typeof snapshotText !== "string"
    || typeof publicKeyText !== "string") {
    throw new Error("SOURCE_FRESHNESS_DERIVATION_MISMATCH: purge attestation inputs");
  }
  const publicKey = createPublicKey(publicKeyText);
  if (!/^[0-9a-f]{64}$/.test(trustedPublicKeySha256 ?? "")
    || publicKeyFingerprint(publicKey) !== trustedPublicKeySha256) {
    throw new Error("SOURCE_FRESHNESS_DERIVATION_MISMATCH: trusted purge attestation key");
  }
  const attestation = report?.attestation;
  const policyBindings = normalizedPolicyBindings(attestation?.policyBindings);
  if (attestation?.schemaVersion !== 1
    || attestation.algorithm !== ALGORITHM
    || attestation.ledgerSha256 !== sha256(ledgerText)
    || attestation.snapshotEvidenceSha256 !== sha256(snapshotText)
    || attestation.publicKeySha256 !== publicKeyFingerprint(publicKey)
    || !policyBindings.some((binding) => (
      binding.policyVersion === governancePolicyVersion
      && binding.policySha256 === governancePolicySha256
    ))
    || typeof attestation.signature !== "string"
    || !verify(
      null,
      Buffer.from(attestationPayload(report)),
      publicKey,
      Buffer.from(attestation.signature, "base64"),
    )) {
    throw new Error("SOURCE_FRESHNESS_DERIVATION_MISMATCH: purge attestation");
  }
  verifyPurgeJournal(report, journalText);
}

export function purgeReportSha256(report) {
  return sha256(JSON.stringify({ ...report, reportSha256: undefined }));
}

function attestationPayload(report) {
  return JSON.stringify({
    ...report,
    reportSha256: undefined,
    attestation: { ...report.attestation, signature: undefined },
  });
}

function verifyPurgeJournal(report, journalText) {
  if (report.auditJournalSha256 !== sha256(journalText)) {
    throw new Error("SOURCE_FRESHNESS_DERIVATION_MISMATCH: purge journal hash");
  }
  const lines = journalText.endsWith("\n") ? journalText.slice(0, -1).split("\n") : [];
  if (lines.length !== report.auditJournalRecordCount || lines.length === 0) {
    throw new Error("SOURCE_FRESHNESS_DERIVATION_MISMATCH: purge journal record count");
  }
  let records;
  try {
    records = lines.map((line) => JSON.parse(line));
  } catch {
    throw new Error("SOURCE_FRESHNESS_DERIVATION_MISMATCH: purge journal JSON");
  }
  const expected = new Map();
  addExpectedResults(expected, report.deleted, new Set(["DELETED"]));
  addExpectedResults(expected, report.alreadyAbsent, new Set(["ALREADY_ABSENT"]));
  addExpectedResults(expected, report.failed, new Set(["FAILED", "AUTHORIZATION_FAILED", "AUDIT_WRITE_FAILED"]));
  const planCandidates = records[0]?.deleteCandidates;
  const planKeys = Array.isArray(planCandidates) ? planCandidates.map(journalItemKey) : [];
  if (records[0]?.event !== "PLAN"
    || records[0].evaluatedAt !== report.evaluatedAt
    || records[0].dryRun !== report.dryRun
    || planKeys.some((key) => key == null)
    || new Set(planKeys).size !== planKeys.length
    || planKeys.length !== expected.size
    || planKeys.some((key) => !expected.has(key))) {
    throw new Error("SOURCE_FRESHNESS_DERIVATION_MISMATCH: purge journal plan");
  }
  const intents = new Set();
  const results = new Map();
  for (const record of records.slice(1)) {
    const key = journalItemKey(record.item);
    if (record.evaluatedAt !== report.evaluatedAt || key == null) {
      throw new Error("SOURCE_FRESHNESS_DERIVATION_MISMATCH: purge journal item");
    }
    if (record.event === "DELETE_INTENT") {
      if (!expected.has(key) || intents.has(key) || results.has(key)) {
        throw new Error("SOURCE_FRESHNESS_DERIVATION_MISMATCH: purge journal sequence");
      }
      intents.add(key);
    } else if (record.event === "DELETE_RESULT") {
      if (results.has(key)) throw new Error("SOURCE_FRESHNESS_DERIVATION_MISMATCH: purge journal sequence");
      results.set(key, record.outcome);
    } else {
      throw new Error("SOURCE_FRESHNESS_DERIVATION_MISMATCH: purge journal event");
    }
  }
  if (results.size !== expected.size) {
    throw new Error("SOURCE_FRESHNESS_DERIVATION_MISMATCH: purge journal result set");
  }
  if ([...intents].some((key) => !results.has(key))) {
    throw new Error("SOURCE_FRESHNESS_DERIVATION_MISMATCH: purge journal sequence");
  }
  for (const [key, outcomes] of expected) {
    const outcome = results.get(key);
    const intentRequired = outcome === "DELETED" || outcome === "AUDIT_WRITE_FAILED";
    if (!outcomes.has(outcome)
      || (intentRequired && !intents.has(key))) {
      throw new Error("SOURCE_FRESHNESS_DERIVATION_MISMATCH: purge journal result");
    }
  }
}

function addExpectedResults(target, entries, outcomes) {
  for (const entry of entries ?? []) {
    const key = journalItemKey(entry);
    if (key == null || target.has(key)) {
      throw new Error("SOURCE_FRESHNESS_DERIVATION_MISMATCH: purge journal result set");
    }
    target.set(key, outcomes);
  }
}

function journalItemKey(item) {
  if (typeof item?.sourceId !== "string"
    || typeof item?.snapshotId !== "string"
    || !/^[0-9a-f]{64}$/.test(item?.rawSha256 ?? "")) return null;
  return `${item.sourceId}\0${item.snapshotId}\0${item.rawSha256}`;
}

function normalizedPolicyBindings(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("SOURCE_FRESHNESS_DERIVATION_MISMATCH: purge attestation policy bindings");
  }
  const bindings = value.map((binding) => {
    if (typeof binding?.policyVersion !== "string"
      || !/^[0-9a-f]{64}$/.test(binding?.policySha256 ?? "")) {
      throw new Error("SOURCE_FRESHNESS_DERIVATION_MISMATCH: purge attestation policy bindings");
    }
    return { policyVersion: binding.policyVersion, policySha256: binding.policySha256 };
  }).sort((left, right) => (
    left.policyVersion.localeCompare(right.policyVersion)
    || left.policySha256.localeCompare(right.policySha256)
  ));
  if (new Set(bindings.map((binding) => `${binding.policyVersion}:${binding.policySha256}`)).size !== bindings.length) {
    throw new Error("SOURCE_FRESHNESS_DERIVATION_MISMATCH: purge attestation policy bindings");
  }
  return bindings;
}

function publicKeyFingerprint(publicKey) {
  return sha256(publicKey.export({ type: "spki", format: "der" }));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
