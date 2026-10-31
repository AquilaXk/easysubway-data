import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { evaluateGithubExpression } from './github-expression.mjs';
import {
  auditWorkflowJqInvocations,
  extractWorkflowJqPrograms,
  validateJqAsBindings,
} from './lib/automerge-queue-jq-ast.mjs';

const workflowUrl = new URL(
  '../../.github/workflows/automerge-queue.yml',
  import.meta.url,
);
const automationWorkflowUrl = new URL(
  '../../.github/workflows/automation-pr-automerge.yml',
  import.meta.url,
);
const ciWorkflowUrl = new URL('../../.github/workflows/ci.yml', import.meta.url);
const ownershipUrl = new URL('./data-test-ownership.json', import.meta.url);
const producerWorkflowUrl = new URL(
  '../../.github/workflows/datapack-release.yml',
  import.meta.url,
);
const prTemplateUrls = [
  new URL('../../.github/PULL_REQUEST_TEMPLATE/full.md', import.meta.url),
  new URL('../../.github/PULL_REQUEST_TEMPLATE/short.md', import.meta.url),
  new URL('../../.github/pull_request_template.md', import.meta.url),
];

const readWorkflow = () => readFile(workflowUrl, 'utf8');
const MARKER_SYNC_RE =
  /# authorization-marker-sync-begin\n([\s\S]*?)\n\s+# authorization-marker-sync-end/;
const REVIEW_JQ_DEFS_RE =
  /(^ +review_jq_defs="\$\(cat <<'JQ'\n[\s\S]*?\n +JQ\n +\)"$)/m;
const BUDGET_CONSTANTS_RE = /# budget-constants-begin\n([\s\S]*?)\n\s+# budget-constants-end/;

const dedent = (block, width = 10) =>
  block.replace(new RegExp(`^ {${width}}`, 'gm'), '');

const budgetConstantsOf = (workflow) => {
  const block = workflow.match(BUDGET_CONSTANTS_RE)?.[1];
  assert.ok(block, 'budget constants block must stay testable');
  return dedent(block);
};

const reviewJqDefsOf = (workflow) => {
  const block = workflow.match(REVIEW_JQ_DEFS_RE)?.[1];
  assert.ok(block, 'shared review_jq_defs block must stay testable');
  return dedent(block);
};

const reviewJqBodyOf = (workflow) => {
  const defs = reviewJqDefsOf(workflow);
  const body = defs.match(/<<'JQ'\n([\s\S]*?)\n *JQ\b/)?.[1];
  assert.ok(body, 'review_jq_defs heredoc body must stay extractable');
  return body;
};

const stubbedBash = (lines) => {
  const dir = mkdtempSync(join(tmpdir(), 'automerge-queue-'));
  const log = join(dir, 'gh.log');
  const result = spawnSync(
    'bash',
    ['-c', [`GH_LOG=${JSON.stringify(log)}`, ': > "$GH_LOG"', ...lines].join('\n')],
    { encoding: 'utf8' },
  );
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    calls: existsSync(log) ? readFileSync(log, 'utf8') : '',
  };
};

test('코디네이터는 기본 토큰이 github.token이고 AUTOMERGE_PAT는 병합 토큰으로만 참조한다', async () => {
  const workflow = await readWorkflow();

  for (const contract of [
    'GH_TOKEN: ${{ github.token }}',
    'pull_request_target:',
    'pull_request_review:',
    'workflow_run:',
    'workflow_dispatch:',
    'permissions: {}',
    'actions: write',
    'checks: read',
    'statuses: read',
    'contents: write',
    'pull-requests: write',
  ]) {
    assert.ok(workflow.includes(contract), `missing contract: ${contract}`);
  }

  // secrets 참조는 병합 토큰용 AUTOMERGE_PAT 하나뿐이다. 기본 GH_TOKEN은 github.token이다.
  assert.ok(
    [...workflow.matchAll(/secrets\.(\w+)/g)].every((match) => match[1] === 'AUTOMERGE_PAT'),
  );
  // 관리자 우회 병합과 squash 이외의 병합 방식은 사용하지 않는다. main ruleset의
  // allowed_merge_methods도 squash 하나뿐이다.
  assert.doesNotMatch(workflow, /--admin|gh pr merge.+--merge|gh pr merge.+--rebase/);
  // 이 저장소는 allow_auto_merge가 꺼져 있어 `--auto`가 API 오류로 실패한다. 형제 저장소
  // 상수를 옮기듯 이 플래그를 옮기면 큐가 병합 지점에서 매번 죽는다.
  assert.doesNotMatch(workflow, /gh pr merge[^\n]*--auto/);
  assert.ok(workflow.includes('gh pr merge --squash "${pr}" --repo "${repo}"'));
  // 라벨 트리거는 base 저장소 권한으로 도는 pull_request_target이어야 한다.
  assert.ok(workflow.includes("github.event_name != 'pull_request_target'"));
  assert.ok(!workflow.includes('  pull_request:\n'));
  // workflow_run 트리거는 이 저장소의 CI 워크플로 이름과 일치해야 한다. 발행 체인 workflow(data#1084)가 끝나도 큐가 깨어난다.
  assert.ok(workflow.includes('workflows: [CI, "Data Pack Release Candidate Chain", "Data Pack Release Cross-Repository Chain"]'));
});

test('병합 예약과 update-branch만 AUTOMERGE_PAT 병합 토큰을 쓰고 나머지는 github.token을 유지한다', async () => {
  const workflow = await readWorkflow();
  assert.ok(
    workflow.includes(
      "MERGE_GH_TOKEN: ${{ secrets.AUTOMERGE_PAT != '' && secrets.AUTOMERGE_PAT || github.token }}",
    ),
  );
  assert.ok(workflow.includes("HAS_AUTOMERGE_PAT: ${{ secrets.AUTOMERGE_PAT != '' }}"));
  assert.ok(workflow.includes('GH_TOKEN: ${{ github.token }}'));
  assert.match(workflow, /if \[ "\$\{HAS_AUTOMERGE_PAT\}" != "true" \]; then/);
  assert.match(workflow, /::warning::AUTOMERGE_PAT/);

  const prefix = 'GH_TOKEN="${MERGE_GH_TOKEN}" ';
  const lines = workflow.split('\n');
  const mergeLines = lines.filter((line) => /\bgh pr merge --squash\b/.test(line));
  const updateLines = lines.filter(
    (line) => /update-branch/.test(line) && /\bgh (api|pr)\b/.test(line),
  );
  assert.ok(mergeLines.length >= 1, 'merge call not found');
  for (const line of [...mergeLines, ...updateLines]) {
    assert.ok(
      line.includes(prefix + 'gh '),
      'merge/update-branch call must use MERGE_GH_TOKEN: ' + line.trim(),
    );
  }

  // 병합 토큰은 병합·update-branch 호출 외에는 어디에도 쓰지 않는다.
  const prefixed = lines.filter((line) => line.includes(prefix));
  assert.equal(prefixed.length, mergeLines.length + updateLines.length);

  const others = lines.filter(
    (l) => /gh api --method (POST|PATCH)/.test(l) || /--disable-auto/.test(l) || /gh workflow run/.test(l),
  );
  for (const line of others) {
    assert.ok(!line.includes('MERGE_GH_TOKEN'), 'must keep github.token: ' + line.trim());
  }
});

test('automerge label 이벤트만 exact-head authorization marker를 발행한다', async () => {
  const workflow = await readWorkflow();

  for (const contract of [
    "EVENT_NAME: ${{ github.event_name }}",
    "EVENT_PR: ${{ github.event_name == 'pull_request_target' && github.event.pull_request.number || '' }}",
    "EVENT_HEAD: ${{ github.event_name == 'pull_request_target' && github.event.pull_request.head.sha || '' }}",
    "if: ${{ !cancelled() && (github.event_name != 'schedule' || needs.queue-probe.outputs.labeled == 'true') && (github.event_name != 'pull_request_target' || github.event.label.name == 'automerge') }}",
    'pull_request_target:\n    types: [labeled]',
  ]) {
    assert.ok(workflow.includes(contract), `missing label authorization contract: ${contract}`);
  }

  const authorizationBlock = workflow.match(
    /          if \[\[ "\$\{EVENT_NAME\}" == "pull_request_target" \]\]; then\n([\s\S]*?)\n          fi\n\n          # required context/,
  )?.[0];
  assert.ok(authorizationBlock, 'label authorization block must stay testable');
  assert.equal(
    (authorizationBlock.match(/gh api --method POST/g) ?? []).length,
    1,
    'label authorization must have exactly one marker emission path',
  );

  // 라벨 이벤트는 기존 canonical marker를 읽어 PATCH-or-POST로 수렴한다. 픽스처는 comment 페이지다.
  const runAuthorization = ({ eventName, pr, head, pages = [[]] }) => {
    const dir = mkdtempSync(join(tmpdir(), 'automerge-authorization-'));
    const log = join(dir, 'gh.log');
    pages.forEach((page, index) =>
      writeFileSync(join(dir, `page-${index + 1}.json`), page === '__FAIL__' ? page : JSON.stringify(page)),
    );
    const result = spawnSync(
      'bash',
      [
        '-c',
        [
          'set -euo pipefail',
          `GH_LOG=${JSON.stringify(log)}`,
          `FIX=${JSON.stringify(dir)}`,
          ': > "$GH_LOG"',
          'gh() {',
          '  printf "%s\\n" "gh $*" >> "$GH_LOG"',
          '  case "$*" in',
          '    *"/comments?per_page=100&page="*) all="$*"; page="${all##*page=}"; [[ -f "$FIX/page-$page.json" ]] || { printf "[]\\n"; return 0; }; [[ "$(cat "$FIX/page-$page.json")" == __FAIL__ ]] && return 1; cat "$FIX/page-$page.json" ;;',
          '  esac',
          '}',
          'repo=o/r',
          `EVENT_NAME=${JSON.stringify(eventName)}`,
          `EVENT_PR=${JSON.stringify(pr)}`,
          `EVENT_HEAD=${JSON.stringify(head)}`,
          dedent(authorizationBlock),
        ].join('\n'),
      ],
      { encoding: 'utf8' },
    );
    return {
      status: result.status,
      calls: existsSync(log) ? readFileSync(log, 'utf8') : '',
    };
  };

  const nonLabelEvent = runAuthorization({
    eventName: 'workflow_run',
    pr: '',
    head: '',
  });
  assert.equal(nonLabelEvent.status, 0);
  assert.equal((nonLabelEvent.calls.match(/gh api --method POST/g) ?? []).length, 0);

  const valid = runAuthorization({
    eventName: 'pull_request_target',
    pr: '42',
    head: 'a'.repeat(40),
  });
  assert.equal(valid.status, 0);
  assert.equal((valid.calls.match(/gh api --method POST/g) ?? []).length, 1);
  assert.match(
    valid.calls,
    /repos\/o\/r\/issues\/42\/comments -f body=<!-- Automerge frozen discovery authorization: a{40} -->/,
  );

  for (const invalid of [
    { pr: 'not-a-number', head: 'a'.repeat(40) },
    { pr: '42', head: 'A'.repeat(40) },
    { pr: '42', head: 'a'.repeat(39) },
  ]) {
    const rejected = runAuthorization({ eventName: 'pull_request_target', ...invalid });
    assert.notEqual(rejected.status, 0);
    assert.equal((rejected.calls.match(/gh api --method POST/g) ?? []).length, 0);
  }

  // PATCH-or-POST 수렴: canonical marker는 PR당 1개로 유지한다(backend·mobile과 동일).
  const bot = { login: 'github-actions[bot]', id: 41898282, type: 'Bot' };
  const markerOf = (sha) => `<!-- Automerge frozen discovery authorization: ${sha} -->`;
  const mutations = (calls) => calls.split('\n').filter((line) => /--method (PATCH|POST)/.test(line));
  const relabeled = runAuthorization({
    eventName: 'pull_request_target', pr: '42', head: 'a'.repeat(40),
    pages: [[{ id: 7, body: markerOf('b'.repeat(40)), user: bot }]],
  });
  assert.equal(relabeled.status, 0);
  assert.deepEqual(mutations(relabeled.calls), [
    `gh api --method PATCH repos/o/r/issues/comments/7 -f body=${markerOf('a'.repeat(40))}`,
  ], 'relabel must PATCH the single canonical marker instead of posting another');
  // 이미 여러 개 쌓인 PR은 라벨 재부착으로 정리한다: 가장 오래된 하나를 새 head로, 나머지는
  // canonical이 아닌 superseded 본문으로 바꾼다. 삭제하지 않는다.
  const accumulated = runAuthorization({
    eventName: 'pull_request_target', pr: '42', head: 'a'.repeat(40),
    pages: [[{ id: 9, body: markerOf('c'.repeat(40)), user: bot }, { id: 7, body: markerOf('b'.repeat(40)), user: bot }]],
  });
  assert.equal(accumulated.status, 0);
  assert.deepEqual(mutations(accumulated.calls), [
    `gh api --method PATCH repos/o/r/issues/comments/7 -f body=${markerOf('a'.repeat(40))}`,
    'gh api --method PATCH repos/o/r/issues/comments/9 -f body=<!-- Automerge frozen discovery authorization superseded -->',
  ]);
  assert.doesNotMatch(accumulated.calls, /--method DELETE/);
  const spoofed = runAuthorization({
    eventName: 'pull_request_target', pr: '42', head: 'a'.repeat(40),
    pages: [[{ id: 7, body: markerOf('b'.repeat(40)), user: { ...bot, id: 1 } }]],
  });
  assert.equal(spoofed.status, 0);
  assert.deepEqual(mutations(spoofed.calls), [
    `gh api --method POST repos/o/r/issues/42/comments -f body=${markerOf('a'.repeat(40))}`,
  ], 'a spoofed marker is not canonical');
  const full = (id) => Array.from({ length: 100 }, (_, index) => ({ id: id * 1000 + index, body: 'x', user: { login: 'someone', id: 5, type: 'User' } }));
  for (const [label, pages] of [
    ['comment read failure', ['__FAIL__']],
    ['malformed comment page', [{ message: 'Not Found' }]],
    ['comment history beyond the bounded read', [full(1), full(2), full(3), [{ id: 1, body: 'x', user: bot }]]],
  ]) {
    const failed = runAuthorization({ eventName: 'pull_request_target', pr: '42', head: 'a'.repeat(40), pages });
    assert.notEqual(failed.status, 0, `${label} must fail the label authorization`);
    assert.deepEqual(mutations(failed.calls), [], `${label} must not mutate markers`);
  }
  const bounded = runAuthorization({ eventName: 'pull_request_target', pr: '42', head: 'a'.repeat(40), pages: [full(1), full(2), full(3), []] });
  assert.equal(bounded.status, 0, bounded.stderr);
  assert.equal(mutations(bounded.calls).length, 1);
});

test('큐는 best-effort FIFO 후보 배열을 훑고 미해결 thread는 fail closed다', async () => {
  const workflow = await readWorkflow();

  for (const contract of [
    '--base main --state open --label automerge',
    '--limit 1000',
    '.isDraft == false',
    // draft는 선택 단계에서 걸러야 한다. `gh pr list`는 draft를 필터하지 않으므로
    // 큐 맨 앞의 draft 하나가 매 실행을 실패시켜 큐 전체를 멈춘다.
    '--json number,createdAt,isDraft',
    // 후보는 단일 값이 아니라 오래된 순 배열이다. head 하나만 보는 구조가
    // head-of-line blocking의 원인이었다.
    '[.[] | select(.isDraft == false)] | [sort_by(.createdAt)[].number]',
    '# queue-loop-begin',
    '# candidate-budget-begin',
    '# candidate-offset-begin',
    '# candidate-window-begin',
    'reviewThreads(first: 100)',
    'hasNextPage',
    'pageInfo.hasNextPage == false',
    'all(.data.repository.pullRequest.reviewThreads.nodes[]; .isResolved)',
    '--match-head-commit "${head}"',
  ]) {
    assert.ok(workflow.includes(contract), `missing contract: ${contract}`);
  }

  // 단일 head 구조의 잔재가 남으면 배열을 뽑아도 첫 후보에서 실행이 끝난다.
  assert.doesNotMatch(workflow, /sort_by\(\.createdAt\)\[0\]\.number \/\/ empty/);
  assert.doesNotMatch(workflow, /\[\[ -n "\$\{pr\}" \]\] \|\| exit 0/);
});

test('required context는 ruleset 전수 조회로만 판정한다', async () => {
  const workflow = await readWorkflow();

  for (const contract of [
    '/rules/branches/main',
    'required_status_checks',
    'integration_id',
    "jq -e 'length > 0' <<<\"${required}\"",
  ]) {
    assert.ok(workflow.includes(contract), `missing contract: ${contract}`);
  }

  // 하드코딩 폴백은 ruleset 변경·조회 실패를 통과시킨다. 조회 실패는 fail closed여야 한다.
  assert.doesNotMatch(workflow, /required_checks='\[/);
  assert.doesNotMatch(workflow, /"Data contracts"\]/);
});

test('REST 목록 조회는 페이지 상한 안에서 읽고 넘치면 판정을 포기한다', async () => {
  const workflow = await readWorkflow();

  // `--paginate`는 페이지 수에 상한이 없어 이력이 긴 후보 하나가 예산 모델을 넘긴다.
  const codeLines = workflow.split('\n').filter((line) => !/^\s*#/.test(line));
  assert.ok(
    !codeLines.some((line) => line.includes('--paginate')),
    'unbounded --paginate must not come back',
  );
  for (const contract of [
    'page_limit=3',
    'read_pages() {',
    'read_pages "repos/${repo}/pulls/${pr}/reviews"',
    'read_pages "repos/${repo}/pulls/${pr}/commits"',
    'read_pages "repos/${repo}/issues/${pr}/comments"',
    'read_pages "repos/${repo}/commits/${head}/check-runs"',
    'read_pages "repos/${repo}/commits/${head}/statuses"',
  ]) {
    assert.ok(workflow.includes(contract), `missing contract: ${contract}`);
  }
  // `/status`는 조합 결과를 단일 객체로 주고 페이지네이션되지 않는다. `/statuses`여야 한다.
  assert.doesNotMatch(workflow, /\/commits\/\$\{head\}\/status"/);
  assert.ok(workflow.includes('($statuses | flatten) as $status_records'));

  // 헬퍼를 그대로 돌려 페이지 수집과 상한 동작을 실측한다.
  const readPages = workflow.match(
    /# paginated-read-begin\n([\s\S]*?)\n\s+# paginated-read-end/,
  )?.[1];
  assert.ok(readPages, 'paginated read helper must stay testable');

  const runReadPages = (pages, { shape = 'array' } = {}) => {
    const dir = mkdtempSync(join(tmpdir(), 'read-pages-'));
    pages.forEach((page, index) => {
      writeFileSync(
        join(dir, `page-${index + 1}.json`),
        JSON.stringify(shape === 'array' ? page : { check_runs: page }),
      );
    });
    const result = stubbedBash([
      'set -euo pipefail',
      `DIR=${JSON.stringify(dir)}`,
      'gh() {',
      `  printf '%s\\n' "gh $*" >> "$GH_LOG"`,
      '  local all="$*"',
      '  local page="${all##*page=}"',
      '  cat "$DIR/page-${page}.json" 2>/dev/null || printf "[]"',
      '}',
      budgetConstantsOf(workflow),
      dedent(readPages),
      'if out="$(read_pages "repos/o/r/pulls/1/reviews")"; then',
      `  printf 'OK %s\\n' "$out"`,
      'else',
      `  printf 'STOPPED %s\\n' "$?"`,
      'fi',
    ]);
    return {
      status: result.status,
      stdout: result.stdout.trim(),
      requests: (result.calls.match(/gh api/g) ?? []).length,
    };
  };

  const full = (count) => Array.from({ length: count }, (_, index) => ({ id: index }));

  // 한 페이지로 끝나면 한 번만 부른다.
  const single = runReadPages([full(3)]);
  assert.equal(single.status, 0);
  assert.equal(single.requests, 1);
  assert.match(single.stdout, /^OK \[\[/);
  // 100건이 꽉 차면 다음 페이지를 읽고, 덜 찬 페이지에서 멈춘다.
  const twoPages = runReadPages([full(100), full(2)]);
  assert.equal(twoPages.requests, 2);
  assert.match(twoPages.stdout, /^OK /);
  // 상한을 넘기면 판정을 포기한다. 모르는 이력 위에서 병합하지 않는다(fail closed).
  const overflow = runReadPages([full(100), full(100), full(100), full(1)]);
  assert.equal(overflow.requests, 3, '페이지 상한을 넘겨 요청하면 예산 모델이 무너진다');
  assert.match(overflow.stdout, /^STOPPED 2/);
  // check-runs는 객체 모양이라 length 계산이 다르다. 같은 상한이 적용돼야 한다.
  const objectShape = runReadPages([full(100), full(100), full(100), full(1)], {
    shape: 'object',
  });
  assert.equal(objectShape.requests, 3);
  assert.match(objectShape.stdout, /^STOPPED 2/);
});

test('리뷰 게이트는 전 커밋의 활성 상태와 exact-head authorization marker가 있는 frozen discovery를 함께 요구한다', async () => {
  const workflow = await readWorkflow();
  assert.doesNotMatch(workflow, /Aquila Universal Review|Aquila fallback|aquila-review/);

  const reviewJqBody = reviewJqBodyOf(workflow);
  const reviewSuffix = workflow.match(
    /# review-state-filter-begin\n[\s\S]*?elif ! jq -e --arg head "\$\{head\}" --argjson comments "\$\{comments\}" --argjson commit_ids "\$\{commit_ids\}" "\$\{review_jq_defs\}"'\n([\s\S]*?)\n\s+' <<<"\$\{reviews\}" >\/dev\/null; then/,
  )?.[1];
  assert.ok(reviewSuffix, 'review state jq program must stay testable');
  const reviewProgram = `${reviewJqBody}\n${reviewSuffix}`;

  const HEAD = 'a'.repeat(40);
  const PREVIOUS_HEAD = 'b'.repeat(40);
  const DIFFERENT_HEAD = 'c'.repeat(40);
  const interrogateMarker = (sha = HEAD, actOn = '0') =>
    `<!-- pstack-interrogate head=${sha} act-on=${actOn} -->`;
  const interrogateBody = (sha = HEAD, actOn = '0') =>
    `## Verdict\n\nNo blocking findings.\n\n${interrogateMarker(sha, actOn)}`;
  const retiredFallbackBody =
    '**Actionable comments posted: 0**\n<!-- Review source: Aquila fallback; canonical visible structure: PR #1926 Review 4676157515 -->';
  const retiredUniversalBody =
    '**Actionable comments posted: 0**\n<!-- Review source: Aquila Universal Review; engine: aquila-review -->';
  const retiredCodexBody =
    '**Actionable comments posted: 0**\n<!-- Review source: Codex CLI fallback; canonical visible structure: PR #1926 Review 4676157515 -->';
  const review = (id, state, submittedAt, body = '', overrides = {}) => ({
    id,
    state,
    submitted_at: submittedAt,
    commit_id: HEAD,
    author_association: 'OWNER',
    body,
    user: { login: 'reviewer', type: 'User' },
    ...overrides,
  });
  const marker = (sha = HEAD, overrides = {}) => ({
    body: `<!-- Automerge frozen discovery authorization: ${sha} -->`,
    user: { login: 'github-actions[bot]', id: 41898282, type: 'Bot' },
    ...overrides,
  });
  const runReviewFilter = (
    reviews,
    comments = [marker()],
    headArg = HEAD,
    commitIds = [PREVIOUS_HEAD, HEAD],
  ) => {
    const result = spawnSync(
      'jq',
      [
        '-e',
        '--arg', 'head', headArg,
        '--argjson', 'comments', JSON.stringify(comments),
        '--argjson', 'commit_ids', JSON.stringify(commitIds),
        reviewProgram,
      ],
      {
        input: JSON.stringify([reviews]),
        encoding: 'utf8',
      },
    );
    assert.ok(
      result.status === 0 || result.status === 1,
      `jq 하네스 파손 (status ${result.status}): ${result.stderr}`,
    );
    return result.status;
  };

  const exactMarker = [marker()];

  assert.notEqual(
    runReviewFilter([
      review(1, 'APPROVED', '2026-08-01T00:00:00Z', '', { commit_id: PREVIOUS_HEAD }),
    ], []),
    0,
  );
  assert.notEqual(
    runReviewFilter([
      review(1, 'APPROVED', '2026-08-01T00:00:00Z', '', { commit_id: PREVIOUS_HEAD }),
    ], [marker(DIFFERENT_HEAD)]),
    0,
  );
  for (const spoof of [
    marker(HEAD, { user: { login: 'other[bot]', id: 41898282, type: 'Bot' } }),
    marker(HEAD, { user: { login: 'github-actions[bot]', id: 1, type: 'Bot' } }),
    marker(HEAD, { user: { login: 'github-actions[bot]', id: 41898282, type: 'User' } }),
  ]) {
    assert.notEqual(
      runReviewFilter([
        review(1, 'APPROVED', '2026-08-01T00:00:00Z', '', { commit_id: PREVIOUS_HEAD }),
      ], [spoof]),
      0,
    );
  }
  assert.notEqual(
    runReviewFilter(
      [review(1, 'APPROVED', '2026-08-01T00:00:00Z')],
      [marker(HEAD), marker(PREVIOUS_HEAD)],
    ),
    0,
    'conflicting duplicate canonical markers must fail closed',
  );
  assert.notEqual(
    runReviewFilter(
      [review(1, 'APPROVED', '2026-08-01T00:00:00Z')],
      [marker(HEAD), marker(HEAD)],
    ),
    0,
    'duplicate canonical markers must fail closed until relabeled',
  );
  assert.equal(
    runReviewFilter(
      [review(1, 'APPROVED', '2026-08-01T00:00:00Z')],
      [
        marker(HEAD),
        {
          body: '<!-- Automerge frozen discovery authorization superseded -->',
          user: { login: 'github-actions[bot]', id: 41898282, type: 'Bot' },
        },
        {
          body: `<!-- Automerge base update requested: ${PREVIOUS_HEAD} -->`,
          user: { login: 'github-actions[bot]', id: 41898282, type: 'Bot' },
        },
      ],
    ),
    0,
    'superseded marker and base-update record must not collide with the single canonical marker',
  );

  assert.equal(
    runReviewFilter([
      review(1, 'CHANGES_REQUESTED', '2026-08-01T00:00:00Z'),
      review(2, 'APPROVED', '2026-08-01T00:01:00Z'),
    ], exactMarker),
    0,
  );
  assert.notEqual(
    runReviewFilter([
      review(1, 'CHANGES_REQUESTED', '2026-08-01T00:00:00Z'),
      review(2, 'COMMENTED', '2026-08-01T00:01:00Z'),
    ], exactMarker),
    0,
  );
  assert.equal(
    runReviewFilter([
      review(1, 'CHANGES_REQUESTED', '2026-08-01T00:00:00Z'),
      review(2, 'COMMENTED', '2026-08-01T00:01:00Z', interrogateBody()),
    ], exactMarker),
    0,
    'valid current-head pstack-interrogate act-on=0 must clear that reviewer prior CHANGES_REQUESTED',
  );
  assert.notEqual(
    runReviewFilter([
      review(1, 'CHANGES_REQUESTED', '2026-08-01T00:00:00Z'),
      review(2, 'COMMENTED', '2026-08-01T00:01:00Z', interrogateBody(PREVIOUS_HEAD, '0'), {
        commit_id: PREVIOUS_HEAD,
      }),
      review(3, 'APPROVED', '2026-08-01T00:02:00Z', '', {
        user: { login: 'reviewer-two', type: 'User' },
      }),
    ], exactMarker),
    0,
    'older-commit pstack-interrogate act-on=0 must not clear that reviewer prior CHANGES_REQUESTED',
  );
  assert.notEqual(
    runReviewFilter([
      review(1, 'CHANGES_REQUESTED', '2026-08-01T00:00:00Z'),
      review(2, 'APPROVED', '2026-08-01T00:01:00Z', '', { commit_id: PREVIOUS_HEAD }),
      review(3, 'COMMENTED', '2026-08-01T00:02:00Z', interrogateBody(), {
        user: { login: 'reviewer-two', type: 'User' },
      }),
    ], exactMarker),
    0,
    'older-commit APPROVED must not clear newer-commit CHANGES_REQUESTED by same reviewer',
  );
  assert.equal(
    runReviewFilter([
      review(1, 'CHANGES_REQUESTED', '2026-08-01T00:00:00Z', 'pre-rebase cr', { commit_id: DIFFERENT_HEAD }),
      review(2, 'COMMENTED', '2026-08-01T00:01:00Z', interrogateBody('6'.repeat(40), '0'), {
        commit_id: '6'.repeat(40),
      }),
      review(3, 'COMMENTED', '2026-08-01T00:02:00Z', interrogateBody(), {
        user: { login: 'reviewer-two', type: 'User' },
      }),
    ], exactMarker),
    0,
    'pre-rebase pstack-interrogate act-on=0 must clear pre-rebase CHANGES_REQUESTED by same reviewer',
  );
  for (const [label, body] of [
    ['inline unclosed <!-- before act-on=0', `See \`<!--\` note.\n\n${interrogateMarker()}`],
    ['fenced unclosed <!-- before act-on=0', `\`\`\`sh\nm="<!-- "\n\`\`\`\n\n${interrogateMarker()}`],
    ['HTML comment holding triple backticks before act-on=0', `<!-- \`\`\` -->\n\n${interrogateMarker()}`],
    ['closed backslash span before decoy inline span', `\`\\\` and \`${interrogateMarker(PREVIOUS_HEAD, '2')}\`\n\n${interrogateMarker()}`],
  ]) {
    assert.equal(
      runReviewFilter([review(1, 'COMMENTED', '2026-08-01T00:00:00Z', body)], exactMarker),
      0,
      label,
    );
  }

  for (const association of ['OWNER', 'MEMBER', 'COLLABORATOR']) {
    assert.equal(
      runReviewFilter([
        review(1, 'COMMENTED', '2026-08-01T00:00:00Z', interrogateMarker(), {
          author_association: association,
        }),
      ], exactMarker),
      0,
      `trusted ${association} standalone pstack-interrogate act-on=0 marker`,
    );
    assert.equal(
      runReviewFilter([
        review(1, 'COMMENTED', '2026-08-01T00:00:00Z', interrogateBody(), {
          author_association: association,
        }),
      ], exactMarker),
      0,
      `trusted ${association} full pstack-interrogate act-on=0 review body`,
    );
  }

  for (const [label, body] of [
    ['act-on=1', interrogateBody(HEAD, '1')],
    ['act-on=2', interrogateBody(HEAD, '2')],
    ['act-on=-1', interrogateBody(HEAD, '-1')],
    ['act-on=00', interrogateBody(HEAD, '00')],
    ['empty act-on', interrogateBody(HEAD, '')],
    ['duplicate identical act-on=0 markers', `${interrogateMarker(HEAD, '0')}\n${interrogateMarker(HEAD, '0')}`],
    ['act-on=1 followed by act-on=0', `${interrogateMarker(HEAD, '1')}\n${interrogateMarker(HEAD, '0')}`],
    ['act-on=0 followed by act-on=1', `${interrogateMarker(HEAD, '0')}\n${interrogateMarker(HEAD, '1')}`],
    ['reversed attributes', `<!-- pstack-interrogate act-on=0 head=${HEAD} -->`],
    ['extra attribute', `<!-- pstack-interrogate head=${HEAD} act-on=0 extra=1 -->`],
    ['extra space after prefix', `<!-- pstack-interrogate  head=${HEAD} act-on=0 -->`],
    ['extra space before close', `<!-- pstack-interrogate head=${HEAD} act-on=0  -->`],
    ['missing space before close', `<!-- pstack-interrogate head=${HEAD} act-on=0-->`],
    ['newline inside marker', `<!-- pstack-interrogate head=${HEAD}\nact-on=0 -->`],
    ['no space after pstack-interrogate', '<!-- pstack-interrogate-->'],
    ['unclosed pstack-interrogate marker alone', `<!-- pstack-interrogate head=${HEAD} act-on=0`],
    [
      'valid act-on=0 marker alongside unclosed pstack-interrogate prefix',
      `${interrogateBody(HEAD, '0')}\n<!-- pstack-interrogate head=${HEAD} act-on=1`,
    ],
  ]) {
    assert.notEqual(
      runReviewFilter([review(1, 'COMMENTED', '2026-08-01T00:00:00Z', body)], exactMarker),
      0,
      label,
    );
  }

  for (const [label, body] of [
    [
      'fenced backtick block quoting act-on=1 before valid act-on=0 marker',
      `\`\`\`html\n${interrogateMarker(HEAD, '1')}\n\`\`\`\n\n${interrogateMarker(HEAD, '0')}`,
    ],
    [
      '4-backtick fenced block with CRLF and 3 leading spaces quoting act-on=2',
      `   \`\`\`\`md\r\n\`\`\`\r\n${interrogateMarker(PREVIOUS_HEAD, '2')}\r\n\`\`\`\r\n   \`\`\`\`\r\n${interrogateMarker(HEAD, '0')}`,
    ],
    [
      'tilde fenced block quoting unclosed prefix before valid act-on=0 marker',
      `~~~html\n<!-- pstack-interrogate head=${HEAD} act-on=1\n~~~\n${interrogateMarker(HEAD, '0')}`,
    ],
    [
      'single and double backtick inline code spans quoting markers before valid act-on=0 marker',
      `See \`${interrogateMarker(HEAD, '1')}\` and \`\` \` ${interrogateMarker(PREVIOUS_HEAD, '3')} \` \`\`.\n\n${interrogateMarker(HEAD, '0')}`,
    ],
    [
      'multiline inline backtick span containing triple backticks in single paragraph before valid act-on=0',
      `Inline \`span\n\`\`\`\ncode\` in paragraph.\n\n${interrogateMarker(HEAD, '0')}`,
    ],
    [
      'list-indented fenced block quoting act-on=1 before valid act-on=0 marker',
      `- item\n\n     \`\`\`html\n     ${interrogateMarker(HEAD, '1')}\n     \`\`\`\n\n${interrogateMarker(HEAD, '0')}`,
    ],
    [
      'blockquote quoting act-on=1 before valid act-on=0 marker',
      `> ${interrogateMarker(HEAD, '1')}\n\n${interrogateMarker(HEAD, '0')}`,
    ],
    [
      '4-space indented code block quoting act-on=1 before valid act-on=0 marker',
      `Paragraph.\n\n    ${interrogateMarker(HEAD, '1')}\n\n${interrogateMarker(HEAD, '0')}`,
    ],
    [
      'HTML comment containing triple fence before valid act-on=0 marker',
      `<!-- note \`\`\` -->\nbody\n${interrogateMarker(HEAD, '0')}`,
    ],
    [
      'escaped backtick before inline code decoy before valid act-on=0 marker',
      `\\\` text \`${interrogateMarker(HEAD, '1')}\`\n${interrogateMarker(HEAD, '0')}`,
    ],
    [
      '4-space indented code block containing fence before valid act-on=0 marker',
      `    \`\`\`\n\n${interrogateMarker(HEAD, '0')}`,
    ],
    [
      '4-space indented code block after ATX heading before valid act-on=0 marker',
      `### Example\n    ${interrogateMarker(HEAD, '2')}\n${interrogateMarker(HEAD, '0')}`,
    ],
    [
      '4-space inner fence inside fenced block before valid act-on=0 marker',
      `\`\`\`md\n    \`\`\`\n${interrogateMarker(HEAD, '2')}\n\`\`\`\n${interrogateMarker(HEAD, '0')}`,
    ],
    [
      'list-nested blockquote decoy before valid act-on=0 marker',
      `- > ${interrogateMarker(HEAD, '2')}\n${interrogateMarker(HEAD, '0')}`,
    ],
  ]) {
    assert.equal(
      runReviewFilter([review(1, 'COMMENTED', '2026-08-01T00:00:00Z', body)], exactMarker),
      0,
      label,
    );
  }

  for (const [label, body] of [
    ['act-on=0 only inside fenced backtick block', `\`\`\`html\n${interrogateMarker(HEAD, '0')}\n\`\`\``],
    ['act-on=0 only inside tilde fenced block', `~~~\n${interrogateMarker(HEAD, '0')}\n~~~`],
    ['act-on=0 only inside unclosed fenced block', `\`\`\`\n${interrogateMarker(HEAD, '0')}`],
    ['act-on=0 only inside single-backtick inline code', `\`${interrogateMarker(HEAD, '0')}\``],
    ['act-on=0 only inside multi-backtick inline code', `\`\` ${interrogateMarker(HEAD, '0')} \`\``],
    ['act-on=0 only inside blockquote', `> ${interrogateMarker(HEAD, '0')}`],
    ['act-on=0 only inside 4-space indented code block', `Paragraph.\n\n    ${interrogateMarker(HEAD, '0')}`],
    ['act-on=0 indented by 2 spaces instead of column 0', `  ${interrogateMarker(HEAD, '0')}`],
    ['act-on=0 inline after prose on same line', `Verdict: ${interrogateMarker(HEAD, '0')}`],
    [
      'valid act-on=0 marker before unclosed fenced block quoting act-on=1 to EOF',
      `${interrogateMarker(HEAD, '0')}\n\`\`\`html\n${interrogateMarker(HEAD, '1')}`,
    ],
    [
      'unclosed fenced block before act-on=1 followed by act-on=0',
      `\`\`\`html\n${interrogateMarker(HEAD, '1')}\n${interrogateMarker(HEAD, '0')}`,
    ],
    [
      'stray single backticks across paragraphs around act-on=1 before act-on=0',
      `First \` stray.\n\n${interrogateMarker(HEAD, '1')}\n\nSecond \` stray.\n\n${interrogateMarker(HEAD, '0')}`,
    ],
    [
      'escaped backticks around real act-on=2 must stay prose and block',
      `Note \\\`${interrogateMarker(HEAD, '2')}\\\`\n${interrogateMarker(HEAD, '0')}`,
    ],
  ]) {
    assert.notEqual(
      runReviewFilter([review(1, 'COMMENTED', '2026-08-01T00:00:00Z', body)], exactMarker),
      0,
      label,
    );
  }

  for (const invalidHead of ['head', 'a'.repeat(39), 'a'.repeat(41), 'A'.repeat(40)]) {
    assert.notEqual(
      runReviewFilter(
        [
          review(1, 'COMMENTED', '2026-08-01T00:00:00Z', interrogateMarker(invalidHead, '0'), {
            commit_id: invalidHead,
          }),
        ],
        [marker(invalidHead)],
        invalidHead,
      ),
      0,
      `non-40-lowercase-hex head must be rejected (${invalidHead})`,
    );
  }

  for (const [label, overrides] of [
    ['marker sha differs from commit_id on current head', { commit_id: HEAD, body: interrogateBody(PREVIOUS_HEAD, '0') }],
    ['commit_id is previous head while marker claims current head', { commit_id: PREVIOUS_HEAD, body: interrogateBody(HEAD, '0') }],
    ['both commit_id and marker belong to previous head', { commit_id: PREVIOUS_HEAD, body: interrogateBody(PREVIOUS_HEAD, '0') }],
    ['missing commit_id', { commit_id: null, body: interrogateBody(HEAD, '0') }],
  ]) {
    assert.notEqual(
      runReviewFilter([review(1, 'COMMENTED', '2026-08-01T00:00:00Z', '', overrides)], exactMarker),
      0,
      label,
    );
  }

  for (const [label, body] of [
    ['retired Aquila fallback marker', retiredFallbackBody],
    ['retired Aquila Universal Review marker', retiredUniversalBody],
    ['retired Codex CLI fallback marker', retiredCodexBody],
    ['empty COMMENTED body', ''],
    ['null COMMENTED body', null],
    ['plain text COMMENTED body', 'LGTM'],
    ['legacy header without marker', '**Actionable comments posted: 0**'],
  ]) {
    assert.notEqual(
      runReviewFilter([review(1, 'COMMENTED', '2026-08-01T00:00:00Z', body)], exactMarker),
      0,
      label,
    );
  }

  for (const untrusted of ['NONE', 'CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR', 'FIRST_TIMER', 'MANNEQUIN']) {
    assert.notEqual(
      runReviewFilter([
        review(1, 'COMMENTED', '2026-08-01T00:00:00Z', interrogateBody(), {
          author_association: untrusted,
        }),
      ], exactMarker),
      0,
      `untrusted author_association ${untrusted}`,
    );
  }

  for (const [label, badUser] of [
    ['null user on OWNER review', null],
    ['empty user object on OWNER review', {}],
    ['missing user.type on OWNER review', { login: 'reviewer' }],
    ['empty user.login on OWNER review', { login: '', type: 'User' }],
    ['numeric user.login on OWNER review', { login: 123, type: 'User' }],
    ['collaborator Bot user on COMMENTED interrogate review', { login: 'helper[bot]', type: 'Bot' }],
  ]) {
    assert.notEqual(
      runReviewFilter([
        review(1, 'COMMENTED', '2026-08-01T00:00:00Z', interrogateBody(), { user: badUser }),
      ], exactMarker),
      0,
      label,
    );
    assert.notEqual(
      runReviewFilter([
        review(1, 'APPROVED', '2026-08-01T00:00:00Z', '', { user: badUser }),
      ], exactMarker),
      0,
      `${label} (APPROVED)`,
    );
  }

  const codeRabbit = {
    author_association: 'NONE',
    user: { login: 'coderabbitai[bot]', id: 136622811, type: 'Bot' },
  };
  assert.equal(
    runReviewFilter([review(1, 'COMMENTED', '2026-08-01T00:00:00Z', '', codeRabbit)], exactMarker),
    0,
  );
  assert.notEqual(
    runReviewFilter([
      review(1, 'COMMENTED', '2026-08-01T00:00:00Z', '', {
        ...codeRabbit,
        commit_id: DIFFERENT_HEAD,
      }),
    ], exactMarker),
    0,
    'CodeRabbit review outside PR commit set must fail closed',
  );
  assert.notEqual(
    runReviewFilter([
      review(1, 'APPROVED', '2026-08-01T00:00:00Z', '', {
        commit_id: DIFFERENT_HEAD,
      }),
    ], exactMarker),
    0,
    'human APPROVED outside PR commit set must fail closed',
  );
  assert.notEqual(
    runReviewFilter([
      review(1, 'CHANGES_REQUESTED', '2026-08-01T00:00:00Z'),
      review(2, 'APPROVED', '2026-08-01T00:01:00Z', '', { commit_id: DIFFERENT_HEAD }),
      review(3, 'COMMENTED', '2026-08-01T00:02:00Z', interrogateBody(), {
        user: { login: 'reviewer-two', type: 'User' },
      }),
    ], exactMarker),
    0,
    'out-of-PR APPROVED must not clear prior CHANGES_REQUESTED',
  );
  assert.equal(
    runReviewFilter([
      review(1, 'CHANGES_REQUESTED', '2026-08-01T00:00:00Z', 'pre-rebase cr', {
        commit_id: DIFFERENT_HEAD,
        user: { login: 'reviewer-one', type: 'User' },
      }),
      review(2, 'APPROVED', '2026-08-01T00:01:00Z', '', {
        commit_id: 'f'.repeat(40),
        user: { login: 'reviewer-one', type: 'User' },
      }),
      review(3, 'COMMENTED', '2026-08-01T00:02:00Z', interrogateBody(), {
        user: { login: 'reviewer-two', type: 'User' },
      }),
    ], exactMarker),
    0,
    'pre-rebase CHANGES_REQUESTED already cleared by pre-rebase APPROVED must not wedge after rebase',
  );
  assert.equal(
    runReviewFilter([
      review(1, 'COMMENTED', '2026-08-01T00:00:00Z', interrogateBody(DIFFERENT_HEAD, '2'), {
        commit_id: DIFFERENT_HEAD,
        user: { login: 'reviewer-one', type: 'User' },
      }),
      review(2, 'COMMENTED', '2026-08-01T00:01:00Z', interrogateBody('f'.repeat(40), '0'), {
        commit_id: 'f'.repeat(40),
        user: { login: 'reviewer-one', type: 'User' },
      }),
      review(3, 'COMMENTED', '2026-08-01T00:02:00Z', '', codeRabbit),
    ], exactMarker),
    0,
    'pre-rebase ACT_ON already cleared by pre-rebase act-on=0 must not wedge CodeRabbit after rebase',
  );
  assert.notEqual(
    runReviewFilter([
      review(1, 'COMMENTED', '2026-08-01T00:00:00Z', interrogateBody(), {
        ...codeRabbit,
        user: { ...codeRabbit.user, type: 'User' },
      }),
    ], exactMarker),
    0,
  );
  assert.notEqual(
    runReviewFilter([
      review(1, 'COMMENTED', '2026-08-01T00:00:00Z', '', {
        author_association: 'NONE',
        user: null,
      }),
    ]),
    0,
  );
  assert.notEqual(
    runReviewFilter([
      review(1, 'COMMENTED', '2026-08-01T00:00:00Z', interrogateBody(), {
        ...codeRabbit,
        user: { ...codeRabbit.user, login: 'other-bot[bot]' },
      }),
    ]),
    0,
  );
  assert.notEqual(
    runReviewFilter([
      review(1, 'COMMENTED', '2026-08-01T00:00:00Z', interrogateBody(), {
        ...codeRabbit,
        user: { ...codeRabbit.user, id: 1 },
      }),
    ]),
    0,
  );

  assert.notEqual(
    runReviewFilter([
      review(1, 'COMMENTED', '2026-08-01T00:00:00Z', '', codeRabbit),
      review(2, 'COMMENTED', '2026-08-01T00:01:00Z', interrogateBody(HEAD, '1'), {
        user: { login: 'reviewer-one', type: 'User' },
      }),
      review(3, 'APPROVED', '2026-08-01T00:02:00Z', '', {
        user: { login: 'reviewer-two', type: 'User' },
      }),
    ], exactMarker),
    0,
    'active ACT_ON_CURRENT must block merge even alongside CodeRabbit and another reviewer APPROVED',
  );
  assert.notEqual(
    runReviewFilter([
      review(1, 'COMMENTED', '2026-08-01T00:00:00Z', `${interrogateBody(HEAD, '0')}\n<!-- pstack-interrogate`, {
        user: { login: 'reviewer-one', type: 'User' },
      }),
      review(2, 'APPROVED', '2026-08-01T00:01:00Z', '', {
        user: { login: 'reviewer-two', type: 'User' },
      }),
    ], exactMarker),
    0,
    'unclosed pstack-interrogate prefix on current head must set ACT_ON_CURRENT and block another reviewer APPROVED',
  );
  assert.notEqual(
    runReviewFilter([
      review(1, 'COMMENTED', '2026-08-01T00:00:00Z', interrogateBody(HEAD, '1')),
      review(2, 'COMMENTED', '2026-08-01T00:01:00Z', 'addressed in latest commit'),
      review(3, 'APPROVED', '2026-08-01T00:02:00Z', '', {
        user: { login: 'reviewer-two', type: 'User' },
      }),
    ], exactMarker),
    0,
    'plain COMMENTED note must not clear that reviewer prior ACT_ON',
  );
  assert.notEqual(
    runReviewFilter([
      review(1, 'COMMENTED', '2026-08-01T00:00:00Z', interrogateBody(HEAD, '1')),
      review(2, 'COMMENTED', '2026-08-01T00:01:00Z', interrogateBody(PREVIOUS_HEAD, '0'), {
        commit_id: PREVIOUS_HEAD,
      }),
      review(3, 'APPROVED', '2026-08-01T00:02:00Z', '', {
        user: { login: 'reviewer-two', type: 'User' },
      }),
    ], exactMarker),
    0,
    'older-commit act-on=0 must not clear that reviewer ACT_ON_CURRENT on HEAD',
  );
  assert.notEqual(
    runReviewFilter([
      review(1, 'COMMENTED', '2026-08-01T00:00:00Z', interrogateBody(PREVIOUS_HEAD, '1'), {
        commit_id: PREVIOUS_HEAD,
        user: { login: 'reviewer-one', type: 'User' },
      }),
      review(2, 'COMMENTED', '2026-08-01T00:01:00Z', '', codeRabbit),
    ], exactMarker),
    0,
    'unresolved ACT_ON_PRIOR must block CodeRabbit-only discovery without a current human pass',
  );
  assert.equal(
    runReviewFilter([
      review(1, 'COMMENTED', '2026-08-01T00:00:00Z', interrogateBody(PREVIOUS_HEAD, '1'), {
        commit_id: PREVIOUS_HEAD,
        user: { login: 'reviewer-one', type: 'User' },
      }),
      review(2, 'COMMENTED', '2026-08-01T00:01:00Z', interrogateBody(PREVIOUS_HEAD, '0'), {
        commit_id: PREVIOUS_HEAD,
        user: { login: 'reviewer-one', type: 'User' },
      }),
      review(3, 'COMMENTED', '2026-08-01T00:02:00Z', '', {
        ...codeRabbit,
        commit_id: PREVIOUS_HEAD,
      }),
    ], exactMarker),
    0,
    'valid act-on=0 on PR commit by same reviewer must clear ACT_ON_PRIOR alongside CodeRabbit discovery',
  );
  assert.equal(
    runReviewFilter([
      review(1, 'COMMENTED', '2026-08-01T00:00:00Z', interrogateBody(PREVIOUS_HEAD, '1'), {
        commit_id: PREVIOUS_HEAD,
        user: { login: 'reviewer-one', type: 'User' },
      }),
      review(2, 'COMMENTED', '2026-08-01T00:01:00Z', interrogateBody(HEAD, '0'), {
        user: { login: 'reviewer-two', type: 'User' },
      }),
    ], exactMarker),
    0,
    'current-head valid pstack-interrogate act-on=0 must satisfy gate despite another reviewer ACT_ON_PRIOR',
  );
  assert.equal(
    runReviewFilter([
      review(1, 'COMMENTED', '2026-08-01T00:00:00Z', interrogateBody(PREVIOUS_HEAD, '0'), {
        commit_id: PREVIOUS_HEAD,
        user: { login: 'reviewer-one', type: 'User' },
      }),
      review(2, 'COMMENTED', '2026-08-01T00:01:00Z', '', codeRabbit),
    ], exactMarker),
    0,
    'older-commit valid act-on=0 must stay neutral alongside CodeRabbit discovery',
  );
  assert.equal(
    runReviewFilter([
      review(1, 'COMMENTED', '2026-08-01T00:00:00Z', interrogateBody(HEAD, '1')),
      review(2, 'COMMENTED', '2026-08-01T00:01:00Z', interrogateBody(HEAD, '0')),
    ], exactMarker),
    0,
    'valid current-head act-on=0 must clear that reviewer prior ACT_ON',
  );
  assert.equal(
    runReviewFilter([
      review(1, 'COMMENTED', '2026-08-01T00:00:00Z', interrogateBody(HEAD, '1'), {
        user: { login: 'reviewer-one', type: 'User' },
      }),
      review(2, 'CHANGES_REQUESTED', '2026-08-01T00:01:00Z', '', {
        user: { login: 'reviewer-one', type: 'User' },
      }),
      review(3, 'DISMISSED', '2026-08-01T00:02:00Z', '', {
        user: { login: 'reviewer-one', type: 'User' },
      }),
      review(4, 'COMMENTED', '2026-08-01T00:03:00Z', interrogateBody(HEAD, '0'), {
        user: { login: 'reviewer-two', type: 'User' },
      }),
    ], exactMarker),
    1,
    'DISMISSED after intermediate CHANGES_REQUESTED must not erase prior current-head ACT_ON',
  );

  assert.notEqual(
    runReviewFilter([
      review(1, 'CHANGES_REQUESTED', '2026-08-01T00:00:00Z', '', {
        commit_id: PREVIOUS_HEAD,
        user: { login: 'reviewer-one', type: 'User' },
      }),
      review(2, 'APPROVED', '2026-08-01T00:01:00Z', '', {
        user: { login: 'reviewer-two', type: 'User' },
      }),
    ]),
    0,
  );
  assert.notEqual(
    runReviewFilter([
      review(1, 'CHANGES_REQUESTED', '2026-08-01T00:00:00Z', '', {
        commit_id: PREVIOUS_HEAD,
        user: { login: 'reviewer-one', type: 'User' },
      }),
      review(2, 'COMMENTED', '2026-08-01T00:01:00Z', interrogateBody(), {
        user: { login: 'reviewer-two', type: 'User' },
      }),
    ]),
    0,
  );
  assert.equal(
    runReviewFilter([
      review(1, 'CHANGES_REQUESTED', '2026-08-01T00:00:00Z', '', {
        commit_id: PREVIOUS_HEAD,
      }),
      review(2, 'APPROVED', '2026-08-01T00:01:00Z'),
    ]),
    0,
  );
  assert.equal(
    runReviewFilter([
      review(1, 'APPROVED', '2026-08-01T00:00:00Z', '', {
        commit_id: PREVIOUS_HEAD,
      }),
    ]),
    0,
  );
  assert.equal(
    runReviewFilter([
      review(1, 'COMMENTED', '2026-08-01T00:00:00Z', '', {
        ...codeRabbit,
        commit_id: PREVIOUS_HEAD,
      }),
    ]),
    0,
  );
  assert.notEqual(
    runReviewFilter([
      review(1, 'CHANGES_REQUESTED', '2026-08-01T00:00:00Z', '', codeRabbit),
      review(2, 'APPROVED', '2026-08-01T00:01:00Z'),
    ]),
    0,
  );

  assert.equal(
    runReviewFilter([
      review(1, 'DISMISSED', '2026-08-01T00:00:00Z', '', {
        commit_id: PREVIOUS_HEAD,
        user: { login: 'reviewer-one', type: 'User' },
      }),
      review(2, 'APPROVED', '2026-08-01T00:01:00Z', '', {
        user: { login: 'reviewer-two', type: 'User' },
      }),
    ]),
    0,
  );
  assert.equal(
    runReviewFilter([
      review(1, 'APPROVED', '2026-08-01T00:00:00Z', '', {
        commit_id: PREVIOUS_HEAD,
        user: { login: 'reviewer-one', type: 'User' },
      }),
      review(2, 'DISMISSED', '2026-08-01T00:01:00Z', '', {
        commit_id: PREVIOUS_HEAD,
        user: { login: 'reviewer-one', type: 'User' },
      }),
      review(3, 'APPROVED', '2026-08-01T00:02:00Z', '', {
        user: { login: 'reviewer-two', type: 'User' },
      }),
    ]),
    0,
  );
  assert.notEqual(
    runReviewFilter([
      review(1, 'APPROVED', '2026-08-01T00:00:00Z', '', {
        commit_id: PREVIOUS_HEAD,
        user: { login: 'reviewer-one', type: 'User' },
      }),
      review(2, 'DISMISSED', '2026-08-01T00:01:00Z', '', {
        commit_id: PREVIOUS_HEAD,
        user: { login: 'reviewer-one', type: 'User' },
      }),
      review(3, 'COMMENTED', '2026-08-01T00:02:00Z', 'just a plain note', {
        user: { login: 'reviewer-one', type: 'User' },
      }),
    ]),
    0,
    'a DISMISSED APPROVED review followed by a plain COMMENTED note must not satisfy discovery',
  );
  assert.notEqual(
    runReviewFilter([
      review(1, 'DISMISSED', '2026-08-01T00:00:00Z', '', {
        commit_id: PREVIOUS_HEAD,
        user: { login: 'reviewer-one', type: 'User' },
      }),
      review(2, 'CHANGES_REQUESTED', '2026-08-01T00:01:00Z', '', {
        commit_id: PREVIOUS_HEAD,
        user: { login: 'reviewer-two', type: 'User' },
      }),
      review(3, 'APPROVED', '2026-08-01T00:02:00Z', '', {
        user: { login: 'reviewer-three', type: 'User' },
      }),
    ]),
    0,
  );
  assert.notEqual(
    runReviewFilter([
      review(1, 'DISMISSED', '2026-08-01T00:00:00Z', '', {
        commit_id: PREVIOUS_HEAD,
        user: { login: 'reviewer-one', type: 'User' },
      }),
      review(2, 'CHANGES_REQUESTED', '2026-08-01T00:01:00Z', '', {
        commit_id: PREVIOUS_HEAD,
        user: { login: 'reviewer-one', type: 'User' },
      }),
      review(3, 'APPROVED', '2026-08-01T00:02:00Z', '', {
        user: { login: 'reviewer-two', type: 'User' },
      }),
    ]),
    0,
  );
  assert.notEqual(
    runReviewFilter([
      review(1, 'DISMISSED', '2026-08-01T00:00:00Z', '', {
        commit_id: PREVIOUS_HEAD,
      }),
    ]),
    0,
  );

  assert.equal(
    runReviewFilter([
      review(1, 'COMMENTED', '2026-08-01T00:00:00Z', interrogateBody(), {
        user: { login: 'pr-author', type: 'User' },
      }),
    ]),
    0,
    'collaborator PR author User review must satisfy pstack-interrogate discovery',
  );
});

test('required context 판정은 대기와 실패를 구분하고 뒤 페이지 status까지 본다', async () => {
  const workflow = await readWorkflow();

  const checkProgram = workflow.match(
    /# required-context-filter-begin\n\s+context_state="\$\(jq -r [^']+'\n([\s\S]*?)\n\s+' <<<"\$\{checks\}"\)"/,
  )?.[1];
  assert.ok(checkProgram, 'required context jq program must stay testable');

  // statusPages는 `gh api --paginate --slurp` 결과와 같은 페이지 배열이다.
  const classify = (
    checkRuns,
    statusPages = [],
    requiredCheck = { context: 'Data contracts', integration_id: null },
  ) => {
    const result = spawnSync(
      'jq',
      [
        '-r',
        '--argjson', 'required_check', JSON.stringify(requiredCheck),
        '--argjson', 'statuses', JSON.stringify(statusPages),
        checkProgram,
      ],
      { input: JSON.stringify([{ check_runs: checkRuns }]), encoding: 'utf8' },
    );
    assert.equal(result.status, 0, `jq 하네스 파손: ${result.stderr}`);
    return result.stdout.trim();
  };

  const run = (overrides) => ({
    id: 1,
    name: 'Data contracts',
    conclusion: 'success',
    started_at: '2026-08-01T00:00:00Z',
    ...overrides,
  });

  // 최신 check run이 판정을 결정한다.
  assert.equal(
    classify([
      run({ id: 1, conclusion: 'success', started_at: '2026-08-01T00:00:00Z' }),
      run({ id: 2, conclusion: 'failure', started_at: '2026-08-01T00:01:00Z' }),
    ]),
    'failure',
  );
  assert.equal(
    classify([
      run({ id: 1, conclusion: 'failure', started_at: '2026-08-01T00:00:00Z' }),
      run({ id: 2, conclusion: 'success', started_at: '2026-08-01T00:01:00Z' }),
    ]),
    'success',
  );
  // 진행 중(conclusion null)은 계약 위반이 아니라 대기다. 이것을 failure로 처리하면
  // 그 실패 check가 PR을 UNSTABLE로 만들어 다음 실행을 같은 자리에서 죽인다.
  assert.equal(classify([run({ conclusion: null })]), 'pending');
  // 새 head에 아직 안 붙은 상태도 대기다. 병합은 여전히 success에서만 진행된다.
  assert.equal(classify([], []), 'missing');
  // required context가 두 번째 status 페이지에 있어도 찾아낸다.
  assert.equal(
    classify(
      [],
      [
        [{ id: 1, context: 'Other CI', state: 'success', updated_at: '2026-08-01T00:00:00Z' }],
        [{ id: 2, context: 'Data contracts', state: 'success', updated_at: '2026-08-01T00:01:00Z' }],
      ],
    ),
    'success',
  );
  // 뒤 페이지의 최신 실패가 앞 페이지의 성공을 덮는다.
  assert.equal(
    classify(
      [],
      [
        [{ id: 1, context: 'Data contracts', state: 'success', updated_at: '2026-08-01T00:00:00Z' }],
        [{ id: 2, context: 'Data contracts', state: 'failure', updated_at: '2026-08-01T00:01:00Z' }],
      ],
    ),
    'failure',
  );
  assert.equal(
    classify([], [[{ id: 1, context: 'Data contracts', state: 'pending', updated_at: '2026-08-01T00:00:00Z' }]]),
    'pending',
  );
  // check run이 있으면 그것이 정본이다. 실패한 check run을 동명 classic status로
  // 되살리지 않는다.
  assert.equal(
    classify(
      [run({ conclusion: 'failure' })],
      [[{ id: 2, context: 'Data contracts', state: 'success', updated_at: '2026-08-01T00:01:00Z' }]],
    ),
    'failure',
  );
  // 같은 이름의 check run과 classic status가 함께 있으면 둘 다 본다. 하나만 보면 나머지
  // 하나가 실패·대기여도 병합이 진행된다.
  assert.equal(
    classify(
      [run({ conclusion: 'success' })],
      [[{ id: 2, context: 'Data contracts', state: 'failure', updated_at: '2026-08-01T00:01:00Z' }]],
    ),
    'failure',
  );
  assert.equal(
    classify(
      [run({ conclusion: 'success' })],
      [[{ id: 2, context: 'Data contracts', state: 'pending', updated_at: '2026-08-01T00:01:00Z' }]],
    ),
    'pending',
  );
  assert.equal(
    classify(
      [run({ conclusion: 'success' })],
      [[{ id: 2, context: 'Data contracts', state: 'success', updated_at: '2026-08-01T00:01:00Z' }]],
    ),
    'success',
  );
  assert.equal(
    classify(
      [run({ conclusion: null })],
      [[{ id: 2, context: 'Data contracts', state: 'failure', updated_at: '2026-08-01T00:01:00Z' }]],
    ),
    'failure',
  );

  // integration_id가 지정된 required context는 다른 앱의 동명 check나 classic status로
  // 충족되지 않는다.
  assert.equal(
    classify(
      [run({ app: { id: 7 } })],
      [[{ id: 2, context: 'Data contracts', state: 'success', updated_at: '2026-08-01T00:01:00Z' }]],
      { context: 'Data contracts', integration_id: 42 },
    ),
    'missing',
  );
  assert.equal(
    classify([run({ app: { id: 42 } })], [], { context: 'Data contracts', integration_id: 42 }),
    'success',
  );
});

test('required context 판정은 후보별 건너뛰기로 수렴하고 실패는 신호를 남긴다', async () => {
  const workflow = await readWorkflow();

  // 분류 결과를 실제로 어떻게 처리하는지까지 고정한다. 대기든 실패든 이 후보만
  // 건너뛰고 다음 후보를 계속 평가한다. 실행을 끝내면 그 한 건이 뒤를 굶긴다.
  assert.doesNotMatch(workflow, /pending \| missing\)\n\s+echo[^\n]*\n\s+exit 0/);
  assert.doesNotMatch(workflow, /required context failed[\s\S]{0,40}exit 1/);
  // 실패는 조용히 묻히면 안 된다. 계약 위반은 annotation으로 run 요약에 남긴다.
  assert.match(workflow, /::warning::[^\n]*required context/);

  // 후보별 게이트 루프를 실제로 돌려 분류별 처리를 실측한다.
  const contextLoop = workflow.match(
    /# required-context-loop-begin\n([\s\S]*?)\n\s+# required-context-loop-end/,
  )?.[1];
  assert.ok(contextLoop, 'required context loop must stay testable');

  const runContextLoop = (checkRuns) => {
    const result = stubbedBash([
      'set -euo pipefail',
      'gh() {',
      `  printf '%s\\n' "gh $*" >> "$GH_LOG"`,
      '}',
      'pr=39',
      'repo=o/r',
      `checks=${JSON.stringify(JSON.stringify([{ check_runs: checkRuns }]))}`,
      `statuses=${JSON.stringify(JSON.stringify([[]]))}`,
      `required=${JSON.stringify(JSON.stringify([{ context: 'Data contracts', integration_id: null }]))}`,
      // `continue`가 후보 루프를 넘기는 동작이므로 1회 루프로 감싸고, 루프를 끝까지
      // 진행한 경우에만 병합 분기 도달을 관측한다.
      'for _ in 1; do',
      dedent(contextLoop, 12),
      `  printf 'REACHED_DISPATCH\\n'`,
      'done',
    ]);
    return {
      status: result.status,
      reached: result.stdout.includes('REACHED_DISPATCH'),
      warned: (result.stdout + result.stderr).includes('::warning::'),
      stdout: result.stdout,
    };
  };

  const run = (conclusion) => [
    { id: 1, name: 'Data contracts', conclusion, started_at: '2026-08-01T00:00:00Z' },
  ];

  // 전 context가 success여야 병합 분기에 닿는다.
  assert.deepEqual(runContextLoop(run('success')), {
    status: 0,
    reached: true,
    warned: false,
    stdout: 'REACHED_DISPATCH\n',
  });
  // 진행 중(pending)은 이미 붙은 check가 끝나기를 기다리는 상태다. 조용히 건너뛰고
  // CI를 새로 쏘지 않는다.
  const pending = runContextLoop(run(null));
  assert.equal(pending.status, 0);
  assert.equal(pending.reached, false, '대기 상태는 병합 분기에 닿으면 안 된다');
  assert.equal(pending.warned, false, '대기 상태는 사람이 볼 신호가 아니다');
  // 미부착(missing)도 owner push가 붙여야 한다. coordinator가 임의 dispatch하면 native
  // pull_request check와 다른 실행이 되어 ruleset 판정과 다음 workflow_run이 갈라진다.
  const missing = runContextLoop([]);
  assert.equal(missing.status, 0);
  assert.equal(missing.reached, false);
  assert.equal(missing.warned, true);
  assert.match(
    missing.stdout,
    /owning SSD worktree must rebase and push a native PR head when behind/,
  );
  assert.match(missing.stdout, /or push a native PR head otherwise/);
  // 명시적 실패도 실행을 죽이지 않고 이 후보만 건너뛰되, 신호는 남긴다.
  const failed = runContextLoop(run('failure'));
  assert.equal(failed.status, 0);
  assert.equal(failed.reached, false);
  assert.equal(failed.warned, true, 'required context 실패는 ::warning::으로 드러나야 한다');
});

test('merge-state 분기는 상태별로 병합·물러남·건너뛰기를 구분한다', async () => {
  const workflow = await readWorkflow();

  const dispatchBlock = workflow.match(
    /# merge-state-dispatch-begin\n([\s\S]*?)\n\s+# merge-state-dispatch-end/,
  )?.[1];
  assert.ok(dispatchBlock, 'merge state dispatch must stay testable');
  const failClosedHelper = workflow.match(
    /# fail-closed-pr-begin\n([\s\S]*?)\n\s+# fail-closed-pr-end/,
  )?.[1];
  assert.ok(failClosedHelper, 'fail-closed helper must stay testable');

  // gh 호출을 기록만 하는 스텁으로 대체해 상태별 분기 결과를 실측한다. 분기는 큐 루프
  // 안에 있으므로 `continue`가 유효하도록 1회 루프로 감싸고, 루프를 빠져나오면
  // SKIPPED를 남겨 "이 후보를 건너뛰었다"를 관측한다.
  const DEFAULT_DISPATCH_HEAD = '1'.repeat(40);
  const PRIOR_DISPATCH_HEAD = '2'.repeat(40);
  const runDispatch = (
    mergeState,
    {
      mergeFails = false,
      commentFails = false,
      hasPat = false,
      updateStatus = 0,
      recordStatus = 0,
      baseUpdateRecords = [],
      headSha = DEFAULT_DISPATCH_HEAD,
      commitIds = [headSha],
      isAutomationPr = 'false',
      reviews = [
        [
          {
            id: 1,
            state: 'APPROVED',
            submitted_at: '2026-08-01T00:00:00Z',
            commit_id: headSha,
            author_association: 'OWNER',
            body: '',
            user: { login: 'reviewer', type: 'User' },
          },
        ],
      ],
    } = {},
  ) => {
    const markerSync = workflow.match(MARKER_SYNC_RE)?.[1];
    assert.ok(markerSync, 'authorization marker sync must stay testable');
    const result = stubbedBash([
      'set -euo pipefail',
      `HAS_AUTOMERGE_PAT=${hasPat}`,
      'GH_TOKEN=github-token',
      `base_update_records=${JSON.stringify(JSON.stringify(baseUpdateRecords))}`,
      `reviews=${JSON.stringify(JSON.stringify(reviews))}`,
      `commit_ids=${JSON.stringify(JSON.stringify(commitIds))}`,
      `is_automation_pr=${isAutomationPr}`,
      'gh() {',
      `  printf '%s\\n' "gh $*" >> "$GH_LOG"`,
      '  case "$*" in',
      `    "api --method PUT "*update-branch*) printf 'UPDATE_BRANCH_TOKEN=%s\\n' "$GH_TOKEN" >> "$GH_LOG"; return ${updateStatus} ;;`,
      `    "api --method "*"requested: "*) printf 'RECORD_TOKEN=%s\\n' "$GH_TOKEN" >> "$GH_LOG"; return ${recordStatus} ;;`,
      `    "pr merge"*) ${mergeFails ? 'return 17' : ':'} ;;`,
      `    "pr comment"*) ${commentFails ? 'return 1' : ':'} ;;`,
      `    "pr edit"*) : ;;`,
      '  esac',
      '}',
      'pr=26',
      'repo=o/r',
      `head=${JSON.stringify(headSha)}`,
      `merge_state=${JSON.stringify(mergeState)}`,
      'GITHUB_SERVER_URL=https://github.example',
      'GITHUB_REPOSITORY=o/r',
      'MERGE_GH_TOKEN=merge-token',
      'GITHUB_RUN_ID=123456',
      reviewJqDefsOf(workflow),
      dedent(failClosedHelper),
      dedent(markerSync),
      'for _ in 1; do',
      dedent(dispatchBlock, 12),
      'done',
      `printf 'SKIPPED\\n' >> "$GH_LOG"`,
    ]);
    return {
      status: result.status,
      merged: result.calls.includes('gh pr merge'),
      updatedBranch: result.calls.includes('update-branch'),
      dispatchedCi: result.calls.includes('workflow run ci.yml'),
      commented: result.calls.includes('gh pr comment'),
      removedLabel: result.calls.includes('gh pr edit') && result.calls.includes('--remove-label automerge'),
      skipped: result.calls.includes('SKIPPED'),
      warned: (result.stdout + result.stderr).includes('::warning::'),
      calls: result.calls,
      stdout: result.stdout,
    };
  };

  // 병합 가능 상태. UNSTABLE은 "필수가 아닌 check가 green이 아님"일 뿐이고 required
  // context는 앞에서 ruleset 기준으로 이미 검증했으므로 병합을 진행한다.
  for (const mergeState of ['CLEAN', 'HAS_HOOKS', 'UNSTABLE']) {
    const result = runDispatch(mergeState);
    assert.deepEqual(
      {
        status: result.status,
        merged: result.merged,
        updatedBranch: result.updatedBranch,
        dispatchedCi: result.dispatchedCi,
        commented: result.commented,
        removedLabel: result.removedLabel,
        skipped: result.skipped,
        warned: result.warned,
      },
      {
        status: 0,
        merged: true,
        updatedBranch: false,
        dispatchedCi: false,
        commented: false,
        removedLabel: false,
        skipped: false,
        warned: false,
      },
      `${mergeState} must proceed to merge`,
    );
    // 이 저장소는 auto-merge가 꺼져 있으므로 즉시 병합이고, head 고정은 서버가 한다.
    assert.match(
      result.calls,
      new RegExp(`gh pr merge --squash 26 --repo o/r --match-head-commit ${DEFAULT_DISPATCH_HEAD}`),
    );
  }
  const behind = runDispatch('BEHIND');
  assert.equal(behind.status, 0);
  assert.equal(behind.merged, false);
  assert.equal(behind.updatedBranch, false);
  assert.equal(behind.dispatchedCi, false);
  assert.equal(behind.commented, false);
  assert.equal(behind.removedLabel, true, 'PAT-less BEHIND handoff must remove automerge label');
  assert.equal(behind.skipped, true);
  assert.equal(behind.warned, true);
  assert.match(behind.calls + behind.stdout, /owning SSD worktree must rebase and push/);
  const interrogateHead = 'f'.repeat(40);
  const behindInterrogateOnly = runDispatch('BEHIND', {
    hasPat: true,
    headSha: interrogateHead,
    reviews: [
      [
        {
          id: 1,
          state: 'COMMENTED',
          submitted_at: '2026-08-01T00:00:00Z',
          commit_id: interrogateHead,
          author_association: 'OWNER',
          body: `<!-- pstack-interrogate head=${interrogateHead} act-on=0 -->`,
          user: { login: 'reviewer', type: 'User' },
        },
      ],
    ],
  });
  assert.equal(behindInterrogateOnly.status, 0);
  assert.equal(behindInterrogateOnly.updatedBranch, false, 'exact-head pstack-interrogate must not trigger update-branch');
  assert.equal(behindInterrogateOnly.removedLabel, true, 'non-transferable BEHIND handoff must remove automerge label');
  assert.equal(
    behindInterrogateOnly.calls,
    'gh pr edit 26 --repo o/r --remove-label automerge\nSKIPPED\n',
    'BEHIND non-transferable handoff must remove automerge label with zero extra read calls',
  );
  assert.equal(behindInterrogateOnly.skipped, true);
  assert.equal(behindInterrogateOnly.warned, true);
  assert.match(
    behindInterrogateOnly.stdout,
    /PR #26 is behind main without a transferable frozen discovery review; its owning SSD worktree must rebase and re-review\./,
  );
  const behindOutsideCommitSet = runDispatch('BEHIND', {
    hasPat: true,
    headSha: DEFAULT_DISPATCH_HEAD,
    commitIds: [DEFAULT_DISPATCH_HEAD],
    reviews: [
      [
        {
          id: 1,
          state: 'APPROVED',
          submitted_at: '2026-08-01T00:00:00Z',
          commit_id: PRIOR_DISPATCH_HEAD,
          author_association: 'OWNER',
          body: '',
          user: { login: 'reviewer', type: 'User' },
        },
      ],
    ],
  });
  assert.equal(behindOutsideCommitSet.updatedBranch, false, 'APPROVED outside PR commit set must not trigger update-branch');
  assert.equal(behindOutsideCommitSet.removedLabel, true);
  const behindUnresolvedPriorActOn = runDispatch('BEHIND', {
    hasPat: true,
    headSha: DEFAULT_DISPATCH_HEAD,
    commitIds: [PRIOR_DISPATCH_HEAD, DEFAULT_DISPATCH_HEAD],
    reviews: [
      [
        {
          id: 1,
          state: 'COMMENTED',
          submitted_at: '2026-08-01T00:00:00Z',
          commit_id: PRIOR_DISPATCH_HEAD,
          author_association: 'OWNER',
          body: `<!-- pstack-interrogate head=${PRIOR_DISPATCH_HEAD} act-on=1 -->`,
          user: { login: 'reviewer-one', type: 'User' },
        },
        {
          id: 2,
          state: 'COMMENTED',
          submitted_at: '2026-08-01T00:01:00Z',
          commit_id: DEFAULT_DISPATCH_HEAD,
          author_association: 'OWNER',
          body: `<!-- pstack-interrogate head=${DEFAULT_DISPATCH_HEAD} act-on=0 -->`,
          user: { login: 'reviewer-two', type: 'User' },
        },
        {
          id: 3,
          state: 'COMMENTED',
          submitted_at: '2026-08-01T00:02:00Z',
          commit_id: PRIOR_DISPATCH_HEAD,
          author_association: 'NONE',
          body: '',
          user: { login: 'coderabbitai[bot]', id: 136622811, type: 'Bot' },
        },
      ],
    ],
  });
  assert.equal(
    behindUnresolvedPriorActOn.updatedBranch,
    false,
    'prior ACT_ON from another reviewer would resurrect after update-branch and must block BEHIND update',
  );
  assert.equal(behindUnresolvedPriorActOn.removedLabel, true);
  // PAT가 있으면 게이트를 통과한 BEHIND 후보의 base를 현재 head 고정으로 갱신하고, 수락된
  // 요청만 github.token 기록으로 남긴 뒤 그 실행을 끝낸다.
  const recordLine = `gh api --method POST repos/o/r/issues/26/comments -f body=<!-- Automerge base update requested: ${DEFAULT_DISPATCH_HEAD} -->`;
  const behindWithPat = runDispatch('BEHIND', { hasPat: true });
  assert.equal(behindWithPat.status, 0);
  assert.equal(behindWithPat.merged, false);
  assert.equal(behindWithPat.skipped, false, 'base update must end the run');
  assert.equal(behindWithPat.removedLabel, false);
  assert.deepEqual(
    behindWithPat.calls.split('\n').filter((line) => line.includes('update-branch')),
    [`gh api --method PUT repos/o/r/pulls/26/update-branch -f expected_head_sha=${DEFAULT_DISPATCH_HEAD}`],
  );
  assert.match(behindWithPat.calls, /^UPDATE_BRANCH_TOKEN=merge-token$/m);
  assert.ok(behindWithPat.calls.includes(recordLine), 'an accepted base update must be recorded');
  assert.ok(behindWithPat.calls.indexOf('update-branch') < behindWithPat.calls.indexOf(recordLine));
  assert.match(behindWithPat.calls, /^RECORD_TOKEN=github-token$/m);
  const behindRecorded = runDispatch('BEHIND', { hasPat: true, baseUpdateRecords: [{ id: 7, head: 'a'.repeat(40) }] });
  assert.ok(behindRecorded.calls.includes(`gh api --method PATCH repos/o/r/issues/comments/7 -f body=<!-- Automerge base update requested: ${DEFAULT_DISPATCH_HEAD} -->`));
  assert.doesNotMatch(behindRecorded.calls, /--method POST/);
  const behindAmbiguous = runDispatch('BEHIND', { hasPat: true, baseUpdateRecords: [{ id: 7, head: 'a'.repeat(40) }, { id: 8, head: 'b'.repeat(40) }] });
  assert.equal(behindAmbiguous.status, 0);
  assert.equal(behindAmbiguous.skipped, false);
  assert.doesNotMatch(behindAmbiguous.calls, /requested: /, 'ambiguous records must not be touched');
  assert.equal(behindAmbiguous.warned, true);
  const behindRecordFailed = runDispatch('BEHIND', { hasPat: true, recordStatus: 49 });
  assert.equal(behindRecordFailed.status, 0, 'a record failure must not fail the run after the accepted update');
  assert.equal(behindRecordFailed.skipped, false);
  assert.equal(behindRecordFailed.warned, true);
  const behindUpdateFailed = runDispatch('BEHIND', { hasPat: true, updateStatus: 42 });
  assert.equal(behindUpdateFailed.status, 0, 'a failed base update must skip only this candidate');
  assert.equal(behindUpdateFailed.skipped, true);
  assert.equal(behindUpdateFailed.merged, false);
  assert.equal(behindUpdateFailed.removedLabel, false);
  assert.equal(behindUpdateFailed.warned, true);
  assert.doesNotMatch(behindUpdateFailed.calls, /requested: /, 'a failed base update must not be recorded');
  // 병합할 수 없는 상태는 전부 "이 후보만 건너뛴다"로 수렴한다. 실행을 실패시키면
  // 그 실패 check가 PR을 UNSTABLE로 만들고 큐 전체가 뒤의 후보까지 굶긴다.
  for (const mergeState of ['BLOCKED', 'UNKNOWN']) {
    const result = runDispatch(mergeState);
    assert.equal(result.status, 0, `${mergeState} must not fail the run`);
    assert.equal(result.merged, false);
    assert.equal(result.skipped, true, `${mergeState} must skip to the next candidate`);
    assert.equal(result.warned, false);
    assert.equal(result.commented, false);
    assert.equal(result.removedLabel, false);
  }
  // 사람이 봐야 하는 상태는 건너뛰되 신호를 남긴다. 실행은 실패시키지 않는다.
  for (const mergeState of ['DIRTY', 'SOME_NEW_STATE']) {
    const result = runDispatch(mergeState);
    assert.equal(result.status, 0, `${mergeState} must not fail the run`);
    assert.equal(result.merged, false);
    assert.equal(result.skipped, true);
    assert.equal(result.warned, true, `${mergeState} must skip with an operator-visible warning`);
    assert.equal(result.commented, false);
    assert.equal(result.removedLabel, false);
  }
  // 병합 API 호출 실패는 fail closed다. 실패를 PR conversation에 남기고 automerge
  // 라벨을 제거한 뒤, coordinator job 자체를 실패시킨다.
  const mergeFailed = runDispatch('CLEAN', { mergeFails: true });
  assert.notEqual(mergeFailed.status, 0, 'merge call failure must fail the run');
  assert.equal(mergeFailed.commented, true, 'merge failure must leave a PR comment');
  assert.equal(mergeFailed.removedLabel, true, 'merge failure must remove the automerge label');
  assert.match(mergeFailed.calls, /PR #26 merge 실패: 상태 CLEAN, 종료 코드 17\./);
  assert.match(mergeFailed.calls, /https:\/\/github\.example\/o\/r\/actions\/runs\/123456/);
  assert.match(mergeFailed.calls, /automerge 라벨을 제거합니다/);
  // comment가 실패해도 라벨 제거는 건너뛰지 않는다. 어느 실패든 job은 fail closed다.
  const commentFailed = runDispatch('CLEAN', { mergeFails: true, commentFails: true });
  assert.notEqual(commentFailed.status, 0);
  assert.equal(commentFailed.commented, true);
  assert.equal(commentFailed.removedLabel, true);

});

test('게이트는 후보별로 병합 분기보다 앞서고 producer dispatch는 큐 뒤에서 실행된다', async () => {
  const workflow = await readWorkflow();

  // 게이트는 후보마다 수행되고, 통과하지 못하면 그 후보만 건너뛴다.
  assert.ok(workflow.includes('set -euo pipefail'));
  const queueStepAt = workflow.indexOf('- name: Coordinate eligible pull requests');
  const producerStepAt = workflow.indexOf('- name: Dispatch the data pack producer for the current main');
  const queueLoopAt = workflow.indexOf('# queue-loop-begin');
  const reviewGateAt = workflow.indexOf('# review-state-filter-end');
  const contextGateAt = workflow.indexOf('# required-context-filter-end');
  const dispatchAt = workflow.indexOf('# merge-state-dispatch-begin');
  assert.ok(queueStepAt > 0, 'queue step must exist');
  assert.ok(producerStepAt > queueStepAt, 'producer must run after the queue step');
  assert.ok(queueLoopAt > 0, 'queue loop marker must exist');
  assert.ok(reviewGateAt > queueLoopAt, 'gates must run inside the candidate loop');
  assert.ok(contextGateAt > reviewGateAt, 'review gate must precede the required context gate');
  assert.ok(dispatchAt > contextGateAt, 'gates must precede the merge dispatch');
  assert.match(
    workflow.slice(producerStepAt, producerStepAt + 320),
    /if: \$\{\{ !cancelled\(\) \}\}/,
    'queue failure 뒤 producer를 실행하되 cancellation에는 실행하지 않아야 한다',
  );
});

const BUDGET_BLOCK_RE = /# candidate-budget-begin\n([\s\S]*?)\n\s+# candidate-budget-end/;

const budgetConstantOf = (workflow, name) => {
  const result = spawnSync(
    'bash',
    ['-c', `set -euo pipefail\n${budgetConstantsOf(workflow)}\nprintf '%s' "\${${name}}"`],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, `${name} evaluation failed: ${result.stderr}`);
  const declared = Number(result.stdout);
  assert.ok(result.stdout !== '' && Number.isInteger(declared), `${name} constant must stay declared`);
  return declared;
};

// 실제 창은 실행마다 실측 잔량에서 정해지므로 상수로 남는 것은 상한뿐이다.
const declaredWindowOf = (workflow) => {
  const declared = budgetConstantOf(workflow, 'window_max');
  assert.ok(declared > 0, 'window ceiling must stay positive');
  return declared;
};

const WINDOW_PROGRAM_RE =
  /# candidate-window-begin\n\s+done < <\(jq -r --argjson window "\$\{window\}" --argjson offset "\$\{offset\}" '\n([\s\S]*?)\n\s+' <<<"\$\{candidates\}"\)/;

const makePickWindow = (windowProgram, windowSize) => (total, offset) => {
  const result = spawnSync(
    'jq',
    [
      '-r',
      '--argjson', 'window', String(windowSize),
      '--argjson', 'offset', String(offset),
      windowProgram,
    ],
    {
      input: JSON.stringify(Array.from({ length: total }, (_, index) => index)),
      encoding: 'utf8',
    },
  );
  // 실패한 jq도 stdout이 비어 "선택 없음"처럼 보인다. 프로그램 파손이 정상 동작으로
  // 새지 않도록 종료 코드를 함께 본다.
  assert.equal(
    result.status,
    0,
    `candidate window jq failed at total=${total} offset=${offset}: ${result.stderr}`,
  );
  const stdout = result.stdout.trim();
  return stdout === '' ? [] : stdout.split('\n').map(Number);
};

// 큐 루프를 통째로 돌리는 하네스. `gh` 호출을 픽스처 파일 조회로 대체해 후보별 게이트와
// 건너뛰기를 실측한다. runNumber는 실행 컨텍스트 주입값이며 결과가 여기 좌우되면 안 된다.
const makeRunQueue =
  (queueLoop, budgetConstants) =>
  (prs, { runNumber = 0, window = null, offset = null, remaining = [5000] } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'automerge-queue-loop-'));
  const log = join(dir, 'gh.log');
  // 잔량은 호출 순서대로 소비하고 목록이 끝나면 마지막 값을 반복한다. 루프 안 재확인이
  // 실제로 다시 읽는지 보려면 실행 도중 값이 바뀌어야 한다.
  writeFileSync(join(dir, 'rates'), `${remaining.join('\n')}\n`);
  for (const pr of prs) {
    const head = String(pr.number).padStart(40, '0');
    writeFileSync(
      join(dir, `pr-${pr.number}.json`),
      JSON.stringify({
        state: pr.state ?? 'OPEN',
        isDraft: false,
        baseRefName: 'main',
        labels: [{ name: 'automerge' }],
        headRefName: `feature-${pr.number}`,
        headRefOid: head,
        headRepository: { nameWithOwner: 'o/r' },
        mergeStateStatus: pr.mergeStateStatus,
      }),
    );
    writeFileSync(
      join(dir, `reviews-${pr.number}.json`),
      JSON.stringify(
        pr.reviewed === false
          ? []
          : [
              {
                id: 1,
                state: 'APPROVED',
                submitted_at: '2026-08-01T00:00:00Z',
                commit_id: head,
                author_association: 'OWNER',
                body: '',
                user: { login: 'reviewer', type: 'User' },
              },
            ],
      ),
    );
    writeFileSync(
      join(dir, `comments-${pr.number}.json`),
      JSON.stringify(
        pr.authorized === false
          ? []
          : [
              {
                id: 9,
                body: `<!-- Automerge frozen discovery authorization: ${head} -->`,
                user: { login: 'github-actions[bot]', id: 41898282, type: 'Bot' },
              },
            ],
      ),
    );
    writeFileSync(
      join(dir, `threads-${pr.number}.json`),
      JSON.stringify({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes: pr.unresolvedThread ? [{ isResolved: false }] : [],
                pageInfo: { hasNextPage: false },
              },
            },
          },
        },
      }),
    );
    // `pending`은 conclusion이 null인 상태다. null 병합 연산자로 접으면 success로 새므로
    // 명시 분기로 둔다.
    const conclusion =
      pr.checkState === 'failure' ? 'failure' : pr.checkState === 'pending' ? null : 'success';
    writeFileSync(
      join(dir, `checks-${head}.json`),
      JSON.stringify({
        check_runs:
          pr.checkState === 'missing'
            ? []
            : [
                {
                  id: 1,
                  name: 'Data contracts',
                  conclusion,
                  started_at: '2026-08-01T00:00:00Z',
                },
              ],
      }),
    );
    writeFileSync(join(dir, `statuses-${head}.json`), JSON.stringify([]));
  }
  const script = [
    'set -euo pipefail',
    `GH_LOG=${JSON.stringify(log)}`,
    `FIX=${JSON.stringify(dir)}`,
    `GITHUB_RUN_NUMBER=${JSON.stringify(String(runNumber))}`,
    ': > "$GH_LOG"',
    'gh() {',
    `  printf '%s\\n' "gh $*" >> "$GH_LOG"`,
    '  local all="$*"',
    '  case "$all" in',
    // 잔량 조회의 jq 프로그램이 `.resources.graphql.remaining`을 담고 있어 아래
    // `*graphql*`에 먼저 걸린다. 좁은 패턴을 앞에 둔다. 스텁은 `--jq` 적용 결과를 낸다.
    '    *rate_limit*)',
    '      rn=$(cat "$FIX/ratecount" 2>/dev/null || printf 0); rn=$((rn + 1))',
    '      printf %s "$rn" > "$FIX/ratecount"',
    '      rv="$(sed -n "${rn}p" "$FIX/rates")"',
    '      [ -n "$rv" ] || rv="$(tail -1 "$FIX/rates")"',
    `      printf '%s\\n' "$rv" ;;`,
    `    "pr list"*) printf '%s\\n' ${JSON.stringify(JSON.stringify(prs.map((p) => p.number)))} ;;`,
    // BEHIND 경로의 bounded wait는 같은 `gh pr view`를 `--json headRefOid`로 부른다.
    // 두 호출을 한 패턴으로 잡으면 new_head에 JSON 문서 전체가 들어가고, 테스트가
    // 잘못된 이유로 통과한다. 좁은 패턴을 먼저 둔다.
    '    "pr view "*"--json headRefOid"*) set -- $all; jq -r ".headRefOid" "$FIX/pr-$3.json" ;;',
    '    "pr view "*) set -- $all; cat "$FIX/pr-$3.json" ;;',
    '    *pulls/*/reviews*) n="${all#*pulls/}"; n="${n%%/reviews*}"; cat "$FIX/reviews-$n.json" ;;',
    '    *issues/*/comments*) n="${all#*issues/}"; n="${n%%/comments*}"; cat "$FIX/comments-$n.json" ;;',
    // marker 복구 판정용 PR commit set. 이벤트 픽스처가 없으므로 복구는 fail-closed로 끝난다.
    `    *pulls/*/commits*) n="\${all#*pulls/}"; n="\${n%%/commits*}"; printf '[{"sha":"%040d"}]\\n' "$n" ;;`,
    '    *issues/*/events*) return 1 ;;',
    '    *graphql*) n="${all#*number=}"; n="${n%% *}"; cat "$FIX/threads-$n.json" ;;',
    '    *check-runs*) h="${all#*commits/}"; h="${h%%/check-runs*}"; cat "$FIX/checks-$h.json" ;;',
    '    *statuses*) h="${all#*commits/}"; h="${h%%/statuses*}"; cat "$FIX/statuses-$h.json" ;;',
    // 응답이 필요 없는 실제 동작. 로그에만 남기고 조용히 성공한다.
    '    "pr merge"* | "pr edit"* | *update-branch* | "workflow run"*) ;;',
    // 기본 분기가 없으면 워크플로가 새 gh 호출을 늘렸을 때 스텁이 빈 출력 + 종료 코드 0을
    // 낸다. 큐 루프는 그것을 "빈 API 응답"으로 읽고 후보를 건너뛰므로, 하네스가 덮지 못한
    // 호출이 조용히 통과한다. 실패시켜 즉시 드러낸다.
    `    *) printf 'unstubbed gh call: %s\\n' "$all" >&2; return 1 ;;`,
    '  esac',
    '}',
    'sleep() { :; }',
    'repo=o/r',
    'MERGE_GH_TOKEN=merge-token',
    'HAS_AUTOMERGE_PAT=false',
    'owner=o',
    'name=r',
    `required='[{"context":"Data contracts","integration_id":null}]'`,
    'candidates="$(gh pr list)"',
    budgetConstants,
    ...(window === null ? [] : [`window=${window}`]),
    ...(offset === null ? [] : [`offset=${offset}`]),
    dedent(queueLoop),
  ].join('\n');
  const result = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
  const calls = existsSync(log) ? readFileSync(log, 'utf8') : '';
  const merged = calls.match(/gh pr merge [^\n]*?(\d+) --repo/)?.[1];
  return {
    status: result.status,
    mergedPr: merged ? Number(merged) : null,
    // 후보 평가 1건당 1회만 세야 한다. bounded wait의 headRefOid 조회까지 세면 같은
    // 후보가 두 번 잡혀 "실행당 실제 동작 최대 한 건" 계약이 헐거워진다.
    evaluated: [...calls.matchAll(/gh pr view (\d+) --repo [^\n]*--json baseRefName/g)].map((m) =>
      Number(m[1]),
    ),
    removedLabels: [...calls.matchAll(/gh pr edit (\d+) --repo o\/r --remove-label automerge/g)].map(
      (m) => Number(m[1]),
    ),
    updatedBranch: calls.includes('update-branch'),
    dispatchedCi: calls.includes('workflow run ci.yml'),
    rateCalls: (calls.match(/gh api rate_limit/g) ?? []).length,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
};

test('막힌 후보는 뒤의 후보를 굶기지 않고 게이트는 후보별로 그대로 강제된다', async () => {
  const workflow = await readWorkflow();
  const queueLoop = workflow.match(
    /# queue-loop-begin\n([\s\S]*?)\n\s+# queue-loop-end/,
  )?.[1];
  assert.ok(queueLoop, 'queue loop must stay testable');
  const runQueue = makeRunQueue(queueLoop, budgetConstantsOf(workflow));

  // 큐 head가 BLOCKED이어도 뒤의 병합 가능한 후보가 처리된다. 이것이 이 설계의 핵심이다.
  assert.equal(
    runQueue([
      { number: 1, mergeStateStatus: 'BLOCKED' },
      { number: 2, mergeStateStatus: 'CLEAN' },
    ]).mergedPr,
    2,
  );
  // 충돌한 후보도 뒤를 막지 않는다.
  const dirtyQueue = runQueue([
    { number: 1, mergeStateStatus: 'DIRTY' },
    { number: 2, mergeStateStatus: 'CLEAN' },
  ]);
  assert.equal(dirtyQueue.mergedPr, 2);
  // 계약 위반이 신호 없이 묻히면 안 된다.
  assert.match(dirtyQueue.stdout + dirtyQueue.stderr, /::warning::/);
  // 게이트는 후보별로 그대로 강제된다 — 리뷰 객체가 없는 후보는 병합되지 않는다.
  assert.equal(
    runQueue([
      { number: 1, mergeStateStatus: 'CLEAN', reviewed: false },
      { number: 2, mergeStateStatus: 'CLEAN' },
    ]).mergedPr,
    2,
  );
  // 미해결 thread가 있는 후보도 건너뛴다.
  assert.equal(
    runQueue([
      { number: 1, mergeStateStatus: 'CLEAN', unresolvedThread: true },
      { number: 2, mergeStateStatus: 'CLEAN' },
    ]).mergedPr,
    2,
  );
  // required context가 실패·대기·미부착인 후보도 각각 건너뛴다.
  for (const checkState of ['failure', 'pending', 'missing']) {
    assert.equal(
      runQueue([
        { number: 1, mergeStateStatus: 'CLEAN', checkState },
        { number: 2, mergeStateStatus: 'CLEAN' },
      ]).mergedPr,
      2,
      `required context ${checkState} must skip only that candidate`,
    );
  }
  // BEHIND이고 required context가 없어도 coordinator가 head를 만들지 않는다. owner가
  // rebase/push할 후보만 건너뛰고 뒤의 CLEAN 후보를 처리한다.
  const behindMissing = runQueue([
    { number: 1, mergeStateStatus: 'BEHIND', checkState: 'missing' },
    { number: 2, mergeStateStatus: 'CLEAN' },
  ]);
  assert.equal(behindMissing.status, 0);
  assert.equal(behindMissing.updatedBranch, false);
  assert.equal(behindMissing.dispatchedCi, false);
  assert.equal(behindMissing.mergedPr, 2);
  assert.deepEqual(behindMissing.evaluated, [1, 2]);
  assert.match(
    behindMissing.stdout + behindMissing.stderr,
    /owning SSD worktree must rebase and push a native PR head when behind/,
  );

  // required context 부재도 owner의 native CI가 해결한다. coordinator는 dispatch하지 않고
  // 뒤의 병합 가능한 후보를 계속 평가한다.
  const missingContext = runQueue([
    { number: 1, mergeStateStatus: 'CLEAN', checkState: 'missing' },
    { number: 2, mergeStateStatus: 'CLEAN' },
  ]);
  assert.equal(missingContext.dispatchedCi, false);
  assert.equal(missingContext.mergedPr, 2);
  assert.match(missingContext.stdout + missingContext.stderr, /or push a native PR head otherwise/);
  // 게이트를 통과한 가장 오래된 후보가 우선한다(best-effort FIFO).
  assert.equal(
    runQueue([
      { number: 1, mergeStateStatus: 'CLEAN' },
      { number: 2, mergeStateStatus: 'CLEAN' },
    ]).mergedPr,
    1,
  );
  // 실제 동작은 한 실행에 최대 한 건이다. 병합 직렬화가 유지되어야 한다.
  const serialized = runQueue([
    { number: 1, mergeStateStatus: 'CLEAN' },
    { number: 2, mergeStateStatus: 'CLEAN' },
  ]);
  assert.equal(serialized.evaluated.length, 1, '병합하면 그 실행은 거기서 끝난다');
  const behind = runQueue([
    { number: 1, mergeStateStatus: 'BEHIND' },
    { number: 2, mergeStateStatus: 'CLEAN' },
  ]);
  assert.equal(behind.status, 0);
  assert.equal(behind.mergedPr, 2);
  assert.deepEqual(behind.evaluated, [1, 2]);
  assert.deepEqual(behind.removedLabels, [1]);
  assert.equal(behind.updatedBranch, false);
  assert.equal(behind.dispatchedCi, false);
  assert.match(behind.stdout + behind.stderr, /owning SSD worktree must rebase and push/);
  // 아무 후보도 병합할 수 없으면 병합 없이 성공으로 끝난다. 라벨은 건드리지 않는다.
  const allBlocked = runQueue([
    { number: 1, mergeStateStatus: 'BLOCKED' },
    { number: 2, mergeStateStatus: 'DIRTY' },
  ]);
  assert.equal(allBlocked.status, 0);
  assert.equal(allBlocked.mergedPr, null);
  assert.equal(allBlocked.evaluated.length, 2);
  assert.deepEqual(allBlocked.removedLabels, []);
});

test('후보 창은 API 지분·timeout·실측 큐 깊이 세 기준으로 유도되고 모든 후보에 도달한다', async () => {
  const workflow = await readWorkflow();

  // 창 크기는 이 저장소 값으로 다시 계산해야 한다. 형제 저장소 상수(backend 6, mobile 20)를
  // 그대로 쓰면 실행당 청구가 이 저장소가 허용하기로 한 지분을 넘는다.
  const declaredWindow = declaredWindowOf(workflow);
  assert.equal(declaredWindow, 3, 'window ceiling must stay pinned to the derived value');
  const rationale = workflow.slice(
    workflow.indexOf('# queue-loop-begin'),
    workflow.indexOf('# candidate-budget-begin'),
  );
  // 근거는 세 기준을 모두 담아야 한다. 하나만 적으면 다음 사람이 다른 쪽을 모른 채 값을 바꾼다.
  for (const basis of [
    '저장소당 시간당 1,000회',
    '10분(600초)',
    '후보 한 건당',
    '고정 비용',
    '실측 큐 깊이',
    // 빈도가 아니라 실측으로 정한다는 것.
    'GET /rate_limit',
    'cancel-in-progress: false',
    // 같은 한도를 쓰는 데이터팩 체인 몫을 왜 떼는지.
    'producer dispatch',
    'Data Pack Release',
  ]) {
    assert.ok(rationale.includes(basis), `window rationale missing: ${basis}`);
  }
  // 실행 빈도 가정으로 되돌아가면 안 된다. concurrency는 대기 실행만 접을 뿐 실행이
  // 시작되는 빈도에 상한을 두지 않으므로, "N회/시"에서 유도한 상한은 강제되지 않는다.
  assert.doesNotMatch(
    rationale,
    /회\/시/,
    'window must not be derived from an assumed invocation rate',
  );

  // 창 선택 자체. 어떤 시작점에서든 선택 수는 window 이하이고 오래된 순이며,
  // 시작점 전체를 훑으면 모든 후보가 최소 한 번은 창에 들어온다.
  const windowProgram = workflow.match(WINDOW_PROGRAM_RE)?.[1];
  assert.ok(windowProgram, 'candidate window jq program must stay testable');
  const pickWindow = makePickWindow(windowProgram, declaredWindow);
  // 빈 큐에서 죽지 않는다.
  assert.deepEqual(pickWindow(0, 0), []);
  for (const total of [declaredWindow + 1, declaredWindow * 2]) {
    const reachable = new Set();
    for (let offset = 0; offset < total; offset += 1) {
      const slice = pickWindow(total, offset);
      assert.ok(slice.length <= declaredWindow, `window exceeded at total=${total}`);
      assert.deepEqual(
        slice,
        [...slice].sort((a, b) => a - b),
        `candidate window must stay oldest-first at total=${total}`,
      );
      for (const index of slice) reachable.add(index);
    }
    assert.equal(
      reachable.size,
      total,
      `every candidate must be reachable from some offset at total=${total}`,
    );
  }
});

test('창은 실측 잔량에서 정해지고 예약분 아래로는 큐를 돌리지 않는다', async () => {
  const workflow = await readWorkflow();
  const budgetBlock = workflow.match(BUDGET_BLOCK_RE)?.[1];
  assert.ok(budgetBlock, 'candidate budget block must stay testable');

  // 잔량은 이 job이 실제로 쓰는 토큰에서 읽어야 한다. 한도값을 상수로 들고 있으면
  // 실행 빈도 가정으로 되돌아간 것과 같다.
  assert.ok(budgetBlock.includes('gh api rate_limit'), 'budget must be measured, not assumed');
  // 후보 평가는 REST와 GraphQL을 함께 쓴다. 한쪽만 보면 다른 버킷이 먼저 마른다.
  assert.ok(budgetBlock.includes('.resources.core.remaining'));
  assert.ok(budgetBlock.includes('.resources.graphql.remaining'));

  const windowMax = budgetConstantOf(workflow, 'window_max');
  const reserve = budgetConstantOf(workflow, 'reserve');
  const fixedCost = budgetConstantOf(workflow, 'fixed_cost');
  const perCandidate = budgetConstantOf(workflow, 'per_candidate');
  assert.equal(windowMax, 3);
  // 예약분은 producer 판정 스텝의 정상 경로 4회 * 100회 실행분이다. 이 저장소는 같은
  // 한도를 Data Pack Release가 함께 쓰므로 형제 저장소(300)보다 크다.
  assert.equal(reserve, 400, 'data pack chain reserve must stay pinned');
  assert.equal(fixedCost, 16);
  assert.equal(perCandidate, 17, 'per-candidate charge must match the page-capped reads');

  // 응답 payload를 주고 워크플로의 jq 질의를 실제 jq로 적용해 `gh --jq`를 그대로 흉내낸다.
  const runBudget = (stub) =>
    spawnSync(
      'bash',
      [
        '-c',
        [
          'set -euo pipefail',
          `gh() { ${stub} }`,
          dedent(budgetBlock),
          `printf 'window=%s\\n' "$window"`,
        ].join('\n'),
      ],
      { encoding: 'utf8' },
    );
  const runPayload = (payload) =>
    runBudget(`printf '%s' ${JSON.stringify(JSON.stringify(payload))} | jq -r "\${budget_query}";`);
  const buckets = (core, graphql) => ({
    resources: { core: { remaining: core }, graphql: { remaining: graphql } },
  });
  const windowAt = (remaining) => runPayload(buckets(remaining, remaining));

  // 기대값은 워크플로 상수로 되계산하지 않고 고정한다. 유도식을 바꾸는 것은 결정이므로
  // 테스트도 함께 고쳐야 한다.
  for (const [remaining, expected] of [
    [5000, 3],
    [1000, 3],
    [467, 3],
    [466, 2],
    [450, 2],
    [433, 1],
  ]) {
    const result = windowAt(remaining);
    assert.equal(result.status, 0, `budget block failed at remaining=${remaining}: ${result.stderr}`);
    assert.equal(
      result.stdout.trim(),
      `window=${expected}`,
      `window must follow the measured budget at remaining=${remaining}`,
    );
    // 핵심 불변식. 이번 실행이 계획한 지출을 다 써도 예약분은 남는다 — 같은 한도를 쓰는
    // producer dispatch가 큐 때문에 멈추지 않는다.
    assert.ok(
      remaining - fixedCost - perCandidate * expected >= reserve,
      `queue must never plan to spend into the reserve at remaining=${remaining}`,
    );
    assert.ok(expected <= windowMax, `window must stay under the ceiling at remaining=${remaining}`);
  }

  // 두 버킷 값이 다르면 작은 쪽이 창을 정한다.
  assert.equal(runPayload(buckets(5000, 450)).stdout.trim(), 'window=2');
  assert.equal(runPayload(buckets(450, 5000)).stdout.trim(), 'window=2');

  // 예약분에 닿으면 큐만 건너뛴다. 실행을 실패시키지 않는다 — producer 스텝은 이미 끝났고
  // 실패로 남기면 그 check가 다음 판정 입력을 오염시킨다.
  for (const remaining of [432, 420, 400, 0]) {
    const result = windowAt(remaining);
    assert.equal(result.status, 0, `budget block must not fail at remaining=${remaining}`);
    assert.match(result.stdout, /::warning::/, `low budget must be announced at remaining=${remaining}`);
    assert.doesNotMatch(
      result.stdout,
      /window=/,
      `queue must not run below the reserve at remaining=${remaining}`,
    );
  }

  // 잔량을 모르면 쓰지 않는다. 한쪽 버킷만 깨져도 마찬가지다.
  for (const [label, stub] of [
    ['core만 null', `printf '%s' ${JSON.stringify(JSON.stringify(buckets(null, 5000)))} | jq -r "\${budget_query}";`],
    ['graphql만 null', `printf '%s' ${JSON.stringify(JSON.stringify(buckets(5000, null)))} | jq -r "\${budget_query}";`],
    ['graphql 버킷 부재', `printf '%s' ${JSON.stringify(JSON.stringify({ resources: { core: { remaining: 5000 } } }))} | jq -r "\${budget_query}";`],
    ['core 값이 문자열', `printf '%s' ${JSON.stringify(JSON.stringify(buckets('5000', 5000)))} | jq -r "\${budget_query}";`],
    ['resources 부재', `printf '%s' '{}' | jq -r "\${budget_query}";`],
    ['빈 응답', "printf '';"],
    ['비숫자 응답', "printf '%s\\n' null;"],
    ['조회 실패', 'return 1;'],
  ]) {
    const result = runBudget(stub);
    assert.equal(result.status, 0, `budget block must not fail on ${label}`);
    assert.match(result.stdout, /::warning::/, `unknown budget must be announced on ${label}`);
    assert.doesNotMatch(result.stdout, /window=/, `queue must not run on ${label}`);
  }
});

test('후보 순회 중에도 잔량을 다시 읽어 예약분에서 멈춘다', async () => {
  const workflow = await readWorkflow();
  const queueLoop = workflow.match(
    /# queue-loop-begin\n([\s\S]*?)\n\s+# queue-loop-end/,
  )?.[1];
  assert.ok(queueLoop, 'queue loop must stay testable');
  const runQueue = makeRunQueue(queueLoop, budgetConstantsOf(workflow));

  // 재확인은 그 후보에 요청을 쓰기 전에 와야 한다. 뒤에 두면 이미 쓴 뒤에 멈춘다.
  const recheck = workflow.match(
    /# budget-recheck-begin\n([\s\S]*?)\n\s+# budget-recheck-end/,
  )?.[1];
  assert.ok(recheck, 'budget recheck block must stay testable');
  assert.ok(recheck.includes('gh api rate_limit'), 'recheck must re-measure, not reuse the draw');
  const recheckAt = workflow.indexOf('# budget-recheck-begin');
  const firstViewAt = workflow.indexOf('info="$(gh pr view');
  assert.ok(recheckAt > 0 && firstViewAt > recheckAt, 'recheck must precede the candidate request');

  const queue = [
    { number: 1, mergeStateStatus: 'BLOCKED' },
    { number: 2, mergeStateStatus: 'BLOCKED' },
    { number: 3, mergeStateStatus: 'CLEAN' },
  ];

  // 잔량이 충분하면 셋 다 평가하고 마지막 후보를 병합한다.
  const plenty = runQueue(queue, { remaining: [5000] });
  assert.equal(plenty.status, 0);
  assert.deepEqual(plenty.evaluated, [1, 2, 3]);
  assert.equal(plenty.mergedPr, 3);
  // 창 산출 1회 + 후보 3건 재확인 3회.
  assert.equal(plenty.rateCalls, 4, 'budget must be re-measured once per candidate');

  // 창을 정할 때는 넉넉했는데 순회 중 예약분에 닿으면, 첫 후보에 요청을 쓰기 전에 멈춘다.
  const drained = runQueue(queue, { remaining: [5000, 420] });
  assert.equal(drained.status, 0, 'reserve stop must not fail the run');
  assert.deepEqual(drained.evaluated, [], 'no candidate may be evaluated below the reserve');
  assert.equal(drained.mergedPr, null);
  assert.match(drained.stdout + drained.stderr, /::warning::/);

  // 한 건을 평가한 뒤 바닥나면 거기서 멈춘다. 뒤의 병합 가능 후보는 다음 실행 몫이다.
  const midway = runQueue(queue, { remaining: [5000, 5000, 420] });
  assert.equal(midway.status, 0);
  assert.deepEqual(midway.evaluated, [1], 'evaluation must stop at the reserve boundary');
  assert.equal(midway.mergedPr, null);

  // 순회 중 잔량을 못 읽는 것도 소진과 같게 다룬다.
  const unknown = runQueue(queue, { remaining: [5000, 'null'] });
  assert.equal(unknown.status, 0, 'unknown budget must not fail the run');
  assert.deepEqual(unknown.evaluated, []);
  assert.match(unknown.stdout + unknown.stderr, /::warning::/);
});

test('창 시작점은 실행 컨텍스트를 읽지 않고 실행마다 새로 뽑힌다', async () => {
  const workflow = await readWorkflow();
  const declaredWindow = declaredWindowOf(workflow);

  // 커버리지 보장이 실행 간격에 의존하지 않으려면 시작점이 실행 컨텍스트 값의 함수가
  // 아니어야 한다.
  const offsetBlock = workflow.match(
    /# candidate-offset-begin\n([\s\S]*?)\n\s+# candidate-offset-end/,
  )?.[1];
  assert.ok(offsetBlock, 'candidate offset block must stay testable');
  assert.doesNotMatch(
    offsetBlock,
    /GITHUB_RUN_NUMBER|GITHUB_RUN_ID|GITHUB_RUN_ATTEMPT|GITHUB_SHA|GITHUB_EVENT/,
    'candidate offset must not depend on run context',
  );

  const drawOffset = (total, runNumber) => {
    const result = spawnSync(
      'bash',
      [
        '-c',
        [
          'set -euo pipefail',
          `GITHUB_RUN_NUMBER=${JSON.stringify(String(runNumber))}`,
          // 창 크기는 앞선 예산 블록이 정한다. 여기서는 주입값으로 시작점만 본다.
          `window=${declaredWindow}`,
          `candidates=${JSON.stringify(
            JSON.stringify(Array.from({ length: total }, (_, index) => index)),
          )}`,
          dedent(offsetBlock),
          `printf '%s %s\\n' "$window" "$offset"`,
        ].join('\n'),
      ],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 0, `offset block failed: ${result.stderr}`);
    const [drawnWindow, offset] = result.stdout.trim().split(' ').map(Number);
    assert.equal(drawnWindow, declaredWindow, 'offset draw must not resize the window');
    return offset;
  };

  // 창 안에 다 들어오면 회전하지 않는다. 빈 큐에서도 죽지 않는다.
  for (const total of [0, 1, declaredWindow]) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      assert.equal(drawOffset(total, attempt), 0, `must not rotate at total=${total}`);
    }
  }

  // total > window면 시작점이 실행마다 새로 뽑히고 범위 안에 있다. run number를 고정해
  // 두는 것은 최악의 앨리어싱 입력(간격 0)이며, 그래도 성질이 유지되어야 한다.
  const rotationTotal = 2 * declaredWindow;
  const samples = 64;
  const drawn = [];
  for (let attempt = 0; attempt < samples; attempt += 1) {
    drawn.push(drawOffset(rotationTotal, 7));
  }
  for (const offset of drawn) {
    assert.ok(
      Number.isInteger(offset) && offset >= 0 && offset < rotationTotal,
      `offset out of range: ${offset}`,
    );
  }
  assert.ok(
    new Set(drawn).size > 1,
    'candidate offset must vary across executions even with a fixed run number',
  );
  // 뽑힌 시작점들의 창 합집합이 전 후보를 덮는다. 표본 성질이라 실패 확률이 0은 아니지만,
  // 후보 하나가 한 표본에서 빠질 확률이 1 - window/total = 1/2이므로 64회에서 누락
  // 확률은 total * 2^-64 수준이다.
  const windowProgram = workflow.match(WINDOW_PROGRAM_RE)?.[1];
  assert.ok(windowProgram, 'candidate window jq program must stay testable');
  const pickWindow = makePickWindow(windowProgram, declaredWindow);
  const covered = new Set();
  for (const offset of drawn) {
    for (const index of pickWindow(rotationTotal, offset)) covered.add(index);
  }
  assert.equal(covered.size, rotationTotal, 'drawn offsets must cover the whole queue');
});

test('창 밖 후보 도달 가능성은 시작점을 주입해 결정적으로 고정한다', async () => {
  const workflow = await readWorkflow();
  const declaredWindow = declaredWindowOf(workflow);
  const queueLoop = workflow.match(
    /# queue-loop-begin\n([\s\S]*?)\n\s+# queue-loop-end/,
  )?.[1];
  assert.ok(queueLoop, 'queue loop must stay testable');
  const runQueue = makeRunQueue(queueLoop, budgetConstantsOf(workflow));
  // 시작점 산출을 뺀 뒷부분만 뽑는다. 큐 루프 전체를 쓰면 주입한 값을 난수 draw가 덮어써
  // 이 테스트가 다시 표본이 된다.
  const candidateLoop = workflow.match(
    /# candidate-offset-end\n([\s\S]*?)\n\s+# queue-loop-end/,
  )?.[1];
  assert.ok(candidateLoop, 'candidate loop must stay testable');
  assert.doesNotMatch(
    candidateLoop,
    /RANDOM/,
    'injected offsets must not be overwritten by the draw',
  );
  const runCandidateLoop = makeRunQueue(candidateLoop, budgetConstantsOf(workflow));
  const windowProgram = workflow.match(WINDOW_PROGRAM_RE)?.[1];
  assert.ok(windowProgram, 'candidate window jq program must stay testable');
  const pickWindow = makePickWindow(windowProgram, declaredWindow);

  // 굶주림 제거는 두 성질의 곱이고, 둘은 성격이 달라 따로 고정해야 한다.
  //   ① 도달 가능성(결정적): 어떤 시작점에서 그 후보가 실제로 평가되고 병합되는가.
  //   ② 시작점 분포(표본·구조): 위 '창 시작점은 …' 테스트가 담당한다.
  const rotationTotal = 2 * declaredWindow;
  const aliasingQueue = [];
  for (let number = 1; number < rotationTotal; number += 1) {
    aliasingQueue.push({ number, mergeStateStatus: 'CLEAN', state: 'CLOSED' });
  }
  aliasingQueue.push({ number: rotationTotal, mergeStateStatus: 'CLEAN' });

  const mergedFrom = [];
  for (let offset = 0; offset < rotationTotal; offset += 1) {
    const run = runCandidateLoop(aliasingQueue, { window: declaredWindow, offset });
    assert.equal(run.status, 0, `offset=${offset}에서 실행이 실패했다: ${run.stderr}`);
    if (run.mergedPr === rotationTotal) mergedFrom.push(offset);
  }

  // 그 후보를 병합하는 시작점이 하나라도 있어야 한다. 창을 큐 앞쪽에 고정하면 여기가 빈다.
  assert.ok(
    mergedFrom.length > 0,
    'the only mergeable candidate sits past the window and must be reachable from some offset',
  );
  // 창 선택과 루프 동작이 일치해야 한다.
  const windowContains = [];
  for (let offset = 0; offset < rotationTotal; offset += 1) {
    if (pickWindow(rotationTotal, offset).includes(rotationTotal - 1)) windowContains.push(offset);
  }
  assert.deepEqual(
    mergedFrom,
    windowContains,
    'the offsets that merge the late candidate must be exactly the offsets whose window contains it',
  );
  assert.equal(
    mergedFrom.length,
    declaredWindow,
    'reachable offsets must equal the window size (probability = window / total)',
  );

  // 후보가 창 안에 다 들어오면 시작점 산출이 회전하지 않으므로, 실행 번호와 무관하게
  // 오래된 후보가 먼저 병합된다.
  for (const runNumber of [0, 7, 40]) {
    assert.equal(
      runQueue(
        [
          { number: 1, mergeStateStatus: 'CLEAN' },
          { number: 2, mergeStateStatus: 'CLEAN' },
        ],
        { runNumber },
      ).mergedPr,
      1,
    );
  }
});

test('draft 필터는 창 산출 이전에 적용된다', async () => {
  const workflow = await readWorkflow();
  const declaredWindow = declaredWindowOf(workflow);

  // 순서 계약. draft 필터가 창 뒤로 밀리면 draft가 창 자리를 차지해 실제로 평가되는
  // 후보 수가 window보다 줄어든다.
  const candidatesAt = workflow.indexOf('candidates="$(gh pr list');
  const budgetAt = workflow.indexOf('# candidate-budget-begin');
  const offsetAt = workflow.indexOf('# candidate-offset-begin');
  const windowAt = workflow.indexOf('# candidate-window-begin');
  assert.ok(candidatesAt > 0, 'candidate selection must stay findable');
  assert.ok(budgetAt > candidatesAt, 'draft filter must run before the budget draw');
  assert.ok(offsetAt > budgetAt, 'window size must be settled before the offset draw');
  assert.ok(windowAt > offsetAt, 'draft filter must run before the window slice');

  const selectProgram = workflow.match(
    /--jq '(\[\.\[\] \| select\(\.isDraft == false\)\] \| \[sort_by\(\.createdAt\)\[\]\.number\])'/,
  )?.[1];
  assert.ok(selectProgram, 'candidate selection jq program must stay testable');

  // draft가 섞인 목록. non-draft만 오래된 순으로 남아야 한다.
  const raw = [];
  for (let index = 0; index < declaredWindow * 2; index += 1) {
    raw.push({
      number: index + 1,
      createdAt: `2026-08-01T00:${String(index).padStart(2, '0')}:00Z`,
      isDraft: index % 2 === 1,
    });
  }
  const selected = spawnSync('jq', ['-c', selectProgram], {
    input: JSON.stringify(raw),
    encoding: 'utf8',
  }).stdout.trim();
  const expected = raw.filter((pr) => !pr.isDraft).map((pr) => pr.number);
  assert.equal(selected, JSON.stringify(expected));

  // 걸러진 목록을 그대로 시작점 산출에 넣는다.
  const offsetBlock = workflow.match(
    /# candidate-offset-begin\n([\s\S]*?)\n\s+# candidate-offset-end/,
  )?.[1];
  assert.ok(offsetBlock, 'candidate offset block must stay testable');
  assert.ok(
    offsetBlock.includes('<<<"${candidates}"'),
    'offset draw must read the draft-filtered candidate list',
  );
  const drawn = spawnSync(
    'bash',
    [
      '-c',
      [
        'set -euo pipefail',
        `window=${declaredWindow}`,
        `candidates=${JSON.stringify(selected)}`,
        dedent(offsetBlock),
        `printf '%s %s\\n' "$total" "$offset"`,
      ].join('\n'),
    ],
    { encoding: 'utf8' },
  );
  assert.equal(drawn.status, 0, drawn.stderr);
  assert.equal(drawn.stdout.trim(), `${expected.length} 0`);
});

test('data pack producer는 head_sha로 판정하고 실패해도 큐를 멈추지 않는다', async () => {
  const workflow = await readWorkflow();

  const producerBlock = workflow.match(
    /# producer-dispatch-begin\n([\s\S]*?)\n\s+# producer-dispatch-end/,
  )?.[1];
  assert.ok(producerBlock, 'producer dispatch block must stay testable');
  // 중복·누락을 동시에 막는 판정 키는 workflow runs API의 head_sha다.
  assert.ok(producerBlock.includes('head_sha=${main_sha}'));
  assert.ok(producerBlock.includes('gh workflow run "${producer}"'));
  // push 트리거가 만들던 실행과 같은 입력이어야 한다.
  assert.ok(producerBlock.includes('-f mode=exploratory'));
  assert.ok(producerBlock.includes('-f targetChannel=dev'));
  assert.ok(producerBlock.includes('tools/datapack/fixtures/candidate-build-spec.json'));
  // allowGaps를 생략하면 producer의 기본값 분기가 dispatch 경로에서만 false로 뒤집힌다.
  assert.ok(
    producerBlock.includes('"allowGaps":"true"'),
    'dispatch must pin allowGaps to the value the push path used',
  );
  // 판정은 exploratory가 되는 실행 경로만 센다.
  assert.ok(producerBlock.includes('producer_attempts_filter='));
  assert.ok(producerBlock.includes('.triggering_actor.login == "github-actions[bot]"'));
  // release·rollback 모드를 코디네이터가 자동으로 쏘면 안 된다.
  assert.doesNotMatch(producerBlock, /mode=(production-publish|release-candidate|rollback|rollout-update)/);
  const attemptLimit = Number(workflow.match(/attempt_limit=(\d+)/)?.[1]);
  assert.ok(Number.isInteger(attemptLimit) && attemptLimit >= 1, 'attempt limit must stay declared');
  // 기준점 선택 규칙은 워크플로에서 읽어 스텁에 그대로 주입한다.
  const baselineSuffix = workflow.match(
    /--jq "\$\{producer_attempts_filter\}"'([^']*)'\)" \|\| base_sha=""/,
  )?.[1];
  assert.ok(baselineSuffix, 'baseline selection program must stay testable');
  assert.ok(
    baselineSuffix.includes('map(select(.conclusion == "success"))'),
    'baseline must be the last successful eligible run',
  );

  // runs: [{ status, conclusion }]
  const runProducer = ({
    runs = [],
    mainSha = 'a'.repeat(40),
    baseSha = 'b'.repeat(40),
    baselineRuns = null,
    changed = 'yes',
    compareFails = false,
    dispatchFails = false,
    appearsAfterDispatch = true,
  } = {}) => {
    const dir = mkdtempSync(join(tmpdir(), 'producer-dispatch-'));
    const dispatched = join(dir, 'dispatched');
    // event·triggering_actor 기본값은 "이 코디네이터가 쏜 dispatch"다. 판정에서 제외돼야
    // 하는 실행(schedule, 사람이 쏜 dispatch)은 케이스마다 명시한다.
    const runRecords = runs.map((run, index) => ({
      id: index + 1,
      status: run.status,
      conclusion: run.conclusion ?? null,
      event: run.event ?? 'workflow_dispatch',
      triggering_actor: { login: run.actor ?? 'github-actions[bot]' },
    }));
    writeFileSync(join(dir, 'runs.json'), JSON.stringify({ workflow_runs: runRecords }));
    // baseline 목록은 새 실행이 앞에 오는 API 정렬을 그대로 흉내낸다.
    writeFileSync(
      join(dir, 'baseline.json'),
      JSON.stringify({
        workflow_runs: (baselineRuns ?? [
          { head_sha: baseSha, conclusion: 'success', event: 'push' },
        ]).map((run, index) => ({
          id: 500 + index,
          head_sha: run.head_sha,
          status: 'completed',
          conclusion: run.conclusion ?? 'success',
          event: run.event ?? 'push',
          triggering_actor: { login: run.actor ?? 'github-actions[bot]' },
        })),
      }),
    );
    writeFileSync(
      join(dir, 'runs-after.json'),
      JSON.stringify({
        workflow_runs: [
          ...runRecords,
          {
            id: 9999,
            status: 'queued',
            conclusion: null,
            event: 'workflow_dispatch',
            triggering_actor: { login: 'github-actions[bot]' },
          },
        ],
      }),
    );

    const result = stubbedBash([
      'set -euo pipefail',
      `DIR=${JSON.stringify(dir)}`,
      `DISPATCHED=${JSON.stringify(dispatched)}`,
      'gh() {',
      `  printf '%s\\n' "gh $*" >> "$GH_LOG"`,
      '  case "$*" in',
      `    *"commits/main"*) printf '%s\\n' ${JSON.stringify(mainSha)} ;;`,
      // 두 호출 모두 같은 URL을 `--jq`로 부른다. 스텁이 워크플로의 필터를 그대로 적용해야
      // "exploratory 시도만 센다"는 계약이 실제로 검증된다.
      '    *"head_sha="*)',
      `      if [ -f "$DISPATCHED" ] && [ ${appearsAfterDispatch ? '1' : '0'} -eq 1 ]; then`,
      '        runs_file="$DIR/runs-after.json"',
      '      else',
      '        runs_file="$DIR/runs.json"',
      '      fi',
      '      case "$*" in',
      '        *"| length"*) jq -r "${producer_attempts_filter} | length" "$runs_file" ;;',
      `        *) jq -r "\${producer_attempts_filter}"' | .[] | "\\(.status) \\(.conclusion // "none")"' "$runs_file" ;;`,
      '      esac ;;',
      // baseline 조회는 워크플로의 jq를 그대로 적용한다. 스텁이 완성된 SHA를 내면
      // 선택 규칙("마지막으로 성공한 적격 실행")이 검증되지 않는다.
      `    *"branch=main&per_page=100"*) jq -r "\${producer_attempts_filter}\${baseline_suffix}" "$DIR/baseline.json" ;;`,
      // 필터가 빠지면 feature ref 실행이나 main의 최신 실패 실행이 기준점이 된다. 그
      // 경우를 스텁으로 재현해 둔다.
      `    *"runs?per_page=1"*) printf '%s\\n' ${JSON.stringify('f'.repeat(40))} ;;`,
      `    *"runs?branch=main&per_page=1"*) printf '%s\\n' ${JSON.stringify('e'.repeat(40))} ;;`,
      `    *"compare/"*) ${compareFails ? 'return 1' : `printf '%s\\n' ${JSON.stringify(changed)}`} ;;`,
      `    *"workflow run"*) : > "$DISPATCHED"; ${dispatchFails ? 'return 1' : ':'} ;;`,
      `    *) printf 'unstubbed gh call: %s\\n' "$*" >&2; return 1 ;;`,
      '  esac',
      '}',
      'sleep() { :; }',
      'repo=o/r',
      'producer=datapack-release.yml',
      `attempt_limit=${attemptLimit}`,
      `baseline_suffix=${JSON.stringify(baselineSuffix)}`,
      dedent(producerBlock),
    ]);
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      dispatched: result.calls.includes('gh workflow run datapack-release.yml'),
      calls: result.calls,
    };
  };

  // 실행이 없고 producer 경로가 바뀌었으면 dispatch한다 (누락 방지).
  const missing = runProducer({ runs: [] });
  assert.equal(missing.status, 0);
  assert.equal(missing.dispatched, true);
  assert.match(missing.calls, /--ref main/);
  // 비교 기준점은 main 이력 위의 실행이어야 한다. branch 필터가 빠지면 feature ref를
  // 대상으로 한 dispatch 실행이 기준점이 되어 compare 범위가 통째로 어긋난다.
  assert.ok(
    producerBlock.includes('runs?branch=main&per_page=100'),
    'baseline query must stay restricted to main',
  );
  assert.match(missing.calls, /compare\/b{40}\.\.\.a{40}/);
  assert.doesNotMatch(missing.calls, /compare\/f{40}/);

  // 같은 head_sha에서 이미 성공했으면 dispatch하지 않는다 (중복 방지).
  const produced = runProducer({ runs: [{ status: 'completed', conclusion: 'success' }] });
  assert.equal(produced.status, 0);
  assert.equal(produced.dispatched, false);
  assert.match(produced.stdout, /이미 실행을 마쳤다/);

  // 실행 중이면 기다린다. 중복 실행을 만들지 않는다.
  const inFlight = runProducer({ runs: [{ status: 'in_progress' }] });
  assert.equal(inFlight.status, 0);
  assert.equal(inFlight.dispatched, false);
  assert.match(inFlight.stdout, /실행 중이다/);

  // 실패 1건은 자동 재시도한다.
  const failedOnce = runProducer({
    runs: Array.from({ length: attemptLimit - 1 }, () => ({
      status: 'completed',
      conclusion: 'failure',
    })),
  });
  assert.equal(failedOnce.status, 0);
  assert.equal(failedOnce.dispatched, true);

  // 실제 저장소에서 재시도가 걸리는 형태는 이것이다: 실패한 그 실행이 곧 최신 실행이라
  // 비교 기준점이 main_sha 자신이 된다. 자기 자신과의 compare는 항상 빈 files라, 경로
  // 판정을 그대로 태우면 attempt_limit 재시도가 영구히 막힌다.
  const failedOnceSameBase = runProducer({
    runs: Array.from({ length: attemptLimit - 1 }, () => ({
      status: 'completed',
      conclusion: 'failure',
    })),
    baseSha: 'a'.repeat(40),
    changed: 'no',
  });
  assert.equal(failedOnceSameBase.status, 0);
  assert.equal(
    failedOnceSameBase.dispatched,
    true,
    'base_sha == main_sha면 경로 판정을 건너뛰고 재시도해야 한다',
  );
  assert.doesNotMatch(
    failedOnceSameBase.calls,
    /compare\//,
    '자기 자신과의 compare는 아예 부르지 않는다',
  );

  // attempt_limit에 도달하면 재시도를 멈추되 큐는 멈추지 않는다. 이 producer의 exploratory
  // 실행 실패는 외부 source 상태에 좌우되므로, 실패시켜 병합 경로 전체를 세우지 않는다.
  const failedTwice = runProducer({
    runs: Array.from({ length: attemptLimit }, () => ({
      status: 'completed',
      conclusion: 'failure',
    })),
  });
  assert.equal(failedTwice.status, 0, 'producer failure must not fail the coordinator run');
  assert.equal(failedTwice.dispatched, false);
  assert.match(failedTwice.stdout + failedTwice.stderr, /::warning::/);
  assert.doesNotMatch(failedTwice.stdout + failedTwice.stderr, /::error::/);

  // 실패한 실행을 기준점으로 삼으면 그 SHA의 변경이 검증되지 않은 채 기준선 뒤로 넘어간다.
  // datapack을 건드린 A에서 producer가 실패하고 무관한 B가 병합된 상황을 그대로 돌린다:
  // 기준점은 실패한 A가 아니라 마지막으로 성공한 X여야 하고, 그래야 A의 변경이 B 시점
  // 비교에 남는다.
  const failedThenUnrelated = runProducer({
    runs: [],
    baselineRuns: [
      { head_sha: 'a'.repeat(39) + '1', conclusion: 'failure', event: 'workflow_dispatch' },
      { head_sha: 'b'.repeat(40), conclusion: 'success', event: 'push' },
    ],
  });
  assert.equal(failedThenUnrelated.status, 0);
  assert.match(
    failedThenUnrelated.calls,
    /compare\/b{40}\.\.\.a{40}/,
    '기준점은 마지막으로 성공한 실행이어야 한다',
  );
  assert.doesNotMatch(
    failedThenUnrelated.calls,
    /compare\/a{39}1/,
    '실패한 실행을 기준점으로 쓰면 그 SHA의 변경이 소실된다',
  );

  // 성공한 적격 실행이 하나도 없으면 기준점이 없다. 비교하지 않고 그대로 dispatch한다
  // (누락보다 중복이 낫다).
  const noSuccessfulBaseline = runProducer({
    runs: [],
    baselineRuns: [
      { head_sha: 'c'.repeat(40), conclusion: 'failure', event: 'workflow_dispatch' },
    ],
  });
  assert.equal(noSuccessfulBaseline.status, 0);
  assert.equal(noSuccessfulBaseline.dispatched, true);
  assert.doesNotMatch(noSuccessfulBaseline.calls, /compare\//);

  // schedule·사람 dispatch의 성공은 기준점이 되지 못한다. exploratory 경로만 기준이다.
  const ineligibleBaseline = runProducer({
    runs: [],
    baselineRuns: [
      { head_sha: 'd'.repeat(40), conclusion: 'success', event: 'schedule', actor: 'AquilaXk' },
      { head_sha: 'b'.repeat(40), conclusion: 'success', event: 'push' },
    ],
  });
  assert.match(ineligibleBaseline.calls, /compare\/b{40}\.\.\.a{40}/);

  // 같은 SHA 안에서의 재시도는 여전히 attempt_limit 경로가 담당한다. 기준점이 성공 실행이
  // 되어도 실패분 재시도 계약은 그대로다.
  const retryWithSuccessBaseline = runProducer({
    runs: Array.from({ length: attemptLimit - 1 }, () => ({
      status: 'completed',
      conclusion: 'failure',
    })),
    baselineRuns: [{ head_sha: 'b'.repeat(40), conclusion: 'success', event: 'push' }],
  });
  assert.equal(retryWithSuccessBaseline.dispatched, true);
  const exhaustedWithSuccessBaseline = runProducer({
    runs: Array.from({ length: attemptLimit }, () => ({
      status: 'completed',
      conclusion: 'failure',
    })),
    baselineRuns: [{ head_sha: 'b'.repeat(40), conclusion: 'success', event: 'push' }],
  });
  assert.equal(exhaustedWithSuccessBaseline.dispatched, false);
  assert.match(exhaustedWithSuccessBaseline.stdout + exhaustedWithSuccessBaseline.stderr, /::warning::/);

  // push 트리거 실행의 성공은 exploratory 완료다(정의상 push 경로는 exploratory).
  const pushProduced = runProducer({
    runs: [{ status: 'completed', conclusion: 'success', event: 'push', actor: 'someone' }],
  });
  assert.equal(pushProduced.dispatched, false);
  assert.match(pushProduced.stdout, /이미 실행을 마쳤다/);

  // 같은 SHA의 schedule 실행 성공은 exploratory 완료가 아니다. mode가 다를 수 있으므로
  // 중립으로 두고 exploratory를 따로 쏜다.
  const scheduledSuccess = runProducer({
    runs: [{ status: 'completed', conclusion: 'success', event: 'schedule', actor: 'someone' }],
  });
  assert.equal(scheduledSuccess.status, 0);
  assert.equal(
    scheduledSuccess.dispatched,
    true,
    'schedule 실행 성공을 exploratory 완료로 읽으면 안 된다',
  );

  // 사람이 쏜 dispatch(rollback·rollout-update 등)는 성공이든 실패든 판정 밖이다.
  // 특히 그 실패로 재시도 한도를 태우면 무관한 사유로 그 SHA가 영구 억제된다.
  const humanDispatchFailures = runProducer({
    runs: Array.from({ length: attemptLimit + 1 }, () => ({
      status: 'completed',
      conclusion: 'failure',
      event: 'workflow_dispatch',
      actor: 'AquilaXk',
    })),
  });
  assert.equal(humanDispatchFailures.status, 0);
  assert.equal(
    humanDispatchFailures.dispatched,
    true,
    '다른 mode 실행의 실패가 attempt_limit을 태우면 안 된다',
  );

  // producer 경로에 변경이 없으면 dispatch하지 않는다. push 트리거의 paths 필터와 같다.
  const untouched = runProducer({ runs: [], changed: 'no' });
  assert.equal(untouched.status, 0);
  assert.equal(untouched.dispatched, false);
  assert.match(untouched.stdout, /경로 변경이 없다/);

  // 비교가 실패하면 모르는 상태다. 누락보다 중복이 낫고, dispatch하면 그 head_sha에
  // 실행이 생겨 다음 실행에서 판정이 끊는다.
  const compareBroken = runProducer({ runs: [], compareFails: true });
  assert.equal(compareBroken.status, 0);
  assert.equal(compareBroken.dispatched, true);

  // 비교 기준점이 없으면(producer 실행 이력 자체가 없음) 그대로 dispatch한다.
  const noBase = runProducer({ runs: [], baseSha: '' });
  assert.equal(noBase.status, 0);
  assert.equal(noBase.dispatched, true);

  // dispatch 후 run 목록 반영이 늦어도 큐를 막지 않는다.
  const lagging = runProducer({ runs: [], appearsAfterDispatch: false });
  assert.equal(lagging.status, 0);
  assert.equal(lagging.dispatched, true);
  assert.match(lagging.stdout, /::warning::/);

  // dispatch 호출 자체가 실패해도 이 스텝을 죽이지 않는다. 죽이면 뒤의 큐 스텝까지
  // 건너뛰어 producer 문제 하나가 병합 경로 전체를 세운다.
  const dispatchFailed = runProducer({ runs: [], dispatchFails: true });
  assert.equal(dispatchFailed.status, 0, 'dispatch call failure must not fail the step');
  assert.match(dispatchFailed.stdout + dispatchFailed.stderr, /::warning::/);

  // main head revision 조회가 깨지면 잘못된 ref로 dispatch하지 않고 실패한다.
  const broken = runProducer({ mainSha: 'null' });
  assert.notEqual(broken.status, 0);
  assert.equal(broken.dispatched, false);
});

test('producer paths 판정은 push 트리거의 paths 필터와 같은 집합을 본다', async () => {
  const workflow = await readWorkflow();
  const producerWorkflow = await readFile(producerWorkflowUrl, 'utf8');

  const pathsProgram = workflow.match(
    /# producer-paths-begin\n[\s\S]*?producer_paths_query='\n([\s\S]*?)\n\s+'\n/,
  )?.[1];
  assert.ok(pathsProgram, 'producer paths jq program must stay testable');
  // 판정에 실제로 쓰이는 질의여야 한다. 변수만 두고 다른 프로그램을 쏘면 이 테스트가
  // 헛돈다.
  assert.match(
    workflow,
    /changed="\$\(gh api "repos\/\$\{repo\}\/compare\/\$\{base_sha\}\.\.\.\$\{main_sha\}" \\\n\s+--jq "\$\{producer_paths_query\}"\)" \|\| changed=yes/,
  );

  // 워크플로가 보는 집합은 producer의 push 트리거 paths와 같아야 한다. 한쪽만 바뀌면
  // 코디네이터가 실행해야 할 병합을 건너뛰거나 필요 없는 실행을 붙인다.
  const declaredPaths = producerWorkflow
    .match(/on:\n[\s\S]*?paths:\n((?:\s+- [^\n]*\n)+)/)?.[1]
    .split('\n')
    .map((line) => line.replace(/^\s*-\s*/, '').trim())
    .filter(Boolean);
  assert.deepEqual(declaredPaths, [
    'tools/datapack/**',
    'tools/route-map/**',
    'contracts.lock.json',
    '.github/workflows/datapack-release.yml',
  ]);
  for (const path of declaredPaths) {
    const literal = path.endsWith('/**') ? `${path.slice(0, -2)}` : path;
    assert.ok(
      pathsProgram.includes(`"${literal}"`),
      `producer paths jq must cover ${path} (looked for ${literal})`,
    );
  }

  const classify = (files) => {
    const result = spawnSync('jq', ['-r', pathsProgram], {
      input: JSON.stringify({ files: files.map((filename) => ({ filename })) }),
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, `jq 하네스 파손: ${result.stderr}`);
    return result.stdout.trim();
  };

  assert.equal(classify(['tools/datapack/build-datapack.mjs']), 'yes');
  assert.equal(classify(['tools/route-map/geometry.json']), 'yes');
  assert.equal(classify(['contracts.lock.json']), 'yes');
  assert.equal(classify(['.github/workflows/datapack-release.yml']), 'yes');
  assert.equal(classify(['README.md', '.github/workflows/ci.yml']), 'no');
  assert.equal(classify([]), 'no');
  // 접두사만 같은 경로를 잘못 잡으면 필터가 paths와 어긋난다.
  assert.equal(classify(['tools/datapack-extra/x.mjs']), 'no');
  // compare의 files는 300건에서 잘린다. 잘린 응답을 "변경 없음"으로 읽으면 안 된다.
  assert.equal(
    classify(Array.from({ length: 300 }, (_, index) => `docs/${index}.md`)),
    'yes',
  );
});

// `run: |` 본문은 YAML block scalar다. 안쪽 줄 하나가 블록 들여쓰기 아래로 내려가면
// 블록은 거기서 끝나고 나머지 스크립트가 YAML 구조로 새어 나간다. 문자열 포함 검사만
// 하는 계약 테스트는 그 파손을 그대로 통과시키므로 구조 자체를 계약으로 고정한다.
const runBlocks = (workflow) => {
  const lines = workflow.split('\n');
  const blocks = [];
  for (let index = 0; index < lines.length; index += 1) {
    const opener = /^(\s*)run: \|\s*$/.exec(lines[index]);
    if (!opener) continue;
    const keyIndent = opener[1].length;
    let cursor = index + 1;
    while (cursor < lines.length && lines[cursor].trim() === '') cursor += 1;
    const blockIndent = /^\s*/.exec(lines[cursor] ?? '')[0].length;
    const body = [];
    let terminator = null;
    for (; cursor < lines.length; cursor += 1) {
      const line = lines[cursor];
      if (line.trim() === '') {
        body.push('');
        continue;
      }
      if (/^\s*/.exec(line)[0].length < blockIndent) {
        terminator = { line, number: cursor + 1 };
        break;
      }
      body.push(line.slice(blockIndent));
    }
    blocks.push({ keyIndent, blockIndent, body: body.join('\n'), terminator, openedAt: index + 1 });
  }
  return blocks;
};

test('워크플로 run 블록은 YAML block scalar 들여쓰기를 지킨다', async () => {
  const files = [
    ['automerge-queue.yml', await readWorkflow()],
    ['ci.yml', await readFile(ciWorkflowUrl, 'utf8')],
  ];

  for (const [name, workflow] of files) {
    const blocks = runBlocks(workflow);
    assert.ok(blocks.length > 0, `${name}: run 블록 추출이 비었다`);

    for (const block of blocks) {
      assert.ok(
        block.blockIndent > block.keyIndent,
        `${name}:${block.openedAt}: block scalar 본문이 run 키보다 깊게 들여쓰기되어야 한다`,
      );
      // 블록을 끝내는 줄은 반드시 더 얕은 레벨의 정상 YAML 키여야 한다. 스크립트 본문이
      // 흘러넘친 줄이면 여기서 걸린다.
      if (block.terminator) {
        assert.match(
          block.terminator.line,
          /^ *(- )?[A-Za-z_][A-Za-z0-9_.-]*:(\s|$)/,
          `${name}:${block.terminator.number}: block scalar 밖으로 새어 나온 줄 — ${JSON.stringify(block.terminator.line)}`,
        );
      }
      // 구조가 살아 있어도 내용이 잘리면 셸이 깨진다. 두 겹으로 잡는다.
      const syntax = spawnSync('bash', ['-n'], { input: block.body, encoding: 'utf8' });
      assert.equal(
        syntax.status,
        0,
        `${name}:${block.openedAt}: run 블록이 bash 문법 검사에 실패했다 — ${syntax.stderr}`,
      );
    }
  }
});

test('여러 줄 셸 문자열은 한 줄 안에서 닫힌다', async () => {
  // 형제 저장소에서 코멘트 본문을 여러 줄로 쓴 `--body "` 가 block scalar를 깨뜨렸다.
  const workflow = await readWorkflow();
  assert.doesNotMatch(workflow, /--body "[^"\n]*$/m);
});

test('CI는 실제 YAML 파서로 워크플로를 검사한다', async () => {
  const ciWorkflow = await readFile(ciWorkflowUrl, 'utf8');
  assert.ok(ciWorkflow.includes('rhysd/actionlint@sha256:'));
  assert.match(ciWorkflow, /docker run --rm[\s\S]{0,200}rhysd\/actionlint@sha256:[a-f0-9]{64}/);
  assert.match(ciWorkflow, /node tools\/ci\/data-test-discovery\.mjs run --class required-pr/);
  const ownership = JSON.parse(await readFile(ownershipUrl, 'utf8'));
  const entry = ownership.tests.find(({ path }) => path === 'tools/ci/automerge-queue.test.mjs');
  assert.ok(entry, 'automerge queue ownership entry를 찾지 못함');
  assert.ok(entry.classes.includes('required-pr'));
});

test('코디네이터는 main push CI를 되살리지 않는다', async () => {
  const workflow = await readWorkflow();

  // GITHUB_TOKEN 병합은 push 이벤트를 만들지 못하므로 main push CI 실행이 사라진다. 이
  // 억제를 되살릴지는 저장소 하나가 혼자 정할 문제가 아니다 — 형제 저장소(backend·mobile)
  // coordinator도 main CI를 dispatch하지 않고, 코디네이터가 병합한 SHA에 main push CI
  // 실행이 0건인 것을 실측했다. 네 저장소의 병합 경로를 일치시키기 위해 억제를 수용한다.
  // 이 계약이 깨지면(= main CI dispatch가 들어오면) 그 결정을 다시 해야 한다.
  const dispatches = [...workflow.matchAll(/gh workflow run ([^\s]+)[^\n]*--ref ([^\s"']+|"[^"]+")/g)]
    .map((match) => `${match[1]} ${match[2]}`);
  assert.deepEqual(dispatches, ['"${producer}" main']);
  // 판정 근거는 주석으로 남아 있어야 한다. 근거 없이 값만 남으면 다음 사람이 되돌린다.
  for (const basis of [
    'main push 실행은 되살리지 않는다',
    'mergedBy가',
    'strict required status checks',
  ]) {
    assert.ok(workflow.includes(basis), `main CI 억제 근거 누락: ${basis}`);
  }
});

test('명시 dispatch는 producer 경로에만 남는다', async () => {
  const producerWorkflow = await readFile(producerWorkflowUrl, 'utf8');

  // GITHUB_TOKEN 병합은 push 이벤트를 만들지 않으므로 producer는 dispatch로도 실행돼야 한다.
  assert.ok(producerWorkflow.includes('  workflow_dispatch:'));
  // 코디네이터가 쓰는 입력이 실제로 정의돼 있어야 한다.
  for (const input of ['      mode:', '      targetChannel:', '      modeArgs:']) {
    assert.ok(producerWorkflow.includes(input), `producer input missing: ${input}`);
  }
  // dispatch 입력이 없을 때의 push 기본값과 같은 모드로 쏜다.
  assert.match(producerWorkflow, /mode="\$\{MODE_INPUT:-exploratory\}"/);

  // allowGaps 기본값은 mode가 같아도 이벤트에 따라 갈린다. push의 exploratory는 true,
  // dispatch의 exploratory는 false다. 코디네이터가 이 값을 명시하는 근거가 그 divergence이므로
  // 분기 자체를 고정한다 — producer가 분기를 바꾸면 코디네이터 입력도 다시 판정해야 한다.
  const allowGapsBranch = producerWorkflow.match(
    /if \[\[ -z "\$\{allow_gaps\}" \]\]; then\n([\s\S]*?\n\s+fi)\n\s+fi\n/,
  )?.[1];
  assert.ok(allowGapsBranch, 'producer allowGaps default branch must stay testable');
  assert.match(
    allowGapsBranch,
    /if \[\[ "\$\{GITHUB_EVENT_NAME\}" != "workflow_dispatch" && "\$\{mode\}" == "exploratory" \]\]; then\n\s+allow_gaps=true\n\s+else\n\s+allow_gaps=false/,
  );

  // 분기를 그대로 실행해 두 경로의 값이 실제로 갈리는지 보고, 코디네이터가 보내는 값이
  // push 경로의 값과 같은지 확인한다.
  const resolveAllowGaps = (eventName) => {
    const result = spawnSync(
      'bash',
      [
        '-c',
        [
          'set -euo pipefail',
          'allow_gaps=""',
          'mode=exploratory',
          `GITHUB_EVENT_NAME=${JSON.stringify(eventName)}`,
          'if [[ -z "${allow_gaps}" ]]; then',
          // 셸은 들여쓰기를 신경 쓰지 않으므로 추출한 분기를 그대로 넣는다.
          allowGapsBranch,
          'fi',
          `printf '%s\\n' "\${allow_gaps}"`,
        ].join('\n'),
      ],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 0, `allowGaps 하네스 파손: ${result.stderr}`);
    return result.stdout.trim();
  };
  assert.equal(resolveAllowGaps('push'), 'true');
  assert.equal(
    resolveAllowGaps('workflow_dispatch'),
    'false',
    'dispatch 경로에서 기본값이 뒤집히는 것이 이 계약의 이유다',
  );

  const workflow = await readWorkflow();
  const dispatchedModeArgs = workflow.match(/-f modeArgs='([^']+)'/)?.[1];
  assert.ok(dispatchedModeArgs, 'dispatch modeArgs must stay testable');
  assert.equal(
    JSON.parse(dispatchedModeArgs).allowGaps,
    resolveAllowGaps('push'),
    'coordinator dispatch must reproduce the value the push path used',
  );
});

// ---------------------------------------------------------------------------
// BEHIND 자동 갱신과 marker 재발행·복구 (backend #412 이식, data #824)
// ---------------------------------------------------------------------------
const PAGINATED_READ_RE = /# paginated-read-begin\n([\s\S]*?)\n\s+# paginated-read-end/;
const markerFor = (head) => `<!-- Automerge frozen discovery authorization: ${head} -->`;
const recordFor = (head) => `<!-- Automerge base update requested: ${head} -->`;
const actionsBotUser = { login: 'github-actions[bot]', id: 41898282, type: 'Bot' };
const retiredUniversalDiscoveryBody =
  '**Actionable comments posted: 0**\n<!-- Review source: Aquila Universal Review; engine: aquila-review -->';
const interrogateDiscoveryBody = (sha, actOn = '0') =>
  `## Verdict\n\nNo blocking findings.\n\n<!-- pstack-interrogate head=${sha} act-on=${actOn} -->`;
const interrogateReview = (commitId, overrides = {}) => ({
  id: 5,
  state: 'COMMENTED',
  submitted_at: '2026-09-29T00:00:00Z',
  commit_id: commitId,
  author_association: 'OWNER',
  body: interrogateDiscoveryBody(commitId),
  user: { login: 'reviewer', type: 'User' },
  ...overrides,
});
const codeRabbitDiscoveryReview = (commitId, overrides = {}) => ({
  id: 5,
  state: 'COMMENTED',
  submitted_at: '2026-09-29T00:00:00Z',
  commit_id: commitId,
  author_association: 'NONE',
  body: '',
  user: { login: 'coderabbitai[bot]', id: 136622811, type: 'Bot' },
  ...overrides,
});
const committedAt = (sha, date) => ({ sha, commit: { committer: { date } } });
const labeledAt = (date, name = 'automerge') => ({ event: 'labeled', label: { name }, created_at: date });
const syncGhStub = [
  'gh() {',
  '  printf "TOKEN=%s gh %s\\n" "$GH_TOKEN" "$*" >> "$GH_LOG"',
  '  local all="$*" filter="" previous="" argument payload="" page',
  '  for argument in "$@"; do [[ "$previous" == --jq ]] && filter="$argument"; previous="$argument"; done',
  '  case "$all" in',
  '    "api --method PATCH repos/o/r/issues/comments/"*|"api --method POST repos/o/r/issues/"*"/comments "*)',
  '      [[ "$mutation" == fail ]] && return 1',
  '      local id=77; [[ "$all" == *"issues/comments/"* ]] && { id="${all#*issues/comments/}"; id="${id%% *}"; }',
  '      if [[ "$mutation" == foreign ]]; then',
  '        jq -nc --argjson id "$id" \'{id: $id, body: "other", user: {login: "github-actions[bot]", id: 41898282, type: "Bot"}}\'',
  '        return 0',
  '      fi',
  '      jq -nc --argjson id "$id" --arg body "${all#*body=}" \'{id: $id, body: $body, user: {login: "github-actions[bot]", id: 41898282, type: "Bot"}}\' ;;',
  '    "api repos/o/r/commits/"*) payload="$(cat "$FIX/head-commit.json" 2>/dev/null || printf __FAIL__)" ;;',
  '    "api repos/o/r/compare/"*) payload="$(cat "$FIX/compare.json" 2>/dev/null || printf __FAIL__)" ;;',
  '    "api repos/o/r/issues/85/events?per_page=100&page="*) page="${all##*page=}"; payload="$(cat "$FIX/events-$page.json" 2>/dev/null || printf __FAIL__)" ;;',
  '    *) printf "unstubbed gh call: %s\\n" "$all" >&2; return 1 ;;',
  '  esac',
  '  if [[ -n "$payload" ]]; then',
  '    [[ "$payload" == __FAIL__ ]] && return 1',
  '    if [[ -n "$filter" ]]; then jq -r "$filter" <<<"$payload"; else printf "%s\\n" "$payload"; fi',
  '  fi',
  '}',
];

// 워크플로의 marker 동기화 블록과 페이지 상한 조회 헬퍼를 그대로 꺼내 stub gh로 실행한다.
// comments·reviews·commits는 read_pages가 돌려주는 모양(페이지 배열)이다.
const runMarkerSync = (
  workflow,
  {
    head,
    comments = [],
    reviews = [],
    commits = [[committedAt(head, '2026-09-29T01:00:00Z')]],
    headCommit = null,
    compare = null,
    events = null,
    mutation = 'ok',
    isAutomationPr = 'false',
  },
) => {
  const block = workflow.match(MARKER_SYNC_RE)?.[1];
  assert.ok(block, 'authorization marker sync must stay testable');
  const readPages = workflow.match(PAGINATED_READ_RE)?.[1];
  assert.ok(readPages, 'paginated read helper must stay testable');
  const dir = mkdtempSync(join(tmpdir(), 'automerge-marker-sync-'));
  const log = join(dir, 'gh.log');
  const fixture = (name, payload) =>
    writeFileSync(join(dir, name), payload === '__FAIL__' ? payload : JSON.stringify(payload));
  if (headCommit !== null) fixture('head-commit.json', headCommit);
  if (compare !== null) fixture('compare.json', compare);
  (events ?? []).forEach((page, index) => fixture(`events-${index + 1}.json`, page));
  const shellQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
  const result = spawnSync('bash', ['-c', [
    'set -euo pipefail',
    `GH_LOG=${shellQuote(log)}`,
    `FIX=${shellQuote(dir)}`,
    'repo=o/r',
    'pr=85',
    `head=${shellQuote(head)}`,
    'GH_TOKEN=github-token',
    'MERGE_GH_TOKEN=merge-token',
    `is_automation_pr=${isAutomationPr}`,
    `mutation=${shellQuote(mutation)}`,
    `comments=${shellQuote(JSON.stringify([comments]))}`,
    `reviews=${shellQuote(JSON.stringify([reviews]))}`,
    `commits=${shellQuote(JSON.stringify(commits))}`,
    `commit_ids="$(jq -c '[flatten[] | .sha? | select(type == "string" and test("^[0-9a-f]{40}$"))]' <<<"$commits")"`,
    ': > "$GH_LOG"',
    ...syncGhStub,
    reviewJqDefsOf(workflow),
    budgetConstantsOf(workflow),
    dedent(readPages),
    dedent(block),
    'sync_authorization_marker "$commits" "$commit_ids"',
    'printf "SYNC_RETURNED\\n"',
    'printf "%s\\n" "$comments"',
  ].join('\n')], { encoding: 'utf8' });
  const calls = existsSync(log) ? readFileSync(log, 'utf8') : '';
  const lines = (result.stdout ?? '').trim().split('\n');
  const after = lines.at(-1)?.startsWith('[') ? JSON.parse(lines.at(-1)).flat() : [];
  const canonical = after.filter(
    (comment) =>
      comment.user?.login === actionsBotUser.login &&
      comment.user?.id === actionsBotUser.id &&
      comment.user?.type === actionsBotUser.type &&
      /^<!-- Automerge frozen discovery authorization: [0-9a-f]{40} -->$/.test(comment.body ?? ''),
  );
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    calls,
    mutations: calls.split('\n').filter((line) => / --method (PATCH|POST) /.test(line)),
    authorized: canonical.length === 1 && canonical[0].body === markerFor(head),
  };
};

test('marker 재발행은 코디네이터 기록이 있는 base 갱신 병합 커밋에만 적용된다', async () => {
  const workflow = await readWorkflow();
  const previous = 'b'.repeat(40);
  const head = 'c'.repeat(40);
  const mainParent = 'd'.repeat(40);
  const other = 'e'.repeat(40);
  const markerComment = { id: 99, body: markerFor(previous), user: actionsBotUser };
  const record = { id: 100, body: recordFor(previous), user: actionsBotUser };
  const base = {
    head,
    comments: [markerComment, record],
    reviews: [codeRabbitDiscoveryReview(previous)],
    headCommit: { sha: head, parents: [{ sha: previous }, { sha: mainParent }] },
    compare: { status: 'ahead' },
  };

  for (const status of ['ahead', 'identical']) {
    const reissued = runMarkerSync(workflow, { ...base, compare: { status } });
    assert.equal(reissued.status, 0, reissued.stderr);
    assert.deepEqual(
      reissued.mutations,
      [`TOKEN=github-token gh api --method PATCH repos/o/r/issues/comments/99 -f body=${markerFor(head)}`],
    );
    assert.match(reissued.calls, new RegExp(`gh api repos/o/r/compare/${mainParent}\\.\\.\\.main `));
    assert.equal(reissued.authorized, true, 'the patched marker must replace the old one in the gate input');
  }

  for (const [label, options] of [
    ['first parent differs from the marker head', { headCommit: { sha: head, parents: [{ sha: other }, { sha: mainParent }] } }],
    ['single-parent session push', { headCommit: { sha: head, parents: [{ sha: previous }] } }],
    ['octopus merge', { headCommit: { sha: head, parents: [{ sha: previous }, { sha: mainParent }, { sha: other }] } }],
    ['malformed parent', { headCommit: { sha: head, parents: [{ sha: previous }, { sha: 'not-a-sha' }] } }],
    ['second parent behind main', { compare: { status: 'behind' } }],
    ['second parent diverged from main', { compare: { status: 'diverged' } }],
    ['commit lookup failure', { headCommit: '__FAIL__' }],
    ['compare lookup failure', { compare: '__FAIL__' }],
  ]) {
    const kept = runMarkerSync(workflow, { ...base, ...options });
    assert.equal(kept.status, 0, `${label}: ${kept.stderr}`);
    assert.match(kept.stdout, /SYNC_RETURNED/);
    assert.deepEqual(kept.mutations, [], `${label} must not reissue`);
    assert.equal(kept.authorized, false);
  }

  for (const [label, comments] of [
    ['no base-update record', [markerComment]],
    ['record for another head', [markerComment, { ...record, body: recordFor(other) }]],
    ['forged record author', [markerComment, { ...record, user: { ...actionsBotUser, id: 1 } }]],
    ['duplicated records', [markerComment, record, { ...record, id: 101 }]],
    // 라벨 재부착 전에 쌓인 marker 여러 개는 어느 것도 고치지 않는다.
    ['accumulated canonical markers', [markerComment, { ...markerComment, id: 98, body: markerFor(other) }, record]],
  ]) {
    const kept = runMarkerSync(workflow, { ...base, comments });
    assert.equal(kept.status, 0, `${label}: ${kept.stderr}`);
    assert.equal(kept.calls, '', `${label} must not reissue or look up anything`);
    assert.equal(kept.authorized, false);
  }

  const current = runMarkerSync(workflow, { ...base, comments: [{ ...markerComment, body: markerFor(head) }] });
  assert.equal(current.calls, '', 'an exact-head marker needs no API call');
  assert.equal(current.authorized, true);

  const automation = runMarkerSync(workflow, { ...base, isAutomationPr: 'true' });
  assert.equal(automation.calls, '', 'automation PRs must never reissue or recover frozen human markers');
  assert.equal(automation.authorized, false);

  for (const mutation of ['fail', 'foreign']) {
    const failed = runMarkerSync(workflow, { ...base, mutation });
    assert.equal(failed.status, 0, `${mutation}: ${failed.stderr}`);
    assert.equal(failed.mutations.length, 1, `${mutation} must not retry`);
    assert.equal(failed.authorized, false);
    assert.match(failed.stdout, /::warning::PR #85: authorization marker/);
    assert.doesNotMatch(failed.stdout, /now covers/);
  }
});

test('marker 복구는 marker가 없고 게이트 정의의 discovery가 commit set에 있으며 라벨 시점 이전 head일 때만 게시한다', async () => {
  const workflow = await readWorkflow();
  const previous = 'b'.repeat(40);
  const head = 'c'.repeat(40);
  const outside = 'f'.repeat(40);
  const base = {
    head,
    comments: [],
    reviews: [interrogateReview(head)],
    commits: [[committedAt(previous, '2026-09-29T00:00:00Z'), committedAt(head, '2026-09-29T01:00:00Z')]],
    events: [[labeledAt('2026-09-29T02:00:00Z')]],
  };
  const posted = [`TOKEN=github-token gh api --method POST repos/o/r/issues/85/comments -f body=${markerFor(head)}`];
  const hundred = (event) => Array.from({ length: 100 }, () => event);

  for (const [label, options] of [
    ['pstack-interrogate discovery on the current PR head', {}],
    // data 게이트는 신뢰 APPROVED도 discovery로 인정한다. 복구도 같은 정의를 쓴다.
    ['trusted approval on an earlier PR commit', { reviews: [interrogateReview(previous, { state: 'APPROVED', body: '' })] }],
    ['CodeRabbit discovery on an earlier PR commit', { reviews: [codeRabbitDiscoveryReview(previous)] }],
    ['CodeRabbit discovery on the current PR head', { reviews: [codeRabbitDiscoveryReview(head)] }],
    [
      'valid pstack-interrogate with fenced and inline quoted bad markers',
      {
        reviews: [
          interrogateReview(head, {
            body: `\`<!-- pstack-interrogate head=bad act-on=2 -->\`\n\`\`\`html\n<!-- pstack-interrogate broken\n\`\`\`\n${interrogateDiscoveryBody(head)}`,
          }),
        ],
      },
    ],
    [
      'prior ACT_ON cleared by current-head valid pstack-interrogate',
      {
        reviews: [
          interrogateReview(previous, {
            id: 5,
            submitted_at: '2026-09-29T00:00:00Z',
            body: interrogateDiscoveryBody(previous, '1'),
          }),
          interrogateReview(head, { id: 6, submitted_at: '2026-09-29T00:30:00Z' }),
        ],
      },
    ],
    ['spoofed marker is not canonical', { comments: [{ id: 7, body: markerFor(previous), user: { ...actionsBotUser, id: 1 } }] }],
    ['head committed at the label time', { events: [[labeledAt('2026-09-29T01:00:00Z')]] }],
    ['relabel after the head', { events: [[labeledAt('2026-09-28T00:00:00Z'), labeledAt('2026-09-29T02:00:00Z')]] }],
    ['force push before the label', { events: [[{ event: 'head_ref_force_pushed', created_at: '2026-09-29T01:30:00Z' }, labeledAt('2026-09-29T02:00:00Z')]] }],
    ['a full first page followed by an empty page', { events: [hundred(labeledAt('2026-09-29T02:00:00Z')), []] }],
  ]) {
    const recovered = runMarkerSync(workflow, { ...base, ...options });
    assert.equal(recovered.status, 0, `${label}: ${recovered.stderr}`);
    assert.deepEqual(recovered.mutations, posted, `${label} must recover the labeled head`);
    assert.equal(recovered.authorized, true, `${label} must authorize the current head in this run`);
  }

  for (const [label, options] of [
    ['no review', { reviews: [] }],
    ['non-canonical comment review', { reviews: [interrogateReview(head, { body: 'looks fine' })] }],
    ['retired Aquila discovery review', { reviews: [interrogateReview(head, { body: retiredUniversalDiscoveryBody })] }],
    ['pstack-interrogate on an earlier PR commit', { reviews: [interrogateReview(previous)] }],
    ['pstack-interrogate with act-on > 0', { reviews: [interrogateReview(head, { body: interrogateDiscoveryBody(head, '1') })] }],
    [
      'active ACT_ON alongside CodeRabbit discovery',
      {
        reviews: [
          codeRabbitDiscoveryReview(head, { id: 5 }),
          interrogateReview(head, { id: 6, body: interrogateDiscoveryBody(head, '1') }),
        ],
      },
    ],
    [
      'unclosed pstack-interrogate prefix alongside CodeRabbit discovery',
      {
        reviews: [
          codeRabbitDiscoveryReview(head, { id: 5 }),
          interrogateReview(head, { id: 6, body: `<!-- pstack-interrogate head=${head} act-on=0` }),
        ],
      },
    ],
    [
      'active CHANGES_REQUESTED alongside CodeRabbit discovery',
      {
        reviews: [
          codeRabbitDiscoveryReview(head, { id: 5 }),
          interrogateReview(head, { id: 6, state: 'CHANGES_REQUESTED', body: '' }),
        ],
      },
    ],
    [
      'dismissed APPROVED followed by plain COMMENTED',
      {
        reviews: [
          interrogateReview(previous, { id: 5, state: 'APPROVED', body: '' }),
          interrogateReview(previous, { id: 6, state: 'DISMISSED', submitted_at: '2026-09-29T00:10:00Z', body: '' }),
          interrogateReview(head, { id: 7, state: 'COMMENTED', submitted_at: '2026-09-29T00:20:00Z', body: '확인 메모' }),
        ],
      },
    ],
    ['collaborator Bot user is not trusted human', { reviews: [interrogateReview(head, { user: { login: 'helper[bot]', type: 'Bot' } })] }],
    ['markdown code-span marker only', { reviews: [interrogateReview(head, { body: `\`<!-- pstack-interrogate head=${head} act-on=0 -->\`` })] }],
    ['untrusted author association', { reviews: [interrogateReview(head, { author_association: 'NONE' })] }],
    ['CodeRabbit impersonation', { reviews: [codeRabbitDiscoveryReview(head, { user: { login: 'coderabbitai[bot]', id: 1, type: 'Bot' } })] }],
    ['CodeRabbit discovery outside the PR commit set', { reviews: [codeRabbitDiscoveryReview(outside)] }],
    ['trusted approval outside the PR commit set', { reviews: [interrogateReview(outside, { state: 'APPROVED', body: '' })] }],
    ['empty commit set', { commits: [[]] }],
    ['automation PR never syncs human marker', { isAutomationPr: 'true' }],
  ]) {
    const kept = runMarkerSync(workflow, { ...base, ...options });
    assert.equal(kept.status, 0, `${label}: ${kept.stderr}`);
    assert.equal(kept.calls, '', `${label} must not read events or post a marker`);
    assert.equal(kept.authorized, false);
  }

  for (const [label, options] of [
    ['head committed after the latest automerge label', { commits: [[committedAt(previous, '2026-09-29T00:00:00Z'), committedAt(head, '2026-09-29T03:00:00Z')]] }],
    ['events lookup failure', { events: ['__FAIL__'] }],
    ['no events at all', { events: [[]] }],
    ['only other label events', { events: [[labeledAt('2026-09-29T02:00:00Z', 'ready')]] }],
    ['force push after the label', { events: [[labeledAt('2026-09-29T02:00:00Z'), { event: 'head_ref_force_pushed', created_at: '2026-09-29T02:30:00Z' }]] }],
    ['unparseable label time', { events: [[labeledAt('yesterday')]] }],
    ['head without a committer date', { commits: [[committedAt(previous, '2026-09-29T00:00:00Z'), { sha: head }]] }],
    ['event history beyond the bounded read', { events: [hundred(labeledAt('2026-09-29T02:00:00Z')), [labeledAt('2026-09-29T02:00:00Z')]] }],
  ]) {
    const kept = runMarkerSync(workflow, { ...base, ...options });
    assert.equal(kept.status, 0, `${label}: ${kept.stderr}`);
    assert.match(kept.stdout, /SYNC_RETURNED/);
    assert.deepEqual(kept.mutations, [], `${label} must not recover a marker`);
    assert.equal(kept.authorized, false);
  }

  const failed = runMarkerSync(workflow, { ...base, mutation: 'fail' });
  assert.equal(failed.mutations.length, 1);
  assert.equal(failed.authorized, false, 'a failed recovery must not authorize the head');
});

test('marker 동기화의 discovery 판정은 리뷰 게이트·자동화 정책·BEHIND 분기와 단일 review_jq_defs를 공유하고 github.token만 쓴다', async () => {
  const workflow = await readWorkflow();
  const defs = reviewJqBodyOf(workflow);
  const sync = workflow.match(MARKER_SYNC_RE)?.[1];
  assert.ok(sync, 'authorization marker sync must stay testable');
  const policy = workflow.match(/# automation-policy-begin\n([\s\S]*?)\n\s+# automation-policy-end/)?.[1];
  assert.ok(policy, 'automation policy must stay testable');
  const dispatch = workflow.match(/# merge-state-dispatch-begin\n([\s\S]*?)\n\s+# merge-state-dispatch-end/)?.[1];
  assert.ok(dispatch, 'merge-state dispatch must stay testable');
  const gate = workflow.match(/# review-state-filter-begin\n([\s\S]*?)\n\s+# review-state-filter-end/)?.[1];
  assert.ok(gate, 'review gate block must stay testable');

  assert.equal(
    (workflow.match(/^ +review_jq_defs="\$\(cat <<'JQ'/gm) ?? []).length,
    1,
    'review_jq_defs must be defined exactly once',
  );
  for (const singleDef of [
    'def is_coderabbit:',
    'def is_trusted_human:',
    'def is_sha_in(',
    'def strip_markdown_code($keep_unclosed):',
    'def has_pstack_interrogate_marker:',
    'def is_valid_pstack_interrogate_on(',
    'def is_transferable_frozen_review(',
    'def reduce_review_states(',
    'def has_no_blocking_review(',
    'def passes_review_discovery(',
    'def passes_transferable_behind_discovery(',
  ]) {
    const escaped = singleDef.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.equal(
      (workflow.match(new RegExp(escaped, 'g')) ?? []).length,
      1,
      `${singleDef} must appear only inside shared review_jq_defs`,
    );
    assert.ok(defs.includes(singleDef), `${singleDef} must live inside review_jq_defs`);
  }

  for (const [name, block, callExpr] of [
    ['automation policy', policy, 'has_no_blocking_review($head; $commit_ids)'],
    ['marker sync', sync, 'passes_review_discovery($head; $commit_ids)'],
    ['review gate', gate, 'passes_review_discovery($head; $commit_ids)'],
    ['merge-state dispatch', dispatch, 'passes_transferable_behind_discovery($commit_ids)'],
  ]) {
    assert.ok(block.includes('"${review_jq_defs}"'), `${name} must invoke shared review_jq_defs`);
    assert.ok(block.includes(callExpr), `${name} must call ${callExpr}`);
  }

  assert.doesNotMatch(sync, /MERGE_GH_TOKEN/);
  const loop = workflow.slice(workflow.indexOf('while IFS= read -r pr; do'));
  const syncAt = loop.indexOf('\n            sync_authorization_marker "${commits}" "${commit_ids}"\n');
  assert.ok(
    syncAt > loop.indexOf('commits="$(read_pages "repos/${repo}/pulls/${pr}/commits")"'),
    'sync must follow the PR commits read',
  );
  assert.ok(
    syncAt > loop.indexOf('comments="$(read_pages "repos/${repo}/issues/${pr}/comments")"'),
    'sync must follow the comment read',
  );
  assert.ok(syncAt < loop.indexOf('# review-state-filter-begin'), 'sync must precede the review gate');
});

const runSyncQueue = (
  workflow,
  prs,
  { hasPat = false, eventName = 'workflow_run', eventPr = '', eventHead = '' } = {},
) => {
  const authorizationBlock = workflow.match(
    /          if \[\[ "\$\{EVENT_NAME\}" == "pull_request_target" \]\]; then\n([\s\S]*?)\n          fi\n\n          # required context/,
  )?.[0];
  assert.ok(authorizationBlock, 'label authorization block must stay testable');
  const queueLoop = workflow.match(/# queue-loop-begin\n([\s\S]*?)\n\s+# queue-loop-end/)?.[1];
  assert.ok(queueLoop, 'queue loop must stay testable');
  const dir = mkdtempSync(join(tmpdir(), 'automerge-sync-queue-'));
  const log = join(dir, 'gh.log');
  for (const pr of prs) {
    const head = pr.head;
    writeFileSync(join(dir, `pr-${pr.number}.json`), JSON.stringify({
      state: 'OPEN',
      isDraft: false,
      baseRefName: 'main',
      author: pr.author ?? { login: 'author', type: 'User' },
      headRefName: pr.headRefName ?? `feature-${pr.number}`,
      labels: [{ name: 'automerge' }],
      headRefOid: head,
      mergeStateStatus: pr.mergeStateStatus,
    }));
    writeFileSync(join(dir, `reviews-${pr.number}.json`), JSON.stringify(pr.reviews));
    writeFileSync(
      join(dir, `commits-${pr.number}.json`),
      pr.commits === '__FAIL__' ? '__FAIL__' : JSON.stringify(pr.commits),
    );
    writeFileSync(join(dir, `comments-${pr.number}.json`), JSON.stringify(pr.comments));
    for (const [page, events] of (pr.events ?? []).entries()) {
      writeFileSync(join(dir, `events-${pr.number}-${page + 1}.json`), JSON.stringify(events));
    }
    if (pr.headParents) {
      writeFileSync(join(dir, `commit-${head}.json`), JSON.stringify({ sha: head, parents: pr.headParents.map((sha) => ({ sha })) }));
    }
    for (const [baseSha, status] of Object.entries(pr.compare ?? {})) {
      writeFileSync(join(dir, `compare-${baseSha}.json`), JSON.stringify({ status }));
    }
    writeFileSync(join(dir, `threads-${pr.number}.json`), JSON.stringify({
      data: { repository: { pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } } } } },
    }));
    const conclusion =
      pr.checkState === 'failure' ? 'failure' : pr.checkState === 'pending' ? null : 'success';
    writeFileSync(join(dir, `checks-${head}.json`), JSON.stringify({
      check_runs: [{ id: 1, name: 'Data contracts', conclusion, started_at: '2026-08-01T00:00:00Z' }],
    }));
    writeFileSync(join(dir, `statuses-${head}.json`), JSON.stringify([]));
  }
  const script = [
    'set -euo pipefail',
    `GH_LOG=${JSON.stringify(log)}`,
    `FIX=${JSON.stringify(dir)}`,
    ': > "$GH_LOG"',
    'gh() {',
    `  printf '%s\\n' "gh $*" >> "$GH_LOG"`,
    '  local all="$*"',
    '  case "$all" in',
    `    *rate_limit*) printf '5000\\n' ;;`,
    `    "pr list"*) printf '%s\\n' ${JSON.stringify(JSON.stringify(prs.map((p) => p.number)))} ;;`,
    `    "api --method PUT repos/o/r/pulls/"*"/update-branch "*) printf 'TOKEN=%s\\n' "$GH_TOKEN" >> "$GH_LOG"; printf '%s\\n' '{"message":"Updating pull request branch."}' ;;`,
    '    "api --method PATCH repos/o/r/issues/comments/"*)',
    '      printf "TOKEN=%s\\n" "$GH_TOKEN" >> "$GH_LOG"',
    '      id="${all#*issues/comments/}"; id="${id%% *}"',
    '      b="${all#*body=}"',
    '      for cf in "$FIX"/comments-*.json; do',
    '        [[ -f "$cf" ]] || continue',
    '        jq --argjson id "$id" --arg body "$b" \'map(if .id == $id then .body = $body else . end)\' "$cf" > "$cf.tmp" && mv "$cf.tmp" "$cf"',
    '      done',
    '      jq -nc --argjson id "$id" --arg body "$b" \'{id: $id, body: $body, user: {login: "github-actions[bot]", id: 41898282, type: "Bot"}}\' ;;',
    '    "api --method POST repos/o/r/issues/"*"/comments "*)',
    '      printf "TOKEN=%s\\n" "$GH_TOKEN" >> "$GH_LOG"',
    '      pn="${all#*issues/}"; pn="${pn%%/comments*}"',
    '      b="${all#*body=}"',
    '      created="$(jq -nc --arg body "$b" \'{id: 77, body: $body, user: {login: "github-actions[bot]", id: 41898282, type: "Bot"}}\')"',
    '      if [[ -f "$FIX/comments-$pn.json" ]]; then',
    '        jq --argjson item "$created" \'. + [$item]\' "$FIX/comments-$pn.json" > "$FIX/comments-$pn.json.tmp" && mv "$FIX/comments-$pn.json.tmp" "$FIX/comments-$pn.json"',
    '      fi',
    '      printf "%s\\n" "$created" ;;',
    '    "api repos/o/r/commits/"*) h="${all#api repos/o/r/commits/}"; [[ -f "$FIX/commit-$h.json" ]] || return 1; cat "$FIX/commit-$h.json" ;;',
    '    "api repos/o/r/compare/"*) b="${all#api repos/o/r/compare/}"; b="${b%%...*}"; [[ -f "$FIX/compare-$b.json" ]] || return 1; jq -r .status "$FIX/compare-$b.json" ;;',
    '    *issues/*/events*) n="${all#*issues/}"; n="${n%%/events*}"; page="${all##*page=}"; [[ -f "$FIX/events-$n-$page.json" ]] || return 1; cat "$FIX/events-$n-$page.json" ;;',
    '    "pr view "*) set -- $all; cat "$FIX/pr-$3.json" ;;',
    '    *pulls/*/reviews*) n="${all#*pulls/}"; n="${n%%/reviews*}"; cat "$FIX/reviews-$n.json" ;;',
    '    *pulls/*/commits*) n="${all#*pulls/}"; n="${n%%/commits*}"; [[ "$(cat "$FIX/commits-$n.json")" == __FAIL__ ]] && return 1; cat "$FIX/commits-$n.json" ;;',
    '    *issues/*/comments*) n="${all#*issues/}"; n="${n%%/comments*}"; cat "$FIX/comments-$n.json" ;;',
    '    *graphql*) n="${all#*number=}"; n="${n%% *}"; cat "$FIX/threads-$n.json" ;;',
    '    *check-runs*) h="${all#*commits/}"; h="${h%%/check-runs*}"; cat "$FIX/checks-$h.json" ;;',
    '    *statuses*) h="${all#*commits/}"; h="${h%%/statuses*}"; cat "$FIX/statuses-$h.json" ;;',
    '    "pr merge"* | "pr edit"*) ;;',
    `    *) printf 'unstubbed gh call: %s\\n' "$all" >&2; return 1 ;;`,
    '  esac',
    '}',
    'sleep() { :; }',
    'repo=o/r',
    'owner=o',
    'name=r',
    'GH_TOKEN=github-token',
    'MERGE_GH_TOKEN=merge-token',
    `HAS_AUTOMERGE_PAT=${hasPat}`,
    `EVENT_NAME=${JSON.stringify(eventName)}`,
    `EVENT_PR=${JSON.stringify(eventPr)}`,
    `EVENT_HEAD=${JSON.stringify(eventHead)}`,
    `required='[{"context":"Data contracts","integration_id":null}]'`,
    dedent(authorizationBlock),
    'candidates="$(gh pr list)"',
    budgetConstantsOf(workflow),
    dedent(queueLoop),
  ].join('\n');
  const result = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
  const calls = existsSync(log) ? readFileSync(log, 'utf8') : '';
  const merged = calls.match(/gh pr merge --squash (\d+) --repo/)?.[1];
  const removedLabels = [...calls.matchAll(/gh pr edit (\d+) --repo o\/r --remove-label automerge/g)].map(
    (m) => Number(m[1]),
  );
  const commentsByPr = Object.fromEntries(
    prs.map((pr) => [pr.number, JSON.parse(readFileSync(join(dir, `comments-${pr.number}.json`), 'utf8'))]),
  );
  return {
    status: result.status,
    mergedPr: merged ? Number(merged) : null,
    removedLabels,
    commentsByPr,
    calls,
    stdout: result.stdout,
    stderr: result.stderr,
  };
};

test('코디네이터 base 갱신 기록 뒤 승계 가능 리뷰는 previous 재사용으로 병합하고 pstack-interrogate 전용 BEHIND는 라벨을 내리고 건너뛴다', async () => {
  const workflow = await readWorkflow();
  const previous = 'b'.repeat(40);
  const head = 'c'.repeat(40);
  const mainParent = 'd'.repeat(40);
  const nextHead = 'e'.repeat(40);
  const initialSha = 'a'.repeat(40);
  const markerComment = { id: 99, body: markerFor(previous), user: actionsBotUser };

  const requested = runSyncQueue(workflow, [{
    number: 1, head: previous, mergeStateStatus: 'BEHIND',
    comments: [markerComment], reviews: [codeRabbitDiscoveryReview(previous)], commits: [{ sha: previous }],
  }], { hasPat: true });
  assert.equal(requested.status, 0, requested.stderr);
  assert.equal(requested.mergedPr, null);
  assert.deepEqual(requested.removedLabels, []);
  assert.match(requested.calls, new RegExp(`update-branch -f expected_head_sha=${previous}\\nTOKEN=merge-token\\n`));
  const recordBody = requested.calls.match(
    /gh api --method POST repos\/o\/r\/issues\/1\/comments -f body=(<!-- Automerge base update requested: [0-9a-f]{40} -->)\nTOKEN=github-token\n/,
  )?.[1];
  assert.equal(recordBody, recordFor(previous), 'the accepted base update must be recorded for head P');

  const approvedBehind = runSyncQueue(workflow, [{
    number: 1, head: previous, mergeStateStatus: 'BEHIND',
    comments: [markerComment],
    reviews: [interrogateReview(previous, { state: 'APPROVED', body: '' })],
    commits: [{ sha: previous }],
  }], { hasPat: true });
  assert.equal(approvedBehind.status, 0, approvedBehind.stderr);
  assert.equal(approvedBehind.mergedPr, null);
  assert.deepEqual(approvedBehind.removedLabels, []);
  assert.match(approvedBehind.calls, new RegExp(`update-branch -f expected_head_sha=${previous}\\nTOKEN=merge-token\\n`));

  const candidate = {
    number: 1, head, mergeStateStatus: 'CLEAN',
    comments: [markerComment, { id: 100, body: recordBody, user: actionsBotUser }],
    reviews: [codeRabbitDiscoveryReview(previous)],
    commits: [{ sha: previous }, { sha: head }],
    headParents: [previous, mainParent],
    compare: { [mainParent]: 'ahead' },
  };
  const reissued = runSyncQueue(workflow, [candidate]);
  assert.equal(reissued.status, 0, reissued.stderr);
  assert.match(reissued.calls, new RegExp(`gh api --method PATCH repos/o/r/issues/comments/99 -f body=${markerFor(head)}\\nTOKEN=github-token\\n`));
  assert.equal(reissued.mergedPr, 1, 'CodeRabbit discovery on previous must still satisfy the gate after base-update marker reissue');

  const clearedPriorActOnReviews = [
    codeRabbitDiscoveryReview(initialSha, { id: 4, submitted_at: '2026-09-29T00:00:00Z' }),
    interrogateReview(initialSha, {
      id: 5,
      submitted_at: '2026-09-29T00:05:00Z',
      body: interrogateDiscoveryBody(initialSha, '1'),
    }),
    interrogateReview(previous, { id: 6, submitted_at: '2026-09-29T00:10:00Z' }),
  ];
  const clearedBehind = runSyncQueue(workflow, [{
    number: 1,
    head: previous,
    mergeStateStatus: 'BEHIND',
    comments: [markerComment],
    reviews: clearedPriorActOnReviews,
    commits: [{ sha: initialSha }, { sha: previous }],
  }], { hasPat: true });
  assert.equal(clearedBehind.status, 0, clearedBehind.stderr);
  assert.match(clearedBehind.calls, new RegExp(`update-branch -f expected_head_sha=${previous}\\nTOKEN=merge-token\\n`));
  const clearedMerged = runSyncQueue(workflow, [{
    ...candidate,
    reviews: clearedPriorActOnReviews,
    commits: [{ sha: initialSha }, { sha: previous }, { sha: head }],
  }]);
  assert.equal(clearedMerged.status, 0, clearedMerged.stderr);
  assert.equal(
    clearedMerged.mergedPr,
    1,
    'same-reviewer act-on=0 on previous must keep prior ACT_ON cleared after coordinator base-update merge commit',
  );

  const interrogateBehind = runSyncQueue(workflow, [
    {
      number: 1, head: previous, mergeStateStatus: 'BEHIND',
      comments: [markerComment], reviews: [interrogateReview(previous)], commits: [{ sha: previous }],
    },
    {
      number: 2, head: nextHead, mergeStateStatus: 'CLEAN',
      comments: [{ id: 101, body: markerFor(nextHead), user: actionsBotUser }],
      reviews: [interrogateReview(nextHead)],
      commits: [{ sha: nextHead }],
    },
  ], { hasPat: true });
  assert.equal(interrogateBehind.status, 0, interrogateBehind.stderr);
  assert.doesNotMatch(interrogateBehind.calls, /update-branch|--method (POST|PATCH)/);
  assert.deepEqual(interrogateBehind.removedLabels, [1], 'non-transferable BEHIND candidate must remove automerge label');
  assert.match(
    interrogateBehind.stdout,
    /PR #1 is behind main without a transferable frozen discovery review; its owning SSD worktree must rebase and re-review\./,
  );
  assert.equal(interrogateBehind.mergedPr, 2, 'non-transferable BEHIND candidate must not block a ready CLEAN candidate behind it');

  const commitsReadFailed = runSyncQueue(workflow, [
    {
      number: 1, head: previous, mergeStateStatus: 'CLEAN',
      comments: [markerComment], reviews: [interrogateReview(previous)], commits: '__FAIL__',
    },
    {
      number: 2, head: nextHead, mergeStateStatus: 'CLEAN',
      comments: [{ id: 101, body: markerFor(nextHead), user: actionsBotUser }],
      reviews: [interrogateReview(nextHead)],
      commits: [{ sha: nextHead }],
    },
  ]);
  assert.equal(commitsReadFailed.status, 0, commitsReadFailed.stderr);
  assert.equal(commitsReadFailed.mergedPr, 2, 'commits read failure must skip only that candidate');

  const interrogateStaleOnNewHead = runSyncQueue(workflow, [{
    ...candidate,
    reviews: [interrogateReview(previous)],
  }]);
  assert.equal(interrogateStaleOnNewHead.status, 0, interrogateStaleOnNewHead.stderr);
  assert.equal(interrogateStaleOnNewHead.mergedPr, null, 'pstack-interrogate on previous head must not merge the new base-update head');

  const interrogateFreshOnNewHead = runSyncQueue(workflow, [{
    ...candidate,
    reviews: [interrogateReview(previous), interrogateReview(head, { id: 6 })],
  }]);
  assert.equal(interrogateFreshOnNewHead.status, 0, interrogateFreshOnNewHead.stderr);
  assert.equal(interrogateFreshOnNewHead.mergedPr, 1, 'pstack-interrogate on current head must merge after base-update marker reissue');

  const sessionMerge = runSyncQueue(workflow, [{ ...candidate, comments: [markerComment] }]);
  assert.equal(sessionMerge.status, 0, sessionMerge.stderr);
  assert.doesNotMatch(sessionMerge.calls, /--method (PATCH|POST)/);
  assert.equal(sessionMerge.mergedPr, null, 'a session-pushed merge commit must wait for a new label authorization');

  const recovery = {
    ...candidate,
    comments: [],
    headParents: undefined,
    compare: undefined,
    commits: [committedAt(previous, '2026-09-29T00:00:00Z'), committedAt(head, '2026-09-29T01:00:00Z')],
  };
  const pushedAfterLabel = runSyncQueue(workflow, [{ ...recovery, events: [[labeledAt('2026-09-29T00:30:00Z')]] }]);
  assert.equal(pushedAfterLabel.status, 0, pushedAfterLabel.stderr);
  assert.doesNotMatch(pushedAfterLabel.calls, /--method (PATCH|POST)/, 'a head pushed after the label must not be recovered');
  assert.equal(pushedAfterLabel.mergedPr, null);

  const recovered = runSyncQueue(workflow, [{ ...recovery, events: [[labeledAt('2026-09-29T02:00:00Z')]] }]);
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.match(recovered.calls, new RegExp(`gh api --method POST repos/o/r/issues/1/comments -f body=${markerFor(head)}\\nTOKEN=github-token\\n`));
  assert.equal(recovered.mergedPr, 1, 'a recovered marker must satisfy the unchanged review gate in the same run');
});

test('비승계 BEHIND 후보의 라벨 제거 뒤 소유 세션 rebase·재리뷰·재라벨이 canonical marker를 갱신해 병합한다', async () => {
  const workflow = await readWorkflow();
  const sha1 = '1'.repeat(40);
  const sha2 = '2'.repeat(40);
  const initialComments = [{ id: 99, body: markerFor(sha1), user: actionsBotUser }];

  const step1Behind = runSyncQueue(
    workflow,
    [{
      number: 1,
      head: sha1,
      mergeStateStatus: 'BEHIND',
      comments: initialComments,
      reviews: [interrogateReview(sha1)],
      commits: [{ sha: sha1 }],
    }],
    { hasPat: true },
  );
  assert.equal(step1Behind.status, 0, step1Behind.stderr);
  assert.equal(step1Behind.mergedPr, null);
  assert.deepEqual(step1Behind.removedLabels, [1]);
  assert.doesNotMatch(step1Behind.calls, /update-branch/);

  const rebasedReviews = [interrogateReview(sha1, { id: 5 }), interrogateReview(sha2, { id: 6 })];
  const step2RelabeledPending = runSyncQueue(
    workflow,
    [{
      number: 1,
      head: sha2,
      mergeStateStatus: 'BLOCKED',
      checkState: 'pending',
      comments: step1Behind.commentsByPr[1],
      reviews: rebasedReviews,
      commits: [{ sha: sha2 }],
    }],
    {
      hasPat: true,
      eventName: 'pull_request_target',
      eventPr: '1',
      eventHead: sha2,
    },
  );
  assert.equal(step2RelabeledPending.status, 0, step2RelabeledPending.stderr);
  assert.equal(step2RelabeledPending.mergedPr, null);
  assert.match(
    step2RelabeledPending.calls,
    new RegExp(`gh api --method PATCH repos/o/r/issues/comments/99 -f body=${markerFor(sha2)}`),
  );
  assert.deepEqual(step2RelabeledPending.commentsByPr[1], [
    { id: 99, body: markerFor(sha2), user: actionsBotUser },
  ]);

  const step3CleanMerge = runSyncQueue(
    workflow,
    [{
      number: 1,
      head: sha2,
      mergeStateStatus: 'CLEAN',
      comments: step2RelabeledPending.commentsByPr[1],
      reviews: rebasedReviews,
      commits: [{ sha: sha2 }],
    }],
    { hasPat: true },
  );
  assert.equal(step3CleanMerge.status, 0, step3CleanMerge.stderr);
  assert.equal(step3CleanMerge.mergedPr, 1);
  assert.match(step3CleanMerge.calls, new RegExp(`gh pr merge --squash 1 --repo o/r --match-head-commit ${sha2}`));
});

test('모든 PR 템플릿이 현재 head의 pstack interrogate 단일 마커 계약을 안내하고 은퇴한 폴백 문구를 남기지 않는다', async () => {
  const expectedLine =
    '- [ ] 현재 head에 대한 `pstack` `interrogate` Review(`<!-- pstack-interrogate head=<40자 sha> act-on=0 -->`)를 단일 PR review로 게시했습니다.';
  for (const templateUrl of prTemplateUrls) {
    const content = await readFile(templateUrl, 'utf8');
    assert.doesNotMatch(
      content,
      /aquila-review|Aquila 마커|Codex|폴백 리뷰|CodeRabbit Review 객체가 없으면/i,
      `${templateUrl.pathname} must not contain retired fallback wording`,
    );
    assert.ok(
      content.includes(expectedLine),
      `${templateUrl.pathname} must include the exact pstack interrogate checklist item`,
    );
  }
});

test('워크플로의 모든 비-reduce jq as 바인딩이 ((<lhs>) as $<var> | <body>) 형식을 지키고 jq 컴파일을 통과한다', async () => {
  for (const [label, badSource] of [
    ['unparenthesized lhs', '.[0] as $x | $x'],
    ['unparenthesized lhs inside parens', '(.foo as $x | $x)'],
    ['missing outer grouping parens', '(.foo) as $x | $x'],
    ['body outside outer parens', '((.[0]) as $x) | $x'],
    ['compound boolean lhs without outer parens', '(true and ($files | flatten) as $changed | $changed)'],
    ['nested second as without own outer parens', '((.a) as $x | (.b) as $y | $x + $y)'],
    ['call paren masquerading as outer grouping paren', 'any((.foo) as $x | $x)'],
    ['call paren with space masquerading as outer grouping paren', 'select ((.foo) as $x | $x)'],
    ['semicolon inside outer grouping level', 'def f(a; b): a; f((.foo) as $x | $x; 1)'],
    ['object destructuring without outer parens', '(.foo) as {a: $a} | $a'],
    ['array destructuring without outer parens', '(.foo) as [$a] | $a'],
    ['string interpolation violation', '"\\((.foo) as $x | $x)"'],
    ['hash inside string does not hide unparenthesized as', '"# hash inside string" | . as $x | $x'],
    ['as following reduce outside header', 'reduce .[] as $r ({}; .) | (.foo) as $x | $x'],
  ]) {
    assert.equal(
      validateJqAsBindings(badSource).ok,
      false,
      `validator must reject ${label}: ${badSource}`,
    );
  }

  for (const [label, goodSource] of [
    ['properly wrapped single binding', '((.foo) as $x | $x)'],
    ['properly wrapped nested bindings', '((.a) as $x | ((.b) as $y | $x + $y))'],
    ['properly wrapped call argument', 'select(((.x) as $v | $v))'],
    ['properly wrapped boolean rhs', 'true and ((.x) as $v | $v)'],
    ['reduce header binding', 'reduce (.items[] | select(.ok)) as $item ({}; . + $item)'],
    ['foreach header binding', '[foreach .[] as $item (0; . + $item; .)]'],
    ['destructuring wrapped properly', '((.foo) as {a: $a} | $a)'],
    ['array destructuring wrapped properly', '((.foo) as [$a, $b] | $a + $b)'],
    ['string interpolation wrapped properly', '"\\(((.foo) as $x | $x))"'],
    ['comment line ignored', '# . as $ignored_comment | .\n((.[0]) as $x | $x)'],
    ['literal "as $x" inside string', '"foo as $x | bar"'],
  ]) {
    const check = validateJqAsBindings(goodSource);
    assert.equal(
      check.ok,
      true,
      `validator must accept ${label} (${check.reason ?? 'ok'}): ${goodSource}`,
    );
  }

  for (const [label, badWorkflow] of [
    ['double-quoted jq filter', 'run: |\n  out="$(jq -r ".foo | . as $x | $x" <<<"$x")"\n'],
    ['double-quoted --jq filter', 'run: |\n  gh api rate_limit --jq ".resources.core.remaining"\n'],
    ['unknown prefix variable', 'run: |\n  out="$(jq -r "${unknown_defs}"\'.\' <<<"$x")"\n'],
    ['nested $(jq ...) in --argjson', 'run: |\n  out="$(jq -c --argjson r "$(jq -c \'{id}\' <<<"$a")" \'.\' <<<"$b")"\n'],
    ['nested $(jq ...) in here-string input', 'run: |\n  out="$(jq -r \'.\' <<<"$(jq -c \'.\' <<<"$a")")"\n'],
    ['gh -q shorthand', 'run: |\n  gh api rate_limit -q \'. as $x | $x\'\n'],
    ['+= query mutation', 'run: |\n  q_query=\'.x\'\n  q_query+=\' | . as $x | $x\'\n  gh api x --jq "${q_query}"\n'],
    ['eval command wrapper', 'run: |\n  eval "jq -r \'. as \\$x | \\$x\' <<<\'{}\'"\n'],
    ['bash -c subshell bypass', 'run: |\n  bash -c "jq -r \'. as \\$x | \\$x\' <<<\'{}\'"\n'],
    ['non-JQ heredoc jq reference', 'run: |\n  msg="$(cat <<\'EOF\'\njq -r \'. as $x | $x\'\nEOF\n)"\n'],
    ['quoted YAML run key', "'run': |\n  jq -r '. as $x | $x' <<<'{}'\n"],
    ['folded YAML run scalar', 'name: T\non: push\njobs:\n  t:\n    steps:\n      - run: >\n          jq -r \'. as $x | $x\' <<<\'{}\'\n'],
  ]) {
    assert.equal(
      auditWorkflowJqInvocations(badWorkflow).ok,
      false,
      `workflow auditor must fail closed on ${label}`,
    );
  }

  const automergeWorkflow = await readWorkflow();
  const automationWorkflow = await readFile(automationWorkflowUrl, 'utf8');
  const stripDefs = [
    ...automergeWorkflow.matchAll(/def strip_markdown_code\(\$keep_unclosed\):[\s\S]*?;\n/g),
  ].map((m) => m[0]);
  assert.equal(stripDefs.length, 1, 'strip_markdown_code($keep_unclosed) must be defined once in review_jq_defs');
  assert.doesNotMatch(stripDefs[0], /`/, 'strip_markdown_code($keep_unclosed) must use \\x60 instead of literal backticks');

  for (const [name, workflowText, minCommands, minBindings] of [
    ['automerge-queue.yml', automergeWorkflow, 30, 10],
    ['automation-pr-automerge.yml', automationWorkflow, 0, 0],
  ]) {
    const audit = auditWorkflowJqInvocations(workflowText);
    assert.equal(audit.ok, true, `${name}: ${audit.reason ?? 'ok'}`);
    assert.equal(extractWorkflowJqPrograms(workflowText).length, audit.programs.length);
    assert.ok(
      audit.commandCount >= minCommands,
      `${name}: expected at least ${minCommands} audited jq/--jq invocations, got ${audit.commandCount}`,
    );

    let checkedNonReduce = 0;
    let checkedLoop = 0;
    for (const program of audit.programs) {
      const validation = validateJqAsBindings(program);
      assert.equal(
        validation.ok,
        true,
        `${name} violates ((<lhs>) as $<var> | <body>) (${validation.reason}):\n${program}`,
      );
      checkedNonReduce += validation.nonReduceCount;
      checkedLoop += validation.loopCount;
    }

    const commentStrippedWorkflow = workflowText
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n');
    const totalWorkflowAsBindings = [
      ...commentStrippedWorkflow.matchAll(/\bas\s*(?:\$[A-Za-z_][A-Za-z0-9_]*|\{|\[)/g),
    ].length;
    assert.ok(totalWorkflowAsBindings >= minBindings);
    assert.equal(
      checkedNonReduce + checkedLoop,
      totalWorkflowAsBindings,
      `${name}: every jq as binding must be accounted for by AST audit`,
    );
  }
});

// #3036: 큐를 다시 깨울 이벤트가 오지 않는 공백을 schedule tick이 메운다. RC chain이 GITHUB_TOKEN으로 dispatch한
// 발행 체인 run은 끝나도 workflow_run을 만들지 않아(실측 39건 중 37건 후속 실행 없음) 체인 잠금으로 건너뛴 후보가
// 사람이 dispatch할 때까지 남았다. 빈 큐 tick은 checkout 없이 목록 조회 한 번으로 끝나야 한다.
const PROBE_JOB_RE = /\n {2}queue-probe:\n([\s\S]*?)\n {2}coordinate:\n/;
const COORDINATE_HEAD_RE = /\n {2}coordinate:\n([\s\S]*?)\n {4}steps:\n/;

const scheduleMinutesOf = (workflow) => {
  const cron = workflow.match(/\n {2}schedule:\n {4}- cron: "([^"]+)"\n/)?.[1];
  assert.ok(cron, 'schedule cron trigger is missing');
  const [minute, ...rest] = cron.split(' ');
  assert.deepEqual(rest, ['*', '*', '*', '*'], 'the tick must fire every hour of every day');
  return minute.split(',').map(Number);
};

const runQueueProbe = (workflow, { listOutput = '0', listFails = false } = {}) => {
  const job = workflow.match(PROBE_JOB_RE)?.[1];
  assert.ok(job, 'queue-probe job must precede coordinate');
  const script = job.match(/\n {8}run: \|\n([\s\S]*)$/)?.[1];
  assert.ok(script, 'queue-probe must have one run block');
  for (const line of script.split('\n').filter((l) => l.trim() !== '')) {
    assert.ok(line.startsWith(' '.repeat(10)), `probe run line escapes the YAML block scalar: ${line.slice(0, 48)}`);
  }
  const dir = mkdtempSync(join(tmpdir(), 'automerge-probe-'));
  const log = join(dir, 'gh.log');
  const output = join(dir, 'output');
  const result = spawnSync(
    'bash',
    [
      '-c',
      [
        `GH_LOG=${JSON.stringify(log)}`,
        `GITHUB_OUTPUT=${JSON.stringify(output)}`,
        'GITHUB_REPOSITORY=o/r',
        ': > "$GH_LOG"; : > "$GITHUB_OUTPUT"',
        'gh() {',
        '  printf "%s\\n" "gh $*" >> "$GH_LOG"',
        listFails ? '  return 1' : `  printf "%s\\n" ${JSON.stringify(listOutput)}`,
        '}',
        dedent(script),
      ].join('\n'),
    ],
    { encoding: 'utf8' },
  );
  return {
    status: result.status,
    output: readFileSync(output, 'utf8'),
    calls: readFileSync(log, 'utf8').split('\n').filter(Boolean),
  };
};

test('schedule tick이 이벤트 없이도 큐를 다시 판정하고 빈 큐에서는 목록 조회 한 번으로 끝난다', async () => {
  const workflow = await readWorkflow();

  const minutes = scheduleMinutesOf(workflow);
  assert.ok(minutes.every((m) => Number.isInteger(m) && m > 0 && m < 60), 'tick minutes must avoid the top of the hour');
  const sorted = [...minutes].sort((a, b) => a - b);
  const gaps = sorted.map((m, i) => (i + 1 < sorted.length ? sorted[i + 1] : sorted[0] + 60) - m);
  assert.ok(Math.max(...gaps) <= 15, `tick interval must stay within 15 minutes: ${gaps}`);

  const probe = workflow.match(PROBE_JOB_RE)?.[1] ?? '';
  assert.match(probe, /\n {4}if: github\.event_name == 'schedule'\n/);
  assert.match(probe, /\n {4}permissions:\n {6}pull-requests: read\n {4}outputs:/);
  assert.doesNotMatch(probe, /uses:/, 'the probe must not check out or call actions');

  const idle = runQueueProbe(workflow, { listOutput: '0' });
  assert.equal(idle.status, 0, idle.stderr);
  assert.equal(idle.output, 'labeled=false\n');
  assert.equal(idle.calls.length, 1);
  assert.match(idle.calls[0], /^gh pr list --repo o\/r --base main --state open --label automerge --draft=false --limit 1 /);

  assert.equal(runQueueProbe(workflow, { listOutput: '1' }).output, 'labeled=true\n');

  for (const broken of [{ listFails: true }, { listOutput: 'oops' }]) {
    const result = runQueueProbe(workflow, broken);
    assert.notEqual(result.status, 0, 'an unreadable queue must fail the probe, not report it empty');
    assert.equal(result.output, '');
  }
});

// coordinate의 if를 문자열이 아니라 이벤트 조합별 실행 여부로 검증한다. 첫 &&가 ||로 바뀌면 probe가 실패하거나
// 라벨 PR이 없다고 답해도 schedule tick이 coordinate를 띄우게 되므로, 그 조합을 모두 표로 못 박는다.
const COORDINATE_IF_CASES = [
  { name: 'schedule, 라벨 PR 있음', event: 'schedule', labeled: 'true', runs: true },
  { name: 'schedule, 라벨 PR 없음', event: 'schedule', labeled: 'false', runs: false },
  { name: 'schedule, probe 출력 없음', event: 'schedule', labeled: '', runs: false },
  { name: 'schedule, probe 실패(출력 없음)', event: 'schedule', labeled: '', runs: false },
  { name: 'schedule, probe 취소(출력 없음)', event: 'schedule', labeled: '', cancelled: true, runs: false },
  { name: 'schedule, 라벨 PR 있음이어도 워크플로 취소', event: 'schedule', labeled: 'true', cancelled: true, runs: false },
  { name: 'push', event: 'push', runs: true },
  { name: 'workflow_run', event: 'workflow_run', runs: true },
  { name: 'pull_request_target, automerge 라벨', event: 'pull_request_target', label: 'automerge', runs: true },
  { name: 'pull_request_target, 다른 라벨', event: 'pull_request_target', label: 'bug', runs: false },
  { name: 'pull_request_review', event: 'pull_request_review', runs: true },
  { name: 'workflow_dispatch', event: 'workflow_dispatch', runs: true },
];

test('coordinate는 schedule에서 라벨 PR이 있을 때만 돌고 동시성 그룹은 coordinate job만 점유한다', async () => {
  const workflow = await readWorkflow();
  const head = workflow.match(COORDINATE_HEAD_RE)?.[1] ?? '';

  assert.match(head, /\n {4}needs: queue-probe\n/);
  const condition = head.match(/\n {4}if: (.+)\n/)?.[1];
  assert.ok(condition, 'coordinate must have a single-line if');
  for (const { name, event, labeled, label, cancelled = false, runs } of COORDINATE_IF_CASES) {
    // 이벤트가 schedule이 아니면 queue-probe가 건너뛰어져 출력이 비어 있다.
    const needs = { 'queue-probe': { outputs: labeled === undefined ? {} : { labeled } } };
    const context = { github: { event_name: event, event: { label: { name: label ?? '' } } }, needs, cancelled };
    assert.equal(evaluateGithubExpression(condition, context), runs, `coordinate if: ${name}`);
  }
  // 빈 큐 tick이 그룹에 들어가면 대기 중인 라벨 run을 밀어낼 수 있다. 그룹은 coordinate job에만 둔다.
  assert.match(head, /\n {4}concurrency:\n {6}group: automerge-queue\n {6}cancel-in-progress: false\n/);
  assert.doesNotMatch(workflow, /^concurrency:/m);
});
