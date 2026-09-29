/**
 * apu.js
 * Ricoh 2A03 APU: Pulse 1, Pulse 2, Triangle, Noise, and DMC channels,
 * driven by envelopes, sweep units, length counters, and a frame
 * sequencer, mixed using the standard NES non-linear mixing formulas.
 *
 * `clock()` is called once per CPU cycle by the master clock. Internally
 * this generates audio samples at the real APU rate and accumulates them
 * into a buffer that the emulator drains once per video frame to feed the
 * Web Audio API -- audio is genuinely produced FROM the emulated
 * channels' state, not synthesized independently.
 */

const LENGTH_TABLE = [
  10,254,20,2,40,4,80,6,160,8,60,10,14,12,26,14,
  12,16,24,18,48,20,96,22,192,24,72,26,16,28,32,30,
];

const NOISE_PERIOD_TABLE = [
  4,8,16,32,64,96,128,160,202,254,380,508,762,1016,1524,2034,
];

const DMC_RATE_TABLE = [
  428,380,340,320,286,254,226,214,190,160,142,128,106,84,72,54,
];

const DUTY_TABLE = [
  [0,1,0,0,0,0,0,0],
  [0,1,1,0,0,0,0,0],
  [0,1,1,1,1,0,0,0],
  [1,0,0,1,1,1,1,1],
];

const TRIANGLE_SEQUENCE = [
  15,14,13,12,11,10,9,8,7,6,5,4,3,2,1,0,
  0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,
];

class Envelope {
  constructor() { this.start = false; this.divider = 0; this.decay = 0; this.loop = false; this.constant = false; this.volume = 0; }
  clock() {
    if (this.start) { this.start = false; this.decay = 15; this.divider = this.volume; }
    else if (this.divider > 0) { this.divider--; }
    else { this.divider = this.volume; if (this.decay > 0) this.decay--; else if (this.loop) this.decay = 15; }
  }
  output() { return this.constant ? this.volume : this.decay; }
}

class Sweep {
  constructor(isChannel1) { this.enabled=false; this.period=0; this.negate=false; this.shift=0; this.reload=false; this.divider=0; this.isChannel1=isChannel1; }
  targetPeriod(timerPeriod) {
    const change = timerPeriod >> this.shift;
    if (this.negate) return timerPeriod - change - (this.isChannel1 ? 1 : 0);
    return timerPeriod + change;
  }
  clock(pulse) {
    const target = this.targetPeriod(pulse.timerPeriod);
    if (this.divider === 0 && this.enabled && this.shift > 0 && !pulse.sweepMuted(target)) {
      pulse.timerPeriod = target & 0x7ff;
    }
    if (this.divider === 0 || this.reload) { this.divider = this.period; this.reload = false; }
    else this.divider--;
  }
}

class Pulse {
  constructor(isChannel1) {
    this.isChannel1 = isChannel1;
    this.duty = 0;
    this.dutyPos = 0;
    this.timerPeriod = 0;
    this.timer = 0;
    this.lengthCounter = 0;
    this.lengthEnabled = true;
    this.envelope = new Envelope();
    this.sweep = new Sweep(isChannel1);
    this.enabled = false;
  }
  sweepMuted(target) { return this.timerPeriod < 8 || target > 0x7ff; }
  writeReg(n, val) {
    switch (n) {
      case 0:
        this.duty = (val >> 6) & 0x03;
        this.envelope.loop = (val & 0x20) !== 0;
        this.lengthEnabled = !(this.envelope.loop);
        this.envelope.constant = (val & 0x10) !== 0;
        this.envelope.volume = val & 0x0f;
        break;
      case 1:
        this.sweep.enabled = (val & 0x80) !== 0;
        this.sweep.period = (val >> 4) & 0x07;
        this.sweep.negate = (val & 0x08) !== 0;
        this.sweep.shift = val & 0x07;
        this.sweep.reload = true;
        break;
      case 2:
        this.timerPeriod = (this.timerPeriod & 0x700) | val;
        break;
      case 3:
        this.timerPeriod = (this.timerPeriod & 0x0ff) | ((val & 0x07) << 8);
        if (this.enabled) this.lengthCounter = LENGTH_TABLE[(val >> 3) & 0x1f];
        this.envelope.start = true;
        this.dutyPos = 0;
        break;
    }
  }
  clockTimer() {
    if (this.timer === 0) { this.timer = this.timerPeriod; this.dutyPos = (this.dutyPos + 1) & 0x07; }
    else this.timer--;
  }
  clockLength() { if (this.lengthEnabled && this.lengthCounter > 0) this.lengthCounter--; }
  output() {
    if (!this.enabled || this.lengthCounter === 0) return 0;
    if (this.timerPeriod < 8 || this.timerPeriod > 0x7ff) return 0;
    if (DUTY_TABLE[this.duty][this.dutyPos] === 0) return 0;
    return this.envelope.output();
  }
}

class Triangle {
  constructor() {
    this.timerPeriod = 0; this.timer = 0; this.sequencePos = 0;
    this.lengthCounter = 0; this.lengthEnabled = true;
    this.linearCounter = 0; this.linearReloadValue = 0; this.linearReload = false; this.control = false;
    this.enabled = false;
  }
  writeReg(n, val) {
    switch (n) {
      case 0: this.control = (val & 0x80) !== 0; this.lengthEnabled = !this.control; this.linearReloadValue = val & 0x7f; break;
      case 1: break;
      case 2: this.timerPeriod = (this.timerPeriod & 0x700) | val; break;
      case 3:
        this.timerPeriod = (this.timerPeriod & 0x0ff) | ((val & 0x07) << 8);
        if (this.enabled) this.lengthCounter = LENGTH_TABLE[(val >> 3) & 0x1f];
        this.linearReload = true;
        break;
    }
  }
  clockTimer() {
    if (this.timer === 0) {
      this.timer = this.timerPeriod;
      if (this.lengthCounter > 0 && this.linearCounter > 0) {
        this.sequencePos = (this.sequencePos + 1) & 0x1f;
      }
    } else this.timer--;
  }
  clockLinear() {
    if (this.linearReload) this.linearCounter = this.linearReloadValue;
    else if (this.linearCounter > 0) this.linearCounter--;
    if (!this.control) this.linearReload = false;
  }
  clockLength() { if (this.lengthEnabled && this.lengthCounter > 0) this.lengthCounter--; }
  output() {
    // The sequencer itself is silenced (stops advancing) when length or
    // linear counter hit zero -- see clockTimer's guard -- but the channel
    // being entirely disabled via $4015 should mute it outright, else a
    // stuck ultrasonic DC-ish tone can leak into the mix.
    if (!this.enabled) return 0;
    return TRIANGLE_SEQUENCE[this.sequencePos];
  }
}

class Noise {
  constructor() {
    this.timerPeriod = NOISE_PERIOD_TABLE[0]; this.timer = 0;
    this.lengthCounter = 0; this.lengthEnabled = true;
    this.envelope = new Envelope();
    this.mode = false;
    this.shiftReg = 1;
    this.enabled = false;
  }
  writeReg(n, val) {
    switch (n) {
      case 0:
        this.envelope.loop = (val & 0x20) !== 0;
        this.lengthEnabled = !this.envelope.loop;
        this.envelope.constant = (val & 0x10) !== 0;
        this.envelope.volume = val & 0x0f;
        break;
      case 2:
        this.mode = (val & 0x80) !== 0;
        this.timerPeriod = NOISE_PERIOD_TABLE[val & 0x0f];
        break;
      case 3:
        if (this.enabled) this.lengthCounter = LENGTH_TABLE[(val >> 3) & 0x1f];
        this.envelope.start = true;
        break;
    }
  }
  clockTimer() {
    if (this.timer === 0) {
      this.timer = this.timerPeriod;
      const bit1 = this.shiftReg & 0x01;
      const bit2 = this.mode ? ((this.shiftReg >> 6) & 0x01) : ((this.shiftReg >> 1) & 0x01);
      const feedback = bit1 ^ bit2;
      this.shiftReg >>= 1;
      this.shiftReg |= (feedback << 14);
    } else this.timer--;
  }
  clockLength() { if (this.lengthEnabled && this.lengthCounter > 0) this.lengthCounter--; }
  output() {
    if (!this.enabled || this.lengthCounter === 0) return 0;
    if (this.shiftReg & 0x01) return 0;
    return this.envelope.output();
  }
}

class DMC {
  constructor(bus) {
    this.bus = bus;
    this.rate = DMC_RATE_TABLE[0];
    this.timer = 0;
    this.loop = false;
    this.irqEnable = false;
    this.irqPending = false;
    this.sampleAddr = 0xc000;
    this.sampleLength = 1;
    this.currentAddr = 0;
    this.bytesRemaining = 0;
    this.sampleBuffer = null;
    this.shiftReg = 0;
    this.bitsRemaining = 8;
    this.output_ = 0;
    this.silence = true;
    this.enabled = false;
  }
  writeReg(n, val) {
    switch (n) {
      case 0:
        this.irqEnable = (val & 0x80) !== 0;
        this.loop = (val & 0x40) !== 0;
        this.rate = DMC_RATE_TABLE[val & 0x0f];
        if (!this.irqEnable) this.irqPending = false;
        break;
      case 1:
        this.output_ = val & 0x7f;
        break;
      case 2:
        this.sampleAddr = 0xc000 + (val * 64);
        break;
      case 3:
        this.sampleLength = (val * 16) + 1;
        break;
    }
  }
  restart() {
    this.currentAddr = this.sampleAddr;
    this.bytesRemaining = this.sampleLength;
  }
  clockTimer() {
    if (this.timer === 0) {
      this.timer = this.rate;
      this._clockOutputUnit();
    } else this.timer--;
  }
  _fetchByte() {
    if (this.bytesRemaining > 0 && this.sampleBuffer === null) {
      this.sampleBuffer = this.bus.cpuRead(this.currentAddr);
      this.currentAddr = 0x8000 | ((this.currentAddr + 1) & 0x7fff);
      this.bytesRemaining--;
      if (this.bytesRemaining === 0) {
        if (this.loop) { this.restart(); }
        else if (this.irqEnable) { this.irqPending = true; }
      }
    }
  }
  _clockOutputUnit() {
    if (this.bitsRemaining === 0) {
      this.bitsRemaining = 8;
      if (this.sampleBuffer === null) { this.silence = true; }
      else { this.silence = false; this.shiftReg = this.sampleBuffer; this.sampleBuffer = null; }
    }
    this._fetchByte();
    if (!this.silence) {
      if (this.shiftReg & 0x01) { if (this.output_ <= 125) this.output_ += 2; }
      else { if (this.output_ >= 2) this.output_ -= 2; }
    }
    this.shiftReg >>= 1;
    this.bitsRemaining--;
  }
  output() { return this.output_; }
}

export class APU {
  constructor(bus, sampleRate = 44100) {
    this.bus = bus;
    this.pulse1 = new Pulse(true);
    this.pulse2 = new Pulse(false);
    this.triangle = new Triangle();
    this.noise = new Noise();
    this.dmc = new DMC(bus);

    this.frameSequenceMode = 0; // 0 = 4-step, 1 = 5-step
    this.frameIrqInhibit = false;
    this.frameIrqPending = false;
    this.frameStep = 0;
    this.cpuCyclesSinceFrameClock = 0;

    this.sampleRate = sampleRate;
    this.cpuClockHz = 1789773;
    this.cyclesPerSample = this.cpuClockHz / this.sampleRate;
    this._sampleAccum = 0;
    this.sampleBuffer = [];
    this.maxBufferedSamples = sampleRate; // 1 second safety cap

    this.cycleCount = 0;
  }

  reset() {
    this.frameStep = 0;
    this.cpuCyclesSinceFrameClock = 0;
  }

  readStatus() {
    const val =
      (this.pulse1.lengthCounter > 0 ? 0x01 : 0) |
      (this.pulse2.lengthCounter > 0 ? 0x02 : 0) |
      (this.triangle.lengthCounter > 0 ? 0x04 : 0) |
      (this.noise.lengthCounter > 0 ? 0x08 : 0) |
      (this.dmc.bytesRemaining > 0 ? 0x10 : 0) |
      (this.frameIrqPending ? 0x40 : 0) |
      (this.dmc.irqPending ? 0x80 : 0);
    this.frameIrqPending = false;
    return val;
  }

  writeRegister(addr, val) {
    if (addr >= 0x4000 && addr <= 0x4003) this.pulse1.writeReg(addr - 0x4000, val);
    else if (addr >= 0x4004 && addr <= 0x4007) this.pulse2.writeReg(addr - 0x4004, val);
    else if (addr >= 0x4008 && addr <= 0x400b) this.triangle.writeReg(addr - 0x4008, val);
    else if (addr >= 0x400c && addr <= 0x400f) this.noise.writeReg(addr - 0x400c, val);
    else if (addr >= 0x4010 && addr <= 0x4013) this.dmc.writeReg(addr - 0x4010, val);
    else if (addr === 0x4015) {
      this.pulse1.enabled = (val & 0x01) !== 0;
      this.pulse2.enabled = (val & 0x02) !== 0;
      this.triangle.enabled = (val & 0x04) !== 0;
      this.noise.enabled = (val & 0x08) !== 0;
      this.dmc.enabled = (val & 0x10) !== 0;
      if (!this.pulse1.enabled) this.pulse1.lengthCounter = 0;
      if (!this.pulse2.enabled) this.pulse2.lengthCounter = 0;
      if (!this.triangle.enabled) this.triangle.lengthCounter = 0;
      if (!this.noise.enabled) this.noise.lengthCounter = 0;
      if (!this.dmc.enabled) { this.dmc.bytesRemaining = 0; }
      else if (this.dmc.bytesRemaining === 0) { this.dmc.restart(); }
      this.dmc.irqPending = false;
    }
  }

  writeFrameCounter(val) {
    this.frameSequenceMode = (val & 0x80) ? 1 : 0;
    this.frameIrqInhibit = (val & 0x40) !== 0;
    if (this.frameIrqInhibit) this.frameIrqPending = false;
    this.cpuCyclesSinceFrameClock = 0;
    this.frameStep = 0;
    if (this.frameSequenceMode === 1) {
      this._clockQuarter();
      this._clockHalf();
    }
  }

  _clockQuarter() {
    this.pulse1.envelope.clock();
    this.pulse2.envelope.clock();
    this.noise.envelope.clock();
    this.triangle.clockLinear();
  }
  _clockHalf() {
    this.pulse1.clockLength(); this.pulse1.sweep.clock(this.pulse1);
    this.pulse2.clockLength(); this.pulse2.sweep.clock(this.pulse2);
    this.triangle.clockLength();
    this.noise.clockLength();
  }

  // Frame sequencer runs at ~240Hz / ~192Hz steps derived from CPU cycles.
  _clockFrameSequencer() {
    this.cpuCyclesSinceFrameClock++;
    const c = this.cpuCyclesSinceFrameClock;
    if (this.frameSequenceMode === 0) {
      // 4-step sequence (NTSC cycle counts)
      if (c === 7457) { this._clockQuarter(); }
      else if (c === 14913) { this._clockQuarter(); this._clockHalf(); }
      else if (c === 22371) { this._clockQuarter(); }
      else if (c === 29828) { if (!this.frameIrqInhibit) this.frameIrqPending = true; }
      else if (c === 29829) { this._clockQuarter(); this._clockHalf(); if (!this.frameIrqInhibit) this.frameIrqPending = true; }
      else if (c === 29830) { this.cpuCyclesSinceFrameClock = 0; }
    } else {
      // 5-step sequence
      if (c === 7457) { this._clockQuarter(); }
      else if (c === 14913) { this._clockQuarter(); this._clockHalf(); }
      else if (c === 22371) { this._clockQuarter(); }
      else if (c === 29829) { /* nothing */ }
      else if (c === 37281) { this._clockQuarter(); this._clockHalf(); }
      else if (c === 37282) { this.cpuCyclesSinceFrameClock = 0; }
    }
  }

  get irqPending() { return this.frameIrqPending || this.dmc.irqPending; }

  // Called once per CPU cycle.
  clock() {
    this.cycleCount++;
    this._clockFrameSequencer();

    // Triangle timer clocks at full CPU rate; pulse/noise/DMC at half rate.
    this.triangle.clockTimer();
    if ((this.cycleCount & 1) === 0) {
      this.pulse1.clockTimer();
      this.pulse2.clockTimer();
      this.noise.clockTimer();
      this.dmc.clockTimer();
    }

    this._sampleAccum++;
    if (this._sampleAccum >= this.cyclesPerSample) {
      this._sampleAccum -= this.cyclesPerSample;
      this._pushSample();
    }
  }

  _pushSample() {
    const p1 = this.pulse1.output();
    const p2 = this.pulse2.output();
    const tri = this.triangle.output();
    const noi = this.noise.output();
    const dmc = this.dmc.output();

    // Standard NES non-linear mixing approximation (nesdev wiki formulas).
    let pulseOut = 0;
    if (p1 + p2 > 0) pulseOut = 95.88 / ((8128 / (p1 + p2)) + 100);
    let tndOut = 0;
    const tndSum = (tri / 8227) + (noi / 12241) + (dmc / 22638);
    if (tndSum > 0) tndOut = 159.79 / ((1 / tndSum) + 100);

    const sample = pulseOut + tndOut; // ~0.0 - ~1.0
    if (this.sampleBuffer.length < this.maxBufferedSamples) {
      this.sampleBuffer.push(sample * 2 - 1); // to roughly [-1, 1]
    }
  }

  // Called by the emulator once per video frame to drain buffered samples
  // for playback; returns a Float32Array (possibly empty).
  drainSamples() {
    const arr = Float32Array.from(this.sampleBuffer);
    this.sampleBuffer.length = 0;
    return arr;
  }

  // Serializable snapshot of all channel/sequencer state (not the pending
  // output sample queue, which is transient).
  getState() {
    return {
      pulse1: snapshotObject(this.pulse1),
      pulse2: snapshotObject(this.pulse2),
      triangle: snapshotObject(this.triangle),
      noise: snapshotObject(this.noise),
      dmc: snapshotObject(this.dmc),
      frameSequenceMode: this.frameSequenceMode,
      frameIrqInhibit: this.frameIrqInhibit,
      frameIrqPending: this.frameIrqPending,
      frameStep: this.frameStep,
      cpuCyclesSinceFrameClock: this.cpuCyclesSinceFrameClock,
      cycleCount: this.cycleCount,
      sampleAccum: this._sampleAccum,
    };
  }

  setState(s) {
    if (!s) return;
    restoreObject(this.pulse1, s.pulse1);
    restoreObject(this.pulse2, s.pulse2);
    restoreObject(this.triangle, s.triangle);
    restoreObject(this.noise, s.noise);
    restoreObject(this.dmc, s.dmc);
    this.frameSequenceMode = s.frameSequenceMode;
    this.frameIrqInhibit = s.frameIrqInhibit;
    this.frameIrqPending = s.frameIrqPending;
    this.frameStep = s.frameStep;
    this.cpuCyclesSinceFrameClock = s.cpuCyclesSinceFrameClock;
    this.cycleCount = s.cycleCount;
    this._sampleAccum = s.sampleAccum || 0;
    this.sampleBuffer.length = 0;
  }
}

// Copies primitive fields and nested plain objects (envelope, sweep).
// Skips the `bus` back-reference and any functions.
function snapshotObject(obj) {
  const out = {};
  for (const key of Object.keys(obj)) {
    if (key === 'bus') continue;
    const v = obj[key];
    if (v === null || typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') out[key] = v;
    else if (typeof v === 'object') out[key] = snapshotObject(v);
  }
  return out;
}

function restoreObject(target, src) {
  if (!src) return;
  for (const key of Object.keys(src)) {
    const v = src[key];
    if (v !== null && typeof v === 'object') restoreObject(target[key], v);
    else target[key] = v;
  }
}
