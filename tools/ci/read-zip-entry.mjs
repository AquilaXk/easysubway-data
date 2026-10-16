import { crc32, inflateRawSync } from "node:zlib";

// GitHub Actions artifact ZIP에서 항목 하나를 읽는다. artifact는 스트리밍 ZIP(data descriptor)이라 크기·CRC는 중앙 디렉터리 값을 믿는다.
// 외부에서 받은 바이트이므로 모호하거나 손상된 ZIP은 추정하지 않고 ZIP_* 코드로 실패한다.
const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const END_OF_CENTRAL_DIRECTORY_SIZE = 22;
const MAX_COMMENT_BYTES = 0xffff;
const CENTRAL_HEADER_SIZE = 46;
const LOCAL_HEADER_SIZE = 30;
const FLAG_ENCRYPTED = 0x0001;
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;
const ZIP64_MARKER = 0xffffffff;

function fail(code, detail) {
  throw new Error(`${code}: ${detail}`);
}

function endOfCentralDirectory(zip) {
  const lowest = Math.max(0, zip.length - END_OF_CENTRAL_DIRECTORY_SIZE - MAX_COMMENT_BYTES);
  for (let offset = zip.length - END_OF_CENTRAL_DIRECTORY_SIZE; offset >= lowest; offset -= 1) {
    if (zip.readUInt32LE(offset) === END_OF_CENTRAL_DIRECTORY) return offset;
  }
  return fail("ZIP_INVALID", "end of central directory is missing");
}

function* centralEntries(zip) {
  const end = endOfCentralDirectory(zip);
  const count = zip.readUInt16LE(end + 10);
  const size = zip.readUInt32LE(end + 12);
  const start = zip.readUInt32LE(end + 16);
  if (count === 0xffff || size === ZIP64_MARKER || start === ZIP64_MARKER) fail("ZIP_UNSUPPORTED", "zip64");
  if (start + size > end) fail("ZIP_INVALID", "central directory is outside the archive");
  let offset = start;
  for (let index = 0; index < count; index += 1) {
    if (offset + CENTRAL_HEADER_SIZE > end || zip.readUInt32LE(offset) !== CENTRAL_HEADER) fail("ZIP_INVALID", "central directory entry");
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    const next = offset + CENTRAL_HEADER_SIZE + nameLength + extraLength + commentLength;
    if (next > end) fail("ZIP_INVALID", "central directory entry is truncated");
    yield {
      name: zip.toString("utf8", offset + CENTRAL_HEADER_SIZE, offset + CENTRAL_HEADER_SIZE + nameLength),
      flags: zip.readUInt16LE(offset + 8),
      method: zip.readUInt16LE(offset + 10),
      crc: zip.readUInt32LE(offset + 16),
      compressedSize: zip.readUInt32LE(offset + 20),
      size: zip.readUInt32LE(offset + 24),
      localOffset: zip.readUInt32LE(offset + 42),
    };
    offset = next;
  }
}

function entryData(zip, entry) {
  const { localOffset } = entry;
  if (entry.compressedSize === ZIP64_MARKER || entry.size === ZIP64_MARKER || localOffset === ZIP64_MARKER) fail("ZIP_UNSUPPORTED", "zip64 entry");
  if (localOffset + LOCAL_HEADER_SIZE > zip.length || zip.readUInt32LE(localOffset) !== LOCAL_HEADER) fail("ZIP_INVALID", "local header");
  const start = localOffset + LOCAL_HEADER_SIZE + zip.readUInt16LE(localOffset + 26) + zip.readUInt16LE(localOffset + 28);
  if (start + entry.compressedSize > zip.length) fail("ZIP_INVALID", "entry data is truncated");
  return zip.subarray(start, start + entry.compressedSize);
}

function inflate(entry, data, maxBytes) {
  if (entry.method === METHOD_STORED) return Buffer.from(data);
  try {
    return inflateRawSync(data, { maxOutputLength: maxBytes });
  } catch {
    return fail("ZIP_INVALID", "entry data cannot be inflated");
  }
}

/**
 * @param {Buffer} zip artifact ZIP 바이트
 * @param {string} entryName 정확히 같은 항목 이름
 * @param {{ maxBytes: number }} limits 압축을 푼 뒤 크기 상한(풀기 전에 중앙 디렉터리 크기로 먼저 거른다)
 * @returns {Buffer | null} 항목이 없으면 null
 */
export function readZipEntry(zip, entryName, { maxBytes }) {
  const matches = [...centralEntries(zip)].filter(({ name }) => name === entryName);
  if (matches.length === 0) return null;
  if (matches.length > 1) fail("ZIP_DUPLICATE_ENTRY", entryName);
  const [entry] = matches;
  if ((entry.flags & FLAG_ENCRYPTED) !== 0 || (entry.method !== METHOD_STORED && entry.method !== METHOD_DEFLATE)) fail("ZIP_UNSUPPORTED", `entry ${entryName}`);
  if (entry.size > maxBytes) fail("ZIP_ENTRY_TOO_LARGE", `${entryName} is ${entry.size} bytes`);
  const bytes = inflate(entry, entryData(zip, entry), maxBytes);
  if (bytes.length !== entry.size || crc32(bytes) !== entry.crc) fail("ZIP_INVALID", `entry ${entryName} does not match its checksum`);
  return bytes;
}
