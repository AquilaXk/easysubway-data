import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildDurationShards,
  combineDurationEvidence,
  parseGitIndex,
  selectExecutionTests,
  validateOwnership,
} from './data-test-discovery.mjs';

const requiredInvocation =
  'node tools/ci/data-test-discovery.mjs run --class required-pr --default-profile';
const profileInvocation =
  'node tools/ci/data-test-discovery.mjs run --class required-pr --profile mobile-v19 --max-workers 1';
const releaseInvocation =
  'node tools/ci/data-test-discovery.mjs run --class deterministic-release --max-workers 1';
const discoverySource = readFileSync(
  fileURLToPath(new URL('./data-test-discovery.mjs', import.meta.url)),
  'utf8',
);

function fixture() {
  const tests = [
    {
      path: 'tools/ci/alpha.test.mjs',
      semanticOwner: 'data25',
      classes: ['required-pr'],
      durationMs: 120,
    },
    {
      path: 'tools/datapack/release.test.mjs',
      semanticOwner: 'data38',
      classes: ['required-pr', 'deterministic-release'],
      durationMs: 80,
    },
  ];
  return {
    manifest: {
      version: 1,
      executionOwner: 'data25',
      executionProfiles: {
        'mobile-v19': {},
      },
      roots: [
        'tools/ci',
        'tools/datapack',
        'tools/release',
        'tools/route-map',
        'tools/routes',
      ],
      owners: {
        data25: {
          issueUrl: 'https://github.com/AquilaXk/easysubway-data/issues/25',
          title: '[CI][Data][P1] 소유 테스트 dynamic discovery·누락 0 gate',
        },
        data38: {
          issueUrl: 'https://github.com/AquilaXk/easysubway-data/issues/38',
          title: '[Feat][Epic][Architecture][Data][P0] Map Pack·Station Catalog·Server Route Bundle 3-artifact 정본',
        },
      },
      fixtures: {
        mobile: {
          repository: 'AquilaXk/easysubway-mobile',
          commit: 'd85742f14cbf97c526a6b94dd55bbf863e1d1346',
          checkoutPath: '.external/mobile',
          sourcePath: 'apps/mobile',
          path: 'apps/mobile',
          requiredFiles: [
            {
              path: 'pubspec.yaml',
              sha256: '23826001737d93cb613711e7c4bb5692cbce6864e345110fbf0af37294595324',
              profileSha256: {
                'mobile-v19': '1'.repeat(64),
              },
            },
          ],
        },
      },
      workflows: {
        'required-pr': {
          file: '.github/workflows/ci.yml',
          jobId: 'contracts',
          checkName: 'Data contracts',
          invocation: requiredInvocation,
          required: true,
          fixtures: ['mobile'],
          fixtureStageContracts: {
            mobile: ['cp -a .external/mobile/apps/mobile apps/mobile'],
          },
          contextInvocations: [],
          profileInvocations: [profileInvocation],
        },
        'deterministic-release': {
          file: '.github/workflows/datapack-release.yml',
          jobId: 'data-pack-release',
          checkName: 'Data Pack Release',
          invocation: releaseInvocation,
          required: false,
        },
      },
      tests,
    },
    trackedEntries: tests.map(({ path }) => ({ path, mode: '100644' })),
    sources: Object.fromEntries(tests.map(({ path }) => [path, "import test from 'node:test';\ntest('ok', () => {});\n"])),
    workflowSources: {
      '.github/workflows/ci.yml': `jobs:\n  contracts:\n    name: Data contracts\n    steps:\n      - uses: actions/checkout@immutable\n        with:\n          ref: \${{ github.event.pull_request.head.sha || github.sha }}\n          persist-credentials: false\n      - uses: actions/checkout@immutable\n        with:\n          repository: AquilaXk/easysubway-mobile\n          ref: d85742f14cbf97c526a6b94dd55bbf863e1d1346\n          path: .external/mobile\n          persist-credentials: false\n      - run: cp -a .external/mobile/apps/mobile apps/mobile\n      - run: ${profileInvocation}\n      - run: ${requiredInvocation}\n`,
      '.github/workflows/datapack-release.yml': `jobs:\n  data-pack-release:\n    name: Data Pack Release\n    steps:\n      - run: ${releaseInvocation}\n`,
    },
    fixtureStates: {
      mobile: {
        headSha: 'd85742f14cbf97c526a6b94dd55bbf863e1d1346',
        files: {
          'pubspec.yaml': '23826001737d93cb613711e7c4bb5692cbce6864e345110fbf0af37294595324',
        },
      },
    },
  };
}

function errorCodes(callback) {
  assert.throws(callback, (error) => {
    assert.ok(Array.isArray(error.issues));
    return true;
  });
  try {
    callback();
  } catch (error) {
    return error.issues.map(({ code }) => code);
  }
  return [];
}

test('valid ownership covers every tracked test and both workflow classes', () => {
  const result = validateOwnership(fixture());

  assert.equal(result.total, 2);
  assert.equal(result.classCounts['required-pr'], 2);
  assert.equal(result.classCounts['deterministic-release'], 1);
  assert.match(result.inventoryDigest, /^[a-f0-9]{64}$/);
});
test('missing, stale, renamed and duplicate manifest entries fail closed', () => {
  const missing = fixture();
  missing.manifest.tests.pop();
  assert.ok(errorCodes(() => validateOwnership(missing)).includes('UNOWNED_TRACKED_TEST'));

  const stale = fixture();
  stale.trackedEntries.pop();
  assert.ok(errorCodes(() => validateOwnership(stale)).includes('STALE_MANIFEST_TEST'));

  const duplicate = fixture();
  duplicate.manifest.tests.push({ ...duplicate.manifest.tests[0] });
  assert.ok(errorCodes(() => validateOwnership(duplicate)).includes('DUPLICATE_TEST_PATH'));
});

test('out-of-root, unsafe path and non-regular Git mode fail closed', () => {
  const outside = fixture();
  outside.trackedEntries.push({ path: 'scripts/outside.test.mjs', mode: '100644' });
  outside.sources['scripts/outside.test.mjs'] = "test('outside', () => {});\n";
  assert.ok(errorCodes(() => validateOwnership(outside)).includes('TEST_OUTSIDE_ROOTS'));

  const traversal = fixture();
  traversal.manifest.tests[0].path = 'tools/ci/../escape.test.mjs';
  assert.ok(errorCodes(() => validateOwnership(traversal)).includes('UNSAFE_TEST_PATH'));

  const symlink = fixture();
  symlink.trackedEntries[0].mode = '120000';
  assert.ok(errorCodes(() => validateOwnership(symlink)).includes('NON_REGULAR_TEST'));
});

test('unknown owner, class, workflow and missing duration fail closed', () => {
  const owner = fixture();
  owner.manifest.tests[0].semanticOwner = 'missing';
  assert.ok(errorCodes(() => validateOwnership(owner)).includes('UNKNOWN_OWNER'));

  const className = fixture();
  className.manifest.tests[0].classes = ['scheduled-live'];
  assert.ok(errorCodes(() => validateOwnership(className)).includes('UNKNOWN_EXECUTION_CLASS'));

  const workflow = fixture();
  workflow.manifest.workflows['required-pr'].jobId = 'renamed';
  assert.ok(errorCodes(() => validateOwnership(workflow)).includes('WORKFLOW_JOB_MISSING'));

  const duration = fixture();
  duration.manifest.tests[0].durationMs = null;
  assert.ok(errorCodes(() => validateOwnership(duration)).includes('INVALID_DURATION'));
});

test('external fixture identity and exact PR-head checkout fail closed on drift', () => {
  const mutable = fixture();
  mutable.manifest.fixtures.mobile.commit = 'main';
  assert.ok(errorCodes(() => validateOwnership(mutable)).includes('INVALID_FIXTURE_COMMIT'));

  const wrongHead = fixture();
  wrongHead.fixtureStates.mobile.headSha = '0000000000000000000000000000000000000000';
  assert.ok(errorCodes(() => validateOwnership(wrongHead)).includes('FIXTURE_HEAD_MISMATCH'));

  const wrongHash = fixture();
  wrongHash.fixtureStates.mobile.files['pubspec.yaml'] = '0'.repeat(64);
  assert.ok(errorCodes(() => validateOwnership(wrongHash)).includes('FIXTURE_HASH_MISMATCH'));

  const mergeCheckout = fixture();
  mergeCheckout.workflowSources['.github/workflows/ci.yml'] = mergeCheckout.workflowSources[
    '.github/workflows/ci.yml'
  ].replace('ref: ${{ github.event.pull_request.head.sha || github.sha }}\n', '');
  assert.ok(errorCodes(() => validateOwnership(mergeCheckout)).includes('PR_HEAD_CHECKOUT_MISSING'));

  const staticOnly = fixture();
  staticOnly.fixtureStates = {};
  staticOnly.requireFixtureStates = false;
  assert.doesNotThrow(() => validateOwnership(staticOnly));
});

test('execution profiles bind manifest membership and fixture hashes', () => {
  const profiled = fixture();
  profiled.manifest.tests[0].executionProfile = 'mobile-v19';
  profiled.executionProfile = 'mobile-v19';
  profiled.fixtureStates.mobile.files['pubspec.yaml'] = '1'.repeat(64);
  const result = validateOwnership(profiled);
  assert.deepEqual(
    selectExecutionTests(result.tests, 'required-pr', 'mobile-v19', false).map(({ path }) => path),
    ['tools/ci/alpha.test.mjs'],
  );
  assert.deepEqual(
    selectExecutionTests(result.tests, 'required-pr', null, true).map(({ path }) => path),
    ['tools/datapack/release.test.mjs'],
  );

  const unknown = fixture();
  unknown.manifest.tests[0].executionProfile = 'missing';
  assert.ok(errorCodes(() => validateOwnership(unknown)).includes('UNKNOWN_EXECUTION_PROFILE'));

  const badHash = fixture();
  badHash.manifest.fixtures.mobile.requiredFiles[0].profileSha256['mobile-v19'] = 'mutable';
  assert.ok(errorCodes(() => validateOwnership(badHash)).includes('INVALID_FIXTURE_PROFILE_HASH'));
});

test('release-only ownership is valid but required workflow cannot become advisory', () => {
  const releaseOnly = fixture();
  releaseOnly.manifest.tests[0].classes = ['deterministic-release'];
  assert.doesNotThrow(() => validateOwnership(releaseOnly));

  const advisory = fixture();
  advisory.manifest.workflows['required-pr'].required = false;
  assert.ok(errorCodes(() => validateOwnership(advisory)).includes('REQUIRED_WORKFLOW_ADVISORY'));
});

test('skip and only markers in tracked tests fail closed', () => {
  for (const marker of [
    "test.skip('later', () => {});",
    "test.only('focused', () => {});",
    "test('later', { skip: true }, () => {});",
    "describe('focused', { only: true }, () => {});",
  ]) {
    const value = fixture();
    value.sources['tools/ci/alpha.test.mjs'] = marker;
    assert.ok(errorCodes(() => validateOwnership(value)).includes('FORBIDDEN_TEST_SELECTION'));
  }
});

test('selection-like text inside strings and comments is not executable selection', () => {
  const value = fixture();
  value.sources['tools/ci/alpha.test.mjs'] = `
    const examples = ["test.skip('later')", 'describe.only("focused")'];
    // test.only('commented', () => {});
    /* test('commented', { skip: true }, () => {}); */
    test('real', () => examples.length);
  `;
  assert.doesNotThrow(() => validateOwnership(value));
});

test('workflow hand lists, missing invocation and warning wrappers fail closed', () => {
  const handList = fixture();
  handList.workflowSources['.github/workflows/ci.yml'] +=
    '      - run: node --test tools/ci/alpha.test.mjs\n';
  assert.ok(errorCodes(() => validateOwnership(handList)).includes('WORKFLOW_HAND_LIST'));

  const declaredContext = fixture();
  const contextInvocation = 'node --test tools/ci/alpha.test.mjs';
  declaredContext.manifest.workflows['required-pr'].contextInvocations = [contextInvocation];
  declaredContext.workflowSources['.github/workflows/ci.yml'] += `      - run: ${contextInvocation}\n`;
  assert.doesNotThrow(() => validateOwnership(declaredContext));

  const contextDrift = structuredClone(declaredContext);
  contextDrift.workflowSources['.github/workflows/ci.yml'] = contextDrift.workflowSources[
    '.github/workflows/ci.yml'
  ].replace(contextInvocation, 'node --test tools/ci/beta.test.mjs');
  const contextDriftCodes = errorCodes(() => validateOwnership(contextDrift));
  assert.ok(contextDriftCodes.includes('CONTEXT_INVOCATION_MISMATCH'));
  assert.ok(contextDriftCodes.includes('WORKFLOW_HAND_LIST'));

  const malformedContext = fixture();
  malformedContext.manifest.workflows['required-pr'].contextInvocations = 'node --test tools/ci/alpha.test.mjs';
  assert.ok(
    errorCodes(() => validateOwnership(malformedContext)).includes('INVALID_CONTEXT_INVOCATIONS'),
  );

  const malformedStage = fixture();
  malformedStage.manifest.workflows['required-pr'].fixtureStageContracts.mobile = [123];
  assert.ok(
    errorCodes(() => validateOwnership(malformedStage)).includes(
      'INVALID_WORKFLOW_FIXTURE_STAGE_CONTRACT',
    ),
  );

  const missing = fixture();
  missing.workflowSources['.github/workflows/ci.yml'] = missing.workflowSources[
    '.github/workflows/ci.yml'
  ].replace(requiredInvocation, 'echo omitted');
  assert.ok(errorCodes(() => validateOwnership(missing)).includes('WORKFLOW_INVOCATION_MISSING'));

  const warning = fixture();
  warning.workflowSources['.github/workflows/ci.yml'] = warning.workflowSources[
    '.github/workflows/ci.yml'
  ].replace(`run: ${requiredInvocation}`, `continue-on-error: true\n        run: ${requiredInvocation}`);
  assert.ok(errorCodes(() => validateOwnership(warning)).includes('WORKFLOW_WARNING_ONLY'));
});

test('Git index parser rejects malformed records and preserves modes', () => {
  const parsed = parseGitIndex(
    '100644 0123456789012345678901234567890123456789 0\ttools/ci/alpha.test.mjs\0' +
      '120000 0123456789012345678901234567890123456789 0\ttools/ci/link.test.mjs\0',
  );
  assert.deepEqual(parsed, [
    { path: 'tools/ci/alpha.test.mjs', mode: '100644' },
    { path: 'tools/ci/link.test.mjs', mode: '120000' },
  ]);
  assert.throws(() => parseGitIndex('broken\0'), /malformed Git index record/);
});

test('discovery runtime uses explicit sorting and a fixed Git executable', () => {
  assert.doesNotMatch(discoverySource, /\.sort\(\)/);
  assert.doesNotMatch(discoverySource, /execFileSync\(['"]git['"]/);
  assert.match(discoverySource, /const GIT_EXECUTABLE = '\/usr\/bin\/git';/);
});

test('duration-based shards are deterministic and never duplicate or drop tests', () => {
  const entries = [
    { path: 'a.test.mjs', durationMs: 100 },
    { path: 'b.test.mjs', durationMs: 90 },
    { path: 'c.test.mjs', durationMs: 20 },
    { path: 'd.test.mjs', durationMs: 10 },
  ];

  const first = buildDurationShards(entries, 2);
  const second = buildDurationShards([...entries].reverse(), 2);
  assert.deepEqual(first, second);
  assert.deepEqual(
    first.flatMap(({ tests }) => tests).sort(),
    entries.map(({ path }) => path).sort(),
  );
  assert.deepEqual(first.map(({ estimatedDurationMs }) => estimatedDurationMs), [110, 110]);
  assert.throws(() => buildDurationShards(entries, 5), /empty shard/);
});

test('profile duration evidence combines only an exact successful disjoint union', () => {
  const value = fixture();
  value.manifest.tests[0].executionProfile = 'mobile-v19';
  const verification = validateOwnership(value);
  const expectedHead = 'a'.repeat(40);
  const profile = {
    version: 1,
    headSha: expectedHead,
    inventoryDigest: verification.inventoryDigest,
    className: 'required-pr',
    executionProfile: 'mobile-v19',
    maxWorkers: 1,
    wallDurationMs: 10,
    tests: [
      {
        path: 'tools/ci/alpha.test.mjs',
        ok: true,
        code: 0,
        signal: null,
        durationMs: 10,
      },
    ],
  };
  const defaultProfile = {
    ...profile,
    executionProfile: null,
    tests: [
      {
        path: 'tools/datapack/release.test.mjs',
        ok: true,
        code: 0,
        signal: null,
        durationMs: 8,
      },
    ],
  };
  const combined = combineDurationEvidence({
    verification,
    evidence: [profile, defaultProfile],
    expectedHead,
    className: 'required-pr',
  });
  assert.deepEqual(combined.tests.map(({ path }) => path), [
    'tools/ci/alpha.test.mjs',
    'tools/datapack/release.test.mjs',
  ]);

  assert.throws(
    () => combineDurationEvidence({ verification, evidence: [profile], expectedHead, className: 'required-pr' }),
    /missing duration evidence/,
  );
  assert.throws(
    () => combineDurationEvidence({
      verification,
      evidence: [profile, { ...defaultProfile, tests: profile.tests }],
      expectedHead,
      className: 'required-pr',
    }),
    /profile mismatch/,
  );
  assert.throws(
    () => combineDurationEvidence({
      verification,
      evidence: [profile, { ...defaultProfile, tests: [{ ...defaultProfile.tests[0], ok: false }] }],
      expectedHead,
      className: 'required-pr',
    }),
    /unsuccessful duration evidence/,
  );
});
