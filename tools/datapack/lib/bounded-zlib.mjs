import { gunzipSync, inflateSync, zstdDecompressSync } from "node:zlib";

export const DEFAULT_MAX_COMPRESSED_BYTES = 256 * 1024 * 1024;
export const DEFAULT_MAX_GUNZIP_BYTES = 512 * 1024 * 1024;
export const DEFAULT_MAX_ZSTD_BYTES = 201_326_592;
export const DEFAULT_MAX_HTTP_RESPONSE_BYTES = 128 * 1024 * 1024;

function requirePositiveLimit(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function asByteBuffer(input, label) {
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof Uint8Array) {
    return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  }
  throw new TypeError(`${label} must be a Buffer or Uint8Array`);
}

function decompressWithLimit(decompressFn, input, {
  maxOutputLength,
  maxCompressedBytes = DEFAULT_MAX_COMPRESSED_BYTES,
  label = "compressed payload",
}) {
  requirePositiveLimit(maxOutputLength, "maxOutputLength");
  requirePositiveLimit(maxCompressedBytes, "maxCompressedBytes");
  const buffer = asByteBuffer(input, label);
  if (buffer.length === 0) {
    throw new Error(`${label} is empty`);
  }
  if (buffer.length > maxCompressedBytes) {
    throw new Error(`${label} compressed size (${buffer.length}) exceeds maximum (${maxCompressedBytes} bytes)`);
  }
  try {
    return decompressFn(buffer, { maxOutputLength });
  } catch (cause) {
    if (cause?.code === "ERR_BUFFER_TOO_LARGE") {
      throw new Error(`${label} exceeds maximum decompressed size (${maxOutputLength} bytes)`, { cause });
    }
    throw cause;
  }
}

export function gunzipWithLimit(input, {
  maxOutputLength = DEFAULT_MAX_GUNZIP_BYTES,
  maxCompressedBytes = DEFAULT_MAX_COMPRESSED_BYTES,
  label = "gzip payload",
} = {}) {
  return decompressWithLimit(gunzipSync, input, { maxOutputLength, maxCompressedBytes, label });
}

export function inflateWithLimit(input, {
  maxOutputLength,
  maxCompressedBytes = DEFAULT_MAX_COMPRESSED_BYTES,
  label = "zlib payload",
} = {}) {
  return decompressWithLimit(inflateSync, input, { maxOutputLength, maxCompressedBytes, label });
}

export function zstdDecompressWithLimit(input, {
  maxOutputLength = DEFAULT_MAX_ZSTD_BYTES,
  maxCompressedBytes = DEFAULT_MAX_COMPRESSED_BYTES,
  label = "zstd payload",
} = {}) {
  return decompressWithLimit(zstdDecompressSync, input, { maxOutputLength, maxCompressedBytes, label });
}

export async function readResponseBytesWithLimit(response, {
  maxBytes = DEFAULT_MAX_HTTP_RESPONSE_BYTES,
  label = "HTTP response",
} = {}) {
  requirePositiveLimit(maxBytes, "maxBytes");
  const contentLengthRaw = response?.headers?.get?.("content-length");
  if (contentLengthRaw !== null && contentLengthRaw !== undefined && String(contentLengthRaw).trim() !== "") {
    const contentLength = Number(String(contentLengthRaw).trim());
    if (!Number.isSafeInteger(contentLength) || contentLength < 0 || contentLength > maxBytes) {
      await response?.body?.cancel?.().catch(() => {});
      throw new Error(`${label} Content-Length exceeds maximum size (${maxBytes} bytes)`);
    }
  }

  if (typeof response?.body?.getReader === "function") {
    const reader = response.body.getReader();
    const chunks = [];
    let totalBytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value == null) continue;
        const chunk = Buffer.isBuffer(value)
          ? value
          : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
        totalBytes += chunk.length;
        if (totalBytes > maxBytes) {
          await reader.cancel().catch(() => {});
          throw new Error(`${label} exceeds maximum size (${maxBytes} bytes)`);
        }
        chunks.push(chunk);
      }
    } finally {
      reader.releaseLock?.();
    }
    return chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, totalBytes);
  }

  if (typeof response?.arrayBuffer === "function") {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) {
      throw new Error(`${label} exceeds maximum size (${maxBytes} bytes)`);
    }
    return buffer;
  }

  if (typeof response?.text === "function") {
    const buffer = Buffer.from(await response.text(), "utf8");
    if (buffer.length > maxBytes) {
      throw new Error(`${label} exceeds maximum size (${maxBytes} bytes)`);
    }
    return buffer;
  }

  throw new TypeError(`${label} response body is unreadable`);
}

export async function readResponseTextWithLimit(response, options = {}) {
  const maxBytes = options?.maxBytes ?? DEFAULT_MAX_HTTP_RESPONSE_BYTES;
  const label = options?.label ?? "HTTP response";
  if (typeof response?.body?.getReader !== "function" && typeof response?.arrayBuffer !== "function" && typeof response?.text === "function") {
    requirePositiveLimit(maxBytes, "maxBytes");
    const contentLengthRaw = response?.headers?.get?.("content-length");
    if (contentLengthRaw !== null && contentLengthRaw !== undefined && String(contentLengthRaw).trim() !== "") {
      const contentLength = Number(String(contentLengthRaw).trim());
      if (!Number.isSafeInteger(contentLength) || contentLength < 0 || contentLength > maxBytes) {
        throw new Error(`${label} Content-Length exceeds maximum size (${maxBytes} bytes)`);
      }
    }
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) {
      throw new Error(`${label} exceeds maximum size (${maxBytes} bytes)`);
    }
    return text;
  }
  return (await readResponseBytesWithLimit(response, options)).toString("utf8");
}
