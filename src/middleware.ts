import { defineMiddleware } from 'astro/middleware';
import { verifyToken } from './lib/auth';

export const onRequest = defineMiddleware(async (context, next) => {
  const { pathname } = new URL(context.request.url);

  // Protect all /api/* routes except login, refresh, and designated public endpoints
  if (pathname.startsWith('/api/') &&
      pathname !== '/api/auth/token' &&
      pathname !== '/api/auth/refresh') {
    // Public: self-service kiosk routes (check-in & registration)
    if (pathname.startsWith('/api/public/')) {
      return next();
    }
    // Public: anyone may read the events schedule
    if (pathname === '/api/events' && context.request.method === 'GET') {
      return next();
    }

    const header = context.request.headers.get('Authorization') ?? '';
    const token  = header.startsWith('Bearer ') ? header.slice(7).trim() : null;

    if (!token || !await verifyToken(token)) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  return next();
});
