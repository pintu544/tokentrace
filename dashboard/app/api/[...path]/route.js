import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

/**
 * Catch-all proxy: browser → Next.js → TokenTrace API.
 *
 * The session JWT lives in the first-party httpOnly cookie `tt_session`;
 * this handler forwards it as `Authorization: Bearer` so the browser never
 * needs CORS or direct API access. Login/logout are special-cased to
 * set/clear the cookie; the raw token is stripped from login responses.
 */
const API_URL = process.env.API_URL || 'http://localhost:4000';

async function forward(req, path) {
  const token = cookies().get('tt_session')?.value;
  const url = new URL(req.url);
  const target = `${API_URL}/api/${path.join('/')}${url.search}`;

  const headers = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  let body;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    headers['Content-Type'] = 'application/json';
    const text = await req.text();
    body = text || undefined;
  }

  let upstream;
  try {
    upstream = await fetch(target, { method: req.method, headers, body });
  } catch {
    return NextResponse.json(
      { error: { message: 'API unreachable — is the TokenTrace server running?' } },
      { status: 502 }
    );
  }

  const text = await upstream.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { error: { message: 'Bad gateway response' } };
  }

  const out = NextResponse.json(data, { status: upstream.status });

  if (path[0] === 'auth' && path[1] === 'login' && upstream.ok && data.token) {
    out.cookies.set('tt_session', data.token, {
      httpOnly: true,
      path: '/',
      maxAge: 86400,
      sameSite: 'lax',
    });
    delete data.token;
    return NextResponse.json(data, { status: upstream.status, headers: out.headers });
  }
  if (path[0] === 'auth' && path[1] === 'logout') {
    out.cookies.set('tt_session', '', { httpOnly: true, path: '/', maxAge: 0, sameSite: 'lax' });
  }
  return out;
}

export async function GET(req, ctx) {
  return forward(req, ctx.params.path);
}
export async function POST(req, ctx) {
  return forward(req, ctx.params.path);
}
export async function PATCH(req, ctx) {
  return forward(req, ctx.params.path);
}
export async function DELETE(req, ctx) {
  return forward(req, ctx.params.path);
}
