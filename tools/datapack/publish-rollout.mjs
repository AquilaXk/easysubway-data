#!/usr/bin/env node
// #1692: releases/<N>.json을 rollout 변환 후 catalog/current.json으로 PUT 게시.
// 흐름: GET releases/<N> + current.json → buildRolloutManifest → verifyReferencedPacks(fail-closed)
//       → putCurrentAndVerify(변환본) / dry-run 시 PUT 생략.
import {
  request,
  objectUrl,
  sha256,
  verifyReferencedPacks,
  putCurrentAndVerify,
} from "./lib/object-storage-publish.mjs";
import {
  validateManifest,
} from "./lib/manifest-validation.mjs";
import { buildRolloutManifest } from "./update-rollout.mjs";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const targetSequence = Number(requireArg(args, "target-sequence"));
  const percentage = Number(requireArg(args, "percentage"));
  const baseUrl = new URL(requireArg(args, "base-url"));
  const channel = args.get("channel") ?? "production";
  const reason = args.get("reason") ?? null;
  const idempotencyKey = args.get("idempotency-key") ?? null;
  const dryRun = args.has("dry-run");

  if (!Number.isInteger(targetSequence) || targetSequence < 1) {
    throw new Error("--target-sequence must be a positive integer");
  }
  if (!Number.isInteger(percentage) || percentage < 0 || percentage > 100) {
    throw new Error("--percentage must be integer 0..100");
  }

  // (1) releases/<N>.json GET + 검증
  const releaseKey = `catalog/releases/${targetSequence}.json`;
  const releaseResponse = await request(objectUrl(baseUrl, releaseKey), "GET");
  if (releaseResponse.statusCode !== 200) {
    throw new Error(`rollout target ${releaseKey} not found (HTTP ${releaseResponse.statusCode})`);
  }
  const manifest = JSON.parse(releaseResponse.body.toString("utf8"));
  validateManifest(manifest, { requireProduction: channel === "production", releasesTarget: true });

  // (2) current.json GET (seed 계승 + previousSha 기록용)
  const currentUrl = objectUrl(baseUrl, "catalog/current.json");
  const currentRes = await request(currentUrl, "GET");
  const currentBytes = currentRes.statusCode === 200 ? currentRes.body : null;
  const current = currentBytes ? JSON.parse(currentBytes.toString("utf8")) : null;
  const previousCurrentSha256 = currentBytes ? sha256(currentBytes) : null;

  // (3) rollout 변환본 계산
  const rolloutManifest = buildRolloutManifest({ releases: manifest, current, targetSequence, percentage });
  const rolloutBytes = Buffer.from(JSON.stringify(rolloutManifest));

  // (4) 참조 팩 존재·sha256 대조 (fail-closed)
  await verifyReferencedPacks(baseUrl, manifest);

  // (5) current.json PUT + 재검증 (dry-run 시 생략)
  if (!dryRun) {
    await putCurrentAndVerify(baseUrl, rolloutBytes);
  }

  process.stdout.write(`${JSON.stringify({
    targetSequence, percentage, channel, previousCurrentSha256,
    newCurrentSha256: sha256(rolloutBytes), reason, idempotencyKey,
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
