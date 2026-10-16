import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DATAPACK_DIR = import.meta.dirname;
const REJECTED_FLAG = ["--bogus-arg", "x"];
const REJECTED_POSITIONAL = ["bogus"];
const NO_SUCH_PACK = ["--pack", "no-such-dir/missing-pack.sqlite.gz"];

/**
 * isMainModule 판정이 틀리면 CLI가 아무 일도 하지 않고 exit 0으로 끝난다(#1293).
 * 각 행은 인자 검증에서 즉시 실패하는 입력과, 진입점이 실제로 실행됐음을 보이는 stderr 패턴이다.
 * 이미 자기 .mjs를 child process로 실행하는 테스트가 있는 스크립트는 표에 두지 않는다.
 */
const CLI_ENTRYPOINTS = [
  { script: "activate-current-source-set", args: REJECTED_FLAG, stderr: /unknown activation argument: --bogus-arg/ },
  { script: "build-current-strict-route-regression-report", args: REJECTED_FLAG, stderr: /strict route report argument is invalid/ },
  { script: "collect-facility-gap-source-evidence", args: REJECTED_FLAG, stderr: /usage: collect-facility-gap-source-evidence\.mjs/ },
  { script: "collect-guri-station-facility-evidence", args: REJECTED_FLAG, stderr: /usage: collect-guri-station-facility-evidence\.mjs/ },
  { script: "collect-kric-line4-timetables", args: REJECTED_POSITIONAL, stderr: /unexpected argument: bogus/ },
  { script: "import-car-door-hints", args: REJECTED_FLAG, stderr: /--roster is required/ },
  { script: "import-transfer-baseline", args: REJECTED_FLAG, stderr: /--roster is required/ },
  { script: "prepare-retained-gwangju-contract", args: REJECTED_FLAG, stderr: /usage: --input <absolute\.json> --output <new-absolute\.json>/ },
  { script: "probe-korail-facility-workbook", args: REJECTED_FLAG, stderr: /usage: probe-korail-facility-workbook\.mjs --output/ },
  { script: "probe-kric-facility-provider-tuples", args: REJECTED_FLAG, stderr: /invalid arguments/ },
  { script: "publish-incheon-accessibility-raw", args: REJECTED_FLAG, stderr: /invalid arguments/ },
  { script: "publish-kric-accessibility-raw", args: REJECTED_FLAG, stderr: /invalid arguments/ },
  { script: "publish-kric-timetable-raw", args: REJECTED_FLAG, stderr: /inputPath is required/ },
  { script: "publish-seoul-accessibility-raw", args: REJECTED_FLAG, stderr: /invalid arguments/ },
  { script: "publish-seoul-transfer-raw", args: REJECTED_FLAG, stderr: /arguments must be --observation-directory/ },
  { script: "read-kric-retained-file-observations", args: REJECTED_FLAG, stderr: /KRIC_RETAINED_FILE_OBSERVATION_READER_ARGUMENTS/ },
  { script: "run-current-seoul-accessibility-registration", args: REJECTED_FLAG, stderr: /usage: --observation-name/ },
  { script: "run-kric-retained-file-operation", args: REJECTED_FLAG, stderr: /KRIC_RETAINED_FILE_OPERATION_ARGUMENTS/ },
  { script: "run-retained-gwangju-timetable-refresh", args: REJECTED_FLAG, stderr: /usage: --operation-root/ },
  { script: "split-station-subnames", args: NO_SUCH_PACK, stderr: /ENOENT[^\n]*missing-pack\.sqlite\.gz/ },
  { script: "validate-timetable-ride-consistency", args: REJECTED_FLAG, stderr: /usage: --reconstruction/ },
];

async function runRejectedCli(script, args, cwd) {
  try {
    await execFileAsync(process.execPath, [path.join(DATAPACK_DIR, `${script}.mjs`), ...args], {
      cwd,
      env: { PATH: process.env.PATH },
      timeout: 30_000,
    });
  } catch (error) {
    return error;
  }
  return null;
}

for (const { script, args, stderr } of CLI_ENTRYPOINTS) {
  test(`${script} 진입점은 잘못된 인자에서 실행 증거를 남기고 비정상 종료한다`, async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "cli-entrypoint-"));
    try {
      const failure = await runRejectedCli(script, args, cwd);
      assert.notEqual(failure, null, "진입점이 실행되지 않아 exit 0으로 끝났다");
      assert.ok(Number.isInteger(failure.code) && failure.code !== 0, `exit code=${failure.code}`);
      assert.match(failure.stderr, stderr);
      assert.deepEqual(await readdir(cwd), [], "잘못된 인자 검증 전에 파일을 썼다");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
}
