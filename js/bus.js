/**
 * bus.js
 * The NES CPU memory bus. Implements the memory map:
 *
 *   $0000-$07FF  2KB internal RAM
 *   $0800-$1FFF  RAM mirrors (repeats every $0800)
 *   $2000-$2007  PPU registers
 *   $2008-$3FFF  PPU register mirrors (repeats every 8 bytes)
 *   $4000-$4013  APU registers
 *   $4014        OAM DMA
 *   $4015        APU status
 *   $4016-$4017  Controller ports
 *   $4018-$401F  APU/IO test registers (disabled on retail hardware)
 *   $4020-$FFFF  Cartridge space (handled by the mapper)
 *
 * The CPU never touches RAM/PPU/APU/cartridge directly -- everything
 * goes through `cpuRead`/`cpuWrite` here.
 */

export class Bus {
  constructor() {
    this.ram = new Uint8Array(0x0800);
    this.ppu = null;
    this.apu = null;
    this.mapper = null;
    this.controller1 = null;
    this.controller2 = null;
    this.cpu = null; // set post-construction (for OAM DMA cycle stalling)

    this.dmaStallCyclesRemaining = 0; // CPU is suspended for 513/514 cycles during OAM DMA
  }

  cpuRead(addr) {
    addr &= 0xffff;
    if (addr < 0x2000) {
      return this.ram[addr & 0x07ff];
    }
    if (addr < 0x4000) {
      return this.ppu.cpuRead(0x2000 + (addr & 0x0007));
    }
    if (addr === 0x4015) {
      return this.apu.readStatus();
    }
    if (addr === 0x4016) {
      return this.controller1 ? this.controller1.read() : 0;
    }
    if (addr === 0x4017) {
      return this.controller2 ? this.controller2.read() : 0;
    }
    if (addr < 0x4018) {
      return 0; // other APU regs are write-only
    }
    if (addr < 0x4020) {
      return 0; // disabled test mode registers
    }
    // Cartridge space
    return this.mapper ? this.mapper.cpuRead(addr) : 0;
  }

  cpuWrite(addr, val) {
    addr &= 0xffff;
    val &= 0xff;
    if (addr < 0x2000) {
      this.ram[addr & 0x07ff] = val;
      return;
    }
    if (addr < 0x4000) {
      this.ppu.cpuWrite(0x2000 + (addr & 0x0007), val);
      return;
    }
    if (addr === 0x4014) {
      const oddCycle = this.cpu ? (this.cpu.totalCycles & 1) !== 0 : false;
      this._startOamDma(val, oddCycle);
      return;
    }
    if (addr === 0x4016) {
      // Writing bit 0 = 1 then 0 latches both controllers' button states
      if (this.controller1) this.controller1.write(val);
      if (this.controller2) this.controller2.write(val);
      return;
    }
    if (addr === 0x4017) {
      this.apu.writeFrameCounter(val);
      return;
    }
    if (addr < 0x4018) {
      this.apu.writeRegister(addr, val);
      return;
    }
    if (addr < 0x4020) {
      return; // disabled test registers
    }
    if (this.mapper) this.mapper.cpuWrite(addr, val);
  }

  // The 256-byte transfer itself has no CPU-visible side effects other
  // than its timing cost, so we perform the copy immediately and simply
  // charge the CPU the correct number of stalled cycles (513, or 514 if
  // triggered on an odd CPU cycle) via `dmaStallCyclesRemaining`. The
  // emulator's master clock checks this each cycle and, while positive,
  // clocks the PPU/APU but not the CPU -- matching real DMA behavior for
  // every case software actually depends on.
  _startOamDma(page, cpuOnOddCycle) {
    const base = page << 8;
    const startAddr = this.ppu.oamAddr;
    for (let i = 0; i < 256; i++) {
      const val = this.cpuRead((base + i) & 0xffff);
      this.ppu.oam[(startAddr + i) & 0xff] = val;
    }
    this.dmaStallCyclesRemaining = cpuOnOddCycle ? 514 : 513;
  }
}
