import { describe, it, expect } from 'vitest';
import { redactText, redactValue, PLACEHOLDERS } from '../src/lib/redact.js';

describe('redactText', () => {
  it('redacts email addresses', () => {
    const out = redactText('Contact jane.doe@example.com for access');
    expect(out).toBe(`Contact ${PLACEHOLDERS.email} for access`);
    expect(out).not.toContain('jane.doe@example.com');
  });

  it('redacts international phone numbers but leaves short numbers alone', () => {
    expect(redactText('Call +1-555-123-4567 now')).toContain(PLACEHOLDERS.phone);
    expect(redactText('Call +91 98765 43210 now')).toContain(PLACEHOLDERS.phone);
    expect(redactText('Call (020) 7946 0958 now')).toContain(PLACEHOLDERS.phone);
    // years, versions, short ids must survive
    expect(redactText('Released in 2026, version 1.2.3')).toBe('Released in 2026, version 1.2.3');
    expect(redactText('Ticket #12345 is open')).toBe('Ticket #12345 is open');
  });

  it('redacts sk- style secrets and bearer tokens', () => {
    const out = redactText('key is sk-abcdefghijklmnop1234567890 done');
    expect(out).toContain(PLACEHOLDERS.secret);
    expect(out).not.toContain('sk-abcdefghijklmnop1234567890');

    const out2 = redactText('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig');
    expect(out2).toContain(PLACEHOLDERS.secret);
    expect(out2).not.toContain('eyJhbGciOiJIUzI1NiJ9');
  });

  it('redacts api_key assignments but keeps the key name', () => {
    const out = redactText('config: {"api_key": "abcdef1234567890"} end');
    expect(out).toContain(`"api_key": "${PLACEHOLDERS.secret}"`);
    expect(out).not.toContain('abcdef1234567890');

    const out2 = redactText('api_key=supersecretvalue99;');
    expect(out2).toContain(`api_key=${PLACEHOLDERS.secret}`);
  });

  it('does not mangle ordinary prose', () => {
    const text = 'Hello, how are you? Please summarize this document for me.';
    expect(redactText(text)).toBe(text);
  });

  it('handles non-string input gracefully', () => {
    expect(redactText(null)).toBe(null);
    expect(redactText(undefined)).toBe(undefined);
    expect(redactText(42)).toBe(42);
  });
});

describe('redactValue', () => {
  it('recursively redacts strings inside objects and arrays', () => {
    const input = {
      model: 'mock-model',
      messages: [
        { role: 'user', content: 'My email is jane@example.com' },
        { role: 'assistant', content: 'Hello!' },
      ],
      nested: { deep: ['call +1-555-000-1111', 42, null] },
    };
    const out = redactValue(input);
    expect(out.messages[0].content).toContain(PLACEHOLDERS.email);
    expect(out.messages[1].content).toBe('Hello!');
    expect(out.nested.deep[0]).toContain(PLACEHOLDERS.phone);
    expect(out.nested.deep[1]).toBe(42);
    // input not mutated
    expect(input.messages[0].content).toContain('jane@example.com');
  });
});
