#!/usr/bin/env node
// #1702 STANDARD 프리셋 환승소요시간 parity 리포트 생성기(tracked 산출물).
//
// 완료조건 evidence: STANDARD 프리셋(speedFactor 1.0)이 공식 환승 데이터의
// 소요시간과 편차 없이(0% ~ ±10% 이내) 일치함을 재현 가능한 리포트로 고정한다.
//
// 입력:
//   --baseline: tools/datapack/reports/baseline-ingestion-gate-report.json
//     (gateInternalConsistency.directionPairReport의 forwardMinTransferSeconds가
//      공식 환승 소요시간의 정본. 값은 여기서 읽으며 창작하지 않는다.)
//   --policy:   apps/mobile/release/mobility-profile-policy.json
//     (presets.STANDARD.speedFactor를 여기서 읽는다.)
//
// STANDARD는 speedFactor 1.0이므로 baseline 초에 곱해도 그대로다. 리포트는
// 각 방향쌍의 baseline 초·STANDARD 산출 초·편차 퍼센트와, 전체가 ±10% 이내인지를
// 명시한다. importer/normalizer/calculator 로직은 읽기만 하고 수정하지 않는다.
//
// 사용: node tools/datapack/build-mobility-standard-transfer-parity-report.mjs \
//   --baseline tools/datapack/reports/baseline-ingestion-gate-report.json \
//   --policy apps/mobile/release/mobility-profile-policy.json \
//   --output tools/datapack/reports/mobility-standard-transfer-parity-report.json
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { parseArgs, readJsonFile, requireArg, sortJson } from "./lib/ledger-admission-cli.mjs";

const DEVIATION_TOLERANCE_PERCENT = 10;

// STANDARD 프리셋을 baseline 초에 적용한 산출 초. backend ProfileWalkTimeCalculator.estimateSeconds의
// Math.toIntExact(Math.ceilDiv((long) baselineSeconds * preset.speedFactorPercent, 100))와 동일한
// 정수 나눗셈 올림(ceil division)을 구현한다. 부동소수 Math.ceil은 큰 값에서 부동소수 오차로 backend와
// 어긋날 수 있어 쓰지 않는다. speedFactorPercent=100(STANDARD)에서는 항등(standardSeconds(x,100)===x)이다.
export function standardSeconds(baselineSeconds, speedFactorPercent) {
  return Math.floor((baselineSeconds * speedFactorPercent + 99) / 100);
}

export function buildMobilityStandardTransferParityReport({ baseline, policy }) {
  const standardPreset = policy?.presets?.STANDARD;
  if (!standardPreset || typeof standardPreset.speedFactor !== "number") {
    throw new Error("policy.presets.STANDARD.speedFactor missing");
  }
  const speedFactor = standardPreset.speedFactor;
  const speedFactorPercent = Math.round(speedFactor * 100);

  const directionPairReport =
    baseline?.gateInternalConsistency?.directionPairReport;
  if (!Array.isArray(directionPairReport) || directionPairReport.length === 0) {
    throw new Error("baseline.gateInternalConsistency.directionPairReport missing");
  }

  const pairs = directionPairReport.map((pair) => {
    const baselineSeconds = pair.forwardMinTransferSeconds;
    if (typeof baselineSeconds !== "number") {
      throw new Error(
        `forwardMinTransferSeconds missing for ${pair.stationId} ${pair.fromLineId}->${pair.toLineId}`,
      );
    }
    const standard = standardSeconds(baselineSeconds, speedFactorPercent);
    const deviationSeconds = standard - baselineSeconds;
    const deviationPercent =
      baselineSeconds === 0 ? 0 : (deviationSeconds / baselineSeconds) * 100;
    return {
      stationId: pair.stationId,
      fromLineId: pair.fromLineId,
      toLineId: pair.toLineId,
      baselineTransferSeconds: baselineSeconds,
      standardPresetSeconds: standard,
      deviationSeconds,
      deviationPercent: Number(deviationPercent.toFixed(4)),
      withinTolerance: Math.abs(deviationPercent) <= DEVIATION_TOLERANCE_PERCENT,
    };
  });

  const maxAbsoluteDeviationPercent = pairs.reduce(
    (max, pair) => Math.max(max, Math.abs(pair.deviationPercent)),
    0,
  );

  return {
    schemaVersion: 1,
    artifactKind: "mobility-standard-transfer-parity-report",
    issue: 1702,
    description:
      "STANDARD 프리셋(speedFactor 1.0)이 공식 환승 소요시간 baseline과 ±10% 이내로 일치함을 고정하는 재현 가능 리포트. baseline 초는 baseline-ingestion-gate-report.json의 gateInternalConsistency.directionPairReport에서 읽는다.",
    baselineSource: {
      artifactKind: baseline?.artifactKind ?? null,
      directionPairSource: "gateInternalConsistency.directionPairReport",
      admittedTransferRules: baseline?.coverage?.transfer?.admittedRules ?? null,
    },
    standardPreset: {
      speedFactor,
      speedFactorPercent,
    },
    toleranceProfile: {
      maxDeviationPercent: DEVIATION_TOLERANCE_PERCENT,
    },
    summary: {
      pairCount: pairs.length,
      maxAbsoluteDeviationPercent: Number(maxAbsoluteDeviationPercent.toFixed(4)),
      allWithinTolerance: pairs.every((pair) => pair.withinTolerance),
    },
    directionPairs: pairs,
  };
}

async function main(argv) {
  const args = parseArgs(argv);
  const baseline = await readJsonFile(requireArg(args, "baseline"));
  const policy = await readJsonFile(requireArg(args, "policy"));
  const outputPath = requireArg(args, "output");

  const report = buildMobilityStandardTransferParityReport({ baseline, policy });

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(sortJson(report), null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
