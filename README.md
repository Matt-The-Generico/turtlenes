# TurtleNES

TurtleNES is a Nintendo Entertainment System (NES) emulator written from
scratch in vanilla HTML, CSS, and JavaScript. It runs entirely in the
browser with no server, no build step, and no dependencies -- open
`index.html` and go.

This is a real emulator: it parses actual `.nes` ROM files, executes the
Ricoh 2A03 (6502-derived) CPU instruction-by-instruction, generates video
by emulating the 2C02 PPU's scanline/dot timing, and generates audio from
an emulated APU. Nothing here fakes gameplay, hardcodes a screenshot, or
wraps an existing emulator core.

## Running it

1. Open `index.html` in a recent version of Chrome or Firefox.
2. Use **File > Open ROM...**, or drag and drop a `.nes` file onto the
   window.
3. Play with the keyboard (see Controls, below), or remap keys under
   **Input > Configure Controller 1...**.

TurtleNES does not include, distribute, or download any commercial ROM
files. You'll need to supply your own legally-obtained `.nes` files.
Public-domain and homebrew ROMs work great for testing -- this project's
own test suite uses `nestest.nes`, a widely-distributed public-domain CPU
test ROM, included under `tests/`.

## Controls (Controller 1 default mapping)

| NES button | Key          |
|------------|--------------|
| A          | Z            |
| B          | X            |
| Start      | Enter        |
| Select     | Shift        |
| D-Pad      | Arrow keys   |

Remap any of these under **Input > Configure Controller 1...**.

## Architecture

```
Emulator (js/emulator.js)
 |-- CPU6502 (js/cpu6502.js)      -- 6502 core, all official opcodes
 |-- PPU (js/ppu.js)              -- 2C02 picture processing unit
 |-- APU (js/apu.js)              -- 2A03 audio: pulse x2, triangle, noise, DMC
 |-- Bus (js/bus.js)              -- CPU memory map, OAM DMA
 |-- Cartridge (js/cartridge.js)  -- iNES/NES 2.0 header parsing
 |    `-- Mapper (js/mapper.js)   -- NROM, UxROM, CNROM, MMC1, MMC3
 |-- Controller (js/controller.js)
 `-- Debugger helpers (js/debugger.js)
```

The CPU never touches PPU/APU/cartridge memory directly -- everything
goes through the `Bus`, and the PPU never touches CHR/nametable-mirroring
logic directly -- everything cartridge-specific goes through the
`Mapper` interface. Adding a new mapper means adding one class to
`mapper.js` and registering it; no other file needs to change.

`main.js` is UI glue only: it owns the canvas, the Web Audio scheduling,
the retro window-chrome interactions, and the debugger/memory/pattern-
table/nametable viewer panels. It contains no emulation logic.

### Timing model

The system runs off a single master clock in `Emulator._clockOnce()`
that steps the PPU once per dot and the CPU once per **three** dots,
matching real NTSC NES timing (1 CPU cycle : 3 PPU dots). OAM DMA
correctly stalls the CPU for 513/514 cycles while continuing to clock
the PPU/APU. NMI (vblank) and mapper IRQs (MMC3's scanline counter) are
wired through the CPU's interrupt lines rather than being faked with a
timer.

## What's implemented

- **iNES / NES 2.0 header parsing**, PRG/CHR extraction, trainer
  handling, mapper/mirroring/battery detection, with clear errors for
  corrupt or truncated files.
- **Full official 6502 instruction set** (151 opcodes, all addressing
  modes), including the indirect-JMP page-wrap hardware bug, correct
  branch/page-crossing cycle penalties, and BRK/IRQ/NMI/RESET sequencing.
  Unofficial/illegal opcodes are intentionally not implemented; the CPU
  reports a clear "jammed" state with the offending opcode if one is
  ever executed, rather than guessing at undocumented behavior.
- **Mappers 0 (NROM), 1 (MMC1), 2 (UxROM), 3 (CNROM), 4 (MMC3)**,
  covering the large majority of licensed NES library titles.
- **PPU**: background rendering (nametables, attribute tables, pattern
  tables, palettes, fine-X/loopy-style scrolling), sprite rendering (8
  sprites/scanline with overflow flag, 8x8 and 8x16 sprites, horizontal/
  vertical flip, priority), sprite-zero hit, vblank + NMI generation, at
  scanline/dot granularity.
- **APU**: pulse x2 (with sweep and envelope), triangle (with linear
  counter), noise (with LFSR), DMC, and the frame sequencer (4-step and
  5-step modes, with IRQ). Audio is generated from the emulated channel
  state via the NES's standard non-linear mixing formulas and played
  back through the Web Audio API.
- **Controller** input with the correct serial shift-register read
  behavior, remappable keys, persisted to `localStorage`.
- **Battery-backed save RAM**, persisted per-ROM (keyed by ROM content
  hash, not filename) in IndexedDB, with a "clear save data" option.
- **Save states** (full CPU/PPU/WRAM/PRG-RAM snapshot) via
  File > Save State / Load State, stored in `localStorage`.
- **Debugger**: live CPU registers/flags, scrolling disassembly centered
  on PC, single-step, run/break/reset, PPU scanline/dot/frame counters.
- **Memory viewer**, **pattern table viewer** (with palette selection),
  and **nametable viewer**.
- Clear, specific error messages for invalid ROMs, unsupported mappers,
  and corrupt/truncated files -- the emulator never silently pretends a
  ROM works when it can't run it.

## What's NOT implemented / known limitations

- **Unofficial 6502 opcodes** are not implemented. A handful of NES
  games (and some test ROMs, including part of `nestest.nes` itself)
  rely on them; those will trigger the CPU's "jammed" state.
- **Mappers beyond 0/1/2/3/4** are not implemented. Loading a ROM with
  another mapper number produces a clear "Unsupported mapper: N" error
  rather than attempting to run it incorrectly.
- **MMC3 IRQ timing** uses a simplified, widely-used scanline-notify
  model (the mapper is told "a new scanline started while rendering was
  enabled") rather than a cycle-exact PPU-A12-rising-edge counter. This
  is correct for the overwhelming majority of MMC3 software but can
  differ from real hardware in some very timing-sensitive edge cases
  (e.g. certain split-screen effects).
- **Sprite overflow** uses a simplified count-based check rather than
  reproducing the real 2C02's diagonal-read hardware bug; no correctly-
  authored game depends on that bug's specific behavior, but a test ROM
  written specifically to probe it would not match real hardware.
- **Save states** capture CPU/PPU/WRAM/PRG-RAM and most mapper register
  state, but the mapper-state restoration is a generic best-effort copy
  rather than a hand-verified per-mapper snapshot; treat save states as
  a convenience feature rather than a guaranteed-perfect restore,
  especially for MMC1/MMC3 mid-bank-switch edge cases.
- **NES 2.0** headers are detected and mostly parsed (mapper number,
  submapper), but NES 2.0's extended PRG/CHR size encoding for unusually
  large ROMs is not fully implemented -- standard iNES sizing is used.
- Four-screen mirroring is recognized but relies on the mapper providing
  four independent 1KB nametable banks; this path is less exercised than
  horizontal/vertical mirroring.

## Testing

Automated tests live in `tests/` and are plain Node scripts (ES modules,
no test framework, no install step -- `node tests/<file>.mjs`):

- **`cpu_quicktest.mjs`** -- hand-written unit tests for individual CPU
  behaviors: flag handling, ADC/SBC overflow and borrow, stack/JSR/RTS,
  branch cycle counts, the indirect-JMP page-wrap bug, zero-page
  wraparound, and NMI sequencing.
- **`nestest_compare.mjs`** -- runs the CPU against `nestest.nes`, the
  widely-used golden-reference CPU test ROM, and compares every single
  instruction's PC/A/X/Y/P/SP/cycle-count against the canonical
  `nestest.log` trace. **This emulator matches all 5,004 official-opcode
  instructions in that log exactly**, then correctly stops at the first
  unofficial opcode the ROM exercises (which this emulator intentionally
  doesn't implement).
- **`mapper_quicktest.mjs`** -- verifies bank-switching arithmetic for
  UxROM, CNROM, MMC1, and MMC3 against synthetic cartridges with
  identifiable bank contents.
- **`integration_smoke.mjs`** -- loads a real ROM through the full
  `Emulator` (CPU+PPU+APU+Bus+Mapper together), runs 120 frames, and
  verifies correct CPU:PPU cycle ratios, no crashes, and a non-blank
  framebuffer.
- **`browser_smoke.cjs`** / **`browser_error_paths.cjs`** (Playwright) --
  load the actual `index.html` in headless Chromium, inject a ROM via
  the real file input, and verify the UI (canvas, status bar, debugger,
  pattern-table viewer, menus, error dialogs) all work with zero
  JavaScript errors, including the "unsupported mapper" and "invalid
  file" error paths producing the correct on-screen messages.

Run them all with:

```
node tests/cpu_quicktest.mjs
node tests/nestest_compare.mjs
node tests/mapper_quicktest.mjs
node tests/integration_smoke.mjs
```

(The two `browser_*.cjs` tests need Playwright and a local static server;
see the comments at the top of each file.)

## Future plans

- Additional mappers (7/AxROM, 9/MMC2, 11/Color Dreams, and others) as
  time permits, using the same drop-in `mapper.js` registry.
- A cycle-exact MMC3 IRQ counter (true PPU-A12 edge detection) for the
  small number of games that are sensitive to it.
- Unofficial-opcode support behind an explicit "compatibility mode"
  toggle, clearly labeled as emulating undocumented behavior.
- Rewind/scrubbing on top of the existing save-state snapshot format.
