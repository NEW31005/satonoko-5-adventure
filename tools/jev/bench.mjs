#!/usr/bin/env node
// Measures what the preprocessing actually saves.
//
// The number that matters is CONTEXT BYTES AVOIDED: material that would have had
// to be read into the agent's context to answer the question, minus what the
// digest actually puts there. That is a real quota effect.
//
// It is NOT the same thing as "the text got shorter", and it is NOT a measured
// Claude token count -- tokens here are an estimate at ~3.2 bytes/token, and the
// Jev request's own input tokens are a separate, separately-priced cost.
//
//   node tools/jev/bench.mjs [--mock]      # --mock spins a loopback server

import { writeFileSync, readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localSearch, excerptFor, selectCandidate } from './lib/candidates.mjs';
import { digestLog } from './lib/logdigest.mjs';
import { estimateTokens, PRICING } from './config.mjs';
import { startMock } from './test/mock-server.mjs';

const B = (s) => Buffer.byteLength(String(s));
const useMock = process.argv.includes('--mock');

/** A build/test log of the kind that would otherwise be pasted in whole. */
/** Many genuinely DIFFERENT messages: local dedupe cannot collapse these. */
function highCardinalityLog() {
  const areas = ['renderer', 'physics', 'audio', 'input', 'network', 'storage', 'shader', 'atlas', 'tilemap', 'particles'];
  const verbs = ['failed to resolve', 'skipped optimisation for', 'fell back to software path for', 'deferred upload of', 'evicted cache entry for'];
  const lines = [];
  for (let i = 0; i < 260; i++) {
    const a = areas[i % areas.length], v = verbs[(i * 3) % verbs.length];
    lines.push(`[warn] ${a}: ${v} ${a}-resource-${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + ((i * 7) % 26))} because the ${areas[(i * 5) % areas.length]} backend reported an unsupported capability set`);
  }
  lines.splice(90, 0, 'not ok 7 - ranking submit retries on transient failure');
  lines.splice(180, 0, 'npm ERR! command failed with exit code 1');
  lines.splice(240, 0, "Error: Cannot read properties of undefined (reading 'hp')");
  return lines.join('\n');
}

function syntheticLog() {
  const lines = [];
  for (let i = 0; i < 900; i++) {
    lines.push(`[${new Date(Date.now() - i * 1000).toISOString()}] vite: transforming src/module-${i % 40}.ts (${i % 90}ms)`);
    if (i % 7 === 0) lines.push(`[info] phaser: texture atlas chunk-${String.fromCharCode(97 + (i % 26))} decoded in ${i % 50}ms`);
    if (i % 11 === 0) lines.push(`[debug] firebase: ranking snapshot ${i} delivered, ${i % 30} docs`);
    if (i % 13 === 0) lines.push(`[info] asset pipeline: copied public/assets/characters/sheet-${i % 20}.png`);
  }
  // The evidence that must survive, wherever it lands in the file.
  lines.splice(300, 0, 'npm ERR! command failed with exit code 1');
  lines.splice(520, 0, 'not ok 12 - boss orb attack stays inside the arena bounds');
  lines.splice(521, 0, 'FAIL src/scenes/BossScene.test.ts');
  lines.splice(522, 0, "Error: Cannot read properties of undefined (reading 'hp')");
  lines.splice(523, 0, '    at BossScene.update (src/scenes/BossScene.ts:142:19)');
  lines.splice(700, 0, 'found 3 vulnerabilities (1 high) -- CVE-2026-1234 in transitive dep');
  lines.splice(860, 0, 'TODO: unresolved -- world ranking write path still needs a retry policy');
  return lines.join('\n');
}

const MUST_SURVIVE = ['exit code 1', 'not ok 12', 'BossScene.test.ts', "reading 'hp'", 'BossScene.ts:142', 'CVE-2026-1234', 'TODO: unresolved'];

async function benchLog(env, { log = syntheticLog(), label = 'B: large log (repetitive)', must = MUST_SURVIVE } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'jev-bench-'));
  const file = join(dir, 'build.log');
  writeFileSync(file, log);

  // Baseline: the whole log reaches the context, because nothing has ranked it.
  const baselineBytes = B(log);

  const t0 = Date.now();
  const digest = await digestLog({ file, question: 'Which log group most likely explains the build failure?', topN: 10, env });
  const ms = Date.now() - t0;

  const digestJson = JSON.stringify(digest, null, 2);
  const digestBytes = B(digestJson);
  const missing = must.filter((n) => !digestJson.includes(n));

  return {
    pattern: label,
    baseline: { contextBytes: baselineBytes, estTokens: estimateTokens(baselineBytes), lines: log.split('\n').length },
    withJev: {
      contextBytes: digestBytes, estTokens: estimateTokens(digestBytes),
      apiRequestBytes: digest.bytes?.request ?? 0, apiResponseBytes: digest.bytes?.response ?? 0,
      calls: digest.attempts ?? 0,
      jevInputTokens: digest.usage?.input_tokens ?? 0,
      jevCostUsd: Number((((digest.usage?.input_tokens ?? 0) / 1e6) * PRICING.inputUsdPerMTok).toFixed(9)),
      ms,
    },
    contextBytesAvoided: baselineBytes - digestBytes,
    contextBytesAvoidedPct: Number((((baselineBytes - digestBytes) / baselineBytes) * 100).toFixed(1)),
    requiredEvidenceMissing: missing,
    evidenceRetained: missing.length === 0,
    omitted: digest.omitted,
  };
}

async function benchFind(env, query, question) {
  // Baseline: every hit's excerpt read into context to judge it by eye.
  const t0 = Date.now();
  const hits = localSearch(query);
  const baselineBytes = hits.reduce((a, h) => a + B(`${h.path}:${h.line}\n${excerptFor(h)}\n`), 0);
  const baselineMs = Date.now() - t0;

  const t1 = Date.now();
  const picked = await selectCandidate({ query, question, env });
  const ms = Date.now() - t1;
  const json = JSON.stringify(picked, null, 2);

  return {
    pattern: 'A: candidate selection',
    query,
    baseline: { hits: hits.length, contextBytes: baselineBytes, estTokens: estimateTokens(baselineBytes), ms: baselineMs },
    withJev: {
      contextBytes: B(json), estTokens: estimateTokens(B(json)),
      sentCandidates: picked.sentCandidates ?? 0,
      apiRequestBytes: picked.bytes?.request ?? 0, apiResponseBytes: picked.bytes?.response ?? 0,
      calls: picked.attempts ?? 0,
      jevInputTokens: picked.usage?.input_tokens ?? 0,
      usedJev: picked.usedJev, reason: picked.reason, ms,
    },
    contextBytesAvoided: baselineBytes - B(json),
    contextBytesAvoidedPct: baselineBytes ? Number((((baselineBytes - B(json)) / baselineBytes) * 100).toFixed(1)) : 0,
    decision: picked.decision ? `${picked.decision.path}:${picked.decision.line}` : null,
  };
}

// Default step: the mock answers with the first offered label, always valid.
const mock = useMock ? await startMock([{}]) : null;
// A mock attempt costs nothing, so it must not draw down the real-money ledger:
// give the mock run its own throwaway ledger and cache.
const benchDir = mock ? mkdtempSync(join(tmpdir(), 'jev-bench-ledger-')) : null;
if (mock) {
  // ledgerPath()/cachePath() read process.env at call time, so the overrides have
  // to land there -- passing them only in the `env` argument would not isolate them.
  Object.assign(process.env, {
    JEV_ENABLED: '1',
    TYPESAFE_API_KEY: 'bench-key-not-real',
    JEV_MOCK_BASE_URL: mock.baseUrl,
    JEV_LEDGER_PATH: join(benchDir, 'budget.json'),
    JEV_CACHE_PATH: join(benchDir, 'cache.json'),
  });
}
const env = process.env;

const report = {
  mode: mock ? 'mock (loopback)' : 'default OFF (local only)',
  note: 'contextBytesAvoided = material that would have entered the agent context, minus the digest. Tokens are an estimate, not a measured Claude token count. Jev input tokens are a separate cost line.',
  results: [
    await benchLog(env),
    await benchLog(env, {
      log: highCardinalityLog(),
      label: 'B: large log (high cardinality)',
      must: ['not ok 7', 'exit code 1', "reading 'hp'"],
    }),
    await benchFind(env, 'this\\.(add|physics|scene)\\.', 'Which site creates the boss scene objects?'),
    await benchFind(env, 'createHash', 'Where is the cache key built?'),
  ],
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (mock) await mock.close();
