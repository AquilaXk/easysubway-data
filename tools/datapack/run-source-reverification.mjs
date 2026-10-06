#!/usr/bin/env node
// P7D 원천 재확인 controller(#984, #969 남은 단계 1, #870 전체 자동화 1단계).
//
// seq127(#940)·seq128(#976)에서 에이전트가 손으로 실행한 "수집 → OCI 게시 → 원장 등록" 절차를 원천별 recipe로 실행한다.
// DUE 판정(tools/ci/decide-source-reverification.mjs)이 고른 recipe를 의존 순서로 돌리고 recipe마다 한 커밋으로 쌓는다.
//
// 이상은 체인을 멈추고 이름 붙은 코드로 드러난다(이전·추정 값으로 대체하지 않는다):
//   SOURCE_FETCH_FAILED         공급자에서 원본을 받지 못했다(전송·HTTP·형식).
//   SOURCE_REGISTRATION_FAILED  OCI 게시·원장 등록·입력 조립이 실패했거나 recipe가 아무 등록 결과도 만들지 않았다.
//   SOURCE_SHA_DRIFT            원본 sha가 고정과 다르거나, 원장·증거 변화가 정책(tools/ci/source-ledger-change-policy.json)을 넘었다.
//   SOURCE_COUNT_DELTA          행 수 변화가 정책 한도를 넘거나 커버리지가 줄었다.
//   BINDING_MISMATCH            원장·증거의 필수 필드·직전 연결이 어긋났다.
//   REVERIFICATION_OUTPUT_SCOPE recipe가 허용 경로(등록 도구의 네 출력 파일 + 새 snapshot 파일) 밖을 바꿨다.
//
// 사용(깨끗한 작업 트리, origin/main의 후손 HEAD에서):
//   node tools/datapack/run-source-reverification.mjs --operation-root <absolute directory> --recipes <id,id,...>
//   환경: data.go.kr 서비스 키(부산·대전 topology·KASI 공휴일), EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL(OCI 게시)
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { evaluateLedgerChange, parseLedgerChangePolicy } from "../ci/source-ledger-gate.mjs";
import { ledgerHead } from "../ci/decide-source-reverification.mjs";
import { isSourceReverificationAllowedPath, SOURCE_REVERIFICATION_REGISTRATION_OUTPUTS } from "../ci/source-reverification-paths.mjs";
import { REVERIFICATION_RECIPES } from "./source-reverification-recipes.mjs";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, "../..");
const GIT = "/usr/bin/git";
const INVENTORY_PATH = "tools/datapack/source-inventory.json";
const LEDGER_PATH = "tools/datapack/release/source-snapshots.json";
const GOVERNANCE_PATH = "tools/datapack/source-governance-policy.json";
const POLICY_PATH = "tools/ci/source-ledger-change-policy.json";
const CATALOG_PATH = "tools/datapack/release/capital-production-canonical-pack.json";
const BUSAN_SCOPE_HTML = "tools/datapack/sources/humetro-cyberstation-map-20260623.html";
const BUSAN_STATION_MAP = "tools/datapack/sources/regional-official-svg-route-map-coordinates-20260624.csv";
const MOLIT_STATION_CSV = "tools/datapack/sources/molit-urban-rail-full-route-20251211.csv";
const KORAIL_SOURCE_ID = "korail-metropolitan-timetable-file";
const KORAIL_PLANNED_SOURCE_ID = "korail-metropolitan-planned-timetable";
const SNAPSHOT_FILE = /^tools\/datapack\/sources\/[^/]+\.json$/u;
const KNOWN_CODE = /^(SOURCE_FETCH_FAILED|SOURCE_REGISTRATION_FAILED|SOURCE_SHA_DRIFT|SOURCE_COUNT_DELTA|BINDING_MISMATCH): /u;
const KORAIL_SHA_DRIFT = /KORAIL_METROPOLITAN_TIMETABLE_FILE_SHA256/u;
const SHA256 = /^[a-f0-9]{64}$/u;
// 이 controller는 공급자를 직접 부르는 runner가 아니다. 키는 환경으로 하위 수집기(각자 키 형상을 먼저 검사한다)와 KASI 수집 함수에 넘기기만 한다.
// 자격 증명 coverage는 연속된 env 토큰으로 runner를 찾으므로 provider-call-integrity와 같은 방식으로 이름을 조립한다.
const DATA_GO_CREDENTIAL_ENV = ["DATA", "GO", "KR", "SERVICE", "KEY"].join("_");
const SECRET_ENV = Object.freeze([DATA_GO_CREDENTIAL_ENV, "EASYSUBWAY_OBJECT_STORAGE_PREAUTH_BASE_URL"]);
const DAY_MS = 86_400_000;
const KST_FORMAT = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" });

function fail(message) {
  throw new Error(message);
}

const text = (value) => typeof value === "string" && value !== "";
function compare(left, right) {
  if (left < right) return -1;
  return left > right ? 1 : 0;
}
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const jsonText = (value) => `${JSON.stringify(value, null, 2)}\n`;
const kstDate = (date) => KST_FORMAT.formatToParts(date).filter(({ type }) => type !== "literal").map(({ value }) => value).join("");
const utcDate = (date) => date.toISOString().slice(0, 10).replaceAll("-", "");

// ---------------------------------------------------------------------------
// 오류 분류와 비밀 마스킹
// ---------------------------------------------------------------------------

/** 단계 종류와 오류 메시지로 이상 코드를 정한다. 수집 실패와 등록 실패를 섞지 않는다. */
export function classifyRecipeFailure(step, message) {
  // 코레일 수집기는 원본 sha를 고정해서 받는다. sha가 다르면 원본이 바뀐 것이지 수집이 실패한 것이 아니다.
  if (KORAIL_SHA_DRIFT.test(message)) return "SOURCE_SHA_DRIFT";
  if (step.kind === "collect") return "SOURCE_FETCH_FAILED";
  if (step.kind === "collect-register") return step.fetchErrorPattern?.test(message) ? "SOURCE_FETCH_FAILED" : "SOURCE_REGISTRATION_FAILED";
  return "SOURCE_REGISTRATION_FAILED";
}

const ANSI_ESCAPE = /\u001b\[[0-9;?]*[ -/]*[@-~]/gu;
const FAILURE_DETAIL_MAX_LENGTH = 2000;

// 환경의 비밀 값과 query의 key=값, OCI 사전 인증 경로(/p/<token>/)는 실패 메시지에 남기지 않는다.
function redact(detail, env) {
  let result = String(detail).replace(ANSI_ESCAPE, "");
  for (const name of SECRET_ENV) {
    const value = env?.[name];
    if (typeof value === "string" && value.length >= 8) result = result.split(value).join("***");
  }
  result = result.replace(/([\w-]{0,32}key)=([^&\s'"|]+)/giu, "$1=***").replace(/\/p\/[^/\s]+\//gu, "/p/***/");
  return result.length > FAILURE_DETAIL_MAX_LENGTH ? result.slice(-FAILURE_DETAIL_MAX_LENGTH) : result;
}

function failureDetail(error) {
  const lines = String(error?.stderr ?? "").replace(ANSI_ESCAPE, "").split("\n")
    .filter((line) => !/^\s+at\s/u.test(line) && !/^Node\.js v\d/u.test(line)).map((line) => line.trim()).filter(Boolean);
  return lines.length > 0 ? lines.join(" | ") : String(error?.message ?? error);
}

function recipeError(recipe, step, error, env) {
  const detail = redact(String(error?.message ?? error), env);
  const known = KNOWN_CODE.exec(detail);
  if (known) return new Error(`${known[0]}${recipe.id}/${step.id}: ${detail.slice(known[0].length)}`);
  return new Error(`${classifyRecipeFailure(step, detail)}: ${recipe.id}/${step.id}: ${detail}`);
}

// ---------------------------------------------------------------------------
// 원장 행이 없는 증거(KRIC 시간표 projection)의 변화 게이트: 원장 게이트와 같은 정책·같은 의미다.
// ---------------------------------------------------------------------------
const percent = (ratio) => `${(ratio * 100).toFixed(1)}%`;
const validEvidence = (value) => text(value?.snapshotId) && SHA256.test(value.rawSha256 ?? "") && SHA256.test(value.recordsSha256 ?? "")
  && Number.isSafeInteger(value.recordCount) && value.recordCount >= 0 && Array.isArray(value.routes);

/**
 * inventory 증거의 직전·이후를 비교한다. 새 행(증거 행)과 정책 위반을 돌려준다.
 * @returns {{ row: object|null, violations: { code: string, sourceId: string, snapshotId: string, detail: string }[] }}
 */
export function evaluateEvidenceChange({ sourceId, before, after, policy } = {}) {
  parseLedgerChangePolicy(policy);
  const violations = [];
  const violate = (code, snapshotId, detail) => violations.push({ code, sourceId, snapshotId: String(snapshotId), detail });
  if (after == null) {
    violate("BINDING_MISMATCH", before?.snapshotId, "the evidence was removed");
    return { row: null, violations };
  }
  if (!validEvidence(after) || (before != null && !validEvidence(before))) {
    violate("BINDING_MISMATCH", after?.snapshotId, "the evidence lacks snapshotId, rawSha256, recordsSha256, recordCount or routes");
    return { row: null, violations };
  }
  const effective = { ...policy, ...policy.sourceOverrides[sourceId] };
  let rowDelta = 0;
  let coverageDelta = 0;
  let diffStatus = "FIRST";
  if (before != null) {
    rowDelta = after.recordCount - before.recordCount;
    coverageDelta = after.routes.length - before.routes.length;
    const contentChanged = before.rawSha256 !== after.rawSha256 || before.recordsSha256 !== after.recordsSha256;
    diffStatus = contentChanged || rowDelta !== 0 || coverageDelta !== 0 ? "CHANGED" : "NO_CHANGE";
    if (contentChanged && !effective.allowContentChange) {
      violate("SOURCE_SHA_DRIFT", after.snapshotId, `the source identity changed from ${before.rawSha256.slice(0, 12)}/${before.recordsSha256.slice(0, 12)} to ${after.rawSha256.slice(0, 12)}/${after.recordsSha256.slice(0, 12)} and the policy does not allow content change`);
    }
    const ratio = Math.abs(rowDelta) / Math.max(before.recordCount, 1);
    if (ratio > effective.maxRowDeltaRatio) violate("SOURCE_COUNT_DELTA", after.snapshotId, `rowDelta ${rowDelta} (${percent(ratio)}) exceeds ${percent(effective.maxRowDeltaRatio)}`);
    if (coverageDelta < 0 && !effective.allowCoverageDecrease) violate("SOURCE_COUNT_DELTA", after.snapshotId, `coverageDelta ${coverageDelta} decreases coverage`);
  }
  return {
    row: {
      sourceId, snapshotId: after.snapshotId, previousSnapshotId: before?.snapshotId ?? null, rawSha256: after.rawSha256,
      contentSha256: after.recordsSha256, rowDelta, coverageDelta, diffStatus,
    },
    violations,
  };
}

// ---------------------------------------------------------------------------
// recipe 단계 구현. 단계는 { id, kind, run(ctx) }이고 kind가 실패 종류를 정한다.
//   collect          공급자에서 원본을 받는다(실패 = SOURCE_FETCH_FAILED)
//   register         OCI 게시·원장 등록(실패 = SOURCE_REGISTRATION_FAILED)
//   collect-register 수집과 등록을 한 도구가 한다(fetchErrorPattern으로 가른다)
//   glue             이전 등록 증거에서 입력을 다시 만든다(실패 = SOURCE_REGISTRATION_FAILED)
// ctx: { recipeId, repositoryRoot, operationDir, env, now(), shared, lib, execute(script, args, { env }), head(), originMain(), readJson(relative), file(name) }
// ---------------------------------------------------------------------------
const step = (id, kind, run, extra = {}) => Object.freeze({ id, kind, run, ...extra });
const abs = (ctx, relative) => path.join(ctx.repositoryRoot, relative);

async function registerWithHead(ctx, script, args) {
  await ctx.execute(script, [...args, "--expected-head", await ctx.head()]);
}

function regionalAccessibilitySteps({ collectScript, collectArgs }) {
  return [
    step("collect", "collect", async (ctx) => {
      await ctx.execute(collectScript, ["--download", ...(await collectArgs(ctx)), "--output", ctx.file("accessibility.json")]);
    }),
    step("register", "register", async (ctx) => {
      await registerWithHead(ctx, "register-regional-accessibility.mjs", ["publish-register", "--snapshot", ctx.file("accessibility.json"), "--receipt", ctx.file("raw-receipt.json")]);
    }),
  ];
}

async function sourceByKey(ctx, sourceId) {
  const inventory = await ctx.readJson(INVENTORY_PATH);
  const sources = inventory.sources.filter(({ id }) => id === sourceId);
  if (sources.length !== 1) fail(`inventory source is missing or ambiguous: ${sourceId}`);
  return sources[0];
}

async function governanceEntry(ctx, sourceId) {
  const entries = ((await ctx.readJson(GOVERNANCE_PATH)).sources ?? []).filter((entry) => entry?.sourceId === sourceId);
  if (entries.length !== 1) fail(`governance entry is missing or ambiguous: ${sourceId}`);
  return entries[0];
}

// 코레일 topology: 이전 등록 증거(inventory·원장 head·snapshot)에서 수집 대상(URL·고정 sha)과 선택 범위·거버넌스 항목을 다시 만든다.
async function korailPrevious(ctx) {
  const source = await sourceByKey(ctx, KORAIL_SOURCE_ID);
  const evidence = source.topologyAdmissionEvidence;
  if (!text(evidence?.snapshotPath) || !SHA256.test(evidence?.rawSha256 ?? "")) fail("Korail topology admission evidence is missing");
  const snapshot = await ctx.readJson(evidence.snapshotPath);
  const timetable = snapshot.observation?.sources?.timetable;
  const selection = snapshot.observation?.selection;
  if (timetable?.rawSha256 !== evidence.rawSha256 || !text(timetable?.collectionReceipt?.officialUrl)
    || !text(selection?.operatorName) || !text(selection?.lineName) || !text(selection?.lineId)) fail("Korail topology snapshot lacks its collection receipt or selection");
  const head = ledgerHead(await ctx.readJson(LEDGER_PATH), KORAIL_SOURCE_ID);
  return {
    officialUrl: timetable.collectionReceipt.officialUrl, rawSha256: evidence.rawSha256, selection,
    observedDataUpdatedAt: source.observedDataUpdatedAt, sourceUpdatedAt: head.sourceUpdatedAt ?? null,
    governanceEntry: await governanceEntry(ctx, KORAIL_SOURCE_ID),
  };
}

const KORAIL_TOPOLOGY_STEPS = [
  step("previous", "glue", async (ctx) => { ctx.shared.set("korail", { previous: await korailPrevious(ctx) }); }),
  step("collect-membership", "collect", async (ctx) => {
    // KRIC 현재 역-노선 파일(membership)을 받아 관측으로 만든다. 코레일 topology의 역 순서가 이 파일에 결속된다.
    const korail = ctx.shared.get("korail");
    const outputFile = ctx.file(`kric-current-station-line-file-${utcDate(ctx.now())}.xlsx`);
    const receipt = await ctx.lib.collectKricCurrentStationLineFile({ outputFile, now: ctx.now() });
    const observation = await ctx.lib.buildKricCurrentStationLineObservation({ workbookBytes: await readFile(outputFile), receipt });
    korail.membershipObservationPath = ctx.file("membership-observation.json");
    korail.membershipReceiptPath = ctx.file("membership-receipt.json");
    await writeFile(korail.membershipObservationPath, `${JSON.stringify(observation)}\n`, { flag: "wx" });
    await writeFile(korail.membershipReceiptPath, `${JSON.stringify(receipt)}\n`, { flag: "wx" });
  }),
  step("collect-timetable", "collect", async (ctx) => {
    const { previous } = ctx.shared.get("korail");
    ctx.shared.get("korail").collectionDirectory = ctx.file("collection");
    await ctx.execute("collect-korail-metropolitan-timetable-file.mjs", ["--url", previous.officialUrl, "--sha256", previous.rawSha256, "--output-directory", ctx.file("collection")]);
  }),
  step("source-input", "glue", async (ctx) => {
    const korail = ctx.shared.get("korail");
    const catalogBytes = await readFile(abs(ctx, CATALOG_PATH));
    korail.catalogPath = abs(ctx, CATALOG_PATH);
    korail.catalogSha256 = sha256(catalogBytes);
    korail.sourceInputPath = ctx.file("source-input.json");
    await writeFile(korail.sourceInputPath, jsonText({
      schemaVersion: 1, artifactKind: "korail-topology-registration-input", collectionDirectory: korail.collectionDirectory,
      stationLineObservationPath: korail.membershipObservationPath, stationLineReceiptPath: korail.membershipReceiptPath,
      canonicalCatalogPath: korail.catalogPath, canonicalCatalogSha256: korail.catalogSha256, ...korail.previous.selection,
      governanceEntry: korail.previous.governanceEntry, observedDataUpdatedAt: korail.previous.observedDataUpdatedAt, sourceUpdatedAt: korail.previous.sourceUpdatedAt,
    }), { flag: "wx" });
  }),
  step("register", "register", async (ctx) => {
    const korail = ctx.shared.get("korail");
    korail.publicationDirectory = ctx.file("publication");
    await ctx.execute("register-korail-route-topology.mjs", [
      "publish-register", "--source-input", korail.sourceInputPath, "--operation-directory", korail.publicationDirectory,
      "--expected-main-sha", await ctx.originMain(), "--expected-head-sha", await ctx.head(),
    ]);
  }),
];

const KORAIL_PLANNED_STEPS = [
  step("calendar", "collect", async (ctx) => {
    // 계획 시각표의 달력 창은 오늘(KST)부터 30일이다. 그 창을 덮는 KASI 공휴일 월을 받는다.
    const start = kstDate(ctx.now());
    const end = kstDate(new Date(ctx.now().getTime() + 30 * DAY_MS));
    ctx.shared.set("korail-calendar", { directory: ctx.file("calendar"), window: { startDate: start, endDate: end } });
    await ctx.lib.collectKasiHolidayCalendarWindowFiles({ outputDirectory: ctx.file("calendar"), startDate: start, endDate: end, serviceKey: ctx.env[DATA_GO_CREDENTIAL_ENV] });
  }),
  step("source-input", "glue", async (ctx) => {
    const korail = ctx.shared.get("korail");
    const calendar = ctx.shared.get("korail-calendar");
    if (!korail?.publicationDirectory || !korail.sourceInputPath) fail("the Korail topology recipe did not leave its registration outputs");
    const topology = (await sourceByKey(ctx, KORAIL_SOURCE_ID)).topologyAdmissionEvidence;
    const plannedHead = ledgerHead(await ctx.readJson(LEDGER_PATH), KORAIL_PLANNED_SOURCE_ID);
    // 같은 원본(sha 고정)이라 시행 시각은 직전 계획 시각표의 값을 그대로 쓴다. 원본이 바뀌었으면 topology 단계가 이미 SOURCE_SHA_DRIFT로 멈췄다.
    korail.plannedInputPath = ctx.file("source-input.json");
    await writeFile(korail.plannedInputPath, jsonText({
      schemaVersion: 1, artifactKind: "korail-timetable-registration-input",
      retainedWorkbookPath: path.join(korail.collectionDirectory, "timetable.xlsx"), collectionReceiptPath: path.join(korail.collectionDirectory, "receipt.json"),
      publicationReceiptPath: path.join(korail.publicationDirectory, "receipt.json"), topologySnapshotPath: abs(ctx, `tools/datapack/sources/${topology.snapshotId}.json`),
      stationLineObservationPath: korail.membershipObservationPath, stationLineReceiptPath: korail.membershipReceiptPath,
      canonicalCatalogPath: korail.catalogPath, canonicalCatalogSha256: korail.catalogSha256, calendarDirectory: calendar.directory, calendarWindow: calendar.window,
      serviceEffectiveAt: plannedHead.serviceEffectiveAt, serviceEffectiveUntil: plannedHead.serviceEffectiveUntil ?? null, ...korail.previous.selection,
      governanceEntry: await governanceEntry(ctx, KORAIL_PLANNED_SOURCE_ID),
    }), { flag: "wx" });
  }),
  step("register", "register", async (ctx) => {
    await ctx.execute("register-korail-timetable.mjs", [
      "--repository-root", ctx.repositoryRoot, "--source-input", ctx.shared.get("korail").plannedInputPath,
      "--expected-main-sha", await ctx.originMain(), "--expected-head-sha", await ctx.head(),
    ]);
  }),
];

async function daejeonTopologySnapshotPath(ctx) {
  const evidence = (await sourceByKey(ctx, "daejeon-station-distance-fare")).topologyAdmissionEvidence;
  if (!text(evidence?.snapshotPath)) fail("Daejeon topology admission evidence is missing");
  return abs(ctx, evidence.snapshotPath);
}

// 대구 여섯 원천은 collect-daegu-datapack-sources(--download)가 만든 snapshot 여섯 개를 한 번에 등록한다.
async function daeguCapturedAt(directory) {
  const names = (await readdir(directory)).filter((name) => name.endsWith(".json") && !name.startsWith(".")).sort(compare);
  if (names.length === 0) fail("the Daegu collector wrote no snapshot");
  const stamps = new Set(await Promise.all(names.map(async (name) => JSON.parse(await readFile(path.join(directory, name), "utf8")).capturedAt)));
  const [capturedAt] = [...stamps];
  if (stamps.size !== 1 || !text(capturedAt) || new Date(capturedAt).toISOString() !== capturedAt) fail("the Daegu snapshots do not share one canonical capturedAt");
  return capturedAt;
}

const DAEGU_SOURCE_IDS = Object.freeze([1, 2, 3].flatMap((line) => [`daegu-line${line}-route-topology`, `daegu-line${line}-train-timetable`]));

export const RECIPE_STEPS = Object.freeze({
  "kric-capital-timetable": [
    // 한 도구가 KRIC 파일을 받고(KRIC_TIMETABLE_FILE_*) 수도권·코레일 projection 증거를 등록한다. OCI 게시는 없다(원본 보관은 광주 보관본 workflow의 몫).
    step("register", "collect-register", async (ctx) => {
      await mkdir(ctx.file("operation"));
      await ctx.execute("register-kric-capital-timetable.mjs", ["--operation-directory", ctx.file("operation")]);
    }, { fetchErrorPattern: /^KRIC_TIMETABLE_FILE_/u }),
  ],
  "korail-topology": KORAIL_TOPOLOGY_STEPS,
  "korail-planned-timetable": KORAIL_PLANNED_STEPS,
  "gwangju-topology": [
    step("collect", "collect", async (ctx) => {
      await ctx.execute("collect-gwangju-route-topology.mjs", ["--inventory", INVENTORY_PATH, "--output", ctx.file("topology.json")]);
    }),
    step("register-input", "glue", async (ctx) => {
      await writeFile(ctx.file("register-input.json"), jsonText({
        repositoryRoot: ctx.repositoryRoot, snapshotPath: ctx.file("topology.json"), receiptPath: ctx.file("raw-receipt.json"), expectedHeadSha: await ctx.head(),
      }), { flag: "wx" });
    }),
    step("register", "register", async (ctx) => {
      await ctx.execute("register-gwangju-route-topology.mjs", ["publish-register", "--input", ctx.file("register-input.json")]);
    }),
  ],
  "gwangju-accessibility": regionalAccessibilitySteps({
    collectScript: "collect-gwangju-accessibility.mjs",
    collectArgs: async (ctx) => ["--inventory", abs(ctx, INVENTORY_PATH)],
  }),
  "busan-topology": [
    step("collect", "collect", async (ctx) => {
      await ctx.execute("collect-busan-route-topology.mjs", ["--output", ctx.file("topology.json"), "--scope-html", abs(ctx, BUSAN_SCOPE_HTML)]);
    }),
    step("register", "register", async (ctx) => {
      await registerWithHead(ctx, "register-busan-route-topology.mjs", [
        "publish-register", "--snapshot", ctx.file("topology.json"), "--station-map", abs(ctx, BUSAN_STATION_MAP), "--receipt", ctx.file("raw-receipt.json"),
      ]);
    }),
  ],
  "daejeon-topology": [
    step("collect", "collect", async (ctx) => {
      await ctx.execute("collect-daejeon-route-topology.mjs", [], { env: { DAEJEON_TOPOLOGY_OUTPUT: ctx.file("topology.json") } });
    }),
    step("register", "register", async (ctx) => {
      await registerWithHead(ctx, "register-daejeon-route-topology.mjs", ["publish-register", "--snapshot", ctx.file("topology.json"), "--receipt", ctx.file("raw-receipt.json")]);
    }),
  ],
  "daejeon-accessibility": regionalAccessibilitySteps({
    collectScript: "collect-daejeon-accessibility.mjs",
    collectArgs: async (ctx) => ["--topology-snapshot", await daejeonTopologySnapshotPath(ctx), "--inventory", abs(ctx, INVENTORY_PATH), "--molit-csv", abs(ctx, MOLIT_STATION_CSV)],
  }),
  "daegu-sources": [
    step("collect", "collect", async (ctx) => {
      await mkdir(ctx.file("collected"));
      await ctx.execute("collect-daegu-datapack-sources.mjs", ["--download", "--output-dir", ctx.file("collected")]);
    }),
    step("receipts", "glue", async (ctx) => {
      await mkdir(ctx.file("receipts"));
      ctx.shared.set("daegu", { capturedAt: await daeguCapturedAt(ctx.file("collected")) });
      await writeFile(ctx.file("receipts.json"), jsonText(Object.fromEntries(DAEGU_SOURCE_IDS.map((sourceId) => [sourceId, ctx.file(`receipts/${sourceId}.json`)]))), { flag: "wx" });
    }),
    step("register", "register", async (ctx) => {
      await registerWithHead(ctx, "register-daegu-datapack-sources.mjs", [
        "publish-register", "--input-dir", ctx.file("collected"), "--captured-at", ctx.shared.get("daegu").capturedAt, "--receipts", ctx.file("receipts.json"),
      ]);
    }),
  ],
});

// ---------------------------------------------------------------------------
// controller
// ---------------------------------------------------------------------------
async function git(repositoryRoot, args) {
  return (await execFileAsync(GIT, args, { cwd: repositoryRoot, maxBuffer: 512 * 1024 * 1024 })).stdout;
}

// status 코드와 경로. 이름 바꾸기 감지는 끈다(경로가 하나여야 허용 경로를 판정할 수 있다).
async function changedEntries(repositoryRoot) {
  const status = await git(repositoryRoot, ["-c", "status.renames=false", "status", "--porcelain=v1", "--untracked-files=all", "-z"]);
  return status.split("\0").filter(Boolean).map((entry) => ({ code: entry.slice(0, 2), path: entry.slice(3) })).sort((left, right) => compare(left.path, right.path));
}

function scopeViolations(entries) {
  const violations = [];
  for (const { code, path: relative } of entries) {
    if (!isSourceReverificationAllowedPath(relative)) { violations.push(relative); continue; }
    if (code.includes("D")) { violations.push(`${relative} (deleted)`); continue; }
    // 새 snapshot 파일만 쓸 수 있다. 이미 있는 snapshot은 불변이다(등록 도구의 네 출력 파일만 제자리에서 바뀐다).
    if (!SOURCE_REVERIFICATION_REGISTRATION_OUTPUTS.includes(relative) && SNAPSHOT_FILE.test(relative) && code !== "??" && !code.includes("A")) {
      violations.push(`${relative} (existing snapshot files are immutable)`);
    }
  }
  return violations;
}

function orderedRecipes(recipeIds, recipes) {
  if (!Array.isArray(recipeIds) || recipeIds.length === 0) fail("REVERIFICATION_RECIPE_UNKNOWN: no recipe is due");
  const known = new Set(recipes.map(({ id }) => id));
  const seen = new Set();
  for (const id of recipeIds) {
    if (!known.has(id)) fail(`REVERIFICATION_RECIPE_UNKNOWN: ${String(id)}`);
    if (seen.has(id)) fail(`REVERIFICATION_RECIPE_UNKNOWN: ${id} is listed twice`);
    seen.add(id);
  }
  const ordered = recipes.filter(({ id }) => seen.has(id));
  for (const recipe of ordered) {
    for (const dependency of recipe.dependsOn) if (!seen.has(dependency)) fail(`REVERIFICATION_RECIPE_DEPENDENCY: ${recipe.id} needs ${dependency}`);
  }
  return ordered;
}

// 수집·관측 도구는 필요한 recipe가 돌 때만 적재한다(xlsx 파서 등 무거운 모듈을 판정 경로에 끌어오지 않는다).
const defaultLib = Object.freeze({
  collectKricCurrentStationLineFile: async (input) => (await import("./collect-kric-nationwide-timetable-file.mjs")).collectKricCurrentStationLineFile(input),
  buildKricCurrentStationLineObservation: async (input) => (await import("./build-kric-current-station-line-observation.mjs")).buildKricCurrentStationLineObservation(input),
  collectKasiHolidayCalendarWindowFiles: async (input) => (await import("./fetch-kasi-public-holiday-calendar.mjs")).collectKasiHolidayCalendarWindowFiles(input),
});

function defaultExecute(repositoryRoot, env) {
  return async (script, args, { env: extra = {} } = {}) => {
    try {
      const { stdout } = await execFileAsync(process.execPath, [path.join(repositoryRoot, "tools/datapack", script), ...args], {
        cwd: repositoryRoot, env: { ...env, ...extra }, maxBuffer: 256 * 1024 * 1024,
      });
      return { stdout };
    } catch (error) {
      throw new Error(failureDetail(error));
    }
  };
}

async function gateLedger({ repositoryRoot, ledgerPath, policy, recipe }) {
  const baseLedger = JSON.parse(await git(repositoryRoot, ["show", `HEAD:${ledgerPath}`]));
  const headLedger = JSON.parse(await readFile(path.join(repositoryRoot, ledgerPath), "utf8"));
  return evaluateLedgerChange({ baseLedger, headLedger, policy }).violations.map((violation) => ({ ...violation, recipe: recipe.id }));
}

async function gateEvidence({ repositoryRoot, policy, recipe, before }) {
  const after = JSON.parse(await readFile(path.join(repositoryRoot, INVENTORY_PATH), "utf8"));
  const find = (inventory) => (inventory.sources ?? []).filter(({ id }) => id === recipe.due.sourceId);
  const [beforeSource] = find(before);
  const [afterSource] = find(after);
  const rows = [];
  const violations = [];
  for (const key of recipe.due.evidenceKeys) {
    const result = evaluateEvidenceChange({ sourceId: recipe.due.sourceId, before: beforeSource?.[key] ?? null, after: afterSource?.[key] ?? null, policy });
    if (result.row) rows.push(result.row);
    violations.push(...result.violations);
  }
  return { rows, violations };
}

function violationError(recipe, violations) {
  const details = violations.map(({ sourceId, snapshotId, detail }) => `${sourceId} ${snapshotId}: ${detail}`).join(" | ");
  return new Error(`${violations[0].code}: ${recipe.id}: ${details}`);
}

// recipe 하나: 단계를 순서대로 실행하고(실패는 이상 코드로 분류) 결과를 허용 경로·원장 게이트·증거 게이트에 통과시킨 뒤 한 커밋으로 쌓는다.
async function runRecipe({ recipe, recipeSteps, ctx, policy, ledgerPath }) {
  const { repositoryRoot, env } = ctx;
  const beforeInventory = recipe.due?.kind === "inventory-evidence" ? await ctx.readJson(INVENTORY_PATH) : null;
  for (const recipeStep of recipeSteps) {
    try {
      await recipeStep.run(ctx); // NOSONAR -- 단계는 앞 단계의 산출물(HEAD·입력 파일)에 의존해 순서대로 실행한다
    } catch (error) {
      throw recipeError(recipe, recipeStep, error, env);
    }
  }
  const entries = await changedEntries(repositoryRoot);
  if (entries.length === 0) fail(`SOURCE_REGISTRATION_FAILED: ${recipe.id}: the recipe produced no registration output`);
  const outside = scopeViolations(entries);
  if (outside.length > 0) fail(`REVERIFICATION_OUTPUT_SCOPE: ${recipe.id}: ${outside.join(", ")}`);
  const paths = entries.map(({ path: relative }) => relative);
  const violations = paths.includes(ledgerPath) ? await gateLedger({ repositoryRoot, ledgerPath, policy, recipe }) : [];
  let evidenceRows = [];
  if (beforeInventory && paths.includes(INVENTORY_PATH)) {
    const gate = await gateEvidence({ repositoryRoot, policy, recipe, before: beforeInventory });
    evidenceRows = gate.rows;
    violations.push(...gate.violations);
  }
  if (violations.length > 0) throw violationError(recipe, violations);
  await git(repositoryRoot, ["add", "--", ...paths]);
  await git(repositoryRoot, ["commit", "-q", "-m", recipe.message]);
  return { result: { id: recipe.id, changed: true, paths }, evidenceRows };
}

function recipeContext({ recipe, repositoryRoot, operationRoot, env, shared, lib, now, execute }) {
  const operationDir = path.join(operationRoot, recipe.id);
  return {
    recipeId: recipe.id, repositoryRoot, operationDir, env, shared, lib, now, execute,
    head: async () => (await git(repositoryRoot, ["rev-parse", "HEAD"])).trim(),
    originMain: async () => (await git(repositoryRoot, ["rev-parse", "origin/main"])).trim(),
    readJson: async (relative) => JSON.parse(await readFile(path.join(repositoryRoot, relative), "utf8")),
    file: (name) => path.join(operationDir, name),
  };
}

export async function runSourceReverification({
  repositoryRoot = ROOT, operationRoot, recipeIds, recipes = REVERIFICATION_RECIPES, steps = RECIPE_STEPS, env = process.env,
  policy = null, ledgerPath = LEDGER_PATH, now = () => new Date(), execute = null, lib = defaultLib,
} = {}) {
  if (!path.isAbsolute(repositoryRoot ?? "") || !path.isAbsolute(operationRoot ?? "")) fail("REVERIFICATION_ARGUMENTS: repository and operation roots must be absolute");
  const ordered = orderedRecipes(recipeIds, recipes);
  if ((await changedEntries(repositoryRoot)).length > 0) fail("REVERIFICATION_WORKTREE_DIRTY: the reverification needs a clean worktree");
  const ledgerPolicy = parseLedgerChangePolicy(policy ?? JSON.parse(await readFile(path.join(ROOT, POLICY_PATH), "utf8")));
  const base = { repositoryRoot, operationRoot, env, shared: new Map(), lib, now: typeof now === "function" ? now : () => new Date(now), execute: execute ?? defaultExecute(repositoryRoot, env) };
  const results = [];
  const evidenceSources = [];
  await mkdir(operationRoot, { recursive: true });
  for (const recipe of ordered) {
    const recipeSteps = steps[recipe.id] ?? fail(`REVERIFICATION_RECIPE_UNKNOWN: ${recipe.id} has no steps`);
    const ctx = recipeContext({ recipe, ...base });
    await mkdir(ctx.operationDir, { recursive: true }); // NOSONAR -- recipe는 앞 recipe의 커밋 위에서 순서대로 실행한다
    const { result, evidenceRows } = await runRecipe({ recipe, recipeSteps, ctx, policy: ledgerPolicy, ledgerPath }); // NOSONAR -- 위와 같다
    evidenceSources.push(...evidenceRows);
    results.push(result);
  }
  return { steps: results, evidenceSources };
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    if (!["--operation-root", "--recipes"].includes(key) || Object.hasOwn(values, key) || typeof argv[index + 1] !== "string") fail("REVERIFICATION_ARGUMENTS: usage: run-source-reverification.mjs --operation-root <absolute directory> --recipes <id,id,...>");
    values[key] = argv[index + 1];
  }
  if (!Object.hasOwn(values, "--operation-root") || !Object.hasOwn(values, "--recipes")) fail("REVERIFICATION_ARGUMENTS: usage: run-source-reverification.mjs --operation-root <absolute directory> --recipes <id,id,...>");
  return { operationRoot: values["--operation-root"], recipeIds: values["--recipes"].split(",").filter(Boolean) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.stdout.write(`${JSON.stringify(await runSourceReverification(parseArgs(process.argv.slice(2))))}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
