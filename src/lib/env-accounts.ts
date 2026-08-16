import { createHash, timingSafeEqual } from 'crypto';
import type { UserRole } from './auth';

/**
 * Accounts configured through environment variables rather than the
 * `staff_users` table.
 *
 * Two accounts live here:
 *   • the admin  (ADMIN_USERNAME / ADMIN_PASSWORD)
 *   • the shared part-timer (PARTTIMER_USERNAME / PARTTIMER_PASSWORD)
 *
 * Keeping the part-timer here rather than in `staff_users` is deliberate.
 * /api/auth/token only falls back to env credentials when `staff_users` holds
 * no active rows, so seeding a part-timer row into that table would flip the
 * table to non-empty and lock the env-var admin out of their own gym. Env
 * accounts stay independent of whatever the table contains.
 */
export interface EnvAccount {
  username: string;
  password: string;
  role: UserRole;
}

/** Constant-time string compare that does not leak length via early return. */
export function secretEquals(a: string, b: string): boolean {
  // Hashing first gives both sides a fixed 32-byte width, so timingSafeEqual
  // never throws on mismatched lengths.
  return timingSafeEqual(
    createHash('sha256').update(a).digest(),
    createHash('sha256').update(b).digest(),
  );
}

/**
 * Read a credential from the environment.
 *
 * The `process.env` half is not redundant. Vite replaces `import.meta.env.X`
 * with a literal at BUILD time, so a variable that was unset when the bundle
 * was built compiles to `undefined` — and the optimiser then folds the whole
 * account away to `return null`. The account does not merely have blank
 * credentials, it ceases to exist, and every login attempt is rejected however
 * correctly it is typed.
 *
 * That is exactly what happens when an env var is added in the hosting
 * dashboard after the last deploy. Falling back to `process.env` reads the
 * value at request time instead, so setting it takes effect without a rebuild.
 * Same pattern as getSigningSecret() in leaderboard-sig.ts.
 */
export function envValue(buildTime: string | undefined, name: string): string {
  return buildTime ?? process.env[name] ?? '';
}

/** The env-var admin, or null when ADMIN_USERNAME/ADMIN_PASSWORD are unset. */
export function envAdmin(): EnvAccount | null {
  const username = envValue(import.meta.env.ADMIN_USERNAME, 'ADMIN_USERNAME');
  const password = envValue(import.meta.env.ADMIN_PASSWORD, 'ADMIN_PASSWORD');
  return username && password ? { username, password, role: 'admin' } : null;
}

/** The shared part-timer account, or null when its env vars are unset. */
export function envPartTimer(): EnvAccount | null {
  const username = envValue(import.meta.env.PARTTIMER_USERNAME, 'PARTTIMER_USERNAME');
  const password = envValue(import.meta.env.PARTTIMER_PASSWORD, 'PARTTIMER_PASSWORD');
  return username && password ? { username, password, role: 'staff' } : null;
}

/** Every configured env account. Unset accounts are simply absent. */
export function envAccounts(): EnvAccount[] {
  return [envAdmin(), envPartTimer()].filter((a): a is EnvAccount => a !== null);
}

/**
 * Match a username/password pair against the env accounts.
 * Returns the matching account, or null. Always compares against every
 * configured account so a wrong username costs the same time as a wrong
 * password.
 */
export function matchEnvAccount(username: string, password: string): EnvAccount | null {
  let matched: EnvAccount | null = null;
  for (const account of envAccounts()) {
    const userOk = secretEquals(username, account.username);
    const passOk = secretEquals(password, account.password);
    if (userOk && passOk) matched = account;
  }
  return matched;
}

/** True if `username` names a configured env account (password not checked). */
export function isEnvAccountName(username: string): boolean {
  return envAccounts().some((a) => secretEquals(username, a.username));
}
