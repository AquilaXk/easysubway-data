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

test("route map position audit allows same station-line in another region", async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), "easysubway-route-map-audit-"));
  try {
    const fixturePath = path.join(tmp, "multi-region-catalog-fixture.json");
    const fixture = JSON.parse(
      await readFile(
        path.join(root, "tools/datapack/fixtures/catalog-fixture.json"),
        "utf8",
      ),
    );
    const pack = fixture.packs[0];
    const sangnoksu = pack.routeMapPositions.find(
      (row) => row.stationId === "station-sangnoksu",
    );
    pack.routeMapPositions.push({
      ...sangnoksu,
      region: "전국",
      x: sangnoksu.x + 1000,
      y: sangnoksu.y + 1000,
    });
    await writeFile(fixturePath, JSON.stringify(fixture), "utf8");

    const { stdout } = await execFileAsync(
      process.execPath,
      [
        "tools/route-map/audit-route-map.mjs",
        "--fixture",
        fixturePath,
        "--fail-on",
        "BLOCKER,HIGH",
      ],
      { cwd: root, maxBuffer: 1024 * 1024 },
    );
    const output = JSON.parse(stdout);

    assert.equal(output.summary.findingsBySeverity.BLOCKER, 0);
    assert.equal(output.summary.findingsBySeverity.HIGH, 0);
    assert.equal(output.packs[0].summary.stationLineCount, 9);
    assert.equal(output.packs[0].summary.routeMapPositionCount, 10);
    assert.equal(output.packs[0].summary.coverageRatio, 1);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("route map position audit reports missing source snapshot hash", async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), "easysubway-route-map-audit-"));
  try {
    const fixturePath = path.join(tmp, "missing-source-sha-fixture.json");
    const fixture = JSON.parse(
      await readFile(
        path.join(root, "tools/datapack/fixtures/catalog-fixture.json"),
        "utf8",
      ),
    );
    delete fixture.packs[0].routeMapPositions[0].sourceSha256;
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
        assert.equal(output.summary.findingsBySeverity.HIGH, 1);
        assert.equal(output.findings[0].code, "MISSING_ROUTE_MAP_SOURCE_SHA");
        return true;
      },
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("route map position audit downgrades reviewed duplicate coordinates", async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), "easysubway-route-map-audit-"));
  try {
    const fixturePath = path.join(tmp, "duplicate-coordinate-fixture.json");
    const reviewedPath = path.join(tmp, "reviewed-ambiguities.json");
    const fixture = JSON.parse(
      await readFile(
        path.join(root, "tools/datapack/fixtures/catalog-fixture.json"),
        "utf8",
      ),
    );
    const pack = fixture.packs[0];
    const sadangLine2 = pack.routeMapPositions.find(
      (row) => row.stationId === "station-sadang" && row.lineId === "seoul-2",
    );
    const gangnamLine2 = pack.routeMapPositions.find(
      (row) => row.stationId === "station-gangnam" && row.lineId === "seoul-2",
    );
    gangnamLine2.x = sadangLine2.x;
    gangnamLine2.y = sadangLine2.y;
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
        assert.equal(output.summary.findingsBySeverity.HIGH, 1);
        assert.equal(output.findings[0].code, "DUPLICATE_SOURCE_COORDINATE");
        return true;
      },
    );

    await writeFile(
      reviewedPath,
      JSON.stringify({
        reviewedAmbiguities: [
          {
            region: "수도권",
            lineId: "seoul-2",
            x: sadangLine2.x,
            y: sadangLine2.y,
            stationIds: ["station-gangnam", "station-sadang"],
            reason: "fixture 검수에서 같은 source 좌표가 의도된 경우로 확인",
            reviewedAt: "2026-06-26T00:00:00.000Z",
            reviewedBy: "QA",
            reviewSource: "fixture-review-note",
          },
        ],
      }),
      "utf8",
    );

    const { stdout } = await execFileAsync(
      process.execPath,
      [
        "tools/route-map/audit-route-map.mjs",
        "--fixture",
        fixturePath,
        "--reviewed-ambiguities",
        reviewedPath,
        "--fail-on",
        "BLOCKER,HIGH",
      ],
      { cwd: root, maxBuffer: 1024 * 1024 },
    );
    const output = JSON.parse(stdout);

    assert.equal(output.summary.findingsBySeverity.HIGH, 0);
    assert.equal(output.summary.findingsBySeverity.INFO, 1);
    assert.equal(output.findings[0].code, "REVIEWED_AMBIGUITY");
    assert.match(output.findings[0].message, /QA/);
    assert.match(output.findings[0].message, /fixture-review-note/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("route map position audit rejects reviewed ambiguity without provenance", async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), "easysubway-route-map-audit-"));
  try {
    const fixturePath = path.join(tmp, "duplicate-coordinate-fixture.json");
    const reviewedPath = path.join(tmp, "reviewed-ambiguities.json");
    const fixture = JSON.parse(
      await readFile(
        path.join(root, "tools/datapack/fixtures/catalog-fixture.json"),
        "utf8",
      ),
    );
    const pack = fixture.packs[0];
    const sadangLine2 = pack.routeMapPositions.find(
      (row) => row.stationId === "station-sadang" && row.lineId === "seoul-2",
    );
    const gangnamLine2 = pack.routeMapPositions.find(
      (row) => row.stationId === "station-gangnam" && row.lineId === "seoul-2",
    );
    gangnamLine2.x = sadangLine2.x;
    gangnamLine2.y = sadangLine2.y;
    await writeFile(fixturePath, JSON.stringify(fixture), "utf8");
    await writeFile(
      reviewedPath,
      JSON.stringify({
        reviewedAmbiguities: [
          {
            region: "수도권",
            lineId: "seoul-2",
            x: sadangLine2.x,
            y: sadangLine2.y,
            stationIds: ["station-gangnam", "station-sadang"],
            reason: "fixture 검수에서 같은 source 좌표가 의도된 경우로 확인",
            reviewedAt: "2026-06-26T00:00:00.000Z",
          },
        ],
      }),
      "utf8",
    );

    await assert.rejects(
      execFileAsync(
        process.execPath,
        [
          "tools/route-map/audit-route-map.mjs",
          "--fixture",
          fixturePath,
          "--reviewed-ambiguities",
          reviewedPath,
          "--fail-on",
          "BLOCKER,HIGH",
        ],
        { cwd: root, maxBuffer: 1024 * 1024 },
      ),
      (error) => {
        assert.match(
          error.stderr,
          /must include reason, reviewedAt, reviewedBy, and reviewSource/,
        );
        return true;
      },
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
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
    jeongja.x = -1;
    jeongja.sourceId = "";
    jeongja.sourceUrl = "";
    delete jeongja.reviewedAt;
    gangnamLine2.labelPolygon = [
      { x: 1, y: 1 },
      { x: 2, y: 2 },
    ];
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
        assert.equal(output.summary.findingsBySeverity.BLOCKER, 4);
        assert.equal(output.summary.findingsBySeverity.HIGH, 3);
        assert.deepEqual(
          output.findings.map((finding) => finding.code).sort(),
          [
            "DUPLICATE_SOURCE_COORDINATE",
            "INVALID_ROUTE_MAP_COORDINATE",
            "INVALID_ROUTE_MAP_LABEL_POLYGON",
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

test("MOLIT nationwide fixture builder emits route map source hashes", async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), "easysubway-route-map-source-sha-"));
  try {
    const fixturePath = path.join(tmp, "generated-production-fixture.json");
    await execFileAsync(
      process.execPath,
      [
        "tools/datapack/build-molit-nationwide-fixture.mjs",
        "--csv",
        "tools/datapack/sources/molit-urban-rail-full-route-20251211.csv",
        "--svg-csv",
        "tools/datapack/sources/molit-rail-station-svg-route-20250811.csv",
        "--seoulmetro-js",
        "tools/datapack/sources/seoulmetro-cyberstation-line-data-20260623.js",
        "--humetro-html",
        "tools/datapack/sources/humetro-cyberstation-map-20260623.html",
        "--humetro-css",
        "tools/datapack/sources/humetro-cyber-station-20250310c.css",
        "--grtc-html",
        "tools/datapack/sources/grtc-cyber-simple-20260623.html",
        "--dtro-html",
        "tools/datapack/sources/dtro-cyberstation-20260623.html",
        "--djtc-html",
        "tools/datapack/sources/djtc-cyberstation-20260623.html",
        "--djtc-css",
        "tools/datapack/sources/djtc-content-20260623.css",
        "--output",
        fixturePath,
      ],
      { cwd: root, maxBuffer: 1024 * 1024 },
    );

    const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
    const pack = fixture.packs[0];
    const routePosition = pack.routeMapPositions.find(
      (row) => row.sourceId === "seoulmetro-cyberstation",
    );
    const source = pack.sourceInventory.find(
      (row) => row.id === "seoulmetro-cyberstation",
    );
    const expectedSha = createHash("sha256")
      .update(
        await readFile(
          path.join(root, "tools/datapack/sources/seoulmetro-cyberstation-line-data-20260623.js"),
        ),
      )
      .digest("hex");

    assert.match(routePosition.sourceSha256, /^[a-f0-9]{64}$/);
    assert.equal(routePosition.sourceSha256, expectedSha);
    assert.equal(source.sourceSha256, expectedSha);

    const { stdout } = await execFileAsync(
      process.execPath,
      [
        "tools/route-map/audit-route-map.mjs",
        "--fixture",
        fixturePath,
        "--reviewed-ambiguities",
        "tools/route-map/fixtures/reviewed-ambiguities.json",
        "--fail-on",
        "BLOCKER,HIGH",
      ],
      { cwd: root, maxBuffer: 1024 * 1024 },
    );
    const audit = JSON.parse(stdout);

    assert.equal(audit.packs[0].summary.coverageRatio, 1);
    assert.equal(audit.summary.findingsBySeverity.BLOCKER, 0);
    assert.equal(audit.summary.findingsBySeverity.HIGH, 0);
    assert.equal(audit.summary.findingsBySeverity.INFO, 2);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
