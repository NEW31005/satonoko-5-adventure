// Secret / PII / private-conversation exclusion.
//
// Policy: a line that matches any rule is DROPPED from anything that could leave
// the machine, and counted. We never "mask and send" outbound -- masking is only
// used for what is printed back into the agent transcript.

const RULES = [
  ['private-key-block', /-----BEGIN[A-Z ]*PRIVATE KEY-----/],
  ['anthropic-key', /\bsk-ant-[A-Za-z0-9_\-]{8,}/],
  ['openai-key', /\bsk-(?:proj-)?[A-Za-z0-9]{20,}/],
  ['github-token', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/],
  ['aws-access-key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['google-key', /\bAIza[0-9A-Za-z_\-]{30,}\b/],
  ['slack-token', /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/],
  ['jwt', /\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\b/],
  ['bearer', /\b[Bb]earer\s+[A-Za-z0-9._\-]{16,}/],
  // No leading \b: a word boundary does not exist after an underscore, so
  // `TYPESAFE_API_KEY=...` would slip through. Allow any word-char prefix/suffix.
  ['secret-assignment', /[A-Za-z0-9_.-]*(?:api[_-]?key|apikey|secret|token|password|passwd|credential|private[_-]?key|client[_-]?secret|auth[_-]?(?:token|secret|key))[A-Za-z0-9_.-]*\s*[:=]\s*['"]?[^\s'"]{8,}/i],
  ['dpapi-blob', /\bAQAAANCMnd8BFdER[A-Za-z0-9+/=]{16,}/],
  ['email', /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/],
  ['credit-card', /\b(?:\d[ \-]?){13,19}\b/],
  ['jp-phone', /\b0\d{1,4}[-\s]?\d{1,4}[-\s]?\d{3,4}\b/],
  ['long-digit-id', /\b\d{12,}\b/],
];

/** Does this text contain anything we refuse to transmit? */
export function findSecrets(text) {
  const hits = [];
  for (const [name, re] of RULES) if (re.test(text)) hits.push(name);
  return hits;
}

export const isClean = (text) => findSecrets(text).length === 0;

/**
 * Rules that indicate an ACTUAL credential value, not merely the word "secret".
 *
 * Blocking outbound data should be paranoid: `findSecrets` deliberately matches
 * `secret:` used as an object key. Risk-tiering a diff must be precise instead,
 * or every file that names a variable `clientSecret` is scored high and real
 * findings get buried. Use this for judgement, `findSecrets` for transmission.
 */
const STRONG = new Set(['private-key-block', 'anthropic-key', 'openai-key', 'github-token',
  'aws-access-key', 'google-key', 'slack-token', 'jwt', 'bearer', 'dpapi-blob']);

export const findStrongSecrets = (text) => findSecrets(text).filter((r) => STRONG.has(r));

/**
 * Drop every offending line. Returns the surviving text plus an audit trail so the
 * caller can report "N lines withheld" instead of silently losing evidence.
 */
export function scrubLines(text) {
  const lines = String(text).split('\n');
  const kept = [];
  const dropped = [];
  for (let i = 0; i < lines.length; i++) {
    const hits = findSecrets(lines[i]);
    if (hits.length) dropped.push({ line: i + 1, rules: hits });
    else kept.push(lines[i]);
  }
  return { text: kept.join('\n'), droppedCount: dropped.length, dropped };
}

/** For transcript display only. Never used to build an outbound payload. */
export function maskForDisplay(text) {
  let out = String(text);
  for (const [, re] of RULES) {
    out = out.replace(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'), '[REDACTED]');
  }
  return out;
}

/**
 * Final gate before any network write. Throws rather than transmitting.
 * Applied to the serialized DTO, so it also catches anything assembled by mistake.
 */
export function assertSendable(payloadJson) {
  const hits = findSecrets(payloadJson);
  if (hits.length) {
    const err = new Error(`outbound payload blocked: matched ${hits.join(', ')}`);
    err.code = 'JEV_SECRET_BLOCKED';
    err.rules = hits;
    throw err;
  }
}
