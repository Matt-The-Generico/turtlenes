import fs from 'fs';
import { Emulator } from '../js/emulator.js';

// Node has no IndexedDB; stub it out since nestest has no battery anyway,
// but the emulator code path still probes for it when handling ROMs that
// declare battery-backed RAM. Provide a minimal always-fails-gracefully stub.
globalThis.indexedDB = {
  open() {
    const req = { onupgradeneeded: null, onsuccess: null, onerror: null };
    setTimeout(() => { if (req.onerror) req.onerror(); }, 0);
    return req;
  },
};

const romPath = new URL('./nestest.nes', import.meta.url);
const buf = fs.readFileSync(romPath);
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

const emu = new Emulator();
const info = emu.loadRom(ab, 'nestest.nes');
console.log('Loaded ROM:', info);

emu.play();
const FRAMES = 120; // 2 seconds of NTSC frames
let crashed = false;
try {
  for (let i = 0; i < FRAMES; i++) {
    emu.runFrame();
  }
} catch (e) {
  crashed = true;
  console.error('CRASHED during runFrame:', e);
}

if (crashed) process.exit(1);

// Check framebuffer isn't all-zero (i.e. something was actually drawn)
const fb = emu.ppu.framebuffer;
let nonZeroPixels = 0;
for (let i = 0; i < fb.length; i += 4) {
  if (fb[i] !== 0 || fb[i + 1] !== 0 || fb[i + 2] !== 0) nonZeroPixels++;
}
console.log(`Ran ${FRAMES} frames without crashing.`);
console.log(`Non-black pixels in final frame: ${nonZeroPixels} / ${fb.length / 4}`);
console.log(`PPU frame count: ${emu.ppu.frameCount}`);
console.log(`CPU total cycles: ${emu.cpu.totalCycles}`);
console.log(`CPU jammed: ${emu.cpu.jammed} ${emu.cpu.jammed ? '(opcode 0x' + emu.cpu.jamOpcode.toString(16) + ')' : ''}`);

if (nonZeroPixels === 0) {
  console.error('FAIL: framebuffer is entirely black -- rendering pipeline produced nothing.');
  process.exit(1);
}
if (emu.ppu.frameCount < FRAMES - 1) {
  console.error('FAIL: PPU frame counter did not advance as expected.');
  process.exit(1);
}
console.log('PASS: integration smoke test succeeded.');
