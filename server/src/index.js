import 'dotenv/config';
import { createPool, migrate } from './db.js';
import { createApp, loadConfig } from './app.js';

const config = loadConfig();
const pool = createPool();
await migrate(pool);

const app = createApp({ pool, config });
app.listen(config.port, () => {
  console.log(
    `TokenTrace API listening on :${config.port} (mock upstream: ${config.mockUpstream || 'off'})`
  );
});
