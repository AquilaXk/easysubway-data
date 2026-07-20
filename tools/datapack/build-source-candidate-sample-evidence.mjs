import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { codepointCompare } from "../lib/codepoint-compare.mjs";

function parseArgs(argv) {
  const args = { candidates: "tools/datapack/source-candidates.json" };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag.startsWith("--")) {
      throw new Error(`unexpected argument: ${flag}`);
    }
    if (!value || value.startsWith("--")) {
      throw new Error(`${flag} requires a value`);
    }
    args[flag.slice(2)] = value;
    index += 1;
  }
  if (!args.candidate) {
    throw new Error("--candidate is required");
  }
  if (!args.response) {
    throw new Error("--response is required");
  }
  return args;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function assertNoServiceKey(value) {
  if (
    /serviceKey=(?!\[서비스키값\])[^&\s<"]+/i.test(value) ||
    /swopenapi\.seoul\.go\.kr\/api\/subway\/(?!\[서비스키값\]\/)(?!\{serviceKey\}\/)[^/\s<"]+\/json\//i.test(value) ||
    /"serviceKey"\s*:\s*"(?!\[서비스키값\]")[^"]+"/i.test(value) ||
    /<serviceKey\b[^>]*>\s*(?!\[서비스키값\]\s*<\/serviceKey>)[\s\S]*?<\/serviceKey>/i.test(value)
  ) {
    throw new Error("raw sample response must not contain serviceKey credentials");
  }
}

function scalarFieldCount(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return 0;
  }
  return Object.values(value).filter((item) => item == null || typeof item !== "object").length;
}

function bestJsonRow(value, best = { row: null, count: 0 }) {
  if (Array.isArray(value)) {
    for (const item of value) {
      bestJsonRow(item, best);
    }
    return best;
  }
  if (!value || typeof value !== "object") {
    return best;
  }

  const count = scalarFieldCount(value);
  if (count > best.count) {
    best.row = value;
    best.count = count;
  }
  for (const item of Object.values(value)) {
    bestJsonRow(item, best);
  }
  return best;
}

function itemRows(value) {
  if (Array.isArray(value)) {
    const objectRows = value.filter((item) => item && typeof item === "object" && !Array.isArray(item));
    if (objectRows.some((item) => scalarFieldCount(item) > 0)) {
      return objectRows;
    }
    return value.flatMap(itemRows);
  }
  if (!value || typeof value !== "object") {
    return [];
  }
  if (Object.hasOwn(value, "item")) {
    return Array.isArray(value.item)
      ? value.item.filter((item) => item && typeof item === "object")
      : value.item && typeof value.item === "object" ? [value.item] : [];
  }
  return Object.values(value).flatMap(itemRows);
}

function fieldsFromRows(rows, format) {
  const fields = new Set();
  for (const row of rows) {
    for (const [key, value] of Object.entries(row)) {
      if (value == null || typeof value !== "object") {
        fields.add(key);
      }
    }
  }
  if (fields.size === 0) {
    throw new Error(`${format} response has no object fields`);
  }
  return [...fields].sort();
}

function jsonRows(raw) {
  const parsed = JSON.parse(raw);
  const rows = itemRows(parsed);
  if (rows.length > 0) {
    return rows.map(sortJson);
  }

  const row = bestJsonRow(parsed).row;
  if (!row) {
    throw new Error("JSON response has no object fields");
  }
  return [sortJson(row)];
}

function fieldsFromJson(raw) {
  return fieldsFromRows(jsonRows(raw), "JSON");
}

function xmlRows(raw) {
  const items = [...raw.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)].map((match) => match[1]);
  const fragments = items.length > 0 ? items : [raw];
  return fragments.map((fragment) => {
    const row = {};
    const selfClosingTagPattern = /<([A-Za-z_][\w.-]*)\b[^>]*\/>/g;
    for (const match of fragment.matchAll(selfClosingTagPattern)) {
      row[match[1]] = null;
    }
    const tagPattern = /<([A-Za-z_][\w.-]*)\b[^>]*>([\s\S]*?)<\/\1>/g;
    for (const match of fragment.matchAll(tagPattern)) {
      const [, tagName, body] = match;
      if (!/<[A-Za-z_][\w.-]*\b/.test(body)) {
        row[tagName] = body.trim();
      }
    }
    return sortJson(row);
  }).filter((row) => Object.keys(row).length > 0);
}

function fieldsFromXml(raw) {
  const fields = fieldsFromRows(xmlRows(raw), "XML");
  if (fields.length === 0) {
    throw new Error("XML response has no leaf fields");
  }
  return fields;
}

function detectFormat(raw, explicitFormat) {
  if (explicitFormat) {
    return explicitFormat.toLowerCase();
  }
  const trimmed = raw.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return "json";
  }
  if (trimmed.startsWith("<")) {
    return "xml";
  }
  throw new Error("response format must be json or xml");
}

function rowsFromRaw(raw, format) {
  return format === "json" ? jsonRows(raw) : xmlRows(raw);
}

function sortJson(value) {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => codepointCompare(left, right))
      .map(([key, entry]) => [key, sortJson(entry)]),
  );
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const candidates = await readJson(path.resolve(args.candidates));
  const candidate = candidates.candidates.find(({ id }) => id === args.candidate);
  if (!candidate) {
    throw new Error(`unknown source candidate: ${args.candidate}`);
  }

  const raw = await readFile(path.resolve(args.response), "utf8");
  assertNoServiceKey(raw);
  const format = detectFormat(raw, args.format);
  const fields = format === "json" ? fieldsFromJson(raw) : fieldsFromXml(raw);
  const rows = rowsFromRaw(raw, format);
  const providerRecordHashes = rows.map((row) => sha256(JSON.stringify(row)));
  const rawSha256 = sha256(raw);
  const schemaFingerprint = sha256(JSON.stringify(fields));

  const evidence = {
    candidateId: args.candidate,
    endpoint: candidate.evidence.endpoint,
    format,
    fields,
    rowCount: rows.length,
    rawSha256,
    schemaFingerprint,
    credentialRedacted: true,
    providerRecordHashes,
  };
  evidence.evidenceHash = sha256(JSON.stringify(evidence));

  console.log(JSON.stringify(evidence, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
