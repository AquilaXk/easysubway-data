// Compact geometry codec based on Mapbox Vector Tile Specification and mapbox/pbf.
// Portions Copyright (c) 2014-2015 Mapbox, Inc. (ISC License & BSD-3-Clause).
// See THIRD_PARTY_NOTICES.md for details.
//
// Features:
// - 1/16 px fixed-point cursor delta quantization (max error <= 0.03125 px)
// - CommandInteger RLE: (cmdId & 0x7) | (count << 3)
// - 32-bit ZigZag delta encoding: (v << 1) ^ (v >> 31)
// - Unsigned LEB128 Varint encoding/decoding
// - Fail-closed resource bounds (maxVertices <= 1,000,000, maxBytes <= 16 MiB)

export const COMMAND = Object.freeze({
  moveTo: 1,
  lineTo: 2,
  closePath: 7,
});

export const SCALE = 16;
export const MAX_QUANTIZATION_ERROR = 1 / (SCALE * 2); // 0.03125 px

export const DEFAULT_MAX_VERTICES = 1_000_000;
export const DEFAULT_MAX_BYTES = 16 * 1024 * 1024; // 16 MiB

/**
 * 32-bit 부호 있는 정수를 ZigZag 인코딩해 비음수 32-bit uint로 변환한다.
 * @param {number} n
 * @returns {number}
 */
export function encodeZigZag(n) {
  const i = n | 0;
  return ((i << 1) ^ (i >> 31)) >>> 0;
}

/**
 * ZigZag 인코딩된 uint를 원래 부호 있는 32-bit int로 복원한다.
 * @param {number} n
 * @returns {number}
 */
export function decodeZigZag(n) {
  const u = n >>> 0;
  return (u >>> 1) ^ (-(u & 1));
}

/**
 * uint32 값을 LEB128 Varint로 buffer에 쓰고 다음 오프셋을 반환한다.
 * @param {Uint8Array} buf
 * @param {number} offset
 * @param {number} value
 * @returns {number} new offset
 */
export function writeVarint(buf, offset, value) {
  let val = value >>> 0;
  let pos = offset;
  while (val >= 0x80) {
    if (pos >= buf.length) throw new Error("Varint write exceeded buffer length");
    buf[pos++] = (val & 0x7f) | 0x80;
    val >>>= 7;
  }
  if (pos >= buf.length) throw new Error("Varint write exceeded buffer length");
  buf[pos++] = val;
  return pos;
}

/**
 * LEB128 Varint 바이트 길이를 계산한다.
 * @param {number} value
 * @returns {number}
 */
export function varintByteLength(value) {
  const val = value >>> 0;
  if (val < 0x80) return 1;
  if (val < 0x4000) return 2;
  if (val < 0x200000) return 3;
  if (val < 0x10000000) return 4;
  return 5;
}

/**
 * LEB128 Varint를 읽고 { value, bytesRead }를 반환한다.
 * @param {Uint8Array} buf
 * @param {number} offset
 * @returns {{ value: number, bytesRead: number }}
 */
export function readVarint(buf, offset) {
  let result = 0;
  let shift = 0;
  let pos = offset;
  while (pos < buf.length) {
    const byte = buf[pos++];
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return { value: result >>> 0, bytesRead: pos - offset };
    }
    shift += 7;
    if (shift >= 35) {
      throw new Error("Varint overflow: exceeds 32 bits");
    }
  }
  throw new Error("Varint reading exceeded buffer bounds (truncated data)");
}

/**
 * Command RLE 정수 생성: (cmd & 0x7) | (count << 3)
 */
export function encodeCommandInteger(cmd, count) {
  if (count <= 0 || count > 0x1fffffff) {
    throw new Error(`Invalid command count: ${count}`);
  }
  return ((cmd & 0x7) | (count << 3)) >>> 0;
}

/**
 * Command RLE 정수 해석: { command, count }
 */
export function decodeCommandInteger(commandInteger) {
  const u = commandInteger >>> 0;
  return {
    command: u & 0x7,
    count: u >>> 3,
  };
}

/**
 * 경로 명령 배열을 1/16px 고정소수점 커서 델타 + Command RLE + ZigZag + Varint로 인코딩한다.
 * @param {Array<{ command: string|number, x?: number, y?: number }>} commands
 * @param {{ maxVertices?: number, maxBytes?: number }} options
 * @returns {Uint8Array}
 */
export function encodeGeometry(commands, {
  maxVertices = DEFAULT_MAX_VERTICES,
  maxBytes = DEFAULT_MAX_BYTES,
} = {}) {
  if (!Array.isArray(commands)) {
    throw new Error("commands must be an array");
  }

  // 정점 수 검증 (moveTo, lineTo)
  let vertexCount = 0;
  for (const cmd of commands) {
    const c = typeof cmd.command === "string" ? COMMAND[cmd.command] : cmd.command;
    if (c === COMMAND.moveTo || c === COMMAND.lineTo) {
      vertexCount += 1;
      if (vertexCount > maxVertices) {
        throw new Error(`Total vertices ${vertexCount} exceeds limit of ${maxVertices}`);
      }
    }
  }

  // RLE 그룹화: 연속된 같은 명령(moveTo / lineTo) 및 closePath
  const groups = [];
  let currentGroup = null;

  for (const item of commands) {
    const cmdId = typeof item.command === "string" ? COMMAND[item.command] : item.command;
    if (cmdId !== COMMAND.moveTo && cmdId !== COMMAND.lineTo && cmdId !== COMMAND.closePath) {
      throw new Error(`Unsupported geometry command: ${item.command}`);
    }

    if (cmdId === COMMAND.closePath) {
      groups.push({ command: COMMAND.closePath, count: 1, points: [] });
      currentGroup = null;
    } else {
      if (!Number.isFinite(item.x) || !Number.isFinite(item.y)) {
        throw new Error(`Invalid coordinates for command ${item.command}: (${item.x}, ${item.y})`);
      }
      if (currentGroup && currentGroup.command === cmdId) {
        currentGroup.count += 1;
        currentGroup.points.push(item.x, item.y);
      } else {
        currentGroup = { command: cmdId, count: 1, points: [item.x, item.y] };
        groups.push(currentGroup);
      }
    }
  }

  // 바이트 크기 사전 계산
  let estimatedBytes = 0;
  let cursorX = 0;
  let cursorY = 0;

  for (const group of groups) {
    estimatedBytes += varintByteLength(encodeCommandInteger(group.command, group.count));
    if (group.command === COMMAND.moveTo || group.command === COMMAND.lineTo) {
      for (let i = 0; i < group.points.length; i += 2) {
        const intX = Math.round(group.points[i] * SCALE);
        const intY = Math.round(group.points[i + 1] * SCALE);
        const dx = intX - cursorX;
        const dy = intY - cursorY;
        cursorX = intX;
        cursorY = intY;
        estimatedBytes += varintByteLength(encodeZigZag(dx));
        estimatedBytes += varintByteLength(encodeZigZag(dy));
      }
    }
  }

  if (estimatedBytes > maxBytes) {
    throw new Error(`Encoded geometry size ${estimatedBytes} bytes exceeds limit of ${maxBytes} bytes`);
  }

  const out = new Uint8Array(estimatedBytes);
  let pos = 0;
  cursorX = 0;
  cursorY = 0;

  for (const group of groups) {
    const cmdInt = encodeCommandInteger(group.command, group.count);
    pos = writeVarint(out, pos, cmdInt);

    if (group.command === COMMAND.moveTo || group.command === COMMAND.lineTo) {
      for (let i = 0; i < group.points.length; i += 2) {
        const intX = Math.round(group.points[i] * SCALE);
        const intY = Math.round(group.points[i + 1] * SCALE);
        const dx = intX - cursorX;
        const dy = intY - cursorY;
        cursorX = intX;
        cursorY = intY;
        pos = writeVarint(out, pos, encodeZigZag(dx));
        pos = writeVarint(out, pos, encodeZigZag(dy));
      }
    }
  }

  return out.subarray(0, pos);
}

/**
 * 인코딩된 기하 바이트를 디코딩하여 명령 배열을 반환한다.
 * @param {Uint8Array} bytes
 * @param {{ maxVertices?: number, maxBytes?: number }} options
 * @returns {Array<{ command: string, x?: number, y?: number }>}
 */
export function decodeGeometry(bytes, {
  maxVertices = DEFAULT_MAX_VERTICES,
  maxBytes = DEFAULT_MAX_BYTES,
} = {}) {
  if (!(bytes instanceof Uint8Array)) {
    throw new Error("bytes must be a Uint8Array");
  }
  if (bytes.byteLength > maxBytes) {
    throw new Error(`Geometry byte length ${bytes.byteLength} exceeds limit of ${maxBytes}`);
  }

  const commands = [];
  let pos = 0;
  let cursorX = 0;
  let cursorY = 0;
  let vertexCount = 0;

  while (pos < bytes.length) {
    const { value: cmdInt, bytesRead: cmdBytes } = readVarint(bytes, pos);
    pos += cmdBytes;

    const { command, count } = decodeCommandInteger(cmdInt);

    if (command === COMMAND.closePath) {
      for (let i = 0; i < count; i += 1) {
        commands.push({ command: "closePath" });
      }
    } else if (command === COMMAND.moveTo || command === COMMAND.lineTo) {
      const cmdName = command === COMMAND.moveTo ? "moveTo" : "lineTo";
      for (let i = 0; i < count; i += 1) {
        vertexCount += 1;
        if (vertexCount > maxVertices) {
          throw new Error(`Decoded vertices ${vertexCount} exceeds limit of ${maxVertices}`);
        }

        const { value: zzX, bytesRead: xBytes } = readVarint(bytes, pos);
        pos += xBytes;
        const { value: zzY, bytesRead: yBytes } = readVarint(bytes, pos);
        pos += yBytes;

        const dx = decodeZigZag(zzX);
        const dy = decodeZigZag(zzY);
        cursorX += dx;
        cursorY += dy;

        commands.push({
          command: cmdName,
          x: cursorX / SCALE,
          y: cursorY / SCALE,
        });
      }
    } else {
      throw new Error(`Unknown geometry command ID ${command}`);
    }
  }

  return commands;
}
