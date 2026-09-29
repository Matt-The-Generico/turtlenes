/**
 * cartridge.js
 * iNES / NES 2.0 header parsing and cartridge (PRG/CHR) storage.
 *
 * This module ONLY parses the ROM file and exposes its data/metadata.
 * Bank-switching behavior lives in mapper.js, which is handed this
 * Cartridge instance and reads/writes through it.
 */

export const MIRROR = {
  HORIZONTAL: 'horizontal',
  VERTICAL: 'vertical',
  SINGLE_SCREEN_A: 'single-a',
  SINGLE_SCREEN_B: 'single-b',
  FOUR_SCREEN: 'four-screen',
};

export class RomLoadError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'RomLoadError';
    this.code = code; // 'invalid' | 'unsupported-mapper' | 'missing-chr' | 'corrupt'
  }
}

export class Cartridge {
  constructor() {
    this.filename = '';
    this.prg = new Uint8Array(0);
    this.chr = new Uint8Array(0);
    this.chrIsRam = false;
    this.mapperNumber = 0;
    this.submapper = 0;
    this.mirroring = MIRROR.HORIZONTAL;
    this.hasFourScreen = false;
    this.hasBattery = false;
    this.hasTrainer = false;
    this.trainer = null;
    this.prgRamSize = 8192; // default assumption for mapper 0 boards
    this.isNes2 = false;
    this.prgBanks16k = 0;
    this.chrBanks8k = 0;
  }

  static fromArrayBuffer(buf, filename) {
    const bytes = new Uint8Array(buf);
    if (bytes.length < 16) {
      throw new RomLoadError('File is too small to be a valid NES ROM.', 'invalid');
    }
    if (!(bytes[0] === 0x4e && bytes[1] === 0x45 && bytes[2] === 0x53 && bytes[3] === 0x1a)) {
      throw new RomLoadError(
        'This does not look like a valid .nes file (missing "NES\\x1A" header signature).',
        'invalid'
      );
    }

    const cart = new Cartridge();
    cart.filename = filename || 'unknown.nes';

    const prgBanks16k = bytes[4];
    let chrBanks8k = bytes[5];
    const flags6 = bytes[6];
    const flags7 = bytes[7];

    cart.hasTrainer = (flags6 & 0x04) !== 0;
    cart.hasFourScreen = (flags6 & 0x08) !== 0;
    cart.hasBattery = (flags6 & 0x02) !== 0;
    const verticalMirror = (flags6 & 0x01) !== 0;

    // NES 2.0 detection: bits 2-3 of byte 7 equal binary 10
    const isNes2 = (flags7 & 0x0c) === 0x08;
    cart.isNes2 = isNes2;

    let mapperNumber = ((flags7 & 0xf0) | (flags6 >> 4));
    let submapper = 0;
    let prgRamSize = 8192;

    if (isNes2) {
      const mapperHi = bytes[8] & 0x0f;
      submapper = (bytes[8] & 0xf0) >> 4;
      mapperNumber |= mapperHi << 8;
      // NES 2.0 encodes PRG/CHR sizes with extra high bits (byte 9) -
      // handled at a basic level; exotic >8MB ROMs are out of scope.
      const prgHi = bytes[9] & 0x0f;
      const chrHi = (bytes[9] & 0xf0) >> 4;
      if (prgHi !== 0x0f) {
        // upper nibble extends bank count (rare); ignore exponent form for simplicity
      }
    }

    cart.mapperNumber = mapperNumber;
    cart.submapper = submapper;
    cart.mirroring = cart.hasFourScreen
      ? MIRROR.FOUR_SCREEN
      : (verticalMirror ? MIRROR.VERTICAL : MIRROR.HORIZONTAL);

    let offset = 16;
    if (cart.hasTrainer) {
      if (bytes.length < offset + 512) {
        throw new RomLoadError('ROM declares a trainer but the file is too short to contain it.', 'corrupt');
      }
      cart.trainer = bytes.slice(offset, offset + 512);
      offset += 512;
    }

    const prgSize = prgBanks16k * 16384;
    if (bytes.length < offset + prgSize) {
      throw new RomLoadError(
        `ROM header declares ${prgBanks16k} x 16KB PRG banks but the file is too short to contain them.`,
        'corrupt'
      );
    }
    cart.prg = bytes.slice(offset, offset + prgSize);
    offset += prgSize;
    cart.prgBanks16k = prgBanks16k;

    let chrSize = chrBanks8k * 8192;
    if (chrBanks8k === 0) {
      // CHR RAM board: no CHR ROM in the file, RAM is provided at runtime.
      cart.chrIsRam = true;
      chrSize = 8192; // standard assumption; NES 2.0 could specify otherwise
      cart.chr = new Uint8Array(chrSize);
    } else {
      if (bytes.length < offset + chrSize) {
        throw new RomLoadError(
          `ROM header declares ${chrBanks8k} x 8KB CHR banks but the file is too short to contain them.`,
          'corrupt'
        );
      }
      cart.chr = bytes.slice(offset, offset + chrSize);
    }
    cart.chrBanks8k = chrBanks8k;

    if (prgBanks16k === 0) {
      throw new RomLoadError('ROM header declares zero PRG ROM banks; nothing to execute.', 'corrupt');
    }

    return cart;
  }

  get prgSizeBytes() { return this.prg.length; }
  get chrSizeBytes() { return this.chr.length; }

  describe() {
    const mapperNames = {
      0: 'NROM', 1: 'MMC1', 2: 'UxROM', 3: 'CNROM', 4: 'MMC3',
      7: 'AxROM', 9: 'MMC2', 11: 'Color Dreams',
    };
    return {
      filename: this.filename,
      format: this.isNes2 ? 'NES 2.0' : 'iNES',
      mapperNumber: this.mapperNumber,
      mapperName: mapperNames[this.mapperNumber] || 'Unknown',
      prgKB: this.prg.length / 1024,
      chrKB: this.chr.length / 1024,
      chrIsRam: this.chrIsRam,
      mirroring: this.mirroring,
      battery: this.hasBattery,
      trainer: this.hasTrainer,
      submapper: this.submapper,
    };
  }
}
