// G1000-style instrument overlay on a 2D canvas — the web twin of flightvid/overlay.py (the video overlay):
// airspeed-style GS tape, attitude, altitude tape + VSI, HSI, flight header (date · tail · airport, lesson ·
// phase, leg), time + heart rate with a 15-min sparkline, and a running flight-stats card.
// Everything is laid out in 1080-high design units; `layout()` anchors the groups to the corners of a rect, so
// the same code draws the live view (around the page's panels) and the exported video frame (full frame).

const INK = '#eef3f8', DIM = '#9aa7b6', CYAN = '#41cff5', MAGENTA = '#ff6ad8', GREEN = '#4ade80',
  YELLOW = '#ffcc00', SKY = '#2f6fd6', GROUND = '#8a5a2b', RED = '#ff5a6e';
const PANEL = 'rgba(10,14,19,0.62)', EDGE = 'rgba(255,255,255,0.14)';
const LABEL = '"Barlow Condensed", "Arial Narrow", sans-serif';
const NUM = '"JetBrains Mono", "SF Mono", Menlo, monospace';

// ---------------------------------------------------------------- tiny painter
function P(ctx) {
  return {
    ctx,
    panel(x, y, w, h, r = 10, fill = PANEL) {
      ctx.beginPath(); ctx.roundRect(x, y, w, h, r);
      ctx.fillStyle = fill; ctx.fill();
      ctx.lineWidth = 1; ctx.strokeStyle = EDGE; ctx.stroke();
    },
    text(s, x, y, font, size, color = INK, align = 'left', shadow = true, weight = 700) {
      ctx.font = `${weight} ${size}px ${font}`;
      ctx.textAlign = align; ctx.textBaseline = 'alphabetic';
      if (shadow) { ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillText(s, x + 1.2, y + 1.2); }
      ctx.fillStyle = color; ctx.fillText(s, x, y);
      return ctx.measureText(s).width;
    },
    width(s, font, size, weight = 700) { ctx.font = `${weight} ${size}px ${font}`; return ctx.measureText(s).width; },
    line(x0, y0, x1, y1, color = INK, w = 2, alpha = 1) {
      ctx.globalAlpha = alpha; ctx.strokeStyle = color; ctx.lineWidth = w; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke(); ctx.globalAlpha = 1;
    },
    poly(pts, color, { stroke = null, alpha = 1, close = true } = {}) {
      ctx.globalAlpha = alpha; ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
      for (const [x, y] of pts.slice(1)) ctx.lineTo(x, y);
      if (close) ctx.closePath();
      if (stroke) { ctx.strokeStyle = color; ctx.lineWidth = stroke; ctx.lineJoin = 'round'; ctx.stroke(); }
      else { ctx.fillStyle = color; ctx.fill(); }
      ctx.globalAlpha = 1;
    },
  };
}

// ---------------------------------------------------------------- instruments
function attitude(p, st, cx, cy, r) {
  const c = p.ctx, ppd = r / 22;
  c.save();
  c.beginPath(); c.arc(cx, cy, r, 0, Math.PI * 2); c.clip();
  c.translate(cx, cy); c.rotate(-st.roll * Math.PI / 180); c.translate(0, st.pitch * ppd);
  const big = 4 * r;
  c.globalAlpha = 0.85;
  c.fillStyle = SKY; c.fillRect(-big, -big, 2 * big, big);
  c.fillStyle = GROUND; c.fillRect(-big, 0, 2 * big, big);
  c.globalAlpha = 1;
  p.line(-big, 0, big, 0, '#fff', 2);
  for (let d = -30; d <= 30; d += 5) {
    if (!d) continue;
    const y = -d * ppd, half = d % 10 === 0 ? r * 0.36 : r * 0.16;
    p.line(-half, y, half, y, '#fff', 1.6, 0.95);
    if (d % 10 === 0) {
      p.text(String(Math.abs(d)), -half - 8, y + 5.5, NUM, 14, '#fff', 'right', false);
      p.text(String(Math.abs(d)), half + 8, y + 5.5, NUM, 14, '#fff', 'left', false);
    }
  }
  c.restore();
  c.lineWidth = 3; c.strokeStyle = 'rgba(0,0,0,.6)'; c.beginPath(); c.arc(cx, cy, r, 0, Math.PI * 2); c.stroke();
  c.lineWidth = 1.2; c.strokeStyle = 'rgba(255,255,255,.35)'; c.beginPath(); c.arc(cx, cy, r + 1.5, 0, Math.PI * 2); c.stroke();
  // roll scale + zero index turn with the horizon (G1000)…
  c.save(); c.translate(cx, cy); c.rotate(-st.roll * Math.PI / 180);
  for (const b of [-60, -45, -30, -20, -10, 10, 20, 30, 45, 60]) {
    const a = (-90 + b) * Math.PI / 180, L = Math.abs(b) === 30 || Math.abs(b) === 60 ? 14 : 9;
    p.line((r + 3) * Math.cos(a), (r + 3) * Math.sin(a), (r + 3 + L) * Math.cos(a), (r + 3 + L) * Math.sin(a), '#fff', 2.2);
  }
  p.poly([[0, -r - 3], [-8, -r - 17], [8, -r - 17]], '#fff');
  c.restore();
  // …while the roll pointer and slip/skid brick stay fixed at the top
  const ty = cy - r + 4;
  const ptr = [[cx, ty], [cx - 9, ty + 15], [cx + 9, ty + 15]];
  p.poly(ptr, '#000', { stroke: 2.5, alpha: 0.8 }); p.poly(ptr, YELLOW);
  const slip = Math.max(-14, Math.min(14, -(st.glat || 0) * 120));
  const brick = [[cx - 10 + slip, ty + 18], [cx + 10 + slip, ty + 18], [cx + 12 + slip, ty + 24], [cx - 12 + slip, ty + 24]];
  p.poly(brick, '#000', { stroke: 2.5, alpha: 0.8 }); p.poly(brick, YELLOW);
  // aircraft symbol (single cue)
  for (const sg of [-1, 1]) {
    const wing = [[cx + sg * r * 0.62, cy - 3], [cx + sg * r * 0.28, cy - 3], [cx + sg * r * 0.28, cy + 3], [cx + sg * r * 0.62, cy + 3]];
    p.poly(wing, '#1a1a1a', { stroke: 4.5 }); p.poly(wing, YELLOW);
  }
  const chev = [[cx, cy], [cx - r * 0.24, cy + r * 0.13], [cx - r * 0.12, cy + r * 0.13], [cx, cy + r * 0.06], [cx + r * 0.12, cy + r * 0.13], [cx + r * 0.24, cy + r * 0.13]];
  p.poly(chev, '#1a1a1a', { stroke: 4.5 }); p.poly(chev, YELLOW);
  if (st.attEst) p.text('EST', cx + r * 0.72, cy - r * 0.78, LABEL, 17, YELLOW, 'center');
  if (Math.abs(st.roll) >= 3) p.text(`${Math.abs(st.roll).toFixed(0)}°${st.roll < 0 ? 'L' : 'R'}`, cx, cy + r * 0.66, NUM, 16, INK, 'center');
}

function tape(p, x, y, w, h, value, ppu, minor, major, label, unit, trend, side, fmt = (v) => v.toFixed(0)) {
  const c = p.ctx, cy = y + h / 2;
  p.panel(x, y, w, h, 8);
  c.save(); c.beginPath(); c.roundRect(x, y, w, h, 8); c.clip();
  const lo = value - h / 2 / ppu, hi = value + h / 2 / ppu;
  for (let v = Math.floor(lo / minor) * minor; v <= hi + minor; v += minor) {
    const yy = cy - (v - value) * ppu, isMajor = Math.abs(v / major - Math.round(v / major)) < 1e-6, L = isMajor ? 14 : 7;
    const x0 = side === 'left' ? x + w - L : x;
    p.line(x0, yy, x0 + L, yy, '#fff', isMajor ? 2 : 1.4, 0.9);
    if (isMajor && v >= 0) {
      if (side === 'left') p.text(v.toFixed(0), x + w - 20, yy + 7, NUM, 17, INK, 'right', false);
      else p.text(v.toFixed(0), x + 20, yy + 7, NUM, 17, INK, 'left', false);
    }
  }
  if (trend) {
    const edge = side === 'left' ? x + w - 3 : x + 3;
    p.line(edge, cy, edge, cy - trend * ppu, MAGENTA, 4.5);
  }
  c.restore();
  const bh = 44;
  const pts = side === 'left'
    ? [[x - 2, cy - bh / 2], [x + w - 12, cy - bh / 2], [x + w - 12, cy - 9], [x + w, cy], [x + w - 12, cy + 9], [x + w - 12, cy + bh / 2], [x - 2, cy + bh / 2]]
    : [[x + w + 2, cy - bh / 2], [x + 12, cy - bh / 2], [x + 12, cy - 9], [x, cy], [x + 12, cy + 9], [x + 12, cy + bh / 2], [x + w + 2, cy + bh / 2]];
  p.poly(pts, '#000'); p.poly(pts, '#fff', { stroke: 1.6, alpha: 0.9 });
  const size = fmt(value).length > 4 ? 23 : 27;
  p.text(fmt(value), side === 'left' ? x + w - 15 : x + w - 3, cy + 10, NUM, size, INK, 'right', false);
  p.text(label, x + w / 2, y - 12, LABEL, 20, DIM, 'center');
  p.text(unit, x + w / 2, y + h + 22, LABEL, 17, DIM, 'center');
}

function vsi(p, st, x, y, w, h) {
  const cy = y + h / 2, k = (h / 2 - 8) / 2000;
  p.panel(x, y, w, h, 6);
  for (const v of [-2000, -1500, -1000, -500, 500, 1000, 1500, 2000]) {
    const yy = cy - v * k;
    p.line(x + 2, yy, x + (v % 1000 === 0 ? 10 : 6), yy, '#fff', 1.6, 0.85);
    if (v % 1000 === 0) p.text(String(Math.abs(v) / 1000), x + 13, yy + 5, NUM, 12, DIM, 'left', false);
  }
  p.line(x + 2, cy, x + w - 2, cy, '#fff', 1.4, 0.6);
  const yy = cy - Math.max(-2000, Math.min(2000, st.vs)) * k;
  const tri = [[x + 2, yy], [x + w + 6, yy - 7], [x + w + 6, yy + 7]];
  p.poly(tri, GREEN); p.poly(tri, '#000', { stroke: 1.2, alpha: 0.8 });
  const v = Math.round(st.vs / 10) * 10;
  p.text(v > 0 ? `+${v}` : String(v), x + w / 2 + 3, y + h + 22, NUM, 15, GREEN, 'center');
  p.text('VS', x + w / 2 + 2, y - 12, LABEL, 20, DIM, 'center');
}

// HSI: heading-up compass card, heading box, magenta track diamond, cyan bearing pointer to the next airport
function hsi(p, st, cx, cy, r) {
  const c = p.ctx;
  c.beginPath(); c.arc(cx, cy, r + 6, 0, Math.PI * 2); c.fillStyle = PANEL; c.fill();
  c.lineWidth = 1; c.strokeStyle = EDGE; c.stroke();
  c.save(); c.translate(cx, cy); c.rotate(-st.hdg * Math.PI / 180);
  for (let d = 0; d < 360; d += 5) {
    const a = (d - 90) * Math.PI / 180, L = d % 10 === 0 ? 12 : 6;
    p.line((r - L) * Math.cos(a), (r - L) * Math.sin(a), r * Math.cos(a), r * Math.sin(a), '#fff', d % 10 === 0 ? 1.8 : 1.1, 0.9);
  }
  const names = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' };
  for (let d = 0; d < 360; d += 30) {
    c.save(); c.rotate(d * Math.PI / 180);
    p.text(names[d] || String(d / 10), 0, -r + 32, NUM, names[d] ? 19 : 16, names[d] ? CYAN : INK, 'center', false);
    c.restore();
  }
  // bearing pointer (cyan, double-ended line) to the destination / nearest airport
  if (st.brg != null) {
    c.save(); c.rotate(st.brg * Math.PI / 180);
    p.line(0, -r + 42, 0, -r * 0.25, CYAN, 2.4); p.line(0, r * 0.25, 0, r - 12, CYAN, 2.4);
    p.poly([[0, -r + 38], [-8, -r + 52], [8, -r + 52]], CYAN);
    c.restore();
  }
  // course pointer + deviation bar (G1000 CDI): magenta on GPS, green on VOR. HCDI is in full-scale units,
  // positive = needle right (fly right); full scale = the outer dot (10° on a VOR, the GPS alarm limit)
  if (st.cdi && st.cdi.crs != null) {
    const col = st.cdi.src === 'GPS' ? MAGENTA : GREEN, dot = r * 0.2;
    c.save(); c.rotate(st.cdi.crs * Math.PI / 180);
    for (const k of [-2, -1, 1, 2]) { c.beginPath(); c.arc(k * dot, 0, 4, 0, Math.PI * 2); c.lineWidth = 1.6; c.strokeStyle = '#fff'; c.stroke(); }
    p.line(0, -r + 20, 0, -r * 0.46, col, 4);
    p.poly([[0, -r + 14], [-9, -r + 30], [9, -r + 30]], col);
    p.line(0, r * 0.46, 0, r - 18, col, 4);
    if (st.cdi.dev != null) {
      const x = Math.max(-2.1, Math.min(2.1, st.cdi.dev * 2)) * dot;
      p.line(x, -r * 0.42, x, r * 0.42, col, 4);
    }
    c.restore();
  }
  // track diamond (magenta, G1000 ground-track marker)
  if (st.gs > 20) {
    c.save(); c.rotate(st.trk * Math.PI / 180);
    p.poly([[0, -r - 1], [-6, -r + 8], [0, -r + 17], [6, -r + 8]], MAGENTA);
    c.restore();
  }
  c.restore();
  // lubber line + ownship
  p.poly([[cx, cy - r + 2], [cx - 7, cy - r - 10], [cx + 7, cy - r - 10]], '#fff');
  const s = r * 0.22;
  p.poly([[cx, cy - s], [cx + s * 0.18, cy - s * 0.2], [cx + s, cy + s * 0.15], [cx + s, cy + s * 0.32], [cx + s * 0.18, cy + s * 0.12],
    [cx + s * 0.12, cy + s * 0.7], [cx + s * 0.4, cy + s * 0.9], [cx + s * 0.4, cy + s], [cx - s * 0.4, cy + s], [cx - s * 0.4, cy + s * 0.9],
    [cx - s * 0.12, cy + s * 0.7], [cx - s * 0.18, cy + s * 0.12], [cx - s, cy + s * 0.32], [cx - s, cy + s * 0.15], [cx - s * 0.18, cy - s * 0.2]], '#fff');
  // heading box
  const bw = 96, bh = 30, by = cy - r - 44;
  p.poly([[cx - bw / 2, by], [cx + bw / 2, by], [cx + bw / 2, by + bh], [cx - bw / 2, by + bh]], '#000', { alpha: 0.9 });
  p.poly([[cx - bw / 2, by], [cx + bw / 2, by], [cx + bw / 2, by + bh], [cx - bw / 2, by + bh]], '#fff', { stroke: 1.4, alpha: 0.9 });
  p.text('HDG', cx - bw / 2 + 7, by + 21, LABEL, 16, DIM, 'left', false);
  p.text(`${String(Math.round(st.hdg) % 360 || 360).padStart(3, '0')}°`, cx + bw / 2 - 6, by + 23, NUM, 20, INK, 'right', false);
  // labels: track + bearing target
  if (st.gs > 20) p.text(`TRK ${String(Math.round(st.trk) % 360 || 360).padStart(3, '0')}°`, cx - r - 4, cy + r + 4, NUM, 14, MAGENTA, 'left');
  if (st.brgLabel) p.text(st.brgLabel, cx + r + 4, cy + r + 4, NUM, 14, CYAN, 'right');
  if (st.cdi) {
    const col = st.cdi.src === 'GPS' ? MAGENTA : GREEN;
    p.text(st.cdi.src === 'GPS' ? 'GPS' : st.cdi.src.replace('NAV', 'VOR'), cx - r * 0.5, cy - r * 0.18, LABEL, 18, col, 'center');
    if (st.cdi.crs != null) p.text(`CRS ${String(Math.round(st.cdi.crs) % 360 || 360).padStart(3, '0')}°`, cx - r - 4, cy - r - 20, NUM, 14, col, 'left');
  }
}

function heart(c, x, y, size, color) {
  const k = size / 20;
  c.beginPath();
  c.moveTo(x, y + 6 * k);
  c.bezierCurveTo(x, y - 4 * k, x - 10 * k, y - 2 * k, x - 10 * k, y + 3 * k);
  c.bezierCurveTo(x - 10 * k, y + 9 * k, x, y + 14 * k, x, y + 17 * k);
  c.bezierCurveTo(x, y + 14 * k, x + 10 * k, y + 9 * k, x + 10 * k, y + 3 * k);
  c.bezierCurveTo(x + 10 * k, y - 2 * k, x, y - 4 * k, x, y + 6 * k);
  c.fillStyle = color; c.fill();
}

// ---------------------------------------------------------------- header + stats
// radio line (G1000 logs): COM1 frequency + station in cyan, NAV1 in green
function radioParts(st) {
  const parts = [];
  if (st.com) parts.push([`COM1 ${st.com.freq.toFixed(3)}${st.com.name ? ' ' + st.com.name.toUpperCase() : ''}`, CYAN]);
  if (st.nav) parts.push([`NAV1 ${st.nav.freq.toFixed(2)}${st.nav.name ? ' ' + st.nav.name.split(' ')[0] : ''}`, GREEN]);
  return parts;
}
function headerLeft(p, st, x, y) {
  const l1 = st.title, l2a = st.lesson, l2b = st.phase ? '  ·  ' + st.phase : '', l3 = st.place || '';
  const rp = radioParts(st), sep = '   ';
  const l4w = rp.reduce((a, [t]) => a + p.width(t + sep, LABEL, 19), 0);
  const w = Math.max(p.width(l1, LABEL, 27), p.width(l2a + l2b, LABEL, 24), p.width(l3, LABEL, 21), l4w) + 38;
  const h = (l3 ? 108 : 80) + (rp.length ? 27 : 0);
  p.panel(x, y, w, h, 10);
  p.text(l1, x + 18, y + 33, LABEL, 27, INK);
  const w2 = p.text(l2a, x + 18, y + 66, LABEL, 24, DIM);
  if (l2b) p.text(l2b, x + 18 + w2, y + 66, LABEL, 24, CYAN);
  if (l3) p.text(l3, x + 18, y + 95, LABEL, 21, st.legColor || MAGENTA);
  let rx = x + 18;
  for (const [t, col] of rp) rx += p.text(t + sep, rx, y + h - 13, LABEL, 19, col);
  return { w, h };
}

function headerRight(p, st, x, y) {
  const pw = 330;
  p.panel(x, y, pw, 80, 10);
  const wt = p.text(st.lcl, x + 18, y + 45, NUM, 32, INK);
  p.text('LCL', x + 18 + wt + 6, y + 45, LABEL, 18, DIM);
  p.text(st.utc, x + 18, y + 69, NUM, 15, DIM);
  if (st.hr != null) {
    const hx = x + pw - 18;
    p.text('BPM', hx, y + 69, LABEL, 16, DIM, 'right');
    const wv = p.text(String(Math.round(st.hr)), hx, y + 45, NUM, 32, INK, 'right');
    heart(p.ctx, hx - wv - 18, y + 22, 22, RED);
    const h = st.hrHist || [];
    if (h.length >= 2) {
      const sx0 = hx - 128, sx1 = hx - 40, sy0 = y + 56, sy1 = y + 72;
      const lo = Math.min(...h) - 2, hi = Math.max(...h) + 2;
      p.poly(h.map((v, i) => [sx0 + (sx1 - sx0) * i / (h.length - 1), sy1 - (sy1 - sy0) * (v - lo) / (hi - lo)]), RED, { stroke: 1.8, alpha: 0.85, close: false });
    }
  }
  return pw;
}

function statsCard(p, st, x, y, w) {
  const rows = st.stats;
  const h = 44 + rows.length * 30;
  p.panel(x, y, w, h, 10);
  p.text('FLIGHT', x + 16, y + 28, LABEL, 18, DIM);
  p.text(st.statsNote || '', x + w - 16, y + 28, LABEL, 16, DIM, 'right');
  rows.forEach(([k, v, u], i) => {
    const yy = y + 60 + i * 30;
    p.text(k, x + 16, yy, LABEL, 18, DIM);
    const wu = u ? p.width(u, LABEL, 15) + 6 : 0;
    p.text(v, x + w - 16 - wu, yy, NUM, 19, INK, 'right');
    if (u) p.text(u, x + w - 16, yy, LABEL, 15, DIM, 'right');
  });
  return h;
}

// G1000-style wind badge: an arrow blowing with the wind, drawn relative to the aircraft's heading
function windBadge(p, st, x, y) {
  if (st.wind == null || st.windFrom == null) return;
  const c = p.ctx, r = 17;
  p.text('WIND', x - r - 6, y - 6, LABEL, 15, DIM, 'right');
  p.text(`${Math.round(st.wind)} KT`, x - r - 6, y + 12, NUM, 15, INK, 'right');
  p.text(`${String(Math.round(st.windFrom) % 360 || 360).padStart(3, '0')}°`, x + r + 6, y + 12, NUM, 15, INK, 'left');
  // the head is drawn at +r (screen down = relative bearing 180°), so rotating by (from − hdg) aims it downwind
  c.save(); c.translate(x, y + 2); c.rotate((st.windFrom - st.hdg) * Math.PI / 180);
  p.line(0, -r, 0, r, CYAN, 2.4);
  p.poly([[0, r + 2], [-6, r - 8], [6, r - 8]], CYAN);
  c.restore();
}

function smallValues(p, st, x, y) {
  const items = [];
  if (st.aglValid) items.push(['AGL', String(Math.max(0, Math.round(st.agl / 10) * 10)), 'FT']);
  if (st.g != null) items.push(['G', st.g.toFixed(2), '']);
  if (st.ias != null) items.push(['GS', String(Math.round(st.gs)), 'KT']);      // the tape shows IAS instead
  if (st.tas != null) items.push(['TAS', String(Math.round(st.tas)), 'KT']);
  if (st.oat != null) items.push(['OAT', `${Math.round(st.oat)}`, '°C']);
  items.forEach(([k, v, u], i) => {
    const yy = y + i * 30;
    const w = p.text(k, x, yy, LABEL, 19, DIM);
    const w2 = p.text(v, x + w + 8, yy, NUM, 20, INK);
    if (u) p.text(u, x + w + 8 + w2 + 4, yy, LABEL, 16, DIM);
  });
}

// G1000 EIS-style engine strip: horizontal bar gauges with green/amber/red arcs, CHT/EGT columns per cylinder
const GAUGES = [
  // label, key, unit, min, max, [green lo, hi], amber above (or null), red above, decimals
  ['RPM', 'rpm', '', 0, 2800, [2100, 2700], null, 2700, 0],
  ['MAN', 'map', 'IN', 10, 30, [15, 30], null, 30, 1],
  ['FFLOW', 'ff', 'GPH', 0, 20, [0, 20], null, 20, 1],
  ['OIL T', 'oilt', '°F', 100, 250, [170, 220], 220, 245, 0],
  ['OIL P', 'oilp', 'PSI', 0, 115, [55, 95], 95, 115, 0],
];
function engineHeight(st) { return 38 + GAUGES.filter((g) => st.eng[g[1]] != null).length * 30 + 112 + 58; }
function engine(p, st, x, y, w) {
  const e = st.eng, rows = GAUGES.filter((g) => e[g[1]] != null);
  const h = engineHeight(st);
  p.panel(x, y, w, h, 10);
  p.text('ENGINE', x + 16, y + 26, LABEL, 18, DIM);
  if (e.fuelUsed != null) p.text(`${e.fuelUsed.toFixed(1)} GAL USED`, x + w - 16, y + 26, NUM, 14, CYAN, 'right');
  const bx = x + 78, bw = w - 78 - 86;
  rows.forEach(([k, key, u, lo, hi, green, amber, red, nd], i) => {
    const yy = y + 50 + i * 30, v = e[key], X = (q) => bx + (Math.max(lo, Math.min(hi, q)) - lo) / (hi - lo) * bw;
    p.text(k, x + 16, yy + 6, LABEL, 17, DIM);
    p.ctx.fillStyle = 'rgba(255,255,255,.12)'; p.ctx.fillRect(bx, yy - 4, bw, 8);
    p.ctx.fillStyle = 'rgba(74,222,128,.75)'; p.ctx.fillRect(X(green[0]), yy - 4, X(green[1]) - X(green[0]), 8);
    if (amber != null) { p.ctx.fillStyle = 'rgba(255,204,0,.8)'; p.ctx.fillRect(X(amber), yy - 4, X(red) - X(amber), 8); }
    p.ctx.fillStyle = RED; p.ctx.fillRect(X(red) - 2, yy - 7, 3, 14);
    const px = X(v);
    p.poly([[px, yy + 3], [px - 7, yy - 11], [px + 7, yy - 11]], '#fff');
    const warn = v >= red ? RED : amber != null && v >= amber ? YELLOW : INK;
    p.text(v.toFixed(nd), x + w - 16 - (u ? p.width(u, LABEL, 13) + 5 : 0), yy + 7, NUM, 18, warn, 'right');
    if (u) p.text(u, x + w - 16, yy + 7, LABEL, 13, DIM, 'right');
  });
  // CHT / EGT columns, cylinder 1–4; hottest CHT outlined
  const top = y + 50 + rows.length * 30, colW = 16, gap = 10;
  const bars = (vals, lo, hi, x0, label, unit, warnAt) => {
    p.text(label, x0, top + 12, LABEL, 16, DIM);
    const hot = vals.indexOf(Math.max(...vals.map((v) => v ?? -1)));
    vals.forEach((v, k) => {
      const bx0 = x0 + k * (colW + gap), by0 = top + 22, bh = 72;
      p.ctx.fillStyle = 'rgba(255,255,255,.12)'; p.ctx.fillRect(bx0, by0, colW, bh);
      if (v != null) {
        const f = Math.max(0, Math.min(1, (v - lo) / (hi - lo)));
        p.ctx.fillStyle = warnAt != null && v >= warnAt ? YELLOW : CYAN; p.ctx.fillRect(bx0, by0 + bh * (1 - f), colW, bh * f);
      }
      if (k === hot) { p.ctx.strokeStyle = '#fff'; p.ctx.lineWidth = 1.5; p.ctx.strokeRect(bx0 - 1.5, by0 - 1.5, colW + 3, bh + 3); }
      p.text(String(k + 1), bx0 + colW / 2, by0 + bh + 16, NUM, 12, DIM, 'center', false);
    });
    const mx = Math.max(...vals.map((v) => v ?? -1));
    if (mx > 0) p.text(`${Math.round(mx)}${unit}`, x0 + 4 * (colW + gap) - gap, top + 12, NUM, 14, INK, 'right');
  };
  if (e.cht) bars(e.cht, 100, 500, x + 16, 'CHT', '°F', 400);
  if (e.egt) bars(e.egt, 800, 1600, x + w / 2 + 6, 'EGT', '°F', null);
  const fy = top + 138;
  if (e.fuelRem != null) {
    p.text('FUEL', x + 16, fy + 6, LABEL, 17, DIM);
    p.text(`${e.fuelRem.toFixed(1)} GAL`, x + 78, fy + 7, NUM, 18, e.fuelRem < 10 ? YELLOW : INK);
    if (e.endurance != null) p.text(`${Math.floor(e.endurance / 60)}:${String(Math.round(e.endurance % 60)).padStart(2, '0')} LEFT`, x + w - 16, fy + 7, NUM, 14, DIM, 'right');
  }
  if (e.volts != null) {
    p.text('VOLTS', x + 16, fy + 34, LABEL, 17, DIM);
    p.text(e.volts.toFixed(1), x + 78, fy + 35, NUM, 18, e.volts < 25 ? YELLOW : INK);
  }
  return h;
}

// ---------------------------------------------------------------- layout
// rect = {x, y, w, h} in canvas pixels; compact = narrow phone layout (header stacked, no stats card)
export function drawOverlay(ctx, rect, st, { compact = false, scale = null } = {}) {
  const s = scale || (compact ? Math.min(rect.w / 680, rect.h / 1450) : Math.max(0.42, Math.min(1.25, rect.h / 1080, rect.w / 1750)));
  const W = rect.w / s, H = rect.h / s;
  const p = P(ctx);
  ctx.save();
  ctx.translate(rect.x, rect.y); ctx.scale(s, s);
  const m = compact ? 12 : 24;
  // header
  const hl = headerLeft(p, st, m, m);
  if (compact) headerRight(p, st, m, m + hl.h + 10);
  else headerRight(p, st, W - m - 330, m);
  if (st.hasPos) {
    // instrument cluster, bottom-left: GS tape · attitude · ALT tape + VSI, HSI underneath
    const cx = m + 226, adiY = H - m - 470, r = 105;
    const spd = st.ias != null ? st.ias : st.gs;      // G1000 logs give real indicated airspeed
    tape(p, m + 6, adiY - 125, 78, 250, spd, 4.0, 5, 10, st.ias != null ? 'IAS' : 'GS', 'KT', st.gsTrend, 'left');
    attitude(p, st, cx, adiY, r);
    tape(p, cx + r + 22, adiY - 125, 90, 250, st.alt, 0.40, 20, 100, 'ALT', 'FT', st.altTrend, 'right');
    vsi(p, st, cx + r + 118, adiY - 105, 22, 210);
    hsi(p, st, cx, H - m - 128, 118);
    smallValues(p, st, cx + r + 40, H - m - 250);
    windBadge(p, st, cx + r + 92, H - m - 78);
    if (!compact && st.stats) statsCard(p, st, W - m - 300, H - m - (44 + st.stats.length * 30), 300);
    // engine strip bottom-right, beside the stats card (the middle stays clear for the aircraft)
    if (!compact && st.eng && W - m - 300 - 12 - 320 > cx + r + 330) {
      const h = engineHeight(st);
      engine(p, st, W - m - 300 - 12 - 320, H - m - h, 320);
    }
  }
  ctx.restore();
}
