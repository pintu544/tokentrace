/**
 * Security middleware: response headers + CORS. Dependency-free on purpose —
 * a handful of headers doesn't justify pulling in helmet for this codebase.
 *
 * CSP is deliberately NOT set: this API serves no HTML (JSON only), and the
 * dashboard is a separate Next.js app with its own headers. Adding a CSP here
 * would be security theater.
 */

export function securityHeaders() {
  return (req, res, next) => {
    // Browsers ignore HSTS on plain HTTP; harmless to always send.
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  };
}

/**
 * CORS locked to an explicit allowlist (CORS_ORIGIN, comma-separated).
 * Default deny: a non-matching Origin gets no ACAO header, so the browser
 * blocks the response. Preflight from a non-allowlisted origin gets an
 * explicit 403.
 *
 * In the reference deployment the dashboard talks to the API server-side via
 * Next.js route handlers, so browsers normally never call this API directly
 * and the allowlist stays empty.
 */
export function corsGuard({ allowedOrigins = [] } = {}) {
  return (req, res, next) => {
    const origin = req.get('origin');
    if (origin && allowedOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader(
        'Access-Control-Allow-Headers',
        'Content-Type, Authorization, x-api-key'
      );
      res.setHeader(
        'Access-Control-Allow-Methods',
        'GET, POST, PUT, PATCH, DELETE, OPTIONS'
      );
      res.setHeader('Access-Control-Max-Age', '86400');
      if (req.method === 'OPTIONS') return res.status(204).end();
    } else if (req.method === 'OPTIONS' && origin) {
      return res.status(403).json({ error: { message: 'CORS origin not allowed' } });
    }
    next();
  };
}
