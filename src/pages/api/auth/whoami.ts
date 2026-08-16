export const prerender = false;

import type { APIRoute } from 'astro';
import { adminOnly, ok } from '../../../lib/auth';
import { envAdmin, envPartTimer, isEnvAccountName } from '../../../lib/env-accounts';
import { db } from '../../../lib/db';

/**
 * GET /api/auth/whoami?username=parttimer — why is a login being rejected?
 *
 * Admin-only, and deliberately reports only the shape of the configuration,
 * never a secret: whether each account exists, whether its credentials reached
 * this running server, and whether the username collides with a staff_users
 * row. Passwords are reported as a length and nothing more — enough to spot a
 * stray space or an empty value, useless to anyone who steals the response.
 *
 * "Invalid credentials" is the same answer for a dozen different causes, which
 * is exactly what makes a login failure hard to chase from the outside. This
 * tells them apart.
 */
export const GET: APIRoute = async ({ request, url }) => {
  const denied = await adminOnly(request);
  if (denied) return denied;

  const probe = (url.searchParams.get('username') ?? '').trim();

  const describe = (
    account: { username: string; password: string } | null,
    userVar: string,
    passVar: string,
  ) => {
    if (!account) {
      return {
        configured: false,
        // Which half is missing is the whole diagnosis when only one was set.
        [userVar]: (process.env[userVar] ?? '') !== '' ? 'set' : 'MISSING',
        [passVar]: (process.env[passVar] ?? '') !== '' ? 'set' : 'MISSING',
      };
    }
    return {
      configured: true,
      username: account.username,
      usernameLength: account.username.length,
      passwordLength: account.password.length,
    };
  };

  // Does a staff_users row shadow this username? A DB row is matched first, so
  // one left over from an earlier attempt beats the env account every time.
  let staffUsers: Record<string, unknown> = { readable: false };
  try {
    const { data, error } = await db
      .from('staff_users')
      .select('username, role, is_active');
    if (!error) {
      const rows = data ?? [];
      staffUsers = {
        readable: true,
        activeCount: rows.filter((r: any) => r.is_active).length,
        usernames: rows.map((r: any) => `${r.username} (${r.role}${r.is_active ? '' : ', inactive'})`),
        shadowsProbedUsername: probe
          ? rows.some((r: any) => r.username === probe && r.is_active)
          : null,
      };
    }
  } catch {
    // Leave readable:false — the login falls back to env accounts in this case.
  }

  return ok({
    admin:     describe(envAdmin(),     'ADMIN_USERNAME',     'ADMIN_PASSWORD'),
    partTimer: describe(envPartTimer(), 'PARTTIMER_USERNAME', 'PARTTIMER_PASSWORD'),
    probe: probe
      ? { username: probe, matchesAnEnvAccount: isEnvAccountName(probe) }
      : null,
    staffUsers,
  });
};
