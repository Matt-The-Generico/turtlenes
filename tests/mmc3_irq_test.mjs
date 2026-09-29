import { Cartridge, MIRROR } from '../js/cartridge.js';
import { createMapper } from '../js/mapper.js';
import { Emulator } from '../js/emulator.js';

let failures = 0;
function assertEq(actual, expected, label) {
  if (actual !== expected) { console.error(`FAIL: ${label} -- expected ${expected}, got ${actual}`); failures++; }
  else console.log(`ok:   ${label}`);
}
function assertTrue(cond, label) {
  if (!cond) { console.error(`FAIL: ${label}`); failures++; }
  else console.log(`ok:   ${label}`);
}

// ---- Part 1: counter logic in isolation (direct notifyA12Rise calls) ----
{
  const cart = new Cartridge();
  cart.mapperNumber = 4;
  cart.prg = new Uint8Array(8 * 8192);
  cart.chr = new Uint8Array(8192);
  cart.mirroring = MIRROR.HORIZONTAL;
  const m = createMapper(cart);

  // Program: latch = 4, reload requested, IRQ enabled.
  m.cpuWrite(0xc000, 4);   // $C000 even -> irqLatch = 4
  m.cpuWrite(0xc001, 0);   // $C001 odd  -> force reload on next clock
  m.cpuWrite(0xe001, 0);   // $E001 odd  -> enable IRQ

  assertEq(m.irqPending, false, 'MMC3: IRQ not pending before any A12 edges');
  m.notifyA12Rise(); // reload: counter becomes latch (4), not yet 0
  assertEq(m.irqPending, false, 'MMC3: first edge after reload does not fire (counter=4)');
  m.notifyA12Rise(); // 3
  m.notifyA12Rise(); // 2
  m.notifyA12Rise(); // 1
  assertEq(m.irqPending, false, 'MMC3: still not pending at counter=1');
  m.notifyA12Rise(); // 0 -> fires
  assertEq(m.irqPending, true, 'MMC3: IRQ fires when counter reaches 0');

  m.clearIrq();
  assertEq(m.irqPending, false, 'MMC3: clearIrq() acknowledges the IRQ');

  // Disabling IRQ via $E000 should prevent future firing even at counter=0.
  m.cpuWrite(0xc001, 0);
  m.cpuWrite(0xe000, 0); // disable
  for (let i = 0; i < 5; i++) m.notifyA12Rise();
  assertEq(m.irqPending, false, 'MMC3: disabled IRQ never fires regardless of counter');
}

// ---- Part 2: full-system integration, verifying IRQ actually reaches the CPU ----
{
  // Build a tiny synthetic MMC3 ROM: sets sprite pattern table to $1000 and
  // background pattern table to $0000 (the standard convention that makes
  // A12 toggle once per visible scanline), turns on rendering, configures
  // the MMC3 IRQ (latch=2, enable), then spins in a tight loop waiting for
  // the IRQ vector to run.
  const cart = new Cartridge();
  cart.mapperNumber = 4;
  cart.mirroring = MIRROR.HORIZONTAL;
  cart.prg = new Uint8Array(8 * 8192);
  cart.chr = new Uint8Array(8192);
  // put a single non-zero pattern tile so background/sprite fetches read
  // real data (not strictly required for A12 timing, but harmless).
  cart.chr[0] = 0xff;

  const prg = cart.prg;
  let pc = 0x0000; // offset within the last 8KB bank (mapped to $E000-$FFFF, fixed)
  const emit = (...bytes) => { for (const b of bytes) prg[6 * 8192 + pc++] = b; };

  // PPUCTRL = 0x18 (BG table=$0000, sprite table=$1000, both from bit4=0/bit3=1... )
  // bit3 (0x08) = sprite table select -> 1 = $1000
  // bit4 (0x10) = bg table select -> 0 = $0000
  emit(0xA9, 0x08);       // LDA #$08
  emit(0x8D, 0x00, 0x20); // STA $2000 (PPUCTRL)
  emit(0xA9, 0x1E);       // LDA #$1E (show background + sprites, incl leftmost 8px)
  emit(0x8D, 0x01, 0x20); // STA $2001 (PPUMASK)
  // MMC3 IRQ setup: latch = 2, reload, enable
  emit(0xA9, 0x02);       // LDA #$02
  emit(0x8D, 0x00, 0x80); // STA $8000 -> bank-select reg (value irrelevant to IRQ path)
  emit(0xA9, 0x02);
  emit(0x8D, 0x00, 0xC0); // STA $C000 -> irqLatch = 2
  emit(0x8D, 0x01, 0xC0); // STA $C001 -> force reload
  emit(0x8D, 0x01, 0xE0); // STA $E001 -> enable IRQ
  emit(0x58);             // CLI (allow IRQs through)
  // spin loop
  const loopAddr = 0xE000 + pc;
  emit(0xEA);             // NOP
  emit(0x4C, loopAddr & 0xff, (loopAddr >> 8) & 0xff); // JMP loop

  // Reset vector -> $E000 (start of this bank, matches offset 0 above)
  prg[7 * 8192 + 0x1ffc - 0x2000 + 0x2000] = 0; // placeholder, set explicitly below
  // PRG is 8x8KB banks; bank 7 occupies $E000-$FFFF (fixed, MMC3 last bank).
  const bank7Base = 7 * 8192;
  prg[bank7Base + 0x1ffc] = 0x00; // reset vector low -> $E000
  prg[bank7Base + 0x1ffd] = 0xe0; // reset vector high
  prg[bank7Base + 0x1ffe] = 0x00; // IRQ/BRK vector -> also $E000 is fine (we just need it to be hit)
  prg[bank7Base + 0x1fff] = 0xe0;
  // Mark a distinctive byte right at the IRQ vector target so we can tell
  // if the CPU actually jumped there via a real hardware interrupt vs.
  // just looping. Use a separate marker address instead: place a BRK-like
  // sentinel opcode (0xFF, illegal in this emulator) at $E100, and point
  // the IRQ vector there instead of at reset.
  prg[bank7Base + 0x1ffe] = 0x00;
  prg[bank7Base + 0x1fff] = 0xe1; // IRQ vector -> $E100
  prg[bank7Base + (0xe100 - 0xe000)] = 0xEA; // NOP at the IRQ handler (harmless if reached)

  globalThis.indexedDB = {
    open() {
      const req = { onupgradeneeded: null, onsuccess: null, onerror: null };
      setTimeout(() => { if (req.onerror) req.onerror(); }, 0);
      return req;
    },
  };

  const emu = new Emulator();
  const buf = cart.prg.buffer.slice(0);
  // loadRom expects a raw iNES ArrayBuffer, so build one from our synthetic cart directly.
  const header = new Uint8Array(16);
  header.set([0x4e, 0x45, 0x53, 0x1a]);
  header[4] = cart.prg.length / 16384;
  header[5] = cart.chr.length / 8192;
  header[6] = ((4 & 0x0f) << 4); // mapper 4 low nibble, horizontal mirroring
  header[7] = (4 & 0xf0);
  const full = new Uint8Array(header.length + cart.prg.length + cart.chr.length);
  full.set(header, 0);
  full.set(cart.prg, header.length);
  full.set(cart.chr, header.length + cart.prg.length);

  const info = emu.loadRom(full.buffer, 'synthetic-mmc3-irq.nes');
  assertEq(info.mapperName, 'MMC3', 'MMC3 integration: ROM loaded as MMC3');

  emu.play();
  let irqVectorHit = false;
  for (let f = 0; f < 10 && !irqVectorHit; f++) {
    emu.runFrame();
    if (emu.cpu.pc >= 0xe100 && emu.cpu.pc <= 0xe101) irqVectorHit = true;
  }
  assertTrue(irqVectorHit, 'MMC3 integration: A12-edge-driven IRQ actually reached the CPU (PC hit $E100 handler)');
}

console.log(failures === 0 ? '\nALL MMC3 IRQ TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
