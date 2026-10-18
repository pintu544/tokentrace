/** Rough token estimate used when the upstream response has no usage block. */
export function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

function messagesText(messages) {
  return (messages || [])
    .map((m) => {
      if (typeof m.content === 'string') return m.content;
      if (Array.isArray(m.content)) return m.content.map((p) => p.text || '').join('');
      return '';
    })
    .join('\n');
}

function completionText(choices) {
  return (choices || [])
    .map((c) => (typeof c.message?.content === 'string' ? c.message.content : ''))
    .join('\n');
}

/**
 * Resolve token counts for a proxied call. Prefers the upstream `usage` block;
 * falls back to estimation. Returns { prompt_tokens, completion_tokens, total_tokens, estimated }.
 */
export function countUsage({ requestBody, responseBody }) {
  const usage = responseBody?.usage;
  if (
    usage &&
    Number.isInteger(usage.prompt_tokens) &&
    Number.isInteger(usage.completion_tokens)
  ) {
    return {
      prompt_tokens: usage.prompt_tokens,
      completion_tokens: usage.completion_tokens,
      total_tokens: usage.total_tokens ?? usage.prompt_tokens + usage.completion_tokens,
      estimated: false,
    };
  }
  const prompt_tokens = estimateTokens(messagesText(requestBody?.messages));
  const completion_tokens = estimateTokens(completionText(responseBody?.choices));
  return {
    prompt_tokens,
    completion_tokens,
    total_tokens: prompt_tokens + completion_tokens,
    estimated: true,
  };
}
