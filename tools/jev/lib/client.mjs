// Guarded HTTP client for POST /v1/systemone.
//
// Two authentication modes, chosen by JEV_AUTH_MODE (see config.mjs):
//   direct (default) -- we send `x-api-key`, per the official @typesafe-ai/sdk build.
//   proxy            -- we send NOTHING; a Claude Code cloud-environment API
//                       credential makes the agent proxy add `Authorization:
//                       Bearer <key>` after the request leaves the VM.
// The endpoint is the same fixed official HTTPS URL either way.
//
// Every failure path is explicit:
//   401 / 403 / missing key / budget refused -> zero retries, local fallback
//   429 / 5xx / timeout / connection          -> retry, and EVERY attempt reserves budget
//   crash or unusable usage                   -> the reservation stands, never free

import { CAPS, MODEL_PIN, estimateTokens, resolveMode } from '../config.mjs';
import { assertSendable } from './redact.mjs';
import { reserve, settle } from './budget.mjs';

const NO_RETRY_STATUS = new Set([400, 401, 403, 404, 422]);

class JevRefusal extends Error {
  constructor(reason, code) { super(reason); this.code = code ?? 'JEV_REFUSED'; this.refusal = reason; }
}

/** Reject a question set that is not one of the three documented primitives. */
export function validateQuestions(questions) {
  const names = Object.keys(questions ?? {});
  if (!names.length) throw new JevRefusal('no questions', 'JEV_BAD_QUERY');
  if (names.length > CAPS.maxQuestions) throw new JevRefusal(`too many questions: ${names.length} > ${CAPS.maxQuestions}`, 'JEV_BAD_QUERY');
  for (const n of names) {
    const q = questions[n];
    if (!q || typeof q !== 'object') throw new JevRefusal(`question ${n} is not an object`, 'JEV_BAD_QUERY');
    if (q.type === 'choice') {
      const labels = Object.keys(q.criteria ?? {});
      if (labels.length < 2) throw new JevRefusal(`choice ${n} needs >= 2 labels`, 'JEV_BAD_QUERY');
      if (labels.length > CAPS.maxCandidates) throw new JevRefusal(`choice ${n} has ${labels.length} labels > cap ${CAPS.maxCandidates}`, 'JEV_BAD_QUERY');
    } else if (q.type === 'score') {
      if (!Array.isArray(q.criteria) || q.criteria.length < 2) throw new JevRefusal(`score ${n} needs a rubric of >= 2 levels`, 'JEV_BAD_QUERY');
    } else if (q.type !== 'noul') {
      throw new JevRefusal(`question ${n} has unknown type ${String(q.type)}`, 'JEV_BAD_QUERY');
    }
  }
  return names;
}

const inRange = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;

/**
 * Validate one answer against the question that asked it. Anything unknown,
 * out of range or below the confidence floor is discarded, with a reason.
 */
export function validateAnswer(name, question, answer) {
  if (!answer || typeof answer !== 'object') return { ok: false, reason: 'answer is not an object' };
  if (answer.type !== question.type) return { ok: false, reason: `type mismatch: got ${String(answer.type)}, asked ${question.type}` };

  if (question.type === 'choice') {
    const labels = Object.keys(question.criteria);
    if (!labels.includes(answer.choice)) return { ok: false, reason: `unknown candidate '${String(answer.choice)}' not among the ${labels.length} offered` };
    if (!inRange(answer.confidence)) return { ok: false, reason: 'confidence out of range' };
    const probs = answer.probabilities;
    if (!probs || typeof probs !== 'object') return { ok: false, reason: 'missing probabilities' };
    for (const [k, v] of Object.entries(probs)) {
      if (!labels.includes(k)) return { ok: false, reason: `probability for unknown label '${k}'` };
      if (!inRange(v)) return { ok: false, reason: `probability for '${k}' out of range` };
    }
    const total = Object.values(probs).reduce((a, b) => a + b, 0);
    if (Math.abs(total - 1) > 0.05) return { ok: false, reason: `probabilities sum to ${total.toFixed(3)}` };
    if (answer.confidence < CAPS.minConfidence) return { ok: false, reason: `confidence ${answer.confidence.toFixed(3)} below floor ${CAPS.minConfidence}`, lowConfidence: true };
    return { ok: true, value: answer };
  }

  if (question.type === 'noul') {
    if (!inRange(answer.noul)) return { ok: false, reason: 'noul out of range' };
    return { ok: true, value: answer };
  }

  const levels = question.criteria.length;
  if (typeof answer.score !== 'number' || !Number.isFinite(answer.score) || answer.score < 0 || answer.score > levels - 1)
    return { ok: false, reason: `score outside 0..${levels - 1}` };
  if (!inRange(answer.confidence)) return { ok: false, reason: 'confidence out of range' };
  if (answer.confidence < CAPS.minConfidence) return { ok: false, reason: `confidence ${answer.confidence.toFixed(3)} below floor ${CAPS.minConfidence}`, lowConfidence: true };
  return { ok: true, value: answer };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Send one System One request. Resolves to { ok:true, ... } or { ok:false, reason, fallback:true }.
 * Never throws for an expected refusal: the caller always has a local path.
 */
export async function systemOne({ state, questions, env = process.env, fetchImpl = globalThis.fetch }) {
  const mode = resolveMode(env);
  if (mode.kind === 'off') return { ok: false, reason: `Jev is off: ${mode.reason}`, fallback: true, attempts: 0 };

  let names;
  try { names = validateQuestions(questions); }
  catch (e) { return { ok: false, reason: e.refusal ?? e.message, code: e.code, fallback: true, attempts: 0 }; }

  const payload = { model: MODEL_PIN, state, questions };
  const body = JSON.stringify(payload);

  if (Buffer.byteLength(body) > CAPS.maxRequestBytes)
    return { ok: false, reason: `request ${Buffer.byteLength(body)}B exceeds cap ${CAPS.maxRequestBytes}B`, fallback: true, attempts: 0 };

  // Last gate before the socket. Throws rather than transmitting a secret.
  assertSendable(body);

  const estTokens = estimateTokens(Buffer.byteLength(body));
  const attemptsLog = [];
  let lastReason = 'no attempt made';

  for (let attempt = 0; attempt <= CAPS.maxRetries; attempt++) {
    // Reserve for THIS attempt. A retry costs budget exactly like a first try.
    const lease = reserve({ tokens: estTokens });
    if (!lease.ok) {
      attemptsLog.push({ attempt, outcome: 'budget-refused', reason: lease.reason });
      return { ok: false, reason: `budget refused: ${lease.reason}`, fallback: true, attempts: attemptsLog.length, attemptsLog, retried: false };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CAPS.timeoutMs);
    const startedAt = Date.now();
    let settled = false;

    try {
      const headers = {
        'content-type': 'application/json',
        'user-agent': 'satonoko-jev-preprocess/1 (local guard rails)',
      };
      if (mode.authMode === 'direct') {
        headers['x-api-key'] = String(env.TYPESAFE_API_KEY ?? '');
      }
      // proxy mode: send NO auth header. The cloud environment's API credential
      // is attached by Anthropic's agent proxy once the request has left the VM.
      // Never read TYPESAFE_API_KEY here -- in this mode we are not supposed to
      // have it, and sending one anyway would leak a credential we should not hold.

      const res = await fetchImpl(mode.endpoint, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      });

      const text = await res.text();
      if (text.length > CAPS.maxResponseBytes) {
        settle(lease.leaseId, null); settled = true;
        return { ok: false, reason: `response ${text.length}B exceeds cap ${CAPS.maxResponseBytes}B`, fallback: true, attempts: attemptsLog.length + 1, attemptsLog };
      }

      if (!res.ok) {
        let parsed; try { parsed = JSON.parse(text); } catch { parsed = text.slice(0, 400); }
        settle(lease.leaseId, null); settled = true; // a failed call still consumed its reservation
        attemptsLog.push({ attempt, outcome: 'http-error', status: res.status, ms: Date.now() - startedAt });
        lastReason = `HTTP ${res.status}`;
        if (NO_RETRY_STATUS.has(res.status)) {
          const label = res.status === 401 || res.status === 403 ? 'auth rejected' : `request rejected (${res.status})`;
          return { ok: false, reason: `${label}: ${typeof parsed === 'string' ? parsed : JSON.stringify(parsed).slice(0, 200)}`, status: res.status, fallback: true, retried: false, attempts: attemptsLog.length, attemptsLog };
        }
        if (attempt < CAPS.maxRetries) { await sleep(300 * (attempt + 1)); continue; }
        return { ok: false, reason: `${lastReason} after ${attemptsLog.length} attempt(s)`, status: res.status, fallback: true, attempts: attemptsLog.length, attemptsLog };
      }

      let parsed;
      try { parsed = JSON.parse(text); }
      catch { settle(lease.leaseId, null); settled = true; return { ok: false, reason: 'response was not JSON', fallback: true, attempts: attemptsLog.length + 1, attemptsLog }; }

      // Settle with real usage when it is usable; otherwise hold the reservation.
      const settlement = settle(lease.leaseId, parsed?.usage); settled = true;

      if (parsed?.model !== MODEL_PIN)
        return { ok: false, reason: `model pin mismatch: asked ${MODEL_PIN}, answered ${String(parsed?.model)}`, fallback: true, attempts: attemptsLog.length + 1, attemptsLog, settlement };
      if (!parsed?.answers || typeof parsed.answers !== 'object')
        return { ok: false, reason: 'response has no answers object', fallback: true, attempts: attemptsLog.length + 1, attemptsLog, settlement };

      const accepted = {}, rejected = {};
      for (const n of names) {
        const v = validateAnswer(n, questions[n], parsed.answers[n]);
        if (v.ok) accepted[n] = v.value; else rejected[n] = v.reason;
      }
      attemptsLog.push({ attempt, outcome: 'ok', ms: Date.now() - startedAt });
      return {
        ok: true, accepted, rejected, resolvedModel: parsed.model,
        usage: parsed.usage, settlement, requestBytes: Buffer.byteLength(body), responseBytes: text.length,
        attempts: attemptsLog.length, attemptsLog, mode: mode.kind, authMode: mode.authMode,
      };
    } catch (e) {
      const aborted = e?.name === 'AbortError';
      if (!settled) settle(lease.leaseId, null); // crash path: reservation stands
      attemptsLog.push({ attempt, outcome: aborted ? 'timeout' : 'connection', ms: Date.now() - startedAt });
      lastReason = aborted ? `timed out after ${CAPS.timeoutMs}ms` : `connection failed: ${e?.message ?? e}`;
      if (attempt < CAPS.maxRetries) { await sleep(300 * (attempt + 1)); continue; }
      return { ok: false, reason: `${lastReason} after ${attemptsLog.length} attempt(s)`, fallback: true, attempts: attemptsLog.length, attemptsLog };
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, reason: lastReason, fallback: true, attempts: attemptsLog.length, attemptsLog };
}
