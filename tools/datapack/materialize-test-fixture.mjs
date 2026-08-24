import { createHash } from "node:crypto";

const ITX_TOKEN = /(?:^|[^A-Z0-9])ITX(?:[_-]|$)/;
const MOLIT_SOURCE_ID = "molit-urban-rail-full-route";
const LEGACY_ROUTE_SERVICE_ARTIFACT_EVIDENCE = Object.freeze({
  serviceClass: "ITX_CHEONGCHUN",
  timetableArtifactId: "itx-cheongchun-completeness-admission-20260714T083544292Z",
  timetableArtifactSha256: "347aec507ec951dde65c10a1c4bff9f94454f762d76a5a74064a40662008336c",
  canonicalPackId: "capital",
  canonicalPackSha256: "580814a58ce8d94b174de1ca8753ef7f350ce806dd793f6a7f43e07e7aa155b9",
  canonicalPackSqliteSha256: "72b85f941a8cb3a905218287a3e2ff4ce38561397ed5c22d77816576529ffe03",
  admissionStatus: "MISSING",
  admissionEligible: false,
  freshUntil: "2026-07-20T00:00:00.000Z",
  sourceIssue: 2116,
});

function rejectItxReference(value, path = "fixture") {
  if (typeof value === "string") {
    const token = value.toUpperCase();
    if (ITX_TOKEN.test(token)) {
      throw new Error(`${path} contains an unexpected ITX reference`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => rejectItxReference(entry, `${path}[${index}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      rejectItxReference(entry, `${path}.${key}`);
    }
  }
}

/**
 * Historical regional materializer tests consume a copied MOLIT CSV and a
 * historical clock.  Keep that fixture self-contained: it must not inherit
 * a newer source-only candidate's active inventory lineage.
 */
export function projectHistoricalMolitMembershipInventory(input, rawBytes, verifiedAt) {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || !Array.isArray(input.sources) || !Buffer.isBuffer(rawBytes)
    || !Number.isFinite(verifiedAt?.getTime?.())) {
    throw new Error("historical MOLIT membership fixture is invalid");
  }
  const inventory = structuredClone(input);
  const rawSources = inventory.sources.filter(({ id }) => id === MOLIT_SOURCE_ID);
  if (rawSources.length !== 1 || !rawSources[0]?.admissionEvidence
    || typeof rawSources[0].admissionEvidence !== "object") {
    throw new Error("historical MOLIT membership fixture is invalid");
  }
  const memberships = inventory.sources.filter(({ membershipAdmissionEvidence }) =>
    membershipAdmissionEvidence?.membershipSourceId === MOLIT_SOURCE_ID);
  if (memberships.length === 0 || memberships.some(({ membershipAdmissionEvidence }) =>
    !membershipAdmissionEvidence || typeof membershipAdmissionEvidence !== "object")) {
    throw new Error("historical MOLIT membership fixture is invalid");
  }

  const rawSha256 = createHash("sha256").update(rawBytes).digest("hex");
  const verifiedAtIso = verifiedAt.toISOString();
  rawSources[0].admissionEvidence.rawSha256 = rawSha256;
  for (const source of memberships) {
    source.membershipAdmissionEvidence = {
      ...source.membershipAdmissionEvidence,
      membershipSourceRawSha256: rawSha256,
      membershipSourceSnapshotSha256: rawSha256,
      verifiedAt: verifiedAtIso,
    };
  }
  return inventory;
}

/**
 * Produces the sole test-only materializer projection: current capital@1 as-is,
 * or historical capital@1 without its exact legacy route-service evidence.
 * Timetable/topology rows are never filtered.
 */
export function projectRegionalMaterializeFixture(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("fixture root must be an object");
  }
  const rootKeys = Object.keys(input);
  if (rootKeys.length !== 2 || !rootKeys.includes("manifest") || !rootKeys.includes("packs")) {
    throw new Error("fixture root must contain exactly manifest and packs");
  }
  const fixture = structuredClone(input);
  if (fixture.manifest?.activePack?.id !== "capital" || fixture.manifest?.activePack?.version !== "1") {
    throw new Error("fixture must have active capital@1 manifest pack");
  }
  if (!Array.isArray(fixture.packs) || fixture.packs.length !== 1) {
    throw new Error("fixture must contain exactly one capital@1 pack");
  }

  const [pack] = fixture.packs;
  if (pack.id !== "capital" || pack.version !== "1" || pack.artifactKind !== "production") {
    throw new Error("fixture must contain exactly one capital@1 pack");
  }
  if (!Array.isArray(pack.routeServiceArtifactEvidence)
    || pack.routeServiceArtifactEvidence.length > 1) {
    throw new Error("capital@1 must contain zero current or exactly one legacy routeServiceArtifactEvidence");
  }

  if (pack.routeServiceArtifactEvidence.length === 1) {
    const [legacyEvidence] = pack.routeServiceArtifactEvidence;
    if (JSON.stringify(legacyEvidence) !== JSON.stringify(LEGACY_ROUTE_SERVICE_ARTIFACT_EVIDENCE)) {
      throw new Error("capital@1 legacy routeServiceArtifactEvidence must match the exact known contract");
    }
    delete pack.routeServiceArtifactEvidence;
  }
  rejectItxReference(fixture, "fixture");
  return fixture;
}
