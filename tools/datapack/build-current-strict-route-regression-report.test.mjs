import assert from "node:assert/strict";
import test from "node:test";

import { buildCurrentStrictRouteRegressionReport, verifyCurrentStrictRouteReportBuilder } from "./build-current-strict-route-regression-report.mjs";

const generatedBy = {
  builderGitSha: "a".repeat(40),
  generatedAtUtc: "2026-08-15T01:02:03.000Z",
};
const findingsBySeverity = { BLOCKER: 0, HIGH: 0, MEDIUM: 1, LOW: 0, INFO: 1 };
const rawAudit = {
  schemaVersion: 1,
  artifactKind: "route-map-position-audit",
  source: "tools/datapack/release/capital-production-canonical-pack.json",
  summary: { packCount: 1, findingsBySeverity },
  packs: [{
    id: "capital",
    summary: {
      regions: [
        { region: "광주권", stationLineCount: 20, coverageRatio: 1 },
        { region: "대구권", stationLineCount: 101, coverageRatio: 1 },
        { region: "대전권", stationLineCount: 22, coverageRatio: 1 },
        { region: "부산권", stationLineCount: 158, coverageRatio: 1 },
        { region: "수도권", stationLineCount: 801, coverageRatio: 1 },
      ],
    },
    findings: [
      { severity: "MEDIUM", code: "LABEL_OVERLAP", packId: "capital", region: "수도권", lineId: "", stationId: "", message: "test" },
      { severity: "INFO", code: "REVIEWED_AMBIGUITY", packId: "capital", region: "부산권", lineId: "line", stationId: "station", message: "test" },
    ],
  }],
  findings: [
    { severity: "MEDIUM", code: "LABEL_OVERLAP", packId: "capital", region: "수도권", lineId: "", stationId: "", message: "test" },
    { severity: "INFO", code: "REVIEWED_AMBIGUITY", packId: "capital", region: "부산권", lineId: "line", stationId: "station", message: "test" },
  ],
};

test("current strict route report는 exact green audit을 deterministic wrapper로 보존한다", () => {
  const report = buildCurrentStrictRouteRegressionReport({ rawAudit, ...generatedBy });
  assert.equal(report.artifactKind, "strict-route-regression-report");
  assert.equal(report.issue, 309);
  assert.equal(report.auditExitCode, 0);
  assert.deepEqual(report.summary, rawAudit.summary);
  assert.deepEqual(report.regions, rawAudit.packs[0].summary.regions);
  assert.deepEqual(report.findings, rawAudit.findings);
  assert.equal(report.generatedBy.builderGitSha, generatedBy.builderGitSha);
  assert.equal(report.generatedBy.generatedAtUtc, generatedBy.generatedAtUtc);
  assert.equal(report.candidateBinding, undefined);
  assert.equal(report.active, undefined);
});

test("strict route report는 non-green, source/region drift, 또는 raw summary 불일치를 거부한다", () => {
  const blocked = structuredClone(rawAudit);
  blocked.summary.findingsBySeverity.BLOCKER = 1;
  blocked.findings[0].severity = "BLOCKER";
  blocked.packs[0].findings[0].severity = "BLOCKER";
  assert.throws(() => buildCurrentStrictRouteRegressionReport({ rawAudit: blocked, ...generatedBy }), /BLOCKER and HIGH must be zero/);

  const wrongSource = structuredClone(rawAudit);
  wrongSource.source = "tools/datapack/release/other.json";
  assert.throws(() => buildCurrentStrictRouteRegressionReport({ rawAudit: wrongSource, ...generatedBy }), /audit source identity is invalid/);

  const missingRegion = structuredClone(rawAudit);
  missingRegion.packs[0].summary.regions.pop();
  assert.throws(() => buildCurrentStrictRouteRegressionReport({ rawAudit: missingRegion, ...generatedBy }), /audit region identity is invalid/);

  const incoherent = structuredClone(rawAudit);
  incoherent.summary.findingsBySeverity.INFO = 0;
  assert.throws(() => buildCurrentStrictRouteRegressionReport({ rawAudit: incoherent, ...generatedBy }), /audit findings summary is incoherent/);

  assert.throws(() => buildCurrentStrictRouteRegressionReport({ rawAudit, builderGitSha: "A".repeat(40), generatedAtUtc: generatedBy.generatedAtUtc }), /builderGitSha is invalid/);
});

test("strict report CLI builder gate는 exact HEAD와 activation output-only dirty state만 수용한다", async () => {
  const exactHead = "b".repeat(40);
  const execFor = ({ commitType = "commit\n", head = `${exactHead}\n`, status = "" } = {}) => async (_file, args) => {
    if (args[0] === "cat-file") return { stdout: commitType };
    if (args[0] === "rev-parse") return { stdout: head };
    if (args[0] === "status") return { stdout: status };
    throw new Error("unexpected git command");
  };
  await verifyCurrentStrictRouteReportBuilder({
    builderGitSha: exactHead,
    execFileImpl: execFor({ status: " M tools/datapack/release/capital-production-canonical-pack.json\n" }),
  });
  await assert.rejects(
    verifyCurrentStrictRouteReportBuilder({ builderGitSha: exactHead, execFileImpl: execFor({ commitType: "blob\n" }) }),
    /must name a commit/,
  );
  await assert.rejects(
    verifyCurrentStrictRouteReportBuilder({ builderGitSha: exactHead, execFileImpl: execFor({ head: `${"c".repeat(40)}\n` }) }),
    /does not match HEAD/,
  );
  await assert.rejects(
    verifyCurrentStrictRouteReportBuilder({ builderGitSha: exactHead, execFileImpl: execFor({ status: "?? stray.txt\n" }) }),
    /unrelated or untracked paths/,
  );
});
