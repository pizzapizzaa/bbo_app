/**
 * Drives the dyno climber in ClimberDyno.astro.
 *
 * Each frame picks where the hips, hands and feet should be, then solves the
 * arms and legs with two-bone IK so the limbs always join up — hands stay on
 * the holds while the body pumps, launches and swings. Only SVG attributes
 * change, so it is cheap; it pauses when off screen or in a background tab,
 * and holds one still pose for prefers-reduced-motion.
 */

type P = [number, number];

// Bone lengths (viewBox units)
const UPPER_ARM = 18, FOREARM = 17;
const THIGH = 22, SHIN = 21;
const SHOULDER: P = [6, -32];   // offset from the hips, mirrored left/right
const HIP_JOINT: P = [4, 0];

// Problem layout — must match the holds drawn in ClimberDyno.astro
const HIPS_START: P = [90, 212];
const START_L: P = [70, 150], START_R: P = [110, 150];
const FOOT_L: P = [68, 226], FOOT_R: P = [112, 226];
const TOP_L: P = [108, 54], TOP_R: P = [122, 54];
const TOP_CENTRE: P = [115, 54];
const HANG_LENGTH = 67;          // hands to hips with straight arms

const CYCLE = 7;                 // seconds per attempt
const LAUNCH = 1.24, RELEASE = 1.42, CATCH = 1.95, LET_GO = 5.4;

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const lerpP = (a: P, b: P, t: number): P => [lerp(a[0], b[0], t), lerp(a[1], b[1], t)];
const clamp01 = (t: number) => Math.min(1, Math.max(0, t));
const easeInOut = (t: number) => (t < .5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
const easeOut = (t: number) => 1 - (1 - t) ** 3;

/** Rotate a body-space offset by `deg` (screen coordinates, clockwise positive). */
function rot(v: P, deg: number): P {
  const r = (deg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  return [v[0] * c - v[1] * s, v[0] * s + v[1] * c];
}
const add = (a: P, b: P): P => [a[0] + b[0], a[1] + b[1]];

/** Swing angle (degrees, + = hips to the right of the hands) `s` seconds after the catch. */
function swing(s: number): number {
  const w = (2 * Math.PI) / 1.3, decay = Math.exp(-s / 1.1);
  return decay * (-2 * Math.cos(w * s) + 15 * Math.sin(w * s));
}

interface Pose {
  hips: P; body: number;          // body rotation, degrees
  hands: [P, P]; feet: [P, P];
  opacity: number;
}

/** Where everything is `t` seconds into an attempt. */
export function poseAt(t: number): Pose {
  // Feet hang under the hips when not on holds; the slight lag makes them trail.
  const dangle = (hips: P, body: number): [P, P] => [
    add(hips, rot([-5, 42], body)),
    add(hips, rot([5, 42], body)),
  ];

  if (t < LAUNCH || t >= 5.9) {
    // Crouched on the start holds, pumping twice before the move
    const dip = t < LAUNCH ? ((1 - Math.cos((2 * Math.PI * t) / .62)) / 2) * 6 : 0;
    const fade = t >= 6.4 ? clamp01((t - 6.4) / .5) : t >= 5.9 ? 0 : 1;
    return {
      hips: [HIPS_START[0], HIPS_START[1] + dip], body: 0,
      hands: [START_L, START_R], feet: [FOOT_L, FOOT_R],
      opacity: fade,
    };
  }

  if (t < CATCH) {
    // Launch: legs drive, hips travel up and right; hands let go and reach
    const u = easeInOut(clamp01((t - LAUNCH) / (CATCH - LAUNCH)));
    const hips = lerpP(HIPS_START, [113, 117], u);
    const reach = easeOut(clamp01((t - RELEASE) / (CATCH - RELEASE)));
    const hands: [P, P] = [lerpP(START_L, TOP_L, reach), lerpP(START_R, TOP_R, reach)];
    const off = clamp01((t - 1.5) / .15);
    const free = dangle(hips, 0);
    return {
      hips, body: -6 * Math.sin(Math.PI * u), hands,
      feet: [lerpP(FOOT_L, free[0], off), lerpP(FOOT_R, free[1], off)],
      opacity: 1,
    };
  }

  if (t < LET_GO) {
    // Hanging off the top jug: swing out and settle
    const s = t - CATCH;
    const angle = swing(s);
    const length = lerp(63, HANG_LENGTH, easeOut(clamp01(s / .25)));
    const hips = add(TOP_CENTRE, rot([0, length], -angle));
    return {
      hips, body: -angle, hands: [TOP_L, TOP_R],
      feet: dangle(hips, -swing(Math.max(0, s - .12))),
      opacity: 1,
    };
  }

  // Let go and drop to the mat
  const s = t - LET_GO;
  const hips: P = [115, 121 + 400 * s * s];
  const shoulders = [add(hips, [-SHOULDER[0], SHOULDER[1]]), add(hips, SHOULDER)];
  return {
    hips, body: 0,
    hands: [add(shoulders[0], [-3, -33]), add(shoulders[1], [3, -33])],
    feet: dangle(hips, 0),
    opacity: 1 - clamp01((t - 5.5) / .4),
  };
}

/**
 * Two-bone IK: elbow/knee and end point for a limb from `root` towards
 * `target`, bending outward (`side` −1 = left, +1 = right).
 */
function solve(root: P, target: P, l1: number, l2: number, side: -1 | 1): [P, P] {
  const dx = target[0] - root[0], dy = target[1] - root[1];
  const d = Math.hypot(dx, dy) || 1;
  const reach = Math.min(l1 + l2 - .01, Math.max(Math.abs(l1 - l2) + .01, d));
  const ux = dx / d, uy = dy / d;
  const end: P = [root[0] + ux * reach, root[1] + uy * reach];
  const a = (l1 * l1 - l2 * l2 + reach * reach) / (2 * reach);
  const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
  const mx = root[0] + ux * a, my = root[1] + uy * a;
  const j1: P = [mx - uy * h, my + ux * h];
  const j2: P = [mx + uy * h, my - ux * h];
  const joint = (side < 0 ? j1[0] < j2[0] : j1[0] > j2[0]) ? j1 : j2;
  return [joint, end];
}

const pts = (...p: P[]) => p.map(q => `${q[0].toFixed(1)},${q[1].toFixed(1)}`).join(' ');

export interface ClimberOptions {
  /** Seconds between attempts. Defaults to back-to-back attempts. */
  every?: number;
}

export function startClimber(stage: HTMLElement, opts: ClimberOptions = {}) {
  const svg = stage.querySelector('svg')!;
  const climber = stage.querySelector<SVGGElement>('[data-climber]')!;
  const torso = stage.querySelector<SVGGElement>('[data-torso]')!;
  const limb = (n: string) => stage.querySelector<SVGPolylineElement>(`[data-limb="${n}"]`)!;
  const hand = (n: string) => stage.querySelector<SVGCircleElement>(`[data-hand="${n}"]`)!;
  const shoe = (n: string) => stage.querySelector<SVGEllipseElement>(`[data-shoe="${n}"]`)!;
  const puffs = stage.querySelector<SVGGElement>('[data-puffs]')!;
  const parts = {
    armL: limb('armL'), armR: limb('armR'), legL: limb('legL'), legR: limb('legR'),
    handL: hand('L'), handR: hand('R'), shoeL: shoe('L'), shoeR: shoe('R'),
  };

  function render(p: Pose) {
    climber.setAttribute('opacity', p.opacity.toFixed(2));
    torso.setAttribute('transform', `translate(${p.hips[0].toFixed(1)} ${p.hips[1].toFixed(1)}) rotate(${p.body.toFixed(1)})`);

    ([[-1, 'L'], [1, 'R']] as const).forEach(([side, n], i) => {
      const shoulder = add(p.hips, rot([side * SHOULDER[0], SHOULDER[1]], p.body));
      const [elbow, h] = solve(shoulder, p.hands[i], UPPER_ARM, FOREARM, side);
      parts[`arm${n}`].setAttribute('points', pts(shoulder, elbow, h));
      parts[`hand${n}`].setAttribute('cx', h[0].toFixed(1));
      parts[`hand${n}`].setAttribute('cy', h[1].toFixed(1));

      const hip = add(p.hips, rot([side * HIP_JOINT[0], HIP_JOINT[1]], p.body));
      const [knee, f] = solve(hip, p.feet[i], THIGH, SHIN, side);
      parts[`leg${n}`].setAttribute('points', pts(hip, knee, f));
      const ang = (Math.atan2(f[1] - knee[1], f[0] - knee[0]) * 180) / Math.PI - 90;
      parts[`shoe${n}`].setAttribute('transform', `translate(${f[0].toFixed(1)} ${f[1].toFixed(1)}) rotate(${ang.toFixed(0)}) translate(${side * 1.5} 1)`);
    });
  }

  function puff(at: P, count = 6) {
    for (let i = 0; i < count; i++) {
      const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      c.setAttribute('cx', String(at[0]));
      c.setAttribute('cy', String(at[1]));
      c.setAttribute('r', String(2 + Math.random() * 2));
      c.setAttribute('fill', '#fff');
      c.style.transformBox = 'fill-box';
      c.style.transformOrigin = 'center';
      puffs.appendChild(c);
      const a = Math.random() * Math.PI * 2, dist = 8 + Math.random() * 10;
      c.animate(
        [
          { transform: 'translate(0,0) scale(.5)', opacity: .9 },
          { transform: `translate(${Math.cos(a) * dist}px, ${Math.sin(a) * dist - 4}px) scale(2.2)`, opacity: 0 },
        ],
        { duration: 650 + Math.random() * 300, easing: 'ease-out' },
      ).onfinish = () => c.remove();
    }
  }

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduced) { render(poseAt(4.6)); return; }

  const period = Math.max(CYCLE, opts.every ?? CYCLE);
  let visible = true, raf = 0, start = performance.now(), last = 0;

  function frame(now: number) {
    const t = ((now - start) / 1000) % period;
    const at = t < CYCLE ? t : 0;
    if (last < RELEASE && at >= RELEASE) puff([90, 150], 5);
    if (last < CATCH && at >= CATCH) puff(TOP_CENTRE, 9);
    last = at;
    render(poseAt(at));
    raf = requestAnimationFrame(frame);
  }

  function run() {
    cancelAnimationFrame(raf);
    if (visible && !document.hidden) raf = requestAnimationFrame(frame);
  }

  new IntersectionObserver(([e]) => { visible = e.isIntersecting; run(); }).observe(svg);
  document.addEventListener('visibilitychange', run);
  render(poseAt(0));
  run();
}
