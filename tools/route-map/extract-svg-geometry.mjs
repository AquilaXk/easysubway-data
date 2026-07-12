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
// v3(#1950): 오너 자작 8선형 도식(easy-subway-sma-v*)의 역 노드
// (data-station/data-line/data-node-role를 가진 circle/g/path)를 조상 transform
// 체인을 브라우저 CTM으로 정규화한 root 좌표 중심으로 함께 추출한다. transfer/edge
// 역의 그룹 로컬 transform(rotate/translate/matrix)까지 정확히 합성되도록
// getScreenCTM+getBBox를 쓴다(결정적: 폰트 무관, CTM 산술은 정확).
const extractorVersion = "route-map-svg-geometry-v3";

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

// 로케일 비의존 결정적 정렬용 코드 유닛 비교. localeCompare(ICU/로케일 의존) 대체.
function codeUnitCompare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
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
    // SVG path d에서 on-path 정점(각 명령의 도착점)만 절대 좌표로 뽑는다. 곡선의
    // 제어점은 버리고 끝점만 취해 8선형 직선 꼭짓점을 보존한다. 지원: M/m L/l H/h
    // V/v C/c S/s Q/q T/t A/a Z/z. 결정적 파서.
    function pathEndpointVertices(d) {
      const tokens = d.match(/[a-zA-Z]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi) || [];
      const out = [];
      let i = 0;
      let cx = 0;
      let cy = 0;
      let startX = 0;
      let startY = 0;
      let cmd = "";
      const num = () => Number.parseFloat(tokens[i++]);
      const push = () => out.push({ x: cx, y: cy });
      while (i < tokens.length) {
        if (/[a-zA-Z]/.test(tokens[i])) {
          cmd = tokens[i++];
        }
        const rel = cmd === cmd.toLowerCase();
        const c = cmd.toUpperCase();
        if (c === "M") {
          cx = (rel ? cx : 0) + num(); cy = (rel ? cy : 0) + num();
          startX = cx; startY = cy; push();
          cmd = rel ? "l" : "L"; // 후속 좌표쌍은 lineto
        } else if (c === "L") {
          cx = (rel ? cx : 0) + num(); cy = (rel ? cy : 0) + num(); push();
        } else if (c === "H") {
          cx = (rel ? cx : 0) + num(); push();
        } else if (c === "V") {
          cy = (rel ? cy : 0) + num(); push();
        } else if (c === "C") {
          num(); num(); num(); num(); // 제어점 2개 폐기
          cx = (rel ? cx : 0) + num(); cy = (rel ? cy : 0) + num(); push();
        } else if (c === "S" || c === "Q") {
          num(); num(); // 제어점 1개 폐기
          cx = (rel ? cx : 0) + num(); cy = (rel ? cy : 0) + num(); push();
        } else if (c === "T") {
          cx = (rel ? cx : 0) + num(); cy = (rel ? cy : 0) + num(); push();
        } else if (c === "A") {
          num(); num(); num(); num(); num(); // rx ry rot large sweep
          cx = (rel ? cx : 0) + num(); cy = (rel ? cy : 0) + num(); push();
        } else if (c === "Z") {
          cx = startX; cy = startY; push();
        } else {
          i++; // 알 수 없는 토큰 방어
        }
      }
      return out;
    }
    // 폴리라인을 8선형으로 정리한다. 각 세그먼트 방향을 최근접 8방향으로 양자화하고,
    // 각 세그먼트 방향을 최근접 8방향으로 양자화하고, 같은 방향 run은 이전 정점을
    // 투영점으로 연장 병합한다. 인접 두 run 방향이 다르면 그 교점을 코너 정점으로 둔다.
    function octolinearizePolyline(points) {
      if (points.length < 3) return points;
      const DIRS = [
        { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }, { x: -1, y: 1 },
        { x: -1, y: 0 }, { x: -1, y: -1 }, { x: 0, y: -1 }, { x: 1, y: -1 },
      ].map((d) => ({ x: d.x / Math.hypot(d.x, d.y), y: d.y / Math.hypot(d.x, d.y) }));
      const snapDir = (dx, dy) => {
        let best = DIRS[0];
        let bestDot = -Infinity;
        for (const d of DIRS) {
          const dot = dx * d.x + dy * d.y;
          if (dot > bestDot) { bestDot = dot; best = d; }
        }
        return best;
      };
      // run 목록: (방향, 시작점). 짧은 세그먼트는 흡수.
      const out = [{ x: number(points[0].x), y: number(points[0].y) }];
      let curDir = null;
      for (let i = 1; i < points.length; i += 1) {
        const prev = out[out.length - 1];
        let dx = points[i].x - prev.x;
        let dy = points[i].y - prev.y;
        const len = Math.hypot(dx, dy);
        if (len < 1e-6) continue;
        const dir = snapDir(dx, dy);
        if (curDir && Math.abs(dir.x - curDir.x) < 1e-9 && Math.abs(dir.y - curDir.y) < 1e-9) {
          // 같은 방향 연장: 이전 정점을 이 투영점으로 이동.
          const t = dx * dir.x + dy * dir.y;
          prev.x = number(prev.x + dir.x * t);
          prev.y = number(prev.y + dir.y * t);
          continue;
        }
        // 방향 전환: 축 투영 길이만큼 새 run 정점을 추가한다. 짧은 코너 브리지든
        // 아니든 동일 처리 — 다음 정점이 같은 방향이면 위 분기가 이 정점을 흡수한다.
        const t = dx * dir.x + dy * dir.y;
        out.push({ x: number(prev.x + dir.x * t), y: number(prev.y + dir.y * t) });
        curDir = dir;
      }
      return out;
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
        // 오너 도식의 route 경로는 8선형 직선(l/h/v)을 짧은 코너 곡선(c/s)으로 이은
        // 형태다. 등간격 재샘플은 코너 각도를 뭉갠다 → 원본 d의 on-path 정점(직선
        // 끝점·곡선 끝점)만 뽑아 정확한 8선형 꼭짓점을 보존한다(코너 곡선은 두
        // 정점으로 근사). d 파싱 실패 시 arc-length 재샘플로 폴백한다.
        const raw = element.getAttribute("d") || "";
        vertices = pathEndpointVertices(raw);
        if (vertices.length < 2) {
          const totalLength = element.getTotalLength();
          if (!(totalLength > 0)) continue;
          const rootLength = totalLength * matrixScale(matrix);
          const samples = Math.max(2, Math.min(600, Math.ceil(rootLength / config.pathSampleSpacing)));
          vertices = [];
          for (let step = 0; step <= samples; step += 1) {
            const point = element.getPointAtLength((totalLength * step) / samples);
            vertices.push({ x: point.x, y: point.y });
          }
        }
      } else {
        vertices = localVertices(element, tag);
      }
      if (vertices.length < 2) continue;

      let points = vertices.map((vertex) => matrixPoint(matrix, vertex.x, vertex.y));
      // 8선형 정리: 코너 곡선 끝점이 만드는 짧은 비축 세그먼트를 인접 8방향 run에
      // 흡수시켜 track 세그먼트를 0/45/90/135°로 정렬한다(오너 도식은 직선 run이
      // 이미 8선형이고, 어긋남은 곡선 근사에서만 온다). path stroke에만 적용.
      if (tag === "path") points = octolinearizePolyline(points);
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

    // 역 노드: data-station + data-node-role를 가진 요소(circle/g/path)의 root 좌표
    // 중심을 조상 transform 체인(scaled-layer + 그룹 로컬 rotate/translate/matrix)까지
    // 합성해 산출한다. circle은 cx/cy를, 그 외는 getBBox 중심을 로컬 기준점으로 쓴다.
    // 상위 요소가 이미 data-station을 들고 있으면 자식은 건너뛴다(그룹 대표 1노드).
    function nodeCenterLocal(element) {
      const tag = element.tagName.toLowerCase();
      if (tag === "circle") {
        return {
          x: Number.parseFloat(element.getAttribute("cx") || "0"),
          y: Number.parseFloat(element.getAttribute("cy") || "0"),
        };
      }
      let bbox;
      try {
        bbox = element.getBBox();
      } catch {
        return null;
      }
      if (!(bbox.width >= 0) || !(bbox.height >= 0)) return null;
      return { x: bbox.x + bbox.width / 2, y: bbox.y + bbox.height / 2 };
    }
    const stationNodes = [];
    for (const element of root.querySelectorAll("[data-node-role][data-station]")) {
      if (element.closest("defs")) continue;
      // 조상 중 이미 data-station 노드가 있으면(예: transfer-symbol g 내부의 circle)
      // 대표는 최상위 그 하나뿐 — 자식 중복은 배제한다.
      const owner = element.parentElement?.closest("[data-node-role][data-station]");
      if (owner) continue;
      const local = nodeCenterLocal(element);
      if (!local) continue;
      const elementMatrix = element.getScreenCTM();
      if (!elementMatrix) continue;
      const matrix = rootInverse.multiply(elementMatrix);
      const center = matrixPoint(matrix, local.x, local.y);
      const dataStation = element.getAttribute("data-station") || "";
      const dataName = element.getAttribute("data-name") || dataStation;
      stationNodes.push({
        dataStation,
        dataName,
        dataStationName: element.getAttribute("data-station-name") || dataName,
        dataLine: element.getAttribute("data-line") || "",
        dataLineName: element.getAttribute("data-line-name") || "",
        dataLineColor: element.getAttribute("data-line-color") || "",
        nodeRole: element.getAttribute("data-node-role") || "",
        transferLines: element.getAttribute("data-transfer-lines") || "",
        tag: element.tagName.toLowerCase(),
        id: element.id || "",
        x: center.x,
        y: center.y,
      });
    }

    // 라벨 앵커 노드(#2011 3단계 대전 문법): 역 마커 g가 data-node-role 없이
    // data-station-code만 들고, 역 정체(이름)와 노드 좌표가 <text> 라벨의
    // data-full-official-name/data-node-x/data-node-y에 실려 있는 도식을 위한
    // 두 번째 노드 소스. data-node-x·data-node-y·data-full-official-name을 모두
    // 가진 요소만 노드로 승격하므로 그 attr가 없는 도식(수도권·부산·대구)에는
    // 아무 영향이 없다(추가만·회귀 0). 좌표는 라벨 bbox가 아니라 명시된 노드
    // 좌표(마커 중심)를 root 좌표로 변환해 쓴다.
    for (const element of root.querySelectorAll("[data-node-x][data-node-y][data-full-official-name]")) {
      if (element.closest("defs")) continue;
      const rawX = element.getAttribute("data-node-x");
      const rawY = element.getAttribute("data-node-y");
      const officialName = element.getAttribute("data-full-official-name") || "";
      const nx = Number.parseFloat(rawX);
      const ny = Number.parseFloat(rawY);
      if (!Number.isFinite(nx) || !Number.isFinite(ny) || !officialName) continue;
      const elementMatrix = element.getScreenCTM();
      if (!elementMatrix) continue;
      const matrix = rootInverse.multiply(elementMatrix);
      const center = matrixPoint(matrix, nx, ny);
      stationNodes.push({
        dataStation: officialName,
        dataName: officialName,
        dataStationName: officialName,
        dataLine: element.getAttribute("data-line") || "",
        dataLineName: element.getAttribute("data-line-name") || "",
        dataLineColor: element.getAttribute("data-line-color") || "",
        nodeRole: element.getAttribute("data-label-role") || element.getAttribute("data-node-role") || "",
        transferLines: element.getAttribute("data-transfer-lines") || "",
        dataStationCode: element.getAttribute("data-station-code") || "",
        dataStatus: element.getAttribute("data-status") || "",
        nodeSource: "label-anchor",
        tag: element.tagName.toLowerCase(),
        id: element.id || "",
        x: center.x,
        y: center.y,
      });
    }

    // 라벨 그룹 노드(#2011 3단계 광주 문법): 역 정체(코드+이름)가 label group
    // <g data-label-role data-station(코드) data-station-name(이름)>에 실리고,
    // 마커 dot(circle.station-node)은 정체 없이 stroke 색만 든다. 명시 노드 좌표가
    // 없으므로 라벨 그룹의 bbox 중심을 노드 좌표 대체값으로 쓴다(수도권 markerless
    // fallback과 동일 발상 — 후속 respace·8선형 스냅이 line_sequence 위상으로
    // 좌표를 정규화한다). 선택자 g[data-label-role]는 광주에만 존재하므로
    // (수도권·부산·대구는 <g>에 data-label-role 0) 다른 권역에 영향이 없다.
    for (const element of root.querySelectorAll("g[data-label-role][data-station-name][data-station]")) {
      if (element.closest("defs")) continue;
      const name = element.getAttribute("data-station-name") || "";
      const code = element.getAttribute("data-station") || "";
      if (!name) continue;
      let bbox;
      try {
        bbox = element.getBBox();
      } catch {
        continue;
      }
      if (!(bbox.width >= 0) || !(bbox.height >= 0)) continue;
      const elementMatrix = element.getScreenCTM();
      if (!elementMatrix) continue;
      const matrix = rootInverse.multiply(elementMatrix);
      const center = matrixPoint(matrix, bbox.x + bbox.width / 2, bbox.y + bbox.height / 2);
      stationNodes.push({
        dataStation: name,
        dataName: name,
        dataStationName: name,
        dataLine: element.getAttribute("data-line") || "",
        dataLineName: element.getAttribute("data-line-name") || "",
        dataLineColor: element.getAttribute("data-line-color") || "",
        nodeRole: element.getAttribute("data-label-role") || "",
        transferLines: element.getAttribute("data-transfer-lines") || "",
        dataStationCode: code,
        dataStatus: element.getAttribute("data-status") || "",
        nodeSource: "label-group",
        tag: element.tagName.toLowerCase(),
        id: element.id || "",
        x: center.x,
        y: center.y,
      });
    }

    return { sourceViewBox: sourceViewBox(root), labels, strokes, stationNodes };
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
      // 결정적 출력: (data-line, data-station, id)로 코드 유닛 비교 안정 정렬한다.
      // localeCompare는 ICU/로케일 의존이라 환경별로 순서가 흔들리므로 쓰지 않는다.
      stationNodes: (extracted.stationNodes ?? [])
        .slice()
        .sort((a, b) =>
          codeUnitCompare(a.dataLine, b.dataLine) ||
          codeUnitCompare(a.dataStation, b.dataStation) ||
          codeUnitCompare(a.id, b.id),
        )
        .map((node, nodeIndex) => {
          const sourceElementKey = sha256(
            JSON.stringify({ id: node.id, dataStation: node.dataStation, dataLine: node.dataLine, sourceSvgSha256 }),
          );
          return { ...node, nodeIndex, sourceElementKey };
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
