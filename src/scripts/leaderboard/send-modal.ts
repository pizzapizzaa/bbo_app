// @ts-nocheck — DOM-heavy page script, kept in the same loose style as before.
/**
 * "Log a Send" scorecard (SendModal.astro):
 *   1 START  name + nickname, checked with the server before moving on
 *   2 ZONE   wall + per-grade counts, capped by the wall's current set
 *   3 TOP    staff picks their name and signs
 *   4 SENT   result
 */
import { GRADES, hexTagHtml } from '../../lib/leaderboard-grades';
import { nicknameError } from '../../lib/nickname';
import { loadLeaderboard } from './board';
import { chalkBurst } from './wall-fx';

// ── State ────────────────────────────────────────────────────────────────
let state = {
  customerName: '',
  nickname:     '',
  selectedWall: '',
  counts:       Object.fromEntries(GRADES.map(g => [g.grade, 0])),
  availability: null,  // null = not loaded | Record<grade, {max,sent,remaining}>
};
let currentStep = 1;

// ── DOM refs ─────────────────────────────────────────────────────────────
const modal      = document.getElementById('modal');
const nameInput  = document.getElementById('name-input');
const nickInput  = document.getElementById('nick-input');
const acList     = document.getElementById('ac-list');
const modalAlert = document.getElementById('modal-alert');
const gradeGrid  = document.getElementById('grade-grid');
const wallPicker = document.getElementById('wall-picker');

// ── Wall picker ──────────────────────────────────────────────────────────
wallPicker.addEventListener('change', async e => {
  const input = e.target.closest('input[name="wall"]');
  if (!input) return;
  state.selectedWall = input.value;
  markSelectedWall();
  clearAlert();
  clearAvailability();
  resetCounts();
  showRoutes(!!state.selectedWall);
  if (state.selectedWall && state.customerName) await fetchAvailability();
});

/** Mirror the checked radio onto its tile (styling without relying on :has). */
function markSelectedWall() {
  wallPicker.querySelectorAll('.wall-tile').forEach(tile => {
    tile.classList.toggle('is-selected', tile.querySelector('input').checked);
  });
}

/** The grade tags only make sense once a wall is picked — the send log and
 *  its per-grade limits are per wall. `message` replaces the prompt, e.g.
 *  when the picked wall is closed for setting. */
const WALL_PROMPT = document.getElementById('wall-prompt').textContent.trim();
function showRoutes(show, message = WALL_PROMPT) {
  document.getElementById('routes-block').hidden = !show;
  const prompt = document.getElementById('wall-prompt');
  prompt.hidden      = show;
  prompt.textContent = message;
}

/** Zero every counter and its display. */
function resetCounts() {
  state.counts = Object.fromEntries(GRADES.map(g => [g.grade, 0]));
  GRADES.forEach(({ grade }) => {
    const el = document.getElementById(`count-${grade}`);
    if (el) { el.textContent = '0'; el.className = 'counter-val'; }
  });
  updatePtsPreview();
}

// ── Availability ─────────────────────────────────────────────────────────
function clearAvailability() {
  state.availability = null;
  GRADES.forEach(({ grade }) => {
    const item = gradeGrid.querySelector(`.grade-item[data-grade="${grade}"]`);
    if (!item) return;
    item.classList.remove('grade-na', 'grade-done');
    const counter = item.querySelector('.grade-counter');
    if (counter) counter.style.display = '';
    const status = item.querySelector('.grade-avail-status');
    if (status) { status.textContent = ''; status.className = 'grade-avail-status'; }
  });
}

async function fetchAvailability() {
  const wall = state.selectedWall;
  gradeGrid.classList.add('grade-grid-loading');
  try {
    const params = new URLSearchParams({ customer_name: state.customerName, wall });
    const res  = await fetch(`/api/public/wall-availability?${params}`);
    const data = await res.json();
    // Staff switched walls while this was loading — its limits belong to
    // the old wall, so drop them; the newer request applies its own.
    if (wall !== state.selectedWall) return;
    if (res.ok && data.resetting) {
      state.availability = {};
      showRoutes(false, `🚧 ${wall} is being reset — logging opens ${data.opensLabel}.`);
      return;
    }
    if (!res.ok) {
      showAlert(data.error ?? 'Could not load wall availability. Try again.');
      // Block every increment until a valid availability response arrives.
      state.availability = {};
      applyAvailability();
      return;
    }
    state.availability = data.grades;
    applyAvailability();
  } catch {
    showAlert('Network error loading wall availability.');
  } finally {
    gradeGrid.classList.remove('grade-grid-loading');
  }
}

function applyAvailability() {
  if (!state.availability) return;
  GRADES.forEach(({ grade }) => {
    const avail   = state.availability[grade];
    const item    = gradeGrid.querySelector(`.grade-item[data-grade="${grade}"]`);
    if (!item) return;
    const counter = item.querySelector('.grade-counter');
    const status  = item.querySelector('.grade-avail-status');

    item.classList.remove('grade-na', 'grade-done');
    if (counter) counter.style.display = '';

    if (!avail || avail.max === 0) {
      item.classList.add('grade-na');
      if (counter) counter.style.display = 'none';
      if (status) { status.textContent = 'Not on this wall'; status.className = 'grade-avail-status'; }
      state.counts[grade] = 0;
    } else if (avail.remaining === 0) {
      item.classList.add('grade-done');
      if (counter) counter.style.display = 'none';
      if (status) { status.textContent = `✓ All ${avail.max} sent!`; status.className = 'grade-avail-status'; }
      state.counts[grade] = 0;
    } else {
      if (state.counts[grade] > avail.remaining) state.counts[grade] = avail.remaining;
      if (status) {
        status.textContent = `${avail.remaining} of ${avail.max} left`;
        status.className = 'grade-avail-status has-avail';
      }
    }
    syncCounter(grade);
  });
  updatePtsPreview();
}

// ── Grade counters ───────────────────────────────────────────────────────
GRADES.forEach(g => {
  const item = document.createElement('div');
  item.className = 'grade-item';
  item.dataset.grade = g.grade;
  item.innerHTML = `
    ${hexTagHtml(g)}
    <div class="grade-info">
      <div class="grade-pts">+${g.pts} pts each</div>
      <div class="grade-avail-status"></div>
      <div class="grade-counter">
        <button type="button" class="counter-btn" data-grade="${g.grade}" data-action="dec" aria-label="One fewer ${g.grade}">−</button>
        <span class="counter-val" id="count-${g.grade}" aria-live="polite">0</span>
        <button type="button" class="counter-btn" data-grade="${g.grade}" data-action="inc" aria-label="One more ${g.grade}">+</button>
      </div>
    </div>`;
  gradeGrid.appendChild(item);
});

gradeGrid.addEventListener('click', e => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const grade = btn.dataset.grade;
  if (btn.dataset.action === 'inc') {
    // Blocked until this wall's availability has loaded
    if (state.selectedWall && !state.availability) return;
    const avail      = state.availability?.[grade];
    const maxAllowed = avail ? avail.remaining : 20;
    if (maxAllowed <= 0 || state.counts[grade] >= maxAllowed) return;
    state.counts[grade] += 1;
    const tag = btn.closest('.grade-item').querySelector('.hex-tag');
    tag.classList.remove('is-pressed');
    void tag.offsetWidth;   // restart the press animation
    tag.classList.add('is-pressed');
  } else {
    state.counts[grade] = Math.max(state.counts[grade] - 1, 0);
  }
  syncCounter(grade);
  updatePtsPreview();
});

function syncCounter(grade) {
  const el = document.getElementById(`count-${grade}`);
  el.textContent = state.counts[grade];
  el.className = 'counter-val' + (state.counts[grade] > 0 ? ' has-count' : '');
}

function tally() {
  let pts = 0, sends = 0;
  const parts = [];
  GRADES.forEach(({ grade, pts: p }) => {
    const n = state.counts[grade];
    if (n > 0) { pts += p * n; sends += n; parts.push(`${n}× ${grade}`); }
  });
  return { pts, sends, parts };
}

function updatePtsPreview() {
  const { pts, parts } = tally();
  document.getElementById('pts-preview-val').textContent = pts;
  document.getElementById('sends-summary').textContent = parts.length ? parts.join(' · ') : 'No sends selected';
}

// ── Steps ────────────────────────────────────────────────────────────────
function setStep(n) {
  currentStep = n;
  [1, 2, 3, 4].forEach(i => { document.getElementById(`step-${i}`).hidden = i !== n; });
  [1, 2, 3].forEach(i => {
    const ind = document.getElementById(`step-ind-${i}`);
    ind.className = 'step' + (i < n ? ' done' : i === n ? ' active' : '');
    ind.querySelector('.step__hold').textContent = i < n ? '✓' : String(i);
    if (i === n) ind.setAttribute('aria-current', 'step'); else ind.removeAttribute('aria-current');
  });
  // The canvas has no size until its step is visible, so size it on entry.
  if (n === 3) resizeSignaturePad();
  clearAlert();
  document.getElementById('modal').scrollTop = 0;
}

function showAlert(msg, type = 'error') {
  modalAlert.textContent = msg;
  modalAlert.className = `alert ${type} visible`;
}
function clearAlert() { modalAlert.className = 'alert error'; }

// ── Step 1 → 2 ───────────────────────────────────────────────────────────
// Check the name and nickname with the server here, so a typo or a taken
// nickname is caught before staff are asked to sign — not after.
const step1Next = document.getElementById('btn-step1-next');
step1Next.addEventListener('click', async () => {
  const name = nameInput.value.trim();
  const nick = nickInput.value.trim();
  if (!name) { showAlert("Please enter the climber's name."); return; }
  const invalidNick = nicknameError(nick);
  if (invalidNick) { showAlert(invalidNick); return; }

  const label = step1Next.textContent;
  step1Next.disabled = true;
  step1Next.textContent = 'Checking…';
  try {
    const params = new URLSearchParams({ lookup: name, nickname: nick });
    const res  = await fetch(`/api/public/leaderboard?${params}`);
    const data = await res.json();
    if (!res.ok) { showAlert(data.error ?? 'Could not check the details. Try again.'); return; }
    if (!data.customerFound) {
      showAlert(`No customer named "${name}". Pick the name from the list as you type it.`);
      return;
    }
    if (data.nicknameError) { showAlert(data.nicknameError); return; }
  } catch {
    showAlert('Network error. Please check the connection and try again.');
    return;
  } finally {
    step1Next.disabled = false;
    step1Next.textContent = label;
  }

  state.customerName = name;
  state.nickname     = nick;
  setStep(2);
});

// ── Step 2 ───────────────────────────────────────────────────────────────
document.getElementById('btn-step2-back').addEventListener('click', () => setStep(1));
document.getElementById('btn-step2-next').addEventListener('click', () => {
  if (!state.selectedWall) { showAlert('Please pick a wall.'); return; }
  if (!buildGradesPayload()) { showAlert('Add at least one route to log.'); return; }
  renderSignSummary();
  setStep(3);
});

/** The non-zero grade counts, or null if nothing is selected. */
function buildGradesPayload() {
  const payload = {};
  GRADES.forEach(({ grade }) => { if (state.counts[grade] > 0) payload[grade] = state.counts[grade]; });
  return Object.keys(payload).length ? payload : null;
}

/** Restate what staff are about to put their name to. */
function renderSignSummary() {
  const { pts, sends, parts } = tally();
  document.getElementById('sign-summary').innerHTML =
    `<strong>${escHtml(state.customerName)}</strong> is logging ` +
    `<strong>${sends}</strong> send${sends !== 1 ? 's' : ''} on ` +
    `<strong>${escHtml(state.selectedWall)}</strong><br>` +
    `${escHtml(parts.join(' · '))} — <strong>${pts} pts</strong>`;
}

// ── Step 3 ───────────────────────────────────────────────────────────────
document.getElementById('btn-step3-back').addEventListener('click', () => setStep(2));

const submitBtn = document.getElementById('btn-step3-submit');
submitBtn.addEventListener('click', async () => {
  const gradesPayload = buildGradesPayload();
  if (!state.selectedWall) { setStep(2); showAlert('Please pick a wall.'); return; }
  if (!gradesPayload)      { setStep(2); showAlert('Add at least one route to log.'); return; }

  const staffName = document.getElementById('staff-select').value;
  if (!staffName)      { showAlert('Please select the staff member signing off.'); return; }
  if (!hasSignature()) { showAlert('Please ask staff to sign in the box.'); return; }

  const label = submitBtn.textContent;
  submitBtn.disabled = true;
  submitBtn.textContent = 'Submitting…';

  try {
    const res = await fetch('/api/public/leaderboard', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        customer_name:   state.customerName,
        nickname:        state.nickname,
        wall:            state.selectedWall,
        grades:          gradesPayload,
        staff_name:      staffName,
        signature_image: exportSignature(),
      }),
    });
    // A crashed handler returns an HTML error page, not JSON. Parsing that
    // used to throw into the catch below and get reported as a network
    // problem, which sent staff chasing the wifi instead of the server.
    let data = null;
    try { data = await res.json(); } catch { /* not JSON — handled next */ }

    if (!data) {
      showAlert(`Server error (${res.status}). The send was not logged — please tell the manager.`);
      return;
    }
    if (!res.ok) { showAlert(data.error ?? 'Something went wrong. Please try again.'); return; }

    showSent(data);
    loadLeaderboard(); // refresh in the background
  } catch {
    showAlert('Network error. Please check the connection and try again.');
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = label;
  }
});

function showSent(data) {
  document.getElementById('celebrate-msg').textContent =
    `${data.sends_count} send${data.sends_count !== 1 ? 's' : ''} on ${state.selectedWall} for ` +
    `"${state.nickname}", signed off by ${data.signed_by}.`;
  setStep(4);

  // Restart the stamp, count the points up, and throw some chalk
  const stamp = document.getElementById('sent-stamp');
  stamp.style.animation = 'none';
  void stamp.offsetWidth;
  stamp.style.animation = '';

  const out = document.getElementById('pts-earned-val');
  const target = data.points_earned;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduced) { out.textContent = `+${target} pts`; return; }
  const t0 = performance.now();
  (function tick(now) {
    const u = Math.min(1, (now - t0) / 700);
    out.textContent = `+${Math.round(target * (1 - (1 - u) ** 3))} pts`;
    if (u < 1) requestAnimationFrame(tick);
  })(t0);
  const r = stamp.getBoundingClientRect();
  chalkBurst(r.left + r.width / 2, r.top + r.height / 2, 16, document.getElementById('celebrate'));
}

// ── Signature pad ────────────────────────────────────────────────────────
// Plain canvas + pointer events: one handler covers mouse, touch and stylus.
const sigPad    = document.getElementById('sig-pad');
const sigCanvas = document.getElementById('sig-canvas');
const sigCtx    = sigCanvas.getContext('2d');

// Strokes are kept in CSS pixels so the pad can be re-rendered at any size
// (rotating a phone, resizing a window) without losing what was drawn.
let sigStrokes = [];   // [[{x,y}, …], …]
let sigDrawing = false;

function resizeSignaturePad() {
  const rect = sigCanvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;   // still hidden
  const dpr = window.devicePixelRatio || 1;
  sigCanvas.width  = Math.round(rect.width  * dpr);
  sigCanvas.height = Math.round(rect.height * dpr);
  sigCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  redrawSignature();
}

function drawStrokes(ctx) {
  ctx.lineWidth   = 2.2;
  ctx.lineCap     = 'round';
  ctx.lineJoin    = 'round';
  ctx.strokeStyle = '#1C1C1E';
  ctx.fillStyle   = '#1C1C1E';
  sigStrokes.forEach(stroke => {
    if (stroke.length === 1) {
      // A single tap still deserves a visible dot.
      ctx.beginPath();
      ctx.arc(stroke[0].x, stroke[0].y, 1.1, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    ctx.beginPath();
    ctx.moveTo(stroke[0].x, stroke[0].y);
    for (let i = 1; i < stroke.length; i++) ctx.lineTo(stroke[i].x, stroke[i].y);
    ctx.stroke();
  });
}

function redrawSignature() {
  const rect = sigCanvas.getBoundingClientRect();
  sigCtx.clearRect(0, 0, rect.width, rect.height);
  drawStrokes(sigCtx);
  sigPad.classList.toggle('has-ink', sigStrokes.length > 0);
}

function sigPoint(e) {
  const rect = sigCanvas.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

sigCanvas.addEventListener('pointerdown', e => {
  e.preventDefault();
  sigCanvas.setPointerCapture(e.pointerId);
  sigDrawing = true;
  sigStrokes.push([sigPoint(e)]);
  redrawSignature();
});
sigCanvas.addEventListener('pointermove', e => {
  if (!sigDrawing) return;
  e.preventDefault();
  sigStrokes[sigStrokes.length - 1].push(sigPoint(e));
  redrawSignature();
});
['pointerup', 'pointercancel', 'pointerleave'].forEach(evt => {
  sigCanvas.addEventListener(evt, () => { sigDrawing = false; });
});

document.getElementById('btn-sig-clear').addEventListener('click', clearSignature);

function clearSignature() {
  sigStrokes = [];
  sigDrawing = false;
  redrawSignature();
}

/**
 * A stray tap shouldn't pass as a signature — require a real mark: either
 * several strokes, or one stroke with enough points to be a squiggle.
 */
function hasSignature() {
  const points = sigStrokes.reduce((n, s) => n + s.length, 0);
  return sigStrokes.length >= 2 || points >= 8;
}

/**
 * Render the strokes onto a fixed 600×180 canvas so every stored signature
 * has the same dimensions regardless of the device that drew it.
 */
function exportSignature() {
  const OUT_W = 600, OUT_H = 180;
  const rect  = sigCanvas.getBoundingClientRect();
  const scale = Math.min(OUT_W / rect.width, OUT_H / rect.height);

  const out = document.createElement('canvas');
  out.width  = OUT_W;
  out.height = OUT_H;
  const ctx = out.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, OUT_W, OUT_H);
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  drawStrokes(ctx);
  return out.toDataURL('image/png');
}

window.addEventListener('resize', () => {
  if (!document.getElementById('step-3').hidden) resizeSignaturePad();
});

// ── Log more / Done ──────────────────────────────────────────────────────
document.getElementById('btn-log-more').addEventListener('click', () => {
  resetModal();
  setStep(2);
});
document.getElementById('btn-done').addEventListener('click', closeModal);

// ── Open / close ─────────────────────────────────────────────────────────
// Tapping the backdrop does nothing: on a phone it is too easy to hit while
// signing, and closing throws the whole scorecard away.
document.getElementById('log-send-btn')?.addEventListener('click', openModal);
document.getElementById('modal-close').addEventListener('click', requestClose);
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !modal.classList.contains('hidden')) requestClose();
});

/** Close, but ask first if there is work on the card that would be lost. */
function requestClose() {
  const inProgress = (currentStep === 2 && (state.selectedWall || buildGradesPayload())) ||
                     (currentStep === 3);
  if (inProgress && !confirm('Discard this scorecard? The sends have not been logged yet.')) return;
  closeModal();
}

function openModal() {
  resetModal();
  setStep(1);
  modal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  nameInput.focus();
}
function closeModal() {
  modal.classList.add('hidden');
  document.body.style.overflow = '';
  document.getElementById('log-send-btn')?.focus();
}
function resetModal() {
  state.selectedWall = '';
  state.availability = null;
  resetCounts();
  showRoutes(false);
  wallPicker.querySelectorAll('input[name="wall"]').forEach(i => { i.checked = false; });
  markSelectedWall();
  // Staff must select their name and sign again for each submission.
  document.getElementById('staff-select').value = '';
  clearSignature();
  clearAvailability();
  updatePtsPreview();
  clearAlert();
}

// ── Customer name autocomplete ───────────────────────────────────────────
let acTimer;
nameInput.addEventListener('input', () => {
  clearTimeout(acTimer);
  const q = nameInput.value.trim();
  if (q.length < 2) { acList.classList.add('hidden'); return; }
  acTimer = setTimeout(() => fetchNames(q), 220);
});

async function fetchNames(q) {
  try {
    const res  = await fetch(`/api/public/customers?q=${encodeURIComponent(q)}`);
    const data = await res.json();
    renderAc(data.names ?? []);
  } catch { acList.classList.add('hidden'); }
}

function renderAc(names) {
  acList.innerHTML = '';
  if (!names.length) { acList.classList.add('hidden'); return; }
  names.forEach(name => {
    const item = document.createElement('div');
    item.className = 'ac-item';
    item.setAttribute('role', 'option');
    item.textContent = name;
    item.addEventListener('mousedown', e => {
      e.preventDefault();
      nameInput.value = name;
      state.customerName = name;
      acList.classList.add('hidden');
      fetchExistingNickname(name);
      nickInput.focus();
    });
    acList.appendChild(item);
  });
  acList.classList.remove('hidden');
}

nameInput.addEventListener('blur', () => setTimeout(() => acList.classList.add('hidden'), 150));

async function fetchExistingNickname(name) {
  try {
    const res  = await fetch(`/api/public/leaderboard?lookup=${encodeURIComponent(name)}`);
    const data = await res.json();
    if (data.existingNickname && !nickInput.value.trim()) {
      nickInput.value = data.existingNickname;
      state.nickname  = data.existingNickname;
    }
  } catch { /* silently skip */ }
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
