#!/usr/bin/env node
// A/B/C/cache measurement over ONE input.
//
//   A     efficient plain local review input (no helper at all)
//   B     local preprocessing only (helper with Jev off)
//   C     Jev preprocessing
//   cache C repeated, served from the answer cache
//
// What is counted, per arm: the instruction text, the body, the helper JSON,
// AND the follow-up re-reads the arm still forces. A digest that hides fifteen
// files is not cheaper if the reviewer must then open them, so both a
// "digest only" and a "digest + follow-up" total are reported.
//
// bytes  = MEASURED.
// tokens = MEASURED only when ANTHROPIC_API_KEY lets us call the official
//          count_tokens endpoint; otherwise an ESTIMATE, labelled as such.
// quota  = NOT observable here. Never reported.
// cost   = SIMULATED whenever this runs against the loopback mock. The mock
//          replays a fixture `usage` observed elsewhere, so the dollar figure is
//          arithmetic on a fixture, NOT money spent. No billed request has ever
//          succeeded from this cloud environment. Only a run whose responses came
//          from api.typesafe.ai may be called real spend.
//
// Scope: these bytes compare the INPUT for review-candidate extraction. They are
// not a total-review-completion figure -- files the helper did not read are not
// reviewed, and finishing the review costs the extra reads reported separately.
//
//   node tools/jev/measure.mjs [--mock] [--base origin/main] [--head HEAD]

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildReviewSet, diffFor } from './lib/reviewset.mjs';
import { digestLog } from './lib/logdigest.mjs';
import { accountInput, bytesOf } from './lib/tokens.mjs';
import { PRICING } from './config.mjs';
import { startMock } from './test/mock-server.mjs';

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i > -1 ? argv[i + 1] : d; };
const useMock = argv.includes('--mock');
const BASE = flag('base', 'origin/main');
const HEAD = flag('head', 'HEAD');

const git = (a) => execFileSync('git', a, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });

const REVIEW_INSTRUCTION =
  'Review this change for correctness and security defects. Report file and line for each finding. ' +
  'Confirm every changed file has been accounted for.';

/** Evidence this review must surface, whatever arm produced it. */
const MUST_FIND = ['sk-ant-api03', 'execFileSync', 'TODO', 'jev.test.mjs', 'candidates.mjs'];

function qualityOf(serialized, allFiles, arm) {
  const missingEvidence = MUST_FIND.filter((m) => !serialized.includes(m));
  const missingFiles = allFiles.filter((f) => !serialized.includes(f));
  return {
    evidenceRetained: missingEvidence.length === 0,
    missingEvidence,
    allFilesAccountedFor: missingFiles.length === 0,
    missingFiles: missingFiles.slice(0, 5),
    unreadDeclared: arm === 'A' ? 'n/a (whole diff present)' : serialized.includes('NOT read in full'),
  };
}

/** Percentages with their denominator named, because 0.56%-of-B and 0.22pp-of-A
 *  are different statements about the same 257 bytes. */
function compare(A, B, C, cache) {
  const pct = (num, den) => Number(((num / den) * 100).toFixed(2));
  const savedVsA = (x) => pct(A.totalBytes - x.totalBytes, A.totalBytes);
  return {
    extractionInput: {
      note: 'input for review-candidate extraction only, NOT a completed review',
      B_savedVsA_pctOfA: savedVsA(B),
      C_savedVsA_pctOfA: savedVsA(C),
      cache_savedVsA_pctOfA: savedVsA(cache),
      C_vs_B_bytes: B.totalBytes - C.totalBytes,
      C_vs_B_pctOfB: pct(B.totalBytes - C.totalBytes, B.totalBytes),
      C_vs_B_percentagePointsOfA: Number((savedVsA(C) - savedVsA(B)).toFixed(2)),
      denominatorWarning: 'C_vs_B_pctOfB uses B as the denominator; C_vs_B_percentagePointsOfA is a difference of two A-based percentages. They are not interchangeable.',
    },
    reviewCompletion: {
      note: 'to COMPLETE the review every changed file must be read. Files the helper skipped are not reviewed, so the extraction saving above is not a completed-review quota saving.',
      A_bytes: A.totalBytes,
      B_completionBytes: B.completionBytes,
      C_completionBytes: C.completionBytes,
      B_savedVsA_pctOfA: pct(A.totalBytes - B.completionBytes, A.totalBytes),
      C_savedVsA_pctOfA: pct(A.totalBytes - C.completionBytes, A.totalBytes),
      filesLeftUnread: C.filesLeftUnread,
    },
  };
}

async function measureReview(env) {
  const rawDiff = diffFor(BASE, HEAD);
  const allFiles = [...rawDiff.matchAll(/^diff --git a\/.+? b\/(.+)$/gm)].map((m) => m[1]);

  // ---- Arm A: no helper. The reviewer reads the whole diff. ----
  const tA0 = Date.now();
  const statOnly = git(['diff', '--stat', `${BASE}...${HEAD}`]);
  const armA = await accountInput({ instruction: REVIEW_INSTRUCTION, stat: statOnly, body: rawDiff }, { env });
  armA.ms = Date.now() - tA0;
  armA.quality = qualityOf(rawDiff, allFiles, 'A');
  armA.followupReads = { files: 0, bytes: 0, note: 'none: the full diff is already in context' };

  // ---- Arms B and C: helper output, plus the re-reads it still forces. ----
  const runHelper = async (useJev) => {
    const t0 = Date.now();
    const set = await buildReviewSet({ base: BASE, head: HEAD, budgetFiles: 4, env: useJev ? env : { ...env, JEV_ENABLED: '' } });
    const ms = Date.now() - t0;
    const json = JSON.stringify(set, null, 2);
    // Follow-up: a reviewer must still open every high-risk file the digest
    // declined to read. That cost belongs to this arm.
    const followups = set.notReviewed.filter((f) => f.risk === 'high');
    const followupText = followups.map((f) => git(['diff', '--no-color', `${BASE}...${HEAD}`, '--', f.file])).join('\n');
    // Completing the review means reading EVERY file the helper skipped, not
    // only the high-risk ones.
    const allSkipped = set.notReviewed.map((f) => git(['diff', '--no-color', `${BASE}...${HEAD}`, '--', f.file])).join('\n');
    const acct = await accountInput({ instruction: REVIEW_INSTRUCTION, helperJson: json, followupReads: followupText }, { env });
    const digestOnly = await accountInput({ instruction: REVIEW_INSTRUCTION, helperJson: json }, { env });
    return {
      ...acct, ms, set,
      digestOnly: { totalBytes: digestOnly.totalBytes, totalTokens: digestOnly.totalTokens },
      followupReads: { files: followups.length, bytes: bytesOf(followupText), note: 'high-risk files the digest did not read in full' },
      completionBytes: bytesOf(REVIEW_INSTRUCTION) + bytesOf(json) + bytesOf(allSkipped),
      filesLeftUnread: set.notReviewed.length,
      quality: qualityOf(json + followupText, allFiles, useJev ? 'C' : 'B'),
      jev: set.jev,
    };
  };

  const armB = await runHelper(false);
  const armC = await runHelper(true);
  const armCache = await runHelper(true); // identical question -> cache path

  const costBasis = useMock ? 'simulated (loopback mock replaying a fixture usage)' : 'real (api.typesafe.ai)';
  const jevCost = (u) => Number((((u?.usage?.input_tokens ?? 0) / 1e6) * PRICING.inputUsdPerMTok).toFixed(9));
  const costField = (u) => (useMock
    ? { jevCostUsdSimulated: jevCost(u), jevCostUsdReal: null, costBasis }
    : { jevCostUsdReal: jevCost(u), costBasis });

  return {
    task: 'review PR diff',
    input: { base: BASE, head: HEAD, files: allFiles.length, rawDiffBytes: bytesOf(rawDiff) },
    arms: {
      A: { label: 'plain local review input', ...armA },
      B: { label: 'local preprocessing (Jev off)', ...armB, set: undefined, jevCalls: 0, jevCostUsdSimulated: 0, jevCostUsdReal: 0, costBasis: 'none (no call)' },
      C: { label: 'Jev preprocessing', ...armC, set: undefined, jevCalls: armC.jev?.usedJev ? (armC.jev.attempts ?? 1) : 0, ...costField(armC.jev), jevLatencyNote: `helper wall time ${armC.ms}ms (includes the ${useMock ? 'loopback mock' : 'Jev'} round trip when one happened)` },
      cache: { label: 'Jev preprocessing, cache reuse', ...armCache, set: undefined, jevCalls: armCache.jev?.usedJev ? (armCache.jev.attempts ?? 1) : 0, ...costField(armCache.jev) },
    },
    comparisons: compare(armA, armB, armC, armCache),
  };
}

async function measureLog(env) {
  const lines = [];
  for (let i = 0; i < 700; i++) lines.push(`[info] vite: transforming src/module-${i % 30}.ts (${i % 80}ms)`);
  lines.splice(200, 0, 'npm ERR! command failed with exit code 1');
  lines.splice(400, 0, 'not ok 4 - ranking retry');
  const text = lines.join('\n');
  const dir = mkdtempSync(join(tmpdir(), 'jev-measure-')); const file = join(dir, 'b.log');
  writeFileSync(file, text);

  const armA = await accountInput({ instruction: 'Find why the build failed.', body: text }, { env });
  const t0 = Date.now();
  const digest = await digestLog({ file, env });
  const ms = Date.now() - t0;
  const json = JSON.stringify(digest, null, 2);
  const armC = await accountInput({ instruction: 'Find why the build failed.', helperJson: json }, { env });
  const must = ['exit code 1', 'not ok 4'];
  return {
    task: 'long build log',
    input: { lines: text.split('\n').length, bytes: bytesOf(text) },
    arms: {
      A: { label: 'whole log in context', ...armA },
      C: { label: 'helper digest', ...armC, ms, jevCalls: digest.attempts ?? 0, jevReason: digest.reason,
           costBasis: useMock ? 'simulated (loopback mock)' : 'real',
           quality: { evidenceRetained: must.every((m) => json.includes(m)), missingEvidence: must.filter((m) => !json.includes(m)) } },
    },
  };
}

const mock = useMock ? await startMock([{}]) : null;
if (mock) {
  const d = mkdtempSync(join(tmpdir(), 'jev-measure-ledger-'));
  Object.assign(process.env, {
    JEV_ENABLED: '1', TYPESAFE_API_KEY: 'measure-key-not-real', JEV_MOCK_BASE_URL: mock.baseUrl,
    JEV_LEDGER_PATH: join(d, 'budget.json'), JEV_CACHE_PATH: join(d, 'cache.json'),
  });
}

const report = {
  generatedAt: new Date().toISOString(),
  mode: mock ? 'mock (loopback)' : 'default OFF (local only)',
  accounting: {
    costBasis: useMock
      ? 'SIMULATED: every response came from a loopback mock replaying a fixture usage. No billed TypeSafe request has succeeded from this cloud environment.'
      : 'real: responses came from api.typesafe.ai',
    scope: 'bytes compare the INPUT for review-candidate extraction; see comparisons.reviewCompletion for the cost of actually finishing the review',
    bytes: 'MEASURED',
    tokens: 'MEASURED only via POST /v1/messages/count_tokens; otherwise a labelled estimate',
    quota: 'NOT observable from this environment; never reported',
    counted: 'instruction + body + helper JSON + follow-up re-reads',
  },
  review: await measureReview(process.env),
  log: await measureLog(process.env),
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (mock) await mock.close();
