#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { isMainModule } from "../lib/is-main-module.mjs";
import {
  parseSharedStrings,
  parseWorkbookSheetRefs,
  parseWorksheetRows,
} from "./parse-kric-code-catalog.mjs";

export const KORAIL_FACILITY_WORKBOOK_URL =
  "https://info.korail.com/info/downloadInfoRelFile.do?infoRelAtchNo=2473";

const execFileAsync = promisify(execFile);
const MAXIMUM_WORKBOOK_BYTES = 50 * 1024 * 1024;
const ALLOWED_CONTENT_TYPES = new Set([
  "application/octet-stream",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/x-msdownload",
]);

export async function summarizeKorailWorkbook(readEntry, maximumBytes = MAXIMUM_WORKBOOK_BYTES) {
  if (!Number.isInteger(maximumBytes) || maximumBytes < 1) throw new Error("workbook XML byte limit is invalid");
  let byteCount = 0;
  const read = async (entry, optional = false) => {
    const remainingBytes = maximumBytes - byteCount;
    if (remainingBytes < 1) throw new Error("Korail XLSX aggregate XML exceeds byte limit");
    const value = await readEntry(entry, optional, remainingBytes);
    byteCount += Buffer.byteLength(value);
    if (byteCount > maximumBytes) throw new Error("Korail XLSX aggregate XML exceeds byte limit");
    return value;
  };

  const workbookXml = await read("xl/workbook.xml");
  const relationshipsXml = await read("xl/_rels/workbook.xml.rels");
  const sharedStrings = parseSharedStrings(await read("xl/sharedStrings.xml", true));
  const sheets = [];
  for (const sheet of parseWorkbookSheetRefs(workbookXml, relationshipsXml)) {
    const rows = parseWorksheetRows(await read(sheet.entry), sharedStrings);
    const nonEmptyRows = rows.filter((row) => row.some((value) => value !== ""));
    sheets.push({
      name: sheet.name,
      leadingRows: nonEmptyRows.slice(0, 10),
      rowCount: nonEmptyRows.length,
    });
  }
  if (sheets.every(({ rowCount }) => rowCount === 0)) {
    throw new Error("Korail XLSX workbook contains no non-empty rows");
  }
  return { sheets };
}

export async function inspectKorailWorkbook(input) {
  return summarizeKorailWorkbook((entry, optional, maximumBytes) =>
    unzipEntry(input, entry, optional, maximumBytes));
}

export async function readBoundedResponseBody(response, maximumBytes) {
  if (!Number.isInteger(maximumBytes) || maximumBytes < 1) throw new Error("workbook byte limit is invalid");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Korail FACILITY workbook body is missing");
  const chunks = [];
  let byteCount = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteCount += value.byteLength;
      if (byteCount > maximumBytes) {
        await reader.cancel().catch(() => {});
        throw new Error("Korail FACILITY workbook exceeds byte limit");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, byteCount);
}

export async function probeKorailFacilityWorkbook({
  capturedAt = new Date().toISOString(),
  fetchImpl = fetch,
  inspectWorkbookImpl = inspectKorailWorkbook,
  output,
  tempRoot,
} = {}) {
  if (!path.isAbsolute(output ?? "")) throw new Error("--output must be an absolute path");
  if (!path.isAbsolute(tempRoot ?? "")) throw new Error("RUNNER_TEMP must be an absolute path");
  if (new Date(capturedAt).toISOString() !== capturedAt) throw new Error("capturedAt must be an ISO instant");
  await rm(output, { force: true });

  const response = await fetchImpl(KORAIL_FACILITY_WORKBOOK_URL, {
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Korail FACILITY workbook HTTP ${response.status}`);
  if (response.url !== KORAIL_FACILITY_WORKBOOK_URL) {
    throw new Error("Korail FACILITY workbook final URL is not allowlisted");
  }
  const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() ?? "";
  if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
    throw new Error("Korail FACILITY workbook content type is not XLSX-compatible");
  }
  const contentLengthHeader = response.headers.get("content-length");
  if (contentLengthHeader != null) {
    const contentLength = Number(contentLengthHeader);
    if (!Number.isInteger(contentLength) || contentLength < 0) {
      throw new Error("Korail FACILITY workbook content length is invalid");
    }
    if (contentLength > MAXIMUM_WORKBOOK_BYTES) {
      throw new Error("Korail FACILITY workbook exceeds byte limit");
    }
  }
  const bytes = await readBoundedResponseBody(response, MAXIMUM_WORKBOOK_BYTES);
  if (bytes.length === 0) {
    throw new Error("Korail FACILITY workbook byte count is invalid");
  }
  if (!bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
    throw new Error("Korail FACILITY workbook XLSX signature is invalid");
  }

  const directory = await mkdtemp(path.join(tempRoot, "korail-facility-xlsx-"));
  try {
    const input = path.join(directory, "source.xlsx");
    await writeFile(input, bytes, { mode: 0o600 });
    const workbook = await inspectWorkbookImpl(input);
    const evidence = {
      schemaVersion: 1,
      artifactKind: "korail-facility-workbook-probe-evidence",
      sourceId: "korail-facility-workbook-2473",
      sourceUrl: KORAIL_FACILITY_WORKBOOK_URL,
      capturedAt,
      contentType,
      rawSha256: createHash("sha256").update(bytes).digest("hex"),
      byteCount: bytes.length,
      sheets: workbook.sheets,
    };
    await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
    return evidence;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function unzipEntry(input, entry, optional = false, maximumBytes = MAXIMUM_WORKBOOK_BYTES) {
  try {
    const { stdout } = await execFileAsync("unzip", ["-p", input, entry], { maxBuffer: maximumBytes });
    return stdout;
  } catch (error) {
    if (error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
      throw new Error("Korail XLSX aggregate XML exceeds byte limit");
    }
    if (optional && error?.code === 11) return "";
    throw new Error(`Korail XLSX archive entry unavailable: ${entry}`);
  }
}

function parseArgs(argv) {
  if (argv.length !== 2 || argv[0] !== "--output" || !path.isAbsolute(argv[1] ?? "")) {
    throw new Error("usage: probe-korail-facility-workbook.mjs --output <absolute.json>");
  }
  return { output: argv[1] };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const evidence = await probeKorailFacilityWorkbook({
    output: args.output,
    tempRoot: process.env.RUNNER_TEMP,
  });
  console.log(`sanitized Korail FACILITY workbook evidence ready: sheets=${evidence.sheets.length}`);
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Korail FACILITY workbook probe failed");
    process.exitCode = 1;
  });
}
