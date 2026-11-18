#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { sha256 } from "../lib/hash.mjs";
import { inflateWithLimit, readResponseBytesWithLimit } from "./lib/bounded-zlib.mjs";

const SOURCE_BASE_URL = "https://www2.humetro.busan.kr/homepage/default/img/cyber-station/";
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_CONNECTOR_PNG_BYTES = 4 * 1024 * 1024;
const MAX_CONNECTOR_PNG_DIMENSION = 4096;
const MAX_CONNECTOR_PNG_SCANLINE_BYTES = 16 * 1024 * 1024;
const MAX_CONNECTOR_PNG_CHUNKS = 1024;

export function connectorCenterline({ width, height, rgba }) {
  if (!Number.isInteger(width) || width < 2 || !Number.isInteger(height) || height < 2
    || !Buffer.isBuffer(rgba) || rgba.length !== width * height * 4) {
    throw new Error("invalid connector RGBA");
  }
  const horizontal = width >= height;
  const points = [];
  const outer = horizontal ? width : height;
  const inner = horizontal ? height : width;
  for (let primary = 0; primary < outer; primary += 1) {
    const visible = [];
    for (let secondary = 0; secondary < inner; secondary += 1) {
      const x = horizontal ? primary : secondary;
      const y = horizontal ? secondary : primary;
      if (rgba[(y * width + x) * 4 + 3] >= 128) visible.push(secondary);
    }
    if (visible.length === 0) continue;
    const secondary = visible[Math.floor(visible.length / 2)];
    points.push(horizontal ? { x: primary, y: secondary } : { x: secondary, y: primary });
  }
  if (points.length < 2) throw new Error("connector PNG has no traceable centerline");
  return points;
}

export function validateBusanRouteMapConnectorEvidence(evidence) {
  const assets = evidence?.assets;
  const seen = new Set();
  if (evidence?.schemaVersion !== 1
    || evidence.artifactKind !== "busan-route-map-connector-evidence"
    || evidence.sourceBaseUrl !== SOURCE_BASE_URL
    || !isIsoInstant(evidence.capturedAt)
    || !Array.isArray(assets)
    || assets.length === 0
    || assets.some((asset) => {
      const expectedUrl = new URL(asset.assetPath ?? "", SOURCE_BASE_URL).href;
      const centerline = asset.centerline;
      const invalid = !/^\d+-\d+\.png$/.test(asset.assetPath ?? "")
        || asset.sourceUrl !== expectedUrl
        || !/^[a-f0-9]{64}$/.test(asset.sha256 ?? "")
        || !Number.isInteger(asset.width) || asset.width < 2
        || !Number.isInteger(asset.height) || asset.height < 2
        || !Array.isArray(centerline) || centerline.length < 2
        || centerline.some(({ x, y }) => !Number.isInteger(x) || !Number.isInteger(y)
          || x < 0 || x >= asset.width || y < 0 || y >= asset.height)
        || seen.has(asset.assetPath);
      seen.add(asset.assetPath);
      return invalid;
    })) {
    throw new Error("invalid connector evidence");
  }
  return evidence;
}

export function decodePngRgba(bytes) {
  if (
    !Buffer.isBuffer(bytes)
    || bytes.length < 33
    || bytes.length > MAX_CONNECTOR_PNG_BYTES
    || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)
  ) {
    throw new Error("invalid connector PNG");
  }
  let offset = 8;
  let width;
  let height;
  let ihdrSeen = false;
  let chunkCount = 0;
  let idatTotalLength = 0;
  const idat = [];
  while (offset + 12 <= bytes.length) {
    chunkCount += 1;
    if (chunkCount > MAX_CONNECTOR_PNG_CHUNKS) {
      throw new Error("connector PNG chunk limit exceeded");
    }
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;
    if (length > bytes.length - dataStart - 4) throw new Error("invalid connector PNG");
    const dataEnd = dataStart + length;
    const data = bytes.subarray(dataStart, dataEnd);
    if (type === "IHDR") {
      if (ihdrSeen || chunkCount !== 1 || length !== 13) {
        throw new Error("invalid connector PNG IHDR");
      }
      ihdrSeen = true;
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (
        width < 2
        || width > MAX_CONNECTOR_PNG_DIMENSION
        || height < 2
        || height > MAX_CONNECTOR_PNG_DIMENSION
      ) {
        throw new Error(`connector PNG dimension exceeds limit: ${width}x${height}`);
      }
      if (data[8] !== 8 || data[9] !== 6 || data[10] !== 0 || data[11] !== 0 || data[12] !== 0) {
        throw new Error("connector PNG must be non-interlaced 8-bit RGBA");
      }
    } else if (type === "IDAT") {
      if (!ihdrSeen) throw new Error("invalid connector PNG");
      idatTotalLength += data.length;
      if (idatTotalLength > MAX_CONNECTOR_PNG_BYTES) {
        throw new Error("connector PNG IDAT compressed limit exceeded");
      }
      idat.push(data);
    } else if (type === "IEND") {
      break;
    } else if (!ihdrSeen) {
      throw new Error("invalid connector PNG");
    }
    offset = dataEnd + 4;
  }
  if (!ihdrSeen || !Number.isInteger(width) || !Number.isInteger(height) || idat.length === 0) {
    throw new Error("invalid connector PNG");
  }
  const stride = width * 4;
  const expectedScanlineBytes = height * (stride + 1);
  if (!Number.isSafeInteger(expectedScanlineBytes) || expectedScanlineBytes > MAX_CONNECTOR_PNG_SCANLINE_BYTES) {
    throw new Error(`connector PNG scanlines exceed budget (${expectedScanlineBytes} > ${MAX_CONNECTOR_PNG_SCANLINE_BYTES})`);
  }
  const inflated = inflateWithLimit(Buffer.concat(idat, idatTotalLength), {
    maxOutputLength: expectedScanlineBytes,
    maxCompressedBytes: MAX_CONNECTOR_PNG_BYTES,
    label: "connector PNG IDAT",
  });
  if (inflated.length !== expectedScanlineBytes) throw new Error("invalid connector PNG scanlines");
  const rgba = Buffer.alloc(width * height * 4);
  let inputOffset = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = inflated[inputOffset];
    inputOffset += 1;
    for (let x = 0; x < stride; x += 1) {
      const raw = inflated[inputOffset + x];
      const left = x >= 4 ? rgba[y * stride + x - 4] : 0;
      const up = y > 0 ? rgba[(y - 1) * stride + x] : 0;
      const upLeft = y > 0 && x >= 4 ? rgba[(y - 1) * stride + x - 4] : 0;
      rgba[y * stride + x] = unfilter(raw, filter, left, up, upLeft);
    }
    inputOffset += stride;
  }
  return { width, height, rgba };
}

function unfilter(raw, filter, left, up, upLeft) {
  if (filter === 0) return raw;
  if (filter === 1) return (raw + left) & 0xff;
  if (filter === 2) return (raw + up) & 0xff;
  if (filter === 3) return (raw + Math.floor((left + up) / 2)) & 0xff;
  if (filter === 4) return (raw + paeth(left, up, upLeft)) & 0xff;
  throw new Error("unsupported connector PNG filter");
}

function paeth(left, up, upLeft) {
  const prediction = left + up - upLeft;
  const leftDistance = Math.abs(prediction - left);
  const upDistance = Math.abs(prediction - up);
  const upLeftDistance = Math.abs(prediction - upLeft);
  if (leftDistance <= upDistance && leftDistance <= upLeftDistance) return left;
  return upDistance <= upLeftDistance ? up : upLeft;
}

export function connectorAssetPaths(css) {
  const assets = new Set();
  const selectorPattern = /\.l(\d+)-(\d+)\s*\{([^}]+)\}/g;
  for (const match of css.matchAll(selectorPattern)) {
    const [, fromCode, toCode, declaration] = match;
    if (!isBusanMetroSegment(fromCode, toCode)) continue;
    const asset = /url\([^)]*\/([0-9]+-[0-9]+\.png)\)/.exec(declaration)?.[1];
    if (asset) assets.add(asset);
  }
  return [...assets].sort(compareAssetPaths);
}

function isBusanMetroSegment(fromCode, toCode) {
  const from = Number(fromCode);
  const to = Number(toCode);
  return [
    [95, 134],
    [201, 243],
    [301, 317],
    [401, 414],
  ].some(([minimum, maximum]) => from >= minimum && from <= maximum && to >= minimum && to <= maximum);
}

async function collectEvidence({ css, capturedAt, fetchImpl = fetch }) {
  const assetPaths = connectorAssetPaths(css);
  const assets = new Array(assetPaths.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(4, assetPaths.length) }, async () => {
    while (cursor < assetPaths.length) {
      const index = cursor;
      cursor += 1;
      const assetPath = assetPaths[index];
      const sourceUrl = new URL(assetPath, SOURCE_BASE_URL).href;
      const bytes = await fetchOfficialPng(sourceUrl, fetchImpl);
      const { width, height, rgba } = decodePngRgba(bytes);
      assets[index] = {
        assetPath,
        sourceUrl,
        sha256: sha256(bytes),
        width,
        height,
        centerline: connectorCenterline({ width, height, rgba }),
      };
    }
  }));
  return validateBusanRouteMapConnectorEvidence({
    schemaVersion: 1,
    artifactKind: "busan-route-map-connector-evidence",
    sourceBaseUrl: SOURCE_BASE_URL,
    capturedAt,
    assets,
  });
}

async function fetchOfficialPng(url, fetchImpl) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok || !String(response.headers.get("content-type") ?? "").startsWith("image/png")) {
        await response.body?.cancel?.().catch(() => {});
        throw new Error(`connector HTTP boundary failed: ${response.status}`);
      }
      const bytes = await readResponseBytesWithLimit(response, {
        maxBytes: MAX_CONNECTOR_PNG_BYTES,
        label: "connector PNG",
      });
      decodePngRgba(bytes);
      return bytes;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function compareAssetPaths(left, right) {
  const numbers = (value) => value.replace(".png", "").split("-").map(Number);
  const [leftFrom, leftTo] = numbers(left);
  const [rightFrom, rightTo] = numbers(right);
  return leftFrom - rightFrom || leftTo - rightTo;
}

function isIsoInstant(value) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) return false;
  return new Date(value).toISOString() === value;
}

function parseArgs(argv) {
  const expected = ["--css", "--captured-at", "--output"];
  if (argv.length !== expected.length * 2 || expected.some((flag, index) => argv[index * 2] !== flag)
    || !path.isAbsolute(argv.at(-1))) {
    throw new Error("usage: collect-busan-route-map-connectors.mjs --css <path> --captured-at <iso> --output <absolute.json>");
  }
  return Object.fromEntries(expected.map((flag, index) => [flag.slice(2), argv[index * 2 + 1]]));
}

async function main(argv) {
  const args = parseArgs(argv);
  if (!isIsoInstant(args["captured-at"])) throw new Error("captured-at must be an ISO instant");
  const css = await readFile(args.css, "utf8");
  const evidence = await collectEvidence({ css, capturedAt: args["captured-at"] });
  await writeFile(args.output, `${JSON.stringify(evidence)}\n`);
  console.log(`Busan route map connectors collected: assets=${evidence.assets.length}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Busan route map connector collection failed");
    process.exitCode = 1;
  }
}
