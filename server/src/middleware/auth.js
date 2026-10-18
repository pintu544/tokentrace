import { verifyToken, bearerToken } from '../lib/auth.js';

export const SESSION_COOKIE = 'tt_session';

/** Minimal cookie parser — avoids a dependency for one header. */
export function parseCookies(headerValue) {
  const out = {};
  if (!headerValue || typeof headerValue !== 'string') return out;
  for (const part of headerValue.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (name) out[name] = decodeURIComponent(value);
  }
  return out;
}

function tokenFromRequest(req) {
  const fromHeader = bearerToken(req.get('authorization'));
  if (fromHeader) return fromHeader;
  return parseCookies(req.get('cookie'))[SESSION_COOKIE] || null;
}

/**
 * Require a valid dashboard JWT (httpOnly cookie `tt_session` or
 * Authorization: Bearer). Sets req.user = { id, email, role }.
 * 401 when missing, malformed, badly signed, or expired.
 */
export function requireAuth({ jwtSecret }) {
  return (req, res, next) => {
    const token = tokenFromRequest(req);
    if (!token) {
      return res.status(401).json({ error: { message: 'Authentication required' } });
    }
    try {
      const payload = verifyToken(jwtSecret, token);
      req.user = { id: payload.sub, email: payload.email, role: payload.role };
      return next();
    } catch (err) {
      const message =
        err.reason === 'expired' ? 'Session expired — please log in again' : 'Invalid session';
      return res.status(401).json({ error: { message } });
    }
  };
}

/**
 * RBAC gate. Usage: router.use(requireRole('admin')).
 * Viewer is read-only: only 'admin' passes an 'admin' gate.
 */
export function requireRole(role) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: { message: 'Authentication required' } });
    }
    if (role === 'admin' && req.user.role !== 'admin') {
      return res
        .status(403)
        .json({ error: { message: 'Admin role required', type: 'forbidden' } });
    }
    return next();
  };
}
