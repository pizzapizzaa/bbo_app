export const prerender = false;

import type { APIRoute } from 'astro';
import { db } from '../../../lib/db';
import { MAX_NAME, MAX_TEXT, escapeLike } from '../../../lib/validate';

/** POST /api/public/register — unauthenticated new customer self-registration */
export const POST: APIRoute = async ({ request }) => {
  let body: {
    full_name: string;
    dob?: string;
    email?: string;
    telephone?: string;
    emergency_contact?: string;
    note?: string;
    waiver_agreed: boolean;
  };
  try { body = await request.json(); }
  catch { return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 }); }

  const full_name = (body.full_name ?? '').trim();

  if (!full_name) {
    return new Response(JSON.stringify({ error: 'Full name is required.' }), { status: 400 });
  }
  if (full_name.length > MAX_NAME) {
    return new Response(JSON.stringify({ error: 'Name too long.' }), { status: 400 });
  }
  // Enforce English/ASCII characters only for the name field
  if (/[^\x00-\x7F]/.test(full_name)) {
    return new Response(
      JSON.stringify({ error: 'Please use English characters only for your name.' }),
      { status: 400 },
    );
  }
  if (!body.waiver_agreed) {
    return new Response(
      JSON.stringify({ error: 'You must read and agree to the waiver before registering.' }),
      { status: 400 },
    );
  }

  const note = (body.note ?? '').trim();
  if (note.length > MAX_TEXT) {
    return new Response(JSON.stringify({ error: 'Note is too long.' }), { status: 400 });
  }

  // Check for duplicate name
  const { data: existing } = await db
    .from('customers')
    .select('id')
    .ilike('full_name', escapeLike(full_name))
    .limit(1)
    .single();

  if (existing) {
    return new Response(
      JSON.stringify({ error: 'A customer with this name already exists. Please ask a staff member for help.' }),
      { status: 409 },
    );
  }

  const { error } = await db.from('customers').insert({
    full_name,
    dob:               (body.dob ?? '').trim(),
    email:             (body.email ?? '').trim().toLowerCase(),
    telephone:         (body.telephone ?? '').trim(),
    emergency_contact: (body.emergency_contact ?? '').trim(),
    note,
    waiver_form:       'Signed (Online)',
  });

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }

  return new Response(
    JSON.stringify({ ok: true }),
    { status: 201, headers: { 'Content-Type': 'application/json' } },
  );
};
