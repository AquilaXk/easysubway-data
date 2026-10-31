import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const workflowUrl = new URL('../../.github/workflows/automerge-queue.yml', import.meta.url);
const readWorkflow = () => readFile(workflowUrl, 'utf8');
const dedent = (block, width = 10) => block.replace(new RegExp(`^ {${width}}`, 'gm'), '');

const APP = { login: 'easysubway-release-chain[bot]', id: 337648189, type: 'Bot' };
const GRAPHQL_APP_AUTHOR = { login: 'app/easysubway-release-chain' };
const HUMAN_AUTHOR = { login: 'contributor', id: 77777, type: 'User' };
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
  user: { login: 'reviewer', type: 'User' },
  ...overrides,
});
const codeRabbitReview = (id = 4, head = HEAD) => ({
  id,
  state: 'COMMENTED',
  submitted_at: `2026-10-06T00:0${id}:00Z`,
  commit_id: head,
  author_association: 'NONE',
  body: '',
  user: { login: 'coderabbitai[bot]', id: 136622811, type: 'Bot' },
});
const marker = (head = HEAD) => ({
  id: 9,
  user: { login: 'github-actions[bot]', id: 41898282, type: 'Bot' },
  body: `<!-- Automerge frozen discovery authorization: ${head} -->`,
});
const interrogateReview = (head = HEAD, overrides = {}) =>
  review(1, 'COMMENTED', {
    commit_id: head,
    body: `<!-- pstack-interrogate head=${head} act-on=0 -->`,
    ...overrides,
  });

async function runGate({
  reviews = [],
  comments = [],
  author = APP,
  infoAuthor = author,
  headRefName = 'automation/datapack-1',
  commitIds = [OTHER, HEAD],
  enabled = 'true',
  authorFails = false,
  prBody = BODY,
  headCommittedAt = HEAD_COMMITTED_AT,
  headDateFails = false,
}) {
  const workflow = await readWorkflow();
  const reviewJqDefs = workflow.match(/(^ +review_jq_defs="\$\(cat <<'JQ'\n[\s\S]*?\n +JQ\n +\)"$)/m)?.[1];
  const isAutomationPrFn = workflow.match(/(^ +is_automation_pr_info\(\) \{\n[\s\S]*?\n +\})/m)?.[1];
  const policy = workflow.match(/# automation-policy-begin\n([\s\S]*?)\n\s+# automation-policy-end/)?.[1];
  const detect = workflow.match(/^ +is_automation_pr="\$\(is_automation_pr_info "\$\{info\}"\)"$/m)?.[0];
  const gate = workflow.match(/# review-state-filter-begin\n([\s\S]*?)\n\s+# review-state-filter-end/)?.[0];
  assert.ok(reviewJqDefs, 'shared review_jq_defs block must stay testable');
  assert.ok(isAutomationPrFn, 'is_automation_pr_info helper must stay testable');
  assert.ok(policy, 'automation policy block must stay testable');
  assert.ok(detect, 'automation PR detection assignment must stay testable');
  assert.ok(gate, 'review gate must stay testable');
  const shellQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
  const result = stubbedBash([
    'set -euo pipefail',
    `AUTOMATION_AUTOMERGE_ENABLED=${enabled}`,
    'gh() {',
    `  printf '%s\\n' "gh $*" >> "$GH_LOG"`,
    '  case "$*" in',
    `    "api repos/o/r/pulls/26 --jq {user, body}") ${authorFails ? 'return 1' : `printf '%s' ${shellQuote(JSON.stringify({ user: author, body: prBody }))}`} ;;`,
    `    "api repos/o/r/commits/${HEAD} --jq .commit.committer.date") ${headDateFails ? 'return 1' : `printf '%s' ${shellQuote(headCommittedAt)}`} ;;`,
    '    *) return 99 ;;',
    '  esac',
    '}',
    'pr=26',
    'repo=o/r',
    `head=${HEAD}`,
    `info=${shellQuote(JSON.stringify({ author: infoAuthor, headRefName }))}`,
    `commit_ids=${shellQuote(JSON.stringify(commitIds))}`,
    `reviews=${shellQuote(JSON.stringify([reviews]))}`,
    `comments=${shellQuote(JSON.stringify([comments]))}`,
    dedent(reviewJqDefs),
    dedent(isAutomationPrFn),
    dedent(policy),
    'automation_authorized=false',
    dedent(detect, 12),
    'for _ in 1; do',
    dedent(gate, 12),
    `printf 'PASSED automation=%s is_automation_pr=%s\\n' "\${automation_authorized}" "\${is_automation_pr}"`,
    'done',
  ]);
  return {
    passed: result.stdout.includes('PASSED'),
    automation: result.stdout.includes('automation=true'),
    isAutomationPr: result.stdout.includes('is_automation_pr=true'),
    skipped: result.stdout.includes('skipping'),
    status: result.status,
    calls: result.calls,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

test('자동화 경로는 저장소 변수 하나로 켜고 끄며 코디네이터는 다른 secret·변수를 늘리지 않는다', async () => {
  const workflow = await readWorkflow();
  assert.ok(workflow.includes("AUTOMATION_AUTOMERGE_ENABLED: ${{ vars.DATAPACK_AUTOMATION_AUTOMERGE == 'true' }}"));
  assert.deepEqual([...new Set([...workflow.matchAll(/vars\.(\w+)/g)].map((match) => match[1]))], ['DATAPACK_AUTOMATION_AUTOMERGE']);
  assert.ok([...workflow.matchAll(/secrets\.(\w+)/g)].every((match) => match[1] === 'AUTOMERGE_PAT'));
  assert.doesNotMatch(workflow, /gh variable|gh api[^\n]*actions\/variables/);
});

test('자동화 정책 판정은 켜져 있고 App 작성 PR에 exact-head App 기록이 있을 때만 통과한다', async () => {
  const passed = await runGate({ comments: [attestation(), marker()] });
  assert.equal(passed.passed, true);
  assert.equal(passed.automation, true);
  assert.equal(passed.isAutomationPr, true);
  assert.match(passed.calls, /gh api repos\/o\/r\/pulls\/26 --jq \{user, body\}/);

  assert.equal((await runGate({ comments: [attestation(), marker()], reviews: [review(1, 'COMMENTED')] })).passed, true);
  assert.equal((await runGate({ comments: [attestation(), marker()], reviews: [review(1, 'APPROVED')] })).passed, true);
  assert.equal((await runGate({ comments: [attestation(), marker()], reviews: [interrogateReview()] })).passed, true);
  assert.equal((await runGate({ comments: [attestation(), marker()], reviews: [codeRabbitReview()] })).passed, true);
});

test('반증: 변수가 꺼져 있으면 사람 리뷰·CodeRabbit·frozen marker가 함께 있어도 자동화 PR은 통과하지 못한다', async () => {
  for (const reviews of [
    [],
    [review(1, 'APPROVED')],
    [interrogateReview()],
    [codeRabbitReview()],
  ]) {
    const off = await runGate({ comments: [attestation(), marker()], reviews, enabled: 'false' });
    assert.equal(off.passed, false);
    assert.equal(off.skipped, true);
    assert.doesNotMatch(off.calls, /pulls\/26/);
  }
  const graphqlAppOff = await runGate({
    comments: [attestation(), marker()],
    reviews: [review(1, 'APPROVED')],
    infoAuthor: GRAPHQL_APP_AUTHOR,
    headRefName: 'custom/release-branch',
    enabled: 'false',
  });
  assert.equal(graphqlAppOff.passed, false);
  const unset = await runGate({ comments: [attestation(), marker()], enabled: "''" });
  assert.equal(unset.passed, false);
});

test('반증: 기록이 없거나 다른 head의 것이거나 신뢰 App이 쓴 것이 아니면 사람 리뷰·CodeRabbit·marker가 있어도 통과하지 못한다', async () => {
  const forged = {
    none: [],
    'other head': [attestation(OTHER), marker()],
    'human author': [attestation(HEAD, { login: 'AquilaXk', id: 12345, type: 'User' }), marker()],
    'github-actions author': [attestation(HEAD, { login: 'github-actions[bot]', id: 41898282, type: 'Bot' }), marker()],
    'login only': [attestation(HEAD, { ...APP, id: 1 }), marker()],
    'id only': [attestation(HEAD, { ...APP, login: 'someone[bot]' }), marker()],
    'wrong type': [attestation(HEAD, { ...APP, type: 'User' }), marker()],
    'suffix text': [attestation(HEAD, APP, `<!-- Automation automerge policy: ${HEAD} evidence ${DIGEST} -->\n승인`), marker()],
    'prefix text': [attestation(HEAD, APP, `승인 <!-- Automation automerge policy: ${HEAD} evidence ${DIGEST} -->`), marker()],
    'short sha': [attestation(HEAD, APP, `<!-- Automation automerge policy: ${HEAD.slice(0, 7)} evidence ${DIGEST} -->`), marker()],
    'no digest (old format)': [attestation(HEAD, APP, `<!-- Automation automerge policy: ${HEAD} -->`), marker()],
    'short digest': [attestation(HEAD, APP, `<!-- Automation automerge policy: ${HEAD} evidence ${DIGEST.slice(0, 12)} -->`), marker()],
    'frozen discovery marker only': [marker()],
  };
  for (const [name, comments] of Object.entries(forged)) {
    for (const reviews of [[], [review(1, 'APPROVED'), interrogateReview(HEAD, { id: 2 }), codeRabbitReview(3)]]) {
      const result = await runGate({ comments, reviews });
      assert.equal(result.passed, false, name);
      assert.equal(result.skipped, true, name);
    }
  }
});

test('반증: PR 작성자가 신뢰 App이 아니거나 작성자를 읽지 못하면 automation 브랜치여도 통과하지 못한다', async () => {
  for (const author of [
    { login: 'AquilaXk', id: 12345, type: 'User' },
    { ...APP, id: 1 },
    { ...APP, login: 'someone[bot]' },
    { ...APP, type: 'User' },
    { login: 'github-actions[bot]', id: 41898282, type: 'Bot' },
  ]) {
    assert.equal(
      (await runGate({ comments: [attestation(), marker()], reviews: [review(1, 'APPROVED')], author })).passed,
      false,
      JSON.stringify(author),
    );
  }
  assert.equal((await runGate({ comments: [attestation(), marker()], reviews: [interrogateReview()], authorFails: true })).passed, false);
});

test('반증: 신뢰 협력자의 CHANGES_REQUESTED 또는 ACT_ON이 열려 있으면 자동화 경로도 막는다', async () => {
  const blocked = await runGate({ comments: [attestation()], reviews: [review(1, 'CHANGES_REQUESTED')] });
  assert.equal(blocked.passed, false);
  assert.equal((await runGate({ comments: [attestation()], reviews: [review(1, 'CHANGES_REQUESTED'), review(2, 'APPROVED')] })).passed, true);
  assert.equal((await runGate({ comments: [attestation()], reviews: [review(1, 'CHANGES_REQUESTED'), review(2, 'DISMISSED')] })).passed, true);
  assert.equal(
    (await runGate({ comments: [attestation()], reviews: [review(1, 'CHANGES_REQUESTED'), interrogateReview(HEAD, { id: 2 })] })).passed,
    true,
  );
  assert.equal((await runGate({ comments: [attestation()], reviews: [review(1, 'CHANGES_REQUESTED', { author_association: 'NONE' })] })).passed, true);

  const actOn = review(1, 'COMMENTED', { body: `<!-- pstack-interrogate head=${HEAD} act-on=1 -->` });
  const unclosed = review(1, 'COMMENTED', { body: `<!-- pstack-interrogate head=${HEAD} act-on=0` });
  assert.equal((await runGate({ comments: [attestation()], reviews: [actOn] })).passed, false);
  assert.equal((await runGate({ comments: [attestation()], reviews: [unclosed] })).passed, false);
  assert.equal((await runGate({ comments: [attestation()], reviews: [actOn, review(2, 'COMMENTED', { body: '일반 코멘트' })] })).passed, false);
  assert.equal(
    (await runGate({ comments: [attestation()], reviews: [actOn, interrogateReview(OTHER, { id: 2 })] })).passed,
    false,
    'older-commit act-on=0 must not clear ACT_ON',
  );
  assert.equal((await runGate({ comments: [attestation()], reviews: [actOn, interrogateReview(HEAD, { id: 2 })] })).passed, true);
  assert.equal((await runGate({ comments: [attestation()], reviews: [actOn, review(2, 'APPROVED')] })).passed, true);
  assert.equal(
    (await runGate({ comments: [attestation()], reviews: [actOn, review(2, 'CHANGES_REQUESTED'), review(3, 'DISMISSED')] })).passed,
    false,
  );
  assert.equal(
    (await runGate({ comments: [attestation()], reviews: [{ ...actOn, author_association: 'NONE' }] })).passed,
    true,
  );
  assert.equal(
    (await runGate({ comments: [attestation()], reviews: [{ ...actOn, user: { login: 'helper[bot]', type: 'Bot' } }] })).passed,
    true,
  );
});

test('사람 PR 경로는 비자동화 브랜치·작성자일 때만 discovery와 exact-head marker로 통과하고 자동화 판정을 부르지 않는다', async () => {
  const humanOpts = { author: HUMAN_AUTHOR, headRefName: 'feat/station-123' };
  const human = await runGate({ ...humanOpts, comments: [marker()], reviews: [interrogateReview()] });
  assert.equal(human.passed, true);
  assert.equal(human.automation, false);
  assert.equal(human.isAutomationPr, false);
  assert.doesNotMatch(human.calls, /pulls\/26/);

  const noReview = await runGate({ ...humanOpts, comments: [marker()], reviews: [] });
  assert.equal(noReview.passed, false);
  assert.equal(noReview.skipped, true);
  assert.doesNotMatch(noReview.calls, /pulls\/26/, 'human PR failure must not probe automation policy');
  const retiredAquila = await runGate({
    ...humanOpts,
    comments: [marker()],
    reviews: [
      review(1, 'COMMENTED', {
        body: '**Actionable comments posted: 0**\n<!-- Review source: Aquila Universal Review; engine: aquila-review -->',
      }),
    ],
  });
  assert.equal(retiredAquila.passed, false);
  assert.equal(retiredAquila.skipped, true);
  const noMarker = await runGate({ ...humanOpts, comments: [], reviews: [interrogateReview()] });
  assert.equal(noMarker.passed, false);
  const priorHeadInterrogate = await runGate({ ...humanOpts, comments: [marker()], reviews: [interrogateReview(OTHER)] });
  assert.equal(priorHeadInterrogate.passed, false);
  const changes = await runGate({ ...humanOpts, comments: [marker()], reviews: [interrogateReview(), review(2, 'CHANGES_REQUESTED')] });
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

test('리뷰 게이트는 자동화 PR을 구조적으로 분리해 사람 discovery 우회를 막고 후보마다 플래그를 초기화한다', async () => {
  const workflow = await readWorkflow();
  assert.match(
    workflow,
    /gh pr view "\$\{pr\}" --repo "\$\{repo\}" \\\n\s+--json baseRefName,author,headRefName,headRefOid,isDraft,labels,mergeStateStatus,state/,
  );
  const gateBlock = workflow.match(/# review-state-filter-begin\n([\s\S]*?)\n\s+# review-state-filter-end/)?.[1];
  assert.ok(gateBlock);
  assert.match(
    gateBlock,
    /if \[\[ "\$\{is_automation_pr:-false\}" == true \]\]; then\n\s+if automation_policy_authorized "\$\{pr\}" "\$\{head\}" "\$\{comments\}" "\$\{commit_ids\}" "\$\{reviews\}"; then/,
  );
  assert.match(gateBlock, /elif ! jq -e /);
  const reset = workflow.indexOf('automation_authorized=false');
  assert.ok(reset !== -1 && reset < workflow.indexOf('# review-state-filter-begin'));
  const syncCall = workflow.indexOf('\n            sync_authorization_marker "${commits}" "${commit_ids}"\n');
  assert.ok(syncCall !== -1 && workflow.indexOf('is_automation_pr="$(is_automation_pr_info "${info}")"') < syncCall);
  assert.ok(workflow.indexOf('# automation-policy-begin') < workflow.indexOf('# review-state-filter-begin'));
});

test('자동화 PR은 사람 리뷰가 있어도 base 갱신(update-branch)을 요청하거나 라벨을 지우지 않는다', async () => {
  const workflow = await readWorkflow();
  const reviewJqDefs = workflow.match(/(^ +review_jq_defs="\$\(cat <<'JQ'\n[\s\S]*?\n +JQ\n +\)"$)/m)?.[1];
  const dispatch = workflow.match(/# merge-state-dispatch-begin\n([\s\S]*?)\n\s+# merge-state-dispatch-end/)?.[1];
  assert.ok(reviewJqDefs && dispatch);
  const failClosed = workflow.match(/# fail-closed-pr-begin\n([\s\S]*?)\n\s+# fail-closed-pr-end/)?.[1];
  const run = ({ automationAuthorized, isAutomationPr } = {}) =>
    stubbedBash([
      'set -euo pipefail',
      'HAS_AUTOMERGE_PAT=true',
      'GH_TOKEN=github-token',
      'MERGE_GH_TOKEN=merge-token',
      'base_update_records=[]',
      `commit_ids=${JSON.stringify(JSON.stringify([HEAD]))}`,
      `reviews=${JSON.stringify(JSON.stringify([[review(1, 'APPROVED')]]))}`,
      'record_base_update() { :; }',
      'gh() {',
      `  printf '%s\\n' "gh $*" >> "$GH_LOG"`,
      '}',
      'pr=26',
      'repo=o/r',
      `head=${HEAD}`,
      'merge_state=BEHIND',
      ...(automationAuthorized === undefined ? [] : [`automation_authorized=${automationAuthorized}`]),
      ...(isAutomationPr === undefined ? [] : [`is_automation_pr=${isAutomationPr}`]),
      dedent(reviewJqDefs),
      dedent(failClosed),
      'for _ in 1; do',
      dedent(dispatch, 12),
      'done',
      `printf 'SKIPPED\\n' >> "$GH_LOG"`,
    ]);
  for (const opts of [
    { automationAuthorized: 'true', isAutomationPr: 'true' },
    { automationAuthorized: 'false', isAutomationPr: 'true' },
    { automationAuthorized: 'true', isAutomationPr: 'false' },
  ]) {
    const automation = run(opts);
    assert.equal(automation.status, 0);
    assert.doesNotMatch(automation.calls, /update-branch|--remove-label automerge/);
    assert.match(automation.calls, /SKIPPED/);
    assert.match(automation.stdout + automation.stderr, /::warning::PR #26 is an automation PR behind main; automation-pr-behind-recreate\.yml closes it/);
  }
  for (const opts of [
    { automationAuthorized: 'false', isAutomationPr: 'false' },
    {},
  ]) {
    const human = run(opts);
    assert.equal(human.status, 0);
    assert.match(human.calls, /update-branch/);
  }
});

test('병합 호출은 자동화 경로에서도 --match-head-commit으로 판정한 head에 고정된다', async () => {
  const workflow = await readWorkflow();
  assert.ok(workflow.includes('gh pr merge --squash "${pr}" --repo "${repo}" \\\n                  --match-head-commit "${head}"'));
  assert.equal((workflow.match(/gh pr merge/g) ?? []).length, 1, 'there is exactly one merge call, shared by both paths');
});

test('반증: 편집된 기록은 본문이 맞아도 통과하지 못한다(쓰기 권한자의 기록 재작성)', async () => {
  const edited = attestation(HEAD, APP, undefined, { updated_at: '2026-10-06T00:20:00Z' });
  const result = await runGate({ comments: [edited, marker()], reviews: [review(1, 'APPROVED')] });
  assert.equal(result.passed, false);
  assert.equal(result.skipped, true);
  assert.equal((await runGate({ comments: [edited, attestation(HEAD, APP, undefined, { id: 2 })] })).passed, true);
  for (const broken of [{ updated_at: undefined }, { created_at: undefined }, { created_at: 'not a date', updated_at: 'not a date' }]) {
    assert.equal((await runGate({ comments: [attestation(HEAD, APP, undefined, broken), marker()] })).passed, false, JSON.stringify(broken));
  }
});

test('반증: head 커밋보다 먼저 만들어진 기록은 재사용으로 보고 통과하지 못한다', async () => {
  const early = attestation(HEAD, APP, undefined, { created_at: '2026-10-05T23:59:59Z', updated_at: '2026-10-05T23:59:59Z' });
  assert.equal((await runGate({ comments: [early, marker()], reviews: [interrogateReview()] })).passed, false);
  const same = attestation(HEAD, APP, undefined, { created_at: HEAD_COMMITTED_AT, updated_at: HEAD_COMMITTED_AT });
  assert.equal((await runGate({ comments: [same] })).passed, true);
  assert.equal((await runGate({ comments: [attestation(), marker()], reviews: [review(1, 'APPROVED')], headDateFails: true })).passed, false);
  assert.equal((await runGate({ comments: [attestation(), marker()], headCommittedAt: 'garbage' })).passed, false);
  assert.equal((await runGate({ comments: [attestation(), marker()], headCommittedAt: '2026-10-06T00:11:00Z' })).passed, false);
});

test('반증: 기록의 증거 digest가 현재 본문 블록과 다르면 사람 리뷰·CodeRabbit·marker가 있어도 통과하지 못한다', async () => {
  const otherPayload = '{"schemaVersion":1,"stage":"registration","edited":true}';
  const edited = `자동화 PR\n\n<!-- easysubway-automation-pr:v1 ${otherPayload} -->\n`;
  for (const reviews of [[], [review(1, 'APPROVED')], [interrogateReview()], [codeRabbitReview()]]) {
    assert.equal((await runGate({ comments: [attestation(), marker()], reviews, prBody: edited })).passed, false);
  }
  assert.equal((await runGate({ comments: [attestation(HEAD, APP, `<!-- Automation automerge policy: ${HEAD} evidence ${digestOf(otherPayload)} -->`), marker()], prBody: edited })).passed, true);
  for (const prBody of ['', '블록 없음', `${BODY}${BODY}`, null]) {
    assert.equal((await runGate({ comments: [attestation(), marker()], reviews: [review(1, 'APPROVED')], prBody })).passed, false, String(prBody));
  }
  assert.equal((await runGate({ comments: [attestation(HEAD, APP, `<!-- Automation automerge policy: ${HEAD} evidence ${digestOf('')} -->`), marker()], prBody: '블록 없음' })).passed, false);
  assert.equal((await runGate({ comments: [attestation(HEAD, APP, `<!-- Automation automerge policy: ${HEAD} evidence ${'0'.repeat(64)} -->`), marker()], reviews: [interrogateReview()] })).passed, false);
});

test('자동화 PR은 사람 리뷰 통과 여부와 무관하게 병합 직전 Automation PR gates check가 github-actions의 성공일 때만 계속한다', async () => {
  const workflow = await readWorkflow();
  const block = workflow.match(/# automation-gates-begin\n([\s\S]*?)\n\s+# automation-gates-end/)?.[1];
  assert.ok(block, 'automation gates recheck must stay testable');
  assert.ok(workflow.indexOf('# required-context-loop-end') < workflow.indexOf('# automation-gates-begin'));
  assert.ok(workflow.indexOf('# automation-gates-end') < workflow.indexOf('# merge-state-dispatch-begin'));
  const run = ({ automationAuthorized, isAutomationPr }, runs) =>
    stubbedBash([
      'set -euo pipefail',
      'pr=26',
      ...(automationAuthorized === undefined ? [] : [`automation_authorized=${automationAuthorized}`]),
      ...(isAutomationPr === undefined ? [] : [`is_automation_pr=${isAutomationPr}`]),
      `checks=${JSON.stringify(JSON.stringify([{ check_runs: runs }]))}`,
      'for _ in 1; do',
      dedent(block, 12),
      `printf 'CONTINUED\\n'`,
      'done',
    ]);
  const gate = (overrides = {}) => ({ id: 2, name: 'Automation PR gates', status: 'completed', conclusion: 'success', started_at: '2026-10-06T00:00:00Z', app: { id: 15368 }, ...overrides });
  const continued = (result) => result.stdout.includes('CONTINUED');
  assert.equal(continued(run({ automationAuthorized: 'true', isAutomationPr: 'true' }, [gate()])), true);
  assert.equal(continued(run({ automationAuthorized: 'false', isAutomationPr: 'true' }, [gate()])), true);
  const retried = [gate({ id: 3, conclusion: 'failure' }), gate({ id: 4, started_at: '2026-10-06T01:00:00Z' })];
  assert.equal(continued(run({ automationAuthorized: 'true', isAutomationPr: 'true' }, retried)), true);
  assert.equal(continued(run({ automationAuthorized: 'true', isAutomationPr: 'true' }, [...retried].reverse())), true);
  for (const [name, runs] of Object.entries({
    none: [],
    failure: [gate({ conclusion: 'failure' })],
    skipped: [gate({ conclusion: 'skipped' })],
    cancelled: [gate({ conclusion: 'cancelled' })],
    neutral: [gate({ conclusion: 'neutral' })],
    pending: [gate({ status: 'in_progress', conclusion: null })],
    'foreign app': [gate({ app: { id: 99999 } })],
    'other name': [gate({ name: 'Data contracts' })],
    'latest failed listed first': [gate({ id: 3, conclusion: 'failure', started_at: '2026-10-06T01:00:00Z' }), gate({ id: 2 })],
    'latest failed listed last': [gate({ id: 2 }), gate({ id: 3, conclusion: 'failure', started_at: '2026-10-06T01:00:00Z' })],
  })) {
    for (const flags of [
      { automationAuthorized: 'true', isAutomationPr: 'true' },
      { automationAuthorized: 'false', isAutomationPr: 'true' },
      { automationAuthorized: 'true', isAutomationPr: 'false' },
    ]) {
      const result = run(flags, runs);
      assert.equal(continued(result), false, `${name} (${JSON.stringify(flags)})`);
      assert.match(result.stdout + result.stderr, /::warning::PR #26: Automation PR gates/, name);
    }
  }
  for (const flags of [{ automationAuthorized: 'false', isAutomationPr: 'false' }, {}]) {
    assert.equal(continued(run(flags, [])), true, JSON.stringify(flags));
  }
});
