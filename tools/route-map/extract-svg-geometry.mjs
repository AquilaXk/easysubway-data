#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFile, execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
// v2: <text> 라벨에 더해 노선 track geometry(line/polyline/polygon/path)를
// root 좌표 정점 목록 + 확정 stroke 색(getComputedStyle)으로 함께 추출한다.
const extractorVersion = "route-map-svg-geometry-v2";

// 이 길이(root 좌표) 미만인 stroke는 노선이 아니라 역 마커 틱/장식으로 보고 버린다.
// seoul SVG의 <line class="SDI">(≈20px 대각선 장식)를 걸러내는 하한이다.
const MIN_STROKE_LENGTH = 24;
// path는 정점 정보가 d 안에 있어 직접 못 읽으므로 등간격으로 재샘플한다(root 좌표 px).
const PATH_SAMPLE_SPACING = 8;

function usage() {
  return `Usage: node tools/route-map/extract-svg-geometry.mjs <svg-file> --region <name> [--browser <path>] [--pretty]

Extract visible SVG <text> bounding polygons and line/polyline/polygon/path
stroke geometry (with computed stroke color) in root SVG coordinates.
`;
}

function parseArgs(argv) {
  const options = { pretty: false, browser: "", region: "" };
  const positionals = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") return { help: true };
    if (arg === "--pretty") {
      options.pretty = true;
    } else if (arg === "--browser") {
      options.browser = argv[++index] ?? "";
    } else if (arg === "--region") {
      options.region = argv[++index] ?? "";
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      positionals.push(arg);
    }
  }
  if (positionals.length !== 1) throw new Error("Exactly one SVG file is required.");
  if (!options.region.trim()) throw new Error("--region is required.");
  return { ...options, svgFile: positionals[0] };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function findBrowser(explicitBrowser) {
  if (explicitBrowser) {
    if (!existsSync(explicitBrowser)) throw new Error(`Browser not found: ${explicitBrowser}`);
    return explicitBrowser;
  }
  const candidates = [
    process.env.CHROME_PATH,
    process.env.BROWSER_PATH,
    "google-chrome-stable",
    "google-chrome",
    "chromium-browser",
    "chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (candidate.includes(path.sep) && existsSync(candidate)) return candidate;
    try {
      execFileSync(candidate, ["--version"], { timeout: 2000, stdio: "ignore" });
      return candidate;
    } catch {
      // Try the next common binary name.
    }
  }
  throw new Error("Chrome/Chromium binary not found. Pass --browser <path> or set CHROME_PATH.");
}

function stripSvgPreamble(svg) {
  return svg.replace(/^\s*<\?xml[\s\S]*?\?>/i, "").replace(/^\s*<!doctype[\s\S]*?>/i, "");
}

function browserExtractorExpression(svg) {
  const svgBase64 = Buffer.from(stripSvgPreamble(svg), "utf8").toString("base64");
  return `(${async function extract(value, config) {
    function decodeBase64Utf8(base64) {
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      return new TextDecoder().decode(bytes);
    }
    function normalizeText(value) {
      return value.normalize("NFKC").trim().replace(/\s+/g, " ");
    }
    function classifyText(element, text) {
      const explicit = element.getAttribute("data-route-map-classification");
      if (explicit) return explicit.toUpperCase();
      if (/not to scale|축척/i.test(text)) return "NOTICE";
      if (/^[0-9A-Za-z가-힣]+호선$/.test(text) || /Line$/i.test(text)) return "LINE_LABEL";
      return "STATION_LABEL";
    }
    function number(value) {
      return Math.round(value * 1000) / 1000;
    }
    function matrixPoint(matrix, x, y) {
      const point = new DOMPoint(x, y).matrixTransform(matrix);
      return { x: number(point.x), y: number(point.y) };
    }
    // matrix의 등방 스케일 근사(root px = local px × scale). path 재샘플 간격 환산용.
    function matrixScale(matrix) {
      return Math.hypot(matrix.a, matrix.b) || 1;
    }
    // getComputedStyle의 "rgb(r,g,b)"/"rgba(r,g,b,a)"를 "#rrggbb"로. 투명/none은 null.
    function normalizeColor(value) {
      const match = /rgba?\(([^)]+)\)/i.exec(value || "");
      if (!match) return null;
      const parts = match[1].split(",").map((part) => Number.parseFloat(part.trim()));
      const [r, g, b, a = 1] = parts;
      if (![r, g, b].every(Number.isFinite) || a <= 0) return null;
      const hex = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
      return `#${hex(r)}${hex(g)}${hex(b)}`;
    }
    function elementClasses(element) {
      if (typeof element.className === "string") return element.className;
      return element.className?.baseVal ?? "";
    }
    // svg 루트 전까지의 조상 체인 — descriptor(sourceElementKey 원천)에 공통 사용.
    function ancestorChain(element) {
      const ancestors = [];
      let current = element.parentElement;
      while (current && current.tagName.toLowerCase() !== "svg") {
        ancestors.push({
          tag: current.tagName.toLowerCase(),
          id: current.id || "",
          className: elementClasses(current),
          transform: current.getAttribute("transform") || "",
        });
        current = current.parentElement;
      }
      return ancestors;
    }
    function descriptorFor(element, text, bbox) {
      return {
        text,
        tag: element.tagName.toLowerCase(),
        id: element.id || "",
        className: elementClasses(element),
        transform: element.getAttribute("transform") || "",
        ancestors: ancestorChain(element),
        bbox: {
          x: number(bbox.x),
          y: number(bbox.y),
          width: number(bbox.width),
          height: number(bbox.height),
        },
      };
    }
    function strokeDescriptor(element, stroke) {
      return {
        tag: element.tagName.toLowerCase(),
        id: element.id || "",
        className: elementClasses(element),
        transform: element.getAttribute("transform") || "",
        stroke,
        ancestors: ancestorChain(element),
      };
    }
    // line/polyline/polygon의 로컬 정점 목록(원본 꺾임점 그대로 보존). path는 별도 재샘플.
    function localVertices(element, tag) {
      if (tag === "line") {
        return [
          { x: Number.parseFloat(element.getAttribute("x1") || "0"), y: Number.parseFloat(element.getAttribute("y1") || "0") },
          { x: Number.parseFloat(element.getAttribute("x2") || "0"), y: Number.parseFloat(element.getAttribute("y2") || "0") },
        ];
      }
      const list = element.points;
      const vertices = [];
      for (let index = 0; index < list.numberOfItems; index += 1) {
        const point = list.getItem(index);
        vertices.push({ x: point.x, y: point.y });
      }
      // polygon은 닫힌 도형 — 마지막→첫 정점 세그먼트를 명시적으로 잇는다.
      if (tag === "polygon" && vertices.length > 1) vertices.push({ ...vertices[0] });
      return vertices;
    }
    function isVisibleText(element, root) {
      if (element.closest("defs")) return false;
      for (let current = element; current; current = current.parentElement) {
        const style = getComputedStyle(current);
        if (style.display === "none" || style.visibility === "hidden") return false;
        if (Number.parseFloat(style.opacity || "1") <= 0) return false;
        if (current === root) break;
      }
      return true;
    }
    function sourceViewBox(root) {
      const viewBox = root.viewBox?.baseVal;
      if (viewBox && viewBox.width > 0 && viewBox.height > 0) {
        return [number(viewBox.x), number(viewBox.y), number(viewBox.width), number(viewBox.height)];
      }
      const width = root.width?.baseVal?.value || root.getBoundingClientRect().width;
      const height = root.height?.baseVal?.value || root.getBoundingClientRect().height;
      return [0, 0, number(width), number(height)];
    }

    document.body.innerHTML = "<div id='host' style='width:1200px;height:900px;margin:0'></div>";
    document.getElementById("host").innerHTML = decodeBase64Utf8(value);
    if (document.fonts?.ready) {
      await Promise.race([document.fonts.ready, new Promise((resolve) => setTimeout(resolve, 250))]);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));

    const root = document.querySelector("#host > svg");
    if (!root) throw new Error("Root <svg> not found.");
    const rootScreenMatrix = root.getScreenCTM();
    if (!rootScreenMatrix) throw new Error("Root SVG screen matrix not available.");
    const rootInverse = rootScreenMatrix.inverse();
    const labels = [];

    for (const element of root.querySelectorAll("text")) {
      const sourceText = normalizeText(element.textContent || "");
      if (!sourceText || !isVisibleText(element, root)) continue;
      let bbox;
      try {
        bbox = element.getBBox();
      } catch {
        continue;
      }
      if (bbox.width <= 0 || bbox.height <= 0) continue;
      const elementMatrix = element.getScreenCTM();
      if (!elementMatrix) continue;
      const matrix = rootInverse.multiply(elementMatrix);
      const polygon = [
        matrixPoint(matrix, bbox.x, bbox.y),
        matrixPoint(matrix, bbox.x + bbox.width, bbox.y),
        matrixPoint(matrix, bbox.x + bbox.width, bbox.y + bbox.height),
        matrixPoint(matrix, bbox.x, bbox.y + bbox.height),
      ];
      const xs = polygon.map((point) => point.x);
      const ys = polygon.map((point) => point.y);
      labels.push({
        sourceText,
        normalizedText: sourceText.replace(/역$/, ""),
        classification: classifyText(element, sourceText),
        polygon,
        bounds: {
          minX: Math.min(...xs),
          minY: Math.min(...ys),
          maxX: Math.max(...xs),
          maxY: Math.max(...ys),
        },
        descriptor: descriptorFor(element, sourceText, bbox),
      });
    }

    // 노선 track geometry: stroke가 있는 line/polyline/polygon/path를 root 좌표
    // 정점 목록 + 확정 stroke 색으로 모은다. fill 전용 도형(마커/배경)과 장식 틱은
    // stroke 없음/길이 하한으로 자연 배제한다. 점선(미개통/예정)은 dashed로 표시.
    const strokes = [];
    for (const element of root.querySelectorAll("line, polyline, polygon, path")) {
      if (element.closest("defs") || !isVisibleText(element, root)) continue;
      const style = getComputedStyle(element);
      const stroke = normalizeColor(style.stroke);
      if (!stroke) continue; // stroke 없는 도형은 노선 track이 아니다.
      const elementMatrix = element.getScreenCTM();
      if (!elementMatrix) continue;
      const matrix = rootInverse.multiply(elementMatrix);
      const tag = element.tagName.toLowerCase();

      let vertices;
      if (tag === "path") {
        const totalLength = element.getTotalLength();
        if (!(totalLength > 0)) continue;
        // root 좌표 기준 등간격이 되도록 로컬 길이를 스케일로 환산해 샘플 수를 정한다.
        const rootLength = totalLength * matrixScale(matrix);
        const samples = Math.max(2, Math.min(600, Math.ceil(rootLength / config.pathSampleSpacing)));
        vertices = [];
        for (let step = 0; step <= samples; step += 1) {
          const point = element.getPointAtLength((totalLength * step) / samples);
          vertices.push({ x: point.x, y: point.y });
        }
      } else {
        vertices = localVertices(element, tag);
      }
      if (vertices.length < 2) continue;

      const points = vertices.map((vertex) => matrixPoint(matrix, vertex.x, vertex.y));
      let length = 0;
      for (let index = 1; index < points.length; index += 1) {
        length += Math.hypot(points[index].x - points[index - 1].x, points[index].y - points[index - 1].y);
      }
      if (length < config.minStrokeLength) continue; // 역 마커 틱/장식 배제.

      const dashArray = style.strokeDasharray;
      const dashed = Boolean(dashArray) && dashArray !== "none" && dashArray.trim() !== "";
      strokes.push({
        tag,
        stroke,
        strokeWidth: Number.parseFloat(style.strokeWidth) || 0,
        dashed,
        length: number(length),
        points,
        descriptor: strokeDescriptor(element, stroke),
      });
    }

    return { sourceViewBox: sourceViewBox(root), labels, strokes };
  }})(${JSON.stringify(svgBase64)}, ${JSON.stringify({
    minStrokeLength: MIN_STROKE_LENGTH,
    pathSampleSpacing: PATH_SAMPLE_SPACING,
  })})`;
}

async function browserVersion(browser) {
  const { stdout } = await execFileAsync(browser, ["--version"], { timeout: 5000 });
  return stdout.trim();
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

async function waitForTarget(port) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 10000) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/new`, { method: "PUT" });
      if (response.ok) return await response.json();
    } catch {
      // Chrome is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for Chrome DevTools target.");
}

function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    child.once("exit", resolve);
  });
}

async function stopBrowser(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = waitForExit(child);
  child.kill("SIGTERM");
  const timeoutId = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }, 5000);
  timeoutId.unref?.();
  try {
    await exited;
  } finally {
    clearTimeout(timeoutId);
  }
}

function openWebSocket(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.addEventListener("open", () => resolve(socket), { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
}

function cdpCall(socket, id, method, params = {}) {
  return new Promise((resolve, reject) => {
    function onMessage(event) {
      const message = JSON.parse(event.data);
      if (message.id !== id) return;
      socket.removeEventListener("message", onMessage);
      if (message.error) reject(new Error(`${method} failed: ${message.error.message}`));
      else resolve(message.result);
    }
    socket.addEventListener("message", onMessage);
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function runBrowserExtraction({ browser, svg, tempDir }) {
  const port = await freePort();
  const sandboxArgs = process.env.ROUTE_MAP_CHROME_NO_SANDBOX === "1"
    ? ["--no-sandbox"]
    : [];
  const child = spawn(browser, [
    "--headless=new",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--no-first-run",
    "--no-default-browser-check",
    ...sandboxArgs,
    `--user-data-dir=${path.join(tempDir, "profile")}`,
    `--remote-debugging-port=${port}`,
    "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  try {
    const target = await waitForTarget(port);
    const socket = await openWebSocket(target.webSocketDebuggerUrl);
    try {
      let id = 1;
      await cdpCall(socket, id++, "Runtime.enable");
      const result = await cdpCall(socket, id++, "Runtime.evaluate", {
        expression: browserExtractorExpression(svg),
        awaitPromise: true,
        returnByValue: true,
        timeout: 20000,
      });
      if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.text || "Browser Runtime.evaluate failed.");
      }
      return result.result.value;
    } finally {
      socket.close();
    }
  } catch (error) {
    throw new Error([error.message, stderr.trim() && `stderr: ${stderr.trim()}`].filter(Boolean).join("\n"));
  } finally {
    await stopBrowser(child);
  }
}

async function extractSvgGeometry({ svgFile, region, browser }) {
  const svg = await readFile(path.resolve(svgFile), "utf8");
  const sourceSvgSha256 = sha256(svg);
  const tempDir = await mkdtemp(path.join(tmpdir(), "easysubway-route-map-"));
  try {
    const extracted = await runBrowserExtraction({ browser, svg, tempDir });
    const version = await browserVersion(browser);
    return {
      schemaVersion: 1,
      region,
      sourceSvgSha256,
      extractorVersion,
      browser: {
        name: version.split(/\s+/)[0] || "Chromium",
        version,
      },
      sourceViewBox: extracted.sourceViewBox,
      labels: extracted.labels.map((label, polygonIndex) => {
        const descriptor = { ...label.descriptor, sourceSvgSha256 };
        const sourceElementKey = sha256(JSON.stringify(descriptor));
        const { descriptor: _descriptor, ...publicLabel } = label;
        return { ...publicLabel, polygonIndex, sourceElementKey };
      }),
      strokes: extracted.strokes.map((stroke, strokeIndex) => {
        const descriptor = { ...stroke.descriptor, sourceSvgSha256 };
        const sourceElementKey = sha256(JSON.stringify(descriptor));
        const { descriptor: _descriptor, ...publicStroke } = stroke;
        return { ...publicStroke, strokeIndex, sourceElementKey };
      }),
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  const browser = findBrowser(options.browser);
  const result = await extractSvgGeometry({
    svgFile: options.svgFile,
    region: options.region.trim(),
    browser,
  });
  process.stdout.write(`${JSON.stringify(result, null, options.pretty ? 2 : 0)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
