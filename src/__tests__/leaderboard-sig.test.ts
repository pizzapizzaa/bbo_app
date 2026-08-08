import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';
import {
  canonicalize,
  hashSignatureImage,
  signSubmission,
  verifySubmission,
  validateSignatureImage,
  MAX_SIGNATURE_CHARS,
  SIG_VERSION,
  type SubmissionFacts,
} from '../lib/leaderboard-sig';
import { STAFF_NAMES, isKnownStaff } from '../lib/staff';

// ── Fixtures ──────────────────────────────────────────────────────────────────
/** A real 1×1 PNG, so the magic-byte check has something valid to accept. */
const PNG_1PX =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const facts: SubmissionFacts = {
  submissionId: 'aaaaaaaa-0000-0000-0000-000000000001',
  customerId:   'bbbbbbbb-0000-0000-0000-000000000002',
  wall:         'W3',
  grades:       { V3: 2, V5: 1 },
  sendsCount:   3,
  points:       110,
  staffName:    'Danny',
  signedAt:     '2026-08-07T09:15:00.000Z',
  imageSha256:  createHash('sha256').update(PNG_1PX).digest('hex'),
};

/** `facts` with one field changed. */
const mutate = (patch: Partial<SubmissionFacts>): SubmissionFacts => ({ ...facts, ...patch });

// ── canonicalize ──────────────────────────────────────────────────────────────
describe('canonicalize', () => {
  it('starts with the version marker', () =>
    expect(canonicalize(facts).split('\n')[0]).toBe(`BBO-LB-v${SIG_VERSION}`));

  it('sorts grades so key order in the object cannot change the signature', () => {
    const a = canonicalize(mutate({ grades: { V3: 2, V5: 1 } }));
    const b = canonicalize(mutate({ grades: { V5: 1, V3: 2 } }));
    expect(a).toBe(b);
    expect(a).toContain('V3:2,V5:1');
  });

  it('omits zero and negative counts', () =>
    expect(canonicalize(mutate({ grades: { V0: 0, V3: 2, V4: -1 } }))).toContain('\nV3:2\n'));

  it('produces one line per field', () =>
    expect(canonicalize(facts).split('\n')).toHaveLength(10));

  it('refuses to sign a field containing a newline', () =>
    expect(() => canonicalize(mutate({ staffName: 'Danny\nBao Anh' }))).toThrow(/newline/));
});

// ── sign / verify round-trip ──────────────────────────────────────────────────
describe('signSubmission / verifySubmission', () => {
  it('verifies a freshly signed submission', () =>
    expect(verifySubmission(facts, signSubmission(facts))).toBe(true));

  it('is deterministic for identical facts', () =>
    expect(signSubmission(facts)).toBe(signSubmission({ ...facts })));

  it('returns a base64url string with no padding', () =>
    expect(signSubmission(facts)).toMatch(/^[A-Za-z0-9_-]+$/));

  it('rejects a missing or non-string signature', () => {
    expect(verifySubmission(facts, undefined)).toBe(false);
    expect(verifySubmission(facts, '')).toBe(false);
    expect(verifySubmission(facts, 12345 as any)).toBe(false);
  });

  it('rejects a signature of the wrong length', () =>
    expect(verifySubmission(facts, signSubmission(facts).slice(0, -4))).toBe(false));

  it('rejects a signature from a different submission', () =>
    expect(verifySubmission(facts, signSubmission(mutate({ points: 999 })))).toBe(false));
});

// ── Tamper detection, field by field ──────────────────────────────────────────
// Each of these is a row someone could edit in the Supabase dashboard.
describe('tamper detection', () => {
  const signature = signSubmission(facts);

  const tampering: Array<[string, Partial<SubmissionFacts>]> = [
    ['inflating the points',        { points: 500 }],
    ['inflating the send count',    { sendsCount: 30 }],
    ['adding a grade',              { grades: { V3: 2, V5: 1, V8: 4 } }],
    ['bumping a grade count',       { grades: { V3: 9, V5: 1 } }],
    ['moving it to another wall',   { wall: 'W6' }],
    ['reassigning the climber',     { customerId: 'cccccccc-0000-0000-0000-000000000003' }],
    ['renaming the staff witness',  { staffName: 'Huyen' }],
    ['backdating the sign-off',     { signedAt: '2026-01-01T00:00:00.000Z' }],
    ['swapping the signature image',{ imageSha256: createHash('sha256').update('other').digest('hex') }],
    ['reusing another row id',      { submissionId: 'dddddddd-0000-0000-0000-000000000004' }],
  ];

  for (const [label, patch] of tampering) {
    it(`detects ${label}`, () =>
      expect(verifySubmission(mutate(patch), signature)).toBe(false));
  }
});

// ── Signature image validation ────────────────────────────────────────────────
describe('validateSignatureImage', () => {
  it('accepts a well-formed PNG data URL', () =>
    expect(validateSignatureImage(PNG_1PX)).toBe(PNG_1PX));

  it('trims surrounding whitespace', () =>
    expect(validateSignatureImage(`  ${PNG_1PX}  `)).toBe(PNG_1PX));

  it('rejects a non-string', () => {
    expect(validateSignatureImage(null)).toBeNull();
    expect(validateSignatureImage(42)).toBeNull();
    expect(validateSignatureImage({ image: PNG_1PX })).toBeNull();
  });

  it('rejects an empty string', () =>
    expect(validateSignatureImage('')).toBeNull());

  it('rejects a non-PNG mime type', () =>
    expect(validateSignatureImage('data:image/svg+xml;base64,PHN2Zy8+')).toBeNull());

  it('rejects a plain URL', () =>
    expect(validateSignatureImage('https://example.com/sig.png')).toBeNull());

  // The prefix alone must not be enough — the bytes have to be a real PNG.
  it('rejects arbitrary base64 wearing a PNG data-URL prefix', () =>
    expect(validateSignatureImage('data:image/png;base64,QUJDREVGR0g=')).toBeNull());

  it('rejects a blob over the size cap', () => {
    const huge = 'data:image/png;base64,' + 'A'.repeat(MAX_SIGNATURE_CHARS);
    expect(validateSignatureImage(huge)).toBeNull();
  });

  it('rejects base64 containing illegal characters', () =>
    expect(validateSignatureImage('data:image/png;base64,not base64!!')).toBeNull());
});

// ── hashSignatureImage ────────────────────────────────────────────────────────
describe('hashSignatureImage', () => {
  it('returns a 64-character hex digest', () =>
    expect(hashSignatureImage(PNG_1PX)).toMatch(/^[0-9a-f]{64}$/));

  it('changes when a single byte of the image changes', () =>
    expect(hashSignatureImage(PNG_1PX)).not.toBe(hashSignatureImage(PNG_1PX + 'x')));
});

// ── Staff roster ──────────────────────────────────────────────────────────────
describe('isKnownStaff', () => {
  it('accepts every name on the roster', () =>
    STAFF_NAMES.forEach((n) => expect(isKnownStaff(n)).toBe(true)));

  it('ignores surrounding whitespace', () =>
    expect(isKnownStaff('  Danny  ')).toBe(true));

  it('rejects a name that is not on the roster', () =>
    expect(isKnownStaff('Mallory')).toBe(false));

  it('rejects an empty name', () =>
    expect(isKnownStaff('')).toBe(false));

  it('is case-sensitive, so stored names stay consistent', () =>
    expect(isKnownStaff('danny')).toBe(false));
});
