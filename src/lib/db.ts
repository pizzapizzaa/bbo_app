import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.SUPABASE_URL;
const key = import.meta.env.SUPABASE_SERVICE_KEY;

if (!url || !key) {
  throw new Error(
    'Missing SUPABASE_URL or SUPABASE_SERVICE_KEY environment variables.\n' +
    'Add them to .env (local) and Vercel Environment Variables (production).'
  );
}

// Service-role client — used only in server-side API routes.
// This key bypasses RLS; never expose it to the browser.
export const db = createClient(url, key, {
  auth: { persistSession: false },
});
