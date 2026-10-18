'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) {
      setError(data.error?.message || 'Login failed');
      return;
    }
    router.push('/');
    router.refresh();
  }

  return (
    <div className="min-h-[70vh] flex items-center justify-center">
      <form onSubmit={submit} className="card w-full max-w-sm space-y-4">
        <div>
          <h1 className="text-xl font-bold text-white">
            Token<span className="text-sky-400">Trace</span>
          </h1>
          <p className="text-sm text-dim mt-1">Sign in to your dashboard</p>
        </div>
        {error && (
          <p className="text-sm text-red-400 bg-red-950/50 border border-red-900 rounded-lg px-3 py-2">
            {error}
          </p>
        )}
        <div>
          <label className="label" htmlFor="email">Email</label>
          <input
            id="email"
            className="input"
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </div>
        <div>
          <label className="label" htmlFor="password">Password</label>
          <input
            id="password"
            className="input"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>
        <button className="btn w-full" disabled={busy} type="submit">
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
