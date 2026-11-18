#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { lstat, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { codepointCompare } from "../lib/codepoint-compare.mjs";
import { sha256 } from "../lib/hash.mjs";

const SHA256 = /^[a-f0-9]{64}$/;
const REQUIRED_PATCH_TABLES = ["facilities", "network_edges", "transit_stop_times"];
const ALLOWED_CHANNELS = new Set(["production", "staging"]);
const ALLOWED_SCRIPT_PATH = /^tools\/(?:datapack|routes|route-map)\/[A-Za-z0-9._/-]+\.mjs$/;
const ALLOWED_SCRIPT_ARG = /^[A-Za-z0-9._:=/-]+$/;
const ALLOWED_INLINE_JSON_REPLAY = /^process\.stdout\.write\(JSON\.stringify\(\{[A-Za-z0-9_:"',[\]{}.-]+\}\)\)$/;
const FORBIDDEN_UNQUOTED_SHELL_CHARS = /[;|&<>()$`"\\*?[\]{}#!~]/;
const FORBIDDEN_QUOTED_CHARS = /["`$\\]/;

export function validateCliPath(rawPath, label) {
  const value = requireString(rawPath, label);
  if (value.includes("\0") || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error(`${label} contains control characters`);
  }
  if (value.startsWith("-")) {
    throw new Error(`${label} must not start with '-'`);
  }
  if (value.split(/[/\\]/).includes("..")) {
    throw new Error(`${label} must not contain parent directory traversal`);
  }
  return path.resolve(value);
}

async function rejectSymlinkIfPresent(resolvedPath, label) {
  try {
    const stat = await lstat(resolvedPath);
    if (stat.isSymbolicLink()) {
      throw new Error(`${label} must not be a symlink`);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function tokenizeReplayCommand(command) {
  const raw = requireString(command, "routeRegressionReplay.command");
  if (raw.includes("\0") || /[\x00-\x1f\x7f\r\n]/.test(raw)) {
    throw new Error("routeRegressionReplay.command contains control characters");
  }
  const tokens = [];
  let current = "";
  let inToken = false;
  let inSingleQuote = false;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (inSingleQuote) {
      if (ch === "'") {
        inSingleQuote = false;
      } else if (FORBIDDEN_QUOTED_CHARS.test(ch)) {
        throw new Error("routeRegressionReplay.command contains forbidden quoted characters");
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === "'") {
      inSingleQuote = true;
      inToken = true;
    } else if (ch === " " || ch === "\t") {
      if (inToken) {
        tokens.push(current);
        current = "";
        inToken = false;
      }
    } else if (FORBIDDEN_UNQUOTED_SHELL_CHARS.test(ch)) {
      throw new Error(`routeRegressionReplay.command contains forbidden shell character '${ch}'`);
    } else {
      current += ch;
      inToken = true;
    }
  }
  if (inSingleQuote) {
    throw new Error("routeRegressionReplay.command has unterminated single quote");
  }
  if (inToken) tokens.push(current);
  return tokens;
}

export function parseReplayCommand(command) {
  const tokens = tokenizeReplayCommand(command);
  if (tokens.length < 2 || tokens[0] !== "node") {
    throw new Error("routeRegressionReplay.command must invoke allowlisted node command");
  }
  const second = tokens[1];
  if (second === "-e") {
    if (tokens.length !== 3 || !ALLOWED_INLINE_JSON_REPLAY.test(tokens[2])) {
      throw new Error("routeRegressionReplay.command inline script is not allowlisted");
    }
    return { file: process.execPath, args: ["-e", tokens[2]] };
  }
  if (second.startsWith("-") || second.includes("//") || second.split("/").includes("..") || !ALLOWED_SCRIPT_PATH.test(second)) {
    throw new Error("routeRegressionReplay.command script path is not allowlisted");
  }
  for (const arg of tokens.slice(2)) {
    if (arg.split(/[/\\]/).includes("..") || !ALLOWED_SCRIPT_ARG.test(arg)) {
      throw new Error("routeRegressionReplay.command contains non-allowlisted argument");
    }
  }
  return { file: process.execPath, args: tokens.slice(1) };
}

function argValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
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

function requirePositiveInteger(value, name) {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function requirePass(value, name) {
  if (value !== "PASS") throw new Error(`${name} must be PASS`);
  return value;
}

function parseTime(value, name) {
  const millis = Date.parse(requireString(value, name));
  if (!Number.isFinite(millis)) {
    throw new TypeError(`${name} must be ISO date-time`);
  }
  return millis;
}

function requireHttpsUrl(value, name) {
  const raw = requireString(value, name);
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`${name} must use https protocol`);
  }
  return raw;
}

function manifest(input, field) {
  const value = requireObject(input[field], field);
  return {
    url: requireHttpsUrl(value.url, `${field}.url`),
    sha256: requireSha(value.sha256, `${field}.sha256`),
  };
}

function correctedTables(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error("emergencyPatch.rows is required");
  }
  const tables = [...new Set(rows.map((row, index) => requireString(row?.table, `emergencyPatch.rows[${index}].table`)))].sort(codepointCompare);
  for (const table of REQUIRED_PATCH_TABLES) {
    if (!tables.includes(table)) {
      throw new Error(`emergencyPatch.rows must include ${table}`);
    }
  }
  return tables;
}

export async function runEmergencyDatapackDrill({ inputPath: rawInputPath, outputPath: rawOutputPath }) {
  const inputPath = validateCliPath(rawInputPath, "--input");
  const outputPath = validateCliPath(rawOutputPath, "--output");
  if (inputPath === outputPath) {
    throw new Error("--input and --output must be distinct paths");
  }
  await rejectSymlinkIfPresent(inputPath, "--input");
  await rejectSymlinkIfPresent(outputPath, "--output");

  const input = JSON.parse(await readFile(inputPath, "utf8"));
  const channel = requireString(input.channel, "channel");
  if (!ALLOWED_CHANNELS.has(channel)) {
    throw new Error(`channel must be one of: ${[...ALLOWED_CHANNELS].join(", ")}`);
  }
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
  const currentReleaseSequence = requirePositiveInteger(rollback.currentReleaseSequence, "rollback.currentReleaseSequence");
  const failedReleaseSequence = requirePositiveInteger(rollback.failedReleaseSequence, "rollback.failedReleaseSequence");
  const knownGoodReleaseSequence = requirePositiveInteger(rollback.knownGoodReleaseSequence, "rollback.knownGoodReleaseSequence");
  const rescueReleaseSequence = requirePositiveInteger(rollback.rescueReleaseSequence, "rollback.rescueReleaseSequence");
  if (!(knownGoodReleaseSequence < failedReleaseSequence
    && failedReleaseSequence === currentReleaseSequence
    && currentReleaseSequence < rescueReleaseSequence)) {
    throw new Error("rollback sequences must satisfy knownGood < failed = current < rescue");
  }
  const rescueManifestSha256 = requireSha(rollback.rescueManifestSha256, "rollback.rescueManifestSha256");
  if (rescueManifestSha256 !== fixedManifest.sha256) {
    throw new Error("rollback rescueManifestSha256 must match fixedManifest.sha256");
  }

  const emergencyPatch = requireObject(input.emergencyPatch, "emergencyPatch");
  const routeRegressionReplay = requireObject(input.routeRegressionReplay, "routeRegressionReplay");
  if (routeRegressionReplay.before?.blocked !== true || routeRegressionReplay.after?.blocked !== false) {
    throw new Error("routeRegressionReplay must prove blocked before and unblocked after patch");
  }

  const command = requireString(routeRegressionReplay.command, "routeRegressionReplay.command");
  const parsedCommand = parseReplayCommand(command);
  const commandOutput = execFileSync(parsedCommand.file, parsedCommand.args, {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    timeout: 30_000,
    shell: false,
  });
  const evidence = {
    schemaVersion: 1,
    artifactKind: "emergency-datapack-release-drill",
    channel,
    rollback: {
      previousKnownGoodManifestUrl: previousKnownGoodManifest.url,
      previousKnownGoodManifestSha256: previousKnownGoodManifest.sha256,
      badManifestUrl: badManifest.url,
      badManifestSha256: badManifest.sha256,
      rollbackTimeSeconds,
      releaseSequences: {
        knownGood: knownGoodReleaseSequence,
        failed: failedReleaseSequence,
        current: currentReleaseSequence,
        rescue: rescueReleaseSequence,
      },
      rescueManifestSha256,
      manifestLastStatus: requirePass(rollback.manifestLastStatus, "rollback.manifestLastStatus"),
      idempotentReplayStatus: requirePass(rollback.idempotentReplayStatus, "rollback.idempotentReplayStatus"),
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
  return evidence;
}

async function main() {
  const args = process.argv.slice(2);
  const inputPath = argValue(args, "--input");
  const outputPath = argValue(args, "--output");
  if (!inputPath || !outputPath) {
    throw new Error("--input and --output are required");
  }
  await runEmergencyDatapackDrill({ inputPath, outputPath });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
