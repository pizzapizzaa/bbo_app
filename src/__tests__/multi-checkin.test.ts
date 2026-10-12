import { describe, expect, it } from 'vitest';
import { punchDemandError, type Customer } from '../scripts/checkin/multi-checkin';

const customers: Customer[] = [
  { _id: 'holder-1', 'Full Name': 'Alice', _punches_remaining: 2, _pt_punches_remaining: 1 },
  { _id: 'holder-2', 'Full Name': 'Bob', _punches_remaining: 1 },
];

describe('multi-customer punch demand', () => {
  it('allows several customers to use an adequately funded holder', () => {
    expect(punchDemandError([{ punch_card_holder_id: 'holder-1' }, { punch_card_holder_id: 'holder-1' }], customers)).toBeNull();
  });

  it('rejects combined demand exceeding a shared holder balance', () => {
    expect(punchDemandError(Array.from({ length: 3 }, () => ({ punch_card_holder_id: 'holder-1' })), customers)).toContain('need 3');
  });

  it('tracks PT punches separately from regular punches', () => {
    expect(punchDemandError([{ punch_card_holder_id: 'holder-1' }, { pt_punch_holder_id: 'holder-1' }], customers)).toBeNull();
    expect(punchDemandError([{ pt_punch_holder_id: 'holder-1' }, { pt_punch_holder_id: 'holder-1' }], customers)).toContain('PT punches');
  });

  it('counts different holders independently and rejects missing holders', () => {
    expect(punchDemandError([{ punch_card_holder_id: 'holder-1' }, { punch_card_holder_id: 'holder-2' }], customers)).toBeNull();
    expect(punchDemandError([{ punch_card_holder_id: 'missing' }], customers)).not.toBeNull();
  });
});