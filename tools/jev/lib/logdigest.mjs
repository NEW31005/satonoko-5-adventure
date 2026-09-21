// Pattern B: collapse a large log locally, call Jev only for what is left.
//
// The whole log is never printed into the agent's context. Local dedupe does the
// bulk of the work; Jev is asked to rank the residue only when many distinct
// groups survive. Lines that carry an outcome -- failures, exit codes,
// exceptions, security warnings, unresolved work -- are PINNED: they are kept
// whatever score they get, and they are never the lines that get omitted.

import { readFileSync } from 'node:fs';
import { CAPS, MODEL_PIN } from '../config.mjs';
import { scrubLines, findSecrets } from './redact.mjs';
import { systemOne } from './client.mjs';
import { cacheKey, readCache, writeCache, repoState } from './cache.mjs';

/** Always retained, regardless of any score. */
const PINNED = [
  ['failed-test', /\b(FAIL|FAILED|failing|✗|✘)\b|\bnot ok\b|\bAssertionError\b|\bexpect\(.*\)\s*(to|\.)/i],
  // NOTE: the zero-count guard below keeps summary lines such as "# fail 0"
  // out of `pinned` -- they report the ABSENCE of failures.
  // Covers "exit code 1", "exited with code 2", "exit status: 3".
  ['exit-code', /\bexit(?:ed)?\s+(?:with\s+)?(?:code|status)\b\s*[:=]?\s*[1-9]\d*|\bnon-zero exit\b|\bcommand failed\b/i],
  // The stack-frame arm allows the space before "(" in "at Foo.bar (file:1:2)".
  ['exception', /\b(Exception|Traceback|Unhandled|panic:|SIGSEGV|SIGABRT|core dumped|stack trace)\b|^\s*at\s+.+\(.*:\d+:\d+\)/i],
  ['error', /\b(ERROR|FATAL|CRITICAL)\b|\bError:/],
  // Each alternative carries its own boundaries: a trailing \b after a prefix
  // like "vulnerab" can never match inside "vulnerabilities".
  ['security', /\bvulnerab|\bCVE-\d{4}-\d+\b|\bsecurity (?:warning|advisory|alert|issue)\b|\binsecure\b|\bdeprecated cipher\b|\bpermission denied\b|\bunauthorized\b/i],
  // Deliberately narrow: a bare "blocked" or "pending" appears constantly in
  // ordinary build chatter and in test names, and would swamp real evidence.
  ['unresolved', /\bTODO\b|\bFIXME\b|\bXXX\b|\bUNRESOLVED\b|\bblocked by\b|\bneeds? follow[- ]?up\b|\bawaiting (?:review|decision)\b/i],
];

/**
 * Summary lines that report a count of ZERO are the opposite of evidence.
 * "# fail 0" must not be pinned as a failure.
 */
const ZERO_COUNT = /^[\s#>*-]*(?:fail(?:ures?|ed)?|todo|skipped|cancelled|errors?|warnings?|vulnerabilit(?:y|ies))\s*[:=]?\s*0\s*$/i;
/** The other word order: "found 0 vulnerabilities". No other digit may appear. */
const ZERO_COUNT_PREFIX = /^[^\d]*\b0\s+(?:vulnerabilit(?:y|ies)|errors?|warnings?|failures?|issues?|problems?)\b[^\d]*$/i;

export function classify(line) {
  if (ZERO_COUNT.test(line) || ZERO_COUNT_PREFIX.test(line)) return [];
  const tags = [];
  for (const [name, re] of PINNED) if (re.test(line)) tags.push(name);
  return tags;
}

/** Collapse volatile detail so repeated lines land in one group. */
export function templateOf(line) {
  return line
    .replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\b/g, '<ts>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
    .replace(/\b0x[0-9a-f]+\b/gi, '<hex>')
    .replace(/\b[0-9a-f]{32,}\b/gi, '<hash>')
    .replace(/\b\d+(\.\d+)?(ms|s|kb|mb|gb|%)\b/gi, '<n><unit>')
    .replace(/\b\d+\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

/** Pointers back into the codebase, plus the commands to widen the search. */
export function traceLeads(lines) {
  const files = new Map();
  const tests = new Set();
  const types = new Set();
  for (const l of lines) {
    for (const m of l.matchAll(/([\w./-]+\.(?:ts|tsx|js|mjs|cjs|jsx|py|go|rs|java|rb))(?::(\d+))?/g)) {
      const k = m[1].replace(/^\.\//, '');
      if (!files.has(k)) files.set(k, new Set());
      if (m[2]) files.get(k).add(Number(m[2]));
    }
    for (const m of l.matchAll(/(?:✓|✗|ok|not ok|PASS|FAIL)\s+\d*\s*[-–]?\s*(.{4,80}?)(?:\s+\(\d|$)/gi)) tests.add(m[1].trim());
    for (const m of l.matchAll(/\b(?:type|interface|class|enum)\s+([A-Z]\w+)/g)) types.add(m[1]);
    for (const m of l.matchAll(/\b([A-Z]\w{2,})(?:Error|Exception)\b/g)) types.add(`${m[1]}Error`);
  }
  const fileList = [...files.entries()].slice(0, 12).map(([f, ls]) => ({ file: f, lines: [...ls].slice(0, 6) }));
  return {
    files: fileList,
    tests: [...tests].slice(0, 10),
    types: [...types].slice(0, 10),
    howToWiden: [
      ...fileList.slice(0, 3).map((f) => `rg -n --glob '!node_modules' -- '${f.file.split('/').pop().replace(/\.\w+$/, '')}' .`),
      ...[...types].slice(0, 2).map((t) => `rg -n -- '\\b${t}\\b' .   # declaration / callers / spec`),
      'node tools/jev/cli.mjs log <file> --show-group <template-index>   # full lines for one group',
    ],
  };
}

/**
 * Digest a log. `text` or `file` is read locally; only group templates are ever
 * considered for sending, and only when the residue is large enough to matter.
 */
export async function digestLog({ text, file, question = 'Which log groups are most likely to explain the failure?', topN = 12, env = process.env, fetchImpl = globalThis.fetch, now = Date.now() }) {
  const t0 = Date.now();
  const raw = text ?? readFileSync(file, 'utf8');
  const allLines = raw.split('\n');
  const inputBytes = Buffer.byteLength(raw);

  // Secrets leave the pipeline before anything else looks at the content.
  const scrubbed = scrubLines(raw);
  const lines = scrubbed.text.split('\n').filter((l) => l.trim());

  const groups = new Map();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = templateOf(line);
    if (!t) continue;
    let g = groups.get(t);
    if (!g) groups.set(t, (g = { template: t, count: 0, first: line, firstLine: i + 1, tags: classify(line) }));
    g.count++;
    for (const tag of classify(line)) if (!g.tags.includes(tag)) g.tags.push(tag);
  }

  const all = [...groups.values()];
  const pinned = all.filter((g) => g.tags.length);
  const rest = all.filter((g) => !g.tags.length).sort((a, b) => b.count - a.count);
  const leads = traceLeads(lines);

  const result = {
    source: file ?? '<inline>',
    inputBytes, totalLines: allLines.length, distinctGroups: all.length,
    secretLinesWithheld: scrubbed.droppedCount,
    pinned: pinned.map((g) => ({ tags: g.tags, count: g.count, line: g.firstLine, text: g.first.slice(0, 300) })),
    usedJev: false, leads, elapsedMs: 0,
  };

  // Not enough residue to be worth a call: rank locally by frequency.
  // What a plain read would cost: one representative line per unpinned group,
  // at the same 200-char width the digest prints them.
  const residueBytes = rest.reduce((a, g) => a + Buffer.byteLength(g.first.slice(0, 200)), 0);
  result.residueBytes = residueBytes;
  if (rest.length < CAPS.minCandidatesForJev || residueBytes < CAPS.minBaselineBytesForJev) {
    result.other = rest.slice(0, topN).map((g) => ({ count: g.count, line: g.firstLine, text: g.first.slice(0, 200) }));
    result.omitted = { groups: Math.max(0, rest.length - topN), lines: lines.length - pinned.reduce((a, g) => a + g.count, 0) - rest.slice(0, topN).reduce((a, g) => a + g.count, 0) };
    result.reason = rest.length < CAPS.minCandidatesForJev
      ? `${rest.length} unpinned group(s) (< ${CAPS.minCandidatesForJev}): ranked locally, no Jev call`
      : `unpinned residue is only ${residueBytes}B (< ${CAPS.minBaselineBytesForJev}B): ranked locally, no Jev call`;
    result.elapsedMs = Date.now() - t0;
    return result;
  }

  const shortlist = rest.slice(0, CAPS.maxCandidates);
  const sendable = shortlist.filter((g) => !findSecrets(g.template).length);
  const criteria = Object.fromEntries(sendable.map((g, i) => [`g${i + 1}`, `Seen ${g.count}x: ${g.template}`]));
  const questions = { pick: { type: 'choice', instructions: question, criteria } };
  const state = { task: question, group_count: sendable.length };

  const key = cacheKey({ contents: sendable.map((g) => g.template), questions, model: MODEL_PIN, state: repoState() });
  const cached = readCache(key, { now });
  let chosenIdx = null, confidence = null, source = null, sent = null;

  if (cached.hit && cached.answers.pick?.choice) {
    chosenIdx = Number(String(cached.answers.pick.choice).slice(1)) - 1;
    confidence = cached.answers.pick.confidence;
    source = 'cache';
  } else {
    sent = await systemOne({ state, questions, env, fetchImpl });
    if (sent.ok && sent.accepted?.pick) {
      writeCache(key, { answers: sent.accepted, usage: sent.usage, resolvedModel: sent.resolvedModel }, { now });
      chosenIdx = Number(String(sent.accepted.pick.choice).slice(1)) - 1;
      confidence = sent.accepted.pick.confidence;
      source = 'jev';
      result.usedJev = true;
      result.usage = sent.usage;
      result.resolvedModel = sent.resolvedModel;
      result.bytes = { request: sent.requestBytes, response: sent.responseBytes };
      result.attempts = sent.attempts;
    } else {
      result.fallback = true;
      result.reason = `local fallback (${sent.ok ? `answer rejected: ${sent.rejected?.pick}` : sent.reason})`;
    }
  }

  // Jev only reorders the unpinned residue. Pinned lines are already in the
  // result and cannot be displaced by a score.
  let ordered = shortlist;
  if (chosenIdx != null && sendable[chosenIdx]) {
    const lead = sendable[chosenIdx];
    ordered = [lead, ...shortlist.filter((g) => g !== lead)];
    result.highlighted = { text: lead.first.slice(0, 300), count: lead.count, line: lead.firstLine, confidence, source };
  }

  const shown = ordered.slice(0, topN);
  result.other = shown.map((g) => ({ count: g.count, line: g.firstLine, text: g.first.slice(0, 200) }));
  const shownLines = pinned.reduce((a, g) => a + g.count, 0) + shown.reduce((a, g) => a + g.count, 0);
  result.omitted = {
    groups: all.length - pinned.length - shown.length,
    lines: Math.max(0, lines.length - shownLines),
    note: 'omitted groups are unpinned only; every failure, exit code, exception, security warning and unresolved marker is in `pinned`',
  };
  result.reason ??= `ranked ${sendable.length} unpinned group(s) via ${source}`;
  result.elapsedMs = Date.now() - t0;
  return result;
}
