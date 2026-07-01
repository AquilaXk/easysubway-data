#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const SHA256 = /^[a-f0-9]{64}$/;
const REQUIRED_PATCH_TABLES = ["facilities", "network_edges", "transit_stop_times"];

function argValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function requireObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function requireString(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function requireSha(value, name) {
  const text = requireString(value, name);
  if (!SHA256.test(text)) {
    throw new Error(`${name} must be sha256`);
  }
  return text;
}

function parseTime(value, name) {
  const millis = Date.parse(requireString(value, name));
  if (!Number.isFinite(millis)) {
    throw new Error(`${name} must be ISO date-time`);
  }
  return millis;
}

function manifest(input, field) {
  const value = requireObject(input[field], field);
  return {
    url: requireString(value.url, `${field}.url`),
    sha256: requireSha(value.sha256, `${field}.sha256`),
  };
}

function correctedTables(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error("emergencyPatch.rows is required");
  }
  const tables = [...new Set(rows.map((row, index) => requireString(row?.table, `emergencyPatch.rows[${index}].table`)))].sort((left, right) =>
    left.localeCompare(right),
  );
  for (const table of REQUIRED_PATCH_TABLES) {
    if (!tables.includes(table)) {
      throw new Error(`emergencyPatch.rows must include ${table}`);
    }
  }
  return tables;
}

async function main() {
  const args = process.argv.slice(2);
  const inputPath = argValue(args, "--input");
  const outputPath = argValue(args, "--output");
  if (!inputPath || !outputPath) {
    throw new Error("--input and --output are required");
  }

  const input = JSON.parse(await readFile(inputPath, "utf8"));
  const previousKnownGoodManifest = manifest(input, "previousKnownGoodManifest");
  const badManifest = manifest(input, "badManifest");
  const fixedManifest = manifest(input, "fixedManifest");
  const rollback = requireObject(input.rollback, "rollback");
  const rollbackTimeSeconds = Math.round(
    (parseTime(rollback.completedAt, "rollback.completedAt") - parseTime(rollback.startedAt, "rollback.startedAt")) / 1000,
  );
  if (rollbackTimeSeconds < 0) {
    throw new Error("rollback.completedAt must be after rollback.startedAt");
  }

  const emergencyPatch = requireObject(input.emergencyPatch, "emergencyPatch");
  const routeRegressionReplay = requireObject(input.routeRegressionReplay, "routeRegressionReplay");
  if (routeRegressionReplay.before?.blocked !== true || routeRegressionReplay.after?.blocked !== false) {
    throw new Error("routeRegressionReplay must prove blocked before and unblocked after patch");
  }

  const command = requireString(routeRegressionReplay.command, "routeRegressionReplay.command");
  const commandOutput = JSON.stringify(routeRegressionReplay);
  const evidence = {
    schemaVersion: 1,
    artifactKind: "emergency-datapack-release-drill",
    channel: requireString(input.channel, "channel"),
    rollback: {
      previousKnownGoodManifestUrl: previousKnownGoodManifest.url,
      previousKnownGoodManifestSha256: previousKnownGoodManifest.sha256,
      badManifestUrl: badManifest.url,
      badManifestSha256: badManifest.sha256,
      rollbackTimeSeconds,
    },
    emergencyPatch: {
      auditId: requireString(emergencyPatch.auditId, "emergencyPatch.auditId"),
      correctedTables: correctedTables(emergencyPatch.rows),
      rowCount: emergencyPatch.rows.length,
    },
    fixedPromotion: {
      fixedManifestUrl: fixedManifest.url,
      fixedManifestSha256: fixedManifest.sha256,
    },
    routeRegressionReplay,
    verification: {
      command,
      commandOutputSha256: sha256(commandOutput),
    },
  };

  await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
