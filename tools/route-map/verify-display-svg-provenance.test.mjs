import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { tmpdir } from "node:os";

import { verifyDisplaySvgProvenance } from "./verify-display-svg-provenance.mjs";

const regions = [
  ["seoul", "easy-subway-sma-v4.svg"],
  ["busan", "easy-subway-busan-v3.svg"],
  ["daegu", "easy-subway-daegu-v3.svg"],
  ["daejeon", "easy-subway-daejeon-v3.svg"],
  ["gwangju", "easy-subway-gwangju-v3.svg"],
];
const sourceDir = "tools/route-map/route-map-defs/svg-sources";
const bundleDir = "apps/mobile/assets/datapacks/metro_map_pack/basemap";
const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const digest = (value) => createHash("sha256").update(value).digest("hex");

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "display-svg-provenance-"));
  const maps = regions.map(([id, file]) => {
    const bytes = Buffer.from(`<svg><path id=\"${id}\"/></svg>\n`);
    const source = `${sourceDir}/${file}`;
    const displaySvg = `${bundleDir}/${id}.svg`;
    const sourcePath = path.join(root, source);
    const displayPath = path.join(root, displaySvg);
    mkdirSync(path.dirname(sourcePath), { recursive: true });
    mkdirSync(path.dirname(displayPath), { recursive: true });
    writeFileSync(sourcePath, bytes);
    writeFileSync(displayPath, bytes);
    return { id, source, displaySvg, sourceSvgSha256: digest(bytes), displaySvgSha256: digest(bytes) };
  });
  writeFileSync(path.join(root, "manifest.json"), `${JSON.stringify({ maps })}\n`);
  return { root, maps };
}

function withFixture(run) {
  const value = fixture();
  try {
    run(value);
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
}

test("verifyDisplaySvgProvenance: canonical source bytes and display bundle bytes must match", () => {
  withFixture(({ root }) => assert.doesNotThrow(() => verifyDisplaySvgProvenance(root, "manifest.json")));
});

test("verifyDisplaySvgProvenance: repository display artifacts match canonical sources", () => {
  assert.doesNotThrow(() => verifyDisplaySvgProvenance());
});

test("Gwangju canonical SVG retains 광주송정역 text without duplicated station accessibility labels", () => {
  const svg = readFileSync(
    path.join(repositoryRoot, sourceDir, "easy-subway-gwangju-v3.svg"),
    "utf8",
  );
  const ariaLabels = [...svg.matchAll(/(?:^|\s)aria-label="([^"]*)"/g)].map((match) => match[1]);

  assert.match(svg, />광주송정역\s*<\/tspan>/);
  assert.deepEqual(ariaLabels.filter((label) => label.includes("역역")), []);
});

test("verifyDisplaySvgProvenance: source byte drift fails", () => {
  withFixture(({ root, maps }) => {
    writeFileSync(path.join(root, maps[0].source), "changed");
    assert.throws(() => verifyDisplaySvgProvenance(root, "manifest.json"), /sourceSvgSha256|byte equality/);
  });
});

test("verifyDisplaySvgProvenance: bundle byte drift fails", () => {
  withFixture(({ root, maps }) => {
    writeFileSync(path.join(root, maps[0].displaySvg), "changed");
    assert.throws(() => verifyDisplaySvgProvenance(root, "manifest.json"), /displaySvgSha256|byte equality/);
  });
});

test("verifyDisplaySvgProvenance: region/output mapping drift fails", () => {
  withFixture(({ root, maps }) => {
    maps[0].displaySvg = `${bundleDir}/busan.svg`;
    writeFileSync(path.join(root, "manifest.json"), `${JSON.stringify({ maps })}\n`);
    assert.throws(() => verifyDisplaySvgProvenance(root, "manifest.json"), /displaySvg path/);
  });
});

test("verifyDisplaySvgProvenance: external SVG subresources fail closed", () => {
  withFixture(({ root, maps }) => {
    const bytes = Buffer.from('<svg><image href="https://example.test/map.png"/></svg>\n');
    writeFileSync(path.join(root, maps[0].source), bytes);
    writeFileSync(path.join(root, maps[0].displaySvg), bytes);
    maps[0].sourceSvgSha256 = digest(bytes);
    maps[0].displaySvgSha256 = digest(bytes);
    writeFileSync(path.join(root, "manifest.json"), `${JSON.stringify({ maps })}\n`);
    assert.throws(() => verifyDisplaySvgProvenance(root, "manifest.json"), /external SVG subresource/);
  });
});

test("verifyDisplaySvgProvenance: self-contained SVG contract rejects dynamic loaders", () => {
  for (const [label, markup] of [
    ["string CSS import", '<svg><style>@import "https://example.test/map.css";</style></svg>\n'],
    ["DOCTYPE", '<!DOCTYPE svg SYSTEM "https://example.test/map.dtd"><svg/>\n'],
    ["ENTITY", '<!ENTITY map SYSTEM "https://example.test/map.ent"><svg/>\n'],
    ["script", "<svg><script>fetch('https://example.test')</script></svg>\n"],
    ["foreignObject", "<svg><foreignObject><div/></foreignObject></svg>\n"],
    ["event handler", '<svg onload="fetch(\'https://example.test/map\')"/>\n'],
    ["event handler boundary", "<svg onbeforematch=\"fetch()\"/>\n"],
    ["SMIL mutation", "<svg><svg:animate attributeName=\"href\"/></svg>\n"],
    ["SMIL discard", "<svg><svg:discard/></svg>\n"],
    ["SMIL animateColor", "<svg><svg:animateColor attributeName=\"fill\"/></svg>\n"],
  ]) {
    withFixture(({ root, maps }) => {
      const bytes = Buffer.from(markup);
      writeFileSync(path.join(root, maps[0].source), bytes);
      writeFileSync(path.join(root, maps[0].displaySvg), bytes);
      maps[0].sourceSvgSha256 = digest(bytes);
      maps[0].displaySvgSha256 = digest(bytes);
      writeFileSync(path.join(root, "manifest.json"), `${JSON.stringify({ maps })}\n`);
      assert.throws(
        () => verifyDisplaySvgProvenance(root, "manifest.json"),
        /external SVG subresource|self-contained SVG/,
        label,
      );
    });
  }
});
