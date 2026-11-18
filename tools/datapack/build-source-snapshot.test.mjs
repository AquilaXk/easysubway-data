import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { execFileAsync } from "./test-fixtures/datapack-tools-support.mjs";
import { fetchSourceSnapshotText } from "./build-source-snapshot.mjs";

const root = path.resolve(import.meta.dirname, "../..");

async function withSnapshotWorkDir(prefix, rawContent, fn) {
  const workDir = path.join(tmpdir(), `easysubway-source-snapshot-${prefix}-${process.pid}-${Date.now()}`);
  const rawPath = path.join(workDir, "raw.csv");
  const outputPath = path.join(workDir, "snapshot.json");
  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });
  await writeFile(rawPath, rawContent);
  try {
    await fn({ workDir, rawPath, outputPath });
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

function runBuildSourceSnapshot(args) {
  return execFileAsync(process.execPath, ["tools/datapack/build-source-snapshot.mjs", ...args], { cwd: root });
}

const PLANNED_TIMETABLE_POLICY = JSON.stringify({
  clockSkewSeconds: 300,
  sourceClasses: [{
    id: "planned_timetable",
    sourceIds: ["planned-a"],
    basisField: "serviceEffectiveAt",
    maximumReverificationCadence: "P30D",
    providerValidityEndField: "serviceEffectiveUntil",
  }],
});

test("source snapshot command는 raw token을 저장 전에 거부한다", async () => {
  await withSnapshotWorkDir("token", "station\nSadang\nserviceKey=secret-token\n", async ({ rawPath, outputPath }) => {
    await assert.rejects(
      runBuildSourceSnapshot([
        "--input", rawPath,
        "--output", outputPath,
        "--snapshot-id", "snapshot-kric-token",
        "--source-id", "kric-station-convenience-standard",
        "--coverage-count", "1",
        "--provider", "국가철도공단",
        "--source-class-id", "static_accessibility_facility",
        "--retrieved-at", "2026-06-30T03:00:00Z",
        "--raw-object-uri", "s3://easysubway-datapack-sources/kric-station-convenience-standard/snapshot-kric-token.json",
        "--freshness-expires-at", "2026-07-07T03:00:00Z",
        "--raw-retention-expires-at", "2026-09-30T03:00:00Z",
      ]),
      /raw snapshot contains credential-like token/,
    );
  });
});

test("source snapshot command는 credential URI와 만료 retention metadata를 거부한다", async () => {
  await withSnapshotWorkDir("policy", "station\nSadang\n", async ({ rawPath, outputPath }) => {
    const baseArgs = [
      "--input", rawPath,
      "--output", outputPath,
      "--snapshot-id", "snapshot-kric-policy",
      "--source-id", "kric-station-convenience-standard",
      "--coverage-count", "1",
      "--provider", "국가철도공단",
      "--source-class-id", "static_accessibility_facility",
      "--retrieved-at", "2026-06-30T03:00:00Z",
      "--freshness-expires-at", "2026-09-28T03:00:00Z",
    ];

    await assert.rejects(
      runBuildSourceSnapshot([
        ...baseArgs,
        "--raw-object-uri", "s3://bucket/snapshot.json?serviceKey=secret",
        "--raw-retention-expires-at", "2026-09-30T03:00:00Z",
      ]),
      /--raw-object-uri must be a credential-free object storage URI/,
    );
    await assert.rejects(
      runBuildSourceSnapshot([
        ...baseArgs,
        "--raw-object-uri", "s3://bucket/snapshot.json",
        "--raw-retention-expires-at", "2026-01-01T00:00:00Z",
      ]),
      /rawRetentionExpiresAt must be after retrievedAt/,
    );
  });
});

test("source snapshot command는 raw CSV를 LOCKED snapshot metadata로 canonicalize한다", async () => {
  await withSnapshotWorkDir("ok", "station,line\nSadang,2\nSangnoksu,4\n", async ({ workDir, rawPath, outputPath }) => {
    const canonicalRawPath = path.join(workDir, "canonical.csv");
    await runBuildSourceSnapshot([
      "--input", rawPath,
      "--raw-output", canonicalRawPath,
      "--output", outputPath,
      "--snapshot-id", "snapshot-kric-station-convenience-standard-20260630",
      "--source-id", "kric-station-convenience-standard",
      "--coverage-count", "2",
      "--provider", "국가철도공단",
      "--source-class-id", "static_accessibility_facility",
      "--retrieved-at", "2026-06-30T03:00:00Z",
      "--raw-object-uri", "s3://easysubway-datapack-sources/kric-station-convenience-standard/snapshot-kric-station-convenience-standard-20260630.csv",
      "--freshness-expires-at", "2026-09-28T03:00:00Z",
      "--raw-retention-expires-at", "2026-09-30T03:00:00Z",
    ]);

    const snapshot = JSON.parse(await readFile(outputPath, "utf8"));
    assert.equal(snapshot.snapshotStatus, "LOCKED");
    assert.equal(snapshot.credentialRedacted, true);
    assert.equal(snapshot.rowCount, 2);
    assert.match(snapshot.rawSha256, /^[0-9a-f]{64}$/);
    assert.match(snapshot.schemaFingerprint, /^[0-9a-f]{64}$/);
    assert.equal(snapshot.providerRecordHashes.length, 2);
    assert.equal(await readFile(canonicalRawPath, "utf8"), "station,line\nSadang,2\nSangnoksu,4\n");
  });
});

test("source snapshot command는 policy에서 파생되지 않은 임의 만료 시각을 거부한다", async () => {
  await withSnapshotWorkDir("freshness", "station\nSadang\n", async ({ rawPath, outputPath }) => {
    await assert.rejects(
      runBuildSourceSnapshot([
        "--input", rawPath,
        "--output", outputPath,
        "--snapshot-id", "snapshot-kric-arbitrary-expiry",
        "--source-id", "kric-station-convenience-standard",
        "--coverage-count", "1",
        "--provider", "국가철도공단",
        "--source-class-id", "static_accessibility_facility",
        "--retrieved-at", "2026-06-30T03:00:00Z",
        "--raw-object-uri", "s3://bucket/snapshot.json",
        "--freshness-expires-at", "2099-01-01T00:00:00Z",
        "--raw-retention-expires-at", "2099-02-01T00:00:00Z",
      ]),
      /SOURCE_FRESHNESS_DERIVATION_MISMATCH/,
    );
  });
});

test("source snapshot command는 source가 속하지 않은 freshness class를 거부한다", async () => {
  await withSnapshotWorkDir("class", "station\nSadang\n", async ({ rawPath, outputPath }) => {
    await assert.rejects(
      runBuildSourceSnapshot([
        "--input", rawPath,
        "--output", outputPath,
        "--snapshot-id", "snapshot-kric-wrong-class",
        "--source-id", "kric-station-convenience-standard",
        "--coverage-count", "1",
        "--provider", "국가철도공단",
        "--source-class-id", "static_network_metadata",
        "--retrieved-at", "2026-06-30T03:00:00Z",
        "--raw-object-uri", "s3://bucket/snapshot.json",
        "--freshness-expires-at", "2026-07-30T03:00:00Z",
        "--raw-retention-expires-at", "2026-09-30T03:00:00Z",
      ]),
      /SOURCE_FRESHNESS_POLICY_MISSING: kric-station-convenience-standard source class/,
    );
  });
});

test("source snapshot command는 정책 basis와 provider validity 필드를 보존한다", async () => {
  await withSnapshotWorkDir("planned", "trip\nA\n", async ({ workDir, rawPath, outputPath }) => {
    const policyPath = path.join(workDir, "policy.json");
    await writeFile(policyPath, PLANNED_TIMETABLE_POLICY);

    await runBuildSourceSnapshot([
      "--input", rawPath,
      "--output", outputPath,
      "--snapshot-id", "snapshot-planned-a",
      "--source-id", "planned-a",
      "--coverage-count", "1",
      "--provider", "provider-a",
      "--source-class-id", "planned_timetable",
      "--freshness-policy", policyPath,
      "--retrieved-at", "2026-07-02T00:00:00Z",
      "--freshness-basis-at", "2026-07-01T00:00:00Z",
      "--provider-valid-until", "2026-07-20T00:00:00Z",
      "--raw-object-uri", "s3://bucket/snapshot-planned-a.csv",
      "--freshness-expires-at", "2026-07-20T00:00:00Z",
      "--raw-retention-expires-at", "2026-10-01T00:00:00Z",
    ]);

    const snapshot = JSON.parse(await readFile(outputPath, "utf8"));
    assert.equal(snapshot.serviceEffectiveAt, "2026-07-01T00:00:00Z");
    assert.equal(snapshot.serviceEffectiveUntil, "2026-07-20T00:00:00Z");
  });
});

test("source snapshot command는 정책상 필수인 provider validity가 없으면 차단한다", async () => {
  await withSnapshotWorkDir("validity-required", "trip\nA\n", async ({ workDir, rawPath, outputPath }) => {
    const policyPath = path.join(workDir, "policy.json");
    await writeFile(policyPath, PLANNED_TIMETABLE_POLICY);

    await assert.rejects(
      runBuildSourceSnapshot([
        "--input", rawPath,
        "--output", outputPath,
        "--snapshot-id", "snapshot-planned-a",
        "--source-id", "planned-a",
        "--coverage-count", "1",
        "--provider", "provider-a",
        "--source-class-id", "planned_timetable",
        "--freshness-policy", policyPath,
        "--retrieved-at", "2026-07-02T00:00:00Z",
        "--freshness-basis-at", "2026-07-01T00:00:00Z",
        "--raw-object-uri", "s3://bucket/snapshot-planned-a.csv",
        "--freshness-expires-at", "2026-07-31T00:00:00Z",
        "--raw-retention-expires-at", "2026-10-01T00:00:00Z",
      ]),
      /--provider-valid-until is required/,
    );
  });
});

test("source snapshot --url fetch는 HTTPS·redirect error·30초 timeout·64MiB streaming 상한을 강제한다", async () => {
  // Non-HTTPS or credential-bearing URLs must fail closed before network call
  await assert.rejects(
    fetchSourceSnapshotText("http://example.invalid/feed.csv", {
      fetchImpl: async () => {
        throw new Error("should not call fetch for http URL");
      },
    }),
    /https/i,
  );
  await assert.rejects(
    fetchSourceSnapshotText("https://user:pass@example.invalid/feed.csv", {
      fetchImpl: async () => {
        throw new Error("should not call fetch for credential URL");
      },
    }),
    /credential/i,
  );

  // CLI rejects non-HTTPS --url before writing output
  await withSnapshotWorkDir("url-reject", "ignored", async ({ workDir, outputPath }) => {
    const policyPath = path.join(workDir, "policy.json");
    await writeFile(policyPath, PLANNED_TIMETABLE_POLICY);
    await assert.rejects(
      runBuildSourceSnapshot([
        "--url", "http://example.invalid/feed.csv",
        "--output", outputPath,
        "--snapshot-id", "snapshot-planned-a",
        "--source-id", "planned-a",
        "--coverage-count", "1",
        "--provider", "provider-a",
        "--source-class-id", "planned_timetable",
        "--freshness-policy", policyPath,
        "--retrieved-at", "2026-07-02T00:00:00Z",
        "--freshness-basis-at", "2026-07-01T00:00:00Z",
        "--provider-valid-until", "2026-08-01T00:00:00Z",
        "--raw-object-uri", "s3://bucket/snapshot-planned-a.csv",
        "--freshness-expires-at", "2026-07-31T00:00:00Z",
        "--raw-retention-expires-at", "2026-10-01T00:00:00Z",
      ]),
      /https/i,
    );
  });

  // Verifies redirect: "error", AbortSignal on options, and bounded stream reading
  let seenInit = null;
  const okText = await fetchSourceSnapshotText("https://data.go.kr/feed.csv", {
    fetchImpl: async (_url, init) => {
      seenInit = init;
      return new Response("station\nSadang\n", { status: 200 });
    },
  });
  assert.equal(okText, "station\nSadang\n");
  assert.equal(seenInit?.redirect, "error");
  assert.ok(seenInit?.signal instanceof AbortSignal);

  // Timed-out fetch fails closed via AbortSignal.timeout
  await assert.rejects(
    fetchSourceSnapshotText("https://data.go.kr/slow.csv", {
      timeoutMs: 10,
      fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
      }),
    }),
    /TimeoutError|timed out|abort/i,
  );

  // Redirected response fails closed
  await assert.rejects(
    fetchSourceSnapshotText("https://data.go.kr/feed.csv", {
      fetchImpl: async () => ({ ok: true, status: 200, redirected: true, text: async () => "ok" }),
    }),
    /redirect/i,
  );

  // Oversized streaming body (> 64 MiB default or bounded limit) fails closed without buffering full payload
  let canceled = false;
  const bigChunk = new Uint8Array(1024 * 1024);
  let sentChunks = 0;
  const largeStream = new ReadableStream({
    pull(controller) {
      if (sentChunks >= 70) {
        controller.close();
        return;
      }
      sentChunks += 1;
      controller.enqueue(bigChunk);
    },
    cancel() {
      canceled = true;
    },
  });
  await assert.rejects(
    fetchSourceSnapshotText("https://data.go.kr/large.csv", {
      fetchImpl: async () => new Response(largeStream, { status: 200 }),
    }),
    /exceeds maximum size/i,
  );
  assert.equal(canceled, true, "stream reader should cancel on oversized body");
});
