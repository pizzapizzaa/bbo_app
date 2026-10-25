import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeBuilder } from './_utils';

const mockFrom = vi.hoisted(() => vi.fn());
vi.mock('../lib/db', () => ({ db: { from: mockFrom } }));
vi.mock('../lib/auth', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/auth')>(),
  adminOnly: vi.fn(async () => null),
}));

import { PATCH } from '../pages/api/customers/[id]';

const customerId = '123e4567-e89b-12d3-a456-426614174000';

beforeEach(() => mockFrom.mockReset());

describe('PATCH /api/customers/:id', () => {
  it('updates all editable profile fields for an admin', async () => {
    const updates = {
      full_name: 'Updated Name',
      dob: '01/02/1990',
      email: 'updated@example.com',
      telephone: '0123456789',
      emergency_contact: 'Emergency Person',
      note: 'Updated note',
      waiver_form: 'Signed',
    };
    const builder = makeBuilder({ data: { id: customerId, ...updates }, error: null });
    mockFrom.mockReturnValue(builder);

    const response = await PATCH({
      params: { id: customerId },
      request: new Request(`http://localhost/api/customers/${customerId}`, {
        method: 'PATCH',
        body: JSON.stringify(updates),
      }),
    } as any);

    expect(response.status).toBe(200);
    expect(builder.update).toHaveBeenCalledWith(updates);
    expect((await response.json()).row).toMatchObject(updates);
  });

  it('rejects a blank customer name without writing to the database', async () => {
    const response = await PATCH({
      params: { id: customerId },
      request: new Request(`http://localhost/api/customers/${customerId}`, {
        method: 'PATCH',
        body: JSON.stringify({ full_name: '  ' }),
      }),
    } as any);

    expect(response.status).toBe(400);
    expect(mockFrom).not.toHaveBeenCalled();
  });
});
