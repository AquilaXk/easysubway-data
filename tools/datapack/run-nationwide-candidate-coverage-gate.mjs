#!/usr/bin/env node
// #2514 (#2510 B0) 전국 candidate pack 게이트 하네스.
//
// candidate spec → candidate fixture 조립 → build-datapack.mjs --fixture → report-coverage-gaps.mjs
// 실행을 한 명령으로 묶고, line-scope 재기술 전(baseline)/후(lineScoped) 두 variant를 같은 실행에서
// 돌려 MISSING → SUPPORTED 전이를 결정적 evidence로 남긴다.
//
// 왜 candidate가 root 단일 pack인가:
//   report-coverage-gaps.mjs의 판정 대상은 manifest의 required root pack(emergencyOverride + activePack
//   /default)뿐이고 각 root pack이 단독으로 coverage 계약을 만족해야 한다. 지역 pack을 병렬로 나열해도
//   provenance가 합산되지 않으므로 candidate는 root가 되는 단일 pack으로 조립한다.
//
// 왜 두 variant를 한 실행에서 돌리나:
//   before/after를 서로 다른 커밋에서 손으로 뽑으면 재현이 불가능하다. baseline variant는 재기술 대상
//   소스의 coverageScope.lineIds를 fixture와 inventory 사본에서 함께 지워 재기술 이전 상태를 복원한다.
//   같은 tracked 입력에서 before/after가 함께 나오므로 evidence가 언제든 재생성된다.
//
// 서명 키:
//   게이트는 root pack의 field provenance artifactKind가 production일 때만 coverage를 인정하고,
//   production pack 서명은 RSA 개인키를 요구한다. 하네스는 실행마다 임시 RSA-2048 키쌍을 만들어
//   자식 프로세스 env로만 주입한다 — 저장소·CI에 서명 비밀이 필요 없고 키가 디스크에 남지 않는다.
//
// 결정성:
//   임시 키로 만든 manifest·pack 서명과 그 서명이 들어간 manifest sha256, 그리고 런타임 SQLite 구현에
//   좌우되는 sqliteSha256은 evidence에 기록하지 않는다. resolutions 만료(nextReviewAt)는 게이트가
//   wall-clock으로 판정하므로 그 영향을 받는 EXPLICITLY_UNSUPPORTED·MISSING 집계도 기록하지 않는다.
//   기록 축은 SUPPORTED 판정과 분모뿐이며 이 축은 오프라인·키 없이 바이트 단위로 재현된다.
//
// 사용:
//   node tools/datapack/run-nationwide-candidate-coverage-gate.mjs \
//     --spec tools/datapack/nationwide-candidate-pack-spec.json \
//     --targets tools/datapack/nationwide-coverage-targets.json \
//     --inventory tools/datapack/source-inventory.json \
//     --resolution-plan tools/datapack/release/nationwide-public-api-coverage-search-plan-20260725.json \
//     --resolutions tools/datapack/release/nationwide-public-api-coverage-resolutions-20260725.json \
//     --output tools/datapack/reports/nationwide-candidate-coverage-gate.json
//
// 선택 인자:
//   --work-dir       중간 산출물(조립 fixture·빌드 결과·원본 게이트 리포트) 보존 경로. 생략하면 임시
//                    디렉터리를 쓰고 실행 후 지운다.
//   --emit-fixture   조립된 lineScoped candidate fixture를 이 경로에 남긴다(수동 재현·검수용).
import { execFile } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { codepointCompare } from "../lib/codepoint-compare.mjs";
import { isMainModule } from "../lib/is-main-module.mjs";
import { parseArgs, requireArg, sortJson } from "./lib/ledger-admission-cli.mjs";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "../..");

// 재생성 명령에 기록하는 tracked evidence 경로. --output이 임시 경로여도 산출 바이트가 달라지지 않도록
// 명령 문자열은 이 상수를 쓴다(재현성 검증이 임시 출력으로 가능해야 한다).
export const EVIDENCE_PATH = "tools/datapack/reports/nationwide-candidate-coverage-gate.json";
const TOOL_PATH = "tools/datapack/run-nationwide-candidate-coverage-gate.mjs";
const BUILDER_PATH = "tools/datapack/build-datapack.mjs";
const GATE_PATH = "tools/datapack/report-coverage-gaps.mjs";
const ALLOWED_FLAGS = new Set([
  "spec",
  "targets",
  "inventory",
  "resolution-plan",
  "resolutions",
  "output",
  "work-dir",
  "emit-fixture",
]);
const SPEC_ARTIFACT_KIND = "nationwide-candidate-pack-spec";
const CANDIDATE_ARTIFACT_KIND = "production";
const CANDIDATE_MANIFEST_CHANNEL = "candidate";
// 예약 TLD(.invalid, RFC 2606)라 어떤 게시 경로에서도 해석되지 않는다.
const NON_PUBLISHABLE_HOST = "easysubway-datapack-candidate.invalid";
const SIGNING_MODE = "EPHEMERAL_RSA_2048";

export async function runNationwideCandidateCoverageGate({
  spec,
  specInput,
  targetsInput,
  inventory,
  inventoryInput,
  resolutionPlanInput,
  resolutionsInput,
  workDir,
  emitFixturePath = null,
}) {
  validateSpec(spec);
  assertInventoryLineScopeSync(spec, inventory);
  // 승계 원본도 입력 해시 축에 넣는다. 경로·pack 정체성만 기록하면 원본 좌표 같은 값 drift가
  // evidence를 바이트 동일하게 통과시킨다(구조 drift만 잡히는 상태) — 파일 바이트로 결속한다.
  const inheritedInput = await readJsonInput(spec.inheritsFrom.path);
  const inherited = inheritedInput.document;

  const signing = ephemeralSigningKeys();
  const variants = {};
  const reports = {};
  for (const lineScoped of [false, true]) {
    const variant = lineScoped ? "lineScoped" : "baseline";
    const variantDir = path.join(workDir, variant);
    await mkdir(variantDir, { recursive: true });

    const fixture = materializeCandidateFixture(spec, inherited, { lineScoped });
    const fixturePath = path.join(variantDir, "nationwide-candidate-pack.json");
    await writeJson(fixturePath, fixture);
    if (lineScoped && emitFixturePath) {
      await writeJson(path.resolve(root, emitFixturePath), fixture);
    }

    // baseline은 재기술 이전 상태를 복원해야 하므로 inventory 사본에서도 같은 lineIds를 지운다.
    // lineScoped는 tracked inventory를 그대로 읽어 evidence가 커밋된 정본에 직접 묶이게 한다.
    const inventoryPath = lineScoped
      ? path.resolve(root, inventoryInput.path)
      : path.join(variantDir, "source-inventory.json");
    if (!lineScoped) {
      await writeJson(inventoryPath, withoutLineScopeRedescriptions(spec, inventory));
    }

    const buildDir = path.join(variantDir, "build");
    await execFileAsync(process.execPath, [
      path.join(root, BUILDER_PATH),
      "--fixture", fixturePath,
      "--output", buildDir,
    ], { cwd: root, env: { ...process.env, ...signing.env } });

    const reportPath = path.join(variantDir, "coverage-gap-report.json");
    await execFileAsync(process.execPath, [
      path.join(root, GATE_PATH),
      "--targets", path.resolve(root, targetsInput.path),
      "--inventory", inventoryPath,
      "--manifest", path.join(buildDir, "current.json"),
      "--provenance", path.join(buildDir, "current.provenance.json"),
      "--resolution-plan", path.resolve(root, resolutionPlanInput.path),
      "--resolutions", path.resolve(root, resolutionsInput.path),
      "--output", reportPath,
      // 전국 gap은 아직 남아 있으므로 게이트를 리포트 모드로 돌린다(게시 차단 판정은 이 하네스의 축이 아니다).
      "--allow-gaps",
    ], { cwd: root });

    reports[variant] = JSON.parse(await readFile(reportPath, "utf8"));
    const provenance = JSON.parse(await readFile(path.join(buildDir, "current.provenance.json"), "utf8"));
    variants[variant] = summarizeVariant(spec, reports[variant], provenance);
  }

  return buildEvidence({
    spec,
    inputs: {
      spec: specInput,
      targets: targetsInput,
      inventory: inventoryInput,
      resolutionPlan: resolutionPlanInput,
      resolutions: resolutionsInput,
      inheritedPack: inheritedInput.input,
    },
    reports,
    variants,
    signing,
  });
}

// candidate fixture 조립: 승계 pack을 그대로 복제하고 candidate 정체성과 line-scope 재기술만 덮어쓴다.
// 승계 원본(production 트랙 파일)은 읽기만 한다.
function materializeCandidateFixture(spec, inherited, { lineScoped }) {
  const inheritedPack = (inherited.packs ?? []).find(
    (pack) => pack.id === spec.inheritsFrom.packId && pack.version === spec.inheritsFrom.packVersion,
  );
  if (!inheritedPack) {
    throw new Error(
      `inherited pack is missing: ${spec.inheritsFrom.packId}@${spec.inheritsFrom.packVersion}`,
    );
  }
  const pack = structuredClone(inheritedPack);
  pack.id = spec.pack.id;
  pack.version = spec.pack.version;
  pack.artifactKind = spec.pack.artifactKind;
  pack.url = spec.pack.url;
  pack.metadata = { ...(pack.metadata ?? {}), ...(spec.pack.metadataOverrides ?? {}) };
  for (const redescription of spec.lineScopeRedescriptions) {
    const source = (pack.sourceInventory ?? []).find(({ id }) => id === redescription.sourceId);
    if (!source) {
      throw new Error(`redescribed source is missing from inherited pack: ${redescription.sourceId}`);
    }
    source.coverageScope = coverageScopeWithLineIds(
      source.coverageScope,
      lineScoped ? redescription.lineIds : null,
      `${redescription.sourceId}.coverageScope`,
    );
  }
  return {
    manifest: {
      manifestVersion: spec.manifest.manifestVersion,
      channel: spec.manifest.channel,
      releaseSequence: spec.manifest.releaseSequence,
      publishedAt: spec.manifest.publishedAt,
      expiresAt: spec.manifest.expiresAt,
      keyId: spec.manifest.keyId,
      ttlSeconds: spec.manifest.ttlSeconds,
      activePack: { id: spec.pack.id, version: spec.pack.version },
    },
    packs: [pack],
  };
}

// baseline inventory: 재기술 대상 소스의 lineIds만 지운 사본(다른 소스의 line-scope는 그대로 둔다).
function withoutLineScopeRedescriptions(spec, inventory) {
  const copy = structuredClone(inventory);
  for (const redescription of spec.lineScopeRedescriptions) {
    const source = copy.sources.find(({ id }) => id === redescription.sourceId);
    source.coverageScope = coverageScopeWithLineIds(
      source.coverageScope,
      null,
      `${redescription.sourceId}.coverageScope`,
    );
  }
  return copy;
}

function coverageScopeWithLineIds(coverageScope, lineIds, label) {
  if (!coverageScope || typeof coverageScope !== "object" || Array.isArray(coverageScope)) {
    throw new Error(`${label} must be an object`);
  }
  // coverageScope에 새 key가 생겨도 조립분에서 조용히 탈락하지 않도록 spread로 보존한다
  // (고정 key 재조립은 미래 key를 무성 유실시킨다).
  const { lineIds: _dropped, ...rest } = coverageScope;
  return lineIds === null ? rest : { ...rest, lineIds: [...lineIds] };
}

// fixture와 tracked inventory의 line-scope 재기술이 어긋나면 게이트 판정이 조용히 갈린다 — fail closed.
function assertInventoryLineScopeSync(spec, inventory) {
  for (const redescription of spec.lineScopeRedescriptions) {
    const source = (inventory.sources ?? []).find(({ id }) => id === redescription.sourceId);
    if (!source) {
      throw new Error(`redescribed source is missing from source inventory: ${redescription.sourceId}`);
    }
    const actual = source.coverageScope?.lineIds ?? [];
    if (JSON.stringify(actual) !== JSON.stringify(redescription.lineIds)) {
      throw new Error(
        `source inventory coverageScope.lineIds must match the spec redescription: ${redescription.sourceId}`,
      );
    }
    if (!source.coverageScope?.sourceDomains?.includes(redescription.sourceDomain)) {
      throw new Error(
        `source inventory coverageScope.sourceDomains must include ${redescription.sourceDomain}: ${redescription.sourceId}`,
      );
    }
  }
}

function summarizeVariant(spec, report, provenance) {
  const supportedRequirementKeys = report.requirements
    .filter((entry) => entry.status === "SUPPORTED")
    .map(requirementKey)
    .sort(codepointCompare);
  return {
    supportedRequirementKeys,
    launchRequired: supportedCounts(report.summary.launchRequired),
    enhancement: supportedCounts(report.summary.enhancement),
    pilotRequirements: spec.lineScopeRedescriptions
      .flatMap(({ requirementKeys }) => requirementKeys)
      .sort(codepointCompare)
      .map((key) => pilotRequirement(report, key, provenance)),
  };
}

function supportedCounts(tier) {
  // EXPLICITLY_UNSUPPORTED·MISSING 집계는 resolutions 만료(wall-clock)에 좌우되므로 기록하지 않는다.
  return {
    totalCount: tier.totalCount,
    supportedCount: tier.supportedCount,
    supportedRatio: tier.supportedRatio,
  };
}

function pilotRequirement(report, key, provenance) {
  const entry = report.requirements.find((requirement) => requirementKey(requirement) === key);
  if (!entry) throw new Error(`pilot requirement is not in the coverage report: ${key}`);
  return {
    requirementKey: key,
    releaseTier: entry.releaseTier,
    status: entry.status,
    // denominator·coveredFields는 domain requiredFields 개수이지 데이터 행 수가 아니다.
    // 실제 뒷받침 행 수는 supportingRecordCountByField로 따로 기록한다.
    denominator: entry.denominator,
    coveredFields: entry.coveredFields,
    coverageRatio: entry.coverageRatio,
    blockingThreshold: entry.blockingThreshold,
    missingFields: entry.missingFields,
    sourceIds: entry.sourceIds,
    fieldCoverage: entry.fieldCoverage.map(({ field, status, sourceIds }) => ({ field, status, sourceIds })),
    supportingRecordCountByField: supportingRecordCountByField(provenance, entry),
  };
}

// requirement scope와 정확히 일치하는 official/field-verified provenance 레코드 수를 필드별로 센다.
// "분모 2 = 데이터 2행"으로 읽히는 오독을 막는 뒷받침 행수 축이다(결정적 — 개수만 기록한다).
function supportingRecordCountByField(provenance, entry) {
  const records = (provenance.packs ?? []).flatMap((pack) => pack.records ?? []);
  return Object.fromEntries(entry.fieldCoverage.map(({ field }) => [
    field,
    records.filter((record) =>
      record.field === field
      && ["OFFICIAL", "FIELD_VERIFIED"].includes(record.derivationKind)
      && (record.coverageScope?.regionIds ?? []).includes(entry.regionId)
      && (record.coverageScope?.operatorIds ?? []).includes(entry.operatorId)
      && (record.coverageScope?.lineIds ?? []).includes(entry.lineId)
      && (record.coverageScope?.sourceDomains ?? []).includes(entry.sourceDomain)).length,
  ]));
}

function buildEvidence({ spec, inputs, reports, variants, signing }) {
  const expectedKeys = spec.lineScopeRedescriptions
    .flatMap(({ requirementKeys }) => requirementKeys)
    .sort(codepointCompare);
  assertCandidateRootPack(spec, reports);
  // 전이 판정은 절대 수치가 아니라 두 variant의 상대 비교다. baseline SUPPORTED 총량을 0으로 못박으면
  // 승계 팩의 다른 소스가 line-scope를 갖는 순간(#2510 로드맵의 정상 진행) 무관한 PR에서 하네스가 깨진다.
  // 아래 두 축은 그대로 fail closed로 남는다: 파일럿 키가 baseline에 이미 있으면 전이 실증이 성립하지 않고,
  // lineScoped가 baseline ∪ 파일럿 키와 다르면 선언보다 넓거나 좁은 전이가 일어난 것이다.
  const baselineKeys = variants.baseline.supportedRequirementKeys;
  const alreadySupported = expectedKeys.filter((key) => baselineKeys.includes(key));
  if (alreadySupported.length > 0) {
    throw new Error(
      `pilot requirements must be MISSING before the line-scope redescription: ${alreadySupported.join(",")}`,
    );
  }
  const expectedLineScopedKeys = [...new Set([...baselineKeys, ...expectedKeys])].sort(codepointCompare);
  if (JSON.stringify(variants.lineScoped.supportedRequirementKeys) !== JSON.stringify(expectedLineScopedKeys)) {
    throw new Error(
      "line-scoped SUPPORTED requirements must equal baseline plus the spec redescription requirementKeys: "
        + `expected ${expectedLineScopedKeys.join(",")}, got ${variants.lineScoped.supportedRequirementKeys.join(",")}`,
    );
  }
  const baselineStatuses = new Map(
    reports.baseline.requirements.map((entry) => [requirementKey(entry), entry.status]),
  );
  const transitions = variants.lineScoped.pilotRequirements.map((entry) => ({
    requirementKey: entry.requirementKey,
    before: baselineStatuses.get(entry.requirementKey),
    after: entry.status,
    sourceIds: entry.sourceIds,
    coveredFields: entry.coveredFields,
    denominator: entry.denominator,
  }));

  return {
    schemaVersion: 1,
    artifactKind: "nationwide-candidate-coverage-gate-evidence",
    issue: spec.issue,
    parentIssues: [...spec.parentIssues],
    targetVersion: reports.lineScoped.targetVersion,
    regeneration: {
      command: regenerationCommand(inputs),
      evidencePath: EVIDENCE_PATH,
      pairedUpdateKo:
        "spec·targets·inventory·resolutions·search plan을 바꾸는 PR은 이 명령으로 evidence를 함께 재생성해야 "
        + "한다. inventory를 바꾸면 tools/datapack/reports/nationwide-coverage-tally.json도 그 ledger의 "
        + "regeneration.command로 같이 재생성한다. 재생성 누락은 datapack 도구 테스트에서 fail closed 된다.",
    },
    harness: {
      tool: TOOL_PATH,
      builder: BUILDER_PATH,
      gate: GATE_PATH,
      offlineKo: "네트워크 호출이 없다. 입력은 전부 tracked 파일이고 산출물은 임시 작업 디렉터리에만 쓴다.",
      signing: {
        mode: SIGNING_MODE,
        keyIdKo: signing.noteKo,
      },
    },
    determinism: {
      recordedAxesKo:
        "SUPPORTED 판정(requirement 키·필드 근거·소스)과 tier 분모만 기록한다. 이 축은 tracked 입력만으로 "
        + "오프라인·서명 키 없이 바이트 단위 재현된다.",
      excludedAxes: [
        "candidate.manifestSha256",
        "manifest.signature",
        "packs[].signature",
        "packs[].sqliteSha256",
        "summary.*.explicitlyUnsupportedCount",
        "summary.*.missingCount",
        "summary.*.terminalResolutionRatio",
      ],
      excludedAxesReasonKo:
        "manifest·pack 서명과 그 서명이 포함된 manifest sha256은 실행마다 새로 만드는 임시 RSA 키에 좌우되고, "
        + "sqliteSha256은 런타임 SQLite 구현에 좌우된다. EXPLICITLY_UNSUPPORTED·MISSING 집계는 게이트가 "
        + "resolutions nextReviewAt을 wall-clock으로 판정하므로 시간이 지나면 같은 입력에서도 값이 갈린다.",
      packPayloadIdenticalAcrossVariants: true,
      packPayloadIdenticalReasonKo:
        "line-scope 재기술은 소스 coverageScope 기술만 바꾸고 pack row 데이터를 바꾸지 않는다 — 두 variant의 "
        + "sqliteSha256이 같은 실행에서 동일함을 하네스가 확인한다.",
    },
    readingGuide: {
      denominatorSemanticsKo:
        "pilotRequirements의 denominator·coveredFields는 domain requiredFields 개수이지 데이터 행 수가 아니다. "
        + "route_map_positions의 denominator 2는 필수 필드 2개(route_map_position·route_map_label_polygon)를 "
        + "뜻하며 역 2개나 행 2개를 뜻하지 않는다. 실제로 그 판정을 뒷받침한 provenance 행 수는 필드별 "
        + "supportingRecordCountByField에 따로 기록한다.",
      supportedScopeKo:
        "이 evidence는 SUPPORTED 축만 기록하므로 전국 gap 총량 판독에 쓰면 안 된다. 전국 진행 집계는 "
        + "tools/datapack/reports/nationwide-coverage-tally.json이 정본이다.",
      variantComparisonKo:
        "전이 판정은 두 variant의 상대 비교다. baseline SUPPORTED 총량은 승계 팩의 다른 소스가 line-scope를 "
        + "갖게 되면 함께 늘어날 수 있고, 하네스는 파일럿 키가 baseline에 없고 lineScoped가 baseline ∪ 파일럿 "
        + "키와 정확히 같은지만 fail closed로 본다.",
    },
    inputs: Object.fromEntries(
      Object.entries(inputs).map(([name, input]) => [name, { path: input.path, sha256: input.sha256 }]),
    ),
    candidatePack: {
      id: spec.pack.id,
      version: spec.pack.version,
      artifactKind: spec.pack.artifactKind,
      manifestChannel: spec.manifest.channel,
      candidateId: spec.candidateId,
      inheritsFrom: {
        path: spec.inheritsFrom.path,
        packId: spec.inheritsFrom.packId,
        packVersion: spec.inheritsFrom.packVersion,
      },
      rootPackRuleKo:
        "게이트는 manifest의 required root pack(emergencyOverride + activePack/default)만 판정하고 각 root "
        + "pack이 단독으로 coverage 계약을 만족해야 한다. candidate manifest는 이 pack 하나만 root로 둔다.",
    },
    lineScopeRedescriptions: spec.lineScopeRedescriptions.map((redescription) => ({
      sourceId: redescription.sourceId,
      sourceDomain: redescription.sourceDomain,
      lineIds: [...redescription.lineIds],
      requirementKeys: [...redescription.requirementKeys],
    })),
    variants: {
      baseline: {
        descriptionKo:
          "line-scope 재기술 이전 상태. 재기술 대상 소스의 coverageScope.lineIds를 candidate fixture와 "
          + "inventory 사본에서 함께 지워 operator-scope provenance만 나오게 한 실행이다.",
        ...variants.baseline,
      },
      lineScoped: {
        descriptionKo:
          "line-scope 재기술 이후 상태. candidate fixture와 tracked source-inventory.json이 같은 lineIds를 "
          + "기술해 (operator, line) 단일 pair provenance가 나온 실행이다.",
        ...variants.lineScoped,
      },
    },
    transitions,
  };
}

function assertCandidateRootPack(spec, reports) {
  for (const [variant, report] of Object.entries(reports)) {
    const packs = report.candidate?.packs ?? [];
    if (packs.length !== 1) {
      throw new Error(`${variant} candidate manifest must have exactly one required root pack`);
    }
    const [pack] = packs;
    if (pack.id !== spec.pack.id || pack.version !== spec.pack.version) {
      throw new Error(`${variant} candidate root pack identity mismatch: ${pack.id}@${pack.version}`);
    }
    if (pack.artifactKind !== CANDIDATE_ARTIFACT_KIND) {
      throw new Error(`${variant} candidate root pack artifactKind must be ${CANDIDATE_ARTIFACT_KIND}`);
    }
  }
  if (reports.baseline.candidate.packs[0].sqliteSha256 !== reports.lineScoped.candidate.packs[0].sqliteSha256) {
    throw new Error("line-scope redescription must not change candidate pack payload bytes");
  }
}

function requirementKey({ regionId, operatorId, lineId, sourceDomain }) {
  return `${regionId}:${operatorId}:${lineId}:${sourceDomain}`;
}

function regenerationCommand(inputs) {
  return [
    "node",
    TOOL_PATH,
    "--spec", inputs.spec.path,
    "--targets", inputs.targets.path,
    "--inventory", inputs.inventory.path,
    "--resolution-plan", inputs.resolutionPlan.path,
    "--resolutions", inputs.resolutions.path,
    "--output", EVIDENCE_PATH,
  ].join(" ");
}

function ephemeralSigningKeys() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    noteKo:
      "production artifactKind pack은 RSA 서명이 필수라 실행마다 임시 RSA-2048 키쌍을 만들어 자식 프로세스 "
      + "env로만 주입한다. 저장소·CI 비밀에 서명 키가 필요 없고 키는 디스크에 남지 않는다.",
    env: {
      EASYSUBWAY_DATAPACK_SIGNING_PRIVATE_KEY_PEM: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      EASYSUBWAY_DATAPACK_SIGNING_PUBLIC_KEY_PEM: publicKey.export({ type: "spki", format: "pem" }).toString(),
    },
  };
}

function validateSpec(spec) {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
    throw new Error("candidate spec must be an object");
  }
  if (spec.schemaVersion !== 1) throw new Error("candidate spec schemaVersion must be 1");
  if (spec.artifactKind !== SPEC_ARTIFACT_KIND) {
    throw new Error(`candidate spec artifactKind must be ${SPEC_ARTIFACT_KIND}`);
  }
  if (!Number.isInteger(spec.issue) || spec.issue <= 0) {
    throw new Error("candidate spec issue must be a positive integer");
  }
  if (!Array.isArray(spec.parentIssues) || spec.parentIssues.some((issue) => !Number.isInteger(issue))) {
    throw new Error("candidate spec parentIssues must be an integer array");
  }
  requiredString(spec.candidateId, "candidate spec candidateId");
  requiredString(spec.inheritsFrom?.path, "candidate spec inheritsFrom.path");
  requiredString(spec.inheritsFrom?.packId, "candidate spec inheritsFrom.packId");
  requiredString(spec.inheritsFrom?.packVersion, "candidate spec inheritsFrom.packVersion");
  // candidate 안전 경계는 주석이 아니라 단언으로 강제한다. 이 도구는 artifactKind production으로
  // 실제 RSA 서명 manifest를 만들기 때문에, spec 편집만으로 production 채널·게시 가능 URL 서명본이
  // 나오면 안 된다(심층방어 — 게시 경로에 오르지 못하게 채널과 호스트를 fail closed로 묶는다).
  if (spec.manifest?.channel !== CANDIDATE_MANIFEST_CHANNEL) {
    throw new Error(`candidate spec manifest.channel must be ${CANDIDATE_MANIFEST_CHANNEL}`);
  }
  requiredString(spec.manifest?.publishedAt, "candidate spec manifest.publishedAt");
  requiredString(spec.manifest?.expiresAt, "candidate spec manifest.expiresAt");
  requiredString(spec.manifest?.keyId, "candidate spec manifest.keyId");
  if (spec.manifest.manifestVersion !== 2) throw new Error("candidate spec manifest.manifestVersion must be 2");
  if (!Number.isInteger(spec.manifest.releaseSequence) || spec.manifest.releaseSequence <= 0) {
    throw new Error("candidate spec manifest.releaseSequence must be a positive integer");
  }
  if (!Number.isInteger(spec.manifest.ttlSeconds) || spec.manifest.ttlSeconds <= 0) {
    throw new Error("candidate spec manifest.ttlSeconds must be a positive integer");
  }
  requiredString(spec.pack?.id, "candidate spec pack.id");
  requiredString(spec.pack?.version, "candidate spec pack.version");
  assertNonPublishablePackUrl(requiredString(spec.pack?.url, "candidate spec pack.url"));
  if (spec.pack.artifactKind !== CANDIDATE_ARTIFACT_KIND) {
    throw new Error(`candidate spec pack.artifactKind must be ${CANDIDATE_ARTIFACT_KIND}`);
  }
  if (spec.pack.id === spec.inheritsFrom.packId) {
    throw new Error("candidate pack id must differ from the inherited production pack id");
  }
  if (!Array.isArray(spec.lineScopeRedescriptions) || spec.lineScopeRedescriptions.length === 0) {
    throw new Error("candidate spec lineScopeRedescriptions must be a non-empty array");
  }
  const sourceIds = new Set();
  for (const redescription of spec.lineScopeRedescriptions) {
    const sourceId = requiredString(redescription?.sourceId, "lineScopeRedescriptions.sourceId");
    if (sourceIds.has(sourceId)) throw new Error(`duplicate line-scope redescription: ${sourceId}`);
    sourceIds.add(sourceId);
    requiredString(redescription.sourceDomain, `${sourceId}.sourceDomain`);
    // B0 파일럿은 (operator, line) 단일 pair 전환만 다룬다. 여러 노선을 한 번에 열려면 그 배치에서
    // 이 단언을 근거와 함께 넓혀야 한다 — spec 편집만으로 전환 범위가 넓어지지 않게 막는다.
    if (requiredStringArray(redescription.lineIds, `${sourceId}.lineIds`).length !== 1) {
      throw new Error(`${sourceId}.lineIds must describe exactly one line for the pilot redescription`);
    }
    requiredStringArray(redescription.requirementKeys, `${sourceId}.requirementKeys`);
  }
}

// candidate pack url은 예약 TLD(.invalid)만 허용한다. 게이트가 root pack artifactKind=production을
// 요구해 production 형태로 서명하지만, 그 산출물이 게시 가능한 호스트를 가리키면 안 된다.
function assertNonPublishablePackUrl(packUrl) {
  let url;
  try {
    url = new URL(packUrl);
  } catch {
    throw new Error("candidate spec pack.url must be an absolute URL");
  }
  if (url.protocol !== "https:") throw new Error("candidate spec pack.url must use https");
  if (url.hostname.toLowerCase().replace(/\.$/, "") !== NON_PUBLISHABLE_HOST) {
    throw new Error(`candidate spec pack.url host must be the non-publishable host ${NON_PUBLISHABLE_HOST}`);
  }
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} is required`);
  return value;
}

function requiredStringArray(value, label) {
  if (
    !Array.isArray(value)
    || value.length === 0
    || value.some((entry) => typeof entry !== "string" || entry.trim() === "")
  ) {
    throw new Error(`${label} must be a non-empty string array`);
  }
  return value;
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function readJsonInput(filePath) {
  const bytes = await readFile(path.resolve(root, filePath));
  return {
    document: JSON.parse(bytes.toString("utf8")),
    input: { path: filePath, sha256: createHash("sha256").update(bytes).digest("hex") },
  };
}

async function main(argv) {
  const args = parseArgs(argv);
  for (const flag of Object.keys(args)) {
    if (!ALLOWED_FLAGS.has(flag)) throw new Error(`unexpected argument: --${flag}`);
  }
  const outputPath = requireArg(args, "output");
  const spec = await readJsonInput(requireArg(args, "spec"));
  const targets = await readJsonInput(requireArg(args, "targets"));
  const inventory = await readJsonInput(requireArg(args, "inventory"));
  const resolutionPlan = await readJsonInput(requireArg(args, "resolution-plan"));
  const resolutions = await readJsonInput(requireArg(args, "resolutions"));

  const requestedWorkDir = args["work-dir"];
  const workDir = requestedWorkDir
    ? path.resolve(root, requestedWorkDir)
    : await mkdtemp(path.join(tmpdir(), "easysubway-nationwide-candidate-gate-"));
  try {
    await mkdir(workDir, { recursive: true });
    const evidence = await runNationwideCandidateCoverageGate({
      spec: spec.document,
      specInput: spec.input,
      targetsInput: targets.input,
      inventory: inventory.document,
      inventoryInput: inventory.input,
      resolutionPlanInput: resolutionPlan.input,
      resolutionsInput: resolutions.input,
      workDir,
      emitFixturePath: args["emit-fixture"] ?? null,
    });
    await mkdir(path.dirname(path.resolve(root, outputPath)), { recursive: true });
    await writeFile(path.resolve(root, outputPath), `${JSON.stringify(sortJson(evidence), null, 2)}\n`);
  } finally {
    if (!requestedWorkDir) {
      await rm(workDir, { recursive: true, force: true });
    }
  }
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
