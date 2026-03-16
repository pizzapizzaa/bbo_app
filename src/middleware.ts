import { defineMiddleware } from 'astro/middleware';
import { verifyToken } from './lib/auth';

export const onRequest = defineMiddleware((context, next) => {
  const { pathname } = new URL(context.request.url);

  // Protect all /api/* routes except the login token endpoint
  if (pathname.startsWith('/api/') && pathname !== '/api/auth/token') {
    const header = context.request.headers.get('Authorization') ?? '';
    const token  = header.startsWith('Bearer ') ? header.slice(7).trim() : null;

    if (!token || !verifyToken(token)) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  return next();
});
