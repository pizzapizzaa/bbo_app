export const CUSTOMER_REFRESH_INTERVAL = 15_000;

export function startCustomerRefresh(refresh: () => Promise<boolean | void>) {
  let inFlight: Promise<void> | null = null;
  let lastSuccess = 0;
  async function run(force = false) {
    if (document.visibilityState === 'hidden') return;
    if (inFlight) return inFlight;
    if (!force && Date.now() - lastSuccess < CUSTOMER_REFRESH_INTERVAL) return;
    inFlight = Promise.resolve().then(refresh).then((success) => {
      if (success !== false) lastSuccess = Date.now();
    }).catch(() => {}).finally(() => { inFlight = null; });
    return inFlight;
  }
  const onFocus = () => { void run(true); };
  const timer = setInterval(() => void run(true), CUSTOMER_REFRESH_INTERVAL);
  document.addEventListener('visibilitychange', onFocus);
  window.addEventListener('focus', onFocus);
  window.addEventListener('pageshow', onFocus);
  return {
    refreshIfStale: () => run(),
    stop: () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onFocus);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('pageshow', onFocus);
    },
  };
}