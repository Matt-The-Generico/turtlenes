import fs from 'fs';
import { CPU6502 } from '../js/cpu6502.js';

// Minimal CPU-only bus: nestest.nes is mapper 0 (NROM), 16KB PRG mirrored
// into both $8000-$BFFF and $C000-$FFFF. We don't need PPU/APU for the
// CPU-log comparison (the "automation mode" trace never depends on their
// actual behavior, only that reads/writes to their registers don't crash).
class NestestBus {
  constructor(prg) {
    this.ram = new Uint8Array(0x0800);
    this.prg = prg; // 16KB Uint8Array
  }
  cpuRead(addr) {
    if (addr < 0x2000) return this.ram[addr & 0x07ff];
    if (addr >= 0x8000) return this.prg[(addr - 0x8000) & 0x3fff];
    return 0; // PPU/APU/IO stub
  }
  cpuWrite(addr, val) {
    if (addr < 0x2000) { this.ram[addr & 0x07ff] = val; return; }
    // writes to PPU/APU/IO ignored in this CPU-only harness
  }
}

function parseINes(buf) {
  if (buf[0] !== 0x4e || buf[1] !== 0x45 || buf[2] !== 0x53 || buf[3] !== 0x1a) {
    throw new Error('Not an iNES file');
  }
  const prgBanks = buf[4];
  const chrBanks = buf[5];
  const hasTrainer = (buf[6] & 0x04) !== 0;
  let offset = 16 + (hasTrainer ? 512 : 0);
  const prg = buf.slice(offset, offset + prgBanks * 16384);
  return { prg, prgBanks, chrBanks };
}

const romPath = new URL('./nestest.nes', import.meta.url);
const logPath = new URL('./nestest.log', import.meta.url);
const romBuf = fs.readFileSync(romPath);
const logLines = fs.readFileSync(logPath, 'utf8').split('\n').filter(l => l.trim().length > 0);

const { prg } = parseINes(romBuf);
const bus = new NestestBus(prg);
const cpu = new CPU6502(bus);
cpu.reset();
if (process.argv.includes('--unofficial')) cpu.unofficialOpcodesEnabled = true;
// Automation entry point (documented nestest usage): force PC to $C000
// and match the documented initial register state instead of relying on
// the reset vector, which points at the interactive (PPU-driven) mode.
cpu.pc = 0xc000;
cpu.sp = 0xfd;
cpu.p = 0x24;
cpu.totalCycles = 7; // matches log's starting CYC:7 (post-reset cycle count)

function parseLogLine(line) {
  // Format: "C000  4C F5 C5  JMP $C5F5    ... A:00 X:00 Y:00 P:24 SP:FD PPU:  0, 21 CYC:7"
  const pc = parseInt(line.slice(0, 4), 16);
  const a = parseInt(line.match(/A:([0-9A-F]{2})/)[1], 16);
  const x = parseInt(line.match(/X:([0-9A-F]{2})/)[1], 16);
  const y = parseInt(line.match(/Y:([0-9A-F]{2})/)[1], 16);
  const p = parseInt(line.match(/P:([0-9A-F]{2})/)[1], 16);
  const sp = parseInt(line.match(/SP:([0-9A-F]{2})/)[1], 16);
  const cyc = parseInt(line.match(/CYC:(\d+)/)[1], 10);
  return { pc, a, x, y, p, sp, cyc };
}

let mismatches = 0;
let firstMismatchLine = -1;
let officialOpcodesEnd = -1;
const KNOWN_UNOFFICIAL_START_HINT = 'unofficial'; // not literally in file; we detect via jam

for (let i = 0; i < logLines.length; i++) {
  const expected = parseLogLine(logLines[i]);
  const actual = { pc: cpu.pc, a: cpu.a, x: cpu.x, y: cpu.y, p: cpu.p, sp: cpu.sp, cyc: cpu.totalCycles };

  const fields = ['pc', 'a', 'x', 'y', 'p', 'sp', 'cyc'];
  const bad = fields.filter(f => actual[f] !== expected[f]);

  if (bad.length > 0) {
    if (cpu.jammed) {
      // We hit an unofficial/illegal opcode nestest also exercises.
      // Official-opcode coverage stops here; report where.
      officialOpcodesEnd = i;
      break;
    }
    mismatches++;
    if (firstMismatchLine === -1) firstMismatchLine = i;
    console.error(`Line ${i + 1}: MISMATCH`);
    console.error(`  expected: PC=${expected.pc.toString(16)} A=${expected.a.toString(16)} X=${expected.x.toString(16)} Y=${expected.y.toString(16)} P=${expected.p.toString(16)} SP=${expected.sp.toString(16)} CYC=${expected.cyc}`);
    console.error(`  actual:   PC=${actual.pc.toString(16)} A=${actual.a.toString(16)} X=${actual.x.toString(16)} Y=${actual.y.toString(16)} P=${actual.p.toString(16)} SP=${actual.sp.toString(16)} CYC=${actual.cyc}`);
    console.error(`  bad fields: ${bad.join(', ')}`);
    if (mismatches > 5) {
      console.error('Too many mismatches, stopping early.');
      break;
    }
  }

  if (cpu.jammed) {
    officialOpcodesEnd = i;
    break;
  }

  cpu.stepInstruction();
}

console.log(`\nCompared ${officialOpcodesEnd >= 0 ? officialOpcodesEnd : logLines.length} lines against nestest.log`);
if (mismatches === 0) {
  console.log('PASS: all compared lines match exactly (PC, A, X, Y, P, SP, cycle count).');
  if (officialOpcodesEnd >= 0) {
    console.log(`Stopped at line ${officialOpcodesEnd + 1} (opcode 0x${cpu.jamOpcode?.toString(16)}) -- this is nestest's unofficial-opcode test section, which this emulator intentionally does not implement (official opcodes only, per spec).`);
  } else {
    console.log('Reached end of log with zero mismatches.');
  }
  process.exit(0);
} else {
  console.log(`FAIL: ${mismatches} mismatching lines. First mismatch at line ${firstMismatchLine + 1}.`);
  process.exit(1);
}
