const ITX_TOKEN = /(?:^|[^A-Z0-9])ITX(?:[_-]|$)/;
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
 * Produces the sole test-only materializer projection: capital@1 without its
 * historical route-service evidence. Timetable/topology rows are never filtered.
 */
export function projectRegionalMaterializeFixture(input) {
  const fixture = structuredClone(input);
  if (!Array.isArray(fixture.packs) || fixture.packs.length !== 1) {
    throw new Error("fixture must contain exactly one capital@1 pack");
  }

  const [pack] = fixture.packs;
  if (pack.id !== "capital" || pack.version !== "1") {
    throw new Error("fixture must contain exactly one capital@1 pack");
  }
  if (!Array.isArray(pack.routeServiceArtifactEvidence) || pack.routeServiceArtifactEvidence.length !== 1) {
    throw new Error("capital@1 must contain exactly one legacy routeServiceArtifactEvidence");
  }

  const [legacyEvidence] = pack.routeServiceArtifactEvidence;
  if (
    !legacyEvidence ||
    JSON.stringify(legacyEvidence) !== JSON.stringify(LEGACY_ROUTE_SERVICE_ARTIFACT_EVIDENCE)
  ) {
    throw new Error("capital@1 legacy routeServiceArtifactEvidence must match the exact known contract");
  }
  delete pack.routeServiceArtifactEvidence;
  rejectItxReference(pack, "capital@1");
  return fixture;
}
