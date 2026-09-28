// Real-time pitch corrector. YIN pitch estimate + TD-PSOLA shift.
const FRAME = 1024;
const HOP = 256;
const MIN_F0 = 75;
const MAX_F0 = 1000;
const YIN_THRESHOLD = 0.15;
const RING_SECONDS = 0.5;

const SCALES = {
  Chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  Major: [0, 2, 4, 5, 7, 9, 11],
  Minor: [0, 2, 3, 5, 7, 8, 10],
  HarmonicMinor: [0, 2, 3, 5, 7, 8, 11],
  Pentatonic: [0, 2, 4, 7, 9],
  MinorPentatonic: [0, 3, 5, 7, 10],
  Blues: [0, 3, 5, 6, 7, 10],
  Dorian: [0, 2, 3, 5, 7, 9, 10],
  Mixolydian: [0, 2, 4, 5, 7, 9, 10],
};

class Autotune extends AudioWorkletProcessor {
  constructor() {
    super();
    this.cfg = { enabled: false, rootPc: 0, scaleName: 'Major', strength: 0.75, speed: 0.5 };
    this.scaleSet = this._buildScale(0, 'Major');
    this.ringSize = Math.max(8192, Math.ceil(sampleRate * RING_SECONDS));
    this.inRing = new Float32Array(this.ringSize);
    this.outRing = new Float32Array(this.ringSize);
    this.inWrite = 0;
    this.outRead = 0;
    this.outWrite = 0;
    this.processedUpTo = 0;
    this.yinBuf = new Float32Array(FRAME / 2);
    this.lastF0 = 0;
    this.smoothMidi = 0;
    this.smoothMidiSet = false;
    this.f0Hist = [];
    this.lockedTarget = null;
    this.epochs = [];
    this.lastEpoch = -1;
    this.lastOutEpoch = null;
    this.inSamples = 0;
    this.outSamples = 0;
    this.port.onmessage = (e) => {
      const d = e.data;
      if (d && d.type === 'config') {
        this.cfg = { ...this.cfg, ...d };
        this.scaleSet = this._buildScale(this.cfg.rootPc | 0, this.cfg.scaleName || 'Major');
      }
    };
  }
  _buildScale(rootPc, name) {
    const intervals = SCALES[name] || SCALES.Chromatic;
    const s = new Set();
    for (const iv of intervals) s.add((rootPc + iv) % 12);
    return s;
  }
  _hzToMidi(hz) { return 12 * Math.log2(hz / 440) + 69; }
  _midiToHz(m) { return 440 * Math.pow(2, (m - 69) / 12); }
  _snapMidi(midiF) {
    const baseMidi = Math.round(midiF);
    for (let d = 0; d < 12; d++) {
      const upPc = ((baseMidi + d) % 12 + 12) % 12;
      const dnPc = ((baseMidi - d) % 12 + 12) % 12;
      if (d === 0 && this.scaleSet.has(upPc)) return baseMidi;
      if (this.scaleSet.has(upPc)) return baseMidi + d;
      if (this.scaleSet.has(dnPc)) return baseMidi - d;
    }
    return baseMidi;
  }
  _yin(frameStart) {
    const W = this.yinBuf.length;
    const r = this.inRing;
    const N = this.ringSize;
    for (let tau = 0; tau < W; tau++) {
      let sum = 0;
      for (let i = 0; i < W; i++) {
        const a = r[(frameStart + i) % N];
        const b = r[(frameStart + i + tau) % N];
        const diff = a - b;
        sum += diff * diff;
      }
      this.yinBuf[tau] = sum;
    }
    this.yinBuf[0] = 1;
    let running = 0;
    for (let tau = 1; tau < W; tau++) {
      running += this.yinBuf[tau];
      this.yinBuf[tau] = (this.yinBuf[tau] * tau) / (running || 1e-12);
    }
    let tau = 2;
    for (; tau < W; tau++) {
      if (this.yinBuf[tau] < YIN_THRESHOLD) {
        while (tau + 1 < W && this.yinBuf[tau + 1] < this.yinBuf[tau]) tau++;
        break;
      }
    }
    if (tau >= W) return { f0: 0, clarity: 0 };
    const s0 = this.yinBuf[tau - 1] ?? this.yinBuf[tau];
    const s1 = this.yinBuf[tau];
    const s2 = this.yinBuf[tau + 1] ?? this.yinBuf[tau];
    const denom = 2 * (2 * s1 - s2 - s0);
    const tauI = Math.abs(denom) < 1e-9 ? tau : tau + (s2 - s0) / denom;
    const f0 = sampleRate / tauI;
    const clarity = 1 - this.yinBuf[tau];
    if (f0 < MIN_F0 || f0 > MAX_F0) return { f0: 0, clarity: 0 };
    return { f0, clarity };
  }
  _findEpochs(rangeStart, rangeEnd, T0) {
    const search = Math.max(2, Math.floor(T0 / 4));
    const r = this.inRing;
    const N = this.ringSize;
    let pos = this.lastEpoch < 0 ? rangeStart + Math.floor(T0 / 2) : this.lastEpoch + Math.round(T0);
    while (pos < rangeEnd) {
      let bestIdx = pos;
      let bestVal = r[((pos % N) + N) % N];
      for (let k = -search; k <= search; k++) {
        const idx = pos + k;
        if (idx < 0 || idx >= this.inSamples) continue;
        const v = r[((idx % N) + N) % N];
        if (v > bestVal) { bestVal = v; bestIdx = idx; }
      }
      this.epochs.push(bestIdx);
      this.lastEpoch = bestIdx;
      pos = bestIdx + Math.round(T0);
    }
  }
  _addGrain(inputCenter, outputCenter, T0_in) {
    const half = Math.max(8, T0_in);
    const r = this.inRing;
    const N = this.ringSize;
    const outR = this.outRing;
    for (let i = -half; i <= half; i++) {
      const inIdx = inputCenter + i;
      if (inIdx < 0) continue;
      const sample = r[((inIdx % N) + N) % N];
      const w = 0.5 + 0.5 * Math.cos((Math.PI * i) / half);
      const outIdx = outputCenter + i;
      if (outIdx < 0) continue;
      outR[((outIdx % N) + N) % N] += sample * w;
    }
  }
  _analyzeAndSynthesize() {
    while (this.inSamples - this.processedUpTo >= FRAME) {
      const frameStart = this.processedUpTo;
      const { f0, clarity } = this._yin(frameStart);
      if (f0 > 0 && clarity > 0.4) {
        this.f0Hist.push(f0);
        if (this.f0Hist.length > 5) this.f0Hist.shift();
        const sorted = this.f0Hist.slice().sort((a, b) => a - b);
        const f0Smooth = sorted[Math.floor(sorted.length / 2)];
        const midiF = this._hzToMidi(f0Smooth);
        if (!this.smoothMidiSet) { this.smoothMidi = midiF; this.smoothMidiSet = true; }
        else this.smoothMidi += (midiF - this.smoothMidi) * (0.2 + 0.7 * this.cfg.speed);
        const HYST = 0.15;
        const candidate = this._snapMidi(this.smoothMidi);
        if (this.lockedTarget == null) this.lockedTarget = candidate;
        else if (candidate !== this.lockedTarget && Math.abs(this.smoothMidi - this.lockedTarget) > 0.5 + HYST) this.lockedTarget = candidate;
        const strength = this.cfg.enabled ? Math.max(0, Math.min(1, this.cfg.strength)) : 0;
        const correctedMidi = this.smoothMidi + (this.lockedTarget - this.smoothMidi) * strength;
        const targetHz = this._midiToHz(correctedMidi);
        const ratio = Math.max(0.5, Math.min(2, targetHz / f0Smooth));
        const T0_in = sampleRate / f0Smooth;
        const T0_out = T0_in / ratio;
        const regionEnd = frameStart + HOP;
        this._findEpochs(frameStart, regionEnd, T0_in);
        const keepFrom = frameStart - Math.ceil(T0_in * 4);
        this.epochs = this.epochs.filter((ep) => ep >= keepFrom);
        if (this.lastOutEpoch == null) this.lastOutEpoch = this.outWrite;
        const outRegionEnd = this.lastOutEpoch + Math.round(((regionEnd - frameStart) / T0_in) * T0_out);
        let outEpoch = this.lastOutEpoch;
        while (outEpoch < outRegionEnd) {
          let nearest = this.epochs[0];
          let bestDist = Infinity;
          const targetInputTime = frameStart + ((outEpoch - this.lastOutEpoch) / T0_out) * T0_in;
          for (let k = 0; k < this.epochs.length; k++) {
            const dist = Math.abs(this.epochs[k] - targetInputTime);
            if (dist < bestDist) { bestDist = dist; nearest = this.epochs[k]; }
          }
          if (nearest != null) this._addGrain(nearest, outEpoch, Math.round(T0_in));
          outEpoch += Math.max(8, Math.round(T0_out));
        }
        this.lastOutEpoch = outEpoch;
        this.outWrite = outEpoch;
        this.lastF0 = f0;
        this.port.postMessage({ type: 'correction', f0: f0Smooth, targetMidi: this.lockedTarget, correctedMidi, strength });
      } else {
        for (let i = 0; i < HOP; i++) {
          const inIdx = frameStart + i;
          const sample = this.inRing[((inIdx % this.ringSize) + this.ringSize) % this.ringSize];
          const outIdx = this.outWrite + i;
          this.outRing[((outIdx % this.ringSize) + this.ringSize) % this.ringSize] += sample;
        }
        this.outWrite += HOP;
        this.lastOutEpoch = this.outWrite;
        this.lastF0 = 0;
        this.lockedTarget = null;
      }
      this.processedUpTo += HOP;
    }
  }
  process(inputs, outputs) {
    const inCh = inputs[0] && inputs[0][0];
    const outCh = outputs[0] && outputs[0][0];
    if (!outCh) return true;
    if (inCh) {
      for (let i = 0; i < inCh.length; i++) {
        this.inRing[this.inWrite] = inCh[i];
        this.inWrite = (this.inWrite + 1) % this.ringSize;
        this.inSamples++;
      }
    }
    this._analyzeAndSynthesize();
    const desiredOutSamples = Math.max(0, this.inSamples - FRAME);
    for (let i = 0; i < outCh.length; i++) {
      if (this.outRead < desiredOutSamples) {
        const idx = ((this.outRead % this.ringSize) + this.ringSize) % this.ringSize;
        outCh[i] = this.outRing[idx];
        this.outRing[idx] = 0;
        this.outRead++;
      } else {
        outCh[i] = 0;
      }
    }
    return true;
  }
}
registerProcessor('autotune', Autotune);
