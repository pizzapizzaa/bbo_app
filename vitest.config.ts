import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/__tests__/**/*.test.ts'],
  },
  define: {
    // Inject test values for import.meta.env reads used in auth.ts
    'import.meta.env.SESSION_SECRET':       JSON.stringify('vitest-test-secret-minimum-32-chars!!'),
    'import.meta.env.SUPABASE_URL':         JSON.stringify('https://test.supabase.co'),
    'import.meta.env.SUPABASE_SERVICE_KEY': JSON.stringify('test-service-key'),
    'import.meta.env.ADMIN_USERNAME':       JSON.stringify('admin'),
    'import.meta.env.ADMIN_PASSWORD':       JSON.stringify('test-password'),
    'import.meta.env.PARTTIMER_USERNAME':   JSON.stringify('parttimer'),
    'import.meta.env.PARTTIMER_PASSWORD':   JSON.stringify('test-pt-password'),
    'import.meta.env.LEADERBOARD_SIGNING_SECRET': JSON.stringify('vitest-leaderboard-secret-32-chars!!'),
  },
});
