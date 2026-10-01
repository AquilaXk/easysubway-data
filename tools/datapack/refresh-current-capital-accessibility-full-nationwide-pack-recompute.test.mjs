import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  deriveTransferSourceAdmissionTransitionOutputs,
  recomputeNationwideCanonicalPackBytes,
} from "./refresh-current-capital-accessibility-full.mjs";
import { currentLiveChainTransferOutputPaths } from "./rebind-current-live-chain-transfer-derived-identities.mjs";

// #875 F3: stub 없이 실제 recomputeNationwideCanonicalPackBytes를 커밋된 입력에 돌려, 커밋된 전국 정본 팩과
// 바이트가 같음을 고정한다. 한 바이트만 달라진 팩은 transfer baseline 모드가 거부해야 한다.
const execFileAsync = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, "../..");
const NATIONWIDE_PACK = "tools/datapack/release/nationwide-production-canonical-pack.json";
const DESCRIPTOR = "tools/datapack/sources/seoul-metro-transfer-distance-duration-20260815T094038817Z.json";
const TRANSFER_PATHS = currentLiveChainTransferOutputPaths(DESCRIPTOR, { sourceAdmissionOnly: true });
const ALL_PATHS = currentLiveChainTransferOutputPaths(DESCRIPTOR);

async function git(root, ...args) {
  const { stdout } = await execFileAsync("git", args, { cwd: root, encoding: "utf8" });
  return stdout.trim();
}

async function commit(root, message, files) {
  for (const [relative, value] of Object.entries(files)) {
    const file = path.join(root, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, typeof value === "string" || Buffer.isBuffer(value) ? value : `${JSON.stringify(value)}\n`);
  }
  await git(root, "add", "--", ...Object.keys(files));
  await git(root, "commit", "-q", "-m", message);
  return git(root, "rev-parse", "HEAD");
}

async function repositoryWithPack(t, packBytes) {
  const root = await mkdtemp(path.join(os.tmpdir(), "nationwide-pack-recompute-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await git(root, "init", "-q");
  await git(root, "config", "user.email", "fixture@example.invalid");
  await git(root, "config", "user.name", "fixture");
  const inventory = (marker) => ({ sources: [{ id: "seoul-metro-transfer-distance-duration", marker, transferAdmissionEvidence: { snapshotPath: DESCRIPTOR } }] });
  const baseline = await commit(root, "baseline", {
    ...Object.fromEntries(ALL_PATHS.map((relative) => [relative, `${relative}:v0\n`])),
    "tools/datapack/source-inventory.json": inventory("v0"), [NATIONWIDE_PACK]: "pack:v0\n",
  });
  await commit(root, "transfer rebind", {
    ...Object.fromEntries(TRANSFER_PATHS.filter((relative) => relative !== "tools/datapack/source-inventory.json").map((relative) => [relative, `${relative}:v1\n`])),
    "tools/datapack/source-inventory.json": inventory("v1"),
  });
  await commit(root, "nationwide pack refresh", { [NATIONWIDE_PACK]: packBytes });
  return { root, baseline };
}

// 임시 저장소의 팩을 커밋된 실제 입력(ROOT)에서 다시 계산한 바이트와 비교한다. stub이 아니다.
const recomputeFromCommittedInputs = () => recomputeNationwideCanonicalPackBytes({ repositoryRoot: ROOT });

test("실제 재계산 결과는 커밋된 전국 정본 팩과 바이트가 같다", async () => {
  const committed = await readFile(path.join(ROOT, NATIONWIDE_PACK));
  const recomputed = await recomputeNationwideCanonicalPackBytes();
  assert.ok(Buffer.isBuffer(recomputed));
  assert.ok(recomputed.length > 0);
  assert.ok(recomputed.equals(committed), "committed nationwide canonical pack differs from the recomputed candidate refresh output");
});

test("커밋된 팩과 같은 바이트는 transfer baseline 모드가 받아들이고 한 바이트가 다르면 거부한다", async (t) => {
  const committed = await readFile(path.join(ROOT, NATIONWIDE_PACK));
  const accepted = await repositoryWithPack(t, committed);
  const outputs = await deriveTransferSourceAdmissionTransitionOutputs({ repositoryRoot: accepted.root, baselineGitSha: accepted.baseline, recomputeNationwideCanonicalPack: recomputeFromCommittedInputs });
  assert.deepEqual(outputs.map(({ relative }) => relative), ALL_PATHS);

  const flipped = Buffer.from(committed);
  flipped[Math.floor(flipped.length / 2)] ^= 0x01;
  assert.equal(flipped.length, committed.length);
  const rejected = await repositoryWithPack(t, flipped);
  await assert.rejects(
    deriveTransferSourceAdmissionTransitionOutputs({ repositoryRoot: rejected.root, baselineGitSha: rejected.baseline, recomputeNationwideCanonicalPack: recomputeFromCommittedInputs }),
    /TRANSFER source admission nationwide canonical pack differs from the recomputed candidate refresh output/,
  );
});
