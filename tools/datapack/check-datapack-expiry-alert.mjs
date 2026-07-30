#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

function argValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function parseIsoDurationSeconds(value) {
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(value ?? "");
  if (!match) throw new Error("alertBeforePackExpiry must be PT duration");
  return Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0);
}

function parseTime(value, name) {
  const millis = Date.parse(value ?? "");
  if (!Number.isFinite(millis)) throw new Error(`${name} must be ISO date-time`);
  return millis;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function main() {
  const args = process.argv.slice(2);
  const manifestPath = argValue(args, "--manifest");
  const outputPath = argValue(args, "--output");
  const policyPath = argValue(args, "--policy") ?? "release/product-gates/datapack-freshness-sla.json";
  const now = parseTime(argValue(args, "--now") ?? new Date().toISOString(), "now");
  if (!manifestPath || !outputPath) throw new Error("--manifest and --output are required");

  const [manifestRaw, policy] = await Promise.all([readFile(manifestPath, "utf8"), readJson(policyPath)]);
  const manifest = JSON.parse(manifestRaw);
  const thresholdSeconds = parseIsoDurationSeconds(policy.monitoring?.alertBeforePackExpiry);
  const expiresAtMillis = parseTime(manifest.expiresAt, "manifest.expiresAt");
  const secondsUntilExpiry = Math.floor((expiresAtMillis - now) / 1000);
  const shouldAlert = secondsUntilExpiry <= thresholdSeconds;
  const severity = secondsUntilExpiry <= 0 ? "critical" : shouldAlert ? "warning" : "none";

  const evidence = {
    schemaVersion: 1,
    artifactKind: "datapack-expiry-alert-evidence",
    policy: {
      path: policyPath,
      alertBeforePackExpiry: policy.monitoring.alertBeforePackExpiry,
      thresholdSeconds,
    },
    manifest: {
      path: manifestPath,
      sha256: createHash("sha256").update(manifestRaw).digest("hex"),
      channel: manifest.channel,
      releaseSequence: manifest.releaseSequence,
      publishedAt: manifest.publishedAt,
      expiresAt: manifest.expiresAt,
    },
    alert: {
      status: shouldAlert ? "FIRING" : "OK",
      severity,
      secondsUntilExpiry,
      summary: shouldAlert ? "Data pack manifest is near expiry" : "Data pack manifest freshness is within SLA",
    },
    checkedAt: new Date(now).toISOString(),
  };
  await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`);
}

try {
  await main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
