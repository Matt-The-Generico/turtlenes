import fs from 'fs';
import { Emulator } from '../js/emulator.js';

globalThis.indexedDB = {
  open() {
    const req = {};
    setTimeout(() => { if (req.onerror) req.onerror(); }, 0);
    return req;
  },
};

let failures = 0;
const ok = (cond, label) => {
  if (!cond) { console.error('FAIL: ' + label); failures++; } else console.log('ok:   ' + label);
};

function loadNestest() {
  const buf = fs.readFileSync(new URL('./nestest.nes', import.meta.url));
  const emu = new Emulator();
  emu.loadRom(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), 'nestest.nes');
  emu.play();
  return emu;
}

// Builds a tiny second ROM (different content) to test wrong-ROM rejection.
function loadOtherRom() {
  const header = new Uint8Array(16);
  header.set([0x4e, 0x45, 0x53, 0x1a, 1, 1]);
  const rom = new Uint8Array(16 + 16384 + 8192);
  rom.set(header, 0);
  rom[16] = 0xea; rom[16 + 0x3ffc] = 0x00; rom[16 + 0x3ffd] = 0x80;
  const emu = new Emulator();
  emu.loadRom(rom.buffer, 'other.nes');
  emu.play();
  return emu;
}

function fingerprint(emu) {
  let h = 0;
  const fb = emu.ppu.framebuffer;
  for (let i = 0; i < fb.length; i += 7) h = (Math.imul(h, 31) + fb[i]) | 0;
  const c = emu.cpu;
  return [h, c.pc, c.a, c.x, c.y, c.sp, c.p, c.totalCycles, emu.bus.ram.reduce((a, b) => (a + b) | 0, 0)].join(',');
}

// ---- Round trip through the in-memory state ----
{
  const emu = loadNestest();
  for (let i = 0; i < 40; i++) emu.runFrame();
  const original = emu.saveState();
  const originalPrint = fingerprint(emu);

  for (let i = 0; i < 25; i++) emu.runFrame();          // change the game state
  const exportedText = emu.serializeState(original);     // export the ORIGINAL
  for (let i = 0; i < 25; i++) emu.runFrame();          // change it again
  ok(fingerprint(emu) !== originalPrint, 'emulation state changed after running further');

  // Import from the exported text (as a file would be)
  const imported = emu.deserializeState(exportedText);
  ok(imported !== null, 'exported state text parses back');
  const r = emu.loadState(imported);
  ok(r.ok, 'imported state loads without error');

  // Determinism: restored emulator must evolve exactly like the original did.
  const ref = loadNestest();
  for (let i = 0; i < 40; i++) ref.runFrame();
  for (let i = 0; i < 30; i++) { ref.runFrame(); emu.runFrame(); }
  ok(fingerprint(ref) === fingerprint(emu), 'restored emulator runs identically to the original (30 frames after restore)');
  ok(ref.cpu.totalCycles === emu.cpu.totalCycles, 'CPU cycle counters match after restore + 30 frames');
}

// ---- State restore reproduces the exact CPU/RAM/PPU values immediately ----
{
  const emu = loadNestest();
  for (let i = 0; i < 20; i++) emu.runFrame();
  const state = emu.saveState();
  const snap = { pc: emu.cpu.pc, a: emu.cpu.a, sp: emu.cpu.sp, scan: emu.ppu.scanline, dot: emu.ppu.dot, v: emu.ppu.v };
  for (let i = 0; i < 15; i++) emu.runFrame();
  emu.loadState(state);
  ok(emu.cpu.pc === snap.pc && emu.cpu.a === snap.a && emu.cpu.sp === snap.sp, 'CPU registers restored exactly');
  ok(emu.ppu.scanline === snap.scan && emu.ppu.dot === snap.dot && emu.ppu.v === snap.v, 'PPU position and VRAM address restored exactly');
}

// ---- Mapper state (MMC3 registers and IRQ counters) survives a round trip ----
{
  const header = new Uint8Array(16);
  header.set([0x4e, 0x45, 0x53, 0x1a, 8, 1, 0x40, 0x00]);
  const rom = new Uint8Array(16 + 8 * 16384 + 8192);
  rom.set(header, 0);
  const emu = new Emulator();
  emu.loadRom(rom.buffer, 'mmc3.nes');
  const m = emu.mapper;
  m.cpuWrite(0x8000, 0x06); m.cpuWrite(0x8001, 0x05);
  m.cpuWrite(0xc000, 0x11); m.cpuWrite(0xe001, 0);
  const st = emu.deserializeState(emu.serializeState(emu.saveState()));
  m.cpuWrite(0x8000, 0x07); m.cpuWrite(0x8001, 0x09); m.cpuWrite(0xc000, 0x22); m.cpuWrite(0xe000, 0);
  ok(emu.loadState(st).ok, 'MMC3 state loads');
  ok(m.bankRegisters[6] === 5 && m.irqLatch === 0x11 && m.irqEnabled === true, 'MMC3 bank registers and IRQ settings restored');
}

// ---- Wrong ROM rejected ----
{
  const a = loadNestest();
  for (let i = 0; i < 5; i++) a.runFrame();
  const text = a.serializeState(a.saveState());
  const b = loadOtherRom();
  const r = b.loadState(b.deserializeState(text));
  ok(!r.ok && /different ROM/.test(r.reason), 'state from a different ROM is refused with a clear reason');
  const bad = a.loadState({ format: 'something-else' });
  ok(!bad.ok, 'unknown state format is refused');
  ok(a.deserializeState('not json {{') === null, 'corrupt state text is rejected without throwing');
}

// ---- Rewind ----
{
  const emu = loadNestest();
  emu.configureRewind({ enabled: true, seconds: 5 });
  for (let i = 0; i < 90; i++) emu.runFrame();
  ok(emu.rewindBuffer.length > 10, `rewind buffer filled (${emu.rewindBuffer.length} snapshots)`);
  ok(emu.rewindBuffer.length <= emu.rewindCapacity, 'rewind buffer respects its capacity');
  const cyclesBefore = emu.cpu.totalCycles;
  for (let i = 0; i < 5; i++) emu.rewindStep();
  ok(emu.cpu.totalCycles < cyclesBefore, 'rewinding moves emulation back in time');
  emu.runFrame();
  ok(emu.rewindBuffer.length < 30, 'resuming after a rewind drops the rewound-past snapshots');
  for (let i = 0; i < 400; i++) emu.runFrame();
  ok(emu.rewindBuffer.length <= emu.rewindCapacity, 'buffer stays bounded over a long run');
}

// ---- Cheats ----
{
  const emu = loadNestest();
  ok(Emulator.parseCheat('0300:FF').address === 0x300, 'cheat parser accepts AAAA:VV');
  ok(Emulator.parseCheat('8000:01').error !== undefined, 'cheat parser rejects ROM addresses');
  ok(Emulator.parseCheat('junk').error !== undefined, 'cheat parser rejects bad text');
  const added = emu.addCheat('0300:5A', 'test');
  ok(!!added.cheat, 'cheat added');
  emu.runFrame();
  ok(emu.bus.ram[0x300] === 0x5a, 'enabled cheat writes its value into RAM');
  emu.bus.ram[0x300] = 0;
  emu.setCheatEnabled(added.cheat.id, false);
  emu.runFrame();
  ok(emu.bus.ram[0x300] !== 0x5a, 'disabled cheat does nothing');
  const romByte = emu.bus.cpuRead(0xc000);
  emu.setCheatEnabled(added.cheat.id, true);
  emu.runFrame();
  ok(emu.bus.cpuRead(0xc000) === romByte, 'cheats never modify the ROM');
  emu.removeCheat(added.cheat.id);
  ok(emu.cheats.length === 0, 'cheat removed');
}

console.log(failures === 0 ? '\nALL SAVESTATE/REWIND/CHEAT TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
