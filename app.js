const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const A4 = 440;
const A4_MIDI = 69;
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
};

function hzToMidi(hz) { return 12 * Math.log2(hz / A4) + A4_MIDI; }
function midiToNote(midi) {
  const n = Math.round(midi);
  return `${NOTES[((n % 12) + 12) % 12]}${Math.floor(n / 12) - 1}`;
}
function zone(midi) {
  if (midi < 50) return 'Very low';
  if (midi < 58) return 'Low';
  if (midi < 67) return 'Middle';
  if (midi < 76) return 'High';
  return 'Very high';
}

let ctx, source, pitchNode, tuneNode, gate, mic;

async function loadWorklet(path) {
  const res = await fetch(new URL(path, import.meta.url));
  if (!res.ok) throw new Error(`Could not load ${path}`);
  const src = await res.text();
  const blob = new Blob([src], { type: 'text/javascript' });
  const url = URL.createObjectURL(blob);
  try {
    await ctx.audioWorklet.addModule(url);
  } finally {
    URL.revokeObjectURL(url);
  }
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
  if (gate && ctx) {
    gate.gain.setTargetAtTime(state.tuneOn ? 1 : 0, ctx.currentTime, 0.04);
  }
  updateTuneStatus();
}

function updateTuneStatus() {
  const key = `${NOTES[state.rootPc]} ${state.mode}`;
  const el = $('tune-status');
  if (!el) return;
  if (!state.running) {
    el.textContent = 'Start the mic to hear correction.';
    return;
  }
  if (!state.tuneOn) {
    el.textContent = `Ready on ${key}. Headphones on before you flip it.`;
    return;
  }
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

function onPitch(frame) {
  const live = frame.f0 > 0 && frame.clarity > 0.35;
  if (!live) {
    setCoach('listen', 'I need a clearer sound', 'Try a steady hum like “mmm.”', 0.5, 'Waiting');
    $('note-name').textContent = '—';
    $('cents-label').textContent = '—';
    return;
  }
  state.frames += 1;
  const midi = hzToMidi(frame.f0);
  const nearest = Math.round(midi);
  const cents = (midi - nearest) * 100;
  const abs = Math.abs(cents);
  const note = midiToNote(midi);
  const meter = Math.max(0, Math.min(1, (midi - 40) / 45));
  $('note-name').textContent = note;
  $('cents-label').textContent = `${cents >= 0 ? '+' : ''}${cents.toFixed(0)}¢`;
  $('cents-needle').style.left = `${50 + Math.max(-50, Math.min(50, cents))}%`;
  $('meter-dot').style.left = `${meter * 100}%`;
  $('zone-label').textContent = zone(midi);
  state.centsAbs = state.centsAbs * 0.96 + abs * 0.04;
  if (frame.clarity > state.bestClarity) {
    state.bestClarity = frame.clarity;
    state.bestNote = note;
  }
  if (abs <= 10) {
    state.holdSec += 0.046;
    setCoach('hold', 'Hold it right there', 'Centered. Keep the same breath and mouth shape.', meter, zone(midi));
  } else if (cents < 0) {
    setCoach('higher', 'Go a little higher', 'Tiny lift, not a big jump. Smile behind the sound.', meter, zone(midi));
  } else {
    setCoach('lower', 'Go a little lower', 'Relax your jaw and let the sound settle down.', meter, zone(midi));
  }
  renderStats();
}

function setCoach(action, title, hint, meter, zoneName) {
  const chip = $('action-chip');
  chip.className = `chip ${action === 'listen' ? 'wait' : action}`;
  chip.textContent = action === 'higher' ? 'UP' : action === 'lower' ? 'DOWN' : action === 'hold' ? 'OK' : '…';
  $('coach-title').textContent = title;
  $('coach-hint').textContent = hint;
  $('meter-dot').style.left = `${meter * 100}%`;
  $('zone-label').textContent = zoneName;
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
buildStyles();
renderStats();
updateTuneStatus();
