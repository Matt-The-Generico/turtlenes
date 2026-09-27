import { Emulator } from './emulator.js';
import { RomLoadError } from './cartridge.js';
import { BUTTONS } from './controller.js';
import { disassembleRange, registerSnapshot, memoryPage, hex } from './debugger.js';

const emu = new Emulator();
window.__turtlenes = emu; // exposed for console debugging / power users

// ---------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const canvas = $('screen');
const ctx = canvas.getContext('2d');
const imageData = ctx.createImageData(256, 240);
const noRomScreen = $('no-rom-screen');
const screenWrap = $('screen-wrap');
const statusRom = $('status-rom');
const statusMapper = $('status-mapper');
const statusFps = $('status-fps');
const statusSpeed = $('status-speed');
const fileInput = $('file-input');

let scale = 2;
let integerScaling = true;
let audioEnabled = true;
let muted = false;
let volume = 0.7;

// ---------------------------------------------------------------------
// Key mapping (remappable). Persisted to localStorage.
// ---------------------------------------------------------------------
const DEFAULT_KEYMAP_P1 = {
  KeyZ: 'A', KeyX: 'B', Enter: 'Start', ShiftLeft: 'Select', ShiftRight: 'Select',
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
};
const DEFAULT_KEYMAP_P2 = {};

function loadKeymap() {
  try {
    const stored = JSON.parse(localStorage.getItem('turtlenes-keymap-p1') || 'null');
    return stored || { ...DEFAULT_KEYMAP_P1 };
  } catch { return { ...DEFAULT_KEYMAP_P1 }; }
}
let keymapP1 = loadKeymap();

function saveKeymap() {
  localStorage.setItem('turtlenes-keymap-p1', JSON.stringify(keymapP1));
}

window.addEventListener('keydown', (e) => {
  if (awaitingKeyForButton) {
    e.preventDefault();
    keymapP1[e.code] = awaitingKeyForButton;
    saveKeymap();
    awaitingKeyForButton = null;
    renderInputConfigTable();
    return;
  }
  const btn = keymapP1[e.code];
  if (btn) { emu.controller1.setButton(btn, true); e.preventDefault(); }
  handleGlobalShortcut(e);
});
window.addEventListener('keyup', (e) => {
  const btn = keymapP1[e.code];
  if (btn) { emu.controller1.setButton(btn, false); e.preventDefault(); }
});

function handleGlobalShortcut(e) {
  switch (e.code) {
    case 'F1': e.preventDefault(); doAction('run'); break;
    case 'F2': e.preventDefault(); doAction('pause'); break;
    case 'F3': e.preventDefault(); doAction('reset'); break;
    case 'F4': e.preventDefault(); doAction('frame-advance'); break;
    case 'F5': e.preventDefault(); doAction('save-state'); break;
    case 'F7': e.preventDefault(); doAction('load-state'); break;
    case 'F9': e.preventDefault(); doAction('open-debugger'); break;
    case 'F11': e.preventDefault(); doAction('fullscreen'); break;
  }
}

// ---------------------------------------------------------------------
// ROM loading (file input + drag & drop)
// ---------------------------------------------------------------------
async function loadFile(file) {
  try {
    const buf = await file.arrayBuffer();
    const info = emu.loadRom(buf, file.name);
    onRomLoaded(info);
  } catch (e) {
    if (e instanceof RomLoadError) {
      showError(e.message);
    } else {
      showError(`Unexpected error while loading ROM:\n${e.message}`);
      console.error(e);
    }
  }
}

function onRomLoaded(info) {
  noRomScreen.style.display = 'none';
  screenWrap.style.display = '';
  statusRom.textContent = info.filename;
  statusMapper.textContent = `Mapper ${String(info.mapperNumber).padStart(3, '0')} (${info.mapperName})`;
  populateRomInfoDialog(info);
  emu.play();
  applyScale();
}

function populateRomInfoDialog(info) {
  $('info-filename').textContent = info.filename;
  $('info-format').textContent = info.format;
  $('info-mapper').textContent = `${String(info.mapperNumber).padStart(3, '0')} (${info.mapperName})`;
  $('info-prg').textContent = `${info.prgKB} KB`;
  $('info-chr').textContent = info.chrIsRam ? 'None (CHR RAM)' : `${info.chrKB} KB`;
  $('info-mirroring').textContent = info.mirroring;
  $('info-battery').textContent = info.battery ? 'Yes' : 'No';
  $('info-trainer').textContent = info.trainer ? 'Yes' : 'No';
}

fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) loadFile(fileInput.files[0]);
});
$('btn-open-rom-big').addEventListener('click', () => fileInput.click());

['dragenter', 'dragover'].forEach(evt => {
  document.body.addEventListener(evt, (e) => { e.preventDefault(); });
});
document.body.addEventListener('drop', (e) => {
  e.preventDefault();
  const file = e.dataTransfer.files && e.dataTransfer.files[0];
  if (file && file.name.toLowerCase().endsWith('.nes')) loadFile(file);
  else if (file) showError('Only .nes ROM files are supported.');
});

// ---------------------------------------------------------------------
// Error / dialog plumbing
// ---------------------------------------------------------------------
function showError(message) {
  $('error-message').textContent = message;
  openDialog('dlg-error');
}
const dialogsVisible = { debugger: false };
function openDialog(id) {
  $(id).style.display = 'block';
  if (id === 'dlg-debugger') dialogsVisible.debugger = true;
}
function closeDialog(id) {
  $(id).style.display = 'none';
  if (id === 'dlg-debugger') dialogsVisible.debugger = false;
}

document.querySelectorAll('[data-close]').forEach(el => {
  el.addEventListener('click', () => closeDialog(el.getAttribute('data-close')));
});

// ---------------------------------------------------------------------
// Menu bar
// ---------------------------------------------------------------------
const menuItems = document.querySelectorAll('.menu-item');
let openMenu = null;
menuItems.forEach(item => {
  item.addEventListener('click', (e) => {
    e.stopPropagation();
    const name = item.getAttribute('data-menu');
    const dropdown = $('menu-' + name);
    if (openMenu === name) { closeAllMenus(); return; }
    closeAllMenus();
    const rect = item.getBoundingClientRect();
    dropdown.style.left = rect.left + 'px';
    dropdown.style.top = rect.bottom + 'px';
    dropdown.classList.add('visible');
    item.classList.add('open');
    openMenu = name;
  });
});
function closeAllMenus() {
  document.querySelectorAll('.dropdown').forEach(d => d.classList.remove('visible'));
  document.querySelectorAll('.menu-item').forEach(m => m.classList.remove('open'));
  openMenu = null;
}
document.body.addEventListener('click', closeAllMenus);

document.querySelectorAll('.dropdown-item[data-action]').forEach(el => {
  el.addEventListener('click', (e) => {
    e.stopPropagation();
    if (el.classList.contains('disabled')) return;
    doAction(el.getAttribute('data-action'), el);
    closeAllMenus();
  });
});

function toggleCheckbox(el) {
  const checked = el.getAttribute('data-checked') === '1';
  el.setAttribute('data-checked', checked ? '0' : '1');
  el.querySelector('.chk').style.visibility = checked ? 'hidden' : 'visible';
  return !checked;
}

function doAction(action, el) {
  switch (action) {
    case 'open-rom': fileInput.click(); break;
    case 'close-rom': emu.unloadRom(); noRomScreen.style.display = ''; screenWrap.style.display = 'none';
      statusRom.textContent = 'No ROM loaded'; statusMapper.textContent = ''; break;
    case 'save-state': doSaveState(); break;
    case 'load-state': doLoadState(); break;
    case 'clear-sram': emu.clearBatterySave(); break;
    case 'exit': showError('TurtleNES runs entirely in your browser tab. Close the tab to exit.'); break;

    case 'run': emu.play(); break;
    case 'pause': emu.pause(); break;
    case 'reset': emu.reset(); break;
    case 'stop': emu.pause(); emu.reset(); break;
    case 'frame-advance': emu.play(); emu.runFrame(); emu.pause(); renderFrame(); break;

    case 'scale-1': setScale(1); break;
    case 'scale-2': setScale(2); break;
    case 'scale-3': setScale(3); break;
    case 'scale-4': setScale(4); break;
    case 'fullscreen': toggleFullscreen(); break;
    case 'toggle-integer-scaling': integerScaling = toggleCheckbox(el); applyScale(); break;

    case 'toggle-audio': audioEnabled = toggleCheckbox(el); break;
    case 'toggle-mute': muted = toggleCheckbox(el); break;

    case 'configure-p1': openInputConfig(); break;
    case 'configure-p2': openInputConfig(); break;

    case 'open-debugger': openDialog('dlg-debugger'); refreshDebugger(); break;
    case 'open-memviewer': openDialog('dlg-memviewer'); refreshMemViewer(); break;
    case 'open-ppuviewer': openDialog('dlg-patterntables'); refreshPatternTables(); break;
    case 'open-patterntables': openDialog('dlg-patterntables'); refreshPatternTables(); break;
    case 'open-nametables': openDialog('dlg-nametables'); refreshNametables(); break;
    case 'open-disasm': openDialog('dlg-debugger'); refreshDebugger(); break;

    case 'open-about': openDialog('dlg-about'); break;
    case 'open-docs': showError('TurtleNES documentation:\n\nType "/README.md" up there in the URL bar to see more information.'); break;
    case 'open-tutorial': showError('Quick start:\n\n1. File > Open ROM...\n2. Select a .nes file\n3. Use Z/X/Enter/Shift/Arrows to play\n4. Tools > Debugger for developer info'); break;
  }
}

$('btn-about-close').addEventListener('click', () => openDialog('dlg-about'));
$('tb-run').addEventListener('click', () => doAction('run'));
$('tb-pause').addEventListener('click', () => doAction('pause'));
$('tb-stop').addEventListener('click', () => doAction('stop'));
$('tb-reset').addEventListener('click', () => doAction('reset'));
$('tb-fullscreen').addEventListener('click', () => doAction('fullscreen'));
document.querySelectorAll('.scale-btn').forEach(b => {
  b.addEventListener('click', () => setScale(parseInt(b.getAttribute('data-scale'), 10)));
});
$('volume-slider').addEventListener('input', (e) => { volume = e.target.value / 100; });

// ---------------------------------------------------------------------
// Video scaling / fullscreen
// ---------------------------------------------------------------------
function setScale(s) { scale = s; applyScale(); }
function applyScale() {
  canvas.style.width = (256 * scale) + 'px';
  canvas.style.height = (240 * scale) + 'px';
}
function toggleFullscreen() {
  if (!document.fullscreenElement) {
    screenWrap.requestFullscreen?.().catch(() => {});
  } else {
    document.exitFullscreen?.();
  }
}
applyScale();

// ---------------------------------------------------------------------
// Save states (localStorage, keyed per-ROM content hash)
// ---------------------------------------------------------------------
function doSaveState() {
  if (!emu.loaded) return;
  const state = emu.saveState();
  try {
    localStorage.setItem('turtlenes-savestate-' + emu.romKey, JSON.stringify(state));
  } catch (e) {
    showError('Could not save state (browser storage may be full).');
  }
}
function doLoadState() {
  if (!emu.loaded) return;
  try {
    const raw = localStorage.getItem('turtlenes-savestate-' + emu.romKey);
    if (!raw) { showError('No save state found for this ROM.'); return; }
    const state = JSON.parse(raw);
    const ok = emu.loadState(state);
    if (!ok) showError('Save state could not be loaded (it may be for a different ROM).');
  } catch (e) {
    showError('Could not load state:\n' + e.message);
  }
}

// ---------------------------------------------------------------------
// Audio (Web Audio API), fed genuinely from APU-generated samples
// ---------------------------------------------------------------------
let audioCtx = null;
let nextStartTime = 0;
function ensureAudioContext() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    nextStartTime = audioCtx.currentTime;
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}
document.body.addEventListener('click', () => { if (audioEnabled) ensureAudioContext(); }, { once: true });

emu.audioSampleCallback = (samples) => {
  if (!audioEnabled || muted || samples.length === 0) return;
  const ac = ensureAudioContext();
  const buffer = ac.createBuffer(1, samples.length, emu.apu.sampleRate);
  buffer.copyToChannel(samples, 0);
  const src = ac.createBufferSource();
  src.buffer = buffer;
  const gain = ac.createGain();
  gain.gain.value = volume;
  src.connect(gain).connect(ac.destination);
  const now = ac.currentTime;
  if (nextStartTime < now) nextStartTime = now + 0.02; // resync if we fell behind
  src.start(nextStartTime);
  nextStartTime += buffer.duration;
};

// ---------------------------------------------------------------------
// Main timing loop: real NTSC NES runs at ~60.0988 fps. We drive frames
// with requestAnimationFrame and an accumulator so emulation speed stays
// correct even if the display refresh rate isn't exactly 60Hz.
// ---------------------------------------------------------------------
const NES_FPS = 60.0988;
const FRAME_MS = 1000 / NES_FPS;
let lastTime = performance.now();
let accumulator = 0;
let fpsCounter = 0;
let fpsTimer = 0;
let lastFps = 0;

function tick(now) {
  const delta = now - lastTime;
  lastTime = now;
  accumulator += delta;
  fpsTimer += delta;

  let framesRun = 0;
  while (accumulator >= FRAME_MS && framesRun < 4) { // cap catch-up to avoid death spiral
    if (emu.running) {
      emu.runFrame();
      framesRun++;
      fpsCounter++;
    } else {
      accumulator = 0;
      break;
    }
    accumulator -= FRAME_MS;
  }
  if (framesRun > 0) renderFrame();

  if (fpsTimer >= 1000) {
    lastFps = fpsCounter;
    fpsCounter = 0;
    fpsTimer = 0;
    updateStatusBar();
  }

  if (dialogsVisible.debugger) refreshDebugger();

  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

function renderFrame() {
  imageData.data.set(emu.ppu.framebuffer);
  ctx.putImageData(imageData, 0, 0);
}

function updateStatusBar() {
  if (!emu.loaded) { statusFps.textContent = ''; statusSpeed.textContent = ''; return; }
  statusFps.textContent = lastFps.toFixed ? `${lastFps} FPS` : '';
  const pct = emu.running ? Math.round((lastFps / NES_FPS) * 100) : 0;
  statusSpeed.textContent = emu.running ? `${pct}%` : 'Paused';
}

// ---------------------------------------------------------------------
// Debugger panel
// ---------------------------------------------------------------------
$('dbg-step').addEventListener('click', () => { emu.pause(); emu.stepInstruction(); refreshDebugger(); renderFrame(); });
$('dbg-run').addEventListener('click', () => { emu.play(); });
$('dbg-break').addEventListener('click', () => { emu.pause(); refreshDebugger(); });
$('dbg-reset').addEventListener('click', () => { emu.reset(); refreshDebugger(); });

function refreshDebugger() {
  if (!emu.loaded) return;
  const snap = registerSnapshot(emu.cpu);
  $('reg-a').textContent = snap.A;
  $('reg-x').textContent = snap.X;
  $('reg-y').textContent = snap.Y;
  $('reg-sp').textContent = snap.SP;
  $('reg-pc').textContent = snap.PC;
  $('reg-p').textContent = snap.P;
  $('dbg-cycles').textContent = snap.cycles;
  $('ppu-scanline').textContent = emu.ppu.scanline;
  $('ppu-dot').textContent = emu.ppu.dot;
  $('ppu-frame').textContent = emu.ppu.frameCount;

  const flagsRow = $('flags-row');
  flagsRow.innerHTML = '';
  const order = ['N', 'V', 'U', 'B', 'D', 'I', 'Z', 'C'];
  order.forEach(f => {
    const span = document.createElement('span');
    span.className = 'flag-chip' + (snap.flags[f] ? ' set' : '');
    span.textContent = f;
    flagsRow.appendChild(span);
  });

  const { before, current, after } = disassembleRange(emu.cpu, emu.cpu.pc, 8, 10);
  const list = $('disasm-list');
  list.innerHTML = '';
  before.forEach(l => appendDisasmLine(list, l, false));
  if (current) appendDisasmLine(list, current, true);
  after.forEach(l => appendDisasmLine(list, l, false));
}
function appendDisasmLine(list, l, isCurrent) {
  const div = document.createElement('div');
  div.className = 'disasm-line' + (isCurrent ? ' current' : '');
  div.textContent = l.text;
  list.appendChild(div);
}

// ---------------------------------------------------------------------
// Memory viewer
// ---------------------------------------------------------------------
$('mem-goto').addEventListener('click', refreshMemViewer);
function refreshMemViewer() {
  if (!emu.loaded) { $('mem-view').textContent = 'No ROM loaded.'; return; }
  const pageStr = $('mem-page-input').value.trim();
  const base = (parseInt(pageStr, 16) || 0) & 0xfff0;
  const lines = memoryPage((a) => emu.bus.cpuRead(a), base, 16, 16);
  let out = '';
  lines.forEach(row => {
    out += hex(row.addr, 4) + '  ' + row.bytes.map(b => hex(b, 2)).join(' ') + '\n';
  });
  $('mem-view').textContent = out;
}

// ---------------------------------------------------------------------
// Pattern table viewer
// ---------------------------------------------------------------------
let ptSelectedPalette = 0;
function refreshPatternTables() {
  if (!emu.loaded) return;
  const paletteHolder = $('pt-palette-select');
  paletteHolder.innerHTML = '';
  for (let p = 0; p < 8; p++) {
    const sw = document.createElement('span');
    sw.className = 'pal-swatch' + (p === ptSelectedPalette ? ' selected' : '');
    const colorIdx = emu.ppu.paletteRam[(p << 2)] & 0x3f;
    sw.title = 'Palette ' + p;
    sw.addEventListener('click', () => { ptSelectedPalette = p; refreshPatternTables(); });
    paletteHolder.appendChild(sw);
  }
  drawPatternTable(0, $('pt-canvas-0'));
  drawPatternTable(1, $('pt-canvas-1'));
}
function drawPatternTable(half, canvasEl) {
  const cctx = canvasEl.getContext('2d');
  const img = cctx.createImageData(128, 128);
  const base = half * 0x1000;
  for (let tileY = 0; tileY < 16; tileY++) {
    for (let tileX = 0; tileX < 16; tileX++) {
      const tileAddr = base + (tileY * 16 + tileX) * 16;
      for (let row = 0; row < 8; row++) {
        const lo = emu.mapper ? emu.mapper.ppuRead(tileAddr + row) : 0;
        const hi = emu.mapper ? emu.mapper.ppuRead(tileAddr + row + 8) : 0;
        for (let col = 0; col < 8; col++) {
          const bit = 7 - col;
          const pixel = (((hi >> bit) & 1) << 1) | ((lo >> bit) & 1);
          const idx = emu.ppu.paletteRam[emu.ppu._paletteIndex(0x3f00 + (ptSelectedPalette << 2) + pixel)] & 0x3f;
          const rgb = NES_PALETTE_RGB(idx);
          const px = tileX * 8 + col;
          const py = tileY * 8 + row;
          const off = (py * 128 + px) * 4;
          img.data[off] = rgb[0]; img.data[off + 1] = rgb[1]; img.data[off + 2] = rgb[2]; img.data[off + 3] = 255;
        }
      }
    }
  }
  cctx.putImageData(img, 0, 0);
}
// Small standalone copy of the palette table for the viewer (kept in sync
// conceptually with ppu.js's NES_PALETTE; duplicated here since the PPU
// module doesn't export its internal table).
const NES_PALETTE_TABLE = [
  0x626262,0x001fb2,0x2404c8,0x5200b2,0x730076,0x800024,0x730b00,0x522800,
  0x244400,0x005700,0x005c00,0x005324,0x003c76,0x000000,0x000000,0x000000,
  0xababab,0x0d57ff,0x4b30ff,0x8a13ff,0xbc08d6,0xd21269,0xc72e00,0x9d5400,
  0x607b00,0x209800,0x00a300,0x009942,0x007db4,0x000000,0x000000,0x000000,
  0xffffff,0x53aeff,0x9085ff,0xd365ff,0xff57ff,0xff5dcf,0xff7757,0xf1a300,
  0xbdc700,0x7fe300,0x51ef1e,0x40e88f,0x43d9ec,0x4e4e4e,0x000000,0x000000,
  0xffffff,0xb6e1ff,0xcecfff,0xe7c3ff,0xffbdff,0xffbde5,0xffcdb9,0xf4dfa5,
  0xe0f2a0,0xc8f7ab,0xb6f7c8,0xacf3e8,0xace6ff,0xb8b8b8,0x000000,0x000000,
];
function NES_PALETTE_RGB(idx) {
  const rgb = NES_PALETTE_TABLE[idx & 0x3f];
  return [(rgb >> 16) & 0xff, (rgb >> 8) & 0xff, rgb & 0xff];
}

// ---------------------------------------------------------------------
// Nametable viewer
// ---------------------------------------------------------------------
function refreshNametables() {
  if (!emu.loaded) return;
  const canvasEl = $('nt-canvas');
  const cctx = canvasEl.getContext('2d');
  const img = cctx.createImageData(512, 480);
  for (let ntIndex = 0; ntIndex < 4; ntIndex++) {
    const originX = (ntIndex % 2) * 256;
    const originY = Math.floor(ntIndex / 2) * 240;
    const nt = emu.ppu.nametables[ntIndex];
    for (let ty = 0; ty < 30; ty++) {
      for (let tx = 0; tx < 32; tx++) {
        const tileId = nt[ty * 32 + tx];
        const attrByte = nt[0x3c0 + (Math.floor(ty / 4) * 8 + Math.floor(tx / 4))];
        const shift = ((ty & 0x02) << 1) | (tx & 0x02);
        const paletteIdx = (attrByte >> shift) & 0x03;
        const bgTable = (emu.ppu.ctrl & 0x10) ? 0x1000 : 0x0000;
        const tileAddr = bgTable + tileId * 16;
        for (let row = 0; row < 8; row++) {
          const lo = emu.mapper ? emu.mapper.ppuRead(tileAddr + row) : 0;
          const hi = emu.mapper ? emu.mapper.ppuRead(tileAddr + row + 8) : 0;
          for (let col = 0; col < 8; col++) {
            const bit = 7 - col;
            const pixel = (((hi >> bit) & 1) << 1) | ((lo >> bit) & 1);
            const idx = emu.ppu.paletteRam[emu.ppu._paletteIndex(0x3f00 + (paletteIdx << 2) + pixel)] & 0x3f;
            const rgb = NES_PALETTE_RGB(idx);
            const px = originX + tx * 8 + col;
            const py = originY + ty * 8 + row;
            const off = (py * 512 + px) * 4;
            img.data[off] = rgb[0]; img.data[off + 1] = rgb[1]; img.data[off + 2] = rgb[2]; img.data[off + 3] = 255;
          }
        }
      }
    }
  }
  cctx.putImageData(img, 0, 0);
}

// ---------------------------------------------------------------------
// Input configuration dialog
// ---------------------------------------------------------------------
let awaitingKeyForButton = null;
function openInputConfig() { renderInputConfigTable(); openDialog('dlg-input'); }
function renderInputConfigTable() {
  const table = $('input-config-table');
  table.innerHTML = '';
  BUTTONS.forEach(btn => {
    const keyCode = Object.entries(keymapP1).find(([, v]) => v === btn)?.[0] || '(unbound)';
    const row = document.createElement('tr');
    const labelCell = document.createElement('td');
    labelCell.className = 'info-label';
    labelCell.textContent = btn + ':';
    const btnCell = document.createElement('td');
    const remapBtn = document.createElement('button');
    remapBtn.textContent = awaitingKeyForButton === btn ? 'Press a key...' : keyCode;
    remapBtn.addEventListener('click', () => { awaitingKeyForButton = btn; renderInputConfigTable(); });
    btnCell.appendChild(remapBtn);
    row.appendChild(labelCell);
    row.appendChild(btnCell);
    table.appendChild(row);
  });
}
document.querySelector('[data-action="input-defaults"]')?.addEventListener('click', () => {
  keymapP1 = { ...DEFAULT_KEYMAP_P1 };
  saveKeymap();
  renderInputConfigTable();
});

// Initial paint (blank blue-ish placeholder isn't necessary; canvas starts black)
renderFrame();
