#!/usr/bin/env node
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { isMainModule } from "../lib/is-main-module.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const execFileAsync = promisify(execFile);
const FIXTURE = "tools/datapack/release/capital-production-canonical-pack.json";
const REVIEWED_AMBIGUITIES = "tools/route-map/fixtures/reviewed-ambiguities.json";
const OUTPUT = "tools/datapack/release/strict-route-regression-report.json";
const AUDITOR = "tools/route-map/audit-route-map.mjs";
const EXPECTED_REGIONS = ["광주권", "대구권", "대전권", "부산권", "수도권"];
const SEVERITIES = ["BLOCKER", "HIGH", "MEDIUM", "LOW", "INFO"];

function same(left, right) { return JSON.stringify(left) === JSON.stringify(right); }

function requireGeneratedBy(builderGitSha, generatedAtUtc) {
  if (!/^[a-f0-9]{40}$/u.test(builderGitSha ?? "")) throw new Error("builderGitSha is invalid");
  if (typeof generatedAtUtc !== "string" || !Number.isFinite(Date.parse(generatedAtUtc))
    || new Date(generatedAtUtc).toISOString() !== generatedAtUtc) {
    throw new Error("generatedAtUtc is invalid");
  }
}

function validateRawAudit(rawAudit) {
  if (rawAudit?.schemaVersion !== 1 || rawAudit.artifactKind !== "route-map-position-audit"
    || rawAudit.source !== FIXTURE || !Array.isArray(rawAudit.packs) || rawAudit.packs.length !== 1
    || rawAudit.packs[0]?.id !== "capital" || !Array.isArray(rawAudit.findings)
    || !Array.isArray(rawAudit.packs[0].findings)) {
    throw new Error("audit source identity is invalid");
  }
  const { summary, packs } = rawAudit;
  if (summary?.packCount !== 1 || !summary.findingsBySeverity
    || Object.keys(summary.findingsBySeverity).length !== SEVERITIES.length
    || SEVERITIES.some((severity) => !Number.isSafeInteger(summary.findingsBySeverity[severity])
      || summary.findingsBySeverity[severity] < 0)) {
    throw new Error("audit findings summary is incoherent");
  }
  if (summary.findingsBySeverity.BLOCKER !== 0 || summary.findingsBySeverity.HIGH !== 0) {
    throw new Error("audit BLOCKER and HIGH must be zero");
  }
  if (!Array.isArray(packs[0].summary?.regions)
    || !same(packs[0].summary.regions.map(({ region }) => region), EXPECTED_REGIONS)) {
    throw new Error("audit region identity is invalid");
  }
  if (!same(packs[0].findings, rawAudit.findings)
    || SEVERITIES.some((severity) =>
      rawAudit.findings.filter((finding) => finding?.severity === severity).length
        !== summary.findingsBySeverity[severity],
    )
    || rawAudit.findings.some((finding) => !SEVERITIES.includes(finding?.severity))) {
    throw new Error("audit findings summary is incoherent");
  }
}

export function buildCurrentStrictRouteRegressionReport({ rawAudit, builderGitSha, generatedAtUtc }) {
  requireGeneratedBy(builderGitSha, generatedAtUtc);
  validateRawAudit(rawAudit);
  return {
    schemaVersion: 1,
    artifactKind: "strict-route-regression-report",
    issue: 309,
    productionScopeId: "capital_pilot_android_v1",
    generatedBy: {
      fixtureBuilder: "tools/datapack/activate-current-source-set.mjs",
      auditor: AUDITOR,
      reviewedAmbiguities: REVIEWED_AMBIGUITIES,
      failOn: ["BLOCKER", "HIGH"],
      builderGitSha,
      generatedAtUtc,
    },
    auditExitCode: 0,
    summary: structuredClone(rawAudit.summary),
    regions: structuredClone(rawAudit.packs[0].summary.regions),
    findings: structuredClone(rawAudit.findings),
  };
}

export function parseCurrentStrictRouteRegressionReportArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!["--builder-git-sha", "--generated-at-utc"].includes(flag) || values[flag] !== undefined) {
      throw new Error("strict route report argument is invalid");
    }
    const value = argv[++index];
    if (!value) throw new Error("strict route report argument is invalid");
    values[flag] = value;
  }
  requireGeneratedBy(values["--builder-git-sha"], values["--generated-at-utc"]);
  return { builderGitSha: values["--builder-git-sha"], generatedAtUtc: values["--generated-at-utc"] };
}

export async function runCurrentStrictRouteAudit({ execFileImpl = execFileAsync } = {}) {
  let stdout;
  try {
    ({ stdout } = await execFileImpl(process.execPath, [
      AUDITOR, "--fixture", FIXTURE, "--reviewed-ambiguities", REVIEWED_AMBIGUITIES,
      "--fail-on", "BLOCKER,HIGH",
    ], { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }));
  } catch {
    throw new Error("strict route audit command failed");
  }
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error("strict route audit stdout is invalid");
  }
}

export async function writeCurrentStrictRouteRegressionReport(bytes, outputPath = path.join(root, OUTPUT)) {
  const temporaryPath = path.join(path.dirname(outputPath), `.${path.basename(outputPath)}.${randomUUID()}.tmp`);
  await writeFile(temporaryPath, bytes, { flag: "wx" });
  await rename(temporaryPath, outputPath);
}

async function main() {
  const args = parseCurrentStrictRouteRegressionReportArgs(process.argv.slice(2));
  const rawAudit = await runCurrentStrictRouteAudit();
  const report = buildCurrentStrictRouteRegressionReport({ rawAudit, ...args });
  await writeCurrentStrictRouteRegressionReport(Buffer.from(`${JSON.stringify(report, null, 2)}\n`));
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
