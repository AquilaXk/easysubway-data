import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const workflow = readFileSync(
  path.join(root, ".github/workflows/public-sensitivity-owner-receipt-caller.yml"),
  "utf8",
);

test("D20 owner receipt caller는 immutable common workflow에 최소 권한과 단일 secret만 위임한다", () => {
  assert.match(workflow, /^on:\n\s+workflow_dispatch:\s*$/m);
  assert.doesNotMatch(workflow, /^\s+(?:push|pull_request|schedule|workflow_call):/m);
  assert.match(workflow, /^permissions:\n\s+contents: read\n\s+actions: read\s*$/m);
  assert.doesNotMatch(workflow, /^\s+(?:id-token|attestations|checks|issues|packages|pull-requests):\s*write\s*$/m);

  const jobs = workflow.match(/^jobs:\n([\s\S]*)$/m)?.[1] ?? "";
  const jobNames = [...jobs.matchAll(/^ {2}([\w-]+):\s*$/gm)].map((match) => match[1]);
  assert.deepEqual(jobNames, ["receipt"]);
  assert.match(
    jobs,
    /^ {2}receipt:\n {4}uses: AquilaXk\/easysubway\/\.github\/workflows\/public-sensitivity-owner-receipt\.yml@3d1590baa98c929ceabd0d2d44414cebcc643c6f$/m,
  );
  assert.doesNotMatch(jobs, /^ {4}(?:runs-on|steps|permissions|with):/m);
  assert.doesNotMatch(jobs, /self-hosted/);
  assert.doesNotMatch(jobs, /secrets:\s*inherit/);
  assert.match(
    jobs,
    /^ {4}secrets:\n {6}D20_SECRET_SCANNING_ALERTS_READ_TOKEN: \$\{\{ secrets\.D20_SECRET_SCANNING_ALERTS_READ_TOKEN \}\}\s*$/m,
  );

  const secretNames = [...jobs.matchAll(/^ {6}([A-Z0-9_]+):/gm)].map((match) => match[1]);
  assert.deepEqual(secretNames, ["D20_SECRET_SCANNING_ALERTS_READ_TOKEN"]);
});
