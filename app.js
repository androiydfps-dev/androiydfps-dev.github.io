const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const A4 = 440;
const A4_MIDI = 69;
const SCALE_PCS = {
  Chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  Major: [0, 2, 4, 5, 7, 9, 11],
  Minor: [0, 2, 3, 5, 7, 8, 10],
};
const STYLES = [
  { id: 'natural', name: 'Natural', speed: 0.20, scale: 'Major' },
  { id: 'pop', name: 'Pop', speed: 0.55, scale: 'Major' },
  { id: 'rnb', name: 'R&B', speed: 0.40, scale: 'Minor' },
  { id: 'trap', name: 'Trap', speed: 0.92, scale: 'Minor' },
  { id: 'tpain', name: 'Hard', speed: 1.00, scale: 'Chromatic' },
];

const $ = (id) => document.getElementById(id);
const state = {
  running: false,
  tab: 'coach',
  rootPc: 0,
  mode: 'Major',
  tuneOn: false,
  strength: 0.75,
  speed: 0.5,
  holdSec: 0,
  frames: 0,
  centsAbs: 0,
  bestNote: '—',
  bestClarity: 0,
  targetName: '—',
  autoTarget: true,
  lockedPc: null,
  viewLow: 48,
  viewHigh: 72,
};

function hzToMidi(hz) { return 12 * Math.log2(hz / A4) + A4_MIDI; }
function midiToNote(midi) {
  const n = Math.round(midi);
  return `${NOTES[((n % 12) + 12) % 12]}${Math.floor(n / 12) - 1}`;
}
function scaleSet() {
  const intervals = SCALE_PCS[state.mode] || SCALE_PCS.Major;
  return new Set(intervals.map((iv) => (state.rootPc + iv) % 12));
}
function snapMidi(midiF) {
  if (!state.autoTarget && state.lockedPc != null) {
    const base = Math.round(midiF);
    let best = base;
    let bestDist = 99;
    for (let d = -24; d <= 24; d++) {
      const cand = base + d;
      if (((cand % 12) + 12) % 12 === state.lockedPc) {
        const dist = Math.abs(midiF - cand);
        if (dist < bestDist) { bestDist = dist; best = cand; }
      }
    }
    return best;
  }
  const allowed = scaleSet();
  const baseMidi = Math.round(midiF);
  for (let d = 0; d < 12; d++) {
    const up = baseMidi + d;
    const dn = baseMidi - d;
    if (allowed.has(((up % 12) + 12) % 12)) return up;
    if (d > 0 && allowed.has(((dn % 12) + 12) % 12)) return dn;
  }
  return baseMidi;
}
function tipFor(cents, abs, inZone) {
  if (inZone) return {
    action: 'hold',
    title: 'Hold it right there',
    hint: 'You are in the target band. Keep the same breath, jaw, and mouth shape.',
    dir: 'Centered',
  };
  if (abs < 25) {
    return cents < 0
      ? { action: 'higher', title: 'Tiny lift', hint: 'Smile a little and think the note up — do not jump.', dir: 'A hair higher' }
      : { action: 'lower', title: 'Settle a hair', hint: 'Relax the jaw and let the sound drop without going airy.', dir: 'A hair lower' };
  }
  if (abs < 80) {
    return cents < 0
      ? { action: 'higher', title: 'Slide up toward the band', hint: 'Glide, do not hop. Keep the vowel the same while you rise.', dir: 'Go higher' }
      : { action: 'lower', title: 'Slide down toward the band', hint: 'Ease the support and let pitch melt down into the green.', dir: 'Go lower' };
  }
  return cents < 0
    ? { action: 'higher', title: 'You are under the note', hint: 'Take a small reset breath, then place the sound higher and hold.', dir: 'Well below' }
    : { action: 'lower', title: 'You are over the note', hint: 'Back off the squeeze in the throat and place it down into the band.', dir: 'Well above' };
}

let ctx, source, pitchNode, tuneNode, gate, mic;

async function loadWorklet(path) {
  const res = await fetch(new URL(path, import.meta.url));
  if (!res.ok) throw new Error(`Could not load ${path}`);
  const src = await res.text();
  const blob = new Blob([src], { type: 'text/javascript' });
  const url = URL.createObjectURL(blob);
  try { await ctx.audioWorklet.addModule(url); }
  finally { URL.revokeObjectURL(url); }
}

function pushConfig() {
  if (!tuneNode) return;
  tuneNode.port.postMessage({
    type: 'config',
    enabled: state.tuneOn,
    rootPc: state.rootPc,
    scaleName: state.mode,
    strength: state.strength,
    speed: state.speed,
  });
  if (gate && ctx) gate.gain.setTargetAtTime(state.tuneOn ? 1 : 0, ctx.currentTime, 0.04);
  updateTuneStatus();
}

function updateTuneStatus() {
  const key = `${NOTES[state.rootPc]} ${state.mode}`;
  const el = $('tune-status');
  if (!el) return;
  if (!state.running) { el.textContent = 'Start the mic to hear correction.'; return; }
  if (!state.tuneOn) { el.textContent = `Ready on ${key}. Headphones on before you flip it.`; return; }
  el.textContent = `Correcting toward ${key} · ${Math.round(state.strength * 100)}% · target ${state.targetName}`;
}

async function startMic() {
  ctx = new AudioContext({ latencyHint: 'interactive' });
  if (ctx.state === 'suspended') await ctx.resume();
  await loadWorklet('./worklets/pitch-detector.js');
  await loadWorklet('./worklets/autotune.js');
  mic = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
  });
  source = ctx.createMediaStreamSource(mic);
  pitchNode = new AudioWorkletNode(ctx, 'pitch-detector', {
    numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1, channelCountMode: 'explicit',
  });
  pitchNode.port.onmessage = (e) => { if (e.data?.type === 'pitch') onPitch(e.data); };
  tuneNode = new AudioWorkletNode(ctx, 'autotune', {
    numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1, channelCountMode: 'explicit',
  });
  tuneNode.port.onmessage = (e) => {
    if (e.data?.type === 'correction' && e.data.targetMidi != null) {
      state.targetName = midiToNote(e.data.targetMidi);
      updateTuneStatus();
    }
  };
  gate = ctx.createGain();
  gate.gain.value = 0;
  source.connect(pitchNode);
  source.connect(tuneNode);
  tuneNode.connect(gate);
  gate.connect(ctx.destination);
  state.running = true;
  pushConfig();
}

function midiToPct(midi) {
  const span = state.viewHigh - state.viewLow;
  const p = (midi - state.viewLow) / span;
  return Math.max(4, Math.min(96, (1 - p) * 100));
}

function paintTicks() {
  const wrap = $('lane-ticks');
  if (!wrap) return;
  wrap.innerHTML = '';
  const low = Math.ceil(state.viewLow);
  const high = Math.floor(state.viewHigh);
  for (let m = low; m <= high; m++) {
    if (m % 2 !== 0) continue;
    const i = document.createElement('i');
    i.style.top = `${midiToPct(m)}%`;
    if (m % 12 === 0) {
      const b = document.createElement('b');
      b.textContent = midiToNote(m);
      i.appendChild(b);
    }
    wrap.appendChild(i);
  }
}

function onPitch(frame) {
  const live = frame.f0 > 0 && frame.clarity > 0.35;
  if (!live) {
    setCoach('listen', 'I need a clearer sound', 'Try a steady hum like “mmm.”');
    $('note-name').textContent = '—';
    $('cents-label').textContent = '—';
    $('gap-label').textContent = '—';
    $('dir-label').textContent = 'Waiting';
    return;
  }
  state.frames += 1;
  const midi = hzToMidi(frame.f0);
  const target = snapMidi(midi);
  const cents = (midi - target) * 100;
  const abs = Math.abs(cents);
  const note = midiToNote(midi);
  const targetNote = midiToNote(target);

  state.viewLow = target - 6;
  state.viewHigh = target + 6;
  paintTicks();
  $('lane-you').style.top = `${midiToPct(midi)}%`;
  $('lane-target').style.top = `${midiToPct(target)}%`;

  $('note-name').textContent = note;
  $('target-name').textContent = targetNote;
  $('cents-label').textContent = `${cents >= 0 ? '+' : ''}${cents.toFixed(0)}¢`;
  $('gap-label').textContent = `${abs.toFixed(0)}¢`;
  $('target-mode-label').textContent = state.autoTarget ? 'Nearest in-scale' : 'Locked note';

  const inZone = abs <= 12;
  const tip = tipFor(cents, abs, inZone);
  $('dir-label').textContent = tip.dir;
  if (inZone) state.holdSec += 0.046;
  if (frame.clarity > state.bestClarity) {
    state.bestClarity = frame.clarity;
    state.bestNote = note;
  }
  state.centsAbs = state.centsAbs * 0.96 + abs * 0.04;
  setCoach(tip.action, tip.title, tip.hint);
  renderStats();
}

function setCoach(action, title, hint) {
  const chip = $('action-chip');
  chip.className = `chip ${action === 'listen' ? 'wait' : action}`;
  chip.textContent = action === 'higher' ? 'UP' : action === 'lower' ? 'DOWN' : action === 'hold' ? 'OK' : '…';
  $('coach-title').textContent = title;
  $('coach-hint').textContent = hint;
}

function renderStats() {
  $('stat-hold').textContent = `${state.holdSec.toFixed(1)}s`;
  $('stat-note').textContent = state.bestNote;
  $('stat-cents').textContent = state.frames ? `${state.centsAbs.toFixed(0)}¢` : '—';
  $('stat-frames').textContent = String(state.frames);
}

function showTab(name) {
  state.tab = name;
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('is-on', b.dataset.tab === name));
  document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('is-on', p.id === `panel-${name}`));
  $('mode-title').textContent = name === 'tune' ? 'Tune' : name === 'session' ? 'Session' : 'Coach';
}

function buildKeys() {
  const wrap = $('keys');
  wrap.innerHTML = '';
  NOTES.forEach((n, i) => {
    const b = document.createElement('button');
    b.textContent = n;
    if (i === state.rootPc) b.classList.add('is-on');
    b.onclick = () => { state.rootPc = i; buildKeys(); pushConfig(); };
    wrap.appendChild(b);
  });
}

function buildTargetKeys() {
  const wrap = $('target-keys');
  wrap.innerHTML = '';
  NOTES.forEach((n, i) => {
    const b = document.createElement('button');
    b.textContent = n;
    if (!state.autoTarget && state.lockedPc === i) b.classList.add('is-on');
    b.onclick = () => {
      state.autoTarget = false;
      state.lockedPc = i;
      $('auto-target').classList.remove('is-on');
      buildTargetKeys();
    };
    wrap.appendChild(b);
  });
}

function buildStyles() {
  const wrap = $('styles');
  if (!wrap) return;
  wrap.innerHTML = '';
  STYLES.forEach((style) => {
    const b = document.createElement('button');
    b.className = 'pill';
    b.textContent = style.name;
    b.onclick = () => {
      state.speed = style.speed;
      state.mode = style.scale === 'Chromatic' ? 'Chromatic' : style.scale;
      $('speed').value = String(Math.round(style.speed * 100));
      $('spd-val').textContent = String(Math.round(style.speed * 100));
      document.querySelectorAll('[data-mode]').forEach((x) => {
        x.classList.toggle('is-on', x.dataset.mode === state.mode);
      });
      pushConfig();
    };
    wrap.appendChild(b);
  });
}

$('start-btn').onclick = async () => {
  $('gate-error').classList.add('hidden');
  try {
    await startMic();
    $('gate').classList.add('hidden');
  } catch (err) {
    $('gate-error').textContent = err.message || 'Could not start the microphone.';
    $('gate-error').classList.remove('hidden');
  }
};
$('explore-btn').onclick = () => $('gate').classList.add('hidden');
document.querySelectorAll('.tab').forEach((b) => { b.onclick = () => showTab(b.dataset.tab); });
document.querySelectorAll('[data-mode]').forEach((b) => {
  b.onclick = () => {
    state.mode = b.dataset.mode;
    document.querySelectorAll('[data-mode]').forEach((x) => x.classList.toggle('is-on', x === b));
    pushConfig();
  };
});
$('auto-target').onclick = () => {
  state.autoTarget = true;
  state.lockedPc = null;
  $('auto-target').classList.add('is-on');
  buildTargetKeys();
  $('target-mode-label').textContent = 'Nearest in-scale';
};
$('tune-toggle').onclick = async () => {
  if (!state.running) {
    try {
      await startMic();
      $('gate').classList.add('hidden');
    } catch (err) {
      $('gate-error').textContent = err.message || 'Could not start the microphone.';
      $('gate-error').classList.remove('hidden');
      showTab('tune');
      $('gate').classList.remove('hidden');
      return;
    }
  }
  state.tuneOn = !state.tuneOn;
  $('tune-toggle').classList.toggle('is-on', state.tuneOn);
  $('tune-toggle').textContent = state.tuneOn ? 'ON' : 'OFF';
  $('tune-toggle').setAttribute('aria-pressed', String(state.tuneOn));
  pushConfig();
};
$('strength').oninput = (e) => {
  state.strength = e.target.value / 100;
  $('str-val').textContent = e.target.value;
  pushConfig();
};
$('speed').oninput = (e) => {
  state.speed = e.target.value / 100;
  $('spd-val').textContent = e.target.value;
  pushConfig();
};

buildKeys();
buildTargetKeys();
buildStyles();
paintTicks();
renderStats();
updateTuneStatus();
