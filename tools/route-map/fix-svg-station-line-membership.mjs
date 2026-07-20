#!/usr/bin/env node
// #2068 마감 감사 Phase C: SVG 역 마커의 data-line/data-transfer-lines 오표기를
// 팩(station_lines, 진본)과 대조해 전수 색출·수정한다. 실측 사례(2026-07-18):
// 고촌 마커가 data-line="gtx-a"로 오기(진짜는 김포골드라인) — apply-sma-svg-positions.mjs의
// resolveStationIds는 역명+수도권 멤버십으로 해소해 이 오기에 영향받지 않지만
// (station_lines.line_id가 아니라 slug를 힌트로만 쓰므로), 신설 감사 도구
// (audit-octolinear-node-on-stroke.mjs)는 raw data-line/data-transfer-lines를
// 그대로 신뢰해 거짓 위반(예: 고촌↔gtx-a 150px)을 낸다. 이 도구가 SVG 속성
// 텍스트 자체를 교정해 두 소비자 모두의 진짜 baseline을 확보한다(마커 좌표는
// 불변 — 텍스트 속성만 수정).
//
// 방법: geometry.json의 stationNodes를 canonicalStationName(SEOUL.canonicalRules)
// 으로 정규화하고, 그 이름의 수도권 station_lines 실제 멤버십(진본)을 slug로
// 환산해 declared(raw data-line/data-transfer-lines)와 비교한다. 콜론 동명이역
// (신촌/양평 disambiguateByLine)은 slug 자체가 신원 식별 근거라 자동수정 대상에서
// 제외한다(오표기가 아니라 설계).
//
// Usage: node tools/route-map/fix-svg-station-line-membership.mjs
//          [--svg tools/route-map/route-map-defs/svg-sources/easy-subway-sma-v2.svg]
//          [--geometry tools/route-map/route-map-defs/easy-subway-sma-v2-geometry.json]
//          [--pack apps/mobile/assets/datapacks/capital.sqlite.gz]
//          [--dry-run] [--json out.json]

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { canonicalStationName, resolveLineMap } from "./apply-sma-svg-positions.mjs";
import { openPack, cleanupPackDir, repoRoot } from "./pack-io.mjs";
import { SEOUL } from "./sma-region-configs.mjs";

function resolveRepo(p) {
  return path.isAbsolute(p) ? p : path.join(repoRoot, p);
}

/** slug 집합 문자열 정렬 비교용 키. */
function slugSetKey(slugs) {
  return [...new Set(slugs)]
    .filter(Boolean)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .join(" ");
}

/**
 * 캐노니컬 역명의 수도권 실제 소속 노선 slug 집합(진본)을 station_lines에서
 * 구한다. resolveStationIds의 "그 외 동명" 분기와 동일 로직(regional 필터)을
 * 재사용하되, 여기서는 broadcast 대신 실제 소속 line_id 전부를 모은다.
 */
function trueSlugsForName(db, name, lineIdToSlug, prefix) {
  const stationRows = db.prepare("SELECT id FROM stations WHERE name_ko = ?").all(name);
  const slugs = new Set();
  for (const s of stationRows) {
    const lineRows = db
      .prepare(
        `SELECT sl.line_id AS lineId FROM station_lines sl JOIN lines l ON l.id=sl.line_id
         WHERE sl.station_id=? AND l.name_ko LIKE ?`,
      )
      .all(s.id, `${prefix} %`);
    for (const r of lineRows) {
      const slug = lineIdToSlug.get(r.lineId);
      if (slug) slugs.add(slug);
    }
  }
  return slugs;
}

/** id="<eid>" 요소(자체닫힘 <.../> 또는 일반 <...>)의 여는 태그 범위. end는
 *  닫는 '>'(자체닫힘이면 '/>') 직후 — slice(start,end)에 태그 전체가 그대로 담긴다. */
function findOpenTagRange(svgText, eid, tag) {
  const idAttr = `id="${eid}"`;
  const idPos = svgText.indexOf(idAttr);
  if (idPos === -1) return null;
  const tagOpen = `<${tag}`;
  const start = svgText.lastIndexOf(tagOpen, idPos);
  if (start === -1) return null;
  const nextLt = svgText.indexOf("<", start + 1);
  if (nextLt !== -1 && nextLt < idPos) return null; // 다른 요소의 id 텍스트 오탐 방지
  const gt = svgText.indexOf(">", idPos);
  if (gt === -1) return null;
  return { start, end: gt + 1 };
}

function setAttr(tagText, name, value) {
  const re = new RegExp(`\\b${name}="[^"]*"`);
  if (re.test(tagText)) return tagText.replace(re, `${name}="${value}"`);
  // 속성이 없으면 태그 끝(> 또는 />) 직전에 추가.
  const selfClose = /\/>\s*$/.test(tagText);
  const insertion = ` ${name}="${value}"`;
  if (selfClose) return tagText.replace(/\/>\s*$/, `${insertion}/>`);
  return tagText.replace(/>\s*$/, `${insertion}>`);
}

/**
 * 노드 하나의 declared(raw) slug 집합과 true(팩) slug 집합을 비교해 불일치면
 * 패치 계획을 반환한다(패치 없음이면 null). 순수 함수 — svgText는 읽기만.
 */
export function planNodeFix(node, trueSlugs, config) {
  const canon = config.canonicalRules(node.dataStation);
  if (canon.disambiguateByLine) return null; // 콜론 동명이역은 slug가 신원 근거 — 제외.
  const declared = new Set();
  if (node.dataLine) declared.add(node.dataLine);
  for (const t of String(node.transferLines || "").split(/[\s,]+/)) if (t) declared.add(t);
  if (slugSetKey([...declared]) === slugSetKey([...trueSlugs])) return null;
  if (trueSlugs.size === 0) return null; // 팩에 없는 역(위상 예외 등) — 자동수정 대상 아님.
  return {
    canonName: canon.name,
    declared: [...declared],
    trueSlugs: [...trueSlugs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
  };
}

/**
 * 환승 마커의 주 data-line slug를 고른다. 기존 data-line이 진본 소속 노선
 * 집합(sortedTrueSlugs)에 있으면 그대로 유지하고, 아니면 정렬된 첫 slug로
 * 교체한다. 순수 함수.
 */
export function resolvePrimarySlug(dataLine, sortedTrueSlugs) {
  return sortedTrueSlugs.includes(dataLine) ? dataLine : sortedTrueSlugs[0];
}

export function main() {
  const argv = process.argv.slice(2);
  const o = {
    svg: "tools/route-map/route-map-defs/svg-sources/easy-subway-sma-v2.svg",
    geometry: "tools/route-map/route-map-defs/easy-subway-sma-v2-geometry.json",
    pack: "apps/mobile/assets/datapacks/capital.sqlite.gz",
    dryRun: false,
    json: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    switch (argv[i]) {
      case "--svg": o.svg = argv[++i]; break;
      case "--geometry": o.geometry = argv[++i]; break;
      case "--pack": o.pack = argv[++i]; break;
      case "--dry-run": o.dryRun = true; break;
      case "--json": o.json = argv[++i]; break;
    }
  }

  const geometry = JSON.parse(readFileSync(resolveRepo(o.geometry), "utf8"));
  let svgText = readFileSync(resolveRepo(o.svg), "utf8");
  const { db, dir } = openPack(o.pack, "fix-line-membership-");
  let mismatches = [];
  let applied = [];
  let skippedNoElement = [];
  try {
    const slugToId = resolveLineMap(db, SEOUL);
    const lineIdToSlug = new Map([...slugToId.entries()].map(([slug, id]) => [id, slug]));
    const colorBySlug = new Map(
      Object.entries(SEOUL.colorToSlug).map(([color, slug]) => [slug, color]),
    );
    const nameCache = new Map();
    const trueSlugsFor = (name) => {
      if (!nameCache.has(name)) {
        nameCache.set(name, trueSlugsForName(db, name, lineIdToSlug, SEOUL.lineNamePrefix));
      }
      return nameCache.get(name);
    };

    for (const node of geometry.stationNodes ?? []) {
      const trueSlugs = trueSlugsFor(canonicalStationName(node.dataStation).name);
      const plan = planNodeFix(node, trueSlugs, SEOUL);
      if (!plan) continue;
      mismatches.push({ station: node.dataStation, id: node.id, tag: node.tag, ...plan });

      const range = findOpenTagRange(svgText, node.id, node.tag);
      if (!range) {
        skippedNoElement.push({ station: node.dataStation, id: node.id });
        continue;
      }
      let tagText = svgText.slice(range.start, range.end);
      const hasTransferAttr = /\bdata-transfer-lines="/.test(tagText);
      if (hasTransferAttr) {
        const sorted = [...plan.trueSlugs].sort((a, b) =>
          a < b ? -1 : a > b ? 1 : 0,
        );
        tagText = setAttr(tagText, "data-transfer-lines", sorted.join(" "));
        tagText = setAttr(tagText, "data-transfer-line-count", String(sorted.length));
        // 주 data-line은 정렬된 첫 slug로(기존이 진짜 목록에 있으면 유지).
        const primary = resolvePrimarySlug(node.dataLine, sorted);
        tagText = setAttr(tagText, "data-line", primary);
        tagText = setAttr(tagText, "data-line-name", `${SEOUL.slugToSuffix[primary] ?? primary}`);
        if (colorBySlug.has(primary)) tagText = setAttr(tagText, "data-line-color", colorBySlug.get(primary));
      } else {
        if (plan.trueSlugs.length !== 1) {
          skippedNoElement.push({
            station: node.dataStation,
            id: node.id,
            reason: `단일 마커인데 진본 소속 노선이 ${plan.trueSlugs.length}개(${plan.trueSlugs.join(",")}) — 수동 확인 필요`,
          });
          continue;
        }
        const slug = plan.trueSlugs[0];
        tagText = setAttr(tagText, "data-line", slug);
        tagText = setAttr(tagText, "data-line-name", `${SEOUL.slugToSuffix[slug] ?? slug}`);
        if (colorBySlug.has(slug)) tagText = setAttr(tagText, "data-line-color", colorBySlug.get(slug));
      }
      svgText = svgText.slice(0, range.start) + tagText + svgText.slice(range.end);
      applied.push({ station: node.dataStation, id: node.id, from: plan.declared, to: plan.trueSlugs });
    }
  } finally {
    cleanupPackDir(dir);
  }

  console.log(
    `[Phase C] data-line 전수 대조 ${geometry.stationNodes?.length ?? 0}개 노드 · 불일치 ${mismatches.length}건 · 수정 적용 ${applied.length}건 · 수동확인 필요 ${skippedNoElement.length}건`,
  );
  for (const m of mismatches) {
    console.log(`  ${m.station}(${m.id}): declared=[${m.declared.join(",")}] → true=[${m.trueSlugs.join(",")}]`);
  }
  if (skippedNoElement.length) {
    console.log("  수동확인 필요:");
    for (const s of skippedNoElement) console.log(`    ${s.station}(${s.id}) — ${s.reason ?? "요소 미발견"}`);
  }
  if (o.json) {
    writeFileSync(
      resolveRepo(o.json),
      JSON.stringify({ mismatches, applied, skippedNoElement }, null, 2) + "\n",
    );
  }
  if (!o.dryRun) {
    writeFileSync(resolveRepo(o.svg), svgText);
    console.log(`SVG 갱신: ${o.svg}`);
  } else {
    console.log("(--dry-run: SVG 미기록)");
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
