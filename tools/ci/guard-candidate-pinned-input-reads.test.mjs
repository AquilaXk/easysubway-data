import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  auditCandidatePinnedInputReads,
  detectDirectPinnedInputReadsInSource,
} from "./guard-candidate-pinned-input-reads.mjs";

const SAMPLE_PINNED_PATHS = [
  "release/product-gates/datapack-freshness-sla.json",
  "tools/datapack/release/capital-production-canonical-pack.json",
  "tools/datapack/release/current-transfer-topology-metrics.json",
  "tools/datapack/release/source-snapshots.json",
  "tools/datapack/source-inventory.json",
];

test("detectDirectPinnedInputReadsInSource distinguishes direct worktree reads from string mentions, temp copies, and candidate-pinned helpers", () => {
  const source = `
    import { readFile, writeFile } from "node:fs/promises";
    import { readFileSync } from "node:fs";
    import path from "node:path";
    import { candidatePinnedReader, candidatePinnedJson } from "./test-fixtures/candidate-pinned-inputs.mjs";

    const root = path.resolve(import.meta.dirname, "../..");
    const PACK_PATH = "tools/datapack/release/capital-production-canonical-pack.json";
    const SNAPSHOTS_PATH = path.join(root, "tools/datapack/release/source-snapshots.json");
    const readRel = (rel) => readFile(new URL(rel, import.meta.url), "utf8");

    export async function sample(tempDir) {
      // 1. Mere string mention and temp directory write/read must NOT be flagged:
      const cliArgs = ["--inventory", "tools/datapack/source-inventory.json"];
      await writeFile(path.join(tempDir, "tools/datapack/source-inventory.json"), "{}");
      await readFile(path.join(tempDir, "tools/datapack/source-inventory.json"), "utf8");

      // 2. Candidate-pinned helper reads must NOT be flagged:
      const readPinned = await candidatePinnedReader();
      await readPinned("release/product-gates/datapack-freshness-sla.json");
      await candidatePinnedJson(readPinned, "release/product-gates/datapack-freshness-sla.json");

      // 3. Direct worktree reads MUST be flagged:
      await readFile("tools/datapack/source-inventory.json", "utf8");
      readFileSync(path.join(root, PACK_PATH), "utf8");
      await readFile(SNAPSHOTS_PATH, "utf8");
      await readRel("./release/current-transfer-topology-metrics.json");
      return cliArgs;
    }
  `;

  const detected = detectDirectPinnedInputReadsInSource({
    testFile: "tools/datapack/sample.test.mjs",
    source,
    pinnedPaths: SAMPLE_PINNED_PATHS,
  });

  assert.deepEqual(detected, [
    "tools/datapack/release/capital-production-canonical-pack.json",
    "tools/datapack/release/current-transfer-topology-metrics.json",
    "tools/datapack/release/source-snapshots.json",
    "tools/datapack/source-inventory.json",
  ]);
});

test("auditCandidatePinnedInputReads rejects unallowlisted direct reads, blank reasons, and stale allowlist entries", (t) => {
  const tmpRoot = realpathSync(mkdtempSync(path.join(os.tmpdir(), "guard-pinned-reads-")));
  t.after(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  mkdirSync(path.join(tmpRoot, "tools/ci"), { recursive: true });
  mkdirSync(path.join(tmpRoot, "tools/datapack/release"), { recursive: true });

  writeFileSync(
    path.join(tmpRoot, "tools/datapack/release/nationwide-candidate-input-manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      artifactKind: "nationwide-candidate-input-manifest",
      files: [
        { path: "tools/datapack/source-inventory.json", sha256: "a".repeat(64), byteSize: 10 },
        { path: "tools/datapack/release/capital-production-canonical-pack.json", sha256: "b".repeat(64), byteSize: 20 },
      ],
    }),
  );

  writeFileSync(
    path.join(tmpRoot, "tools/ci/data-test-ownership.json"),
    JSON.stringify({
      version: 1,
      tests: [
        { path: "tools/datapack/unallowlisted.test.mjs", classes: ["required-pr"] },
        { path: "tools/datapack/blank-reason.test.mjs", classes: ["required-pr"] },
        { path: "tools/datapack/stale-entry.test.mjs", classes: ["required-pr"] },
      ],
    }),
  );

  writeFileSync(
    path.join(tmpRoot, "tools/datapack/unallowlisted.test.mjs"),
    'import { readFile } from "node:fs/promises";\nawait readFile("tools/datapack/source-inventory.json", "utf8");\n',
  );
  writeFileSync(
    path.join(tmpRoot, "tools/datapack/blank-reason.test.mjs"),
    'import { readFile } from "node:fs/promises";\nawait readFile("tools/datapack/release/capital-production-canonical-pack.json", "utf8");\n',
  );
  writeFileSync(
    path.join(tmpRoot, "tools/datapack/stale-entry.test.mjs"),
    'import assert from "node:assert/strict";\nassert.equal("tools/datapack/source-inventory.json".endsWith(".json"), true);\n',
  );

  writeFileSync(
    path.join(tmpRoot, "tools/ci/candidate-pinned-input-read-allowlist.json"),
    JSON.stringify({
      schemaVersion: 1,
      entries: [
        {
          testFile: "tools/datapack/blank-reason.test.mjs",
          paths: ["tools/datapack/release/capital-production-canonical-pack.json"],
          reason: "   ",
        },
        {
          testFile: "tools/datapack/stale-entry.test.mjs",
          paths: ["tools/datapack/source-inventory.json"],
          reason: "더 이상 직접 읽지 않는 오래된 예외 항목",
        },
      ],
    }),
  );

  const violations = auditCandidatePinnedInputReads({ repositoryRoot: tmpRoot });
  assert.equal(
    violations.some((v) => v.code === "UNALLOWLISTED_PINNED_INPUT_READ" && v.testFile === "tools/datapack/unallowlisted.test.mjs"),
    true,
  );
  assert.equal(
    violations.some((v) => v.code === "ALLOWLIST_REASON_REQUIRED" && v.testFile === "tools/datapack/blank-reason.test.mjs"),
    true,
  );
  assert.equal(
    violations.some((v) => v.code === "STALE_ALLOWLIST_PATH" && v.testFile === "tools/datapack/stale-entry.test.mjs"),
    true,
  );
});

test("auditCandidatePinnedInputReads passes on the repository required-pr suite", () => {
  const violations = auditCandidatePinnedInputReads();
  assert.deepEqual(
    violations,
    [],
    `Expected 0 candidate-pinned input direct-read violations, got:\n${JSON.stringify(violations, null, 2)}`,
  );
});
