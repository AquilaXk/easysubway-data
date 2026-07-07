// #1692: 객체스토리지 PUT 공유 I/O — rollback-manifest·publish-rollout가 함께 사용.
import { createHash } from "node:crypto";
import http from "node:http";
import https from "node:https";

const REQUEST_TIMEOUT_MS = 30_000;

// ─── 기본 HTTP 요청 ────────────────────────────────────────────────────────────

export function request(url, method, body = Buffer.alloc(0), headers = {}) {
  const transport = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const chunks = [];
    const req = transport.request(url, { method, headers }, (res) => {
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => { res.body = Buffer.concat(chunks); resolve(res); });
      res.on("error", reject);
    });
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error(`request timeout after ${REQUEST_TIMEOUT_MS}ms`));
    });
    req.on("error", reject);
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

// ─── SHA-256 헬퍼 ─────────────────────────────────────────────────────────────

export function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

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

// ─── current.json PUT + 재검증 ─────────────────────────────────────────────────
// GET으로 이전 sha256를 얻은 뒤 bytes를 PUT하고, 재GET으로 바이트 동일성을 검증한다.
// 이전 sha256(없으면 null)을 반환한다.

export async function putCurrentAndVerify(baseUrl, bytes) {
  const currentUrl = objectUrl(baseUrl, "catalog/current.json");
  const previous = await request(currentUrl, "GET");
  const previousCurrentSha256 = previous.statusCode === 200 ? sha256(previous.body) : null;
  const put = await request(currentUrl, "PUT", bytes, {
    "content-type": "application/json",
    "content-length": String(bytes.length),
    "cache-control": "public, max-age=60",
  });
  if (put.statusCode < 200 || put.statusCode >= 300) {
    throw new Error(`current.json PUT failed with HTTP ${put.statusCode}`);
  }
  const verify = await request(currentUrl, "GET");
  if (sha256(verify.body) !== sha256(bytes)) {
    throw new Error("current.json byte-identity verification failed");
  }
  return previousCurrentSha256;
}
