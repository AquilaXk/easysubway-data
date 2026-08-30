import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { canonicalCurrentExitAdmissionOciReceiptJson } from "./build-current-exit-admission-oci-receipt.mjs";
import { canonicalExitPathAdmissionJson } from "./build-exit-path-admission.mjs";
import { canonicalJson, sha256 } from "./lib/manifest-validation.mjs";
import {
  buildReboundCurrentExitAdmissionIdentities,
  buildReboundCurrentExitAdmissionIdentitiesFromRepository,
  applyReboundCurrentExitAdmissionIdentities,
} from "./rebind-current-exit-admission-identities.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const EXIT_DIRECTORY = "tools/datapack/release/current-exit-admission-v2";

test("rebinds only EXIT candidate identities to the canonical v2 transition boundary", async () => {
  const transitionBytes = await bytes("tools/datapack/release/current-capital-accessibility-transition.json");
  const normalizedBytes = await bytes(`${EXIT_DIRECTORY}/exit-path-normalized-source-snapshot.json`);
  const admissionBytes = await bytes(`${EXIT_DIRECTORY}/exit-path-source-admission.json`);
  const receiptBytes = await bytes(`${EXIT_DIRECTORY}/exit-path-admission-oci-receipt.json`);
  const result = buildReboundCurrentExitAdmissionIdentities({ transitionBytes, normalizedBytes, admissionBytes, receiptBytes });
  const transition = JSON.parse(transitionBytes);
  const beforeAdmission = JSON.parse(admissionBytes);
  const afterAdmission = JSON.parse(result.admissionBytes);
  const beforeReceipt = JSON.parse(receiptBytes);
  const afterReceipt = JSON.parse(result.receiptBytes);

  assert.equal(afterAdmission.candidate.candidateId, transition.nextCandidate.candidateId);
  assert.equal(afterAdmission.candidate.sourceSetSha256, transition.previousCandidate.sourceSnapshotSetHash);
  for (const rows of [afterAdmission.cells, afterAdmission.materializerEvidenceRows]) {
    assert.ok(rows.length > 0);
    assert.ok(rows.every((row) => row.candidateId === transition.nextCandidate.candidateId));
    assert.ok(rows.every((row) => row.sourceSetSha256 === transition.previousCandidate.sourceSnapshotSetHash));
  }
  assert.equal(canonicalExitPathAdmissionJson(afterAdmission), result.admissionBytes.toString("utf8"));
  assert.equal(canonicalCurrentExitAdmissionOciReceiptJson(afterReceipt), result.receiptBytes.toString("utf8").slice(0, -1));
  assert.equal(result.receiptBytes.at(-1), 0x0a);
  assert.equal(afterReceipt.normalizedSnapshotSha256, sha256(normalizedBytes));
  assert.equal(afterReceipt.admissionSha256, sha256(result.admissionBytes));
  assert.equal(afterReceipt.admissionDigest, afterAdmission.admissionDigest);
  assert.equal(canonicalJson(stripAdmission(beforeAdmission)), canonicalJson(stripAdmission(afterAdmission)));
  assert.equal(canonicalJson(stripReceipt(beforeReceipt)), canonicalJson(stripReceipt(afterReceipt)));

  const fromRepository = await buildReboundCurrentExitAdmissionIdentitiesFromRepository({ repositoryRoot: ROOT });
  assert.deepEqual(fromRepository, result);
});

test("rejects an EXIT OCI receipt that is not bound to the starting admission bytes", async () => {
  const transitionBytes = await bytes("tools/datapack/release/current-capital-accessibility-transition.json");
  const normalizedBytes = await bytes(`${EXIT_DIRECTORY}/exit-path-normalized-source-snapshot.json`);
  const admissionBytes = await bytes(`${EXIT_DIRECTORY}/exit-path-source-admission.json`);
  const receipt = JSON.parse(await bytes(`${EXIT_DIRECTORY}/exit-path-admission-oci-receipt.json`));
  receipt.admissionSha256 = "0".repeat(64);
  const { receiptSha256: _ignored, ...payload } = receipt;
  receipt.receiptSha256 = sha256(Buffer.from(canonicalJson(payload)));
  assert.throws(
    () => buildReboundCurrentExitAdmissionIdentities({
      transitionBytes,
      normalizedBytes,
      admissionBytes,
      receiptBytes: Buffer.from(`${canonicalCurrentExitAdmissionOciReceiptJson(receipt)}\n`),
    }),
    /starting EXIT OCI receipt binding mismatch/,
  );
});

test("applies exact EXIT identity bytes in an isolated repository", async (t) => {
  const repositoryRoot = await temporaryRepository(t);
  const beforeAdmission = await readFile(path.join(repositoryRoot, `${EXIT_DIRECTORY}/exit-path-source-admission.json`));
  const beforeReceipt = await readFile(path.join(repositoryRoot, `${EXIT_DIRECTORY}/exit-path-admission-oci-receipt.json`));
  const expected = await buildReboundCurrentExitAdmissionIdentitiesFromRepository({ repositoryRoot });
  let committed = false;
  const applied = await applyReboundCurrentExitAdmissionIdentities({
    repositoryRoot,
    beforeCommit: async () => { committed = true; },
  });

  assert.equal(committed, true);
  assert.deepEqual(applied.admission.bytes, expected.admissionBytes);
  assert.deepEqual(applied.receipt.bytes, expected.receiptBytes);
  assert.notDeepEqual(applied.admission.bytes, beforeAdmission);
  assert.notDeepEqual(applied.receipt.bytes, beforeReceipt);
});

test("rolls back exact originals when a post-replacement failure is injected", async (t) => {
  const repositoryRoot = await temporaryRepository(t);
  const admissionPath = path.join(repositoryRoot, `${EXIT_DIRECTORY}/exit-path-source-admission.json`);
  const receiptPath = path.join(repositoryRoot, `${EXIT_DIRECTORY}/exit-path-admission-oci-receipt.json`);
  const originals = await Promise.all([readFile(admissionPath), readFile(receiptPath)]);

  await assert.rejects(
    applyReboundCurrentExitAdmissionIdentities({
      repositoryRoot,
      failAfter: async ({ stage }) => {
        if (stage === "receipt") throw new Error("injected post-replacement failure");
      },
    }),
    /injected post-replacement failure/,
  );
  assert.deepEqual(await readFile(admissionPath), originals[0]);
  assert.deepEqual(await readFile(receiptPath), originals[1]);
});

test("reclaims a dead owner lock to recover PREPARED residue but rejects a live owner", async (t) => {
  const repositoryRoot = await temporaryRepository(t);
  const admissionPath = path.join(repositoryRoot, `${EXIT_DIRECTORY}/exit-path-source-admission.json`);
  const lockDirectory = path.join(repositoryRoot, `${EXIT_DIRECTORY}/.exit-admission-identity-rebind.lock`);
  const originalAdmission = await readFile(admissionPath);
  await assert.rejects(
    applyReboundCurrentExitAdmissionIdentities({
      repositoryRoot,
      crashAfter: async ({ stage }) => stage === "admission",
    }),
    /interrupted with recovery journal/,
  );
  await mkdir(lockDirectory, { mode: 0o700 });
  await writeFile(path.join(lockDirectory, "owner.json"), JSON.stringify({
    token: "00000000-0000-4000-8000-000000000000", pid: 99999999,
  }));
  let recoveredBeforeCommit = false;
  await applyReboundCurrentExitAdmissionIdentities({
    repositoryRoot,
    beforeCommit: async () => {
      recoveredBeforeCommit = true;
      assert.deepEqual(await readFile(admissionPath), originalAdmission);
    },
  });
  assert.equal(recoveredBeforeCommit, true);
  await mkdir(lockDirectory, { mode: 0o700 });
  await writeFile(path.join(lockDirectory, "owner.json"), JSON.stringify({
    token: "00000000-0000-4000-8000-000000000001", pid: process.pid,
  }));
  await assert.rejects(
    applyReboundCurrentExitAdmissionIdentities({ repositoryRoot }),
    /lock owner is live/,
  );
});

test("retains recovery evidence when a crash residue has foreign output bytes", async (t) => {
  const repositoryRoot = await temporaryRepository(t);
  const admissionPath = path.join(repositoryRoot, `${EXIT_DIRECTORY}/exit-path-source-admission.json`);
  const journalPath = path.join(repositoryRoot, `${EXIT_DIRECTORY}/.exit-admission-identity-rebind.journal.json`);
  await assert.rejects(
    applyReboundCurrentExitAdmissionIdentities({
      repositoryRoot,
      crashAfter: async ({ stage }) => stage === "admission",
    }),
    /interrupted with recovery journal/,
  );
  await writeFile(admissionPath, Buffer.from("foreign output"));
  await assert.rejects(
    applyReboundCurrentExitAdmissionIdentities({ repositoryRoot }),
    /foreign output bytes; recovery refused/,
  );
  assert.ok((await readFile(journalPath)).length > 0);
});

test("rejects transition dependency replacement before durable journal creation", async (t) => {
  const repositoryRoot = await temporaryRepository(t);
  const candidatePath = path.join(repositoryRoot, "tools/datapack/release/candidate-build-spec.json");
  const journalPath = path.join(repositoryRoot, `${EXIT_DIRECTORY}/.exit-admission-identity-rebind.journal.json`);
  const candidate = await readFile(candidatePath);
  await assert.rejects(
    applyReboundCurrentExitAdmissionIdentities({
      repositoryRoot,
      beforeCommit: async () => writeFile(candidatePath, Buffer.concat([candidate, Buffer.from(" ")])),
    }),
    /transition candidate changed during EXIT identity rebind/,
  );
  await assert.rejects(readFile(journalPath), { code: "ENOENT" });
});

async function bytes(relative) { return readFile(path.join(ROOT, relative)); }
async function temporaryRepository(t) {
  const repositoryRoot = await mkdtemp(path.join(os.tmpdir(), "easysubway-exit-rebind-"));
  t.after(() => rm(repositoryRoot, { recursive: true, force: true }));
  const files = [
    "tools/datapack/release/candidate-build-spec.json",
    "tools/datapack/release/current-station-line-accessibility/station-line-input.json",
    "tools/datapack/release/current-capital-facility-source-admission.json",
    "tools/datapack/source-inventory.json",
    "tools/datapack/release/source-snapshots.json",
    "tools/datapack/release/current-capital-accessibility-transition.json",
    `${EXIT_DIRECTORY}/exit-path-normalized-source-snapshot.json`,
    `${EXIT_DIRECTORY}/exit-path-source-admission.json`,
    `${EXIT_DIRECTORY}/exit-path-admission-oci-receipt.json`,
  ];
  await Promise.all(files.map(async (relative) => {
    const destination = path.join(repositoryRoot, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(path.join(ROOT, relative), destination, { recursive: false, force: false });
  }));
  return repositoryRoot;
}
function stripAdmission(value) {
  const copy = structuredClone(value);
  delete copy.admissionDigest;
  copy.candidate.candidateId = "";
  copy.candidate.sourceSetSha256 = "";
  for (const rows of [copy.cells, copy.materializerEvidenceRows]) {
    for (const row of rows) {
      row.candidateId = "";
      row.sourceSetSha256 = "";
    }
  }
  return copy;
}
function stripReceipt(value) {
  const copy = structuredClone(value);
  delete copy.admissionSha256;
  delete copy.admissionDigest;
  delete copy.receiptSha256;
  return copy;
}
