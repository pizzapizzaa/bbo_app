import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let _client: SupabaseClient | null = null;

function getClient(): SupabaseClient {
  if (!_client) {
    const url = import.meta.env.SUPABASE_URL;
    const key = import.meta.env.SUPABASE_SERVICE_KEY;
    if (!url || !key) {
      throw new Error(
        'Missing SUPABASE_URL or SUPABASE_SERVICE_KEY environment variables. ' +
        'Add them to .env (local) and Vercel Environment Variables (production).'
      );
    }
    // Service-role client — used only in server-side API routes.
    // This key bypasses RLS; never expose it to the browser.
    _client = createClient(url, key, { auth: { persistSession: false } });
  }
  return _client;
}

// Lazy proxy — client is only created on first request, not at module load time.
// This ensures missing env vars return a proper JSON error instead of crashing silently.
export const db: SupabaseClient = new Proxy({} as SupabaseClient, {
  get(_, prop: string | symbol) {
    return (getClient() as any)[prop];
  },
});
