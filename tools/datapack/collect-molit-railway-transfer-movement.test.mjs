import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { gzipSync, gunzipSync } from "node:zlib";

import {
  buildMolitRailwayTransferMovementSnapshot,
  runMolitRailwayTransferMovementCollector,
} from "./collect-molit-railway-transfer-movement.mjs";

const HEADER = "철도운영기관코드,선명,역명,환승이동순서,이동내용상세,환승이동내용";
const ROWS = [
  "S1,1호선,가,1,계단,1호선 승강장 이동",
  "S1,1호선,가,2,,",
];

function csv(rows = ROWS, header = HEADER) {
  return Buffer.from(`${header}\r\n${rows.join("\r\n")}\r\n`, "utf8");
}
function options(bytes = csv()) { return { capturedAt: "2026-07-29T00:00:00.000Z", expectedRowCount: 2, expectedRawSha256: createHash("sha256").update(bytes).digest("hex") }; }

test("MOLIT transfer movement collector는 exact schema·순서와 공란을 보존한 deterministic gzip snapshot을 만든다", () => {
  const snapshot = buildMolitRailwayTransferMovementSnapshot({
    bytes: csv(),
    ...options(csv()),
  });

  assert.equal(snapshot.sourceId, "molit-railway-transfer-movement");
  assert.equal(snapshot.snapshotId, "molit-railway-transfer-movement-20250811");
  assert.equal(snapshot.rowCount, 2);
  assert.deepEqual(snapshot.observedRailOperatorCodes, ["S1"]);
  assert.deepEqual(snapshot.columns, HEADER.split(",").map((value) => ({
    철도운영기관코드: "RAIL_OPR_ISTT_CD",
    선명: "LN_NM",
    역명: "STIN_NM",
    환승이동순서: "CHTN_MV_TP_ORDR",
    이동내용상세: "MV_CONT_DTL",
    환승이동내용: "CHTN_MV_CONT",
  })[value]));
  assert.equal(snapshot.rows[1].MV_CONT_DTL, "");
  assert.equal(snapshot.rows[1].CHTN_MV_CONT, "");
  assert.equal(snapshot.credentialRedacted, true);
  assert.equal(snapshot.licenseText, "이용허락범위 제한 없음");
  assert.match(snapshot.rawSha256, /^[0-9a-f]{64}$/);
  assert.match(snapshot.gzipSha256, /^[0-9a-f]{64}$/);
  assert.match(snapshot.sortedContentSha256, /^[0-9a-f]{64}$/);
  assert.equal(gunzipSync(snapshot.gzipBytes).equals(csv()), true);
});

test("MOLIT transfer movement collector는 provider step 순서를 verbatim 보존하고 양의 정수 형식만 검증한다", () => {
  const fixtureOptions = options();
  assert.throws(() => buildMolitRailwayTransferMovementSnapshot({ ...fixtureOptions, bytes: csv(), capturedAt: "2026-07-29" }), /RFC 3339 UTC timestamp/);
  assert.throws(() => buildMolitRailwayTransferMovementSnapshot({ ...fixtureOptions, bytes: csv(), capturedAt: "2025-08-10T23:59:59.999Z" }), /between observedAt and now/);
  assert.throws(() => buildMolitRailwayTransferMovementSnapshot({ ...fixtureOptions, bytes: csv(), capturedAt: "9999-01-01T00:00:00.000Z" }), /between observedAt and now/);
  for (const [bytes, pattern] of [[csv(ROWS, "a,b,c"), /header mismatch/], [csv([ROWS[0]]), /row count mismatch/], [csv([",1호선,가,1,계단,이동", ROWS[1]]), /identity blank/], [csv([ROWS[0], "S1,1호선,가,0,,"]), /invalid step/], [csv([ROWS[0], "S1,1호선,가,one,,"]), /invalid step/]]) assert.throws(() => buildMolitRailwayTransferMovementSnapshot({ ...fixtureOptions, bytes, expectedRawSha256: createHash("sha256").update(bytes).digest("hex") }), pattern);
});

test("MOLIT transfer movement collector CLI는 output gzip과 metadata hash 변조를 거부한다", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "easysubway-molit-transfer-"));
  try {
    const input = path.join(directory, "official.csv");
    const output = path.join(directory, "molit-railway-transfer-movement-20250811.csv.gz");
    await writeFile(input, csv());
    const fixture = { expectedRowCount: 2, expectedRawSha256: createHash("sha256").update(csv()).digest("hex") };
    await assert.rejects(() => runMolitRailwayTransferMovementCollector([
      "--input", input, "--output", path.join(directory, "snapshot.csv.gz"), "--captured-at", "2026-07-29T00:00:00.000Z",
    ], fixture), /canonical snapshot filename/);
    const generated = await runMolitRailwayTransferMovementCollector([
      "--input", input,
      "--output", output,
      "--captured-at", "2026-07-29T00:00:00.000Z",
    ], fixture);
    const metadata = JSON.parse(await readFile(`${output}.json`, "utf8"));
    assert.deepEqual(generated, metadata);
    assert.equal(metadata.gzipPath, path.basename(output));
    await rm(input);
    await assert.rejects(() => runMolitRailwayTransferMovementCollector([
      "--input", input, "--output", output, "--captured-at", "2026-07-29T00:00:00.000Z", "--verify-existing", "ture",
    ], fixture), /--verify-existing must be true/);
    assert.deepEqual(await runMolitRailwayTransferMovementCollector([
      "--input", input, "--output", output, "--captured-at", "2026-07-29T00:00:00.000Z", "--verify-existing", "true",
    ], fixture), metadata);
    const alternateGzip = gzipSync(gunzipSync(await readFile(output)), { level: 1, mtime: 0 });
    const alternateMetadata = {
      ...metadata,
      gzipSha256: createHash("sha256").update(alternateGzip).digest("hex"),
    };
    assert.notEqual(alternateMetadata.gzipSha256, metadata.gzipSha256);
    await writeFile(output, alternateGzip);
    await writeFile(`${output}.json`, JSON.stringify(alternateMetadata));
    assert.deepEqual(await runMolitRailwayTransferMovementCollector([
      "--input", input, "--output", output, "--captured-at", "2026-07-29T00:00:00.000Z", "--verify-existing", "true",
    ], fixture), alternateMetadata);
    await writeFile(`${output}.json`, JSON.stringify({ ...alternateMetadata, rowCount: 3 }));
    await assert.rejects(() => runMolitRailwayTransferMovementCollector([
      "--input", input, "--output", output, "--captured-at", "2026-07-29T00:00:00.000Z", "--verify-existing", "true",
    ], fixture), /metadata mismatch/);
    await writeFile(`${output}.json`, JSON.stringify(alternateMetadata));
    await writeFile(output, Buffer.from("mutated"));
    await assert.rejects(() => runMolitRailwayTransferMovementCollector([
      "--input", input,
      "--output", output,
      "--captured-at", "2026-07-29T00:00:00.000Z",
      "--verify-existing", "true",
    ], fixture), /gzip hash mismatch/);
    const mutatedBytes = csv([ROWS[0], "S1,1호선,가,2,경사로,"]);
    const mutatedGzip = gzipSync(mutatedBytes, { mtime: 0 });
    await writeFile(output, mutatedGzip);
    await writeFile(`${output}.json`, JSON.stringify({
      ...metadata,
      rawSha256: createHash("sha256").update(mutatedBytes).digest("hex"),
      gzipSha256: createHash("sha256").update(mutatedGzip).digest("hex"),
    }));
    await assert.rejects(() => runMolitRailwayTransferMovementCollector([
      "--input", input,
      "--output", output,
      "--captured-at", "2026-07-29T00:00:00.000Z",
      "--verify-existing", "true",
    ], fixture), /raw hash mismatch/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
