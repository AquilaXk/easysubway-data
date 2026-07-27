import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertInventoryMirrorByteParity,
  replaceFileAtomically,
  replaceInventoryMirrors,
  withRouteMapAdmissionFreshness,
} from "./refresh-route-map-admission-freshness.mjs";

const paths = ["canonical.json", "mobile.json"];
const inventory = JSON.stringify({
  sources: [{
    id: "route-map-source",
    routeMapAdmissionEvidence: { capturedAt: "2024-02-29T12:00:00.000Z" },
  }],
});

test("route-map freshness refresh는 mirror 불일치를 parse/write 전에 거부하고 정규화는 멱등이다", () => {
  assert.throws(() => assertInventoryMirrorByteParity([
    { bytes: Buffer.from(inventory) },
    { bytes: Buffer.from(`${inventory}\n`) },
  ]), /source inventory mirrors must be byte-identical before refresh/);
  assert.doesNotThrow(() => assertInventoryMirrorByteParity(paths.map(() => ({ bytes: Buffer.from(inventory) }))));

  const normalized = withRouteMapAdmissionFreshness(JSON.parse(inventory));
  assert.deepEqual(withRouteMapAdmissionFreshness(normalized), normalized);
  assert.equal(normalized.sources[0].routeMapAdmissionEvidence.freshUntil, "2025-03-01T12:00:00.000Z");
});

test("inventory 교체는 임시 파일을 남기지 않고 기존 파일 권한을 보존한다", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "route-map-freshness-"));
  const targetPath = path.join(directory, "inventory.json");
  try {
    await writeFile(targetPath, "before\n", { mode: 0o640 });
    await replaceFileAtomically(targetPath, "after\n");
    assert.equal(await readFile(targetPath, "utf8"), "after\n");
    assert.equal((await stat(targetPath)).mode & 0o777, 0o640);
    assert.deepEqual(await readdir(directory), ["inventory.json"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("두 번째 mirror commit 실패 시 첫 번째 mirror를 원본으로 롤백한다", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "route-map-mirror-rollback-"));
  const targets = ["canonical.json", "mobile.json"].map((name) => ({
    targetPath: path.join(directory, name),
    originalBytes: Buffer.from(`${name}:before\n`),
  }));
  let stagedCount = 0;
  try {
    await Promise.all(targets.map(({ targetPath, originalBytes }) => writeFile(targetPath, originalBytes)));
    await assert.rejects(
      () => replaceInventoryMirrors(targets, "after\n", {
        stageReplacement: async (targetPath, bytes) => {
          stagedCount += 1;
          return {
            targetPath,
            commit: async () => {
              assert.equal(stagedCount, targets.length, "모든 mirror가 commit 전에 staging돼야 한다");
              if (targetPath === targets[1].targetPath) throw new Error("injected second commit failure");
              await writeFile(targetPath, bytes);
            },
            cleanup: async () => {},
          };
        },
      }),
      /injected second commit failure/,
    );
    assert.deepEqual(
      await Promise.all(targets.map(({ targetPath }) => readFile(targetPath))),
      targets.map(({ originalBytes }) => originalBytes),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
