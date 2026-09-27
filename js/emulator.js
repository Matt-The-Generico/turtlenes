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

  // ---- Save states (full snapshot, in-memory / localStorage) ------------
  saveState() {
    if (!this.loaded) return null;
    return {
      cpu: {
        a: this.cpu.a, x: this.cpu.x, y: this.cpu.y, sp: this.cpu.sp,
        pc: this.cpu.pc, p: this.cpu.p, totalCycles: this.cpu.totalCycles,
      },
      ram: Array.from(this.bus.ram),
      ppu: {
        ctrl: this.ppu.ctrl, mask: this.ppu.mask, status: this.ppu.status,
        oamAddr: this.ppu.oamAddr, v: this.ppu.v, t: this.ppu.t,
        fineX: this.ppu.fineX, writeToggle: this.ppu.writeToggle,
        scanline: this.ppu.scanline, dot: this.ppu.dot,
        oam: Array.from(this.ppu.oam),
        nametables: this.ppu.nametables.map(nt => Array.from(nt)),
        paletteRam: Array.from(this.ppu.paletteRam),
      },
      prgRam: this.mapper ? Array.from(this.mapper.prgRam) : null,
      mapperExtra: this._captureMapperExtra(),
      romKey: this.romKey,
    };
  }

  loadState(state) {
    if (!this.loaded || !state || state.romKey !== this.romKey) return false;
    Object.assign(this.cpu, state.cpu);
    this.bus.ram.set(state.ram);
    Object.assign(this.ppu, {
      ctrl: state.ppu.ctrl, mask: state.ppu.mask, status: state.ppu.status,
      oamAddr: state.ppu.oamAddr, v: state.ppu.v, t: state.ppu.t,
      fineX: state.ppu.fineX, writeToggle: state.ppu.writeToggle,
      scanline: state.ppu.scanline, dot: state.ppu.dot,
    });
    this.ppu.oam.set(state.ppu.oam);
    state.ppu.nametables.forEach((nt, i) => this.ppu.nametables[i].set(nt));
    this.ppu.paletteRam.set(state.ppu.paletteRam);
    if (state.prgRam && this.mapper) this.mapper.prgRam.set(state.prgRam);
    this._restoreMapperExtra(state.mapperExtra);
    return true;
  }

  _captureMapperExtra() {
    if (!this.mapper) return null;
    const m = this.mapper;
    return {
      bankSelect: m.bankSelect, bankRegisters: m.bankRegisters ? Array.from(m.bankRegisters) : null,
      prgBank: m.prgBank, chrBank0: m.chrBank0, chrBank1: m.chrBank1, control: m.control,
      chrBank: m.chrBank, bankSelectU: m.bankSelect, mirrorMode: m.mirrorMode,
      irqLatch: m.irqLatch, irqCounter: m.irqCounter, irqEnabled: m.irqEnabled,
    };
  }
  _restoreMapperExtra(extra) {
    if (!extra || !this.mapper) return;
    Object.entries(extra).forEach(([k, v]) => {
      if (v === null || v === undefined || !(k in this.mapper)) return;
      this.mapper[k] = Array.isArray(v) ? v.slice() : v;
    });
  }
}
