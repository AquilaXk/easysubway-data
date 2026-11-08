import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { execFileAsync } from "./test-fixtures/datapack-tools-support.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const DEFAULT_FIXTURE_PATH = "tools/datapack/fixtures/catalog-fixture.json";

function manualOverrideLedger(facilityStatusUpdates, overrides = {}) {
  return {
    artifactKind: "datapack-manual-override-ledger",
    schemaVersion: 1,
    ledgerSource: "manual_overrides",
    source: "facility-report-admin-review",
    exportedAt: "2026-06-21T00:00:00.000Z",
    facilityStatusUpdates,
    ...overrides,
  };
}

async function withAdminOverrideWorkspace(prefix, ledger, fn) {
  const outputDir = path.join(tmpdir(), `easysubway-admin-review-overrides-${prefix}-${Date.now()}`);
  const overridePath = path.join(outputDir, "admin-review-overrides.json");
  const outputPath = path.join(outputDir, "catalog-fixture.reviewed.json");
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(overridePath, `${JSON.stringify(ledger, null, 2)}\n`);

  const runApplyOverrides = (fixturePath = DEFAULT_FIXTURE_PATH) =>
    execFileAsync(
      process.execPath,
      [
        "tools/datapack/apply-admin-review-overrides.mjs",
        "--fixture",
        fixturePath,
        "--overrides",
        overridePath,
        "--output",
        outputPath,
      ],
      { cwd: root },
    );

  const readReviewedPack = async () => {
    const reviewedFixture = JSON.parse(await readFile(outputPath, "utf8"));
    const pack = reviewedFixture.packs[0];
    return {
      pack,
      reviewedFacility: pack.facilities.find((facility) => facility.id === "facility-sangnoksu-elevator-1"),
      reviewedInternalRouteEdge: pack.internalRouteEdges.find(
        (edge) => edge.id === "edge-sangnoksu-concourse-exit-1",
      ),
      reviewedSummary: pack.stationAccessibilitySummaries.find(
        (summary) => summary.stationId === "station-sangnoksu",
      ),
    };
  };

  try {
    await fn({ outputDir, runApplyOverrides, readReviewedPack });
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
}

test("관리자 검수 override는 fixture에 없는 시설 id를 거부한다", async () => {
  await withAdminOverrideWorkspace(
    "missing-facility",
    manualOverrideLedger([
      {
        reportId: "report-admin-approved-missing-facility",
        facilityId: "facility-missing",
        status: "BROKEN",
        reviewedBy: "admin-user",
        reviewedAt: "2026-06-21T00:00:00.000Z",
      },
    ]),
    async ({ runApplyOverrides }) => {
      await assert.rejects(
        runApplyOverrides(),
        /facilityStatusUpdates\.facilityId was not found in fixture: facility-missing/,
      );
    },
  );
});

test("production 관리자 검수 override는 legacy transit_master_overrides 입력을 거부한다", async () => {
  await withAdminOverrideWorkspace(
    "legacy",
    manualOverrideLedger(
      [
        {
          reportId: "legacy-effective-master-row",
          facilityId: "facility-sangnoksu-elevator-1",
          status: "NORMAL",
          reviewedBy: "admin-user",
          reviewedAt: "2026-06-21T00:00:00.000Z",
        },
      ],
      {
        artifactKind: "transit-master-overrides",
        ledgerSource: "transit_master_overrides",
        source: "transit_master_overrides",
      },
    ),
    async ({ runApplyOverrides }) => {
      await assert.rejects(
        runApplyOverrides(),
        /transit_master_overrides.*manual_overrides ledger/s,
      );
    },
  );
});

test("관리자 검수 override는 복구 상태를 route 접근성에 다시 반영한다", async () => {
  await withAdminOverrideWorkspace(
    "recovered",
    manualOverrideLedger([
      {
        reportId: "report-admin-approved-broken-elevator",
        facilityId: "facility-sangnoksu-elevator-1",
        status: "BROKEN",
        reviewedBy: "admin-user",
        reviewedAt: "2026-06-21T00:00:00.000Z",
      },
      {
        reportId: "report-admin-approved-recovered-elevator",
        facilityId: "facility-sangnoksu-elevator-1",
        status: "NORMAL",
        reviewedBy: "admin-user",
        reviewedAt: "2026-06-21T00:10:00.000Z",
      },
    ]),
    async ({ runApplyOverrides, readReviewedPack }) => {
      await runApplyOverrides();
      const { reviewedFacility, reviewedInternalRouteEdge, reviewedSummary } = await readReviewedPack();
      assert.equal(reviewedFacility.status, "NORMAL");
      assert.equal(reviewedFacility.statusMeaning, "REALTIME_OPERATION");
      assert.equal(reviewedFacility.operationalStatus, "AVAILABLE");
      assert.equal(reviewedInternalRouteEdge.accessibilityStatus, "AVAILABLE");
      assert.equal(reviewedSummary.summary, "1번 출구 엘리베이터 이용 가능");
      assert.equal(reviewedSummary.warning, "");
    },
  );
});

test("관리자 검수 override는 같은 시설의 최신 reviewedAt 결과만 적용한다", async () => {
  await withAdminOverrideWorkspace(
    "latest",
    manualOverrideLedger([
      {
        reportId: "report-admin-approved-recovered-elevator",
        facilityId: "facility-sangnoksu-elevator-1",
        status: "NORMAL",
        reviewedBy: "admin-user",
        reviewedAt: "2026-06-21T00:10:00.000Z",
      },
      {
        reportId: "report-admin-approved-older-broken-elevator",
        facilityId: "facility-sangnoksu-elevator-1",
        status: "BROKEN",
        reviewedBy: "admin-user",
        reviewedAt: "2026-06-21T00:00:00.000Z",
      },
    ]),
    async ({ runApplyOverrides, readReviewedPack }) => {
      await runApplyOverrides();
      const { pack, reviewedFacility, reviewedInternalRouteEdge, reviewedSummary } = await readReviewedPack();
      assert.equal(reviewedFacility.status, "NORMAL");
      assert.equal(reviewedInternalRouteEdge.accessibilityStatus, "AVAILABLE");
      assert.equal(reviewedSummary.summary, "1번 출구 엘리베이터 이용 가능");
      assert.equal(reviewedSummary.warning, "");
      assert.equal(pack.metadata.adminReviewOverrideCount, "1");
    },
  );
});

test("관리자 검수 override는 같은 역의 제한 시설 상태를 정상 시설로 지우지 않는다", async () => {
  await withAdminOverrideWorkspace(
    "station-summary",
    manualOverrideLedger([
      {
        reportId: "report-admin-approved-broken-elevator",
        facilityId: "facility-sangnoksu-elevator-1",
        status: "BROKEN",
        reviewedBy: "admin-user",
        reviewedAt: "2026-06-21T00:00:00.000Z",
      },
      {
        reportId: "report-admin-approved-normal-second-elevator",
        facilityId: "facility-sangnoksu-elevator-2",
        status: "NORMAL",
        reviewedBy: "admin-user",
        reviewedAt: "2026-06-21T00:01:00.000Z",
      },
    ]),
    async ({ outputDir, runApplyOverrides, readReviewedPack }) => {
      const inputPath = path.join(outputDir, "catalog-fixture.json");
      const fixture = JSON.parse(await readFile(DEFAULT_FIXTURE_PATH, "utf8"));
      fixture.packs[0].facilities.push({
        id: "facility-sangnoksu-elevator-2",
        stationId: "station-sangnoksu",
        exitId: "exit-sangnoksu-1",
        type: "ELEVATOR",
        name: "2번 출구 엘리베이터",
        status: "NORMAL",
        floorFrom: "B1",
        floorTo: "1F",
        description: "대합실과 1번 출구 지상을 연결",
      });
      await writeFile(inputPath, `${JSON.stringify(fixture, null, 2)}\n`);

      await runApplyOverrides(inputPath);
      const { pack, reviewedInternalRouteEdge, reviewedSummary } = await readReviewedPack();
      assert.equal(reviewedInternalRouteEdge.accessibilityStatus, "UNAVAILABLE");
      assert.equal(reviewedSummary.summary, "1번 출구 엘리베이터 이용 제한");
      assert.equal(reviewedSummary.warning, "1번 출구 엘리베이터 고장으로 우회가 필요합니다.");
      assert.equal(pack.metadata.adminReviewOverrideCount, "2");
    },
  );
});
