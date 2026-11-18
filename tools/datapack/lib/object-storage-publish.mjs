// #1692: 객체스토리지 PUT 공유 I/O — rollback-manifest·publish-rollout가 함께 사용.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { gunzipWithLimit } from "./bounded-zlib.mjs";
import { sha256 } from "../../lib/hash.mjs";
import {
  findMatchingPackSigningPublicKey,
  requiredString,
  verifyRsaSha256Signature,
} from "./manifest-validation.mjs";

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_OBJECT_RESPONSE_BYTES = 256 * 1024 * 1024;
const MAX_PACK_SQLITE_BYTES = 512 * 1024 * 1024;

// ─── 기본 HTTP 요청 ────────────────────────────────────────────────────────────

export function request(url, method, body = Buffer.alloc(0), headers = {}, { maxResponseBytes = MAX_OBJECT_RESPONSE_BYTES } = {}) {
  const transport = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    let settled = false;
    const req = transport.request(url, { method, headers }, (res) => {
      res.on("data", (c) => {
        totalBytes += c.length;
        if (totalBytes > maxResponseBytes) {
          if (!settled) {
            settled = true;
            req.destroy(new Error(`object storage response exceeds maximum size (${maxResponseBytes} bytes)`));
          }
          return;
        }
        chunks.push(c);
      });
      res.on("end", () => {
        if (!settled) {
          settled = true;
          res.body = Buffer.concat(chunks, totalBytes);
          resolve(res);
        }
      });
      res.on("error", (err) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
      });
    });
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      if (!settled) {
        settled = true;
        req.destroy(new Error(`request timeout after ${REQUEST_TIMEOUT_MS}ms`));
      }
    });
    req.on("error", (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
    if (body.length > 0) req.write(body);
    req.end();
  });
}

// ─── URL 생성 ─────────────────────────────────────────────────────────────────

export function objectUrl(baseUrl, key) {
  const url = new URL(baseUrl.toString());
  const base = url.pathname.replace(/\/+$/, "");
  url.pathname = `${base}/${key.split("/").map(encodeURIComponent).join("/")}`;
  return url;
}

// ─── 참조 팩 존재·sha256 대조 (fail-closed) ──────────────────────────────────
// preauth(OCI PAR) 대상은 HEAD/meta sha를 신뢰할 수 없어 GET 본문 sha256을 직접 대조한다.
// 팩이 유실·훼손·교체되면 즉시 throw.

export async function verifyReferencedPacks(baseUrl, manifest) {
  for (const pack of manifest.packs) {
    const packKey = pack.url && !/^https:\/\//.test(pack.url)
      ? pack.url
      : `catalog/${pack.id}-v${pack.version}.sqlite.gz`;
    const packResponse = await request(objectUrl(baseUrl, packKey), "GET");
    if (packResponse.statusCode !== 200) {
      throw new Error(`referenced pack ${packKey} not found (HTTP ${packResponse.statusCode})`);
    }
    const storedSha256 = sha256(packResponse.body);
    if (storedSha256 !== pack.sha256) {
      throw new Error(`referenced pack ${packKey} sha256 mismatch: stored=${storedSha256} manifest=${pack.sha256}`);
    }
  }
}

export async function validateReferencedPacksForRescue(baseUrl, manifest) {
  const temporaryDir = await mkdtemp(path.join(tmpdir(), "easysubway-rescue-pack-"));
  try {
    for (const pack of manifest.packs) {
      const packKey = pack.url && !pack.url.startsWith("https://")
        ? pack.url
        : `catalog/${pack.id}-v${pack.version}.sqlite.gz`;
      const response = await request(objectUrl(baseUrl, packKey), "GET");
      if (response.statusCode !== 200) {
        throw new Error(`referenced pack ${packKey} not found (HTTP ${response.statusCode})`);
      }
      if (response.body.length !== pack.sizeBytes) {
        throw new Error(`${pack.id}@${pack.version} sizeBytes mismatch`);
      }
      if (sha256(response.body) !== pack.sha256) {
        throw new Error(`${pack.id}@${pack.version} sha256 mismatch`);
      }
      const matchedPublicKey = validatePackSignature(pack);
      validateRouteRegressionSignature(pack, matchedPublicKey);

      const sqliteBytes = gunzipWithLimit(response.body, {
        maxOutputLength: MAX_PACK_SQLITE_BYTES,
        maxCompressedBytes: MAX_OBJECT_RESPONSE_BYTES,
        label: `${pack.id}@${pack.version} pack`,
      });
      if (sha256(sqliteBytes) !== pack.sqliteSha256) {
        throw new Error(`${pack.id}@${pack.version} sqlite checksum mismatch`);
      }
      const sqlitePath = path.join(temporaryDir, `${pack.id}-v${pack.version}.sqlite`);
      await writeFile(sqlitePath, sqliteBytes);
      validateRescueSqlite(sqlitePath, pack);
    }
  } finally {
    await rm(temporaryDir, { recursive: true, force: true });
  }
}

function validatePackSignature(pack) {
  const fixturePayload = `${pack.id}:${pack.version}:${pack.sha256}:${pack.sqliteSha256}:${pack.sizeBytes}`;
  const payload = pack.artifactKind === "production"
    ? `${fixturePayload}:${new URL(pack.url).toString()}`
    : fixturePayload;
  if (pack.artifactKind === "production") {
    const matchedPublicKey = findMatchingPackSigningPublicKey(payload, pack.signature.value);
    if (!matchedPublicKey) throw new Error(`${pack.id}@${pack.version} pack signature mismatch`);
    return matchedPublicKey;
  }
  if (pack.signature.value !== sha256(Buffer.from(payload))) {
    throw new Error(`${pack.id}@${pack.version} pack signature mismatch`);
  }
  return null;
}

function validateRouteRegressionSignature(pack, matchedPublicKey = null) {
  const routes = pack.representativeRouteRegressions.map((route) => ({
    id: requiredString(route.id, "representativeRouteRegressions.id"),
    pattern: requiredString(route.pattern, "representativeRouteRegressions.pattern"),
    fromNodeId: requiredString(route.fromNodeId, "representativeRouteRegressions.fromNodeId"),
    toNodeId: requiredString(route.toNodeId, "representativeRouteRegressions.toNodeId"),
    requiredEdgeIds: route.requiredEdgeIds.map((edgeId) => requiredString(edgeId, "representativeRouteRegressions.requiredEdgeIds")),
  }));
  const fixturePayload = `${pack.id}:${pack.version}:${pack.sha256}:${pack.sqliteSha256}:${pack.sizeBytes}`;
  const basePayload = `${fixturePayload}:${JSON.stringify(routes)}`;
  const payload = pack.artifactKind === "production"
    ? `${basePayload}:${new URL(pack.url).toString()}`
    : basePayload;
  const valid = pack.artifactKind === "production"
    ? (matchedPublicKey
      ? verifyRsaSha256Signature(matchedPublicKey, payload, pack.representativeRouteRegressionSignature.value)
      : Boolean(findMatchingPackSigningPublicKey(payload, pack.representativeRouteRegressionSignature.value)))
    : pack.representativeRouteRegressionSignature.value === sha256(Buffer.from(payload));
  if (!valid) throw new Error(`${pack.id}@${pack.version} representative route regression signature mismatch`);
}

function validateRescueSqlite(sqlitePath, pack) {
  const database = new DatabaseSync(sqlitePath, { readOnly: true });
  try {
    if (database.prepare("PRAGMA quick_check").all().some((row) => row.quick_check !== "ok")) {
      throw new Error(`${pack.id}@${pack.version} PRAGMA quick_check failed`);
    }
    if (database.prepare("PRAGMA foreign_key_check").all().length > 0) {
      throw new Error(`${pack.id}@${pack.version} PRAGMA foreign_key_check failed`);
    }
    const metadata = database.prepare("SELECT value FROM catalog_metadata WHERE key = 'schemaVersion'").get();
    if (!metadata || metadata.value !== pack.schemaVersion) {
      throw new Error(`${pack.id}@${pack.version} schemaVersion mismatch`);
    }
    const userVersion = database.prepare("PRAGMA user_version").get().user_version;
    if (userVersion < Number(pack.schemaVersion)) {
      throw new Error(`${pack.id}@${pack.version} PRAGMA user_version mismatch`);
    }
    for (const tableName of pack.requiredTables) {
      const table = database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?").get(tableName);
      if (!table) throw new Error(`${pack.id}@${pack.version} missing required table: ${tableName}`);
    }
    for (const [tableName, minimumRows] of Object.entries(pack.minimumTableRows ?? {})) {
      const count = database.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get().count;
      if (count < minimumRows) {
        throw new Error(`${pack.id}@${pack.version} ${tableName} row count ${count} is below ${minimumRows}`);
      }
    }
  } finally {
    database.close();
  }
}

// ─── current.json PUT + 재검증 ─────────────────────────────────────────────────
// GET으로 이전 sha256를 얻은 뒤 bytes를 PUT하고, 재GET으로 바이트 동일성을 검증한다.
// 이전 sha256(없으면 null)을 반환한다.

export async function putCurrentAndVerify(baseUrl, bytes, expectedPreviousSha256 = undefined) {
  const currentUrl = objectUrl(baseUrl, "catalog/current.json");
  const previous = await request(currentUrl, "GET");
  if (previous.statusCode !== 200 && previous.statusCode !== 404) {
    throw new Error(`current.json GET failed with HTTP ${previous.statusCode}`);
  }
  if (previous.statusCode === 200 && !previous.headers.etag) {
    throw new Error("current.json GET response is missing ETag");
  }
  const previousCurrentSha256 = previous.statusCode === 200 ? sha256(previous.body) : null;
  if (expectedPreviousSha256 !== undefined && previousCurrentSha256 !== expectedPreviousSha256) {
    throw new Error("current manifest changed during rescue");
  }
  const put = await request(currentUrl, "PUT", bytes, {
    "content-type": "application/json",
    "content-length": String(bytes.length),
    "cache-control": "public, max-age=60",
    [previous.statusCode === 200 ? "if-match" : "if-none-match"]:
      previous.statusCode === 200 ? previous.headers.etag : "*",
  });
  if (put.statusCode === 412) {
    throw new Error("current.json precondition failed; concurrent publish preserved");
  }
  if (put.statusCode < 200 || put.statusCode >= 300) {
    throw new Error(`current.json PUT failed with HTTP ${put.statusCode}`);
  }
  const verify = await request(currentUrl, "GET");
  if (sha256(verify.body) !== sha256(bytes)) {
    throw new Error("current.json byte-identity verification failed");
  }
  return previousCurrentSha256;
}

export async function putImmutableAndVerify(baseUrl, key, bytes) {
  const url = objectUrl(baseUrl, key);
  const expectedSha256 = sha256(bytes);
  const existing = await request(url, "GET");
  if (existing.statusCode === 200) {
    if (sha256(existing.body) !== expectedSha256) throw new Error(`${key} immutable collision`);
    return { created: false, sha256: expectedSha256 };
  }
  if (existing.statusCode !== 404) throw new Error(`${key} GET failed with HTTP ${existing.statusCode}`);
  const put = await request(url, "PUT", bytes, {
    "content-type": "application/json",
    "content-length": String(bytes.length),
    "cache-control": "public, max-age=31536000, immutable",
    "if-none-match": "*",
  });
  if (put.statusCode === 412) throw new Error(`${key} immutable collision`);
  if (put.statusCode < 200 || put.statusCode >= 300) {
    throw new Error(`${key} PUT failed with HTTP ${put.statusCode}`);
  }
  const verify = await request(url, "GET");
  if (verify.statusCode !== 200 || sha256(verify.body) !== expectedSha256) {
    throw new Error(`${key} byte-identity verification failed`);
  }
  return { created: true, sha256: expectedSha256 };
}
