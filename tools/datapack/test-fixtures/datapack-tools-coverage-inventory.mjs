import { writeFile } from "node:fs/promises";
import path from "node:path";
import { sha256 } from "../../lib/hash.mjs";

export function completeCoverageInventory(targets) {
  const scopes = targets.schemaVersion === 2
    ? targets.activeLineScopes
    : targets.regions.flatMap((region) =>
        region.operatorIds.map((operatorId) => ({ regionId: region.id, operatorId, lineId: null })),
      );
  const regionNames = new Map(targets.regions.map((region) => [region.id, region.displayName]));
  return {
    schemaVersion: 1,
    region: "nationwide",
    artifactKind: "production-source-inventory",
    retrievedAt: "2026-06-22",
    sources: scopes.flatMap((scope) =>
        targets.requiredSourceDomains.map((domain) => ({
          id: `${scope.regionId}-${scope.operatorId}-${scope.lineId ?? "operator"}-${domain.id}`,
          displayName: `${regionNames.get(scope.regionId)} ${scope.operatorId} ${scope.lineId ?? "operator"} ${domain.id}`,
          owner: "테스트 운영기관",
          provider: "테스트 운영기관",
          providerDepartment: "테스트",
          sourceSystem: "테스트",
          datasetUrl: `https://example.invalid/${scope.regionId}/${scope.operatorId}/${scope.lineId ?? "operator"}/${domain.id}`,
          datasetKind: "fixture-only",
          coverageScope: {
            regionIds: [scope.regionId],
            operatorIds: [scope.operatorId],
            ...(scope.lineId ? { lineIds: [scope.lineId] } : {}),
            sourceDomains: [domain.id],
          },
          requiredForProductionPack: true,
          updateFrequency: "daily",
          observedDataUpdatedAt: "2026-06-22",
          retrievedAt: "2026-06-22",
          license: {
            type: "KOGL-1",
            name: "공공누리 1유형",
            attribution: "테스트",
            commercialUseAllowed: true,
            derivativeWorkAllowed: true,
            redistributionAllowed: true,
            evidenceUrl: "https://example.invalid/license",
          },
          capabilities: sourceCapabilityFixture(domain.id),
          fieldsProvided: domain.requiredFields,
        })),
    ),
  };
}

function sourceCapabilityFixture(domainId) {
  const supportedFacility = domainId === "accessibility_facilities";
  const realtimeCandidate = domainId === "realtime_arrivals";
  const updateFrequency = "daily";
  return {
    schedule: {
      status: "UNSUPPORTED",
      productionUseAllowed: false,
      coverageStatus: "NOT_PROVIDED_BY_SOURCE",
      updateFrequency,
      unsupportedNotes: "fixture source does not provide scheduled timetable data",
    },
    realtime: realtimeCandidate
      ? {
          status: "CANDIDATE",
          productionUseAllowed: false,
          liveEtaEligible: false,
          rateLimitStatus: "BLOCKED_PENDING_PROVIDER_TERMS_OR_QUOTA",
          coverageStatus: "SOURCE_INVENTORY_COVERED",
          updateFrequency,
          unsupportedNotes: "fixture realtime source is not approved for production live ETA",
        }
      : {
          status: "UNSUPPORTED",
          productionUseAllowed: false,
          liveEtaEligible: false,
          rateLimitStatus: "NOT_APPLICABLE",
          coverageStatus: "NOT_PROVIDED_BY_SOURCE",
          updateFrequency,
          unsupportedNotes: "fixture source does not provide realtime arrival data",
        },
    facility: supportedFacility
      ? {
          status: "SUPPORTED",
          productionUseAllowed: true,
          coverageStatus: "SOURCE_INVENTORY_COVERED",
          updateFrequency,
          unsupportedNotes: "fixture source supports official accessibility facility evidence only",
        }
      : {
          status: "UNSUPPORTED",
          productionUseAllowed: false,
          coverageStatus: "NOT_PROVIDED_BY_SOURCE",
          updateFrequency,
          unsupportedNotes: "fixture source does not provide accessibility facility records",
        },
  };
}

export function completeCoverageProvenance(inventory) {
  return {
    schemaVersion: 1,
    artifactKind: "datapack-field-provenance",
    manifestSha256: "a".repeat(64),
    packs: [
      {
        id: "nationwide",
        version: "1",
        artifactKind: "production",
        sqliteSha256: "b".repeat(64),
        records: inventory.sources.flatMap((source) =>
          source.fieldsProvided.map((field) => ({
            entityType: "source-field",
            entityId: `${source.id}:${field}`,
            field,
            sourceId: source.id,
            coverageScope: source.coverageScope,
            derivationKind: "OFFICIAL",
            verifiedAt: "2026-06-22T00:00:00.000Z",
          })),
        ),
      },
    ],
  };
}

export async function writeCoverageCandidate(outputDir, provenance) {
  const packs = provenance.packs.map(({ id, version, artifactKind, sqliteSha256 }) => ({
    id,
    version,
    artifactKind,
    sqliteSha256,
  }));
  const manifestJson = `${JSON.stringify({
    activePack: { id: packs[0].id, version: packs[0].version },
    packs,
  }, null, 2)}\n`;
  provenance.manifestSha256 = sha256(Buffer.from(manifestJson));
  await writeFile(path.join(outputDir, "current.json"), manifestJson);
  await writeFile(
    path.join(outputDir, "current.provenance.json"),
    `${JSON.stringify(provenance, null, 2)}\n`,
  );
}
