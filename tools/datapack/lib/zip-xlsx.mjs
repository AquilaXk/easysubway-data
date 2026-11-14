import { inflateRawSync } from "node:zlib";

export const DEFAULT_MAX_ZIP_ARCHIVE_BYTES = 128 * 1024 * 1024;
export const DEFAULT_MAX_ZIP_ENTRIES = 1_024;
export const DEFAULT_MAX_ZIP_ENTRY_BYTES = 64 * 1024 * 1024;
export const DEFAULT_MAX_ZIP_TOTAL_BYTES = 128 * 1024 * 1024;
export const DEFAULT_REQUIRED_XLSX_ENTRIES = Object.freeze([
  "xl/sharedStrings.xml",
  "xl/worksheets/sheet1.xml",
]);

const LOCAL_FILE_HEADER_SIG = 0x04034b50;
const CENTRAL_DIR_HEADER_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;

function requirePositiveLimit(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function asByteBuffer(input) {
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof Uint8Array) {
    return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  }
  throw new TypeError("xlsx archive bytes must be a Buffer or Uint8Array");
}

function assertSafeZipEntryPath(name) {
  if (
    typeof name !== "string"
    || name.length === 0
    || name.length > 1_024
    || name.includes("\0")
    || name.includes("\\")
    || name.startsWith("/")
    || name.endsWith("/")
    || name.includes("//")
    || /^[A-Za-z]:/.test(name)
  ) {
    throw new Error(`unsafe zip entry path: ${String(name)}`);
  }
  const segments = name.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`unsafe zip entry path: ${name}`);
  }
}

/**
 * Bounded, fail-closed XLSX/ZIP local-entry extractor.
 * Rejects zip-slip paths, encrypted/data-descriptor flags, excessive entry counts,
 * and entries whose uncompressed size exceeds per-entry or cumulative budgets
 * BEFORE allocating large decompressed buffers.
 */
export function unzipXlsx(input, {
  maxArchiveBytes = DEFAULT_MAX_ZIP_ARCHIVE_BYTES,
  maxEntries = DEFAULT_MAX_ZIP_ENTRIES,
  maxEntryBytes = DEFAULT_MAX_ZIP_ENTRY_BYTES,
  maxTotalBytes = DEFAULT_MAX_ZIP_TOTAL_BYTES,
  requiredEntries = DEFAULT_REQUIRED_XLSX_ENTRIES,
} = {}) {
  requirePositiveLimit(maxArchiveBytes, "maxArchiveBytes");
  requirePositiveLimit(maxEntries, "maxEntries");
  requirePositiveLimit(maxEntryBytes, "maxEntryBytes");
  requirePositiveLimit(maxTotalBytes, "maxTotalBytes");

  const buffer = asByteBuffer(input);
  if (buffer.length < 30) {
    throw new Error("xlsx archive is empty or truncated");
  }
  if (buffer.length > maxArchiveBytes) {
    throw new Error(`xlsx archive size ${buffer.length} exceeds limit (${maxArchiveBytes} bytes)`);
  }
  if (buffer.readUInt32LE(0) !== LOCAL_FILE_HEADER_SIG) {
    throw new Error("xlsx source is not a zip local file archive");
  }

  /** @type {Map<string, Buffer>} */
  const out = new Map();
  let offset = 0;
  let totalDecompressedBytes = 0;

  while (offset + 30 <= buffer.length) {
    const signature = buffer.readUInt32LE(offset);
    if (signature === CENTRAL_DIR_HEADER_SIG || signature === EOCD_SIG) {
      break;
    }
    if (signature !== LOCAL_FILE_HEADER_SIG) {
      throw new Error(`invalid zip local file header at offset ${offset}`);
    }
    if (out.size >= maxEntries) {
      throw new Error(`zip entry count exceeds limit (${maxEntries})`);
    }

    const flags = buffer.readUInt16LE(offset + 6);
    const method = buffer.readUInt16LE(offset + 8);
    const compSize = buffer.readUInt32LE(offset + 18);
    const uncompSize = buffer.readUInt32LE(offset + 22);
    const nameLen = buffer.readUInt16LE(offset + 26);
    const extraLen = buffer.readUInt16LE(offset + 28);

    const nameStart = offset + 30;
    const nameEnd = nameStart + nameLen;
    const start = nameEnd + extraLen;
    const end = start + compSize;
    if (nameLen === 0 || nameEnd > buffer.length || start > buffer.length || end > buffer.length) {
      throw new Error(`truncated zip local entry at offset ${offset}`);
    }

    const name = buffer.subarray(nameStart, nameEnd).toString("utf8");
    assertSafeZipEntryPath(name);
    if (out.has(name)) {
      throw new Error(`duplicate zip entry: ${name}`);
    }
    if ((flags & 0x0001) !== 0) {
      throw new Error(`encrypted zip entry unsupported: ${name}`);
    }
    if ((flags & 0x0008) !== 0) {
      throw new Error(`xlsx entry uses data descriptor unsupported: ${name}`);
    }

    const remainingBytes = maxTotalBytes - totalDecompressedBytes;
    const entryBudget = Math.min(maxEntryBytes, remainingBytes);
    if (entryBudget <= 0 || uncompSize > entryBudget) {
      throw new Error(`zip entry ${name} exceeds decompressed size limit (${Math.max(0, entryBudget)} bytes)`);
    }

    const compressed = buffer.subarray(start, end);
    let data;
    if (method === 0) {
      if (compSize > entryBudget || (uncompSize !== 0 && uncompSize !== compSize)) {
        throw new Error(`zip entry ${name} exceeds decompressed size limit (${entryBudget} bytes)`);
      }
      data = Buffer.from(compressed);
    } else if (method === 8) {
      try {
        data = inflateRawSync(compressed, { maxOutputLength: entryBudget });
      } catch (cause) {
        if (cause?.code === "ERR_BUFFER_TOO_LARGE") {
          throw new Error(`zip entry ${name} exceeds decompressed size limit (${entryBudget} bytes)`, { cause });
        }
        throw new Error(`failed to inflate zip entry ${name}`, { cause });
      }
    } else {
      throw new Error(`unsupported zip method ${method} for ${name}`);
    }

    if (data.length > entryBudget) {
      throw new Error(`zip entry ${name} exceeds decompressed size limit (${entryBudget} bytes)`);
    }
    totalDecompressedBytes += data.length;
    out.set(name, data);
    offset = end;
  }

  for (const required of requiredEntries) {
    if (!out.has(required)) {
      throw new Error("failed to unzip xlsx local entries");
    }
  }
  return out;
}
