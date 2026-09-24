// Flight Replay 3D — MapLibre satellite + terrain globe, three.js aircraft / 3D track in a custom layer.
// Data: flights/index.json + flights/<id>.json written by `./fv replay` (flightvid/replay.py), 1 Hz.
import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { drawOverlay } from './overlay.js';
import { exportVideo } from './export.js';

const maplibregl = window.maplibregl;
const FT = 0.3048;
const SPEEDS = [1, 2, 5, 10, 20, 50, 100, 200];
const TZ = 'Asia/Bangkok';
const CALLSIGN = 'NGT';
const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- state
const S = {
  index: [], flight: null, t: 0, playing: false, speed: 10, cam: 'chase',
  chaseOffset: 0, look: { yaw: 0, pitch: 0 }, lastBearing: null, smoothBearing: null,
  terrainOffset: 0, offsetTries: 0, colorBy: 'alt', dirty: true,
};

// ---------------------------------------------------------------- map
const map = new maplibregl.Map({
  container: 'map',
  center: [99.95, 12.636], zoom: 11, pitch: 60, bearing: -20, maxPitch: 88,
  centerClampedToGround: false,
  canvasContextAttributes: { antialias: true, preserveDrawingBuffer: true },   // frames are read back for video export
  attributionControl: false,
  style: {
    version: 8,
    sources: {
      sat: {
        type: 'raster', tileSize: 256, maxzoom: 19,
        tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
        attribution: 'Imagery © Esri, Maxar, Earthstar Geographics',
      },
      dem: {
        type: 'raster-dem', encoding: 'terrarium', tileSize: 256, maxzoom: 15,
        tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
        attribution: 'Terrain: Mapzen / AWS Terrain Tiles',
      },
      labels: {
        type: 'raster', tileSize: 256, maxzoom: 19,
        tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}'],
      },
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': '#1b2630' } },
      { id: 'sat', type: 'raster', source: 'sat', paint: { 'raster-saturation': 0.05, 'raster-contrast': 0.05, 'raster-fade-duration': 150 } },
      { id: 'labels', type: 'raster', source: 'labels', paint: { 'raster-opacity': 0.75 } },
    ],
    terrain: { source: 'dem', exaggeration: 1 },
    sky: {
      'sky-color': '#5d93cf', 'horizon-color': '#cfe0ef', 'fog-color': '#d6e3ee',
      'sky-horizon-blend': 0.6, 'horizon-fog-blend': 0.7, 'fog-ground-blend': 0.75, 'atmosphere-blend': 0.8,
    },
  },
});
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true, showZoom: true }), 'top-right');
map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-left');
map.addControl(new maplibregl.ScaleControl({ unit: 'nautical' }), 'bottom-left');

// ---------------------------------------------------------------- three.js scene (X east, Y north, Z up, metres)
const scene = new THREE.Scene();
const world = new THREE.Group();            // translated by the terrain offset
scene.add(world);
const camera3 = new THREE.Camera();
let renderer = null, origin = null, originK = 1;
scene.add(new THREE.HemisphereLight(0xdfefff, 0x5a5040, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 2.2);
sun.position.set(-0.4, -0.6, 1).normalize();
scene.add(sun);

const callsignMat = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
document.fonts.load('800 150px "Barlow Condensed"').finally(() => { callsignMat.map = callsignTexture(CALLSIGN); callsignMat.needsUpdate = true; });
const aircraft = buildAircraft();
world.add(aircraft);
const dropGeom = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(6), 3));
const dropLine = new THREE.Line(dropGeom, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55 }));
dropLine.frustumCulled = false;
world.add(dropLine);
const ring = new THREE.Mesh(new THREE.RingGeometry(3.2, 4.2, 40),
  new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.7, side: THREE.DoubleSide, depthWrite: false }));
ring.frustumCulled = false;
world.add(ring);
let pathPast = null, pathAll = null, wall = null;

const layer = {
  id: 'flight3d', type: 'custom', renderingMode: '3d',
  onAdd(m, gl) {
    renderer = new THREE.WebGLRenderer({ canvas: m.getCanvas(), context: gl, antialias: true });
    renderer.autoClear = false;
  },
  render(gl, args) {
    if (!origin) return;
    const m = new THREE.Matrix4().fromArray(args.defaultProjectionData.mainMatrix);
    const l = new THREE.Matrix4().makeTranslation(origin.x, origin.y, 0).scale(new THREE.Vector3(originK, -originK, originK));
    camera3.projectionMatrix = m.multiply(l);
    const px = new THREE.Vector2(map.getCanvas().clientWidth, map.getCanvas().clientHeight);   // line widths in CSS px
    for (const p of [pathPast, pathAll]) if (p) p.material.resolution.copy(px);
    renderer.resetState();
    renderer.setViewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);   // three keeps its creation-time size otherwise
    renderer.render(scene, camera3);
  },
};

// ---------------------------------------------------------------- aircraft model (DA40-ish, metres, nose +Y)
function callsignTexture(text) {
  const cv = document.createElement('canvas');
  cv.width = 512; cv.height = 160;
  const c = cv.getContext('2d');
  c.fillStyle = '#16305a';
  c.font = '800 150px "Barlow Condensed", "Arial Narrow", sans-serif';
  c.textAlign = 'center'; c.textBaseline = 'middle';
  c.fillText(text, 256, 88);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function buildAircraft() {
  const g = new THREE.Group();
  const white = new THREE.MeshLambertMaterial({ color: 0xf4f6f8 });
  const trim = new THREE.MeshLambertMaterial({ color: 0x1f3c68 });
  const glass = new THREE.MeshLambertMaterial({ color: 0x1b2a38, emissive: 0x0b1620 });
  const dark = new THREE.MeshLambertMaterial({ color: 0x222222 });
  const prof = [[0, 3.45], [0.22, 3.32], [0.5, 3.0], [0.6, 2.4], [0.64, 1.2], [0.6, 0], [0.47, -1.4], [0.3, -2.9], [0.17, -4.3], [0.06, -4.75]]
    .map(([r, y]) => new THREE.Vector2(r, y));
  const fus = new THREE.Mesh(new THREE.LatheGeometry(prof, 24), white);
  fus.scale.set(1, 1, 1.12);
  g.add(fus);
  const spinner = new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.35, 16), trim);
  spinner.position.set(0, 3.55, 0);
  g.add(spinner);
  const canopy = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), glass);
  canopy.scale.set(0.56, 1.35, 0.5);
  canopy.position.set(0, 0.55, 0.42);
  g.add(canopy);
  for (const side of [-1, 1]) {           // wings with a little dihedral + taper
    const w = new THREE.Mesh(new THREE.BoxGeometry(5.9, 1.3, 0.14), white);
    w.geometry.translate(side * 2.95, 0, 0);
    const pos = w.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) if (Math.abs(pos.getX(i)) > 5) pos.setY(i, pos.getY(i) * 0.62 - 0.1);
    w.position.set(side * 0.3, 0.45, -0.28);
    w.rotation.y = -side * 0.07;   // dihedral: tips up
    g.add(w);
    const call = new THREE.Mesh(new THREE.PlaneGeometry(2.5, 0.78), callsignMat);   // top of the wing, letters' tops toward the nose
    call.position.set(side * 3.05, -0.02, 0.13);   // clear of the skin: depth precision is coarse at map scale
    w.add(call);
    const tip = new THREE.Mesh(new THREE.SphereGeometry(0.09, 8, 8), new THREE.MeshBasicMaterial({ color: side > 0 ? 0x33ff66 : 0xff3333 }));
    tip.position.set(side * 6.2, 0.35, 0.15);
    g.add(tip);
    const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.12, 12), dark);
    wheel.rotation.z = Math.PI / 2;
    wheel.position.set(side * 1.3, 0.2, -1.05);
    g.add(wheel);
  }
  const fin = new THREE.Mesh(new THREE.BoxGeometry(0.1, 1.1, 1.5), white);
  fin.position.set(0, -4.15, 0.85);
  fin.rotation.x = -0.35;
  g.add(fin);
  const stab = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.75, 0.08), white);
  stab.position.set(0, -4.55, 1.55);
  g.add(stab);
  const stripe = new THREE.Mesh(new THREE.BoxGeometry(1.3, 3.2, 0.06), trim);
  stripe.position.set(0, -1.6, -0.05);
  stripe.scale.set(1, 1, 1);
  g.add(stripe);
  const nose = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 0.1, 12), dark);
  nose.rotation.z = Math.PI / 2;
  nose.position.set(0, 2.6, -0.95);
  g.add(nose);
  const prop = new THREE.Mesh(new THREE.CircleGeometry(0.95, 32),
    new THREE.MeshBasicMaterial({ color: 0x111111, transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false }));
  prop.rotation.x = Math.PI / 2;
  prop.position.set(0, 3.5, 0);
  g.add(prop);
  g.traverse((o) => { o.frustumCulled = false; });
  g.rotation.order = 'ZXY';
  return g;
}

// ---------------------------------------------------------------- data
async function loadIndex() {
  const r = await fetch('flights/index.json', { cache: 'no-cache' });
  const d = await r.json();
  S.index = d.flights;
  S.aerodromes = d.aerodromes || [];
  renderList();
  const want = decodeURIComponent((location.hash.match(/f=([^&]+)/) || [])[1] || '');
  const t = +((location.hash.match(/t=(\d+)/) || [])[1] || 0);
  const first = S.index.find((f) => f.id === want && f.source) || S.index.find((f) => f.source === 'ahrs') || S.index.find((f) => f.source);
  if (first) await loadFlight(first.id, t);
}

async function loadFlight(id, t = 0) {
  toast('Loading flight…');
  const r = await fetch(`flights/${encodeURIComponent(id)}.json`, { cache: 'no-cache' });
  const F = await r.json();
  prepare(F);
  S.flight = F;
  S.t = Math.min(t, F.T[F.n - 1]);
  S.playing = false;
  S.terrainOffset = 0; S.offsetTries = 0; world.position.z = 0;
  buildPath();
  document.title = `${F.lesson} · Nu's Flight`;
  drawProfile();
  markSelected();
  toast(null);
  const st = sample(S.t);
  S.chaseOffset = 0; S.smoothBearing = st.hdg; S.lastBearing = null;
  map.jumpTo({ center: [st.lon, st.lat], zoom: 15.5, pitch: 66, bearing: st.hdg, elevation: st.alt * FT });
  if (S.cam === 'free') setCam('chase');
  updateTerrainOffset();
  S.dirty = true;
  writeHash(true);
}

function prepare(F) {
  const c = F.cols, n = F.n;
  F.T = Float64Array.from(c.t);
  origin = maplibregl.MercatorCoordinate.fromLngLat([c.lon[0], c.lat[0]], 0);
  originK = origin.meterInMercatorCoordinateUnits();
  F.X = new Float64Array(n); F.Y = new Float64Array(n); F.Z = new Float64Array(n); F.G = new Float64Array(n);
  F.dist = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const m = maplibregl.MercatorCoordinate.fromLngLat([c.lon[i], c.lat[i]], 0);
    F.X[i] = (m.x - origin.x) / originK;
    F.Y[i] = (origin.y - m.y) / originK;
    F.Z[i] = c.alt[i] * FT;
    F.G[i] = (c.gnd[i] ?? c.alt[i]) * FT;
    if (i) F.dist[i] = F.dist[i - 1] + Math.max(0, c.gs[i] || 0) / 3600 * (F.T[i] - F.T[i - 1]);
  }
  // running "so far" statistics, one value per second
  F.air = new Float64Array(n); F.maxAlt = new Float64Array(n); F.maxBank = new Float64Array(n);
  F.minG = new Float64Array(n); F.maxG = new Float64Array(n); F.hrSum = new Float64Array(n); F.hrN = new Float64Array(n); F.hrMax = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const dt = i ? F.T[i] - F.T[i - 1] : 0, p = i ? i - 1 : 0, airborne = (c.alt[i] - (c.gnd[i] ?? c.alt[i])) > 60 && c.gs[i] > 45;
    F.air[i] = (i ? F.air[p] : 0) + (airborne ? dt : 0);
    F.maxAlt[i] = Math.max(i ? F.maxAlt[p] : -1e9, c.alt[i]);
    F.maxBank[i] = Math.max(i ? F.maxBank[p] : 0, airborne ? Math.abs(c.roll[i] || 0) : 0);
    F.minG[i] = Math.min(i ? F.minG[p] : 9, airborne && c.g[i] != null ? c.g[i] : 9);
    F.maxG[i] = Math.max(i ? F.maxG[p] : 0, airborne && c.g[i] != null ? c.g[i] : 0);
    F.hrSum[i] = (i ? F.hrSum[p] : 0) + (c.hr[i] ?? 0); F.hrN[i] = (i ? F.hrN[p] : 0) + (c.hr[i] != null ? 1 : 0);
    F.hrMax[i] = Math.max(i ? F.hrMax[p] : 0, c.hr[i] ?? 0);
  }
  if (c.ias) {
    F.maxIas = new Float64Array(n);
    for (let i = 0; i < n; i++) F.maxIas[i] = Math.max(i ? F.maxIas[i - 1] : 0, c.ias[i] ?? 0);
  }
  F.xc = /XC|XV/.test(`${F.kind} ${F.lesson}`);
  F.t0ms = Date.parse(F.t0);
  F.takeoffs = F.events.filter((e) => e.type === 'takeoff').map((e) => e.t);
  F.landings = F.events.filter((e) => e.type === 'landing').map((e) => e.t);
  let lo = Infinity, hi = -Infinity, la = Infinity, ha = -Infinity;
  c.lon.forEach((v) => { lo = Math.min(lo, v); hi = Math.max(hi, v); });
  c.lat.forEach((v) => { la = Math.min(la, v); ha = Math.max(ha, v); });
  F.bounds = [[lo, la], [hi, ha]];
}

// ---------------------------------------------------------------- 3D path
const RAMPS = {
  alt: [[0, '#2f7dff'], [0.35, '#27d3c3'], [0.6, '#9be15d'], [0.8, '#ffd23f'], [1, '#ff4fd8']],
  gs: [[0, '#5b6cff'], [0.5, '#2fe0b5'], [0.8, '#ffe14f'], [1, '#ff5a3c']],
  vs: [[0, '#3aa0ff'], [0.45, '#e8eef2'], [0.55, '#e8eef2'], [1, '#ff7a3c']],
  hr: [[0, '#62e3a1'], [0.5, '#ffd84f'], [1, '#ff4a4a']],
};
function rampColor(ramp, x) {
  x = Math.min(1, Math.max(0, x));
  for (let i = 1; i < ramp.length; i++) {
    if (x <= ramp[i][0]) {
      const [a, ca] = ramp[i - 1], [b, cb] = ramp[i];
      return new THREE.Color(ca).lerp(new THREE.Color(cb), (x - a) / (b - a || 1));
    }
  }
  return new THREE.Color(ramp[ramp.length - 1][1]);
}
function pathColors(F) {
  const c = F.cols, n = F.n, out = new Float32Array(n * 3);
  const key = S.colorBy;
  let val, lo, hi;
  if (key === 'alt') { val = (i) => c.alt[i]; lo = Math.min(...c.gnd.filter((v) => v != null)); hi = Math.max(lo + 1500, F.summary.max_alt_ft); }
  else if (key === 'gs') { val = (i) => c.gs[i]; lo = 0; hi = Math.max(130, F.summary.max_gs_kt); }
  else if (key === 'vs') { val = (i) => c.vs[i]; lo = -1000; hi = 1000; }
  else if (key === 'hr') { val = (i) => c.hr[i]; const h = c.hr.filter((v) => v != null); lo = h.length ? Math.min(...h) : 60; hi = h.length ? Math.max(...h) : 140; }
  const plain = new THREE.Color('#e24bd0');
  for (let i = 0; i < n; i++) {
    const v = val ? val(i) : null;
    const col = v == null ? plain : rampColor(RAMPS[key], (v - lo) / (hi - lo || 1));
    out.set([col.r, col.g, col.b], i * 3);
  }
  return out;
}

function buildPath() {
  const F = S.flight;
  for (const o of [pathPast, pathAll, wall]) if (o) { world.remove(o); o.geometry.dispose(); o.material.dispose(); }
  const pos = new Float32Array(F.n * 3);
  for (let i = 0; i < F.n; i++) pos.set([F.X[i], F.Y[i], F.Z[i]], i * 3);
  const cols = pathColors(F);

  const gAll = new LineGeometry(); gAll.setPositions(pos);
  pathAll = new Line2(gAll, new LineMaterial({ color: 0xffffff, linewidth: 1.5, transparent: true, opacity: 0.28, depthWrite: false }));
  const gPast = new LineGeometry(); gPast.setPositions(pos); gPast.setColors(cols);
  pathPast = new Line2(gPast, new LineMaterial({ vertexColors: true, linewidth: 3.2, transparent: true, opacity: 0.98 }));

  // curtain from the track down to the ground (Google-Earth "extrude"): 2 triangles per second
  const wp = new Float32Array((F.n - 1) * 18), wc = new Float32Array((F.n - 1) * 24);
  for (let i = 0; i < F.n - 1; i++) {
    const a = [F.X[i], F.Y[i], F.Z[i]], b = [F.X[i + 1], F.Y[i + 1], F.Z[i + 1]];
    const a0 = [F.X[i], F.Y[i], F.G[i] - 25], b0 = [F.X[i + 1], F.Y[i + 1], F.G[i + 1] - 25];
    wp.set([...a, ...a0, ...b, ...a0, ...b0, ...b], i * 18);
    const ca = [cols[i * 3], cols[i * 3 + 1], cols[i * 3 + 2]], cb = [cols[i * 3 + 3], cols[i * 3 + 4], cols[i * 3 + 5]];
    const top = 0.32, bot = 0.04;
    wc.set([...ca, top, ...ca, bot, ...cb, top, ...ca, bot, ...cb, bot, ...cb, top], i * 24);
  }
  const wg = new THREE.BufferGeometry();
  wg.setAttribute('position', new THREE.BufferAttribute(wp, 3));
  wg.setAttribute('color', new THREE.BufferAttribute(wc, 4));
  wall = new THREE.Mesh(wg, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, side: THREE.DoubleSide, depthWrite: false }));

  for (const o of [wall, pathAll, pathPast]) { o.frustumCulled = false; world.add(o); }
  pathAll.renderOrder = 1; wall.renderOrder = 2; pathPast.renderOrder = 3; aircraft.renderOrder = 4;
}

// ---------------------------------------------------------------- sampling (Catmull-Rom position, linear rest)
function idxAt(t) {
  const T = S.flight.T;
  let lo = 0, hi = T.length - 1;
  if (t <= T[0]) return 0;
  if (t >= T[hi]) return hi - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (T[m] <= t) lo = m; else hi = m; }
  return lo;
}
const cr = (p0, p1, p2, p3, u) => 0.5 * ((2 * p1) + (-p0 + p2) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u * u + (-p0 + 3 * p1 - 3 * p2 + p3) * u * u * u);
const lerp = (a, b, u) => (a == null || b == null ? (a ?? b) : a + (b - a) * u);
const alerp = (a, b, u) => { const d = ((b - a + 540) % 360) - 180; return (a + d * u + 360) % 360; };

function sample(t) {
  const F = S.flight, c = F.cols, n = F.n;
  const i = idxAt(t), j = Math.min(i + 1, n - 1);
  const span = F.T[j] - F.T[i] || 1;
  const u = Math.min(1, Math.max(0, (t - F.T[i]) / span));
  const i0 = Math.max(0, i - 1), i3 = Math.min(n - 1, j + 1);
  const P = (A) => cr(A[i0], A[i], A[j], A[i3], u);
  const x = P(F.X), y = P(F.Y), z = P(F.Z);
  const m = new maplibregl.MercatorCoordinate(origin.x + x * originK, origin.y - y * originK, 0).toLngLat();
  return {
    i, u, x, y, z, lon: m.lng, lat: m.lat, alt: z / FT, gnd: lerp(F.G[i], F.G[j], u) / FT,
    gs: lerp(c.gs[i], c.gs[j], u), vs: lerp(c.vs[i], c.vs[j], u), trk: alerp(c.trk[i], c.trk[j], u), hdg: alerp(c.hdg[i], c.hdg[j], u),
    pitch: lerp(c.pitch[i], c.pitch[j], u), roll: lerp(c.roll[i], c.roll[j], u), g: lerp(c.g[i], c.g[j], u),
    hr: lerp(c.hr[i], c.hr[j], u), dist: lerp(F.dist[i], F.dist[j], u),
    ias: c.ias && lerp(c.ias[i], c.ias[j], u), tas: c.tas && lerp(c.tas[i], c.tas[j], u),
    oat: c.oat && lerp(c.oat[i], c.oat[j], u), rpm: c.rpm && lerp(c.rpm[i], c.rpm[j], u),
    wind: c.wind && lerp(c.wind[i], c.wind[j], u),
    windfrom: c.windfrom && alerp(c.windfrom[i], c.windfrom[j], u),
    fuel: c.fuel && lerp(c.fuel[i], c.fuel[j], u),
  };
}

function phaseAt(t, s) {
  const F = S.flight;
  const agl = s.alt - s.gnd;
  const k = F.takeoffs.filter((x) => x <= t).length;
  if (agl > 60 && s.gs > 45) {
    const what = s.vs > 300 ? 'Climb' : s.vs < -300 ? 'Descent' : 'Level';
    const word = F.xc ? 'Leg' : 'Circuit';
    return F.takeoffs.length > 1 || F.xc ? `${word} ${k || 1} · ${what}` : what;
  }
  if (s.gs < 3) return 'Parked';
  const next = F.takeoffs.find((x) => x > t);
  if (next != null && next - t <= 60 && s.gs >= 30) return 'Takeoff roll';
  const last = [...F.landings].reverse().find((x) => x <= t);
  if (last != null && t - last <= 60 && s.gs >= 30) return 'Landing roll';
  return 'Taxi';
}

// ---------------------------------------------------------------- terrain alignment
// GPS altitude and the terrain model disagree by a few metres: align the parked start to the map's ground.
function updateTerrainOffset() {
  if (!S.flight || S.offsetTries > 3 || !map.getSource('dem') || !map.isSourceLoaded('dem')) return;
  const c = S.flight.cols;
  const e = map.queryTerrainElevation([c.lon[0], c.lat[0]]);
  if (e == null || !map.getBounds().contains([c.lon[0], c.lat[0]])) return;   // only once the start's tile is in view
  S.terrainOffset = e - S.flight.Z[0] + 0.9;       // wheels on the ground
  if (Math.abs(S.terrainOffset) > 150) S.terrainOffset = 0;   // implausible → trust GPS
  world.position.z = S.terrainOffset;
  S.offsetTries++;
  S.dirty = true;
}
map.on('idle', updateTerrainOffset);
setInterval(updateTerrainOffset, 1500);   // follow modes redraw constantly while playing, so 'idle' can be rare

// ---------------------------------------------------------------- per-frame update
function metersPerPixel(lat, zoom) { return 40075016.686 * Math.cos(lat * Math.PI / 180) / (512 * 2 ** zoom); }

function frame(s) {
  const F = S.flight;
  aircraft.position.set(s.x, s.y, s.z);
  aircraft.rotation.set((s.pitch || 0) * Math.PI / 180, (s.roll || 0) * Math.PI / 180, -s.hdg * Math.PI / 180, 'ZXY');
  const scale = Math.max(1, 44 * metersPerPixel(s.lat, map.getZoom()) / 12);   // never smaller than ~44 px on screen
  aircraft.scale.setScalar(scale);
  aircraft.visible = S.cam !== 'cockpit';

  const terr = map.queryTerrainElevation([s.lon, s.lat]);
  const gz = (terr != null ? terr : S.terrainOffset + s.gnd * FT) - S.terrainOffset;
  S.aglNow = terr != null ? (s.z - gz) / FT : null;   // height over the map's DEM, for sources without terrain
  const air = s.z - gz > 15;
  dropLine.visible = ring.visible = air && S.cam !== 'cockpit';
  const dp = dropGeom.attributes.position;
  dp.setXYZ(0, s.x, s.y, s.z); dp.setXYZ(1, s.x, s.y, gz + 0.3); dp.needsUpdate = true;
  ring.position.set(s.x, s.y, gz + 0.5);
  ring.scale.setScalar(scale);

  // in the cockpit the last seconds of track pass through the eye point and smear across the view
  const shown = Math.max(0, s.i + (s.u > 0 ? 1 : 0) - (S.cam === 'cockpit' ? 6 : 0));
  if (pathPast) pathPast.geometry.instanceCount = shown;
  if (wall) wall.geometry.setDrawRange(0, shown * 6);
  if (pathAll) pathAll.visible = S.cam !== 'cockpit';
  if (wall) wall.visible = S.cam !== 'cockpit';   // from the seat the curtain is a wall across the windscreen
}

function camera(s, dt) {
  const worldAlt = s.z + S.terrainOffset;
  if (S.cam === 'free') return;
  if (S.cam === 'cockpit') {
    const hdg = s.hdg + S.look.yaw, pit = (s.pitch || 0) + S.look.pitch;
    const eye = new maplibregl.MercatorCoordinate(origin.x + s.x * originK, origin.y - s.y * originK, 0).toLngLat();
    const d = 400, h = hdg * Math.PI / 180;
    const ax = s.x + Math.sin(h) * d, ay = s.y + Math.cos(h) * d;
    const tgt = new maplibregl.MercatorCoordinate(origin.x + ax * originK, origin.y - ay * originK, 0).toLngLat();
    const opts = map.calculateCameraOptionsFromTo(eye, worldAlt + 1.2, tgt, worldAlt + 1.2 + Math.tan(pit * Math.PI / 180) * d);
    opts.roll = s.roll || 0;   // camera rolls with the wings: left bank → horizon tilts clockwise, like the ADI
    map.jumpTo(opts);
    return;
  }
  let bearing = map.getBearing();
  if (S.cam === 'chase') {
    // user rotation since last frame (mouse, touch, compass) becomes an offset behind the aircraft
    if (S.lastBearing != null) S.chaseOffset += ((bearing - S.lastBearing + 540) % 360) - 180;
    const target = s.hdg;
    const k = 1 - Math.exp(-dt * 2.2);
    const d = ((target - S.smoothBearing + 540) % 360) - 180;
    S.smoothBearing = (S.smoothBearing + d * k + 360) % 360;
    bearing = S.smoothBearing + S.chaseOffset;
  }
  map.jumpTo({ center: [s.lon, s.lat], elevation: worldAlt, bearing, roll: 0 });
  S.lastBearing = map.getBearing();
}

// ---------------------------------------------------------------- overlay (live + export)
const AD = (icao) => S.aerodromes.find((a) => a.icao === icao);
function nmBetween(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180, dlat = (lat2 - lat1) * r, dlon = (lon2 - lon1) * r;
  const h = Math.sin(dlat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dlon / 2) ** 2;
  return 2 * 3440.065 * Math.asin(Math.sqrt(h));
}
function bearingTo(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180, y = Math.sin((lon2 - lon1) * r) * Math.cos(lat2 * r);
  const x = Math.cos(lat1 * r) * Math.sin(lat2 * r) - Math.sin(lat1 * r) * Math.cos(lat2 * r) * Math.cos((lon2 - lon1) * r);
  return (Math.atan2(y, x) / r + 360) % 360;
}
const hm = (sec) => `${Math.floor(sec / 3600)}:${String(Math.floor(sec / 60) % 60).padStart(2, '0')}`;

// where am I: leg (from → to, distance, ETE) in the air; nearest aerodrome on the ground / in the circuit
function place(t, s) {
  const F = S.flight, airborne = s.alt - s.gnd > 60 && s.gs > 45;
  const nearest = S.aerodromes.map((a) => ({ a, d: nmBetween(s.lat, s.lon, a.lat, a.lon) })).sort((x, y) => x.d - y.d)[0];
  if (airborne) {
    const tos = F.events.filter((e) => e.type === 'takeoff' && e.t <= t);
    const from = tos.length ? tos[tos.length - 1].ad : F.home;
    const next = F.events.find((e) => e.type === 'landing' && e.t > t);
    const to = next?.ad;
    const dest = to && AD(to);
    if (F.xc && dest && to !== from) {
      const d = nmBetween(s.lat, s.lon, dest.lat, dest.lon);
      const ete = s.gs > 30 ? d / s.gs * 3600 : null;
      return { text: `LEG ${tos.length}  ·  ${from || '—'} → ${to}  ·  ${d.toFixed(1)} NM${ete ? '  ·  ETE ' + hm(ete) : ''}`,
        brg: bearingTo(s.lat, s.lon, dest.lat, dest.lon), brgLabel: `${to} ${d.toFixed(1)}NM` };
    }
    const ref = dest || (from && AD(from)) || nearest?.a;
    if (!ref) return { text: '' };
    const d = nmBetween(s.lat, s.lon, ref.lat, ref.lon);
    return { text: `${ref.icao} · ${ref.city.toUpperCase()}  ·  ${d.toFixed(1)} NM`, brg: bearingTo(s.lat, s.lon, ref.lat, ref.lon), brgLabel: `${ref.icao} ${d.toFixed(1)}NM` };
  }
  if (nearest && nearest.d < 4) return { text: `${nearest.a.icao} · ${nearest.a.city.toUpperCase()}`, legColor: '#9aa7b6' };
  return { text: nearest ? `${nearest.d.toFixed(0)} NM from ${nearest.a.icao}` : '', legColor: '#9aa7b6' };
}

function overlayState(s) {
  const F = S.flight, t = S.t, end = F.T[F.n - 1], i = Math.min(F.n - 1, s.i + (s.u > 0.5 ? 1 : 0));
  const [yy, mm, dd] = F.date.split('-');
  const d = `${dd} ${'JAN FEB MAR APR MAY JUN JUL AUG SEP OCT NOV DEC'.split(' ')[+mm - 1]} ${yy}`;
  const pl = place(t, s);
  const hrHist = [];
  for (let tt = Math.max(0, t - 900); tt <= t; tt += 20) { const v = sample(tt).hr; if (v != null) hrHist.push(v); }
  const tos = F.takeoffs.filter((x) => x <= t).length, lds = F.landings.filter((x) => x <= t).length;
  const ahrs = F.attitude === 'ahrs' || F.attitude === 'g1000';
  const stats = [
    ['ELAPSED', `${hms(t)} / ${hms(end)}`, ''],
    ['AIRBORNE', hm(F.air[i]), 'H:MM'],
    ['DISTANCE', F.dist[i].toFixed(1), 'NM'],
    ['T/O · LDG', `${tos}/${F.takeoffs.length} · ${lds}/${F.landings.length}`, ''],
    ['MAX ALT', String(Math.round(F.maxAlt[i] / 10) * 10), 'FT'],
    ['MAX BANK', F.maxBank[i].toFixed(0), '°'],
  ];
  if (ahrs && F.maxG[i] > 0) stats.push(['LOAD', `${F.minG[i].toFixed(2)} – ${F.maxG[i].toFixed(2)}`, 'G']);
  if (F.cols.ias) stats.push(['MAX IAS', String(Math.round(F.maxIas[i])), 'KT']);
  if (F.cols.fuel) stats.push(['FUEL USED', (F.cols.fuel[0] - F.cols.fuel[i]).toFixed(1), 'GAL']);
  if (F.hrN[i]) stats.push(['HR AVG · MAX', `${Math.round(F.hrSum[i] / F.hrN[i])} · ${Math.round(F.hrMax[i])}`, 'BPM']);
  const up = F.kind ? F.kind.toUpperCase() : '';
  return {
    hasPos: true,
    title: `${d}  ·  ${CALLSIGN}  ·  ${F.tail}  ·  DA40  ·  ${F.home || 'VTPH'}`,
    lesson: `${F.lesson} · ${up}`, phase: phaseAt(t, s).toUpperCase(),
    place: pl.text, legColor: pl.legColor, brg: pl.brg, brgLabel: pl.brgLabel,
    lcl: clock(t), utc: new Date(F.t0ms + t * 1000).toISOString().slice(11, 19) + 'Z',
    hr: s.hr, hrHist,
    gs: s.gs || 0, alt: s.alt, vs: s.vs || 0,
    agl: F.agl === 'terrain' ? s.alt - s.gnd : (S.aglNow ?? s.alt - s.gnd),
    aglValid: F.agl === 'terrain' || S.aglNow != null,
    ias: s.ias, tas: s.tas, oat: s.oat, wind: s.wind, windFrom: s.windfrom, rpm: s.rpm,
    hdg: s.hdg, trk: s.trk, pitch: s.pitch || 0, roll: s.roll || 0, g: ahrs ? s.g : null, attEst: !ahrs,
    gsTrend: s.ias != null ? ((sample(t + 3).ias ?? 0) - (sample(Math.max(0, t - 3)).ias ?? 0))
      : ((sample(t + 3).gs ?? 0) - (sample(Math.max(0, t - 3)).gs ?? 0)), altTrend: (s.vs || 0) / 10,
    stats, statsNote: 'SO FAR',
  };
}

const ov = $('ov'), octx = ov.getContext('2d');
function overlayRect() {
  const phone = window.innerWidth < 900;
  const left = document.body.classList.contains('list-open') && !phone ? 324 : 0;
  const bottom = phone ? 150 : 150;
  return { x: left, y: 0, w: window.innerWidth - left, h: window.innerHeight - bottom, compact: phone };
}
function drawLive(s) {
  const dpr = Math.min(2, window.devicePixelRatio || 1), W = window.innerWidth, H = window.innerHeight;
  if (ov.width !== Math.round(W * dpr) || ov.height !== Math.round(H * dpr)) { ov.width = Math.round(W * dpr); ov.height = Math.round(H * dpr); }
  octx.setTransform(dpr, 0, 0, dpr, 0, 0);
  octx.clearRect(0, 0, W, H);
  const r = overlayRect();
  drawOverlay(octx, r, overlayState(s), { compact: r.compact });
  $('tl-now').textContent = hms(S.t);
}
window.addEventListener('resize', () => { S.dirty = true; });
document.fonts.ready.then(() => { S.dirty = true; });

function loop(now) {
  const dt = Math.min(0.1, (now - (loop.last || now)) / 1000);
  loop.last = now;
  if (S.flight) {
    const end = S.flight.T[S.flight.n - 1];
    if (S.playing && !S.exporting) {
      S.t = Math.min(end, S.t + dt * S.speed);
      if (S.t >= end) setPlaying(false);
      S.dirty = true;
    }
    if (S.dirty && !S.exporting) {
      const s = sample(S.t);
      frame(s);
      camera(s, dt);
      drawLive(s);
      drawCursor();
      map.triggerRepaint();
      if (S.dirty && !S.playing) writeHash();
      S.dirty = false;
    }
  }
  requestAnimationFrame(loop);
}

// ---------------------------------------------------------------- timeline
const tl = $('timeline'), tctx = tl.getContext('2d');
let profile = null;
function drawProfile() {
  const F = S.flight;
  if (!F) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const W = tl.clientWidth, H = tl.clientHeight;
  tl.width = W * dpr; tl.height = H * dpr;
  profile = document.createElement('canvas');
  profile.width = tl.width; profile.height = tl.height;
  const c = profile.getContext('2d');
  c.scale(dpr, dpr);
  const end = F.T[F.n - 1], c0 = F.cols;
  const minA = Math.min(...c0.gnd.filter((v) => v != null)) - 50, maxA = Math.max(F.summary.max_alt_ft, minA + 1000);
  const X = (t) => (t / end) * W, Y = (a) => H - 6 - ((a - minA) / (maxA - minA)) * (H - 22);
  const step = Math.max(1, Math.floor(F.n / (W * 2)));
  const path = (key) => { c.beginPath(); c.moveTo(0, H); for (let i = 0; i < F.n; i += step) c.lineTo(X(F.T[i]), Y(c0[key][i] ?? minA)); c.lineTo(W, H); c.closePath(); };
  path('alt'); c.fillStyle = 'rgba(69, 211, 230, 0.20)'; c.fill();
  c.beginPath(); for (let i = 0; i < F.n; i += step) c.lineTo(X(F.T[i]), Y(c0.alt[i])); c.strokeStyle = 'rgba(69, 211, 230, 0.9)'; c.lineWidth = 1.2; c.stroke();
  path('gnd'); c.fillStyle = 'rgba(122, 90, 60, 0.55)'; c.fill();
  // local-time ticks every 15 min
  c.font = '500 10px "JetBrains Mono", monospace'; c.fillStyle = 'rgba(147,164,177,.8)'; c.textBaseline = 'top';
  const every = [5, 10, 15, 30, 60].find((m) => (m * 60 / end) * W >= 64) || 120;   // label spacing ≥ 64 px
  const firstQ = Math.ceil(F.t0ms / (every * 60000)) * every * 60000;
  for (let ms = firstQ; ms < F.t0ms + end * 1000; ms += every * 60000) {
    const x = X((ms - F.t0ms) / 1000);
    c.fillRect(x, H - 5, 1, 5);
    if (x > 8 && x < W - 150) c.fillText(clock((ms - F.t0ms) / 1000).slice(0, 5), x + 3, 3);
  }
  for (const e of F.events) {
    const x = X(e.t);
    c.fillStyle = e.type === 'takeoff' ? '#58d68d' : '#f3b63f';
    c.fillRect(x - 0.5, 14, 1.5, H - 14);
    c.beginPath(); c.moveTo(x, 14); c.lineTo(x - 3.5, 8); c.lineTo(x + 3.5, 8); c.fill();
  }
  $('tl-end').textContent = '/ ' + hms(end);
  drawCursor();
}
function drawCursor() {
  if (!profile || !S.flight || !profile.width || !profile.height) return;
  const dpr = profile.width / (tl.clientWidth || 1);
  tctx.setTransform(1, 0, 0, 1, 0, 0);
  tctx.clearRect(0, 0, tl.width, tl.height);
  tctx.drawImage(profile, 0, 0);
  const x = (S.t / S.flight.T[S.flight.n - 1]) * tl.width;
  tctx.fillStyle = 'rgba(9,14,19,.45)'; tctx.fillRect(x, 0, tl.width - x, tl.height);
  tctx.fillStyle = '#fff'; tctx.fillRect(x - dpr, 0, 2 * dpr, tl.height);
}
function scrubTo(ev) {
  const r = tl.getBoundingClientRect();
  const u = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width));
  S.t = u * S.flight.T[S.flight.n - 1];
  S.dirty = true;
}
tl.addEventListener('pointerdown', (e) => { if (!S.flight) return; tl.setPointerCapture(e.pointerId); scrubTo(e); });
tl.addEventListener('pointermove', (e) => { if (tl.hasPointerCapture(e.pointerId)) scrubTo(e); });
new ResizeObserver(() => drawProfile()).observe(tl);

// ---------------------------------------------------------------- camera controls
function setCam(mode) {
  S.cam = mode;
  document.querySelectorAll('#cams [data-cam]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.cam === mode)));
  const follow = mode !== 'free';
  if (follow) { map.dragPan.disable(); map.scrollZoom.enable({ around: 'center' }); map.touchZoomRotate.enable({ around: 'center' }); }
  else { map.dragPan.enable(); map.scrollZoom.enable(); map.touchZoomRotate.enable(); }
  map.setVerticalFieldOfView(mode === 'cockpit' ? 58 : 36.87);   // wider, windscreen-like view from the seat
  if (mode === 'cockpit') { map.scrollZoom.disable(); map.touchZoomRotate.disable(); map.dragRotate.disable(); map.touchPitch.disable(); S.look = { yaw: 0, pitch: 0 }; }
  else { map.dragRotate.enable(); map.touchPitch.enable(); }
  if (mode === 'chase' && S.flight) { S.chaseOffset = 0; S.smoothBearing = sample(S.t).hdg; S.lastBearing = null; map.jumpTo({ pitch: 68, zoom: Math.max(map.getZoom(), 13) }); }
  if (mode === 'follow' || mode === 'chase') map.jumpTo({ roll: 0 });
  if (mode === 'free') map.jumpTo({ roll: 0 });
  S.dirty = true;
}
document.querySelectorAll('#cams [data-cam]').forEach((b) => b.addEventListener('click', () => setCam(b.dataset.cam)));
$('overview').addEventListener('click', overview);
function overview() {
  if (!S.flight) return;
  setCam('free');
  const phone = window.innerWidth < 900, list = document.body.classList.contains('list-open') && !phone;
  const padding = phone ? { top: 80, bottom: 150, left: 30, right: 120 }
    : { top: 130, bottom: 110, left: (list ? 330 : 0) + 60, right: 560 };   // keep the track clear of the panels
  const cam = map.cameraForBounds(S.flight.bounds, { padding });
  map.flyTo({ ...cam, pitch: 55, bearing: map.getBearing(), elevation: 0, duration: 1600 });
}

// one-finger / left-button drag orbits the aircraft in follow modes (dragPan is off there)
{
  const el = map.getCanvasContainer();
  let drag = null;
  el.addEventListener('pointerdown', (e) => {
    if (S.cam === 'free' || e.button !== 0 || e.ctrlKey || e.metaKey) return;
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, n: 0 };
  });
  window.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    drag.x = e.clientX; drag.y = e.clientY;
    if (S.cam === 'cockpit') {
      S.look.yaw = (S.look.yaw - dx * 0.25) % 360;
      S.look.pitch = Math.max(-60, Math.min(45, S.look.pitch + dy * 0.2));
    } else {
      map.jumpTo({ bearing: map.getBearing() - dx * 0.35, pitch: Math.max(0, Math.min(86, map.getPitch() - dy * 0.25)) });
    }
    S.dirty = true;
  });
  map.on('zoom', () => { S.dirty = true; });   // aircraft keeps its minimum on-screen size
  const end = (e) => { if (drag && e.pointerId === drag.id) drag = null; };
  window.addEventListener('pointerup', end);
  window.addEventListener('pointercancel', end);
  el.addEventListener('touchstart', (e) => { if (e.touches.length > 1) drag = null; }, { passive: true });
  el.addEventListener('dblclick', () => { if (S.cam === 'cockpit') S.look = { yaw: 0, pitch: 0 }; });
}

// ---------------------------------------------------------------- playback controls
function setPlaying(p) {
  if (p && S.flight && S.t >= S.flight.T[S.flight.n - 1] - 0.5) S.t = 0;
  S.playing = p;
  const b = $('play');
  b.textContent = p ? '❚❚' : '▶';
  b.classList.toggle('playing', p);
  b.setAttribute('aria-label', p ? 'Pause' : 'Play');
  if (!p) writeHash(true);
}
function setSpeed(k) {
  const i = Math.max(0, Math.min(SPEEDS.length - 1, SPEEDS.indexOf(S.speed) + k));
  S.speed = SPEEDS[i];
  $('speed').textContent = S.speed + '×';
}
$('play').addEventListener('click', () => setPlaying(!S.playing));
$('slower').addEventListener('click', () => setSpeed(-1));
$('faster').addEventListener('click', () => setSpeed(1));
$('colorby').addEventListener('change', (e) => { S.colorBy = e.target.value; if (S.flight) buildPath(); S.dirty = true; });
window.addEventListener('keydown', (e) => {
  if (e.target.matches('input, select')) return;
  const k = e.key;
  if (k === ' ') { e.preventDefault(); setPlaying(!S.playing); }
  else if (k === 'ArrowRight' || k === 'ArrowLeft') {
    const step = (e.shiftKey ? 60 : 10) * (k === 'ArrowRight' ? 1 : -1);
    S.t = Math.max(0, Math.min(S.flight.T[S.flight.n - 1], S.t + step)); S.dirty = true; e.preventDefault();
  }
  else if (k === ']') setSpeed(1);
  else if (k === '[') setSpeed(-1);
  else if (k === '1') setCam('chase');
  else if (k === '2') setCam('follow');
  else if (k === '3') setCam('cockpit');
  else if (k === '4') setCam('free');
  else if (k === 'o' || k === 'O') overview();
  else if (k === 'f' || k === 'F') toggleList();
  else if (k === 'n' || k === 'N') jumpEvent(1);
  else if (k === 'p' || k === 'P') jumpEvent(-1);
});
function jumpEvent(dir) {
  const ev = S.flight.events.map((e) => e.t - 20);
  const t = dir > 0 ? ev.find((x) => x > S.t + 1) : [...ev].reverse().find((x) => x < S.t - 1);
  if (t != null) { S.t = Math.max(0, t); S.dirty = true; }
}

// ---------------------------------------------------------------- flight list
function toggleList(force) {
  document.body.classList.toggle('list-open', force ?? !document.body.classList.contains('list-open'));
  S.dirty = true;
  setTimeout(() => { map.resize(); drawProfile(); S.dirty = true; }, 280);
}
$('list-open').addEventListener('click', () => toggleList());
$('list-close').addEventListener('click', () => toggleList(false));
$('search').addEventListener('input', renderList);

const BADGE = { g1000: 'G1000', ahrs: 'AHRS', gps: 'GPS', track15: '15 s', null: 'no track' };
function renderList() {
  const q = $('search').value.trim().toLowerCase();
  const box = $('flights');
  box.textContent = '';
  let month = null;
  for (const f of S.index) {
    const hay = `${f.lesson} ${f.tail} ${f.date} ${f.kind} ${f.instructor || ''}`.toLowerCase();
    if (q && !hay.includes(q)) continue;
    const d = new Date(f.date + 'T00:00:00');
    const m = d.toLocaleString('en-GB', { month: 'long', year: 'numeric' });
    if (m !== month) { month = m; const h = document.createElement('div'); h.className = 'month'; h.textContent = m; box.append(h); }
    const b = document.createElement('button');
    b.className = 'fl'; b.dataset.id = f.id; b.setAttribute('role', 'option');
    b.disabled = !f.source;
    const dur = f.summary ? `${Math.floor(f.summary.airborne_min / 60)}:${String(Math.round(f.summary.airborne_min % 60)).padStart(2, '0')}` : '';
    b.innerHTML = `<span class="fl-day">${d.getDate()}<small>${d.toLocaleString('en-GB', { weekday: 'short' })}</small></span>
      <span class="fl-lesson"></span>
      <span class="fl-right"><span class="badge ${f.source || 'none'}">${BADGE[f.source] || 'no track'}</span><span class="fl-dur">${dur}</span></span>
      <span class="fl-meta"></span>`;
    b.querySelector('.fl-lesson').textContent = f.lesson;
    b.querySelector('.fl-meta').textContent = `${f.kind} · ${f.tail}${f.summary ? ` · ${f.summary.landings} ldg · ${Math.round(f.summary.distance_nm)} nm` : ''}`;
    b.title = f.source ? `${f.lesson} — airborne ${dur}` : 'No position data for this flight (before Spidertracks / no Garmin GPS)';
    b.addEventListener('click', () => { loadFlight(f.id); if (window.innerWidth < 900) toggleList(false); });
    box.append(b);
  }
  const have = S.index.filter((f) => f.source).length;
  const measured = S.index.filter((f) => f.attitude === 'ahrs' || f.attitude === 'g1000').length;
  const panel = S.index.filter((f) => f.source === 'g1000').length;
  $('list-foot').innerHTML = `<b>${have}</b> of ${S.index.length} flights have a track · <b>${measured}</b> with measured attitude` +
    (panel ? ` (<b>${panel}</b> from the aircraft's G1000 log)` : '') + `. GPS / 15 s tracks show estimated attitude.`;
  markSelected();
}
function markSelected() {
  document.querySelectorAll('.fl').forEach((b) => b.setAttribute('aria-selected', String(S.flight && b.dataset.id === S.flight.id)));
}
const titleCase = (s) => s.toLowerCase().replace(/\b\w/g, (m) => m.toUpperCase());

// ---------------------------------------------------------------- utils
function clock(t) {
  return new Date(S.flight.t0ms + t * 1000).toLocaleTimeString('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
function hms(t) {
  t = Math.max(0, Math.round(t));
  const h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, s = t % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0');
}
let hashTimer = 0;
function writeHash(now) {
  clearTimeout(hashTimer);
  const go = () => S.flight && history.replaceState(null, '', `#f=${encodeURIComponent(S.flight.id)}&t=${Math.round(S.t)}`);
  if (now) go(); else hashTimer = setTimeout(go, 400);
}
function toast(msg) { const t = $('toast'); t.hidden = !msg; if (msg) t.textContent = msg; }

// ---------------------------------------------------------------- boot
if (window.innerWidth >= 900) document.body.classList.add('list-open');
setSpeed(0);
setCam('chase');
map.on('style.load', () => {
  map.addLayer(layer);
  if (window.innerWidth < 900) document.querySelector('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show');
});   // earlier than 'load', which waits for the first tiles
loadIndex().catch((e) => { toast('Could not load flights — run ./fv replay to build them.'); console.error(e); });
requestAnimationFrame(loop);
map.on('error', (e) => console.warn(e.error?.message || e));
window.replay = { S, map, aircraft, sample, setCam };   // console debugging

// ---------------------------------------------------------------- video export
$('export-open').addEventListener('click', () => {
  if (!S.flight) return;
  setPlaying(false);
  $('x-speed').value = String(S.speed);
  updateExportEstimate();
  $('export').showModal();
});
for (const id of ['x-speed', 'x-range', 'x-res', 'x-fps']) $(id).addEventListener('change', updateExportEstimate);
function exportRange() {
  const end = S.flight.T[S.flight.n - 1], v = $('x-range').value;
  if (v === 'all') return [0, end];
  if (v === 'rest') return [S.t, end];
  const f = S.flight, first = f.takeoffs[0] ?? 0, last = f.landings[f.landings.length - 1] ?? end;
  return [Math.max(0, first - 30), Math.min(end, last + 30)];       // 'air': first takeoff → last landing
}
function updateExportEstimate() {
  const [a, b] = exportRange(), sp = +$('x-speed').value;
  $('x-est').textContent = `Video length ${hms((b - a) / sp)} · ${Math.ceil((b - a) / sp * +$('x-fps').value)} frames. Rendering runs at roughly 10–25 frames/s on this Mac — keep this tab in front.`;
}
$('x-cancel').addEventListener('click', () => { if (S.exporting) S.exportCancel = true; else $('export').close(); });
$('x-start').addEventListener('click', async () => {
  const [t0, t1] = exportRange();
  const [W, H] = $('x-res').value.split('x').map(Number);
  const opts = { W, H, fps: +$('x-fps').value, speed: +$('x-speed').value, t0, t1,
    name: `${S.flight.id}_${$('x-speed').value}x_${H}p.mp4` };
  $('x-start').disabled = true; $('x-cancel').textContent = 'Stop';
  S.exporting = true; S.exportCancel = false;
  const keep = { t: S.t };
  try {
    await exportVideo(opts, {
      map, maplibregl, mapEl: $('map'),
      step: (t, dt) => { S.t = t; const s = sample(t); frame(s); camera(s, dt); return s; },
      paint: (ctx, s) => {
        drawOverlay(ctx, { x: 0, y: 0, w: opts.W, h: opts.H }, overlayState(s), { scale: opts.H / 1080 });
        window.__exportProbe?.(ctx.canvas);   // test hook
      },
      cancelled: () => S.exportCancel,
      progress: (i, n, fps) => {
        $('x-bar').value = i / n;
        $('x-msg').textContent = `Frame ${i} / ${n} · ${fps.toFixed(1)} frames/s · about ${hms((n - i) / Math.max(fps, 0.1))} left`;
      },
    });
    $('x-msg').textContent = S.exportCancel ? 'Stopped — the part rendered so far was saved.' : 'Done — video saved.';
  } catch (e) {
    console.error(e);
    $('x-msg').textContent = `Export failed: ${e.message || e}`;
  } finally {
    S.exporting = false; S.t = keep.t; S.dirty = true;
    $('x-start').disabled = false; $('x-cancel').textContent = 'Close';
    map.resize();
  }
});
