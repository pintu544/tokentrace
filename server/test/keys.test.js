import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { testContext, seedUser } from './helpers.js';
import {
  generateKey,
  hashKey,
  createApiKey,
  verifyApiKey,
  revokeApiKey,
  KEY_PREFIX_LABEL,
} from '../src/lib/keys.js';

describe('api keys', () => {
  let ctx;
  beforeEach(async () => {
    ctx = await testContext();
  });
  afterEach(async () => {
    await ctx.pool.end();
  });

  it('generates a tt_live_ prefixed key with hash + display prefix', () => {
    const { key, keyHash, keyPrefix } = generateKey();
    expect(key.startsWith(KEY_PREFIX_LABEL)).toBe(true);
    expect(key.length).toBe(KEY_PREFIX_LABEL.length + 43);
    expect(keyHash).toBe(hashKey(key));
    expect(keyPrefix).toBe(key.slice(0, KEY_PREFIX_LABEL.length + 8));
    expect(/^[A-Za-z0-9]+$/.test(key.slice(KEY_PREFIX_LABEL.length))).toBe(true);
  });

  it('generates unique keys', () => {
    const a = generateKey().key;
    const b = generateKey().key;
    expect(a).not.toBe(b);
  });

  it('issues, verifies, and revokes a key; plaintext is never stored', async () => {
    const user = await seedUser(ctx.pool);
    const issued = await createApiKey(ctx.pool, { name: 'customer-acme', userId: user.id });
    expect(issued.key.startsWith(KEY_PREFIX_LABEL)).toBe(true); // shown once

    const found = await verifyApiKey(ctx.pool, issued.key);
    expect(found?.name).toBe('customer-acme');
    expect(found?.user_id).toBe(user.id);

    const { rows } = await ctx.pool.query('SELECT key_hash FROM api_keys');
    expect(rows[0].key_hash).toBe(hashKey(issued.key));
    expect(rows[0].key_hash).not.toBe(issued.key);

    expect(await revokeApiKey(ctx.pool, found.id)).toBe(true);
    expect(await verifyApiKey(ctx.pool, issued.key)).toBeNull();
    // revoking twice is a no-op
    expect(await revokeApiKey(ctx.pool, found.id)).toBe(false);
  });

  it('rejects unknown, malformed, and empty keys', async () => {
    expect(await verifyApiKey(ctx.pool, `${KEY_PREFIX_LABEL}${'x'.repeat(43)}`)).toBeNull();
    expect(await verifyApiKey(ctx.pool, 'garbage')).toBeNull();
    expect(await verifyApiKey(ctx.pool, '')).toBeNull();
    expect(await verifyApiKey(ctx.pool, undefined)).toBeNull();
    expect(await verifyApiKey(ctx.pool, null)).toBeNull();
  });
});
