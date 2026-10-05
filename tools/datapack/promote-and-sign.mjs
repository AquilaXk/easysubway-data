import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { canonicalJson, withoutSignature, sha256 } from "./lib/manifest-validation.mjs";
import { rsaSha256Signature, signingPrivateKey } from "./lib/manifest-signing.mjs";

function fixtureSignaturePayload(pack) {
  return `${pack.id}:${pack.version}:${pack.sha256}:${pack.sqliteSha256}:${pack.sizeBytes}`;
}

function canonicalProductionPackUrl(packUrl) {
  return new URL(packUrl).toString();
}

function productionSignaturePayload(pack) {
  return `${fixtureSignaturePayload(pack)}:${canonicalProductionPackUrl(pack.url)}`;
}

function canonicalRepresentativeRouteRegressions(routes) {
  return (routes ?? []).map((route) => ({
    id: route.id,
    pattern: route.pattern,
    fromNodeId: route.fromNodeId,
    toNodeId: route.toNodeId,
    requiredEdgeIds: route.requiredEdgeIds.map((edgeId) => edgeId),
  }));
}

function representativeRouteRegressionSignaturePayload(pack) {
  const basePayload = `${fixtureSignaturePayload(pack)}:${JSON.stringify(canonicalRepresentativeRouteRegressions(pack.representativeRouteRegressions))}`;
  return `${basePayload}:${canonicalProductionPackUrl(pack.url)}`;
}

async function promoteAndSign() {
  const signingKey = signingPrivateKey();
  const currentPath = path.resolve("artifacts/datapack/current.json");
  const currentProvenancePath = path.resolve("artifacts/datapack/current.provenance.json");

  const manifest = JSON.parse(await readFile(currentPath, "utf8"));
  manifest.channel = "production";
  manifest.keyId = "production-v1";

  for (const pack of manifest.packs) {
    pack.artifactKind = "production";
    pack.signature = {
      algorithm: "rsa-sha256-pack-manifest-v2",
      value: rsaSha256Signature(signingKey, productionSignaturePayload(pack)),
    };
    if (pack.representativeRouteRegressions) {
      pack.representativeRouteRegressionSignature = {
        algorithm: "rsa-sha256-route-regression-v1",
        value: rsaSha256Signature(signingKey, representativeRouteRegressionSignaturePayload(pack)),
      };
    }
  }

  manifest.signature = {
    algorithm: "rsa-sha256-manifest-v2",
    value: rsaSha256Signature(signingKey, canonicalJson(withoutSignature(manifest))),
  };

  const currentJsonContent = JSON.stringify(manifest, null, 2) + "\n";
  await writeFile(currentPath, currentJsonContent, "utf8");
  const newManifestSha256 = sha256(Buffer.from(currentJsonContent));

  const provenance = JSON.parse(await readFile(currentProvenancePath, "utf8"));
  provenance.manifestSha256 = newManifestSha256;
  for (const pack of provenance.packs ?? []) {
    pack.artifactKind = "production";
  }
  await writeFile(currentProvenancePath, JSON.stringify(provenance, null, 2) + "\n", "utf8");

  console.log("Promoted and signed production artifacts successfully.");
  console.log("New manifestSha256:", newManifestSha256);
}

promoteAndSign().catch((error) => {
  console.error(`promote-and-sign failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
