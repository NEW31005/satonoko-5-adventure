#!/usr/bin/env node
// Entry point Claude Code calls. Prints a compact JSON digest -- never the whole
// log, never every candidate. Default is OFF: with no env set it answers locally
// and makes no network call.
//
//   node tools/jev/cli.mjs status
//   node tools/jev/cli.mjs find <regex> --question "..." [--glob '*.ts']
//   node tools/jev/cli.mjs log <file> [--question "..."] [--top 12]
//   node tools/jev/cli.mjs allow <path>...        # exact repo-relative paths
//   node tools/jev/cli.mjs budget

import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { CAPS, BUDGET, MODEL_PIN, PRICING, OFFICIAL_ENDPOINT, resolveMode, allowlistPath, loadAllowlist } from './config.mjs';
import { snapshot } from './lib/budget.mjs';
import { selectCandidate } from './lib/candidates.mjs';
import { digestLog } from './lib/logdigest.mjs';

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        flags[key] = true;
      } else {
        // Repeatable flags accumulate, e.g. --glob a --glob b.
        flags[key] = Array.isArray(flags[key]) ? [...flags[key], next] : [next];
        i++;
      }
    } else positional.push(a);
  }
  return { positional, flags };
}
const one = (v, d) => (Array.isArray(v) ? v[0] : v) ?? d;

const print = (obj) => process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const cmd = positional[0] ?? 'status';
  const mode = resolveMode();

  if (cmd === 'status') {
    const allow = loadAllowlist();
    return print({
      command: 'status',
      mode: mode.kind,
      modeReason: mode.reason ?? null,
      endpoint: mode.kind === 'real' ? OFFICIAL_ENDPOINT : (mode.endpoint ?? `${OFFICIAL_ENDPOINT} (not contacted)`),
      modelPin: MODEL_PIN,
      apiKeyPresent: Boolean(String(process.env.TYPESAFE_API_KEY ?? '').trim()),
      pricing: PRICING,
      caps: CAPS,
      budgetCaps: BUDGET,
      allowlist: { source: allow.source, count: allow.paths.size, paths: [...allow.paths] },
      budget: snapshot(),
    });
  }

  if (cmd === 'budget') return print({ command: 'budget', ...snapshot() });

  if (cmd === 'allow') {
    const add = positional.slice(1);
    if (!add.length) return print({ command: 'allow', error: 'no paths given' });
    const p = allowlistPath();
    mkdirSync(dirname(p), { recursive: true });
    let current = { paths: [] };
    if (existsSync(p)) { try { current = JSON.parse(readFileSync(p, 'utf8')); } catch { current = { paths: [] }; } }
    const before = new Set(Array.isArray(current.paths) ? current.paths : []);
    const rejected = [];
    for (const raw of add) {
      const rel = raw.replace(/^\.\//, '');
      if (rel.startsWith('/') || rel.includes('..') || rel.includes('*')) { rejected.push(rel); continue; }
      before.add(rel);
    }
    const next = { ...current, paths: [...before].sort() };
    writeFileSync(p, `${JSON.stringify(next, null, 2)}\n`);
    return print({ command: 'allow', file: p, count: next.paths.length, added: add, rejected });
  }

  if (cmd === 'find') {
    const query = positional[1];
    if (!query) return print({ command: 'find', error: 'usage: find <regex> --question "..."' });
    const result = await selectCandidate({
      query,
      question: one(flags.question, `Which candidate best matches: ${query}`),
      globs: Array.isArray(flags.glob) ? flags.glob : [],
    });
    return print({ command: 'find', ...result });
  }

  if (cmd === 'log') {
    const file = positional[1];
    if (!file) return print({ command: 'log', error: 'usage: log <file> [--question "..."]' });
    const result = await digestLog({
      file,
      question: one(flags.question, 'Which log group most likely explains the failure?'),
      topN: Number(one(flags.top, 12)),
    });
    return print({ command: 'log', ...result });
  }

  return print({ error: `unknown command '${cmd}'`, commands: ['status', 'find', 'log', 'allow', 'budget'] });
}

main().catch((e) => {
  print({ error: e?.message ?? String(e), code: e?.code ?? null });
  process.exitCode = 1;
});
