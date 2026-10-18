/**
 * Call the upstream LLM (OpenAI-compatible chat completions).
 * With MOCK_UPSTREAM set, returns a canned response instead — no API key needed.
 *   MOCK_UPSTREAM=true      → canned response WITH a usage block
 *   MOCK_UPSTREAM=no-usage  → canned response WITHOUT a usage block (exercises estimation)
 */
export async function callUpstream({ body, config }) {
  if (config.mockUpstream) {
    return mockResponse(body, config.mockUpstream);
  }
  if (!config.upstreamBaseUrl) {
    const err = new Error('UPSTREAM_BASE_URL is not set and MOCK_UPSTREAM is off');
    err.status = 500;
    throw err;
  }
  const res = await fetch(`${config.upstreamBaseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.upstreamApiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`Upstream error ${res.status}: ${text.slice(0, 500)}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

function mockResponse(body, mode) {
  const model = body?.model || 'mock-model';
  const content =
    'Mock response: TokenTrace proxy is working. ' +
    `Received ${(body?.messages || []).length} message(s).`;
  const response = {
    id: 'chatcmpl-mock-' + Date.now().toString(36),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      { index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' },
    ],
  };
  if (mode !== 'no-usage') {
    const promptText = (body?.messages || [])
      .map((m) => (typeof m.content === 'string' ? m.content : ''))
      .join('\n');
    const prompt_tokens = Math.max(1, Math.ceil(promptText.length / 4));
    const completion_tokens = Math.ceil(content.length / 4);
    response.usage = {
      prompt_tokens,
      completion_tokens,
      total_tokens: prompt_tokens + completion_tokens,
    };
  }
  return response;
}
