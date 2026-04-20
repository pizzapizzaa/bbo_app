export const prerender = false;

import type { APIRoute } from 'astro';
import { db } from '../../../lib/db';
import { ok, serverError } from '../../../lib/auth';
import { fetchAllPages } from '../../../lib/paginate';

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
const DISPLAY_HEADERS = ['Full Name', 'DOB', 'Email', 'Telephone no', 'Emergency contact', 'Note', 'Waiver form (old)', 'Punches', 'PT Punches', 'Membership', 'Member Until'];

/** GET /api/customers — return all customers */
export const GET: APIRoute = async () => {
  try {
  // Try with punch card columns first; fall back if they don't exist yet (pre-migration)
  let data: any[] | null = null;
  let hasPunchCols = true;

  const res = await fetchAllPages((from, to) =>
    db.from('customers')
      .select('id, full_name, dob, email, telephone, emergency_contact, note, waiver_form, is_punch_card_holder, punches_remaining, pt_punches_remaining, membership_type, membership_start_date, membership_end_date')
      .order('full_name')
      .range(from, to)
  );

  if (res.error) {
    // Column doesn't exist yet — retry without punch card columns
    if (res.error.code === '42703' || res.error.message?.includes('is_punch_card_holder') || res.error.message?.includes('punches_remaining') || res.error.message?.includes('pt_punches_remaining') || res.error.message?.includes('membership_type')) {
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
    'PT Punches':           hasPunchCols ? (r.pt_punches_remaining ?? 0) : 0,
    _is_punch_card_holder:  hasPunchCols ? (r.is_punch_card_holder ?? false) : false,
    _punches_remaining:     hasPunchCols ? (r.punches_remaining ?? 0) : 0,
    _pt_punches_remaining:  hasPunchCols ? (r.pt_punches_remaining ?? 0) : 0,
    'Membership':           hasPunchCols ? (r.membership_type ?? '') : '',
    'Member Until':         hasPunchCols ? (r.membership_end_date ?? '') : '',
    _membership_type:       hasPunchCols ? (r.membership_type ?? '') : '',
    _membership_start_date: hasPunchCols ? (r.membership_start_date ?? '') : '',
    _membership_end_date:   hasPunchCols ? (r.membership_end_date ?? '') : '',
  }));

  return ok({ headers: DISPLAY_HEADERS, rows, total, _punchColsMissing: !hasPunchCols });
  } catch (e: any) { return serverError(e?.message ?? String(e)); }
};

/** POST /api/customers — merge CSV into existing records (additive, no deletes) */
export const POST: APIRoute = async ({ request }) => {
  try {
  let body: { rows: Record<string, string>[] };
  try { body = await request.json(); }
  catch { return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 }); }

  const csvRows = body.rows ?? [];
  if (!csvRows.length) return ok({ added: 0, skipped: 0 });

  // Fetch all existing emails and names so we can deduplicate.
  const existing = await fetchAllPages((from, to) =>
    db.from('customers').select('email, full_name').range(from, to)
  );
  if (existing.error) return serverError(existing.error.message);

  const existingEmails = new Set(
    (existing.data ?? [])
      .map((r: any) => (r.email ?? '').trim().toLowerCase())
      .filter(Boolean)
  );
  const existingNames = new Set(
    (existing.data ?? [])
      .map((r: any) => (r.full_name ?? '').trim().toLowerCase())
      .filter(Boolean)
  );

  // Keep only rows not already in the DB (match by email, fall back to name).
  const newRows = csvRows.filter((r) => {
    const email = (r['Email'] ?? '').trim().toLowerCase();
    const name  = (r['Full Name'] ?? '').trim().toLowerCase();
    if (email && email !== 'na' && email !== 'n/a') return !existingEmails.has(email);
    return name ? !existingNames.has(name) : false;
  });

  const skipped = csvRows.length - newRows.length;

  // Insert genuinely new records in batches of 500.
  const BATCH = 500;
  for (let i = 0; i < newRows.length; i += BATCH) {
    const batch = newRows.slice(i, i + BATCH).map((r) => ({
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

  return ok({ added: newRows.length, skipped });
  } catch (e: any) { return serverError(e?.message ?? String(e)); }
};

/** DELETE /api/customers — wipe all customer records.
 *  Requires body: { "confirm": "DELETE ALL CUSTOMERS" } to prevent accidental wipes. */
export const DELETE: APIRoute = async ({ request }) => {
  try {
  let body: { confirm?: string } = {};
  try { body = await request.json(); } catch { /* body is optional */ }
  if (body.confirm !== 'DELETE ALL CUSTOMERS') {
    return new Response(
      JSON.stringify({ error: 'Confirmation required. Send { "confirm": "DELETE ALL CUSTOMERS" }.' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }
  const { error } = await db
    .from('customers')
    .delete()
    .not('id', 'is', null);
  if (error) return serverError(error.message);
  return ok({ cleared: true });
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
