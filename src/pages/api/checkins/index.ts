export const prerender = false;

import type { APIRoute } from 'astro';
import { db } from '../../../lib/db';
import { ok, serverError } from '../../../lib/auth';
import { fetchAllPages } from '../../../lib/paginate';
import { isValidDate, isValidTime, MAX_NAME, MAX_TEXT, escapeLike } from '../../../lib/validate';

/** GET /api/checkins?date=YYYY-MM-DD          — single date
 *  GET /api/checkins?from=YYYY-MM-DD&to=YYYY-MM-DD — inclusive date range */
export const GET: APIRoute = async ({ url }) => {
  const date = url.searchParams.get('date');
  const from = url.searchParams.get('from');
  const to   = url.searchParams.get('to');

  // Validate date params to prevent unexpected query behaviour
  if (date && !isValidDate(date)) {
    return new Response(JSON.stringify({ error: 'Invalid date format' }), { status: 400 });
  }
  if ((from && !isValidDate(from)) || (to && !isValidDate(to))) {
    return new Response(JSON.stringify({ error: 'Invalid from/to date format' }), { status: 400 });
  }

  let query = db
    .from('checkins')
    .select('*')
    .order('date',          { ascending: true })
    .order('checked_in_at', { ascending: true });

  if (date) {
    query = query.eq('date', date);
  } else if (from && to) {
    query = query.gte('date', from).lte('date', to);
  } else {
    return new Response(JSON.stringify({ error: 'Missing date or from/to range' }), { status: 400 });
  }

  const { data, error } = await fetchAllPages((from, to) => (query as any).range(from, to));
  if (error) return serverError(error.message);
  return ok({ checkins: data });
};

/** POST /api/checkins — add a new check-in */
export const POST: APIRoute = async ({ request }) => {
  let body: {
    customer_name: string;
    date: string;
    time: string;
    payment_method: string;
    amount: number;
    notes?: string;
    punch_card_holder_id?: string;
    punch_card_holder_name?: string;
    pt_punch_holder_id?: string;
    pt_punch_holder_name?: string;
    checkin_type?: string;
    addons?: string;
  };
  try { body = await request.json(); }
  catch { return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 }); }

  const { customer_name, date, time, payment_method, amount, notes,
          punch_card_holder_id, punch_card_holder_name,
          pt_punch_holder_id, pt_punch_holder_name,
          checkin_type, addons } = body;
  if (!customer_name || !date || !time || !payment_method) {
    return new Response(JSON.stringify({ error: 'Missing required fields' }), { status: 400 });
  }
  if (String(customer_name).length > MAX_NAME) {
    return new Response(JSON.stringify({ error: 'customer_name too long' }), { status: 400 });
  }
  if (!isValidDate(date)) {
    return new Response(JSON.stringify({ error: 'Invalid date format (expected YYYY-MM-DD)' }), { status: 400 });
  }
  if (!isValidTime(time.slice(0, 5))) {
    return new Response(JSON.stringify({ error: 'Invalid time format (expected HH:MM)' }), { status: 400 });
  }
  if ((notes ?? '').length > MAX_TEXT) {
    return new Response(JSON.stringify({ error: 'notes exceeds maximum length' }), { status: 400 });
  }

  // Validate membership when payment is "Valid Membership"
  if (payment_method === 'Valid Membership') {
    const { data: memberData } = await db
      .from('customers')
      .select('membership_type, membership_end_date')
      .ilike('full_name', escapeLike(customer_name))
      .limit(1)
      .single();

    if (!memberData || !memberData.membership_type) {
      return new Response(JSON.stringify({ error: 'Customer has no active membership.' }), { status: 400 });
    }
    if (!memberData.membership_end_date || memberData.membership_end_date < date) {
      return new Response(JSON.stringify({ error: 'Membership has expired.' }), { status: 400 });
    }
  }

  const { data, error } = await db
    .from('checkins')
    .insert({
      customer_name,
      date,
      time,
      payment_method,
      amount: amount ?? 0,
      notes: notes ?? '',
      punch_card_holder_id:   punch_card_holder_id   || null,
      punch_card_holder_name: punch_card_holder_name || '',
      pt_punch_holder_id:     pt_punch_holder_id     || null,
      pt_punch_holder_name:   pt_punch_holder_name   || '',
      checkin_type: checkin_type ?? '',
      addons:       addons       ?? '',
    })
    .select()
    .single();

  if (error) return serverError(error.message);

  // Auto-create a customer record if this name doesn't exist yet
  const { data: existing } = await db
    .from('customers')
    .select('id')
    .ilike('full_name', escapeLike(customer_name))
    .limit(1)
    .maybeSingle();

  if (!existing) {
    await db.from('customers').insert({ full_name: customer_name });
  }

  // ── Punch card purchase: add punches to the buyer's account ──
  const PUNCH_ADDS: Record<string, number> = {
    '10 Punches – Adult':   10,
    '10 Punches – Student': 10,
    '10 Punches – Kid':     10,
    '20 Punches – Adult':   20,
  };

  // ── PT punch purchase: add PT punches to the buyer's account ──
  const PT_PUNCH_ADDS: Record<string, number> = {
    '10 PT Punches – Shingo PT': 10,
    '10 PT Punches – Other PT':  10,
  };
  const MEMBERSHIP_TYPE_MAP: Record<string, string> = {
    'Membership – 1 Month':   '1 Month',
    'Membership – 3 Months':  '3 Months',
    'Membership – 6 Months':  '6 Months',
    'Membership – 12 Months': '12 Months',
  };
  const MONTHS_TO_ADD: Record<string, number> = {
    '1 Month': 1, '3 Months': 3, '6 Months': 6, '12 Months': 12,
  };

  const punchesToAdd  = checkin_type ? (PUNCH_ADDS[checkin_type] ?? 0) : 0;
  const ptPunchesToAdd = checkin_type ? (PT_PUNCH_ADDS[checkin_type] ?? 0) : 0;
  const newMemberType = checkin_type ? (MEMBERSHIP_TYPE_MAP[checkin_type] ?? '') : '';

  if (punchesToAdd > 0 || ptPunchesToAdd > 0 || newMemberType) {
    const { data: cust } = await db
      .from('customers')
      .select('id, punches_remaining, pt_punches_remaining, membership_end_date')
      .ilike('full_name', escapeLike(customer_name))
      .limit(1)
      .maybeSingle();

    if (cust) {
      if (punchesToAdd > 0) {
        await db.from('customers').update({
          is_punch_card_holder: true,
          punches_remaining: (cust.punches_remaining ?? 0) + punchesToAdd,
        }).eq('id', cust.id);
      }

      if (ptPunchesToAdd > 0) {
        await db.from('customers').update({
          pt_punches_remaining: (cust.pt_punches_remaining ?? 0) + ptPunchesToAdd,
        }).eq('id', cust.id);
      }

      if (newMemberType) {
        const checkinDay  = new Date(date);
        const existingEnd = cust.membership_end_date ? new Date(cust.membership_end_date) : null;
        // Stack onto existing membership if still active, otherwise start from check-in date
        const startDate   = (existingEnd && existingEnd > checkinDay) ? existingEnd : checkinDay;
        const endDate     = new Date(startDate);
        endDate.setMonth(endDate.getMonth() + MONTHS_TO_ADD[newMemberType]);
        await db.from('customers').update({
          membership_type:       newMemberType,
          membership_start_date: startDate.toISOString().slice(0, 10),
          membership_end_date:   endDate.toISOString().slice(0, 10),
        }).eq('id', cust.id);
      }
    }
  }

  // Deduct one punch from the punch card holder
  if (punch_card_holder_id) {
    const { data: holder } = await db
      .from('customers')
      .select('punches_remaining')
      .eq('id', punch_card_holder_id)
      .single();

    if (holder && holder.punches_remaining > 0) {
      await db
        .from('customers')
        .update({ punches_remaining: holder.punches_remaining - 1 })
        .eq('id', punch_card_holder_id);
    }
  }

  // Deduct one PT punch from the PT punch holder
  if (pt_punch_holder_id) {
    const { data: ptHolder } = await db
      .from('customers')
      .select('pt_punches_remaining')
      .eq('id', pt_punch_holder_id)
      .single();

    if (ptHolder && ptHolder.pt_punches_remaining > 0) {
      await db
        .from('customers')
        .update({ pt_punches_remaining: ptHolder.pt_punches_remaining - 1 })
        .eq('id', pt_punch_holder_id);
    }
  }

  return ok({ checkin: data });
};
