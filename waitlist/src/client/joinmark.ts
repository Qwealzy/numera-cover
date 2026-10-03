// The Numera mark behind the join section. The page ships the flat SVG mark; when the section comes near the
// viewport, motion is on and WebGL works, this loads the 3D scene (mark3d.ts, which bundles three.js as its own
// chunk) and swaps the flat mark for a slowly turning extruded one. Anything else keeps the flat mark.
// Only this loader is in the first-load JavaScript; three.js loads on demand from the same origin.
import { motionOn } from './motion.ts';

/** Start loading three.js this far before the join section scrolls into view. */
export const JOIN_MARK_ROOT_MARGIN = '600px 0px';

function webglOk(): boolean {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2') ?? c.getContext('webgl');
    if (!gl) return false;
    (gl as WebGLRenderingContext).getExtension('WEBGL_lose_context')?.loseContext();
    return true;
  } catch {
    return false;
  }
}

export function mountJoinMark(section: HTMLElement): void {
  const box = section.querySelector<HTMLElement>('[data-join-mark]');
  if (!box) return;
  const io = new IntersectionObserver(
    (es) => {
      if (!es.some((e) => e.isIntersecting)) return;
      io.disconnect();
      // reduced motion (or paused) or no WebGL: the flat mark stays
      if (!motionOn() || !webglOk()) return;
      import('./mark3d.ts')
        .then((m) => m.mountMark3d(box))
        .catch((e) => console.warn('[numera] 3D mark not started', e));
    },
    { rootMargin: JOIN_MARK_ROOT_MARGIN },
  );
  io.observe(box);
}
