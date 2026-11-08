#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { isObject } from "../lib/is-object.mjs";

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export const DEFAULT_JOURNEY_GOLDEN_DIFF_DECLARATION_PATH = path.join(
  REPO_ROOT,
  "tools/datapack/release/candidate-journey-golden-diff-declaration.json",
);
export const MIN_GOLDEN_QUERY_COUNT = 20;

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const DECLARATION_KEYS = Object.freeze([
  "schemaVersion",
  "allowChangedQueries",
  "declaredChangedQueryIds",
  "declaredDiffSha256",
  "reason",
]);

function fail(code, detail) {
  const error = new Error(detail ? `${code}: ${detail}` : code);
  error.code = code;
  throw error;
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

function sortCodepoint(values) {
  return [...values].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (isObject(value)) {
    const entries = sortCodepoint(Object.keys(value)).map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
    );
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

function hasExactKeys(value, keys) {
  return (
    isObject(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key))
  );
}

function isSortedUniqueStringArray(values) {
  if (!Array.isArray(values)) return false;
  for (let index = 0; index < values.length; index += 1) {
    if (!nonEmptyString(values[index])) return false;
    if (index > 0 && !(values[index - 1] < values[index])) return false;
  }
  return true;
}

function validateChangedQueriesArray(changedQueries, expectedCount) {
  if (!Array.isArray(changedQueries) || changedQueries.length !== expectedCount) {
    fail("JOURNEY_GOLDEN_DIFF_REPORT_INVALID", "changedQueries length must equal changedCount");
  }
  const ids = [];
  for (const entry of changedQueries) {
    if (!isObject(entry) || !nonEmptyString(entry.id)) {
      fail("JOURNEY_GOLDEN_DIFF_REPORT_INVALID", "each changedQuery must be an object with a non-empty id");
    }
    ids.push(entry.id.trim());
  }
  if (!isSortedUniqueStringArray(ids)) {
    fail("JOURNEY_GOLDEN_DIFF_REPORT_INVALID", "changedQueries must be sorted by unique id");
  }
  return ids;
}

export function computeChangedQueriesSummarySha256(changedQueries) {
  if (!Array.isArray(changedQueries)) {
    fail("JOURNEY_GOLDEN_DIFF_REPORT_INVALID", "changedQueries must be an array");
  }
  const normalized = [...changedQueries]
    .map((entry) => {
      if (!isObject(entry) || !nonEmptyString(entry.id)) {
        fail("JOURNEY_GOLDEN_DIFF_REPORT_INVALID", "each changedQuery must have a non-empty id");
      }
      return { ...entry, id: entry.id.trim() };
    })
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  return createHash("sha256").update(canonicalJson(normalized)).digest("hex");
}

function validateReportShape(report) {
  if (!isObject(report) || report.schemaVersion !== 1) {
    fail("JOURNEY_GOLDEN_DIFF_REPORT_INVALID", "schemaVersion must be 1");
  }
  if (!Number.isSafeInteger(report.queryCount) || report.queryCount < MIN_GOLDEN_QUERY_COUNT) {
    fail("JOURNEY_GOLDEN_DIFF_REPORT_INVALID", `queryCount must be an integer >= ${MIN_GOLDEN_QUERY_COUNT}`);
  }
  if (!Number.isSafeInteger(report.unchangedCount) || report.unchangedCount < 0) {
    fail("JOURNEY_GOLDEN_DIFF_REPORT_INVALID", "unchangedCount must be a non-negative integer");
  }
  if (!Number.isSafeInteger(report.changedCount) || report.changedCount < 0) {
    fail("JOURNEY_GOLDEN_DIFF_REPORT_INVALID", "changedCount must be a non-negative integer");
  }
  if (report.unchangedCount + report.changedCount !== report.queryCount) {
    fail("JOURNEY_GOLDEN_DIFF_REPORT_INVALID", "unchangedCount + changedCount must equal queryCount");
  }
  if (!nonEmptyString(report.baselineBundleDir) || !nonEmptyString(report.candidateBundleDir)) {
    fail("JOURNEY_GOLDEN_DIFF_REPORT_INVALID", "baselineBundleDir and candidateBundleDir are required");
  }
  const changedQueryIds = validateChangedQueriesArray(report.changedQueries, report.changedCount);
  const expectedSha256 = computeChangedQueriesSummarySha256(report.changedQueries);
  if (typeof report.diffSummarySha256 !== "string" || !SHA256_PATTERN.test(report.diffSummarySha256)) {
    fail("JOURNEY_GOLDEN_DIFF_REPORT_INVALID", "diffSummarySha256 must be a 64-char hex sha256");
  }
  if (report.diffSummarySha256 !== expectedSha256) {
    fail("JOURNEY_GOLDEN_DIFF_REPORT_INVALID", "diffSummarySha256 does not match changedQueries summary");
  }
  return changedQueryIds;
}

function validateDeclarationShape(declaration) {
  if (!hasExactKeys(declaration, DECLARATION_KEYS) || declaration.schemaVersion !== 1) {
    fail("JOURNEY_GOLDEN_DIFF_DECLARATION_INVALID", "declaration must have exact v1 schema keys");
  }
  if (typeof declaration.allowChangedQueries !== "boolean") {
    fail("JOURNEY_GOLDEN_DIFF_DECLARATION_INVALID", "allowChangedQueries must be a boolean");
  }
  if (!isSortedUniqueStringArray(declaration.declaredChangedQueryIds)) {
    fail("JOURNEY_GOLDEN_DIFF_DECLARATION_INVALID", "declaredChangedQueryIds must be a sorted unique string array");
  }
}

function validateZeroDiffAgainstDeclaration(report, declaration) {
  if (declaration.allowChangedQueries) {
    fail("JOURNEY_GOLDEN_DIFF_STALE_DECLARATION", "changedCount is 0 but allowChangedQueries is true");
  }
  if (
    declaration.declaredChangedQueryIds.length !== 0
    || declaration.declaredDiffSha256 !== null
    || declaration.reason !== null
  ) {
    fail(
      "JOURNEY_GOLDEN_DIFF_DECLARATION_INVALID",
      "zero-diff declaration must have empty declaredChangedQueryIds and null declaredDiffSha256/reason",
    );
  }
  return {
    status: "GO",
    mode: "ZERO_DIFF",
    queryCount: report.queryCount,
    unchangedCount: report.unchangedCount,
    changedCount: 0,
    changedQueryIds: [],
    diffSummarySha256: report.diffSummarySha256,
    reason: null,
  };
}

function validateDeclaredDiffAgainstDeclaration(report, declaration, changedQueryIds) {
  if (!declaration.allowChangedQueries) {
    fail(
      "JOURNEY_GOLDEN_DIFF_UNDECLARED_CHANGES",
      `changedCount is ${report.changedCount} (${changedQueryIds.join(", ")}) but allowChangedQueries is false`,
    );
  }
  if (!nonEmptyString(declaration.reason)) {
    fail("JOURNEY_GOLDEN_DIFF_REASON_REQUIRED", "reason must be a non-empty string when allowChangedQueries is true");
  }
  if (
    declaration.declaredChangedQueryIds.length === 0
    || JSON.stringify(declaration.declaredChangedQueryIds) !== JSON.stringify(changedQueryIds)
  ) {
    fail(
      "JOURNEY_GOLDEN_DIFF_QUERY_IDS_MISMATCH",
      `declaredChangedQueryIds (${declaration.declaredChangedQueryIds.join(", ")}) != actual (${changedQueryIds.join(", ")})`,
    );
  }
  if (typeof declaration.declaredDiffSha256 !== "string" || !SHA256_PATTERN.test(declaration.declaredDiffSha256)) {
    fail("JOURNEY_GOLDEN_DIFF_SHA256_MISMATCH", "declaredDiffSha256 must be a 64-char lowercase hex sha256");
  }
  if (declaration.declaredDiffSha256 !== report.diffSummarySha256) {
    fail(
      "JOURNEY_GOLDEN_DIFF_SHA256_MISMATCH",
      `declaredDiffSha256 (${declaration.declaredDiffSha256}) != actual (${report.diffSummarySha256})`,
    );
  }
  return {
    status: "GO",
    mode: "DECLARED_DIFF",
    queryCount: report.queryCount,
    unchangedCount: report.unchangedCount,
    changedCount: report.changedCount,
    changedQueryIds,
    diffSummarySha256: report.diffSummarySha256,
    reason: declaration.reason.trim(),
  };
}

export function validateCandidateJourneyGoldenDiffReport(report, declaration) {
  const changedQueryIds = validateReportShape(report);
  validateDeclarationShape(declaration);
  if (report.changedCount === 0) {
    return validateZeroDiffAgainstDeclaration(report, declaration);
  }
  return validateDeclaredDiffAgainstDeclaration(report, declaration, changedQueryIds);
}

export function formatJourneyGoldenDiffEvidenceLine(validation) {
  if (!isObject(validation) || validation.status !== "GO") {
    fail("JOURNEY_GOLDEN_DIFF_EVIDENCE_INVALID", "validation must be a GO result");
  }
  const base = `- Journey golden diff: status=${validation.status} mode=${validation.mode} queryCount=${validation.queryCount} unchangedCount=${validation.unchangedCount} changedCount=${validation.changedCount} diffSummarySha256=${validation.diffSummarySha256}`;
  if (validation.mode === "DECLARED_DIFF") {
    return `${base} declaredQueryIds=${validation.changedQueryIds.join(",")}`;
  }
  return base;
}

async function produceRawGoldenDiffReport({
  baselineBundleDir,
  candidateBundleDir,
  backendDir,
  goldenDiffInputPath,
  execGradleImpl = execFileAsync,
}) {
  if (nonEmptyString(goldenDiffInputPath)) {
    return JSON.parse(await readFile(path.resolve(goldenDiffInputPath), "utf8"));
  }
  if (!nonEmptyString(backendDir)) {
    fail(
      "JOURNEY_GOLDEN_DIFF_ARGUMENTS",
      "either --golden-diff-input or --backend-dir must be provided",
    );
  }
  const resolvedBackendDir = path.resolve(backendDir);
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "journey-golden-diff-"));
  const tempReportPath = path.join(tempDir, "journey-golden-diff-report.json");
  try {
    await execGradleImpl(
      path.join(resolvedBackendDir, "gradlew"),
      [
        "--no-daemon",
        "journeyGoldenDiff",
        `-PgoldenBaselineBundle=${path.resolve(baselineBundleDir)}`,
        `-PgoldenCandidateBundle=${path.resolve(candidateBundleDir)}`,
        `-PgoldenDiffReport=${tempReportPath}`,
      ],
      { cwd: resolvedBackendDir, maxBuffer: 64 * 1024 * 1024 },
    );
    return JSON.parse(await readFile(tempReportPath, "utf8"));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function normalizeRawGoldenDiffReport(rawReport, { baselineBundleDir, candidateBundleDir }) {
  if (!isObject(rawReport)) {
    fail("JOURNEY_GOLDEN_DIFF_REPORT_INVALID", "raw golden diff report must be a JSON object");
  }
  const rawChanged = Array.isArray(rawReport.changedQueries) ? rawReport.changedQueries : [];
  const sortedChanged = [...rawChanged].sort((left, right) => {
    const leftId = String(left?.id ?? "");
    const rightId = String(right?.id ?? "");
    return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
  });
  const computedSha256 = computeChangedQueriesSummarySha256(sortedChanged);
  if (
    rawReport.diffSummarySha256 !== undefined
    && rawReport.diffSummarySha256 !== null
    && rawReport.diffSummarySha256 !== computedSha256
  ) {
    fail("JOURNEY_GOLDEN_DIFF_REPORT_INVALID", "raw report diffSummarySha256 does not match changedQueries");
  }
  return {
    schemaVersion: rawReport.schemaVersion ?? 1,
    baselineBundleDir: nonEmptyString(baselineBundleDir) ? baselineBundleDir : rawReport.baselineBundleDir,
    candidateBundleDir: nonEmptyString(candidateBundleDir) ? candidateBundleDir : rawReport.candidateBundleDir,
    queryCount: rawReport.queryCount,
    unchangedCount: rawReport.unchangedCount,
    changedCount: rawReport.changedCount,
    changedQueries: sortedChanged,
    diffSummarySha256: computedSha256,
  };
}

export async function runCandidateJourneyGoldenDiff({
  baselineBundleDir,
  candidateBundleDir,
  declarationPath = DEFAULT_JOURNEY_GOLDEN_DIFF_DECLARATION_PATH,
  reportOutPath,
  backendDir,
  goldenDiffInputPath,
  execGradleImpl,
} = {}) {
  const declaration = JSON.parse(await readFile(path.resolve(declarationPath), "utf8"));
  const rawReport = await produceRawGoldenDiffReport({
    baselineBundleDir,
    candidateBundleDir,
    backendDir,
    goldenDiffInputPath,
    execGradleImpl,
  });
  const report = normalizeRawGoldenDiffReport(rawReport, { baselineBundleDir, candidateBundleDir });
  const validation = validateCandidateJourneyGoldenDiffReport(report, declaration);
  const fullReport = {
    ...report,
    validation,
  };
  if (nonEmptyString(reportOutPath)) {
    const resolvedOut = path.resolve(reportOutPath);
    await mkdir(path.dirname(resolvedOut), { recursive: true });
    await writeFile(resolvedOut, `${JSON.stringify(fullReport, null, 2)}\n`, "utf8");
  }
  return { report: fullReport, validation };
}

function parseCliArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || typeof value !== "string" || value.startsWith("--")) {
      fail("JOURNEY_GOLDEN_DIFF_ARGUMENTS", `invalid CLI argument near ${String(flag)}`);
    }
    const key = flag.slice(2);
    if (Object.hasOwn(options, key)) {
      fail("JOURNEY_GOLDEN_DIFF_ARGUMENTS", `duplicate CLI argument --${key}`);
    }
    options[key] = value;
  }
  return {
    baselineBundleDir: options["baseline-bundle"],
    candidateBundleDir: options["candidate-bundle"],
    declarationPath: options.declaration ?? DEFAULT_JOURNEY_GOLDEN_DIFF_DECLARATION_PATH,
    reportOutPath: options["report-out"],
    backendDir: options["backend-dir"],
    goldenDiffInputPath: options["golden-diff-input"],
  };
}

export async function main(argv = process.argv.slice(2), { write = (chunk) => process.stdout.write(chunk) } = {}) {
  const parsed = parseCliArgs(argv);
  const { validation } = await runCandidateJourneyGoldenDiff(parsed);
  write(`${formatJourneyGoldenDiffEvidenceLine(validation)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
