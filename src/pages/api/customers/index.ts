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
const DISPLAY_HEADERS = ['Full Name', 'DOB', 'Email', 'Telephone no', 'Emergency contact', 'Note', 'Waiver form (old)'];

/** GET /api/customers — return all customers */
export const GET: APIRoute = async () => {
  try {
  const { data, error } = await db
    .from('customers')
    .select('id, full_name, dob, email, telephone, emergency_contact, note, waiver_form')
    .order('full_name');

  if (error) return serverError(error.message);

  // Map DB rows back to the original CSV-style header names for the frontend
  const rows = (data ?? []).map((r: any) => ({
    _id:               r.id,
    'Full Name':        r.full_name,
    'DOB':              r.dob,
    'Email':            r.email,
    'Telephone no':     r.telephone,
    'Emergency contact':r.emergency_contact,
    'Note':             r.note,
    'Waiver form (old)':r.waiver_form,
  }));

  return ok({ headers: DISPLAY_HEADERS, rows });
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
      full_name:         r['Full Name']         ?? '',
      dob:               r['DOB']               ?? '',
      email:             r['Email']             ?? '',
      telephone:         r['Telephone no']      ?? '',
      emergency_contact: r['Emergency contact'] ?? '',
      note:              r['Note']              ?? '',
      waiver_form:       r['Waiver form (old)'] ?? '',
    })
    .select('id, full_name, dob, email, telephone, emergency_contact, note, waiver_form')
    .single();

  if (error) return serverError(error.message);

  const newRow = {
    _id:                data.id,
    'Full Name':        data.full_name,
    'DOB':              data.dob,
    'Email':            data.email,
    'Telephone no':     data.telephone,
    'Emergency contact':data.emergency_contact,
    'Note':             data.note,
    'Waiver form (old)':data.waiver_form,
  };

  return ok({ row: newRow });
  } catch (e: any) { return serverError(e?.message ?? String(e)); }
};
