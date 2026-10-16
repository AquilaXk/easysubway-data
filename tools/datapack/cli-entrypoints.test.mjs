import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DATAPACK_DIR = import.meta.dirname;
const REPOSITORY_ROOT = path.resolve(DATAPACK_DIR, "../..");
const CLI_TIMEOUT_MS = 30_000;
const FAILURE_EXIT_CODE = 1;
const USAGE_EXIT_CODE = 2;
const ENTRYPOINT_MARKER = "isMainModule(import.meta.url)";
const REJECTED_FLAG = ["--bogus-arg", "x"];
const REJECTED_POSITIONAL = ["bogus"];
const NO_SUCH_PACK = ["--pack", "no-such-dir/missing-pack.sqlite.gz"];
// 오류 메시지가 스크립트 이름 없이 "invalid arguments"뿐인 CLI는 stderr만으로 스크립트를 구별할 수 없다.
// 이 행들은 exit code와 고정 메시지로 진입점 실행을 증명하고, 스크립트 구별은 행의 script 필드가 맡는다.
const GENERIC_INVALID_ARGUMENTS = /^invalid arguments$/m;

/**
 * isMainModule 판정이 틀리면 CLI가 아무 일도 하지 않고 exit 0으로 끝난다(#1293).
 * 각 행은 인자 검증에서 즉시 실패하는 입력과, 진입점이 실제로 실행됐음을 보이는 stderr 패턴이다.
 * build-server-timetable-snapshot은 알 수 없는 --flag를 받아 repo 기본 경로로 진행하므로 위치 인자로 거부시킨다.
 */
const CLI_ENTRYPOINTS = [
  { script: "activate-current-source-set", args: REJECTED_FLAG, stderr: /unknown activation argument: --bogus-arg/ },
  { script: "build-current-strict-route-regression-report", args: REJECTED_FLAG, stderr: /strict route report argument is invalid/ },
  { script: "build-server-timetable-snapshot", args: REJECTED_POSITIONAL, stderr: /invalid argument: bogus/ },
  { script: "collect-facility-gap-source-evidence", args: REJECTED_FLAG, stderr: /usage: collect-facility-gap-source-evidence\.mjs/ },
  { script: "collect-guri-station-facility-evidence", args: REJECTED_FLAG, stderr: /usage: collect-guri-station-facility-evidence\.mjs/ },
  { script: "collect-korail-metropolitan-timetable-file", args: REJECTED_FLAG, stderr: /KORAIL_METROPOLITAN_TIMETABLE_FILE_ARGUMENTS/ },
  { script: "collect-kric-line4-timetables", args: REJECTED_POSITIONAL, stderr: /unexpected argument: bogus/ },
  { script: "collect-kric-station-timetables", args: REJECTED_FLAG, stderr: /usage: collect-kric-station-timetables\.mjs --output/ },
  { script: "fetch-kasi-public-holiday-calendar", args: REJECTED_FLAG, stderr: /usage: --year YYYY --months M,M --output-directory/ },
  { script: "import-car-door-hints", args: REJECTED_FLAG, stderr: /--roster is required/ },
  { script: "import-transfer-baseline", args: REJECTED_FLAG, stderr: /--roster is required/ },
  { script: "prepare-retained-gwangju-contract", args: REJECTED_FLAG, stderr: /usage: --input <absolute\.json> --output <new-absolute\.json>/ },
  { script: "probe-korail-facility-workbook", args: REJECTED_FLAG, stderr: /usage: probe-korail-facility-workbook\.mjs --output/ },
  { script: "probe-kric-facility-provider-tuples", args: REJECTED_FLAG, stderr: GENERIC_INVALID_ARGUMENTS },
  { script: "publish-incheon-accessibility-raw", args: REJECTED_FLAG, stderr: GENERIC_INVALID_ARGUMENTS },
  { script: "publish-kric-accessibility-raw", args: REJECTED_FLAG, stderr: GENERIC_INVALID_ARGUMENTS },
  { script: "publish-kric-station-timetables-raw", args: REJECTED_FLAG, stderr: /inputPath is required/ },
  { script: "publish-kric-timetable-raw", args: REJECTED_FLAG, stderr: /inputPath is required/ },
  { script: "publish-seoul-accessibility-raw", args: REJECTED_FLAG, stderr: GENERIC_INVALID_ARGUMENTS },
  { script: "publish-seoul-transfer-raw", args: REJECTED_FLAG, stderr: /arguments must be --observation-directory/ },
  { script: "read-kric-retained-file-observations", args: REJECTED_FLAG, stderr: /KRIC_RETAINED_FILE_OBSERVATION_READER_ARGUMENTS/ },
  { script: "register-kric-capital-timetable", args: REJECTED_FLAG, stderr: /usage: register-kric-capital-timetable\.mjs --operation-directory/ },
  { script: "run-current-seoul-accessibility-registration", args: REJECTED_FLAG, stderr: /usage: --observation-name/ },
  { script: "run-korail-route-topology-registration", args: REJECTED_FLAG, stderr: /KORAIL_TOPOLOGY_REGISTRATION_FAILED/ },
  { script: "run-kric-retained-file-operation", args: REJECTED_FLAG, stderr: /KRIC_RETAINED_FILE_OPERATION_ARGUMENTS/ },
  { script: "run-retained-gwangju-timetable-refresh", args: REJECTED_FLAG, stderr: /usage: --operation-root/ },
  { script: "split-station-subnames", args: NO_SUCH_PACK, stderr: /ENOENT[^\n]*missing-pack\.sqlite\.gz/ },
  { script: "validate-timetable-ride-consistency", args: REJECTED_FLAG, stderr: /usage: --reconstruction/, exitCode: USAGE_EXIT_CODE },
];

/** 이미 그 스크립트의 .mjs를 child process로 실행하는 테스트가 있어 표에서 뺀 CLI. 값은 그 실행 테스트 파일이다. */
const ENTRYPOINTS_COVERED_ELSEWHERE = {
  "apply-kric-line4-pilot-schedule": "datapack-tools.test.mjs",
  "build-backend-timetable-seed": "build-backend-timetable-seed.test.mjs",
  "build-nationwide-coverage-tally": "build-nationwide-coverage-tally.test.mjs",
  "import-official-sources": "import-official-sources.test.mjs",
  "report-coverage-gaps": "report-coverage-gaps.test.mjs",
  "validate-datapack": "validate-datapack.datapack-tools.test.mjs",
  "validate-source-inventory": "parse-korail-metropolitan-timetable.test.mjs",
};

async function gitStatus() {
  const { stdout } = await execFileAsync("git", ["-C", REPOSITORY_ROOT, "status", "--porcelain", "--untracked-files=no"]);
  return stdout;
}

async function runRejectedCli(script, args, cwd) {
  try {
    await execFileAsync(process.execPath, [path.join(DATAPACK_DIR, `${script}.mjs`), ...args], {
      cwd,
      env: { PATH: process.env.PATH },
      timeout: CLI_TIMEOUT_MS,
    });
  } catch (error) {
    return error;
  }
  return null;
}

let statusBefore;
before(async () => {
  statusBefore = await gitStatus();
});
after(async () => {
  assert.equal(await gitStatus(), statusBefore, "CLI 실행이 repo의 추적 파일을 바꿨다");
});

for (const { script, args, stderr, exitCode = FAILURE_EXIT_CODE } of CLI_ENTRYPOINTS) {
  test(`${script} 진입점은 잘못된 인자에서 실행 증거를 남기고 비정상 종료한다`, async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "cli-entrypoint-"));
    try {
      const failure = await runRejectedCli(script, args, cwd);
      assert.notEqual(failure, null, "진입점이 실행되지 않아 exit 0으로 끝났다");
      assert.equal(failure.code, exitCode);
      assert.match(failure.stderr, stderr);
      assert.deepEqual(await readdir(cwd), [], "잘못된 인자 검증 전에 파일을 썼다");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
}

test("isMainModule 진입점을 가진 모든 datapack 스크립트는 표 또는 사유가 있는 제외 목록에 있다", async () => {
  const entrypoints = [];
  for (const name of await readdir(DATAPACK_DIR)) {
    if (!name.endsWith(".mjs") || name.endsWith(".test.mjs")) continue;
    if ((await readFile(path.join(DATAPACK_DIR, name), "utf8")).includes(ENTRYPOINT_MARKER)) {
      entrypoints.push(name.slice(0, -".mjs".length));
    }
  }
  const covered = new Set([...CLI_ENTRYPOINTS.map(({ script }) => script), ...Object.keys(ENTRYPOINTS_COVERED_ELSEWHERE)]);
  assert.deepEqual(entrypoints.filter((script) => !covered.has(script)), [], "표에도 제외 목록에도 없는 진입점");
  assert.deepEqual([...covered].filter((script) => !entrypoints.includes(script)), [], "더 이상 진입점이 아닌 표 항목");
  assert.equal(covered.size, CLI_ENTRYPOINTS.length + Object.keys(ENTRYPOINTS_COVERED_ELSEWHERE).length, "표와 제외 목록이 겹친다");
});

test("제외 목록의 테스트 파일은 실제로 그 스크립트를 child process로 실행한다", async () => {
  for (const [script, testFile] of Object.entries(ENTRYPOINTS_COVERED_ELSEWHERE)) {
    const source = await readFile(path.join(DATAPACK_DIR, testFile), "utf8");
    assert.ok(source.includes(`${script}.mjs`), `${testFile}이 ${script}.mjs 경로를 쓰지 않는다`);
    assert.match(source, /execFile|spawn/, `${testFile}에 child process 실행이 없다`);
  }
});
