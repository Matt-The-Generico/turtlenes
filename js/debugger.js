/**
 * debugger.js
 * Formatting helpers for the debugger UI panel: a disassembly window
 * around the current PC, a hex memory viewer, and register snapshots.
 * Pure functions/helpers only -- no emulation logic lives here.
 */

export function hex(n, digits) {
  return n.toString(16).toUpperCase().padStart(digits, '0');
}

export function disassembleRange(cpu, centerAddr, countBefore, countAfter) {
  // Walk backward from a safe point to find `countBefore` instruction
  // boundaries before centerAddr. Since 6502 instructions are variable
  // length, we can't reverse-disassemble exactly -- we approximate by
  // scanning forward from up to 3*countBefore bytes earlier and taking
  // the last `countBefore` instructions found before centerAddr. This is
  // the same practical approach real 6502 disassemblers use.
  const scanStart = Math.max(0, centerAddr - countBefore * 3);
  const lines = [];
  let addr = scanStart;
  const preLines = [];
  while (addr < centerAddr && addr <= 0xffff) {
    const d = cpu.disassembleAt(addr);
    preLines.push({ addr, ...d });
    addr += d.length;
  }
  const before = preLines.slice(-countBefore);

  let cur = centerAddr;
  const atAndAfter = [];
  for (let i = 0; i <= countAfter; i++) {
    if (cur > 0xffff) break;
    const d = cpu.disassembleAt(cur);
    atAndAfter.push({ addr: cur, ...d });
    cur += d.length;
  }

  return { before, current: atAndAfter[0], after: atAndAfter.slice(1) };
}

export function registerSnapshot(cpu) {
  return {
    A: hex(cpu.a, 2), X: hex(cpu.x, 2), Y: hex(cpu.y, 2),
    SP: hex(cpu.sp, 2), PC: hex(cpu.pc, 4), P: hex(cpu.p, 2),
    flags: {
      N: (cpu.p & 0x80) !== 0, V: (cpu.p & 0x40) !== 0, U: true,
      B: (cpu.p & 0x10) !== 0, D: (cpu.p & 0x08) !== 0, I: (cpu.p & 0x04) !== 0,
      Z: (cpu.p & 0x02) !== 0, C: (cpu.p & 0x01) !== 0,
    },
    cycles: cpu.totalCycles,
    instructionCount: cpu.instructionCount,
  };
}

export function memoryPage(readFn, pageBase, rows = 16, cols = 16) {
  const lines = [];
  for (let r = 0; r < rows; r++) {
    const rowAddr = pageBase + r * cols;
    const bytes = [];
    for (let c = 0; c < cols; c++) bytes.push(readFn((rowAddr + c) & 0xffff));
    lines.push({ addr: rowAddr & 0xffff, bytes });
  }
  return lines;
}
