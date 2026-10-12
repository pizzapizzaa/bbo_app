import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { customerGroups, punchDemandError, type Customer } from '../scripts/checkin/multi-checkin';
import { startCustomerRefresh } from '../scripts/customers/refresh';

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

describe('newly registered customer groups', () => {
  const entries: Customer[] = [
    { _id: 'old-self', 'Full Name': 'Alice Yesterday', _registration_source: 'self', _created_at: '2026-10-11T16:59:59Z' },
    { _id: 'self-early', 'Full Name': 'Climber Early', _registration_source: 'self', _created_at: '2026-10-11T17:00:00Z' },
    { _id: 'self-late', 'Full Name': 'Climber Late', _registration_source: 'self', _created_at: '2026-10-12T12:00:00Z' },
    { _id: 'staff', 'Full Name': 'Climber Staff', _registration_source: 'staff', _created_at: '2026-10-12T12:30:00Z' },
    { _id: 'import', 'Full Name': 'Climber Imported', _registration_source: 'import', _created_at: '2026-10-12T12:30:00Z' },
    { _id: 'unknown', 'Full Name': 'Climber Unknown', _created_at: '2026-10-12T12:30:00Z' },
    { _id: 'invalid', 'Full Name': 'Climber Invalid', _registration_source: 'self', _created_at: 'invalid' },
  ];

  it('groups only today\'s self-registered customers, newest first', () => {
    const groups = customerGroups(entries, '', '2026-10-12');
    expect(groups.newlyRegistered.map((customer) => customer._id)).toEqual(['self-late', 'self-early']);
    expect(groups.others).toHaveLength(5);
    expect(new Set([...groups.newlyRegistered, ...groups.others].map((customer) => customer._id)).size).toBe(entries.length);
  });

  it('searches both groups without duplicating a result', () => {
    const groups = customerGroups(entries, 'climber', '2026-10-12');
    expect(groups.newlyRegistered).toHaveLength(2);
    expect(groups.others).toHaveLength(4);
    expect(customerGroups(entries, 'late', '2026-10-12').newlyRegistered[0]._id).toBe('self-late');
  });

  it('moves the group into other customers when the gym day changes', () => {
    expect(customerGroups(entries, '', '2026-10-13').newlyRegistered).toEqual([]);
  });
});

describe('automatic customer refresh', () => {
  let stop: (() => void) | undefined;
  let visibility: EventTarget & { visibilityState: string };
  let browser: EventTarget;
  beforeEach(() => {
    vi.useFakeTimers();
    visibility = Object.assign(new EventTarget(), { visibilityState: 'visible' });
    browser = new EventTarget();
    vi.stubGlobal('document', visibility);
    vi.stubGlobal('window', browser);
  });
  afterEach(() => {
    stop?.();
    stop = undefined;
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('refreshes every 15 seconds but pauses requests while hidden', async () => {
    const fetchCustomers = vi.fn(async () => true);
    stop = startCustomerRefresh(fetchCustomers).stop;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(fetchCustomers).toHaveBeenCalledTimes(1);
    visibility.visibilityState = 'hidden';
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchCustomers).toHaveBeenCalledTimes(1);
    visibility.visibilityState = 'visible';
    visibility.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchCustomers).toHaveBeenCalledTimes(2);
  });

  it('does not overlap focus, dropdown, or timer requests', async () => {
    let resolveRequest: (success: boolean) => void = () => {};
    const fetchCustomers = vi.fn(() => new Promise<boolean>((resolve) => { resolveRequest = resolve; }));
    const refresh = startCustomerRefresh(fetchCustomers);
    stop = refresh.stop;
    browser.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(0);
    void refresh.refreshIfStale();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(fetchCustomers).toHaveBeenCalledTimes(1);
    resolveRequest(true);
    await vi.advanceTimersByTimeAsync(0);
    await refresh.refreshIfStale();
    expect(fetchCustomers).toHaveBeenCalledTimes(1);
  });

  it('does not delay the next scheduled update after a focus refresh', async () => {
    const fetchCustomers = vi.fn(async () => true);
    stop = startCustomerRefresh(fetchCustomers).stop;
    await vi.advanceTimersByTimeAsync(5_000);
    browser.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchCustomers).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchCustomers).toHaveBeenCalledTimes(2);
  });

  it('retries failures automatically and stops when disposed', async () => {
    const fetchCustomers = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(true);
    stop = startCustomerRefresh(fetchCustomers).stop;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchCustomers).toHaveBeenCalledTimes(2);
    stop();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchCustomers).toHaveBeenCalledTimes(2);
  });
});