const FRAME_SIZE = 2048;
const HOP_SIZE = 512;
const YIN_THRESHOLD = 0.12;
const MIN_F0 = 65;
const MAX_F0 = 1100;
const RMS_GATE_DB = -55;

class PitchDetector extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(FRAME_SIZE);
    this.writeIdx = 0;
    this.samplesSinceHop = 0;
    this.yinBuf = new Float32Array(FRAME_SIZE / 2);
  }
  difference(buf) {
    const W = this.yinBuf.length;
    for (let tau = 0; tau < W; tau++) {
      let sum = 0;
      for (let i = 0; i < W; i++) {
        const delta = buf[i] - buf[i + tau];
        sum += delta * delta;
      }
      this.yinBuf[tau] = sum;
    }
  }
  cmnd() {
    this.yinBuf[0] = 1;
    let running = 0;
    for (let tau = 1; tau < this.yinBuf.length; tau++) {
      running += this.yinBuf[tau];
      this.yinBuf[tau] = (this.yinBuf[tau] * tau) / (running || 1e-12);
    }
  }
  absoluteThreshold() {
    const W = this.yinBuf.length;
    let tau = 2;
    for (; tau < W; tau++) {
      if (this.yinBuf[tau] < YIN_THRESHOLD) {
        while (tau + 1 < W && this.yinBuf[tau + 1] < this.yinBuf[tau]) tau++;
        return tau;
      }
    }
    return -1;
  }
  parabolicInterp(tau) {
    const W = this.yinBuf.length;
    if (tau <= 0 || tau >= W - 1) return tau;
    const s0 = this.yinBuf[tau - 1];
    const s1 = this.yinBuf[tau];
    const s2 = this.yinBuf[tau + 1];
    const denom = 2 * (2 * s1 - s2 - s0);
    if (Math.abs(denom) < 1e-9) return tau;
    return tau + (s2 - s0) / denom;
  }
  analyze() {
    let rms = 0;
    for (let i = 0; i < FRAME_SIZE; i++) rms += this.buffer[i] * this.buffer[i];
    rms = Math.sqrt(rms / FRAME_SIZE);
    const db = 20 * Math.log10(rms + 1e-9);
    if (db < RMS_GATE_DB) {
      this.port.postMessage({ type: 'pitch', f0: 0, clarity: 0, db, rms });
      return;
    }
    this.difference(this.buffer);
    this.cmnd();
    const tau = this.absoluteThreshold();
    if (tau < 0) {
      this.port.postMessage({ type: 'pitch', f0: 0, clarity: 0, db, rms });
      return;
    }
    const tauI = this.parabolicInterp(tau);
    const f0 = sampleRate / tauI;
    const clarity = 1 - this.yinBuf[tau];
    if (f0 < MIN_F0 || f0 > MAX_F0) {
      this.port.postMessage({ type: 'pitch', f0: 0, clarity: 0, db, rms });
      return;
    }
    this.port.postMessage({ type: 'pitch', f0, clarity, db, rms });
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.buffer[this.writeIdx] = ch[i];
      this.writeIdx = (this.writeIdx + 1) % FRAME_SIZE;
      this.samplesSinceHop++;
    }
    if (this.samplesSinceHop >= HOP_SIZE) {
      this.samplesSinceHop = 0;
      const ordered = new Float32Array(FRAME_SIZE);
      ordered.set(this.buffer.subarray(this.writeIdx), 0);
      ordered.set(this.buffer.subarray(0, this.writeIdx), FRAME_SIZE - this.writeIdx);
      const tmp = this.buffer;
      this.buffer = ordered;
      this.analyze();
      this.buffer = tmp;
    }
    return true;
  }
}
registerProcessor('pitch-detector', PitchDetector);
