// Call audio player with a real waveform and transcript sync.
import { h, icon } from './ui.js';

const fmt = (s) => {
  s = Math.max(0, Math.floor(s || 0));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

/**
 * Map each transcript line (ISO timestamps) to a position in the recording.
 * The recording starts at the "recording started" system event and skips the
 * paused intervals; the result is scaled to the real file length.
 */
export function audioTimeline(transcript, duration) {
  const secs = transcript.map((m) => Date.parse(m.timestamp) / 1000);
  if (!secs.length || secs.some((s) => Number.isNaN(s))) return null;
  const sys = (i, re) => transcript[i].speaker === 'system' && re.test(transcript[i].text || '');
  let start = secs[0];
  const startIdx = transcript.findIndex((_, i) => sys(i, /запущен|басталды|recording started/i));
  if (startIdx >= 0) start = secs[startIdx];
  const pauses = [];
  let pausedAt = null;
  transcript.forEach((_, i) => {
    if (sys(i, /приостановлен|paused|тоқтатыл/i)) pausedAt = secs[i];
    else if (sys(i, /возобновлен|resumed|жалғасты/i) && pausedAt != null) { pauses.push([pausedAt, secs[i]]); pausedAt = null; }
  });
  const active = (t) => {
    let a = t - start;
    for (const [s, e] of pauses) { if (t >= e) a -= e - s; else if (t > s) a -= t - s; }
    return Math.max(0, a);
  };
  const raw = secs.map(active);
  const last = raw[raw.length - 1] || 1;
  const k = duration ? duration / last : 1;
  const scale = k > 0.7 && k < 1.3 ? k : 1;
  return raw.map((a) => Math.min(a * scale, duration || Infinity));
}

export function createPlayer({ src, transcript, onIndex }) {
  const audio = new Audio();
  audio.preload = 'auto';
  let peaks = null;
  let timeline = null;
  let raf = 0;
  let lastIndex = -1;

  const playBtn = h('button', { class: 'play', 'aria-label': 'Воспроизвести', disabled: true }, icon('play', 22));
  const timeEl = h('div', { class: 'time' }, '00:00 ', h('span', null, '/ --:--'));
  const canvas = h('canvas');
  const wave = h('div', { class: 'wave' }, canvas);
  const speeds = [1, 1.25, 1.5, 2];
  const speedBtn = h('button', { class: 'speed', type: 'button' }, '1x');
  const loading = h('span', { class: 'loading' }, 'Загрузка записи…');
  const el = h('div', { class: 'player' }, playBtn, timeEl, wave, loading, speedBtn);

  speedBtn.addEventListener('click', () => {
    const next = speeds[(speeds.indexOf(audio.playbackRate) + 1) % speeds.length];
    audio.playbackRate = next;
    speedBtn.textContent = `${next}x`;
  });
  playBtn.addEventListener('click', () => (audio.paused ? audio.play() : audio.pause()));
  audio.addEventListener('play', () => { playBtn.replaceChildren(icon('pause', 22)); loop(); });
  audio.addEventListener('pause', () => { playBtn.replaceChildren(icon('play', 22)); cancelAnimationFrame(raf); draw(); });
  audio.addEventListener('ended', () => { playBtn.replaceChildren(icon('play', 22)); });
  audio.addEventListener('loadedmetadata', () => {
    timeline = audioTimeline(transcript, audio.duration);
    playBtn.disabled = false;
    loading.remove();
    tick();
  });
  audio.addEventListener('timeupdate', tick);

  // seeking by click / drag on the waveform
  let dragging = false;
  const seekAt = (clientX) => {
    if (!audio.duration) return;
    const r = wave.getBoundingClientRect();
    audio.currentTime = Math.min(1, Math.max(0, (clientX - r.left) / r.width)) * audio.duration;
    tick();
  };
  wave.addEventListener('pointerdown', (e) => { dragging = true; wave.setPointerCapture(e.pointerId); seekAt(e.clientX); });
  wave.addEventListener('pointermove', (e) => { if (dragging) seekAt(e.clientX); });
  wave.addEventListener('pointerup', () => { dragging = false; });

  function loop() { tick(); raf = requestAnimationFrame(loop); }

  function tick() {
    timeEl.replaceChildren(`${fmt(audio.currentTime)} `, h('span', null, `/ ${fmt(audio.duration)}`));
    draw();
    if (!timeline) return;
    let idx = -1;
    for (let i = 0; i < timeline.length; i++) {
      const sp = transcript[i].speaker;
      if (sp === 'system') continue;
      if (timeline[i] <= audio.currentTime + 0.25) idx = i; else break;
    }
    if (idx !== lastIndex) { lastIndex = idx; onIndex?.(idx, !audio.paused); }
  }

  function draw() {
    const dpr = window.devicePixelRatio || 1;
    const w = wave.clientWidth, hgt = wave.clientHeight;
    if (!w) return;
    if (canvas.width !== Math.round(w * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(hgt * dpr); }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, hgt);
    const barW = 3, gap = 2, n = Math.floor(w / (barW + gap));
    const progress = audio.duration ? audio.currentTime / audio.duration : 0;
    for (let i = 0; i < n; i++) {
      const p = peaks ? peaks[Math.floor((i / n) * peaks.length)] : 0.15 + 0.1 * Math.abs(Math.sin(i * 0.7));
      const bh = Math.max(3, p * (hgt - 6));
      ctx.fillStyle = i / n <= progress ? '#6FE09A' : 'rgba(255,255,255,.32)';
      const x = i * (barW + gap);
      roundRect(ctx, x, (hgt - bh) / 2, barW, bh, 1.5);
    }
    if (audio.duration) {
      const x = progress * w;
      ctx.fillStyle = '#fff';
      ctx.fillRect(x - 1, 2, 2, hgt - 4);
      ctx.beginPath(); ctx.arc(x, hgt / 2, 5, 0, Math.PI * 2); ctx.fill();
    }
  }

  function roundRect(ctx, x, y, w, hh, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + hh, r); ctx.arcTo(x + w, y + hh, x, y + hh, r);
    ctx.arcTo(x, y + hh, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.fill();
  }

  // Load once: the same bytes feed the <audio> element and the waveform.
  let objectUrl = null;
  (async () => {
    try {
      const res = await fetch(src);
      if (!res.ok) throw new Error();
      const buf = await res.arrayBuffer();
      objectUrl = URL.createObjectURL(new Blob([buf], { type: 'audio/mpeg' }));
      audio.src = objectUrl;
      try {
        const AC = window.AudioContext || window.webkitAudioContext;
        const ac = new AC();
        const decoded = await ac.decodeAudioData(buf.slice(0));
        peaks = computePeaks(decoded.getChannelData(0), 220);
        ac.close();
        draw();
      } catch { /* waveform is optional */ }
    } catch {
      loading.textContent = 'Запись недоступна';
    }
  })();

  const ro = new ResizeObserver(() => draw());
  ro.observe(wave);

  return {
    el,
    seekToIndex(i, play = false) {
      if (!timeline || timeline[i] == null) return;
      audio.currentTime = timeline[i];
      tick();
      if (play) audio.play();
    },
    canSeek: () => !!timeline,
    destroy() {
      audio.pause();
      cancelAnimationFrame(raf);
      ro.disconnect();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    },
  };
}

function computePeaks(data, n) {
  const size = Math.floor(data.length / n) || 1;
  const out = [];
  let max = 0;
  for (let i = 0; i < n; i++) {
    let sum = 0;
    const start = i * size;
    for (let j = start; j < start + size && j < data.length; j += 4) sum += data[j] * data[j];
    const rms = Math.sqrt(sum / (size / 4));
    out.push(rms);
    if (rms > max) max = rms;
  }
  return out.map((v) => (max ? Math.pow(v / max, 0.7) : 0));
}
