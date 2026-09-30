#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { normalizeDataGoKrServiceKey } from "./lib/provider-call-integrity.mjs";

const DEFAULT_OAS_URL = "https://infuser.odcloud.kr/oas/docs?namespace=15071311/v1";
const ODCLOUD_BASE_URL = "https://api.odcloud.kr";
const DATASET_SUMMARY_PATTERN = /^서울교통공사_지하철혼잡도정보_(\d{8})$/;

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function canonicalJson(obj) {
  return JSON.stringify(obj, Object.keys(obj).sort());
}

export function selectLatestOasUddi(oasDocument) {
  const paths = oasDocument?.paths;
  if (!paths || typeof paths !== "object") {
    throw new Error("invalid OAS document: missing paths");
  }

  let maxDate = -1;
  let selected = null;

  for (const [pathKey, pathItem] of Object.entries(paths)) {
    const summary = pathItem?.get?.summary;
    if (typeof summary !== "string") continue;
    const match = DATASET_SUMMARY_PATTERN.exec(summary.trim());
    if (!match) continue;

    const dateNum = Number(match[1]);
    if (dateNum > maxDate) {
      maxDate = dateNum;
      const uddiMatch = /(uddi:[a-f0-9-]+)/i.exec(pathKey);
      const uddi = uddiMatch ? uddiMatch[1] : pathKey.replace(/^\/?api\/15071311\/v1\/?/, "");
      selected = {
        path: pathKey,
        summary: summary.trim(),
        datasetLabel: summary.trim(),
        date: match[1],
        uddi,
      };
    }
  }

  if (!selected) {
    throw new Error("no matching path found in OAS document for 서울교통공사_지하철혼잡도정보_(\\d{8})");
  }

  return selected;
}

export async function collectSeoulMetroCongestion({
  serviceKey = process.env.DATA_GO_KR_SERVICE_KEY,
  fetchImpl = fetch,
  oasUrl = DEFAULT_OAS_URL,
  outputDir,
  now = new Date(),
  targetUddi,
  datasetLabel,
} = {}) {
  // Preflight validate credentials
  const normalizedKey = normalizeDataGoKrServiceKey(serviceKey);

  let selectedUddi = targetUddi;
  let label = datasetLabel;

  if (!selectedUddi || !label) {
    const oasResponse = await fetchImpl(oasUrl);
    if (!oasResponse.ok) {
      throw new Error(`failed to fetch OAS document from ${oasUrl}: HTTP ${oasResponse.status}`);
    }
    const oasDoc = await oasResponse.json();
    const resolution = selectLatestOasUddi(oasDoc);
    selectedUddi = selectedUddi ?? resolution.uddi;
    label = label ?? resolution.datasetLabel;
  }

  const endpointUrl = new URL(`/api/15071311/v1/${selectedUddi}`, ODCLOUD_BASE_URL);
  endpointUrl.searchParams.set("page", "1");
  endpointUrl.searchParams.set("perPage", "2000");
  endpointUrl.searchParams.set("returnType", "JSON");

  const response = await fetchImpl(endpointUrl.href, {
    headers: {
      Authorization: `Infuser ${normalizedKey}`,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`failed to fetch congestion data: HTTP ${response.status}`);
  }

  const rawText = await response.text();
  const parsed = JSON.parse(rawText);

  const totalCount = parsed.totalCount ?? parsed.matchCount;
  const rows = parsed.data;

  if (!Array.isArray(rows)) {
    throw new Error("response data is not an array");
  }

  if (typeof totalCount === "number" && rows.length !== totalCount) {
    throw new Error(`received row count (${rows.length}) does not match totalCount (${totalCount})`);
  }

  const rawSha = sha256(rawText);
  const contentSha = sha256(JSON.stringify(rows));
  const capturedAt = (now instanceof Date ? now : new Date(now)).toISOString();
  const timestampTag = capturedAt.replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const snapshotId = `seoul-metro-congestion-${timestampTag}`;

  const snapshot = {
    snapshotId,
    datasetLabel: label,
    capturedAt,
    uddi: selectedUddi,
    rawSha256: rawSha,
    contentSha256: contentSha,
    rowCount: rows.length,
    rows,
  };

  if (outputDir) {
    await mkdir(outputDir, { recursive: true });
    const targetFile = path.join(outputDir, `${snapshotId}.json`);
    await writeFile(targetFile, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    snapshot.savedPath = targetFile;
  }

  return snapshot;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const outputDir = path.resolve(process.cwd(), "tools/datapack/sources");
  console.log("Collecting Seoul Metro congestion statistics to", outputDir);
  collectSeoulMetroCongestion({ outputDir })
    .then((snap) => {
      console.log(`Successfully collected ${snap.rowCount} rows. Snapshot saved to ${snap.savedPath}`);
    })
    .catch((err) => {
      console.error("Collection failed:", err);
      process.exit(1);
    });
}
