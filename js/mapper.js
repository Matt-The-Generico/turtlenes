/**
 * mapper.js
 * Cartridge bank-switching hardware ("mappers"). Each mapper receives the
 * parsed Cartridge (PRG/CHR data + header info) and exposes a uniform
 * interface to the Bus/PPU:
 *
 *   cpuRead(addr)        - addr in $6000-$FFFF
 *   cpuWrite(addr, val)  - addr in $6000-$FFFF
 *   ppuRead(addr)        - addr in $0000-$1FFF (pattern tables)
 *   ppuWrite(addr, val)  - addr in $0000-$1FFF (only meaningful for CHR RAM)
 *   mirrorNametable(addr) -> physical nametable index 0-3, for $2000-$2FFF
 *   notifyScanline()     - called once per visible/pre-render scanline
 *                          (only meaningful to mappers with scanline IRQs,
 *                          e.g. MMC3); a simplified but effective model.
 *   irqPending           - boolean, mapper is asserting IRQ
 *   clearIrq()
 *
 * Bank-switching is never hard-coded into the CPU or PPU; they only ever
 * go through this interface, so adding a new mapper means adding a new
 * class here and registering it in `createMapper`.
 */

import { RomLoadError, MIRROR } from './cartridge.js';

class MapperBase {
  constructor(cart) {
    this.cart = cart;
    this.prgRam = new Uint8Array(8192);
    this.irqPending = false;
  }
  cpuRead(addr) { return 0; }
  cpuWrite(addr, val) {}
  ppuRead(addr) { return this.cart.chr[addr] ?? 0; }
  ppuWrite(addr, val) { if (this.cart.chrIsRam) this.cart.chr[addr] = val; }

  // Default fixed mirroring from the header; mappers that support
  // dynamic mirroring override this.
  mirrorNametable(addr) {
    const table = (addr - 0x2000) & 0x0fff;
    const region = table >> 10; // 0..3, which 1KB nametable slot is addressed
    switch (this.cart.mirroring) {
      case MIRROR.VERTICAL:
        return region & 0x01; // 0,1,0,1
      case MIRROR.SINGLE_SCREEN_A:
        return 0;
      case MIRROR.SINGLE_SCREEN_B:
        return 1;
      case MIRROR.FOUR_SCREEN:
        return region; // needs 4x1KB physical RAM; bus provides that when flagged
      case MIRROR.HORIZONTAL:
      default:
        return region >> 1; // 0,0,1,1
    }
  }

  notifyScanline() {}
  clearIrq() { this.irqPending = false; }
  getSaveData() { return this.cart.hasBattery ? this.prgRam.slice() : null; }
  loadSaveData(bytes) { if (bytes && this.cart.hasBattery) this.prgRam.set(bytes.slice(0, this.prgRam.length)); }
}

// ---- Mapper 0: NROM -----------------------------------------------------
class NROM extends MapperBase {
  constructor(cart) {
    super(cart);
    this.prgMask = cart.prg.length - 1; // 16KB (0x3FFF) or 32KB (0x7FFF), both power-of-two sized
  }
  cpuRead(addr) {
    if (addr >= 0x6000 && addr < 0x8000) return this.prgRam[addr - 0x6000];
    if (addr >= 0x8000) {
      // 16KB PRG mirrors into both halves of $8000-$FFFF; 32KB fills it directly.
      return this.cart.prg[(addr - 0x8000) & this.prgMask];
    }
    return 0;
  }
  cpuWrite(addr, val) {
    if (addr >= 0x6000 && addr < 0x8000) this.prgRam[addr - 0x6000] = val;
    // writes to $8000+ are no-ops on NROM (no registers)
  }
}

// ---- Mapper 2: UxROM ----------------------------------------------------
// Switchable 16KB bank at $8000-$BFFF; fixed LAST 16KB bank at $C000-$FFFF.
class UxROM extends MapperBase {
  constructor(cart) {
    super(cart);
    this.bankCount = cart.prg.length / 16384;
    this.bankSelect = 0;
  }
  cpuRead(addr) {
    if (addr >= 0x6000 && addr < 0x8000) return this.prgRam[addr - 0x6000];
    if (addr >= 0x8000 && addr < 0xc000) {
      return this.cart.prg[this.bankSelect * 16384 + (addr - 0x8000)];
    }
    if (addr >= 0xc000) {
      const lastBank = this.bankCount - 1;
      return this.cart.prg[lastBank * 16384 + (addr - 0xc000)];
    }
    return 0;
  }
  cpuWrite(addr, val) {
    if (addr >= 0x6000 && addr < 0x8000) { this.prgRam[addr - 0x6000] = val; return; }
    if (addr >= 0x8000) {
      // Many UxROM boards only decode a few low bits; bus conflicts exist
      // on real hardware but are irrelevant for correctly-authored ROMs.
      this.bankSelect = val % Math.max(1, this.bankCount);
    }
  }
}

// ---- Mapper 3: CNROM ----------------------------------------------------
// Fixed 32KB PRG; switchable 8KB CHR bank.
class CNROM extends MapperBase {
  constructor(cart) {
    super(cart);
    this.prgMask = cart.prg.length - 1;
    this.chrBank = 0;
    this.chrBankCount = Math.max(1, cart.chr.length / 8192);
  }
  cpuRead(addr) {
    if (addr >= 0x6000 && addr < 0x8000) return this.prgRam[addr - 0x6000];
    if (addr >= 0x8000) return this.cart.prg[(addr - 0x8000) & this.prgMask];
    return 0;
  }
  cpuWrite(addr, val) {
    if (addr >= 0x6000 && addr < 0x8000) { this.prgRam[addr - 0x6000] = val; return; }
    if (addr >= 0x8000) this.chrBank = val % this.chrBankCount;
  }
  ppuRead(addr) {
    if (this.cart.chrIsRam) return this.cart.chr[addr];
    return this.cart.chr[this.chrBank * 8192 + addr];
  }
  ppuWrite(addr, val) {
    if (this.cart.chrIsRam) this.cart.chr[this.chrBank * 8192 + addr] = val;
  }
}

// ---- Mapper 1: MMC1 ------------------------------------------------------
class MMC1 extends MapperBase {
  constructor(cart) {
    super(cart);
    this.shiftReg = 0x10;
    this.control = 0x0c; // PRG mode 3 (fix last bank), CHR mode 0 by default on power-on
    this.chrBank0 = 0;
    this.chrBank1 = 0;
    this.prgBank = 0;
    this.prgBankCount16k = cart.prg.length / 16384;
    this.chrBankCount4k = Math.max(1, cart.chr.length / 4096);
    this.mirrorMode = MIRROR.HORIZONTAL;
    this.lastWriteCycle = -1;
  }

  mirrorNametable(addr) {
    const table = (addr - 0x2000) & 0x0fff;
    const region = table >> 10;
    switch (this.control & 0x03) {
      case 0: return 0; // single screen, bank 0
      case 1: return 1; // single screen, bank 1
      case 2: return region & 0x01; // vertical
      case 3: default: return region >> 1; // horizontal
    }
  }

  cpuRead(addr) {
    if (addr >= 0x6000 && addr < 0x8000) return this.prgRam[addr - 0x6000];
    if (addr < 0x8000) return 0;

    const prgMode = (this.control >> 2) & 0x03;
    let bank16k;
    if (prgMode === 0 || prgMode === 1) {
      // 32KB mode: bankSelect's low bits select a 32KB pair, addr bit14 picks half
      const bank32 = this.prgBank >> 1;
      const which = (addr - 0x8000) >> 14; // 0 or 1
      bank16k = bank32 * 2 + which;
    } else if (prgMode === 2) {
      // fix first bank at $8000, switch $C000
      bank16k = (addr < 0xc000) ? 0 : this.prgBank;
    } else {
      // fix LAST bank at $C000, switch $8000
      bank16k = (addr < 0xc000) ? this.prgBank : (this.prgBankCount16k - 1);
    }
    bank16k = bank16k % this.prgBankCount16k;
    return this.cart.prg[bank16k * 16384 + (addr & 0x3fff)];
  }

  cpuWrite(addr, val) {
    if (addr >= 0x6000 && addr < 0x8000) { this.prgRam[addr - 0x6000] = val; return; }
    if (addr < 0x8000) return;

    if (val & 0x80) {
      // Reset shift register; also forces PRG mode 3 (fix last bank)
      this.shiftReg = 0x10;
      this.control |= 0x0c;
      return;
    }

    const complete = (this.shiftReg & 0x01) !== 0;
    this.shiftReg = (this.shiftReg >> 1) | ((val & 0x01) << 4);

    if (complete) {
      const value = this.shiftReg & 0x1f;
      const target = (addr >> 13) & 0x03; // which internal register, from addr bits 13-14
      switch (target) {
        case 0: this.control = value; break;
        case 1: this.chrBank0 = value; break;
        case 2: this.chrBank1 = value; break;
        case 3: this.prgBank = value & 0x0f; break;
      }
      this.shiftReg = 0x10;
    }
  }

  _chrBankOffset(is4k, bankIndex) {
    const bankCount4k = this.chrBankCount4k;
    return (bankIndex % bankCount4k) * 4096;
  }

  ppuRead(addr) {
    const chrMode = (this.control >> 4) & 0x01;
    let offset;
    if (chrMode === 0) {
      // 8KB mode: chrBank0's low bits (ignoring bit0) select an 8KB bank
      const bank8 = this.chrBank0 >> 1;
      offset = (bank8 % Math.max(1, this.cart.chr.length / 8192)) * 8192 + addr;
    } else {
      // 4KB independent banks
      if (addr < 0x1000) offset = this._chrBankOffset(true, this.chrBank0) + addr;
      else offset = this._chrBankOffset(true, this.chrBank1) + (addr - 0x1000);
    }
    return this.cart.chr[offset % this.cart.chr.length];
  }
  ppuWrite(addr, val) {
    if (!this.cart.chrIsRam) return;
    const chrMode = (this.control >> 4) & 0x01;
    let offset;
    if (chrMode === 0) {
      const bank8 = this.chrBank0 >> 1;
      offset = (bank8 % Math.max(1, this.cart.chr.length / 8192)) * 8192 + addr;
    } else {
      if (addr < 0x1000) offset = this._chrBankOffset(true, this.chrBank0) + addr;
      else offset = this._chrBankOffset(true, this.chrBank1) + (addr - 0x1000);
    }
    this.cart.chr[offset % this.cart.chr.length] = val;
  }
}

// ---- Mapper 4: MMC3 -------------------------------------------------------
class MMC3 extends MapperBase {
  constructor(cart) {
    super(cart);
    this.bankSelect = 0;
    this.bankRegisters = new Array(8).fill(0);
    this.mirrorMode = MIRROR.HORIZONTAL;
    this.prgRamProtect = 0;
    this.irqLatch = 0;
    this.irqCounter = 0;
    this.irqEnabled = false;
    this.irqReload = false;
    this.prgBankCount8k = cart.prg.length / 8192;
    this.chrIsRam = cart.chrIsRam;
  }

  mirrorNametable(addr) {
    const table = (addr - 0x2000) & 0x0fff;
    const region = table >> 10;
    if (this.cart.hasFourScreen) return region;
    return (this.mirrorMode === MIRROR.VERTICAL) ? (region & 0x01) : (region >> 1);
  }

  _prgBank8k(slot) {
    // slot: 0=$8000,1=$A000,2=$C000,3=$E000
    const swapMode = (this.bankSelect >> 6) & 0x01;
    const last = this.prgBankCount8k - 1;
    const secondLast = this.prgBankCount8k - 2;
    if (slot === 3) return last; // $E000 always fixed to second-to-last... actually last bank
    if (!swapMode) {
      if (slot === 0) return this.bankRegisters[6] % this.prgBankCount8k;
      if (slot === 1) return this.bankRegisters[7] % this.prgBankCount8k;
      if (slot === 2) return secondLast;
    } else {
      if (slot === 0) return secondLast;
      if (slot === 1) return this.bankRegisters[7] % this.prgBankCount8k;
      if (slot === 2) return this.bankRegisters[6] % this.prgBankCount8k;
    }
    return 0;
  }

  cpuRead(addr) {
    if (addr >= 0x6000 && addr < 0x8000) return this.prgRam[addr - 0x6000];
    if (addr < 0x8000) return 0;
    const slot = (addr - 0x8000) >> 13; // 0..3
    const bank = this._prgBank8k(slot);
    return this.cart.prg[bank * 8192 + (addr & 0x1fff)];
  }

  cpuWrite(addr, val) {
    if (addr >= 0x6000 && addr < 0x8000) { this.prgRam[addr - 0x6000] = val; return; }
    if (addr < 0x8000) return;

    const even = (addr & 1) === 0;
    if (addr < 0xa000) {
      if (even) this.bankSelect = val;
      else this.bankRegisters[this.bankSelect & 0x07] = val;
    } else if (addr < 0xc000) {
      if (even) this.mirrorMode = (val & 0x01) ? MIRROR.HORIZONTAL : MIRROR.VERTICAL;
      else this.prgRamProtect = val;
    } else if (addr < 0xe000) {
      if (even) this.irqLatch = val;
      else { this.irqCounter = 0; this.irqReload = true; }
    } else {
      if (even) { this.irqEnabled = false; this.irqPending = false; }
      else this.irqEnabled = true;
    }
  }

  _chrOffset(addr) {
    const chrInv = (this.bankSelect >> 7) & 0x01;
    // 8 x 1KB regions across $0000-$1FFF; two 2KB regs (R0,R1) + four 1KB regs (R2-R5)
    const r = this.bankRegisters;
    let regionIndex = addr >> 10; // 0..7
    if (chrInv) regionIndex ^= 0x04; // swap the two 4KB halves
    let bank1k;
    switch (regionIndex) {
      case 0: bank1k = r[0] & 0xfe; break;
      case 1: bank1k = r[0] | 0x01; break;
      case 2: bank1k = r[1] & 0xfe; break;
      case 3: bank1k = r[1] | 0x01; break;
      case 4: bank1k = r[2]; break;
      case 5: bank1k = r[3]; break;
      case 6: bank1k = r[4]; break;
      case 7: bank1k = r[5]; break;
    }
    const totalKB1 = Math.max(1, this.cart.chr.length / 1024);
    bank1k = bank1k % totalKB1;
    return bank1k * 1024 + (addr & 0x3ff);
  }

  ppuRead(addr) { return this.cart.chr[this._chrOffset(addr) % this.cart.chr.length]; }
  ppuWrite(addr, val) { if (this.chrIsRam) this.cart.chr[this._chrOffset(addr) % this.cart.chr.length] = val; }

  // Simplified scanline-based IRQ model: the PPU calls this once per
  // visible/pre-render scanline while rendering is enabled, which is a
  // widely-used approximation of the real A12-rising-edge counter and is
  // accurate enough for the overwhelming majority of MMC3 software.
  notifyScanline() {
    if (this.irqCounter === 0 || this.irqReload) {
      this.irqCounter = this.irqLatch;
      this.irqReload = false;
    } else {
      this.irqCounter--;
    }
    if (this.irqCounter === 0 && this.irqEnabled) {
      this.irqPending = true;
    }
  }
}

const MAPPER_REGISTRY = {
  0: NROM,
  1: MMC1,
  2: UxROM,
  3: CNROM,
  4: MMC3,
};

export function createMapper(cart) {
  const Ctor = MAPPER_REGISTRY[cart.mapperNumber];
  if (!Ctor) {
    throw new RomLoadError(
      `Unsupported mapper: ${cart.mapperNumber}\n\nThis ROM uses mapper ${cart.mapperNumber}, which this emulator does not currently support. Supported mappers: 0 (NROM), 1 (MMC1), 2 (UxROM), 3 (CNROM), 4 (MMC3).`,
      'unsupported-mapper'
    );
  }
  return new Ctor(cart);
}

export const SUPPORTED_MAPPERS = Object.keys(MAPPER_REGISTRY).map(Number);
