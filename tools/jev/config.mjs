// Local operating policy for Claude Code's use of the TypeSafe System One API.
// NOT part of the official typesafe-ai skill: that lives unmodified under
// .claude/skills/typesafe-ai/. This file is our own guard rail configuration.

import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

/** Official endpoint, fixed. Never taken from a file, a model answer or a repo value. */
export const OFFICIAL_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';

/** Pinned model. A response that resolves to anything else is rejected. */
export const MODEL_PIN = 'jev-1.13.0';

/** Confirmed 2026-09-22. Output tokens are billed at zero; we still record them. */
export const PRICING = {
  confirmedOn: '2026-09-22',
  inputUsdPerMTok: 0.042,
  outputUsdPerMTok: 0,
};

/** Initial local-development ceilings. Attempts are counted, not just calls. */
export const BUDGET = {
  dailyUsd: 0.10,
  monthlyUsd: 5.00,
  dailyAttempts: 20,
  dailyReservedTokens: 100_000,
  maxConcurrent: 2,
};

export const CAPS = {
  /** Bytes of JSON we are willing to send in one request. */
  maxRequestBytes: 48_000,
  /** Bytes of response body we are willing to read. */
  maxResponseBytes: 256_000,
  /** Candidates offered to a single Choice question. */
  maxCandidates: 40,
  /** Questions per request. */
  maxQuestions: 8,
  /** Characters of any single candidate excerpt. */
  maxExcerptChars: 600,
  /** Retries after the first attempt, for rate limits and 5xx only. */
  maxRetries: 1,
  /** Per-attempt timeout. Overridable for tests; clamped to a sane range. */
  timeoutMs: Math.min(60_000, Math.max(200, Number(process.env.JEV_TIMEOUT_MS) || 10_000)),
  /** Conservative bytes-per-token estimate used to reserve budget up front. */
  bytesPerTokenEstimate: 3.2,
  /** Answers below this confidence are discarded and we fall back to local order. */
  minConfidence: 0.35,
  /** Cache lifetime. */
  cacheTtlMs: 24 * 60 * 60 * 1000,
  /** A lease older than this is settled as fully spent, never refunded. */
  staleLeaseMs: 5 * 60 * 1000,
  /** Below this many candidates the work is small: answer locally, never call Jev. */
  minCandidatesForJev: 8,
  /**
   * Second gate, measured rather than counted. If the material a plain local read
   * would put in context is already this small, a call cannot pay for itself --
   * benchmarking showed 5 candidates / 1.6 KB saving only 15% for a full request.
   */
  minBaselineBytesForJev: 4_000,
};

const TRUE = new Set(['1', 'true', 'yes', 'on']);
const flag = (name) => TRUE.has(String(process.env[name] ?? '').trim().toLowerCase());

/**
 * Resolve the runtime mode. Default is OFF: with no environment set at all,
 * every entry point returns a local-only result and makes no network call.
 */
export function resolveMode(env = process.env) {
  const enabled = TRUE.has(String(env.JEV_ENABLED ?? '').trim().toLowerCase());
  const mock = String(env.JEV_MOCK_BASE_URL ?? '').trim();
  if (mock) {
    // A mock base URL may only ever be loopback, so a misconfiguration cannot
    // send repository content to a third party.
    if (!/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(mock)) {
      return { kind: 'off', reason: 'JEV_MOCK_BASE_URL must be http://127.0.0.1:<port>' };
    }
    if (!enabled) return { kind: 'off', reason: 'JEV_ENABLED is not set' };
    return { kind: 'mock', endpoint: `${mock}/v1/systemone` };
  }
  if (!enabled) return { kind: 'off', reason: 'JEV_ENABLED is not set (default OFF)' };
  if (!TRUE.has(String(env.JEV_ALLOW_REAL_API ?? '').trim().toLowerCase())) {
    return { kind: 'off', reason: 'JEV_ALLOW_REAL_API is not set (real API stays OFF)' };
  }
  if (!String(env.TYPESAFE_API_KEY ?? '').trim()) {
    return { kind: 'off', reason: 'TYPESAFE_API_KEY is not present in this environment' };
  }
  return { kind: 'real', endpoint: OFFICIAL_ENDPOINT };
}

export const repoRoot = () => process.env.JEV_REPO_ROOT || process.cwd();

export const ledgerPath = () =>
  process.env.JEV_LEDGER_PATH || join(repoRoot(), '.jev', 'budget.json');

export const cachePath = () =>
  process.env.JEV_CACHE_PATH || join(repoRoot(), '.jev', 'cache.json');

export const allowlistPath = () =>
  process.env.JEV_ALLOWLIST_PATH || join(repoRoot(), 'tools', 'jev', 'allowlist.json');

/**
 * Exact repository-relative paths whose content may leave the machine.
 * No globs, no directories: a path is either listed or it is not sendable.
 */
export function loadAllowlist() {
  const p = allowlistPath();
  if (!existsSync(p)) return { paths: new Set(), source: p, raw: [] };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return { paths: new Set(), source: p, raw: [], invalid: true };
  }
  const raw = Array.isArray(parsed?.paths) ? parsed.paths.filter((x) => typeof x === 'string') : [];
  // Reject anything that is not a plain relative path.
  const clean = raw.filter((x) => x && !x.startsWith('/') && !x.includes('..') && !x.includes('*'));
  return { paths: new Set(clean), source: p, raw };
}

/** Anything matching these is never read for outbound content, allowlisted or not. */
export const HARD_DENY = [
  /(^|\/)\.git\//, /(^|\/)\.jev\//, /(^|\/)node_modules\//,
  /(^|\/)\.env($|\.)/, /\.(key|pem|pfx|p12|dpapi|keystore|jks)$/i,
  /(^|\/)\.private\//, /(^|\/)secrets?\//i, /(^|\/)\.ssh\//,
  /(^|\/)\.claude\/(projects|sessions|history)\//,
  /(conversation|transcript|chatlog|chat_history)/i,
  /\.(dpapi|enc|age|gpg)$/i,
];

export const isDenied = (relPath) => HARD_DENY.some((re) => re.test(relPath));

/** Config fingerprint: any change to these invalidates cached answers. */
export function configFingerprint() {
  return createHash('sha256')
    .update(JSON.stringify({ MODEL_PIN, PRICING, BUDGET, CAPS, OFFICIAL_ENDPOINT, v: 1 }))
    .digest('hex')
    .slice(0, 16);
}

export const usdForTokens = (inputTokens, outputTokens = 0) =>
  (inputTokens / 1e6) * PRICING.inputUsdPerMTok + (outputTokens / 1e6) * PRICING.outputUsdPerMTok;

export const estimateTokens = (bytes) => Math.ceil(bytes / CAPS.bytesPerTokenEstimate);

export const verbose = () => flag('JEV_VERBOSE');
