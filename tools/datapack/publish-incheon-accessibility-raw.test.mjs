import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runIncheonAccessibilityCollector } from "./collect-incheon-accessibility.mjs";
import { publishIncheonAccessibilityRawArtifact } from "./publish-incheon-accessibility-raw.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const OCI_ENV = { EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL: "https://objectstorage.ap-seoul-1.oraclecloud.com/p/redacted/n/axvym6vk8g7i/b/easysubway-datapacks/o" };
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "incheon-raw-publisher-")); t.after(() => rm(root, { recursive: true, force: true }));
  const observationRoot = path.join(root, "observation");
  await runIncheonAccessibilityCollector([
    "--elevator-input", path.join(ROOT, "tools/datapack/fixtures/incheon-accessibility-raw/data-go-15083478.csv"),
    "--escalator-input", path.join(ROOT, "tools/datapack/fixtures/incheon-accessibility-raw/data-go-15010199.csv"),
    "--wheelchair-input", path.join(ROOT, "tools/datapack/fixtures/incheon-accessibility-raw/data-go-15146049.csv"),
    "--topology-snapshot", path.join(ROOT, "tools/datapack/sources/incheon-transit-station-info-20260828.json"),
    "--observation-output", observationRoot, "--captured-at", "2026-08-28T04:33:56.000Z",
  ]);
  return { root, observationRoot, receiptPath: path.join(root, "receipt.json") };
}
function client() {
  const calls = []; let bytes = null;
  return { calls, client: {
    async putObjectIfAbsent(key, body) { calls.push(["put", key]); bytes = Buffer.from(body); return true; },
    async readObject(key) { calls.push(["get", key]); return { exists: true, body: bytes }; },
  } };
}

async function rewriteRawAsAttacker({ observationRoot, manifest, mutate }) {
  const rawPath = path.join(observationRoot, manifest.rawArtifactFile);
  const raw = JSON.parse(await readFile(rawPath, "utf8"));
  mutate(raw);
  const bytes = Buffer.from(`${JSON.stringify(raw, null, 2)}\n`);
  await (await import("node:fs/promises")).writeFile(rawPath, bytes);
  manifest.rawObjectSha256 = createHash("sha256").update(bytes).digest("hex");
  manifest.rawObjectChecksumSha256 = createHash("sha256").update(bytes).digest("base64");
  manifest.rawObjectByteSize = bytes.length;
  await (await import("node:fs/promises")).writeFile(path.join(observationRoot, "observation.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

test("Incheon publisher puts and verifies one OCI raw object then binds a private receipt", async (t) => {
  const values = await fixture(t); const oci = client();
  const receipt = await publishIncheonAccessibilityRawArtifact({ ...values, env: OCI_ENV, client: oci.client, now: new Date("2026-08-28T04:34:00.000Z") });
  assert.deepEqual(oci.calls.map(([operation]) => operation), ["put", "get"]);
  assert.match(receipt.rawObjectUri, /^oci:\/\/axvym6vk8g7i\/easysubway-datapacks\/source-raw\/incheon-transit-accessibility\/20260828\/[a-f0-9]{64}\.json$/u);
  assert.equal(JSON.parse(await readFile(values.receiptPath, "utf8")).snapshotId, receipt.snapshotId);
});

test("Incheon publisher rejects raw mutation and non-OCI storage configuration before a put", async (t) => {
  const values = await fixture(t); const oci = client();
  const manifest = JSON.parse(await readFile(path.join(values.observationRoot, "observation.json"), "utf8"));
  const rawPath = path.join(values.observationRoot, manifest.rawArtifactFile);
  const raw = JSON.parse(await readFile(rawPath, "utf8")); raw.artifactKind = "wrong";
  await (await import("node:fs/promises")).writeFile(rawPath, `${JSON.stringify(raw)}\n`);
  await assert.rejects(publishIncheonAccessibilityRawArtifact({ ...values, env: OCI_ENV, client: oci.client }), /raw collection is invalid/);
  assert.equal(oci.calls.length, 0);
  const clean = await fixture(t); const rejected = client();
  await assert.rejects(publishIncheonAccessibilityRawArtifact({ ...clean, env: {}, client: rejected.client }), /EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL/);
  assert.equal(rejected.calls.length, 0);
  const extra = await fixture(t); const extraClient = client();
  await (await import("node:fs/promises")).writeFile(path.join(extra.observationRoot, "unexpected.json"), "{}\n");
  await assert.rejects(publishIncheonAccessibilityRawArtifact({ ...extra, env: OCI_ENV, client: extraClient.client }), /observation inventory/);
  assert.equal(extraClient.calls.length, 0);
  const cadence = await fixture(t); const cadenceClient = client();
  const cadenceManifest = JSON.parse(await readFile(path.join(cadence.observationRoot, "observation.json"), "utf8"));
  await rewriteRawAsAttacker({ observationRoot: cadence.observationRoot, manifest: cadenceManifest, mutate: (raw) => { raw.freshnessPolicy.sourceClasses[0].reverificationCadence = "P1D"; } });
  await assert.rejects(publishIncheonAccessibilityRawArtifact({ ...cadence, env: OCI_ENV, client: cadenceClient.client }), /freshness policy mismatch/);
  assert.equal(cadenceClient.calls.length, 0);
  const policyExtra = await fixture(t); const policyExtraClient = client();
  const policyExtraManifest = JSON.parse(await readFile(path.join(policyExtra.observationRoot, "observation.json"), "utf8"));
  await rewriteRawAsAttacker({ observationRoot: policyExtra.observationRoot, manifest: policyExtraManifest, mutate: (raw) => { raw.freshnessPolicy.extra = true; } });
  await assert.rejects(publishIncheonAccessibilityRawArtifact({ ...policyExtra, env: OCI_ENV, client: policyExtraClient.client }), /freshness policy mismatch/);
  assert.equal(policyExtraClient.calls.length, 0);
  const nested = await fixture(t); const nestedClient = client();
  const nestedManifest = JSON.parse(await readFile(path.join(nested.observationRoot, "observation.json"), "utf8"));
  await rewriteRawAsAttacker({ observationRoot: nested.observationRoot, manifest: nestedManifest, mutate: (raw) => { raw.topologySnapshot.scope[0].private = "attacker"; } });
  await assert.rejects(publishIncheonAccessibilityRawArtifact({ ...nested, env: OCI_ENV, client: nestedClient.client }), /unexpected fields/);
  assert.equal(nestedClient.calls.length, 0);
});
