#!/usr/bin/env node
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SOURCE_ID = "gwangju-transportation-cyberstation-timetable";
const BOOTSTRAP_URL = "https://www.grtc.co.kr/cyber";
const ENDPOINT = "https://www.grtc.co.kr/cyber/portlet/subwayTimetable";
const DETAIL_URL = "https://www.grtc.co.kr/subway/menu/trainTimetableSubMenu";
const LICENSE_URL = "https://www.data.go.kr/data/15111298/openapi.do";
const DAY_CODES = Object.freeze(["DAYOFF", "HOLI", "SAT", "WEEK"]);
const STATIONS = Object.freeze([
  ["01", "119", "평동역"], ["02", "118", "도산역"], ["03", "117", "광주송정역"],
  ["04", "116", "송정공원역"], ["05", "115", "공항역"], ["06", "114", "김대중컨벤션센터역"],
  ["07", "113", "상무역"], ["08", "112", "운천역"], ["09", "111", "쌍촌역"],
  ["10", "110", "화정역"], ["11", "109", "농성역"], ["12", "108", "돌고개역"],
  ["13", "107", "양동시장역"], ["14", "106", "금남로5가역"], ["15", "105", "금남로4가역"],
  ["16", "104", "문화전당역"], ["17", "103", "남광주역"], ["18", "102", "학동증심사입구역"],
  ["19", "101", "소태역"], ["20", "100", "녹동역"],
].map(([stationId, stationCode, stationName]) => ({ stationId, stationCode, stationName })));
const FRESHNESS_MILLIS = 24 * 60 * 60 * 1_000;

export async function collectGwangjuCyberstationTimetable({
  fetchImpl = fetch,
  now = new Date(),
  sleepImpl = sleep,
  concurrency = 4,
} = {}) {
  const capturedAt = validDate(now, "now");
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) throw new Error("concurrency is invalid");
  const session = await bootstrapSession(fetchImpl, sleepImpl);
  const fragments = new Array(STATIONS.length);
  let next = 0;
  let failure;
  const worker = async () => {
    while (!failure && next < STATIONS.length) {
      const index = next;
      next += 1;
      try {
        fragments[index] = await collectFragment({ station: STATIONS[index], fetchImpl, sleepImpl, session });
      } catch (error) {
        failure = error;
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  if (failure) throw failure;
  const rows = fragments.flatMap(({ rows: values }) => values).sort(compareRows);
  const excludedPlaceholderCount = fragments.reduce((total, fragment) => total + fragment.placeholderCount, 0);
  const normalizedBoundaryMinuteCount = fragments.reduce(
    (total, fragment) => total + fragment.boundaryMinuteCount,
    0,
  );
  validateRows(rows);
  const dayCodes = [...new Set(rows.map(({ dayCode }) => dayCode))].sort(compareText);
  if (JSON.stringify(dayCodes) !== JSON.stringify(DAY_CODES)) {
    throw new Error(`Gwangju cyberstation timetable schema mismatch: day codes=${dayCodes.join(",") || "missing"}`);
  }
  const directions = [...new Set(rows.map(({ direction }) => direction))].sort(compareText);
  if (JSON.stringify(directions) !== JSON.stringify(["nd", "pd", "st"])) {
    throw new Error(`Gwangju cyberstation timetable schema mismatch: directions=${directions.join(",") || "missing"}`);
  }
  const rowsSha256 = sha256(JSON.stringify(rows));
  const rawSha256 = sha256(JSON.stringify({
    bootstrapSha256: session.rawSha256,
    fragments: fragments.map(({ stationId, rawSha256: fragmentSha256 }) => ({
      stationId,
      rawSha256: fragmentSha256,
    })),
  }));
  const contentSha256 = sha256(JSON.stringify({
    fragments: fragments.map(({ stationId, rawSha256 }) => ({ stationId, rawSha256 })),
    rowsSha256,
  }));
  return {
    schemaVersion: 1,
    artifactKind: "gwangju-cyberstation-timetable-snapshot",
    sourceId: SOURCE_ID,
    detailUrl: DETAIL_URL,
    endpoint: ENDPOINT,
    capturedAt: capturedAt.toISOString(),
    freshUntil: new Date(capturedAt.getTime() + FRESHNESS_MILLIS).toISOString(),
    official: true,
    fixture: false,
    credentialRedacted: true,
    requestCount: fragments.length + 1,
    stationRequestCount: fragments.length,
    stationCount: STATIONS.length,
    rowCount: rows.length,
    excludedPlaceholderCount,
    normalizedBoundaryMinuteCount,
    dayCodes,
    directions,
    fieldsProvided: ["service_calendar", "trip", "stop_time"],
    license: {
      type: "UNRESTRICTED",
      attribution: "광주교통공사",
      redistributionAllowed: true,
      evidenceUrl: LICENSE_URL,
    },
    scope: STATIONS,
    scopeSha256: sha256(JSON.stringify(STATIONS)),
    bootstrapSha256: session.rawSha256,
    rawSha256,
    contentSha256,
    rowsSha256,
    fragments: fragments.map(({ rows: _rows, ...fragment }) => fragment),
    rows,
  };
}

async function bootstrapSession(fetchImpl, sleepImpl) {
  const response = await fetchWithRetry(fetchImpl, sleepImpl, BOOTSTRAP_URL, {
    method: "GET",
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
    headers: { accept: "text/html" },
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  const rawSha256 = sha256(bytes);
  if (!response.ok) {
    throw new Error(`Gwangju cyberstation timetable bootstrap HTTP ${response.status}; `
      + `rawBytes=${bytes.length}; rawSha256=${rawSha256}`);
  }
  const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() ?? "";
  if (contentType !== "text/html") {
    throw new Error(`Gwangju cyberstation timetable schema mismatch: content-type ${contentType || "missing"}; `
      + `bootstrap; rawSha256=${rawSha256}`);
  }
  const html = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const token = /\bvar\s+token\s*=\s*['"]([A-Za-z0-9-]{8,128})['"]\s*;/.exec(html)?.[1];
  const header = /\bvar\s+header\s*=\s*['"](X-XSRF-TOKEN)['"]\s*;/.exec(html)?.[1];
  const cookies = (response.headers.getSetCookie?.() ?? [response.headers.get("set-cookie")].filter(Boolean))
    .map((value) => value.split(";", 1)[0].trim())
    .filter((value) => /^[A-Za-z0-9_.-]+=[^;\s]{1,512}$/.test(value));
  if (!token || header !== "X-XSRF-TOKEN" || cookies.length === 0) {
    throw new Error(`Gwangju cyberstation timetable schema mismatch: bootstrap session; rawSha256=${rawSha256}`);
  }
  return { token, cookie: cookies.join("; "), rawSha256 };
}

async function collectFragment({ station, fetchImpl, sleepImpl, session }) {
  const body = new URLSearchParams([["lineNo", "1"], ["subwayid", station.stationId]]);
  const response = await fetchWithRetry(fetchImpl, sleepImpl, ENDPOINT, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
    headers: {
      accept: "text/html",
      "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
      AJAX: "true",
      "X-XSRF-TOKEN": session.token,
      cookie: session.cookie,
      origin: "https://www.grtc.co.kr",
      referer: "https://www.grtc.co.kr/cyber",
    },
    body: body.toString(),
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  const rawSha256 = sha256(bytes);
  if (!response.ok) {
    throw new Error(`Gwangju cyberstation timetable HTTP ${response.status}; station=${station.stationId}; `
      + `rawBytes=${bytes.length}; rawSha256=${rawSha256}`);
  }
  const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() ?? "";
  if (contentType !== "text/html") {
    throw new Error(`Gwangju cyberstation timetable schema mismatch: content-type ${contentType || "missing"}; `
      + `station=${station.stationId}; rawSha256=${rawSha256}`);
  }
  const html = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const { rows, placeholderCount, boundaryMinuteCount } = parseFragment(html, station);
  const dayCodes = [...new Set(rows.map(({ dayCode }) => dayCode))].sort(compareText);
  const directions = [...new Set(rows.map(({ direction }) => direction))].sort(compareText);
  if (JSON.stringify(dayCodes) !== JSON.stringify(DAY_CODES) || rows.length === 0) {
    throw new Error(`Gwangju cyberstation timetable schema mismatch: station ${station.stationId}; rawSha256=${rawSha256}`);
  }
  return {
    ...station,
    dayCodes,
    directions,
    rowCount: rows.length,
    placeholderCount,
    boundaryMinuteCount,
    rawSha256,
    rows,
  };
}

function parseFragment(html, station) {
  const directions = [...html.matchAll(/<div\s+class=["'](pd|nd)["'][^>]*>/gi)]
    .map((match) => ({ direction: match[1].toLowerCase(), index: match.index }));
  if (directions.length !== 2 || directions[0].direction !== "pd" || directions[1].direction !== "nd") {
    throw new Error(`Gwangju cyberstation timetable schema mismatch: station ${station.stationId}`);
  }
  const rows = [];
  let placeholderCount = 0;
  let boundaryMinuteCount = 0;
  for (const [index, entry] of directions.entries()) {
    const block = html.slice(entry.index, directions[index + 1]?.index ?? html.length);
    for (const item of block.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)) {
      const hour = /<strong\b[^>]*class=["'][^"']*\bhour\b[^"']*["'][^>]*>\s*(\d{2})/i.exec(item[1])?.[1];
      if (hour == null) continue;
      if (!/^(?:[01]\d|2\d)$/.test(hour)) {
        throw new Error(`Gwangju cyberstation timetable schema mismatch: station ${station.stationId} hour`);
      }
      for (const minuteMatch of item[1].matchAll(
        /<span\b[^>]*class=["']([^"']*\bminute\b[^"']*)["'][^>]*>\s*(\d{2})/gi,
      )) {
        const classes = minuteMatch[1].split(/\s+/).filter(Boolean);
        const dayCodes = DAY_CODES.filter((code) => classes.includes(code));
        const minute = minuteMatch[2];
        if (minute === "99" && dayCodes.length > 0) {
          placeholderCount += dayCodes.length;
          continue;
        }
        if (dayCodes.length === 0 || Number(minute) > 60) {
          const knownClasses = classes.filter((value) => value === "minute" || DAY_CODES.includes(value)
            || /^(?:nd|pd|st)$/.test(value)).sort(compareText);
          throw new Error(`Gwangju cyberstation timetable schema mismatch: station ${station.stationId} minute; `
            + `dayCodes=${dayCodes.length}; minuteRangeValid=${Number(minute) <= 59}; `
            + `knownClasses=${knownClasses.join("+") || "none"}`);
        }
        const isNokdong = entry.direction === "nd" && classes.includes("nd");
        const direction = entry.direction === "pd" ? "pd" : isNokdong ? "nd" : "st";
        const [endCode, endName] = direction === "pd"
          ? ["119", "평동역"]
          : direction === "nd" ? ["100", "녹동역"] : ["101", "소태역"];
        const normalizedTime = minute === "60"
          ? `${String(Number(hour) + 1).padStart(2, "0")}00`
          : `${hour}${minute}`;
        if (minute === "60") boundaryMinuteCount += dayCodes.length;
        rows.push(...dayCodes.map((dayCode) => ({
          ...station,
          dayCode,
          direction,
          endCode,
          endName,
          time: normalizedTime,
        })));
      }
    }
  }
  return { rows, placeholderCount, boundaryMinuteCount };
}

function validateRows(rows) {
  const keys = new Set();
  for (const row of rows) {
    const key = [row.stationId, row.dayCode, row.direction, row.endCode, row.time].join(":");
    if (keys.has(key)) throw new Error("Gwangju cyberstation timetable schema mismatch: duplicate row");
    keys.add(key);
  }
  if (new Set(rows.map(({ stationId }) => stationId)).size !== STATIONS.length) {
    throw new Error("Gwangju cyberstation timetable schema mismatch: station scope incomplete");
  }
}

async function fetchWithRetry(fetchImpl, sleepImpl, url, init) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(15_000) });
      if (attempt === 0 && (response.status === 429 || response.status >= 500)) {
        await sleepImpl(250);
        continue;
      }
      return response;
    } catch (error) {
      if (attempt === 1) {
        const code = error?.code ?? error?.cause?.code ?? "UNKNOWN";
        throw new Error(`Gwangju cyberstation timetable transport failure; code=${safeToken(String(code))}`);
      }
    }
  }
  throw new Error("Gwangju cyberstation timetable transport failure");
}

function validDate(value, label) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${label} is invalid`);
  return date;
}
function safeToken(value) { return /^[A-Za-z0-9._-]{1,32}$/.test(value) ? value : "UNKNOWN"; }
function compareText(left, right) { return left.localeCompare(right, "en"); }
function compareRows(left, right) {
  return [left.stationId, left.dayCode, left.direction, left.endCode, left.time].join(":")
    .localeCompare([right.stationId, right.dayCode, right.direction, right.endCode, right.time].join(":"), "en");
}
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function sleep(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }

async function main(args = process.argv.slice(2)) {
  if (args.length !== 2 || args[0] !== "--output") {
    throw new Error("usage: collect-gwangju-cyberstation-timetable.mjs --output <absolute.json>");
  }
  const output = args[1];
  if (!path.isAbsolute(output)) throw new Error("output must be absolute");
  const snapshot = await collectGwangjuCyberstationTimetable();
  await writeFile(output, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
  console.log(`sanitized Gwangju cyberstation timetable snapshot ready: stations=${snapshot.stationCount}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Gwangju cyberstation timetable collection failed");
    process.exitCode = 1;
  }
}
