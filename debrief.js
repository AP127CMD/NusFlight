// Lesson debrief panel: what `flightvid/analysis.py` found in a G1000 log (events, approach gates, legs vs
// book, fuel, nav log plan vs actual, winds, engine) plus flying-accuracy scores for every lesson and how
// they change across lessons. Times are buttons: clicking one moves the replay there.

const esc = (v) => String(v ?? '—').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const num = (v, nd = 0) => (v == null || Number.isNaN(v) ? '—' : Number(v).toLocaleString('en-US', { minimumFractionDigits: nd, maximumFractionDigits: nd }));
const sgn = (v, nd = 0) => (v == null ? '—' : (v > 0 ? '+' : '') + num(v, nd));
const deg = (v) => (v == null ? '—' : String(Math.round(v) % 360 || 360).padStart(3, '0') + '°');
const KIND = { takeoff: 'Take-off', landing: 'Landing', touch_and_go: 'Touch-and-go', low_pass: 'Low pass' };

export function renderDebrief(root, F, ctx) {
  const A = F.analysis, rel = F.rel;
  const at = (iso, text) => (iso ? `<button class="db-t" data-t="${Math.max(0, rel(iso) - 3)}">${esc(text ?? ctx.clock(rel(iso)).slice(0, 5))}</button>` : '—');
  const sec = (id, title, body, note = '') => `<section class="db-sec" id="db-${id}"><h3>${title}</h3>${note ? `<p class="db-note">${note}</p>` : ''}${body}</section>`;
  const table = (head, rows, cls = '') => `<div class="db-tw"><table class="${cls}"><thead><tr>${head.map((h) => `<th${/^[#·]|n$/.test(h[1] || '') ? ' class="n"' : ''}>${h[0]}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
  const out = [];

  if (!A) {
    out.push(`<p class="db-note">This lesson has no G1000 flight data log, so the debrief shows only what its ${esc(F.source === 'ahrs' ? 'Spidertracks AHRS' : F.source)} track supports: the accuracy scores. Import the aircraft's SD card (<code>./fv g1000 import</code>) for approaches, engine, fuel and nav-log comparisons.</p>`);
  } else {
    const crit = A.criteria.stabilised;
    // ---------- summary chips
    const ap = A.approaches || [];
    const stable = ap.filter((a) => a.stable).length;
    const fuel = A.fuel?.total_gal;
    out.push(`<div class="db-chips">
      <span class="chip ${stable === ap.length ? 'ok' : 'warn'}"><b>${stable}/${ap.length}</b> approaches stable by ${crit.by_ft} ft</span>
      <span class="chip"><b>${num(fuel, 1)}</b> gal burned</span>
      <span class="chip"><b>${(A.legs || []).length}</b> legs</span>
      ${A.accuracy?.alt_hold ? `<span class="chip"><b>${A.accuracy.alt_hold.within_100_pct}%</b> within ±100 ft</span>` : ''}
    </div>`);

    // ---------- events
    const major = (A.events || []).filter((e) => e.major);
    const minor = (A.events || []).filter((e) => !e.major);
    out.push(sec('events', 'Timeline', `<ul class="db-events">${major.map((e) => `<li class="k-${e.kind}">${at(e.t)} <span>${esc(e.label)}</span></li>`).join('')}</ul>
      <details><summary>${minor.length} radio, waypoint, HSI and altimeter changes</summary>
      <ul class="db-events small">${minor.map((e) => `<li class="k-${e.kind}">${at(e.t)} <span>${esc(e.label)}</span></li>`).join('')}</ul></details>`));

    // ---------- approaches
    const apBody = ap.map((a) => {
      const verdict = a.stable == null ? '' : a.stable ? '<span class="pill ok">stable</span>' : `<span class="pill bad">not stable — ${esc(a.unstable_on.join(', '))}</span>`;
      const rows = a.gates.map((g) => {
        const c = g.checks, cell = (ok, v) => `<td class="n${ok === false ? ' fail' : ''}">${v}</td>`;
        return `<tr${g.ft === a.stable_by_ft ? ' class="gate"' : ''}><td class="n">${num(g.ft)} ft</td><td>${at(g.t, '−' + g.s_before + ' s')}</td>
          ${cell(c.ias, num(g.ias))}${cell(c.sink, num(g.vs))}${cell(c.bank, num(g.bank, 1))}${cell(c.hdg, sgn(g.hdg_err))}<td class="n">${num(g.pitch, 1)}</td><td class="n">${num(g.rpm)}</td></tr>`;
      });
      const td = a.touchdown;
      return `<div class="db-card"><div class="db-card-h">${at(a.t)} <b>${esc(KIND[a.type])} ${esc(a.ad)} RWY ${esc(a.rwy)}</b> ${verdict}</div>
        ${table([['Height'], ['Time'], ['IAS', 'n'], ['VS', 'n'], ['Bank', 'n'], ['HDG err', 'n'], ['Pitch', 'n'], ['RPM', 'n']], rows)}
        <p class="db-td">Touchdown: IAS <b>${num(td.ias)}</b> kt · GS ${num(td.gs)} · sink <b>${num(td.sink)}</b> fpm · pitch ${num(td.pitch, 1)}° · drift ${sgn(td.drift)}° ·
        ${td.headwind != null ? `${td.headwind >= 0 ? 'headwind' : 'tailwind'} ${Math.abs(td.headwind)} kt, crosswind ${Math.abs(td.crosswind)} kt from the ${td.crosswind >= 0 ? 'right' : 'left'} · ` : ''}peak ${num(td.g_max, 2)} g${a.runway_s ? ` · ${a.runway_s} s on the runway` : ''}</p></div>`;
    }).join('');
    out.push(sec('approaches', 'Approaches and landings', apBody || '<p class="db-note">No landings in this log.</p>',
      `Stabilised = every sample from ${crit.by_ft} ft above the runway down to 50 ft inside: IAS ${crit.vapp_kt - crit.ias_minus}–${crit.vapp_kt + crit.ias_plus} kt, sink ≤ ${crit.max_sink_fpm} fpm, bank ≤ ${crit.max_bank_deg}°, heading within ${crit.max_hdg_err_deg}° of the runway. ` +
      (crit.source === 'default' ? '<b>These are default limits</b> — put CATC\'s own numbers in config.yaml <code>analysis.stabilised</code>.' : 'Limits from config.yaml.') +
      ' Heights are baro altitude above the touchdown point; red cells break a limit.'));

    // ---------- legs vs book
    const legRows = (A.legs || []).map((l) => {
      const c = l.cruise;
      return `<tr><td>${at(l.off)} ${esc(l.from)}→${esc(l.to)}</td><td class="n">${l.min} min</td><td class="n">${num(l.dist_nm, 0)} NM</td>
        <td class="n">${l.climb ? `${num(l.climb.vs)} fpm @ ${l.climb.ias} kt` : '—'}</td>
        <td class="n">${c ? `${num(c.level_ft)} ft · ${c.min} min` : '—'}</td>
        <td class="n">${c ? `${c.rpm} / ${num(c.map, 1)}"` : '—'}</td>
        <td class="n">${c ? `${c.tas} <small>(${sgn(c.tas_vs_book)})</small>` : '—'}</td>
        <td class="n">${c ? `${num(c.ff, 1)} <small>(${sgn(c.ff_vs_book, 1)})</small>` : '—'}</td>
        <td class="n">${c ? `+${num(c.isa_dev, 0)} / ${num(c.density_alt)}` : '—'}</td></tr>`;
    });
    const book = (A.legs || []).find((l) => l.cruise)?.cruise.book;
    out.push(sec('legs', 'Legs and cruise performance', table([['Leg'], ['Time', 'n'], ['Dist', 'n'], ['Climb', 'n'], ['Cruise', 'n'], ['RPM / MAP', 'n'], ['KTAS (vs book)', 'n'], ['GPH (vs book)', 'n'], ['ISA / DA', 'n']], legRows),
      book ? `Book: the nearest power row (${book.pct}% · ${book.rpm} RPM · ${book.map}" → ${book.tas} KTAS, ${book.ff} GPH at 4 500 ft) from <b>${esc(book.source)}</b>. ISA deviation in °C, density altitude in ft.` : ''));

    // ---------- fuel
    const fr = (A.fuel?.runs || []).map((r) => `<tr><td>${at(r.start)}–${at(r.stop)}</td><td class="n">${num(r.gauge_start_gal, 1)}${r.gauge_capped ? '*' : ''}</td>
      <td class="n">${num(r.taxi_out_gal, 1)}</td><td class="n">${num(r.used_gal, 1)}</td><td class="n">${num(r.taxi_in_gal, 1)}</td><td class="n"><b>${num(r.remaining_gal, 1)}</b></td><td class="n">${r.endurance_min != null ? Math.floor(r.endurance_min / 60) + ':' + String(r.endurance_min % 60).padStart(2, '0') : '—'}</td></tr>`);
    const fl = (A.fuel?.legs || []).map((l) => `<tr><td>${esc(l.from)}→${esc(l.to)}</td><td class="n">${num(l.planned_gal, 1)}</td><td class="n">${num(l.used_gal, 1)}</td>
      <td class="n ${l.planned_gal && l.used_gal - l.planned_gal > 1 ? 'fail' : ''}">${l.planned_gal ? sgn(l.used_gal - l.planned_gal, 1) : '—'}</td></tr>`);
    out.push(sec('fuel', 'Fuel', table([['Engine run'], ['Start gal', 'n'], ['Taxi out', 'n'], ['Burned', 'n'], ['Taxi in', 'n'], ['Left', 'n'], ['Endurance', 'n']], fr) +
      table([['Leg'], ['Planned', 'n'], ['Burned', 'n'], ['Diff', 'n']], fl),
      'Burn is the integral of the fuel-flow sensor. Fuel on board at start is the tank gauges (*: they read at the top of their scale, ~21 gal a side, so a full tank may hold more). Endurance at the lesson\'s average cruise fuel flow.'));

    // ---------- nav log
    const nlog = (A.navlog || []).map((n) => {
      const rows = n.rows.filter((r) => r.checkpoint).map((r) => {
        const dt = r.act_min != null && r.plan_eto_min != null ? r.act_min - r.plan_eto_min : null;
        const w = (x) => (x && x[0] != null ? `${deg(x[0])}/${x[1]}` : '—');
        return `<tr${r.passed ? '' : ' class="missed"'}><td>${r.passed ? at(r.t, r.label) : esc(r.label)}</td>
          <td class="n">${num(r.plan_eto_min)}</td><td class="n">${num(r.act_min, 1)}</td><td class="n ${dt != null && Math.abs(dt) > 3 ? 'fail' : ''}">${sgn(dt, 1)}</td>
          <td class="n ${r.off_nm > 1 ? 'fail' : ''}">${num(r.off_nm, 1)}</td><td class="n">${num(r.plan_gs)} / ${num(r.act_gs)}</td>
          <td class="n">${num(r.plan_alt)} / ${num(r.act_alt)}</td><td class="n">${w(r.plan_wind)} / ${w(r.act_wind)}</td><td class="n">${num(r.plan_fuel, 1)} / ${num(r.act_fuel, 1)}</td></tr>`;
      });
      return `<div class="db-card"><div class="db-card-h"><b>${esc(n.from)} → ${esc(n.to)}</b> <span class="db-file">${esc(n.folder)} / ${esc(n.file)}</span></div>
        ${table([['Checkpoint'], ['Plan min', 'n'], ['Act min', 'n'], ['Δ', 'n'], ['Off NM', 'n'], ['GS plan/act', 'n'], ['Alt plan/act', 'n'], ['Wind plan/act', 'n'], ['Fuel plan/act', 'n']], rows)}</div>`;
    }).join('');
    out.push(sec('navlog', 'Nav log: plan vs actual', nlog || '<p class="db-note">No nav-log workbook matches these legs (config <code>navlog_dir</code>, folder named after the lesson).</p>',
      'Minutes from take-off. A checkpoint counts as passed when the track comes within 3 NM of it (greyed rows: not overflown). Winds true, from/kt; actual wind is the G1000 average over the segment before the checkpoint.'));

    // ---------- winds
    const wb = (A.winds?.bands || []).map((b) => `<tr><td>${esc(b.leg)}</td><td class="n">${num(b.band)}–${num(b.band + 999)}</td><td class="n">${b.min}</td><td class="n">${deg(b.from)} / ${b.kt} kt</td><td class="n">${num(b.oat, 1)} °C</td></tr>`);
    out.push(sec('winds', 'Winds aloft (measured)', table([['Leg'], ['Band ft', 'n'], ['Min', 'n'], ['Wind', 'n'], ['OAT', 'n']], wb),
      'From the G1000\'s own wind computation (TAS/heading vs GPS track), by 1 000 ft band. The forecast used for planning is in the nav-log table above, per checkpoint.'));

    // ---------- engine
    const E = A.engine || {};
    const ru = (E.runups || []).map((r) => `<tr><td>${at(r.t)}</td><td class="n">${r.s} s</td><td class="n">${num(r.rpm)}</td><td class="n">${num(r.oil_t)} °F</td>
      <td>${r.mag_checks.length ? r.mag_checks.map((m) => `${m.kind === 'mag' ? 'mag' : 'throttle'} −${m.drop_rpm} rpm, EGT ${sgn(m.egt_rise_f)} °F`).join('<br>') : '—'}</td></tr>`);
    const lim = E.limits || {};
    out.push(sec('engine', 'Engine', table([['Run-up'], ['Length', 'n'], ['RPM', 'n'], ['Oil T', 'n'], ['Drops seen']], ru) +
      `<div class="db-grid">
        <div><span>CHT max #1–4</span><b>${(E.cht_max || []).map((v, i) => `<em${v >= lim.cht_caution_f ? ' class="fail"' : ''}${i + 1 === E.hottest_cyl ? ' title="hottest"' : ''}>${v}</em>`).join(' ')} °F</b></div>
        <div><span>EGT max #1–4</span><b>${(E.egt_max || []).join(' ')} °F</b></div>
        <div><span>Time above ${lim.cht_caution_f} °F CHT</span><b>${E.cht_over_caution_s} s</b></div>
        <div><span>Fastest CHT cooling</span><b class="${E.shock_cool_max_f_min > lim.shock_cool_f_per_min ? 'fail' : ''}">${num(E.shock_cool_max_f_min)} °F/min</b></div>
        <div><span>Oil temp / pressure in flight</span><b>${(E.oil_t || []).join('–')} °F · ${(E.oil_p || []).join('–')} psi</b></div>
        <div><span>Lowest bus volts in flight</span><b>${num(E.volts_min_air, 1)} V</b></div>
      </div>`,
      `A magneto check shows as an RPM drop with every EGT rising (one plug per cylinder firing); a drop without the EGT rise is the throttle. Limits: CHT caution ${lim.cht_caution_f} °F, shock cooling above ${lim.shock_cool_f_per_min} °F/min.`));
  }

  // ---------- accuracy + progress (every lesson)
  const acc = { ...(F.accuracy || {}), ...(A?.accuracy?.tracking ? { tracking: A.accuracy.tracking } : {}), ...(A?.accuracy?.climb_speed ? { climb_speed: A.accuracy.climb_speed } : {}) };
  const tiles = [];
  if (acc.alt_hold) tiles.push(['Altitude hold', `${acc.alt_hold.within_100_pct}%`, `within ±100 ft · RMS ${acc.alt_hold.rms_ft} ft · ${acc.alt_hold.min} min level`]);
  if (acc.hdg_hold) tiles.push(['Heading hold', `±${acc.hdg_hold.sd_deg}°`, `SD wings level · ${acc.hdg_hold.within_5_pct}% within 5°`]);
  if (acc.turns) tiles.push(['Turns', `${acc.turns.bank_median}°`, `median bank · SD ${acc.turns.bank_sd}° · max ${acc.turns.max_bank}° · ${acc.turns.n} turns`]);
  if (acc.climb_speed) tiles.push(['Climb speed', `${acc.climb_speed.ias_median} kt`, `IAS SD ${acc.climb_speed.ias_sd} kt`]);
  for (const [src, v] of Object.entries(acc.tracking || {})) tiles.push([`${src === 'GPS' ? 'GPS' : 'VOR'} tracking`, `${v.within_half_pct}%`, `needle within half scale · median ${v.median_fs} · ${v.min} min`]);
  const prog = ctx.index.filter((f) => f.accuracy && f.accuracy.alt_hold).map((f) => {
    const a = f.accuracy;
    return `<tr${f.id === F.id ? ' class="gate"' : ''}><td>${esc(f.date.slice(5))}</td><td>${esc(f.lesson)}</td><td><span class="badge ${f.source}">${esc(f.source)}</span></td>
      <td class="n">${a.alt_hold.within_100_pct}%</td><td class="n">${a.alt_hold.rms_ft}</td><td class="n">${a.hdg_hold?.sd_deg ?? '—'}</td><td class="n">${a.turns?.bank_sd ?? '—'}</td></tr>`;
  });
  out.push(sec('accuracy', 'Flying accuracy', `<div class="db-tiles">${tiles.map(([k, v, s]) => `<div><span>${k}</span><b>${v}</b><small>${s}</small></div>`).join('')}</div>
    <h4>Across lessons</h4>${table([['Date'], ['Lesson'], ['Source'], ['±100 ft', 'n'], ['Alt RMS', 'n'], ['HDG SD', 'n'], ['Bank SD', 'n']], prog)}`,
    'Altitude hold: every level stretch of 2 min or more against its nearest 100 ft. Heading hold: wings-level stretches of 60 s or more. Turns: bank held 10° or more for 10 s. Lessons with GPS or 15 s tracks have estimated bank, so compare those columns with care.'));

  root.innerHTML = out.join('');
  root.querySelectorAll('.db-t').forEach((b) => b.addEventListener('click', () => ctx.jump(+b.dataset.t)));
}
