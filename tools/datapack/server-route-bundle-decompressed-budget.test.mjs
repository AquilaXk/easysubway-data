import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { constants, zstdCompressSync } from "node:zlib";

import {
  E_SERVER_BUNDLE_DECOMPRESSED_BUDGET,
  evaluateDecompressedBudget,
} from "./build-server-route-bundle-final.mjs";

const CONTRACT_PATH = "contracts/datapack/server-route-bundle-build-contract.json";
const SCHEMA_PATH = "contracts/datapack/server-route-bundle-build-contract.schema.json";

test("server route bundle build contract pins maxTotalDecompressedBytes to 201326592 with explanation", () => {
  const contract = JSON.parse(readFileSync(CONTRACT_PATH, "utf8"));
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));

  assert.equal(contract.maxTotalDecompressedBytes, 201326592);
  assert.equal(typeof contract.maxTotalDecompressedBytesDescription, "string");
  assert.match(
    contract.maxTotalDecompressedBytesDescription,
    /RouteBundleSqliteRuntimeCompiler\.MAX_TOTAL_DECOMPRESSED_BYTES/,
  );
  assert.match(
    contract.maxTotalDecompressedBytesDescription,
    /backend\/src\/main\/java\/com\/easysubway\/journey\/bundle\/RouteBundleSqliteRuntimeCompiler\.java/,
  );
  assert.deepEqual(schema.const, contract);
});

test("evaluateDecompressedBudget verifies components against budget", () => {
  const compress = (buf) => zstdCompressSync(buf, {
    params: {
      [constants.ZSTD_c_compressionLevel]: 10,
      [constants.ZSTD_c_checksumFlag]: 1,
    },
  });

  const payloadBytesByComponent = {
    accessibility: compress(Buffer.alloc(8192, 1)),
    fare: compress(Buffer.from("fare payload")),
    timetable: compress(Buffer.from("timetable payload")),
    topology: compress(Buffer.from("topology payload")),
  };

  const expectedSizes = {
    accessibility: 8192,
    fare: 12,
    timetable: 17,
    topology: 16,
  };
  const expectedTotal = 8192 + 12 + 17 + 16; // 8237

  // (1) 합계 = 한도 -> 통과
  const passResult = evaluateDecompressedBudget(payloadBytesByComponent, expectedTotal);
  assert.equal(passResult.totalBytes, expectedTotal);
  assert.equal(passResult.maxTotalBytes, expectedTotal);
  assert.equal(passResult.headroomBytes, 0);
  assert.equal(passResult.headroomRatio, 0);
  assert.deepEqual(passResult.components, expectedSizes);

  // (2) 합계 = 한도 + 1 -> 지정 오류 코드로 실패
  assert.throws(
    () => evaluateDecompressedBudget(payloadBytesByComponent, expectedTotal - 1),
    (err) => {
      assert.equal(err.code, E_SERVER_BUNDLE_DECOMPRESSED_BUDGET);
      assert.match(err.message, /E_SERVER_BUNDLE_DECOMPRESSED_BUDGET/);
      return true;
    },
  );
});
