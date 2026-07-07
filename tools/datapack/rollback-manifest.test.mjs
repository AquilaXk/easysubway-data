import { createHash, createSign } from "node:crypto";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");

// 테스트용 RSA 키쌍 (datapack-tools.test.mjs에서 재사용)
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

const testPublicKeyPem = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAitNBIH/FyHbqONXe/z8L
NzWes4rh3veI4/8RY76rb7onamA+WDoJlvFyvBG+ihBOl7LtgW1rV54hCLHz95VF
Lmm028+tll9ThDzSs3Bu9ychED+m0vny16tK8ZgB6gf7sJkjGBJn8MLDaiVWoVvD
5TEjv433f/vMFIljdNUKZC2Xf0qHYlYv18dAwbJHKeOsmJkky13HNVn40HuEn5FW
EJvFI5qqVgpJ+k1V3ip39ga2+Ek5SOVHAL6U44ypjSXUjo7NCKVpuQRwN7hAnvlY
utXDdrEQ6Oa3iUtbQJIgkl+ZmTwNkYHCEIhd/ZLB9n/EEHdvyJAmUKCtAKLX5FOa
9wIDAQAB
-----END PUBLIC KEY-----`;

// ─── 서명 헬퍼 ────────────────────────────────────────────────────────────────

function sha256hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function rsaSign(data) {
  return createSign("RSA-SHA256").update(data).sign(testPrivateKeyPem).toString("base64url");
}

function canonicalValue(value) {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(canonicalValue);
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
}

function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function withoutSignature(manifest) {
  const copy = { ...manifest };
  delete copy.signature;
  return copy;
}

// ─── 유효 production 팩 픽스처 ────────────────────────────────────────────────
// production artifactKind → validateManifestSignature이 RSA 경로를 탄다.
// HTTPS URL + minimumTableRows + coverageScope 모두 포함해 validateManifest를 통과한다.

function buildPack() {
  const fakePackBytes = Buffer.from("pack");
  const fakeSqliteBytes = Buffer.from("sqlite");
  return {
    id: "capital",
    version: "1",
    artifactKind: "production",
    url: "https://cdn.example.com/catalog/capital-v1.sqlite.gz",
    sha256: sha256hex(fakePackBytes),
    sqliteSha256: sha256hex(fakeSqliteBytes),
    sizeBytes: 4,
    signature: {
      algorithm: "rsa-sha256-pack-manifest-v2",
      value: rsaSign("pack-sig-payload"),
    },
    schemaVersion: "1",
    sourceInventory: [
      {
        id: "src1",
        owner: "test-owner",
        url: "https://data.example.com/catalog",
        license: "CC-BY-4.0",
        licenseStatus: "redistributable",
        redistributionAllowed: true,
        updateFrequency: "daily",
        updatedAt: "2026-07-06T00:00:00.000Z",
        fields: ["stations"],
        coverageScope: {
          regionIds: ["seoul"],
          operatorIds: ["seoulmetro"],
          sourceDomains: ["station_map"],
        },
      },
    ],
    regionalQualityMetrics: {
      stationCount: 100,
      edgeCount: 200,
      facilityCoverageRatio: 0.5,
      requiredFacilityEvidenceCoverageRatio: 0.5,
      strictRouteEligibleFacilityRatio: 0.5,
      operationalKnownRatio: 1.0,
      freshnessValidRatio: 0.8,
      fieldVerifiedPathwayRatio: 0.3,
      unknownAccessibilityRatio: 0.2,
      unknownEdgeRatioByProfile: { wheelchair: 0.1, stroller: 0.1, lowMobility: 0.1 },
    },
    // routeRegressionScope 없음 + 빈 배열 → validateManifest 통과 (scope=null, routes=[] → requiredPatterns=empty)
    representativeRouteRegressions: [],
    representativeRouteRegressionSignature: {
      algorithm: "rsa-sha256-route-regression-v1",
      value: rsaSign("regression-sig-payload"),
    },
    requiredTables: ["stations"],
    minimumTableRows: {
      stations: 1,
      station_lines: 1,
      network_edges: 1,
      facilities: 1,
      station_facility_evidence: 1,
    },
  };
}

// buildManifest: 오버라이드 적용 후 RSA 서명을 재계산한다.
// keyId="production-v1" → signingKeyId() 기본값과 일치.
function buildManifest(overrides = {}) {
  const base = {
    manifestVersion: 2,
    channel: "staging",
    releaseSequence: 2,
    publishedAt: "2026-07-06T00:00:00.000Z",
    expiresAt: "2999-01-01T00:00:00.000Z",
    keyId: "production-v1",
    ttlSeconds: 3600,
    signature: { algorithm: "rsa-sha256-manifest-v2", value: "placeholder" },
    packs: [buildPack()],
    ...overrides,
  };
  // 오버라이드 반영 후 서명 재계산 (canonicalJson 기반 RSA-SHA256)
  base.signature = {
    algorithm: "rsa-sha256-manifest-v2",
    value: rsaSign(canonicalJson(withoutSignature(base))),
  };
  return base;
}

// ─── mock 스토리지 서버 ────────────────────────────────────────────────────────

function startStorage(seed) {
  const objects = new Map(seed);
  const server = createServer((req, res) => {
    const key = decodeURIComponent(req.url.replace(/^\//, ""));
    if (req.method === "PUT") {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        objects.set(key, { body: Buffer.concat(chunks) });
        res.statusCode = 200;
        res.end();
      });
      return;
    }
    const found = objects.get(key);
    if (!found) { res.statusCode = 404; res.end(); return; }
    if (found.sha256) res.setHeader("x-amz-meta-sha256", found.sha256);
    res.setHeader("content-length", String(found.body.length));
    res.statusCode = 200;
    res.end(req.method === "HEAD" ? undefined : found.body);
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, objects, port: server.address().port })));
}

// ─── 롤백 실행 헬퍼 ──────────────────────────────────────────────────────────
// EASYSUBWAY_DATAPACK_SIGNING_PUBLIC_KEY_PEM를 항상 주입 (production 팩 RSA 검증용)

const testEnv = {
  ...process.env,
  EASYSUBWAY_DATAPACK_SIGNING_PUBLIC_KEY_PEM: testPublicKeyPem,
};

async function runRollback(args, baseUrl) {
  return execFileAsync(
    "node",
    [path.join(REPO_ROOT, "tools/datapack/rollback-manifest.mjs"), "--base-url", baseUrl, ...args],
    { env: testEnv },
  );
}

const sha256 = (b) => createHash("sha256").update(b).digest("hex");

// ─── 테스트 ①: 정상 스왑 (+ ⑥ 바이트 동일성 커버) ──────────────────────────

test("① 롤백은 releases/<N>.json을 바이트 동일하게 current.json으로 스왑한다", async () => {
  const manifest = buildManifest();
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const packBytes = Buffer.from("pack");

  const storage = await startStorage([
    ["catalog/releases/2.json", { body: manifestBytes }],
    ["catalog/capital-v1.sqlite.gz", { body: packBytes }],
    ["catalog/current.json", { body: Buffer.from("old") }],
  ]);
  const baseUrl = `http://127.0.0.1:${storage.port}`;
  try {
    const { stdout } = await runRollback(
      ["--target-sequence", "2", "--channel", "staging", "--reason", "rehearsal", "--idempotency-key", "k1"],
      baseUrl,
    );
    const report = JSON.parse(stdout);
    assert.equal(report.targetSequence, 2);
    assert.equal(report.channel, "staging");
    assert.equal(report.newCurrentSha256, sha256(manifestBytes));
    assert.equal(report.reason, "rehearsal");
    assert.equal(report.idempotencyKey, "k1");
    // ⑥ 바이트 동일성: 재직렬화 없이 원본 바이트가 그대로 저장돼야 한다.
    assert.deepEqual(storage.objects.get("catalog/current.json").body, manifestBytes);
  } finally {
    storage.server.close();
  }
});

// ─── 테스트 ②: 만료된 manifest 거부 ─────────────────────────────────────────
// publishedAt < expiresAt 이어야 validateManifestV2Envelope를 통과하고,
// expiresAt < Date.now() 이어야 CLI 만료 거부가 동작한다.

test("② 만료된 manifest를 거부한다", async () => {
  const manifest = buildManifest({
    publishedAt: "1999-01-01T00:00:00.000Z",
    expiresAt: "2000-01-01T00:00:00.000Z",
  });
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const storage = await startStorage([
    ["catalog/releases/2.json", { body: manifestBytes }],
    ["catalog/capital-v1.sqlite.gz", { body: Buffer.from("pack") }],
  ]);
  const baseUrl = `http://127.0.0.1:${storage.port}`;
  try {
    await assert.rejects(
      runRollback(["--target-sequence", "2", "--channel", "staging", "--reason", "test", "--idempotency-key", "k2"], baseUrl),
      /expired; rebuild required/,
    );
  } finally {
    storage.server.close();
  }
});

// ─── 테스트 ③: 팩 객체 유실 거부 ────────────────────────────────────────────

test("③ 참조 팩이 스토리지에 없으면 거부한다", async () => {
  const manifest = buildManifest();
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  // catalog/capital-v1.sqlite.gz를 심지 않음
  const storage = await startStorage([
    ["catalog/releases/2.json", { body: manifestBytes }],
  ]);
  const baseUrl = `http://127.0.0.1:${storage.port}`;
  try {
    await assert.rejects(
      runRollback(["--target-sequence", "2", "--channel", "staging", "--reason", "test", "--idempotency-key", "k3"], baseUrl),
      /referenced pack.*not found/,
    );
  } finally {
    storage.server.close();
  }
});

// ─── 테스트 ⑧: 참조 팩 sha256 불일치 거부 ───────────────────────────────────
// 팩 객체가 존재해도 저장 바이트의 sha256이 manifest pack.sha256과 다르면
// (훼손·교체) 롤백을 거부해야 한다 (spec §4-4: 존재·sha256 대조).

test("⑧ 참조 팩 sha256이 manifest와 불일치하면 거부한다", async () => {
  const manifest = buildManifest();
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const storage = await startStorage([
    ["catalog/releases/2.json", { body: manifestBytes }],
    // manifest pack.sha256 = sha256("pack") 인데 다른 바이트를 심는다.
    ["catalog/capital-v1.sqlite.gz", { body: Buffer.from("tampered") }],
    ["catalog/current.json", { body: Buffer.from("old") }],
  ]);
  const baseUrl = `http://127.0.0.1:${storage.port}`;
  try {
    await assert.rejects(
      runRollback(["--target-sequence", "2", "--channel", "staging", "--reason", "test", "--idempotency-key", "k8"], baseUrl),
      /sha256 mismatch/,
    );
    // 스왑이 수행되지 않았어야 한다 (거부 시 current.json 원본 보존).
    assert.deepEqual(storage.objects.get("catalog/current.json").body, Buffer.from("old"));
  } finally {
    storage.server.close();
  }
});

// ─── 테스트 ④: 훼손된 서명 거부 ─────────────────────────────────────────────
// 유효 manifest에서 signature.value 한 글자를 변경하면 RSA 검증이 실패해야 한다.

test("④ 훼손된 manifest 서명을 거부한다", async () => {
  const manifest = buildManifest();
  // 첫 글자를 확실히 다른 문자로 변경 (A→B, 그 외→A)
  const orig = manifest.signature.value;
  manifest.signature.value = (orig[0] === "A" ? "B" : "A") + orig.slice(1);

  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const storage = await startStorage([
    ["catalog/releases/2.json", { body: manifestBytes }],
    ["catalog/capital-v1.sqlite.gz", { body: Buffer.from("pack") }],
  ]);
  const baseUrl = `http://127.0.0.1:${storage.port}`;
  try {
    await assert.rejects(
      runRollback(["--target-sequence", "2", "--channel", "staging", "--reason", "test", "--idempotency-key", "k4"], baseUrl),
      /manifest signature mismatch/,
    );
  } finally {
    storage.server.close();
  }
});

// ─── 테스트 ⑤: 채널 불일치 거부 ─────────────────────────────────────────────
// manifest.channel=staging 인데 --channel production 으로 실행하면
// validateManifest(requireProduction=true)는 production 팩이므로 통과하지만
// 이후 채널 대조에서 거부해야 한다.

test("⑤ 채널 불일치(staging manifest → production 채널)를 거부한다", async () => {
  const manifest = buildManifest(); // channel: "staging"
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const storage = await startStorage([
    ["catalog/releases/2.json", { body: manifestBytes }],
    ["catalog/capital-v1.sqlite.gz", { body: Buffer.from("pack") }],
  ]);
  const baseUrl = `http://127.0.0.1:${storage.port}`;
  try {
    await assert.rejects(
      runRollback(["--target-sequence", "2", "--channel", "production", "--reason", "test", "--idempotency-key", "k5"], baseUrl),
      /channel mismatch/,
    );
  } finally {
    storage.server.close();
  }
});

// ─── 테스트 ⑥: 바이트 동일성 전용 — pretty-print 재직렬화 금지 ────────────────
// pretty-print된 JSON 바이트를 그대로 PUT해야 한다. 재직렬화 시 공백이 사라진다.

test("⑥ current.json은 pretty-print 바이트를 재직렬화 없이 저장한다", async () => {
  const manifest = buildManifest();
  // pretty-print: 재직렬화하면 공백이 사라져 bytes가 달라진다.
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2));
  const storage = await startStorage([
    ["catalog/releases/2.json", { body: manifestBytes }],
    ["catalog/capital-v1.sqlite.gz", { body: Buffer.from("pack") }],
  ]);
  const baseUrl = `http://127.0.0.1:${storage.port}`;
  try {
    await runRollback(["--target-sequence", "2", "--channel", "staging", "--reason", "test", "--idempotency-key", "k6"], baseUrl);
    // 재직렬화가 없으면 pretty-print 공백이 그대로 보존된다.
    assert.deepEqual(storage.objects.get("catalog/current.json").body, manifestBytes);
  } finally {
    storage.server.close();
  }
});

// ─── 테스트 ⑦: --dry-run 플래그는 스왑을 수행하지 않음 ────────────────────────
// --dry-run 실행 후에도 catalog/current.json은 원본 바이트를 유지해야 한다.

test("⑦ --dry-run은 current.json을 수정하지 않으면서 exit 0으로 성공한다", async () => {
  const manifest = buildManifest();
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const originalCurrentBytes = Buffer.from("old");

  const storage = await startStorage([
    ["catalog/releases/2.json", { body: manifestBytes }],
    ["catalog/capital-v1.sqlite.gz", { body: Buffer.from("pack") }],
    ["catalog/current.json", { body: originalCurrentBytes }],
  ]);
  const baseUrl = `http://127.0.0.1:${storage.port}`;
  try {
    // --dry-run 플래그로 실행
    const { stdout } = await runRollback(
      ["--dry-run", "--target-sequence", "2", "--channel", "staging", "--reason", "test", "--idempotency-key", "k7"],
      baseUrl,
    );
    // exit 0 성공, 리포트 생성됨
    const report = JSON.parse(stdout);
    assert.equal(report.targetSequence, 2);
    // 중요: current.json은 원본 바이트 그대로 (스왑 미수행)
    assert.deepEqual(storage.objects.get("catalog/current.json").body, originalCurrentBytes);
  } finally {
    storage.server.close();
  }
});
