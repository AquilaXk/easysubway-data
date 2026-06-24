#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { TextDecoder } from "node:util";
import vm from "node:vm";

const sourceId = "molit-urban-rail-full-route";
const seoulMetroSourceId = "seoulmetro-cyberstation";
const humetroSourceId = "humetro-cyberstation";
const grtcSourceId = "grtc-cyberstation";
const dtroSourceId = "dtro-cyberstation";
const djtcSourceId = "djtc-cyberstation";
const verifiedAt = "2026-04-02T00:00:00.000Z";
const sourceUrl = "https://www.data.go.kr/data/15122916/fileData.do";

const knownOperatorIds = new Map([
  ["서울교통공사", "seoul-metro"],
  ["코레일", "korail"],
  ["부산교통공사", "busan-transportation"],
  ["대구교통공사", "daegu-transportation"],
  ["광주교통공사", "gwangju-metropolitan-rapid-transit"],
  ["대전교통공사", "daejeon-transportation"],
  ["인천교통공사", "incheon-transit"],
]);

const knownLineIds = new Map([
  ["수도권:2호선", "seoul-2"],
  ["수도권:4호선", "seoul-4"],
  ["수도권:신분당", "shinbundang"],
  ["수도권:2호선 지선", "seoul-2-branch"],
]);

const knownStationIds = new Map([
  ["수도권:상록수", "station-sangnoksu"],
  ["수도권:사당", "station-sadang"],
  ["수도권:강남", "station-gangnam"],
  ["수도권:정자", "station-jeongja"],
  ["수도권:성수", "station-seongsu"],
  ["수도권:신설동", "station-sinseoldong"],
]);

const lineColors = new Map([
  ["1호선", "#052f93"],
  ["2호선", "#10a643"],
  ["2호선 지선", "#10a643"],
  ["3호선", "#de6d00"],
  ["4호선", "#0099d1"],
  ["5호선", "#a95094"],
  ["6호선", "#d08d1a"],
  ["7호선", "#657931"],
  ["8호선", "#e74e6d"],
  ["9호선", "#b58600"],
  ["신분당", "#cd2234"],
  ["공항", "#038fa0"],
  ["수인분당", "#a69500"],
  ["경의중앙", "#5f9c82"],
  ["경춘", "#0ba382"],
  ["의정부", "#d9750d"],
  ["우이신설", "#878787"],
  ["서해선", "#40a607"],
  ["김포골드라인", "#a18f57"],
  ["신림선", "#0781fa"],
  ["인천1호선", "#6496df"],
  ["인천2호선", "#cf843c"],
  ["경강", "#004ea7"],
  ["에버라인", "#36a805"],
  ["GTX-A", "#9f6181"],
]);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const csvPath = requireArg(args, "csv");
  const svgCsvPath = requireArg(args, "svg-csv");
  const seoulMetroPath = args["seoulmetro-js"];
  const humetroHtmlPath = args["humetro-html"];
  const humetroCssPath = args["humetro-css"];
  const grtcHtmlPath = args["grtc-html"];
  const dtroHtmlPath = args["dtro-html"];
  const djtcHtmlPath = args["djtc-html"];
  const djtcCssPath = args["djtc-css"];
  const outputPath = requireArg(args, "output");
  const csv = new TextDecoder("euc-kr").decode(await readFile(csvPath));
  const svgCsv = new TextDecoder("euc-kr").decode(await readFile(svgCsvPath));
  const seoulMetroJs = seoulMetroPath ? await readFile(seoulMetroPath, "utf8") : "";
  const officialSources = {
    seoulMetroJs,
    humetroHtml: humetroHtmlPath ? await readFile(humetroHtmlPath, "utf8") : "",
    humetroCss: humetroCssPath ? await readFile(humetroCssPath, "utf8") : "",
    grtcHtml: grtcHtmlPath ? await readFile(grtcHtmlPath, "utf8") : "",
    dtroHtml: dtroHtmlPath ? await readFile(dtroHtmlPath, "utf8") : "",
    djtcHtml: djtcHtmlPath ? await readFile(djtcHtmlPath, "utf8") : "",
    djtcCss: djtcCssPath ? await readFile(djtcCssPath, "utf8") : "",
  };
  const rows = parseCsv(csv).map(rowFromCsv).filter(Boolean);
  const svgRows = parseCsv(svgCsv).map(svgRowFromCsv).filter(Boolean);
  const fixture = buildFixture(rows, svgRows, officialSources);
  await writeFile(outputPath, `${JSON.stringify(fixture, null, 2)}\n`);
}

function buildFixture(rows, svgRows, officialSources) {
  const operators = new Map();
  const lines = new Map();
  const stations = new Map();
  const stationLines = new Map();
  const byLine = new Map();
  const svgByKey = svgRowsByKey(svgRows);
  const officialByKey = officialRowsByKey(officialSources);

  for (const row of rows) {
    const operatorId = operatorIdFor(row.operatorName);
    operators.set(operatorId, {
      id: operatorId,
      nameKo: row.operatorName,
      nameEn: "",
    });

    const lineId = lineIdFor(row.regionName, row.lineName);
    if (!lines.has(lineId)) {
      lines.set(lineId, {
        id: lineId,
        operatorId: preferredOperatorId(lineId, operatorId),
        nameKo: `${row.regionName} ${row.lineName}`,
        nameEn: "",
        color: lineColorFor(row.regionName, row.lineName),
      });
    }

    const stationId = stationIdFor(row.regionName, row.stationName);
    stations.set(stationId, {
      id: stationId,
      nameKo: row.stationName,
      nameEn: "",
      normalizedName: row.stationName,
      region: regionLabel(row.regionName),
      latitude: null,
      longitude: null,
      dataQualityLevel: "LEVEL_2",
      dataSourceType: "OFFICIAL_FILE",
      lastVerifiedAt: verifiedAt,
    });

    const stationLineKey = `${stationId}:${lineId}`;
    stationLines.set(stationLineKey, {
      stationId,
      lineId,
      stationCode: stationCodeFor(row.regionName, row.lineName, row.stationName, row.sequence),
      lineSequence: row.sequence,
      platformInfo: "",
    });
    byLine.set(lineId, [...(byLine.get(lineId) ?? []), { ...row, stationId, lineId }]);
  }

  const lineOrder = [...byLine.keys()].sort((left, right) => {
    const leftLine = lines.get(left);
    const rightLine = lines.get(right);
    return `${leftLine.nameKo}`.localeCompare(`${rightLine.nameKo}`, "ko");
  });
  const regionalLineOrder = new Map();
  for (const lineId of lineOrder) {
    const lineRows = byLine.get(lineId);
    const region = regionLabel(lineRows[0].regionName);
    regionalLineOrder.set(region, [...(regionalLineOrder.get(region) ?? []), lineId]);
  }

  const routeMapPositions = [];
  for (const [region, regionLineIds] of regionalLineOrder.entries()) {
    for (const lineId of regionLineIds) {
      routeMapPositions.push(...positionsForLine(byLine.get(lineId), region, svgByKey, officialByKey));
    }
  }
  fillMissingRouteMapPositions(routeMapPositions, byLine);

  const networkEdges = [];
  for (const [lineId, rawLineRows] of byLine.entries()) {
    const lineRows = [...rawLineRows].sort((a, b) => a.sequence - b.sequence);
    for (let index = 0; index < lineRows.length - 1; index += 1) {
      const from = lineRows[index];
      const to = lineRows[index + 1];
      networkEdges.push(edgeFor(lineId, from, to));
      networkEdges.push(edgeFor(lineId, to, from));
    }
  }

  const firstEdge = networkEdges[0];
  return {
    manifest: {
      ttlSeconds: 3600,
      activePack: { id: "capital", version: "1" },
    },
    packs: [
      {
        id: "capital",
        version: "1",
        artifactKind: "fixture",
        schemaVersion: "1",
        url: "catalog/capital-v1.sqlite.gz",
        sourceInventory: sourceInventoryEntries(),
        requiredTables: [
          "catalog_metadata",
          "operators",
          "lines",
          "stations",
          "station_lines",
          "network_edges",
          "route_map_positions",
          "station_exits",
          "facilities",
          "data_quality_records",
        ],
        minimumTableRows: {
          catalog_metadata: 2,
          operators: operators.size,
          lines: lines.size,
          stations: stations.size,
          station_lines: stationLines.size,
          network_edges: networkEdges.length,
          route_map_positions: routeMapPositions.length,
          station_exits: 0,
          facilities: 0,
          data_quality_records: 0,
        },
        metadata: { activePack: "capital" },
        operators: [...operators.values()].sort(byId),
        lines: [...lines.values()].sort(byId),
        stations: [...stations.values()].sort(byId),
        stationAliases: [],
        stationLines: [...stationLines.values()].sort((a, b) => a.lineId.localeCompare(b.lineId) || a.lineSequence - b.lineSequence),
        networkEdges,
        routeMapPositions,
        stationExits: [],
        facilities: [],
        dataQualityRecords: [],
        representativeRouteRegressions: representativeRoutes(firstEdge),
      },
    ],
  };
}

function positionsForLine(lineRows, region, svgByKey, officialByKey) {
  const officialLineExists = lineRows.some((row) => officialByKey.has(svgKey(row.regionCode, row.lineName, row.stationName)));
  return [...lineRows]
    .sort((a, b) => a.sequence - b.sequence)
    .map((row) => {
      const official = officialByKey.get(svgKey(row.regionCode, row.lineName, row.stationName))
        ?? officialByKey.get(svgKey(row.regionCode, "__any__", row.stationName));
      if (official) {
        return {
          stationId: row.stationId,
          lineId: row.lineId,
          region,
          x: Math.round(official.x),
          y: Math.round(official.y),
          labelDx: Math.round(official.labelDx),
          labelDy: Math.round(official.labelDy),
          upPath: "",
          downPath: official.path,
          sourceId: official.sourceId,
          sourceName: official.sourceName,
          sourceUrl: official.sourceUrl,
          license: "공식 웹 공개 노선도 기준",
          licenseStatus: "review-required",
          commercialUseAllowed: false,
          attributionRequired: true,
          reviewedAt: verifiedAt,
          updatedAt: verifiedAt,
        };
      }
      if (officialRegionCodes().has(row.regionCode) && officialLineExists) {
        return null;
      }
      const svg = svgByKey.get(svgKey(row.regionCode, row.lineName, row.stationName));
      if (!svg) {
        return null;
      }
      const point = firstMovePoint(svg.downPath || svg.upPath);
      if (!point) {
        return null;
      }
      return {
        stationId: row.stationId,
        lineId: row.lineId,
        region,
        x: Math.round(point.x),
        y: Math.round(point.y),
        labelDx: 0,
        labelDy: 0,
        upPath: svg.upPath,
        downPath: svg.downPath,
        sourceId: "molit-rail-station-svg-route",
        sourceName: "국토교통부 철도 역사 SVG선지도",
        sourceUrl: "https://www.data.go.kr/data/15130544/fileData.do",
        license: "공공데이터포털 이용허락범위 제한 없음",
        licenseStatus: "redistributable",
        commercialUseAllowed: true,
        attributionRequired: false,
        reviewedAt: verifiedAt,
        updatedAt: verifiedAt,
      };
    })
    .filter(Boolean);
}

function fillMissingRouteMapPositions(routeMapPositions, byLine) {
  const positionsByNode = new Map(routeMapPositions.map((row) => [`${row.stationId}:${row.lineId}`, row]));
  for (const [lineId, rawRows] of byLine.entries()) {
    const lineRows = [...rawRows].sort((a, b) => a.sequence - b.sequence);
    for (let index = 0; index < lineRows.length; index += 1) {
      const row = lineRows[index];
      const key = `${row.stationId}:${row.lineId}`;
      if (positionsByNode.has(key)) {
        continue;
      }
      const previous = nearestPosition(lineRows, index, positionsByNode, -1);
      const next = nearestPosition(lineRows, index, positionsByNode, 1);
      if (!previous && !next) {
        continue;
      }
      const point = interpolatedPoint(row.sequence, previous, next);
      const path = previous ? `${moveTo(previous.position.x, previous.position.y)} ${lineTo(point.x, point.y).trim()}` : "";
      const position = {
        stationId: row.stationId,
        lineId: row.lineId,
        region: regionLabel(row.regionName),
        x: Math.round(point.x),
        y: Math.round(point.y),
        labelDx: 12,
        labelDy: 0,
        upPath: "",
        downPath: path,
        sourceId,
        sourceName: "국토교통부 도시철도 전체노선정보",
        sourceUrl,
        license: "공공데이터포털 이용허락범위 제한 없음",
        licenseStatus: "redistributable",
        commercialUseAllowed: true,
        attributionRequired: false,
        reviewedAt: verifiedAt,
        updatedAt: verifiedAt,
      };
      routeMapPositions.push(position);
      positionsByNode.set(key, position);
    }
  }
}

function nearestPosition(lineRows, startIndex, positionsByNode, direction) {
  for (let index = startIndex + direction; index >= 0 && index < lineRows.length; index += direction) {
    const row = lineRows[index];
    const position = positionsByNode.get(`${row.stationId}:${row.lineId}`);
    if (position) {
      return { row, position };
    }
  }
  return null;
}

function interpolatedPoint(sequence, previous, next) {
  if (previous && next && next.row.sequence !== previous.row.sequence) {
    const ratio = (sequence - previous.row.sequence) / (next.row.sequence - previous.row.sequence);
    return nonNegativePoint({
      x: previous.position.x + (next.position.x - previous.position.x) * ratio,
      y: previous.position.y + (next.position.y - previous.position.y) * ratio,
    });
  }
  if (previous) {
    return nonNegativePoint({ x: previous.position.x + 56, y: previous.position.y });
  }
  return nonNegativePoint({ x: next.position.x - 56, y: next.position.y });
}

function nonNegativePoint(point) {
  return { x: Math.max(0, point.x), y: Math.max(0, point.y) };
}

function officialRegionCodes() {
  return new Set(["01", "02", "03", "04", "05"]);
}

function officialRowsByKey(sources) {
  return new Map([
    ...seoulMetroRowsByKey(sources.seoulMetroJs),
    ...humetroRowsByKey(sources.humetroHtml, sources.humetroCss),
    ...grtcRowsByKey(sources.grtcHtml),
    ...dtroRowsByKey(sources.dtroHtml),
    ...djtcRowsByKey(sources.djtcHtml, sources.djtcCss),
  ]);
}

function seoulMetroRowsByKey(source) {
  if (!source.trim()) {
    return new Map();
  }
  const context = {};
  vm.createContext(context);
  vm.runInContext(`${source}\nthis.__lines = lines;`, context);
  const rows = new Map();
  for (const line of Object.values(context.__lines ?? {})) {
    const lineName = lineNameFromSeoulMetro(line.attr?.["data-label"]);
    if (!lineName) {
      continue;
    }
    const color = line.attr?.["data-color"] ?? "#000000";
    const nodes = cyberNodes(line, color);
    for (const row of cyberRouteRows(nodes)) {
      if (!row.stationName || !row.path) {
        continue;
      }
      const keyedRow = {
        ...row,
        x: row.scaledX,
        y: row.scaledY,
        sourceId: seoulMetroSourceId,
        sourceName: "서울교통공사 사이버스테이션",
        sourceUrl: "http://www.seoulmetro.co.kr/kr/cyberStation.do",
      };
      rows.set(svgKey("01", lineName, row.stationName), keyedRow);
      rows.set(svgKey("01", "__any__", row.stationName), keyedRow);
    }
  }
  return rows;
}

function humetroRowsByKey(html, css) {
  if (!html.trim() || !css.trim()) {
    return new Map();
  }
  const stationCss = cssPositionRules(css, /^\.s(\d+)$/);
  const labelCss = cssPositionRules(css, /^\.s(\d+) \.sta-title$/);
  const byLine = new Map();
  const stationPattern = /<div class="([^"]*\bs(\d+)\b[^"]*)">[\s\S]*?one_point\('(\d+)', '(\d+)', '([^']+)'[\s\S]*?<span class="sta-title[^"]*">([\s\S]*?)<\/span>/g;
  let match;
  while ((match = stationPattern.exec(html)) !== null) {
    const [, className, stationCode, , lineCode, stationNameArg, titleHtml] = match;
    const position = stationCss.get(stationCode);
    if (!position) {
      continue;
    }
    const lineName = humetroLineName(lineCode);
    if (!lineName) {
      continue;
    }
    const label = labelCss.get(stationCode) ?? { left: 13, top: 0 };
    const titleName = normalizeHtmlText(titleHtml);
    const stationName = titleName && !titleName.includes("환승역") && !titleHtml.includes("<span")
      ? titleName
      : stationNameArg;
    const row = {
      stationName,
      x: position.left + (className.includes("trans") ? 12.5 : 5.5),
      y: position.top + (className.includes("trans") ? 13 : 5),
      labelDx: (label.left ?? 13) - 5,
      labelDy: label.top ?? 0,
      sourceId: humetroSourceId,
      sourceName: "부산교통공사 사이버스테이션",
      sourceUrl: "https://www2.humetro.busan.kr/homepage/cyberstation/map.do",
    };
    byLine.set(lineName, [...(byLine.get(lineName) ?? []), row]);
  }
  return lineRowsToKeyedRows("02", byLine);
}

function humetroLineName(code) {
  return {
    "1": "1호선",
    "2": "2호선",
    "3": "3호선",
    "4": "4호선",
    "8": "동해선",
    "9": "부산김해경전철",
  }[code] ?? null;
}

function grtcRowsByKey(html) {
  if (!html.trim()) {
    return new Map();
  }
  const names = [];
  const section = /<div class="line-box pc">([\s\S]*?)<div class="line-box mobile">/.exec(html)?.[1] ?? "";
  const stationPattern = /data-subwayid="(\d+)"[\s\S]*?<p>\s*([\s\S]*?)\s*<span class="icon">/g;
  let match;
  while ((match = stationPattern.exec(section)) !== null) {
    names.push(normalizeHtmlText(match[2]));
  }
  const positions = [
    [73, 212],
    [215, 212],
    [361, 212],
    [527, 212],
    [624, 212],
    [724, 212],
    [865, 212],
    [994, 212],
    [1075, 212],
    [1166, 212],
    [1249, 212],
    [1335, 212],
    [1428, 212],
    [1532, 212],
    [1640, 212],
    [1746, 212],
    [1836, 212],
    [1921, 212],
    [2004, 212],
    [2087, 212],
  ];
  const rows = [];
  for (let index = 0; index < names.length; index += 1) {
    const [x, y] = positions[index] ?? [220 + index * 72, 190];
    rows.push({
      stationName: names[index],
      x,
      y,
      labelDx: 0,
      labelDy: 40,
      sourceId: grtcSourceId,
      sourceName: "광주교통공사 사이버스테이션",
      sourceUrl: "https://www.grtc.co.kr/cyber/simple",
    });
  }
  return lineRowsToKeyedRows("04", new Map([["1호선", rows]]));
}

function dtroRowsByKey(html) {
  if (!html.trim()) {
    return new Map();
  }
  const byLine = new Map();
  const areaPattern = /<area[^>]+alt="([^"]+)"[^>]+parent_line="cyberStation(\d+)"[^>]+coords="(\d+),(\d+),\d+"/g;
  let match;
  while ((match = areaPattern.exec(html)) !== null) {
    const [, alt, lineCode, x, y] = match;
    const lineName = `${lineCode}호선`;
    byLine.set(lineName, [
      ...(byLine.get(lineName) ?? []),
      {
        stationName: alt.replace(/\(.*/, ""),
        x: Number(x),
        y: Number(y),
        labelDx: 12,
        labelDy: 0,
        sourceId: dtroSourceId,
        sourceName: "대구교통공사 사이버스테이션",
        sourceUrl: "https://www.dtro.or.kr/front/dtro/cyberstation/station/cyberstation.do",
      },
    ]);
    if (alt.startsWith("대공원")) {
      byLine.set(lineName, [
        ...(byLine.get(lineName) ?? []),
        {
          stationName: "수성알파시티",
          x: Number(x),
          y: Number(y),
          labelDx: 12,
          labelDy: 0,
          sourceId: dtroSourceId,
          sourceName: "대구교통공사 사이버스테이션",
          sourceUrl: "https://www.dtro.or.kr/front/dtro/cyberstation/station/cyberstation.do",
        },
      ]);
    }
  }
  return lineRowsToKeyedRows("03", byLine);
}

function djtcRowsByKey(html, css) {
  if (!html.trim() || !css.trim()) {
    return new Map();
  }
  const cssRows = cssPositionRules(css, /^\.routrack(\d+)$/);
  const rows = [];
  const stationPattern = /<a class="routrack(\d+)"[^>]+title="([^"]+)역"[^>]+index="(\d+)"/g;
  let match;
  while ((match = stationPattern.exec(html)) !== null) {
    const [, trackCode, name, index] = match;
    const position = cssRows.get(trackCode);
    if (!position) {
      continue;
    }
    rows.push({
      stationName: name,
      index: Number(index),
      x: position.left + 10,
      y: position.top + 10,
      labelDx: 0,
      labelDy: 22,
      sourceId: djtcSourceId,
      sourceName: "대전교통공사 사이버스테이션",
      sourceUrl: "https://www.djtc.kr/kor/cyberStation.do?menuIdx=28",
    });
  }
  rows.sort((a, b) => a.index - b.index);
  return lineRowsToKeyedRows("05", new Map([["1호선", rows]]));
}

function lineRowsToKeyedRows(regionCode, byLine) {
  const rows = new Map();
  for (const [lineName, lineRows] of byLine.entries()) {
    const sortedRows = [...lineRows];
    for (let index = 0; index < sortedRows.length; index += 1) {
      const row = sortedRows[index];
      const previous = sortedRows[index - 1];
      const path = previous
        ? `${moveTo(previous.x, previous.y)} ${lineTo(row.x, row.y).trim()}`
        : "";
      const keyedRow = { ...row, path };
      rows.set(svgKey(regionCode, lineName, row.stationName), keyedRow);
      rows.set(svgKey(regionCode, "__any__", row.stationName), keyedRow);
    }
  }
  return rows;
}

function cssPositionRules(css, selectorPattern) {
  const rows = new Map();
  const rulePattern = /([^{]+)\{([^}]+)\}/g;
  let match;
  while ((match = rulePattern.exec(css)) !== null) {
    const selector = match[1].trim().split(/[\n,]/).at(-1).trim();
    const body = match[2];
    const selectorMatch = selectorPattern.exec(selector);
    if (!selectorMatch) {
      continue;
    }
    const top = cssNumber(body, "top");
    const left = cssNumber(body, "left");
    if (top == null && left == null) {
      continue;
    }
    rows.set(selectorMatch[1], { top, left });
  }
  return rows;
}

function cssNumber(body, name) {
  const match = new RegExp(`${name}\\s*:\\s*(-?\\d+(?:\\.\\d+)?)px`).exec(body);
  return match ? Number(match[1]) : null;
}

function cyberNodes(line, color) {
  const scale = 5;
  return (line.stations ?? [])
    .filter((station) => !String(station["data-marker"] ?? "").startsWith("@"))
    .map((station, index) => {
      const [x, y] = String(station["data-coords"] ?? "0,0").split(",").map(Number);
      const labelPos = station["data-labelPos"] ?? "s";
      return {
        x,
        y,
        scaledX: x * scale,
        scaledY: y * scale,
        direction: station["data-dir"] ?? "",
        moveTo: station["data-moveTo"] ?? "",
        stationName: normalizeStationName(station["station-nm"] ?? ""),
        stationCode: station["station-cd"] ?? "",
        labelDx: labelDx(labelPos, station["data-marker"] ?? "", scale),
        labelDy: labelDy(labelPos, station["data-marker"] ?? "", scale),
        color,
        index,
      };
    });
}

function cyberRouteRows(nodes) {
  const rows = [];
  let path = "";
  for (let index = 0; index < nodes.length; index += 1) {
    const current = nodes[index];
    if (!path) {
      path = moveTo(current.scaledX, current.scaledY);
      if (current.stationName) {
        rows.push({ ...current, path });
      }
      continue;
    }
    if (current.moveTo) {
      const [moveX, moveY] = current.moveTo.split(",").map(Number);
      path = moveTo(moveX * 5, moveY * 5);
      if (current.stationName) {
        rows.push({ ...current, path });
      }
      continue;
    }
    const previous = nodes[index - 1];
    const next = nodes[index + 1];
    const post = nodes[index - 2];
    path += pathToNode(previous, current, next, post);
    if (current.stationName) {
      rows.push({ ...current, path });
      path = moveTo(current.scaledX, current.scaledY);
    }
  }
  return rows;
}

function pathToNode(previous, current, next, post) {
  const xDiff = Math.round(Math.abs(current.x - previous.x));
  const yDiff = Math.round(Math.abs(current.y - previous.y));
  if (xDiff === 0) {
    return verticalTo(current.scaledY);
  }
  if (yDiff === 0) {
    return horizonTo(current.scaledX);
  }
  const direction = current.direction.toLowerCase();
  if (!direction) {
    return lineTo(current.scaledX, current.scaledY);
  }
  let xVal = previous.scaledX;
  let yVal = previous.scaledY;
  if (direction === "auto" && next && post) {
    const x1 = post.x, x2 = previous.x, x3 = current.x, x4 = next.x;
    const y1 = post.y, y2 = previous.y, y3 = current.y, y4 = next.y;
    const divisor = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
    if (divisor !== 0) {
      xVal = (((x1 * y2 - y1 * x2) * (x3 - x4) - (x1 - x2) * (x3 * y4 - y3 * x4)) / divisor) * 5;
      yVal = (((x1 * y2 - y1 * x2) * (y3 - y4) - (y1 - y2) * (x3 * y4 - y3 * x4)) / divisor) * 5;
    }
  } else {
    const xDiffVal = 5 * (current.x - previous.x);
    const yDiffVal = 5 * (current.y - previous.y);
    const t = { e: 100, w: 100, sc: 5, nc: 5, ec: 95, wc: 95 }[direction] ?? 0;
    xVal += xDiffVal * (t / 100);
    yVal += yDiffVal * ((100 - t) / 100);
  }
  return curveTo(xVal, yVal, current.scaledX, current.scaledY);
}

function lineNameFromSeoulMetro(label) {
  return {
    "GTX-A": "GTX-A",
    "1호선": "1호선",
    "2호선": "2호선",
    "3호선": "3호선",
    "4호선": "4호선",
    "5호선": "5호선",
    "6호선": "6호선",
    "7호선": "7호선",
    "8호선": "8호선",
    "9호선": "9호선",
    "김포골드라인": "김포골드라인",
    "의정부경전철": "의정부",
    "인천1호선": "인천1호선",
    "인천2호선": "인천2호선",
    "경춘선": "경춘",
    "경의·중앙선": "경의중앙",
    "공항철도": "공항",
    "수인분당선": "수인분당",
    "신분당선": "신분당",
    "경강선": "경강",
    "용인경전철": "에버라인",
    "우이신설경전철": "우이신설",
    "서해": "서해선",
    "신림": "신림선",
  }[label] ?? null;
}

function lineColorFor(regionName, lineName) {
  return regionLineColors.get(`${regionName}:${lineName}`)
    ?? lineColors.get(lineName)
    ?? "#006D77";
}

const regionLineColors = new Map([
  ["부산:1호선", "#f06a00"],
  ["부산:2호선", "#81bf48"],
  ["부산:3호선", "#bb8c00"],
  ["부산:4호선", "#217dc1"],
  ["부산:동해", "#b7a36a"],
  ["부산:부산김해경전철", "#875cac"],
  ["대구:1호선", "#d93f3d"],
  ["대구:2호선", "#00aa80"],
  ["대구:3호선", "#f5c400"],
  ["대구:대경선", "#5b78b9"],
  ["광주:1호선", "#009088"],
  ["대전:1호선", "#007448"],
]);

function normalizeStationName(name) {
  return String(name).replace(/\s+/g, "").trim();
}

function normalizedStationNameForMap(name) {
  return normalizeHtmlText(name)
    .replace(/\([^)]*\)/g, "")
    .replace(/\[[^\]]*]/g, "")
    .replace(/[·.\s]/g, "")
    .replace(/역$/g, "")
    .trim();
}

function normalizeHtmlText(value) {
  return String(value)
    .replace(/<br\s*\/?>/gi, "")
    .replace(/<span class="blind">[\s\S]*?<\/span>/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&middot;/g, "·")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, "")
    .trim();
}

function labelDx(labelPos, marker, scale) {
  const lower = String(labelPos).toLowerCase();
  const inter = String(marker).includes("interchange") ? 6 : 0;
  if (lower.includes("e")) return 14 + inter;
  if (lower.includes("w")) return -14 - inter;
  return 0;
}

function labelDy(labelPos, marker, scale) {
  const lower = String(labelPos).toLowerCase();
  const inter = String(marker).includes("interchange") ? 6 : 0;
  if (lower.includes("s")) return 16 + inter;
  if (lower.includes("n")) return -14 - inter;
  return 0;
}

function moveTo(x, y) {
  return `M${roundPathNumber(x)},${roundPathNumber(y)}`;
}

function lineTo(x, y) {
  return ` L${roundPathNumber(x)},${roundPathNumber(y)}`;
}

function horizonTo(x) {
  return ` H${roundPathNumber(x)}`;
}

function verticalTo(y) {
  return ` V${roundPathNumber(y)}`;
}

function curveTo(cx, cy, x, y) {
  return ` Q${roundPathNumber(cx)},${roundPathNumber(cy)} ${roundPathNumber(x)},${roundPathNumber(y)}`;
}

function roundPathNumber(value) {
  return Number.parseFloat(Number(value).toFixed(2));
}

function edgeFor(lineId, from, to) {
  return {
    id: `edge-${lineId}-${from.stationId}-${to.stationId}`,
    fromNodeId: `${from.stationId}:${lineId}`,
    toNodeId: `${to.stationId}:${lineId}`,
    durationSeconds: 120,
    distanceMeters: 0,
    edgeType: "RIDE",
    servicePattern: "LOCAL",
    includesStairs: false,
    stairAccessState: "UNKNOWN",
    accessibilityStatus: "UNKNOWN",
    reliabilityScore: 80,
    lastVerifiedAt: verifiedAt,
  };
}

function representativeRoutes(edge) {
  const fallback = {
    id: "edge-sample",
    fromNodeId: "station-sample:line-sample",
    toNodeId: "station-sample-next:line-sample",
  };
  const selected = edge ?? fallback;
  return ["DIRECT", "TRANSFER", "MULTI_TRANSFER", "LOOP_BRANCH", "EXPRESS_LOCAL"].map((pattern) => ({
    id: `nationwide-${pattern.toLowerCase().replaceAll("_", "-")}`,
    pattern,
    fromNodeId: selected.fromNodeId,
    toNodeId: selected.toNodeId,
    requiredEdgeIds: [selected.id],
  }));
}

function rowFromCsv(row) {
  if (row.length < 6 || row[0] === "권역") {
    return null;
  }
  return {
    regionCode: row[0].trim(),
    regionName: row[1].trim(),
    operatorName: row[2].trim(),
    lineName: row[3].trim(),
    sequence: Number.parseInt(row[4].trim(), 10),
    stationName: row[5].trim(),
  };
}

function svgRowFromCsv(row) {
  if (row.length < 8 || row[0] === "SVG파일명") {
    return null;
  }
  return {
    svgFileName: row[0].trim(),
    lineName: row[2].trim(),
    stationName: row[3].trim(),
    upPath: row[4].trim(),
    downPath: row[5].trim(),
    svgOrder: Number.parseInt(row[6].trim(), 10),
  };
}

function svgRowsByKey(rows) {
  const byKey = new Map();
  for (const row of rows) {
    const regionCode = areaRegionCode(row.svgFileName);
    if (!regionCode || (!row.upPath && !row.downPath)) {
      continue;
    }
    const key = svgKey(regionCode, row.lineName, row.stationName);
    const existing = byKey.get(key);
    if (!existing || row.svgOrder < existing.svgOrder) {
      byKey.set(key, row);
    }
  }
  return byKey;
}

function areaRegionCode(svgFileName) {
  const match = /^area(\d{2})$/.exec(svgFileName);
  return match?.[1] ?? null;
}

function svgKey(regionCode, lineName, stationName) {
  return `${regionCode}:${normalizedLineName(lineName)}:${normalizedStationNameForMap(stationName)}`;
}

function firstMovePoint(path) {
  const match = /M\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/i.exec(path);
  if (!match) {
    return null;
  }
  return { x: Number.parseFloat(match[1]), y: Number.parseFloat(match[2]) };
}

function parseCsv(csv) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < csv.length; index += 1) {
    const char = csv[index];
    if (char === '"') {
      if (quoted && csv[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (char === "," && !quoted) {
      row.push(cell);
      cell = "";
      continue;
    }
    if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && csv[index + 1] === "\n") {
        index += 1;
      }
      row.push(cell);
      if (row.some((value) => value.trim() !== "")) {
        rows.push(row);
      }
      row = [];
      cell = "";
      continue;
    }
    cell += char;
  }
  if (cell || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function operatorIdFor(name) {
  return knownOperatorIds.get(name) ?? `operator-${hash(name)}`;
}

function preferredOperatorId(lineId, fallback) {
  if (lineId === "seoul-2" || lineId === "seoul-4" || lineId === "shinbundang" || lineId === "seoul-2-branch") {
    return "seoul-metro";
  }
  return fallback;
}

function lineIdFor(regionName, lineName) {
  return knownLineIds.get(`${regionName}:${lineName}`) ?? `line-${hash(`${regionName}:${lineName}`)}`;
}

function normalizedLineName(lineName) {
  return {
    "2호선 지선": "2호선",
    동해: "동해선",
    공항: "공항철도",
    신분당: "신분당선",
    서해선: "서해",
    에버라인: "용인에버라인",
    의정부: "의정부경전철",
  }[lineName] ?? lineName;
}

function stationIdFor(regionName, stationName) {
  return knownStationIds.get(`${regionName}:${stationName}`) ?? `station-${hash(`${regionName}:${stationName}`)}`;
}

function stationCodeFor(regionName, lineName, stationName, sequence) {
  if (regionName === "수도권" && lineName === "4호선" && stationName === "상록수") {
    return "448";
  }
  if (regionName === "수도권" && lineName === "4호선" && stationName === "사당") {
    return "433";
  }
  if (regionName === "수도권" && lineName === "2호선" && stationName === "사당") {
    return "226";
  }
  return String(sequence);
}

function regionLabel(regionName) {
  return regionName.endsWith("권") ? regionName : `${regionName}권`;
}

function sourceInventoryEntries() {
  const common = {
    owner: "국토교통부",
    license: "공공데이터포털 이용허락범위 제한 없음",
    licenseStatus: "redistributable",
    redistributionAllowed: true,
    updateFrequency: "annual",
    updatedAt: verifiedAt,
  };
  return [
    {
      ...common,
      id: sourceId,
      url: sourceUrl,
      fields: ["region", "operator_name", "line_name", "station_sequence", "station_name"],
    },
    {
      ...common,
      id: "molit-rail-station-svg-route",
      url: "https://www.data.go.kr/data/15130544/fileData.do",
      fields: ["svg_file_name", "line_name", "station_name", "up_path", "down_path", "svg_order"],
    },
    {
      id: seoulMetroSourceId,
      owner: "서울교통공사",
      url: "http://www.seoulmetro.co.kr/kr/cyberStation.do",
      license: "공식 웹 공개 노선도 기준",
      licenseStatus: "review-required",
      redistributionAllowed: false,
      updateFrequency: "unknown",
      updatedAt: verifiedAt,
      fields: ["line_color", "station_name", "station_coordinate", "label_position", "route_path"],
    },
    {
      id: humetroSourceId,
      owner: "부산교통공사",
      url: "https://www2.humetro.busan.kr/homepage/cyberstation/map.do",
      license: "공식 웹 공개 노선도 기준",
      licenseStatus: "review-required",
      redistributionAllowed: false,
      updateFrequency: "unknown",
      updatedAt: verifiedAt,
      fields: ["station_name", "station_coordinate", "label_position", "route_path"],
    },
    {
      id: grtcSourceId,
      owner: "광주교통공사",
      url: "https://www.grtc.co.kr/cyber/simple",
      license: "공식 웹 공개 노선도 기준",
      licenseStatus: "review-required",
      redistributionAllowed: false,
      updateFrequency: "unknown",
      updatedAt: verifiedAt,
      fields: ["station_name", "station_grid_area", "route_path"],
    },
    {
      id: dtroSourceId,
      owner: "대구교통공사",
      url: "https://www.dtro.or.kr/front/dtro/cyberstation/station/cyberstation.do",
      license: "공식 웹 공개 노선도 기준",
      licenseStatus: "review-required",
      redistributionAllowed: false,
      updateFrequency: "unknown",
      updatedAt: verifiedAt,
      fields: ["station_name", "image_map_coordinate", "route_path"],
    },
    {
      id: djtcSourceId,
      owner: "대전교통공사",
      url: "https://www.djtc.kr/kor/cyberStation.do?menuIdx=28",
      license: "공식 웹 공개 노선도 기준",
      licenseStatus: "review-required",
      redistributionAllowed: false,
      updateFrequency: "unknown",
      updatedAt: verifiedAt,
      fields: ["station_name", "station_coordinate", "route_path"],
    },
  ];
}

function hash(value) {
  return createHash("sha1").update(value).digest("hex").slice(0, 12);
}

function byId(left, right) {
  return left.id.localeCompare(right.id);
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    args[argv[index]?.replace(/^--/, "")] = argv[index + 1];
  }
  return args;
}

function requireArg(args, name) {
  const value = args[name];
  if (!value) {
    throw new Error(`--${name} is required`);
  }
  return value;
}

await main();
