/**
 * emulator.js
 * Top-level orchestrator: owns the Bus, CPU, PPU, APU, Controller(s), and
 * the currently loaded Cartridge+Mapper. Implements the actual CPU:PPU
 * 1:3 clock ratio (one CPU cycle for every three PPU dots -- real NTSC
 * NES timing), OAM-DMA CPU stalling, IRQ/NMI wiring, save-RAM
 * persistence (IndexedDB, keyed per-ROM), and save states.
 */

import { CPU6502 } from './cpu6502.js';
import { PPU } from './ppu.js';
import { APU } from './apu.js';
import { Bus } from './bus.js';
import { Controller } from './controller.js';
import { Cartridge, RomLoadError } from './cartridge.js';
import { createMapper } from './mapper.js';

const DB_NAME = 'turtlenes-saves';
const DB_STORE = 'battery-ram';

function openSaveDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore(DB_STORE); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// Cheap, dependency-free content hash to key save data to the ROM's
// actual contents (so renaming a file doesn't lose its save, and two
// different ROMs with the same filename don't collide).
function hashBytes(bytes) {
  let h1 = 0xdeadbeef ^ bytes.length, h2 = 0x41c6ce57 ^ bytes.length;
  for (let i = 0; i < bytes.length; i++) {
    const ch = bytes[i];
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

export class Emulator {
  constructor() {
    this.bus = new Bus();
    this.cpu = new CPU6502(this.bus);
    this.ppu = new PPU();
    this.apu = new APU(this.bus);
    this.controller1 = new Controller();
    this.controller2 = new Controller();

    this.bus.ppu = this.ppu;
    this.bus.apu = this.apu;
    this.bus.controller1 = this.controller1;
    this.bus.controller2 = this.controller2;
    this.bus.cpu = this.cpu;
    this.ppu.cpu = this.cpu;

    this.cartridge = null;
    this.mapper = null;
    this.romKey = null;

    this.running = false;
    this.loaded = false;
    this.masterClockCount = 0; // counts PPU dots; CPU advances every 3rd

    this.audioSampleCallback = null; // set by UI to receive drained samples
    this.errorMessage = null;

    this._saveDbPromise = null;
    this._saveTimer = null;

    this.rewindEnabled = true;
    this.rewindSeconds = 30;
    this.rewindInterval = 3; // frames between snapshots
    this.rewindCapacity = Math.floor((this.rewindSeconds * 60) / this.rewindInterval);
    this.rewindBuffer = [];
    this._rewindCursor = null;
    this._framesSinceRewind = 0;

    this.cheats = [];
    this._nextCheatId = 1;
  }

  loadRom(arrayBuffer, filename) {
    this.errorMessage = null;
    let cart;
    try {
      cart = Cartridge.fromArrayBuffer(arrayBuffer, filename);
    } catch (e) {
      if (e instanceof RomLoadError) throw e;
      throw new RomLoadError(`Failed to parse ROM: ${e.message}`, 'invalid');
    }
    const mapper = createMapper(cart); // throws RomLoadError for unsupported mappers

    this.cartridge = cart;
    this.mapper = mapper;
    this.bus.mapper = mapper;
    this.ppu.mapper = mapper;
    this.romKey = hashBytes(new Uint8Array(arrayBuffer));
    this.loaded = true;
    this.rewindBuffer.length = 0;
    this._rewindCursor = null;

    this.reset();
    this._loadBatterySave();
    return cart.describe();
  }

  unloadRom() {
    this.pause();
    this.cartridge = null;
    this.mapper = null;
    this.bus.mapper = null;
    this.ppu.mapper = null;
    this.loaded = false;
    this.rewindBuffer.length = 0;
  }

  reset() {
    if (!this.loaded) return;
    this.cpu.reset();
    this.ppu.reset();
    this.apu.reset();
    this.masterClockCount = 0;
  }

  play() { if (this.loaded) this.running = true; }
  pause() { this.running = false; }

  // Advance the whole system by exactly one PPU dot / (1/3) CPU cycle.
  _clockOnce() {
    this.ppu.clock();

    if (this.masterClockCount % 3 === 0) {
      if (this.bus.dmaStallCyclesRemaining > 0) {
        this.bus.dmaStallCyclesRemaining--;
      } else {
        this.cpu.clock();
      }
      this.apu.clock();
      const irqAsserted = this.apu.irqPending || (this.mapper && this.mapper.irqPending);
      this.cpu.setIRQLine(!!irqAsserted);
    }

    this.masterClockCount++;
  }

  // Runs until a full frame has been produced (or a hard safety cap of
  // clocks is hit, to guarantee we can never hang the browser tab).
  runFrame() {
    if (!this.loaded || !this.running) return;
    this.ppu.frameComplete = false;
    let safety = 0;
    const SAFETY_LIMIT = 400000; // generous upper bound per frame
    while (!this.ppu.frameComplete && safety < SAFETY_LIMIT) {
      this._clockOnce();
      safety++;
    }
    if (this.audioSampleCallback) {
      const samples = this.apu.drainSamples();
      if (samples.length > 0) this.audioSampleCallback(samples);
    }
    this._applyCheats();
    this._captureRewind();
    this._scheduleBatterySave();
  }

  // For the debugger's single-step: executes exactly one CPU instruction
  // worth of clocks (advancing PPU/APU alongside it).
  stepInstruction() {
    if (!this.loaded) return;
    const startTotal = this.cpu.totalCycles;
    // Clock forward until the CPU has consumed at least one instruction.
    // We detect completion by watching totalCycles advance past a fresh
    // instruction boundary (cpu.cycles going back to 0 right after we
    // clocked it and cpu.cycles was 0 at the time of the clock).
    let iterations = 0;
    do {
      this._clockOnce();
      iterations++;
    } while (this.cpu.cycles !== 0 && iterations < 100);
  }

  // ---- Save RAM persistence (battery-backed cartridges) ------------------
  async _loadBatterySave() {
    if (!this.cartridge || !this.cartridge.hasBattery || !this.romKey) return;
    try {
      const db = await this._getDb();
      const tx = db.transaction(DB_STORE, 'readonly');
      const req = tx.objectStore(DB_STORE).get(this.romKey);
      req.onsuccess = () => {
        if (req.result && this.mapper) this.mapper.loadSaveData(new Uint8Array(req.result));
      };
    } catch (e) {
      console.warn('Save RAM load failed:', e);
    }
  }

  _scheduleBatterySave() {
    if (!this.cartridge || !this.cartridge.hasBattery) return;
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => { this._saveTimer = null; this._writeBatterySave(); }, 2000);
  }

  async _writeBatterySave() {
    if (!this.mapper || !this.cartridge || !this.cartridge.hasBattery || !this.romKey) return;
    const data = this.mapper.getSaveData();
    if (!data) return;
    try {
      const db = await this._getDb();
      const tx = db.transaction(DB_STORE, 'readwrite');
      tx.objectStore(DB_STORE).put(data.buffer.slice(0), this.romKey);
    } catch (e) {
      console.warn('Save RAM write failed:', e);
    }
  }

  async clearBatterySave() {
    if (!this.romKey) return;
    try {
      const db = await this._getDb();
      const tx = db.transaction(DB_STORE, 'readwrite');
      tx.objectStore(DB_STORE).delete(this.romKey);
      if (this.mapper) this.mapper.prgRam.fill(0);
    } catch (e) {
      console.warn('Save RAM clear failed:', e);
    }
  }

  _getDb() {
    if (!this._saveDbPromise) this._saveDbPromise = openSaveDb();
    return this._saveDbPromise;
  }

  // ---- Save states ------------------------------------------------------
  // A state is a plain object that holds typed-array copies. Use
  // `serializeState` / `deserializeState` to turn it into a portable
  // string (file export, localStorage) and back.
  saveState() {
    if (!this.loaded) return null;
    return {
      format: STATE_FORMAT,
      version: STATE_VERSION,
      romKey: this.romKey,
      romName: this.cartridge.filename,
      timestamp: Date.now(),
      masterClockCount: this.masterClockCount,
      cpu: captureFields(this.cpu, CPU_SKIP),
      ppu: captureFields(this.ppu, PPU_SKIP),
      apu: this.apu.getState(),
      bus: { ram: this.bus.ram.slice(), dmaStallCyclesRemaining: this.bus.dmaStallCyclesRemaining },
      controllers: [
        { strobe: this.controller1.strobe, shiftReg: this.controller1.shiftReg },
        { strobe: this.controller2.strobe, shiftReg: this.controller2.shiftReg },
      ],
      mapper: captureFields(this.mapper, MAPPER_SKIP),
      prgRam: this.mapper.prgRam.slice(),
      chrRam: this.cartridge.chrIsRam ? this.cartridge.chr.slice() : null,
    };
  }

  // Returns { ok: true } or { ok: false, reason } so callers can show a
  // specific message (wrong ROM, unknown format, and so on).
  loadState(state) {
    if (!this.loaded) return { ok: false, reason: 'No ROM is loaded.' };
    if (!state || state.format !== STATE_FORMAT) return { ok: false, reason: 'This is not a TurtleNES save state.' };
    if (state.version > STATE_VERSION) return { ok: false, reason: 'This save state was made by a newer version of TurtleNES.' };
    if (state.romKey !== this.romKey) {
      return { ok: false, reason: `This save state belongs to a different ROM (${state.romName || 'unknown'}).` };
    }
    restoreFields(this.cpu, state.cpu);
    restoreFields(this.ppu, state.ppu);
    this.apu.setState(state.apu);
    this.bus.ram.set(state.bus.ram);
    this.bus.dmaStallCyclesRemaining = state.bus.dmaStallCyclesRemaining;
    [this.controller1, this.controller2].forEach((c, i) => {
      c.strobe = state.controllers[i].strobe;
      c.shiftReg = state.controllers[i].shiftReg;
    });
    restoreFields(this.mapper, state.mapper);
    this.mapper.prgRam.set(state.prgRam);
    if (state.chrRam && this.cartridge.chrIsRam) this.cartridge.chr.set(state.chrRam);
    this.masterClockCount = state.masterClockCount;
    this.ppu.frameComplete = false;
    this.cpu.nmiPending = !!state.cpu.nmiPending;
    return { ok: true };
  }

  serializeState(state) {
    return JSON.stringify(state, (key, value) => {
      if (ArrayBuffer.isView(value)) return { __typed: value.constructor.name, data: bytesToBase64(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)) };
      return value;
    });
  }

  deserializeState(text) {
    let state;
    try {
      state = JSON.parse(text, (key, value) => {
        if (value && typeof value === 'object' && value.__typed) {
          const bytes = base64ToBytes(value.data);
          if (value.__typed === 'Uint8Array') return bytes;
          if (value.__typed === 'Uint8ClampedArray') return new Uint8ClampedArray(bytes.buffer);
          if (value.__typed === 'Uint16Array') return new Uint16Array(bytes.buffer);
          if (value.__typed === 'Int32Array') return new Int32Array(bytes.buffer);
          return bytes;
        }
        return value;
      });
    } catch (e) {
      return null;
    }
    return state;
  }

  // ---- Rewind -------------------------------------------------------------
  // A ring of recent snapshots, one every `rewindInterval` frames.
  configureRewind({ enabled, seconds }) {
    if (enabled !== undefined) this.rewindEnabled = !!enabled;
    if (seconds !== undefined) this.rewindSeconds = seconds;
    this.rewindCapacity = Math.max(2, Math.floor((this.rewindSeconds * 60) / this.rewindInterval));
    while (this.rewindBuffer.length > this.rewindCapacity) this.rewindBuffer.shift();
    if (!this.rewindEnabled) this.rewindBuffer.length = 0;
  }

  _captureRewind() {
    if (!this.rewindEnabled || !this.loaded) return;
    if (this._rewindCursor !== null) {
      // Resuming after a seek: drop the snapshots that were rewound past.
      this.rewindBuffer.length = this._rewindCursor + 1;
      this._rewindCursor = null;
    }
    this._framesSinceRewind++;
    if (this._framesSinceRewind < this.rewindInterval) return;
    this._framesSinceRewind = 0;
    this.rewindBuffer.push(this.saveState());
    if (this.rewindBuffer.length > this.rewindCapacity) this.rewindBuffer.shift();
  }

  // Steps one snapshot back in time (used while the rewind key is held).
  rewindStep() {
    if (!this.loaded || this.rewindBuffer.length === 0) return false;
    const index = this._rewindCursor === null ? this.rewindBuffer.length - 1 : Math.max(0, this._rewindCursor - 1);
    return this.rewindSeek(index);
  }

  rewindSeek(index) {
    if (index < 0 || index >= this.rewindBuffer.length) return false;
    const result = this.loadState(this.rewindBuffer[index]);
    if (!result.ok) return false;
    this._rewindCursor = index;
    this._framesSinceRewind = 0;
    return true;
  }

  // ---- Cheats ---------------------------------------------------------
  // Format: "AAAA:VV" writes value VV to address AAAA every frame.
  // "AAAA:VV?CC" only writes while the current byte equals CC.
  // Addresses are limited to work RAM ($0000-$1FFF) and cartridge RAM
  // ($6000-$7FFF); the ROM itself is never modified.
  static parseCheat(code) {
    const m = /^\s*([0-9a-f]{4})\s*[:=]\s*([0-9a-f]{2})(?:\s*\?\s*([0-9a-f]{2}))?\s*$/i.exec(code || '');
    if (!m) return { error: 'Use the format AAAA:VV or AAAA:VV?CC (hexadecimal).' };
    const address = parseInt(m[1], 16);
    const inRam = address < 0x2000;
    const inSram = address >= 0x6000 && address < 0x8000;
    if (!inRam && !inSram) {
      return { error: 'Address must be in work RAM ($0000-$1FFF) or cartridge RAM ($6000-$7FFF).' };
    }
    return { address, value: parseInt(m[2], 16), compare: m[3] !== undefined ? parseInt(m[3], 16) : null };
  }

  addCheat(code, label) {
    const parsed = Emulator.parseCheat(code);
    if (parsed.error) return parsed;
    const cheat = { id: this._nextCheatId++, code: code.trim().toUpperCase(), label: label || '', enabled: true, ...parsed };
    this.cheats.push(cheat);
    return { cheat };
  }
  removeCheat(id) { this.cheats = this.cheats.filter(c => c.id !== id); }
  setCheatEnabled(id, enabled) { const c = this.cheats.find(x => x.id === id); if (c) c.enabled = enabled; }

  _applyCheats() {
    for (const c of this.cheats) {
      if (!c.enabled) continue;
      if (c.compare !== null && this.bus.cpuRead(c.address) !== c.compare) continue;
      if (c.address < 0x2000) this.bus.ram[c.address & 0x07ff] = c.value;
      else this.mapper.prgRam[c.address - 0x6000] = c.value;
    }
  }
}

const STATE_FORMAT = 'TurtleNES-State';
const STATE_VERSION = 2;

const CPU_SKIP = new Set(['bus', 'table', 'unofficialTable', 'unofficialOpcodesEnabled']);
const PPU_SKIP = new Set(['mapper', 'cpu', 'framebuffer']);
const MAPPER_SKIP = new Set(['cart', 'prgRam']);

// Copies numbers, booleans, typed arrays and arrays of typed arrays or
// numbers. Anything else (objects, functions, back-references) is skipped.
function captureFields(obj, skip) {
  const out = {};
  for (const key of Object.keys(obj)) {
    if (skip.has(key)) continue;
    const v = obj[key];
    if (v === null || typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') out[key] = v;
    else if (ArrayBuffer.isView(v)) out[key] = v.slice();
    else if (Array.isArray(v)) {
      if (v.every(e => typeof e === 'number')) out[key] = v.slice();
      else if (v.every(e => ArrayBuffer.isView(e))) out[key] = v.map(e => e.slice());
    }
  }
  return out;
}

function restoreFields(obj, snap) {
  for (const key of Object.keys(snap)) {
    if (!(key in obj)) continue;
    const v = snap[key];
    const cur = obj[key];
    if (ArrayBuffer.isView(v)) cur.set(v);
    else if (Array.isArray(v) && v.length && ArrayBuffer.isView(v[0])) v.forEach((e, i) => cur[i].set(e));
    else if (Array.isArray(v)) obj[key] = v.slice();
    else obj[key] = v;
  }
}

function bytesToBase64(bytes) {
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  return btoa(s);
}
function base64ToBytes(b64) {
  const s = atob(b64);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return bytes;
}
