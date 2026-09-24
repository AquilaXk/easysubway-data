import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { canonicalJson, withoutSignature, sha256 } from "./lib/manifest-validation.mjs";
import { rsaSha256Signature } from "./lib/manifest-signing.mjs";

const testPrivateKeyPem = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCK00Egf8XIduo4
1d7/Pws3NZ6ziuHe94jj/xFjvqtvuidqYD5YOgmW8XK8Eb6KEE6Xsu2BbWtXniEI
sfP3lUUuabTbz62WX1OEPNKzcG73JyEQP6bS+fLXq0rxmAHqB/uwmSMYEmfwwsNq
JVahW8PlMSO/jfd/+8wUiWN01QpkLZd/SodiVi/Xx0DBskcp46yYmSTLXcc1WfjQ
e4SfkVYQm8UjmqpWCkn6TVXeKnf2Brb4STlI5UcAvpTjjKmNJdSOjs0IpWm5BHA3
uECe+Vi61cN2sRDo5reJS1tAkiCSX5mZPA2RgcIQiF39ksH2f8QQd2/IkCZQoK0A
otfkU5r3AgMBAAECggEAERi5MY5qxihW6g70uoyCDheNZuEYtgPYGPQFqToHFOhh
CEm4A9eJ7MvpbF3nEEu30hjYBRN7n7u6p756pCf+8BtWiaeG4jj1KRjwfea/07I+
8ShVnC/qB0NyJFSrD65SAcqqNsG1iUIDHORiSdbqRiSKGYIbU+inlnPhCrdd4z5H
tLZtN/IZD5YfgJbPU7ADW1VPAIEaCLNcfmBS1NfML9DLuAmHZxfvoXI9oSEYvUOc
YCIF4mNkwmpJCylP8mADNhyHNj+7r5SKijhfTRL7xeHJxa4F8ctM3UAg7zpG6Njk
F5hDukO/GvsqQi+EqPp0sJfrdDTxyZ2zwtI8FPXKWQKBgQC/XM7IBSAoJgAF60PV
1oiqP6lzT4ydVGXkqtESHxx70TnpwMnU2aRlOu61SBHWxqvFhRId8WFko2/rKYtM
hbZ/TTlBHtsu5YiwE4BZcwU+kTp3sZCHOtD1G9aOk63Qz9mVqXBVlJEeNv9C6KGA
0fsU5exJyzLjxsEFprbRY7fWJQKBgQC5t4Y/nzUL7EsEcxRFB+Lr6VRbb/N3RzOK
j4QoDZ2UAN2bCNKQgpqmcLY7O+XB4BRhhQdGVs79LDSjp3huY5QTf7N0aro2ybT3
h5BBFFiPPWGUS5651aFU6vdxMBrEkzzPnhPeOUkHGwaTmdmY7HfRKrbrHbx6oX0H
aPTo3wG76wKBgEmHgbT9szN6FnwvwCsEehLgz12NbXxul5BbymXqKmmxJU2aVHND
BZYYJOznOmOKhyooTaPPwhqHalOz7OCEaHFV3PAWySWl8PWnKKQ2PAekihC/28b6
ZJwqDDFQsXMQyoxlRNK9eV1gyIiPFq+G/7Ex/68DMxSupDBltM2UQWk5AoGASkmO
Cs79YhqP22TI+9/utl0sIDNE2TaC+G719yuTF8vM2SILUEDd6av2SPVpr0aaAHQ8
97brrzvKhpgLxWRRrAcN2oiCmj3PBKCWZGHmFs3/xVkGUeGRWi1u8zjBzFX1Ijti
SSby/kOiOtJ0xwX325RRfPT1GryUDa2/IZNq1ycCgYEAo/3pD6aluZrJAJYb5WqY
zvnAVLCVuMUi2zkCNQr9v5L/jW/f3ZQ4ojV5WYCNLE5wcEBwDle0xuUyCN6mQ6sd
o35vd3fdGgjXdRONSb0iXcqjem8PNsDixTRtlmr2iVW54/AdUz3ME40/osRFW+nQ
xdXms0N7qyLs62EdiaOxJy8=
-----END PRIVATE KEY-----`;

export const testPublicKeyPem = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAitNBIH/FyHbqONXe/z8L
NzWes4rh3veI4/8RY76rb7onamA+WDoJlvFyvBG+ihBOl7LtgW1rV54hCLHz95VF
Lmm028+tll9ThDzSs3Bu9ychED+m0vny16tK8ZgB6gf7sJkjGBJn8MLDaiVWoVvD
5TEjv433f/vMFIljdNUKZC2Xf0qHYlYv18dAwbJHKeOsmJkky13HNVn40HuEn5FW
EJvFI5qqVgpJ+k1V3ip39ga2+Ek5SOVHAL6U44ypjSXUjo7NCKVpuQRwN7hAnvlY
utXDdrEQ6Oa3iUtbQJIgkl+ZmTwNkYHCEIhd/ZLB9n/EEHdvyJAmUKCtAKLX5FOa
9wIDAQAB
-----END PUBLIC KEY-----`;

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
  const currentPath = path.resolve("artifacts/datapack/current.json");
  const currentProvenancePath = path.resolve("artifacts/datapack/current.provenance.json");

  const manifest = JSON.parse(await readFile(currentPath, "utf8"));
  manifest.channel = "production";
  manifest.keyId = "production-v1";

  const signingKey = process.env.EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM || testPrivateKeyPem;

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

promoteAndSign();
