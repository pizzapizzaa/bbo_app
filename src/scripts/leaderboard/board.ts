// @ts-nocheck — DOM-heavy page script, kept in the same loose style as before.
/**
 * Loads the leaderboard and draws it: stats tape, the podium volumes and the
 * route of everyone else. With ?board in the URL the page runs as a TV board:
 * no logging controls, refresh every minute, and the route scrolls itself.
 */

export const boardMode = new URLSearchParams(location.search).has('board');

const REFRESH_MS = 60_000;
const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const podiumArea = document.getElementById('podium-area');
const podiumEl   = document.getElementById('podium');
const routeEl    = document.getElementById('route');
const stateEl    = document.getElementById('board-state');
const noteEl     = document.getElementById('board-note');
const refreshBtn = document.getElementById('refresh-btn');
const statusEl   = document.getElementById('board-status');

let loading = false;
let hasData = false;
/** nickname → rank at the previous draw, to tag climbers who moved up */
let lastRanks = new Map();

export async function loadLeaderboard() {
  if (loading) return;
  loading = true;
  if (refreshBtn) refreshBtn.disabled = true;
  if (noteEl) noteEl.hidden = true;

  try {
    const res  = await fetch('/api/public/leaderboard');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? 'Failed to load');
    render(data.leaderboard ?? []);
    hasData = true;
    if (statusEl) statusEl.textContent = `Live · updated ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  } catch {
    // Keep what is already on screen (a TV should never flip to an error);
    // only say so when there is nothing to show yet.
    if (!hasData) showState('Off the wall', 'Could not load the leaderboard. Try refreshing.');
    else if (noteEl) noteEl.hidden = false;
  } finally {
    loading = false;
    if (refreshBtn) refreshBtn.disabled = false;
  }
}

function showState(tag, message, loadingDots = false) {
  podiumArea.hidden = true;
  routeEl.innerHTML = '';
  stateEl.hidden = false;
  stateEl.innerHTML =
    (loadingDots ? '<div class="chalk-dots" aria-hidden="true"><span></span><span></span><span></span></div><br>' : '') +
    `<span class="tape tape--yellow">${tag}</span><p>${message}</p>`;
}

function render(entries) {
  const totalSends = entries.reduce((s, e) => s + e.sends, 0);
  const totalPts   = entries.reduce((s, e) => s + e.total, 0);
  countTo('stat-climbers', entries.length);
  countTo('stat-sends', totalSends);
  countTo('stat-pts', totalPts);

  if (!entries.length) {
    showState('Fresh set', 'No sends logged yet. Be the first to top out!');
    lastRanks = new Map();
    return;
  }
  stateEl.hidden = true;

  const rises = new Map();
  entries.forEach(e => {
    const before = lastRanks.get(e.nickname);
    if (before && e.rank < before) rises.set(e.nickname, before - e.rank);
  });
  lastRanks = new Map(entries.map(e => [e.nickname, e.rank]));

  // ── Podium: up to three volumes, tallest for the leader ──
  podiumArea.hidden = false;
  podiumEl.innerHTML = '<div class="podium__spot" aria-hidden="true"></div>' +
    entries.slice(0, 3).map((e, i) => `
      <article class="vol vol--${i + 1}" aria-label="${ordinal(e.rank)} place: ${esc(e.nickname)}, ${e.total} points">
        <div class="vol__head"><span class="tape vol__rank">${ordinal(e.rank)}</span>${riseTag(rises, e)}</div>
        <h3 class="vol__name">${esc(e.nickname)}</h3>
        <div class="vol__pts">${e.total.toLocaleString()}<small>pts</small></div>
        <div class="vol__meta">${e.sends} send${e.sends !== 1 ? 's' : ''} ${signMark(e)}</div>
      </article>`).join('');

  // ── The route: everyone after the podium ──
  routeEl.innerHTML = entries.slice(3).map((e, i) => `
    <li class="route-row" style="animation-delay:${Math.min(i * 40, 1200)}ms">
      <span class="rank-tag${e.rank <= 10 ? ' rank-tag--top' : ''}" aria-label="Rank ${e.rank}">${String(e.rank).padStart(2, '0')}</span>
      <div class="row-main">
        <div class="row-name">${esc(e.nickname)}${riseTag(rises, e)}</div>
        <div class="row-meta">${e.sends} send${e.sends !== 1 ? 's' : ''} ${signMark(e)}</div>
      </div>
      <div class="row-pts">${e.total.toLocaleString()}<small>pts</small></div>
    </li>`).join('');
}

function ordinal(n) {
  const s = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] ?? 'th');
  return `${n}${s}`;
}

function riseTag(rises, e) {
  const up = rises.get(e.nickname);
  return up ? ` <span class="tape rise-tag" title="Up ${up} since the last update">▲ ${up}</span>` : '';
}

/**
 * A signature squiggle when every one of a climber's sends carries a staff
 * signature. Sends logged before sign-off existed have none and stay marked
 * as such rather than being quietly promoted.
 */
function signMark(e) {
  const signed = e.signed ?? 0;
  if (!e.sends) return '';
  if (signed >= e.sends) {
    return '<span class="signed" title="Every send staff-signed">' +
      '<svg viewBox="0 0 34 16" aria-hidden="true"><path d="M2 12c3-7 6-9 7-6s-2 7 1 6 4-8 7-8 0 7 3 7 5-5 7-6 3 1 5 0" ' +
      'fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>signed</span>';
  }
  const missing = e.sends - signed;
  return `<span class="unsigned" title="${missing} send${missing !== 1 ? 's' : ''} logged without a staff signature">${missing} unsigned</span>`;
}

/** Count a stat up (or down) to its new value. */
function countTo(id, value) {
  const el = document.getElementById(id);
  const from = Number(el.dataset.value ?? 0);
  el.dataset.value = String(value);
  if (reduced() || from === value) { el.textContent = value.toLocaleString(); return; }
  const t0 = performance.now();
  (function tick(now) {
    const u = Math.min(1, (now - t0) / 800);
    el.textContent = Math.round(from + (value - from) * (1 - (1 - u) ** 3)).toLocaleString();
    if (u < 1) requestAnimationFrame(tick);
  })(t0);
}

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * TV: scroll the route slowly to the bottom, pause, jump back to the top,
 * pause, repeat. Does nothing while the list fits on screen.
 */
function autoScroll(box) {
  const SPEED = 28;           // px per second
  const PAUSE = 5000;
  let phase = 'top', since = performance.now(), last = since;

  function step(now) {
    const dt = (now - last) / 1000;
    last = now;
    const max = box.scrollHeight - box.clientHeight;
    if (max <= 2) {
      box.scrollTop = 0; phase = 'top'; since = now;
    } else if (phase === 'top' && now - since > PAUSE) {
      phase = 'down';
    } else if (phase === 'down') {
      box.scrollTop = Math.min(max, box.scrollTop + SPEED * dt);
      if (box.scrollTop >= max - 1) { phase = 'bottom'; since = now; }
    } else if (phase === 'bottom' && now - since > PAUSE) {
      box.scrollTop = 0; phase = 'top'; since = now;
    }
    requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

// ── Init ─────────────────────────────────────────────────────────────────
refreshBtn?.addEventListener('click', () => {
  refreshBtn.classList.remove('is-dipping');
  void refreshBtn.offsetWidth;
  refreshBtn.classList.add('is-dipping');
  loadLeaderboard();
});

showState('Chalking up', 'Loading the leaderboard…', true);
loadLeaderboard();

if (boardMode) {
  setInterval(loadLeaderboard, REFRESH_MS);
  autoScroll(document.getElementById('route-scroll'));
}
