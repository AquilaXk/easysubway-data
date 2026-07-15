import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, createPublicKey, generateKeyPairSync } from "node:crypto";
import { chmod, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  buildPurgePlan,
  deleteExpiredItems,
  recordPurgeFailure,
} from "./purge-expired-source-raw.mjs";
import { verifyPurgeAttestation } from "./source-raw-purge-attestation.mjs";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "../..");
const evaluationAt = new Date().toISOString();
const purgeAttestationPrivateKey = generateKeyPairSync("ed25519").privateKey
  .export({ type: "pkcs8", format: "pem" });

test("만료 raw만 삭제하고 active·rollback·legal hold 원본은 보존하며 재실행은 idempotent하다", async () => {
  await withFixture(async ({ baseUrl, objects, requests, workDir }) => {
    const files = await writeInputs(workDir, [
      rawEntry("expired", "raw/expired.json"),
      rawEntry("active", "raw/active.json", { protectedBy: ["ACTIVE_RELEASE"] }),
      rawEntry("rollback", "raw/rollback.json", { protectedBy: ["ROLLBACK_WINDOW"] }),
      rawEntry("legal-hold", "raw/legal-hold.json", { legalHold: legalHold("legal-hold") }),
    ]);
    for (const key of ["raw/expired.json", "raw/active.json", "raw/rollback.json", "raw/legal-hold.json"]) {
      objects.add(`/${key}`);
    }

    const first = await runPurge({ ...files, baseUrl, output: path.join(workDir, "first.json") });
    assert.deepEqual(first.deleted.map((entry) => entry.snapshotId), ["expired"]);
    assert.deepEqual(first.protected.map((entry) => entry.snapshotId), ["active", "legal-hold", "rollback"]);
    assert.deepEqual(first.protected.map((entry) => entry.protectedBy), [
      ["ACTIVE_RELEASE"],
      [],
      ["ROLLBACK_WINDOW"],
    ]);
    assert.equal(
      first.protected.find((entry) => entry.snapshotId === "legal-hold").legalHold.reasonCode,
      "REGULATORY_AUDIT",
    );
    assert.deepEqual(requests, ["/raw/expired.json"]);
    assert.equal(objects.has("/raw/expired.json"), false);
    assert.equal(objects.has("/raw/active.json"), true);
    assert.equal(objects.has("/raw/rollback.json"), true);
    assert.equal(objects.has("/raw/legal-hold.json"), true);

    const second = await runPurge({ ...files, baseUrl, output: path.join(workDir, "second.json") });
    assert.deepEqual(second.alreadyAbsent.map((entry) => entry.snapshotId), ["expired"]);
    assert.deepEqual(requests, ["/raw/expired.json"]);
  });
});

test("dry-run은 만료 raw를 계획하지만 DELETE하지 않는다", async () => {
  await withFixture(async ({ baseUrl, objects, requests, workDir }) => {
    const files = await writeInputs(workDir, [rawEntry("expired", "raw/expired.json")]);
    objects.add("/raw/expired.json");

    const report = await runPurge({
      ...files,
      baseUrl,
      output: path.join(workDir, "dry-run.json"),
      dryRun: true,
    });

    assert.deepEqual(report.wouldDelete.map((entry) => entry.snapshotId), ["expired"]);
    assert.deepEqual(requests, []);
    assert.equal(objects.has("/raw/expired.json"), true);
  });
});

test("실제 DELETE는 CLI 인자가 아닌 env-injected preauthenticated base URL을 요구한다", async () => {
  await withFixture(async ({ baseUrl, requests, workDir }) => {
    const files = await writeInputs(workDir, [rawEntry("expired", "raw/expired.json")]);

    await assert.rejects(
      runPurge({ ...files, baseUrl, output: path.join(workDir, "unauthenticated.json"), authenticated: false }),
      /preauthenticated base URL environment variable/,
    );
    assert.deepEqual(requests, []);
  });
});

test("실제 DELETE는 report output을 열 수 없으면 객체 요청 전에 거부한다", async () => {
  await withFixture(async ({ baseUrl, objects, requests, workDir }) => {
    const files = await writeInputs(workDir, [rawEntry("expired", "raw/expired.json")]);
    objects.add("/raw/expired.json");
    const parentFile = path.join(workDir, "not-a-directory");
    await writeFile(parentFile, "occupied\n");

    await assert.rejects(
      runPurge({
        ...files,
        baseUrl,
        output: path.join(parentFile, "purge-report.json"),
      }),
      /EEXIST|ENOTDIR|not a directory/,
    );
    assert.deepEqual(requests, []);
    assert.equal(objects.has("/raw/expired.json"), true);
  });
});

test("실제 DELETE는 기존 report 파일이나 symbolic link를 덮어쓰지 않는다", async () => {
  await withFixture(async ({ baseUrl, objects, requests, workDir }) => {
    const files = await writeInputs(workDir, [rawEntry("expired", "raw/expired.json")]);
    objects.add("/raw/expired.json");
    const existing = path.join(workDir, "existing.json");
    const victim = path.join(workDir, "victim.txt");
    const linked = path.join(workDir, "linked.json");
    await writeFile(existing, "existing\n");
    await chmod(existing, 0o644);
    await writeFile(victim, "do-not-truncate\n");
    await symlink(victim, linked);

    for (const output of [existing, linked]) {
      await assert.rejects(
        runPurge({ ...files, baseUrl, output }),
        /EEXIST|ELOOP|purge report output/i,
      );
    }
    assert.equal(await readFile(existing, "utf8"), "existing\n");
    assert.equal(await readFile(victim, "utf8"), "do-not-truncate\n");
    assert.deepEqual(requests, []);
    assert.equal(objects.has("/raw/expired.json"), true);
  });
});

test("DELETE 직전 report에는 fsync 대상 sanitized intent가 기록된다", async () => {
  await withFixture(async ({ baseUrl, deleteHooks, objects, workDir }) => {
    const files = await writeInputs(workDir, [rawEntry("expired", "raw/secret-object.json")]);
    objects.add("/raw/secret-object.json");
    const output = path.join(workDir, "journaled.json");
    deleteHooks.push(async () => {
      const journal = (await readFile(`${output}.journal`, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.deepEqual(journal.map((entry) => entry.event), ["PLAN", "DELETE_INTENT"]);
      assert.deepEqual(journal[0].deleteCandidates.map((entry) => entry.snapshotId), ["expired"]);
      assert.equal(journal[1].item.snapshotId, "expired");
      assert.doesNotMatch(JSON.stringify(journal), /secret-object|objectUrl|objectKey/i);
    });

    const report = await runPurge({ ...files, baseUrl, output });

    assert.equal(report.decision, "PASS");
    assert.match(report.auditJournalSha256, /^[0-9a-f]{64}$/);
    assert.equal(report.auditJournalRecordCount, 3);
    assert.equal(report.attestation.algorithm, "Ed25519");
    assert.match(report.attestation.signature, /^[A-Za-z0-9+/]+=*$/);
  });
});

test("GET 뒤 authoritative ledger가 보호 상태로 바뀌면 DELETE를 중단한다", async () => {
  await withFixture(async ({ baseUrl, getHooks, objects, requests, workDir }) => {
    const files = await writeInputs(workDir, [rawEntry("expired", "raw/expired.json")]);
    objects.add("/raw/expired.json");
    getHooks.push(async () => {
      const ledger = JSON.parse(await readFile(files.ledger, "utf8"));
      ledger.entries[0].protectedBy = ["ACTIVE_RELEASE"];
      await writeFile(files.ledger, `${JSON.stringify(ledger, null, 2)}\n`);
    });

    await assert.rejects(
      runPurge({
        ...files,
        baseUrl,
        output: path.join(workDir, "protection-changed.json"),
      }),
      /ledger sha256 mismatch|protection changed/i,
    );
    assert.deepEqual(requests, []);
    assert.equal(objects.has("/raw/expired.json"), true);
  });
});

test("여러 DELETE 중 보호 재검증이 실패해도 완료 결과를 hash-bound FAIL report로 남긴다", async () => {
  await withFixture(async ({ baseUrl, getHooks, objects, requests, workDir }) => {
    const files = await writeInputs(workDir, [
      rawEntry("first", "raw/first.json"),
      rawEntry("second", "raw/second.json"),
    ]);
    objects.add("/raw/first.json");
    objects.add("/raw/second.json");
    let getCount = 0;
    getHooks.push(async () => {
      getCount += 1;
      if (getCount !== 2) return;
      const ledger = JSON.parse(await readFile(files.ledger, "utf8"));
      ledger.entries.find((entry) => entry.snapshotId === "second").protectedBy = ["ACTIVE_RELEASE"];
      await writeFile(files.ledger, `${JSON.stringify(ledger, null, 2)}\n`);
    });
    const output = path.join(workDir, "partial-failure.json");

    await assert.rejects(
      runPurge({ ...files, baseUrl, output }),
      /ledger sha256 mismatch|protection changed/i,
    );

    const report = JSON.parse(await readFile(output, "utf8"));
    assert.equal(report.decision, "FAIL");
    assert.match(report.completedAt, /Z$/);
    assert.deepEqual(report.deleted.map((entry) => entry.snapshotId), ["first"]);
    assert.deepEqual(report.failed.map((entry) => entry.snapshotId), ["second"]);
    assert.deepEqual(report.reasonCodes, ["RAW_RETENTION_OVERDUE"]);
    assert.equal(
      report.reportSha256,
      sha256(JSON.stringify({ ...report, reportSha256: undefined })),
    );
    assert.equal(report.auditJournalSha256, sha256(await readFile(`${output}.journal`)));
    assert.deepEqual(requests, ["/raw/first.json"]);
    assert.equal(objects.has("/raw/first.json"), false);
    assert.equal(objects.has("/raw/second.json"), true);
  });
});

test("실제 DELETE는 env-injected snapshot evidence hash로 승인 bytes를 고정한다", async () => {
  await withFixture(async ({ baseUrl, objects, requests, workDir }) => {
    const files = await writeInputs(workDir, [rawEntry("expired", "raw/expired.json")]);
    objects.add("/raw/expired.json");

    await assert.rejects(
      runPurge({
        ...files,
        baseUrl,
        output: path.join(workDir, "untrusted-evidence.json"),
        trustedSnapshots: false,
      }),
      /snapshot evidence sha256 environment variable/,
    );
    assert.deepEqual(requests, []);
    assert.equal(objects.has("/raw/expired.json"), true);
  });
});

test("실제 DELETE는 보호 상태를 포함한 retention ledger hash를 고정한다", async () => {
  await withFixture(async ({ baseUrl, objects, requests, workDir }) => {
    const files = await writeInputs(workDir, [rawEntry("expired", "raw/expired.json")]);
    objects.add("/raw/expired.json");

    await assert.rejects(
      runPurge({
        ...files,
        baseUrl,
        output: path.join(workDir, "untrusted-ledger.json"),
        trustedLedger: false,
      }),
      /ledger sha256 environment variable/,
    );
    assert.deepEqual(requests, []);
    assert.equal(objects.has("/raw/expired.json"), true);
  });
});

test("snapshot storage authority가 승인된 DELETE target과 다르면 요청 전에 거부한다", async () => {
  await withFixture(async ({ baseUrl, objects, requests, workDir }) => {
    const files = await writeInputs(workDir, [rawEntry("expired", "raw/expired.json")]);
    objects.add("/raw/expired.json");

    await assert.rejects(
      runPurge({
        ...files,
        baseUrl,
        output: path.join(workDir, "wrong-authority.json"),
        sourceAuthority: "s3://different-bucket",
      }),
      /storage authority mismatch/,
    );
    assert.deepEqual(requests, []);
    assert.equal(objects.has("/raw/expired.json"), true);
  });
});

test("실제 DELETE는 system clock보다 미래인 evaluation-at을 요청 전에 거부한다", async () => {
  await withFixture(async ({ baseUrl, objects, requests, workDir }) => {
    const files = await writeInputs(workDir, [rawEntry("expired", "raw/expired.json")]);
    objects.add("/raw/expired.json");

    await assert.rejects(
      runPurge({
        ...files,
        baseUrl,
        output: path.join(workDir, "future-evaluation.json"),
        evaluationAtOverride: "2099-01-01T00:00:00Z",
      }),
      /evaluationAt must not be in the future/,
    );
    assert.deepEqual(requests, []);
    assert.equal(objects.has("/raw/expired.json"), true);
  });
});

test("실제 DELETE는 clock skew 이내라도 미래인 evaluation-at을 요청 전에 거부한다", async () => {
  await withFixture(async ({ baseUrl, objects, requests, workDir }) => {
    const files = await writeInputs(workDir, [rawEntry("expired", "raw/expired.json")]);
    objects.add("/raw/expired.json");

    await assert.rejects(
      runPurge({
        ...files,
        baseUrl,
        output: path.join(workDir, "near-future-evaluation.json"),
        evaluationAtOverride: new Date(Date.now() + 60_000).toISOString(),
      }),
      /evaluationAt must not be in the future/,
    );
    assert.deepEqual(requests, []);
    assert.equal(objects.has("/raw/expired.json"), true);
  });
});

test("실제 DELETE는 5분보다 오래된 protection 판단을 요청 전에 거부한다", async () => {
  await withFixture(async ({ baseUrl, objects, requests, workDir }) => {
    const staleEvaluationAt = new Date(Date.now() - 6 * 60 * 1_000).toISOString();
    const files = await writeInputs(
      workDir,
      [rawEntry("expired", "raw/expired.json")],
      staleEvaluationAt,
    );
    objects.add("/raw/expired.json");

    await assert.rejects(
      runPurge({
        ...files,
        baseUrl,
        output: path.join(workDir, "stale-evaluation.json"),
        evaluationAtOverride: staleEvaluationAt,
      }),
      /evaluationAt must be recent/,
    );
    assert.deepEqual(requests, []);
    assert.equal(objects.has("/raw/expired.json"), true);
  });
});

test("실제 DELETE는 승인 ledger의 evaluatedAt과 실행 판단 시각을 일치시킨다", async () => {
  await withFixture(async ({ baseUrl, objects, requests, workDir }) => {
    const files = await writeInputs(workDir, [rawEntry("expired", "raw/expired.json")]);
    objects.add("/raw/expired.json");

    await assert.rejects(
      runPurge({
        ...files,
        baseUrl,
        output: path.join(workDir, "mismatched-evaluation.json"),
        evaluationAtOverride: new Date(Date.parse(evaluationAt) - 1_000).toISOString(),
      }),
      /ledger evaluatedAt mismatch/,
    );
    assert.deepEqual(requests, []);
    assert.equal(objects.has("/raw/expired.json"), true);
  });
});

test("snapshot evidence가 ledger에서 누락되면 DELETE 전에 거부한다", async () => {
  await withFixture(async ({ baseUrl, objects, requests, workDir }) => {
    const files = await writeInputs(workDir, [
      rawEntry("included", "raw/included.json"),
      rawEntry("omitted", "raw/omitted.json"),
    ]);
    const ledger = JSON.parse(await readFile(files.ledger, "utf8"));
    ledger.entries = ledger.entries.filter((entry) => entry.snapshotId === "included");
    await writeFile(files.ledger, `${JSON.stringify(ledger, null, 2)}\n`);
    objects.add("/raw/included.json");
    objects.add("/raw/omitted.json");

    await assert.rejects(
      runPurge({ ...files, baseUrl, output: path.join(workDir, "incomplete-ledger.json") }),
      /ledger snapshot set mismatch/,
    );
    assert.deepEqual(requests, []);
    assert.equal(objects.has("/raw/included.json"), true);
    assert.equal(objects.has("/raw/omitted.json"), true);
  });
});

test("서로 다른 governance policy 세대의 entry를 각 원본 policy bytes로 purge한다", async () => {
  await withFixture(async ({ attestationPrivateKey, baseUrl, objects, requests, workDir }) => {
    const first = policyFixture(["source-old"]);
    const second = { ...policyFixture(["source-new"]), policyVersion: "2026-07-16" };
    const policies = await Promise.all([
      writePolicy(workDir, "old", first),
      writePolicy(workDir, "new", second),
    ]);
    const ledger = {
      schemaVersion: 1,
      artifactKind: "source-raw-retention-ledger",
      evaluatedAt: evaluationAt,
      entries: [
        bindPolicy(rawEntry("old", "raw/old.json"), policies[0]),
        bindPolicy(rawEntry("new", "raw/new.json"), policies[1]),
      ],
    };
    const ledgerPath = path.join(workDir, "multi-policy-ledger.json");
    await writeFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
    const snapshots = await writeSnapshotEvidence(workDir, ledger.entries);
    objects.add("/raw/old.json");
    objects.add("/raw/new.json");

    const report = await runPurge({
      ledger: ledgerPath,
      policies: policies.map((entry) => entry.path),
      snapshots,
      attestationPrivateKey,
      baseUrl,
      output: path.join(workDir, "multi-policy.json"),
    });

    assert.deepEqual(report.deleted.map((entry) => entry.snapshotId), ["new", "old"]);
    assert.deepEqual(requests.sort(), ["/raw/new.json", "/raw/old.json"]);
  });
});

test("invalid legal hold가 있으면 전체 plan을 DELETE 전에 거부한다", async () => {
  await withFixture(async ({ baseUrl, objects, requests, workDir }) => {
    const files = await writeInputs(workDir, [
      rawEntry("expired", "raw/expired.json"),
      rawEntry("invalid-hold", "raw/invalid-hold.json", {
        legalHold: { ...legalHold("invalid-hold"), expiresAt: evaluationAt },
      }),
    ]);
    objects.add("/raw/expired.json");
    objects.add("/raw/invalid-hold.json");
    const output = path.join(workDir, "invalid.json");

    await assert.rejects(
      runPurge({ ...files, baseUrl, output }),
      /LEGAL_HOLD_INVALID/,
    );
    assert.deepEqual(requests, []);
    assert.equal(objects.has("/raw/expired.json"), true);
  });
});

test("legal hold report는 검증된 metadata만 기록한다", async () => {
  await withFixture(async ({ baseUrl, workDir }) => {
    const files = await writeInputs(workDir, [
      rawEntry("legal-hold", "raw/legal-hold.json", {
        legalHold: {
          ...legalHold("legal-hold"),
          requesterNote: "serviceKey=must-not-leak",
        },
      }),
    ]);
    const output = path.join(workDir, "sanitized-legal-hold.json");

    const report = await runPurge({ ...files, baseUrl, output });

    assert.deepEqual(report.protected[0].legalHold, legalHold("legal-hold"));
    assert.doesNotMatch(await readFile(output, "utf8"), /requesterNote|must-not-leak/);
  });
});

test("같은 object key가 만료와 legal hold entry에 중복되면 DELETE 전에 거부한다", async () => {
  await withFixture(async ({ baseUrl, objects, requests, workDir }) => {
    const files = await writeInputs(workDir, [
      rawEntry("expired", "raw/shared.json"),
      rawEntry("legal-hold", "raw/shared.json", { legalHold: legalHold("legal-hold") }),
    ]);
    objects.add("/raw/shared.json");

    await assert.rejects(
      runPurge({ ...files, baseUrl, output: path.join(workDir, "duplicate-object.json") }),
      /duplicate object key/,
    );
    assert.deepEqual(requests, []);
    assert.equal(objects.has("/raw/shared.json"), true);
  });
});

test("ledger object key가 LOCKED snapshot raw URI와 다르면 DELETE 전에 거부한다", async () => {
  await withFixture(async ({ baseUrl, objects, requests, workDir }) => {
    const entry = rawEntry("expired", "raw/active.json");
    const files = await writeInputs(workDir, [entry]);
    const snapshots = await writeSnapshotEvidence(workDir, [entry], {
      expired: "raw/expired.json",
    });
    objects.add("/raw/active.json");

    await assert.rejects(
      runPurge({
        ...files,
        snapshots,
        baseUrl,
        output: path.join(workDir, "mismatched-object.json"),
      }),
      /snapshot evidence mismatch/,
    );
    assert.deepEqual(requests, []);
    assert.equal(objects.has("/raw/active.json"), true);
  });
});

test("ledger는 LOCKED snapshot에 저장된 retention policy binding과 정확히 일치해야 한다", async () => {
  await withFixture(async ({ baseUrl, requests, workDir }) => {
    const files = await writeInputs(workDir, [rawEntry("bound", "raw/bound.json")]);
    const original = JSON.parse(await readFile(files.snapshots, "utf8"));
    const cases = [
      (snapshot) => { snapshot.rawRetentionExpiresAt = "2026-07-16T00:00:00.000Z"; },
      (snapshot) => { snapshot.governancePolicyVersion = "2026-07-14"; },
      (snapshot) => { snapshot.governancePolicySha256 = "f".repeat(64); },
      (snapshot) => {
        snapshot.rawRetentionExpiresAt = "2026-07-16T00:00:00.000Z";
        delete snapshot.governancePolicyVersion;
        delete snapshot.governancePolicySha256;
      },
    ];

    for (const [index, mutate] of cases.entries()) {
      const snapshots = structuredClone(original);
      mutate(snapshots[0]);
      await writeFile(files.snapshots, `${JSON.stringify(snapshots, null, 2)}\n`);
      await assert.rejects(
        runPurge({
          ...files,
          baseUrl,
          output: path.join(workDir, `retention-binding-${index}.json`),
        }),
        /snapshot evidence mismatch/,
      );
    }
    assert.deepEqual(requests, []);
  });
});

test("legacy snapshot은 저장된 retention expiry가 ledger와 같은 경우에만 purge한다", async () => {
  await withFixture(async ({ baseUrl, objects, requests, workDir }) => {
    const files = await writeInputs(workDir, [rawEntry("legacy", "raw/legacy.json")]);
    const snapshots = JSON.parse(await readFile(files.snapshots, "utf8"));
    delete snapshots[0].governancePolicyVersion;
    delete snapshots[0].governancePolicySha256;
    await writeFile(files.snapshots, `${JSON.stringify(snapshots, null, 2)}\n`);
    objects.add("/raw/legacy.json");

    const report = await runPurge({
      ...files,
      baseUrl,
      output: path.join(workDir, "legacy-retention-binding.json"),
    });

    assert.deepEqual(report.deleted.map((entry) => entry.snapshotId), ["legacy"]);
    assert.deepEqual(requests, ["/raw/legacy.json"]);
  });
});

test("exact-hash 승인 legacy snapshot은 현행 policy로 파생한 retention expiry를 적용한다", async () => {
  const [snapshot] = JSON.parse(await readFile(path.join(root, "tools/datapack/release/source-snapshots.json"), "utf8"));
  const policyText = await readFile(path.join(root, "tools/datapack/source-governance-policy.json"), "utf8");
  const policy = JSON.parse(policyText);
  const rawRetentionExpiresAt = "2026-10-10T00:00:00.000Z";
  const objectKey = new URL(snapshot.rawObjectUri).pathname.slice(1);
  const ledger = {
    schemaVersion: 1,
    artifactKind: "source-raw-retention-ledger",
    evaluatedAt: "2026-10-11T00:00:00.000Z",
    entries: [{
      sourceId: snapshot.sourceId,
      snapshotId: snapshot.snapshotId,
      retrievedAt: snapshot.retrievedAt,
      rawRetentionExpiresAt,
      rawSha256: snapshot.rawSha256,
      objectKey,
      protectedBy: [],
      legalHold: null,
      governancePolicyVersion: policy.policyVersion,
      governancePolicySha256: sha256(policyText),
    }],
  };

  const plan = buildPurgePlan({
    ledger,
    snapshots: [snapshot],
    policyFiles: [{ policy, sha256: sha256(policyText) }],
    evaluationAt: ledger.evaluatedAt,
    evaluatedMillis: Date.parse(ledger.evaluatedAt),
    baseUrl: new URL("https://objects.example.invalid/authorized/"),
    sourceAuthority: "s3://easysubway-datapack-sources",
  });

  assert.equal(snapshot.rawRetentionExpiresAt, "2099-10-01T00:00:00Z");
  assert.deepEqual(plan.map(({ snapshotId, disposition }) => ({ snapshotId, disposition })), [{
    snapshotId: snapshot.snapshotId,
    disposition: "DELETE",
  }]);

  const tamperedSnapshot = { ...snapshot, provider: `${snapshot.provider}-tampered` };
  assert.throws(() => buildPurgePlan({
    ledger,
    snapshots: [tamperedSnapshot],
    policyFiles: [{ policy, sha256: sha256(policyText) }],
    evaluationAt: ledger.evaluatedAt,
    evaluatedMillis: Date.parse(ledger.evaluatedAt),
    baseUrl: new URL("https://objects.example.invalid/authorized/"),
    sourceAuthority: "s3://easysubway-datapack-sources",
  }), /snapshot evidence mismatch/);

  const unapprovedPolicy = { ...policy, policyVersion: "2026-07-16" };
  const unapprovedPolicyText = `${JSON.stringify(unapprovedPolicy, null, 2)}\n`;
  const unapprovedLedger = structuredClone(ledger);
  unapprovedLedger.entries[0].governancePolicyVersion = unapprovedPolicy.policyVersion;
  unapprovedLedger.entries[0].governancePolicySha256 = sha256(unapprovedPolicyText);
  assert.throws(() => buildPurgePlan({
    ledger: unapprovedLedger,
    snapshots: [snapshot],
    policyFiles: [{ policy: unapprovedPolicy, sha256: sha256(unapprovedPolicyText) }],
    evaluationAt: ledger.evaluatedAt,
    evaluatedMillis: Date.parse(ledger.evaluatedAt),
    baseUrl: new URL("https://objects.example.invalid/authorized/"),
    sourceAuthority: "s3://easysubway-datapack-sources",
  }), /snapshot evidence mismatch/);
});

test("snapshot raw URI의 dot-segment는 URL 정규화 전에 거부한다", async () => {
  await withFixture(async ({ baseUrl, requests, workDir }) => {
    for (const objectKey of ["raw/../victim.json", "raw/%2e%2e/victim.json"]) {
      const entry = rawEntry("dot-segment", "victim.json");
      const files = await writeInputs(workDir, [entry]);
      const snapshots = await writeSnapshotEvidence(workDir, [entry], {
        "dot-segment": objectKey,
      });

      await assert.rejects(
        runPurge({
          ...files,
          snapshots,
          baseUrl,
          output: path.join(workDir, `dot-segment-${encodeURIComponent(objectKey)}.json`),
        }),
        /snapshot evidence/,
      );
    }
    assert.deepEqual(requests, []);
  });
});

test("Unicode와 공백을 포함한 승인 object key도 동일 bytes를 검증해 삭제한다", async () => {
  await withFixture(async ({ baseUrl, objects, requests, workDir }) => {
    const objectKey = "raw/한글 file.json";
    const requestPath = "/raw/%ED%95%9C%EA%B8%80%20file.json";
    const files = await writeInputs(workDir, [rawEntry("unicode", objectKey)]);
    objects.add(requestPath, `/${objectKey}`);

    const report = await runPurge({
      ...files,
      baseUrl,
      output: path.join(workDir, "unicode-object-key.json"),
    });

    assert.deepEqual(report.deleted.map((entry) => entry.snapshotId), ["unicode"]);
    assert.deepEqual(requests, [requestPath]);
    assert.equal(objects.has(requestPath), false);
  });
});

test("DELETE 5xx는 sanitized RAW_RETENTION_OVERDUE evidence를 남기고 실패한다", async () => {
  await withFixture(async ({ baseUrl, objects, requests, workDir, failPaths }) => {
    const files = await writeInputs(workDir, [rawEntry("failed", "raw/failed-secret-name.json")]);
    objects.add("/raw/failed-secret-name.json");
    failPaths.add("/raw/failed-secret-name.json");
    const output = path.join(workDir, "failed.json");

    await assert.rejects(runPurge({ ...files, baseUrl, output }), /RAW_RETENTION_OVERDUE/);
    const reportText = await readFile(output, "utf8");
    const report = JSON.parse(reportText);
    assert.deepEqual(requests, ["/raw/failed-secret-name.json"]);
    assert.deepEqual(report.reasonCodes, ["RAW_RETENTION_OVERDUE"]);
    assert.deepEqual(report.failed.map((entry) => entry.snapshotId), ["failed"]);
    assert.doesNotMatch(reportText, /failed-secret-name|objectKey|baseUrl/i);
  });
});

test("중간 authorization 실패는 나머지 plan을 삭제하지 않고 검증 가능한 실패로 기록한다", async () => {
  await withFixture(async ({ baseUrl, deleteHooks, objects, requests, workDir }) => {
    const files = await writeInputs(workDir, [
      rawEntry("first", "raw/first.json"),
      rawEntry("second", "raw/second.json"),
      rawEntry("third", "raw/third.json"),
    ]);
    for (const key of ["first", "second", "third"]) objects.add(`/raw/${key}.json`);
    const snapshotText = await readFile(files.snapshots, "utf8");
    deleteHooks.push(async () => writeFile(files.snapshots, `${snapshotText}\n`));
    const output = path.join(workDir, "mid-plan-authorization-failure.json");

    await assert.rejects(runPurge({ ...files, baseUrl, output }), /snapshot evidence sha256 mismatch/);

    const report = JSON.parse(await readFile(output, "utf8"));
    const journalText = await readFile(`${output}.journal`, "utf8");
    const ledgerText = await readFile(files.ledger, "utf8");
    const policyText = await readFile(files.policies[0], "utf8");
    const publicKey = createPublicKey(purgeAttestationPrivateKey);
    assert.deepEqual(requests, ["/raw/first.json"]);
    assert.deepEqual(report.deleted.map((entry) => entry.snapshotId), ["first"]);
    assert.deepEqual(report.failed.map((entry) => entry.snapshotId), ["second", "third"]);
    assert.doesNotThrow(() => verifyPurgeAttestation(report, {
      journalText,
      ledgerText,
      snapshotText,
      governancePolicyVersion: "2026-07-15",
      governancePolicySha256: sha256(policyText),
      publicKeyText: publicKey.export({ type: "spki", format: "pem" }),
      trustedPublicKeySha256: sha256(publicKey.export({ type: "spki", format: "der" })),
    }));
  });
});

test("DELETE 202 Accepted는 완료 evidence가 아니라 실패로 기록한다", async () => {
  await withFixture(async ({ baseUrl, objects, requests, workDir, responseStatuses }) => {
    const files = await writeInputs(workDir, [rawEntry("accepted", "raw/accepted.json")]);
    objects.add("/raw/accepted.json");
    responseStatuses.set("/raw/accepted.json", 202);
    const output = path.join(workDir, "accepted.json");

    await assert.rejects(runPurge({ ...files, baseUrl, output }), /RAW_RETENTION_OVERDUE/);
    const report = JSON.parse(await readFile(output, "utf8"));
    assert.deepEqual(requests, ["/raw/accepted.json"]);
    assert.deepEqual(report.deleted, []);
    assert.deepEqual(report.failed.map((entry) => entry.snapshotId), ["accepted"]);
    assert.equal(objects.has("/raw/accepted.json"), true);
  });
});

test("감사 기록 실패는 이미 기록한 DELETE 성공을 failed로 재분류한다", () => {
  const item = {
    sourceId: "source-expired",
    snapshotId: "expired",
    rawSha256: sha256("raw"),
    objectUrl: "https://secret.example.invalid/raw/expired",
  };
  const report = {
    deleted: [{
      sourceId: item.sourceId,
      snapshotId: item.snapshotId,
      rawSha256: item.rawSha256,
    }],
    alreadyAbsent: [],
    failed: [],
  };

  recordPurgeFailure(report, item);

  assert.deepEqual(report.deleted, []);
  assert.deepEqual(report.alreadyAbsent, []);
  assert.deepEqual(report.failed, [{
    sourceId: item.sourceId,
    snapshotId: item.snapshotId,
    rawSha256: item.rawSha256,
  }]);
  assert.doesNotMatch(JSON.stringify(report), /secret\.example\.invalid/);
});

test("DELETE는 최대 4개 동시 실행하고 각 요청에 timeout signal을 건다", async () => {
  let active = 0;
  let maxActive = 0;
  const items = Array.from({ length: 9 }, (_, index) => ({
    snapshotId: `snapshot-${index}`,
    rawSha256: sha256(`raw-${index}`),
    objectUrl: `https://objects.example.invalid/raw/${index}`,
  }));
  const results = await deleteExpiredItems(items, {
    fetchImpl: async (url, options) => {
      const objectUrl = new URL(url);
      assert.ok(options.signal instanceof AbortSignal);
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      if (options.method === "GET") {
        return new Response(`raw-${objectUrl.pathname.split("/").at(-1)}`, {
          headers: { etag: `"version-${objectUrl.pathname.split("/").at(-1)}"` },
        });
      }
      return new Response(null, { status: 204 });
    },
  });

  assert.equal(maxActive, 4);
  assert.deepEqual(results.map((result) => result.status), Array(9).fill(204));
});

test("원격 raw bytes가 snapshot hash와 다르면 DELETE하지 않는다", async () => {
  const methods = [];
  const [result] = await deleteExpiredItems(
    [{
      snapshotId: "changed",
      rawSha256: sha256("approved-bytes"),
      objectUrl: "https://objects.example.invalid/raw/changed",
    }],
    {
      fetchImpl: async (_url, options) => {
        methods.push(options.method);
        if (options.method === "GET") {
          return new Response("changed-bytes", { headers: { etag: '"changed-version"' } });
        }
        return new Response(null, { status: 204 });
      },
    },
  );

  assert.equal(result.status, 412);
  assert.deepEqual(methods, ["GET"]);
});

test("검증한 원격 ETag를 If-Match로 고정해 DELETE한다", async () => {
  const raw = "approved-bytes";
  const requests = [];
  const [result] = await deleteExpiredItems(
    [{
      snapshotId: "approved",
      rawSha256: sha256(raw),
      objectUrl: "https://objects.example.invalid/raw/approved",
    }],
    {
      fetchImpl: async (_url, options) => {
        requests.push({ method: options.method, ifMatch: options.headers?.["If-Match"] });
        if (options.method === "GET") {
          return new Response(raw, { headers: { etag: '"approved-version"' } });
        }
        return new Response(null, { status: 204 });
      },
    },
  );

  assert.equal(result.status, 204);
  assert.deepEqual(requests, [
    { method: "GET", ifMatch: undefined },
    { method: "DELETE", ifMatch: '"approved-version"' },
  ]);
});

test("보호 근거 deadline이 GET 뒤 만료되면 DELETE하지 않는다", async () => {
  const raw = "approved-bytes";
  const methods = [];
  let now = 1_000;
  const [result] = await deleteExpiredItems(
    [{
      snapshotId: "expired-evidence",
      rawSha256: sha256(raw),
      objectUrl: "https://objects.example.invalid/raw/expired-evidence",
    }],
    {
      executionEvidenceExpiresAt: 2_000,
      now: () => now,
      fetchImpl: async (_url, options) => {
        methods.push(options.method);
        if (options.method === "GET") {
          now = 2_001;
          return new Response(raw, { headers: { etag: '"approved-version"' } });
        }
        return new Response(null, { status: 204 });
      },
    },
  );

  assert.equal(result.status, 0);
  assert.deepEqual(methods, ["GET"]);
});

test("보호 근거 deadline이 최종 보호 재검증 중 만료되면 DELETE하지 않는다", async () => {
  const raw = "approved-bytes";
  const methods = [];
  let now = 1_000;
  const [result] = await deleteExpiredItems(
    [{
      snapshotId: "expired-during-authorization",
      rawSha256: sha256(raw),
      objectUrl: "https://objects.example.invalid/raw/expired-during-authorization",
    }],
    {
      executionEvidenceExpiresAt: 2_000,
      now: () => now,
      beforeDelete: async () => {
        now = 2_001;
      },
      fetchImpl: async (_url, options) => {
        methods.push(options.method);
        if (options.method === "GET") {
          return new Response(raw, { headers: { etag: '"approved-version"' } });
        }
        return new Response(null, { status: 204 });
      },
    },
  );

  assert.equal(result.status, 0);
  assert.deepEqual(methods, ["GET"]);
});

test("보호 근거 deadline이 batch 사이 만료되면 남은 object를 조회하지 않는다", async () => {
  const raw = "approved-bytes";
  const methods = [];
  let now = 1_000;
  const results = await deleteExpiredItems(
    ["first", "second"].map((snapshotId) => ({
      snapshotId,
      rawSha256: sha256(raw),
      objectUrl: `https://objects.example.invalid/raw/${snapshotId}`,
    })),
    {
      concurrency: 1,
      executionEvidenceExpiresAt: 2_000,
      now: () => now,
      fetchImpl: async (url, options) => {
        methods.push(`${options.method}:${new URL(url).pathname}`);
        if (options.method === "GET") {
          return new Response(raw, { headers: { etag: '"approved-version"' } });
        }
        now = 2_001;
        return new Response(null, { status: 204 });
      },
    },
  );

  assert.deepEqual(results.map((result) => result.status), [204, 0]);
  assert.deepEqual(methods, ["GET:/raw/first", "DELETE:/raw/first"]);
});

test("응답 없는 DELETE는 timeout 뒤 실패 상태로 반환한다", async () => {
  const [result] = await deleteExpiredItems(
    [{ snapshotId: "stalled", objectUrl: "https://objects.example.invalid/raw/stalled" }],
    {
      timeoutMs: 5,
      fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
    },
  );

  assert.equal(result.status, 0);
});

async function withFixture(run) {
  const workDir = path.join(tmpdir(), `easysubway-source-purge-${process.pid}-${Date.now()}`);
  const objectBodies = new Map();
  const objects = {
    add(objectPath, body = objectPath) {
      objectBodies.set(objectPath, body);
      return this;
    },
    delete: (objectPath) => objectBodies.delete(objectPath),
    get: (objectPath) => objectBodies.get(objectPath),
    has: (objectPath) => objectBodies.has(objectPath),
  };
  const requests = [];
  const failPaths = new Set();
  const responseStatuses = new Map();
  const getHooks = [];
  const deleteHooks = [];
  await mkdir(workDir, { recursive: true });
  const attestationPrivateKey = path.join(workDir, "fixture-purge-attestation-private.pem");
  await writeFile(attestationPrivateKey, purgeAttestationPrivateKey, { mode: 0o600 });
  const server = createServer(async (request, response) => {
    if (request.method === "GET") {
      if (!objects.has(request.url)) {
        response.writeHead(404).end();
        return;
      }
      const body = objects.get(request.url);
      for (const hook of getHooks) await hook(request.url);
      response.writeHead(200, { etag: `"${sha256(body)}"` }).end(body);
      return;
    }
    if (request.method !== "DELETE") {
      response.writeHead(405).end();
      return;
    }
    for (const hook of deleteHooks) await hook(request.url);
    requests.push(request.url);
    if (responseStatuses.has(request.url)) {
      response.writeHead(responseStatuses.get(request.url)).end();
      return;
    }
    if (failPaths.has(request.url)) {
      response.writeHead(503).end();
      return;
    }
    if (request.headers["if-match"] !== `"${sha256(objects.get(request.url) ?? "")}"`) {
      response.writeHead(412).end();
      return;
    }
    if (!objects.delete(request.url)) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(204).end();
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    await run({
      baseUrl: `http://127.0.0.1:${address.port}/`,
      objects,
      requests,
      failPaths,
      responseStatuses,
      getHooks,
      deleteHooks,
      attestationPrivateKey,
      workDir,
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(workDir, { recursive: true, force: true });
  }
}

async function writeInputs(workDir, entries, ledgerEvaluatedAt = evaluationAt) {
  const policy = policyFixture(entries.map((entry) => entry.sourceId));
  const policyFile = await writePolicy(workDir, "current", policy);
  const ledger = {
    schemaVersion: 1,
    artifactKind: "source-raw-retention-ledger",
    evaluatedAt: ledgerEvaluatedAt,
    entries: entries.map((entry) => ({
      ...entry,
      governancePolicyVersion: policy.policyVersion,
      governancePolicySha256: policyFile.hash,
    })),
  };
  const ledgerPath = path.join(workDir, "ledger.json");
  await writeFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
  const snapshots = await writeSnapshotEvidence(workDir, ledger.entries);
  const attestationPrivateKey = path.join(workDir, "purge-attestation-private.pem");
  await writeFile(attestationPrivateKey, purgeAttestationPrivateKey, { mode: 0o600 });
  return { policies: [policyFile.path], ledger: ledgerPath, snapshots, attestationPrivateKey };
}

async function runPurge({
  ledger,
  policies,
  snapshots,
  baseUrl,
  output,
  dryRun = false,
  authenticated = true,
  trustedSnapshots = true,
  trustedLedger = true,
  sourceAuthority = "s3://easysubway-datapack-sources",
  evaluationAtOverride = evaluationAt,
  attestationPrivateKey,
}) {
  try {
    const snapshotEvidenceSha256 = snapshots && trustedSnapshots
      ? sha256(await readFile(snapshots))
      : "";
    const ledgerSha256 = trustedLedger ? sha256(await readFile(ledger)) : "";
    await execFileAsync(process.execPath, [
      "tools/datapack/purge-expired-source-raw.mjs",
      "--ledger", ledger,
      ...policies.flatMap((policy) => ["--policy", policy]),
      ...(snapshots ? ["--snapshots", snapshots] : []),
      "--evaluation-at", evaluationAtOverride,
      "--output", output,
      ...(dryRun ? [
        "--dry-run",
        "--base-url", baseUrl,
        "--source-authority", sourceAuthority,
      ] : []),
      ...(!dryRun && !authenticated ? ["--base-url", baseUrl] : []),
    ], {
      cwd: root,
      env: {
        ...process.env,
        EASYSUBWAY_SOURCE_RAW_PURGE_PREAUTH_BASE_URL: !dryRun && authenticated ? baseUrl : "",
        EASYSUBWAY_SOURCE_RAW_PURGE_SNAPSHOT_EVIDENCE_SHA256: !dryRun ? snapshotEvidenceSha256 : "",
        EASYSUBWAY_SOURCE_RAW_PURGE_LEDGER_SHA256: !dryRun ? ledgerSha256 : "",
        EASYSUBWAY_SOURCE_RAW_PURGE_OBJECT_AUTHORITY: !dryRun ? sourceAuthority : "",
        EASYSUBWAY_SOURCE_RAW_PURGE_ATTESTATION_PRIVATE_KEY_PATH: !dryRun ? attestationPrivateKey : "",
      },
    });
  } catch (error) {
    const message = `${error.stderr ?? ""}${error.stdout ?? ""}`;
    const wrapped = new Error(message || error.message);
    wrapped.cause = error;
    throw wrapped;
  }
  return JSON.parse(await readFile(output, "utf8"));
}

async function writeSnapshotEvidence(workDir, entries, objectKeyOverrides = {}) {
  const snapshots = entries.map((entry) => ({
    snapshotId: entry.snapshotId,
    sourceId: entry.sourceId,
    snapshotStatus: "LOCKED",
    retrievedAt: entry.retrievedAt,
    rawRetentionExpiresAt: entry.rawRetentionExpiresAt,
    governancePolicyVersion: entry.governancePolicyVersion,
    governancePolicySha256: entry.governancePolicySha256,
    rawSha256: entry.rawSha256,
    rawObjectUri: `s3://easysubway-datapack-sources/${objectKeyOverrides[entry.snapshotId] ?? entry.objectKey}`,
  }));
  const snapshotsPath = path.join(workDir, "source-snapshots.json");
  await writeFile(snapshotsPath, `${JSON.stringify(snapshots, null, 2)}\n`);
  return snapshotsPath;
}

async function writePolicy(workDir, name, policy) {
  const text = `${JSON.stringify(policy, null, 2)}\n`;
  const policyPath = path.join(workDir, `${name}-policy.json`);
  await writeFile(policyPath, text);
  return { path: policyPath, hash: sha256(text), policy };
}

function bindPolicy(entry, policyFile) {
  return {
    ...entry,
    governancePolicyVersion: policyFile.policy.policyVersion,
    governancePolicySha256: policyFile.hash,
  };
}

function rawEntry(snapshotId, objectKey, overrides = {}) {
  return {
    sourceId: `source-${snapshotId}`,
    snapshotId,
    objectKey,
    rawSha256: sha256(`/${objectKey}`),
    retrievedAt: "2026-04-16T00:00:00Z",
    rawRetentionExpiresAt: "2026-07-15T00:00:00.000Z",
    protectedBy: [],
    legalHold: null,
    ...overrides,
  };
}

function legalHold(snapshotId) {
  return {
    sourceId: `source-${snapshotId}`,
    snapshotId,
    ownerRole: "datapack-source-owner",
    reasonCode: "REGULATORY_AUDIT",
    createdAt: "2026-07-01T00:00:00Z",
    expiresAt: "2099-07-20T00:00:00Z",
  };
}

function policyFixture(sourceIds) {
  return {
    schemaVersion: 1,
    artifactKind: "datapack-source-governance-policy",
    policyVersion: "2026-07-15",
    retentionClasses: [{ id: "standard-90d", retentionDays: 90 }],
    sources: sourceIds.map((sourceId) => ({
      sourceId,
      retentionClassId: "standard-90d",
      ownerRole: "datapack-source-owner",
    })),
  };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
