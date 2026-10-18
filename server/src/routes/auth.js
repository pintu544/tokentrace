import { Router } from 'express';
import { issueToken, verifyPassword } from '../lib/auth.js';
import { requireAuth, SESSION_COOKIE } from '../middleware/auth.js';

const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;

/**
 * POST /api/auth/login { email, password }
 * Verifies credentials against users, issues a JWT (24h) in an httpOnly cookie.
 * Light in-memory brute-force throttle: 10 failed attempts per email+IP per 10 min.
 */
export function authRouter({ pool, config }) {
  const router = Router();
  const failures = new Map(); // key -> timestamps[]

  function throttleKey(req, email) {
    return `${req.ip}|${String(email || '').toLowerCase()}`;
  }

  function isThrottled(req, email) {
    const now = Date.now();
    const key = throttleKey(req, email);
    const attempts = (failures.get(key) || []).filter((t) => now - t < LOGIN_WINDOW_MS);
    failures.set(key, attempts);
    return attempts.length >= LOGIN_MAX_ATTEMPTS;
  }

  function recordFailure(req, email) {
    const key = throttleKey(req, email);
    const attempts = failures.get(key) || [];
    attempts.push(Date.now());
    failures.set(key, attempts);
  }

  function setSessionCookie(res, token) {
    const secure = config.nodeEnv === 'production';
    const parts = [
      `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
      'Path=/',
      'HttpOnly',
      'Max-Age=86400',
      'SameSite=Lax',
    ];
    if (secure) parts.push('Secure');
    // Express has no res.cookie without cookie parsing concerns; set raw header.
    res.setHeader('Set-Cookie', parts.join('; '));
  }

  router.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: { message: 'Email and password are required' } });
    }
    if (isThrottled(req, email)) {
      return res
        .status(429)
        .json({ error: { message: 'Too many login attempts — try again later' } });
    }
    const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    const user = rows[0];
    if (!user || !verifyPassword(password, user.password_hash)) {
      recordFailure(req, email);
      return res.status(401).json({ error: { message: 'Invalid email or password' } });
    }
    const token = issueToken(config.jwtSecret, user);
    setSessionCookie(res, token);
    return res.json({
      user: { id: user.id, email: user.email, role: user.role },
      // Token also returned so non-browser clients (and the Next.js proxy) can use it.
      token,
    });
  });

  router.post('/api/auth/logout', (req, res) => {
    res.setHeader(
      'Set-Cookie',
      `${SESSION_COOKIE}=; Path=/; HttpOnly; Max-Age=0; SameSite=Lax`
    );
    return res.json({ ok: true });
  });

  router.get('/api/auth/me', requireAuth({ jwtSecret: config.jwtSecret }), (req, res) => {
    return res.json({ user: req.user });
  });

  return router;
}
