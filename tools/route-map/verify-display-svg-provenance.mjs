#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "../..");
const sourceDir = "tools/route-map/route-map-defs/svg-sources";
const bundleDir = "apps/mobile/assets/datapacks/metro_map_pack/basemap";
const canonicalMaps = new Map([
  ["seoul", "easy-subway-sma-v4.svg"],
  ["busan", "easy-subway-busan-v3.svg"],
  ["daegu", "easy-subway-daegu-v3.svg"],
  ["daejeon", "easy-subway-daejeon-v3.svg"],
  ["gwangju", "easy-subway-gwangju-v3.svg"],
]);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertNoExternalSubresources(bytes, label) {
  const svg = bytes.toString("utf8");
  for (const [pattern, construct] of [
    [/<!DOCTYPE\b/i, "DOCTYPE"],
    [/<!ENTITY\b/i, "ENTITY"],
    [/<script\b/i, "script"],
    [/<foreignObject\b/i, "foreignObject"],
    [/@import\b/i, "CSS @import"],
    // Inkscape namedview metadata, not an event-handler attribute.
    [/(?:^|\s)on(?!ly_selected\s*=)[a-z][\w:.-]*\s*=/i, "event handler attribute"],
    [/<(?:[A-Za-z_][\w.-]*:)?(?:animateColor|animateMotion|animateTransform|animate|set|discard)\b/i, "SMIL mutation element"],
  ]) {
    assert.ok(!pattern.test(svg), `${label}: self-contained SVG forbids ${construct}`);
  }
  const references = [
    ...svg.matchAll(/\b(?:href|xlink:href)\s*=\s*["']([^"']*)["']/gi),
    ...svg.matchAll(/\burl\(\s*["']?([^)'"\s]+)["']?\s*\)/gi),
  ];
  for (const match of references) {
    assert.ok(
      match[1].startsWith("#"),
      `${label}: external SVG subresource is not allowed: ${match[1]}`,
    );
  }
}

export function verifyDisplaySvgProvenance(
  repositoryRoot = root,
  manifestFile = "tools/route-map/basemap-build-manifest.json",
) {
  const manifest = JSON.parse(readFileSync(path.join(repositoryRoot, manifestFile), "utf8"));
  assert.ok(Array.isArray(manifest.maps), "manifest maps must be an array");
  assert.equal(manifest.maps.length, canonicalMaps.size, "manifest map count");
  const seen = new Set();

  for (const map of manifest.maps) {
    assert.equal(typeof map.id, "string", "manifest map id");
    assert.ok(!seen.has(map.id), `duplicate region id: ${map.id}`);
    seen.add(map.id);
    const canonicalSource = canonicalMaps.get(map.id);
    assert.ok(canonicalSource, `unknown region id: ${map.id}`);
    assert.equal(map.source, `${sourceDir}/${canonicalSource}`, `${map.id}: canonical source path`);
    assert.equal(map.displaySvg, `${bundleDir}/${map.id}.svg`, `${map.id}: displaySvg path`);

    const source = readFileSync(path.join(repositoryRoot, map.source));
    const bundle = readFileSync(path.join(repositoryRoot, map.displaySvg));
    assert.equal(sha256(source), map.sourceSvgSha256, `${map.id}: sourceSvgSha256`);
    assert.equal(sha256(bundle), map.displaySvgSha256, `${map.id}: displaySvgSha256`);
    assert.deepEqual(bundle, source, `${map.id}: source and display SVG byte equality`);
    assertNoExternalSubresources(source, `${map.id}: source`);
    assertNoExternalSubresources(bundle, `${map.id}: display bundle`);
  }
  assert.equal(seen.size, canonicalMaps.size, "unique region ids");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  verifyDisplaySvgProvenance();
  process.stdout.write("display SVG provenance verified: 5 regions\n");
}
