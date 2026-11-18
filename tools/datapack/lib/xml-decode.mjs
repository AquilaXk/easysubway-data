const DEFAULT_MAX_XML_CHARS = 32 * 1024 * 1024;
const DEFAULT_MAX_XML_BYTES = 64 * 1024 * 1024;

const NAMED_XML_ENTITIES = Object.freeze({
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
});

const SUPPORTED_XML_ENCODINGS = new Map([
  ["utf-8", "utf-8"],
  ["utf8", "utf-8"],
  ["euc-kr", "euc-kr"],
  ["ks_c_5601-1987", "euc-kr"],
  ["ks-c-5601-1987", "euc-kr"],
]);

const ENTITY_OR_CONTROL_PATTERN = /&(?:(amp|lt|gt|quot|apos)|#(\d+)|#x([0-9a-fA-F]+));|([\u0000-\u001f\u007f-\u009f])/g;
const DECLARED_ENCODING_PATTERN = /<\?xml\b[^>]*\bencoding=["']([^"']+)["']/i;

function requirePositiveLimit(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}

function safeEncodingToken(value) {
  return /^[A-Za-z0-9._-]{1,32}$/.test(value) ? value : "UNKNOWN";
}

function isValidXmlCodePoint(codePoint) {
  if (!Number.isSafeInteger(codePoint) || codePoint <= 0 || codePoint > 0x10FFFF) {
    return false;
  }
  if (codePoint >= 0xD800 && codePoint <= 0xDFFF) {
    return false;
  }
  if (codePoint === 0xFFFE || codePoint === 0xFFFF) {
    return false;
  }
  if (codePoint < 0x20 && codePoint !== 0x09 && codePoint !== 0x0A && codePoint !== 0x0D) {
    return false;
  }
  return true;
}

/**
 * Decodes XML named/numeric entities in a single non-reentrant O(n) pass so
 * double-encoded entities such as `&amp;lt;` become `&lt;` instead of `<`.
 */
export function decodeXmlEntities(value, {
  maxInputLength = DEFAULT_MAX_XML_CHARS,
  stripControlChars = false,
  rejectNul = true,
  label = "XML text",
} = {}) {
  requirePositiveLimit(maxInputLength, "maxInputLength");
  const text = typeof value === "string" ? value : String(value ?? "");
  if (text.length > maxInputLength) {
    throw new Error(`${label} exceeds maximum length (${maxInputLength} chars)`);
  }
  if (stripControlChars) {
    if (!/[&\u0000-\u001f\u007f-\u009f]/.test(text)) return text;
  } else if (!/[&\u0000]/.test(text)) {
    return text;
  }

  return text.replace(ENTITY_OR_CONTROL_PATTERN, (full, named, decimalDigits, hexDigits, controlChar) => {
    if (controlChar !== undefined) {
      if (stripControlChars) return " ";
      if (controlChar === "\u0000" && rejectNul) {
        throw new Error(`${label} contains a raw NUL byte`);
      }
      return controlChar;
    }
    if (named !== undefined) {
      return Object.hasOwn(NAMED_XML_ENTITIES, named) ? NAMED_XML_ENTITIES[named] : full;
    }
    const codePoint = decimalDigits !== undefined
      ? Number.parseInt(decimalDigits, 10)
      : Number.parseInt(hexDigits, 16);
    if (!isValidXmlCodePoint(codePoint)) {
      throw new Error(`${label} contains an invalid XML numeric character reference`);
    }
    if (stripControlChars && ((codePoint >= 0x00 && codePoint <= 0x1F) || (codePoint >= 0x7F && codePoint <= 0x9F))) {
      return " ";
    }
    return String.fromCodePoint(codePoint);
  });
}

/**
 * Decodes raw XML byte buffers into a string with strict byte-size caps,
 * UTF-8/EUC-KR fatal decoding, and optional XML declaration validation.
 */
export function decodeXmlBytes(bytes, {
  maxBytes = DEFAULT_MAX_XML_BYTES,
  respectDeclaredEncoding = false,
  rejectReplacementChar = false,
  errorPrefix = "",
  label = "XML payload",
} = {}) {
  requirePositiveLimit(maxBytes, "maxBytes");
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError(`${label} must be a Uint8Array`);
  }
  if (bytes.byteLength > maxBytes) {
    throw new Error(`${label} exceeds maximum size (${maxBytes} bytes)`);
  }

  let encoding = "utf-8";
  if (respectDeclaredEncoding) {
    const prefix = Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(256, bytes.byteLength)).toString("latin1");
    const declared = DECLARED_ENCODING_PATTERN.exec(prefix)?.[1]?.toLowerCase() ?? "utf-8";
    encoding = SUPPORTED_XML_ENCODINGS.get(declared);
    if (!encoding) {
      throw new Error(`${errorPrefix}XML encoding ${safeEncodingToken(declared)}`);
    }
  }

  let raw;
  let responseEncoding = encoding;
  try {
    raw = new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } catch {
    if (respectDeclaredEncoding && encoding !== "utf-8") {
      throw new Error(`${errorPrefix}XML ${encoding} decoding`);
    }
    try {
      raw = new TextDecoder("euc-kr", { fatal: true }).decode(bytes);
      responseEncoding = respectDeclaredEncoding ? "euc-kr-after-invalid-utf8" : "euc-kr";
    } catch {
      throw new Error(`${errorPrefix}XML utf-8/euc-kr decoding`);
    }
  }

  if (rejectReplacementChar && raw.includes("\uFFFD")) {
    throw new Error(`${errorPrefix}XML replacement character`);
  }
  return { raw, responseEncoding };
}
