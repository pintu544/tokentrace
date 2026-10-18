import { cookies } from 'next/headers';

const API_URL = process.env.API_URL || 'http://localhost:4000';

/** Server-side fetch to the TokenTrace API with the session JWT. */
export async function apiFetch(path, { method = 'GET', body } = {}) {
  const token = cookies().get('tt_session')?.value;
  const res = await fetch(`${API_URL}/api/${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

export async function getSession() {
  const { status, data } = await apiFetch('auth/me');
  return status === 200 ? data.user : null;
}

export function fmt(n) {
  return new Intl.NumberFormat('en-US').format(Number(n) || 0);
}

export function fmtDate(iso) {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
