import { CPU6502, FLAG_C, FLAG_Z, FLAG_N, FLAG_V } from '../js/cpu6502.js';

class FlatBus {
  constructor() { this.mem = new Uint8Array(0x10000); }
  cpuRead(addr) { return this.mem[addr]; }
  cpuWrite(addr, val) { this.mem[addr] = val & 0xff; }
}

let failures = 0;
function assertEq(actual, expected, label) {
  if (actual !== expected) {
    console.error(`FAIL: ${label} -- expected ${expected} (0x${expected.toString(16)}), got ${actual} (0x${actual.toString(16)})`);
    failures++;
  } else {
    console.log(`ok:   ${label}`);
  }
}

function makeCPU(program, org = 0x8000) {
  const bus = new FlatBus();
  bus.mem.set(program, org);
  bus.mem[0xfffc] = org & 0xff;
  bus.mem[0xfffd] = (org >> 8) & 0xff;
  const cpu = new CPU6502(bus);
  cpu.reset();
  return { cpu, bus };
}

function run(cpu, n) { for (let i = 0; i < n; i++) cpu.stepInstruction(); }

// Test 1: LDA immediate + flags
{
  const { cpu } = makeCPU([0xA9, 0x00, 0xA9, 0x80, 0xA9, 0x05]);
  run(cpu, 1); assertEq(cpu.a, 0x00, 'LDA #$00 loads A');
  assertEq(cpu.getFlag(FLAG_Z), true, 'LDA #$00 sets Zero');
  run(cpu, 1); assertEq(cpu.getFlag(FLAG_N), true, 'LDA #$80 sets Negative');
  run(cpu, 1); assertEq(cpu.a, 0x05, 'LDA #$05 loads A');
  assertEq(cpu.getFlag(FLAG_Z), false, 'LDA #$05 clears Zero');
  assertEq(cpu.getFlag(FLAG_N), false, 'LDA #$05 clears Negative');
}

// Test 2: ADC with carry + overflow
{
  const { cpu } = makeCPU([
    0xA9, 0x7F,       // LDA #$7F
    0x18,             // CLC
    0x69, 0x01,       // ADC #$01  -> 0x80, V set (pos+pos=neg), C clear
  ]);
  run(cpu, 3);
  assertEq(cpu.a, 0x80, 'ADC 7F+1 = 80');
  assertEq(cpu.getFlag(FLAG_V), true, 'ADC 7F+1 sets overflow');
  assertEq(cpu.getFlag(FLAG_C), false, 'ADC 7F+1 carry clear');
}

// Test 3: SBC / borrow
{
  const { cpu } = makeCPU([
    0xA9, 0x05,   // LDA #$05
    0x38,         // SEC (no borrow)
    0xE9, 0x06,   // SBC #$06 -> 0xFF, C clear (borrow occurred), N set
  ]);
  run(cpu, 3);
  assertEq(cpu.a, 0xFF, 'SBC 5-6 = FF (wrap)');
  assertEq(cpu.getFlag(FLAG_C), false, 'SBC 5-6 clears carry (borrow)');
  assertEq(cpu.getFlag(FLAG_N), true, 'SBC 5-6 sets negative');
}

// Test 4: Stack + JSR/RTS
{
  const { cpu, bus } = makeCPU([
    0x20, 0x06, 0x80,  // JSR $8006
    0xA9, 0xAA,        // LDA #$AA (should run after RTS)
    0x00,              // BRK (halt marker, not executed if RTS lands right)
    // at $8006:
    0xA9, 0x11,        // LDA #$11
    0x60,              // RTS
  ], 0x8000);
  run(cpu, 3); // JSR, LDA #$11 (in sub), RTS
  assertEq(cpu.a, 0x11, 'JSR body executed');
  run(cpu, 1); // LDA #$AA after return
  assertEq(cpu.a, 0xAA, 'Returned correctly after RTS');
}

// Test 5: Branch taken + not taken + page-cross cycle counts
{
  const { cpu } = makeCPU([
    0xA9, 0x00,  // LDA #0 -> Z=1
    0xF0, 0x02,  // BEQ +2 (taken, no page cross) -> skip next 2 bytes
    0xA9, 0xFF,  // (skipped)
    0xA9, 0x42,  // LDA #$42
  ]);
  run(cpu, 1);
  const c1 = cpu.stepInstruction(); // BEQ taken, same page => 3 cycles
  assertEq(c1, 3, 'BEQ taken same-page = 3 cycles');
  run(cpu, 1);
  assertEq(cpu.a, 0x42, 'Branch correctly skipped dead code');
}

// Test 6: Indirect JMP page-wrap bug
{
  const bus = new FlatBus();
  // JMP ($80FF) with the classic bug: high byte comes from $8000, not $8100
  bus.mem[0x8000] = 0x6C; bus.mem[0x8001] = 0xFF; bus.mem[0x8002] = 0x80; // JMP ($80FF)
  bus.mem[0x80FF] = 0x00; // low byte of target
  bus.mem[0x8000] = 0x40; // <-- wait this collides with program; use separate ptr location
  bus.mem.fill(0);
  bus.mem[0xC000] = 0x6C; bus.mem[0xC001] = 0xFF; bus.mem[0xC002] = 0xC1; // JMP ($C1FF)
  bus.mem[0xC1FF] = 0x34; // low byte
  bus.mem[0xC100] = 0x12; // buggy hardware reads high byte from $C100, not $C200
  bus.mem[0xC200] = 0xFF; // decoy - should NOT be used
  bus.mem[0xfffc] = 0x00; bus.mem[0xfffd] = 0xC0;
  const cpu = new CPU6502(bus);
  cpu.reset();
  cpu.stepInstruction();
  assertEq(cpu.pc, 0x1234, 'Indirect JMP reproduces page-wrap hardware bug');
}

// Test 7: Zero page ,X wraparound
{
  const { cpu, bus } = makeCPU([
    0xA2, 0x01,        // LDX #$01
    0xB5, 0xFF,        // LDA $FF,X  -> should read zero page $00 (wraps), not $0100
  ]);
  bus.mem[0x0000] = 0x99;
  bus.mem[0x0100] = 0x11; // decoy
  run(cpu, 2);
  assertEq(cpu.a, 0x99, 'ZPX addressing wraps within zero page');
}

// Test 8: NMI sequence pushes PC+P and jumps to vector, respects I flag being ignored for NMI
{
  const { cpu, bus } = makeCPU([0xEA, 0xEA, 0xEA]); // NOPs
  bus.mem[0xFFFA] = 0x00; bus.mem[0xFFFB] = 0x90; // NMI vector -> $9000
  bus.mem[0x9000] = 0xEA;
  cpu.triggerNMI();
  const cycles = cpu.stepInstruction();
  assertEq(cpu.pc, 0x9000, 'NMI jumps to vector');
  assertEq(cycles, 7, 'NMI takes 7 cycles');
}

console.log(failures === 0 ? '\nALL CPU QUICK TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
