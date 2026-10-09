import assert from "node:assert/strict";
import test from "node:test";

import {
  SNAPSHOT_MAX_BYTES,
  STATUS_STAGES,
  buildAutomationStatus,
  collectAutomationStatus,
  postAutomationStatus,
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
