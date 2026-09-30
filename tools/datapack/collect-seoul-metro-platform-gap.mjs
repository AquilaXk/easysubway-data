#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJson } from "./lib/manifest-validation.mjs";

const DEFAULT_ENDPOINT = "http://openapi.seoul.go.kr:8088/{serviceKey}/json/TbSubwayLineInfo";
const PAGE_SIZE = 1000;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalUtc(value, label) {
  if (typeof value !== "string" || !ISO_INSTANT.test(value) || isNaN(Date.parse(value))) {
    throw new Error(`${label} must be a canonical UTC instant`);
  }
  return new Date(value).toISOString();
}

export async function fetchSeoulPlatformGapPage({
  serviceKey,
  start = 1,
  end = 1000,
  fetchImpl = fetch,
  endpoint = DEFAULT_ENDPOINT,
} = {}) {
  if (!serviceKey) throw new Error("serviceKey is required");
  const url = `${endpoint.replace("{serviceKey}", encodeURIComponent(serviceKey))}/${start}/${end}/`;
  const response = await fetchImpl(url, {
    signal: AbortSignal.timeout(30_000),
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw new Error(`Seoul open data API HTTP ${response.status}`);
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new Error("Seoul open data API invalid JSON response", { cause: error });
  }
  const root = json?.TbSubwayLineInfo;
  const resultCode = root?.RESULT?.CODE;
  if (resultCode !== "INFO-000") {
    throw new Error(`Seoul open data API error: ${resultCode} - ${root?.RESULT?.MESSAGE ?? ""}`);
  }
  const totalCount = root?.list_total_count ?? 0;
  const rows = root?.row ?? [];
  return {
    totalCount,
    rows,
    rawText: text,
  };
}

export async function collectSeoulPlatformGap({
  serviceKey,
  capturedAt = new Date().toISOString(),
  fetchImpl = fetch,
  endpoint = DEFAULT_ENDPOINT,
  limit = null,
} = {}) {
  const instant = canonicalUtc(capturedAt, "capturedAt");
  const firstPage = await fetchSeoulPlatformGapPage({
    serviceKey,
    start: 1,
    end: Math.min(PAGE_SIZE, limit ?? PAGE_SIZE),
    fetchImpl,
    endpoint,
  });

  const totalCount = limit !== null ? Math.min(limit, firstPage.totalCount) : firstPage.totalCount;
  const allRows = [...firstPage.rows];
  const rawPages = [{ start: 1, end: firstPage.rows.length, rawText: firstPage.rawText }];

  let currentStart = PAGE_SIZE + 1;
  while (currentStart <= totalCount) {
    const currentEnd = Math.min(currentStart + PAGE_SIZE - 1, totalCount);
    const page = await fetchSeoulPlatformGapPage({
      serviceKey,
      start: currentStart,
      end: currentEnd,
      fetchImpl,
      endpoint,
    });
    allRows.push(...page.rows);
    rawPages.push({ start: currentStart, end: currentEnd, rawText: page.rawText });
    currentStart += PAGE_SIZE;
  }

  // Key-redacted raw archive
  const sanitizedRawPages = rawPages.map((page) => ({
    start: page.start,
    end: page.end,
    sanitizedJson: JSON.parse(page.rawText),
  }));
  const rawBytes = Buffer.from(canonicalJson({
    endpoint: endpoint.replace("{serviceKey}", "[REDACTED]"),
    capturedAt: instant,
    pages: sanitizedRawPages,
  }), "utf8");

  const snapshotTimestamp = instant.replace(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "Z");
  const snapshotId = `seoul-metro-platform-gap-${snapshotTimestamp}`;

  const snapshot = {
    schemaVersion: 1,
    artifactKind: "seoul-platform-gap-snapshot",
    sourceId: "seoul-metro-platform-gap",
    snapshotId,
    capturedAt: instant,
    rowCount: allRows.length,
    rawSha256: sha256(rawBytes),
    contentSha256: sha256(canonicalJson(allRows)),
    rows: allRows,
  };

  return {
    snapshot,
    rawBytes,
    snapshotId,
  };
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const val = argv[i + 1];
    if (flag && flag.startsWith("--")) {
      args[flag.slice(2)] = val;
    }
  }
  return args;
}

async function main(argv) {
  const args = parseArgs(argv);
  const key = args.key ?? process.env.SEOUL_OPENAPI_KEY;
  if (!key) throw new Error("SEOUL_OPENAPI_KEY is required (--key or env)");
  const capturedAt = args["captured-at"] ?? new Date().toISOString();
  const limit = args.limit ? parseInt(args.limit, 10) : null;

  console.log(`Collecting Seoul Metro platform gap data (limit=${limit ?? "ALL"})...`);
  const { snapshot, rawBytes, snapshotId } = await collectSeoulPlatformGap({
    serviceKey: key,
    capturedAt,
    limit,
  });

  const outputDir = path.resolve("tools/datapack/sources");
  await mkdir(outputDir, { recursive: true });

  const snapshotPath = args.output
    ? path.resolve(args.output)
    : path.join(outputDir, `${snapshotId}.json`);
  const rawPath = args["raw-output"]
    ? path.resolve(args["raw-output"])
    : path.join(outputDir, `${snapshotId}.raw.json`);

  await writeFile(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  await writeFile(rawPath, rawBytes);

  console.log(`Saved snapshot: ${snapshotPath} (${snapshot.rowCount} rows)`);
  console.log(`Saved raw archive: ${rawPath}`);
  console.log(`rawSha256: ${snapshot.rawSha256}`);
  console.log(`contentSha256: ${snapshot.contentSha256}`);
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isDirectRun) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
