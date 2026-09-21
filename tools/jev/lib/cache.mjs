// Answer cache.
//
// The key binds an answer to everything that could change its meaning: the repo
// and commit, the WORKING-TREE DIRTY STATE, the full content actually sent (not
// a path or an mtime), the questions, the pinned model and the guard-rail config.
// Entries past their TTL, or that fail their own shape check, are rejected.

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { CAPS, MODEL_PIN, cachePath, configFingerprint, repoRoot } from '../config.mjs';

const sha = (s) => createHash('sha256').update(s).digest('hex');

/** Fixed argv only -- nothing from a file or a model answer reaches a shell. */
function git(args) {
  try {
    return execFileSync('git', args, { cwd: repoRoot(), encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

/** Identity of the tree as it stands right now, dirty edits included. */
export function repoState() {
  return {
    remote: git(['config', '--get', 'remote.origin.url']),
    head: git(['rev-parse', 'HEAD']),
    dirty: sha(git(['status', '--porcelain'])).slice(0, 16),
  };
}

export function cacheKey({ contents, questions, model = MODEL_PIN, state = repoState() }) {
  return sha(JSON.stringify({
    repo: state.remote,
    head: state.head,
    dirty: state.dirty,
    // Full content of every item sent, in order -- not paths, not sizes.
    content: contents.map((c) => sha(c)),
    questions,
    model,
    config: configFingerprint(),
    v: 1,
  }));
}

function loadStore(path) {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function validEntry(e) {
  return e && typeof e === 'object'
    && typeof e.storedAt === 'number' && typeof e.expiresAt === 'number'
    && typeof e.resolvedModel === 'string'
    && e.answers && typeof e.answers === 'object'
    && typeof e.configFingerprint === 'string';
}

/**
 * Returns { hit:false, reason } for a miss, an expired entry, a malformed entry,
 * a config change, or a model that no longer matches the pin.
 */
export function readCache(key, { path = cachePath(), now = Date.now(), model = MODEL_PIN } = {}) {
  const entry = loadStore(path)[key];
  if (!entry) return { hit: false, reason: 'miss' };
  if (!validEntry(entry)) return { hit: false, reason: 'rejected: malformed entry' };
  if (entry.expiresAt <= now) return { hit: false, reason: 'rejected: expired' };
  if (entry.configFingerprint !== configFingerprint()) return { hit: false, reason: 'rejected: config changed' };
  if (entry.resolvedModel !== model) return { hit: false, reason: `rejected: cached model ${entry.resolvedModel} != pin ${model}` };
  return { hit: true, answers: entry.answers, usage: entry.usage, resolvedModel: entry.resolvedModel, storedAt: entry.storedAt };
}

export function writeCache(key, { answers, usage, resolvedModel }, { path = cachePath(), now = Date.now(), ttlMs = CAPS.cacheTtlMs } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  const store = loadStore(path);
  // Sweep expired and malformed entries first, then add the new one.
  for (const [k, e] of Object.entries(store)) if (!validEntry(e) || e.expiresAt <= now) delete store[k];
  store[key] = { storedAt: now, expiresAt: now + ttlMs, answers, usage, resolvedModel, configFingerprint: configFingerprint() };
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2));
  renameSync(tmp, path);
  return { stored: true, expiresAt: now + ttlMs };
}
