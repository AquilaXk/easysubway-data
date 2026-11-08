import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { SEOUL_ROUTE_MAP_SOURCE_OPERATOR_IDS } from "./materialize-seoul-route-map-positions.mjs";
import { stageLocalMobileFixture } from "../ci/stage-local-mobile-fixture.mjs";
import { execFileAsync } from "./test-fixtures/datapack-tools-support.mjs";
import { sha256 } from "../lib/hash.mjs";
import { COVERAGE_REVIEW_DUE_AT, COVERAGE_REVIEW_NOW } from "./test-fixtures/coverage-review-clock.mjs";
import {
  completeCoverageInventory,
  completeCoverageProvenance,
  writeCoverageCandidate,
} from "./test-fixtures/datapack-tools-coverage-inventory.mjs";

const root = path.resolve(import.meta.dirname, "../..");
stageLocalMobileFixture({ repositoryRoot: root });

const NATIONWIDE_TARGETS_PATH = "tools/datapack/nationwide-coverage-targets.json";
const PILOT_TARGETS_PATH = "tools/datapack/capital-pilot-coverage-targets.json";
const SOURCE_INVENTORY_PATH = "tools/datapack/source-inventory.json";
const PRODUCTION_SCOPE_PATH = "release/product-gates/production-datapack-scope.json";

const writeJson = (filePath, value) => writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
const readJson = async (filePath) => JSON.parse(await readFile(filePath, "utf8"));
const readNationwideTargets = async () => JSON.parse(await readFile(path.join(root, NATIONWIDE_TARGETS_PATH), "utf8"));
const readPilotTargets = async () => JSON.parse(await readFile(path.join(root, PILOT_TARGETS_PATH), "utf8"));
const readSourceInventory = async () => JSON.parse(await readFile(path.join(root, SOURCE_INVENTORY_PATH), "utf8"));
const readProductionScope = async () => JSON.parse(await readFile(path.join(root, PRODUCTION_SCOPE_PATH), "utf8"));

const pilotAndroidV1Scope = () => ({
  verifiedAccessibilityScope: {
    id: "capital_pilot_android_v1",
    regionIds: ["capital"],
    includedOperatorIds: ["seoul-metro"],
    includedLineIds: ["seoul-4"],
  },
});

function runCoverageGapsCli({
  targets = NATIONWIDE_TARGETS_PATH,
  inventory = SOURCE_INVENTORY_PATH,
  manifest,
  provenance,
  releaseScope,
  releaseTargets,
  output,
  allowGaps = false,
}) {
  const args = [
    "tools/datapack/report-coverage-gaps.mjs",
    "--targets",
    targets,
    "--inventory",
    inventory,
    "--output",
    output,
  ];
  if (manifest) args.push("--manifest", manifest);
  if (provenance) args.push("--provenance", provenance);
  if (releaseScope) args.push("--release-scope", releaseScope);
  if (releaseTargets) args.push("--release-targets", releaseTargets);
  if (allowGaps) args.push("--allow-gaps");
  return execFileAsync(process.execPath, args, { cwd: root });
}

async function withCoverageWorkspace(fn) {
  const outputDir = await mkdtemp(path.join(tmpdir(), "easysubway-coverage-gap-"));
  const paths = {
    outputDir,
    targetsPath: path.join(outputDir, "nationwide-coverage-targets.json"),
    inventoryPath: path.join(outputDir, "source-inventory.json"),
    provenancePath: path.join(outputDir, "current.provenance.json"),
    manifestPath: path.join(outputDir, "current.json"),
    reportPath: path.join(outputDir, "coverage-gap-report.json"),
    releaseScopePath: path.join(outputDir, "release-scope.json"),
    resolutionsPath: path.join(outputDir, "nationwide-coverage-resolutions.json"),
    resolutionPlanPath: path.join(outputDir, "nationwide-coverage-search-plan.json"),
  };
  const writeCandidate = async (inventory, provenance = completeCoverageProvenance(inventory), releaseScope) => {
    await writeJson(paths.inventoryPath, inventory);
    await writeCoverageCandidate(outputDir, provenance);
    if (releaseScope) {
      await writeJson(paths.releaseScopePath, releaseScope);
    }
  };
  const writeManifestAndProvenance = async (inventory, manifest, packs) => {
    const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`;
    const provenance = {
      schemaVersion: 1,
      artifactKind: "datapack-field-provenance",
      manifestSha256: sha256(Buffer.from(manifestJson)),
      packs,
    };
    await writeJson(paths.inventoryPath, inventory);
    await writeFile(paths.manifestPath, manifestJson);
    await writeJson(paths.provenancePath, provenance);
  };
  const runReport = (options = {}) =>
    runCoverageGapsCli({
      output: paths.reportPath,
      ...options,
    });
  const runCandidateReport = (options = {}) =>
    runReport({
      inventory: paths.inventoryPath,
      manifest: paths.manifestPath,
      provenance: paths.provenancePath,
      ...(options.withReleaseScope ? { releaseScope: paths.releaseScopePath } : {}),
      ...options,
    });
  const readReport = () => readJson(paths.reportPath);

  try {
    return await fn({
      ...paths,
      writeCandidate,
      writeManifestAndProvenance,
      runReport,
      runCandidateReport,
      readReport,
    });
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
}

function coverageResolutionSearchPlan(entry, publicApiQueries) {
  return {
    schemaVersion: 1,
    artifactKind: "nationwide-public-api-coverage-search-plan",
    targetVersion: "2026-07-13",
    entries: [{
      regionId: entry.regionId,
      operatorId: entry.operatorId,
      lineId: entry.lineId,
      sourceDomain: entry.sourceDomain,
      fallback: entry.fallback,
      userMessageKo: entry.userMessageKo,
      queries: publicApiQueries.map(({ providerId, endpoint, operation, query, matchAnyTerms, matchTermGroups, captureFields }) => ({
        providerId,
        endpoint,
        operation,
        query,
        ...(matchAnyTerms ? { matchAnyTerms } : {}),
        ...(matchTermGroups ? { matchTermGroups } : {}),
        ...(captureFields ? { captureFields } : {}),
      })),
    }],
  };
}

function buildBusanTimetableResolution({
  responseFill = "a",
  checkedAt = "2026-07-13T00:00:00.000Z",
  reviewedAt = checkedAt,
  nextReviewAt = "2099-07-13T00:00:00.000Z",
} = {}) {
  const publicApiQueries = [{
    providerId: "kric",
    endpoint: "https://openapi.kric.go.kr/openapi/trainUseInfo/subwayTimetable",
    operation: "subwayTimetable",
    query: { railOprIsttCd: "B1", lnCd: "1" },
    httpStatus: 200,
    providerResultCode: "00",
    schemaStatus: "EXPECTED",
    matchCount: 0,
    responseSha256: responseFill.repeat(64),
  }];
  const entry = {
    regionId: "busan",
    operatorId: "busan-transportation",
    lineId: "line-ab1a041f6266",
    sourceDomain: "schedule_timetable",
    state: "EXPLICITLY_UNSUPPORTED_WITH_EVIDENCE",
    reasonCode: "PUBLIC_API_NO_DATA",
    userMessageKo: "공공기관 API에서 시간표 데이터를 제공하지 않습니다.",
    fallback: "STATIC_LOCAL",
    checkedAt,
    reviewedAt,
    reviewerRole: "DATA_STEWARD",
    nextReviewAt,
    requiredProviderIds: ["kric"],
    publicApiQueries,
    evidenceHash: sha256(JSON.stringify(publicApiQueries)),
  };
  const plan = coverageResolutionSearchPlan(entry, publicApiQueries);
  return { publicApiQueries, entry, plan };
}

const findRequirement = (report, { regionId, operatorId, lineId, sourceDomain }) =>
  report.requirements.find(
    (entry) =>
      entry.regionId === regionId &&
      entry.operatorId === operatorId &&
      entry.lineId === lineId &&
      entry.sourceDomain === sourceDomain,
  );

test("전국 coverage target은 train-search-only 열차를 route scope에 섞으면 거부한다", async () => {
  await withCoverageWorkspace(async ({ targetsPath, runReport }) => {
    const targets = await readNationwideTargets();
    targets.railProductScope.routeMapAndRouting.push({
      serviceId: "KTX",
      lineId: "line-54a7b980b7c3",
      servicePattern: "EXPRESS",
      representation: "SERVICE_PATTERN_ON_EXISTING_LINE",
    });
    await writeJson(targetsPath, targets);

    await assert.rejects(
      runReport({ targets: targetsPath, allowGaps: true }),
      /routeMapAndRouting must contain GTX-A and ITX-청춘 only/,
    );
  });
});

test("전국 coverage report는 운행 노선 launch와 enhancement 분모를 분리한다", async () => {
  await withCoverageWorkspace(async ({ runReport, readReport }) => {
    await runReport({ allowGaps: true });
    const report = await readReport();
    assert.equal(report.schemaVersion, 2);
    assert.deepEqual(report.summary.scope, { activeLineCount: 36, activeLineOperatorScopeCount: 45 });
    assert.equal(report.summary.launchRequiredCompletionRatio, 0);
    assert.equal(report.summary.enhancementProgressRatio, 0);
    assert.equal(report.summary.activeScopeCount, 45);
    assert.equal(report.summary.plannedScopeCount, 0);
    assert.equal(report.summary.launchRequired.totalCount, 270);
    assert.equal(report.summary.launchRequired.supportedCount, 0);
    assert.equal(report.summary.launchRequired.missingCount, 270);
    assert.equal(report.summary.launchRequired.completionReady, false);
    assert.equal(report.summary.enhancement.totalCount, 45);
    assert.equal(report.summary.enhancement.supportedCount, 0);
    assert.ok(report.requirements.every(({ lineId }) => typeof lineId === "string" && lineId.length > 0));
    assert.ok(report.requirements.every(({ serviceLifecycle }) => serviceLifecycle === "ACTIVE"));
    assert.ok(report.requirements.every(({ effectiveFrom }) => effectiveFrom === "2026-04-02"));
    assert.ok(report.requirements.every(({ verifiedAt }) => verifiedAt === "2026-07-13T00:00:00.000Z"));
    assert.ok(report.requirements.every(({ evidenceRef }) => evidenceRef === "source:molit-urban-rail-full-route"));
  });
});

test("전국 coverage report는 공공기관 API 실제 부재만 공식 미지원 terminal 상태로 집계한다", async () => {
  await withCoverageWorkspace(async ({ resolutionsPath, resolutionPlanPath, reportPath, readReport }) => {
    const { publicApiQueries, entry: resolutionEntry, plan: resolutionPlan } = buildBusanTimetableResolution({
      responseFill: "a",
    });
    await writeJson(resolutionPlanPath, resolutionPlan);
    await writeJson(resolutionsPath, {
      schemaVersion: 1,
      artifactKind: "nationwide-coverage-resolutions",
      targetVersion: "2026-07-13",
      searchPlanSha256: sha256(JSON.stringify(resolutionPlan)),
      entries: [resolutionEntry],
    });

    await execFileAsync(process.execPath, [
      "tools/datapack/report-coverage-gaps.mjs",
      "--targets",
      NATIONWIDE_TARGETS_PATH,
      "--inventory",
      SOURCE_INVENTORY_PATH,
      "--resolutions",
      resolutionsPath,
      "--resolution-plan",
      resolutionPlanPath,
      "--now",
      COVERAGE_REVIEW_NOW,
      "--output",
      reportPath,
      "--allow-gaps",
    ], { cwd: root });

    const report = await readReport();
    const requirement = findRequirement(report, resolutionEntry);
    assert.equal(requirement.status, "EXPLICITLY_UNSUPPORTED_WITH_EVIDENCE");
    assert.equal(requirement.capabilityFallback, "STATIC_LOCAL");
    assert.equal(report.summary.launchRequired.supportedCount, 0);
    assert.equal(report.summary.launchRequired.explicitlyUnsupportedCount, 1);
    assert.equal(report.summary.launchRequired.missingCount, 269);
    assert.equal(report.summary.launchRequired.supportedRatio, 0);
    assert.equal(report.summary.launchRequired.terminalResolutionRatio, Number((1 / 270).toFixed(4)));
    assert.equal(report.summary.launchRequired.completionReady, false);
    assert.deepEqual(report.transitions, [{
      requirementKey: "busan:busan-transportation:line-ab1a041f6266:schedule_timetable",
      before: "MISSING",
      after: "EXPLICITLY_UNSUPPORTED_WITH_EVIDENCE",
      reasonCode: "PUBLIC_API_NO_DATA",
      evidenceHash: sha256(JSON.stringify(publicApiQueries)),
      reviewedAt: "2026-07-13T00:00:00.000Z",
    }]);
  });
});

test("전국 coverage report는 불완전하거나 만료된 공공 API 미지원 evidence를 fail closed한다", async (context) => {
  const { publicApiQueries, entry: baseEntry, plan: resolutionPlan } = buildBusanTimetableResolution({
    responseFill: "b",
  });
  const withModifiedQuery = (overrides) => {
    const modifiedQueries = [{ ...publicApiQueries[0], ...overrides }];
    return [{
      ...baseEntry,
      publicApiQueries: modifiedQueries,
      evidenceHash: sha256(JSON.stringify(modifiedQueries)),
    }];
  };
  const cases = [
    ["duplicate", [baseEntry, baseEntry], /duplicate coverage resolution/],
    ["unknown key", [{ ...baseEntry, lineId: "unknown-line" }], /unknown coverage resolution requirement/],
    ["unknown state", [{ ...baseEntry, state: "UNSUPPORTED" }], /coverage resolution state is invalid/],
    ["non-public endpoint", withModifiedQuery({ endpoint: "https://example.com/blog" }), /public API origin is not allowed/],
    ["credential query endpoint", withModifiedQuery({ endpoint: `${publicApiQueries[0].endpoint}?serviceKey=secret` }), /endpoint must not contain credentials/],
    ["provider failure", withModifiedQuery({ providerResultCode: "99" }), /providerResultCode must be 00/],
    ["schema mismatch", withModifiedQuery({ schemaStatus: "MISMATCH" }), /schemaStatus must be EXPECTED/],
    ["different line query", withModifiedQuery({ query: { railOprIsttCd: "B1", lnCd: "2" } }), /search plan query mismatch/],
  ];

  const assertResolutionsRejected = async (resolutionsJson, expected) => {
    await withCoverageWorkspace(async ({ resolutionsPath, resolutionPlanPath, reportPath }) => {
      await writeFile(resolutionPlanPath, `${JSON.stringify(resolutionPlan)}\n`);
      await writeFile(resolutionsPath, `${resolutionsJson}\n`);
      await assert.rejects(
        execFileAsync(process.execPath, [
          "tools/datapack/report-coverage-gaps.mjs",
          "--targets",
          NATIONWIDE_TARGETS_PATH,
          "--inventory",
          SOURCE_INVENTORY_PATH,
          "--resolutions",
          resolutionsPath,
          "--resolution-plan",
          resolutionPlanPath,
          "--now",
          COVERAGE_REVIEW_NOW,
          "--output",
          reportPath,
          "--allow-gaps",
        ], { cwd: root }),
        expected,
      );
    });
  };

  for (const [label, entries, expected] of cases) {
    await context.test(label, () => assertResolutionsRejected(JSON.stringify({
      schemaVersion: 1,
      artifactKind: "nationwide-coverage-resolutions",
      targetVersion: "2026-07-13",
      searchPlanSha256: sha256(JSON.stringify(resolutionPlan)),
      entries,
    }), expected));
  }

  for (const [label, rawJson] of [
    ["json zero", "0"],
    ["json false", "false"],
    ["json empty string", '""'],
    ["json null", "null"],
  ]) {
    await context.test(label, () => assertResolutionsRejected(rawJson, /coverage resolutions must be an object/));
  }
});

const REVIEW_BOUNDARY = COVERAGE_REVIEW_DUE_AT;
const plusMillis = (instant, millis) => new Date(Date.parse(instant) + millis).toISOString();

async function reportRequirementAt({ nextReviewAt, now }) {
  const { entry, plan } = buildBusanTimetableResolution({
    responseFill: "c",
    checkedAt: "2026-07-25T09:12:39.105Z",
    nextReviewAt,
  });
  return withCoverageWorkspace(async ({ resolutionsPath, resolutionPlanPath, reportPath, readReport }) => {
    await writeFile(resolutionPlanPath, `${JSON.stringify(plan)}\n`);
    await writeFile(resolutionsPath, `${JSON.stringify({
      schemaVersion: 1,
      artifactKind: "nationwide-coverage-resolutions",
      targetVersion: "2026-07-13",
      searchPlanSha256: sha256(JSON.stringify(plan)),
      entries: [entry],
    })}\n`);
    await execFileAsync(process.execPath, [
      "tools/datapack/report-coverage-gaps.mjs",
      "--targets",
      NATIONWIDE_TARGETS_PATH,
      "--inventory",
      SOURCE_INVENTORY_PATH,
      "--resolutions",
      resolutionsPath,
      "--resolution-plan",
      resolutionPlanPath,
      "--now",
      now,
      "--output",
      reportPath,
      "--allow-gaps",
    ], { cwd: root });
    const report = await readReport();
    return {
      requirement: findRequirement(report, entry),
      transitions: report.transitions,
    };
  });
}

test("공식 미지원 evidence는 nextReviewAt 직전까지 terminal이고 그 시각부터 MISSING(EXPIRED)이다", async (context) => {
  await context.test("nextReviewAt 1ms 전에는 공식 미지원이 유지된다", async () => {
    const { requirement, transitions } = await reportRequirementAt({
      nextReviewAt: REVIEW_BOUNDARY, now: plusMillis(REVIEW_BOUNDARY, -1),
    });
    assert.equal(requirement.status, "EXPLICITLY_UNSUPPORTED_WITH_EVIDENCE");
    assert.equal(requirement.resolutionReviewStatus, "CURRENT");
    assert.equal(transitions.length, 1);
  });

  for (const [label, offsetMillis] of [["정확히 그 시각", 0], ["1ms 뒤", 1], ["하루 뒤", 86_400_000]]) {
    await context.test(`nextReviewAt ${label}에는 MISSING으로 되돌아가고 재검토 필요로 남는다`, async () => {
      const { requirement, transitions } = await reportRequirementAt({
        nextReviewAt: REVIEW_BOUNDARY, now: plusMillis(REVIEW_BOUNDARY, offsetMillis),
      });
      assert.equal(requirement.status, "MISSING");
      assert.equal(requirement.resolutionReviewStatus, "EXPIRED");
      assert.deepEqual(transitions, []);
    });
  }
});

test("--now는 밀리초까지 있는 ISO 시각만 받는다", async (context) => {
  for (const [label, value] of [["날짜만", "2026-10-01"], ["밀리초 없음", "2026-10-01T00:00:00Z"], ["문자열", "yesterday"]]) {
    await context.test(label, async () => {
      await assert.rejects(reportRequirementAt({ nextReviewAt: REVIEW_BOUNDARY, now: value }), /--now must be an ISO timestamp/);
    });
  }
});

test("--now는 --resolutions 없이 쓰면 거부한다", async () => {
  await withCoverageWorkspace(async ({ reportPath }) => {
    await assert.rejects(
      execFileAsync(process.execPath, [
        "tools/datapack/report-coverage-gaps.mjs",
        "--targets",
        NATIONWIDE_TARGETS_PATH,
        "--inventory",
        SOURCE_INVENTORY_PATH,
        "--now",
        COVERAGE_REVIEW_NOW,
        "--output",
        reportPath,
        "--allow-gaps",
      ], { cwd: root }),
      /--resolutions is required with --now/,
    );
  });
});

test("전국 coverage v2는 LAUNCH_REQUIRED domain이 없는 target을 거부한다", async () => {
  await withCoverageWorkspace(async ({ targetsPath, runReport }) => {
    const targets = await readNationwideTargets();
    for (const domain of targets.requiredSourceDomains) {
      domain.releaseTier = "ENHANCEMENT";
    }
    await writeJson(targetsPath, targets);

    await assert.rejects(
      runReport({ targets: targetsPath, allowGaps: true }),
      /schemaVersion 2 targets must include at least one LAUNCH_REQUIRED domain/,
    );
  });
});

// #2138 증거 모델 축. route_map_positions는 도식 위 좌표를 공표하는 공식 기관이 없어 정본이 오너
// 자작 도식이고 공식 데이터는 역 신원 식별·provenance를 댄다. 그 성격을 판정 경로가 읽는 필드로 적되,
// 판정 자체는 한 톨도 느슨해지지 않는다는 것이 이 축의 계약이다.
test("전국 coverage v2는 domain 증거 모델 선언을 판정 레코드에 싣고 판정은 그대로 둔다", async () => {
  await withCoverageWorkspace(async ({ runReport, readReport }) => {
    const targets = await readNationwideTargets();
    await runReport({ allowGaps: true });
    const report = await readReport();

    const routeMapDomain = targets.requiredSourceDomains.find(({ id }) => id === "route_map_positions");
    assert.equal(routeMapDomain.evidenceModel, "owner-authored-canonical");
    assert.match(routeMapDomain.evidenceModelReasonKo, /좌표를 공표하는 공식 기관이 존재하지 않으므로/);
    // 선언하지 않은 도메인은 기본값으로 기록된다 — 기존 계약이 그대로 유지된다는 하위 호환 축이다.
    for (const domain of targets.requiredSourceDomains) {
      const rows = report.requirements.filter((entry) => entry.sourceDomain === domain.id);
      assert.ok(rows.length > 0, domain.id);
      for (const row of rows) {
        assert.equal(row.evidenceModel, domain.evidenceModel ?? "official-source", domain.id);
      }
    }
    // 선언이 판정을 열어 주지 않는다: 근거 provenance 없이 돌린 이 실행에서 route_map_positions는 다른
    // 도메인과 똑같이 MISSING이고 분모·차단 임계도 선언 전과 같다.
    for (const row of report.requirements.filter((entry) => entry.sourceDomain === "route_map_positions")) {
      assert.equal(row.status, "MISSING");
      assert.equal(row.denominator, routeMapDomain.requiredFields.length);
      assert.equal(row.blockingThreshold, routeMapDomain.blockingThreshold.minimumOfficialFieldCoverageRatio);
      assert.deepEqual(row.missingFields, routeMapDomain.requiredFields);
    }
  });
});

test("전국 coverage v2는 등재되지 않은 domain 증거 모델과 사유 없는 선언을 거부한다", async () => {
  await withCoverageWorkspace(async ({ outputDir, runReport }) => {
    const targets = await readNationwideTargets();
    const runWith = async (mutate, expected) => {
      const mutated = structuredClone(targets);
      mutate(mutated.requiredSourceDomains.find(({ id }) => id === "route_map_positions"));
      const targetsPath = path.join(outputDir, `targets-${Date.now()}-${Math.random()}.json`);
      await writeJson(targetsPath, mutated);
      await assert.rejects(runReport({ targets: targetsPath, allowGaps: true }), expected);
    };

    await runWith(
      (domain) => { domain.evidenceModel = "owner-declared"; },
      /route_map_positions\.evidenceModel must be one of official-source,owner-authored-canonical/,
    );
    await runWith(
      (domain) => { delete domain.evidenceModelReasonKo; },
      /route_map_positions\.evidenceModelReasonKo is required/,
    );
    // 사유만 남기고 모델 선언을 지우면 아무것도 하지 않는 죽은 서술이 된다 — 그것도 거부한다.
    await runWith(
      (domain) => { delete domain.evidenceModel; },
      /route_map_positions\.evidenceModelReasonKo requires evidenceModel/,
    );
  });
});

// #2138이 production 유입을 거부하는 범주. 선언한 소스가 requirement를 하나라도 뒷받침하면 판정을 내지
// 않는다. 현재 선언한 소스는 0건이라 판정은 그대로이고, 이 축은 그 경계를 기계로 옮긴 것이다.
// 전국 targets(schemaVersion 2)는 provenance 없이는 어떤 소스도 뒷받침 소스로 세지 않으므로, 소스가 실제로
// requirement를 뒷받침하는 pilot 계약(schemaVersion 1)으로 이 축을 때린다.
test("coverage 게이트는 placeholder-fixture 소스가 requirement를 지원하면 거부한다", async () => {
  await withCoverageWorkspace(async ({ outputDir, runReport, readReport }) => {
    const targets = await readPilotTargets();
    const inventory = completeCoverageInventory(targets);
    const runWith = async (sources, name) => {
      const inventoryPath = path.join(outputDir, name);
      await writeJson(inventoryPath, { ...inventory, sources });
      return runReport({ targets: PILOT_TARGETS_PATH, inventory: inventoryPath, allowGaps: true });
    };
    const withFirst = (extra) => inventory.sources.map((source, index) => (
      index === 0 ? { ...source, ...extra } : source
    ));

    // 선언 없는 inventory는 그대로 통과하고 그 소스가 실제로 requirement를 뒷받침한다(하위 호환 + 전제 확인).
    await runWith(inventory.sources, "baseline-inventory.json");
    const baseline = await readReport();
    assert.ok(baseline.requirements.some((entry) => entry.sourceIds.includes(inventory.sources[0].id)));

    await assert.rejects(
      runWith(
        withFirst({ evidenceCategory: "placeholder-fixture", evidenceCategoryReasonKo: "진짜 데이터 도착 전 임시값" }),
        "placeholder-inventory.json",
      ),
      new RegExp(`is supported by placeholder-fixture sources: ${inventory.sources[0].id}`),
    );

    // 범주 값은 열거형이고 사유를 함께 요구한다 — 자유 문자열 선언으로 이 축을 비껴갈 수 없다.
    await assert.rejects(
      runWith(
        withFirst({ evidenceCategory: "draft", evidenceCategoryReasonKo: "임시" }),
        "bad-category-inventory.json",
      ),
      /evidenceCategory must be one of placeholder-fixture/,
    );
    await assert.rejects(
      runWith(withFirst({ evidenceCategory: "placeholder-fixture" }), "no-reason-inventory.json"),
      /evidenceCategoryReasonKo is required/,
    );
    await assert.rejects(
      runWith(withFirst({ evidenceCategoryReasonKo: "모델 없는 죽은 서술" }), "no-category-inventory.json"),
      /evidenceCategoryReasonKo requires evidenceCategory/,
    );
  });
});

// 같은 축의 두 번째 경로. 전국 라벨 경로에만 회귀가 있으면 게시 차단 판정이 실제로 도는 release-scope
// 평가에서 같은 유입이 열려도 회귀가 침묵한다 — 그 경로를 따로 때린다.
// 축 분리 방법: 전국 계약(schemaVersion 2)은 provenance 없이는 어떤 소스도 뒷받침 소스로 세지 않으므로
// provenance 없이 돌리면 전국 경로는 조용하고, pilot 계약(schemaVersion 1)으로 도는 release-scope
// 경로에서만 소스가 requirement를 뒷받침한다.
test("coverage 게이트는 release scope 평가에서도 placeholder-fixture 소스 지원을 거부한다", async () => {
  await withCoverageWorkspace(async ({ outputDir, runReport, readReport }) => {
    const targets = await readNationwideTargets();
    const inventory = completeCoverageInventory(targets);
    const runWith = async (sources, name) => {
      const inventoryPath = path.join(outputDir, name);
      await writeJson(inventoryPath, { ...inventory, sources });
      return runReport({
        inventory: inventoryPath,
        releaseScope: PRODUCTION_SCOPE_PATH,
        allowGaps: true,
      });
    };

    await runWith(inventory.sources, "scope-baseline-inventory.json");
    const baseline = await readReport();
    // 전제 확인: 전국 경로에는 뒷받침 소스가 하나도 없고 release-scope 경로에는 있다 — 이 회귀가 겨냥한
    // 분기에 실제로 닿는다는 뜻이다(전국 경로가 먼저 걸리면 축이 갈린다).
    assert.ok(baseline.requirements.every(({ sourceIds }) => sourceIds.length === 0));
    const scopeSourceIds = [...new Set(baseline.releaseScopeRequirements.flatMap(({ sourceIds }) => sourceIds))];
    assert.ok(scopeSourceIds.length > 0);

    await assert.rejects(
      runWith(
        inventory.sources.map((source) => (scopeSourceIds.includes(source.id)
          ? {
            ...source,
            evidenceCategory: "placeholder-fixture",
            evidenceCategoryReasonKo: "진짜 데이터 도착 전 임시값",
          }
          : source)),
        "scope-placeholder-inventory.json",
      ),
      /release scope requirement .+ is supported by placeholder-fixture sources: /,
    );
  });
});

test("전국 coverage v2는 line-scoped inventory만으로 지원 완료를 선언하지 않는다", async () => {
  await withCoverageWorkspace(async ({ inventoryPath, runReport, readReport }) => {
    const targets = await readNationwideTargets();
    await writeJson(inventoryPath, completeCoverageInventory(targets));

    await assert.rejects(
      runReport({ inventory: inventoryPath }),
      /nationwide coverage gaps remain/,
    );

    const report = await readReport();
    assert.equal(report.summary.launchRequired.supportedCount, 0);
    assert.equal(report.summary.launchRequired.missingCount, report.summary.launchRequired.totalCount);
  });
});

test("전국 coverage gap report는 현재 source inventory의 누락 coverage를 실패로 노출한다", async () => {
  await withCoverageWorkspace(async ({ runReport, readReport }) => {
    await assert.rejects(runReport(), /nationwide coverage gaps remain/);

    const report = await readReport();
    assert.equal(report.artifactKind, "nationwide-coverage-gap-report");
    assert.equal(report.summary.coverageComplete, false);
    assert.ok(report.summary.missingRequirements > 0);
  });
});

test("전국 coverage gap report는 allow-gaps 모드에서 감사 가능한 report를 생성한다", async () => {
  await withCoverageWorkspace(async ({ inventoryPath, runReport, readReport }) => {
    await writeJson(inventoryPath, await readSourceInventory());
    await runReport({ inventory: inventoryPath, allowGaps: true });

    const report = await readReport();
    assert.equal(report.summary.coverageComplete, false);
    assert.equal(report.summary.coveredRequirements, 0);
    assert.ok(report.requirements.every((entry) => entry.status === "MISSING"));
    assert.ok(report.requirements.every((entry) => Array.isArray(entry.sourceIds)));
  });
});

test("전국 coverage gap report는 operator-wide source를 노선 coverage로 승격하지 않는다", async () => {
  await withCoverageWorkspace(async ({ runReport, readReport }) => {
    await runReport({ allowGaps: true });

    const report = await readReport();
    assert.equal(report.summary.totalRequirements, 270);
    assert.equal(report.summary.coveredRequirements, 0);
    assert.equal(report.summary.missingRequirements, 270);

    const busanStationMembership = findRequirement(report, {
      regionId: "busan",
      operatorId: "busan-transportation",
      lineId: "line-ab1a041f6266",
      sourceDomain: "station_line_membership",
    });
    assert.deepEqual(busanStationMembership?.sourceIds, []);
    assert.deepEqual(busanStationMembership?.missingFields, ["line", "station_name", "station_code"]);

    const capitalAccessibilityFacilities = findRequirement(report, {
      regionId: "capital",
      operatorId: "seoul-metro",
      lineId: "seoul-4",
      sourceDomain: "accessibility_facilities",
    });
    assert.deepEqual(capitalAccessibilityFacilities?.sourceIds, []);
    assert.deepEqual(capitalAccessibilityFacilities?.missingFields, [
      "elevator",
      "escalator",
      "wheelchair_lift",
      "status",
      "verified_at",
    ]);
  });
});

test("전국 coverage gap report는 targets에 없는 coverageScope domain을 거부한다", async () => {
  await withCoverageWorkspace(async ({ inventoryPath, runReport }) => {
    const inventory = await readSourceInventory();
    inventory.sources[0].coverageScope.sourceDomains = ["unknown_domain"];
    await writeJson(inventoryPath, inventory);

    await assert.rejects(
      runReport({ inventory: inventoryPath, allowGaps: true }),
      /undefined source domain: unknown_domain/,
    );
  });
});

test("전국 coverage gap report는 target coverage가 모두 충족되면 성공한다", async () => {
  await withCoverageWorkspace(async ({ writeCandidate, runCandidateReport, readReport }) => {
    const targets = await readNationwideTargets();
    await writeCandidate(completeCoverageInventory(targets));
    await runCandidateReport();

    const report = await readReport();
    assert.equal(report.summary.coverageComplete, true);
    assert.equal(report.summary.missingRequirements, 0);
    assert.equal(report.summary.coverageRatio, 1);
  });
});

test("전국 coverage gap report는 여러 노선과 운영기관을 곱집합으로 해석할 provenance를 거부한다", async () => {
  await withCoverageWorkspace(async ({ writeCandidate, runCandidateReport }) => {
    const targets = await readNationwideTargets();
    const inventory = completeCoverageInventory(targets);
    const provenance = completeCoverageProvenance(inventory);
    provenance.packs[0].records[0].coverageScope = {
      ...provenance.packs[0].records[0].coverageScope,
      operatorIds: ["seoul-metro", "korail"],
      lineIds: ["seoul-4", "line-31e4cf10b52b"],
    };
    await writeCandidate(inventory, provenance);

    await assert.rejects(
      runCandidateReport(),
      /line-scoped field provenance must identify exactly one operator-line pair/,
    );
  });
});

test("전국 coverage gap report는 inactive 노선 source metadata를 허용하되 출시 분모에서 제외한다", async () => {
  await withCoverageWorkspace(async ({ inventoryPath, runReport, readReport }) => {
    const inventory = {
      schemaVersion: 1,
      retrievedAt: "2026-07-13",
      sources: [
        {
          id: "inactive-maglev-metadata",
          coverageScope: {
            regionIds: ["capital"],
            operatorIds: ["airport-railroad"],
            lineIds: ["line-cbe75f5287a1"],
            sourceDomains: ["station_line_membership"],
          },
          fieldsProvided: ["line", "station_name", "station_code"],
        },
      ],
    };
    await writeJson(inventoryPath, inventory);
    await runReport({ inventory: inventoryPath, allowGaps: true });

    const report = await readReport();
    assert.equal(report.summary.scope.activeLineCount, 36);
    assert.ok(report.requirements.every(({ lineId }) => lineId !== "line-cbe75f5287a1"));
  });
});

test("전국 coverage gap report는 candidate field provenance와 manifest hash를 evidence로 결합한다", async () => {
  await withCoverageWorkspace(async ({ manifestPath, writeCandidate, runCandidateReport, readReport }) => {
    const targets = await readNationwideTargets();
    await writeCandidate(completeCoverageInventory(targets));
    await runCandidateReport();

    const report = await readReport();
    assert.equal(report.summary.coverageComplete, true);
    assert.equal(report.candidate.manifestSha256, sha256(await readFile(manifestPath)));
    assert.deepEqual(report.candidate.packs.map(({ id, version, sqliteSha256 }) => ({ id, version, sqliteSha256 })), [
      { id: "nationwide", version: "1", sqliteSha256: "b".repeat(64) },
    ]);
    assert.ok(report.requirements.every((entry) => entry.fieldCoverage.every((field) => field.status === "covered")));
  });
});

test("전국 coverage gap report는 provenance를 현재 manifest bytes에 결합한다", async () => {
  await withCoverageWorkspace(async ({ inventoryPath, manifestPath, provenancePath, runCandidateReport }) => {
    const targets = await readNationwideTargets();
    const inventory = completeCoverageInventory(targets);
    const provenance = completeCoverageProvenance(inventory);
    await writeJson(inventoryPath, inventory);
    await writeJson(manifestPath, {
      activePack: { id: "nationwide", version: "1" },
      packs: [{ id: "nationwide", version: "1", artifactKind: "production", sqliteSha256: "b".repeat(64) }],
    });
    await writeJson(provenancePath, provenance);

    await assert.rejects(
      runCandidateReport(),
      /field provenance manifestSha256 does not match --manifest/,
    );
  });
});

test("전국 coverage gap report는 fixture manifest를 production provenance로 승격하지 않는다", async () => {
  await withCoverageWorkspace(async ({ inventoryPath, manifestPath, provenancePath, runCandidateReport }) => {
    const targets = await readNationwideTargets();
    const inventory = completeCoverageInventory(targets);
    const provenance = completeCoverageProvenance(inventory);
    const manifestJson = `${JSON.stringify({
      activePack: { id: "nationwide", version: "1" },
      packs: [{ id: "nationwide", version: "1", artifactKind: "fixture", sqliteSha256: "b".repeat(64) }],
    }, null, 2)}\n`;
    provenance.manifestSha256 = sha256(Buffer.from(manifestJson));
    await writeJson(inventoryPath, inventory);
    await writeFile(manifestPath, manifestJson);
    await writeJson(provenancePath, provenance);

    await assert.rejects(
      runCandidateReport(),
      /field provenance artifactKind does not match --manifest/,
    );
  });
});

test("전국 coverage gap report는 실제 active pack 밖 dependency provenance를 집계하지 않는다", async () => {
  await withCoverageWorkspace(async ({ writeManifestAndProvenance, runCandidateReport, readReport }) => {
    const targets = await readNationwideTargets();
    const inventory = completeCoverageInventory(targets);
    const records = completeCoverageProvenance(inventory).packs[0].records;
    const manifest = {
      activePack: { id: "active", version: "1" },
      packs: [
        {
          id: "active",
          version: "1",
          artifactKind: "production",
          sqliteSha256: "a".repeat(64),
          dependencies: [{ id: "dependency", version: "1" }],
        },
        { id: "dependency", version: "1", artifactKind: "production", sqliteSha256: "b".repeat(64) },
        { id: "inactive", version: "1", artifactKind: "production", sqliteSha256: "c".repeat(64) },
      ],
    };
    await writeManifestAndProvenance(inventory, manifest, [
      { id: "active", version: "1", artifactKind: "production", sqliteSha256: "a".repeat(64), records: [] },
      { id: "dependency", version: "1", artifactKind: "production", sqliteSha256: "b".repeat(64), records },
      { id: "inactive", version: "1", artifactKind: "production", sqliteSha256: "c".repeat(64), records: [] },
    ]);

    await assert.rejects(
      runCandidateReport(),
      /nationwide coverage gaps remain: 270 missing requirements/,
    );

    const report = await readReport();
    assert.deepEqual(report.candidate.packs.map(({ id }) => id), ["active"]);
  });
});

test("전국 coverage gap report는 emergency override pack의 provenance를 검증한다", async () => {
  await withCoverageWorkspace(async ({ reportPath, writeManifestAndProvenance, runCandidateReport }) => {
    const targets = await readNationwideTargets();
    const inventory = completeCoverageInventory(targets);
    const records = completeCoverageProvenance(inventory).packs[0].records;
    const manifest = {
      activePack: { id: "active", version: "1" },
      emergencyOverride: { id: "override", version: "1", reason: "긴급 안전 보정" },
      packs: [
        { id: "active", version: "1", artifactKind: "production", sqliteSha256: "a".repeat(64) },
        { id: "override", version: "1", artifactKind: "production", sqliteSha256: "b".repeat(64) },
      ],
    };
    await writeManifestAndProvenance(inventory, manifest, [
      { id: "active", version: "1", artifactKind: "production", sqliteSha256: "a".repeat(64), records },
      { id: "override", version: "1", artifactKind: "production", sqliteSha256: "b".repeat(64), records: [] },
    ]);

    await assert.rejects(
      runCandidateReport(),
      /coverage manifest emergencyOverride is forbidden/,
    );

    await assert.rejects(readFile(reportPath, "utf8"), /ENOENT/);
  });
});

test("전국 coverage gap report는 emergency override 실패 시 fallback active pack provenance도 검증한다", async () => {
  await withCoverageWorkspace(async ({ reportPath, writeManifestAndProvenance, runCandidateReport }) => {
    const targets = await readNationwideTargets();
    const inventory = completeCoverageInventory(targets);
    const records = completeCoverageProvenance(inventory).packs[0].records;
    const manifest = {
      activePack: { id: "active", version: "1" },
      emergencyOverride: { id: "override", version: "1", reason: "긴급 안전 보정" },
      packs: [
        { id: "active", version: "1", artifactKind: "production", sqliteSha256: "a".repeat(64) },
        { id: "override", version: "1", artifactKind: "production", sqliteSha256: "b".repeat(64) },
      ],
    };
    await writeManifestAndProvenance(inventory, manifest, [
      { id: "active", version: "1", artifactKind: "production", sqliteSha256: "a".repeat(64), records: [] },
      { id: "override", version: "1", artifactKind: "production", sqliteSha256: "b".repeat(64), records },
    ]);

    const existingReport = "existing coverage report\n";
    await writeFile(reportPath, existingReport);

    await assert.rejects(
      runCandidateReport(),
      /coverage manifest emergencyOverride is forbidden/,
    );

    assert.equal(await readFile(reportPath, "utf8"), existingReport);
  });
});

test("전국 coverage gap report는 activePack 생략 시 기본 capital pack을 검증한다", async () => {
  await withCoverageWorkspace(async ({ reportPath, writeManifestAndProvenance, runCandidateReport }) => {
    const targets = await readNationwideTargets();
    const inventory = completeCoverageInventory(targets);
    const records = completeCoverageProvenance(inventory).packs[0].records;
    const manifest = {
      packs: [
        { id: "capital", version: "1", artifactKind: "production", sqliteSha256: "a".repeat(64) },
        { id: "inactive", version: "1", artifactKind: "production", sqliteSha256: "b".repeat(64) },
      ],
    };
    await writeManifestAndProvenance(inventory, manifest, [
      { id: "capital", version: "1", artifactKind: "production", sqliteSha256: "a".repeat(64), records },
      { id: "inactive", version: "1", artifactKind: "production", sqliteSha256: "b".repeat(64), records: [] },
    ]);

    await assert.rejects(
      runCandidateReport(),
      /coverage manifest activePack is required/,
    );

    await assert.rejects(readFile(reportPath, "utf8"), /ENOENT/);
  });
});

test("전국 coverage gap report는 safe integer를 넘는 기본 capital pack 버전을 정확히 비교한다", async () => {
  await withCoverageWorkspace(async ({ reportPath, writeManifestAndProvenance, runCandidateReport }) => {
    const targets = await readNationwideTargets();
    const inventory = completeCoverageInventory(targets);
    const records = completeCoverageProvenance(inventory).packs[0].records;
    const oldVersion = "9007199254740992";
    const newVersion = "9007199254740993";
    const manifest = {
      packs: [
        { id: "capital", version: oldVersion, artifactKind: "production", sqliteSha256: "a".repeat(64) },
        { id: "capital", version: newVersion, artifactKind: "production", sqliteSha256: "b".repeat(64) },
      ],
    };
    await writeManifestAndProvenance(inventory, manifest, [
      { ...manifest.packs[0], records: [] },
      { ...manifest.packs[1], records },
    ]);

    const existingReport = "existing coverage report\n";
    await writeFile(reportPath, existingReport);

    await assert.rejects(
      runCandidateReport(),
      /coverage manifest activePack is required/,
    );

    assert.equal(await readFile(reportPath, "utf8"), existingReport);
  });
});

test("v1 pilot release gate는 line-scoped inventory와 provenance를 포함 노선으로 평가한다", async () => {
  await withCoverageWorkspace(async ({ writeCandidate, runCandidateReport, readReport }) => {
    const targets = await readNationwideTargets();
    const inventory = completeCoverageInventory(targets);
    await writeCandidate(inventory, completeCoverageProvenance(inventory), pilotAndroidV1Scope());
    await runCandidateReport({ withReleaseScope: true });

    const report = await readReport();
    assert.equal(report.summary.releaseScope.coverageComplete, true);
    assert.equal(report.releaseScopeRequirements.length, 3);
    assert.ok(report.releaseScopeRequirements.every(({ lineId }) => lineId === "seoul-4"));
  });
});

const findSeoul4StationSource = (inventory) =>
  inventory.sources.find(
    (source) =>
      source.coverageScope.operatorIds.includes("seoul-metro") &&
      source.coverageScope.lineIds?.includes("seoul-4") &&
      source.coverageScope.sourceDomains.includes("station_line_membership"),
  );

test("v1 pilot release gate는 다른 노선의 line-scoped provenance를 재사용하지 않는다", async () => {
  await withCoverageWorkspace(async ({ writeCandidate, runCandidateReport, readReport }) => {
    const targets = await readNationwideTargets();
    const inventory = completeCoverageInventory(targets);
    const stationSource = findSeoul4StationSource(inventory);
    stationSource.coverageScope.lineIds = ["seoul-2", "seoul-4"];
    const provenance = completeCoverageProvenance(inventory);
    for (const record of provenance.packs[0].records.filter(({ sourceId }) => sourceId === stationSource.id)) {
      record.coverageScope = { ...record.coverageScope, lineIds: ["seoul-2"] };
    }
    await writeCandidate(inventory, provenance, pilotAndroidV1Scope());

    await assert.rejects(
      runCandidateReport({ withReleaseScope: true }),
      /in-scope coverage gaps remain: 1 missing requirements/,
    );
    const report = await readReport();
    const stationRequirement = report.releaseScopeRequirements.find(
      ({ sourceDomain }) => sourceDomain === "station_line_membership",
    );
    assert.equal(stationRequirement.status, "missing");
    assert.deepEqual(stationRequirement.sourceIds, []);
  });
});

test("v1 pilot release gate는 line-scoped source의 노선 없는 provenance를 재사용하지 않는다", async () => {
  await withCoverageWorkspace(async ({ writeCandidate, runCandidateReport }) => {
    const targets = await readNationwideTargets();
    const inventory = completeCoverageInventory(targets);
    const stationSource = findSeoul4StationSource(inventory);
    const provenance = completeCoverageProvenance(inventory);
    for (const record of provenance.packs[0].records.filter(({ sourceId }) => sourceId === stationSource.id)) {
      record.coverageScope = { ...record.coverageScope };
      delete record.coverageScope.lineIds;
    }
    await writeCandidate(inventory, provenance, pilotAndroidV1Scope());

    await assert.rejects(
      runCandidateReport({ withReleaseScope: true }),
      /in-scope coverage gaps remain: 1 missing requirements/,
    );
  });
});

test("v1 release gate는 active 노선-운영기관 pair만 평가한다", async () => {
  await withCoverageWorkspace(async ({ writeCandidate, runCandidateReport, readReport }) => {
    const targets = await readNationwideTargets();
    const inventory = completeCoverageInventory(targets);
    const releaseScope = await readProductionScope();
    releaseScope.verifiedAccessibilityScope.regionIds = ["capital"];
    releaseScope.verifiedAccessibilityScope.includedOperatorIds = ["seoul-metro", "operator-28e01fb8509d"];
    releaseScope.verifiedAccessibilityScope.includedLineIds = ["seoul-4", "shinbundang"];
    await writeCandidate(inventory, completeCoverageProvenance(inventory), releaseScope);
    await runCandidateReport({ withReleaseScope: true });

    const report = await readReport();
    assert.equal(report.summary.releaseScope.coverageComplete, true);
    assert.equal(report.releaseScopeRequirements.length, 6);
    assert.deepEqual(
      [...new Set(report.releaseScopeRequirements.map(({ lineId, operatorId }) => `${lineId}:${operatorId}`))].sort(),
      ["seoul-4:seoul-metro", "shinbundang:operator-28e01fb8509d"],
    );
  });
});

test("release gate는 일부만 active pair에 매칭되는 scope를 거부한다", async () => {
  await withCoverageWorkspace(async ({ writeCandidate, runCandidateReport }) => {
    const targets = await readNationwideTargets();
    const inventory = completeCoverageInventory(targets);
    const releaseScope = await readProductionScope();
    releaseScope.verifiedAccessibilityScope.includedLineIds.push("unknown-line");
    await writeCandidate(inventory, completeCoverageProvenance(inventory), releaseScope);

    await assert.rejects(
      runCandidateReport({ withReleaseScope: true }),
      /release scope lineId has no matching active coverage pair: unknown-line/,
    );
  });
});

test("schema v1 direct target은 line-scoped provenance를 operator requirement로 집계한다", async () => {
  await withCoverageWorkspace(async ({ writeCandidate, runCandidateReport, readReport }) => {
    const targets = await readPilotTargets();
    const inventory = completeCoverageInventory(targets);
    for (const source of inventory.sources) {
      source.coverageScope.lineIds = ["seoul-4"];
    }
    await writeCandidate(inventory);
    await runCandidateReport({ targets: PILOT_TARGETS_PATH });

    const report = await readReport();
    assert.equal(report.summary.coverageComplete, true);
    assert.equal(report.summary.missingRequirements, 0);
  });
});

test("release gate는 schema v2 release target의 SUPPORTED requirement를 집계한다", async () => {
  await withCoverageWorkspace(async ({ writeCandidate, runCandidateReport, readReport }) => {
    const targets = await readNationwideTargets();
    const inventory = completeCoverageInventory(targets);
    const provenance = completeCoverageProvenance(inventory);
    provenance.packs[0].records = provenance.packs[0].records.filter(
      (record) => !record.coverageScope.sourceDomains.includes("demand_reference"),
    );
    await writeCandidate(inventory, provenance, pilotAndroidV1Scope());
    await runCandidateReport({ withReleaseScope: true, releaseTargets: NATIONWIDE_TARGETS_PATH });

    const report = await readReport();
    assert.equal(report.summary.releaseScope.coverageComplete, true);
    assert.equal(report.summary.releaseScope.coveredRequirements, 6);
    assert.equal(report.summary.releaseScope.missingRequirements, 0);
    assert.ok(
      report.releaseScopeRequirements.some(
        ({ releaseTier, sourceDomain, status }) =>
          releaseTier === "ENHANCEMENT" && sourceDomain === "demand_reference" && status === "MISSING",
      ),
    );
  });
});

test("release gate는 schema v2 release target에서 operator-wide provenance로 line scope를 우회하지 않는다", async () => {
  await withCoverageWorkspace(async ({ writeCandidate, runCandidateReport, readReport }) => {
    const targets = await readNationwideTargets();
    const inventory = completeCoverageInventory(targets);
    const stationSource = findSeoul4StationSource(inventory);
    delete stationSource.coverageScope.lineIds;
    await writeCandidate(inventory, completeCoverageProvenance(inventory), pilotAndroidV1Scope());

    await assert.rejects(
      runCandidateReport({ withReleaseScope: true, releaseTargets: NATIONWIDE_TARGETS_PATH }),
      /in-scope coverage gaps remain: 1 missing requirements/,
    );

    const report = await readReport();
    const stationRequirement = report.releaseScopeRequirements.find(
      ({ sourceDomain }) => sourceDomain === "station_line_membership",
    );
    assert.equal(stationRequirement.status, "MISSING");
    assert.deepEqual(stationRequirement.sourceIds, []);
  });
});

test("전국 coverage gap report는 multi-region source의 provenance scope를 requirement별로 제한한다", async () => {
  await withCoverageWorkspace(async ({ writeCandidate, runCandidateReport, readReport }) => {
    const targets = await readNationwideTargets();
    const stationMembership = targets.requiredSourceDomains.find((domain) => domain.id === "station_line_membership");
    const multiRegionSource = {
      id: "multi-region-station-source",
      coverageScope: {
        regionIds: ["capital", "busan"],
        operatorIds: ["seoul-metro", "busan-transportation"],
        lineIds: ["seoul-4", "line-ab1a041f6266"],
        sourceDomains: ["station_line_membership"],
      },
      fieldsProvided: stationMembership.requiredFields,
    };
    const inventory = {
      schemaVersion: 1,
      retrievedAt: "2026-06-22",
      sources: [multiRegionSource],
    };
    const provenance = {
      schemaVersion: 1,
      artifactKind: "datapack-field-provenance",
      manifestSha256: "a".repeat(64),
      packs: [
        {
          id: "nationwide",
          version: "1",
          artifactKind: "production",
          sqliteSha256: "b".repeat(64),
          records: stationMembership.requiredFields.map((field) => ({
            entityType: "station_line",
            entityId: `capital-seoul-metro:${field}`,
            field,
            sourceId: multiRegionSource.id,
            coverageScope: {
              regionIds: ["capital"],
              operatorIds: ["seoul-metro"],
              lineIds: ["seoul-4"],
              sourceDomains: ["station_line_membership"],
            },
            derivationKind: "OFFICIAL",
            verifiedAt: "2026-06-22T00:00:00.000Z",
          })),
        },
      ],
    };
    await writeCandidate(inventory, provenance);
    await runCandidateReport({ allowGaps: true });

    const report = await readReport();
    const capitalRequirement = findRequirement(report, {
      regionId: "capital",
      operatorId: "seoul-metro",
      lineId: "seoul-4",
      sourceDomain: "station_line_membership",
    });
    const busanRequirement = findRequirement(report, {
      regionId: "busan",
      operatorId: "busan-transportation",
      lineId: "line-ab1a041f6266",
      sourceDomain: "station_line_membership",
    });
    assert.equal(capitalRequirement.status, "SUPPORTED");
    assert.deepEqual(capitalRequirement.missingFields, []);
    assert.equal(busanRequirement.status, "MISSING");
    assert.deepEqual(busanRequirement.sourceIds, []);
    assert.deepEqual(busanRequirement.missingFields, stationMembership.requiredFields);
  });
});

test("전국 coverage gap report는 provenance 모드에서 source-native field명을 target field gate로 쓰지 않는다", async () => {
  await withCoverageWorkspace(async ({ writeCandidate, runCandidateReport, readReport }) => {
    const inventory = {
      schemaVersion: 1,
      retrievedAt: "2026-06-22",
      sources: [
        {
          id: "kric-station-convenience-standard",
          coverageScope: {
            regionIds: ["capital"],
            operatorIds: ["seoul-metro"],
            lineIds: ["seoul-4"],
            sourceDomains: ["accessibility_facilities"],
          },
          fieldsProvided: ["station_code", "station_name", "location", "floor_from", "floor_to"],
        },
      ],
    };
    const provenance = {
      schemaVersion: 1,
      artifactKind: "datapack-field-provenance",
      manifestSha256: "a".repeat(64),
      packs: [
        {
          id: "capital",
          version: "1",
          artifactKind: "production",
          sqliteSha256: "b".repeat(64),
          records: [
            {
              entityType: "facility",
              entityId: "facility-sangnoksu-elevator-kric-1",
              field: "elevator",
              sourceId: "kric-station-convenience-standard",
              coverageScope: {
                regionIds: ["capital"],
                operatorIds: ["seoul-metro"],
                lineIds: ["seoul-4"],
                sourceDomains: ["accessibility_facilities"],
              },
              derivationKind: "OFFICIAL",
              verifiedAt: "2026-06-22T00:00:00.000Z",
            },
          ],
        },
      ],
    };
    await writeCandidate(inventory, provenance);
    await runCandidateReport({ allowGaps: true });

    const report = await readReport();
    const accessibilityRequirement = findRequirement(report, {
      regionId: "capital",
      operatorId: "seoul-metro",
      lineId: "seoul-4",
      sourceDomain: "accessibility_facilities",
    });
    const elevatorCoverage = accessibilityRequirement.fieldCoverage.find((entry) => entry.field === "elevator");
    assert.equal(elevatorCoverage.status, "covered");
    assert.deepEqual(elevatorCoverage.sourceIds, ["kric-station-convenience-standard"]);
    assert.ok(accessibilityRequirement.missingFields.includes("status"));
  });
});

test("전국 coverage gap report는 generated fixture manual provenance를 official coverage에서 제외한다", async () => {
  await withCoverageWorkspace(async ({ writeCandidate, runCandidateReport, readReport }) => {
    const targets = await readNationwideTargets();
    const inventory = completeCoverageInventory(targets);
    const provenance = completeCoverageProvenance(inventory);
    provenance.packs[0].records.find((record) => record.field === "line").derivationKind = "GENERATED";
    await writeCandidate(inventory, provenance);

    await assert.rejects(
      runCandidateReport(),
      /nationwide coverage gaps remain/,
    );

    const report = await readReport();
    assert.equal(report.summary.coverageComplete, false);
    assert.ok(report.requirements.some((entry) => entry.missingFields.includes("line")));
  });
});

test("v2 admission과 current source provider scope에 exact 결속된 generated 서울 노선도 geometry만 coverage를 충족한다", async () => {
  await withCoverageWorkspace(async ({ outputDir, inventoryPath, writeCandidate, runCandidateReport, readReport }) => {
    const targets = await readNationwideTargets();
    const inventory = completeCoverageInventory(targets);
    const source = inventory.sources.find(({ coverageScope }) =>
      coverageScope.regionIds.includes("capital")
        && coverageScope.operatorIds.includes("seoul-metro")
        && coverageScope.lineIds?.includes("seoul-2")
        && coverageScope.sourceDomains.includes("route_map_positions"));
    const originalSourceId = source.id;
    const provenance = completeCoverageProvenance(inventory);
    const snapshotId = "seoul-metro-route-map-positions-current-20260814T000000000Z";
    const layoutArtifactSha256 = "7".repeat(64);
    source.id = "seoul-metro-route-map-positions";
    source.coverageScope = {
      regionIds: ["capital"],
      operatorIds: [...SEOUL_ROUTE_MAP_SOURCE_OPERATOR_IDS],
      lineIds: [
        "line-472a81add377", "seoul-2", "line-41a8c75ec9d8", "seoul-4",
        "line-80fc4d5350d4", "line-3f41718e0833", "line-15b3b8a93259", "line-2b2d9eaa53d0",
      ],
      sourceDomains: ["route_map_positions"],
    };
    source.fieldsProvided = ["line", "station_code", "station_name", "latitude", "longitude", "basis_date"];
    source.productDerivedFields = ["route_map_position", "route_map_label_polygon", "route_map_line_track"];
    source.routeMapAdmissionEvidence = {
      capturedAt: "2026-08-14T00:00:00.000Z",
      currentLayoutAdmission: {
        schemaVersion: 2,
        artifactKind: "seoul-public-route-map-layout-admission",
        status: "ADMITTED",
        positionSnapshotId: snapshotId,
        layoutArtifactSha256,
      },
    };
    const generatedRecords = provenance.packs[0].records.filter(({ sourceId, field }) =>
      sourceId === originalSourceId
        && ["route_map_position", "route_map_label_polygon"].includes(field));
    assert.equal(generatedRecords.length, 2);
    for (const record of generatedRecords) {
      Object.assign(record, {
        entityType: "route_map_position",
        sourceId: source.id,
        derivationKind: "GENERATED",
        sourceSnapshotId: snapshotId,
        providerRecordHash: "6".repeat(64),
        evidenceHash: layoutArtifactSha256,
        verifiedAt: source.routeMapAdmissionEvidence.capturedAt,
      });
    }
    await writeCandidate(inventory, provenance);

    const findSeoul2RouteMap = (report) =>
      findRequirement(report, {
        regionId: "capital",
        operatorId: "seoul-metro",
        lineId: "seoul-2",
        sourceDomain: "route_map_positions",
      });

    await runCandidateReport();
    let report = await readReport();
    const routeMap = findSeoul2RouteMap(report);
    assert.deepEqual(routeMap.missingFields, []);
    assert.ok(routeMap.fieldCoverage.every(({ sourceIds }) => sourceIds.includes(source.id)));

    source.coverageScope.operatorIds = ["korail"];
    await writeJson(inventoryPath, inventory);
    await runCandidateReport({ allowGaps: true });
    report = await readReport();
    const operatorDriftRouteMap = findSeoul2RouteMap(report);
    assert.deepEqual(operatorDriftRouteMap.missingFields, ["route_map_position", "route_map_label_polygon"]);

    source.coverageScope.operatorIds = [...SEOUL_ROUTE_MAP_SOURCE_OPERATOR_IDS];
    await writeJson(inventoryPath, inventory);

    generatedRecords[0].evidenceHash = "8".repeat(64);
    await writeCoverageCandidate(outputDir, provenance);
    await runCandidateReport({ allowGaps: true });
    report = await readReport();
    const tamperedRouteMap = findSeoul2RouteMap(report);
    assert.ok(tamperedRouteMap.missingFields.includes(generatedRecords[0].field));
  });
});

test("release gate admits gap recording in candidate preparation state (NO_GO + RELEASE_EVIDENCE_PENDING)", async () => {
  await withCoverageWorkspace(async ({ releaseScopePath, writeCandidate, runCandidateReport, readReport }) => {
    const targets = await readNationwideTargets();
    const testInv = completeCoverageInventory(targets);
    const testProv = completeCoverageProvenance(testInv);

    const daejeonSrc = testInv.sources.find(
      (s) => s.coverageScope.operatorIds?.includes("daejeon-transportation") && s.coverageScope.lineIds?.includes("line-7051a9c2525c"),
    );
    if (daejeonSrc) delete daejeonSrc.coverageScope.lineIds;

    await writeCandidate(testInv, testProv);

    const runGate = async (launchDecision, blocker) => {
      const scopeBody = {
        decision: { currentLaunchDecision: launchDecision, ...(blocker ? { blocker } : {}) },
        verifiedAccessibilityScope: {
          id: "daejeon_pilot_candidate_scope",
          regionIds: ["daejeon"],
          includedOperatorIds: ["daejeon-transportation"],
          includedLineIds: ["line-7051a9c2525c"],
        },
      };
      await writeJson(releaseScopePath, scopeBody);
      return runCandidateReport({
        withReleaseScope: true,
        releaseTargets: NATIONWIDE_TARGETS_PATH,
      });
    };

    // Candidate preparation permits gap recording without gate failure
    await runGate("NO_GO", "RELEASE_EVIDENCE_PENDING");
    const generatedReport = await readReport();
    assert.equal(generatedReport.summary.releaseScope.candidatePreparation, true);
    assert.equal(generatedReport.summary.releaseScope.coverageComplete, false);
    assert.ok(generatedReport.summary.releaseScope.missingRequirements > 0);

    // GO decision must strictly fail closed
    let launchError = null;
    try {
      await runGate("GO");
    } catch (error) {
      launchError = error;
    }
    assert.match(launchError?.message ?? "", /in-scope coverage gaps remain: \d+ missing requirements/);
  });
});
