export const TOKEN_REFRESH_WINDOW_MS = 60 * 60 * 1000;

export function tokenExpiryFromToken(token: string): number {
  try {
    const payload = token.split('.', 1)[0];
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const claims = JSON.parse(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')));
    return typeof claims.e === 'number' && Number.isFinite(claims.e) ? claims.e : 0;
  } catch {
    return 0;
  }
}

export function startSessionRefresh() {
  let inFlight = false;

  function maybeRefreshToken() {
    const token = localStorage.getItem('bbo_token');
    if (!token) return;

    const expiresAt = tokenExpiryFromToken(token);
    if (!expiresAt) return;
    if (Date.now() >= expiresAt) {
      localStorage.removeItem('bbo_auth');
      localStorage.removeItem('bbo_token');
      localStorage.removeItem('bbo_admin');
      window.location.replace('/pos');
      return;
    }
    if (expiresAt - Date.now() > TOKEN_REFRESH_WINDOW_MS || inFlight) return;

    inFlight = true;
    fetch('/api/auth/refresh', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((response) => response.json())
      .then((data) => {
        if (data.token && localStorage.getItem('bbo_token') === token) {
          localStorage.setItem('bbo_token', data.token);
        }
      })
      .catch(() => {})
      .finally(() => { inFlight = false; });
  }

  const onResume = () => {
    if (document.visibilityState !== 'hidden') maybeRefreshToken();
  };
  maybeRefreshToken();
  const timer = window.setInterval(maybeRefreshToken, 60 * 60 * 1000);
  window.addEventListener('focus', onResume);
  document.addEventListener('visibilitychange', onResume);

  return () => {
    window.clearInterval(timer);
    window.removeEventListener('focus', onResume);
    document.removeEventListener('visibilitychange', onResume);
  };
}
