// Automated coverage over mock HTTP only. No test contacts a real endpoint.
// Run: node --test tools/jev/test/

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMock } from './mock-server.mjs';

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
    assert.equal(mock.seen[0].headers['x-api-key'], 'test-key-not-real', 'auth uses the SDK header');
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
