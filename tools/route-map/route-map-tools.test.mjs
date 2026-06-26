import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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

test("route map position audit passes clean catalog fixture", async () => {
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      "tools/route-map/audit-route-map.mjs",
      "--fixture",
      "tools/datapack/fixtures/catalog-fixture.json",
      "--fail-on",
      "BLOCKER,HIGH",
    ],
    { cwd: root, maxBuffer: 1024 * 1024 },
  );
  const output = JSON.parse(stdout);

  assert.equal(output.schemaVersion, 1);
  assert.equal(output.artifactKind, "route-map-position-audit");
  assert.equal(output.summary.packCount, 1);
  assert.equal(output.summary.findingsBySeverity.BLOCKER, 0);
  assert.equal(output.summary.findingsBySeverity.HIGH, 0);
  assert.equal(output.packs[0].summary.stationLineCount, 9);
  assert.equal(output.packs[0].summary.routeMapPositionCount, 9);
  assert.equal(output.packs[0].summary.coverageRatio, 1);
});

test("route map position audit reports broken production geometry rows", async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), "easysubway-route-map-audit-"));
  try {
    const fixturePath = path.join(tmp, "broken-catalog-fixture.json");
    const fixture = JSON.parse(
      await readFile(
        path.join(root, "tools/datapack/fixtures/catalog-fixture.json"),
        "utf8",
      ),
    );
    const pack = fixture.packs[0];
    const removedPosition = pack.routeMapPositions.shift();
    pack.routeMapPositions.push({
      ...removedPosition,
      stationId: "station-ghost",
    });
    const sadangLine2 = pack.routeMapPositions.find(
      (row) => row.stationId === "station-sadang" && row.lineId === "seoul-2",
    );
    const gangnamLine2 = pack.routeMapPositions.find(
      (row) => row.stationId === "station-gangnam" && row.lineId === "seoul-2",
    );
    gangnamLine2.x = sadangLine2.x;
    gangnamLine2.y = sadangLine2.y;
    const jeongja = pack.routeMapPositions.find(
      (row) => row.stationId === "station-jeongja",
    );
    jeongja.sourceId = "";
    jeongja.sourceUrl = "";
    delete jeongja.reviewedAt;
    await writeFile(fixturePath, JSON.stringify(fixture), "utf8");

    await assert.rejects(
      execFileAsync(
        process.execPath,
        [
          "tools/route-map/audit-route-map.mjs",
          "--fixture",
          fixturePath,
          "--fail-on",
          "BLOCKER,HIGH",
        ],
        { cwd: root, maxBuffer: 1024 * 1024 },
      ),
      (error) => {
        const output = JSON.parse(error.stdout);
        assert.equal(output.summary.findingsBySeverity.BLOCKER, 2);
        assert.equal(output.summary.findingsBySeverity.HIGH, 3);
        assert.deepEqual(
          output.findings.map((finding) => finding.code).sort(),
          [
            "DUPLICATE_SOURCE_COORDINATE",
            "MISSING_ROUTE_MAP_POSITION",
            "MISSING_ROUTE_MAP_REVIEW",
            "MISSING_ROUTE_MAP_SOURCE",
            "ROUTE_MAP_POSITION_WITHOUT_STATION_LINE",
          ],
        );
        return true;
      },
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
