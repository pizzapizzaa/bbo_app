export const prerender = false;

import type { APIRoute } from 'astro';
import { db } from '../../../lib/db';
import { MAX_NAME, escapeLike } from '../../../lib/validate';

/** POST /api/public/checkin — unauthenticated self-check-in kiosk endpoint */
export const POST: APIRoute = async ({ request }) => {
  let body: { full_name: string; date?: string; time?: string };
  try { body = await request.json(); }
  catch { return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 }); }

  const name = (body.full_name ?? '').trim();
  if (!name) {
    return new Response(JSON.stringify({ error: 'Full name is required.' }), { status: 400 });
  }
  if (name.length > MAX_NAME) {
    return new Response(JSON.stringify({ error: 'Name too long.' }), { status: 400 });
  }
  // Enforce English/ASCII characters only
  if (/[^\x00-\x7F]/.test(name)) {
    return new Response(JSON.stringify({ error: 'Please use English characters only.' }), { status: 400 });
  }

  // Look up the customer (case-insensitive exact-name match)
  const { data: customer } = await db
    .from('customers')
    .select('id, full_name, membership_type, membership_end_date, is_punch_card_holder, punches_remaining')
    .ilike('full_name', escapeLike(name))
    .limit(1)
    .single();

  if (!customer) {
    return new Response(
      JSON.stringify({ error: 'Name not found. Please register first or ask a staff member for help.' }),
      { status: 404 },
    );
  }

  // Use client-supplied date/time (browser is physically at the gym, correct TZ).
  // Fall back to server UTC only if not provided.
  const today = (body.date && /^\d{4}-\d{2}-\d{2}$/.test(body.date))
    ? body.date
    : new Date().toISOString().slice(0, 10);
  const time  = (body.time && /^\d{2}:\d{2}(:\d{2})?$/.test(body.time))
    ? (body.time.length === 5 ? body.time + ':00' : body.time)
    : new Date().toTimeString().slice(0, 8);

  // Prevent duplicate check-ins on the same day
  const { count } = await db
    .from('checkins')
    .select('id', { count: 'exact', head: true })
    .eq('date', today)
    .ilike('customer_name', escapeLike(customer.full_name));

  if ((count ?? 0) > 0) {
    return new Response(
      JSON.stringify({ error: 'You have already checked in today. See staff if this is wrong.' }),
      { status: 409 },
    );
  }

  // Determine payment method automatically
  let payment_method = 'Self Check-in';
  if (customer.membership_type && customer.membership_end_date >= today) {
    payment_method = 'Valid Membership';
  }

  const { error } = await db.from('checkins').insert({
    customer_name:  customer.full_name,
    date:           today,
    time,
    payment_method,
    amount:         0,
    notes:          '',
  });

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }

  return new Response(
    JSON.stringify({ ok: true, name: customer.full_name, payment_method }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
};
