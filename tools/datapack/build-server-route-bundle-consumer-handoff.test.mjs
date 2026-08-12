import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createSign, generateKeyPairSync } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildServerRouteBundleConsumerHandoff,
  canonicalServerRouteBundleConsumerHandoffJson,
  validateServerRouteBundleConsumerHandoff,
} from "./build-server-route-bundle-consumer-handoff.mjs";
import {
  buildServerRouteBundlePublicationDescriptor,
  canonicalServerRouteBundlePublicationDescriptorJson,
  validateServerRouteBundlePublicationDescriptor,
} from "./build-server-route-bundle-publication-descriptor.mjs";
import {
  canonicalJson,
  sha256,
} from "./lib/manifest-validation.mjs";
import {
  buildServerRouteBundleFinal,
  canonicalServerRouteBundleFinalJson,
} from "./lib/server-route-bundle-final.mjs";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = path.join(REPOSITORY_ROOT, "tools/datapack/build-server-route-bundle-consumer-handoff.mjs");
const DESCRIPTOR_SCRIPT = path.join(
  REPOSITORY_ROOT,
  "tools/datapack/build-server-route-bundle-publication-descriptor.mjs",
);
const REPOSITORY_GIT_SHA = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: REPOSITORY_ROOT,
  encoding: "utf8",
}).trim();
const PUBLIC_BASE_URL = "https://objectstorage.ap-seoul-1.oraclecloud.com/n/example/b/easysubway/o";
const ACTIVE_FROM = "2099-01-01T00:00:00.000+09:00";
const FRESH_UNTIL = "2099-02-01T00:00:00.000+09:00";
const NOW = Date.parse("2099-01-02T00:00:00.000+09:00");
const keyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKey = keyPair.privateKey.export({ type: "pkcs8", format: "pem" });
const publicKey = keyPair.publicKey.export({ type: "spki", format: "pem" });
process.env.EASYSUBWAY_DATAPACK_SIGNING_KEY_ID = "production-v1";
process.env.EASYSUBWAY_DATAPACK_SIGNING_PUBLIC_KEY_PEM = publicKey;
const COMPONENTS = ["accessibility", "fare", "timetable", "topology"];
const SIGNED_PATHS = [
  "compatibility.json",
  "manifest.json",
  "manifest.signing-input.json",
  ...COMPONENTS.map((component) => `payload/${component}.sqlite.zst`),
  "provenance.json",
].sort(bytewise);
let rejectedSequence = 0;

test("malformed handoff CLI는 stack trace 없이 fail closed한다", () => {
  const result = spawnSync(process.execPath, [SCRIPT, "--artifact-root"], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(
    result.stderr,
    "build-server-route-bundle-consumer-handoff: invalid argument near --artifact-root\n",
  );
});

test("GO FINAL과 OCI receipt를 closed Backend/Platform handoff로 결속한다", async (t) => {
  const fixture = await createFixture(t);
  const firstOutput = path.join(fixture.root, "handoff-first.json");
  const secondOutput = path.join(fixture.root, "handoff-second.json");

  const handoff = await buildServerRouteBundleConsumerHandoff({
    ...fixture.input,
    output: firstOutput,
    clock: () => NOW,
  });
  await buildServerRouteBundleConsumerHandoff({
    ...fixture.input,
    output: secondOutput,
    clock: () => NOW,
  });

  assert.equal(handoff.schemaVersion, 1);
  assert.equal(handoff.artifactKind, "server-route-bundle-consumer-handoff");
  assert.deepEqual(handoff.manifest, fixture.manifest);
  assert.equal(handoff.sourceSnapshotSetHash, fixture.final.candidate.sourceSnapshotSetHash);
  assert.deepEqual(handoff.publicationReceipt, fixture.receipt);
  assert.deepEqual(handoff.release, {
    finalRawSha256: sha256(fixture.finalBytes),
    finalSha256: fixture.final.finalSha256,
    promotionEvidenceSha256: sha256(fixture.promotionRequestBytes),
    publicationReceiptRawSha256: sha256(fixture.receiptBytes),
    publicationReceiptSha256: fixture.receipt.receiptSha256,
    result: "GO",
  });
  assert.deepEqual(handoff.backendAdmission, {
    finalEvidenceReference: `sha256:${sha256(fixture.finalBytes)}`,
    immutablePublicationReceiptIdentity: `sha256:${sha256(fixture.receiptBytes)}`,
    manifestSha256: sha256(fixture.manifestBytes),
    promotionEvidenceReference: `sha256:${sha256(fixture.promotionRequestBytes)}`,
  });
  assert.deepEqual(handoff.platformRelease, {
    serverRouteBundleDigest: `sha256:${sha256(fixture.manifestBytes)}`,
  });
  assert.match(handoff.handoffSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(validateServerRouteBundleConsumerHandoff(handoff), handoff);
  assert.equal(await readFile(firstOutput, "utf8"), canonicalServerRouteBundleConsumerHandoffJson(handoff));
  assert.deepEqual(await readFile(firstOutput), await readFile(secondOutput));

  const cliOutput = path.join(fixture.root, "handoff-cli.json");
  const cli = spawnSync(process.execPath, [
    SCRIPT,
    "--artifact-root", fixture.artifactRoot,
    "--final", fixture.finalPath,
    "--publication-receipt", fixture.publicationReceiptPath,
    "--promotion-request", fixture.promotionRequestPath,
    "--repository-git-sha", REPOSITORY_GIT_SHA,
    "--output", cliOutput,
  ], { cwd: REPOSITORY_ROOT, encoding: "utf8" });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(cli.stderr, "");
  assert.equal(cli.stdout, `HANDOFF ${handoff.handoffSha256}\n`);
  assert.deepEqual(await readFile(cliOutput), await readFile(firstOutput));

  const schema = JSON.parse(await readFile(
    path.join(REPOSITORY_ROOT, "contracts/datapack/server-route-bundle-consumer-handoff.schema.json"),
    "utf8",
  ));
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, [
    "schemaVersion",
    "artifactKind",
    "manifest",
    "sourceSnapshotSetHash",
    "publicationReceipt",
    "release",
    "backendAdmission",
    "platformRelease",
    "handoffSha256",
  ]);
  assert.deepEqual(schema.properties.backendAdmission.required, [
    "manifestSha256",
    "finalEvidenceReference",
    "promotionEvidenceReference",
    "immutablePublicationReceiptIdentity",
  ]);
  assert.equal(Object.hasOwn(schema.properties.backendAdmission.properties, "activationRequestIdentity"), false);
  assert.deepEqual(schema.properties.platformRelease.required, ["serverRouteBundleDigest"]);
});

test("producer-neutral v2 descriptor는 v1 producer facts를 보존하고 consumer projection을 제외한다", async (t) => {
  const fixture = await createFixture(t);
  const v1Output = path.join(fixture.root, "handoff-v1.json");
  const firstOutput = path.join(fixture.root, "descriptor-v2-first.json");
  const secondOutput = path.join(fixture.root, "descriptor-v2-second.json");
  const handoff = await buildServerRouteBundleConsumerHandoff({
    ...fixture.input,
    output: v1Output,
    clock: () => NOW,
  });
  const descriptor = await buildServerRouteBundlePublicationDescriptor({
    ...fixture.input,
    output: firstOutput,
    clock: () => NOW,
  });
  await buildServerRouteBundlePublicationDescriptor({
    ...fixture.input,
    output: secondOutput,
    clock: () => NOW,
  });

  assert.deepEqual(descriptor, {
    artifactKind: "server-route-bundle-publication-descriptor",
    descriptorSha256: descriptor.descriptorSha256,
    manifest: handoff.manifest,
    producer: {
      gitSha: fixture.receipt.repository.gitSha,
      repository: fixture.receipt.repository.name,
    },
    publicationReceipt: handoff.publicationReceipt,
    release: handoff.release,
    schemaVersion: 2,
    sourceSnapshotSetHash: handoff.sourceSnapshotSetHash,
  });
  assert.match(descriptor.descriptorSha256, /^[a-f0-9]{64}$/);
  assert.equal(Object.hasOwn(descriptor, "backendAdmission"), false);
  assert.equal(Object.hasOwn(descriptor, "platformRelease"), false);
  assert.deepEqual(validateServerRouteBundlePublicationDescriptor(descriptor), descriptor);
  assert.equal(
    await readFile(firstOutput, "utf8"),
    canonicalServerRouteBundlePublicationDescriptorJson(descriptor),
  );
  assert.deepEqual(await readFile(firstOutput), await readFile(secondOutput));

  const cliOutput = path.join(fixture.root, "descriptor-v2-cli.json");
  const cli = spawnSync(process.execPath, [
    DESCRIPTOR_SCRIPT,
    "--artifact-root", fixture.artifactRoot,
    "--final", fixture.finalPath,
    "--publication-receipt", fixture.publicationReceiptPath,
    "--promotion-request", fixture.promotionRequestPath,
    "--repository-git-sha", REPOSITORY_GIT_SHA,
    "--output", cliOutput,
  ], { cwd: REPOSITORY_ROOT, encoding: "utf8" });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(cli.stderr, "");
  assert.equal(cli.stdout, `DESCRIPTOR ${descriptor.descriptorSha256}\n`);
  assert.deepEqual(await readFile(cliOutput), await readFile(firstOutput));

  const schema = JSON.parse(await readFile(
    path.join(REPOSITORY_ROOT, "contracts/datapack/server-route-bundle-publication-descriptor.schema.json"),
    "utf8",
  ));
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, [
    "schemaVersion",
    "artifactKind",
    "producer",
    "manifest",
    "sourceSnapshotSetHash",
    "publicationReceipt",
    "release",
    "descriptorSha256",
  ]);
  assert.equal(Object.hasOwn(schema.properties, "backendAdmission"), false);
  assert.equal(Object.hasOwn(schema.properties, "platformRelease"), false);
});

test("v2 descriptor는 extra consumer field와 identity drift를 fail closed한다", async (t) => {
  const fixture = await createFixture(t);
  const output = path.join(fixture.root, "descriptor-v2-valid.json");
  const descriptor = await buildServerRouteBundlePublicationDescriptor({
    ...fixture.input,
    output,
    clock: () => NOW,
  });

  const consumerProjection = structuredClone(descriptor);
  consumerProjection.backendAdmission = {};
  assert.throws(
    () => validateServerRouteBundlePublicationDescriptor(consumerProjection),
    /descriptor keys mismatch/,
  );

  const producerDrift = structuredClone(descriptor);
  producerDrift.producer.gitSha = "f".repeat(40);
  assert.throws(
    () => validateServerRouteBundlePublicationDescriptor(producerDrift),
    /producer identity mismatch/,
  );

  const digestDrift = structuredClone(descriptor);
  digestDrift.descriptorSha256 = "f".repeat(64);
  assert.throws(
    () => validateServerRouteBundlePublicationDescriptor(digestDrift),
    /descriptorSha256 mismatch/,
  );

  const mutationFixture = await createFixture(t);
  const rejectedOutput = path.join(mutationFixture.root, "descriptor-v2-mutated.json");
  await assert.rejects(() => buildServerRouteBundlePublicationDescriptor({
    ...mutationFixture.input,
    output: rejectedOutput,
    clock: () => NOW,
    beforeOutput: async () => {
      await writeFile(mutationFixture.promotionRequestPath, "mutated after snapshot");
    },
  }), /promotion request changed during descriptor build/);
  await assertMissing(rejectedOutput);
});

test("identity drift와 non-GO FINAL은 handoff output 없이 fail closed한다", async (t) => {
  await t.test("signed artifact byte drift", async (t) => {
    const fixture = await createFixture(t);
    await writeFile(path.join(fixture.artifactRoot, "compatibility.json"), "drift");
    await assertNoOutput(fixture, /publication receipt object compatibility\.json mismatch/);
  });

  await t.test("cryptographically invalid signed manifest", async (t) => {
    const fixture = await createFixture(t, { invalidSignature: true });
    await assertNoOutput(fixture, /signed manifest signature mismatch/);
  });

  await t.test("signed provenance source snapshot identity drift", async (t) => {
    const fixture = await createFixture(t, { candidateSourceSnapshotSetHash: "3".repeat(64) });
    await assertNoOutput(fixture, /provenance sourceSnapshotSetHash mismatch/);
  });

  await t.test("BOM-prefixed FINAL", async (t) => {
    const fixture = await createFixture(t);
    await writeFile(fixture.finalPath, Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      fixture.finalBytes,
    ]));
    await assertNoOutput(fixture, /FINAL must be canonical JSON/);
  });

  await t.test("publication receipt raw digest drift", async (t) => {
    const fixture = await createFixture(t);
    const final = buildServerRouteBundleFinal({
      candidate: fixture.final.candidate,
      gates: {
        ...fixture.final.gates,
        publication: { state: "PASS", evidenceSha256: "f".repeat(64) },
      },
    });
    await writeFile(fixture.finalPath, canonicalServerRouteBundleFinalJson(final));
    await assertNoOutput(fixture, /publication receipt raw digest mismatch/);
  });

  await t.test("promotion request raw digest drift", async (t) => {
    const fixture = await createFixture(t);
    await writeFile(fixture.promotionRequestPath, "different promotion request bytes");
    await assertNoOutput(fixture, /promotion request raw digest mismatch/);
  });

  await t.test("forged pre-publication FINAL identity", async (t) => {
    const fixture = await createFixture(t);
    const receiptPayload = structuredClone(fixture.receipt);
    delete receiptPayload.receiptSha256;
    receiptPayload.candidate.prePublicationFinalSha256 = "f".repeat(64);
    const receipt = {
      ...receiptPayload,
      receiptSha256: sha256(Buffer.from(canonicalJson(receiptPayload))),
    };
    const receiptBytes = Buffer.from(canonicalJson(receipt));
    await writeFile(fixture.publicationReceiptPath, receiptBytes);
    const final = buildServerRouteBundleFinal({
      candidate: fixture.final.candidate,
      gates: {
        ...fixture.final.gates,
        publication: { state: "PASS", evidenceSha256: sha256(receiptBytes) },
      },
    });
    await writeFile(fixture.finalPath, canonicalServerRouteBundleFinalJson(final));
    await assertNoOutput(fixture, /publication receipt pre-publication FINAL identity mismatch/);
  });

  await t.test("NO_GO FINAL", async (t) => {
    const fixture = await createFixture(t);
    const final = buildServerRouteBundleFinal({
      candidate: fixture.final.candidate,
      gates: {
        ...fixture.final.gates,
        publication: { state: "UNAVAILABLE", evidenceSha256: null },
      },
    });
    await writeFile(fixture.finalPath, canonicalServerRouteBundleFinalJson(final));
    await assertNoOutput(fixture, /FINAL must be GO with all gates PASS/);
  });

  await t.test("stale FINAL", async (t) => {
    const fixture = await createFixture(t);
    await assertNoOutput(fixture, /FINAL candidate freshUntil must be in the future/, Date.parse(FRESH_UNTIL));
  });
});

test("symlink·occupied output·input mutation을 거부하고 activation identity를 발명하지 않는다", async (t) => {
  await t.test("..-prefixed artifact child output", async (t) => {
    const fixture = await createFixture(t);
    const output = path.join(fixture.artifactRoot, "..handoff.json");
    await assert.rejects(() => buildServerRouteBundleConsumerHandoff({
      ...fixture.input,
      output,
      clock: () => NOW,
    }), /output must be outside the signed artifact root/);
    await assertMissing(output);
  });

  await t.test("ancestor symlink alias into artifact", async (t) => {
    const fixture = await createFixture(t);
    const aliasRoot = path.join(fixture.root, "artifact-parent-alias");
    await symlink(fixture.root, aliasRoot);
    const output = path.join(fixture.artifactRoot, "alias-handoff.json");
    await assert.rejects(() => buildServerRouteBundleConsumerHandoff({
      ...fixture.input,
      artifactRoot: path.join(aliasRoot, "signed"),
      output,
      clock: () => NOW,
    }), /output must be outside the signed artifact root/);
    await assertMissing(output);
  });

  await t.test("symlink receipt", async (t) => {
    const fixture = await createFixture(t);
    const link = path.join(fixture.root, "receipt-link.json");
    await symlink(fixture.publicationReceiptPath, link);
    await assertNoOutput({
      ...fixture,
      input: { ...fixture.input, publicationReceiptPath: link },
    }, /publication receipt must be a regular non-symlink/);
  });

  await t.test("occupied output", async (t) => {
    const fixture = await createFixture(t);
    const output = path.join(fixture.root, "occupied.json");
    await writeFile(output, "owner bytes");
    await assert.rejects(() => buildServerRouteBundleConsumerHandoff({
      ...fixture.input,
      output,
      clock: () => NOW,
    }), /output must not already exist/);
    assert.equal(await readFile(output, "utf8"), "owner bytes");
  });

  await t.test("input mutation before output", async (t) => {
    const fixture = await createFixture(t);
    const output = path.join(fixture.root, "mutated.json");
    await assert.rejects(() => buildServerRouteBundleConsumerHandoff({
      ...fixture.input,
      output,
      clock: () => NOW,
      beforeOutput: async () => {
        await writeFile(fixture.promotionRequestPath, "mutated after snapshot");
      },
    }), /promotion request changed during handoff build/);
    await assertMissing(output);
  });

  await t.test("post-link verification failure cleanup", async (t) => {
    const fixture = await createFixture(t);
    const output = path.join(fixture.root, "post-link-failure.json");
    const residueBefore = (await readdir(fixture.root))
      .filter((entry) => entry.startsWith(".server-route-handoff-"));
    await assert.rejects(() => buildServerRouteBundleConsumerHandoff({
      ...fixture.input,
      output,
      clock: () => NOW,
      afterOutputLink: async () => writeFile(output, "corrupted after link"),
    }), /output bytes mismatch after create/);
    await assertMissing(output);
    assert.deepEqual(
      (await readdir(fixture.root)).filter((entry) => entry.startsWith(".server-route-handoff-")),
      residueBefore,
    );
  });

  const fixture = await createFixture(t);
  const output = path.join(fixture.root, "valid.json");
  const handoff = await buildServerRouteBundleConsumerHandoff({ ...fixture.input, output, clock: () => NOW });
  const invalid = structuredClone(handoff);
  invalid.backendAdmission.activationRequestIdentity = "platform-owned";
  assert.throws(() => validateServerRouteBundleConsumerHandoff(invalid), /backendAdmission keys mismatch/);
});

test("standalone validator는 receipt의 signing-input·metadata를 manifest와 교차 결속한다", async (t) => {
  const fixture = await createFixture(t);
  const output = path.join(fixture.root, "valid-for-validator.json");
  const handoff = await buildServerRouteBundleConsumerHandoff({ ...fixture.input, output, clock: () => NOW });

  const signingInputDrift = rebindReceipt(handoff, (receipt) => {
    receipt.candidate.signingInputSha256 = "f".repeat(64);
    receipt.objects.find((entry) => entry.path === "manifest.signing-input.json").sha256 = "f".repeat(64);
  });
  assert.throws(
    () => validateServerRouteBundleConsumerHandoff(signingInputDrift),
    /publication receipt and manifest signing input identity mismatch/,
  );

  const compatibilityDrift = rebindReceipt(handoff, (receipt) => {
    receipt.objects.find((entry) => entry.path === "compatibility.json").sha256 = "f".repeat(64);
  });
  assert.throws(
    () => validateServerRouteBundleConsumerHandoff(compatibilityDrift),
    /publication receipt and manifest compatibility identity mismatch/,
  );
});

async function createFixture(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "server-route-consumer-handoff-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const artifactRoot = path.join(root, "signed");
  await mkdir(path.join(artifactRoot, "payload"), { recursive: true });

  const payloadEntries = [];
  const artifactBytes = new Map();
  for (const component of COMPONENTS) {
    const bytes = Buffer.from(`${component}-payload`);
    const relative = `payload/${component}.sqlite.zst`;
    artifactBytes.set(relative, bytes);
    payloadEntries.push({ path: relative, sizeBytes: bytes.length, sha256: sha256(bytes) });
  }
  const compatibilityBytes = Buffer.from(canonicalJson({ schemaCompatibility: { backendMin: 3, backendMax: 3 } }));
  const provenanceBytes = Buffer.from(canonicalJson({ sourceSnapshotSetHash: "2".repeat(64) }));
  artifactBytes.set("compatibility.json", compatibilityBytes);
  artifactBytes.set("provenance.json", provenanceBytes);
  const signingInput = {
    manifestVersion: 1,
    artifactKind: "server-route-bundle",
    bundleId: "server-route-bundle-20990101",
    releaseSequence: 7,
    stationSetSha256: "1".repeat(64),
    payloadSha256: sha256(Buffer.from(canonicalJson(payloadEntries))),
    topologySha256: payloadEntries.find((entry) => entry.path.includes("topology")).sha256,
    timetableSha256: payloadEntries.find((entry) => entry.path.includes("timetable")).sha256,
    accessibilitySha256: payloadEntries.find((entry) => entry.path.includes("accessibility")).sha256,
    fareSha256: payloadEntries.find((entry) => entry.path.includes("fare")).sha256,
    provenanceSha256: sha256(provenanceBytes),
    compatibilitySha256: sha256(compatibilityBytes),
    serviceTimezone: "Asia/Seoul",
    activeFrom: ACTIVE_FROM,
    freshUntil: FRESH_UNTIL,
    schemaCompatibility: { backendMin: 3, backendMax: 3 },
    keyId: "production-v1",
  };
  const signingInputBytes = Buffer.from(canonicalJson(signingInput));
  const signatureValue = options.invalidSignature
    ? "AA-_09"
    : createSign("RSA-SHA256").update(signingInputBytes).sign(privateKey).toString("base64url");
  const manifest = {
    ...signingInput,
    signature: { algorithm: "rsa-sha256-server-route-bundle-v1", value: signatureValue },
  };
  const manifestBytes = Buffer.from(canonicalJson(manifest));
  artifactBytes.set("manifest.signing-input.json", signingInputBytes);
  artifactBytes.set("manifest.json", manifestBytes);
  for (const [relative, bytes] of artifactBytes) {
    await writeFile(path.join(artifactRoot, relative), bytes);
  }

  const manifestSha256 = sha256(manifestBytes);
  const objectPrefix = `server-route-bundles/v1/${manifestSha256}/`;
  const candidate = {
    repository: "AquilaXk/easysubway-data",
    gitSha: REPOSITORY_GIT_SHA,
    bundleId: manifest.bundleId,
    releaseSequence: manifest.releaseSequence,
    stationSetSha256: manifest.stationSetSha256,
    sourceSnapshotSetHash: options.candidateSourceSnapshotSetHash ?? "2".repeat(64),
    signingInputSha256: sha256(signingInputBytes),
    signedManifestRawSha256: manifestSha256,
    payloadRootSha256: manifest.payloadSha256,
    componentInventorySha256: manifest.payloadSha256,
    componentDigests: {
      accessibility: manifest.accessibilitySha256,
      fare: manifest.fareSha256,
      timetable: manifest.timetableSha256,
      topology: manifest.topologySha256,
    },
    activeFrom: manifest.activeFrom,
    freshUntil: manifest.freshUntil,
    keyId: manifest.keyId,
  };
  const pass = (digest) => ({ state: "PASS", evidenceSha256: digest });
  const prePublicationFinal = buildServerRouteBundleFinal({
    candidate,
    gates: {
      sourceFreshness: pass("4".repeat(64)),
      stationLineAccessibility: pass("5".repeat(64)),
      routeEdgeEvaluation: pass("6".repeat(64)),
      artifactInventory: pass("7".repeat(64)),
      signature: pass(manifestSha256),
      publication: { state: "UNAVAILABLE", evidenceSha256: null },
      rebuildParityPromotion: { state: "UNAVAILABLE", evidenceSha256: null },
    },
  });
  const receiptPayload = {
    schemaVersion: 1,
    artifactKind: "server-route-bundle-publication-receipt",
    repository: { name: "AquilaXk/easysubway-data", gitSha: REPOSITORY_GIT_SHA },
    candidate: {
      bundleId: manifest.bundleId,
      releaseSequence: manifest.releaseSequence,
      stationSetSha256: manifest.stationSetSha256,
      sourceSnapshotSetHash: candidate.sourceSnapshotSetHash,
      signingInputSha256: sha256(signingInputBytes),
      signedManifestRawSha256: manifestSha256,
      payloadRootSha256: manifest.payloadSha256,
      componentInventorySha256: manifest.payloadSha256,
      componentDigests: candidate.componentDigests,
      activeFrom: manifest.activeFrom,
      freshUntil: manifest.freshUntil,
      keyId: manifest.keyId,
      prePublicationFinalSha256: prePublicationFinal.finalSha256,
    },
    locator: { publicBaseUrl: PUBLIC_BASE_URL, objectPrefix },
    objects: SIGNED_PATHS.map((relative) => {
      const bytes = artifactBytes.get(relative);
      return {
        path: relative,
        objectKey: `${objectPrefix}${relative}`,
        sizeBytes: bytes.length,
        sha256: sha256(bytes),
      };
    }),
  };
  const receipt = {
    ...receiptPayload,
    receiptSha256: sha256(Buffer.from(canonicalJson(receiptPayload))),
  };
  const receiptBytes = Buffer.from(canonicalJson(receipt));
  const publicationReceiptPath = path.join(root, "publication-receipt.json");
  await writeFile(publicationReceiptPath, receiptBytes);

  const promotionRequestBytes = Buffer.from(canonicalJson({
    artifactKind: "promotion-request",
    candidateId: manifest.bundleId,
  }));
  const promotionRequestPath = path.join(root, "promotion-request.json");
  await writeFile(promotionRequestPath, promotionRequestBytes);
  const final = buildServerRouteBundleFinal({
    candidate,
    gates: {
      sourceFreshness: pass("4".repeat(64)),
      stationLineAccessibility: pass("5".repeat(64)),
      routeEdgeEvaluation: pass("6".repeat(64)),
      artifactInventory: pass("7".repeat(64)),
      signature: pass(manifestSha256),
      publication: pass(sha256(receiptBytes)),
      rebuildParityPromotion: pass(sha256(promotionRequestBytes)),
    },
  });
  const finalBytes = Buffer.from(canonicalServerRouteBundleFinalJson(final));
  const finalPath = path.join(root, "server-route-bundle-final.json");
  await writeFile(finalPath, finalBytes);

  return {
    root,
    artifactRoot,
    final,
    finalBytes,
    finalPath,
    input: {
      repositoryRoot: REPOSITORY_ROOT,
      repositoryGitSha: REPOSITORY_GIT_SHA,
      artifactRoot,
      finalPath,
      publicationReceiptPath,
      promotionRequestPath,
    },
    manifest,
    manifestBytes,
    promotionRequestBytes,
    promotionRequestPath,
    publicationReceiptPath,
    receipt,
    receiptBytes,
  };
}

async function assertNoOutput(fixture, pattern, now = NOW) {
  rejectedSequence += 1;
  const output = path.join(fixture.root, `rejected-${rejectedSequence}.json`);
  await assert.rejects(() => buildServerRouteBundleConsumerHandoff({
    ...fixture.input,
    output,
    clock: () => now,
  }), pattern);
  await assertMissing(output);
}

async function assertMissing(target) {
  await assert.rejects(() => readFile(target), { code: "ENOENT" });
}

function rebindReceipt(handoff, mutate) {
  const rebound = structuredClone(handoff);
  mutate(rebound.publicationReceipt);
  const receiptPayload = structuredClone(rebound.publicationReceipt);
  delete receiptPayload.receiptSha256;
  rebound.publicationReceipt.receiptSha256 = sha256(Buffer.from(canonicalJson(receiptPayload)));
  rebound.release.publicationReceiptSha256 = rebound.publicationReceipt.receiptSha256;
  rebound.release.publicationReceiptRawSha256 = sha256(Buffer.from(canonicalJson(rebound.publicationReceipt)));
  rebound.backendAdmission.immutablePublicationReceiptIdentity =
    `sha256:${rebound.release.publicationReceiptRawSha256}`;
  const payload = structuredClone(rebound);
  delete payload.handoffSha256;
  rebound.handoffSha256 = sha256(Buffer.from(canonicalJson(payload)));
  return rebound;
}

function bytewise(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}
