/**
 * Small touches on the wall: tap a hold for a chalk puff and a wobble, and a
 * gentle parallax on the decoration as a mouse moves. Nothing here is needed
 * to use the page; all of it is skipped for prefers-reduced-motion.
 */

const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Puff of chalk at a viewport point, drawn inside `container`. */
export function chalkBurst(clientX: number, clientY: number, count: number, container: HTMLElement) {
  if (reduced()) return;
  const rect = container.getBoundingClientRect();
  for (let i = 0; i < count; i++) {
    const p = document.createElement('span');
    p.className = 'puff';
    const a = Math.random() * Math.PI * 2;
    const dist = 1.2 + Math.random() * 2.6;
    p.style.left = `${clientX - rect.left}px`;
    p.style.top  = `${clientY - rect.top}px`;
    p.style.setProperty('--dx', `${Math.cos(a) * dist}rem`);
    p.style.setProperty('--dy', `${Math.sin(a) * dist - .6}rem`);
    p.style.animationDelay = `${Math.random() * 80}ms`;
    p.addEventListener('animationend', () => p.remove());
    container.appendChild(p);
  }
}

export function initWallFx(wall: HTMLElement, opts: { parallax: boolean }) {
  wall.addEventListener('click', e => {
    const hold = (e.target as Element).closest<HTMLElement>('.hold');
    if (!hold) return;
    chalkBurst(e.clientX, e.clientY, 8, wall);
    if (reduced()) return;
    hold.classList.remove('is-wobbling');
    void hold.offsetWidth;   // restart the animation
    hold.classList.add('is-wobbling');
  });

  const decor = wall.querySelector<HTMLElement>('.decor');
  if (!opts.parallax || !decor || reduced() || !window.matchMedia('(pointer: fine)').matches) return;

  // Holds sit "on" the wall, so they shift a touch against the pointer.
  let raf = 0, x = 0, y = 0;
  window.addEventListener('pointermove', e => {
    x = e.clientX / window.innerWidth - .5;
    y = e.clientY / window.innerHeight - .5;
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      decor.style.transform = `translate(${(-x * 10).toFixed(1)}px, ${(-y * 8).toFixed(1)}px)`;
    });
  }, { passive: true });
}
