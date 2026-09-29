import { Cartridge, MIRROR } from '../js/cartridge.js';
import { createMapper } from '../js/mapper.js';

let failures = 0;
function assertEq(actual, expected, label) {
  if (actual !== expected) { console.error(`FAIL: ${label} -- expected ${expected}, got ${actual}`); failures++; }
  else console.log(`ok:   ${label}`);
}

function fakeCart({ mapperNumber, prgBanks16k, chrBanks8k, chrIsRam = false }) {
  const cart = new Cartridge();
  cart.mapperNumber = mapperNumber;
  cart.prgBanks16k = prgBanks16k;
  cart.chrBanks8k = chrBanks8k;
  cart.prg = new Uint8Array(prgBanks16k * 16384);
  // Stamp each 16KB PRG bank with its own index at offset 0, for easy identification.
  for (let b = 0; b < prgBanks16k; b++) cart.prg[b * 16384] = b;
  cart.chr = new Uint8Array(Math.max(1, chrBanks8k) * 8192);
  cart.chrIsRam = chrIsRam;
  for (let b = 0; b < Math.max(1, chrBanks8k); b++) cart.chr[b * 8192] = b + 0x40;
  cart.mirroring = MIRROR.HORIZONTAL;
  return cart;
}

// --- UxROM: switchable $8000-$BFFF, fixed LAST bank at $C000-$FFFF ---
{
  const cart = fakeCart({ mapperNumber: 2, prgBanks16k: 4, chrBanks8k: 0, chrIsRam: true });
  const m = createMapper(cart);
  assertEq(m.cpuRead(0xc000), 3, 'UxROM: $C000 fixed to LAST bank (3) at power-on');
  m.cpuWrite(0x8000, 0x01); // select bank 1
  assertEq(m.cpuRead(0x8000), 1, 'UxROM: $8000 reflects newly selected bank 1');
  assertEq(m.cpuRead(0xc000), 3, 'UxROM: $C000 remains fixed to LAST bank after switch');
  m.cpuWrite(0x8000, 0x02);
  assertEq(m.cpuRead(0x8000), 2, 'UxROM: switching to bank 2 works');
}

// --- CNROM: fixed 32KB PRG, switchable 8KB CHR ---
{
  const cart = fakeCart({ mapperNumber: 3, prgBanks16k: 2, chrBanks8k: 4 });
  const m = createMapper(cart);
  assertEq(m.ppuRead(0), 0x40, 'CNROM: CHR bank 0 selected by default');
  m.cpuWrite(0x8000, 2);
  assertEq(m.ppuRead(0), 0x42, 'CNROM: CHR bank switch to bank 2 works');
}

// --- MMC1: PRG mode 3 (fix last, switch first) is the power-on default ---
{
  const cart = fakeCart({ mapperNumber: 1, prgBanks16k: 8, chrBanks8k: 0, chrIsRam: true });
  const m = createMapper(cart);
  assertEq(m.cpuRead(0xc000), 7, 'MMC1: $C000 fixed to LAST bank (7) at power-on');
  // Write bank-select register (target 3, addr bit13-14 = 11) with value 2,
  // serially, LSB first, 5 writes.
  const writeSerial5 = (addr, value) => {
    for (let i = 0; i < 5; i++) {
      m.cpuWrite(addr, (value >> i) & 0x01);
    }
  };
  writeSerial5(0xe000, 2); // PRG bank register <- 2
  assertEq(m.cpuRead(0x8000), 2, 'MMC1: switched $8000 bank to 2 (PRG mode 3 keeps $C000 fixed)');
  assertEq(m.cpuRead(0xc000), 7, 'MMC1: $C000 still fixed to last bank after PRG bank switch');
}

// --- MMC3: PRG mode 0 fixes $C000 to second-to-last bank ---
{
  const cart = fakeCart({ mapperNumber: 4, prgBanks16k: 0, chrBanks8k: 0 });
  // MMC3 banks in 8KB units for PRG; build manually.
  cart.prg = new Uint8Array(8 * 8192);
  for (let b = 0; b < 8; b++) cart.prg[b * 8192] = b;
  cart.chr = new Uint8Array(8192);
  const m = createMapper(cart);
  assertEq(m.cpuRead(0xe000), 7, 'MMC3: $E000 always fixed to LAST 8KB bank');
  assertEq(m.cpuRead(0xc000), 6, 'MMC3: $C000 fixed to second-to-last bank in PRG mode 0 at power-on');
  m.cpuWrite(0x8000, 0x06); // select register 6 (maps to $8000 in mode 0)
  m.cpuWrite(0x8001, 0x03); // R6 = bank 3
  assertEq(m.cpuRead(0x8000), 3, 'MMC3: R6 write correctly banks in at $8000 (PRG mode 0)');
}

// --- AxROM: 32KB PRG bank switch + single-screen mirror select ---
{
  const cart = fakeCart({ mapperNumber: 7, prgBanks16k: 8, chrBanks8k: 0, chrIsRam: true });
  const m = createMapper(cart);
  assertEq(m.cpuRead(0x8000), 0, 'AxROM: bank 0 selected by default');
  m.cpuWrite(0x8000, 0x02); // select bank 2, single-screen A
  assertEq(m.cpuRead(0x8000), 4, 'AxROM: switched to 32KB bank 2 (byte-offset 65536, stamped as 16KB-bank 4)');
  assertEq(m.mirrorNametable(0x2400), 0, 'AxROM: single-screen A maps all nametables to slot 0');
  m.cpuWrite(0x8000, 0x12); // same bank, single-screen B (bit4 set)
  assertEq(m.mirrorNametable(0x2c00), 1, 'AxROM: single-screen B maps all nametables to slot 1');
}

// --- MMC2: fixed last-three-banks PRG, latch-driven CHR banking ---
{
  const cart = new Cartridge();
  cart.mapperNumber = 9;
  cart.mirroring = MIRROR.VERTICAL;
  cart.prg = new Uint8Array(8 * 8192);
  for (let b = 0; b < 8; b++) cart.prg[b * 8192] = b;
  cart.chr = new Uint8Array(8 * 4096);
  for (let b = 0; b < 8; b++) cart.chr[b * 4096] = b + 0x10;
  const m = createMapper(cart);
  assertEq(m.cpuRead(0xa000), 5, 'MMC2: $A000 fixed to third-from-last bank (5) at power-on');
  assertEq(m.cpuRead(0xc000), 6, 'MMC2: $C000 fixed to second-from-last bank (6)');
  assertEq(m.cpuRead(0xe000), 7, 'MMC2: $E000 fixed to LAST bank (7)');
  m.cpuWrite(0xa000, 3); // switchable $8000-$9FFF -> bank 3
  assertEq(m.cpuRead(0x8000), 3, 'MMC2: $8000 reflects switched-in bank 3');

  // CHR latch behavior: default latch state is 0xFE for both windows.
  m.cpuWrite(0xb000, 1); // chrBank0Fe... wait $B000 is Fd bank; set both to know values
  m.cpuWrite(0xb000, 1); // chr0 (latch=FD) = bank 1
  m.cpuWrite(0xc000, 2); // chr0 (latch=FE) = bank 2
  assertEq(m.ppuRead(0x0000), 0x12, 'MMC2: reads bank 2 in $0000 region at default latch (FE)');
  // Fetching tile $FD's marker address flips latch0 to FD.
  m.ppuRead(0x0fd8);
  assertEq(m.ppuRead(0x0000), 0x11, 'MMC2: latch flip to FD switches in bank 1');
}

// --- Color Dreams: 32KB PRG + 8KB CHR from one combined register ---
{
  const cart = fakeCart({ mapperNumber: 11, prgBanks16k: 4, chrBanks8k: 4 });
  const m = createMapper(cart);
  assertEq(m.cpuRead(0x8000), 0, 'Color Dreams: PRG bank 0 by default');
  assertEq(m.ppuRead(0), 0x40, 'Color Dreams: CHR bank 0 by default');
  m.cpuWrite(0x8000, 0x21); // PRG bank 1, CHR bank 2
  assertEq(m.cpuRead(0x8000), 2, 'Color Dreams: PRG bank switched to 1 (byte-offset 32768, stamped as 16KB-bank 2)');
  assertEq(m.ppuRead(0), 0x42, 'Color Dreams: CHR bank switched to 2');
}

console.log(failures === 0 ? '\nALL MAPPER QUICK TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
