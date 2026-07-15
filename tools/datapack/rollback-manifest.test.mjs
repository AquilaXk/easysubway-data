import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, createSign, generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";

import { canonicalJson, withoutSignature } from "./lib/manifest-validation.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "../..");
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" });
const publicKeyPem = publicKey.export({ type: "spki", format: "pem" });

test("known-good pack 검증 후 immutable rescue를 쓰고 current를 마지막에 교체한다", async () => {
  await withFixture(async ({ directory, storage, current, knownGood, packBytes }) => {
    const result = await runRollback(directory, storage.baseUrl);
    const report = JSON.parse(result.stdout);
    const rescueKey = `catalog/releases/${report.rescue.releaseSequence}.json`;
    assert.ok(report.rescue.releaseSequence > current.releaseSequence);
    assert.equal(report.knownGood.releaseSequence, knownGood.releaseSequence);
    assert.equal(report.manifestLastStatus, "PASS");
    assert.equal(report.productionExecuted, false);
    assert.deepEqual(storage.objects.get("catalog/current.json").body, storage.objects.get(rescueKey).body);

    const packGet = storage.log.indexOf("GET catalog/capital-v1.sqlite.gz");
    const immutablePut = storage.log.indexOf(`PUT ${rescueKey}`);
    const currentPut = storage.log.indexOf("PUT catalog/current.json");
    assert.ok(packGet >= 0 && packGet < immutablePut);
    assert.ok(immutablePut < currentPut);
    assert.equal(sha256(packBytes), knownGood.packs[0].sha256);

    const evidence = JSON.parse(await readFile(path.join(directory, "rollback-evidence.json"), "utf8"));
    const rescueManifest = await readFile(path.join(directory, "rollback-manifest.json"));
    assert.equal(evidence.rescue.manifestSha256, report.rescue.manifestSha256);
    assert.equal(sha256(rescueManifest), report.rescue.manifestSha256);
    assert.equal(evidence.manifestLastStatus, "PASS");
  });
});

test("rollout current pointer는 failed immutable 승인 해시로 rollback한다", async () => {
  await withFixture(async ({ directory, storage, current }) => {
    current.rollout = { percentage: 10, seed: "a".repeat(32) };
    resignManifest(current);
    const rolloutBytes = bytes(current);
    storage.objects.set("catalog/current.json", { body: rolloutBytes });

    const report = JSON.parse((await runRollback(directory, storage.baseUrl)).stdout);

    assert.equal(report.from.manifestSha256, sha256(storage.originalFailedBytes));
    assert.notEqual(report.from.manifestSha256, sha256(rolloutBytes));
    assert.equal(storage.currentIfMatch, sha256(rolloutBytes));
  });
});

test("동일 승인 입력 재실행은 immutable/current PUT 없이 멱등 성공한다", async () => {
  await withFixture(async ({ directory, storage }) => {
    const first = JSON.parse((await runRollback(directory, storage.baseUrl)).stdout);
    const putCount = storage.log.filter((entry) => entry.startsWith("PUT ")).length;
    const second = JSON.parse((await runRollback(directory, storage.baseUrl)).stdout);
    assert.equal(second.idempotentReplay, true);
    assert.deepEqual(second.rescue, first.rescue);
    assert.deepEqual(second.from, first.from);
    assert.equal(storage.log.filter((entry) => entry.startsWith("PUT ")).length, putCount);
  });
});

test("멱등 재실행도 승인된 failed identity가 바뀌면 거부한다", async () => {
  await withFixture(async ({ directory, storage }) => {
    await runRollback(directory, storage.baseUrl);
    const approvalPath = path.join(directory, "approval.json");
    const approval = JSON.parse(await readFile(approvalPath, "utf8"));
    approval.failedManifestSha256 = "0".repeat(64);
    await writeFile(approvalPath, `${JSON.stringify(approval)}\n`);
    await assert.rejects(runRollback(directory, storage.baseUrl), /approval failed manifest identity mismatch/);
  });
});

test("만료된 동일 rescue 재실행은 성공 evidence를 만들지 않는다", async () => {
  await withFixture(async ({ directory, storage }) => {
    const first = JSON.parse((await runRollback(directory, storage.baseUrl)).stdout);
    const rescueKey = `catalog/releases/${first.rescue.releaseSequence}.json`;
    const expired = JSON.parse(storage.objects.get(rescueKey).body);
    expired.publishedAt = "2019-01-01T00:00:00.000Z";
    expired.expiresAt = "2020-01-01T00:00:00.000Z";
    resignManifest(expired);
    const expiredBytes = bytes(expired);
    storage.objects.set(rescueKey, { body: expiredBytes });
    storage.objects.set("catalog/current.json", { body: expiredBytes });

    await assert.rejects(runRollback(directory, storage.baseUrl), /idempotent rescue expired/);
  });
});

test("dry-run은 모든 검증과 report 생성을 수행하되 object를 쓰지 않는다", async () => {
  await withFixture(async ({ directory, storage, currentBytes }) => {
    const report = JSON.parse((await runRollback(directory, storage.baseUrl, ["--dry-run"])).stdout);
    assert.equal(report.dryRun, true);
    assert.equal(report.manifestLastStatus, "NOT_EXECUTED");
    assert.equal(report.executionEnvironment, "DRY_RUN");
    assert.equal(storage.log.some((entry) => entry.startsWith("PUT ")), false);
    assert.deepEqual(storage.objects.get("catalog/current.json").body, currentBytes);
  });
});

test("fixture rescue wrapper는 production private key 없이 sha256 manifest를 게시한다", async () => {
  await withFixture(async ({ directory, storage, current, knownGood }) => {
    signFixtureManifest(current);
    signFixtureManifest(knownGood);
    const currentBytes = bytes(current);
    const knownGoodBytes = bytes(knownGood);
    storage.objects.set("catalog/current.json", { body: currentBytes });
    storage.objects.set("catalog/releases/115.json", { body: currentBytes });
    storage.objects.set("catalog/releases/114.json", { body: knownGoodBytes });
    const approvalPath = path.join(directory, "approval.json");
    const approval = JSON.parse(await readFile(approvalPath, "utf8"));
    approval.failedManifestSha256 = sha256(currentBytes);
    approval.knownGoodManifestSha256 = sha256(knownGoodBytes);
    await writeFile(approvalPath, `${JSON.stringify(approval)}\n`);

    const report = JSON.parse((await runRollback(directory, storage.baseUrl, [], false)).stdout);
    const rescue = JSON.parse(storage.objects.get(`catalog/releases/${report.rescue.releaseSequence}.json`).body);
    assert.equal(rescue.signature.algorithm, "sha256-manifest-v2");
  });
});

test("rescue sequence는 caller 파일이 아니라 원격 immutable catalog 최대값 다음으로 계산한다", async () => {
  await withFixture(async ({ directory, storage }) => {
    storage.objects.set("catalog/releases/120.json", { body: bytes(manifest(120, storage.pack)) });
    const report = JSON.parse((await runRollback(directory, storage.baseUrl)).stdout);
    assert.equal(report.rescue.releaseSequence, 121);
    assert.ok(storage.log.some((entry) => entry.startsWith("GET ?prefix=catalog%2Freleases%2F")));
    assert.ok(storage.log.includes("GET catalog/releases/120.json"));
  });
});

test("known-good immutable key와 manifest releaseSequence가 다르면 거부한다", async () => {
  await withFixture(async (fixture) => {
    fixture.knownGood.releaseSequence = 113;
    resignManifest(fixture.knownGood);
    fixture.storage.objects.set("catalog/releases/114.json", { body: bytes(fixture.knownGood) });
    await bindApprovalToKnownGood(fixture);
    await assert.rejects(
      runRollback(fixture.directory, fixture.storage.baseUrl),
      /known-good releaseSequence mismatch/,
    );
  });
});

test("승인된 rollback event의 channel과 manifest identity가 실제 대상과 다르면 거부한다", async (t) => {
  for (const [name, mutate, expected] of [
    ["channel", (approval) => { approval.targetChannel = "production"; }, /approval targetChannel mismatch/],
    ["failed hash", (approval) => { approval.failedManifestSha256 = "0".repeat(64); }, /approval failed manifest identity mismatch/],
    ["known-good hash", (approval) => { approval.knownGoodManifestSha256 = "0".repeat(64); }, /approval known-good manifest identity mismatch/],
  ]) {
    await t.test(name, async () => {
      await withFixture(async ({ directory, storage }) => {
        const approvalPath = path.join(directory, "approval.json");
        const approval = JSON.parse(await readFile(approvalPath, "utf8"));
        mutate(approval);
        await writeFile(approvalPath, `${JSON.stringify(approval)}\n`);
        await assert.rejects(runRollback(directory, storage.baseUrl), expected);
      });
    });
  }
});

test("immutable rescue key에 다른 bytes가 있으면 current PUT 전에 거부한다", async () => {
  await withFixture(async ({ directory, storage, currentBytes }) => {
    storage.afterCatalogList = () => {
      storage.objects.set("catalog/releases/116.json", { body: Buffer.from("collision") });
    };
    await assert.rejects(runRollback(directory, storage.baseUrl), /immutable collision/);
    assert.equal(storage.log.includes("PUT catalog/current.json"), false);
    assert.deepEqual(storage.objects.get("catalog/current.json").body, currentBytes);
  });
});

test("immutable 게시 뒤 current identity가 경합하면 기존 새 current를 보존한다", async () => {
  await withFixture(async ({ directory, storage }) => {
    const concurrent = manifest(120, storage.pack);
    const concurrentBytes = bytes(concurrent);
    storage.afterImmutablePut = () => storage.objects.set("catalog/current.json", { body: concurrentBytes });
    await assert.rejects(runRollback(directory, storage.baseUrl), /current manifest changed during rescue/);
    assert.equal(storage.log.includes("PUT catalog/current.json"), false);
    assert.deepEqual(storage.objects.get("catalog/current.json").body, concurrentBytes);
  });
});

test("current GET 뒤 동시 게시가 발생하면 조건부 PUT이 최신 current를 보존한다", async () => {
  await withFixture(async ({ directory, storage }) => {
    const concurrent = manifest(120, storage.pack);
    const concurrentBytes = bytes(concurrent);
    storage.afterImmutablePut = () => {
      storage.afterCurrentGet = () => storage.objects.set("catalog/current.json", { body: concurrentBytes });
    };

    await assert.rejects(runRollback(directory, storage.baseUrl), /precondition failed/);
    assert.deepEqual(storage.objects.get("catalog/current.json").body, concurrentBytes);
  });
});

test("immutable 또는 current PUT 실패에서 이전 current를 보존한다", async (t) => {
  for (const failedKey of ["catalog/releases/116.json", "catalog/current.json"]) {
    await t.test(failedKey, async () => {
      await withFixture(async ({ directory, storage, currentBytes }) => {
        storage.failPutKey = failedKey;
        await assert.rejects(runRollback(directory, storage.baseUrl), /PUT failed/);
        assert.deepEqual(storage.objects.get("catalog/current.json").body, currentBytes);
      });
    });
  }
});

test("pack hash, RSA signature, SQLite quick/FK/schema/minimum row 오류를 current PUT 전에 거부한다", async (t) => {
  const cases = [
    ["compressed hash", ({ storage, packBytes }) => {
      storage.objects.set("catalog/capital-v1.sqlite.gz", { body: Buffer.alloc(packBytes.length, 0x61) });
    }, /sha256 mismatch/],
    ["pack signature", ({ knownGood, storage }) => {
      knownGood.packs[0].signature.value = "bad";
      resignManifest(knownGood);
      storage.objects.set("catalog/releases/114.json", { body: bytes(knownGood) });
    }, /pack signature mismatch/],
    ["sqlite schema", async ({ directory, knownGood, storage }) => {
      const { compressedBytes, sqliteBytes } = await invalidSqlitePack(directory);
      const pack = knownGood.packs[0];
      pack.sha256 = sha256(compressedBytes);
      pack.sqliteSha256 = sha256(sqliteBytes);
      pack.sizeBytes = compressedBytes.length;
      signPack(pack);
      resignManifest(knownGood);
      storage.objects.set("catalog/releases/114.json", { body: bytes(knownGood) });
      storage.objects.set("catalog/capital-v1.sqlite.gz", { body: compressedBytes });
    }, /missing required table/],
  ];
  for (const [name, mutate, expected] of cases) {
    await t.test(name, async () => {
      await withFixture(async (fixture) => {
        await mutate(fixture);
        await bindApprovalToKnownGood(fixture);
        await assert.rejects(runRollback(fixture.directory, fixture.storage.baseUrl), expected);
        assert.equal(fixture.storage.log.includes("PUT catalog/current.json"), false);
      });
    });
  }
});

async function bindApprovalToKnownGood({ directory, knownGood }) {
  const approvalPath = path.join(directory, "approval.json");
  const approval = JSON.parse(await readFile(approvalPath, "utf8"));
  approval.knownGoodManifestSha256 = sha256(bytes(knownGood));
  await writeFile(approvalPath, `${JSON.stringify(approval)}\n`);
}

async function withFixture(callback) {
  const directory = await mkdtemp(path.join(tmpdir(), "rollback-rescue-test-"));
  const { pack, packBytes } = await createPack(directory);
  const current = manifest(115, pack);
  const knownGood = manifest(114, pack);
  const currentBytes = bytes(current);
  const storage = await startStorage([
    ["catalog/current.json", { body: currentBytes }],
    ["catalog/releases/114.json", { body: bytes(knownGood) }],
    ["catalog/releases/115.json", { body: currentBytes }],
    ["catalog/capital-v1.sqlite.gz", { body: packBytes }],
  ]);
  storage.pack = pack;
  storage.originalFailedBytes = currentBytes;
  await writeFile(path.join(directory, "approval.json"), `${JSON.stringify({
    schemaVersion: 1,
    artifactKind: "datapack-rollback-approval",
    rollbackApprovalEventId: "release-channel-event-1",
    targetChannel: "staging",
    failedManifestSha256: sha256(currentBytes),
    knownGoodManifestSha256: sha256(bytes(knownGood)),
    approvedBy: "release-approver",
    approvedByRole: "admin.datapack.rollback",
    approvedAt: "2026-07-15T00:30:00.000Z",
    reasonCode: "ADMIN_APPROVED_ROLLBACK",
  })}\n`);
  try {
    await callback({ directory, storage, current, knownGood, currentBytes, packBytes });
  } finally {
    await new Promise((resolve) => storage.server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
}

async function runRollback(directory, baseUrl, extraArgs = [], includePrivateKey = true) {
  const publishedAt = new Date();
  const expiresAt = new Date(publishedAt.getTime() + 86_400_000);
  return execFileAsync("node", [
    path.join(repoRoot, "tools/datapack/rollback-manifest.mjs"),
    "--target-sequence", "114",
    "--failed-sequence", "115",
    "--channel", "staging",
    "--base-url", baseUrl,
    "--approval", path.join(directory, "approval.json"),
    "--published-at", publishedAt.toISOString(),
    "--expires-at", expiresAt.toISOString(),
    "--manifest-output", path.join(directory, "rollback-manifest.json"),
    "--evidence-output", path.join(directory, "rollback-evidence.json"),
    ...extraArgs,
  ], {
    env: {
      ...process.env,
      EASYSUBWAY_DATAPACK_SIGNING_PUBLIC_KEY_PEM: publicKeyPem,
      ...(includePrivateKey ? { EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM: privateKeyPem } : {}),
    },
  });
}

async function startStorage(seed) {
  const objects = new Map(seed);
  const log = [];
  const state = {
    objects, log, failPutKey: null, afterCatalogList: null, afterImmutablePut: null, afterCurrentGet: null,
    currentIfMatch: null,
  };
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://fixture.local");
    const key = decodeURIComponent(url.pathname.replace(/^\//, ""));
    if (request.method === "GET" && key === "") {
      log.push(`GET ${url.search}`);
      const prefix = url.searchParams.get("prefix");
      if (prefix !== "catalog/releases/") {
        response.statusCode = 400;
        response.end("invalid prefix");
        return;
      }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        objects: [...objects.keys()].filter((name) => name.startsWith(prefix)).map((name) => ({ name })),
      }));
      const afterCatalogList = state.afterCatalogList;
      state.afterCatalogList = null;
      afterCatalogList?.();
      return;
    }
    log.push(`${request.method} ${key}`);
    if (request.method === "PUT") {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        if (state.failPutKey === key) {
          response.statusCode = 500;
          response.end("injected failure");
          return;
        }
        const current = objects.get(key);
        const expectedEtag = current ? `"${sha256(current.body)}"` : null;
        const condition = request.headers["if-match"] ?? request.headers["if-none-match"];
        if (key === "catalog/current.json") state.currentIfMatch = condition?.replaceAll('"', "") ?? null;
        if (
          key === "catalog/current.json"
          && condition !== (expectedEtag ?? "*")
        ) {
          response.statusCode = 412;
          response.end("precondition failed");
          return;
        }
        objects.set(key, { body: Buffer.concat(chunks) });
        if (key.startsWith("catalog/releases/")) state.afterImmutablePut?.();
        response.statusCode = 200;
        response.end();
      });
      return;
    }
    const object = objects.get(key);
    if (!object) {
      response.statusCode = 404;
      response.end();
      return;
    }
    response.statusCode = 200;
    response.setHeader("etag", `"${sha256(object.body)}"`);
    response.end(object.body);
    if (key === "catalog/current.json") {
      const afterCurrentGet = state.afterCurrentGet;
      state.afterCurrentGet = null;
      afterCurrentGet?.();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  Object.assign(state, { server, baseUrl: `http://127.0.0.1:${server.address().port}` });
  return state;
}

async function createPack(directory) {
  const sqlitePath = path.join(directory, "capital.sqlite");
  const database = new DatabaseSync(sqlitePath);
  database.exec(`
    PRAGMA user_version = 1;
    PRAGMA foreign_keys = ON;
    CREATE TABLE catalog_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO catalog_metadata VALUES ('schemaVersion', '1');
    CREATE TABLE stations (id TEXT PRIMARY KEY);
    CREATE TABLE station_lines (id TEXT PRIMARY KEY);
    CREATE TABLE network_edges (id TEXT PRIMARY KEY);
    CREATE TABLE facilities (id TEXT PRIMARY KEY);
    CREATE TABLE station_facility_evidence (id TEXT PRIMARY KEY);
    INSERT INTO stations VALUES ('s');
    INSERT INTO station_lines VALUES ('sl');
    INSERT INTO network_edges VALUES ('e');
    INSERT INTO facilities VALUES ('f');
    INSERT INTO station_facility_evidence VALUES ('fe');
  `);
  database.close();
  const sqliteBytes = await readFile(sqlitePath);
  const packBytes = gzipSync(sqliteBytes, { level: 9, mtime: 0 });
  const pack = {
    id: "capital",
    version: "1",
    artifactKind: "production",
    url: "https://cdn.example.com/catalog/capital-v1.sqlite.gz",
    sha256: sha256(packBytes),
    sqliteSha256: sha256(sqliteBytes),
    sizeBytes: packBytes.length,
    schemaVersion: "1",
    sourceInventory: [{
      id: "source", owner: "owner", url: "https://data.example.com/source",
      license: "CC-BY-4.0", licenseStatus: "redistributable", redistributionAllowed: true,
      updateFrequency: "daily", updatedAt: "2026-07-14T00:00:00.000Z", fields: ["stations"],
      coverageScope: { regionIds: ["seoul"], operatorIds: ["metro"], sourceDomains: ["stations"] },
    }],
    regionalQualityMetrics: {
      stationCount: 1, facilityCoverageRatio: 1, requiredFacilityEvidenceCoverageRatio: 1,
      strictRouteEligibleFacilityRatio: 1, operationalKnownRatio: 1, freshnessValidRatio: 1,
      fieldVerifiedPathwayRatio: 1, edgeCount: 1, unknownAccessibilityRatio: 0,
      unknownEdgeRatioByProfile: { wheelchair: 0, stroller: 0, lowMobility: 0 },
    },
    representativeRouteRegressions: [],
    requiredTables: ["stations", "station_lines", "network_edges", "facilities", "station_facility_evidence"],
    minimumTableRows: { stations: 1, station_lines: 1, network_edges: 1, facilities: 1, station_facility_evidence: 1 },
  };
  signPack(pack);
  return { pack, packBytes };
}

async function invalidSqlitePack(directory) {
  const sqlitePath = path.join(directory, "invalid.sqlite");
  const database = new DatabaseSync(sqlitePath);
  database.exec(`
    PRAGMA user_version = 1;
    CREATE TABLE catalog_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO catalog_metadata VALUES ('schemaVersion', '1');
    CREATE TABLE wrong (id TEXT PRIMARY KEY);
    INSERT INTO wrong VALUES ('x');
  `);
  database.close();
  const sqliteBytes = await readFile(sqlitePath);
  return { sqliteBytes, compressedBytes: gzipSync(sqliteBytes, { level: 9, mtime: 0 }) };
}

function signPack(pack) {
  const fixturePayload = `${pack.id}:${pack.version}:${pack.sha256}:${pack.sqliteSha256}:${pack.sizeBytes}`;
  pack.signature = {
    algorithm: "rsa-sha256-pack-manifest-v2",
    value: sign(`${fixturePayload}:${new URL(pack.url)}`),
  };
  pack.representativeRouteRegressionSignature = {
    algorithm: "rsa-sha256-route-regression-v1",
    value: sign(`${fixturePayload}:[]:${new URL(pack.url)}`),
  };
}

function manifest(releaseSequence, pack) {
  const value = {
    manifestVersion: 2,
    channel: "staging",
    releaseSequence,
    publishedAt: "2026-07-14T00:00:00.000Z",
    expiresAt: "2026-07-20T00:00:00.000Z",
    keyId: "production-v1",
    ttlSeconds: 3600,
    packs: [structuredClone(pack)],
  };
  resignManifest(value);
  return value;
}

function resignManifest(value) {
  value.signature = {
    algorithm: "rsa-sha256-manifest-v2",
    value: sign(canonicalJson(withoutSignature(value))),
  };
}

function signFixtureManifest(value) {
  const pack = value.packs[0];
  pack.artifactKind = "fixture";
  pack.url = "catalog/capital-v1.sqlite.gz";
  const payload = `${pack.id}:${pack.version}:${pack.sha256}:${pack.sqliteSha256}:${pack.sizeBytes}`;
  pack.signature = { algorithm: "sha256-pack-manifest-v2", value: sha256(payload) };
  pack.representativeRouteRegressionSignature = {
    algorithm: "sha256-route-regression-v1",
    value: sha256(`${payload}:${JSON.stringify(pack.representativeRouteRegressions)}`),
  };
  value.keyId = "fixture-key";
  value.signature = {
    algorithm: "sha256-manifest-v2",
    value: sha256(canonicalJson(withoutSignature(value))),
  };
}

function sign(value) {
  return createSign("RSA-SHA256").update(value).sign(privateKeyPem).toString("base64url");
}

function bytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
