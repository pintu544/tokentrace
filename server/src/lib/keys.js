import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

export const KEY_PREFIX_LABEL = 'tt_live_';
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

function toBase62(bytes) {
  let n = BigInt('0x' + bytes.toString('hex'));
  if (n === 0n) return BASE62[0];
  let out = '';
  while (n > 0n) {
    out = BASE62[Number(n % 62n)] + out;
    n = n / 62n;
  }
  return out;
}

/** Generate a new API key. Returns { key, keyHash, keyPrefix }; `key` is shown once. */
export function generateKey() {
  // 32 bytes ≈ 43 base62 chars; normalize to exactly 43.
  const randomPart = toBase62(randomBytes(32)).padStart(43, '0').slice(-43);
  const key = KEY_PREFIX_LABEL + randomPart;
  return {
    key,
    keyHash: hashKey(key),
    keyPrefix: key.slice(0, KEY_PREFIX_LABEL.length + 8),
  };
}

export function hashKey(key) {
  return createHash('sha256').update(key).digest('hex');
}

/** Issue a key and store only its hash. Returns the row plus the plaintext key (show once). */
export async function createApiKey(
  pool,
  { name, userId, monthlyQuotaTokens = 1_000_000, rateLimitPerMin = 60 }
) {
  const { key, keyHash, keyPrefix } = generateKey();
  const { rows } = await pool.query(
    `INSERT INTO api_keys (key_hash, key_prefix, name, user_id, monthly_quota_tokens, rate_limit_per_min)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, key_prefix, name, user_id, monthly_quota_tokens, rate_limit_per_min, created_at`,
    [keyHash, keyPrefix, name, userId, monthlyQuotaTokens, rateLimitPerMin]
  );
  return { ...rows[0], key };
}

/**
 * Verify a presented key. Returns the key row, or null when unknown/malformed/revoked.
 *
 * Timing safety: we look up candidates by display prefix (tt_live_ + 8 chars,
 * not secret) and compare the sha256 digests with crypto.timingSafeEqual.
 * Comparing via `WHERE key_hash = $1` instead would leak key existence through
 * database timing noise; the secret comparison itself here is constant-time.
 * Prefix collisions are possible (8 chars) so every candidate is compared.
 */
export async function verifyApiKey(pool, key) {
  if (!key || typeof key !== 'string' || !key.startsWith(KEY_PREFIX_LABEL)) return null;
  const keyPrefix = key.slice(0, KEY_PREFIX_LABEL.length + 8);
  const { rows } = await pool.query(
    'SELECT * FROM api_keys WHERE key_prefix = $1 AND revoked_at IS NULL',
    [keyPrefix]
  );
  const presented = Buffer.from(hashKey(key), 'hex');
  for (const row of rows) {
    let stored;
    try {
      stored = Buffer.from(row.key_hash, 'hex');
    } catch {
      continue;
    }
    if (stored.length === presented.length && timingSafeEqual(stored, presented)) {
      return row;
    }
  }
  return null;
}

/** Revoke a key. Returns true when a live key was revoked. */
export async function revokeApiKey(pool, id) {
  const { rows } = await pool.query(
    'UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL RETURNING id',
    [id]
  );
  return rows.length > 0;
}
