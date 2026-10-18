import { NextResponse } from 'next/server';

/**
 * Gate pages on the presence of the session cookie. This checks presence
 * only — real JWT verification happens at the API on every request.
 */
export function middleware(req) {
  const token = req.cookies.get('tt_session')?.value;
  const { pathname } = req.nextUrl;

  if (!token && pathname !== '/login') {
    return NextResponse.redirect(new URL('/login', req.url));
  }
  if (token && pathname === '/login') {
    return NextResponse.redirect(new URL('/', req.url));
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico).*)'],
};
