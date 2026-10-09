import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ChainError,
  DATA_DISPATCH_ACTOR,
  RELEASE_CHAIN_APP,
  assertBackendNotOlder,
  deployStage,
  formatDeployRunName,
  hubGatesStage,
  parseDeployRunName,
  publishStage,
  requireReleaseArtifact,
  rollbackStage,
  runChainStage,
  selectActiveRelease,
  selectBackendProducerRun,
  selectDeployInputsStage,
  verifyStage,
} from "./datapack-release-chain.mjs";

const HUB = "AquilaXk/easysubway";
const DATA = "AquilaXk/easysubway-data";
const PLATFORM = "AquilaXk/easysubway-platform";
const BACKEND = "AquilaXk/easysubway-backend";
const RC_SHA = "a".repeat(40);
const OLD_BACKEND_SHA = "1".repeat(40);
const NEW_BACKEND_SHA = "2".repeat(40);
const digest = (char) => `sha256:${char.repeat(64)}`;
const tokens = { hub: "hub-token", platform: "platform-token", backend: "backend-token", data: "data-token" };

async function rejectsWith(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof ChainError, `expected ChainError, got ${error}`);
    assert.equal(error.code, code, error.message);
    return true;
  });
}

// ---------- pure decisions ----------

test("deploy run-name은 platform 고정 형식으로만 해석되고 형식이 어긋나면 해석 불가다", () => {
  const ids = { backendRunId: "37912373228", backendArtifactId: "11607367446", dataRunId: "37930592937", dataArtifactId: "11610000000" };
  const title = formatDeployRunName("DEPLOY", ids);
  assert.equal(title, "DEPLOY backend=37912373228/11607367446 data=37930592937/11610000000");
  assert.deepEqual(parseDeployRunName(title), { mode: "DEPLOY", ...ids });
  assert.equal(parseDeployRunName(formatDeployRunName("PREVIEW", ids)).mode, "PREVIEW");
  for (const bad of [
    "Source-free Journey K3s Deploy", "", undefined, null, 42,
    "DEPLOY backend=1/2 data=3/4 extra", " DEPLOY backend=1/2 data=3/4", "DEPLOY backend=0/2 data=3/4",
    "DEPLOY backend=01/2 data=3/4", "ROLLBACK backend=1/2 data=3/4", "DEPLOY backend=1/2\ndata=3/4",
    "DEPLOY backend=1/2 data=3/4\n", "DEPLOY backend=a/2 data=3/4",
  ]) assert.equal(parseDeployRunName(bad), null, JSON.stringify(bad));
  assert.throws(() => formatDeployRunName("DEPLOY", { ...ids, backendRunId: "1; rm" }), /invalid/u);
});

const deployRun = (id, title, conclusion = "success", extra = {}) => ({
  id, display_title: title, status: "completed", conclusion, event: "workflow_dispatch", head_branch: "main",
  triggering_actor: { login: RELEASE_CHAIN_APP },
  created_at: `2026-10-09T${String(10 + (id % 10)).padStart(2, "0")}:00:00Z`, ...extra,
});
const ACTIVE = { backendRunId: "100", backendArtifactId: "101", dataRunId: "200", dataArtifactId: "201" };

test("직전 활성 release는 가장 최근 DEPLOY run의 run-name에서만 읽고 추정하지 않는다", () => {
  const newer = { backendRunId: "300", backendArtifactId: "301", dataRunId: "400", dataArtifactId: "401" };
  const runs = [
    deployRun(1, formatDeployRunName("DEPLOY", ACTIVE), "success", { created_at: "2026-10-08T00:00:00Z" }),
    deployRun(2, formatDeployRunName("PREVIEW", newer), "success", { created_at: "2026-10-09T00:00:00Z" }),
    deployRun(3, formatDeployRunName("DEPLOY", newer), "success", { created_at: "2026-10-09T00:01:00Z" }),
  ];
  assert.deepEqual(selectActiveRelease(runs), { runId: 3, ...newer });
  assert.deepEqual(selectActiveRelease(runs.slice(0, 2)), { runId: 1, ...ACTIVE });
});

test("활성 release를 알 수 없거나 불확실하면 배포 입력을 만들지 않는다", async () => {
  const done = (id, mode, conclusion, at, ids = ACTIVE) => deployRun(id, formatDeployRunName(mode, ids), conclusion, { created_at: at });
  const cases = [
    ["no runs", [], "ACTIVE_RELEASE_UNKNOWN"],
    ["only previews", [done(1, "PREVIEW", "success", "2026-10-09T00:00:00Z")], "ACTIVE_RELEASE_UNKNOWN"],
    ["legacy title first", [deployRun(1, "Source-free Journey K3s Deploy")], "ACTIVE_RELEASE_UNCERTAIN"],
    ["latest deploy failed", [done(1, "DEPLOY", "success", "2026-10-08T00:00:00Z"), done(2, "DEPLOY", "failure", "2026-10-09T00:00:00Z")], "ACTIVE_RELEASE_UNCERTAIN"],
    ["latest deploy cancelled", [done(1, "DEPLOY", "success", "2026-10-08T00:00:00Z"), done(2, "DEPLOY", "cancelled", "2026-10-09T00:00:00Z")], "ACTIVE_RELEASE_UNCERTAIN"],
    ["deploy in flight", [done(1, "DEPLOY", "success", "2026-10-08T00:00:00Z"), deployRun(2, formatDeployRunName("DEPLOY", ACTIVE), null, { status: "in_progress" })], "DEPLOY_IN_FLIGHT"],
    ["deploy queued", [deployRun(2, formatDeployRunName("PREVIEW", ACTIVE), null, { status: "queued" })], "DEPLOY_IN_FLIGHT"],
    ["not main", [deployRun(1, formatDeployRunName("DEPLOY", ACTIVE), "success", { head_branch: "feature" })], "ACTIVE_RELEASE_UNCERTAIN"],
  ];
  for (const [label, runs, code] of cases) {
    assert.throws(() => selectActiveRelease(runs), (error) => error instanceof ChainError && error.code === code, label);
  }
});

const listing = (artifact, extra = {}) => ({ total_count: 1, artifacts: [artifact], ...extra });
const artifact = (overrides = {}) => ({
  id: 5, name: "easysubway-x", expired: false, digest: digest("c"), workflow_run: { id: 77 }, ...overrides,
});

test("릴리스 artifact는 이름·run·만료·digest가 모두 맞는 정확히 하나만 통과한다", () => {
  assert.deepEqual(
    requireReleaseArtifact(listing(artifact()), { name: "easysubway-x", runId: 77 }),
    { id: 5, name: "easysubway-x", digest: digest("c"), sha256: "c".repeat(64) },
  );
  for (const [label, value] of [
    ["empty", { total_count: 0, artifacts: [] }],
    ["two", { total_count: 2, artifacts: [artifact(), artifact({ id: 6 })] }],
    ["inconsistent count", { total_count: 1, artifacts: [] }],
    ["wrong name", listing(artifact({ name: "other" }))],
    ["expired", listing(artifact({ expired: true }))],
    ["other run", listing(artifact({ workflow_run: { id: 78 } }))],
    ["no digest", listing(artifact({ digest: null }))],
    ["short digest", listing(artifact({ digest: "sha256:abc" }))],
    ["upper digest", listing(artifact({ digest: `sha256:${"C".repeat(64)}` }))],
    ["md5 digest", listing(artifact({ digest: `md5:${"c".repeat(64)}` }))],
    ["string id", listing(artifact({ id: "5" }))],
    ["not object", null],
  ]) {
    assert.throws(() => requireReleaseArtifact(value, { name: "easysubway-x", runId: 77 }),
      (error) => error instanceof ChainError && error.code === "ARTIFACT_INVALID", label);
  }
});

test("backend는 활성 backend보다 오래되거나 갈라진 커밋이면 거부한다", () => {
  assert.doesNotThrow(() => assertBackendNotOlder({ activeSha: OLD_BACKEND_SHA, candidateSha: NEW_BACKEND_SHA, compareStatus: "ahead" }));
  assert.doesNotThrow(() => assertBackendNotOlder({ activeSha: OLD_BACKEND_SHA, candidateSha: OLD_BACKEND_SHA, compareStatus: "identical" }));
  for (const status of ["behind", "diverged", "", undefined, "ahead_by_2"]) {
    assert.throws(() => assertBackendNotOlder({ activeSha: OLD_BACKEND_SHA, candidateSha: NEW_BACKEND_SHA, compareStatus: status }),
      (error) => error instanceof ChainError && error.code === "BACKEND_OLDER_THAN_ACTIVE", String(status));
  }
});

test("backend producer는 main의 push·dispatch 성공 run 중 가장 최근 것만 고른다", () => {
  const run = (id, at, extra = {}) => ({
    id, created_at: at, status: "completed", conclusion: "success", event: "push", head_branch: "main",
    head_sha: String(id % 10).repeat(40), path: ".github/workflows/release-artifacts.yml", run_attempt: 1, ...extra,
  });
  const picked = selectBackendProducerRun([
    run(1, "2026-10-09T01:00:00Z"),
    run(2, "2026-10-09T03:00:00Z", { event: "workflow_dispatch" }),
    run(3, "2026-10-09T04:00:00Z", { event: "pull_request" }),
    run(4, "2026-10-09T05:00:00Z", { head_branch: "feature" }),
    run(5, "2026-10-09T06:00:00Z", { conclusion: "failure" }),
    run(6, "2026-10-09T07:00:00Z", { path: ".github/workflows/other.yml" }),
    run(7, "2026-10-09T02:00:00Z"),
  ]);
  assert.equal(picked.id, 2);
  assert.throws(() => selectBackendProducerRun([]), (error) => error instanceof ChainError && error.code === "BACKEND_PRODUCER_NOT_FOUND");
});

// ---------- fake GitHub ----------

class World {
  constructor() {
    this.clock = Date.parse("2026-10-09T12:00:00Z");
    this.refs = { [HUB]: "b".repeat(40), [DATA]: RC_SHA };
    this.runs = new Map(); // `${repo}|${workflow}` -> run[]
    this.runById = new Map(); // `${repo}|${id}` -> run
    this.artifactsByRun = new Map(); // `${repo}|${runId}` -> artifact[]
    this.artifactsById = new Map(); // `${repo}|${id}` -> artifact
    this.compare = new Map();
    this.behaviors = new Map();
    this.dispatches = [];
    this.nextId = 9000;
    this.calls = [];
    this.cancelled = [];
  }

  now() { return this.clock; }
  async sleep(ms) { this.clock += Math.max(ms, 1000); }
  seedRuns(repo, workflow, runs) {
    this.runs.set(`${repo}|${workflow}`, runs);
    for (const run of runs) this.runById.set(`${repo}|${run.id}`, run);
  }
  addArtifact(repo, runId, art) {
    const key = `${repo}|${runId}`;
    this.artifactsByRun.set(key, [...(this.artifactsByRun.get(key) ?? []), art]);
    this.artifactsById.set(`${repo}|${art.id}`, art);
  }
  // behavior key: repo|workflow[|mode]
  script(key, fn) { this.behaviors.set(key, fn); }

  async api(endpoint, { token } = {}) {
    this.calls.push({ endpoint, token });
    const [pathPart] = endpoint.split("?");
    let match;
    if ((match = /^repos\/([^/]+\/[^/]+)\/git\/ref\/heads\/main$/u.exec(pathPart))) {
      return { object: { sha: this.refs[match[1]] } };
    }
    if ((match = /^repos\/([^/]+\/[^/]+)\/actions\/workflows\/([^/]+)\/runs$/u.exec(pathPart))) {
      return { workflow_runs: [...(this.runs.get(`${match[1]}|${match[2]}`) ?? [])] };
    }
    if ((match = /^repos\/([^/]+\/[^/]+)\/actions\/runs\/(\d+)\/artifacts$/u.exec(pathPart))) {
      const name = new URLSearchParams(endpoint.split("?")[1] ?? "").get("name");
      const all = (this.artifactsByRun.get(`${match[1]}|${match[2]}`) ?? []).filter((a) => name === null || a.name === name);
      return { total_count: all.length, artifacts: all };
    }
    if ((match = /^repos\/([^/]+\/[^/]+)\/actions\/runs\/(\d+)$/u.exec(pathPart))) {
      const run = this.runById.get(`${match[1]}|${match[2]}`);
      if (!run) throw new Error(`gh: not found ${endpoint}`);
      if (run.pendingReads > 0) {
        run.pendingReads -= 1;
        return { ...run, status: run.pendingStatus ?? "in_progress", conclusion: null };
      }
      return { ...run };
    }
    if ((match = /^repos\/([^/]+\/[^/]+)\/actions\/artifacts\/(\d+)$/u.exec(pathPart))) {
      const art = this.artifactsById.get(`${match[1]}|${match[2]}`);
      if (!art) throw new Error(`gh: not found ${endpoint}`);
      return art;
    }
    if ((match = /^repos\/([^/]+\/[^/]+)\/compare\/([0-9a-f]{40})\.\.\.([0-9a-f]{40})$/u.exec(pathPart))) {
      const status = this.compare.get(`${match[2]}...${match[3]}`);
      if (status === undefined) throw new Error(`gh: not found ${endpoint}`);
      return { status };
    }
    throw new Error(`unexpected api call: ${endpoint}`);
  }

  async dispatch({ repo, workflow, ref, inputs = {}, token }) {
    this.dispatches.push({ repo, workflow, ref, inputs, token });
    const key = `${repo}|${workflow}`;
    const behavior = this.behaviors.get(`${key}|${inputs.mode ?? ""}`) ?? this.behaviors.get(key);
    assert.ok(behavior, `no scripted behavior for ${key}|${inputs.mode ?? ""}`);
    const outcome = behavior(inputs, this) ?? {};
    const id = this.nextId++;
    const run = {
      id, status: "completed", conclusion: "success", event: "workflow_dispatch", head_branch: "main",
      head_sha: this.refs[repo] ?? RC_SHA, path: `.github/workflows/${workflow}`, run_attempt: 1,
      created_at: new Date(this.clock).toISOString(), triggering_actor: { login: RELEASE_CHAIN_APP },
      display_title: workflow, pendingReads: 0, ...outcome,
    };
    this.runs.set(key, [run, ...(this.runs.get(key) ?? [])]);
    this.runById.set(`${repo}|${id}`, run);
    for (const art of outcome.artifacts ?? []) this.addArtifact(repo, id, art);
    return run;
  }

  async cancel({ repo, runId, token }) { this.cancelled.push({ repo, runId, token }); }

  gh() {
    return {
      api: (endpoint, options) => this.api(endpoint, options),
      dispatch: (options) => this.dispatch(options),
      cancel: (options) => this.cancel(options),
    };
  }
  context(extra = {}) {
    return {
      gh: this.gh(), tokens, now: () => this.now(), sleep: (ms) => this.sleep(ms), pollMs: 5000,
      timeouts: { compat: 600_000, promotion: 600_000, publish: 1_200_000, preview: 600_000, deploy: 900_000, discover: 60_000 },
      ...extra,
    };
  }
}

const initialState = () => ({ schemaVersion: 1, rc: { runId: "7001", sha: RC_SHA } });

function seedHub(world, { compat = () => ({}), promotion = () => ({}) } = {}) {
  world.script(`${HUB}|release-artifacts.yml`, (inputs, w) => {
    const base = { head_sha: w.refs[HUB], artifacts: [] };
    const outcome = compat(inputs, w) ?? {};
    return { ...base, ...outcome };
  });
  world.script(`${HUB}|datapack-promotion.yml`, (inputs, w) => ({ head_sha: w.refs[HUB], artifacts: [], ...(promotion(inputs, w) ?? {}) }));
}

// compat artifact needs the dispatched run id, which is assigned inside dispatch(); patch dispatch to register artifacts by run.
function installCompatArtifacts(world) {
  const dispatch = world.dispatch.bind(world);
  world.dispatch = async (options) => {
    const run = await dispatch(options);
    if (options.repo === HUB && options.workflow === "release-artifacts.yml" && run.conclusion === "success") {
      world.addArtifact(HUB, run.id, { id: run.id * 10, name: `easysubway-datapack-compatibility-${run.id}`, expired: false, digest: digest("d"), workflow_run: { id: run.id } });
    }
    if (options.repo === HUB && options.workflow === "datapack-promotion.yml" && run.conclusion === "success") {
      world.addArtifact(HUB, run.id, { id: run.id * 10, name: `easysubway-datapack-promotion-${run.id}`, expired: false, digest: digest("e"), workflow_run: { id: run.id } });
    }
    return run;
  };
}

// ---------- hub gates ----------

test("hub 게이트: 호환성 run 성공 뒤 hub main이 그대로일 때만 승격을 dispatch하고 같은 SHA의 증거로 결속한다", async () => {
  const world = new World();
  seedHub(world);
  installCompatArtifacts(world);
  const state = await hubGatesStage(world.context(), initialState());
  assert.equal(world.dispatches.length, 2);
  const [compat, promotion] = world.dispatches;
  assert.deepEqual(compat, {
    repo: HUB, workflow: "release-artifacts.yml", ref: "main", token: "hub-token",
    inputs: { android_rc_signing_mode: "ci-self-signed", play_upload: "none", datapack_candidate_run_id: "7001" },
  });
  assert.equal(promotion.workflow, "datapack-promotion.yml");
  assert.deepEqual(promotion.inputs, {
    candidateRunId: "7001",
    compatibilityEvidenceRunId: String(state.hub.compatRunId),
    compatibilityEvidenceArtifactName: `easysubway-datapack-compatibility-${state.hub.compatRunId}`,
    issueRef: "AquilaXk/easysubway#2705",
  });
  assert.equal(state.hub.hubSha, "b".repeat(40));
  assert.equal(state.hub.attempts, 1);
  assert.ok(Number.isSafeInteger(state.hub.promotionRunId));
});

test("hub 게이트: 호환성 취소·hub 이동은 한정 횟수만 처음부터 재시도하고 소진하면 명시적으로 실패한다", async () => {
  const world = new World();
  let compatCalls = 0;
  seedHub(world, {
    compat: (_inputs, w) => {
      compatCalls += 1;
      if (compatCalls === 1) return { conclusion: "cancelled" };
      if (compatCalls === 2) { const sha = w.refs[HUB]; w.refs[HUB] = "c".repeat(40); return { head_sha: sha }; }
      return {};
    },
  });
  installCompatArtifacts(world);
  const state = await hubGatesStage(world.context(), initialState());
  assert.equal(compatCalls, 3);
  assert.equal(state.hub.attempts, 3);
  assert.equal(state.hub.hubSha, "c".repeat(40));
  assert.equal(world.dispatches.filter((d) => d.workflow === "datapack-promotion.yml").length, 1);

  const exhausted = new World();
  seedHub(exhausted, { compat: () => ({ conclusion: "cancelled" }) });
  installCompatArtifacts(exhausted);
  await rejectsWith(hubGatesStage(exhausted.context(), initialState()), "HUB_GATES_RETRY_EXHAUSTED");
  assert.equal(exhausted.dispatches.length, 3);
  assert.equal(exhausted.dispatches.some((d) => d.workflow === "datapack-promotion.yml"), false);
});

test("hub 게이트: 호환성 실패는 재시도 없이, 승격 실패는 같은 SHA면 재시도 없이 실패한다", async () => {
  const failing = new World();
  seedHub(failing, { compat: () => ({ conclusion: "failure" }) });
  installCompatArtifacts(failing);
  await rejectsWith(hubGatesStage(failing.context(), initialState()), "COMPAT_FAILED");
  assert.equal(failing.dispatches.length, 1);

  const rejected = new World();
  seedHub(rejected, { promotion: () => ({ conclusion: "failure" }) });
  installCompatArtifacts(rejected);
  await rejectsWith(hubGatesStage(rejected.context(), initialState()), "PROMOTION_FAILED");
  assert.equal(rejected.dispatches.length, 2);
});

test("hub 게이트: 호환성 artifact가 없거나 두 번째 dispatch 후보가 모호하면 승격을 시작하지 않는다", async () => {
  const world = new World();
  seedHub(world);
  // 호환성 artifact를 등록하지 않는다.
  await rejectsWith(hubGatesStage(world.context(), initialState()), "ARTIFACT_INVALID");
  assert.equal(world.dispatches.some((d) => d.workflow === "datapack-promotion.yml"), false);

  const ambiguous = new World();
  seedHub(ambiguous);
  installCompatArtifacts(ambiguous);
  const dispatch = ambiguous.dispatch.bind(ambiguous);
  ambiguous.dispatch = async (options) => {
    const run = await dispatch(options);
    // 같은 시각에 다른 run이 하나 더 생겼다.
    const twin = { ...run, id: run.id + 500 };
    ambiguous.runs.set(`${options.repo}|${options.workflow}`, [twin, ...ambiguous.runs.get(`${options.repo}|${options.workflow}`)]);
    ambiguous.runById.set(`${options.repo}|${twin.id}`, twin);
    return run;
  };
  await rejectsWith(hubGatesStage(ambiguous.context(), initialState()), "RUN_AMBIGUOUS");
});

test("hub 게이트: dispatch한 run이 제한 시간 안에 끝나지 않으면 RUN_TIMEOUT으로 실패한다", async () => {
  const world = new World();
  seedHub(world, { compat: () => ({ pendingReads: 100000 }) });
  installCompatArtifacts(world);
  await rejectsWith(hubGatesStage(world.context(), initialState()), "RUN_TIMEOUT");
});

test("제한 시간을 넘긴 run은 아직 시작하지 않았을 때만 취소하고, 이미 실행 중이면 건드리지 않는다", async () => {
  // 러너가 없어 queued로 남은 DEPLOY가 나중에 갑자기 실행되는 일이 없도록 시작 전 run은 취소한다.
  const queued = new World();
  seedHub(queued, { compat: () => ({ pendingReads: 100000, pendingStatus: "queued" }) });
  installCompatArtifacts(queued);
  await rejectsWith(hubGatesStage(queued.context(), initialState()), "RUN_TIMEOUT");
  assert.equal(queued.cancelled.length, 1);
  assert.equal(queued.cancelled[0].repo, HUB);
  assert.equal(queued.cancelled[0].token, "hub-token");

  // 이미 실행 중인 run(예: 트래픽 전환 중인 DEPLOY)은 취소하지 않는다.
  const running = new World();
  seedHub(running, { compat: () => ({ pendingReads: 100000 }) });
  installCompatArtifacts(running);
  await rejectsWith(hubGatesStage(running.context(), initialState()), "RUN_TIMEOUT");
  assert.equal(running.cancelled.length, 0);
});

test("dispatch한 run이 목록에 나타나지 않으면 RUN_NOT_FOUND로 실패한다", async () => {
  const world = new World();
  seedHub(world);
  installCompatArtifacts(world);
  const context = world.context();
  context.gh.dispatch = async (options) => { world.dispatches.push(options); };
  await rejectsWith(hubGatesStage(context, initialState()), "RUN_NOT_FOUND");
});

// ---------- publish ----------

const modeArgsFor = (extra) => async ({ candidateRunId, promotionRunId }) => ({
  buildSpecPath: "tools/datapack/release/candidate-build-spec.json",
  releaseRequestId: "release-request-x",
  releaseRequestPath: "tools/datapack/release/release-request.json",
  androidEvidencePath: "tools/datapack/release/android-evidence-summary.json",
  strictRouteRegressionPath: "tools/datapack/release/strict-route-regression-report.json",
  allowGaps: "false",
  sourceGovernanceEvaluationAt: "",
  candidateRunId,
  promotionRunId,
  ...extra,
});

function publishWorld({ behavior = () => ({}), manifest = { releaseSequence: 130, expiresAt: "2026-10-12T00:00:00.000Z" }, finalArtifact = true } = {}) {
  const world = new World();
  world.script(`${DATA}|datapack-release.yml|production-publish`, (inputs, w) => {
    const outcome = behavior(inputs, w) ?? {};
    return { head_sha: w.refs[DATA], display_title: "Data Pack Release (production-publish)", triggering_actor: { login: "github-actions[bot]" }, ...outcome };
  });
  const dispatch = world.dispatch.bind(world);
  world.dispatch = async (options) => {
    const run = await dispatch(options);
    if (finalArtifact && run.conclusion === "success") {
      world.addArtifact(DATA, run.id, { id: run.id * 10, name: `easysubway-datapacks-${run.head_sha}`, expired: false, digest: digest("f"), workflow_run: { id: run.id } });
    }
    return run;
  };
  const publishContext = (extra = {}) => world.context({
    readModeArgs: modeArgsFor({}), expectedSequence: 130, fetchJson: async () => manifest, ...extra,
  });
  return { world, publishContext };
}

const afterHub = () => ({ ...initialState(), hub: { compatRunId: 8001, promotionRunId: 8002, hubSha: "b".repeat(40), attempts: 1 } });

test("발행: main이 RC 커밋 그대로일 때 저장소 파일 기반 modeArgs로 production-publish를 dispatch하고 FINAL artifact를 확인한다", async () => {
  const { world, publishContext } = publishWorld();
  const state = await publishStage(publishContext(), afterHub());
  const [dispatched] = world.dispatches;
  assert.equal(dispatched.repo, DATA);
  assert.equal(dispatched.workflow, "datapack-release.yml");
  assert.equal(dispatched.ref, "main");
  assert.equal(dispatched.token, "data-token");
  assert.equal(dispatched.inputs.mode, "production-publish");
  assert.equal(dispatched.inputs.targetChannel, "production");
  assert.deepEqual(Object.keys(JSON.parse(dispatched.inputs.modeArgs)).sort(), [
    "allowGaps", "androidEvidencePath", "buildSpecPath", "candidateRunId", "promotionRunId",
    "releaseRequestId", "releaseRequestPath", "sourceGovernanceEvaluationAt", "strictRouteRegressionPath",
  ]);
  assert.equal(JSON.parse(dispatched.inputs.modeArgs).candidateRunId, "7001");
  assert.equal(JSON.parse(dispatched.inputs.modeArgs).promotionRunId, "8002");
  assert.equal(state.publish.releaseSequence, 130);
  assert.deepEqual(state.publish.finalArtifact, { id: state.publish.runId * 10, name: `easysubway-datapacks-${RC_SHA}`, digest: digest("f"), sha256: "f".repeat(64) });
});

test("발행: data main이 RC 이후 움직였으면 dispatch 없이 CHAIN_MAIN_MOVED로 실패한다", async () => {
  const { world, publishContext } = publishWorld();
  world.refs[DATA] = "9".repeat(40);
  await rejectsWith(publishStage(publishContext(), afterHub()), "CHAIN_MAIN_MOVED");
  assert.equal(world.dispatches.length, 0);
});

test("발행: 발행 run 실패·FINAL artifact 없음·공개 manifest 불일치·만료 임박은 모두 명시적으로 실패한다", async () => {
  let publish = publishWorld({ behavior: () => ({ conclusion: "failure" }) });
  await rejectsWith(publishStage(publish.publishContext(), afterHub()), "PUBLISH_FAILED");

  publish = publishWorld({ finalArtifact: false });
  await rejectsWith(publishStage(publish.publishContext(), afterHub()), "ARTIFACT_INVALID");

  publish = publishWorld({ manifest: { releaseSequence: 129, expiresAt: "2026-10-12T00:00:00.000Z" } });
  await rejectsWith(publishStage(publish.publishContext(), afterHub()), "PUBLISH_MANIFEST_MISMATCH");

  publish = publishWorld({ manifest: { releaseSequence: 130, expiresAt: "2026-10-09T12:30:00.000Z" } });
  await rejectsWith(publishStage(publish.publishContext(), afterHub()), "PUBLISH_MANIFEST_EXPIRING");

  // 검증한 RC 커밋이 아닌 main으로 시작된 발행 run은 취소하고 실패한다.
  publish = publishWorld({ behavior: () => ({ head_sha: "9".repeat(40) }) });
  await rejectsWith(publishStage(publish.publishContext(), afterHub()), "CHAIN_MAIN_MOVED");
  assert.equal(publish.world.cancelled.length, 1);
  assert.equal(publish.world.cancelled[0].repo, DATA);

  const missingPromotion = publishWorld();
  await rejectsWith(publishStage(missingPromotion.publishContext(), { ...afterHub(), hub: undefined }), "CHAIN_STATE_INVALID");
  assert.equal(missingPromotion.world.dispatches.length, 0);
});

// ---------- deploy input selection + deploy ----------

const PREV = { backendRunId: "100", backendArtifactId: "101", dataRunId: "200", dataArtifactId: "201" };

function deployWorld({ compare = "ahead", previousExpired = false, backendDigest = digest("b"), inFlight = false, legacy = false } = {}) {
  const world = new World();
  world.refs[PLATFORM] = "p".repeat(40);
  const previous = deployRun(50, legacy ? "Source-free Journey K3s Deploy" : formatDeployRunName("DEPLOY", PREV), "success", { created_at: "2026-10-08T00:00:00Z" });
  const runs = [previous];
  if (inFlight) runs.push(deployRun(51, formatDeployRunName("PREVIEW", PREV), null, { status: "in_progress", created_at: "2026-10-09T11:59:00Z" }));
  world.seedRuns(PLATFORM, "source-free-journey-k3s-deploy.yml", runs);
  // previous release artifacts (rollback inputs)
  world.runById.set(`${BACKEND}|100`, { id: 100, head_sha: OLD_BACKEND_SHA, conclusion: "success", head_branch: "main", path: ".github/workflows/release-artifacts.yml" });
  world.artifactsById.set(`${BACKEND}|101`, { id: 101, name: `easysubway-backend-release-${OLD_BACKEND_SHA}-1`, expired: previousExpired, digest: digest("1"), workflow_run: { id: 100 } });
  world.artifactsById.set(`${DATA}|201`, { id: 201, name: `easysubway-datapacks-${"d".repeat(40)}`, expired: false, digest: digest("2"), workflow_run: { id: 200 } });
  // new backend producer
  const newRun = {
    id: 300, created_at: "2026-10-09T09:00:00Z", status: "completed", conclusion: "success", event: "push", head_branch: "main",
    head_sha: NEW_BACKEND_SHA, path: ".github/workflows/release-artifacts.yml", run_attempt: 1,
  };
  world.seedRuns(BACKEND, "release-artifacts.yml", [newRun]);
  world.addArtifact(BACKEND, 300, { id: 301, name: `easysubway-backend-release-${NEW_BACKEND_SHA}-1`, expired: false, digest: backendDigest, workflow_run: { id: 300 } });
  world.compare.set(`${OLD_BACKEND_SHA}...${NEW_BACKEND_SHA}`, compare);
  world.script(`${PLATFORM}|source-free-journey-k3s-deploy.yml`, (inputs) => ({
    display_title: formatDeployRunName(inputs.mode, {
      backendRunId: inputs.backend_run_id, backendArtifactId: inputs.backend_artifact_id,
      dataRunId: inputs.data_run_id, dataArtifactId: inputs.data_artifact_id,
    }),
  }));
  return world;
}

const afterPublish = () => ({
  ...afterHub(),
  publish: {
    runId: 7100, releaseSequence: 130,
    finalArtifact: { id: 71001, name: `easysubway-datapacks-${RC_SHA}`, digest: digest("f"), sha256: "f".repeat(64) },
  },
});

test("배포 입력: 활성 release를 읽고 최신 backend producer artifact를 digest·단조성 검증 뒤 고른다", async () => {
  const world = deployWorld();
  const state = await selectDeployInputsStage(world.context(), afterPublish());
  assert.deepEqual(state.deploy.next, {
    backend_run_id: "300", backend_artifact_id: "301", backend_artifact_name: `easysubway-backend-release-${NEW_BACKEND_SHA}-1`,
    backend_archive_sha256: "b".repeat(64),
    data_run_id: "7100", data_artifact_id: "71001", data_artifact_name: `easysubway-datapacks-${RC_SHA}`,
    data_archive_sha256: "f".repeat(64),
  });
  assert.deepEqual(state.deploy.previous, {
    backend_run_id: "100", backend_artifact_id: "101", backend_artifact_name: `easysubway-backend-release-${OLD_BACKEND_SHA}-1`,
    backend_archive_sha256: "1".repeat(64),
    data_run_id: "200", data_artifact_id: "201", data_artifact_name: `easysubway-datapacks-${"d".repeat(40)}`,
    data_archive_sha256: "2".repeat(64),
  });
  assert.equal(state.deploy.activeBackendSha, OLD_BACKEND_SHA);
  assert.equal(state.deploy.nextBackendSha, NEW_BACKEND_SHA);
  assert.equal(world.dispatches.length, 0);
  // 백엔드 읽기에는 backend 토큰, 플랫폼 읽기에는 platform 토큰을 쓴다.
  assert.ok(world.calls.filter((c) => c.endpoint.includes(`repos/${BACKEND}/`)).every((c) => c.token === "backend-token"));
  assert.ok(world.calls.filter((c) => c.endpoint.includes(`repos/${PLATFORM}/`)).every((c) => c.token === "platform-token"));
});

test("배포 입력: 활성보다 오래된 backend·digest 불량·이전 artifact 만료·진행 중 배포·기록 없음은 모두 배포 전에 실패한다", async () => {
  for (const [label, options, code] of [
    ["behind", { compare: "behind" }, "BACKEND_OLDER_THAN_ACTIVE"],
    ["diverged", { compare: "diverged" }, "BACKEND_OLDER_THAN_ACTIVE"],
    ["bad digest", { backendDigest: "sha256:zz" }, "ARTIFACT_INVALID"],
    ["previous expired", { previousExpired: true }, "ROLLBACK_PATH_UNAVAILABLE"],
    ["in flight", { inFlight: true }, "DEPLOY_IN_FLIGHT"],
    ["legacy title", { legacy: true }, "ACTIVE_RELEASE_UNCERTAIN"],
  ]) {
    const world = deployWorld(options);
    await rejectsWith(selectDeployInputsStage(world.context(), afterPublish()), code);
    assert.equal(world.dispatches.length, 0, label);
  }
});

test("배포: PREVIEW가 성공한 뒤에만 같은 입력으로 DEPLOY를 dispatch하고 run-name으로 정확한 run을 식별한다", async () => {
  const world = deployWorld();
  let state = await selectDeployInputsStage(world.context(), afterPublish());
  state = await deployStage(world.context(), state);
  assert.deepEqual(world.dispatches.map((d) => [d.workflow, d.inputs.mode, d.token]), [
    ["source-free-journey-k3s-deploy.yml", "PREVIEW", "platform-token"],
    ["source-free-journey-k3s-deploy.yml", "DEPLOY", "platform-token"],
  ]);
  for (const dispatched of world.dispatches) {
    const { mode, ...rest } = dispatched.inputs;
    assert.deepEqual(rest, state.deploy.next);
    assert.ok(["PREVIEW", "DEPLOY"].includes(mode));
  }
  assert.equal(state.deploy.deployed, true);
  assert.ok(Number.isSafeInteger(state.deploy.previewRunId) && Number.isSafeInteger(state.deploy.deployRunId));
});

test("배포: PREVIEW 실패는 DEPLOY를 막고, DEPLOY 실패는 활성 상태를 모르므로 자동 롤백 대상으로 표시하지 않는다", async () => {
  let world = deployWorld();
  world.script(`${PLATFORM}|source-free-journey-k3s-deploy.yml|PREVIEW`, (inputs) => ({
    conclusion: "failure",
    display_title: formatDeployRunName("PREVIEW", { backendRunId: inputs.backend_run_id, backendArtifactId: inputs.backend_artifact_id, dataRunId: inputs.data_run_id, dataArtifactId: inputs.data_artifact_id }),
  }));
  let state = await selectDeployInputsStage(world.context(), afterPublish());
  await rejectsWith(deployStage(world.context(), state), "PREVIEW_FAILED");
  assert.equal(world.dispatches.length, 1);

  world = deployWorld();
  world.script(`${PLATFORM}|source-free-journey-k3s-deploy.yml|DEPLOY`, (inputs) => ({
    conclusion: "failure",
    display_title: formatDeployRunName("DEPLOY", { backendRunId: inputs.backend_run_id, backendArtifactId: inputs.backend_artifact_id, dataRunId: inputs.data_run_id, dataArtifactId: inputs.data_artifact_id }),
  }));
  state = await selectDeployInputsStage(world.context(), afterPublish());
  const stateRef = state;
  await rejectsWith(deployStage(world.context(), state), "DEPLOY_FAILED");
  assert.equal(stateRef.deploy.deployed, undefined);
});

// ---------- verify + rollback ----------

function verifyContext(overrides = {}) {
  const world = new World();
  const requests = [];
  return {
    world, requests,
    context: world.context({
      apiBaseUrl: "https://api.example.invalid",
      expectedSequence: 130,
      readinessChecks: 3, readinessIntervalMs: 30_000,
      minManifestRemainingSeconds: 12 * 3600,
      fetchStatus: async (url) => { requests.push(url); return { status: 200 }; },
      fetchJson: async () => ({ releaseSequence: 130, expiresAt: "2026-10-12T00:00:00.000Z" }),
      ...overrides,
    }),
  };
}

test("검증: readiness 200 연속 3회와 발행 sequence·충분한 잔여 만료 시간이 모두 맞아야 통과한다", async () => {
  const { context, requests } = verifyContext();
  const state = await verifyStage(context, afterPublish());
  assert.deepEqual(requests, Array(3).fill("https://api.example.invalid/actuator/health/readiness"));
  assert.equal(state.verify.ok, true);
  assert.equal(state.verify.releaseSequence, 130);
});

test("검증: readiness 비200·sequence 불일치·만료 임박은 각각 다른 코드로 실패하고 한 번이라도 실패하면 통과가 아니다", async () => {
  let calls = 0;
  await rejectsWith(verifyStage(verifyContext({ fetchStatus: async () => ({ status: ++calls === 2 ? 503 : 200 }) }).context, afterPublish()), "VERIFY_READINESS_FAILED");
  await rejectsWith(verifyStage(verifyContext({ fetchStatus: async () => { throw new Error("network"); } }).context, afterPublish()), "VERIFY_READINESS_FAILED");
  await rejectsWith(verifyStage(verifyContext({ fetchJson: async () => ({ releaseSequence: 129, expiresAt: "2026-10-12T00:00:00.000Z" }) }).context, afterPublish()), "VERIFY_MANIFEST_MISMATCH");
  await rejectsWith(verifyStage(verifyContext({ fetchJson: async () => ({ releaseSequence: 130, expiresAt: "2026-10-09T20:00:00.000Z" }) }).context, afterPublish()), "VERIFY_MANIFEST_EXPIRING");
  await rejectsWith(verifyStage(verifyContext({ fetchJson: async () => ({ releaseSequence: 130 }) }).context, afterPublish()), "VERIFY_MANIFEST_MISMATCH");
});

test("롤백: 배포가 성공한 상태에서만 직전 활성 release 입력으로 PREVIEW → DEPLOY를 다시 실행하고 readiness를 확인한다", async () => {
  const world = deployWorld();
  let state = await selectDeployInputsStage(world.context(), afterPublish());
  state = await deployStage(world.context(), state);
  world.dispatches.length = 0;
  const requests = [];
  const context = world.context({
    apiBaseUrl: "https://api.example.invalid", readinessChecks: 3, readinessIntervalMs: 30_000,
    fetchStatus: async (url) => { requests.push(url); return { status: 200 }; },
  });
  const rolledBack = await rollbackStage(context, state);
  assert.deepEqual(world.dispatches.map((d) => d.inputs.mode), ["PREVIEW", "DEPLOY"]);
  for (const dispatched of world.dispatches) {
    const { mode, ...rest } = dispatched.inputs;
    assert.ok(mode);
    assert.deepEqual(rest, state.deploy.previous);
  }
  assert.equal(requests.length, 3);
  assert.equal(rolledBack.rollback.ok, true);

  const never = deployWorld();
  const undeployed = await selectDeployInputsStage(never.context(), afterPublish());
  await rejectsWith(rollbackStage(never.context({ fetchStatus: async () => ({ status: 200 }) }), undeployed), "ROLLBACK_NOT_APPLICABLE");
  assert.equal(never.dispatches.length, 0);
});

test("롤백: 롤백 DEPLOY가 실패하거나 readiness가 돌아오지 않으면 ROLLBACK_FAILED로 드러낸다", async () => {
  const world = deployWorld();
  let state = await selectDeployInputsStage(world.context(), afterPublish());
  state = await deployStage(world.context(), state);
  world.script(`${PLATFORM}|source-free-journey-k3s-deploy.yml|DEPLOY`, (inputs) => ({
    conclusion: "failure",
    display_title: formatDeployRunName("DEPLOY", { backendRunId: inputs.backend_run_id, backendArtifactId: inputs.backend_artifact_id, dataRunId: inputs.data_run_id, dataArtifactId: inputs.data_artifact_id }),
  }));
  await rejectsWith(rollbackStage(world.context({ fetchStatus: async () => ({ status: 200 }) }), state), "ROLLBACK_FAILED");

  const world2 = deployWorld();
  let state2 = await selectDeployInputsStage(world2.context(), afterPublish());
  state2 = await deployStage(world2.context(), state2);
  await rejectsWith(rollbackStage(world2.context({
    apiBaseUrl: "https://api.example.invalid", readinessChecks: 3, readinessIntervalMs: 1000,
    fetchStatus: async () => ({ status: 503 }),
  }), state2), "ROLLBACK_FAILED");
});

// ---------- 리뷰 반영 (data#1084 F2·F4·F5·F7, platform#242 F3) ----------

test("활성 release: 허용 목록 밖 행위자·행위자 불명 run의 제목은 근거로 쓰지 않고, 허용 행위자의 run만 고른다", () => {
  const forged = { backendRunId: "900", backendArtifactId: "901", dataRunId: "902", dataArtifactId: "903" };
  const runs = [
    deployRun(1, formatDeployRunName("DEPLOY", ACTIVE), "success", { created_at: "2026-10-08T00:00:00Z" }),
    deployRun(2, formatDeployRunName("DEPLOY", forged), "success", { created_at: "2026-10-09T00:00:00Z", triggering_actor: { login: "write-collaborator" } }),
    deployRun(3, formatDeployRunName("DEPLOY", forged), "success", { created_at: "2026-10-09T00:01:00Z", triggering_actor: { login: "AquilaXk-evil" } }),
    deployRun(4, formatDeployRunName("DEPLOY", forged), "success", { created_at: "2026-10-09T00:02:00Z", triggering_actor: undefined }),
  ];
  assert.deepEqual(selectActiveRelease(runs), { runId: 1, ...ACTIVE });
  // 수동 bootstrap 배포(저장소 소유자)는 인정한다.
  const manual = deployRun(5, formatDeployRunName("DEPLOY", ACTIVE), "success", { triggering_actor: { login: "AquilaXk" } });
  assert.equal(selectActiveRelease([manual]).runId, 5);
  // 허용 행위자의 run이 하나도 없으면 활성 release를 알 수 없다.
  assert.throws(() => selectActiveRelease(runs.slice(1)), (error) => error instanceof ChainError && error.code === "ACTIVE_RELEASE_UNKNOWN");
  // 허용 행위자의 최신 DEPLOY가 실패했다면, 위조 제목이 성공이어도 불확실로 멈춘다.
  const failedLatest = [deployRun(6, formatDeployRunName("DEPLOY", ACTIVE), "failure", { created_at: "2026-10-09T05:00:00Z" }), runs[1]];
  assert.throws(() => selectActiveRelease(failedLatest), (error) => error instanceof ChainError && error.code === "ACTIVE_RELEASE_UNCERTAIN");
  // 진행 중 run은 행위자와 상관없이 배포 중으로 본다.
  const inFlight = deployRun(7, "PREVIEW backend=1/2 data=3/4", null, { status: "in_progress", triggering_actor: { login: "write-collaborator" } });
  assert.throws(() => selectActiveRelease([runs[0], inFlight]), (error) => error instanceof ChainError && error.code === "DEPLOY_IN_FLIGHT");
});

test("발행: github-actions[bot]이 dispatch한 production-publish run만 인정하고 다른 행위자의 같은 제목 run은 찾지 못한다", async () => {
  assert.equal(DATA_DISPATCH_ACTOR, "github-actions[bot]");
  const { world, publishContext } = publishWorld({ behavior: () => ({ triggering_actor: { login: "write-collaborator" } }) });
  await rejectsWith(publishStage(publishContext(), afterHub()), "RUN_NOT_FOUND");
  assert.equal(world.dispatches.length, 1);
});

test("발행: modeArgs가 후보 run id 또는 승격 run id 중 하나라도 어긋나면 dispatch하지 않는다", async () => {
  for (const [label, override] of [["candidate only wrong", { candidateRunId: "9999" }], ["promotion only wrong", { promotionRunId: "9999" }], ["both wrong", { candidateRunId: "1", promotionRunId: "2" }], ["missing", { candidateRunId: undefined }]]) {
    const { world, publishContext } = publishWorld();
    const base = modeArgsFor({});
    await rejectsWith(publishStage(publishContext({ readModeArgs: async (ids) => ({ ...(await base(ids)), ...override }) }), afterHub()), "CHAIN_STATE_INVALID");
    assert.equal(world.dispatches.length, 0, label);
  }
});

async function planOnce(env, { mainSha = RC_SHA } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "chain-plan-"));
  const statePath = path.join(dir, "state.json");
  const requested = [];
  const gh = { api: async (endpoint) => { requested.push(endpoint); return { object: { sha: mainSha } }; }, dispatch: async () => { throw new Error("plan must not dispatch"); }, cancel: async () => {} };
  const base = { RC_RUN_ID: "7001", RC_RUN_SHA: RC_SHA, GITHUB_SHA: RC_SHA, GH_TOKEN: "t", CHAIN_API_BASE_URL: "https://api.example.invalid", CHAIN_DATAPACK_BASE_URL: "https://packs.example.invalid" };
  return { statePath, requested, run: () => runChainStage({ stage: "plan", statePath, env: { ...base, ...env }, repositoryRoot: process.cwd(), gh }) };
}

test("계획: 검증·롤백에 필요한 공개 URL이 없거나 형식이 틀리면 발행 전에 CHAIN_ENV_INVALID로 멈추고 state를 쓰지 않는다", async () => {
  const ok = await planOnce({});
  assert.equal((await ok.run()).rc.runId, "7001");
  for (const [label, env] of [
    ["api url unset", { CHAIN_API_BASE_URL: undefined }], ["api url empty", { CHAIN_API_BASE_URL: "" }], ["api url malformed", { CHAIN_API_BASE_URL: "http://insecure.example.invalid" }],
    ["datapack url unset", { CHAIN_DATAPACK_BASE_URL: undefined }], ["datapack url empty", { CHAIN_DATAPACK_BASE_URL: "" }], ["datapack url malformed", { CHAIN_DATAPACK_BASE_URL: "not a url" }],
  ]) {
    const planned = await planOnce(env);
    await rejectsWith(planned.run(), "CHAIN_ENV_INVALID");
    await assert.rejects(readFile(planned.statePath, "utf8"), { code: "ENOENT" }, label);
  }
});

test("롤백: 성공해도 공개 manifest 번호와 서버 활성 FINAL이 어긋난 사실을 결과에 남기고 ok만으로 복구 완료처럼 읽히지 않게 한다", async () => {
  const world = deployWorld();
  let state = await selectDeployInputsStage(world.context(), afterPublish());
  state = await deployStage(world.context(), state);
  const rolledBack = await rollbackStage(world.context({ apiBaseUrl: "https://api.example.invalid", readinessChecks: 1, readinessIntervalMs: 1, fetchStatus: async () => ({ status: 200 }) }), state);
  assert.equal(rolledBack.rollback.ok, true);
  assert.deepEqual(rolledBack.rollback.manifestMismatch, {
    publicManifestReleaseSequence: 130,
    restoredDataRunId: state.deploy.previous.data_run_id,
    restoredDataArtifactId: state.deploy.previous.data_artifact_id,
    detail: "공개 manifest는 롤백한 새 release 번호를 가리키고, 서버의 활성 FINAL은 직전 release다. 롤백만으로 복구가 끝나지 않았다.",
  });
});
