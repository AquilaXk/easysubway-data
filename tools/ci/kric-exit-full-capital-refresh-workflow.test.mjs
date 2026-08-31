import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const workflowPath = path.join(root, ".github/workflows/kric-exit-full-capital-refresh.yml");

test("EXIT full-capital refresh is main-only, due-only, exact-claim automation with one draft PR", () => {
  assert.ok(existsSync(workflowPath));
  const yml = readFileSync(workflowPath, "utf8");
  assert.match(yml, /cron: "41 \*\/2 \* \* \*"/);
  assert.match(yml, /workflow_dispatch:/);
  assert.match(yml, /github\.ref == 'refs\/heads\/main'/);
  assert.match(yml, /cancel-in-progress: false/);
  assert.match(yml, /contents: write/);
  assert.match(yml, /pull-requests: write/);
  assert.match(yml, /persist-credentials: false/);
  assert.match(yml, /fetch-depth: 0/);
  assert.match(yml, /decide-current-kric-exit-full-capital-refresh\.mjs/);
  assert.match(yml, /RECOVER_CLAIM/);
  assert.match(yml, /automation\/6-kric-exit-full-capital-refresh-\$\{GITHUB_RUN_ID\}/);
  assert.match(yml, /recover-current-live-chain-transfer-observation\.mjs --repository-root "\$\{GITHUB_WORKSPACE\}" --recovery-root "\$\{EXIT_REFRESH_OPERATION_ROOT\}\/transfer"/);
  assert.match(yml, /run-current-capital-live-chain\.mjs[\s\S]*--repository-root "\$\{GITHUB_WORKSPACE\}"[\s\S]*--operation-id "kric-exit-full-capital-refresh-\$\{GITHUB_RUN_ID\}"/);
  assert.doesNotMatch(yml, /--retained-exit-bundle/);
  assert.match(yml, /git commit --allow-empty -m "Claim KRIC EXIT full-capital refresh"/);
  assert.match(yml, /git rev-list --count HEAD\.\."origin\/\$\{branch\}"/);
  assert.match(yml, /git rev-parse "origin\/\$\{branch\}\^\^"/);
  assert.match(yml, /git log -1 --format=%s "origin\/\$\{branch\}"/);
  assert.match(yml, /currentCapitalLiveChainOutputPaths/);
  assert.match(yml, /changed\.length !== 17/);
  assert.match(yml, /git commit -m "Refresh KRIC EXIT full-capital snapshot"/);
  assert.match(yml, /--draft/);
  assert.match(yml, /Refresh KRIC EXIT full-capital snapshot/);
  assert.doesNotMatch(yml, /aws|s3:|fallback|retry|automerge|approval|merge|git push origin main|gh workflow run/i);
});
