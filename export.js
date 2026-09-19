// MP4 export: steps the replay frame by frame (not in real time), waits for the map tiles of each frame,
// composites map + instrument overlay, and encodes H.264 with WebCodecs into an MP4 (mp4-muxer).
// Output timing is exact: frame i is stamped i / fps, whatever the render speed.
import { Muxer, ArrayBufferTarget, StreamTarget } from 'mp4-muxer';

const CODECS = ['avc1.640033', 'avc1.640032', 'avc1.640028', 'avc1.4d0033', 'avc1.42003e'];   // High 5.1 … Baseline
const BITRATE = { 720: 6e6, 1080: 12e6, 1440: 20e6, 2160: 40e6 };

async function pickCodec(W, H, fps, bitrate) {
  for (const codec of CODECS) {
    const cfg = { codec, width: W, height: H, bitrate, framerate: fps, avc: { format: 'avc' } };
    try { if ((await VideoEncoder.isConfigSupported(cfg)).supported) return cfg; } catch { /* try the next */ }
  }
  throw new Error(`this browser cannot encode ${W}×${H} H.264`);
}

// draw this frame synchronously once its tiles are in (or after maxMs): no dependence on requestAnimationFrame,
// which browsers throttle in background tabs
async function settled(map, maxMs = 4000) {
  const t0 = performance.now();
  map.redraw();
  while (!map.areTilesLoaded() && performance.now() - t0 < maxMs) {
    await new Promise((r) => setTimeout(r, 25));
  }
  map.redraw();
}

export async function exportVideo(o, { map, mapEl, step, paint, cancelled, progress }) {
  if (!('VideoEncoder' in window)) throw new Error('this browser has no WebCodecs video encoder — use Chrome, Edge or Safari 17+');
  // ask where to save first, while the click still counts as a user gesture (Chrome/Edge)
  let handle = null;
  if (window.showSaveFilePicker) {
    handle = await window.showSaveFilePicker({ suggestedName: o.name, types: [{ description: 'MP4 video', accept: { 'video/mp4': ['.mp4'] } }] });
  }
  const cfg = await pickCodec(o.W, o.H, o.fps, BITRATE[o.H] || 12e6);
  const stream = handle ? await handle.createWritable() : null;
  // streamed straight to the chosen file (long exports never sit in memory); else built in memory and downloaded
  let writes = Promise.resolve();
  const target = stream
    ? new StreamTarget({ chunked: true, onData: (data, position) => { writes = writes.then(() => stream.write({ type: 'write', data, position })); } })
    : new ArrayBufferTarget();
  const muxer = new Muxer({ target, video: { codec: 'avc', width: o.W, height: o.H, frameRate: o.fps },
    fastStart: stream ? false : 'in-memory', firstTimestampBehavior: 'offset' });
  let failure = null;
  const enc = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: (e) => { failure = e; } });
  enc.configure(cfg);

  // render the map at exactly the output size, 1 device pixel per pixel
  const saved = { w: mapEl.style.width, h: mapEl.style.height, pr: map.getPixelRatio() };
  mapEl.style.width = `${o.W}px`; mapEl.style.height = `${o.H}px`;
  map.setPixelRatio(1); map.resize();
  const out = document.createElement('canvas');
  out.width = o.W; out.height = o.H;
  const ctx = out.getContext('2d');

  const n = Math.max(1, Math.ceil((o.t1 - o.t0) / o.speed * o.fps));
  const started = performance.now();
  let i = 0;
  try {
    for (; i < n && !cancelled(); i++) {
      if (failure) throw failure;
      const s = step(o.t0 + i * o.speed / o.fps, 1 / o.fps);
      await settled(map);
      ctx.drawImage(map.getCanvas(), 0, 0, o.W, o.H);
      paint(ctx, s);
      const frame = new VideoFrame(out, { timestamp: Math.round(i * 1e6 / o.fps), duration: Math.round(1e6 / o.fps) });
      enc.encode(frame, { keyFrame: i % (o.fps * 2) === 0 });
      frame.close();
      while (enc.encodeQueueSize > 4) await new Promise((r) => setTimeout(r, 4));
      if (i % 5 === 0) progress(i, n, (i + 1) / ((performance.now() - started) / 1000));
    }
    await enc.flush();
    if (failure) throw failure;
    muxer.finalize();
    if (stream) { await writes; await stream.close(); }
    else {
      const url = URL.createObjectURL(new Blob([target.buffer], { type: 'video/mp4' }));
      const a = Object.assign(document.createElement('a'), { href: url, download: o.name });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    }
    progress(i, n, (i + 1) / ((performance.now() - started) / 1000));
  } finally {
    if (enc.state !== 'closed') enc.close();
    mapEl.style.width = saved.w; mapEl.style.height = saved.h;
    map.setPixelRatio(saved.pr); map.resize();
  }
}
