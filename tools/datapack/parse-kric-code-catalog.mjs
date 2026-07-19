#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);
const MAXIMUM_SHEETS = 10;
const MAXIMUM_ROWS = 20_000;
const MAXIMUM_COLUMNS = 100;
const MAXIMUM_CELL_LENGTH = 2_048;

export function parseWorkbookSheetRefs(workbookXml, relationshipsXml) {
  const relationships = new Map();
  for (const match of relationshipsXml.matchAll(/<Relationship\b([^>]*)>/gi)) {
    const attributes = xmlAttributes(match[1]);
    if (attributes.Id && attributes.Target) relationships.set(attributes.Id, attributes.Target);
  }
  const sheets = [];
  for (const match of workbookXml.matchAll(/<sheet\b([^>]*)>/gi)) {
    const attributes = xmlAttributes(match[1]);
    const relationshipId = attributes["r:id"];
    const target = relationships.get(relationshipId);
    if (!attributes.name || !target || !/^worksheets\/sheet\d+\.xml$/.test(target)) {
      throw new Error("KRIC XLSX worksheet target is invalid");
    }
    sheets.push({ name: boundedText(attributes.name, "sheet name"), entry: `xl/${target}` });
  }
  if (sheets.length === 0 || sheets.length > MAXIMUM_SHEETS) throw new Error("KRIC XLSX sheet count is invalid");
  return sheets;
}

export function parseSharedStrings(xml) {
  if (!xml) return [];
  const strings = [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/gi)].map(([, item]) => {
    const parts = [...item.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/gi)].map(([, value]) => decodeXml(value));
    return boundedText(parts.join(""), "shared string");
  });
  if (strings.length > 200_000) throw new Error("KRIC XLSX shared string limit exceeded");
  return strings;
}

export function parseWorksheetRows(xml, sharedStrings) {
  const rows = [];
  for (const rowMatch of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/gi)) {
    if (rows.length >= MAXIMUM_ROWS) throw new Error("KRIC XLSX row limit exceeded");
    const row = [];
    for (const cellMatch of rowMatch[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/gi)) {
      const attributes = xmlAttributes(cellMatch[1]);
      const column = columnIndex(attributes.r);
      if (column >= MAXIMUM_COLUMNS) throw new Error("KRIC XLSX column limit exceeded");
      row[column] = boundedText(worksheetCellValue(attributes, cellMatch[2], sharedStrings), "cell");
    }
    while (row.length > 0 && row.at(-1) === undefined) row.pop();
    rows.push(Array.from({ length: row.length }, (_, index) => row[index] ?? ""));
  }
  return rows;
}

function worksheetCellValue(attributes, body, sharedStrings) {
  if (attributes.t === "inlineStr") {
    return [...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/gi)]
      .map(([, text]) => decodeXml(text))
      .join("");
  }
  const raw = /<v\b[^>]*>([\s\S]*?)<\/v>/i.exec(body)?.[1] ?? "";
  if (attributes.t !== "s") return decodeXml(raw);
  const normalizedIndex = raw.trim();
  const index = Number(normalizedIndex);
  if (!/^\d+$/.test(normalizedIndex) || !Number.isInteger(index) || index < 0 || index >= sharedStrings.length) {
    throw new Error("KRIC XLSX shared string index is invalid");
  }
  return sharedStrings[index];
}

export function buildProviderLineCatalog({ sourceId, sourceSha256, capturedAt, sheets }) {
  const expectedHeader = ["RAIL_OPR_ISTT_CD", "RAIL_OPR_ISTT_NM", "LN_CD", "LN_NM", "STIN_CD", "STIN_NM"];
  const sheet = sheets?.find(({ name }) => name === "Sheet1");
  if (!sheet || JSON.stringify(sheet.rows?.[0]) !== JSON.stringify(expectedHeader)) {
    throw new Error("KRIC provider code catalog header is invalid");
  }
  if (sheet.rows.length < 2) {
    throw new Error("KRIC provider code catalog contains no station rows");
  }
  const providerLines = new Map();
  for (const [index, row] of sheet.rows.slice(1).entries()) {
    if (!Array.isArray(row) || row.length !== expectedHeader.length || row.some((value) => typeof value !== "string" || !value.trim())) {
      throw new Error(`KRIC provider code catalog row ${index + 2} is invalid`);
    }
    const record = { railOprIsttCd: row[0], operatorName: row[1], lnCd: row[2], lineName: row[3] };
    const key = `${record.railOprIsttCd}:${record.lnCd}`;
    const existing = providerLines.get(key);
    if (existing && JSON.stringify(existing) !== JSON.stringify(record)) {
      throw new Error(`KRIC provider line conflict: ${key}`);
    }
    providerLines.set(key, record);
  }
  return {
    schemaVersion: 1,
    artifactKind: "kric-provider-line-catalog",
    sourceId,
    sourceSha256,
    capturedAt,
    stationRecordCount: sheet.rows.length - 1,
    providerLines: [...providerLines.values()].sort((left, right) =>
      `${left.railOprIsttCd}:${left.lnCd}`.localeCompare(`${right.railOprIsttCd}:${right.lnCd}`),
    ),
  };
}

function xmlAttributes(raw) {
  return Object.fromEntries([...raw.matchAll(/(?:^|[ \t\r\n])([:\w-]+)[ \t\r\n]*=[ \t\r\n]*"([^"]*)"/g)]
    .map(([, name, value]) => [name, decodeXml(value)]));
}

function columnIndex(reference) {
  const letters = /^([A-Z]{1,3})\d+$/i.exec(reference ?? "")?.[1]?.toUpperCase();
  if (!letters) throw new Error("KRIC XLSX cell reference is invalid");
  let value = 0;
  for (const letter of letters) value = value * 26 + letter.codePointAt(0) - 64;
  return value - 1;
}

function boundedText(value, label) {
  const normalized = String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, " ");
  if (normalized.length > MAXIMUM_CELL_LENGTH) throw new Error(`KRIC XLSX ${label} limit exceeded`);
  return normalized;
}

function decodeXml(value) {
  return String(value).replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'").replaceAll("&amp;", "&");
}

async function unzipEntry(input, entry, optional = false) {
  try {
    const { stdout } = await execFileAsync("unzip", ["-p", input, entry], { maxBuffer: 50 * 1024 * 1024 });
    return stdout;
  } catch (error) {
    if (optional && error?.code === 11) return "";
    throw new Error(`KRIC XLSX archive entry unavailable: ${entry}`);
  }
}

function parseArgs(argv) {
  if (argv.length !== 6 || argv[0] !== "--input" || argv[2] !== "--metadata" || argv[4] !== "--output") {
    throw new Error("usage: parse-kric-code-catalog.mjs --input <absolute.xlsx> --metadata <absolute.json> --output <absolute.json>");
  }
  const args = { input: argv[1], metadata: argv[3], output: argv[5] };
  if (Object.values(args).some((value) => !path.isAbsolute(value))) throw new Error("paths must be absolute");
  return args;
}

async function main(argv) {
  const args = parseArgs(argv);
  const bytes = await readFile(args.input);
  const metadata = JSON.parse(await readFile(args.metadata, "utf8"));
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (metadata.artifactKind !== "kric-provider-code-catalog-download" || metadata.sha256 !== sha256
    || metadata.byteCount !== bytes.length) {
    throw new Error("KRIC code catalog metadata does not match input");
  }
  const workbookXml = await unzipEntry(args.input, "xl/workbook.xml");
  const relationshipsXml = await unzipEntry(args.input, "xl/_rels/workbook.xml.rels");
  const sharedStrings = parseSharedStrings(await unzipEntry(args.input, "xl/sharedStrings.xml", true));
  const sheetRefs = parseWorkbookSheetRefs(workbookXml, relationshipsXml);
  const sheets = [];
  for (const sheet of sheetRefs) {
    sheets.push({
      name: sheet.name,
      rows: parseWorksheetRows(await unzipEntry(args.input, sheet.entry), sharedStrings),
    });
  }
  if (sheets.every((sheet) => sheet.rows.length === 0)) {
    throw new Error("KRIC XLSX workbook contains no rows");
  }
  const output = buildProviderLineCatalog({
    sourceId: metadata.sourceId,
    sourceSha256: sha256,
    capturedAt: metadata.capturedAt,
    sheets,
  });
  await writeFile(args.output, `${JSON.stringify(output, null, 2)}\n`, { mode: 0o600 });
  console.log(`sanitized KRIC code catalog parsed: sheets=${sheets.length} rows=${sheets.reduce((sum, sheet) => sum + sheet.rows.length, 0)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "KRIC code catalog parse failed");
    process.exitCode = 1;
  }
}
