#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const ENDPOINT = "https://apis.data.go.kr/B553766/fare2/getRltmFare2";
const EXPECTED_SAMPLE = {
  dptreStnCd: "0150",
  dptreStnNm: "서울역",
  arvlStnCd: "0151",
  arvlStnNm: "시청",
  gnrlCardFare: 1550,
  gnrlCashFare: 1650,
  yungCardFare: 900,
  yungCashFare: 1650,
  childCardFare: 550,
  childCashFare: 550,
};
const SAFE_REPORT_FIELDS = new Set([
  "dptreStnCd",
  "dptreStnNm",
  "arvlStnCd",
  "arvlStnNm",
  "gnrlCardFare",
  "gnrlCashFare",
  "yungCardFare",
  "yungCashFare",
  "childCardFare",
  "childCashFare",
  "distFare",
  "distanceFare",
]);

function decodedServiceKey(value) {
  if (!/%[0-9a-f]{2}/i.test(value)) {
    return value;
  }
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function validateFareSample(sample) {
  if (!sample || typeof sample !== "object" || Array.isArray(sample)) {
    throw new TypeError("fare API sample must be an object");
  }
  for (const [field, expected] of Object.entries(EXPECTED_SAMPLE)) {
    if (!(field in sample)) {
      throw new Error(`fare API field missing: ${field}`);
    }
    if (typeof sample[field] !== typeof expected) {
      throw new TypeError(`fare API field type invalid: ${field}`);
    }
    if (sample[field] !== expected) {
      throw new Error(`fare API field value changed: ${field}`);
    }
  }
}

async function main() {
  const serviceKey = process.env.DATA_GO_KR_SERVICE_KEY;
  const outputPath = process.env.FARE_API_PROBE_OUTPUT;
  if (!serviceKey || !outputPath) {
    throw new Error("fare API probe environment is incomplete");
  }

  const url = new URL(ENDPOINT);
  url.searchParams.set("serviceKey", decodedServiceKey(serviceKey));
  url.searchParams.set("pageNo", "1");
  url.searchParams.set("numOfRows", "10");
  url.searchParams.set("dataType", "JSON");
  url.searchParams.set("dptreStnCd", "0150");
  url.searchParams.set("dptreStnNm", "서울역");
  url.searchParams.set("arvlStnCd", "0151");
  url.searchParams.set("arvlStnNm", "시청");

  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) {
    throw new Error(`fare API HTTP ${response.status}`);
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error("fare API returned invalid JSON");
  }

  const envelope = payload?.response ?? payload;
  const resultCode = String(envelope?.header?.resultCode ?? "");
  const body = envelope?.body;
  const rawItems = body?.items?.item ?? body?.items ?? body?.item;
  let items = [];
  if (Array.isArray(rawItems)) {
    items = rawItems;
  } else if (rawItems) {
    items = [rawItems];
  }
  if (resultCode !== "00" || items.length === 0 || !items[0] || typeof items[0] !== "object") {
    throw new Error(`fare API response rejected: resultCode=${resultCode || "missing"}`);
  }

  const sample = items[0];
  validateFareSample(sample);
  const report = {
    endpoint: ENDPOINT,
    request: { dptreStnCd: "0150", dptreStnNm: "서울역", arvlStnCd: "0151", arvlStnNm: "시청" },
    resultCode,
    totalCount: Number(body?.totalCount ?? items.length),
    fieldNames: Object.keys(sample).sort((left, right) => left.localeCompare(right)),
    sample: Object.fromEntries(
      Object.entries(sample).filter(
        ([key, value]) => SAFE_REPORT_FIELDS.has(key) && ["string", "number", "boolean"].includes(typeof value),
      ),
    ),
  };
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "fare API probe failed"}\n`);
    process.exitCode = 1;
  }
}
