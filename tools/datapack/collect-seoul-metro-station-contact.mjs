#!/usr/bin/env node
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readResponseBytesWithLimit } from "./lib/bounded-zlib.mjs";
import { canonicalJson } from "./lib/manifest-validation.mjs";
import { withSourceCollectionRetry } from "./lib/source-collection-retry.mjs";
import { writeFileReplacing } from "./lib/staged-output.mjs";
import { unwrapTransientRetryFailure } from "./lib/transient-retry.mjs";
import { sha256 } from "../lib/hash.mjs";

const DEFAULT_ENDPOINT = "https://datafile.seoul.go.kr/bigfile/iot/inf/nio_download.do?&useCache=false";
const DEFAULT_INF_ID = "OA-12035";
const DEFAULT_SEQ = "11";
const DEFAULT_INF_SEQ = "1";
const MAX_RAW_BYTES = 8 * 1024 * 1024;
const EXPECTED_HEADER = Object.freeze(["연번", "역번호", "호선", "역명", "역전화번호", "도로명주소", "지번주소"]);
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

function canonicalUtc(value, label) {
  if (typeof value !== "string" || !ISO_INSTANT.test(value) || Number.isNaN(Date.parse(value))) {
    throw new Error(`${label} must be a canonical UTC instant`);
  }
  return new Date(value).toISOString();
}

export function parseCsvLine(line) {
  const fields = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "\"") {
      if (inQuotes && line[i + 1] === "\"") {
        current += "\"";
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      fields.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current);
  if (inQuotes) {
    throw new Error("CSV line has unterminated quoted field");
  }
  return fields;
}

export function parseSeoulMetroStationContactCsv(csvText) {
  const normalized = String(csvText ?? "").replace(/^\uFEFF/u, "");
  const lines = normalized.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) {
    throw new Error("CSV has insufficient lines");
  }

  const header = parseCsvLine(lines[0]).map((col) => col.trim());
  if (header.length !== EXPECTED_HEADER.length || !EXPECTED_HEADER.every((col, idx) => header[idx] === col)) {
    throw new Error(`CSV header mismatch: got [${header.join(", ")}]`);
  }

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const fields = parseCsvLine(lines[i]);
    if (fields.length !== EXPECTED_HEADER.length) {
      throw new Error(`CSV row ${i} column count mismatch: expected ${EXPECTED_HEADER.length}, got ${fields.length}`);
    }
    const [seq, stnNo, line, name, phone, roadAddr, jibunAddr] = fields;
    if (name.trim() === "" || line.trim() === "") {
      throw new Error(`CSV row ${i} is missing required station name or line`);
    }
    rows.push({
      seq: seq?.trim() ?? "",
      stnNo: stnNo?.trim() ?? "",
      line: line?.trim() ?? "",
      name: name?.trim() ?? "",
      phone: phone?.trim() ?? "",
      roadAddr: roadAddr?.trim() ?? "",
      jibunAddr: jibunAddr?.trim() ?? "",
    });
  }
  if (rows.length === 0) {
    throw new Error("CSV has no data rows");
  }
  return rows;
}

export async function fetchSeoulMetroStationContactFile({
  endpoint = DEFAULT_ENDPOINT,
  infId = DEFAULT_INF_ID,
  seq = DEFAULT_SEQ,
  infSeq = DEFAULT_INF_SEQ,
  fetchImpl = fetch,
  sleepImpl,
  retryBudget,
  randomImpl,
  retryOptions = {},
} = {}) {
  const form = new URLSearchParams({ infId, seq, infSeq });
  const { response, rawBuffer } = await withSourceCollectionRetry(async () => {
    const res = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return { response: res, rawBuffer: null };
    const bytes = await readResponseBytesWithLimit(res, {
      maxBytes: MAX_RAW_BYTES,
      label: "Seoul Metro station contact CSV",
    });
    return { response: res, rawBuffer: bytes };
  }, {
    label: "Seoul Metro station contact file download",
    url: endpoint,
    sleep: sleepImpl ?? retryOptions.sleep,
    budget: retryBudget ?? retryOptions.budget,
    random: randomImpl ?? retryOptions.random,
  }).catch((error) => {
    throw unwrapTransientRetryFailure(error);
  });

  if (!response.ok) {
    throw new Error(`Seoul data file download failed: HTTP ${response.status}`);
  }
  if (!rawBuffer || rawBuffer.length === 0) {
    throw new Error("Seoul Metro station contact CSV response is empty");
  }

  // Server returns EUC-KR (CP949) encoded CSV
  const decoder = new TextDecoder("euc-kr", { fatal: true });
  const text = decoder.decode(rawBuffer);

  return {
    rawBuffer,
    decodedText: text,
  };
}

export async function collectSeoulStationContact({
  capturedAt = new Date().toISOString(),
  endpoint = DEFAULT_ENDPOINT,
  infId = DEFAULT_INF_ID,
  seq = DEFAULT_SEQ,
  infSeq = DEFAULT_INF_SEQ,
  fetchImpl = fetch,
  sleepImpl,
  retryBudget,
  randomImpl,
  retryOptions = {},
} = {}) {
  const instant = canonicalUtc(capturedAt, "capturedAt");
  const { rawBuffer, decodedText } = await fetchSeoulMetroStationContactFile({
    endpoint,
    infId,
    seq,
    infSeq,
    fetchImpl,
    sleepImpl,
    retryBudget,
    randomImpl,
    retryOptions,
  });

  const rows = parseSeoulMetroStationContactCsv(decodedText);

  // Key-redacted / structured raw archive
  const rawBytes = rawBuffer;

  const snapshotTimestamp = instant.replace(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "Z");
  const snapshotId = `seoul-metro-station-contact-${snapshotTimestamp}`;

  const snapshot = {
    schemaVersion: 1,
    artifactKind: "seoul-station-contact-snapshot",
    sourceId: "seoul-metro-station-contact",
    snapshotId,
    capturedAt: instant,
    rowCount: rows.length,
    rawSha256: sha256(rawBytes),
    contentSha256: sha256(canonicalJson(rows)),
    rows,
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
  const capturedAt = args["captured-at"] ?? new Date().toISOString();

  console.log("Collecting Seoul Metro station contact data...");
  const { snapshot, rawBytes, snapshotId } = await collectSeoulStationContact({
    capturedAt,
  });

  const outputDir = path.resolve("tools/datapack/sources");
  await mkdir(outputDir, { recursive: true });

  const snapshotPath = args.output
    ? path.resolve(args.output)
    : path.join(outputDir, `${snapshotId}.json`);
  const rawPath = args["raw-output"]
    ? path.resolve(args["raw-output"])
    : path.join(outputDir, `${snapshotId}.raw.json`);

  await writeFileReplacing(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  await writeFileReplacing(rawPath, rawBytes);

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
