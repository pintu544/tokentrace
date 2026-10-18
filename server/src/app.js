import express from 'express';
import { proxyRouter } from './routes/proxy.js';

export function loadConfig(env = process.env) {
  return {
    port: Number(env.PORT || 4000),
    // 'true' → canned response with usage block; 'no-usage' → canned response without one.
    mockUpstream: env.MOCK_UPSTREAM || false,
    upstreamBaseUrl: (env.UPSTREAM_BASE_URL || '').replace(/\/$/, ''),
    upstreamApiKey: env.UPSTREAM_API_KEY || '',
  };
}

export function createApp({ pool, config }) {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  app.get('/health', (req, res) => res.json({ ok: true, service: 'tokentrace-api' }));

  app.use(proxyRouter({ pool, config }));

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
