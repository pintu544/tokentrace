import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const TOKEN_TTL_SECONDS = 24 * 60 * 60; // 24h

function base64urlEncode(buf) {
  return Buffer.from(buf).toString('base64url');
}

function base64urlDecode(str) {
  return Buffer.from(str, 'base64url');
}

function sign(data, secret) {
  return createHmac('sha256', secret).update(data).digest('base64url');
}

/**
 * Issue a JWT (HS256) for a dashboard user.
 * Payload: { sub, email, role, iat, exp }. 24h expiry.
 */
export function issueToken(secret, user, ttlSeconds = TOKEN_TTL_SECONDS) {
  if (!secret) throw new Error('JWT secret is not configured');
  const now = Math.floor(Date.now() / 1000);
  const header = base64urlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64urlEncode(
    JSON.stringify({
      sub: user.id,
      email: user.email,
      role: user.role,
      iat: now,
      exp: now + ttlSeconds,
    })
  );
  const signature = sign(`${header}.${payload}`, secret);
  return `${header}.${payload}.${signature}`;
}

/**
 * Verify a JWT. Returns the payload, or throws with a `reason`
 * ('malformed' | 'bad_signature' | 'expired' | 'bad_algorithm').
 */
export function verifyToken(secret, token) {
  if (!secret) throw new Error('JWT secret is not configured');
  if (!token || typeof token !== 'string') {
    const err = new Error('Malformed token');
    err.reason = 'malformed';
    throw err;
  }
  const parts = token.split('.');
  if (parts.length !== 3) {
    const err = new Error('Malformed token');
    err.reason = 'malformed';
    throw err;
  }
  const [headerB64, payloadB64, signature] = parts;
  let header;
  try {
    header = JSON.parse(base64urlDecode(headerB64).toString('utf8'));
  } catch {
    const err = new Error('Malformed token');
    err.reason = 'malformed';
    throw err;
  }
  if (header.alg !== 'HS256') {
    const err = new Error('Unsupported algorithm');
    err.reason = 'bad_algorithm';
    throw err;
  }
  const expected = sign(`${headerB64}.${payloadB64}`, secret);
  const a = Buffer.from(signature, 'base64url');
  const b = Buffer.from(expected, 'base64url');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    const err = new Error('Bad signature');
    err.reason = 'bad_signature';
    throw err;
  }
  let payload;
  try {
    payload = JSON.parse(base64urlDecode(payloadB64).toString('utf8'));
  } catch {
    const err = new Error('Malformed token');
    err.reason = 'malformed';
    throw err;
  }
  if (typeof payload.exp !== 'number' || payload.exp <= Math.floor(Date.now() / 1000)) {
    const err = new Error('Token expired');
    err.reason = 'expired';
    throw err;
  }
  return payload;
}

/** Hash a password in the `scrypt$salt$hash` format used by seed.js. */
export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

/** Verify a password against a `scrypt$salt$hash` stored hash. Timing-safe. */
export function verifyPassword(password, stored) {
  if (!password || !stored || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, expectedHex] = parts;
  let derived;
  try {
    derived = scryptSync(password, salt, 64);
  } catch {
    return false;
  }
  const expected = Buffer.from(expectedHex, 'hex');
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

/** Extract a bearer token from an Authorization header value. */
export function bearerToken(headerValue) {
  if (!headerValue || typeof headerValue !== 'string') return null;
  const m = headerValue.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}
