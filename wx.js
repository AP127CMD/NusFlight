// Weather layer for the replay: Himawari cloud tops (satellite), ECMWF model rain and TMD radar, stepped with the
// replay clock, plus a short readout of the weather at the aircraft.
// Data: flights/<F.wx> written by `./fv replay` (flightvid/weather/pack.py) — see that file for the encoding.
const FT = 0.3048;
const NM_KM = 1.852;
const CONVECTIVE_K = 245;                 // cloud-top temperature below this = convective (pack.CONVECTIVE_K)
const SAT_MAX_MIN = 30;                   // nearest satellite frame this far away or more = no frame (half an hour gap)
const RADAR_MAX_MIN = 20;                 // newest radar frame at or before now, at most this old
const HERE_KM = 2;                        // "cloud here" = the highest cell within this distance
const PHASE = ['clear', 'water', 'supercooled', 'mixed', 'ice'];
const IDS = ['wx-radar', 'wx-rain', 'wx-cloud', 'wx-conv'];
const EMPTY = { type: 'FeatureCollection', features: [] };
const BLANK = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const CTT_COLOR = ['interpolate', ['linear'], ['get', 'ctt'],
  195, '#ff2fd0', 210, '#ff3030', 225, '#ff9a1f', 240, '#ffe04a', 255, '#b9c4d0', 275, '#eef2f6'];
// TMD radar legend (flightvid/weather/radar.py LEGEND): dBZ, RGB — the decoded PNGs carry exactly these colours
const LEGEND = [
  [66.5, 254, 255, 255], [64.0, 255, 226, 255], [61.5, 255, 201, 255], [59.0, 253, 128, 254],
  [56.5, 248, 2, 248], [54.0, 203, 0, 84], [51.5, 209, 2, 86], [49.0, 224, 1, 94],
  [46.5, 235, 3, 1], [44.0, 251, 86, 4], [41.5, 225, 151, 1], [39.0, 239, 159, 8],
  [36.5, 253, 197, 7], [34.0, 219, 214, 6], [31.5, 227, 224, 6], [29.0, 249, 247, 6],
  [26.5, 7, 245, 5], [24.0, 2, 228, 4], [21.5, 1, 207, 70], [19.0, 2, 202, 1],
  [16.5, 3, 201, 1], [11.5, 2, 187, 2], [10.5, 1, 172, 2],
];

const ms = (iso) => Date.parse(iso);
const hhmm = (iso) => new Date(ms(iso)).toISOString().slice(11, 16) + 'Z';
const km = (lon0, lat0, lon1, lat1) => Math.hypot((lon1 - lon0) * 111.3 * Math.cos(lat0 * Math.PI / 180), (lat1 - lat0) * 111.3);
const degC = (k) => (k > 0 ? `${Math.round(k - 273.15)}°C` : '?°C');
const ft100 = (m) => Math.round(m / FT / 100) * 100;
const odTxt = (cod10) => (cod10 >= 0 ? (cod10 / 10).toFixed(1).replace(/\.0$/, '') : '?');   // stored ×10, −1 unknown
const merc = (lat) => Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360));
const square = (lon, lat, hx, hy) => ({ type: 'Polygon',
  coordinates: [[[lon - hx, lat - hy], [lon + hx, lat - hy], [lon + hx, lat + hy], [lon - hx, lat + hy], [lon - hx, lat - hy]]] });

function nearestDbz(r, g, b) {
  let best = null, bd = 30 * 30;                // canvas un-premultiplying alpha 170 moves a channel by ~1
  for (const [v, R, G, B] of LEGEND) {
    const d = (r - R) ** 2 + (g - G) ** 2 + (b - B) ** 2;
    if (d < bd) { bd = d; best = v; }
  }
  return best;
}

export function createWeather(map, { panel }) {
  let doc = null, base = '', attrKey = null;
  let sat = -1, rain = -1, radar = -1;          // frame index on the map (-1 = none drawn)
  let pix = null;                               // decoded radar frame: { idx, w, h, data } for the dBZ readout
  let loadSeq = 0;
  let pending = null;                         // lesson whose weather waits for the layer to be switched on
  const W = { on: true };
  try { W.on = localStorage.getItem('nf-wx') !== '0'; } catch { /* storage blocked: default on */ }

  const ready = () => !!map.style?.stylesheet;
  const decode = (q, b, lonq, latq) => [b[0] + lonq * q, b[1] + latq * q];

  function removeLayers() {
    for (const id of IDS) if (map.getLayer(id)) map.removeLayer(id);
    for (const id of IDS.slice(0, 3)) if (map.getSource(id)) map.removeSource(id);
    attrKey = null;
  }

  // sources + layers, (re)built when the document's attribution differs from what is on the map
  function ensureLayers() {
    if (!doc || !ready()) return false;
    // image sources take no attribution: the radar credit rides on the rain source when the lesson has radar
    const att = doc.attribution || [];
    const rainAtt = [att[1], doc.radar?.length ? att[2] : null].filter(Boolean).join(' | ');
    const key = JSON.stringify([att[0], rainAtt]);
    if (attrKey === key && map.getSource('wx-cloud')) return true;
    removeLayers();
    const [lo0, la0, lo1, la1] = doc.box;
    map.addSource('wx-radar', { type: 'image', url: BLANK,
      coordinates: [[lo0, la1], [lo1, la1], [lo1, la0], [lo0, la0]] });
    map.addSource('wx-rain', { type: 'geojson', data: EMPTY, attribution: rainAtt });
    map.addSource('wx-cloud', { type: 'geojson', data: EMPTY, attribution: att[0] });
    map.addLayer({ id: 'wx-radar', type: 'raster', source: 'wx-radar',
      paint: { 'raster-opacity': 0.8, 'raster-fade-duration': 0 } });
    map.addLayer({ id: 'wx-rain', type: 'fill-extrusion', source: 'wx-rain', paint: {
      'fill-extrusion-color': ['interpolate', ['linear'], ['get', 'mm'], 0.1, '#5aa0ff', 2, '#2050ff', 5, '#8020ff'],
      'fill-extrusion-base': 0, 'fill-extrusion-height': 450, 'fill-extrusion-opacity': 0.16 } });
    map.addLayer({ id: 'wx-cloud', type: 'fill-extrusion', source: 'wx-cloud',
      filter: ['any', ['>=', ['get', 'ctt'], CONVECTIVE_K], ['==', ['get', 'ctt'], 0]], paint: {
        'fill-extrusion-color': ['case', ['==', ['get', 'ctt'], 0], '#c8ced6', CTT_COLOR],
        'fill-extrusion-base': ['get', 'base'], 'fill-extrusion-height': ['get', 'top'], 'fill-extrusion-opacity': 0.32 } });
    map.addLayer({ id: 'wx-conv', type: 'fill-extrusion', source: 'wx-cloud',
      filter: ['all', ['>', ['get', 'ctt'], 0], ['<', ['get', 'ctt'], CONVECTIVE_K]], paint: {
        'fill-extrusion-color': CTT_COLOR,
        'fill-extrusion-base': ['get', 'base'], 'fill-extrusion-height': ['get', 'top'], 'fill-extrusion-opacity': 0.55 } });
    attrKey = key;
    sat = rain = radar = -1;
    visibility();
    return true;
  }

  function visibility() {
    const show = W.on && !!doc;
    for (const id of ['wx-rain', 'wx-cloud', 'wx-conv']) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', show ? 'visible' : 'none');
    if (map.getLayer('wx-radar')) map.setLayoutProperty('wx-radar', 'visibility', show && radar >= 0 ? 'visible' : 'none');
    panel.hidden = !show;
  }

  function cloudFC(fr) {
    const q = doc.q, b = doc.box, hx = fr.dlon / 2, hy = fr.dlat / 2, c = fr.c, out = [];
    for (let i = 0; i + 6 < c.length; i += 7) {
      if (c[i + 3] < 0) continue;               // cloudy pixel without a cloud-top height: readout only
      const [lon, lat] = decode(q, b, c[i], c[i + 1]);
      out.push({ type: 'Feature', properties: { base: c[i + 2] * 10, top: c[i + 3] * 10, ctt: c[i + 4], cod: c[i + 5] / 10, ph: c[i + 6] },
        geometry: square(lon, lat, hx, hy) });
    }
    return { type: 'FeatureCollection', features: out };
  }
  function rainFC(r) {
    const q = doc.q, b = doc.box, h = r.deg / 2, c = r.c, out = [];
    for (let i = 0; i + 2 < c.length; i += 3) {
      const [lon, lat] = decode(q, b, c[i], c[i + 1]);
      out.push({ type: 'Feature', properties: { mm: c[i + 2] / 10 }, geometry: square(lon, lat, h, h) });
    }
    return { type: 'FeatureCollection', features: out };
  }

  // frame choice
  function satIndex(now) {
    let best = -1, bd = Infinity;
    doc.frames.forEach((f, i) => { const d = Math.abs(ms(f.t) - now); if (d < bd) { bd = d; best = i; } });
    return bd < SAT_MAX_MIN * 60000 ? best : -1;
  }
  function rainIndex(now) {                     // entry t = start of its accumulation hour, shown t → t + 1h
    let best = -1;
    (doc.rain || []).forEach((r, i) => { const t = ms(r.t); if (t <= now && now < t + 3600000) best = i; });
    return best;
  }
  function radarIndex(now) {                    // newest frame at or before now, not older than RADAR_MAX_MIN
    let best = -1, bt = -Infinity;
    (doc.radar || []).forEach((r, i) => { const t = ms(r.t); if (t <= now && now - t <= RADAR_MAX_MIN * 60000 && t > bt) { bt = t; best = i; } });
    return best;
  }

  function loadRadarPixels(i) {
    pix = null;
    const fr = doc.radar[i], want = doc;
    const img = new Image();
    img.onload = () => {
      if (doc !== want || radar !== i) return;
      const cv = document.createElement('canvas');
      cv.width = img.naturalWidth; cv.height = img.naturalHeight;
      const ctx = cv.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      pix = { idx: i, w: cv.width, h: cv.height, data: ctx.getImageData(0, 0, cv.width, cv.height).data };
      W.onchange?.();
    };
    img.src = base + fr.png;
  }

  // radar at lon/lat: { cover: false } outside the range circle, else { cover: true, dbz: number | null }
  function radarAt(lon, lat) {
    if (!pix || pix.idx !== radar) return null;
    const bd = doc.radar[radar].bounds, lo0 = bd[0][0], lo1 = bd[1][0], la1 = bd[0][1], la0 = bd[2][1];
    const x = (lon - lo0) / (lo1 - lo0) * pix.w;
    const y = (merc(la1) - merc(lat)) / (merc(la1) - merc(la0)) * pix.h;
    // the decoded image is the box around the radar's range circle: coverage = its inscribed circle
    if (Math.hypot(x - pix.w / 2, y - pix.h / 2) > Math.min(pix.w, pix.h) / 2) return { cover: false };
    const xi = Math.floor(x), yi = Math.floor(y), k = (yi * pix.w + xi) * 4, d = pix.data;
    if (d[k + 3] < 20) return { cover: true, dbz: null };
    return { cover: true, dbz: nearestDbz(d[k], d[k + 1], d[k + 2]) };
  }

  function readout(now, s) {
    const lines = [];
    const fr = sat >= 0 ? doc.frames[sat] : null;
    const rd = radar >= 0 ? doc.radar[radar] : null;
    const radarTxt = rd ? ` · radar ${hhmm(rd.t)}` : '';
    if (fr) {
      const age = Math.round((now - ms(fr.t)) / 60000);
      lines.push(`Weather · satellite ${hhmm(fr.t)} (${age < 0 ? '−' : '+'}${Math.abs(age)} min)${radarTxt}`);
    } else lines.push(`Weather · no satellite frame near this time${radarTxt}`);
    const you = `you ${Math.round(s.alt / 100) * 100} ft`;

    // rain at the aircraft: radar when a frame is shown and covers the aircraft, else the model
    let rainTxt = 'none', noCover = false;
    const ra = rd ? radarAt(s.lon, s.lat) : null;
    if (ra && ra.cover) rainTxt = ra.dbz != null ? `radar ${ra.dbz} dBZ` : 'none';
    else {
      if (ra && !ra.cover) noCover = true;
      const r = rain >= 0 ? doc.rain[rain] : null;
      if (r) {
        const h = r.deg / 2, c = r.c;
        for (let i = 0; i + 2 < c.length; i += 3) {
          const [lon, lat] = decode(doc.q, doc.box, c[i], c[i + 1]);
          if (Math.abs(lon - s.lon) <= h && Math.abs(lat - s.lat) <= h && c[i + 2] > 0) { rainTxt = `model ${c[i + 2] / 10} mm/h`; break; }
        }
      }
    }

    if (fr) {
      let here = null, unk = null, unkD = Infinity, n5 = 0, n20 = 0, coldest = Infinity;
      const c = fr.c;
      for (let i = 0; i + 6 < c.length; i += 7) {
        const [lon, lat] = decode(doc.q, doc.box, c[i], c[i + 1]);
        const d = km(s.lon, s.lat, lon, lat);
        if (c[i + 3] < 0) {                       // cloudy, top unknown (pack.UNKNOWN_TOP): the nearest one
          if (d < HERE_KM && d < unkD) { unkD = d; unk = c[i + 6]; }
          continue;
        }
        if (d < HERE_KM && (!here || c[i + 3] > here[3])) here = c.slice(i, i + 7);
        const ctt = c[i + 4];
        if (ctt > 0 && ctt < CONVECTIVE_K) {
          if (d < 5 * NM_KM) n5++;
          if (d < 20 * NM_KM) { n20++; coldest = Math.min(coldest, ctt); }
        }
      }
      if (here) {
        const [, , b10, t10, ctt, cod, ph] = here;
        lines.push(`Cloud here: top ${ft100(t10 * 10)} ft (${degC(ctt)}, ${PHASE[ph] || 'phase ?'}, OD ${odTxt(cod)})` +
          ` · base ~${ft100(b10 * 10)} ft (model guess) · ${you}`);
      } else if (unk != null) lines.push(`Cloud here: cloud (${PHASE[unk] || 'phase ?'}), top unknown · ${you}`);
      else lines.push(`Cloud here: clear from satellite · ${you}`);
      lines.push(`Convective tops: ${n5} within 5 NM · ${n20} within 20 NM${n20 ? ` (coldest ${degC(coldest)})` : ''} · rain: ${rainTxt}`);
    } else lines.push(`Rain: ${rainTxt} · ${you}`);
    if (noCover) lines.push('no radar coverage here');

    panel.replaceChildren(...lines.map((t) => { const d = document.createElement('div'); d.textContent = t; return d; }));
  }

  W.attach = () => { if (doc) ensureLayers(); };

  W.load = async (F) => {
    const seq = ++loadSeq;
    doc = null; pix = null;
    sat = rain = radar = -1;
    for (const id of ['wx-cloud', 'wx-rain']) map.getSource(id)?.setData(EMPTY);
    visibility();
    W.lastNow = null;
    pending = null;
    if (!F?.wx) return;
    if (!W.on) { pending = F; return; }        // weather off: download nothing until W is pressed
    try {
      const url = `flights/${F.wx.split('/').map(encodeURIComponent).join('/')}`;
      const r = await fetch(url, { cache: 'no-cache' });
      if (!r.ok) throw new Error(`${r.status} ${url}`);
      const d = await r.json();
      if (seq !== loadSeq) return;
      W.setDoc(d, 'flights/wx/');
    } catch (e) { if (seq === loadSeq) console.warn('weather: not loaded:', e.message || e); }
  };

  // also the console hook for testing modified documents: replay.wx.setDoc(doc)
  W.setDoc = (d, prefix = 'flights/wx/') => {
    doc = d; base = prefix; pix = null;
    sat = rain = radar = -1;
    try { ensureLayers(); } catch (e) { W.fail(e); return; }
    visibility();
  };

  // a broken document must never stop the replay: warn once, drop the weather for this flight
  W.fail = (e) => {
    console.warn('weather: disabled for this flight:', e?.message || e);
    doc = null; pix = null;
    sat = rain = radar = -1;
    try {
      for (const id of ['wx-cloud', 'wx-rain']) map.getSource(id)?.setData(EMPTY);
      visibility();
    } catch { panel.hidden = true; }
  };

  W.update = (now, s) => {
    if (!doc || !W.on || !ensureLayers()) return;
    W.lastNow = now; W.lastS = s;
    const i = satIndex(now);
    if (i !== sat) { sat = i; map.getSource('wx-cloud').setData(i >= 0 ? cloudFC(doc.frames[i]) : EMPTY); }
    const j = rainIndex(now);
    if (j !== rain) { rain = j; map.getSource('wx-rain').setData(j >= 0 ? rainFC(doc.rain[j]) : EMPTY); }
    const k = radarIndex(now);
    if (k !== radar) {
      radar = k;
      if (k >= 0) {
        const fr = doc.radar[k];
        map.getSource('wx-radar').updateImage({ url: base + fr.png, coordinates: fr.bounds });
        loadRadarPixels(k);
      } else pix = null;
      visibility();
    }
    readout(now, s);
  };

  W.setOn = (on) => {
    W.on = !!on;
    try { localStorage.setItem('nf-wx', W.on ? '1' : '0'); } catch { /* storage blocked */ }
    if (W.on) sat = rain = radar = -1;          // redraw from the current time on the next update
    visibility();
    if (W.on && pending) W.load(pending).catch((e) => W.fail(e));
  };

  return W;
}
