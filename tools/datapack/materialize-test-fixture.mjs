const ITX_REFERENCE = "ITX_";

function rejectItxReference(value, path = "fixture") {
  if (typeof value === "string") {
    if (value.startsWith(ITX_REFERENCE)) {
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
  if (legacyEvidence?.serviceClass !== "ITX_CHEONGCHUN") {
    throw new Error("capital@1 legacy routeServiceArtifactEvidence must be ITX_CHEONGCHUN");
  }
  delete pack.routeServiceArtifactEvidence;
  rejectItxReference(pack, "capital@1");
  return fixture;
}
