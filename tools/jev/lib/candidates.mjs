// Pattern A: narrow locally, then let Jev pick among the survivors.
//
// Local search and symbol/path filters do the cheap work. Jev is asked only when
// many genuinely SEMANTIC candidates remain -- the case where the alternative is
// reading all of them into the agent's context. Code, not the model, resolves the
// winning id back to a real file, line and excerpt.
//
// What leaves the machine is a path-free DTO: opaque ids and excerpt text drawn
// only from exactly-allowlisted paths.

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { relative, isAbsolute } from 'node:path';
import { CAPS, isDenied, loadAllowlist, repoRoot, MODEL_PIN } from '../config.mjs';
import { findSecrets, scrubLines } from './redact.mjs';
import { systemOne } from './client.mjs';
import { cacheKey, readCache, writeCache, repoState } from './cache.mjs';

/** Fixed argv, never a shell string. */
function run(cmd, args) {
  try {
    return execFileSync(cmd, args, { cwd: repoRoot(), encoding: 'utf8', timeout: 20_000, maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) {
    return e?.stdout ?? '';
  }
}

const hasRg = (() => { try { execFileSync('rg', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

/** Local search producing file/line/text triples. */
export function localSearch(query, { globs = [], limit = 400 } = {}) {
  const out = hasRg
    ? run('rg', ['--no-heading', '--line-number', '--color', 'never', '--max-count', '20',
        ...globs.flatMap((g) => ['--glob', g]), '--', query, '.'])
    : run('grep', ['-rnI', '--exclude-dir=.git', '--exclude-dir=node_modules', '--exclude-dir=.jev', '--', query, '.']);

  const hits = [];
  for (const line of out.split('\n')) {
    if (!line.trim() || hits.length >= limit) continue;
    const m = /^(.*?):(\d+):([\s\S]*)$/.exec(line);
    if (!m) continue;
    const path = m[1].replace(/^\.\//, '');
    if (isDenied(path)) continue;
    hits.push({ path, line: Number(m[2]), text: m[3] });
  }
  return hits;
}

/**
 * Cheap local relevance score. Default is OFF, so the local ordering is the
 * ordinary path, not just a fallback -- ripgrep order is file order, which put a
 * JSON allowlist above the source file that actually answered the question.
 */
export function scoreHit(hit, query = '') {
  let s = 0;
  const p = hit.path.toLowerCase();
  if (/\b(?:export\s+)?(?:function|class|interface|type|enum|const|let|async)\s/.test(hit.text)) s += 3;
  if (/^\s*(?:export|import)\b/.test(hit.text)) s += 1;
  if (/\.(?:ts|tsx|js|mjs|cjs|jsx|py|go|rs|java|rb)$/.test(p)) s += 3;
  if (/\.(?:json|lock|md|txt|ya?ml|css|html)$/.test(p)) s -= 4;
  if (/(?:^|\/)(?:tests?|__tests__|spec)\//.test(p) || /\.(?:test|spec|bench)\./.test(p)) s -= 2;
  if (/(?:^|\/)(?:tools|scripts|examples?)\//.test(p)) s -= 1;
  // A path echoing a word from the query is a strong signal.
  for (const w of (query.toLowerCase().match(/[a-z][a-z0-9]{2,}/g) ?? [])) if (p.includes(w)) s += 2;
  return s;
}

/** Stable sort by descending local score. */
export const rankHits = (hits, query) =>
  hits.map((h, i) => ({ h, i, s: scoreHit(h, query) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map(({ h }) => h);

/** Widen one hit into a readable excerpt, straight from the file on disk. */
export function excerptFor({ path, line }, { context = 3 } = {}) {
  const abs = isAbsolute(path) ? path : `${repoRoot()}/${path}`;
  if (!existsSync(abs)) return '';
  const lines = readFileSync(abs, 'utf8').split('\n');
  const from = Math.max(0, line - 1 - context);
  const to = Math.min(lines.length, line + context);
  return lines.slice(from, to).join('\n').slice(0, CAPS.maxExcerptChars);
}

/**
 * Build the outbound DTO. Returns opaque ids only; the id -> path map stays here.
 * Candidates off the allowlist, or carrying a secret, are excluded and counted.
 */
export function buildDto(hits) {
  const allow = loadAllowlist();
  const map = new Map();
  const candidates = [];
  const excluded = { notAllowlisted: [], secretBearing: [], empty: [] };

  for (const hit of hits) {
    if (candidates.length >= CAPS.maxCandidates) break;
    if (!allow.paths.has(hit.path)) { excluded.notAllowlisted.push(hit.path); continue; }
    const raw = excerptFor(hit);
    if (!raw.trim()) { excluded.empty.push(hit.path); continue; }
    if (findSecrets(raw).length) {
      const scrubbed = scrubLines(raw);
      if (!scrubbed.text.trim() || findSecrets(scrubbed.text).length) { excluded.secretBearing.push(hit.path); continue; }
      const id = `c${candidates.length + 1}`;
      map.set(id, { ...hit, excerpt: raw, scrubbedLines: scrubbed.droppedCount });
      candidates.push({ id, excerpt: scrubbed.text });
      continue;
    }
    const id = `c${candidates.length + 1}`;
    map.set(id, { ...hit, excerpt: raw });
    candidates.push({ id, excerpt: raw });
  }
  return { candidates, map, excluded, allowlistSource: allow.source };
}

/**
 * Select the candidate that answers `question`.
 *
 * Returns a result carrying the REAL file/line/excerpt, resolved locally from the
 * chosen id, plus `usedJev` and the reason when it did not.
 */
export async function selectCandidate({ query, question, globs = [], env = process.env, fetchImpl = globalThis.fetch, now = Date.now() }) {
  const t0 = Date.now();
  const hits = rankHits(localSearch(query, { globs }), query);
  const base = { query, question, localHits: hits.length, elapsedMs: 0, usedJev: false };

  if (!hits.length) return { ...base, decision: null, reason: 'no local hits', elapsedMs: Date.now() - t0 };

  // Small or cheap work stays local. Two gates: too few candidates to be
  // ambiguous, or little enough material that reading it directly is cheaper
  // than a request.
  const baselineBytes = hits.reduce((a, h) => a + Buffer.byteLength(excerptFor(h)), 0);
  const tooFew = hits.length < CAPS.minCandidatesForJev;
  const tooCheap = baselineBytes < CAPS.minBaselineBytesForJev;
  if (tooFew || tooCheap) {
    return {
      ...base, baselineBytes,
      decision: { ...hits[0], excerpt: excerptFor(hits[0]) },
      alternatives: hits.slice(1, 5).map((h) => ({ path: h.path, line: h.line })),
      reason: tooFew
        ? `only ${hits.length} candidate(s) (< ${CAPS.minCandidatesForJev}): resolved locally, no Jev call`
        : `local material is only ${baselineBytes}B (< ${CAPS.minBaselineBytesForJev}B): reading it directly is cheaper than a call`,
      elapsedMs: Date.now() - t0,
    };
  }

  base.baselineBytes = baselineBytes;
  const { candidates, map, excluded, allowlistSource } = buildDto(hits);
  const exclusionSummary = {
    notAllowlisted: excluded.notAllowlisted.length,
    secretBearing: excluded.secretBearing.length,
    empty: excluded.empty.length,
    allowlistSource,
  };

  if (candidates.length < 2) {
    const first = hits[0];
    return {
      ...base, exclusions: exclusionSummary,
      decision: { ...first, excerpt: excerptFor(first) },
      reason: `only ${candidates.length} sendable candidate(s) after the allowlist: resolved locally`,
      elapsedMs: Date.now() - t0,
    };
  }

  const criteria = Object.fromEntries(candidates.map((c) => [c.id, `Candidate ${c.id}:\n${c.excerpt}`]));
  const questions = { pick: { type: 'choice', instructions: question, criteria } };
  const state = { task: question, candidate_count: candidates.length };

  const key = cacheKey({ contents: candidates.map((c) => c.excerpt), questions, model: MODEL_PIN, state: repoState() });
  const cached = readCache(key, { now });
  if (cached.hit) {
    const chosen = map.get(cached.answers.pick?.choice);
    if (chosen) {
      return {
        ...base, usedJev: false, cache: 'hit', exclusions: exclusionSummary,
        sentCandidates: candidates.length,
        decision: { path: chosen.path, line: chosen.line, excerpt: chosen.excerpt },
        confidence: cached.answers.pick.confidence,
        reason: `served from cache (stored ${new Date(cached.storedAt).toISOString()}), 0 calls`,
        elapsedMs: Date.now() - t0,
      };
    }
  }

  const sent = await systemOne({ state, questions, env, fetchImpl });
  const bytes = { request: sent.requestBytes ?? 0, response: sent.responseBytes ?? 0 };

  if (!sent.ok || !sent.accepted?.pick) {
    const why = sent.ok ? `answer rejected: ${sent.rejected?.pick}` : sent.reason;
    const first = hits[0];
    return {
      ...base, exclusions: exclusionSummary, sentCandidates: candidates.length,
      cache: cached.hit ? 'hit-unusable' : cached.reason,
      decision: { ...first, excerpt: excerptFor(first) },
      alternatives: hits.slice(1, 5).map((h) => ({ path: h.path, line: h.line })),
      fallback: true, reason: `local fallback (${why})`, attempts: sent.attempts, bytes,
      elapsedMs: Date.now() - t0,
    };
  }

  writeCache(key, { answers: sent.accepted, usage: sent.usage, resolvedModel: sent.resolvedModel }, { now });
  const chosen = map.get(sent.accepted.pick.choice);
  const ranked = Object.entries(sent.accepted.pick.probabilities)
    .sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([id, p]) => ({ path: map.get(id)?.path, line: map.get(id)?.line, p: Number(p.toFixed(4)) }));

  return {
    ...base, usedJev: true, cache: cached.reason, exclusions: exclusionSummary,
    sentCandidates: candidates.length,
    // Resolved here, from local data -- the model only returned an opaque id.
    decision: { path: chosen.path, line: chosen.line, excerpt: chosen.excerpt },
    confidence: sent.accepted.pick.confidence,
    ranked, usage: sent.usage, resolvedModel: sent.resolvedModel, settlement: sent.settlement,
    attempts: sent.attempts, bytes, reason: 'selected by Jev among allowlisted candidates',
    elapsedMs: Date.now() - t0,
  };
}
