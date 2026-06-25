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
const extractorVersion = "route-map-svg-geometry-v1";

function usage() {
  return `Usage: node tools/route-map/extract-svg-geometry.mjs <svg-file> --region <name> [--browser <path>] [--pretty]

Extract visible SVG <text> bounding polygons in root SVG coordinates.
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
  return `(${async function extract(value) {
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
    function elementClasses(element) {
      if (typeof element.className === "string") return element.className;
      return element.className?.baseVal ?? "";
    }
    function descriptorFor(element, text, bbox) {
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
      return {
        text,
        tag: element.tagName.toLowerCase(),
        id: element.id || "",
        className: elementClasses(element),
        transform: element.getAttribute("transform") || "",
        ancestors,
        bbox: {
          x: number(bbox.x),
          y: number(bbox.y),
          width: number(bbox.width),
          height: number(bbox.height),
        },
      };
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

    return { sourceViewBox: sourceViewBox(root), labels };
  }})(${JSON.stringify(svgBase64)})`;
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
    child.kill("SIGTERM");
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
