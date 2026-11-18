#!/usr/bin/env node
// #1692: releases/<N>.json에 rollout 주입·재서명해 current.json 게시본 객체를 만든다(순수).
import { readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { manifestSignatureValue } from "./lib/manifest-signing.mjs";
import { validateManifest } from "./lib/manifest-validation.mjs";

export function buildRolloutManifest({ releases, current, targetSequence, percentage }) {
  if (releases.releaseSequence !== targetSequence) {
    throw new Error(`sequence mismatch: releases ${releases.releaseSequence} target ${targetSequence}`);
  }
  if (current && current.releaseSequence !== targetSequence) {
    throw new Error(`current.json은 다른 릴리즈(${current.releaseSequence}) — 릴리즈 전환은 production-publish/rollback만`);
  }
  if (!Number.isInteger(percentage) || percentage < 0 || percentage > 100) {
    throw new Error("percentage must be integer 0..100");
  }
  if (percentage === 100) {
    const { rollout: _drop, ...rest } = releases; // releases 본 그대로(서명 유효)
    return rest;
  }
  const seed = current?.rollout?.seed ?? randomBytes(16).toString("hex");
  const { signature: _dropSig, ...unsignedRest } = releases;
  const unsigned = { ...unsignedRest, rollout: { percentage, seed } };
  const out = { ...unsigned, signature: { ...releases.signature, value: manifestSignatureValue(unsigned) } };
  validateManifest(out, { requireProduction: true });
  return out;
}

// 얇은 CLI(standalone 산출)
function arg(n) { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined; }
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const releases = JSON.parse(readFileSync(arg("--releases-manifest"), "utf8"));
  const cp = arg("--current-manifest");
  const current = cp ? JSON.parse(readFileSync(cp, "utf8")) : null;
  const out = buildRolloutManifest({
    releases,
    current,
    targetSequence: Number(arg("--target-sequence")),
    percentage: Number(arg("--percentage")),
  });
  writeFileSync(arg("--out"), JSON.stringify(out));
}
