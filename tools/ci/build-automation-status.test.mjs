import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  EXPIRED_SOURCE_GRACE_MS,
  EXPIRING_SOURCE_LIMIT,
  SNAPSHOT_MAX_BYTES,
  STATUS_STAGES,
  buildAutomationStatus,
  collectAutomationStatus,
  loadSourceInventory,
  postAutomationStatus,
  refreshWorkflowsOf,
  sourceRefreshStages,
} from "./build-automation-status.mjs";

const now = new Date("2026-10-10T03:00:00.000Z");
const manifest = { releaseSequence: 129, publishedAt: "2026-10-09T10:29:36.200Z", expiresAt: "2026-10-11T15:00:00.000Z" };
const hoursAgo = (hours) => new Date(now.getTime() - hours * 3_600_000).toISOString();

const run = (id, overrides = {}) => ({
  id, html_url: `https://github.com/AquilaXk/example/actions/runs/${id}`, status: "completed", conclusion: "success",
  created_at: hoursAgo(2), updated_at: hoursAgo(1.9), event: "workflow_dispatch", head_branch: "main", display_title: "t", ...overrides,
});

const REPOSITORY = "AquilaXk/easysubway-data";
const APP_USER = { login: "easysubway-release-chain[bot]", id: 337648189, type: "Bot" };
const ownPull = (number, ref, createdHoursAgo, overrides = {}) => ({
  number, title: `PR ${number}`, html_url: `https://github.com/${REPOSITORY}/pull/${number}`,
  created_at: hoursAgo(createdHoursAgo), head: { ref, repo: { full_name: REPOSITORY } }, user: APP_USER, ...overrides,
});

const emptyInputs = () => ({
  now, repository: REPOSITORY, manifest, stageRuns: {}, issues: [], openPulls: [], claimRefs: [], behind: { actions: [], anomalies: [] },
});

test("스냅샷은 활성 데이터팩과 모든 단계를 담고, 기록이 없는 단계는 latest null로 드러낸다", () => {
  const snapshot = buildAutomationStatus(emptyInputs());
  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.artifactKind, "automation-status-snapshot");
  assert.equal(snapshot.generatedAt, now.toISOString());
  assert.deepEqual(snapshot.activeDatapack, manifest);
  assert.deepEqual(snapshot.stages.map((stage) => stage.id),
    ["refresh", "registration", "reverification", "candidate", "rc", "compat", "promotion", "publish", "deploy"]);
  for (const stage of snapshot.stages) {
    assert.equal(stage.latest, null, stage.id);
    assert.equal(stage.lastSuccessAt, null, stage.id);
    assert.equal(stage.inFlight, false, stage.id);
    assert.equal(typeof stage.label, "string");
  }
  assert.deepEqual(snapshot.failureIssues, []);
  assert.deepEqual(snapshot.stuck, { pulls: [], claims: [], behindCap: [] });
  assert.equal(snapshot.candidateInFlight, false);
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) < SNAPSHOT_MAX_BYTES);
});

test("단계마다 가장 최근 run과 마지막 성공 시각을 고르고, mode가 다른 run은 섞지 않는다", () => {
  const snapshot = buildAutomationStatus({
    ...emptyInputs(),
    stageRuns: {
      candidate: [
        run(1, { created_at: hoursAgo(10), updated_at: hoursAgo(9.9) }),
        run(2, { created_at: hoursAgo(3), updated_at: hoursAgo(2.9), conclusion: "failure" }),
      ],
      // datapack-release.yml 한 workflow에서 RC와 발행을 display_title로 가른다.
      rc: [
        run(10, { display_title: "Data Pack Release (exploratory)", created_at: hoursAgo(1) }),
        run(11, { display_title: "Data Pack Release (release-candidate)", created_at: hoursAgo(6) }),
        run(12, { display_title: "Data Pack Release (production-publish)", created_at: hoursAgo(5) }),
      ],
      publish: [
        run(12, { display_title: "Data Pack Release (production-publish)", created_at: hoursAgo(5), updated_at: hoursAgo(4.9) }),
        run(11, { display_title: "Data Pack Release (release-candidate)", created_at: hoursAgo(6) }),
      ],
      // hub 호환성은 dispatch run만, 배포는 DEPLOY run-name만 센다.
      compat: [run(20, { event: "push", created_at: hoursAgo(0.5) }), run(21, { created_at: hoursAgo(4) })],
      deploy: [
        run(30, { display_title: "PREVIEW backend=1/2 data=3/4", created_at: hoursAgo(0.5) }),
        run(31, { display_title: "DEPLOY backend=1/2 data=3/4", created_at: hoursAgo(4), updated_at: hoursAgo(3.9) }),
        run(32, { display_title: "Source-free Journey K3s Deploy", created_at: hoursAgo(0.2) }),
      ],
    },
  });
  const stage = (id) => snapshot.stages.find((item) => item.id === id);
  assert.equal(stage("candidate").latest.runId, 2);
  assert.equal(stage("candidate").latest.conclusion, "failure");
  assert.equal(stage("candidate").lastSuccessAt, hoursAgo(9.9));
  assert.equal(stage("rc").latest.runId, 11);
  assert.equal(stage("publish").latest.runId, 12);
  assert.equal(stage("compat").latest.runId, 21);
  assert.equal(stage("deploy").latest.runId, 31);
  assert.deepEqual(stage("deploy").latest, {
    runId: 31, url: "https://github.com/AquilaXk/example/actions/runs/31", status: "completed", conclusion: "success",
    createdAt: hoursAgo(4), updatedAt: hoursAgo(3.9),
  });
});

test("진행 중인 run은 inFlight이고 후보~배포가 진행 중이면 candidateInFlight다", () => {
  const running = (id) => run(id, { status: "in_progress", conclusion: null, created_at: hoursAgo(0.1) });
  for (const stageId of ["candidate", "rc", "compat", "promotion", "publish", "deploy"]) {
    const runs = stageId === "rc" ? [{ ...running(1), display_title: "Data Pack Release (release-candidate)" }]
      : stageId === "publish" ? [{ ...running(1), display_title: "Data Pack Release (production-publish)" }]
        : stageId === "deploy" ? [{ ...running(1), display_title: "DEPLOY backend=1/2 data=3/4" }] : [running(1)];
    const snapshot = buildAutomationStatus({ ...emptyInputs(), stageRuns: { [stageId]: runs } });
    assert.equal(snapshot.stages.find((stage) => stage.id === stageId).inFlight, true, stageId);
    assert.equal(snapshot.candidateInFlight, true, stageId);
  }
  // 정기 원천 갱신 단계가 진행 중인 것은 후보가 오고 있다는 뜻이 아니다.
  const refreshing = buildAutomationStatus({ ...emptyInputs(), stageRuns: { refresh: [running(1)] } });
  assert.equal(refreshing.candidateInFlight, false);
  // 열린 후보 갱신 PR도 후보가 오고 있다는 뜻이다.
  const openCandidatePr = buildAutomationStatus({
    ...emptyInputs(),
    openPulls: [ownPull(5, "automation/927-nationwide-candidate-refresh-1", 1)],
  });
  assert.equal(openCandidatePr.candidateInFlight, true);
});

test("열린 실패 이슈는 자동화 실패 제목만, 최근 순으로 담는다", () => {
  const issue = (number, title, login = "app/github-actions") => ({
    number, title, url: `https://github.com/AquilaXk/easysubway-data/issues/${number}`, createdAt: hoursAgo(number), author: { login },
  });
  const snapshot = buildAutomationStatus({
    ...emptyInputs(),
    issues: [
      issue(3, "[Fix] 원천 자동 갱신 실패: 후보 (nationwide-candidate-refresh.yml)"),
      issue(7, "[Fix] 원천 자동 갱신 실패: 체인 (datapack-release-cross-repo-chain.yml)", "github-actions[bot]"),
      issue(9, "[Feat] 무관한 이슈"),
      issue(11, "[Fix] 원천 자동 갱신 실패: 사람이 쓴 이슈", "AquilaXk"),
    ],
  });
  assert.deepEqual(snapshot.failureIssues.map((item) => item.number), [7, 3]);
  assert.deepEqual(snapshot.failureIssues[0], {
    number: 7, title: "[Fix] 원천 자동 갱신 실패: 체인 (datapack-release-cross-repo-chain.yml)",
    url: "https://github.com/AquilaXk/easysubway-data/issues/7", createdAt: hoursAgo(7),
  });
});

test("막힌 자동화: 뒤처진 PR, 오래 열린 PR, 주인 없는 claim, BEHIND 상한 도달을 구분해 담는다", () => {
  const pull = (number, ref, createdHoursAgo) => ownPull(number, ref, createdHoursAgo);
  const snapshot = buildAutomationStatus({
    ...emptyInputs(),
    openPulls: [
      pull(1, "automation/636-current-topology-refresh-100", 1),
      pull(2, "automation/636-current-topology-refresh-101", 8),
      pull(3, "automation/636-current-topology-refresh-102", 9),
      pull(4, "feature/human-branch", 30),
    ],
    behind: {
      actions: [{ number: 3, branch: "automation/636-current-topology-refresh-102", stage: "capital-topology-refresh", workflow: "x.yml" }],
      anomalies: [{ stage: "registration", number: 1, closures: 3 }],
    },
    claimRefs: [
      { branch: "automation/636-current-topology-refresh-90", committedAt: hoursAgo(5) },
      { branch: "automation/636-current-topology-refresh-91", committedAt: hoursAgo(0.5) },
    ],
  });
  assert.deepEqual(snapshot.stuck.pulls.map(({ number, reason }) => [number, reason]), [[1, "BEHIND"], [2, "OLD"], [3, "BEHIND"]]);
  assert.deepEqual(snapshot.stuck.claims, [{ branch: "automation/636-current-topology-refresh-90", committedAt: hoursAgo(5) }]);
  assert.deepEqual(snapshot.stuck.behindCap, [{ stage: "registration", number: 1, closures: 3 }]);
});

test("활성 manifest를 읽을 수 없거나 값이 어긋나면 만들어 내지 않고 실패한다", () => {
  for (const bad of [
    null, {}, { releaseSequence: 0, publishedAt: manifest.publishedAt, expiresAt: manifest.expiresAt },
    { releaseSequence: 1.5, publishedAt: manifest.publishedAt, expiresAt: manifest.expiresAt },
    { releaseSequence: 129, publishedAt: "nope", expiresAt: manifest.expiresAt },
    { releaseSequence: 129, publishedAt: manifest.publishedAt, expiresAt: undefined },
  ]) {
    assert.throws(() => buildAutomationStatus({ ...emptyInputs(), manifest: bad }), /STATUS_MANIFEST_INVALID/u, JSON.stringify(bad));
  }
  assert.throws(() => buildAutomationStatus({ ...emptyInputs(), now: new Date("x") }), /STATUS_CLOCK/u);
});

test("수집: 단계별 workflow run 목록과 열린 이슈·PR·claim을 읽어 스냅샷 입력을 만든다", async () => {
  const calls = [];
  const runsByWorkflow = {
    "current-capital-topology-refresh.yml": [run(1)],
    "release-artifacts.yml": [run(2)],
  };
  const apiFor = (repository) => async (endpoint) => {
    calls.push(`${repository} ${endpoint}`);
    let match;
    if ((match = /actions\/workflows\/([^/]+)\/runs/u.exec(endpoint))) return { workflow_runs: runsByWorkflow[match[1]] ?? [] };
    if (/git\/matching-refs\/heads\/automation\//u.test(endpoint)) {
      return [{ ref: "refs/heads/automation/636-current-topology-refresh-90", object: { sha: "a".repeat(40) } }];
    }
    if (/commits\/a{40}$/u.test(endpoint)) return { commit: { committer: { date: hoursAgo(5) } } };
    if (/pulls\?state=open/u.test(endpoint)) return [];
    throw new Error(`unexpected ${endpoint}`);
  };
  const collected = await collectAutomationStatus({
    now,
    repositories: { data: "AquilaXk/easysubway-data", hub: "AquilaXk/easysubway", platform: "AquilaXk/easysubway-platform" },
    apis: { data: apiFor("data"), hub: apiFor("hub"), platform: apiFor("platform") },
    listFailureIssues: async () => [],
    fetchManifest: async () => manifest,
    planBehind: async () => ({ actions: [], anomalies: [] }),
  });
  assert.deepEqual(collected.manifest, manifest);
  assert.equal(collected.stageRuns.refresh[0].id, 1);
  assert.equal(collected.stageRuns.compat[0].id, 2);
  assert.deepEqual(collected.claimRefs, [{ branch: "automation/636-current-topology-refresh-90", committedAt: hoursAgo(5) }]);
  // hub·platform 단계는 각자의 저장소 api로만 읽는다.
  assert.ok(calls.some((call) => call.startsWith("hub ") && call.includes("release-artifacts.yml")));
  assert.ok(calls.some((call) => call.startsWith("platform ") && call.includes("source-free-journey-k3s-deploy.yml")));
  assert.ok(calls.filter((call) => call.startsWith("data ")).every((call) => !call.includes("release-artifacts.yml") && !call.includes("k3s-deploy")));
  // 수집 결과를 그대로 스냅샷으로 만들 수 있다.
  const snapshot = buildAutomationStatus({ now, ...collected, issues: [] });
  assert.equal(snapshot.stages.find((stage) => stage.id === "refresh").latest.runId, 1);
  assert.equal(snapshot.stuck.claims.length, 1);
});

test("수집: 어느 단계의 조회라도 실패하면 빈 값으로 채우지 않고 실패한다", async () => {
  const failing = async () => { throw new Error("rate limited"); };
  await assert.rejects(collectAutomationStatus({
    now,
    repositories: { data: "AquilaXk/easysubway-data", hub: "AquilaXk/easysubway", platform: "AquilaXk/easysubway-platform" },
    apis: { data: async () => ({ workflow_runs: [] }), hub: failing, platform: async () => ({ workflow_runs: [] }) },
    listFailureIssues: async () => [], fetchManifest: async () => manifest, planBehind: async () => ({ actions: [], anomalies: [] }),
  }), /rate limited/u);
});

test("게시: backend 주소와 서비스 토큰이 있어야 하고, 응답이 2xx가 아니면 실패한다", async () => {
  const snapshot = buildAutomationStatus(emptyInputs());
  const requests = [];
  const fetchOk = async (url, init) => { requests.push({ url, init }); return { ok: true, status: 202 }; };
  await postAutomationStatus({ snapshot, apiBaseUrl: "https://api.example.invalid/", token: "svc-token", fetchImpl: fetchOk });
  assert.equal(requests[0].url, "https://api.example.invalid/admin/api/datapack/automation-status");
  assert.equal(requests[0].init.method, "POST");
  assert.equal(requests[0].init.headers.authorization, "Bearer svc-token");
  assert.equal(requests[0].init.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(requests[0].init.body), snapshot);
  await assert.rejects(postAutomationStatus({ snapshot, apiBaseUrl: "https://api.example.invalid", token: "t", fetchImpl: async () => ({ ok: false, status: 403 }) }), /STATUS_POST_FAILED[\s\S]*403/u);
  await assert.rejects(postAutomationStatus({ snapshot, apiBaseUrl: "https://api.example.invalid", token: "", fetchImpl: fetchOk }), /STATUS_POST_ARGUMENTS/u);
  await assert.rejects(postAutomationStatus({ snapshot, apiBaseUrl: "http://api.example.invalid", token: "t", fetchImpl: fetchOk }), /STATUS_POST_ARGUMENTS/u);
  await assert.rejects(postAutomationStatus({ snapshot: { ...snapshot, padding: "x".repeat(SNAPSHOT_MAX_BYTES) }, apiBaseUrl: "https://api.example.invalid", token: "t", fetchImpl: fetchOk }), /STATUS_SNAPSHOT_TOO_LARGE/u);
  assert.equal(STATUS_STAGES.length, 9);
});

test("fork PR·사람·위장 계정이 자동화 브랜치 이름을 써도 자동화 PR로 세지 않고 snapshot에 싣지 않는다", () => {
  const branch = "automation/927-nationwide-candidate-refresh-1";
  const html = '<img src=x onerror=alert(1)>';
  const impostors = [
    ownPull(21, branch, 9, { title: html, head: { ref: branch, repo: { full_name: "attacker/easysubway-data" } } }),
    ownPull(22, branch, 9, { title: html, head: { ref: branch, repo: null } }),
    ownPull(23, branch, 9, { title: html, user: { login: "AquilaXk", id: 1, type: "User" } }),
    ownPull(24, branch, 9, { title: html, user: { login: "easysubway-release-chain[bot]", id: 1, type: "Bot" } }),
    ownPull(25, branch, 9, { title: html, user: { login: "easysubway-release-chain[bot]", id: 337648189, type: "User" } }),
    ownPull(26, branch, 9, { title: html, user: undefined }),
  ];
  const snapshot = buildAutomationStatus({ ...emptyInputs(), openPulls: impostors });
  assert.deepEqual(snapshot.stuck.pulls, []);
  assert.equal(snapshot.candidateInFlight, false, "위장 PR이 만료 임박 알림을 잠재우면 안 된다");
  const claim = { branch, committedAt: hoursAgo(5) };
  assert.deepEqual(buildAutomationStatus({ ...emptyInputs(), openPulls: impostors, claimRefs: [claim] }).stuck.claims, [claim], "위장 PR이 낡은 claim을 가리면 안 된다");
  // github-actions[bot]이 만든 자기 저장소 PR은 자동화 PR이다.
  const actionsPull = ownPull(30, branch, 9, { user: { login: "github-actions[bot]", id: 41898282, type: "Bot" } });
  assert.deepEqual(buildAutomationStatus({ ...emptyInputs(), openPulls: [actionsPull] }).stuck.pulls.map((item) => item.number), [30]);
});

test("fork PR이 같은 이름의 claim 브랜치를 열린 PR로 가장해 낡은 claim을 가리지 못한다", async () => {
  const branch = "automation/636-current-topology-refresh-90";
  const forkPull = ownPull(40, branch, 5, { head: { ref: branch, repo: { full_name: "attacker/easysubway-data" } } });
  const apis = {
    data: async (endpoint) => {
      if (endpoint.includes("/pulls?")) return [forkPull];
      if (endpoint.includes("matching-refs")) return [{ ref: `refs/heads/${branch}`, object: { sha: "a".repeat(40) } }];
      if (endpoint.includes("/commits/")) return { commit: { committer: { date: hoursAgo(5) } } };
      if (endpoint.includes("/actions/workflows/")) return { workflow_runs: [] };
      throw new Error(`unexpected ${endpoint}`);
    },
  };
  apis.hub = apis.data;
  apis.platform = apis.data;
  const collected = await collectAutomationStatus({
    now, repositories: { data: REPOSITORY, hub: "AquilaXk/easysubway", platform: "AquilaXk/easysubway-platform" }, apis,
    listFailureIssues: async () => [], fetchManifest: async () => manifest, planBehind: async () => ({ actions: [], anomalies: [] }),
  });
  assert.deepEqual(collected.claimRefs, [{ branch, committedAt: hoursAgo(5) }]);
  assert.equal(collected.repository, REPOSITORY);
});

test("snapshot에 실리는 PR 제목은 제어·양방향 문자를 지우고 길이를 제한하며, 잘못된 URL·제목은 만들어 내지 않고 실패한다", () => {
  const branch = "automation/636-current-topology-refresh-100";
  const dirty = `\u202Eevil\u0000 ${"가".repeat(300)}\n\u2066x`;
  const [item] = buildAutomationStatus({ ...emptyInputs(), openPulls: [ownPull(50, branch, 9, { title: dirty })] }).stuck.pulls;
  assert.ok(!/[\p{Cc}\p{Cf}]/u.test(item.title));
  assert.equal([...item.title].length, 120);
  assert.ok(item.title.startsWith("evil "));
  for (const bad of [{ html_url: "https://evil.example/pull/50" }, { html_url: "javascript:alert(1)" }, { html_url: undefined }, { title: undefined }, { title: "\u202E\u200B" }]) {
    assert.throws(() => buildAutomationStatus({ ...emptyInputs(), openPulls: [ownPull(50, branch, 9, bad)] }), /STATUS_PULL_INVALID/u, JSON.stringify(bad));
  }
  assert.throws(() => buildAutomationStatus({ ...emptyInputs(), repository: undefined }), /STATUS_ENV_INVALID/u);
});

// ---------- 곧 만료되는 원천 근거(#1116, backend#507) ----------

const iso = (hoursFromNow) => new Date(now.getTime() + hoursFromNow * 3_600_000).toISOString();
const evidenceSource = (id, freshUntilHours, { evidence = "scheduleAdmissionEvidence", displayName = `자료 ${id}`, productionUseAllowed = true } = {}) => ({
  id, displayName, productionUseAllowed, [evidence]: { freshUntil: iso(freshUntilHours), snapshotId: `${id}-1` },
});
const inventoryOf = (...sources) => ({ schemaVersion: 1, sources });
// 갱신 단계마다 가장 최근에 끝난 run이 성공인 목록. 테스트가 단계별로 덮어쓴다.
const REFRESH_STAGES_IN_USE = [...new Set(sourceRefreshStages().values())].sort();
const refreshRunsOf = (overrides = {}) => Object.fromEntries(REFRESH_STAGES_IN_USE.map((stage) => [stage, overrides[stage] ?? [run(1, { created_at: hoursAgo(1), conclusion: "success" })]]));
const expiring = (inputs) => buildAutomationStatus({ ...emptyInputs(), refreshRuns: refreshRunsOf(), ...inputs }).expiringSources;
const failureIssue = (number, workflow) => ({
  number, title: `[Fix] 원천 자동 갱신 실패: 이름 (${workflow})`, url: `https://github.com/${REPOSITORY}/issues/${number}`, createdAt: hoursAgo(1), author: { login: "app/github-actions" },
});

test("인벤토리를 주지 않으면 snapshot에 expiringSources가 없다: 기존 출력과 키가 같다(backend 배포 전 게이트)", () => {
  const snapshot = buildAutomationStatus(emptyInputs());
  assert.deepEqual(Object.keys(snapshot), ["schemaVersion", "artifactKind", "generatedAt", "activeDatapack", "stages", "failureIssues", "stuck", "candidateInFlight"]);
  assert.equal(Object.hasOwn(snapshot, "expiringSources"), false);
  const withInventory = buildAutomationStatus({ ...emptyInputs(), sourceInventory: inventoryOf() });
  assert.deepEqual(Object.keys(withInventory), [
    "schemaVersion", "artifactKind", "generatedAt", "activeDatapack", "stages", "failureIssues", "stuck", "candidateInFlight", "expiringSources",
  ]);
  assert.deepEqual(withInventory.expiringSources, []);
});

test("만료가 이른 순서로 최대 10개를 싣고, 같은 시각이면 sourceId 순이다. 항목은 backend 계약의 여섯 키뿐이다", () => {
  const sources = Array.from({ length: 14 }, (_, index) => evidenceSource(`source-${String(index).padStart(2, "0")}`, 30 - index));
  sources.push(evidenceSource("aaa-tie", 17), evidenceSource("zzz-tie", 17));
  const list = expiring({ sourceInventory: inventoryOf(...sources) });
  assert.equal(list.length, EXPIRING_SOURCE_LIMIT);
  assert.equal(EXPIRING_SOURCE_LIMIT, 10);
  assert.deepEqual(list.map((item) => item.sourceId), [
    "aaa-tie", "source-13", "zzz-tie", "source-12", "source-11", "source-10", "source-09", "source-08", "source-07", "source-06",
  ]);
  assert.deepEqual(Object.keys(list[1]), ["sourceId", "name", "evidence", "freshUntil", "refreshStage", "refreshState"]);
  assert.deepEqual(list[1], { sourceId: "source-13", name: "자료 source-13", evidence: "scheduleAdmissionEvidence", freshUntil: iso(17), refreshStage: null, refreshState: "NONE" });
});

test("원천 하나에 근거가 여럿이면 가장 이른 freshUntil 하나만 싣고 근거 종류는 원천 항목 아래 최상위 키다", () => {
  const source = {
    id: "daegu-line1-train-timetable", displayName: "대구 1호선 열차 시간표", productionUseAllowed: true,
    scheduleAdmissionEvidence: { freshUntil: iso(20) },
    routeMapAdmissionEvidence: { freshUntil: iso(500), currentTopologyAdmission: { freshUntil: iso(5) } },
  };
  const [item] = expiring({ sourceInventory: inventoryOf(source) });
  assert.equal(item.evidence, "routeMapAdmissionEvidence");
  assert.equal(item.freshUntil, iso(5));
});

test("productionUseAllowed가 아닌 원천과 freshUntil이 없는 원천은 싣지 않는다", () => {
  const list = expiring({ sourceInventory: inventoryOf(
    evidenceSource("used", 3), evidenceSource("unused", 2, { productionUseAllowed: false }), { id: "no-evidence", displayName: "근거 없음", productionUseAllowed: true },
  ) });
  assert.deepEqual(list.map((item) => item.sourceId), ["used"]);
});

test("이미 만료된 근거는 만료 24시간 안에서만 싣는다(만료 순간에 신호가 사라지지 않게, 오래된 만료가 목록을 채우지 않게)", () => {
  assert.equal(EXPIRED_SOURCE_GRACE_MS, 24 * 3_600_000);
  const list = expiring({ sourceInventory: inventoryOf(
    evidenceSource("just-expired", -0.01), evidenceSource("expired-23h", -23), evidenceSource("expired-24h", -24), evidenceSource("expired-week", -168), evidenceSource("future", 1),
  ) });
  assert.deepEqual(list.map((item) => item.sourceId), ["expired-23h", "just-expired", "future"]);
});

test("갱신 단계는 소유 표(REFRESH_STAGES, 재확인 recipe)에서 오고, 소유자가 없으면 NONE이다", () => {
  const stages = sourceRefreshStages();
  assert.equal(stages.get("incheon-line1-train-timetable"), "capital-topology-refresh");
  assert.equal(stages.get("kric-gyeongui-jungang-route-map-positions"), "capital-topology-refresh");
  assert.equal(stages.get("seoul-metro-accessibility"), "seoul-accessibility-refresh");
  assert.equal(stages.get("kric-station-convenience-standard"), "kric-facility-refresh");
  assert.equal(stages.get("daegu-line1-train-timetable"), "source-reverification");
  assert.equal(stages.get("busan-transportation-timetable"), undefined);
  // 한 원천이 두 소유 표에 있으면 REFRESH_STAGES가 먼저다.
  assert.equal(stages.get("kric-nationwide-timetable-file"), "gwangju-timetable-refresh");
  const list = expiring({ sourceInventory: inventoryOf(evidenceSource("incheon-line1-train-timetable", 2), evidenceSource("busan-transportation-timetable", 3)) });
  assert.deepEqual(list.map((item) => [item.sourceId, item.refreshStage, item.refreshState]), [
    ["incheon-line1-train-timetable", "capital-topology-refresh", "OK"],
    ["busan-transportation-timetable", null, "NONE"],
  ]);
});

test("갱신 작업 상태: 그 단계 workflow의 가장 최근에 끝난 run이 실패면 FAILED, 막힌 PR·주인 없는 claim·재생성 상한이 그 단계이면 BLOCKED, 아니면 OK (2026-10-10 인천 사례)", () => {
  const inventory = inventoryOf(
    evidenceSource("incheon-line1-train-timetable", 2), evidenceSource("seoul-metro-accessibility", 3),
    evidenceSource("kric-station-convenience-standard", 4), evidenceSource("daegu-line1-train-timetable", 5), evidenceSource("busan-transportation-timetable", 6),
  );
  const states = ({ runs = {}, ...inputs } = {}) => Object.fromEntries(expiring({ sourceInventory: inventory, refreshRuns: refreshRunsOf(runs), ...inputs }).map((item) => [item.sourceId, item.refreshState]));
  assert.deepEqual(states(), {
    "incheon-line1-train-timetable": "OK", "seoul-metro-accessibility": "OK", "kric-station-convenience-standard": "OK", "daegu-line1-train-timetable": "OK", "busan-transportation-timetable": "NONE",
  });
  // 인천 사례: 갱신 PR의 CI가 실패해 수도권 topology 갱신 workflow의 최근 run이 실패했다.
  const failed = (id, conclusion = "failure") => [run(id, { created_at: hoursAgo(1), conclusion })];
  for (const conclusion of ["failure", "timed_out", "startup_failure"]) {
    assert.equal(states({ runs: { "capital-topology-refresh": failed(2, conclusion) } })["incheon-line1-train-timetable"], "FAILED", conclusion);
  }
  assert.equal(states({ runs: { "capital-topology-refresh": failed(2) } })["seoul-metro-accessibility"], "OK");
  // 취소·성공·건너뜀은 실패가 아니다.
  for (const conclusion of ["cancelled", "skipped", "success", "neutral"]) {
    assert.equal(states({ runs: { "capital-topology-refresh": failed(2, conclusion) } })["incheon-line1-train-timetable"], "OK", conclusion);
  }
  // 가장 최근에 끝난 run만 본다: 옛 실패 뒤에 성공이 있으면 OK이고, 진행 중인 run은 건너뛴다.
  const newerSuccess = [run(5, { created_at: hoursAgo(2), conclusion: "failure" }), run(6, { created_at: hoursAgo(1), conclusion: "success" })];
  assert.equal(states({ runs: { "capital-topology-refresh": newerSuccess } })["incheon-line1-train-timetable"], "OK");
  const newerFailure = [run(5, { created_at: hoursAgo(2), conclusion: "success" }), run(6, { created_at: hoursAgo(1), conclusion: "failure" })];
  assert.equal(states({ runs: { "capital-topology-refresh": newerFailure } })["incheon-line1-train-timetable"], "FAILED");
  const runningOnTop = [run(5, { created_at: hoursAgo(3), conclusion: "failure" }), run(6, { created_at: hoursAgo(0.1), status: "in_progress", conclusion: null })];
  assert.equal(states({ runs: { "capital-topology-refresh": runningOnTop } })["incheon-line1-train-timetable"], "FAILED");
  // 열린 실패 이슈는 사람이 닫을 때까지 열려 있어 지금 실패 중이라는 뜻이 아니다: 최근 run이 성공이면 OK다.
  assert.equal(states({ issues: [failureIssue(964, "current-capital-topology-refresh.yml")] })["incheon-line1-train-timetable"], "OK");
  // 막힌 PR: stuck.pulls[].stage가 그 단계다(6시간 넘게 열려 있음).
  const stuckPull = ownPull(1112, "automation/636-current-topology-refresh-1", 7);
  assert.equal(states({ openPulls: [stuckPull] })["incheon-line1-train-timetable"], "BLOCKED");
  assert.equal(states({ openPulls: [stuckPull] })["seoul-metro-accessibility"], "OK");
  // 주인 없는 claim: 접두사가 그 단계의 claim 브랜치다.
  assert.equal(states({ claimRefs: [{ branch: "automation/639-seoul-accessibility-refresh-9", committedAt: hoursAgo(3) }] })["seoul-metro-accessibility"], "BLOCKED");
  // 재생성 상한 도달.
  assert.equal(states({ behind: { actions: [], anomalies: [{ stage: "kric-facility-refresh", number: 8, closures: 3 }] } })["kric-station-convenience-standard"], "BLOCKED");
  // 재확인 recipe 소유 원천은 source-reverification 단계다.
  assert.equal(states({ runs: { "source-reverification": failed(3) } })["daegu-line1-train-timetable"], "FAILED");
  // 실패가 막힘보다 앞선다.
  assert.equal(states({ runs: { "capital-topology-refresh": failed(2) }, openPulls: [stuckPull] })["incheon-line1-train-timetable"], "FAILED");
  // 자동 갱신 경로가 없는 원천은 다른 단계의 실패와 무관하게 NONE이다.
  assert.equal(states({ runs: { "capital-topology-refresh": failed(2) } })["busan-transportation-timetable"], "NONE");
});

test("갱신 단계의 run 목록이 없으면 OK로 채우지 않고 실패한다", () => {
  const inventory = inventoryOf(evidenceSource("incheon-line1-train-timetable", 2));
  assert.throws(() => buildAutomationStatus({ ...emptyInputs(), sourceInventory: inventory }), /STATUS_RUNS_INVALID.*capital-topology-refresh/u);
  assert.throws(() => buildAutomationStatus({ ...emptyInputs(), sourceInventory: inventory, refreshRuns: { "capital-topology-refresh": "nope" } }), /STATUS_RUNS_INVALID/u);
  // 소유 단계가 없는 원천만 있으면 단계 run 목록이 필요 없다.
  assert.deepEqual(buildAutomationStatus({ ...emptyInputs(), sourceInventory: inventoryOf(evidenceSource("busan-transportation-timetable", 2)) }).expiringSources.map((item) => item.refreshState), ["NONE"]);
});

test("refreshWorkflowsOf: 갱신 단계 id를 그 단계 workflow 파일로 옮긴다(소유 표에 쓰이는 단계만)", () => {
  const workflows = refreshWorkflowsOf();
  assert.deepEqual(Object.keys(workflows), [...REFRESH_STAGES_IN_USE]);
  assert.equal(workflows["capital-topology-refresh"], "current-capital-topology-refresh.yml");
  assert.equal(workflows["source-reverification"], "source-reverification.yml");
  assert.equal(workflows["seoul-accessibility-refresh"], "seoul-current-accessibility-refresh.yml");
  assert.equal(workflows["kric-facility-refresh"], "kric-current-facility-refresh.yml");
  assert.equal(workflows["gwangju-timetable-refresh"], "retained-gwangju-timetable-refresh.yml");
});

test("수집: 갱신 workflow를 주면 단계마다 끝난 run 목록을 읽고, 안 주면 읽지 않는다. 응답이 목록이 아니면 실패한다", async () => {
  const requested = [];
  const apis = {
    data: async (endpoint) => {
      requested.push(endpoint);
      if (endpoint.includes("/actions/workflows/")) return { workflow_runs: [] };
      if (endpoint.includes("/git/matching-refs/")) return [];
      return [];
    },
    hub: async () => ({ workflow_runs: [] }),
    platform: async () => ({ workflow_runs: [] }),
  };
  const base = {
    now, repositories: { data: REPOSITORY, hub: "AquilaXk/easysubway", platform: "AquilaXk/easysubway-platform" }, apis,
    listFailureIssues: async () => [], fetchManifest: async () => manifest, planBehind: async () => ({ actions: [], anomalies: [] }),
  };
  const without = await collectAutomationStatus(base);
  assert.equal(Object.hasOwn(without, "refreshRuns"), false);
  const before = requested.length;
  const withRuns = await collectAutomationStatus({ ...base, refreshWorkflows: { "capital-topology-refresh": "current-capital-topology-refresh.yml", "source-reverification": "source-reverification.yml" } });
  assert.deepEqual(Object.keys(withRuns.refreshRuns), ["capital-topology-refresh", "source-reverification"]);
  assert.deepEqual(requested.slice(before).filter((endpoint) => endpoint.includes("status=completed")), [
    `repos/${REPOSITORY}/actions/workflows/current-capital-topology-refresh.yml/runs?per_page=10&status=completed&branch=main`,
    `repos/${REPOSITORY}/actions/workflows/source-reverification.yml/runs?per_page=10&status=completed&branch=main`,
  ]);
  await assert.rejects(collectAutomationStatus({
    ...base, apis: { ...apis, data: async (endpoint) => (endpoint.includes("/actions/workflows/") ? { not: "a list" } : apis.data(endpoint)) },
    refreshWorkflows: { "source-reverification": "source-reverification.yml" },
  }), /STATUS_RUNS_INVALID/u);
});

test("스냅샷의 expiringSources는 크기 상한 안이고 JSON 왕복이 같다", () => {
  const sources = Array.from({ length: 40 }, (_, index) => evidenceSource(`source-${index}`, index + 1, { displayName: "가".repeat(200) }));
  const snapshot = buildAutomationStatus({ ...emptyInputs(), refreshRuns: refreshRunsOf(), sourceInventory: inventoryOf(...sources) });
  assert.equal(snapshot.expiringSources.length, 10);
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) < SNAPSHOT_MAX_BYTES);
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), snapshot);
});

test("인벤토리나 값이 어긋나면 채우지 않고 이름 있는 코드로 실패한다", () => {
  const build = (sourceInventory) => () => buildAutomationStatus({ ...emptyInputs(), refreshRuns: refreshRunsOf(), sourceInventory });
  assert.throws(build({ sources: "nope" }), /STATUS_INVENTORY_INVALID/u);
  assert.throws(build(null), /STATUS_INVENTORY_INVALID/u);
  assert.throws(build(inventoryOf(null)), /STATUS_INVENTORY_INVALID/u);
  assert.throws(build(inventoryOf({ ...evidenceSource("a", 1), scheduleAdmissionEvidence: { freshUntil: "2026-10-10" } })), /STATUS_INVENTORY_INVALID.*freshUntil/u);
  assert.throws(build(inventoryOf({ ...evidenceSource("a", 1), scheduleAdmissionEvidence: { freshUntil: 123 } })), /STATUS_INVENTORY_INVALID.*freshUntil/u);
  assert.throws(build(inventoryOf(evidenceSource("Bad Id", 1))), /STATUS_INVENTORY_INVALID.*source id/u);
  assert.throws(build(inventoryOf(evidenceSource("a", 1, { displayName: "" }))), /STATUS_INVENTORY_INVALID.*displayName/u);
  assert.throws(build(inventoryOf({ ...evidenceSource("a", 1), displayName: undefined })), /STATUS_INVENTORY_INVALID.*displayName/u);
  assert.throws(build(inventoryOf(evidenceSource("a", 1), evidenceSource("a", 2))), /STATUS_INVENTORY_INVALID.*duplicate/u);
  assert.throws(build(inventoryOf({ ...evidenceSource("a", 1, { evidence: "bad-key" }) })), /STATUS_INVENTORY_INVALID.*evidence/u);
});

test("표시 이름은 제어·양방향 문자를 지우고 200자로 제한한다", () => {
  const [item] = expiring({ sourceInventory: inventoryOf(evidenceSource("a", 1, { displayName: `인천\u202e 시간표\n${"가".repeat(300)}` })) });
  assert.doesNotMatch(item.name, /[\u202e\n]/u);
  assert.equal([...item.name].length, 200);
  assert.ok(item.name.startsWith("인천 시간표 가"));
});

test("실제 source-inventory.json으로 만들어도 backend 계약(키·형식·정렬·상한)을 지킨다", () => {
  const inventory = JSON.parse(readFileSync(new URL("../datapack/source-inventory.json", import.meta.url), "utf8"));
  for (const hours of [0, 12, 300]) {
    const at = new Date(Date.parse("2026-10-10T08:00:00.000Z") + hours * 3_600_000);
    const snapshot = buildAutomationStatus({ ...emptyInputs(), now: at, sourceInventory: inventory, refreshRuns: refreshRunsOf() });
    const list = snapshot.expiringSources;
    assert.ok(list.length <= EXPIRING_SOURCE_LIMIT);
    assert.deepEqual([...list].sort((left, right) => Date.parse(left.freshUntil) - Date.parse(right.freshUntil) || (left.sourceId < right.sourceId ? -1 : 1)), list);
    assert.equal(new Set(list.map((item) => item.sourceId)).size, list.length);
    for (const item of list) {
      assert.deepEqual(Object.keys(item), ["sourceId", "name", "evidence", "freshUntil", "refreshStage", "refreshState"]);
      assert.match(item.sourceId, /^[a-z0-9][a-z0-9-]{0,99}$/u);
      assert.match(item.evidence, /^[A-Za-z][A-Za-z0-9]{0,63}$/u);
      assert.ok(item.name.length >= 1 && [...item.name].length <= 200);
      assert.ok(Date.parse(item.freshUntil) > at.getTime() - EXPIRED_SOURCE_GRACE_MS);
      assert.equal(item.refreshState === "NONE", item.refreshStage === null);
      assert.ok(["OK", "FAILED", "BLOCKED", "NONE"].includes(item.refreshState));
    }
    assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) < SNAPSHOT_MAX_BYTES);
  }
});

test("loadSourceInventory: 변수가 true일 때만 인벤토리를 읽고, 꺼짐·미설정이면 undefined, 알 수 없는 값은 실패한다", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "status-inventory-"));
  try {
    await mkdir(path.join(root, "tools/datapack"), { recursive: true });
    await writeFile(path.join(root, "tools/datapack/source-inventory.json"), JSON.stringify(inventoryOf(evidenceSource("a", 1))));
    assert.equal(await loadSourceInventory({ env: {}, root }), undefined);
    assert.equal(await loadSourceInventory({ env: { AUTOMATION_STATUS_SOURCE_FRESHNESS: "" }, root }), undefined);
    assert.equal(await loadSourceInventory({ env: { AUTOMATION_STATUS_SOURCE_FRESHNESS: "false" }, root }), undefined);
    assert.equal((await loadSourceInventory({ env: { AUTOMATION_STATUS_SOURCE_FRESHNESS: "true" }, root })).sources[0].id, "a");
    for (const bad of ["TRUE", "1", "yes", " true"]) {
      await assert.rejects(loadSourceInventory({ env: { AUTOMATION_STATUS_SOURCE_FRESHNESS: bad }, root }), /STATUS_ENV_INVALID/u);
    }
    await assert.rejects(loadSourceInventory({ env: { AUTOMATION_STATUS_SOURCE_FRESHNESS: "true" }, root: path.join(root, "missing") }), /ENOENT|STATUS_INVENTORY_INVALID/u);
    await writeFile(path.join(root, "tools/datapack/source-inventory.json"), "{not json");
    await assert.rejects(loadSourceInventory({ env: { AUTOMATION_STATUS_SOURCE_FRESHNESS: "true" }, root }), /STATUS_INVENTORY_INVALID/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
