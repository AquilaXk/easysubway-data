import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DEFAULT_CRITICAL_SECONDS,
  DEFAULT_WARN_SECONDS,
  classifySnapshotFreshness,
  computeItxAdmissionServiceDates,
  parseArgs,
  renderPrometheusMetrics,
  runCheckTimetableSnapshotFreshnessCli,
} from "./check-timetable-snapshot-freshness.mjs";

const FRESH_UNTIL = "2026-07-27T00:00:00+09:00";
const freshUntilMs = Date.parse(FRESH_UNTIL);
const at = (secondsBefore) => new Date(freshUntilMs - secondsBefore * 1000);

test("여유가 충분하면 OK, 경보 없음", () => {
  const result = classifySnapshotFreshness({ freshUntil: FRESH_UNTIL, now: at(10 * 86_400) });
  assert.equal(result.status, "OK");
  assert.equal(result.severity, "none");
  assert.equal(result.shouldRefresh, false);
  assert.equal(result.expired, false);
});

test("T-72h refresh lead 창에 들어오면 shouldRefresh=true", () => {
  const result = classifySnapshotFreshness({ freshUntil: FRESH_UNTIL, now: at(3 * 86_400 - 1) });
  assert.equal(result.shouldRefresh, true);
});

test("T-24h 이내이면 warning 경보가 발화한다", () => {
  const result = classifySnapshotFreshness({ freshUntil: FRESH_UNTIL, now: at(DEFAULT_WARN_SECONDS - 60) });
  assert.equal(result.status, "FIRING");
  assert.equal(result.severity, "warning");
  assert.equal(result.shouldRefresh, true);
});

test("T-6h 이내이면 critical 경보로 격상한다", () => {
  const result = classifySnapshotFreshness({ freshUntil: FRESH_UNTIL, now: at(DEFAULT_CRITICAL_SECONDS - 60) });
  assert.equal(result.severity, "critical");
});

test("만료 이후에는 expired=true, critical, remainingSeconds<=0", () => {
  const result = classifySnapshotFreshness({ freshUntil: FRESH_UNTIL, now: at(-3600) });
  assert.equal(result.expired, true);
  assert.equal(result.severity, "critical");
  assert.ok(result.remainingSeconds <= 0);
});

test("잘못된 freshUntil은 예외", () => {
  assert.throws(() => classifySnapshotFreshness({ freshUntil: "not-a-date", now: new Date() }));
});

test("warn-seconds가 critical-seconds보다 작으면 예외", () => {
  assert.throws(() =>
    classifySnapshotFreshness({ freshUntil: FRESH_UNTIL, now: new Date(), warnSeconds: 60, criticalSeconds: 3600 }),
  );
});

test("Prometheus exposition 형식은 gauge 3종을 노출한다", () => {
  const metrics = renderPrometheusMetrics(classifySnapshotFreshness({ freshUntil: FRESH_UNTIL, now: at(86_400) }));
  assert.match(metrics, /# TYPE easysubway_timetable_snapshot_remaining_seconds gauge/);
  assert.match(metrics, /easysubway_timetable_snapshot_remaining_seconds 86400/);
  assert.match(metrics, /easysubway_timetable_snapshot_fresh_until_timestamp_seconds \d+/);
  assert.match(metrics, /easysubway_timetable_snapshot_expired 0/);
});

test("admission service dates는 창 안의 평일·토·일을 고른다", () => {
  // 2026-07-20은 월요일(KST). 창: 07-20(월)~07-26(일).
  const dates = computeItxAdmissionServiceDates(new Date("2026-07-20T00:00:00+09:00"));
  assert.equal(dates["8"], "20260720"); // 월요일(평일)
  assert.equal(dates["7"], "20260725"); // 토요일
  assert.equal(dates["9"], "20260726"); // 일요일
});

test("parseArgs는 --로 시작하지만 플래그 이름 형태가 아닌 값을 값으로 인식한다", () => {
  const result = parseArgs(["--evidence", "--not-a-flag.json", "--fail-on-critical"]);
  assert.equal(result.evidence, "--not-a-flag.json");
  assert.equal(result["fail-on-critical"], true);
});

test("parseArgs는 실제 플래그 이름 형태의 다음 토큰은 여전히 플래그 경계로 인식한다", () => {
  const result = parseArgs(["--warn-seconds", "--critical-seconds", "60"]);
  assert.equal(result["warn-seconds"], true);
  assert.equal(result["critical-seconds"], "60");
});

test("CLI는 evidence를 읽어 evidence/metrics/github-output를 남기고 fail-on-critical을 반영한다", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "freshness-cli-"));
  const evidencePath = path.join(dir, "evidence.json");
  await writeFile(evidencePath, `${JSON.stringify({ freshUntil: FRESH_UNTIL })}\n`);
  const outputPath = path.join(dir, "out.json");
  const metricsPath = path.join(dir, "metrics.prom");
  const githubOutputPath = path.join(dir, "gh-output");
  await writeFile(githubOutputPath, "");

  const { result, exitCode } = await runCheckTimetableSnapshotFreshnessCli({
    argv: [
      "--evidence", evidencePath,
      "--output", outputPath,
      "--metrics-output", metricsPath,
      "--github-output", githubOutputPath,
      "--fail-on-critical",
    ],
    now: at(DEFAULT_CRITICAL_SECONDS - 60),
    cwd: dir,
  });

  assert.equal(result.severity, "critical");
  assert.equal(exitCode, 1);
  const evidenceOut = JSON.parse(await readFile(outputPath, "utf8"));
  assert.equal(evidenceOut.artifactKind, "timetable-snapshot-freshness-alert");
  assert.equal(evidenceOut.serviceDates["8"].length, 8);
  assert.match(evidenceOut.serviceDates["8"], /^\d{8}$/);
  const ghOutput = await readFile(githubOutputPath, "utf8");
  assert.match(ghOutput, /severity=critical/);
  assert.match(ghOutput, /should_refresh=true/);
  assert.match(ghOutput, /day8_date=\d{8}/);
  assert.match(await readFile(metricsPath, "utf8"), /easysubway_timetable_snapshot_expired 0/);
});
