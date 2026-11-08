import * as THREE from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

const TAU = 2 * Math.PI;
const PERIODS = [1, 60, 3600, 86400];
const AMPLITUDES = [0.005, 0.02, 0.1, 1];
const waves = PERIODS.map((p, i) => ({ f: TAU / p, amp: AMPLITUDES[i] }));
const sumWaves = (fn, t) => waves.reduce((s, w) => s + w.amp * fn(w.f * t), 0);
const signal = (t) => ({ y: sumWaves(Math.sin, t), z: sumWaves(Math.cos, t) });

const MIN_HALF = 0.5;
const MAX_HALF = 86400 * 4;
const X_EXTENT = 1.5; // world half-length of the time axis (aspect 3:1:1)
const MIN_SAMPLES = 1501;
const MAX_SAMPLES = 500001;
const LINE_WIDTH = 0.5; // px, present side
const PAST_WIDTH_SCALE = 0.5;
let halfSpan = 60; // 2 minutes total

const nowSeconds = () => Date.now() / 1000;
const el = document.getElementById('plot');
const timeEl = document.getElementById('time');
const spanEl = document.getElementById('span');

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
el.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x111111);
const cam = new THREE.PerspectiveCamera(45, 1, 0.005, 100);
cam.up.set(0, 0, 1);

const VIEWS = {
  yz: [-1.0, 0, 0],
  xz: [0, -2, 0],
  xy: [0, -0.01, 2],
};
let activeView = null;
let yzRadius = 0.5; // largest distance of the now-point from the axis, in world units
// Back the yz camera off just enough that the now-point stays in frame (limited by the narrower fov axis).
const yzDistance = () => {
  const half = Math.tan(THREE.MathUtils.degToRad(cam.fov / 2)) * Math.min(1, cam.aspect);
  return Math.max(1.0, (yzRadius * 1.15) / half);
};
const setView = (name) => {
  activeView = name;
  const p = VIEWS[name];
  if (name === 'yz') cam.position.set(-yzDistance(), 0, 0);
  else cam.position.set(...p);
  controls.target.set(0, 0, 0);
  controls.update();
};
const controls = new OrbitControls(cam, renderer.domElement);
controls.enableZoom = false;
controls.addEventListener('start', () => { activeView = null; });
controls.enableDamping = true;

// Curve: screen-space fat line; alpha is computed in the shader from the world-space x (time offset from now).
// The curve is drawn twice (past / future halves, split per-fragment at x = 0) so each half
// can sit in its own layer: future < now-point < past.
function makeCurveMat(side) {
  const mat = new LineMaterial({ color: 0xffffff, linewidth: LINE_WIDTH, transparent: true, depthWrite: false, depthTest: false });
  mat.uniforms.uSide = { value: side };
  mat.uniforms.uReach = { value: X_EXTENT * 1.25 };
  mat.uniforms.uPastWidth = { value: PAST_WIDTH_SCALE };
  mat.uniforms.uPast = { value: new THREE.Vector4(...new THREE.Color(0x2a56b0).toArray(), 0.6) };
  mat.uniforms.uFuture = { value: new THREE.Vector4(...new THREE.Color(0x2f8cff).toArray(), 1) };
  mat.onBeforeCompile = (sh) => {
    for (const k of ['uSide', 'uReach', 'uPast', 'uPastWidth', 'uFuture']) sh.uniforms[k] = mat.uniforms[k];
    sh.vertexShader = sh.vertexShader
      .replace('offset *= linewidth;', 'offset *= linewidth * (vFadeX < 0.0 ? uPastWidth : 1.0);')
      .replace('void main() {', 'uniform float uPastWidth;\nvarying float vFadeX;\nvoid main() {\n vFadeX = (modelMatrix * vec4(position.y < 0.5 ? instanceStart : instanceEnd, 1.0)).x;');
    sh.fragmentShader = sh.fragmentShader
      .replace('void main() {', 'uniform float uSide; uniform float uReach; uniform vec4 uPast; uniform vec4 uFuture; varying float vFadeX;\nvoid main() {\n if (uSide * vFadeX < 0.0) discard;')
      .replace('gl_FragColor = vec4( diffuseColor.rgb, alpha );',
        'vec4 c = vFadeX < 0.0 ? uPast : uFuture; gl_FragColor = vec4(c.rgb, c.a * pow(max(0.0, 1.0 - abs(vFadeX) / uReach), 1.5) * alpha);');
  };
  return mat;
}
const curveMats = [makeCurveMat(1), makeCurveMat(-1)];
const futureCurve = new Line2(new LineGeometry(), curveMats[0]);
const pastCurve = new Line2(new LineGeometry(), curveMats[1]);
futureCurve.renderOrder = 0;
pastCurve.renderOrder = 20;
const curves = [futureCurve, pastCurve];
for (const c of curves) { c.frustumCulled = false; scene.add(c); }

const timeMarkerMaterial = new THREE.ShaderMaterial({
  uniforms: { uFadeExtent: { value: X_EXTENT } },
  vertexShader: `
    uniform float uFadeExtent;
    varying float vOpacity;
    void main() {
      vec4 worldPosition = modelMatrix * vec4(position, 1.0);
      vOpacity = clamp(1.0 - abs(worldPosition.x) / uFadeExtent, 0.0, 1.0);
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      gl_PointSize = 7.0;
    }
  `,
  fragmentShader: `
    varying float vOpacity;
    void main() {
      float edge = 1.0 - smoothstep(0.34, 0.5, length(gl_PointCoord - vec2(0.5)));
      gl_FragColor = vec4(0.62, 0.82, 1.0, vOpacity * edge);
    }
  `,
  transparent: true,
  depthTest: false,
  depthWrite: false,
});
const timeMarkers = new THREE.Points(new THREE.BufferGeometry(), timeMarkerMaterial);
timeMarkers.renderOrder = 30;
timeMarkers.frustumCulled = false;
scene.add(timeMarkers);
const timeMarkerLabelContainer = document.getElementById('time-marker-labels');
const timeMarkerLabels = [];
const timeMarkerProjection = new THREE.Vector3();

// Now-point: bright core plus a pulsing additive glow sprite.
const glowTex = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  gr.addColorStop(0, 'rgba(255,255,255,1)');
  gr.addColorStop(0.15, 'rgba(120,190,255,0.8)');
  gr.addColorStop(0.5, 'rgba(47,140,255,0.25)');
  gr.addColorStop(1, 'rgba(47,140,255,0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
})();
const glow = new THREE.Sprite(new THREE.SpriteMaterial({
  map: glowTex, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false, transparent: true,
}));
scene.add(glow);
const core = new THREE.Mesh(
  new THREE.SphereGeometry(0.007, 24, 16),
  new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true }),
);
core.renderOrder = 10;
glow.renderOrder = 9;
scene.add(core);

let anchor = 0;
let yzCenter = [0, 0];
let yzScale = 1;
const toY = (y) => (y - yzCenter[0]) * yzScale;
const toZ = (z) => (z - yzCenter[1]) * yzScale;

const SAMPLES_PER_CYCLE = 12;
const MIN_VISIBLE_PX = 0.75;
const TIME_MARKER_INTERVALS = [
  1, 5, 15, 30,
  60, 300, 900, 1800,
  3600, 10800, 21600, 43200,
  86400,
];

function formatTimeMarkerLabel(time, interval) {
  const date = new Date(time * 1000);
  if (interval < 60) {
    return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
  }
  if (interval < 86400) {
    return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function buildTimeMarkers(now) {
  const desiredInterval = (2 * halfSpan) / 8;
  const interval = TIME_MARKER_INTERVALS.find((step) => step >= desiredInterval)
    ?? TIME_MARKER_INTERVALS[TIME_MARKER_INTERVALS.length - 1];
  const start = (Math.floor(now / interval) + 1) * interval;
  const end = now + halfSpan;
  const positions = [];
  timeMarkerLabels.length = 0;
  timeMarkerLabelContainer.replaceChildren();
  for (let t = start; t <= end; t += interval) {
    const p = signal(t);
    const position = new THREE.Vector3(((t - now) / halfSpan) * X_EXTENT, toY(p.y), toZ(p.z));
    positions.push(position.x, position.y, position.z);
    const element = document.createElement('div');
    element.className = 'time-marker-label';
    element.textContent = formatTimeMarkerLabel(t, interval);
    timeMarkerLabelContainer.appendChild(element);
    timeMarkerLabels.push({ element, position, time: t });
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  timeMarkers.geometry.dispose();
  timeMarkers.geometry = geometry;
}

function build(now) {
  anchor = now;
  // Coarse pass fits y/z to the visible window.
  let y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  const COARSE = 4001;
  for (let i = 0; i < COARSE; i++) {
    const s = signal(now - halfSpan + (2 * halfSpan * i) / (COARSE - 1));
    y0 = Math.min(y0, s.y); y1 = Math.max(y1, s.y);
    z0 = Math.min(z0, s.z); z1 = Math.max(z1, s.z);
  }
  yzCenter = [(y0 + y1) / 2, (z0 + z1) / 2];
  yzScale = 0.5 / (Math.max(y1 - y0, z1 - z0) / 2 * 1.08);
  yzRadius = 0;
  for (let i = 0; i < COARSE; i += 1) {
    const s = signal(now - halfSpan + (2 * halfSpan * i) / (COARSE - 1));
    yzRadius = Math.max(yzRadius, Math.hypot(toY(s.y), toZ(s.z)));
  }
  // Sample densely enough for the fastest wave that is still at least a pixel wide.
  const px = yzScale * el.clientHeight;
  let finest = PERIODS[PERIODS.length - 1];
  for (let i = 0; i < PERIODS.length; i++) {
    if (AMPLITUDES[i] * px >= MIN_VISIBLE_PX) { finest = PERIODS[i]; break; }
  }
  const window_ = halfSpan * 2.5;
  const n = Math.min(MAX_SAMPLES, Math.max(MIN_SAMPLES, Math.round((SAMPLES_PER_CYCLE * window_) / finest)));
  const t0 = now - halfSpan * 1.25, dt = window_ / (n - 1);
  const pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    pos[3 * i] = ((t0 + i * dt - now) / halfSpan) * X_EXTENT;
    const p = signal(t0 + i * dt);
    pos[3 * i + 1] = toY(p.y);
    pos[3 * i + 2] = toZ(p.z);
  }
  const geo = new LineGeometry();
  geo.setPositions(pos);
  for (const c of curves) { c.geometry.dispose(); c.geometry = geo; }
  buildTimeMarkers(now);
}

function spanLabel(h) {
  const s = 2 * h;
  if (s < 120) return `${s.toFixed(1)} s`;
  if (s < 7200) return `${(s / 60).toFixed(1)} min`;
  if (s < 172800) return `${(s / 3600).toFixed(1)} h`;
  return `${(s / 86400).toFixed(1)} days`;
}

renderer.domElement.addEventListener('wheel', (e) => {
  e.preventDefault();
  halfSpan = Math.min(MAX_HALF, Math.max(MIN_HALF, halfSpan * Math.exp(e.deltaY * 0.002)));
  build(nowSeconds());
}, { passive: false });

document.querySelectorAll('#views button[data-view]').forEach((b) =>
  b.addEventListener('click', () => setView(b.dataset.view)));

function resize() {
  const w = el.clientWidth, h = el.clientHeight;
  renderer.setSize(w, h);
  for (const m of curveMats) m.resolution.set(w, h);
  cam.aspect = w / h;
  cam.updateProjectionMatrix();
  if (activeView === 'yz') setView('yz');
}
addEventListener('resize', resize);
resize();
build(nowSeconds());
setView('yz');

function frame() {
  const now = nowSeconds();
  if (Math.abs(now - anchor) > 0.2 * halfSpan) build(now);
  const curveOffset = -((now - anchor) / halfSpan) * X_EXTENT;
  for (const c of curves) c.position.x = curveOffset;
  timeMarkers.position.x = curveOffset;
  const s = signal(now);
  glow.position.set(0, toY(s.y), toZ(s.z));
  core.position.copy(glow.position);
  const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 1000 * TAU * 0.8);
  glow.scale.setScalar(0.07 + 0.04 * pulse);
  glow.material.opacity = 0.7 + 0.3 * pulse;
  timeEl.textContent = new Date(now * 1000).toLocaleTimeString();
  spanEl.textContent = `span ${spanLabel(halfSpan)}`;
  controls.update();
  cam.updateMatrixWorld();
  const width = el.clientWidth, height = el.clientHeight;
  for (const timeMarker of timeMarkerLabels) {
    timeMarkerProjection.copy(timeMarker.position);
    timeMarkerProjection.x += curveOffset;
    timeMarkerProjection.project(cam);
    const x = (timeMarkerProjection.x * 0.5 + 0.5) * width;
    const y = (-timeMarkerProjection.y * 0.5 + 0.5) * height;
    const visible = timeMarkerProjection.z >= -1 && timeMarkerProjection.z <= 1
      && x >= 0 && x <= width && y >= 0 && y <= height;
    timeMarker.element.style.visibility = visible ? 'visible' : 'hidden';
    timeMarker.element.style.opacity = String(Math.max(0, 1 - (timeMarker.time - now) / halfSpan));
    timeMarker.element.style.left = `${x}px`;
    timeMarker.element.style.top = `${y}px`;
  }
  renderer.render(scene, cam);
  requestAnimationFrame(frame);
}
frame();

const gestureOverlayEl = document.getElementById('gesture-overlay');
const gestureHintEl = document.getElementById('gesture-hint');
const gestureHelpButton = document.getElementById('gesture-help');
const initialSplashTimeout = setTimeout(() => {
  gestureOverlayEl.classList.add('timer-dismissed');
  gestureOverlayEl.classList.add('is-hidden');
}, 3000);

const closeGestureOverlay = () => {
  gestureOverlayEl.classList.add('timer-dismissed');
  gestureOverlayEl.classList.add('is-hidden');
  gestureOverlayEl.classList.remove('manual-open');
  gestureHelpButton.setAttribute('aria-expanded', 'false');
};

document.addEventListener('click', (event) => {
  if (
    gestureOverlayEl.classList.contains('manual-open') &&
    !gestureHintEl.contains(event.target) &&
    event.target !== gestureHelpButton
  ) {
    closeGestureOverlay();
  }
});

gestureHelpButton.addEventListener('click', () => {
  if (gestureOverlayEl.classList.contains('manual-open')) {
    closeGestureOverlay();
    return;
  }
  if (!gestureOverlayEl.classList.contains('is-hidden')) {
    clearTimeout(initialSplashTimeout);
    gestureOverlayEl.classList.add('timer-dismissed');
  }
  gestureOverlayEl.classList.remove('is-hidden');
  gestureOverlayEl.classList.add('manual-open');
  gestureHelpButton.setAttribute('aria-expanded', 'true');
});
