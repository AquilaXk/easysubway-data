import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { readReplaySourceFile } from "./replay-source-run.mjs";

const CODE = "REPLAY_TEST_INPUT_INVALID";
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const invalid = (name) => new RegExp(`^Error: ${CODE}: ${name} is not a regular file within the size limit$`, "u");

test("재생 원본 파일은 일반 파일이고 크기 상한 안일 때만 읽는다. 없거나 디렉터리거나 링크이거나 상한을 넘으면 이름 있는 코드로 실패한다", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "replay-source-file-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const regular = path.join(directory, "run.json");
  await writeFile(regular, "{\"ok\":true}\n");
  assert.equal((await readReplaySourceFile(regular, CODE)).toString("utf8"), "{\"ok\":true}\n");

  await assert.rejects(readReplaySourceFile(path.join(directory, "missing.json"), CODE), invalid("missing\\.json"));

  await mkdir(path.join(directory, "folder.json"));
  await assert.rejects(readReplaySourceFile(path.join(directory, "folder.json"), CODE), invalid("folder\\.json"));

  await symlink(regular, path.join(directory, "linked.json"));
  await assert.rejects(readReplaySourceFile(path.join(directory, "linked.json"), CODE), invalid("linked\\.json"));

  // 희소 파일이라 디스크를 쓰지 않는다. 상한과 같은 크기는 읽고 1바이트라도 넘으면 읽기 전에 거부한다.
  const atLimit = path.join(directory, "at-limit.bin");
  await writeFile(atLimit, "");
  await truncate(atLimit, MAX_FILE_BYTES);
  assert.equal((await readReplaySourceFile(atLimit, CODE)).length, MAX_FILE_BYTES);
  const overLimit = path.join(directory, "over-limit.bin");
  await writeFile(overLimit, "");
  await truncate(overLimit, MAX_FILE_BYTES + 1);
  await assert.rejects(readReplaySourceFile(overLimit, CODE), invalid("over-limit\\.bin"));
});
