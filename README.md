# TurtleNES v1.1

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

1. Open `index.html` in a recent version of Chrome or Firefox (locally,
   or via the deployed website).
2. Use **File > Open ROM...**, or drag and drop a `.nes` file onto the
   window.
3. Play with the keyboard (see Controls, below), or remap keys under
   **Input > Configure Controller 1 / 2...**.

TurtleNES does not include, distribute, or download any commercial ROM
files. You'll need to supply your own legally-obtained `.nes` files.
Public-domain and homebrew ROMs work great for testing -- this project's
own test suite uses `nestest.nes`, a widely-distributed public-domain CPU
test ROM, included under `tests/`.

Full in-app documentation (controls, save states, cheats, filters, and
so on) is available from **Help > Documentation**, which opens
`docs.html` -- written for the deployed website, not assuming you have
the repository checked out locally.

## What's new in v1.1

- **Input display**: a toggleable window (Input > Input Display, or the
  "Pads" toolbar button) showing both controllers' buttons live, reading
  directly from the real controller objects.
- **Fixed controller configuration bug**: the configuration dialog now
  shows each controller's *actual* current bindings (it previously only
  showed/edited Player 1, even from the "Configure Controller 2" menu
  item). Both players' bindings are now genuinely independent, shown
  correctly, and take effect immediately.
- **One audio control**: "Enable Audio" and "Mute" were confusing and
  redundant; there is now a single "Mute Audio" toggle whose state is
  obvious in both the menu and the status bar.
- **Save/load feedback**: saving, loading, deleting, and overwriting a
  state now show a status-bar message and a brief on-screen note, and
  the status bar keeps a timestamp of the current save slot.
- **Real save-state files**: File > Export Save State... downloads a
  `.tnesstate` file; File > Import Save State... (or dropping such a
  file on the window) loads one back. States are tied to the ROM's
  content hash and refused with a clear error if they belong to a
  different game. The normal Save State (F5) / Load State (F7) actions
  remain instant, in-memory operations and never open a file picker.
- **Fullscreen, fixed and expanded**: the picture is now always centered
  (previously it could appear pinned to the top-left corner). Four
  fullscreen modes are available: Normal, Square (whole-pixel scaling),
  Keep Aspect Ratio (letterboxed/pillarboxed), and Fill Screen.
- **Three more mappers**: AxROM (7), MMC2 (9, Punch-Out!!'s CHR-latch
  mapper), and Color Dreams (11).
- **Cycle-exact-model MMC3 IRQ**: the IRQ counter is now clocked from a
  real PPU-A12 rising-edge detector (driven by the actual pattern-table
  fetch addresses the PPU issues) instead of a once-per-scanline
  approximation, improving compatibility with games that use
  mid-scanline CHR-bank tricks for split-screen effects.
- **Unofficial 6502 opcodes**, behind an explicit compatibility setting
  (Emulation > CPU Compatibility...): "Official opcodes only" (default,
  matches v1.0 behavior exactly) or "Enable undocumented opcodes".
- **Rewind**: hold Backspace (or the Rewind toolbar button) to step
  backward through recent gameplay, built on periodic lightweight
  snapshots with a bounded, configurable history length.
- **Speed controls**: 0.5x / 1x / 2x / 4x / custom (0.1x-10x), which
  genuinely change how much emulated time runs per real second (not a
  visual stretch). Audio is switched off away from 1x rather than
  producing pitched/glitchy sound.
- **Cheats**: simple RAM-patch cheats (`AAAA:VV`, optionally
  `AAAA:VV?CC`), addable/removable/toggleable per game, never modifying
  the ROM itself.
- **Video filters**: Nearest (default), Linear, Scanlines, and CRT,
  selectable from Video > Filter.
- **Open Recent**: remembers the last 10 ROMs opened, with mapper and
  time. Where the browser supports the File System Access API
  (Chromium-based browsers), it can reopen the actual file; otherwise it
  honestly asks you to re-select it rather than pretending it can.

## Controls (defaults)

| NES button | Player 1     | Player 2 |
|------------|--------------|----------|
| A          | Z            | O        |
| B          | X            | U        |
| Start      | Enter        | M        |
| Select     | Shift        | N        |
| D-Pad      | Arrow keys   | I/K/J/L  |

Remap any of these under **Input > Configure Controller 1 / 2...**; the
dialog always reflects the bindings actually in effect.

## Architecture

```
Emulator (js/emulator.js)
 |-- CPU6502 (js/cpu6502.js)      -- 6502 core: official + optional unofficial opcodes
 |-- PPU (js/ppu.js)              -- 2C02 picture processing unit
 |-- APU (js/apu.js)              -- 2A03 audio: pulse x2, triangle, noise, DMC
 |-- Bus (js/bus.js)              -- CPU memory map, OAM DMA
 |-- Cartridge (js/cartridge.js)  -- iNES/NES 2.0 header parsing
 |    `-- Mapper (js/mapper.js)   -- NROM, MMC1, UxROM, CNROM, MMC3, AxROM, MMC2, Color Dreams
 |-- Controller (js/controller.js)
 `-- Debugger helpers (js/debugger.js)
```

The CPU never touches PPU/APU/cartridge memory directly -- everything
goes through the `Bus`, and the PPU never touches CHR/nametable-mirroring
logic directly -- everything cartridge-specific goes through the
`Mapper` interface. Adding a new mapper means adding one class to
`mapper.js` and registering it in `MAPPER_REGISTRY`; no other file needs
to change.

`main.js` is UI glue only: it owns the canvas, the Web Audio scheduling,
the retro window-chrome interactions, and the debugger/memory/pattern-
table/nametable viewer panels, plus the v1.1 additions (input display,
save-state files, rewind, speed, cheats, filters, recent ROMs). It
contains no emulation logic -- every one of those features reads and
writes the same `Emulator`/`Controller`/`CPU6502` objects the game
itself runs on, never a separate parallel copy of the state.

### Timing model

The system runs off a single master clock in `Emulator._clockOnce()`
that steps the PPU once per dot and the CPU once per **three** dots,
matching real NTSC NES timing (1 CPU cycle : 3 PPU dots). OAM DMA
correctly stalls the CPU for 513/514 cycles while continuing to clock
the PPU/APU. NMI (vblank) and mapper IRQs are wired through the CPU's
interrupt lines rather than being faked with a timer.

MMC3's IRQ counter is clocked by `ppu.js`'s `_fetchPatternByte`, which
tracks the PPU address bus's bit 12 (A12) across every real pattern-table
fetch (background and sprite) and calls the mapper's `notifyA12Rise()`
on a low-to-high transition -- the same signal real MMC3 hardware uses,
rather than a fixed once-per-scanline check.

The UI's frame loop (`main.js`) scales how much emulated time runs per
real second according to the selected speed; the `Emulator` itself has
no notion of "speed" beyond running whole NES frames on request.

## What's implemented

- **iNES / NES 2.0 header parsing**, PRG/CHR extraction, trainer
  handling, mapper/mirroring/battery detection, with clear errors for
  corrupt or truncated files.
- **Full official 6502 instruction set** (151 opcodes, all addressing
  modes), including the indirect-JMP page-wrap hardware bug, correct
  branch/page-crossing cycle penalties, and BRK/IRQ/NMI/RESET sequencing.
- **Optional unofficial/undocumented opcodes** (LAX, SAX, DCP, ISC, SLO,
  RLA, SRE, RRA, ANC, ALR, ARR, AXS, the duplicate SBC, and the various
  undocumented NOP forms), off by default, toggleable in
  Emulation > CPU Compatibility.
- **Mappers 0 (NROM), 1 (MMC1), 2 (UxROM), 3 (CNROM), 4 (MMC3), 7
  (AxROM), 9 (MMC2), 11 (Color Dreams)**.
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
- **Controller** input for two players with correct serial shift-register
  read behavior, independently remappable keys, persisted to
  `localStorage`, and a live input display for both controllers.
- **Battery-backed save RAM**, persisted per-ROM (keyed by ROM content
  hash, not filename) in IndexedDB, with a "clear save data" option.
- **Save states**: instant in-memory quick-slot (Save/Load/Delete) plus
  file-based export/import (`.tnesstate`), both built on one shared,
  extensible serialization format covering CPU, RAM, PPU (registers,
  VRAM/OAM/palette), APU, mapper, PRG RAM, CHR RAM, and controller state.
- **Rewind**, built on the same snapshot format, with a bounded ring
  buffer and a scrubbable timeline.
- **Speed control** (0.5x-10x) that changes real emulation throughput.
- **A simple RAM-patch cheat system**.
- **Debugger**: live CPU registers/flags, scrolling disassembly centered
  on PC, single-step, run/break/reset, PPU scanline/dot/frame counters.
- **Memory viewer**, **pattern table viewer** (with palette selection),
  and **nametable viewer**.
- **Four video filters** (Nearest, Linear, Scanlines, CRT) and **four
  fullscreen modes** (Normal, Square, Keep Aspect Ratio, Fill Screen),
  all correctly centered.
- **Open Recent** ROMs list, using the File System Access API for real
  re-opening where the browser supports it, with an honest fallback
  prompt where it doesn't.
- Clear, specific error messages for invalid ROMs, unsupported mappers
  (listing exactly which mappers *are* supported), and corrupt/truncated
  files -- the emulator never silently pretends a ROM works when it can't
  run it.

## What's NOT implemented / known limitations

- **Mappers beyond the eight listed above** are not implemented. Loading
  a ROM with another mapper number produces a clear "Unsupported mapper:
  N" error rather than attempting to run it incorrectly.
- **MMC3 IRQ** uses real A12-edge detection for the actual pattern-table
  fetches the PPU performs, which correctly handles the standard
  "BG table = $0000, sprite table = $1000" convention and mid-scanline
  CHR-table swaps for split-screen effects. It does not model A12
  changes from CPU-driven `$2007` VRAM pokes (a rare trick a handful of
  demos/test ROMs use to manually clock the counter), and it has no
  artificial minimum-low-time filter, since this codebase's PPU never
  routes nametable/attribute fetches through the same path pattern-table
  fetches use (the source of the "noise" that filter exists to reject on
  real hardware).
- **Sprite overflow** uses a simplified count-based check rather than
  reproducing the real 2C02's diagonal-read hardware bug; no correctly-
  authored game depends on that bug's specific behavior, but a test ROM
  written specifically to probe it would not match real hardware.
- **NES 2.0** headers are detected and mostly parsed (mapper number,
  submapper), but NES 2.0's extended PRG/CHR size encoding for unusually
  large ROMs is not fully implemented -- standard iNES sizing is used.
- Four-screen mirroring is recognized but relies on the mapper providing
  four independent 1KB nametable banks; this path is less exercised than
  horizontal/vertical mirroring.
- **Cheats** support only simple RAM-patch codes (`AAAA:VV[?CC]`), not
  Game Genie or Pro Action Replay code formats.
- **Rewind** memory usage scales with history length and PRG-RAM size;
  very long histories on large-PRG-RAM games use correspondingly more
  browser memory. The in-app Rewind window shows the current buffer's
  approximate memory footprint.
- **Open Recent** file re-access depends on the File System Access API
  (Chromium-based browsers); other browsers fall back to asking the user
  to re-select the file, since there is no way to reopen an arbitrary
  local file without it.

## Testing

Automated tests live in `tests/` and are plain Node scripts (ES modules
or CommonJS for the Playwright ones, no test framework, no install step
beyond Node itself):

- **`cpu_quicktest.mjs`** -- hand-written unit tests for individual CPU
  behaviors: flag handling, ADC/SBC overflow and borrow, stack/JSR/RTS,
  branch cycle counts, the indirect-JMP page-wrap bug, zero-page
  wraparound, and NMI sequencing.
- **`nestest_compare.mjs`** -- runs the CPU against `nestest.nes`, the
  widely-used golden-reference CPU test ROM, and compares every single
  instruction's PC/A/X/Y/P/SP/cycle-count against the canonical
  `nestest.log` trace. With official opcodes only (the default), this
  emulator matches all 5,004 official-opcode instructions in that log
  exactly, then correctly stops at the first unofficial opcode. Run with
  `--unofficial` to enable undocumented-opcode support first: with that
  flag, **all 8,991 lines of the complete log match exactly**, covering
  the unofficial opcodes too.
- **`mapper_quicktest.mjs`** -- verifies bank-switching arithmetic for
  every supported mapper (NROM implicitly via the others' base class,
  UxROM, CNROM, MMC1, MMC3, AxROM, MMC2's latch-driven CHR switching, and
  Color Dreams) against synthetic cartridges with identifiable bank
  contents.
- **`mmc3_irq_test.mjs`** -- regression tests for MMC3's IRQ counter: the
  reload/decrement/fire/acknowledge logic in isolation, and a full-system
  integration test that builds a tiny synthetic MMC3 ROM, runs it through
  the complete emulator with real rendering enabled, and confirms the
  A12-edge-driven IRQ actually reaches the CPU and jumps to the handler.
- **`savestate_test.mjs`** -- the full save/export/import round trip
  (start a ROM, save, change state, export, change state again, import,
  confirm the emulator returns to the original state and then continues
  to run identically to a reference instance that never diverged),
  immediate-restore accuracy of CPU/PPU fields, wrong-ROM and corrupt-file
  rejection, mapper-state (MMC3 registers/IRQ settings) round-tripping,
  rewind buffer growth/bounding/seeking, and the cheat system.
- **`integration_smoke.mjs`** -- loads a real ROM through the full
  `Emulator` (CPU+PPU+APU+Bus+Mapper together), runs 120 frames, and
  verifies correct CPU:PPU cycle ratios, no crashes, and a non-blank
  framebuffer.
- **`browser_v11.cjs`** (Playwright) -- the primary v1.1 browser test:
  loads the actual `index.html` in headless Chromium and exercises, on
  the real UI, every new feature -- both controllers' input and live
  display, the configuration-dialog bug fix, the single mute control
  (with real Web Audio scheduling verified via an instrumented
  `createBufferSource`), save/load/delete/overwrite status messages,
  file export/import (including a real browser download and a real file
  input), wrong-ROM and corrupt-file rejection, the Recent ROMs menu,
  all four video filters' actual CSS effects, all four speed settings'
  actual frame-rate impact (measured, not assumed) and audio muting,
  rewind, cheats (including RAM writes and address validation), the CPU
  compatibility toggle, and all four fullscreen modes' actual on-screen
  geometry (confirming the picture is centered and not pinned to the
  corner). It also re-checks that the unsupported-mapper error dialog
  still works and now lists the new mappers, and that Help > Documentation
  opens an appropriately deployed-site-friendly page. Finishes by
  asserting there were zero console/page errors during the entire run.
- **`browser_smoke.cjs`** / **`browser_error_paths.cjs`** (Playwright,
  carried over from v1.0) -- baseline UI smoke test and error-path
  checks, re-run against the v1.1 build to confirm no regressions.

Run the non-browser tests with:

```
node tests/cpu_quicktest.mjs
node tests/nestest_compare.mjs
node tests/nestest_compare.mjs --unofficial
node tests/mapper_quicktest.mjs
node tests/mmc3_irq_test.mjs
node tests/savestate_test.mjs
node tests/integration_smoke.mjs
```

The Playwright tests need a local static server and a Chromium binary;
see the comment at the top of `browser_v11.cjs`.

## Future plans

- Additional mappers (5/MMC5, 10/MMC4, 71, and others) as time permits,
  using the same drop-in `mapper.js` registry.
- Modeling A12 changes from CPU-driven `$2007` pokes, for the small
  number of demos/test ROMs that rely on it for MMC3 IRQ timing.
- Game Genie code support for the cheat system.
- A configurable rewind hotkey and an on-screen rewind indicator bar.
