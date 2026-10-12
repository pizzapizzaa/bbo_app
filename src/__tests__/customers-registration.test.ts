import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeBuilder } from './_utils';

const mockFrom = vi.hoisted(() => vi.fn());
vi.mock('../lib/db', () => ({ db: { from: mockFrom } }));
vi.mock('../lib/auth', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/auth')>(),
  adminOnly: vi.fn(async () => null),
}));
import { POST as register } from '../pages/api/public/register';
import { GET as getCustomers, PUT as addCustomer, POST as importCustomers } from '../pages/api/customers/index';

beforeEach(() => mockFrom.mockReset());

describe('customer registration metadata', () => {
  it('marks self-registration on the server, ignoring a supplied source', async () => {
    const inserted = vi.fn(() => makeBuilder({ data: null, error: null }));
    mockFrom.mockImplementation(() => ({ ...makeBuilder({ data: null, error: null }), insert: inserted }));
    const response = await register({ request: new Request('http://localhost/api/public/register', {
      method: 'POST', body: JSON.stringify({ full_name: 'New Climber', waiver_agreed: true, registration_source: 'staff' }),
    }) } as any);
    expect(response.status).toBe(201);
    expect(inserted).toHaveBeenCalledWith(expect.objectContaining({ registration_source: 'self' }));
  });

  it('returns creation timestamps and sources without adding visible table columns', async () => {
    mockFrom.mockImplementation((table: string) => makeBuilder({ data: table === 'customers' ? [
      { id: 'new', full_name: 'New Climber', created_at: '2026-10-12T03:00:00Z', registration_source: 'self' },
      { id: 'old', full_name: 'Existing Climber' },
    ] : [], error: null }));
    const response = await getCustomers({} as any);
    const data = await response.json();
    expect(data.rows[0]).toMatchObject({ _created_at: '2026-10-12T03:00:00Z', _registration_source: 'self' });
    expect(data.rows[1]).toMatchObject({ _created_at: '', _registration_source: 'unknown' });
    expect(data.headers).not.toContain('registration_source');
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  });

  it('tags staff-created customers even if the input claims self-registration', async () => {
    const row = { id: 'staff', full_name: 'Staff Added', created_at: '2026-10-12T03:00:00Z', registration_source: 'staff' };
    const inserted = vi.fn(() => makeBuilder({ data: row, error: null }));
    mockFrom.mockImplementation(() => ({ ...makeBuilder({ data: row, error: null }), insert: inserted }));
    const response = await addCustomer({ request: new Request('http://localhost/api/customers', {
      method: 'PUT', body: JSON.stringify({ row: { 'Full Name': 'Staff Added', registration_source: 'self' } }),
    }) } as any);
    expect(response.status).toBe(200);
    expect(inserted).toHaveBeenCalledWith(expect.objectContaining({ registration_source: 'staff' }));
    expect((await response.json()).row).toMatchObject({ _registration_source: 'staff', _created_at: row.created_at });
  });

  it('tags CSV-imported accounts instead of treating them as self-registered', async () => {
    const inserted = vi.fn(() => makeBuilder({ data: [], error: null }));
    mockFrom.mockImplementation(() => ({ ...makeBuilder({ data: [], error: null }), insert: inserted }));
    const response = await importCustomers({ request: new Request('http://localhost/api/customers', {
      method: 'POST', body: JSON.stringify({ rows: [{ 'Full Name': 'Imported Climber' }] }),
    }) } as any);
    expect(response.status).toBe(200);
    expect(inserted).toHaveBeenCalledWith([expect.objectContaining({ registration_source: 'import' })]);
  });
});