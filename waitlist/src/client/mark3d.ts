// Lazy chunk: the Numera mark extruded from its own two polygons (the same points as the flat SVG, from
// src/lib/geometry.ts) and turning slowly, behind the join section. Ported from the 3D hub on the site-phase2
// branch (site/src/scene/hub.ts buildMark): only the mark geometry and a slow rotation, no rings, nodes or
// environment map. It renders through the page's one rAF scheduler, so it stops while the section is off
// screen, the tab is hidden or motion is off. Its opacity is the CSS token --join-mark-opacity.
import {
  Color,
  DirectionalLight,
  ExtrudeGeometry,
  Group,
  HemisphereLight,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  Scene,
  Shape,
  SRGBColorSpace,
  WebGLRenderer,
} from 'three';
import { MARK_GREEN, MARK_NAVY } from '../lib/geometry.ts';
import { loop, onMotion } from './motion.ts';

/** Turn speed around the vertical axis (radians per second): one turn in about 50 s. */
export const MARK_SPIN_RAD_S = 0.125;
/** The mark also rocks gently around the horizontal axis by this much (radians). */
export const MARK_TILT_RAD = 0.12;
/** Device pixel ratio cap: sharp on retina screens without rendering 3x buffers. */
export const MARK_MAX_DPR = 2;

function buildMark(): Group {
  const S = 2 / 512;
  const depth = 0.34;
  const g = new Group();
  for (const [pts, hex] of [
    [MARK_NAVY, '#435c7a'],
    [MARK_GREEN, '#23b779'],
  ] as const) {
    const shape = new Shape();
    pts.forEach(([x, y], i) => {
      const X = (x - 256) * S;
      const Y = -(y - 256) * S;
      if (i === 0) shape.moveTo(X, Y);
      else shape.lineTo(X, Y);
    });
    shape.closePath();
    const geo = new ExtrudeGeometry(shape, { depth, bevelEnabled: true, bevelThickness: 0.035, bevelSize: 0.022, bevelSegments: 3, curveSegments: 1 });
    geo.translate(0, 0, -depth / 2);
    const col = new Color(hex);
    g.add(new Mesh(geo, new MeshStandardMaterial({ color: col, metalness: 0.1, roughness: 0.4, emissive: col, emissiveIntensity: 0.12 })));
  }
  return g;
}

export function mountMark3d(box: HTMLElement): void {
  const canvas = document.createElement('canvas');
  canvas.className = 'join-mark-3d';
  canvas.setAttribute('aria-hidden', 'true');
  const renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'low-power' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MARK_MAX_DPR));
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = SRGBColorSpace;

  const scene = new Scene();
  const camera = new PerspectiveCamera(30, 1, 0.1, 50);
  camera.position.set(0, 0, 5.2);
  scene.add(new HemisphereLight(0xf8f2ef, 0x435c7a, 1.1));
  const key = new DirectionalLight(0xf8f2ef, 1.4);
  key.position.set(-3, 4, 6);
  scene.add(key);
  const mark = buildMark();
  scene.add(mark);

  let t = 0;
  const render = () => {
    mark.rotation.y = t * MARK_SPIN_RAD_S;
    mark.rotation.x = Math.sin(t * 0.3) * MARK_TILT_RAD;
    renderer.render(scene, camera);
  };
  const resize = () => {
    const w = Math.max(1, box.clientWidth);
    const h = Math.max(1, box.clientHeight);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    render();
  };

  box.append(canvas);
  resize();
  box.dataset.mode = '3d'; // CSS hides the flat mark only now that the 3D one has drawn a frame
  new ResizeObserver(resize).observe(box);

  const run = loop('join-mark', box, (dt) => {
    t += dt;
    render();
  });
  run.start();
  onMotion((on) => (on ? run.start() : render()));
}
