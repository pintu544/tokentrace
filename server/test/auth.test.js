import { describe, it, expect } from 'vitest';
import {
  issueToken,
  verifyToken,
  hashPassword,
  verifyPassword,
  bearerToken,
} from '../src/lib/auth.js';
import { parseCookies } from '../src/middleware/auth.js';

const SECRET = 'unit-test-secret';

describe('JWT (HS256, node:crypto)', () => {
  it('issues a verifiable token with the user payload', () => {
    const token = issueToken(SECRET, { id: 7, email: 'a@b.c', role: 'viewer' });
    const payload = verifyToken(SECRET, token);
    expect(payload.sub).toBe(7);
    expect(payload.email).toBe('a@b.c');
    expect(payload.role).toBe('viewer');
    expect(payload.exp - payload.iat).toBe(24 * 60 * 60);
  });

  it('rejects an expired token', () => {
    const token = issueToken(SECRET, { id: 1, email: 'a@b.c', role: 'admin' }, -10);
    expect(() => verifyToken(SECRET, token)).toThrowError(/expired/i);
    try {
      verifyToken(SECRET, token);
    } catch (err) {
      expect(err.reason).toBe('expired');
    }
  });

  it('rejects a tampered payload', () => {
    const token = issueToken(SECRET, { id: 1, email: 'a@b.c', role: 'viewer' });
    const [h, p, s] = token.split('.');
    const evil = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, 'base64url').toString()), role: 'admin' })).toString('base64url');
    expect(() => verifyToken(SECRET, `${h}.${evil}.${s}`)).toThrowError(/signature/i);
  });

  it('rejects a token signed with a different secret', () => {
    const token = issueToken('other-secret', { id: 1, email: 'a@b.c', role: 'admin' });
    expect(() => verifyToken(SECRET, token)).toThrowError(/signature/i);
  });

  it('rejects malformed tokens', () => {
    for (const bad of [null, '', 'abc', 'a.b', 'a.b.c.d']) {
      expect(() => verifyToken(SECRET, bad)).toThrow();
    }
  });

  it('rejects a non-HS256 algorithm header', () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ sub: 1, exp: 9999999999 })).toString('base64url');
    expect(() => verifyToken(SECRET, `${header}.${payload}.x`)).toThrowError(/algorithm/i);
  });

  it('throws when no secret is configured', () => {
    expect(() => issueToken('', { id: 1 })).toThrow(/secret/i);
    expect(() => verifyToken('', 'a.b.c')).toThrow(/secret/i);
  });
});

describe('scrypt password hashing', () => {
  it('round-trips: hash then verify', () => {
    const hash = hashPassword('correct horse battery staple');
    expect(hash.startsWith('scrypt$')).toBe(true);
    expect(verifyPassword('correct horse battery staple', hash)).toBe(true);
  });

  it('rejects the wrong password', () => {
    const hash = hashPassword('right');
    expect(verifyPassword('wrong', hash)).toBe(false);
  });

  it('rejects malformed stored hashes without throwing', () => {
    expect(verifyPassword('x', 'not-a-hash')).toBe(false);
    expect(verifyPassword('x', null)).toBe(false);
    expect(verifyPassword('', hashPassword('x'))).toBe(false);
  });
});

describe('header helpers', () => {
  it('parses Bearer tokens', () => {
    expect(bearerToken('Bearer abc123')).toBe('abc123');
    expect(bearerToken('bearer ABC')).toBe('ABC');
    expect(bearerToken('Basic abc')).toBeNull();
    expect(bearerToken(null)).toBeNull();
  });

  it('parses cookies', () => {
    expect(parseCookies('tt_session=tok123; other=x')).toEqual({ tt_session: 'tok123', other: 'x' });
    expect(parseCookies('')).toEqual({});
    expect(parseCookies(null)).toEqual({});
  });
});
