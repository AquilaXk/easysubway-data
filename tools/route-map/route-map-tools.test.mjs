import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "../..");

test("SVG geometry extractor returns transformed visible text polygons", async () => {
  const fixture = "tools/route-map/fixtures/geometry-fixture.svg";
  const { stdout } = await execFileAsync(
    process.execPath,
    ["tools/route-map/extract-svg-geometry.mjs", fixture, "--region", "fixture"],
    { cwd: root, maxBuffer: 1024 * 1024 },
  );
  const output = JSON.parse(stdout);
  const source = await readFile(path.join(root, fixture), "utf8");

  assert.equal(output.schemaVersion, 1);
  assert.equal(output.region, "fixture");
  assert.equal(output.extractorVersion, "route-map-svg-geometry-v1");
  assert.equal(output.sourceSvgSha256, createHash("sha256").update(source).digest("hex"));
  assert.deepEqual(output.sourceViewBox, [0, 0, 200, 120]);
  assert.match(output.browser.version, /Chrome|Chromium/i);

  const texts = output.labels.map((label) => label.sourceText).sort();
  assert.deepEqual(texts, ["1호선", "Not to scale", "알파역", "회전역"]);
  for (const hiddenText of ["숨김역", "투명역", "비가시역", "레이어숨김역", "템플릿역"]) {
    assert.equal(output.labels.find((label) => label.sourceText === hiddenText), undefined);
  }

  const line = output.labels.find((label) => label.sourceText === "1호선");
  assert.equal(line.classification, "LINE_LABEL");
  const notice = output.labels.find((label) => label.sourceText === "Not to scale");
  assert.equal(notice.classification, "NOTICE");

  const alpha = output.labels.find((label) => label.sourceText === "알파역");
  assert.equal(alpha.classification, "STATION_LABEL");
  assert.match(alpha.sourceElementKey, /^[a-f0-9]{64}$/);
  assert.equal(alpha.polygon.length, 4);
  assert.ok(alpha.bounds.maxX > alpha.bounds.minX);
  assert.ok(alpha.bounds.maxY > alpha.bounds.minY);

  const rotated = output.labels.find((label) => label.sourceText === "회전역");
  assert.notEqual(rotated.polygon[0].y, rotated.polygon[1].y);
  assert.notEqual(rotated.polygon[0].x, rotated.polygon[3].x);
});
