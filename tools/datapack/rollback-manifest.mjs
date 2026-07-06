#!/usr/bin/env node
import { createHash } from "node:crypto";
import http from "node:http";
import https from "node:https";
import {
  validateManifest,
} from "./lib/manifest-validation.mjs";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const targetSequence = Number(requireArg(args, "target-sequence"));
  const channel = requireArg(args, "channel");
  const baseUrl = new URL(requireArg(args, "base-url"));
  const reason = requireArg(args, "reason");
  const idempotencyKey = requireArg(args, "idempotency-key");
  const dryRun = args.has("dry-run");

  if (!Number.isInteger(targetSequence) || targetSequence < 1) {
    throw new Error("--target-sequence must be a positive integer");
  }

  // (1) releases/<N>.json GET + 검증
  const releaseKey = `catalog/releases/${targetSequence}.json`;
  const releaseResponse = await request(objectUrl(baseUrl, releaseKey), "GET");
  if (releaseResponse.statusCode !== 200) {
    throw new Error(`rollback target ${releaseKey} not found (HTTP ${releaseResponse.statusCode})`);
  }
  const releaseBytes = releaseResponse.body;
  const manifest = JSON.parse(releaseBytes.toString("utf8"));
  // validateManifest는 manifestVersion 2의 서명 검증을 내부에서 수행한다
  validateManifest(manifest, { requireProduction: channel === "production" });

  // (2) 채널 대조
  if (manifest.channel !== channel) {
    throw new Error(`rollback channel mismatch: manifest=${manifest.channel} expected=${channel}`);
  }

  // (3) 만료 거부
  if (new Date(manifest.expiresAt).getTime() < Date.now()) {
    throw new Error("rollback target expired; rebuild required");
  }

  // (4) 참조 팩 존재·sha256 대조
  // preauth(OCI PAR) 대상은 HEAD/meta sha를 신뢰할 수 없어(publish-object-storage와 동일 이유)
  // GET 본문 sha256을 manifest pack.sha256과 직접 대조한다 — 팩이 훼손·교체되면 스왑 거부(fail-closed).
  for (const pack of manifest.packs) {
    const packKey = pack.url && !/^https:\/\//.test(pack.url) ? pack.url : `catalog/${pack.id}-v${pack.version}.sqlite.gz`;
    const packResponse = await request(objectUrl(baseUrl, packKey), "GET");
    if (packResponse.statusCode !== 200) {
      throw new Error(`rollback target references missing pack ${packKey} (HTTP ${packResponse.statusCode})`);
    }
    const storedSha256 = sha256(packResponse.body);
    if (storedSha256 !== pack.sha256) {
      throw new Error(`rollback target pack ${packKey} sha256 mismatch: stored=${storedSha256} manifest=${pack.sha256}`);
    }
  }

  // (5) 바이트 동일 current.json PUT + 재검증
  const currentUrl = objectUrl(baseUrl, "catalog/current.json");
  const previous = await request(currentUrl, "GET");
  const previousCurrentSha256 = previous.statusCode === 200 ? sha256(previous.body) : null;
  if (!dryRun) {
    const put = await request(currentUrl, "PUT", releaseBytes, {
      "content-type": "application/json",
      "content-length": String(releaseBytes.length),
      "cache-control": "public, max-age=60",
    });
    if (put.statusCode < 200 || put.statusCode >= 300) {
      throw new Error(`current.json PUT failed with HTTP ${put.statusCode}`);
    }
    const verify = await request(currentUrl, "GET");
    if (sha256(verify.body) !== sha256(releaseBytes)) {
      throw new Error("current.json byte-identity verification failed");
    }
  }

  process.stdout.write(`${JSON.stringify({
    targetSequence, channel, previousCurrentSha256,
    newCurrentSha256: sha256(releaseBytes), reason, idempotencyKey,
  })}\n`);
}

function request(url, method, body = Buffer.alloc(0), headers = {}) {
  const transport = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const chunks = [];
    const req = transport.request(url, { method, headers }, (res) => {
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => { res.body = Buffer.concat(chunks); resolve(res); });
    });
    req.on("error", reject);
    if (body.length > 0) req.write(body);
    req.end();
  });
}

function objectUrl(baseUrl, key) {
  const url = new URL(baseUrl.toString());
  const base = url.pathname.replace(/\/+$/, "");
  url.pathname = `${base}/${key.split("/").map(encodeURIComponent).join("/")}`;
  return url;
}

function parseArgs(argv) {
  const args = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === "--dry-run") { args.set("dry-run", "true"); continue; }
    const value = argv[i + 1];
    if (!key?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error(`invalid argument near ${key ?? "<end>"}`);
    }
    args.set(key.slice(2), value); i += 1;
  }
  return args;
}

function requireArg(args, name) {
  const v = args.get(name);
  if (!v) throw new Error(`missing required argument: --${name}`);
  return v;
}

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
