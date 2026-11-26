import { crc32, inflateRawSync } from "node:zlib";

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
const MAX_ZIP_COMMENT_LENGTH = 0xffff;

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
    || name.includes("//")
    || /^[A-Za-z]:/.test(name)
  ) {
    throw new Error(`unsafe zip entry path: ${String(name)}`);
  }
  const isDirectory = name.endsWith("/");
  const trimmed = isDirectory ? name.slice(0, -1) : name;
  if (trimmed.length === 0) {
    throw new Error(`unsafe zip entry path: ${name}`);
  }
  const segments = trimmed.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`unsafe zip entry path: ${name}`);
  }
  return isDirectory;
}

/**
 * Locate End-of-Central-Directory (EOCD) strictly at the end of the ZIP buffer.
 */
function findEocdOffset(buffer) {
  const minOffset = Math.max(0, buffer.length - 22 - MAX_ZIP_COMMENT_LENGTH);
  for (let offset = buffer.length - 22; offset >= minOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) !== EOCD_SIG) continue;
    const commentLen = buffer.readUInt16LE(offset + 20);
    if (offset + 22 + commentLen === buffer.length) {
      return offset;
    }
  }
  throw new Error("xlsx archive is missing a valid zip end-of-central-directory record");
}

/**
 * Bounded, fail-closed XLSX/ZIP Central-Directory + CRC32 extractor.
 * Validates EOCD, Central Directory <-> Local File Header parity, CRC32 checksums,
 * rejects zip-slip paths, encrypted/data-descriptor flags, Zip64 sentinels,
 * excessive entry counts, and entries exceeding per-entry or cumulative budgets
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
  if (buffer.length < 22) {
    throw new Error("xlsx archive is empty or truncated");
  }
  if (buffer.length > maxArchiveBytes) {
    throw new Error(`xlsx archive size ${buffer.length} exceeds limit (${maxArchiveBytes} bytes)`);
  }
  if (buffer.readUInt32LE(0) !== LOCAL_FILE_HEADER_SIG) {
    throw new Error("xlsx source is not a zip local file archive");
  }

  const eocdOffset = findEocdOffset(buffer);
  const diskNumber = buffer.readUInt16LE(eocdOffset + 4);
  const cdStartDisk = buffer.readUInt16LE(eocdOffset + 6);
  const entriesOnDisk = buffer.readUInt16LE(eocdOffset + 8);
  const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
  const cdSize = buffer.readUInt32LE(eocdOffset + 12);
  const cdOffset = buffer.readUInt32LE(eocdOffset + 16);

  if (diskNumber !== 0 || cdStartDisk !== 0 || entriesOnDisk !== totalEntries) {
    throw new Error("multi-disk zip archives are unsupported");
  }
  if (totalEntries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new Error("zip64 archives are unsupported");
  }
  if (totalEntries > maxEntries) {
    throw new Error(`zip entry count exceeds limit (${maxEntries})`);
  }
  if (cdOffset + cdSize !== eocdOffset || cdOffset > eocdOffset) {
    throw new Error("zip central directory bounds are invalid");
  }

  /** @type {Map<string, Buffer>} */
  const out = new Map();
  const seenNames = new Set();
  let cdCursor = cdOffset;
  let totalDecompressedBytes = 0;

  for (let index = 0; index < totalEntries; index += 1) {
    if (cdCursor + 46 > eocdOffset || buffer.readUInt32LE(cdCursor) !== CENTRAL_DIR_HEADER_SIG) {
      throw new Error(`invalid zip central directory header at offset ${cdCursor}`);
    }

    const flags = buffer.readUInt16LE(cdCursor + 8);
    const method = buffer.readUInt16LE(cdCursor + 10);
    const expectedCrc32 = buffer.readUInt32LE(cdCursor + 16);
    const compSize = buffer.readUInt32LE(cdCursor + 20);
    const uncompSize = buffer.readUInt32LE(cdCursor + 24);
    const nameLen = buffer.readUInt16LE(cdCursor + 28);
    const extraLen = buffer.readUInt16LE(cdCursor + 30);
    const commentLen = buffer.readUInt16LE(cdCursor + 32);
    const localOffset = buffer.readUInt32LE(cdCursor + 42);

    const cdNameStart = cdCursor + 46;
    const cdNameEnd = cdNameStart + nameLen;
    const cdNext = cdNameEnd + extraLen + commentLen;
    if (nameLen === 0 || cdNext > eocdOffset) {
      throw new Error(`truncated zip central directory entry at offset ${cdCursor}`);
    }

    const nameBytes = buffer.subarray(cdNameStart, cdNameEnd);
    const name = nameBytes.toString("utf8");
    const isDirectory = assertSafeZipEntryPath(name);
    if (seenNames.has(name)) {
      throw new Error(`duplicate zip entry: ${name}`);
    }
    seenNames.add(name);
    if ((flags & 0x0001) !== 0) {
      throw new Error(`encrypted zip entry unsupported: ${name}`);
    }
    if ((flags & 0x0008) !== 0) {
      throw new Error(`xlsx entry uses data descriptor unsupported: ${name}`);
    }
    if (compSize === 0xffffffff || uncompSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new Error(`zip64 entry unsupported: ${name}`);
    }

    if (localOffset + 30 > cdOffset || buffer.readUInt32LE(localOffset) !== LOCAL_FILE_HEADER_SIG) {
      throw new Error(`invalid zip local file header for ${name} at offset ${localOffset}`);
    }
    const localFlags = buffer.readUInt16LE(localOffset + 6);
    const localMethod = buffer.readUInt16LE(localOffset + 8);
    const localCrc32 = buffer.readUInt32LE(localOffset + 14);
    const localCompSize = buffer.readUInt32LE(localOffset + 18);
    const localUncompSize = buffer.readUInt32LE(localOffset + 22);
    const localNameLen = buffer.readUInt16LE(localOffset + 26);
    const localExtraLen = buffer.readUInt16LE(localOffset + 28);
    const localNameStart = localOffset + 30;
    const localNameEnd = localNameStart + localNameLen;
    const dataStart = localNameEnd + localExtraLen;
    const dataEnd = dataStart + compSize;

    if (
      localNameLen !== nameLen
      || dataStart > cdOffset
      || dataEnd > cdOffset
      || !buffer.subarray(localNameStart, localNameEnd).equals(nameBytes)
      || localFlags !== flags
      || localMethod !== method
      || localCrc32 !== expectedCrc32
      || localCompSize !== compSize
      || localUncompSize !== uncompSize
    ) {
      throw new Error(`zip central directory mismatch for entry ${name}`);
    }

    if (isDirectory) {
      if (method !== 0 || compSize !== 0 || uncompSize !== 0 || expectedCrc32 !== 0) {
        throw new Error(`zip directory entry ${name} must be empty`);
      }
      cdCursor = cdNext;
      continue;
    }

    const remainingBytes = maxTotalBytes - totalDecompressedBytes;
    const entryBudget = Math.min(maxEntryBytes, remainingBytes);
    if (entryBudget <= 0 || uncompSize > entryBudget) {
      throw new Error(`zip entry ${name} exceeds decompressed size limit (${Math.max(0, entryBudget)} bytes)`);
    }

    const compressed = buffer.subarray(dataStart, dataEnd);
    let data;
    if (method === 0) {
      if (compSize > entryBudget || uncompSize !== compSize) {
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
    if (data.length !== uncompSize) {
      throw new Error(`zip entry ${name} uncompressed size mismatch (expected ${uncompSize}, got ${data.length})`);
    }
    if ((crc32(data) >>> 0) !== expectedCrc32) {
      throw new Error(`zip entry ${name} CRC32 checksum mismatch`);
    }
    totalDecompressedBytes += data.length;
    out.set(name, data);
    cdCursor = cdNext;
  }

  if (cdCursor !== eocdOffset) {
    throw new Error("zip central directory contains unparsed trailing bytes");
  }

  for (const required of requiredEntries) {
    if (!out.has(required)) {
      throw new Error("failed to unzip xlsx local entries");
    }
  }
  return out;
}
