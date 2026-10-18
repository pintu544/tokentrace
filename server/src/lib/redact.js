/**
 * PII redaction (v1, regex-based) for audit logging.
 * Redacts emails, phone numbers, and key-like secrets from text BEFORE it is
 * stored in audit_logs. Applied recursively to string values inside objects/arrays
 * so JSON structure is preserved.
 *
 * Deliberately conservative: patterns must be specific enough not to mangle
 * normal prose. Anything uncertain is left in place — redaction is best-effort
 * for v1, not a compliance guarantee (see README).
 */

export const PLACEHOLDERS = {
  email: '[EMAIL_REDACTED]',
  phone: '[PHONE_REDACTED]',
  secret: '[SECRET_REDACTED]',
};

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

// Candidate phone spans: optional leading +, then digits mixed with common
// separators. Kept only when the digit count is >= 8 (filters out years,
// versions, short IDs). Applied AFTER secrets so key-like tokens are gone.
const PHONE_CANDIDATE_RE = /\+?[\d][\d\s\-().]{6,}[\d]/g;

const SIMPLE_SECRET_RES = [
  // sk- style keys (OpenAI etc.): sk- + 16+ alphanumerics/dashes/underscores
  /sk-[A-Za-z0-9-_]{16,}/g,
  // Bearer tokens in pasted headers / curl snippets
  /Bearer\s+[A-Za-z0-9\-._~+/=]{16,}/gi,
];
// "api_key": "value" / api_key=value / 'api-key': 'value' assignments —
// keeps the key name, redacts only the value.
const API_KEY_ASSIGN_RE = /(["']?api[_-]?key["']?\s*[:=]\s*["']?)([A-Za-z0-9\-._]{12,})(["']?)/gi;

function digitCount(s) {
  const m = s.match(/\d/g);
  return m ? m.length : 0;
}

function redactSecrets(text) {
  let out = text;
  for (const re of SIMPLE_SECRET_RES) out = out.replace(re, PLACEHOLDERS.secret);
  out = out.replace(API_KEY_ASSIGN_RE, `$1${PLACEHOLDERS.secret}$3`);
  return out;
}

function redactPhones(text) {
  return text.replace(PHONE_CANDIDATE_RE, (match) =>
    digitCount(match) >= 8 ? PLACEHOLDERS.phone : match
  );
}

/** Redact PII from a plain string. */
export function redactText(text) {
  if (typeof text !== 'string') return text;
  let out = redactSecrets(text);
  out = out.replace(EMAIL_RE, PLACEHOLDERS.email);
  out = redactPhones(out);
  return out;
}

/** Recursively redact every string value in an object/array. Returns a copy. */
export function redactValue(value) {
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactValue(v);
    return out;
  }
  return value;
}
