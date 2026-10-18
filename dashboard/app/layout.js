import './globals.css';
import Link from 'next/link';
import { getSession } from '@/lib/api';
import { LogoutButton } from './logout-button';

export const metadata = {
  title: 'TokenTrace — meter, audit, and bill every AI API call',
  description: 'TokenTrace dashboard',
};

function Nav({ user }) {
  if (!user) return null;
  const links = [
    ['/', 'Overview'],
    ['/keys', 'API Keys'],
    ['/audit', 'Audit Log'],
    ['/billing', 'Billing'],
  ];
  return (
    <header className="border-b border-line bg-panel">
      <div className="max-w-6xl mx-auto px-5 h-14 flex items-center gap-6">
        <Link href="/" className="font-bold text-white tracking-tight">
          Token<span className="text-sky-400">Trace</span>
        </Link>
        <nav className="flex gap-1 text-sm">
          {links.map(([href, label]) => (
            <Link key={href} href={href} className="px-3 py-1.5 rounded-lg hover:bg-line text-slate-300">
              {label}
            </Link>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-3">
          <span className="text-xs text-dim hidden sm:block">{user.email}</span>
          <span className={`badge ${user.role === 'admin' ? 'badge-admin' : 'badge-viewer'}`}>
            {user.role}
          </span>
          <LogoutButton />
        </div>
      </div>
    </header>
  );
}

export default async function RootLayout({ children }) {
  const user = await getSession().catch(() => null);
  return (
    <html lang="en">
      <body>
        <Nav user={user} />
        <main className="max-w-6xl mx-auto px-5 py-8">{children}</main>
      </body>
    </html>
  );
}
