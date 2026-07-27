#!/usr/bin/env node
// 오너 SVG의 **실측 잉크 bbox**를 headless Chrome으로 구하고, CI 게이트가 쓰는
// 순수 JS 계산(`svg-ink-bbox.mjs`)과 나란히 대조한다.
//
// 왜 둘 다 두나: 게이트는 브라우저 없이 돌아야 해서 순수 JS로 재지만, 그 계산이
// 실제 렌더와 어긋나면 게이트가 헛돈다. 이 스크립트가 두 값을 함께 찍으므로
// 크롭 값을 정하거나 게이트를 손볼 때 근거로 쓴다(#2603 실측에서 두 값의 차이는
// 5권역 전부 ±1.8단위 이내였다).
//
// 제외 요소 집합은 `svg-ink-bbox.mjs`의 FULL_CANVAS_DECOR_IDS를 그대로 import해
// 쓴다 — 여기서 따로 하드코딩하면 게이트와 측정이 갈라진다.
//
// 사용법:
//   node tools/route-map/svg-crop/measure-ink-bbox.mjs           # 5권역 전부
//   node tools/route-map/svg-crop/measure-ink-bbox.mjs gwangju   # 권역 지정
//   CHROME_BIN=/path/to/chrome node …                            # 브라우저 지정

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import { normalizeSvgForCompile } from "../compile-basemap-vec.mjs";
import { FULL_CANVAS_DECOR_IDS, inkBBoxOf, viewBoxOf } from "../svg-ink-bbox.mjs";
import { outDir, REGIONS as REGION_FILES, svgPathFor } from "./regions.mjs";

/** 실행할 브라우저. 실제 파일인지 확인해 임의 명령 실행을 막는다. */
function resolveChrome() {
  const candidate =
    process.env.CHROME_BIN ??
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const resolved = path.resolve(candidate);
  if (!existsSync(resolved) || !statSync(resolved).isFile()) {
    throw new Error(`브라우저 실행 파일을 찾지 못했습니다: ${resolved}`);
  }
  return resolved;
}

const CHROME = resolveChrome();

const REGIONS = Object.keys(REGION_FILES).map((id) => ({ id }));

/** 브라우저 안에서 도는 측정식. 전면 배경·그리드는 빼고 잉크만 union한다. */
function measureExpression(excludeIds) {
  return `
(async () => {
  const out = { ok: false };
  try {
    await document.fonts.ready;
    const svg = document.querySelector('svg#target');
    const inv = svg.getScreenCTM().inverse();
    const pt = svg.createSVGPoint();
    const toUser = (x, y) => { pt.x = x; pt.y = y; const p = pt.matrixTransform(inv); return { x: p.x, y: p.y }; };
    const EXCLUDE = new Set(${JSON.stringify(excludeIds)});
    const SKIP = new Set(['defs','clippath','mask','pattern','marker','symbol','title','desc','metadata','style','script','lineargradient','radialgradient','stop','filter']);
    const skipped = new Set();
    for (const el of svg.querySelectorAll('*')) {
      const tag = el.tagName.toLowerCase().replace(/^.*:/, '');
      if ((el.id && EXCLUDE.has(el.id)) || SKIP.has(tag)) {
        skipped.add(el);
        for (const d of el.querySelectorAll('*')) skipped.add(d);
      }
    }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const el of svg.querySelectorAll('*')) {
      if (skipped.has(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      const a = toUser(r.left, r.top), b = toUser(r.right, r.bottom);
      minX = Math.min(minX, a.x, b.x); maxX = Math.max(maxX, a.x, b.x);
      minY = Math.min(minY, a.y, b.y); maxY = Math.max(maxY, a.y, b.y);
    }
    out.ok = true;
    out.ink = { minX, minY, maxX, maxY };
  } catch (e) { out.error = String(e && e.stack || e); }
  document.documentElement.innerHTML =
    '<head></head><body><pre id="RESULT">' +
    JSON.stringify(out).replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</pre></body>';
})();
`;
}

function chromeInkBBox(svgText) {
  const [, , vbw, vbh] = viewBoxOf(svgText);
  let inlined = svgText
    .replaceAll(/<\?xml[\s\S]*?\?>/g, "")
    .replaceAll(/<!DOCTYPE[\s\S]*?>/g, "")
    .replace(/<svg\b/, '<svg id="target"');
  inlined = inlined
    .replace(/(<svg\b[^>]*?)\swidth\s*=\s*"[^"]*"/, "$1")
    .replace(/(<svg\b[^>]*?)\sheight\s*=\s*"[^"]*"/, "$1")
    .replace(/<svg\b/, `<svg width="${vbw}" height="${vbh}"`);

  const html =
    `<!doctype html><html><head><meta charset="utf-8"><style>` +
    `html,body{margin:0;padding:0;background:#fff}` +
    `svg#target{display:block;width:${vbw}px;height:${vbh}px}</style></head>` +
    `<body>${inlined}<script>${measureExpression(FULL_CANVAS_DECOR_IDS)}</script></body></html>`;

  mkdirSync(outDir, { recursive: true });
  const htmlPath = path.join(outDir, "measure-ink-bbox.html");
  writeFileSync(htmlPath, html);
  const dom = execFileSync(
    CHROME,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--hide-scrollbars",
      "--force-device-scale-factor=1",
      `--window-size=${Math.min(vbw, 4000)},${Math.min(vbh, 4000)}`,
      "--virtual-time-budget=30000",
      "--run-all-compositor-stages-before-draw",
      "--dump-dom",
      `file://${htmlPath}`,
    ],
    {
      maxBuffer: 1024 * 1024 * 512,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  const match = dom.match(/<pre id="RESULT">([\s\S]*?)<\/pre>/);
  if (!match) throw new Error("브라우저 측정 결과를 찾지 못했습니다.");
  const parsed = JSON.parse(
    match[1].replaceAll("&lt;", "<").replaceAll("&amp;", "&"),
  );
  if (!parsed.ok) throw new Error(`브라우저 측정 실패: ${parsed.error}`);
  return parsed.ink;
}

const only = process.argv[2];
const targets = only ? REGIONS.filter((r) => r.id === only) : REGIONS;
if (targets.length === 0) {
  console.error(`알 수 없는 권역: ${only}`);
  process.exit(2);
}

const f = (v) => v.toFixed(2).padStart(9);
console.log(
  "region     viewBox                 여유 L/T/R/B (Chrome 실측)                       순수JS Δ maxX/maxY",
);
for (const region of targets) {
  const raw = readFileSync(svgPathFor(region.id), "utf8");
  const normalized = normalizeSvgForCompile(raw);
  const [vx, vy, vw, vh] = viewBoxOf(raw);
  const chrome = chromeInkBBox(raw);
  const pure = inkBBoxOf(normalized, { excludeIds: FULL_CANVAS_DECOR_IDS });
  console.log(
    region.id.padEnd(10) +
      `[${vx} ${vy} ${vw} ${vh}]`.padEnd(24) +
      `L${f(chrome.minX - vx)} T${f(chrome.minY - vy)}` +
      ` R${f(vx + vw - chrome.maxX)} B${f(vy + vh - chrome.maxY)}` +
      `      ${f(pure.maxX - chrome.maxX)} ${f(pure.maxY - chrome.maxY)}`,
  );
}
