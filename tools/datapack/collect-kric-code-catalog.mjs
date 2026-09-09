#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const OFFICIAL_ORIGIN = "https://openapi.kric.go.kr";
const CONTENT_TYPES = new Set([
  "application/octet-stream",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);
const DEFAULT_MAXIMUM_BYTES = 20 * 1024 * 1024;

export async function downloadKricCodeCatalog({
  candidate,
  fetchImpl = fetch,
  now = new Date(),
  maximumBytes = DEFAULT_MAXIMUM_BYTES,
} = {}) {
  if (!Number.isInteger(maximumBytes) || maximumBytes < 1) throw new Error("maximumBytes is invalid");
  const selected = validateCandidate(candidate);
  const response = await fetchCatalog(selected.endpoint, fetchImpl);
  if (!response.ok) throw new Error(`KRIC code catalog HTTP ${response.status}`);
  const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (!CONTENT_TYPES.has(contentType)) {
    throw new Error(`KRIC code catalog schema mismatch: content-type ${contentType ?? "missing"}`);
  }
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maximumBytes) {
    throw new Error("KRIC code catalog size limit exceeded");
  }
  if (!response.body) throw new Error("KRIC code catalog schema mismatch: response body missing");
  const reader = response.body.getReader();
  const chunks = [];
  let byteCount = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    byteCount += value.byteLength;
    if (byteCount > maximumBytes) {
      await reader.cancel().catch(() => {});
      throw new Error("KRIC code catalog size limit exceeded");
    }
    chunks.push(Buffer.from(value));
  }
  const bytes = Buffer.concat(chunks, byteCount);
  if (bytes.length < 4 || !bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
    throw new Error("KRIC code catalog schema mismatch: XLSX ZIP signature missing");
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return {
    bytes,
    metadata: {
      schemaVersion: 1,
      artifactKind: "kric-provider-code-catalog-download",
      sourceId: `${selected.id}-${sha256}`,
      detailUrl: selected.detailUrl,
      endpoint: selected.endpoint,
      capturedAt: now.toISOString(),
      byteCount: bytes.length,
      sha256,
      credentialRequired: false,
    },
  };
}

function validateCandidate(candidate) {
  const endpoint = candidate?.operation?.endpoint;
  if (typeof candidate?.id !== "string" || candidate.id.length === 0
    || candidate?.operation?.method !== "GET"
    || candidate?.operation?.auth?.placement !== "none"
    || candidate.operation.maxRetries !== 0
    || candidate.requestUrl !== endpoint
    || typeof candidate.detailUrl !== "string"
    || !isOfficial(endpoint, "/rips/download.file")
    || !isOfficial(candidate.detailUrl, "/rips/M_04_02/detail.do")) {
    throw new Error("KRIC code catalog candidate is invalid");
  }
  return { id: candidate.id, endpoint, detailUrl: candidate.detailUrl };
}

function isOfficial(value, pathname) {
  try {
    const url = new URL(value);
    return url.origin === OFFICIAL_ORIGIN && url.pathname === pathname
      && !url.username && !url.password;
  } catch {
    return false;
  }
}

async function fetchCatalog(endpoint, fetchImpl) {
  try {
    return await fetchWithBoundedRedirect(endpoint, fetchImpl);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("KRIC code catalog redirect")) throw error;
    throw new Error(`KRIC code catalog transport failure (${transportReason(error)})`);
  }
}

function transportReason(error) {
  const code = error?.cause?.code ?? error?.code;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{1,63}$/.test(code) ? code : "UNKNOWN";
}

async function fetchWithBoundedRedirect(initialUrl, fetchImpl) {
  let url = initialUrl;
  for (let redirectCount = 0; redirectCount <= 1; redirectCount += 1) {
    const response = await fetchImpl(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
      headers: { accept: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/octet-stream" },
    });
    if (response.status < 300 || response.status >= 400) return response;
    if (redirectCount === 1) throw new Error("KRIC code catalog redirect limit exceeded");
    const location = response.headers.get("location");
    if (!location) throw new Error("KRIC code catalog redirect location missing");
    const redirected = new URL(location, url);
    if (redirected.origin !== OFFICIAL_ORIGIN || redirected.username || redirected.password) {
      throw new Error("KRIC code catalog redirect origin is not allowed");
    }
    url = redirected.href;
  }
  throw new Error("KRIC code catalog redirect limit exceeded");
}

export function parseArgs(argv) {
  if (argv.length !== 4 || argv[0] !== "--output" || argv[2] !== "--metadata-output") {
    throw new Error("usage: collect-kric-code-catalog.mjs --output <absolute.xlsx> --metadata-output <absolute.json>");
  }
  const output = argv[1];
  const metadataOutput = argv[3];
  if (!path.isAbsolute(output) || !path.isAbsolute(metadataOutput)) throw new Error("output paths must be absolute");
  return { output, metadataOutput };
}

async function main(argv) {
  const args = parseArgs(argv);
  const candidates = JSON.parse(await readFile(new URL("./source-candidates.json", import.meta.url), "utf8"));
  const matches = candidates.candidates?.filter((candidate) => candidate.id === "kric-provider-code-catalog") ?? [];
  if (matches.length !== 1) throw new Error("KRIC code catalog candidate is invalid");
  const catalog = await downloadKricCodeCatalog({ candidate: matches[0] });
  await writeFile(args.output, catalog.bytes, { mode: 0o600 });
  await writeFile(args.metadataOutput, `${JSON.stringify(catalog.metadata, null, 2)}\n`, { mode: 0o600 });
  console.log(`sanitized KRIC code catalog ready: bytes=${catalog.metadata.byteCount} sha256=${catalog.metadata.sha256}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "KRIC code catalog collection failed");
    process.exitCode = 1;
  }
}
