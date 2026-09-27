/**
 * ppu.js
 * Ricoh 2C02 Picture Processing Unit.
 *
 * Produces a 256x240 RGBA framebuffer, driven dot-by-dot (341 dots per
 * scanline, 262 scanlines per frame -- NTSC timing) so that CPU and PPU
 * stay correctly locked together at a 1:3 clock ratio via the master
 * clock in emulator.js.
 *
 * Implements: PPUCTRL/MASK/STATUS/OAMADDR/OAMDATA/PPUSCROLL/PPUADDR/
 * PPUDATA registers, the loopy v/t/x/w scroll-address model, background
 * tile/attribute/pattern fetching with shift registers, sprite
 * evaluation (up to 8/scanline) with overflow flag, sprite priority,
 * sprite-zero hit, vblank + NMI generation, and palette RAM with its
 * mirroring quirks.
 */

import { MIRROR } from './cartridge.js';

// Standard NTSC 2C02 palette approximation (RGB), indices 0x00-0x3F.
// This is the well-known public-domain-equivalent palette values used
// throughout NES emulator documentation (nesdev wiki), not copied from
// any single codebase.
const NES_PALETTE = [
  0x626262,0x001fb2,0x2404c8,0x5200b2,0x730076,0x800024,0x730b00,0x522800,
  0x244400,0x005700,0x005c00,0x005324,0x003c76,0x000000,0x000000,0x000000,
  0xababab,0x0d57ff,0x4b30ff,0x8a13ff,0xbc08d6,0xd21269,0xc72e00,0x9d5400,
  0x607b00,0x209800,0x00a300,0x009942,0x007db4,0x000000,0x000000,0x000000,
  0xffffff,0x53aeff,0x9085ff,0xd365ff,0xff57ff,0xff5dcf,0xff7757,0xf1a300,
  0xbdc700,0x7fe300,0x51ef1e,0x40e88f,0x43d9ec,0x4e4e4e,0x000000,0x000000,
  0xffffff,0xb6e1ff,0xcecfff,0xe7c3ff,0xffbdff,0xffbde5,0xffcdb9,0xf4dfa5,
  0xe0f2a0,0xc8f7ab,0xb6f7c8,0xacf3e8,0xace6ff,0xb8b8b8,0x000000,0x000000,
];

const CTRL_NAMETABLE = 0x03;
const CTRL_VRAM_INC = 0x04;
const CTRL_SPRITE_TABLE = 0x08;
const CTRL_BG_TABLE = 0x10;
const CTRL_SPRITE_HEIGHT = 0x20;
const CTRL_MASTER_SLAVE = 0x40;
const CTRL_NMI_ENABLE = 0x80;

const MASK_GREYSCALE = 0x01;
const MASK_BG_LEFT = 0x02;
const MASK_SPRITE_LEFT = 0x04;
const MASK_BG_ENABLE = 0x08;
const MASK_SPRITE_ENABLE = 0x10;

const STATUS_SPRITE_OVERFLOW = 0x20;
const STATUS_SPRITE_ZERO_HIT = 0x40;
const STATUS_VBLANK = 0x80;

export class PPU {
  constructor() {
    this.mapper = null;
    this.cpu = null; // for triggering NMI

    this.nametables = [new Uint8Array(1024), new Uint8Array(1024), new Uint8Array(1024), new Uint8Array(1024)];
    this.paletteRam = new Uint8Array(32);
    this.oam = new Uint8Array(256);
    this.secondaryOam = new Uint8Array(32); // 8 sprites * 4 bytes
    this.spriteCount = 0;
    this.spritePatternLo = new Uint8Array(8);
    this.spritePatternHi = new Uint8Array(8);
    this.spriteAttr = new Uint8Array(8);
    this.spriteX = new Uint8Array(8);
    this.spriteIsZero = new Uint8Array(8);
    this.spriteZeroInSecondary = false;
    this.spriteZeroBeingRendered = false;

    this.ctrl = 0;
    this.mask = 0;
    this.status = 0;
    this.oamAddr = 0;

    this.v = 0; // current VRAM address (loopy v), 15 bits
    this.t = 0; // temporary VRAM address (loopy t), 15 bits
    this.fineX = 0; // 3 bits
    this.writeToggle = false; // loopy w

    this.ppuDataBuffer = 0;

    this.scanline = -1; // -1 = pre-render
    this.dot = 0;
    this.frameOdd = false;
    this.frameComplete = false;
    this.frameCount = 0;

    // Background shift registers
    this.bgShiftPatternLo = 0;
    this.bgShiftPatternHi = 0;
    this.bgShiftAttrLo = 0;
    this.bgShiftAttrHi = 0;
    this.nextTileId = 0;
    this.nextTileAttr = 0;
    this.nextTileLsb = 0;
    this.nextTileMsb = 0;

    // Output framebuffer, 256x240 RGBA
    this.framebuffer = new Uint8ClampedArray(256 * 240 * 4);

    this.suppressNmiThisFrame = false;
  }

  reset() {
    this.ctrl = 0;
    this.mask = 0;
    this.status = 0;
    this.oamAddr = 0;
    this.v = 0; this.t = 0; this.fineX = 0; this.writeToggle = false;
    this.ppuDataBuffer = 0;
    this.scanline = -1;
    this.dot = 0;
    this.frameOdd = false;
    this.frameComplete = false;
  }

  // ---- Nametable mirroring -------------------------------------------
  _nametableIndex(addr) {
    if (this.mapper) return this.mapper.mirrorNametable(addr);
    const table = (addr - 0x2000) & 0x0fff;
    return (table >> 10) >> 1; // fallback horizontal
  }
  _nametableRead(addr) {
    return this.nametables[this._nametableIndex(addr)][addr & 0x03ff];
  }
  _nametableWrite(addr, val) {
    this.nametables[this._nametableIndex(addr)][addr & 0x03ff] = val;
  }

  _paletteIndex(addr) {
    addr &= 0x1f;
    // $3F10/$3F14/$3F18/$3F1C mirror $3F00/$3F04/$3F08/$3F0C (universal bg + unused sprite slots)
    if ((addr & 0x13) === 0x10) addr &= ~0x10;
    return addr;
  }

  // ---- CPU-facing register interface ($2000-$2007) --------------------
  cpuRead(addr) {
    switch (addr & 0x2007) {
      case 0x2002: {
        const value = (this.status & 0xe0) | (this.ppuDataBuffer & 0x1f);
        this.status &= ~STATUS_VBLANK;
        this.writeToggle = false;
        return value;
      }
      case 0x2004:
        return this.oam[this.oamAddr];
      case 0x2007: {
        let value = this.ppuDataBuffer;
        this.ppuDataBuffer = this._ppuBusRead(this.v);
        if ((this.v & 0x3fff) >= 0x3f00) {
          // Palette reads are not delayed/buffered
          value = this._ppuBusRead(this.v);
        }
        this.v = (this.v + ((this.ctrl & CTRL_VRAM_INC) ? 32 : 1)) & 0x7fff;
        return value;
      }
      default:
        return 0;
    }
  }

  cpuWrite(addr, val) {
    val &= 0xff;
    switch (addr & 0x2007) {
      case 0x2000: {
        const oldNmiEnable = (this.ctrl & CTRL_NMI_ENABLE) !== 0;
        this.ctrl = val;
        this.t = (this.t & 0x73ff) | ((val & 0x03) << 10);
        // A rising edge of NMI-enable while vblank flag is already set
        // fires NMI immediately (a documented, subtle PPU quirk).
        if (!oldNmiEnable && (this.ctrl & CTRL_NMI_ENABLE) && (this.status & STATUS_VBLANK)) {
          if (this.cpu) this.cpu.triggerNMI();
        }
        break;
      }
      case 0x2001: this.mask = val; break;
      case 0x2003: this.oamAddr = val; break;
      case 0x2004: this.oam[this.oamAddr] = val; this.oamAddr = (this.oamAddr + 1) & 0xff; break;
      case 0x2005: {
        if (!this.writeToggle) {
          this.fineX = val & 0x07;
          this.t = (this.t & 0x7fe0) | (val >> 3);
        } else {
          this.t = (this.t & 0x0c1f) | ((val & 0x07) << 12) | ((val & 0xf8) << 2);
        }
        this.writeToggle = !this.writeToggle;
        break;
      }
      case 0x2006: {
        if (!this.writeToggle) {
          this.t = (this.t & 0x00ff) | ((val & 0x3f) << 8);
        } else {
          this.t = (this.t & 0x7f00) | val;
          this.v = this.t;
        }
        this.writeToggle = !this.writeToggle;
        break;
      }
      case 0x2007: {
        this._ppuBusWrite(this.v, val);
        this.v = (this.v + ((this.ctrl & CTRL_VRAM_INC) ? 32 : 1)) & 0x7fff;
        break;
      }
    }
  }

  writeOamByte(addr, val) { this.oam[addr & 0xff] = val; }

  // ---- Internal PPU bus (nametables, pattern tables via mapper, palette) ---
  _ppuBusRead(addr) {
    addr &= 0x3fff;
    if (addr < 0x2000) return this.mapper ? this.mapper.ppuRead(addr) : 0;
    if (addr < 0x3f00) return this._nametableRead(addr);
    return this.paletteRam[this._paletteIndex(addr)];
  }
  _ppuBusWrite(addr, val) {
    addr &= 0x3fff;
    if (addr < 0x2000) { if (this.mapper) this.mapper.ppuWrite(addr, val); return; }
    if (addr < 0x3f00) { this._nametableWrite(addr, val); return; }
    this.paletteRam[this._paletteIndex(addr)] = val & 0x3f;
  }

  // ---- Rendering helpers ------------------------------------------------
  _incrementScrollX() {
    if (!this._renderingEnabled()) return;
    if ((this.v & 0x001f) === 31) {
      this.v &= ~0x001f;
      this.v ^= 0x0400;
    } else {
      this.v += 1;
    }
  }
  _incrementScrollY() {
    if (!this._renderingEnabled()) return;
    if ((this.v & 0x7000) !== 0x7000) {
      this.v += 0x1000;
    } else {
      this.v &= ~0x7000;
      let y = (this.v & 0x03e0) >> 5;
      if (y === 29) { y = 0; this.v ^= 0x0800; }
      else if (y === 31) { y = 0; }
      else { y += 1; }
      this.v = (this.v & ~0x03e0) | (y << 5);
    }
  }
  _transferAddressX() {
    if (!this._renderingEnabled()) return;
    this.v = (this.v & ~0x041f) | (this.t & 0x041f);
  }
  _transferAddressY() {
    if (!this._renderingEnabled()) return;
    this.v = (this.v & ~0x7be0) | (this.t & 0x7be0);
  }
  _renderingEnabled() { return (this.mask & (MASK_BG_ENABLE | MASK_SPRITE_ENABLE)) !== 0; }

  _loadBackgroundShifters() {
    this.bgShiftPatternLo = (this.bgShiftPatternLo & 0xff00) | this.nextTileLsb;
    this.bgShiftPatternHi = (this.bgShiftPatternHi & 0xff00) | this.nextTileMsb;
    const attrBits = this.nextTileAttr & 0x03;
    this.bgShiftAttrLo = (this.bgShiftAttrLo & 0xff00) | ((attrBits & 0b01) ? 0xff : 0x00);
    this.bgShiftAttrHi = (this.bgShiftAttrHi & 0xff00) | ((attrBits & 0b10) ? 0xff : 0x00);
  }
  _updateShifters() {
    if (this.mask & MASK_BG_ENABLE) {
      this.bgShiftPatternLo = (this.bgShiftPatternLo << 1) & 0xffff;
      this.bgShiftPatternHi = (this.bgShiftPatternHi << 1) & 0xffff;
      this.bgShiftAttrLo = (this.bgShiftAttrLo << 1) & 0xffff;
      this.bgShiftAttrHi = (this.bgShiftAttrHi << 1) & 0xffff;
    }
  }

  _evaluateSprites() {
    this.secondaryOam.fill(0xff);
    this.spriteCount = 0;
    this.spriteZeroInSecondary = false;
    const spriteHeight = (this.ctrl & CTRL_SPRITE_HEIGHT) ? 16 : 8;
    let n = 0;
    for (let i = 0; i < 64 && this.spriteCount < 8; i++) {
      const y = this.oam[i * 4 + 0];
      const row = this.scanline - y;
      if (row >= 0 && row < spriteHeight) {
        if (i === 0) this.spriteZeroInSecondary = true;
        this.secondaryOam[this.spriteCount * 4 + 0] = y;
        this.secondaryOam[this.spriteCount * 4 + 1] = this.oam[i * 4 + 1];
        this.secondaryOam[this.spriteCount * 4 + 2] = this.oam[i * 4 + 2];
        this.secondaryOam[this.spriteCount * 4 + 3] = this.oam[i * 4 + 3];
        this.spriteCount++;
      }
    }
    // Overflow flag: simplified (correct count-based detection; doesn't
    // reproduce the real hardware's diagonal-read bug for the buggy
    // extra-scan behavior, which no correctly-authored game depends on).
    let extra = 0;
    for (let i = this.spriteCount === 8 ? 8 : 64; i < 64; i++) { /* not used */ }
    if (this.spriteCount >= 8) {
      let count = 0;
      for (let i = 0; i < 64; i++) {
        const y = this.oam[i * 4 + 0];
        const row = this.scanline - y;
        if (row >= 0 && row < spriteHeight) count++;
      }
      if (count > 8) this.status |= STATUS_SPRITE_OVERFLOW;
    }
  }

  _fetchSpritePatterns() {
    const spriteHeight = (this.ctrl & CTRL_SPRITE_HEIGHT) ? 16 : 8;
    for (let i = 0; i < this.spriteCount; i++) {
      const y = this.secondaryOam[i * 4 + 0];
      const tileIndex = this.secondaryOam[i * 4 + 1];
      const attr = this.secondaryOam[i * 4 + 2];
      const x = this.secondaryOam[i * 4 + 3];
      const flipV = (attr & 0x80) !== 0;
      const flipH = (attr & 0x40) !== 0;

      let row = this.scanline - y;
      let patternTable, tileNum;
      if (spriteHeight === 16) {
        tileNum = tileIndex & 0xfe;
        patternTable = (tileIndex & 0x01) ? 0x1000 : 0x0000;
        if (flipV) row = 15 - row;
        if (row >= 8) { tileNum += 1; row -= 8; }
      } else {
        tileNum = tileIndex;
        patternTable = (this.ctrl & CTRL_SPRITE_TABLE) ? 0x1000 : 0x0000;
        if (flipV) row = 7 - row;
      }
      const addr = patternTable + tileNum * 16 + row;
      let lo = this.mapper ? this.mapper.ppuRead(addr) : 0;
      let hi = this.mapper ? this.mapper.ppuRead(addr + 8) : 0;
      if (flipH) {
        lo = this._reverseBits(lo);
        hi = this._reverseBits(hi);
      }
      this.spritePatternLo[i] = lo;
      this.spritePatternHi[i] = hi;
      this.spriteAttr[i] = attr;
      this.spriteX[i] = x;
      this.spriteIsZero[i] = (i === 0 && this.spriteZeroInSecondary) ? 1 : 0;
    }
  }
  _reverseBits(b) {
    b = ((b & 0xf0) >> 4) | ((b & 0x0f) << 4);
    b = ((b & 0xcc) >> 2) | ((b & 0x33) << 2);
    b = ((b & 0xaa) >> 1) | ((b & 0x55) << 1);
    return b;
  }

  _renderPixel() {
    const x = this.dot - 1;
    const y = this.scanline;

    let bgPixel = 0, bgPalette = 0;
    if (this.mask & MASK_BG_ENABLE) {
      if (x >= 8 || (this.mask & MASK_BG_LEFT)) {
        const bitMux = 0x8000 >> this.fineX;
        const p0 = (this.bgShiftPatternLo & bitMux) ? 1 : 0;
        const p1 = (this.bgShiftPatternHi & bitMux) ? 1 : 0;
        bgPixel = (p1 << 1) | p0;
        const a0 = (this.bgShiftAttrLo & bitMux) ? 1 : 0;
        const a1 = (this.bgShiftAttrHi & bitMux) ? 1 : 0;
        bgPalette = (a1 << 1) | a0;
      }
    }

    let spritePixel = 0, spritePalette = 0, spritePriority = 0, spriteZeroHere = false;
    if (this.mask & MASK_SPRITE_ENABLE) {
      if (x >= 8 || (this.mask & MASK_SPRITE_LEFT)) {
        for (let i = 0; i < this.spriteCount; i++) {
          const offset = x - this.spriteX[i];
          if (offset < 0 || offset > 7) continue;
          const shiftAmount = 7 - offset;
          const p0 = (this.spritePatternLo[i] >> shiftAmount) & 1;
          const p1 = (this.spritePatternHi[i] >> shiftAmount) & 1;
          const pix = (p1 << 1) | p0;
          if (pix === 0) continue; // transparent
          spritePixel = pix;
          spritePalette = (this.spriteAttr[i] & 0x03) + 4;
          spritePriority = (this.spriteAttr[i] & 0x20) ? 1 : 0; // 1 = behind background
          spriteZeroHere = this.spriteIsZero[i] === 1;
          break; // first non-transparent sprite in priority order wins
        }
      }
    }

    // Sprite-zero hit
    if (spriteZeroHere && bgPixel !== 0 && spritePixel !== 0 &&
        (this.mask & MASK_BG_ENABLE) && (this.mask & MASK_SPRITE_ENABLE) && x !== 255) {
      this.status |= STATUS_SPRITE_ZERO_HIT;
    }

    let finalPixel = 0, finalPalette = 0;
    if (bgPixel === 0 && spritePixel === 0) { finalPixel = 0; finalPalette = 0; }
    else if (bgPixel === 0) { finalPixel = spritePixel; finalPalette = spritePalette; }
    else if (spritePixel === 0) { finalPixel = bgPixel; finalPalette = bgPalette; }
    else if (spritePriority === 0) { finalPixel = spritePixel; finalPalette = spritePalette; }
    else { finalPixel = bgPixel; finalPalette = bgPalette; }

    const colorAddr = (finalPalette << 2) + finalPixel;
    const paletteEntry = this.paletteRam[this._paletteIndex(0x3f00 + colorAddr)] & 0x3f;
    let rgb = NES_PALETTE[paletteEntry];
    if (this.mask & MASK_GREYSCALE) {
      // force grey column of palette
      rgb = NES_PALETTE[paletteEntry & 0x30];
    }

    if (x >= 0 && x < 256 && y >= 0 && y < 240) {
      const idx = (y * 256 + x) * 4;
      this.framebuffer[idx + 0] = (rgb >> 16) & 0xff;
      this.framebuffer[idx + 1] = (rgb >> 8) & 0xff;
      this.framebuffer[idx + 2] = rgb & 0xff;
      this.framebuffer[idx + 3] = 255;
    }
  }

  // ---- Master clock entry point: advance exactly one PPU dot -----------
  clock() {
    if (this.scanline >= -1 && this.scanline < 240) {
      if (this.scanline === 0 && this.dot === 0 && this.frameOdd && this._renderingEnabled()) {
        this.dot = 1; // skip idle cycle on odd frames when rendering enabled
      }
      if (this.scanline === -1 && this.dot === 1) {
        this.status &= ~(STATUS_VBLANK | STATUS_SPRITE_ZERO_HIT | STATUS_SPRITE_OVERFLOW);
      }

      if ((this.dot >= 2 && this.dot <= 257) || (this.dot >= 321 && this.dot <= 337)) {
        this._updateShifters();
        switch ((this.dot - 1) % 8) {
          case 0:
            this._loadBackgroundShifters();
            this.nextTileId = this._ppuBusRead(0x2000 | (this.v & 0x0fff));
            break;
          case 2: {
            const attrAddr = 0x23c0 | (this.v & 0x0c00) | ((this.v >> 4) & 0x38) | ((this.v >> 2) & 0x07);
            let attr = this._ppuBusRead(attrAddr);
            if (this.v & 0x40) attr >>= 4;
            if (this.v & 0x02) attr >>= 2;
            this.nextTileAttr = attr & 0x03;
            break;
          }
          case 4: {
            const fineY = (this.v >> 12) & 0x07;
            const table = (this.ctrl & CTRL_BG_TABLE) ? 0x1000 : 0x0000;
            const addr = table + this.nextTileId * 16 + fineY;
            this.nextTileLsb = this.mapper ? this.mapper.ppuRead(addr) : 0;
            break;
          }
          case 6: {
            const fineY = (this.v >> 12) & 0x07;
            const table = (this.ctrl & CTRL_BG_TABLE) ? 0x1000 : 0x0000;
            const addr = table + this.nextTileId * 16 + fineY + 8;
            this.nextTileMsb = this.mapper ? this.mapper.ppuRead(addr) : 0;
            break;
          }
          case 7:
            this._incrementScrollX();
            break;
        }
      }

      if (this.dot === 256) this._incrementScrollY();
      if (this.dot === 257) { this._loadBackgroundShifters(); this._transferAddressX(); }

      if (this.dot === 257 && this.scanline >= 0) {
        this._evaluateSprites();
        this._fetchSpritePatterns();
        if (this.mapper && this.mapper.notifyScanline && this._renderingEnabled()) {
          this.mapper.notifyScanline();
        }
      }

      if (this.scanline === -1 && this.dot >= 280 && this.dot <= 304) {
        this._transferAddressY();
      }

      // Unused NT fetches at 337/339 for timing accuracy (value discarded)
      if (this.dot === 337 || this.dot === 339) {
        this.nextTileId = this._ppuBusRead(0x2000 | (this.v & 0x0fff));
      }
    }

    if (this.scanline >= 0 && this.scanline < 240 && this.dot >= 1 && this.dot <= 256) {
      this._renderPixel();
    }

    if (this.scanline === 241 && this.dot === 1) {
      this.status |= STATUS_VBLANK;
      if (this.ctrl & CTRL_NMI_ENABLE) {
        if (this.cpu) this.cpu.triggerNMI();
      }
    }

    // Advance dot/scanline counters
    this.dot++;
    if (this.dot > 340) {
      this.dot = 0;
      this.scanline++;
      if (this.scanline > 260) {
        this.scanline = -1;
        this.frameOdd = !this.frameOdd;
        this.frameComplete = true;
        this.frameCount++;
      }
    }
  }
}
