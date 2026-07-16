#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import path from "node:path";

const DOWNLOAD_TIMEOUT_MS = 30_000;

const args = parseArgs(process.argv.slice(2));
const manifestUrl = requireArg(args, "manifest-url");
const outputRoot = path.resolve(requireArg(args, "output"));
const requireProduction = args["require-production"] === true;
const expectedManifestPath = args["expected-manifest"];

await mkdir(path.join(outputRoot, "catalog"), { recursive: true });
const manifestPath = path.join(outputRoot, "catalog", "current.json");
const manifestBytes = await download(manifestUrl, { revalidate: true });
if (expectedManifestPath) {
  const expectedManifestBytes = await readFile(path.resolve(expectedManifestPath));
  if (sha256(manifestBytes) !== sha256(expectedManifestBytes)) {
    throw new Error("remote production manifest does not match the selected RC manifest");
  }
}
await writeFile(manifestPath, manifestBytes);

const manifest = JSON.parse(manifestBytes.toString("utf8"));
const downloadedPacks = [];
for (const pack of manifest.packs ?? []) {
  const packUrl = /^https?:\/\//.test(pack.url)
    ? pack.url
    : new URL(pack.url, new URL("/", manifestUrl)).toString();
  const packPath = path.join(outputRoot, "catalog", `${pack.id}-v${pack.version}.sqlite.gz`);
  const packBytes = await download(packUrl);
  await writeFile(packPath, packBytes);
  downloadedPacks.push(summarizeDownloadedPack({ pack, packUrl, packBytes }));
}

const validation = await runValidator({ manifestPath, outputRoot, requireProduction });
const summary = {
  manifestUrl,
  manifestSha256: sha256(manifestBytes),
  manifestVersion: manifest.manifestVersion ?? 1,
  channel: manifest.channel,
  releaseSequence: manifest.releaseSequence,
  publishedAt: manifest.publishedAt,
  expiresAt: manifest.expiresAt,
  rollbackProvenance: manifest.rollbackProvenance,
  packs: (manifest.packs ?? []).map((pack) => ({
    id: pack.id,
    version: pack.version,
    artifactKind: pack.artifactKind,
    url: pack.url,
    sha256: pack.sha256,
    sqliteSha256: pack.sqliteSha256,
    sizeBytes: pack.sizeBytes,
    download: downloadedPacks.find(
      (downloadedPack) => downloadedPack.id === pack.id && downloadedPack.version === pack.version,
    ),
    regionalQualityMetrics: pack.regionalQualityMetrics,
  })),
  validation,
};
await writeFile(
  path.join(outputRoot, "remote-datapack-validation-summary.json"),
  `${JSON.stringify(summary, null, 2)}\n`,
);

if (validation.signal) {
  process.stderr.write(validation.stderr || validation.stdout);
  process.stderr.write(`validator terminated by signal ${validation.signal}\n`);
  process.exit(1);
}

if (validation.exitCode !== 0) {
  process.stderr.write(validation.stderr || validation.stdout);
  process.exit(validation.exitCode);
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) {
      throw new Error(`invalid argument: ${value}`);
    }
    const key = value.slice(2);
    if (key === "require-production") {
      parsed[key] = true;
      continue;
    }
    parsed[key] = values[++index];
  }
  return parsed;
}

function requireArg(parsed, name) {
  const value = parsed[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`missing required argument: --${name}`);
  }
  return value;
}

function summarizeDownloadedPack({ pack, packUrl, packBytes }) {
  const compressedSha256 = sha256(packBytes);
  const summary = {
    id: pack.id,
    version: pack.version,
    resolvedUrl: packUrl,
    sizeBytes: packBytes.length,
    sha256: compressedSha256,
    sizeBytesMatchesManifest: packBytes.length === pack.sizeBytes,
    sha256MatchesManifest: compressedSha256 === pack.sha256,
  };
  try {
    const sqliteBytes = gunzipSync(packBytes);
    const sqliteSha256 = sha256(sqliteBytes);
    summary.sqliteSha256 = sqliteSha256;
    summary.sqliteSha256MatchesManifest = sqliteSha256 === pack.sqliteSha256;
  } catch (error) {
    summary.sqliteSha256MatchesManifest = false;
    summary.sqliteDecompressionError = error.message;
  }
  return summary;
}

async function download(url, { revalidate = false } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(url, {
      signal: controller.signal,
      headers: revalidate
        ? { "cache-control": "no-cache", pragma: "no-cache" }
        : undefined,
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`download timed out after ${DOWNLOAD_TIMEOUT_MS}ms: ${url}`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    throw new Error(`download failed: ${url} ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

async function runValidator({ manifestPath, outputRoot, requireProduction }) {
  const args = [
    "tools/datapack/validate-datapack.mjs",
    "--manifest",
    manifestPath,
    "--root",
    outputRoot,
  ];
  if (requireProduction) {
    args.push("--require-production");
  }
  const result = await spawnResult(process.execPath, args);
  return {
    command: `${process.execPath} ${args.join(" ")}`,
    exitCode: result.exitCode,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function spawnResult(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: path.resolve(import.meta.dirname, "../..") });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (exitCode, signal) => {
      resolve({
        exitCode,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
