#!/usr/bin/env node
import {
  validateManifest,
} from "./lib/manifest-validation.mjs";
import {
  request,
  objectUrl,
  sha256,
  verifyReferencedPacks,
  putCurrentAndVerify,
} from "./lib/object-storage-publish.mjs";

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

  // (4) 참조 팩 존재·sha256 대조 (lib 공유, fail-closed)
  await verifyReferencedPacks(baseUrl, manifest);

  // (5) 바이트 동일 current.json PUT + 재검증 (dry-run 시 GET만)
  let previousCurrentSha256;
  if (dryRun) {
    const currentUrl = objectUrl(baseUrl, "catalog/current.json");
    const previous = await request(currentUrl, "GET");
    previousCurrentSha256 = previous.statusCode === 200 ? sha256(previous.body) : null;
  } else {
    previousCurrentSha256 = await putCurrentAndVerify(baseUrl, releaseBytes);
  }

  process.stdout.write(`${JSON.stringify({
    targetSequence, channel, previousCurrentSha256,
    newCurrentSha256: sha256(releaseBytes), reason, idempotencyKey,
  })}\n`);
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

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
