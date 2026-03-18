export const prerender = false;

import type { APIRoute } from 'astro';
import { db } from '../../../lib/db';
import { ok, serverError } from '../../../lib/auth';

// Column map: CSV header → DB column name
const COL_MAP: Record<string, string> = {
  'Full Name':         'full_name',
  'DOB':               'dob',
  'Email':             'email',
  'Telephone no':      'telephone',
  'Emergency contact': 'emergency_contact',
  'Note':              'note',
  'Waiver form (old)': 'waiver_form',
};

// DB column → display header (inverse map)
const DISPLAY_HEADERS = ['Full Name', 'DOB', 'Email', 'Telephone no', 'Emergency contact', 'Note', 'Waiver form (old)', 'Punch Card', 'Punches', 'Membership', 'Member Until'];

const PAGE_SIZE = 1000;

/** Fetch all rows from a Supabase table query, bypassing the default 1000-row cap. */
async function fetchAllPages(selectFn: (from: number, to: number) => PromiseLike<{ data: any[] | null; error: any }>): Promise<{ data: any[]; error: any }> {
  const all: any[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await selectFn(from, from + PAGE_SIZE - 1);
    if (error) return { data: [], error };
    const rows = data ?? [];
    all.push(...rows);
    if (rows.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return { data: all, error: null };
}

/** GET /api/customers — return all customers */
export const GET: APIRoute = async () => {
  try {
  // Try with punch card columns first; fall back if they don't exist yet (pre-migration)
  let data: any[] | null = null;
  let hasPunchCols = true;

  const res = await fetchAllPages((from, to) =>
    db.from('customers')
      .select('id, full_name, dob, email, telephone, emergency_contact, note, waiver_form, is_punch_card_holder, punches_remaining, membership_type, membership_start_date, membership_end_date')
      .order('full_name')
      .range(from, to)
  );

  if (res.error) {
    // Column doesn't exist yet — retry without punch card columns
    if (res.error.code === '42703' || res.error.message?.includes('is_punch_card_holder') || res.error.message?.includes('punches_remaining') || res.error.message?.includes('membership_type')) {
      hasPunchCols = false;
      const fallback = await fetchAllPages((from, to) =>
        db.from('customers')
          .select('id, full_name, dob, email, telephone, emergency_contact, note, waiver_form')
          .order('full_name')
          .range(from, to)
      );
      if (fallback.error) return serverError(fallback.error.message);
      data = fallback.data;
    } else {
      return serverError(res.error.message);
    }
  } else {
    data = res.data;
  }

  const total = data!.length;

  // Map DB rows back to the original CSV-style header names for the frontend
  const rows = data.map((r: any) => ({
    _id:                  r.id,
    'Full Name':          r.full_name,
    'DOB':                r.dob,
    'Email':              r.email,
    'Telephone no':       r.telephone,
    'Emergency contact':  r.emergency_contact,
    'Note':               r.note,
    'Waiver form (old)':  r.waiver_form,
    'Punch Card':           hasPunchCols ? (r.is_punch_card_holder ? 'Yes' : 'No') : 'No',
    'Punches':              hasPunchCols ? (r.punches_remaining ?? 0) : 0,
    _is_punch_card_holder:  hasPunchCols ? (r.is_punch_card_holder ?? false) : false,
    _punches_remaining:     hasPunchCols ? (r.punches_remaining ?? 0) : 0,
    'Membership':           hasPunchCols ? (r.membership_type ?? '') : '',
    'Member Until':         hasPunchCols ? (r.membership_end_date ?? '') : '',
    _membership_type:       hasPunchCols ? (r.membership_type ?? '') : '',
    _membership_start_date: hasPunchCols ? (r.membership_start_date ?? '') : '',
    _membership_end_date:   hasPunchCols ? (r.membership_end_date ?? '') : '',
  }));

  return ok({ headers: DISPLAY_HEADERS, rows, total, _punchColsMissing: !hasPunchCols });
  } catch (e: any) { return serverError(e?.message ?? String(e)); }
};

/** POST /api/customers — bulk import (replaces all existing records) */
export const POST: APIRoute = async ({ request }) => {
  try {
  let body: { rows: Record<string, string>[] };
  try { body = await request.json(); }
  catch { return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 }); }

  const csvRows = body.rows ?? [];

  // Delete all existing customers
  const { error: delErr } = await db
    .from('customers')
    .delete()
    .not('id', 'is', null);

  if (delErr) return serverError(delErr.message);

  // Insert in batches of 500 to stay within Supabase request limits
  const BATCH = 500;
  for (let i = 0; i < csvRows.length; i += BATCH) {
    const batch = csvRows.slice(i, i + BATCH).map((r) => ({
      full_name:         r['Full Name']         ?? '',
      dob:               r['DOB']               ?? '',
      email:             r['Email']             ?? '',
      telephone:         r['Telephone no']      ?? '',
      emergency_contact: r['Emergency contact'] ?? '',
      note:              r['Note']              ?? '',
      waiver_form:       r['Waiver form (old)'] ?? '',
    }));
    const { error } = await db.from('customers').insert(batch);
    if (error) return serverError(error.message);
  }

  return ok({ count: csvRows.length });
  } catch (e: any) { return serverError(e?.message ?? String(e)); }
};

/** PUT /api/customers — insert a single new customer */
export const PUT: APIRoute = async ({ request }) => {
  try {
  let body: { row: Record<string, string> };
  try { body = await request.json(); }
  catch { return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 }); }

  const r = body.row ?? {};

  const { data, error } = await db
    .from('customers')
    .insert({
      full_name:            r['Full Name']         ?? '',
      dob:                  r['DOB']               ?? '',
      email:                r['Email']             ?? '',
      telephone:            r['Telephone no']      ?? '',
      emergency_contact:    r['Emergency contact'] ?? '',
      note:                 r['Note']              ?? '',
      waiver_form:          r['Waiver form (old)'] ?? '',
      is_punch_card_holder:  false,
      punches_remaining:     0,
      membership_type:       '',
      membership_start_date: null,
      membership_end_date:   null,
    })
    .select('id, full_name, dob, email, telephone, emergency_contact, note, waiver_form, is_punch_card_holder, punches_remaining, membership_type, membership_start_date, membership_end_date')
    .single();

  if (error) return serverError(error.message);

  const newRow = {
    _id:                    data.id,
    'Full Name':            data.full_name,
    'DOB':                  data.dob,
    'Email':                data.email,
    'Telephone no':         data.telephone,
    'Emergency contact':    data.emergency_contact,
    'Note':                 data.note,
    'Waiver form (old)':    data.waiver_form,
    'Punch Card':           'No',
    'Punches':              0,
    _is_punch_card_holder:  false,
    _punches_remaining:     0,
    'Membership':           '',
    'Member Until':         '',
    _membership_type:       '',
    _membership_start_date: '',
    _membership_end_date:   '',
  };

  return ok({ row: newRow });
  } catch (e: any) { return serverError(e?.message ?? String(e)); }
};
