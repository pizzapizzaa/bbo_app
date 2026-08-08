/**
 * Detached HMAC signatures for staff-signed leaderboard submissions.
 *
 * A submission is sealed at the moment staff signs off on it. The signature
 * covers every fact that makes the submission what it is — who sent what, on
 * which wall, witnessed by whom, and a hash of their handwritten signature —
 * so any later edit to the stored row (through the API, through the Supabase
 * dashboard, through a stolen service key) is detectable by re-deriving it.
 *
 * What this does NOT do: prove the person who drew the signature is really
 * staff. Nothing authenticates the sign-off. The seal makes the record
 * tamper-evident, not the sign-off trustworthy.
 */

import { createHash, createHmac, timingSafeEqual } from 'crypto';

/** Bump when the canonical format changes; stored per row so old rows still verify. */
export const SIG_VERSION = 1;

/** Max length of the signature data URL. ~100 KB is far more than a scribble needs. */
export const MAX_SIGNATURE_CHARS = 100 * 1024;

// ── Secret ────────────────────────────────────────────────────────────────────
/**
 * Deliberately NOT SESSION_SECRET. Session signing should be rotatable at any
 * time; rotating it must never invalidate a season of send records.
 */
function getSigningSecret(): string {
  const secret =
    import.meta.env.LEADERBOARD_SIGNING_SECRET ?? process.env.LEADERBOARD_SIGNING_SECRET;
  if (!secret) {
    throw new Error(
      'LEADERBOARD_SIGNING_SECRET environment variable is required. ' +
      'Set it in .env (local) and in Vercel Environment Variables (production).'
    );
  }
  return secret;
}

// ── Canonical form ────────────────────────────────────────────────────────────
export interface SubmissionFacts {
  submissionId: string;
  customerId:   string;
  wall:         string;
  /** grade → count, e.g. { V3: 2, V5: 1 }. Zero/negative counts are ignored. */
  grades:       Record<string, number>;
  sendsCount:   number;
  points:       number;
  staffName:    string;
  /** ISO-8601 timestamp string. */
  signedAt:     string;
  /** Hex SHA-256 of the signature image data URL. */
  imageSha256:  string;
}

/**
 * Serialise the facts into the exact string that gets signed.
 *
 * Newline-delimited: no legitimate field (UUIDs, W1–W6, V0–V8, integers, ISO
 * timestamps, hex digests, roster names) can contain a newline, so there is no
 * way to shift a boundary and make one set of facts serialise like another.
 * The guard below enforces that rather than assuming it.
 */
export function canonicalize(f: SubmissionFacts): string {
  const grades = Object.keys(f.grades)
    .filter((g) => Number(f.grades[g]) > 0)
    .sort()
    .map((g) => `${g}:${Math.floor(Number(f.grades[g]))}`)
    .join(',');

  const fields = [
    `BBO-LB-v${SIG_VERSION}`,
    f.submissionId,
    f.customerId,
    f.wall,
    grades,
    String(f.sendsCount),
    String(f.points),
    f.staffName,
    f.signedAt,
    f.imageSha256,
  ];

  for (const field of fields) {
    if (typeof field !== 'string' || field.includes('\n')) {
      throw new Error('Refusing to sign: a submission field is missing or contains a newline.');
    }
  }

  return fields.join('\n');
}

// ── Sign / verify ─────────────────────────────────────────────────────────────
/** Hex SHA-256 of the signature image data URL — this is what the seal covers. */
export function hashSignatureImage(dataUrl: string): string {
  return createHash('sha256').update(dataUrl).digest('hex');
}

/** Produce the base64url HMAC-SHA256 seal for a submission. */
export function signSubmission(f: SubmissionFacts): string {
  return createHmac('sha256', getSigningSecret()).update(canonicalize(f)).digest('base64url');
}

/** Re-derive the seal and compare it in constant time. */
export function verifySubmission(f: SubmissionFacts, signature: unknown): boolean {
  if (typeof signature !== 'string' || !signature) return false;
  try {
    const expected = Buffer.from(signSubmission(f), 'base64url');
    const actual   = Buffer.from(signature,         'base64url');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

// ── Signature image validation ────────────────────────────────────────────────
const PNG_DATA_URL = /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/;
/** First 8 bytes of any PNG file. */
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Validate a client-supplied signature image.
 *
 * This lands on a public, unauthenticated endpoint, so the shape and size caps
 * matter: without them the field is an open door for writing arbitrary
 * multi-megabyte blobs into the database.
 *
 * Returns the trimmed data URL, or null if it is not an acceptable PNG.
 */
export function validateSignatureImage(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (!s || s.length > MAX_SIGNATURE_CHARS) return null;
  if (!PNG_DATA_URL.test(s)) return null;

  // Confirm the base64 really decodes to a PNG rather than arbitrary bytes
  // wearing a PNG data-URL prefix.
  try {
    const bytes = Buffer.from(s.slice('data:image/png;base64,'.length), 'base64');
    if (bytes.length < PNG_MAGIC.length) return null;
    if (!bytes.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) return null;
  } catch {
    return null;
  }

  return s;
}
