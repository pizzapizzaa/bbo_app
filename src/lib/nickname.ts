/**
 * Leaderboard nickname rules. No server imports, so the leaderboard page's
 * script can import this too and reject a bad nickname at step 1 — before
 * staff have signed — with exactly the message the API would give.
 */

export const MAX_NICKNAME = 30;

/** Returns an error message, or null when the nickname is acceptable. */
export function nicknameError(raw: string): string | null {
  const nickname = raw.trim();
  if (!nickname) return 'A public nickname is required.';
  if (nickname.length > MAX_NICKNAME)
    return `Nickname must be ${MAX_NICKNAME} characters or fewer.`;
  if (!/^[\x20-\x7E]+$/.test(nickname))
    return 'Nickname must contain printable characters only.';
  if (!/^\w/.test(nickname))
    return 'Nickname must start with a letter or number.';
  return null;
}
