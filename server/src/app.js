import express from 'express';
import { proxyRouter } from './routes/proxy.js';
import { auditRouter } from './routes/audit.js';
import { authRouter } from './routes/auth.js';
import { keysRouter } from './routes/keys.js';
import { statsRouter } from './routes/stats.js';
import { billingRouter } from './routes/billing.js';

export function loadConfig(env = process.env) {
  const jwtSecret = env.JWT_SECRET || '';
  if (!jwtSecret && env.NODE_ENV === 'production') {
    throw new Error('JWT_SECRET must be set in production');
  }
  if (!jwtSecret) {
    console.warn(
      'WARNING: JWT_SECRET is not set — using an insecure dev default. Set JWT_SECRET for anything real.'
    );
  }
  return {
    port: Number(env.PORT || 4000),
    nodeEnv: env.NODE_ENV || 'development',
    jwtSecret: jwtSecret || 'dev-only-insecure-secret',
    // 'true' → canned response with usage block; 'no-usage' → canned response without one.
    mockUpstream: env.MOCK_UPSTREAM || false,
    upstreamBaseUrl: (env.UPSTREAM_BASE_URL || '').replace(/\/$/, ''),
    upstreamApiKey: env.UPSTREAM_API_KEY || '',
  };
}

export function createApp({ pool, config }) {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  // Trust the platform proxy (Render) so req.ip is the real client IP for login throttling.
  app.set('trust proxy', 1);

  app.get('/health', (req, res) => res.json({ ok: true, service: 'tokentrace-api' }));

  app.use(proxyRouter({ pool, config }));
  app.use(authRouter({ pool, config }));
  app.use(keysRouter({ pool, config }));
  app.use(auditRouter({ pool, config }));
  app.use(statsRouter({ pool, config }));
  app.use(billingRouter({ pool, config }));

  app.use((req, res) => res.status(404).json({ error: { message: 'Not found' } }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err?.type === 'entity.parse.failed') {
      return res.status(400).json({ error: { message: 'Invalid JSON body' } });
    }
    res.status(500).json({ error: { message: 'Internal server error' } });
  });

  return app;
}
