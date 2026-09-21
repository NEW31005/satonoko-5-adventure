// Atomic, shareable spend ledger.
//
// Every attempt -- including a retry after a 429 or a 5xx -- reserves budget
// BEFORE the request goes out. A crash, or a response with unusable usage
// numbers, settles at the reserved amount: never as free.
//
// Sharing: point JEV_LEDGER_PATH at one file from every environment that should
// draw on the same pot. Without that, each environment holds its own allocation
// and the totals are NOT combined -- see tools/jev/README.md.

import { mkdirSync, readFileSync, writeFileSync, renameSync, rmdirSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { BUDGET, CAPS, ledgerPath, usdForTokens } from '../config.mjs';

const EMPTY = { version: 1, days: {}, months: {}, leases: {} };

const dayKey = (d = new Date()) => d.toISOString().slice(0, 10);
const monthKey = (d = new Date()) => d.toISOString().slice(0, 7);

function sleepSync(ms) {
  const sab = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(sab, 0, 0, ms);
}

/** Directory creation is atomic, so it serves as a cross-process mutex. */
function withLock(path, fn) {
  const lock = `${path}.lock`;
  mkdirSync(dirname(path), { recursive: true });
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // Break a lock abandoned by a dead process.
      try {
        if (Date.now() - statSync(lock).mtimeMs > 30_000) rmdirSync(lock);
      } catch { /* raced with the owner; just retry */ }
      if (Date.now() > deadline) {
        const err = new Error('budget ledger is locked');
        err.code = 'JEV_LEDGER_LOCKED';
        throw err;
      }
      sleepSync(25);
    }
  }
  try {
    return fn();
  } finally {
    try { rmdirSync(lock); } catch { /* already released */ }
  }
}

function load(path) {
  if (!existsSync(path)) return structuredClone(EMPTY);
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (parsed?.version !== 1 || typeof parsed.days !== 'object') return structuredClone(EMPTY);
    return { ...structuredClone(EMPTY), ...parsed };
  } catch {
    // A corrupt ledger must not read as "nothing spent"; start a fresh one that
    // still holds today's caps rather than silently granting a clean slate.
    return structuredClone(EMPTY);
  }
}

function save(path, data) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, path); // atomic within a filesystem
}

const dayBucket = (l, k) => (l.days[k] ??= { attempts: 0, tokens: 0, usd: 0 });
const monthBucket = (l, k) => (l.months[k] ??= { usd: 0 });

/** Settle leases whose owner died. Conservative: the reservation is spent. */
function reclaimStale(l) {
  let reclaimed = 0;
  for (const [id, lease] of Object.entries(l.leases)) {
    if (Date.now() - lease.startedAt > CAPS.staleLeaseMs) {
      delete l.leases[id];
      reclaimed++;
    }
  }
  return reclaimed;
}

/**
 * Reserve one attempt. Returns { ok:false, reason } when a cap would be crossed;
 * the caller must then fall back to local-only behaviour without retrying.
 */
export function reserve({ tokens, path = ledgerPath(), now = new Date() } = {}) {
  const estTokens = Math.max(1, Math.ceil(tokens));
  const estUsd = usdForTokens(estTokens);
  return withLock(path, () => {
    const l = load(path);
    reclaimStale(l);
    const dk = dayKey(now), mk = monthKey(now);
    const day = dayBucket(l, dk), month = monthBucket(l, mk);

    const active = Object.keys(l.leases).length;
    if (active >= BUDGET.maxConcurrent)
      return { ok: false, reason: `concurrency cap: ${active}/${BUDGET.maxConcurrent} in flight` };
    if (day.attempts + 1 > BUDGET.dailyAttempts)
      return { ok: false, reason: `daily attempt cap: ${day.attempts}/${BUDGET.dailyAttempts}` };
    if (day.tokens + estTokens > BUDGET.dailyReservedTokens)
      return { ok: false, reason: `daily token reservation cap: ${day.tokens}+${estTokens} > ${BUDGET.dailyReservedTokens}` };
    if (day.usd + estUsd > BUDGET.dailyUsd)
      return { ok: false, reason: `daily USD cap: ${(day.usd + estUsd).toFixed(6)} > ${BUDGET.dailyUsd}` };
    if (month.usd + estUsd > BUDGET.monthlyUsd)
      return { ok: false, reason: `monthly USD cap: ${(month.usd + estUsd).toFixed(6)} > ${BUDGET.monthlyUsd}` };

    const leaseId = randomUUID();
    day.attempts += 1;
    day.tokens += estTokens;
    day.usd += estUsd;
    month.usd += estUsd;
    l.leases[leaseId] = { day: dk, month: mk, tokens: estTokens, usd: estUsd, startedAt: Date.now(), pid: process.pid };
    save(path, l);
    return { ok: true, leaseId, reservedTokens: estTokens, reservedUsd: estUsd };
  });
}

/**
 * Close a lease. Pass real usage to true it up; pass nothing (crash, malformed
 * or missing usage) and the reservation stands. Attempts are never refunded.
 */
export function settle(leaseId, usage, { path = ledgerPath() } = {}) {
  return withLock(path, () => {
    const l = load(path);
    const lease = l.leases[leaseId];
    if (!lease) return { ok: false, reason: 'unknown or already-settled lease' };
    delete l.leases[leaseId];

    const inTok = Number(usage?.input_tokens);
    const outTok = Number(usage?.output_tokens);
    const usable = Number.isInteger(inTok) && inTok >= 0 && Number.isInteger(outTok) && outTok >= 0;
    if (!usable) {
      save(path, l);
      return { ok: true, settledAs: 'reservation-held', tokens: lease.tokens, usd: lease.usd };
    }

    const actualUsd = usdForTokens(inTok, outTok);
    const day = dayBucket(l, lease.day), month = monthBucket(l, lease.month);
    // Replace the estimate with the measured amount, never below zero.
    day.tokens = Math.max(0, day.tokens - lease.tokens + inTok + outTok);
    day.usd = Math.max(0, day.usd - lease.usd + actualUsd);
    month.usd = Math.max(0, month.usd - lease.usd + actualUsd);
    save(path, l);
    return { ok: true, settledAs: 'actual', tokens: inTok + outTok, usd: actualUsd, inputTokens: inTok, outputTokens: outTok };
  });
}

export function snapshot({ path = ledgerPath(), now = new Date() } = {}) {
  const l = load(path);
  const day = l.days[dayKey(now)] ?? { attempts: 0, tokens: 0, usd: 0 };
  const month = l.months[monthKey(now)] ?? { usd: 0 };
  return {
    path,
    shared: Boolean(process.env.JEV_LEDGER_PATH),
    day: { ...day, caps: { attempts: BUDGET.dailyAttempts, tokens: BUDGET.dailyReservedTokens, usd: BUDGET.dailyUsd } },
    month: { ...month, caps: { usd: BUDGET.monthlyUsd } },
    inFlight: Object.keys(l.leases).length,
    maxConcurrent: BUDGET.maxConcurrent,
  };
}

export const _internals = { dayKey, monthKey, join };
