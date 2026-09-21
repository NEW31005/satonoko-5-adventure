// Automated coverage over mock HTTP only. No test contacts a real endpoint.
// Run: node --test tools/jev/test/

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMock } from './mock-server.mjs';
import { execFileSync } from 'node:child_process';

// Every mock is closed even when an assertion throws: an open server keeps the
// process alive and the whole file then dies on the runner timeout.
const openMocks = new Set();
const mkMock = async (script) => { const m = await startMock(script); openMocks.add(m); return m; };
afterEach(async () => { for (const m of openMocks) await m.close(); openMocks.clear(); });

/** Each test gets its own ledger, cache and allowlist. */
function freshEnv(extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'jev-test-'));
  return {
    dir,
    env: {
      JEV_ENABLED: '1',
      TYPESAFE_API_KEY: 'test-key-not-real',
      JEV_LEDGER_PATH: join(dir, 'budget.json'),
      JEV_CACHE_PATH: join(dir, 'cache.json'),
      JEV_ALLOWLIST_PATH: join(dir, 'allowlist.json'),
      ...extra,
    },
  };
}

const allow = (env, paths) =>
  writeFileSync(env.JEV_ALLOWLIST_PATH, JSON.stringify({ paths }, null, 2));

// Modules read process.env at call time, so tests set it around each call.
function withEnv(env, fn) {
  const saved = {};
  for (const k of Object.keys(env)) { saved[k] = process.env[k]; process.env[k] = env[k]; }
  const restore = () => { for (const k of Object.keys(env)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } };
  const out = fn();
  return out instanceof Promise ? out.finally(restore) : (restore(), out);
}

const { systemOne, validateAnswer, validateQuestions } = await import('../lib/client.mjs');
const { reserve, settle, snapshot } = await import('../lib/budget.mjs');
const { readCache, writeCache, cacheKey } = await import('../lib/cache.mjs');
const { findSecrets, scrubLines, assertSendable } = await import('../lib/redact.mjs');
const { digestLog, classify, templateOf } = await import('../lib/logdigest.mjs');
const { scoreHit, rankHits } = await import('../lib/candidates.mjs');
const { resolveMode, MODEL_PIN } = await import('../config.mjs');

const CHOICE = (labels) => ({ pick: { type: 'choice', instructions: 'pick one', criteria: Object.fromEntries(labels.map((l) => [l, `desc ${l}`])) } });

describe('default OFF', () => {
  test('no env at all: off, zero requests', async () => {
    const mock = await mkMock();
    const r = await withEnv({ JEV_ENABLED: '', JEV_ALLOW_REAL_API: '', JEV_MOCK_BASE_URL: '', TYPESAFE_API_KEY: '' },
      () => systemOne({ state: 'x', questions: CHOICE(['a', 'b']) }));
    assert.equal(r.ok, false);
    assert.match(r.reason, /off/);
    assert.equal(r.fallback, true);
    assert.equal(mock.requestCount(), 0);
    await mock.close();
  });

  test('enabled but real API not explicitly allowed stays off', () => {
    const m = resolveMode({ JEV_ENABLED: '1', TYPESAFE_API_KEY: 'k' });
    assert.equal(m.kind, 'off');
    assert.match(m.reason, /JEV_ALLOW_REAL_API/);
  });

  test('a non-loopback mock base URL is refused', () => {
    const m = resolveMode({ JEV_ENABLED: '1', JEV_MOCK_BASE_URL: 'https://evil.example.com' });
    assert.equal(m.kind, 'off');
    assert.match(m.reason, /127\.0\.0\.1/);
  });
});

describe('happy path', () => {
  test('valid answer accepted, pin verified, usage settled', async () => {
    const mock = await mkMock([{ answerFor: 'b', usage: { input_tokens: 1919, output_tokens: 355 } }]);
    const { env } = freshEnv({ JEV_MOCK_BASE_URL: mock.baseUrl });
    const r = await withEnv(env, () => systemOne({ state: 's', questions: CHOICE(['a', 'b', 'c']) }));
    assert.equal(r.ok, true);
    assert.equal(r.accepted.pick.choice, 'b');
    assert.equal(r.resolvedModel, MODEL_PIN);
    assert.equal(r.settlement.settledAs, 'actual');
    assert.equal(r.settlement.inputTokens, 1919);
    // $0.042/Mtok on input, output free.
    assert.ok(Math.abs(r.settlement.usd - (1919 / 1e6) * 0.042) < 1e-12);
    assert.equal(mock.seen[0].body.model, MODEL_PIN, 'request pins the model');
    assert.equal(mock.seen[0].headers.authorization, 'Bearer test-key-not-real', 'auth uses the SDK header');
    await mock.close();
  });
});

describe('error handling', () => {
  test('401 does not retry and falls back locally', async () => {
    const mock = await mkMock([{ status: 401, body: { error: 'bad key' } }]);
    const { env } = freshEnv({ JEV_MOCK_BASE_URL: mock.baseUrl });
    const r = await withEnv(env, () => systemOne({ state: 's', questions: CHOICE(['a', 'b']) }));
    assert.equal(r.ok, false);
    assert.equal(r.status, 401);
    assert.equal(r.retried, false);
    assert.equal(r.fallback, true);
    assert.equal(mock.requestCount(), 1, '401 must not be retried');
    await mock.close();
  });

  test('500 retries, and every attempt reserves budget', async () => {
    const mock = await mkMock([{ status: 500, body: { error: 'boom' } }]);
    const { env } = freshEnv({ JEV_MOCK_BASE_URL: mock.baseUrl });
    const r = await withEnv(env, () => systemOne({ state: 's', questions: CHOICE(['a', 'b']) }));
    assert.equal(r.ok, false);
    assert.equal(mock.requestCount(), 2, 'one retry after the first attempt');
    const snap = withEnv(env, () => snapshot());
    assert.equal(snap.day.attempts, 2, 'the retry is charged an attempt too');
    assert.ok(snap.day.tokens > 0, 'the retry reserved tokens as well');
    await mock.close();
  });

  test('model pin mismatch is rejected', async () => {
    const mock = await mkMock([{ model: 'jev-1.14.0' }]);
    const { env } = freshEnv({ JEV_MOCK_BASE_URL: mock.baseUrl });
    const r = await withEnv(env, () => systemOne({ state: 's', questions: CHOICE(['a', 'b']) }));
    assert.equal(r.ok, false);
    assert.match(r.reason, /model pin mismatch/);
    assert.equal(r.fallback, true);
    await mock.close();
  });

  test('a candidate that was never offered is rejected', async () => {
    const q = CHOICE(['a', 'b']);
    const v = validateAnswer('pick', q.pick, { type: 'choice', choice: 'ghost', confidence: 0.9, probabilities: { a: 0.5, b: 0.5 } });
    assert.equal(v.ok, false);
    assert.match(v.reason, /unknown candidate/);
  });

  test('out-of-range and malformed answers are rejected', () => {
    const q = CHOICE(['a', 'b']);
    assert.equal(validateAnswer('pick', q.pick, { type: 'choice', choice: 'a', confidence: 1.7, probabilities: { a: 1, b: 0 } }).ok, false);
    assert.equal(validateAnswer('pick', q.pick, { type: 'noul', noul: 0.5 }).ok, false);
    assert.equal(validateAnswer('pick', q.pick, null).ok, false);
    const score = { type: 'score', instructions: 'x', criteria: ['lo', 'hi'] };
    assert.equal(validateAnswer('s', score, { type: 'score', score: 9, confidence: 0.9 }).ok, false);
    assert.equal(validateAnswer('n', { type: 'noul' }, { type: 'noul', noul: 2 }).ok, false);
  });

  test('low confidence is discarded', () => {
    const q = CHOICE(['a', 'b']);
    const v = validateAnswer('pick', q.pick, { type: 'choice', choice: 'a', confidence: 0.1, probabilities: { a: 0.55, b: 0.45 } });
    assert.equal(v.ok, false);
    assert.equal(v.lowConfidence, true);
  });

  test('malformed questions never reach the network', async () => {
    const mock = await mkMock();
    const { env } = freshEnv({ JEV_MOCK_BASE_URL: mock.baseUrl });
    const r = await withEnv(env, () => systemOne({ state: 's', questions: { bad: { type: 'telepathy' } } }));
    assert.equal(r.ok, false);
    assert.equal(r.code, 'JEV_BAD_QUERY');
    assert.equal(mock.requestCount(), 0);
    assert.throws(() => validateQuestions({}), /no questions/);
    await mock.close();
  });
});

describe('timeout', () => {
  test('a hung response aborts and falls back', async () => {
    const mock = await mkMock([{ hang: true }]);
    const { env } = freshEnv({ JEV_MOCK_BASE_URL: mock.baseUrl });
    const r = await withEnv(env, () => systemOne({ state: 's', questions: CHOICE(['a', 'b']) }));
    assert.equal(r.ok, false);
    assert.match(r.reason, /timed out/);
    assert.equal(r.fallback, true);
    await mock.close();
  });
});

describe('budget', () => {
  test('caps refuse before any request goes out', async () => {
    const mock = await mkMock();
    const { env, dir } = freshEnv({ JEV_MOCK_BASE_URL: mock.baseUrl });
    // Burn the daily attempt allowance without touching the network.
    withEnv(env, () => { for (let i = 0; i < 20; i++) { const l = reserve({ tokens: 10 }); assert.equal(l.ok, true); settle(l.leaseId, { input_tokens: 10, output_tokens: 0 }); } });
    const r = await withEnv(env, () => systemOne({ state: 's', questions: CHOICE(['a', 'b']) }));
    assert.equal(r.ok, false);
    assert.match(r.reason, /budget refused.*attempt cap/);
    assert.equal(r.retried, false);
    assert.equal(mock.requestCount(), 0, 'a refused budget must not reach the network');
    await mock.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('unknown usage is held at the reservation, never free', async () => {
    const mock = await mkMock([{ body: { model: MODEL_PIN, answers: { pick: { type: 'choice', choice: 'a', confidence: 0.9, probabilities: { a: 0.9, b: 0.1 } } } } }]);
    const { env } = freshEnv({ JEV_MOCK_BASE_URL: mock.baseUrl });
    const r = await withEnv(env, () => systemOne({ state: 's', questions: CHOICE(['a', 'b']) }));
    assert.equal(r.settlement.settledAs, 'reservation-held');
    assert.ok(r.settlement.usd > 0, 'missing usage is charged, not free');
    await mock.close();
  });

  test('concurrency is capped at 2', () => {
    const { env } = freshEnv();
    withEnv(env, () => {
      const a = reserve({ tokens: 10 }), b = reserve({ tokens: 10 });
      assert.equal(a.ok, true); assert.equal(b.ok, true);
      const c = reserve({ tokens: 10 });
      assert.equal(c.ok, false);
      assert.match(c.reason, /concurrency cap/);
      settle(a.leaseId, { input_tokens: 10, output_tokens: 0 });
      assert.equal(reserve({ tokens: 10 }).ok, true, 'a slot frees after settling');
    });
  });

  test('the daily token reservation cap binds', () => {
    const { env } = freshEnv();
    withEnv(env, () => {
      const big = reserve({ tokens: 99_999 });
      assert.equal(big.ok, true);
      settle(big.leaseId, { input_tokens: 99_999, output_tokens: 0 });
      const over = reserve({ tokens: 500 });
      assert.equal(over.ok, false);
      assert.match(over.reason, /token reservation cap/);
    });
  });
});

describe('cache', () => {
  test('a second identical question is served from cache with zero requests', async () => {
    const mock = await mkMock([{ answerFor: 'a' }]);
    const { env } = freshEnv({ JEV_MOCK_BASE_URL: mock.baseUrl });
    const q = CHOICE(['a', 'b']);
    await withEnv(env, async () => {
      const key = cacheKey({ contents: ['x'], questions: q });
      assert.equal(readCache(key).hit, false);
      const r = await systemOne({ state: 's', questions: q });
      writeCache(key, { answers: r.accepted, usage: r.usage, resolvedModel: r.resolvedModel });
      const second = readCache(key);
      assert.equal(second.hit, true);
      assert.equal(second.answers.pick.choice, 'a');
    });
    assert.equal(mock.requestCount(), 1, 'the cached read made no request');
    await mock.close();
  });

  test('expired, model-mismatched and malformed entries are rejected', () => {
    const { env } = freshEnv();
    withEnv(env, () => {
      const q = CHOICE(['a', 'b']);
      const key = cacheKey({ contents: ['x'], questions: q });
      const answers = { pick: { type: 'choice', choice: 'a', confidence: 0.9, probabilities: { a: 0.9, b: 0.1 } } };
      writeCache(key, { answers, usage: {}, resolvedModel: MODEL_PIN }, { ttlMs: 1000 });
      assert.equal(readCache(key).hit, true);
      assert.match(readCache(key, { now: Date.now() + 5000 }).reason, /expired/);
      assert.match(readCache(key, { model: 'jev-1.14.0' }).reason, /model/);
      writeFileSync(env.JEV_CACHE_PATH, JSON.stringify({ [key]: { junk: true } }));
      assert.match(readCache(key).reason, /malformed/);
    });
  });

  test('changing the content changes the key', () => {
    const { env } = freshEnv();
    withEnv(env, () => {
      const q = CHOICE(['a', 'b']);
      assert.notEqual(cacheKey({ contents: ['x'], questions: q }), cacheKey({ contents: ['x '], questions: q }));
      assert.notEqual(cacheKey({ contents: ['x'], questions: q }), cacheKey({ contents: ['x'], questions: CHOICE(['a', 'c']) }));
    });
  });
});

describe('secret and PII exclusion', () => {
  test('known credential shapes are detected', () => {
    for (const s of [
      'sk-ant-api03-AAAAAAAAAAAAAAAAAAAA', 'ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      'AKIAIOSFODNN7EXAMPLE', 'AIzaSyAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      'xoxb-111111111111-abcdefghij', 'API_KEY=supersecretvalue123',
      '-----BEGIN RSA PRIVATE KEY-----', 'someone@example.com',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    ]) assert.ok(findSecrets(s).length > 0, `should flag: ${s.slice(0, 24)}`);
    assert.equal(findSecrets('const speed = 120; // normal code').length, 0);
  });

  test('a payload carrying a secret is blocked before the socket', async () => {
    const mock = await mkMock();
    const { env } = freshEnv({ JEV_MOCK_BASE_URL: mock.baseUrl });
    await withEnv(env, async () => {
      await assert.rejects(
        () => systemOne({ state: 'TYPESAFE_API_KEY=abcdefghijklmnop', questions: CHOICE(['a', 'b']) }),
        (e) => e.code === 'JEV_SECRET_BLOCKED',
      );
    });
    assert.equal(mock.requestCount(), 0, 'nothing was transmitted');
    await mock.close();
  });

  test('scrubbing drops offending lines and counts them', () => {
    const r = scrubLines('safe line\nAPI_KEY=abcdefghijklmnop\nalso safe');
    assert.equal(r.droppedCount, 1);
    assert.ok(!r.text.includes('API_KEY'));
    assert.ok(r.text.includes('also safe'));
    assert.doesNotThrow(() => assertSendable('{"state":"plain text"}'));
  });

  test('a log with secrets digests without transmitting them', async () => {
    const mock = await mkMock();
    const { env } = freshEnv({ JEV_MOCK_BASE_URL: mock.baseUrl });
    const log = ['starting build', 'TYPESAFE_API_KEY=abcdefghijklmnopqrst', 'FAIL src/a.test.ts', 'done']
      .concat(Array.from({ length: 40 }, (_, i) => `info: step ${i} completed in ${i}ms`)).join('\n');
    const r = await withEnv(env, () => digestLog({ text: log }));
    assert.ok(r.secretLinesWithheld >= 1);
    for (const req of mock.seen) assert.ok(!req.raw.includes('abcdefghijklmnopqrst'), 'secret must never be sent');
    await mock.close();
  });
});

describe('log digest', () => {
  test('duplicates collapse into counted groups', () => {
    assert.equal(templateOf('took 412ms at 2026-09-21T10:00:00Z'), templateOf('took 77ms at 2026-09-21T11:30:00Z'));
  });

  test('important lines are pinned even when Jev highlights something else', async () => {
    // Distinct templates on purpose: identical lines collapse to one group and
    // would never exercise the ranking path.
    const noise = Array.from({ length: 120 }, (_, i) =>
      `info: loader ${String.fromCharCode(97 + (i % 26))}${i % 7} resolved bundle chunk-${String.fromCharCode(97 + (i % 13))} from workspace package @satonoko/pkg-${String.fromCharCode(97 + (i % 11))} strategy node-modules`);
    const important = [
      'not ok 12 - boss orb attack stays in bounds',
      'FAIL src/scenes/BossScene.test.ts',
      'Error: Cannot read properties of undefined (reading \'hp\')',
      '    at BossScene.update (src/scenes/BossScene.ts:142:19)',
      'npm ERR! command failed with exit code 1',
      'found 3 vulnerabilities (1 high) -- CVE-2026-1234',
      'TODO: unresolved -- ranking write path needs a retry',
    ];
    const mock = await mkMock([{ answerFor: 'g1' }]); // Jev picks a noise group
    const { env } = freshEnv({ JEV_MOCK_BASE_URL: mock.baseUrl });
    const r = await withEnv(env, () => digestLog({ text: [...noise, ...important].join('\n'), topN: 5 }));

    const pinnedText = r.pinned.map((p) => p.text).join('\n');
    for (const needle of ['not ok 12', 'FAIL src/scenes/BossScene.test.ts', 'Cannot read properties', 'exit code 1', 'CVE-2026-1234', 'TODO: unresolved'])
      assert.ok(pinnedText.includes(needle), `pinned must retain: ${needle}`);

    const tags = new Set(r.pinned.flatMap((p) => p.tags));
    for (const t of ['failed-test', 'exit-code', 'exception', 'security', 'unresolved'])
      assert.ok(tags.has(t), `missing tag ${t}`);

    assert.ok(r.omitted.groups > 0, 'omitted count is reported');
    assert.ok(r.leads.files.some((f) => f.file.includes('BossScene')), 'leads point at the caller file');
    assert.ok(r.leads.howToWiden.length > 0, 'tells the reader how to fetch more');
    await mock.close();
  });

  test('zero-count summaries and ordinary test names are not pinned', () => {
    // Found by running the digest over this suite's own TAP output.
    for (const l of ['# fail 0', '# todo 0', '  # skipped 0', 'found 0 vulnerabilities'])
      assert.deepEqual(classify(l), [], `must not pin: ${l}`);
    assert.deepEqual(classify('    # Subtest: a payload carrying a secret is blocked before the socket'), []);
    assert.deepEqual(classify('ok 2 - a payload carrying a secret is blocked before the socket'), []);
    // ...while the real thing still pins.
    assert.ok(classify('# fail 3').includes('failed-test'));
    assert.ok(classify('TODO: unresolved -- retry policy').includes('unresolved'));
    assert.ok(classify('blocked by upstream issue').includes('unresolved'));
  });

  test('classify recognises each important category', () => {
    assert.deepEqual(classify('not ok 3 - thing'), ['failed-test']);
    assert.ok(classify('process exited with code 2').includes('exit-code'));
    assert.ok(classify('Traceback (most recent call last):').includes('exception'));
    assert.ok(classify('found 2 vulnerabilities').includes('security'));
    assert.ok(classify('FIXME: handle the null case').includes('unresolved'));
  });
});

describe('simple work costs zero Jev calls', () => {
  test('a short log with few distinct groups makes no request', async () => {
    const mock = await mkMock();
    const { env } = freshEnv({ JEV_MOCK_BASE_URL: mock.baseUrl });
    const r = await withEnv(env, () => digestLog({ text: 'build ok\nall tests passed\ndone in 2s' }));
    assert.equal(r.usedJev, false);
    assert.match(r.reason, /no Jev call/);
    assert.equal(mock.requestCount(), 0);
    await mock.close();
  });

  test('a large log with many groups does call Jev', async () => {
    const mock = await mkMock([{ answerFor: 'g1' }]);
    const { env } = freshEnv({ JEV_MOCK_BASE_URL: mock.baseUrl });
    // Must clear BOTH gates: many distinct groups and enough residue bytes that
    // a call can pay for itself.
    const text = Array.from({ length: 120 }, (_, i) =>
      `module ${String.fromCharCode(97 + (i % 26))}${i} resolved via loader-${String.fromCharCode(97 + (i % 17))} from workspace package @satonoko/pkg-${String.fromCharCode(97 + (i % 11))} with resolver strategy node-modules`).join('\n');
    const r = await withEnv(env, () => digestLog({ text }));
    assert.equal(r.usedJev, true);
    assert.equal(mock.requestCount(), 1);
    await mock.close();
  });
});

describe('local relevance ranking', () => {
  test('source definitions outrank JSON and test-file mentions', () => {
    // Regression: a real run picked tools/jev/allowlist.json over the source
    // file that actually answered the question, because ripgrep returns file order.
    const hits = [
      { path: 'tools/jev/allowlist.json', line: 7, text: '    "src/data/ranking.ts",' },
      { path: 'src/data/ranking.ts', line: 12, text: 'export async function submitScore(entry) {' },
      { path: 'tools/jev/test/jev.test.mjs', line: 9, text: '  // ranking fixture' },
    ];
    const ranked = rankHits(hits, 'submitScore|ranking|leaderboard');
    assert.equal(ranked[0].path, 'src/data/ranking.ts');
    assert.ok(scoreHit(hits[1], 'ranking') > scoreHit(hits[0], 'ranking'));
    assert.ok(scoreHit(hits[1], 'ranking') > scoreHit(hits[2], 'ranking'));
  });

  test('ranking is stable for equal scores', () => {
    const hits = [{ path: 'a.ts', line: 1, text: 'x' }, { path: 'b.ts', line: 1, text: 'x' }];
    assert.deepEqual(rankHits(hits, '').map((h) => h.path), ['a.ts', 'b.ts']);
  });
});

const { buildReviewSet, parseDiff, markersFor, riskOf } = await import('../lib/reviewset.mjs');
const { findStrongSecrets } = await import('../lib/redact.mjs');
const { estimateTokens, countTokens, bytesOf } = await import('../lib/tokens.mjs');

describe('review narrowing invariants', () => {
  test('every changed file is in the inventory, and skipped ones are declared unreviewed', async () => {
    const { env } = freshEnv({ JEV_ENABLED: '' });
    const set = await withEnv(env, () => buildReviewSet({ base: 'HEAD~1', head: 'HEAD', budgetFiles: 1 }));
    const changed = execFileSync('git', ['diff', '--name-only', 'HEAD~1...HEAD'], { encoding: 'utf8' })
      .split('\n').filter(Boolean);
    assert.equal(set.inventory.length, changed.length, 'inventory must list every changed file');
    for (const f of changed) assert.ok(set.inventory.some((i) => i.file === f), `missing from inventory: ${f}`);

    // Narrowing decides what is READ, never what is LISTED.
    assert.equal(set.totals.selected + set.totals.notSelected, set.inventory.length);
    assert.equal(set.totals.reviewed, 0, 'the helper never reviews anything');
    for (const f of set.notSelected) {
      assert.equal(f.reviewed, false, 'an unselected file must never be marked reviewed');
      assert.ok(f.command.includes(f.file), 'must say how to read it');
    }
    // A SELECTED file is an excerpt, not a reading.
    for (const f of set.selectedExcerpts) {
      assert.equal(f.reviewed, false, 'a selected file is excerpted, not reviewed');
      assert.equal(f.excerptOnly, true);
    }
    assert.match(set.warning, /EXCERPT SET, not a review/);
  });

  test('a Jev-unselected file is never described as safe', async () => {
    const { env } = freshEnv({ JEV_ENABLED: '' });
    const set = await withEnv(env, () => buildReviewSet({ base: 'HEAD~1', head: 'HEAD', budgetFiles: 1 }));
    const blob = JSON.stringify(set).toLowerCase();
    for (const word of ['"safe"', 'looks fine', 'no issues found', 'reviewed: true'])
      assert.ok(!blob.includes(word), `must not claim: ${word}`);
  });

  test('diff parsing preserves both old and new line numbers', () => {
    const files = parseDiff([
      'diff --git a/src/a.ts b/src/a.ts',
      '@@ -10,3 +20,4 @@ function f() {',
      ' keep',
      '-gone',
      '+added one',
      '+added two',
    ].join('\n'));
    assert.equal(files.length, 1);
    const lines = files[0].hunks[0].lines;
    assert.deepEqual(lines.map((l) => [l.sign, l.old, l.new]), [
      [' ', 10, 20], ['-', 11, null], ['+', null, 21], ['+', null, 22],
    ]);
    assert.equal(files[0].added, 2);
    assert.equal(files[0].removed, 1);
  });

  test('markers are precise: prose and licence text are not code findings', () => {
    // Regression: these produced 126 bogus pinned entries on a real PR.
    assert.deepEqual(markersFor('Permission is hereby granted, free of charge', 'LICENSE'), []);
    assert.deepEqual(markersFor('see [docs](https://docs.typesafe.ai/llms.txt)', 'SKILL.md'), []);
    assert.deepEqual(markersFor("const STRONG = new Set(['private-key-block']);", 'lib/redact.mjs'), []);
    // ...and real findings still fire.
    assert.ok(markersFor('it.skip("flaky", () => {})', 'a.test.ts').includes('skipped-test'));
    assert.ok(markersFor('const r = await fetch(u);', 'a.ts').includes('network'));
    assert.ok(markersFor('// @ts-ignore', 'a.ts').includes('suppression'));
    assert.ok(markersFor('allow read: if true;', 'firestore.rules').includes('auth-surface'));
    assert.ok(markersFor('const k = "sk-ant-api03-AAAAAAAAAAAAAAAAAAAA";', 'a.ts').includes('possible-secret'));
  });

  test('strong-secret tiering is narrower than outbound blocking', () => {
    // Blocking stays paranoid; tiering must not flag every `secret:` key.
    assert.ok(findSecrets("secret: 'abcdefghijkl'").length > 0, 'blocking still catches it');
    assert.equal(findStrongSecrets("secret: 'abcdefghijkl'").length, 0, 'tiering must not');
    assert.ok(findStrongSecrets('ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA').length > 0);
  });

  test('risk tiers put sensitive paths and suppressions above docs', () => {
    assert.equal(riskOf('firestore.rules', ['allow read: if true;']).tier, 'high');
    assert.equal(riskOf('src/a.ts', ['// @ts-ignore']).tier, 'high');
    assert.equal(riskOf('README.md', ['just words']).tier, 'low');
    assert.equal(riskOf('package-lock.json', ['{}']).tier, 'generated');
  });
});

describe('token accounting honesty', () => {
  test('bytes are measured; tokens without a credential are a labelled estimate', async () => {
    const r = await countTokens('hello world', { env: {} });
    assert.equal(r.measured, false);
    assert.match(r.method, /estimate/);
    assert.match(r.reason, /ANTHROPIC_API_KEY/);
    assert.equal(bytesOf('hello'), 5);
    assert.ok(estimateTokens('hello world') > 0);
  });

  test('a successful count_tokens call is reported as measured', async () => {
    const fake = async () => new Response(JSON.stringify({ input_tokens: 4242 }), { status: 200 });
    const r = await countTokens('x', { env: { ANTHROPIC_API_KEY: 'k' }, fetchImpl: fake });
    assert.equal(r.measured, true);
    assert.equal(r.tokens, 4242);
    assert.match(r.method, /count_tokens/);
  });

  test('a failed count_tokens call degrades to an estimate, never a fake measurement', async () => {
    const fake = async () => new Response('nope', { status: 401 });
    const r = await countTokens('x', { env: { ANTHROPIC_API_KEY: 'k' }, fetchImpl: fake });
    assert.equal(r.measured, false);
    assert.match(r.reason, /401/);
  });
});

describe('auth modes (direct vs proxy)', () => {
  const AUTHY = ['authorization', 'x-api-key', 'api-key', 'proxy-authorization', 'x-typesafe-key'];

  test('direct mode sends exactly one auth header: Authorization: Bearer', async () => {
    const mock = await mkMock([{}]);
    const { env } = freshEnv({ JEV_MOCK_BASE_URL: mock.baseUrl, JEV_AUTH_MODE: 'direct' });
    const r = await withEnv(env, () => systemOne({ state: 's', questions: CHOICE(['a', 'b']) }));
    assert.equal(r.ok, true);
    assert.equal(r.authMode, 'direct');
    const h = mock.seen[0].headers;
    assert.equal(h.authorization, 'Bearer test-key-not-real');
    assert.equal(h['x-api-key'], undefined, 'x-api-key is a log-redaction name, not a request header');
  });

  test('proxy mode sends NO auth header at all, and still hits the official path', async () => {
    const mock = await mkMock([{}]);
    const { env } = freshEnv({ JEV_MOCK_BASE_URL: mock.baseUrl, JEV_AUTH_MODE: 'proxy' });
    delete env.TYPESAFE_API_KEY; // proxy mode holds no key by design
    const r = await withEnv(env, () => systemOne({ state: 's', questions: CHOICE(['a', 'b']) }));
    assert.equal(r.ok, true);
    assert.equal(r.authMode, 'proxy');
    const h = mock.seen[0].headers;
    for (const k of AUTHY) assert.equal(h[k], undefined, `proxy mode must not send ${k}`);
    assert.equal(mock.seen[0].url, '/v1/systemone', 'endpoint path is unchanged');
  });

  test('CREDENTIAL LEAK GUARD: proxy mode withholds a key even when one is present', async () => {
    // The whole point of the cloud API credential is that this process never
    // holds the key. If one leaks into the environment anyway, we must still not
    // transmit it -- the agent proxy is what authenticates the request.
    const mock = await mkMock([{}]);
    const { env } = freshEnv({ JEV_MOCK_BASE_URL: mock.baseUrl, JEV_AUTH_MODE: 'proxy' });
    env.TYPESAFE_API_KEY = 'leaked-key-must-not-be-sent';
    const r = await withEnv(env, () => systemOne({ state: 's', questions: CHOICE(['a', 'b']) }));
    assert.equal(r.ok, true);
    const raw = JSON.stringify(mock.seen[0]);
    assert.ok(!raw.includes('leaked-key-must-not-be-sent'), 'the key must appear nowhere in the request');
    for (const k of AUTHY) assert.equal(mock.seen[0].headers[k], undefined);
  });

  test('proxy mode drops the key requirement; direct mode keeps it', () => {
    const base = { JEV_ENABLED: '1', JEV_ALLOW_REAL_API: '1' };
    assert.equal(resolveMode({ ...base, JEV_AUTH_MODE: 'proxy' }).kind, 'real');
    assert.equal(resolveMode({ ...base }).kind, 'off');
    assert.match(resolveMode({ ...base }).reason, /TYPESAFE_API_KEY/);
    assert.equal(resolveMode({ ...base, TYPESAFE_API_KEY: 'k' }).kind, 'real');
  });

  test('an unknown auth mode is refused, not silently treated as direct', () => {
    const m = resolveMode({ JEV_ENABLED: '1', JEV_ALLOW_REAL_API: '1', JEV_AUTH_MODE: 'bearer-yolo' });
    assert.equal(m.kind, 'off');
    assert.match(m.reason, /JEV_AUTH_MODE must be one of/);
  });

  test('proxy mode is still OFF by default and still respects the budget', async () => {
    // Removing the key requirement must not remove any other gate.
    assert.equal(resolveMode({ JEV_AUTH_MODE: 'proxy' }).kind, 'off');
    assert.equal(resolveMode({ JEV_ENABLED: '1', JEV_AUTH_MODE: 'proxy' }).kind, 'off');

    const mock = await mkMock([{}]);
    const { env } = freshEnv({ JEV_MOCK_BASE_URL: mock.baseUrl, JEV_AUTH_MODE: 'proxy' });
    withEnv(env, () => { for (let i = 0; i < 20; i++) { const l = reserve({ tokens: 10 }); settle(l.leaseId, { input_tokens: 10, output_tokens: 0 }); } });
    const r = await withEnv(env, () => systemOne({ state: 's', questions: CHOICE(['a', 'b']) }));
    assert.equal(r.ok, false);
    assert.match(r.reason, /budget refused/);
    assert.equal(mock.requestCount(), 0);
  });
});

describe('verification accounting covers excerpted files too', () => {
  test('a selected file whose excerpt elided lines is in verificationReads', async () => {
    const { env } = freshEnv({ JEV_ENABLED: '' });
    const set = await withEnv(env, () => buildReviewSet({ base: 'origin/main', head: 'HEAD', budgetFiles: 4 }));
    const elided = set.selectedExcerpts.filter((f) => f.linesElided > 0 || f.linesTruncated > 0 || f.contextLinesOmitted > 0);
    assert.ok(elided.length > 0, 'this diff should elide something');
    for (const f of elided) {
      const entry = set.verificationReads.find((v) => v.file === f.file && v.origin === 'selected');
      assert.ok(entry, `selected-but-incomplete file missing from verificationReads: ${f.file}`);
      assert.ok(entry.reasons.length > 0);
    }
  });

  test('verificationReads accounts for every changed file with a gap, selected or not', async () => {
    const { env } = freshEnv({ JEV_ENABLED: '' });
    const set = await withEnv(env, () => buildReviewSet({ base: 'origin/main', head: 'HEAD', budgetFiles: 4 }));
    const covered = new Set(set.verificationReads.map((v) => v.file));
    for (const f of set.notSelected) assert.ok(covered.has(f.file), `unselected file missing: ${f.file}`);
    assert.equal(set.totals.needingVerification, set.verificationReads.length);
    // Never claim a complete reading.
    assert.ok(!JSON.stringify(set).includes('every changed file was read in full'));
  });
});

describe('auth header matches the official SDK', () => {
  test('direct mode sends Authorization: Bearer, not x-api-key', async () => {
    // @typesafe-ai/sdk 0.6.0 dist/index.mjs:581 sets `Authorization: Bearer ${apiKey}`.
    // `x-api-key` there is only a log-redaction name (KEY_HEADERS, lines 285-288).
    const mock = await mkMock([{}]);
    const { env } = freshEnv({ JEV_MOCK_BASE_URL: mock.baseUrl, JEV_AUTH_MODE: 'direct' });
    const r = await withEnv(env, () => systemOne({ state: 's', questions: CHOICE(['a', 'b']) }));
    assert.equal(r.ok, true);
    const h = mock.seen[0].headers;
    assert.equal(h.authorization, 'Bearer test-key-not-real');
    assert.equal(h['x-api-key'], undefined, 'x-api-key is a redaction name, not a request header');
  });

  test('proxy mode sends neither Authorization nor x-api-key', async () => {
    const mock = await mkMock([{}]);
    const { env } = freshEnv({ JEV_MOCK_BASE_URL: mock.baseUrl, JEV_AUTH_MODE: 'proxy' });
    env.TYPESAFE_API_KEY = 'leaked-key-must-not-be-sent';
    await withEnv(env, () => systemOne({ state: 's', questions: CHOICE(['a', 'b']) }));
    const h = mock.seen[0].headers;
    assert.equal(h.authorization, undefined);
    assert.equal(h['x-api-key'], undefined);
    assert.ok(!JSON.stringify(mock.seen[0]).includes('leaked-key-must-not-be-sent'));
  });
});
