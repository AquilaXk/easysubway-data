#!/usr/bin/env node
// 이슈 #2531(DP-05): publish 직전 "live >= 앱 수락 하한" 불변식 게이트.
//
// 앱은 production 빌드에 절대 순번 하한을 심고 나간다(단일 원본:
// apps/mobile/release/datapack-manifest-acceptance-policy.json). 하한보다 낮은 순번의
// 매니페스트를 publish하면 그 하한을 심은 단말이 현행 매니페스트를 전량 거부하고
// 데이터팩 갱신이 멈춘다. 그래서 publish 경로에서 이 불변식을 fail closed로 막는다.
//
// workflow 인라인 `node -e`가 아니라 스크립트로 둔 이유: 비교 방향이 뒤집히거나 throw가
// 빠지는 회귀를 단위 테스트로 잡기 위해서다(인라인은 "문자열이 있다"까지만 검증된다).
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { parseArgs, requiredArg } from "./lib/cli-args.mjs";

export const DEFAULT_POLICY_PATH = "apps/mobile/release/datapack-manifest-acceptance-policy.json";

/**
 * 정책 자체의 불변식: 하한은 실제로 관측한 published 순번을 넘을 수 없다. 하한만 올리는
 * 변경은 관측 근거를 함께 갱신해야 통과한다. 이 불변식은 채널과 무관하게 늘 검사한다.
 *
 * 순번 하한 자체는 정책이 선언한 채널(`policy.channel`)의 매니페스트에만 적용한다.
 * 앱도 같은 조건에서만 하한을 심고 나가므로(`AppEndpoints.dataPackMinimumReleaseSequence`),
 * 다른 채널 후보를 production 하한으로 막으면 실제로 존재하지 않는 제약이 된다.
 * release-candidate 모드는 기본 채널이 production이 아니다(workflow 기본값 dev).
 */
export function acceptanceFloorViolations({ manifest, manifestSha256, policy }) {
  const violations = [];
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    return ["수락 정책 JSON을 읽지 못했다"];
  }
  if (policy.artifactKind !== "datapack-manifest-acceptance-policy") {
    violations.push(`정책 artifactKind는 datapack-manifest-acceptance-policy여야 한다 (실제: ${describe(policy.artifactKind)})`);
  }
  if (typeof policy.channel !== "string" || policy.channel.length === 0) {
    violations.push(`정책 channel은 비어 있지 않은 문자열이어야 한다 (실제: ${describe(policy.channel)})`);
  }
  const floor = policy.minimumReleaseSequence;
  if (!Number.isSafeInteger(floor) || floor < 1) {
    violations.push(`정책 minimumReleaseSequence는 1 이상 정수여야 한다 (실제: ${describe(floor)})`);
  }
  const evidence = policy.minimumReleaseSequenceEvidence;
  const observed = evidence?.observedReleaseSequence;
  if (!Number.isSafeInteger(observed) || observed < 1) {
    violations.push(`정책 관측 순번은 1 이상 정수여야 한다 (실제: ${describe(observed)})`);
  }
  if (Number.isSafeInteger(floor) && Number.isSafeInteger(observed) && floor > observed) {
    violations.push(`하한(${floor})은 관측한 published 순번(${observed})을 넘을 수 없다`);
  }

  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    violations.push("매니페스트를 읽지 못했다");
    return violations;
  }
  if (!appliesToManifest({ manifest, policy })) {
    return violations;
  }
  const sequence = manifest.releaseSequence;
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    violations.push(`매니페스트 releaseSequence는 1 이상 정수여야 한다 (실제: ${describe(sequence)})`);
  } else if (Number.isSafeInteger(floor) && sequence < floor) {
    violations.push(`매니페스트 releaseSequence(${sequence})가 앱 수락 하한(${floor}) 아래다`);
  }

  // 관측 근거가 자기신고 값에 머물지 않도록, 같은 순번의 매니페스트를 만나면 기록한
  // 해시와 대조한다. 기록이 실제 산출물과 다르면 그 자리에서 드러난다.
  if (Number.isSafeInteger(sequence) && sequence === observed && typeof manifestSha256 === "string") {
    if (evidence?.observedManifestSha256 !== manifestSha256) {
      violations.push(
        `관측 근거 sha256(${describe(evidence?.observedManifestSha256)})이 같은 순번 매니페스트의 실제 해시(${manifestSha256})와 다르다`,
      );
    }
  }
  return violations;
}

/** 하한이 이 매니페스트에 적용되는지. 정책이 선언한 채널의 매니페스트에만 적용한다. */
export function appliesToManifest({ manifest, policy }) {
  return manifest?.channel === policy?.channel;
}

function describe(value) {
  return value === undefined ? "undefined" : JSON.stringify(value);
}

async function main(argv) {
  const args = parseArgs(argv);
  const manifestPath = path.resolve(requiredArg(args, "manifest"));
  const policyPath = path.resolve(args.get("policy") ?? DEFAULT_POLICY_PATH);
  const manifestBytes = await readFile(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const policy = JSON.parse(await readFile(policyPath, "utf8"));
  const manifestSha256 = createHash("sha256").update(manifestBytes).digest("hex");
  const violations = acceptanceFloorViolations({ manifest, manifestSha256, policy });
  if (violations.length > 0) {
    throw new Error([
      "매니페스트가 앱 수락 하한 계약을 만족하지 않는다 — publish할 수 없다.",
      ...violations.map((violation) => `- ${violation}`),
      `manifest: ${manifestPath}`,
      `policy: ${policyPath}`,
    ].join("\n"));
  }
  process.stdout.write(`${JSON.stringify({
    status: appliesToManifest({ manifest, policy }) ? "PASS" : "SKIPPED_CHANNEL",
    channel: manifest.channel ?? null,
    policyChannel: policy.channel,
    releaseSequence: manifest.releaseSequence,
    minimumReleaseSequence: policy.minimumReleaseSequence,
    manifestSha256,
  })}\n`);
}

// main().catch(...)는 verify-release-request-binding.mjs 말미와 같은 리포 관용구다.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
