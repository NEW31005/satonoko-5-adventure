// Pre-review evidence narrowing.
//
// Non-negotiable invariants, because a review that silently skips a file is
// worse than no review:
//
//   1. The FULL inventory of every changed file is always emitted. Narrowing
//      decides what gets READ IN FULL, never what gets listed.
//   2. Files not read in full appear in `notReviewed` with the exact command to
//      read them. They are never described as safe, clean, or reviewed.
//   3. Original line numbers (old and new) are carried on every retained line.
//   4. Risk markers -- skipped tests, suppressions, swallowed errors, exec,
//      unresolved work, secrets -- are PINNED and surfaced whatever any score says.
//   5. Jev, when consulted at all, only ORDERS the ambiguous middle. It can
//      never remove a file from the inventory or clear a pinned marker.

import { execFileSync } from 'node:child_process';
import { CAPS, MODEL_PIN, isDenied, loadAllowlist, repoRoot } from '../config.mjs';
import { findSecrets, findStrongSecrets } from './redact.mjs';
import { systemOne } from './client.mjs';
import { cacheKey, readCache, writeCache, repoState } from './cache.mjs';

/** Fixed argv only; nothing from a diff or a model answer reaches a shell. */
function git(args) {
  return execFileSync('git', args, {
    cwd: repoRoot(), encoding: 'utf8', timeout: 30_000,
    maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
  });
}

/** Always pinned when present on an ADDED line. */
const DIFF_MARKERS = [
  ['skipped-test', /\.(?:skip|only)\s*\(|\bxit\s*\(|\bxdescribe\s*\(|\bt\.skip\b/],
  ['suppression', /@ts-ignore|@ts-nocheck|eslint-disable|#\s*noqa|#\s*type:\s*ignore|prettier-ignore|istanbul ignore/],
  ['swallowed-error', /catch\s*\([^)]*\)\s*\{\s*\}|except\s*:\s*pass|\.catch\(\s*\(\s*\)\s*=>\s*\{\s*\}\s*\)|catch\s*\{\s*\}/],
  ['unresolved', /\bTODO\b|\bFIXME\b|\bXXX\b|\bHACK\b/],
  ['dangerous-exec', /child_process|execSync|spawnSync|\beval\s*\(|new\s+Function\s*\(|shell\s*:\s*true/],
  // Real outbound calls only. A bare URL in prose is not a network change.
  ['network', /\bfetch\s*\(|\baxios\b|XMLHttpRequest|\bhttps?\.request\s*\(|\bnew\s+WebSocket\s*\(/],
  // Actual auth surface, not any sentence containing "permission" or "AUTHORS".
  ['auth-surface', /\b(?:getAuth|signIn|signOut|currentUser|onAuthStateChanged|authorization|Bearer|api[_-]?key|access[_-]?token|refresh[_-]?token|hashPassword|setPassword)\b|allow\s+(?:read|write|create|update|delete)\s*:/i],
];

/** Rules that only make sense in code; prose and licences are exempt. */
const CODE_ONLY = new Set(['suppression', 'swallowed-error', 'dangerous-exec', 'network', 'auth-surface', 'skipped-test']);
const PROSE = /\.(?:md|txt|rst)$|(?:^|\/)(?:LICENSE|LICENCE|NOTICE|COPYING)$/i;

export function markersFor(line, file = '') {
  const prose = PROSE.test(file);
  const tags = [];
  for (const [name, re] of DIFF_MARKERS) {
    if (prose && CODE_ONLY.has(name)) continue;
    if (re.test(line)) tags.push(name);
  }
  // Tiering uses the precise rule set; transmission blocking still uses the
  // paranoid one in redact.mjs.
  if (findStrongSecrets(line).length) tags.push('possible-secret');
  return tags;
}

const GENERATED = /(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml|\.min\.(?:js|css)|dist\/|build\/)/;
const DOCS = /\.(?:md|txt|rst)$/i;

/** Cheap local risk tier. Decides reading order, never whether a file is listed. */
export function riskOf(file, addedLines) {
  const reasons = [];
  if (/firestore\.rules|\.rules$|auth|security|crypto|secret|login|session/i.test(file)) reasons.push('sensitive path');
  if (GENERATED.test(file)) reasons.push('generated/lockfile');
  if (DOCS.test(file)) reasons.push('documentation');
  const tags = new Set(addedLines.flatMap((l) => markersFor(l, file)));
  for (const t of tags) reasons.push(t);

  let tier = 'medium';
  if (tags.has('possible-secret') || tags.has('dangerous-exec') || tags.has('skipped-test')
      || tags.has('suppression') || tags.has('swallowed-error') || reasons.includes('sensitive path')) tier = 'high';
  else if (GENERATED.test(file)) tier = 'generated';
  else if (DOCS.test(file)) tier = 'low';
  return { tier, reasons: [...new Set(reasons)] };
}

/** Parse unified diff, preserving BOTH old and new line numbers. */
export function parseDiff(text) {
  const files = [];
  let cur = null, oldLine = 0, newLine = 0;
  for (const raw of text.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(raw);
      cur = { file: m ? m[2] : raw.slice(11), status: 'modified', hunks: [], added: 0, removed: 0, binary: false };
      files.push(cur);
      continue;
    }
    if (!cur) continue;
    if (raw.startsWith('new file mode')) { cur.status = 'added'; continue; }
    if (raw.startsWith('deleted file mode')) { cur.status = 'deleted'; continue; }
    if (raw.startsWith('rename to ')) { cur.status = 'renamed'; continue; }
    if (raw.startsWith('Binary files')) { cur.binary = true; continue; }
    const hh = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(raw);
    if (hh) {
      oldLine = Number(hh[1]); newLine = Number(hh[3]);
      cur.hunks.push({ header: raw, oldStart: oldLine, newStart: newLine, context: hh[5].trim(), lines: [] });
      continue;
    }
    const h = cur.hunks[cur.hunks.length - 1];
    if (!h) continue;
    if (raw.startsWith('+') && !raw.startsWith('+++')) {
      h.lines.push({ sign: '+', new: newLine, old: null, text: raw.slice(1) });
      newLine++; cur.added++;
    } else if (raw.startsWith('-') && !raw.startsWith('---')) {
      h.lines.push({ sign: '-', new: null, old: oldLine, text: raw.slice(1) });
      oldLine++; cur.removed++;
    } else if (raw.startsWith(' ')) {
      h.lines.push({ sign: ' ', new: newLine, old: oldLine, text: raw.slice(1) });
      oldLine++; newLine++;
    }
  }
  return files;
}

export const diffFor = (base, head) =>
  git(['diff', '--no-color', '--find-renames', `${base}...${head}`]);

const TIER_ORDER = { high: 0, medium: 1, low: 2, generated: 3 };

/**
 * Build the review set.
 *
 * `budgetFiles` caps how many files are read IN FULL. Every other changed file
 * still appears in the inventory and in `notReviewed`.
 */
export async function buildReviewSet({
  base, head, budgetFiles = 6, env = process.env, fetchImpl = globalThis.fetch, now = Date.now(),
} = {}) {
  const t0 = Date.now();
  const raw = diffFor(base, head);
  const parsed = parseDiff(raw);

  const inventory = parsed.map((f) => {
    const added = f.hunks.flatMap((h) => h.lines.filter((l) => l.sign === '+').map((l) => l.text));
    const { tier, reasons } = riskOf(f.file, added);
    return { file: f.file, status: f.status, binary: f.binary, added: f.added, removed: f.removed, risk: tier, riskReasons: reasons, _parsed: f };
  });

  // Pinned evidence: every marker on every added line, from the WHOLE diff --
  // including files that will not be read in full.
  const pinned = [];
  for (const f of parsed) {
    for (const h of f.hunks) {
      for (const l of h.lines) {
        if (l.sign !== '+') continue;
        const tags = markersFor(l.text, f.file);
        if (tags.length) pinned.push({ file: f.file, newLine: l.new, tags, text: l.text.trim().slice(0, 200) });
      }
    }
    // A removed test is evidence too.
    for (const h of f.hunks) {
      for (const l of h.lines) {
        if (l.sign !== '-') continue;
        if (/\b(?:it|test|describe)\s*\(/.test(l.text)) pinned.push({ file: f.file, oldLine: l.old, tags: ['removed-test'], text: l.text.trim().slice(0, 200) });
      }
    }
  }

  const ordered = [...inventory].sort((a, b) =>
    (TIER_ORDER[a.risk] - TIER_ORDER[b.risk]) || (b.added + b.removed) - (a.added + a.removed));

  // Jev is consulted only when the ambiguous middle is genuinely large.
  const ambiguous = ordered.filter((f) => f.risk === 'medium');
  const allow = loadAllowlist();
  let jev = { usedJev: false, reason: null };

  if (ambiguous.length >= CAPS.minCandidatesForJev) {
    const sendable = ambiguous
      .filter((f) => allow.paths.has(f.file) && !isDenied(f.file))
      .slice(0, CAPS.maxCandidates);
    const summaries = sendable.map((f, i) => {
      const adds = f._parsed.hunks.flatMap((h) => h.lines.filter((l) => l.sign === '+').map((l) => l.text))
        .join('\n').slice(0, CAPS.maxExcerptChars);
      return { id: `f${i + 1}`, entry: f, text: `+${f.added}/-${f.removed}\n${adds}` };
    }).filter((s) => !findSecrets(s.text).length);

    if (summaries.length >= 2) {
      const criteria = Object.fromEntries(summaries.map((s) => [s.id, s.text]));
      const questions = { pick: { type: 'choice', instructions: 'Which change is most likely to contain a correctness or security defect a reviewer must read first?', criteria } };
      const state = { task: 'review triage', change_count: summaries.length };
      const key = cacheKey({ contents: summaries.map((s) => s.text), questions, model: MODEL_PIN, state: repoState() });
      const cached = readCache(key, { now });
      let choice = null;
      if (cached.hit) { choice = cached.answers.pick?.choice; jev = { usedJev: false, reason: 'served from cache, 0 calls', cache: 'hit' }; }
      else {
        const sent = await systemOne({ state, questions, env, fetchImpl });
        if (sent.ok && sent.accepted?.pick) {
          writeCache(key, { answers: sent.accepted, usage: sent.usage, resolvedModel: sent.resolvedModel }, { now });
          choice = sent.accepted.pick.choice;
          jev = { usedJev: true, reason: 'Jev ordered the ambiguous middle', usage: sent.usage, resolvedModel: sent.resolvedModel, attempts: sent.attempts, bytes: { request: sent.requestBytes, response: sent.responseBytes } };
        } else {
          jev = { usedJev: false, reason: `local order (${sent.ok ? `answer rejected: ${sent.rejected?.pick}` : sent.reason})`, fallback: true };
        }
      }
      const lead = summaries.find((s) => s.id === choice)?.entry;
      if (lead) { // promote, never remove
        const i = ordered.indexOf(lead);
        if (i > -1) { ordered.splice(i, 1); ordered.unshift(lead); }
      }
    } else {
      jev = { usedJev: false, reason: `only ${summaries.length} allowlisted sendable change(s): ordered locally` };
    }
  } else {
    jev = { usedJev: false, reason: `${ambiguous.length} ambiguous file(s) (< ${CAPS.minCandidatesForJev}): ordered locally, no Jev call` };
  }

  const selected = ordered.slice(0, budgetFiles);
  const selectedSet = new Set(selected.map((f) => f.file));

  const readInFull = selected.map((f) => {
    // Changed lines only, capped, with markers kept first so a cap can never
    // drop evidence in favour of ordinary lines.
    const all = f._parsed.hunks.flatMap((h) => h.lines.filter((l) => l.sign !== ' ')
      .map((l) => ({ ...l, hunk: h.header, marked: l.sign === '+' && markersFor(l.text, f.file).length > 0 })));
    const marked = all.filter((l) => l.marked);
    const rest = all.filter((l) => !l.marked);
    const keep = [...marked, ...rest].slice(0, CAPS.maxHunkLinesPerFile);
    const keepSet = new Set(keep);
    return {
      file: f.file, risk: f.risk, riskReasons: f.riskReasons,
      hunkHeaders: f._parsed.hunks.map((h) => h.header),
      lines: all.filter((l) => keepSet.has(l))
        .map((l) => ({ sign: l.sign, old: l.old, new: l.new, text: l.text.slice(0, CAPS.maxDiffLineChars) })),
      linesShown: keep.length,
      linesElided: Math.max(0, all.length - keep.length),
      command: `git diff ${base}...${head} -- ${f.file}`,
    };
  });

  const notReviewed = ordered.filter((f) => !selectedSet.has(f.file)).map((f) => ({
    file: f.file, risk: f.risk, added: f.added, removed: f.removed,
    reason: f.binary ? 'binary' : `outside the read budget of ${budgetFiles} file(s)`,
    command: `git diff ${base}...${head} -- ${f.file}`,
    reviewed: false,
  }));

  // Group pinned evidence: counts are exact, examples are capped.
  const byKey = new Map();
  for (const p of pinned) {
    const k = `${p.file}::${p.tags.join(',')}`;
    if (!byKey.has(k)) byKey.set(k, { file: p.file, tags: p.tags, count: 0, examples: [] });
    const g = byKey.get(k);
    g.count++;
    if (g.examples.length < CAPS.maxPinnedPerTag) g.examples.push({ line: p.newLine ?? p.oldLine, text: p.text });
  }
  const severity = (t) => (['possible-secret', 'dangerous-exec', 'skipped-test', 'removed-test', 'swallowed-error', 'suppression'].some((x) => t.includes(x)) ? 0 : 1);
  const pinnedGroups = [...byKey.values()].sort((a, b) => severity(a.tags) - severity(b.tags) || b.count - a.count);
  const pinnedShown = pinnedGroups.slice(0, CAPS.maxPinnedShown);

  return {
    base, head,
    totals: {
      files: inventory.length,
      added: inventory.reduce((a, f) => a + f.added, 0),
      removed: inventory.reduce((a, f) => a + f.removed, 0),
      readInFull: readInFull.length,
      notReviewed: notReviewed.length,
    },
    // The complete list, always, whatever was narrowed.
    inventory: inventory.map(({ _parsed, ...rest }) => rest),
    pinned: pinnedShown,
    pinnedTotals: {
      occurrences: pinned.length,
      groups: pinnedGroups.length,
      groupsShown: pinnedShown.length,
      groupsElided: Math.max(0, pinnedGroups.length - pinnedShown.length),
    },
    readInFull,
    notReviewed,
    jev,
    warning: notReviewed.length
      ? `${notReviewed.length} changed file(s) were NOT read in full and are NOT reviewed. Jev not selecting a file says nothing about its safety. Read them with the commands in notReviewed, or raise --budget.`
      : 'every changed file was read in full',
    elapsedMs: Date.now() - t0,
    rawDiffBytes: Buffer.byteLength(raw),
  };
}
