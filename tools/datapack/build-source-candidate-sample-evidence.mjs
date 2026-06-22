import { readFile } from "node:fs/promises";
import path from "node:path";

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

function fieldsFromJson(raw) {
  const parsed = JSON.parse(raw);
  const rows = itemRows(parsed);
  if (rows.length > 0) {
    const fields = new Set();
    for (const row of rows) {
      for (const [key, value] of Object.entries(row)) {
        if (value == null || typeof value !== "object") {
          fields.add(key);
        }
      }
    }
    if (fields.size === 0) {
      throw new Error("JSON response has no object fields");
    }
    return [...fields].sort();
  }

  const row = bestJsonRow(parsed).row;
  if (!row) {
    throw new Error("JSON response has no object fields");
  }
  return Object.keys(row)
    .filter((key) => row[key] == null || typeof row[key] !== "object")
    .sort();
}

function fieldsFromXml(raw) {
  const items = [...raw.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)].map((match) => match[1]);
  const fragments = items.length > 0 ? items : [raw];
  const fields = new Set();
  for (const fragment of fragments) {
    const selfClosingTagPattern = /<([A-Za-z_][\w.-]*)\b[^>]*\/>/g;
    for (const match of fragment.matchAll(selfClosingTagPattern)) {
      fields.add(match[1]);
    }
    const tagPattern = /<([A-Za-z_][\w.-]*)\b[^>]*>([\s\S]*?)<\/\1>/g;
    for (const match of fragment.matchAll(tagPattern)) {
      const [, tagName, body] = match;
      if (!/<[A-Za-z_][\w.-]*\b/.test(body)) {
        fields.add(tagName);
      }
    }
  }
  if (fields.size === 0) {
    throw new Error("XML response has no leaf fields");
  }
  return [...fields].sort();
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

  console.log(
    JSON.stringify(
      {
        candidateId: args.candidate,
        endpoint: candidate.evidence.endpoint,
        format,
        fields,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
