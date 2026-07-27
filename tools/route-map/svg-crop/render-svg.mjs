#!/usr/bin/env node
// 오너 SVG를 headless Chrome으로 PNG 렌더한다(#2603 잉크 무손실 검증용).
//
//   node tools/route-map/svg-crop/render-svg.mjs <region> [--ref <git-ref>] \
//        [--scale N] [--ink]
//
//   --ref  : 작업 트리 대신 그 git ref의 SVG를 렌더한다(크롭 전후 비교용).
//   --ink  : 전면 배경·그리드를 숨기고 투명 배경으로 그린다 → alpha>0이 곧 잉크다.
//            크롭 전후 비교(verify-ink-lossless.py)는 이 모드 산출물을 쓴다.
//
// 산출물은 `tools/route-map/svg-crop/.out/<region>-<ref>[-ink].png`다.
// 경로를 인자로 받지 않는 이유는 regions.mjs 주석 참조.

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import {
  assertSafeRef,
  outDir,
  repoRelativeSvg,
  repoRoot,
  svgPathFor,
} from "./regions.mjs";

/** PATH 조회 없이 고정 경로로 git을 찾는다(PATH 오염 차단). */
function resolveGit() {
  for (const candidate of ["/usr/bin/git", "/opt/homebrew/bin/git", "/usr/local/bin/git"]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  throw new Error("git 실행 파일을 고정 경로에서 찾지 못했습니다.");
}

/**
 * `.out/` 안으로만 해석되는 산출물 경로를 만든다.
 * 구성 요소가 검증된 값이어도 최종 경로를 한 번 더 확인한다 — 파일 시스템에
 * 닿기 전에 경계를 벗어나지 않았음을 여기서 단정한다.
 */
function outPathFor(fileName) {
  const base = path.basename(fileName);
  const resolved = path.resolve(outDir, base);
  const root = path.resolve(outDir);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`산출물 경로가 .out/ 밖입니다: ${resolved}`);
  }
  return resolved;
}

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

function flagValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

const region = process.argv[2];
if (!region || region.startsWith("--")) {
  console.error(
    "사용법: render-svg.mjs <region> [--ref <git-ref>] [--scale N] [--ink]",
  );
  process.exit(2);
}
const inkOnly = process.argv.includes("--ink");
const ref = flagValue("--ref", null);
const scale = Number(flagValue("--scale", "1"));
if (!Number.isFinite(scale) || scale <= 0) {
  throw new Error(`scale이 유효하지 않습니다: ${scale}`);
}

/** 작업 트리 또는 지정 ref에서 SVG 원문을 읽는다. */
function readSvg() {
  if (!ref) return readFileSync(svgPathFor(region), "utf8");
  return execFileSync(
    resolveGit(),
    ["show", `${assertSafeRef(ref)}:${repoRelativeSvg(region)}`],
    { cwd: repoRoot(), encoding: "utf8", maxBuffer: 1024 * 1024 * 64 },
  );
}

const svgText = readSvg()
  .replaceAll("﻿", "")
  .replaceAll(/<\?xml[\s\S]*?\?>/g, "")
  .replaceAll(/<!DOCTYPE[\s\S]*?>/g, "");

const viewBox = svgText.match(/viewBox\s*=\s*"([^"]+)"/);
if (!viewBox) throw new Error(`${region}: viewBox를 찾지 못했습니다.`);
const [, , vbw, vbh] = viewBox[1].trim().split(/[\s,]+/).map(Number);
const width = Math.round(vbw * scale);
const height = Math.round(vbh * scale);

let inlined = svgText.replace(/<svg\b/, '<svg id="target"');
inlined = inlined
  .replace(/(<svg\b[^>]*?)\swidth\s*=\s*"[^"]*"/, "$1")
  .replace(/(<svg\b[^>]*?)\sheight\s*=\s*"[^"]*"/, "$1")
  .replace(/<svg\b/, `<svg width="${width}" height="${height}"`);

const inkCss = inkOnly
  ? "#page-background,#background-grid-overlay{display:none !important}" +
    "html,body{background:transparent !important}"
  : "html,body{background:#fff}";

const html =
  `<!doctype html><html><head><meta charset="utf-8"><style>` +
  `*{margin:0;padding:0}` +
  `html,body{width:${width}px;height:${height}px;overflow:hidden}` +
  `svg#target{display:block;width:${width}px;height:${height}px}` +
  `${inkCss}</style></head><body>${inlined}</body></html>`;

mkdirSync(outDir, { recursive: true });
// stem 구성 요소는 전부 검증을 통과한 값이지만(region은 고정 표의 키, ref는
// assertSafeRef 통과), 최종 경로는 outPathFor가 다시 .out/ 안인지 확인한다.
const refPart = ref ? ref.replaceAll(/[^\w.-]/g, "_") : "working";
const stem = `${region}-${refPart}${inkOnly ? "-ink" : ""}`;
const outPng = outPathFor(`${stem}.png`);

// 브라우저에 넘기는 인자는 **고정 경로**만 쓴다. 최종 파일명은 렌더가 끝난 뒤
// 파일 시스템 API로 옮긴다 — CLI에서 온 문자열이 OS 명령 인자에 닿지 않는다.
const workHtml = path.resolve(outDir, "render-input.html");
const workPng = path.resolve(outDir, "render-output.png");
writeFileSync(workHtml, html);

const args = [
  "--headless=new",
  "--disable-gpu",
  "--no-sandbox",
  "--hide-scrollbars",
  "--force-device-scale-factor=1",
  `--window-size=${width},${height}`,
  "--virtual-time-budget=60000",
  "--run-all-compositor-stages-before-draw",
  `--screenshot=${workPng}`,
];
if (inkOnly) args.push("--default-background-color=00000000");
args.push(`file://${workHtml}`);

execFileSync(resolveChrome(), args, { stdio: ["ignore", "ignore", "ignore"] });
renameSync(workPng, outPng);
console.log(`${outPng}  ${width}x${height}  scale=${scale}  ink=${inkOnly}`);
