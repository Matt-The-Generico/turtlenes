/**
 * cpu6502.js
 * Ricoh 2A03 CPU emulation (6502 core, no decimal mode arithmetic on NES).
 *
 * The CPU talks to the rest of the system exclusively through `this.bus`,
 * which must expose `read(addr) -> byte` and `write(addr, value)`.
 *
 * This implements the full official 6502 instruction set (151 opcodes),
 * all addressing modes, correct flag behavior, stack operations, branch
 * timing, page-crossing penalty cycles, BRK/IRQ/NMI/RESET sequences, and
 * the 6502's famous indirect-JMP page-boundary bug.
 *
 * Unofficial/illegal opcodes are NOT implemented (per spec: official set
 * only). Encountering one sets `this.jammed = true` and records the byte
 * so the debugger/UI can report it clearly instead of silently misbehaving.
 */

// Status flag bit masks
export const FLAG_C = 0x01; // Carry
export const FLAG_Z = 0x02; // Zero
export const FLAG_I = 0x04; // Interrupt disable
export const FLAG_D = 0x08; // Decimal (unused for arithmetic on NES, but bit exists)
export const FLAG_B = 0x10; // Break (only meaningful in byte pushed to stack)
export const FLAG_U = 0x20; // Unused, always 1
export const FLAG_V = 0x40; // Overflow
export const FLAG_N = 0x80; // Negative

const STACK_BASE = 0x0100;
const NMI_VECTOR = 0xfffa;
const RESET_VECTOR = 0xfffc;
const IRQ_VECTOR = 0xfffe;

export class CPU6502 {
  constructor(bus) {
    this.bus = bus;

    // Registers
    this.a = 0;
    this.x = 0;
    this.y = 0;
    this.sp = 0xfd;
    this.pc = 0x0000;
    this.p = FLAG_U | FLAG_I;

    // Scheduling
    this.cycles = 0;       // cycles remaining for current instruction
    this.totalCycles = 0;  // running total, for timing/debugger

    // Interrupt request lines (edge-triggered NMI, level-triggered IRQ)
    this.nmiPending = false;
    this.irqPending = false;

    // Debug/introspection state, updated at the start of each instruction
    this.jammed = false;
    this.jamOpcode = null;
    this.currentOpcode = 0x00;
    this.currentPC = 0x0000;
    this.currentMnemonic = '---';
    this.currentAddrMode = '';
    this.instructionCount = 0;
    this._extraCycles = 0;

    this._buildTable();
  }

  // ---- Bus helpers -------------------------------------------------
  read(addr) { return this.bus.cpuRead(addr & 0xffff); }
  write(addr, val) { this.bus.cpuWrite(addr & 0xffff, val & 0xff); }

  read16(addr) {
    const lo = this.read(addr);
    const hi = this.read((addr + 1) & 0xffff);
    return (hi << 8) | lo;
  }

  // Reproduces the 6502 indirect-addressing page-wrap hardware bug:
  // if the low byte of the pointer is 0xFF, the high byte is fetched
  // from the SAME page (wraps), not the next page.
  read16Bug(addr) {
    const lo = this.read(addr);
    const hiAddr = (addr & 0xff00) | ((addr + 1) & 0x00ff);
    const hi = this.read(hiAddr);
    return (hi << 8) | lo;
  }

  // ---- Flags ---------------------------------------------------------
  getFlag(mask) { return (this.p & mask) !== 0; }
  setFlag(mask, value) {
    if (value) this.p |= mask;
    else this.p &= ~mask;
  }
  setZN(value) {
    value &= 0xff;
    this.setFlag(FLAG_Z, value === 0);
    this.setFlag(FLAG_N, (value & 0x80) !== 0);
  }

  // ---- Stack -----------------------------------------------------------
  push(value) {
    this.write(STACK_BASE + this.sp, value & 0xff);
    this.sp = (this.sp - 1) & 0xff;
  }
  pop() {
    this.sp = (this.sp + 1) & 0xff;
    return this.read(STACK_BASE + this.sp);
  }
  push16(value) {
    this.push((value >> 8) & 0xff);
    this.push(value & 0xff);
  }
  pop16() {
    const lo = this.pop();
    const hi = this.pop();
    return (hi << 8) | lo;
  }

  // ---- Reset / Interrupts ---------------------------------------------
  reset() {
    this.a = 0;
    this.x = 0;
    this.y = 0;
    this.sp = 0xfd;
    this.p = FLAG_U | FLAG_I;
    this.pc = this.read16(RESET_VECTOR);
    this.cycles = 8;
    this.totalCycles = 0;
    this.jammed = false;
    this.jamOpcode = null;
    this.nmiPending = false;
    this.irqPending = false;
  }

  // Called by the PPU when it raises NMI (vblank start, if enabled).
  triggerNMI() {
    this.nmiPending = true;
  }
  // Level-triggered; mapper/APU assert/deassert this each cycle.
  setIRQLine(active) {
    this.irqPending = active;
  }

  // Note: these set `this.cycles` (the full cost, 7) but do NOT touch
  // `totalCycles` themselves -- both callers (the per-tick `clock()` and
  // the instant `stepInstruction()`) account for totalCycles uniformly
  // based on `this.cycles`, so the bookkeeping only happens in one place.
  _doNMI() {
    this.push16(this.pc);
    this.push((this.p | FLAG_U) & ~FLAG_B);
    this.setFlag(FLAG_I, true);
    this.pc = this.read16(NMI_VECTOR);
    this.cycles = 7;
    this.nmiPending = false;
  }
  _doIRQ() {
    this.push16(this.pc);
    this.push((this.p | FLAG_U) & ~FLAG_B);
    this.setFlag(FLAG_I, true);
    this.pc = this.read16(IRQ_VECTOR);
    this.cycles = 7;
  }

  /**
   * Advance the CPU by exactly one clock cycle. Instructions take several
   * cycles; we only decode/execute a new instruction when `cycles` hits 0,
   * but external callers (the emulator's master clock) still call this
   * once per CPU cycle so CPU and PPU/APU stay locked together.
   */
  clock() {
    if (this.cycles === 0) {
      if (this.jammed) {
        this.cycles = 1;
        this.totalCycles++;
        return;
      }
      if (this.nmiPending) {
        this._doNMI();
      } else if (this.irqPending && !this.getFlag(FLAG_I)) {
        this._doIRQ();
      }
      if (this.cycles === 0) {
        this._step();
      }
    }
    this.cycles--;
    this.totalCycles++;
  }

  // Executes exactly one full instruction immediately (used by the
  // debugger's "single step" and by CPU-only unit tests). Returns the
  // number of cycles it took.
  stepInstruction() {
    if (this.jammed) return 0;
    if (this.nmiPending) {
      this._doNMI();
      const used = this.cycles;
      this.totalCycles += used;
      this.cycles = 0;
      return used;
    }
    if (this.irqPending && !this.getFlag(FLAG_I)) {
      this._doIRQ();
      const used = this.cycles;
      this.totalCycles += used;
      this.cycles = 0;
      return used;
    }
    this.cycles = 0;
    this._step();
    const used = this.cycles;
    this.totalCycles += used;
    this.cycles = 0;
    return used;
  }

  _step() {
    this.currentPC = this.pc;
    const opcode = this.read(this.pc);
    this.currentOpcode = opcode;
    this.pc = (this.pc + 1) & 0xffff;

    const entry = this.table[opcode];
    if (!entry) {
      this.jammed = true;
      this.jamOpcode = opcode;
      this.currentMnemonic = 'JAM';
      this.currentAddrMode = '';
      this.cycles = 1;
      return;
    }

    this.currentMnemonic = entry.name;
    this.currentAddrMode = entry.mode;
    this.instructionCount++;

    const modeResult = entry.addr.call(this);
    const extraFromAddr = modeResult ? modeResult.pageCrossed : false;

    this._extraCycles = 0; // ops (branches) may add to this directly
    entry.op.call(this, modeResult);

    let total = entry.cycles;
    if (entry.pageCheck && extraFromAddr) total += 1;
    total += this._extraCycles;

    // Full cost of the instruction, in cycles. `clock()` (the tick-driven
    // path) decrements this by 1 on every call including this one, so an
    // N-cycle instruction occupies exactly N calls to clock(). The
    // instruction-stepping path (`stepInstruction`) reads this value
    // directly as the total cost, with no implicit extra decrement.
    this.cycles = total;
  }

  // ---- Addressing modes --------------------------------------------
  // Each returns { addr, pageCrossed } except IMP/ACC (return null) and
  // IMM (returns { addr: pc-of-operand }).
  amIMP() { return null; }
  amACC() { return null; }
  amIMM() {
    const addr = this.pc;
    this.pc = (this.pc + 1) & 0xffff;
    return { addr, pageCrossed: false };
  }
  amZP0() {
    const addr = this.read(this.pc) & 0xff;
    this.pc = (this.pc + 1) & 0xffff;
    return { addr, pageCrossed: false };
  }
  amZPX() {
    const addr = (this.read(this.pc) + this.x) & 0xff;
    this.pc = (this.pc + 1) & 0xffff;
    return { addr, pageCrossed: false };
  }
  amZPY() {
    const addr = (this.read(this.pc) + this.y) & 0xff;
    this.pc = (this.pc + 1) & 0xffff;
    return { addr, pageCrossed: false };
  }
  amABS() {
    const addr = this.read16(this.pc);
    this.pc = (this.pc + 2) & 0xffff;
    return { addr, pageCrossed: false };
  }
  amABX() {
    const base = this.read16(this.pc);
    this.pc = (this.pc + 2) & 0xffff;
    const addr = (base + this.x) & 0xffff;
    const pageCrossed = (base & 0xff00) !== (addr & 0xff00);
    return { addr, pageCrossed };
  }
  amABY() {
    const base = this.read16(this.pc);
    this.pc = (this.pc + 2) & 0xffff;
    const addr = (base + this.y) & 0xffff;
    const pageCrossed = (base & 0xff00) !== (addr & 0xff00);
    return { addr, pageCrossed };
  }
  amIND() {
    const ptr = this.read16(this.pc);
    this.pc = (this.pc + 2) & 0xffff;
    const addr = this.read16Bug(ptr);
    return { addr, pageCrossed: false };
  }
  amIZX() { // Indexed Indirect: (zp,X)
    const zp = (this.read(this.pc) + this.x) & 0xff;
    this.pc = (this.pc + 1) & 0xffff;
    const lo = this.read(zp);
    const hi = this.read((zp + 1) & 0xff);
    const addr = (hi << 8) | lo;
    return { addr, pageCrossed: false };
  }
  amIZY() { // Indirect Indexed: (zp),Y
    const zp = this.read(this.pc) & 0xff;
    this.pc = (this.pc + 1) & 0xffff;
    const lo = this.read(zp);
    const hi = this.read((zp + 1) & 0xff);
    const base = (hi << 8) | lo;
    const addr = (base + this.y) & 0xffff;
    const pageCrossed = (base & 0xff00) !== (addr & 0xff00);
    return { addr, pageCrossed };
  }
  amREL() {
    let offset = this.read(this.pc);
    this.pc = (this.pc + 1) & 0xffff;
    if (offset & 0x80) offset -= 0x100;
    const addr = (this.pc + offset) & 0xffff;
    return { addr, pageCrossed: (this.pc & 0xff00) !== (addr & 0xff00) };
  }

  _fetch(m) { return this.read(m.addr); }

  // ---- Opcodes -----------------------------------------------------
  // Load / store
  opLDA(m) { this.a = this._fetch(m); this.setZN(this.a); }
  opLDX(m) { this.x = this._fetch(m); this.setZN(this.x); }
  opLDY(m) { this.y = this._fetch(m); this.setZN(this.y); }
  opSTA(m) { this.write(m.addr, this.a); return false; }
  opSTX(m) { this.write(m.addr, this.x); return false; }
  opSTY(m) { this.write(m.addr, this.y); return false; }

  // Transfers
  opTAX() { this.x = this.a; this.setZN(this.x); }
  opTAY() { this.y = this.a; this.setZN(this.y); }
  opTXA() { this.a = this.x; this.setZN(this.a); }
  opTYA() { this.a = this.y; this.setZN(this.a); }
  opTSX() { this.x = this.sp; this.setZN(this.x); }
  opTXS() { this.sp = this.x; }

  // Stack
  opPHA() { this.push(this.a); }
  opPHP() { this.push(this.p | FLAG_B | FLAG_U); }
  opPLA() { this.a = this.pop(); this.setZN(this.a); }
  opPLP() { this.p = (this.pop() & ~FLAG_B) | FLAG_U; }

  // Arithmetic
  opADC(m) {
    const val = this._fetch(m);
    const carryIn = this.getFlag(FLAG_C) ? 1 : 0;
    const sum = this.a + val + carryIn;
    this.setFlag(FLAG_C, sum > 0xff);
    const result = sum & 0xff;
    this.setFlag(FLAG_V, (~(this.a ^ val) & (this.a ^ result) & 0x80) !== 0);
    this.a = result;
    this.setZN(this.a);
  }
  opSBC(m) {
    const val = this._fetch(m) ^ 0xff;
    const carryIn = this.getFlag(FLAG_C) ? 1 : 0;
    const sum = this.a + val + carryIn;
    this.setFlag(FLAG_C, sum > 0xff);
    const result = sum & 0xff;
    this.setFlag(FLAG_V, (~(this.a ^ val) & (this.a ^ result) & 0x80) !== 0);
    this.a = result;
    this.setZN(this.a);
  }
  opINC(m) { const v = (this._fetch(m) + 1) & 0xff; this.write(m.addr, v); this.setZN(v); }
  opDEC(m) { const v = (this._fetch(m) - 1) & 0xff; this.write(m.addr, v); this.setZN(v); }
  opINX() { this.x = (this.x + 1) & 0xff; this.setZN(this.x); }
  opINY() { this.y = (this.y + 1) & 0xff; this.setZN(this.y); }
  opDEX() { this.x = (this.x - 1) & 0xff; this.setZN(this.x); }
  opDEY() { this.y = (this.y - 1) & 0xff; this.setZN(this.y); }

  // Logic
  opAND(m) { this.a &= this._fetch(m); this.setZN(this.a); }
  opORA(m) { this.a |= this._fetch(m); this.setZN(this.a); }
  opEOR(m) { this.a ^= this._fetch(m); this.setZN(this.a); }
  opBIT(m) {
    const v = this._fetch(m);
    this.setFlag(FLAG_Z, (this.a & v) === 0);
    this.setFlag(FLAG_V, (v & 0x40) !== 0);
    this.setFlag(FLAG_N, (v & 0x80) !== 0);
  }

  // Shifts / rotates (operate on accumulator when mode === ACC)
  opASL(m) {
    if (m === null) {
      this.setFlag(FLAG_C, (this.a & 0x80) !== 0);
      this.a = (this.a << 1) & 0xff;
      this.setZN(this.a);
    } else {
      const v = this._fetch(m);
      this.setFlag(FLAG_C, (v & 0x80) !== 0);
      const r = (v << 1) & 0xff;
      this.write(m.addr, r);
      this.setZN(r);
    }
  }
  opLSR(m) {
    if (m === null) {
      this.setFlag(FLAG_C, (this.a & 0x01) !== 0);
      this.a = this.a >> 1;
      this.setZN(this.a);
    } else {
      const v = this._fetch(m);
      this.setFlag(FLAG_C, (v & 0x01) !== 0);
      const r = v >> 1;
      this.write(m.addr, r);
      this.setZN(r);
    }
  }
  opROL(m) {
    const carryIn = this.getFlag(FLAG_C) ? 1 : 0;
    if (m === null) {
      this.setFlag(FLAG_C, (this.a & 0x80) !== 0);
      this.a = ((this.a << 1) | carryIn) & 0xff;
      this.setZN(this.a);
    } else {
      const v = this._fetch(m);
      this.setFlag(FLAG_C, (v & 0x80) !== 0);
      const r = ((v << 1) | carryIn) & 0xff;
      this.write(m.addr, r);
      this.setZN(r);
    }
  }
  opROR(m) {
    const carryIn = this.getFlag(FLAG_C) ? 0x80 : 0;
    if (m === null) {
      this.setFlag(FLAG_C, (this.a & 0x01) !== 0);
      this.a = (this.a >> 1) | carryIn;
      this.setZN(this.a);
    } else {
      const v = this._fetch(m);
      this.setFlag(FLAG_C, (v & 0x01) !== 0);
      const r = (v >> 1) | carryIn;
      this.write(m.addr, r);
      this.setZN(r);
    }
  }

  // Compares
  _cmp(reg, val) {
    const r = (reg - val) & 0x1ff;
    this.setFlag(FLAG_C, reg >= val);
    this.setZN((reg - val) & 0xff);
  }
  opCMP(m) { this._cmp(this.a, this._fetch(m)); }
  opCPX(m) { this._cmp(this.x, this._fetch(m)); }
  opCPY(m) { this._cmp(this.y, this._fetch(m)); }

  // Branches. On the real 6502: +1 cycle if the branch is taken, and a
  // further +1 if that branch crosses a page boundary. We use a scratch
  // `_extraCycles` field (reset per-instruction in `_step`) so this adds
  // cleanly on top of the opcode's base cycle count instead of being
  // clobbered by `_step`'s final cycle assignment.
  opBCC(m) { this._branchTaken(!this.getFlag(FLAG_C), m); }
  opBCS(m) { this._branchTaken(this.getFlag(FLAG_C), m); }
  opBEQ(m) { this._branchTaken(this.getFlag(FLAG_Z), m); }
  opBNE(m) { this._branchTaken(!this.getFlag(FLAG_Z), m); }
  opBMI(m) { this._branchTaken(this.getFlag(FLAG_N), m); }
  opBPL(m) { this._branchTaken(!this.getFlag(FLAG_N), m); }
  opBVC(m) { this._branchTaken(!this.getFlag(FLAG_V), m); }
  opBVS(m) { this._branchTaken(this.getFlag(FLAG_V), m); }
  _branchTaken(cond, m) {
    if (!cond) return;
    const oldPage = this.pc & 0xff00;
    this.pc = m.addr;
    const newPage = this.pc & 0xff00;
    this._extraCycles += 1; // extra cycle for taken branch
    if (oldPage !== newPage) this._extraCycles += 1; // extra cycle for page cross
  }

  // Jumps / subroutines
  opJMP(m) { this.pc = m.addr; }
  opJSR(m) {
    this.push16((this.pc - 1) & 0xffff);
    this.pc = m.addr;
  }
  opRTS() { this.pc = (this.pop16() + 1) & 0xffff; }
  opRTI() {
    this.p = (this.pop() & ~FLAG_B) | FLAG_U;
    this.pc = this.pop16();
  }
  opBRK() {
    this.pc = (this.pc + 1) & 0xffff;
    this.push16(this.pc);
    this.push(this.p | FLAG_B | FLAG_U);
    this.setFlag(FLAG_I, true);
    this.pc = this.read16(IRQ_VECTOR);
  }

  // Flags
  opCLC() { this.setFlag(FLAG_C, false); }
  opSEC() { this.setFlag(FLAG_C, true); }
  opCLI() { this.setFlag(FLAG_I, false); }
  opSEI() { this.setFlag(FLAG_I, true); }
  opCLD() { this.setFlag(FLAG_D, false); }
  opSED() { this.setFlag(FLAG_D, true); }
  opCLV() { this.setFlag(FLAG_V, false); }

  opNOP() {}

  // ---- Opcode table --------------------------------------------------
  _buildTable() {
    const T = new Array(256).fill(null);
    // name, addr mode fn, mode label, op fn, base cycles, pageCheck(bool: add 1 if page crossed)
    const def = (op, addr, mode, name, cyc, pageCheck = false) => {
      T[op] = { addr, mode, name, op: this[name.startsWith('op') ? name : 'op' + name] || null, cycles: cyc, pageCheck };
    };
    // Helper binds using method references
    const IMP = this.amIMP, ACC = this.amACC, IMM = this.amIMM, ZP0 = this.amZP0,
      ZPX = this.amZPX, ZPY = this.amZPY, ABS = this.amABS, ABX = this.amABX,
      ABY = this.amABY, IND = this.amIND, IZX = this.amIZX, IZY = this.amIZY, REL = this.amREL;

    const entry = (opcode, mnemonic, addrFn, addrLabel, cycles, pageCheck, opFn) => {
      T[opcode] = { name: mnemonic, addr: addrFn, mode: addrLabel, op: opFn, cycles, pageCheck };
    };

    // LDA
    entry(0xA9,'LDA',IMM,'IMM',2,false,this.opLDA); entry(0xA5,'LDA',ZP0,'ZP0',3,false,this.opLDA);
    entry(0xB5,'LDA',ZPX,'ZPX',4,false,this.opLDA); entry(0xAD,'LDA',ABS,'ABS',4,false,this.opLDA);
    entry(0xBD,'LDA',ABX,'ABX',4,true,this.opLDA); entry(0xB9,'LDA',ABY,'ABY',4,true,this.opLDA);
    entry(0xA1,'LDA',IZX,'IZX',6,false,this.opLDA); entry(0xB1,'LDA',IZY,'IZY',5,true,this.opLDA);
    // LDX
    entry(0xA2,'LDX',IMM,'IMM',2,false,this.opLDX); entry(0xA6,'LDX',ZP0,'ZP0',3,false,this.opLDX);
    entry(0xB6,'LDX',ZPY,'ZPY',4,false,this.opLDX); entry(0xAE,'LDX',ABS,'ABS',4,false,this.opLDX);
    entry(0xBE,'LDX',ABY,'ABY',4,true,this.opLDX);
    // LDY
    entry(0xA0,'LDY',IMM,'IMM',2,false,this.opLDY); entry(0xA4,'LDY',ZP0,'ZP0',3,false,this.opLDY);
    entry(0xB4,'LDY',ZPX,'ZPX',4,false,this.opLDY); entry(0xAC,'LDY',ABS,'ABS',4,false,this.opLDY);
    entry(0xBC,'LDY',ABX,'ABX',4,true,this.opLDY);
    // STA
    entry(0x85,'STA',ZP0,'ZP0',3,false,this.opSTA); entry(0x95,'STA',ZPX,'ZPX',4,false,this.opSTA);
    entry(0x8D,'STA',ABS,'ABS',4,false,this.opSTA); entry(0x9D,'STA',ABX,'ABX',5,false,this.opSTA);
    entry(0x99,'STA',ABY,'ABY',5,false,this.opSTA); entry(0x81,'STA',IZX,'IZX',6,false,this.opSTA);
    entry(0x91,'STA',IZY,'IZY',6,false,this.opSTA);
    // STX / STY
    entry(0x86,'STX',ZP0,'ZP0',3,false,this.opSTX); entry(0x96,'STX',ZPY,'ZPY',4,false,this.opSTX);
    entry(0x8E,'STX',ABS,'ABS',4,false,this.opSTX);
    entry(0x84,'STY',ZP0,'ZP0',3,false,this.opSTY); entry(0x94,'STY',ZPX,'ZPX',4,false,this.opSTY);
    entry(0x8C,'STY',ABS,'ABS',4,false,this.opSTY);
    // Transfers
    entry(0xAA,'TAX',IMP,'IMP',2,false,this.opTAX); entry(0xA8,'TAY',IMP,'IMP',2,false,this.opTAY);
    entry(0x8A,'TXA',IMP,'IMP',2,false,this.opTXA); entry(0x98,'TYA',IMP,'IMP',2,false,this.opTYA);
    entry(0xBA,'TSX',IMP,'IMP',2,false,this.opTSX); entry(0x9A,'TXS',IMP,'IMP',2,false,this.opTXS);
    // Stack
    entry(0x48,'PHA',IMP,'IMP',3,false,this.opPHA); entry(0x08,'PHP',IMP,'IMP',3,false,this.opPHP);
    entry(0x68,'PLA',IMP,'IMP',4,false,this.opPLA); entry(0x28,'PLP',IMP,'IMP',4,false,this.opPLP);
    // ADC/SBC
    entry(0x69,'ADC',IMM,'IMM',2,false,this.opADC); entry(0x65,'ADC',ZP0,'ZP0',3,false,this.opADC);
    entry(0x75,'ADC',ZPX,'ZPX',4,false,this.opADC); entry(0x6D,'ADC',ABS,'ABS',4,false,this.opADC);
    entry(0x7D,'ADC',ABX,'ABX',4,true,this.opADC); entry(0x79,'ADC',ABY,'ABY',4,true,this.opADC);
    entry(0x61,'ADC',IZX,'IZX',6,false,this.opADC); entry(0x71,'ADC',IZY,'IZY',5,true,this.opADC);
    entry(0xE9,'SBC',IMM,'IMM',2,false,this.opSBC); entry(0xE5,'SBC',ZP0,'ZP0',3,false,this.opSBC);
    entry(0xF5,'SBC',ZPX,'ZPX',4,false,this.opSBC); entry(0xED,'SBC',ABS,'ABS',4,false,this.opSBC);
    entry(0xFD,'SBC',ABX,'ABX',4,true,this.opSBC); entry(0xF9,'SBC',ABY,'ABY',4,true,this.opSBC);
    entry(0xE1,'SBC',IZX,'IZX',6,false,this.opSBC); entry(0xF1,'SBC',IZY,'IZY',5,true,this.opSBC);
    // INC/DEC
    entry(0xE6,'INC',ZP0,'ZP0',5,false,this.opINC); entry(0xF6,'INC',ZPX,'ZPX',6,false,this.opINC);
    entry(0xEE,'INC',ABS,'ABS',6,false,this.opINC); entry(0xFE,'INC',ABX,'ABX',7,false,this.opINC);
    entry(0xC6,'DEC',ZP0,'ZP0',5,false,this.opDEC); entry(0xD6,'DEC',ZPX,'ZPX',6,false,this.opDEC);
    entry(0xCE,'DEC',ABS,'ABS',6,false,this.opDEC); entry(0xDE,'DEC',ABX,'ABX',7,false,this.opDEC);
    entry(0xE8,'INX',IMP,'IMP',2,false,this.opINX); entry(0xC8,'INY',IMP,'IMP',2,false,this.opINY);
    entry(0xCA,'DEX',IMP,'IMP',2,false,this.opDEX); entry(0x88,'DEY',IMP,'IMP',2,false,this.opDEY);
    // Logic
    entry(0x29,'AND',IMM,'IMM',2,false,this.opAND); entry(0x25,'AND',ZP0,'ZP0',3,false,this.opAND);
    entry(0x35,'AND',ZPX,'ZPX',4,false,this.opAND); entry(0x2D,'AND',ABS,'ABS',4,false,this.opAND);
    entry(0x3D,'AND',ABX,'ABX',4,true,this.opAND); entry(0x39,'AND',ABY,'ABY',4,true,this.opAND);
    entry(0x21,'AND',IZX,'IZX',6,false,this.opAND); entry(0x31,'AND',IZY,'IZY',5,true,this.opAND);
    entry(0x09,'ORA',IMM,'IMM',2,false,this.opORA); entry(0x05,'ORA',ZP0,'ZP0',3,false,this.opORA);
    entry(0x15,'ORA',ZPX,'ZPX',4,false,this.opORA); entry(0x0D,'ORA',ABS,'ABS',4,false,this.opORA);
    entry(0x1D,'ORA',ABX,'ABX',4,true,this.opORA); entry(0x19,'ORA',ABY,'ABY',4,true,this.opORA);
    entry(0x01,'ORA',IZX,'IZX',6,false,this.opORA); entry(0x11,'ORA',IZY,'IZY',5,true,this.opORA);
    entry(0x49,'EOR',IMM,'IMM',2,false,this.opEOR); entry(0x45,'EOR',ZP0,'ZP0',3,false,this.opEOR);
    entry(0x55,'EOR',ZPX,'ZPX',4,false,this.opEOR); entry(0x4D,'EOR',ABS,'ABS',4,false,this.opEOR);
    entry(0x5D,'EOR',ABX,'ABX',4,true,this.opEOR); entry(0x59,'EOR',ABY,'ABY',4,true,this.opEOR);
    entry(0x41,'EOR',IZX,'IZX',6,false,this.opEOR); entry(0x51,'EOR',IZY,'IZY',5,true,this.opEOR);
    entry(0x24,'BIT',ZP0,'ZP0',3,false,this.opBIT); entry(0x2C,'BIT',ABS,'ABS',4,false,this.opBIT);
    // Shifts
    entry(0x0A,'ASL',ACC,'ACC',2,false,this.opASL); entry(0x06,'ASL',ZP0,'ZP0',5,false,this.opASL);
    entry(0x16,'ASL',ZPX,'ZPX',6,false,this.opASL); entry(0x0E,'ASL',ABS,'ABS',6,false,this.opASL);
    entry(0x1E,'ASL',ABX,'ABX',7,false,this.opASL);
    entry(0x4A,'LSR',ACC,'ACC',2,false,this.opLSR); entry(0x46,'LSR',ZP0,'ZP0',5,false,this.opLSR);
    entry(0x56,'LSR',ZPX,'ZPX',6,false,this.opLSR); entry(0x4E,'LSR',ABS,'ABS',6,false,this.opLSR);
    entry(0x5E,'LSR',ABX,'ABX',7,false,this.opLSR);
    entry(0x2A,'ROL',ACC,'ACC',2,false,this.opROL); entry(0x26,'ROL',ZP0,'ZP0',5,false,this.opROL);
    entry(0x36,'ROL',ZPX,'ZPX',6,false,this.opROL); entry(0x2E,'ROL',ABS,'ABS',6,false,this.opROL);
    entry(0x3E,'ROL',ABX,'ABX',7,false,this.opROL);
    entry(0x6A,'ROR',ACC,'ACC',2,false,this.opROR); entry(0x66,'ROR',ZP0,'ZP0',5,false,this.opROR);
    entry(0x76,'ROR',ZPX,'ZPX',6,false,this.opROR); entry(0x6E,'ROR',ABS,'ABS',6,false,this.opROR);
    entry(0x7E,'ROR',ABX,'ABX',7,false,this.opROR);
    // Compares
    entry(0xC9,'CMP',IMM,'IMM',2,false,this.opCMP); entry(0xC5,'CMP',ZP0,'ZP0',3,false,this.opCMP);
    entry(0xD5,'CMP',ZPX,'ZPX',4,false,this.opCMP); entry(0xCD,'CMP',ABS,'ABS',4,false,this.opCMP);
    entry(0xDD,'CMP',ABX,'ABX',4,true,this.opCMP); entry(0xD9,'CMP',ABY,'ABY',4,true,this.opCMP);
    entry(0xC1,'CMP',IZX,'IZX',6,false,this.opCMP); entry(0xD1,'CMP',IZY,'IZY',5,true,this.opCMP);
    entry(0xE0,'CPX',IMM,'IMM',2,false,this.opCPX); entry(0xE4,'CPX',ZP0,'ZP0',3,false,this.opCPX);
    entry(0xEC,'CPX',ABS,'ABS',4,false,this.opCPX);
    entry(0xC0,'CPY',IMM,'IMM',2,false,this.opCPY); entry(0xC4,'CPY',ZP0,'ZP0',3,false,this.opCPY);
    entry(0xCC,'CPY',ABS,'ABS',4,false,this.opCPY);
    // Branches (all REL, base 2 cycles; extra handled in _branchTaken via this.cycles)
    entry(0x90,'BCC',REL,'REL',2,false,this.opBCC); entry(0xB0,'BCS',REL,'REL',2,false,this.opBCS);
    entry(0xF0,'BEQ',REL,'REL',2,false,this.opBEQ); entry(0xD0,'BNE',REL,'REL',2,false,this.opBNE);
    entry(0x30,'BMI',REL,'REL',2,false,this.opBMI); entry(0x10,'BPL',REL,'REL',2,false,this.opBPL);
    entry(0x50,'BVC',REL,'REL',2,false,this.opBVC); entry(0x70,'BVS',REL,'REL',2,false,this.opBVS);
    // Jumps
    entry(0x4C,'JMP',ABS,'ABS',3,false,this.opJMP); entry(0x6C,'JMP',IND,'IND',5,false,this.opJMP);
    entry(0x20,'JSR',ABS,'ABS',6,false,this.opJSR); entry(0x60,'RTS',IMP,'IMP',6,false,this.opRTS);
    entry(0x40,'RTI',IMP,'IMP',6,false,this.opRTI); entry(0x00,'BRK',IMP,'IMP',7,false,this.opBRK);
    // Flags
    entry(0x18,'CLC',IMP,'IMP',2,false,this.opCLC); entry(0x38,'SEC',IMP,'IMP',2,false,this.opSEC);
    entry(0x58,'CLI',IMP,'IMP',2,false,this.opCLI); entry(0x78,'SEI',IMP,'IMP',2,false,this.opSEI);
    entry(0xD8,'CLD',IMP,'IMP',2,false,this.opCLD); entry(0xF8,'SED',IMP,'IMP',2,false,this.opSED);
    entry(0xB8,'CLV',IMP,'IMP',2,false,this.opCLV);
    // NOP
    entry(0xEA,'NOP',IMP,'IMP',2,false,this.opNOP);

    this.table = T;
  }

  // ---- Disassembly (for the debugger UI) ------------------------------
  disassembleAt(addr) {
    const opcode = this.read(addr);
    const entry = this.table[opcode];
    if (!entry) return { text: `$${addr.toString(16).padStart(4,'0').toUpperCase()}  ??? (${opcode.toString(16)})`, length: 1 };
    let len = 1;
    let operandText = '';
    switch (entry.mode) {
      case 'IMP': case 'ACC': len = 1; operandText = entry.mode === 'ACC' ? 'A' : ''; break;
      case 'IMM': len = 2; operandText = `#$${this.read(addr+1).toString(16).padStart(2,'0')}`; break;
      case 'ZP0': len = 2; operandText = `$${this.read(addr+1).toString(16).padStart(2,'0')}`; break;
      case 'ZPX': len = 2; operandText = `$${this.read(addr+1).toString(16).padStart(2,'0')},X`; break;
      case 'ZPY': len = 2; operandText = `$${this.read(addr+1).toString(16).padStart(2,'0')},Y`; break;
      case 'ABS': len = 3; operandText = `$${this.read16(addr+1).toString(16).padStart(4,'0')}`; break;
      case 'ABX': len = 3; operandText = `$${this.read16(addr+1).toString(16).padStart(4,'0')},X`; break;
      case 'ABY': len = 3; operandText = `$${this.read16(addr+1).toString(16).padStart(4,'0')},Y`; break;
      case 'IND': len = 3; operandText = `($${this.read16(addr+1).toString(16).padStart(4,'0')})`; break;
      case 'IZX': len = 2; operandText = `($${this.read(addr+1).toString(16).padStart(2,'0')},X)`; break;
      case 'IZY': len = 2; operandText = `($${this.read(addr+1).toString(16).padStart(2,'0')}),Y`; break;
      case 'REL': {
        len = 2;
        let off = this.read(addr+1);
        if (off & 0x80) off -= 0x100;
        const target = (addr + 2 + off) & 0xffff;
        operandText = `$${target.toString(16).padStart(4,'0')}`;
        break;
      }
    }
    const text = `${addr.toString(16).padStart(4,'0').toUpperCase()}  ${entry.name} ${operandText}`.trimEnd();
    return { text, length: len, mnemonic: entry.name, mode: entry.mode };
  }
}
