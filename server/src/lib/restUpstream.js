/**
 * Generic REST upstream passthrough.
 *
 * Unlike lib/upstream.js (OpenAI-compatible chat completions), this forwards
 * ANY method/path/query/body to `${UPSTREAM_BASE_URL}` with the server-side
 * upstream key injected as `Authorization: Bearer`. The client's x-api-key is
 * TokenTrace's own key and is NEVER forwarded; the upstream key never leaves
 * the server.
 *
 * Used for grant APIs like Perfect Corp YouCam, which are task-based REST
 * (POST file upload → POST create task → GET poll status) rather than
 * chat-completions shaped.
 *
 * Mock mode (MOCK_UPSTREAM set) returns a canned echo — tests never touch the
 * network and never burn grant API units. The mock records the last request it
 * "received" (headers the real call would have sent) so tests can assert the
 * Authorization injection without any real key ever being logged.
 */

const UPSTREAM_TIMEOUT_MS = 30_000;

// Hop-by-hop headers (plus client credentials) that must never be forwarded.
const STRIPPED_HEADERS = new Set([
  'host',
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-length', // let fetch recompute it from the body we actually send
  'cookie',
  'x-api-key', // TokenTrace's client key — never forward it upstream
  'authorization', // replaced below with the server-side upstream key
]);

let lastMockRequest = null;

/** What the mock last "received" — test hook only. */
export function getLastMockRequest() {
  return lastMockRequest;
}

function mockResponse({ method, suffix, query }) {
  // Mock-only failure injection for passthrough tests: a suffix starting with
  // __fail500/ simulates a non-2xx upstream without any network.
  if (suffix.startsWith('__fail500/')) {
    return {
      status: 500,
      contentType: 'application/json',
      body: Buffer.from(JSON.stringify({ error: 'mock upstream failure' })),
    };
  }
  return {
    status: 200,
    contentType: 'application/json',
    body: Buffer.from(
      JSON.stringify({
        ok: true,
        echoed_method: method,
        echoed_path: '/' + suffix + (query ? '?' + query : ''),
      })
    ),
  };
}

/**
 * Forward a REST call upstream. Returns { status, contentType, body: Buffer }.
 * Throws err.status === 504 on timeout, or err.status set for other failures.
 */
export async function callRestUpstream({
  method,
  suffix,
  query,
  headers,
  body,
  contentType,
  config,
}) {
  const authHeader = `Bearer ${config.upstreamApiKey}`;

  if (config.mockUpstream) {
    lastMockRequest = {
      method,
      suffix,
      query,
      authorization: authHeader,
      contentType,
      bodyBytes: body ? body.length : 0,
    };
    return mockResponse({ method, suffix, query });
  }

  if (!config.upstreamBaseUrl) {
    const err = new Error('UPSTREAM_BASE_URL is not set and MOCK_UPSTREAM is off');
    err.status = 500;
    throw err;
  }

  const url = `${config.upstreamBaseUrl}/${suffix}${query ? '?' + query : ''}`;
  const fwdHeaders = {};
  for (const [name, value] of Object.entries(headers || {})) {
    if (!STRIPPED_HEADERS.has(name.toLowerCase())) fwdHeaders[name] = value;
  }
  fwdHeaders['authorization'] = authHeader;
  if (contentType) fwdHeaders['content-type'] = contentType;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: fwdHeaders,
      body: body && body.length ? body : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      const timeout = new Error('Upstream request timed out');
      timeout.status = 504;
      throw timeout;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  return {
    status: res.status,
    contentType: res.headers.get('content-type') || 'application/octet-stream',
    body: Buffer.from(await res.arrayBuffer()),
  };
}
