import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { constants, zstdCompressSync, zstdDecompressSync } from "node:zlib";

import {
  buildServerRouteBundleFinalEvidence,
} from "./build-server-route-bundle-final.mjs";
import {
  buildRouteAccessibilityEligibility,
} from "./build-route-accessibility-eligibility.mjs";
import { GENERATED_ACCESSIBILITY_EVIDENCE_TABLE_DDL } from "./emit-artifact-components.mjs";
import {
  canonicalJson,
  sha256,
} from "./lib/manifest-validation.mjs";
import {
  validateServerRouteBundleFinal,
} from "./lib/server-route-bundle-final.mjs";
import {
  canonicalRouteEdgeEvaluationJson,
  canonicalRideEdgeSetSha256,
  evaluateRouteAccessibilityEdges,
  routeEdgeSha256,
} from "./evaluate-route-accessibility-edges.mjs";
import {
  canonicalStationLineAccessibilityJson,
  materializeStationLineAccessibility,
} from "./materialize-station-line-accessibility.mjs";
import { signServerRouteBundle } from "./sign-server-route-bundle.mjs";

const FRESH_AT = "2026-08-14T15:34:07.000Z";
const STALE_AT = "2026-08-14T20:06:04.806Z";
const CANDIDATE_ID = "capital-pilot-candidate-20260814";
const BUNDLE_ID = "capital-route-bundle-1";
const STATION_SET_SHA256 = "1".repeat(64);
const SCOPED_STATION_SET_SHA256 = sha256(Buffer.from(canonicalJson(["station-a", "station-b"])));
const SCRIPT = path.resolve("tools/datapack/build-server-route-bundle-final.mjs");
const signingKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const signingPrivateKey = signingKeys.privateKey.export({ type: "pkcs8", format: "pem" });
const signingPublicKey = signingKeys.publicKey.export({ type: "spki", format: "pem" });

test("route accessibility eligibility report를 FINAL gate에 bound한다", async (t) => {
  const fixture = await createFixture(t);
  const provisional = path.join(fixture.temp, "provisional");
  await build(fixture, provisional, FRESH_AT);
  const reportPath = await createEligibilityReport(fixture, provisional, "eligibility.json");
  const bound = path.join(fixture.temp, "bound");
  await build(fixture, bound, FRESH_AT, undefined, { eligibilityReportPath: reportPath });
  const boundFinal = await readJson(path.join(bound, "server-route-bundle-final.json"));
  assert.deepEqual(boundFinal.gates.routeAccessibilityEligibility, {
    state: "PASS",
    evidenceSha256: await fileSha(reportPath),
  });

  const drifted = await readJson(reportPath);
  delete drifted.eligibilitySha256;
  drifted.stationLineAccessibility.rowCount += 1;
  const driftedReportPath = path.join(fixture.temp, "eligibility-drift.json");
  await writeCanonical(driftedReportPath, {
    ...drifted,
    eligibilitySha256: sha256(Buffer.from(canonicalJson(drifted))),
  });
  const mismatch = path.join(fixture.temp, "eligibility-mismatch");
  await build(fixture, mismatch, FRESH_AT, undefined, { eligibilityReportPath: driftedReportPath });
  const mismatchFinal = await readJson(path.join(mismatch, "server-route-bundle-final.json"));
  assert.equal(mismatchFinal.gates.routeAccessibilityEligibility.state, "IDENTITY_MISMATCH");
});

test("current accessibility eligibility는 canonical prepublication evidence만 집계한다", async (t) => {
  const fixture = await createFixture(t);
  await writeEligibilityInputs(fixture);
  const prepublicationRoot = path.join(fixture.temp, "prepublication");
  await build(fixture, prepublicationRoot, FRESH_AT);

  const report = await buildRouteAccessibilityEligibility(eligibilityInput(
    fixture,
    prepublicationRoot,
    path.join(fixture.temp, "eligibility.json"),
  ));
  assert.equal(report.decision, "ELIGIBLE");
  assert.equal(report.stationLineAccessibility.rowCount, 6);
  assert.equal(report.routeEdgeEvaluation.edgeCount, fixture.routeEdgeInput.routeEdges.length);
  const unresolvedFixture = await createFixture(t, {
    configureInputs: ({ stationLineInput }) => {
      stationLineInput.evidenceRows[0] = {
        ...stationLineInput.evidenceRows[0],
        state: "UNKNOWN",
        evidenceKind: "PROVIDER_NO_DATA",
        evidenceReason: "official record unavailable",
      };
    },
  });
  await writeEligibilityInputs(unresolvedFixture);
  const unresolvedRoot = path.join(unresolvedFixture.temp, "prepublication");
  await build(unresolvedFixture, unresolvedRoot, FRESH_AT);
  const ineligible = await buildRouteAccessibilityEligibility(eligibilityInput(
    unresolvedFixture,
    unresolvedRoot,
    path.join(unresolvedFixture.temp, "ineligible.json"),
  ));
  assert.equal(ineligible.decision, "INELIGIBLE");
  assert.ok(ineligible.blockers.includes("stationLineAccessibility:UNKNOWN"));

  for (const name of [
    "source-freshness.json",
    "artifact-inventory.json",
    "station-line-accessibility.json",
    "route-edge-evaluation.json",
    "server-route-bundle-final.json",
  ]) {
    const root = path.join(fixture.temp, `mutated-${name}`);
    await cp(prepublicationRoot, root, { recursive: true });
    const target = path.join(root, name);
    const value = await readJson(target);
    value.reviewMutation = true;
    await writeCanonical(target, value);
    const output = path.join(fixture.temp, `${name}.eligibility.json`);
    await assert.rejects(() => buildRouteAccessibilityEligibility(eligibilityInput(fixture, root, output)), /prepublication .* mismatch/);
    await assert.rejects(() => readFile(output), /ENOENT/);
  }
});

test("current Data #8 three-handoff input과 materialization bytes를 exact consumer로 수용한다", async () => {
  const [inputBytes, materializationBytes] = await Promise.all([
    readFile("tools/datapack/release/current-station-line-accessibility/station-line-input.json"),
    readFile("tools/datapack/release/current-station-line-accessibility/station-line-accessibility.json"),
  ]);
  const input = JSON.parse(inputBytes);
  const tracked = JSON.parse(materializationBytes);

  assert.equal(inputBytes.toString("utf8"), canonicalJson(input));
  assert.equal(materializationBytes.toString("utf8"), canonicalStationLineAccessibilityJson(tracked));
  const materialized = materializeStationLineAccessibility({
    ...input,
    observedAt: FRESH_AT,
  });
  assert.equal(canonicalStationLineAccessibilityJson(materialized), materializationBytes.toString("utf8"));
  assert.equal(materialized.materializationDigest, "561ef3dde0f68e1223b05897d71a193d73b67b34cb677fc91201e99a4ae9eabb");
});

test("embedded #8/#9 evidence와 current keyless bytes를 deterministic NO_GO FINAL로 결속한다", async (t) => {
  const fixture = await createFixture(t);
  const beforeStation = structuredClone(fixture.stationLineInput);
  const beforeRoute = structuredClone(fixture.routeEdgeInput);
  const firstOutput = path.join(fixture.temp, "evidence-one");
  const secondOutput = path.join(fixture.temp, "evidence-two");

  await build(fixture, firstOutput, FRESH_AT);
  await build(fixture, secondOutput, FRESH_AT);

  assert.deepEqual(fixture.stationLineInput, beforeStation);
  assert.deepEqual(fixture.routeEdgeInput, beforeRoute);
  assert.deepEqual((await readdir(firstOutput)).sort(bytewise), [
    "artifact-inventory.json",
    "route-edge-evaluation.json",
    "server-route-bundle-final.json",
    "source-freshness.json",
    "station-line-accessibility.json",
  ]);
  for (const name of (await readdir(firstOutput)).sort(bytewise)) {
    assert.deepEqual(await readFile(path.join(firstOutput, name)), await readFile(path.join(secondOutput, name)), name);
  }

  const final = await readJson(path.join(firstOutput, "server-route-bundle-final.json"));
  assert.deepEqual(final.gates, {
    artifactInventory: { state: "PASS", evidenceSha256: await fileSha(path.join(firstOutput, "artifact-inventory.json")) },
    publication: { state: "UNAVAILABLE", evidenceSha256: null },
    routeAccessibilityEligibility: { state: "UNAVAILABLE", evidenceSha256: null },
    rebuildParityPromotion: { state: "UNAVAILABLE", evidenceSha256: null },
    routeEdgeEvaluation: { state: "PASS", evidenceSha256: await fileSha(path.join(firstOutput, "route-edge-evaluation.json")) },
    signature: { state: "UNAVAILABLE", evidenceSha256: null },
    sourceFreshness: { state: "PASS", evidenceSha256: await fileSha(path.join(firstOutput, "source-freshness.json")) },
    stationLineAccessibility: { state: "PASS", evidenceSha256: await fileSha(path.join(firstOutput, "station-line-accessibility.json")) },
  });
  assert.equal(final.result, "NO_GO");
  assert.deepEqual(final.blockers, [
    "publication:UNAVAILABLE",
    "rebuildParityPromotion:UNAVAILABLE",
    "routeAccessibilityEligibility:UNAVAILABLE",
    "signature:UNAVAILABLE",
  ]);
  assert.equal(final.candidate.repository, "AquilaXk/easysubway-data");
  assert.equal(final.candidate.gitSha, fixture.repositoryGitSha);
  assert.equal(final.candidate.bundleId, BUNDLE_ID);
  assert.equal(final.candidate.sourceSnapshotSetHash, fixture.buildSpec.sourceSnapshotSetHash);
  assert.equal(final.candidate.payloadRootSha256, final.candidate.componentInventorySha256);
  assert.equal(final.candidate.signedManifestRawSha256, null);
  assert.equal(final.candidate.componentDigests.topology, fixture.manifest.topologySha256);
  assert.doesNotThrow(() => validateServerRouteBundleFinal(final));

  const inventory = await readJson(path.join(firstOutput, "artifact-inventory.json"));
  assert.deepEqual(inventory.entries.map(({ path: entryPath }) => entryPath), [
    "payload/accessibility.sqlite.zst",
    "payload/fare.sqlite.zst",
    "payload/timetable.sqlite.zst",
    "payload/topology.sqlite.zst",
  ]);
  assert.equal(inventory.componentInventorySha256, fixture.manifest.payloadSha256);

  await mutateAccessibilityPayload(
    fixture,
    "UPDATE station_line_accessibility_evidence SET canonical_json = canonical_json || ' '",
  );
  const tamperedOutput = path.join(fixture.temp, "tampered-final");
  await assert.rejects(
    () => build(fixture, tamperedOutput, FRESH_AT),
    /embedded station-line accessibility evidence mismatch/,
  );
  await assert.rejects(() => readFile(tamperedOutput), /ENOENT/);
});

test("handoff candidate와 signed bundle identity를 분리한다", async (t) => {
  const fixture = await createFixture(t);
  assert.equal(fixture.buildSpec.candidateId, CANDIDATE_ID);
  assert.equal(fixture.stationLineInput.candidate.candidateId, CANDIDATE_ID);
  assert.equal(fixture.routeEdgeInput.candidate.candidateId, CANDIDATE_ID);
  assert.notEqual(CANDIDATE_ID, BUNDLE_ID);

  const output = path.join(fixture.temp, "distinct-candidate-bundle");
  await build(fixture, output, FRESH_AT);
  const final = await readJson(path.join(output, "server-route-bundle-final.json"));
  assert.equal(final.candidate.bundleId, BUNDLE_ID);

  for (const [name, mutate] of [
    ["station", (value) => { value.stationLineInput.candidate.candidateId = "other-candidate"; }],
    ["route", (value) => { value.routeEdgeInput.candidate.candidateId = "other-candidate"; }],
  ]) {
    const rejected = await createFixture(t);
    mutate(rejected);
    const rejectedOutput = path.join(rejected.temp, `wrong-${name}-candidate`);
    await assert.rejects(() => build(rejected, rejectedOutput, FRESH_AT), /candidate identity mismatch/);
    await assert.rejects(() => readFile(rejectedOutput), /ENOENT/);
  }
});

test("embedded #8/#9 evidence의 missing·extra·digest mismatch는 fail closed한다", async (t) => {
  for (const [name, sql, pattern] of [
    ["wrong-user-version", "PRAGMA user_version=18", /embedded accessibility evidence SQLite user_version mismatch/],
    ["missing-route-row", "DELETE FROM route_accessibility_edge_evidence", /embedded route-edge evaluation evidence mismatch/],
    ["extra-station-row", `INSERT INTO station_line_accessibility_evidence VALUES('${"d".repeat(64)}','{}')`, /embedded station-line accessibility evidence mismatch/],
    ["route-digest-mismatch", `UPDATE route_accessibility_edge_evidence SET evaluation_digest='${"e".repeat(64)}'`, /embedded route-edge evaluation evidence mismatch/],
    ["route-schema-without-constraints", "ALTER TABLE route_accessibility_edge_evidence RENAME TO route_accessibility_edge_evidence_old; CREATE TABLE route_accessibility_edge_evidence (evaluation_digest TEXT NOT NULL PRIMARY KEY, materialization_digest TEXT NOT NULL, canonical_json TEXT NOT NULL); INSERT INTO route_accessibility_edge_evidence SELECT * FROM route_accessibility_edge_evidence_old; DROP TABLE route_accessibility_edge_evidence_old", /embedded route_accessibility_edge_evidence schema mismatch/],
    ["missing-route-table", "DROP TABLE route_accessibility_edge_evidence", /embedded route_accessibility_edge_evidence schema mismatch/],
  ]) {
    await t.test(name, async () => {
      const fixture = await createFixture(t);
      await mutateAccessibilityPayload(fixture, sql);
      const output = path.join(fixture.temp, `rejected-${name}`);
      await assert.rejects(() => build(fixture, output, FRESH_AT), pattern);
      await assert.rejects(() => readFile(output), /ENOENT/);
    });
  }
});

test("current-key signed manifest는 signature gate만 닫고 publication·parity NO_GO를 유지한다", async (t) => {
  const fixture = await createFixture(t);
  installSigningEnvironment(t);
  const signedRoot = path.join(fixture.temp, "signed-bundle");
  await signServerRouteBundle({ input: fixture.artifactRoot, output: signedRoot });
  fixture.artifactRoot = signedRoot;
  const output = path.join(fixture.temp, "signed-final");
  await build(fixture, output, FRESH_AT);

  const manifestSha256 = await fileSha(path.join(signedRoot, "manifest.json"));
  const final = await readJson(path.join(output, "server-route-bundle-final.json"));
  assert.equal(final.candidate.signedManifestRawSha256, manifestSha256);
  assert.deepEqual(final.gates.signature, { state: "PASS", evidenceSha256: manifestSha256 });
  assert.deepEqual(final.blockers, ["publication:UNAVAILABLE", "rebuildParityPromotion:UNAVAILABLE", "routeAccessibilityEligibility:UNAVAILABLE"]);
  assert.equal(final.result, "NO_GO");
  const inventory = await readJson(path.join(output, "artifact-inventory.json"));
  assert.equal(inventory.signedManifestRawSha256, manifestSha256);
  assert.doesNotThrow(() => validateServerRouteBundleFinal(final));

  const manifestPath = path.join(signedRoot, "manifest.json");
  const manifest = await readJson(manifestPath);
  await writeCanonical(manifestPath, { ...manifest, bundleId: "other-bundle" });
  const driftOutput = path.join(fixture.temp, "manifest-drift");
  await assert.rejects(() => build(fixture, driftOutput, FRESH_AT), /signed manifest does not match signing input/);
  await assert.rejects(() => readFile(driftOutput), /ENOENT/);

  const head = manifest.signature.value[0];
  manifest.signature.value = `${head === "A" ? "B" : "A"}${manifest.signature.value.slice(1)}`;
  await writeCanonical(manifestPath, manifest);
  const rejectedOutput = path.join(fixture.temp, "invalid-signature");
  await assert.rejects(() => build(fixture, rejectedOutput, FRESH_AT), /signed manifest signature mismatch/);
  await assert.rejects(() => readFile(rejectedOutput), /ENOENT/);
});

test("publication receipt와 three-run promotion을 동일 candidate FINAL GO로 결속한다", async (t) => {
  const fixture = await createFixture(t);
  installSigningEnvironment(t);
  const signedRoot = path.join(fixture.temp, "signed-release-bundle");
  await signServerRouteBundle({ input: fixture.artifactRoot, output: signedRoot });
  fixture.artifactRoot = signedRoot;

  const provisionalOutput = path.join(fixture.temp, "provisional-final");
  await build(fixture, provisionalOutput, FRESH_AT);
  const eligibilityReportPath = await createEligibilityReport(
    fixture,
    provisionalOutput,
    "release-eligibility.json",
  );
  const prePublicationOutput = path.join(fixture.temp, "pre-publication-final");
  await build(fixture, prePublicationOutput, FRESH_AT, undefined, { eligibilityReportPath });
  const prePublicationFinal = await readJson(
    path.join(prePublicationOutput, "server-route-bundle-final.json"),
  );
  assert.equal(prePublicationFinal.result, "NO_GO");
  assert.deepEqual(prePublicationFinal.blockers, [
    "publication:UNAVAILABLE",
    "rebuildParityPromotion:UNAVAILABLE",
  ]);

  const releaseEvidence = {
    ...await createReleaseEvidence(fixture, prePublicationFinal),
    eligibilityReportPath,
  };
  const output = path.join(fixture.temp, "release-final");
  await build(fixture, output, FRESH_AT, releaseEvidence);

  const final = await readJson(path.join(output, "server-route-bundle-final.json"));
  assert.equal(final.result, "GO");
  assert.deepEqual(final.blockers, []);
  assert.deepEqual(final.gates.publication, {
    state: "PASS",
    evidenceSha256: await fileSha(releaseEvidence.publicationReceiptPath),
  });
  assert.deepEqual(final.gates.rebuildParityPromotion, {
    state: "PASS",
    evidenceSha256: await fileSha(releaseEvidence.promotionRequestPath),
  });
  assert.doesNotThrow(() => validateServerRouteBundleFinal(final));
  assert.deepEqual((await readdir(output)).sort(bytewise), [
    "artifact-inventory.json",
    "route-edge-evaluation.json",
    "server-route-bundle-final.json",
    "source-freshness.json",
    "station-line-accessibility.json",
  ]);
});

test("receipt와 promotion inventory를 함께 변조해도 actual bundle bytes mismatch는 거부한다", async (t) => {
  installSigningEnvironment(t);
  const { fixture, releaseEvidence } = await prepareSignedReleaseFixture(t);
  await rewriteReceipt(releaseEvidence.publicationReceiptPath, (receipt) => {
    receipt.objects.find((entry) => entry.path === "compatibility.json").sha256 = "f".repeat(64);
  });
  await rewritePromotionEvidence(releaseEvidence, ({ inventory }) => {
    inventory.entries.find((entry) => (
      entry.path === "server-route-bundle/compatibility.json"
    )).sha256 = "f".repeat(64);
  });
  const output = path.join(fixture.temp, "release-rejected-published-byte-drift");
  await assert.rejects(
    () => build(fixture, output, FRESH_AT, releaseEvidence),
    /publication receipt object inventory mismatch/,
  );
  await assert.rejects(() => readFile(output), /ENOENT/);
});

test("FINAL closure는 bundle보다 이른 source freshness cutoff를 거부한다", async (t) => {
  installSigningEnvironment(t);
  const { fixture, releaseEvidence } = await prepareSignedReleaseFixture(t, {
    freshUntil: "2026-09-09T00:00:00.000+09:00",
  });
  const output = path.join(fixture.temp, "release-rejected-source-cutoff");
  await assert.rejects(
    () => build(fixture, output, FRESH_AT, releaseEvidence, {
      clock: () => Date.parse(FRESH_AT),
    }),
    /source freshness cutoff must cover candidate freshUntil/,
  );
  await assert.rejects(() => readFile(output), /ENOENT/);
});

test("release evidence mismatch·stale·mutation은 FINAL output 전에 fail closed한다", async (t) => {
  installSigningEnvironment(t);
  for (const [name, mutate, pattern, evaluationAt = FRESH_AT] of [
    ["partial-input", async ({ releaseEvidence }) => {
      delete releaseEvidence.approvalEvidencePath;
    }, /release evidence keys mismatch/],
    ["receipt-final", async ({ releaseEvidence }) => {
      await rewriteReceipt(releaseEvidence.publicationReceiptPath, (receipt) => {
        receipt.candidate.prePublicationFinalSha256 = "f".repeat(64);
      });
    }, /publication receipt FINAL identity mismatch/],
    ["receipt-noncanonical", async ({ releaseEvidence }) => {
      const receipt = await readJson(releaseEvidence.publicationReceiptPath);
      await writeFile(releaseEvidence.publicationReceiptPath, JSON.stringify(receipt, null, 2));
    }, /publication receipt must be canonical JSON/],
    ["promotion-git", async ({ releaseEvidence }) => {
      await rewritePromotionEvidence(releaseEvidence, ({ component }) => {
        component.gitSha = "f".repeat(40);
      });
    }, /promotion candidate identity mismatch/],
    ["promotion-release", async ({ releaseEvidence }) => {
      await rewritePromotionEvidence(releaseEvidence, ({ component }) => {
        component.releaseSequence += 1;
      });
    }, /promotion candidate identity mismatch/],
    ["promotion-source", async ({ releaseEvidence }) => {
      await rewritePromotionEvidence(releaseEvidence, ({ component }) => {
        component.provenance.sourceSnapshotSetHash = "f".repeat(64);
      });
    }, /promotion candidate identity mismatch/],
    ["server-digest", async ({ releaseEvidence }) => {
      await rewritePromotionEvidence(releaseEvidence, ({ inventory }) => {
        inventory.entries.find((entry) => entry.path === "server-route-bundle/provenance.json").sha256 = "f".repeat(64);
      });
    }, /promotion server-route-bundle inventory mismatch/],
    ["server-missing", async ({ releaseEvidence }) => {
      await rewritePromotionEvidence(releaseEvidence, ({ inventory }) => {
        inventory.entries = inventory.entries.filter((entry) => (
          entry.path !== "server-route-bundle/payload/fare.sqlite.zst"
        ));
      });
    }, /promotion server-route-bundle inventory mismatch/],
    ["server-extra", async ({ releaseEvidence }) => {
      await rewritePromotionEvidence(releaseEvidence, ({ inventory }) => {
        inventory.entries.push({
          path: "server-route-bundle/extra.bin",
          sizeBytes: 1,
          sha256: "e".repeat(64),
        });
        inventory.entries.sort((left, right) => bytewise(left.path, right.path));
      });
    }, /promotion server-route-bundle inventory mismatch/],
    ["inventory-duplicate", async ({ releaseEvidence }) => {
      await rewritePromotionEvidence(releaseEvidence, ({ inventory }) => {
        inventory.entries.push(structuredClone(inventory.entries.find((entry) => (
          entry.path === "server-route-bundle/provenance.json"
        ))));
        inventory.entries.sort((left, right) => bytewise(left.path, right.path));
      });
    }, /inventory entry is invalid/],
    ["inventory-order", async ({ releaseEvidence }) => {
      await rewritePromotionEvidence(releaseEvidence, ({ inventory }) => {
        inventory.entries.reverse();
      });
    }, /inventory entry is invalid/],
    ["symlink", async ({ fixture, releaseEvidence }) => {
      const target = path.join(fixture.temp, "approval-target.json");
      await rename(releaseEvidence.approvalEvidencePath, target);
      await symlink(target, releaseEvidence.approvalEvidencePath);
    }, /approvalEvidencePath must be a regular non-symlink/],
    ["stale", async () => {}, /embedded station-line accessibility evidence mismatch/, STALE_AT],
    ["wall-clock-expired", async () => ({
      clock: () => Date.parse(STALE_AT),
    }), /candidate freshUntil must be in the future at FINAL closure/],
    ["changed-during-build", async ({ releaseEvidence }) => ({
      beforeReleaseOutput: async () => {
        await writeFile(releaseEvidence.promotionRequestPath, "changed");
      },
    }), /promotionRequestPath changed during FINAL build/],
    ["eligibility-changed-during-build", async ({ releaseEvidence }) => ({
      beforeReleaseOutput: async () => {
        await writeFile(releaseEvidence.eligibilityReportPath, "changed");
      },
    }), /eligibilityReportPath changed during FINAL build/],
  ]) {
    await t.test(name, async () => {
      const { fixture, releaseEvidence } = await prepareSignedReleaseFixture(t);
      const extraInput = await mutate({ fixture, releaseEvidence }) ?? {};
      const output = path.join(fixture.temp, `release-rejected-${name}`);
      await assert.rejects(
        () => build(fixture, output, evaluationAt, releaseEvidence, extraInput),
        pattern,
      );
      await assert.rejects(() => readFile(output), /ENOENT/);
    });
  }
});

test("stale source와 unresolved #8/#9 denominator를 NO_GO gate로 보존한다", async (t) => {
  const stale = await createFixture(t, { evaluationAt: STALE_AT });
  const staleOutput = path.join(stale.temp, "stale");
  await build(stale, staleOutput, STALE_AT);
  const staleFinal = await readJson(path.join(staleOutput, "server-route-bundle-final.json"));
  assert.equal(staleFinal.gates.sourceFreshness.state, "STALE");
  assert.ok(staleFinal.blockers.includes("sourceFreshness:STALE"));

  const incomplete = await createFixture(t, {
    configureInputs: ({ stationLineInput }) => {
      stationLineInput.evidenceRows = stationLineInput.evidenceRows.filter((row) => !(
        row.stationId === "station-a" && row.domain === "FACILITY"
      ));
    },
  });
  const incompleteOutput = path.join(incomplete.temp, "incomplete");
  await build(incomplete, incompleteOutput, FRESH_AT);
  const incompleteFinal = await readJson(path.join(incompleteOutput, "server-route-bundle-final.json"));
  assert.equal(incompleteFinal.gates.stationLineAccessibility.state, "MISSING");
  assert.equal(incompleteFinal.gates.routeEdgeEvaluation.state, "MISSING");
  assert.ok(incompleteFinal.blockers.includes("stationLineAccessibility:MISSING"));
  assert.ok(incompleteFinal.blockers.includes("routeEdgeEvaluation:MISSING"));
  const materialization = await readJson(path.join(incompleteOutput, "station-line-accessibility.json"));
  const evaluation = await readJson(path.join(incompleteOutput, "route-edge-evaluation.json"));
  assert.equal(materialization.stateSummary.MISSING, 1);
  assert.equal(evaluation.denominator.edgeCount, incomplete.routeEdgeInput.routeEdges.length);
  assert.equal(evaluation.stateSummary.MISSING, 1);
});

test("artifact와 candidate identity mismatch는 output 전에 fail closed한다", async (t) => {
  for (const [name, mutate, pattern] of [
    ["component-digest", async (fixture) => {
      const manifest = await readJson(path.join(fixture.artifactRoot, "manifest.signing-input.json"));
      manifest.topologySha256 = "f".repeat(64);
      await writeCanonical(path.join(fixture.artifactRoot, "manifest.signing-input.json"), manifest);
    }, /topology payload digest mismatch/],
    ["station-identity", async (fixture) => {
      fixture.stationLineInput.candidate.stationSetSha256 = "f".repeat(64);
    }, /station set identity mismatch/],
    ["source-identity", async (fixture) => {
      fixture.routeEdgeInput.candidate.sourceSetSha256 = "f".repeat(64);
    }, /source set identity mismatch/],
    ["topology-identity", async (fixture) => {
      fixture.routeEdgeInput.candidate.topologySha256 = "f".repeat(64);
    }, /topology identity mismatch/],
    ["git-identity", async (fixture) => {
      fixture.repositoryGitSha = "f".repeat(40);
    }, /repositoryGitSha does not match repository HEAD/],
    ["bundle-identity", async (fixture) => {
      const provenancePath = path.join(fixture.artifactRoot, "provenance.json");
      const provenance = await readJson(provenancePath);
      provenance.bundleId = "other-bundle";
      await writeCanonical(provenancePath, provenance);
    }, /bundle identity mismatch/],
    ["release-identity", async (fixture) => {
      const compatibilityPath = path.join(fixture.artifactRoot, "compatibility.json");
      const compatibility = await readJson(compatibilityPath);
      compatibility.releaseSequence = 2;
      await writeCanonical(compatibilityPath, compatibility);
    }, /release sequence identity mismatch/],
    ["time-identity", async (fixture) => {
      const provenancePath = path.join(fixture.artifactRoot, "provenance.json");
      const provenance = await readJson(provenancePath);
      provenance.freshUntil = "2026-08-08T07:00:00.000+09:00";
      await writeCanonical(provenancePath, provenance);
    }, /freshUntil identity mismatch/],
    ["missing-file", async (fixture) => {
      await rm(path.join(fixture.artifactRoot, "payload/fare.sqlite.zst"));
    }, /artifact payload file set mismatch/],
    ["extra-file", async (fixture) => {
      await writeFile(path.join(fixture.artifactRoot, "payload/extra.sqlite.zst"), "extra");
    }, /artifact payload file set mismatch/],
    ["empty-file", async (fixture) => {
      await writeFile(path.join(fixture.artifactRoot, "payload/fare.sqlite.zst"), Buffer.alloc(0));
    }, /artifact file must be non-empty/],
    ["symlink-file", async (fixture) => {
      const target = path.join(fixture.temp, "topology-target");
      const source = path.join(fixture.artifactRoot, "payload/topology.sqlite.zst");
      await rename(source, target);
      await symlink(target, source);
    }, /artifact file must be a regular non-symlink/],
  ]) {
    await t.test(name, async () => {
      const fixture = await createFixture(t);
      const output = path.join(fixture.temp, `rejected-${name}`);
      await mutate(fixture);
      await assert.rejects(() => build(fixture, output, FRESH_AT), pattern);
      await assert.rejects(() => readFile(output), /ENOENT/);
      assert.deepEqual((await readdir(fixture.temp)).filter((entry) => entry.startsWith(".server-route-final-")), []);
    });
  }
});

test("occupied output을 교체하지 않고 기존 bytes를 보존한다", async (t) => {
  const fixture = await createFixture(t);
  const output = path.join(fixture.temp, "occupied");
  await writeFile(output, "owner bytes");
  await assert.rejects(() => build(fixture, output, FRESH_AT), /output must not already exist/);
  assert.equal(await readFile(output, "utf8"), "owner bytes");
  const ownerTarget = path.join(fixture.temp, "owner-target");
  const symlinkOutput = path.join(fixture.temp, "occupied-symlink");
  await writeFile(ownerTarget, "owner symlink bytes");
  await symlink(ownerTarget, symlinkOutput);
  await assert.rejects(() => build(fixture, symlinkOutput, FRESH_AT), /output must not already exist/);
  assert.equal(await readFile(ownerTarget, "utf8"), "owner symlink bytes");
  assert.deepEqual((await readdir(fixture.temp)).filter((entry) => entry.startsWith(".server-route-final-")), []);
});

test("standalone CLI도 exact inputs로 같은 FINAL을 생성한다", async (t) => {
  const fixture = await createFixture(t);
  const stationLineInputPath = path.join(fixture.temp, "station-line-input.json");
  const routeEdgeInputPath = path.join(fixture.temp, "route-edge-input.json");
  const output = path.join(fixture.temp, "cli-output");
  await writeFile(stationLineInputPath, canonicalJson(fixture.stationLineInput));
  await writeFile(routeEdgeInputPath, canonicalJson(fixture.routeEdgeInput));

  const result = spawnSync(process.execPath, [
    SCRIPT,
    "--artifact-root", fixture.artifactRoot,
    "--station-line-input", stationLineInputPath,
    "--route-edge-input", routeEdgeInputPath,
    "--repository-git-sha", fixture.repositoryGitSha,
    "--evaluation-at", FRESH_AT,
    "--output", output,
  ], { cwd: fixture.repositoryRoot, encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^NO_GO [a-f0-9]{64}\n$/);
  const final = JSON.parse(await readFile(path.join(output, "server-route-bundle-final.json"), "utf8"));
  assert.doesNotThrow(() => validateServerRouteBundleFinal(final));

  await writeFile(stationLineInputPath, JSON.stringify(fixture.stationLineInput, null, 2));
  const rejectedOutput = path.join(fixture.temp, "noncanonical-cli-output");
  const rejected = spawnSync(process.execPath, [
    SCRIPT,
    "--artifact-root", fixture.artifactRoot,
    "--station-line-input", stationLineInputPath,
    "--route-edge-input", routeEdgeInputPath,
    "--repository-git-sha", fixture.repositoryGitSha,
    "--evaluation-at", FRESH_AT,
    "--output", rejectedOutput,
  ], { cwd: fixture.repositoryRoot, encoding: "utf8" });
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /station-line input must be canonical JSON/);
  await assert.rejects(() => readFile(rejectedOutput), /ENOENT/);
});

test("standalone CLI release mode는 exact evidence set만 받아 GO를 생성한다", async (t) => {
  installSigningEnvironment(t);
  const { fixture, releaseEvidence } = await prepareSignedReleaseFixture(t);
  const clockPath = path.join(fixture.temp, "release-cli-clock.mjs");
  await writeFile(clockPath, `Date.now = () => ${Date.parse(FRESH_AT)};\n`);
  const stationLineInputPath = path.join(fixture.temp, "release-station-line-input.json");
  const routeEdgeInputPath = path.join(fixture.temp, "release-route-edge-input.json");
  await writeFile(stationLineInputPath, canonicalJson(fixture.stationLineInput));
  await writeFile(routeEdgeInputPath, canonicalJson(fixture.routeEdgeInput));
  const output = path.join(fixture.temp, "release-cli-output");
  const baseArgs = [
    SCRIPT,
    "--artifact-root", fixture.artifactRoot,
    "--station-line-input", stationLineInputPath,
    "--route-edge-input", routeEdgeInputPath,
    "--repository-git-sha", fixture.repositoryGitSha,
    "--evaluation-at", FRESH_AT,
    "--output", output,
    "--eligibility-report", releaseEvidence.eligibilityReportPath,
    "--publication-receipt", releaseEvidence.publicationReceiptPath,
    "--promotion-request", releaseEvidence.promotionRequestPath,
    "--promotion-component", releaseEvidence.promotionComponentPath,
    "--promotion-inventory", releaseEvidence.promotionInventoryPath,
    "--compatibility-evidence", releaseEvidence.compatibilityEvidencePath,
    "--rebuild-parity-evidence", releaseEvidence.rebuildParityEvidencePath,
    "--approval-evidence", releaseEvidence.approvalEvidencePath,
    "--promotion-workflow-run-id", releaseEvidence.promotionWorkflowRunId,
  ];
  const result = spawnSync(process.execPath, ["--import", clockPath, ...baseArgs], {
    cwd: fixture.repositoryRoot,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^GO [a-f0-9]{64}\n$/);
  const final = await readJson(path.join(output, "server-route-bundle-final.json"));
  assert.equal(final.result, "GO");

  const rejectedOutput = path.join(fixture.temp, "partial-release-cli-output");
  const partialArgs = baseArgs.slice(0, -2);
  partialArgs[partialArgs.indexOf("--output") + 1] = rejectedOutput;
  const partial = spawnSync(process.execPath, ["--import", clockPath, ...partialArgs], {
    cwd: fixture.repositoryRoot,
    encoding: "utf8",
  });
  assert.equal(partial.status, 1);
  assert.match(partial.stderr, /CLI arguments mismatch/);
  await assert.rejects(() => readFile(rejectedOutput), /ENOENT/);
});

async function createFixture(t, options = {}) {
  const temp = await mkdtemp(path.join(os.tmpdir(), "server-route-final-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const repositoryRoot = path.join(temp, "repository");
  await copyRepositoryInputs(repositoryRoot);
  const policyPath = path.join(repositoryRoot, "release/product-gates/route-edge-evaluation-policy.json");
  const policy = await readJson(policyPath);
  const buildSpec = await readJson(path.join(repositoryRoot, "tools/datapack/release/candidate-build-spec.json"));
  const artifactRoot = path.join(temp, "server-route-bundle");
  const stationLineInput = completeStationLineInput(buildSpec.sourceSnapshotSetHash);
  const routeEdgeInput = completeRouteEdgeInput(
    buildSpec.sourceSnapshotSetHash,
    sha256(Buffer.from("topology payload")),
  );
  options.configureInputs?.({ stationLineInput, routeEdgeInput });
  policy.rideInvariant.subwayLocal.admittedEdgeSetSha256 = canonicalRideEdgeSetSha256(
    routeEdgeInput.routeEdges.filter(({ edgeType, serviceClass, servicePattern }) => edgeType === "RIDE" && serviceClass === "SUBWAY" && servicePattern === "LOCAL"),
  );
  policy.rideInvariant.itxCheongchunExpress.admittedEdgeSetSha256 = canonicalRideEdgeSetSha256(
    routeEdgeInput.routeEdges.filter(({ edgeType, serviceClass }) => edgeType === "RIDE" && serviceClass === "ITX_CHEONGCHUN"),
  );
  await writeFile(policyPath, `${JSON.stringify(policy, null, 2)}\n`);
  const repositoryGitSha = initializeRepository(repositoryRoot);
  const { manifest } = await createArtifact(
    repositoryRoot,
    artifactRoot,
    buildSpec,
    stationLineInput,
    routeEdgeInput,
    options.evaluationAt ?? FRESH_AT,
    options.freshUntil,
  );
  return { temp, repositoryRoot, repositoryGitSha, artifactRoot, buildSpec, manifest, stationLineInput, routeEdgeInput };
}

async function copyRepositoryInputs(repositoryRoot) {
  for (const relative of [
    "contracts/datapack/artifact-component-table-layout.json",
    "contracts/datapack/server-route-bundle-build-contract.json",
    "release/product-gates/datapack-freshness-sla.json",
    "release/product-gates/route-edge-evaluation-policy.json",
    "tools/datapack/release/candidate-build-spec.json",
    "tools/datapack/release/source-snapshots.json",
    "tools/datapack/schema/catalog-schema.sql",
    "tools/datapack/source-governance-policy.json",
    "tools/datapack/source-inventory.json",
  ]) {
    await mkdir(path.dirname(path.join(repositoryRoot, relative)), { recursive: true });
    await cp(relative, path.join(repositoryRoot, relative));
  }
}

async function createArtifact(
  repositoryRoot,
  artifactRoot,
  buildSpec,
  stationLineInput,
  routeEdgeInput,
  evaluationAt,
  freshUntil = "2026-08-15T05:06:04.805+09:00",
) {
  const routePolicy = await readJson(path.join(repositoryRoot, "release/product-gates/route-edge-evaluation-policy.json"));
  const materialization = materializeStationLineAccessibility({ ...stationLineInput, observedAt: evaluationAt });
  const evaluation = evaluateRouteAccessibilityEdges({
    ...routeEdgeInput,
    evaluationAt,
    materialization,
  }, routePolicy);
  await mkdir(artifactRoot, { recursive: true });
  const accessibilitySqlite = path.join(artifactRoot, ".accessibility.sqlite");
  const accessibilityDatabase = new DatabaseSync(accessibilitySqlite);
  accessibilityDatabase.exec(Object.values(GENERATED_ACCESSIBILITY_EVIDENCE_TABLE_DDL).join("; "));
  accessibilityDatabase.prepare("INSERT INTO station_line_accessibility_evidence VALUES(?,?)").run(
    materialization.materializationDigest,
    canonicalStationLineAccessibilityJson(materialization),
  );
  accessibilityDatabase.prepare("INSERT INTO route_accessibility_edge_evidence VALUES(?,?,?)").run(
    evaluation.evaluationDigest,
    materialization.materializationDigest,
    canonicalRouteEdgeEvaluationJson(evaluation),
  );
  accessibilityDatabase.exec("PRAGMA user_version=19; VACUUM");
  accessibilityDatabase.close();
  const buildContract = await readJson(path.join(repositoryRoot, "contracts/datapack/server-route-bundle-build-contract.json"));
  const payloads = {
    accessibility: zstdCompressSync(await readFile(accessibilitySqlite), {
      params: {
        [constants.ZSTD_c_compressionLevel]: buildContract.compressionProfile.compressionLevel,
        [constants.ZSTD_c_checksumFlag]: buildContract.compressionProfile.checksumFlag,
      },
    }),
    fare: Buffer.from("fare payload"),
    timetable: Buffer.from("timetable payload"),
    topology: Buffer.from("topology payload"),
  };
  await mkdir(path.join(artifactRoot, "payload"), { recursive: true });
  for (const [name, bytes] of Object.entries(payloads)) {
    await writeFile(path.join(artifactRoot, `payload/${name}.sqlite.zst`), bytes);
  }
  await rm(accessibilitySqlite);

  const buildSpecBytes = await readFile(path.join(repositoryRoot, "tools/datapack/release/candidate-build-spec.json"));
  const layout = await readJson(path.join(repositoryRoot, "contracts/datapack/artifact-component-table-layout.json"));
  const provenance = {
    schemaVersion: 1,
    artifactKind: "server-route-bundle-provenance",
    bundleId: BUNDLE_ID,
    releaseSequence: 1,
    stationSetSha256: STATION_SET_SHA256,
    serviceTimezone: "Asia/Seoul",
    activeFrom: "2026-08-15T00:34:07.000+09:00",
    freshUntil,
    builtAt: FRESH_AT,
    buildSpecSha256: sha256(buildSpecBytes),
    sourceSnapshotSetHash: buildSpec.sourceSnapshotSetHash,
    sourceInventorySha256: buildSpec.sourceInventorySha256,
    sourceSnapshotIds: [...new Set(buildSpec.sourceSnapshotIds)].sort(bytewise),
  };
  const compatibility = {
    schemaVersion: 1,
    artifactKind: "server-route-bundle-compatibility",
    bundleId: BUNDLE_ID,
    releaseSequence: 1,
    stationSetSha256: STATION_SET_SHA256,
    serviceTimezone: "Asia/Seoul",
    manifestVersion: 1,
    tableLayoutSchemaVersion: layout.schemaVersion,
    sourceSchemaPath: layout.serverRouteBundle.sourceSchema.path,
    sourceSqliteUserVersion: layout.serverRouteBundle.sourceSchema.sqliteUserVersion,
    sourceSchemaSha256: layout.serverRouteBundle.sourceSchema.sha256,
    schemaCompatibility: buildContract.manifestLifecycle.schemaCompatibility,
    compressionProfile: buildContract.compressionProfile,
    encoderRuntime: { node: process.versions.node, zstd: process.versions.zstd },
  };
  const provenanceBytes = Buffer.from(canonicalJson(provenance));
  const compatibilityBytes = Buffer.from(canonicalJson(compatibility));
  await writeFile(path.join(artifactRoot, "provenance.json"), provenanceBytes);
  await writeFile(path.join(artifactRoot, "compatibility.json"), compatibilityBytes);
  const entries = Object.entries(payloads).map(([name, bytes]) => ({
    path: `payload/${name}.sqlite.zst`, sizeBytes: bytes.length, sha256: sha256(bytes),
  })).sort((left, right) => bytewise(left.path, right.path));
  const manifest = {
    manifestVersion: 1,
    artifactKind: "server-route-bundle",
    bundleId: BUNDLE_ID,
    releaseSequence: 1,
    stationSetSha256: STATION_SET_SHA256,
    payloadSha256: sha256(Buffer.from(canonicalJson(entries))),
    topologySha256: sha256(payloads.topology),
    timetableSha256: sha256(payloads.timetable),
    accessibilitySha256: sha256(payloads.accessibility),
    fareSha256: sha256(payloads.fare),
    provenanceSha256: sha256(provenanceBytes),
    compatibilitySha256: sha256(compatibilityBytes),
    serviceTimezone: "Asia/Seoul",
    activeFrom: provenance.activeFrom,
    freshUntil: provenance.freshUntil,
    schemaCompatibility: buildContract.manifestLifecycle.schemaCompatibility,
    keyId: "production-v1",
  };
  await writeCanonical(path.join(artifactRoot, "manifest.signing-input.json"), manifest);
  return { manifest, provenance, compatibility };
}

async function rebindPayloadManifest(artifactRoot) {
  const manifestPath = path.join(artifactRoot, "manifest.signing-input.json");
  const manifest = await readJson(manifestPath);
  const entries = [];
  for (const component of ["accessibility", "fare", "timetable", "topology"]) {
    const bytes = await readFile(path.join(artifactRoot, `payload/${component}.sqlite.zst`));
    const digest = sha256(bytes);
    manifest[`${component}Sha256`] = digest;
    entries.push({ path: `payload/${component}.sqlite.zst`, sizeBytes: bytes.length, sha256: digest });
  }
  manifest.payloadSha256 = sha256(Buffer.from(canonicalJson(entries.sort((left, right) => bytewise(left.path, right.path)))));
  await writeCanonical(manifestPath, manifest);
}

async function mutateAccessibilityPayload(fixture, sql) {
  const accessibilityPath = path.join(fixture.artifactRoot, "payload/accessibility.sqlite.zst");
  const sqlitePath = path.join(fixture.temp, "mutated-accessibility.sqlite");
  await writeFile(sqlitePath, zstdDecompressSync(await readFile(accessibilityPath)));
  const database = new DatabaseSync(sqlitePath);
  database.exec(sql);
  database.close();
  const buildContract = await readJson(path.join(fixture.repositoryRoot, "contracts/datapack/server-route-bundle-build-contract.json"));
  await writeFile(accessibilityPath, zstdCompressSync(await readFile(sqlitePath), {
    params: {
      [constants.ZSTD_c_compressionLevel]: buildContract.compressionProfile.compressionLevel,
      [constants.ZSTD_c_checksumFlag]: buildContract.compressionProfile.checksumFlag,
    },
  }));
  await rebindPayloadManifest(fixture.artifactRoot);
}

function completeStationLineInput(sourceSetSha256) {
  const candidate = {
    candidateId: CANDIDATE_ID,
    stationSetSha256: SCOPED_STATION_SET_SHA256,
    sourceSetSha256,
    mappingContractVersion: "station-line-v1",
    materializerVersion: "1",
  };
  const stationLines = [
    { stationId: "station-a", lineId: "line-1", operatorId: "operator-1" },
    { stationId: "station-b", lineId: "line-1", operatorId: "operator-1" },
  ];
  const evidenceRows = stationLines.flatMap((line) => [
    evidence(candidate, line, "FACILITY", "VERIFIED_PRESENT", "OBSERVED", "official facility"),
    evidence(candidate, line, "EXIT", "VERIFIED_ABSENT", "EXPLICIT_ZERO", "official zero exit"),
    evidence(candidate, line, "TRANSFER", "NOT_APPLICABLE", "CURRENT_APPLICABILITY_RULE", "no transfer boundary"),
  ]);
  return { candidate, stationLines, evidenceRows };
}

function evidence(candidate, line, domain, state, evidenceKind, evidenceReason) {
  return {
    ...candidate,
    ...line,
    domain,
    state,
    sourceId: "official-accessibility",
    sourceSnapshotId: "official-accessibility-20260813",
    evidenceRawSha256: "b".repeat(64),
    providerRecordHash: "c".repeat(64),
    capturedAt: FRESH_AT,
    freshUntil: "2026-08-14T20:06:04.805Z",
    provenanceId: "official-provider",
    licenseId: "public-data-license",
    evidenceKind,
    evidenceReason,
  };
}

function completeRouteEdgeInput(sourceSetSha256, topologySha256) {
  const candidate = {
    candidateId: CANDIDATE_ID,
    stationSetSha256: STATION_SET_SHA256,
    sourceSetSha256,
    topologySha256,
    policyVersion: "route-edge-evaluation-v2",
    evaluatorVersion: "1",
  };
  const stationLines = [
    { stationId: "station-a", lineId: "line-1", operatorId: "operator-1", lineSequence: 1 },
    { stationId: "station-b", lineId: "line-1", operatorId: "operator-1", lineSequence: 2 },
  ];
  return {
    candidate,
    stationLines,
    routeEdges: [
      edge({ edgeId: "entry-a", edgeType: "ENTRY", fromNodeId: "station-a", toNodeId: "station-a:line-1" }),
      edge({ edgeId: "entry-b", edgeType: "ENTRY", fromNodeId: "station-b", toNodeId: "station-b:line-1" }),
      edge({ edgeId: "exit-a", edgeType: "EXIT", fromNodeId: "station-a:line-1", toNodeId: "station-a" }),
      edge({ edgeId: "exit-b", edgeType: "EXIT", fromNodeId: "station-b:line-1", toNodeId: "station-b" }),
      ...Array.from({ length: 2220 }, (_, index) => edge({
        edgeId: `ride-${String(index).padStart(4, "0")}`,
        edgeType: "RIDE",
        fromNodeId: index % 2 === 0 ? "station-a:line-1" : "station-b:line-1",
        toNodeId: index % 2 === 0 ? "station-b:line-1" : "station-a:line-1",
        durationSeconds: 120,
        distanceMeters: 1000,
        servicePattern: "LOCAL",
      })),
    ],
  };
}

function edge(value) {
  const raw = {
    edgeId: value.edgeId,
    edgeType: value.edgeType,
    fromNodeId: value.fromNodeId,
    toNodeId: value.toNodeId,
    durationSeconds: value.durationSeconds ?? 0,
    distanceMeters: value.distanceMeters ?? 0,
    servicePattern: value.servicePattern ?? "",
    serviceClass: value.serviceClass ?? "SUBWAY",
  };
  return { ...raw, edgeSha256: routeEdgeSha256(raw) };
}

async function createReleaseEvidence(fixture, prePublicationFinal) {
  const objectPrefix = `server-route-bundles/v1/${prePublicationFinal.candidate.signedManifestRawSha256}/`;
  const signedPaths = [
    "compatibility.json",
    "manifest.json",
    "manifest.signing-input.json",
    "payload/accessibility.sqlite.zst",
    "payload/fare.sqlite.zst",
    "payload/timetable.sqlite.zst",
    "payload/topology.sqlite.zst",
    "provenance.json",
  ];
  const objects = [];
  for (const entryPath of signedPaths) {
    const bytes = await readFile(path.join(fixture.artifactRoot, entryPath));
    objects.push({
      path: entryPath,
      objectKey: `${objectPrefix}${entryPath}`,
      sizeBytes: bytes.length,
      sha256: sha256(bytes),
    });
  }
  const receiptPayload = {
    schemaVersion: 1,
    artifactKind: "server-route-bundle-publication-receipt",
    repository: {
      name: "AquilaXk/easysubway-data",
      gitSha: fixture.repositoryGitSha,
    },
    candidate: {
      bundleId: prePublicationFinal.candidate.bundleId,
      releaseSequence: prePublicationFinal.candidate.releaseSequence,
      stationSetSha256: prePublicationFinal.candidate.stationSetSha256,
      sourceSnapshotSetHash: prePublicationFinal.candidate.sourceSnapshotSetHash,
      signingInputSha256: prePublicationFinal.candidate.signingInputSha256,
      signedManifestRawSha256: prePublicationFinal.candidate.signedManifestRawSha256,
      payloadRootSha256: prePublicationFinal.candidate.payloadRootSha256,
      componentInventorySha256: prePublicationFinal.candidate.componentInventorySha256,
      componentDigests: prePublicationFinal.candidate.componentDigests,
      activeFrom: prePublicationFinal.candidate.activeFrom,
      freshUntil: prePublicationFinal.candidate.freshUntil,
      keyId: prePublicationFinal.candidate.keyId,
      prePublicationFinalSha256: prePublicationFinal.finalSha256,
    },
    locator: {
      publicBaseUrl: "https://objectstorage.ap-seoul-1.oraclecloud.com/n/easysubway/b/releases/o",
      objectPrefix,
    },
    objects,
  };
  const receipt = {
    ...receiptPayload,
    receiptSha256: sha256(Buffer.from(canonicalJson(receiptPayload))),
  };
  const publicationReceiptPath = path.join(fixture.temp, "publication-receipt.json");
  await writeCanonical(publicationReceiptPath, receipt);

  const inventory = {
    schemaVersion: 1,
    artifactKind: "datapack-candidate-inventory",
    entries: [
      { path: "map-pack/manifest.json", sizeBytes: 1, sha256: "a".repeat(64) },
      ...objects.filter((entry) => entry.path !== "manifest.json").map((entry) => ({
        path: `server-route-bundle/${entry.path}`,
        sizeBytes: entry.sizeBytes,
        sha256: entry.sha256,
      })),
      { path: "station-catalog-pack/manifest.json", sizeBytes: 1, sha256: "b".repeat(64) },
    ].sort((left, right) => bytewise(left.path, right.path)),
  };
  const inventoryBytes = Buffer.from(canonicalJson(inventory));
  const component = {
    schemaVersion: 1,
    component: "data",
    repository: "AquilaXk/easysubway-data",
    gitSha: fixture.repositoryGitSha,
    workflowRunId: "123",
    dataVersion: "1",
    releaseSequence: prePublicationFinal.candidate.releaseSequence,
    manifestSha256: "c".repeat(64),
    provenance: {
      sourceSnapshotSetHash: prePublicationFinal.candidate.sourceSnapshotSetHash,
    },
    artifactInventorySha256: sha256(inventoryBytes),
    contractVersion: "datapack-contract-v3",
    issueRef: "AquilaXk/easysubway#2705",
  };
  const compatibility = {
    schemaVersion: 1,
    artifactKind: "datapack-mobile-compatibility-evidence",
    decision: "PASS",
    candidate: structuredClone(component),
  };
  const compatibilityBytes = Buffer.from(canonicalJson(compatibility));
  const rebuildParity = {
    schemaVersion: 1,
    artifactKind: "datapack-rebuild-parity-evidence",
    selectedCandidateWorkflowRunId: component.workflowRunId,
    candidates: [
      structuredClone(component),
      { ...component, workflowRunId: "234" },
      { ...component, workflowRunId: "345" },
    ],
    artifactInventorySha256: component.artifactInventorySha256,
    contractVersion: "datapack-rebuild-parity-v1",
    issueRef: component.issueRef,
  };
  const rebuildParityBytes = Buffer.from(canonicalJson(rebuildParity));
  const approval = [{
    state: "approved",
    environments: [{ name: "datapack-promotion" }],
    user: { login: "AquilaXk" },
  }];
  const approvalBytes = Buffer.from(canonicalJson(approval));
  const promotionWorkflowRunId = "456";
  const request = {
    schemaVersion: 1,
    artifactKind: "datapack-promotion-request",
    candidate: structuredClone(component),
    compatibilityEvidenceSha256: sha256(compatibilityBytes),
    rebuildParityEvidenceSha256: sha256(rebuildParityBytes),
    requestedBy: "AquilaXk",
    approval: {
      workflowRunId: promotionWorkflowRunId,
      environment: "datapack-promotion",
      reviewer: "AquilaXk",
      approvalEvidenceSha256: sha256(approvalBytes),
    },
    contractVersion: "datapack-promotion-v1",
    issueRef: component.issueRef,
  };

  const paths = {
    promotionRequestPath: path.join(fixture.temp, "promotion-request.json"),
    promotionComponentPath: path.join(fixture.temp, "promotion-component.json"),
    promotionInventoryPath: path.join(fixture.temp, "promotion-inventory.json"),
    compatibilityEvidencePath: path.join(fixture.temp, "compatibility-evidence.json"),
    rebuildParityEvidencePath: path.join(fixture.temp, "rebuild-parity-evidence.json"),
    approvalEvidencePath: path.join(fixture.temp, "promotion-approvals.json"),
  };
  for (const [target, bytes] of [
    [paths.promotionRequestPath, Buffer.from(canonicalJson(request))],
    [paths.promotionComponentPath, Buffer.from(canonicalJson(component))],
    [paths.promotionInventoryPath, inventoryBytes],
    [paths.compatibilityEvidencePath, compatibilityBytes],
    [paths.rebuildParityEvidencePath, rebuildParityBytes],
    [paths.approvalEvidencePath, approvalBytes],
  ]) await writeFile(target, bytes);
  return { publicationReceiptPath, promotionWorkflowRunId, ...paths };
}

async function prepareSignedReleaseFixture(t, options = {}) {
  const fixture = await createFixture(t, options);
  const signedRoot = path.join(fixture.temp, "signed-release-fixture");
  await signServerRouteBundle({ input: fixture.artifactRoot, output: signedRoot });
  fixture.artifactRoot = signedRoot;
  const provisionalOutput = path.join(fixture.temp, "provisional-fixture");
  await build(fixture, provisionalOutput, FRESH_AT);
  const eligibilityReportPath = await createEligibilityReport(
    fixture,
    provisionalOutput,
    "fixture-eligibility.json",
  );
  const prePublicationOutput = path.join(fixture.temp, "pre-publication-fixture");
  await build(fixture, prePublicationOutput, FRESH_AT, undefined, { eligibilityReportPath });
  const prePublicationFinal = await readJson(
    path.join(prePublicationOutput, "server-route-bundle-final.json"),
  );
  return {
    fixture,
    releaseEvidence: {
      ...await createReleaseEvidence(fixture, prePublicationFinal),
      eligibilityReportPath,
    },
  };
}

async function rewriteReceipt(target, mutate) {
  const receipt = await readJson(target);
  delete receipt.receiptSha256;
  mutate(receipt);
  receipt.receiptSha256 = sha256(Buffer.from(canonicalJson(receipt)));
  await writeCanonical(target, receipt);
}

async function rewritePromotionEvidence(releaseEvidence, mutate) {
  const inventory = await readJson(releaseEvidence.promotionInventoryPath);
  const component = await readJson(releaseEvidence.promotionComponentPath);
  await mutate({ inventory, component });
  const inventoryBytes = Buffer.from(canonicalJson(inventory));
  component.artifactInventorySha256 = sha256(inventoryBytes);
  const compatibility = {
    schemaVersion: 1,
    artifactKind: "datapack-mobile-compatibility-evidence",
    decision: "PASS",
    candidate: structuredClone(component),
  };
  const compatibilityBytes = Buffer.from(canonicalJson(compatibility));
  const rebuildParity = {
    schemaVersion: 1,
    artifactKind: "datapack-rebuild-parity-evidence",
    selectedCandidateWorkflowRunId: component.workflowRunId,
    candidates: [
      structuredClone(component),
      { ...component, workflowRunId: "234" },
      { ...component, workflowRunId: "345" },
    ],
    artifactInventorySha256: component.artifactInventorySha256,
    contractVersion: "datapack-rebuild-parity-v1",
    issueRef: component.issueRef,
  };
  const rebuildParityBytes = Buffer.from(canonicalJson(rebuildParity));
  const approvalBytes = await readFile(releaseEvidence.approvalEvidencePath);
  const request = {
    schemaVersion: 1,
    artifactKind: "datapack-promotion-request",
    candidate: structuredClone(component),
    compatibilityEvidenceSha256: sha256(compatibilityBytes),
    rebuildParityEvidenceSha256: sha256(rebuildParityBytes),
    requestedBy: "AquilaXk",
    approval: {
      workflowRunId: releaseEvidence.promotionWorkflowRunId,
      environment: "datapack-promotion",
      reviewer: "AquilaXk",
      approvalEvidenceSha256: sha256(approvalBytes),
    },
    contractVersion: "datapack-promotion-v1",
    issueRef: component.issueRef,
  };
  for (const [target, bytes] of [
    [releaseEvidence.promotionRequestPath, Buffer.from(canonicalJson(request))],
    [releaseEvidence.promotionComponentPath, Buffer.from(canonicalJson(component))],
    [releaseEvidence.promotionInventoryPath, inventoryBytes],
    [releaseEvidence.compatibilityEvidencePath, compatibilityBytes],
    [releaseEvidence.rebuildParityEvidencePath, rebuildParityBytes],
  ]) await writeFile(target, bytes);
}

async function build(fixture, output, evaluationAt, releaseEvidence = undefined, extraInput = {}) {
  const { eligibilityReportPath, ...releaseOnly } = releaseEvidence ?? {};
  return buildServerRouteBundleFinalEvidence({
    repositoryRoot: fixture.repositoryRoot,
    repositoryGitSha: fixture.repositoryGitSha,
    artifactRoot: fixture.artifactRoot,
    stationLineInput: fixture.stationLineInput,
    routeEdgeInput: fixture.routeEdgeInput,
    evaluationAt,
    output,
    ...(releaseEvidence === undefined ? {} : { releaseEvidence: releaseOnly, eligibilityReportPath }),
    ...(releaseEvidence === undefined ? {} : { clock: () => Date.parse(FRESH_AT) }),
    ...extraInput,
  });
}

async function createEligibilityReport(fixture, prepublicationRoot, name) {
  const final = await readJson(path.join(prepublicationRoot, "server-route-bundle-final.json"));
  const station = await readJson(path.join(prepublicationRoot, "station-line-accessibility.json"));
  const route = await readJson(path.join(prepublicationRoot, "route-edge-evaluation.json"));
  const payload = {
    schemaVersion: 1,
    artifactKind: "route-accessibility-eligibility",
    decision: "ELIGIBLE",
    candidate: final.candidate,
    stationLineAccessibility: {
      rowCount: station.rows.length,
      stateSummary: station.stateSummary,
      materializationDigest: station.materializationDigest,
      evidenceSha256: await fileSha(path.join(prepublicationRoot, "station-line-accessibility.json")),
    },
    routeEdgeEvaluation: {
      edgeCount: route.results.length,
      stateSummary: route.stateSummary,
      evaluationDigest: route.evaluationDigest,
      evidenceSha256: await fileSha(path.join(prepublicationRoot, "route-edge-evaluation.json")),
    },
    blockers: [],
  };
  const reportPath = path.join(fixture.temp, name);
  await writeCanonical(reportPath, {
    ...payload,
    eligibilitySha256: sha256(Buffer.from(canonicalJson(payload))),
  });
  return reportPath;
}

function eligibilityInput(fixture, prepublicationRoot, output) {
  return {
    prepublicationRoot,
    artifactRoot: fixture.artifactRoot,
    stationLineInput: path.join(fixture.temp, "eligibility-station-line-input.json"),
    routeEdgeInput: path.join(fixture.temp, "eligibility-route-edge-input.json"),
    repositoryGitSha: fixture.repositoryGitSha,
    evaluationAt: FRESH_AT,
    output,
    repositoryRoot: fixture.repositoryRoot,
  };
}

async function writeEligibilityInputs(fixture) {
  await Promise.all([
    writeCanonical(path.join(fixture.temp, "eligibility-station-line-input.json"), fixture.stationLineInput),
    writeCanonical(path.join(fixture.temp, "eligibility-route-edge-input.json"), fixture.routeEdgeInput),
  ]);
}

function installSigningEnvironment(t) {
  const names = [
    "EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM",
    "EASYSUBWAY_DATAPACK_SIGNING_PUBLIC_KEY_PEM",
    "EASYSUBWAY_DATAPACK_SIGNING_KEY_ID",
  ];
  const before = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  process.env.EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM = signingPrivateKey;
  process.env.EASYSUBWAY_DATAPACK_SIGNING_PUBLIC_KEY_PEM = signingPublicKey;
  process.env.EASYSUBWAY_DATAPACK_SIGNING_KEY_ID = "production-v1";
  t.after(() => {
    for (const name of names) {
      if (before[name] === undefined) delete process.env[name];
      else process.env[name] = before[name];
    }
  });
}

async function writeCanonical(target, value) {
  await writeFile(target, Buffer.from(canonicalJson(value)));
}

async function readJson(target) {
  return JSON.parse(await readFile(target, "utf8"));
}

async function fileSha(target) {
  return sha256(await readFile(target));
}

function bytewise(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function initializeRepository(repositoryRoot) {
  const environment = {
    ...process.env,
    GIT_AUTHOR_DATE: "2026-08-07T00:00:00Z",
    GIT_COMMITTER_DATE: "2026-08-07T00:00:00Z",
  };
  for (const args of [
    ["init", "--quiet"],
    ["add", "."],
    ["-c", "user.name=EasySubway Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "fixture"],
  ]) {
    const result = spawnSync("git", args, { cwd: repositoryRoot, env: environment, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
