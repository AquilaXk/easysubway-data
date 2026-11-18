import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const scriptPath = "tools/ci/require-workflow-artifact.mjs";
const expectedName = `easysubway-backend-release-${"a".repeat(40)}`;
const expectedRunId = 123456;
const expectedSha = "a".repeat(40);

function artifact(overrides = {}) {
  return {
    id: 789,
    name: expectedName,
    expired: false,
    workflow_run: { id: expectedRunId, head_sha: expectedSha },
    ...overrides,
  };
}

async function invoke(artifacts, totalCount = Array.isArray(artifacts) ? artifacts.length : 0) {
  const dir = await mkdtemp(path.join(tmpdir(), "easysubway-workflow-artifact-"));
  const responsePath = path.join(dir, "response.json");
  await writeFile(responsePath, JSON.stringify({ total_count: totalCount, artifacts }));
  try {
    return await execFileAsync("node", [
      scriptPath,
      responsePath,
      expectedName,
      String(expectedRunId),
      expectedSha,
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("exact run과 SHA의 unexpired artifact 하나만 승인한다", async () => {
  const result = await invoke([artifact()]);

  assert.equal(result.stdout, "validated_artifact_id=789\n");
  assert.equal(result.stderr, "");
});

test("artifact가 없거나 만료된 경우만 unavailable로 구분한다", async () => {
  for (const artifacts of [[], [artifact({ expired: true })]]) {
    await assert.rejects(invoke(artifacts), (error) => {
      assert.equal(error.code, 3);
      assert.match(error.stderr, /required workflow artifact is unavailable/);
      return true;
    });
  }
});

test("artifact evidence가 malformed 또는 모호하면 trust failure로 중단한다", async () => {
  const cases = [
    [null],
    [[artifact()], 2],
    [[artifact({ name: "other" })]],
    [[artifact({ id: "789" })]],
    [[artifact({ workflow_run: { id: 654321, head_sha: expectedSha } })]],
    [[artifact({ workflow_run: { id: expectedRunId, head_sha: "b".repeat(40) } })]],
    [[artifact(), artifact({ id: 790 })]],
  ];

  for (const args of cases) {
    await assert.rejects(invoke(...args), (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /workflow artifacts response is inconsistent/);
      return true;
    });
  }
});
