import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const PINNED_MOBILE_REVISION = "d85742f14cbf97c526a6b94dd55bbf863e1d1346";

async function verifyImmutableMobileRepository(repository, runGit) {
  const stat = await lstat(repository).catch(() => undefined);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("immutable Mobile checkout must be a real directory");
  }
  const inside = await runGit(repository, ["rev-parse", "--is-inside-work-tree"]);
  const revision = await runGit(repository, ["rev-parse", "--verify", `${PINNED_MOBILE_REVISION}^{commit}`]);
  if (inside.trim() !== "true" || revision.trim() !== PINNED_MOBILE_REVISION) {
    throw new Error("immutable Mobile checkout does not contain the expected d857 commit");
  }
  return repository;
}

export async function resolveImmutableMobileRepository({
  repositoryRoot,
  runGit = async (repository, args) => (await execFileAsync("git", ["-C", repository, ...args])).stdout,
} = {}) {
  const root = repositoryRoot ?? path.resolve(import.meta.dirname, "../../..");
  const ciCheckout = path.join(root, ".external", "mobile");
  if (await lstat(ciCheckout).then(() => true).catch(() => false)) {
    return verifyImmutableMobileRepository(ciCheckout, runGit);
  }
  return verifyImmutableMobileRepository(path.resolve(root, "../easysubway-mobile"), runGit);
}
