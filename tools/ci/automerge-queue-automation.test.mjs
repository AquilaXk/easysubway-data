import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// #985: 코디네이터의 자동화 PR 경로. 코디네이터는 여전히 유일한 병합 주체이고, 자동화 PR은 신뢰 협력자의 Aquila 리뷰 대신
// App(easysubway-release-chain[bot])이 남긴 exact-head 정책 통과 기록(attestation)으로 리뷰 게이트를 통과한다.
// 나머지 게이트(미해결 thread, required context, 병합 상태, --match-head-commit)는 사람 PR과 같다.
const workflowUrl = new URL('../../.github/workflows/automerge-queue.yml', import.meta.url);
const readWorkflow = () => readFile(workflowUrl, 'utf8');
const dedent = (block, width = 10) => block.replace(new RegExp(`^ {${width}}`, 'gm'), '');

const APP = { login: 'easysubway-release-chain[bot]', id: 337648189, type: 'Bot' };
const HEAD = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

function stubbedBash(lines) {
  const dir = mkdtempSync(join(tmpdir(), 'automerge-automation-'));
  const log = join(dir, 'gh.log');
  const result = spawnSync('bash', ['-c', [`GH_LOG=${JSON.stringify(log)}`, ': > "$GH_LOG"', ...lines].join('\n')], { encoding: 'utf8' });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    calls: existsSync(log) ? readFileSync(log, 'utf8') : '',
  };
}

const PAYLOAD = '{"schemaVersion":1,"stage":"registration"}';
const BODY = `자동화 PR\n\n<!-- easysubway-automation-pr:v1 ${PAYLOAD} -->\n`;
const digestOf = (payload) => createHash('sha256').update(payload).digest('hex');
const DIGEST = digestOf(PAYLOAD);
const HEAD_COMMITTED_AT = '2026-10-06T00:00:00Z';
const ATTESTED_AT = '2026-10-06T00:10:00Z';
const attestation = (head = HEAD, user = APP, body, overrides = {}) => ({
  id: 1,
  user,
  body: body ?? `<!-- Automation automerge policy: ${head} evidence ${DIGEST} -->`,
  created_at: ATTESTED_AT,
  updated_at: ATTESTED_AT,
  ...overrides,
});
const review = (id, state, overrides = {}) => ({
  id,
  state,
  submitted_at: `2026-10-06T00:0${id}:00Z`,
  commit_id: HEAD,
  author_association: 'OWNER',
  body: '',
  user: { login: 'reviewer' },
  ...overrides,
});
const marker = (head = HEAD) => ({
  id: 9,
  user: { login: 'github-actions[bot]', id: 41898282, type: 'Bot' },
  body: `<!-- Automerge frozen discovery authorization: ${head} -->`,
});
const aquilaReview = (overrides = {}) =>
  review(1, 'COMMENTED', {
    body: '**Actionable comments posted: 0**\n<!-- Review source: Aquila Universal Review; engine: aquila-review -->',
    ...overrides,
  });

/** 리뷰 게이트 블록(함수 정의 포함)을 1회 루프에 넣어 실제 판정을 실행한다. */
async function runGate({ reviews = [], comments = [], author = APP, enabled = 'true', authorFails = false, prBody = BODY, headCommittedAt = HEAD_COMMITTED_AT, headDateFails = false }) {
  const workflow = await readWorkflow();
  const policy = workflow.match(/# automation-policy-begin\n([\s\S]*?)\n\s+# automation-policy-end/)?.[1];
  const gate = workflow.match(/# review-state-filter-begin\n([\s\S]*?)\n\s+# review-state-filter-end/)?.[0];
  assert.ok(policy, 'automation policy block must stay testable');
  assert.ok(gate, 'review gate must stay testable');
  const result = stubbedBash([
    'set -euo pipefail',
    `AUTOMATION_AUTOMERGE_ENABLED=${enabled}`,
    'gh() {',
    `  printf '%s\\n' "gh $*" >> "$GH_LOG"`,
    '  case "$*" in',
    `    "api repos/o/r/pulls/26 --jq {user, body}") ${authorFails ? 'return 1' : `printf '%s' ${JSON.stringify(JSON.stringify({ user: author, body: prBody }))}`} ;;`,
    `    "api repos/o/r/commits/${HEAD} --jq .commit.committer.date") ${headDateFails ? 'return 1' : `printf '%s' ${JSON.stringify(headCommittedAt)}`} ;;`,
    '    *) return 99 ;;',
    '  esac',
    '}',
    'pr=26',
    'repo=o/r',
    `head=${HEAD}`,
    `reviews=${JSON.stringify(JSON.stringify([reviews]))}`,
    `comments=${JSON.stringify(JSON.stringify([comments]))}`,
    dedent(policy),
    'automation_authorized=false',
    'for _ in 1; do',
    dedent(gate, 12),
    `printf 'PASSED automation=%s\\n' "\${automation_authorized}"`,
    'done',
  ]);
  return {
    passed: result.stdout.includes('PASSED'),
    automation: result.stdout.includes('PASSED automation=true'),
    skipped: result.stdout.includes('skipping'),
    status: result.status,
    calls: result.calls,
    stdout: result.stdout,
  };
}

test('자동화 경로는 저장소 변수 하나로 켜고 끄며 코디네이터는 다른 secret·변수를 늘리지 않는다', async () => {
  const workflow = await readWorkflow();
  assert.ok(workflow.includes("AUTOMATION_AUTOMERGE_ENABLED: ${{ vars.DATAPACK_AUTOMATION_AUTOMERGE == 'true' }}"));
  assert.deepEqual([...new Set([...workflow.matchAll(/vars\.(\w+)/g)].map((match) => match[1]))], ['DATAPACK_AUTOMATION_AUTOMERGE']);
  assert.ok([...workflow.matchAll(/secrets\.(\w+)/g)].every((match) => match[1] === 'AUTOMERGE_PAT'));
  // 코드는 변수를 스스로 켜지 않는다.
  assert.doesNotMatch(workflow, /gh variable|gh api[^\n]*actions\/variables/);
});

test('자동화 정책 판정은 켜져 있고 App 작성 PR에 exact-head App 기록이 있을 때만 통과한다', async () => {
  const passed = await runGate({ comments: [attestation()] });
  assert.equal(passed.passed, true);
  assert.equal(passed.automation, true);
  assert.match(passed.calls, /gh api repos\/o\/r\/pulls\/26 --jq \{user, body\}/);

  // 신뢰 협력자의 COMMENTED·APPROVED 리뷰가 함께 있어도 막지 않는다.
  assert.equal((await runGate({ comments: [attestation()], reviews: [review(1, 'COMMENTED')] })).passed, true);
  assert.equal((await runGate({ comments: [attestation()], reviews: [review(1, 'APPROVED')] })).passed, true);
});

test('반증: 변수가 꺼져 있으면 기록이 있어도 통과하지 못하고 PR 작성자 조회조차 하지 않는다', async () => {
  const off = await runGate({ comments: [attestation()], enabled: 'false' });
  assert.equal(off.passed, false);
  assert.equal(off.skipped, true);
  assert.doesNotMatch(off.calls, /pulls\/26/);
  const unset = await runGate({ comments: [attestation()], enabled: "''" });
  assert.equal(unset.passed, false);
});

test('반증: 기록이 없거나 다른 head의 것이거나 신뢰 App이 쓴 것이 아니면 통과하지 못한다', async () => {
  const forged = {
    none: [],
    'other head': [attestation(OTHER)],
    'human author': [attestation(HEAD, { login: 'AquilaXk', id: 12345, type: 'User' })],
    'github-actions author': [attestation(HEAD, { login: 'github-actions[bot]', id: 41898282, type: 'Bot' })],
    'login only': [attestation(HEAD, { ...APP, id: 1 })],
    'id only': [attestation(HEAD, { ...APP, login: 'someone[bot]' })],
    'wrong type': [attestation(HEAD, { ...APP, type: 'User' })],
    'suffix text': [attestation(HEAD, APP, `<!-- Automation automerge policy: ${HEAD} evidence ${DIGEST} -->\n승인`)],
    'prefix text': [attestation(HEAD, APP, `승인 <!-- Automation automerge policy: ${HEAD} evidence ${DIGEST} -->`)],
    'short sha': [attestation(HEAD, APP, `<!-- Automation automerge policy: ${HEAD.slice(0, 7)} evidence ${DIGEST} -->`)],
    'no digest (old format)': [attestation(HEAD, APP, `<!-- Automation automerge policy: ${HEAD} -->`)],
    'short digest': [attestation(HEAD, APP, `<!-- Automation automerge policy: ${HEAD} evidence ${DIGEST.slice(0, 12)} -->`)],
    'frozen discovery marker only': [marker()],
  };
  for (const [name, comments] of Object.entries(forged)) {
    const result = await runGate({ comments });
    assert.equal(result.passed, false, name);
    assert.equal(result.skipped, true, name);
  }
});

test('반증: PR 작성자가 신뢰 App이 아니거나 작성자를 읽지 못하면 기록이 있어도 통과하지 못한다', async () => {
  for (const author of [
    { login: 'AquilaXk', id: 12345, type: 'User' },
    { ...APP, id: 1 },
    { ...APP, login: 'someone[bot]' },
    { ...APP, type: 'User' },
    { login: 'github-actions[bot]', id: 41898282, type: 'Bot' },
  ]) {
    assert.equal((await runGate({ comments: [attestation()], author })).passed, false, JSON.stringify(author));
  }
  assert.equal((await runGate({ comments: [attestation()], authorFails: true })).passed, false);
});

test('반증: 신뢰 협력자의 CHANGES_REQUESTED가 열려 있으면 자동화 경로도 막는다', async () => {
  const blocked = await runGate({ comments: [attestation()], reviews: [review(1, 'CHANGES_REQUESTED')] });
  assert.equal(blocked.passed, false);
  // 변경 요청 뒤 승인·무시(dismiss)로 풀리면 통과한다. 신뢰 협력자가 아닌 사람의 변경 요청은 게이트가 보지 않는다(기존 게이트와 같다).
  assert.equal((await runGate({ comments: [attestation()], reviews: [review(1, 'CHANGES_REQUESTED'), review(2, 'APPROVED')] })).passed, true);
  assert.equal((await runGate({ comments: [attestation()], reviews: [review(1, 'CHANGES_REQUESTED'), review(2, 'DISMISSED')] })).passed, true);
  assert.equal((await runGate({ comments: [attestation()], reviews: [review(1, 'CHANGES_REQUESTED', { author_association: 'NONE' })] })).passed, true);
});

test('사람 PR 경로는 그대로다: Aquila 리뷰와 exact-head marker가 있으면 자동화 판정을 부르지 않고, 없으면 여전히 막힌다', async () => {
  const human = await runGate({ comments: [marker()], reviews: [aquilaReview()] });
  assert.equal(human.passed, true);
  assert.equal(human.automation, false);
  assert.doesNotMatch(human.calls, /pulls\/26/);

  const noReview = await runGate({ comments: [marker()], reviews: [] });
  assert.equal(noReview.passed, false);
  assert.equal(noReview.skipped, true);
  const noMarker = await runGate({ comments: [], reviews: [aquilaReview()] });
  assert.equal(noMarker.passed, false);
  const changes = await runGate({ comments: [marker()], reviews: [aquilaReview(), review(2, 'CHANGES_REQUESTED')] });
  assert.equal(changes.passed, false);
});

test('자동화 판정 함수는 github.token의 GET 조회만 쓰고 쓰기·병합 토큰을 만지지 않는다', async () => {
  const workflow = await readWorkflow();
  const policy = workflow.match(/# automation-policy-begin\n([\s\S]*?)\n\s+# automation-policy-end/)?.[1];
  assert.ok(policy);
  assert.doesNotMatch(policy, /--method|gh pr |MERGE_GH_TOKEN|gh workflow/);
  assert.equal((policy.match(/\bgh api\b/g) ?? []).length, 2, 'PR author and head commit time are the only reads');
  assert.match(policy, /\[\[ "\$\{AUTOMATION_AUTOMERGE_ENABLED:-\}" == "true" \]\] \|\| return 1/);
  assert.ok(policy.indexOf('AUTOMATION_AUTOMERGE_ENABLED') < policy.indexOf('gh api'), 'the switch is read before any API call');
});

test('리뷰 게이트는 Aquila 판정이 실패했을 때만 자동화 판정을 부르고 통과 여부를 BEHIND 분기에 넘긴다', async () => {
  const workflow = await readWorkflow();
  assert.match(
    workflow,
    /<<<"\$\{reviews\}" >\/dev\/null; then\n\s+if automation_policy_authorized; then\n\s+automation_authorized=true\n[^\n]*\n\s+else\n\s+echo "PR #\$\{pr\}: no trusted frozen discovery review, or an active change request is open; skipping\."\n\s+continue\n\s+fi\n\s+fi\n\s+# review-state-filter-end/,
  );
  // 후보마다 초기화한다. 앞 후보의 통과 여부가 다음 후보로 새면 안 된다.
  const reset = workflow.indexOf('automation_authorized=false');
  assert.ok(reset !== -1 && reset < workflow.indexOf('# review-state-filter-begin'));
  assert.ok(workflow.indexOf('# automation-policy-begin') < workflow.indexOf('# review-state-filter-begin'));
});

test('자동화 PR은 base 갱신(update-branch)을 요청하지 않는다. 사람 작성 병합 커밋이 head 결속을 깨기 때문이다', async () => {
  const workflow = await readWorkflow();
  const dispatch = workflow.match(/# merge-state-dispatch-begin\n([\s\S]*?)\n\s+# merge-state-dispatch-end/)?.[1];
  assert.ok(dispatch);
  const failClosed = workflow.match(/# fail-closed-pr-begin\n([\s\S]*?)\n\s+# fail-closed-pr-end/)?.[1];
  const run = (automationAuthorized) =>
    stubbedBash([
      'set -euo pipefail',
      'HAS_AUTOMERGE_PAT=true',
      'GH_TOKEN=github-token',
      'MERGE_GH_TOKEN=merge-token',
      'base_update_records=[]',
      'record_base_update() { :; }',
      'gh() {',
      `  printf '%s\\n' "gh $*" >> "$GH_LOG"`,
      '}',
      'pr=26',
      'repo=o/r',
      `head=${HEAD}`,
      'merge_state=BEHIND',
      ...(automationAuthorized === undefined ? [] : [`automation_authorized=${automationAuthorized}`]),
      dedent(failClosed),
      'for _ in 1; do',
      dedent(dispatch, 12),
      'done',
      `printf 'SKIPPED\\n' >> "$GH_LOG"`,
    ]);
  const automation = run('true');
  assert.equal(automation.status, 0);
  assert.doesNotMatch(automation.calls, /update-branch/);
  assert.match(automation.calls, /SKIPPED/);
  assert.match(automation.stdout + automation.stderr, /::warning::PR #26 is an automation PR behind main/);
  // 사람 PR은 PAT가 있으면 지금처럼 base를 갱신한다. 변수가 정의되지 않은 경로에서도 깨지지 않는다.
  for (const flag of ['false', undefined]) {
    const human = run(flag);
    assert.equal(human.status, 0);
    assert.match(human.calls, /update-branch/);
  }
});

test('병합 호출은 자동화 경로에서도 --match-head-commit으로 판정한 head에 고정된다', async () => {
  const workflow = await readWorkflow();
  assert.ok(workflow.includes('gh pr merge --squash "${pr}" --repo "${repo}" \\\n                  --match-head-commit "${head}"'));
  assert.equal((workflow.match(/gh pr merge/g) ?? []).length, 1, 'there is exactly one merge call, shared by both paths');
});

// #986 리뷰 F1: App 기록은 편집되지 않았고(updated_at == created_at) head 커밋 이후에 만들어진 것만 인정한다.
test('반증: 편집된 기록은 본문이 맞아도 통과하지 못한다(쓰기 권한자의 기록 재작성)', async () => {
  const edited = attestation(HEAD, APP, undefined, { updated_at: '2026-10-06T00:20:00Z' });
  const result = await runGate({ comments: [edited] });
  assert.equal(result.passed, false);
  assert.equal(result.skipped, true);
  // 편집 시각이 달라진 기록 옆에 편집되지 않은 올바른 기록이 있으면 그것이 인정된다.
  assert.equal((await runGate({ comments: [edited, attestation(HEAD, APP, undefined, { id: 2 })] })).passed, true);
  for (const broken of [{ updated_at: undefined }, { created_at: undefined }, { created_at: 'not a date', updated_at: 'not a date' }]) {
    assert.equal((await runGate({ comments: [attestation(HEAD, APP, undefined, broken)] })).passed, false, JSON.stringify(broken));
  }
});

test('반증: head 커밋보다 먼저 만들어진 기록은 재사용으로 보고 통과하지 못한다', async () => {
  const early = attestation(HEAD, APP, undefined, { created_at: '2026-10-05T23:59:59Z', updated_at: '2026-10-05T23:59:59Z' });
  assert.equal((await runGate({ comments: [early] })).passed, false);
  // head 커밋과 같은 초에 만든 기록은 인정한다(경계).
  const same = attestation(HEAD, APP, undefined, { created_at: HEAD_COMMITTED_AT, updated_at: HEAD_COMMITTED_AT });
  assert.equal((await runGate({ comments: [same] })).passed, true);
  // head 커밋 시각을 읽지 못하면 판정하지 못하므로 통과하지 못한다.
  assert.equal((await runGate({ comments: [attestation()], headDateFails: true })).passed, false);
  assert.equal((await runGate({ comments: [attestation()], headCommittedAt: 'garbage' })).passed, false);
  assert.equal((await runGate({ comments: [attestation()], headCommittedAt: '2026-10-06T00:11:00Z' })).passed, false);
});

// #986 리뷰 F3: 기록은 CI가 본 증거 블록(digest)에 묶인다. 코디네이터는 지금 PR 본문의 블록 digest와 기록의 digest를 대조한다.
test('반증: 기록의 증거 digest가 현재 본문 블록과 다르면 통과하지 못한다(CI·라벨 뒤 본문 편집)', async () => {
  const otherPayload = '{"schemaVersion":1,"stage":"registration","edited":true}';
  const edited = `자동화 PR\n\n<!-- easysubway-automation-pr:v1 ${otherPayload} -->\n`;
  assert.equal((await runGate({ comments: [attestation()], prBody: edited })).passed, false);
  assert.equal((await runGate({ comments: [attestation(HEAD, APP, `<!-- Automation automerge policy: ${HEAD} evidence ${digestOf(otherPayload)} -->`)], prBody: edited })).passed, true);
  // 블록이 없거나 둘 이상이거나 본문이 비어 있으면 digest를 정할 수 없으므로 통과하지 못한다.
  for (const prBody of ['', '블록 없음', `${BODY}${BODY}`, null]) {
    assert.equal((await runGate({ comments: [attestation()], prBody })).passed, false, String(prBody));
  }
  // 블록이 없는 본문에 빈 문자열의 digest를 가진 기록이 있어도 통과하지 못한다.
  assert.equal((await runGate({ comments: [attestation(HEAD, APP, `<!-- Automation automerge policy: ${HEAD} evidence ${digestOf('')} -->`)], prBody: '블록 없음' })).passed, false);
  // 기록 digest가 형식에 맞아도 다른 값이면 막는다.
  assert.equal((await runGate({ comments: [attestation(HEAD, APP, `<!-- Automation automerge policy: ${HEAD} evidence ${'0'.repeat(64)} -->`)] })).passed, false);
});
