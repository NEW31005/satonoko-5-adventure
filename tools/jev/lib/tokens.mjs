// Token accounting.
//
// Three different things are deliberately kept apart, because conflating them
// produces numbers that look like evidence and are not:
//
//   bytes    - MEASURED. Byte length of exactly what would be supplied.
//   tokens   - MEASURED only via the official POST /v1/messages/count_tokens
//              endpoint. Without a usable credential it is an ESTIMATE, and
//              every figure carries `measured: false` plus the method used.
//   quota    - NOT OBSERVABLE from here at all. Account/plan consumption is not
//              returned by any endpoint we can call, so we never report it.
//
// tiktoken and friends are OpenAI tokenizers: they undercount Claude by 15-20%
// on prose and far more on code. They are not used here at any confidence level.

const ENDPOINT = 'https://api.anthropic.com/v1/messages/count_tokens';
const ANTHROPIC_VERSION = '2023-06-01';

/** Bytes are always measurable. */
export const bytesOf = (text) => Buffer.byteLength(String(text ?? ''), 'utf8');

/**
 * Character-class aware fallback. Still an estimate: code, punctuation and
 * non-ASCII tokenize very differently from prose, so we weight them apart
 * rather than dividing the whole string by one constant.
 */
export function estimateTokens(text) {
  const s = String(text ?? '');
  if (!s) return 0;
  let ascii = 0, nonAscii = 0, punct = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c > 0x7f) nonAscii++;
    else if (/[^A-Za-z0-9\s]/.test(ch)) punct++;
    else ascii++;
  }
  // Prose-ish ASCII ~3.6 B/token; punctuation-dense code closer to 2.2;
  // CJK and other non-ASCII commonly land near 1 token per character.
  return Math.ceil(ascii / 3.6 + punct / 2.2 + nonAscii / 1.0);
}

/** Is a credential available for the official endpoint? Presence only. */
export const hasCredential = (env = process.env) =>
  Boolean(String(env.ANTHROPIC_API_KEY ?? '').trim());

/**
 * Official count. Returns { tokens, measured, method, model } — and on any
 * failure returns the estimate with measured:false and the reason, rather than
 * pretending a number was measured.
 */
export async function countTokens(text, {
  model = 'claude-opus-5',
  env = process.env,
  fetchImpl = globalThis.fetch,
  timeoutMs = 15_000,
} = {}) {
  const fallback = (reason) => ({
    tokens: estimateTokens(text),
    measured: false,
    method: 'local estimate (character-class weighted)',
    reason,
    model,
  });

  if (!hasCredential(env)) return fallback('no ANTHROPIC_API_KEY in this environment');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(env.ANTHROPIC_COUNT_TOKENS_URL || ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'anthropic-version': ANTHROPIC_VERSION,
        'x-api-key': String(env.ANTHROPIC_API_KEY),
      },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: String(text) }] }),
      signal: controller.signal,
    });
    const body = await res.text();
    if (!res.ok) return fallback(`count_tokens HTTP ${res.status}`);
    const parsed = JSON.parse(body);
    if (!Number.isInteger(parsed?.input_tokens)) return fallback('count_tokens returned no input_tokens');
    return {
      tokens: parsed.input_tokens,
      measured: true,
      method: 'anthropic POST /v1/messages/count_tokens',
      model,
    };
  } catch (e) {
    return fallback(e?.name === 'AbortError' ? 'count_tokens timed out' : `count_tokens failed: ${e?.message ?? e}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Account one arm of a measurement. `parts` is a labelled map so the report can
 * show that helper JSON, instructions and re-reads were counted, not just body.
 */
export async function accountInput(parts, opts = {}) {
  const entries = Object.entries(parts).filter(([, v]) => v != null && v !== '');
  const perPart = {};
  let totalBytes = 0;
  for (const [name, text] of entries) {
    const b = bytesOf(text);
    perPart[name] = { bytes: b };
    totalBytes += b;
  }
  const joined = entries.map(([, v]) => String(v)).join('\n');
  const count = await countTokens(joined, opts);
  return {
    parts: perPart,
    totalBytes,
    totalTokens: count.tokens,
    tokensMeasured: count.measured,
    tokenMethod: count.method,
    tokenNote: count.reason ?? null,
    quotaNote: 'account/plan quota consumption is not observable from this environment and is not reported',
  };
}
