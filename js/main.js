import { Emulator } from './emulator.js';
import { RomLoadError } from './cartridge.js';
import { BUTTONS } from './controller.js';
import { disassembleRange, registerSnapshot, memoryPage, hex } from './debugger.js';

const VERSION = '1.1';
const emu = new Emulator();
window.__turtlenes = emu; // exposed for console debugging and browser tests

// ---------------------------------------------------------------------
// Settings (localStorage, all optional)
// ---------------------------------------------------------------------
const store = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem('turtlenes-' + key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem('turtlenes-' + key, JSON.stringify(value)); return true; } catch { return false; }
  },
  remove(key) { try { localStorage.removeItem('turtlenes-' + key); } catch { /* ignore */ } },
};

// ---------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const canvas = $('screen');
const ctx = canvas.getContext('2d');
const imageData = ctx.createImageData(256, 240);
const noRomScreen = $('no-rom-screen');
const screenWrap = $('screen-wrap');
const stage = $('screen-stage');
const statusRom = $('status-rom');
const statusMapper = $('status-mapper');
const statusFps = $('status-fps');
const statusSpeed = $('status-speed');
const fileInput = $('file-input');
const stateInput = $('state-input');
$('about-version').textContent = VERSION;

// ---------------------------------------------------------------------
// User settings
// ---------------------------------------------------------------------
let scale = store.get('scale', 2);
let filterMode = store.get('filter', 'nearest');
let fsMode = store.get('fsmode', 'aspect');
let muted = store.get('muted', false);
let volume = store.get('volume', 0.7);
let speed = 1;
let inputDisplayVisible = false;

// ---------------------------------------------------------------------
// Dialog plumbing (cascading placement, raise on click, draggable)
// ---------------------------------------------------------------------
const dialogsVisible = { debugger: false };
let zTop = 2000;
let cascade = 0;

function openDialog(id) {
  const el = $(id);
  el.style.display = 'block';
  if (!el.dataset.placed) {
    const n = cascade++ % 8;
    el.style.left = (110 + n * 26) + 'px';
    el.style.top = (70 + n * 26) + 'px';
    el.style.transform = 'none';
    el.dataset.placed = '1';
  }
  el.style.zIndex = ++zTop;
  if (id === 'dlg-debugger') dialogsVisible.debugger = true;
}
function closeDialog(id) {
  $(id).style.display = 'none';
  if (id === 'dlg-debugger') dialogsVisible.debugger = false;
  if (id === 'dlg-inputdisplay') { inputDisplayVisible = false; refreshMenuChecks(); }
}
function isDialogOpen(id) { return $(id).style.display !== 'none'; }

document.querySelectorAll('[data-close]').forEach(el => {
  el.addEventListener('click', () => closeDialog(el.getAttribute('data-close')));
});
document.querySelectorAll('.win-dialog').forEach(dlg => {
  dlg.addEventListener('mousedown', () => { dlg.style.zIndex = ++zTop; });
});
(function enableDragging() {
  let drag = null;
  document.querySelectorAll('.dialog-titlebar').forEach(bar => {
    bar.addEventListener('mousedown', (e) => {
      if (e.target.classList.contains('dialog-close')) return;
      const dlg = bar.closest('.win-dialog');
      const rect = dlg.getBoundingClientRect();
      dlg.style.left = rect.left + 'px';
      dlg.style.top = rect.top + 'px';
      dlg.style.transform = 'none';
      dlg.dataset.placed = '1';
      drag = { dlg, dx: e.clientX - rect.left, dy: e.clientY - rect.top };
      e.preventDefault();
    });
  });
  window.addEventListener('mousemove', (e) => {
    if (!drag) return;
    drag.dlg.style.left = Math.max(0, e.clientX - drag.dx) + 'px';
    drag.dlg.style.top = Math.max(0, e.clientY - drag.dy) + 'px';
  });
  window.addEventListener('mouseup', () => { drag = null; });
})();

function showError(message) {
  $('error-message').textContent = message;
  openDialog('dlg-error');
}
function showMessage(title, text, { onOk = null, confirm = false } = {}) {
  $('msg-title').textContent = title;
  $('msg-text').textContent = text;
  $('msg-cancel').style.display = confirm ? '' : 'none';
  $('msg-ok').onclick = () => { closeDialog('dlg-message'); if (onOk) onOk(); };
  openDialog('dlg-message');
}

// ---------------------------------------------------------------------
// Feedback: status bar message and a small on-screen note
// ---------------------------------------------------------------------
let msgTimer = null;
let toastTimer = null;
function flash(text) {
  const msg = $('status-msg');
  msg.textContent = text;
  clearTimeout(msgTimer);
  msgTimer = setTimeout(() => { msg.textContent = ''; }, 4000);
  const toast = $('screen-toast');
  toast.textContent = text;
  toast.style.display = 'block';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.style.display = 'none'; }, 1800);
}
function clockText(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// ---------------------------------------------------------------------
// Controller bindings. `keymaps` is the single source of truth: the key
// handlers, the configuration dialog and the input display all read it.
// ---------------------------------------------------------------------
const DEFAULT_KEYMAPS = {
  1: {
    KeyZ: 'A', KeyX: 'B', Enter: 'Start', ShiftLeft: 'Select', ShiftRight: 'Select',
    ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  },
  2: {
    KeyO: 'A', KeyU: 'B', KeyM: 'Start', KeyN: 'Select',
    KeyI: 'Up', KeyK: 'Down', KeyJ: 'Left', KeyL: 'Right',
  },
};
const RESERVED_KEYS = new Set(['Backspace', 'Escape', 'F1', 'F2', 'F3', 'F4', 'F5', 'F7', 'F9', 'F11', 'F12']);

function cloneMap(m) { return JSON.parse(JSON.stringify(m)); }
function loadKeymaps() {
  const saved = store.get('keymaps', null);
  if (saved && saved[1] && saved[2]) return saved;
  const maps = cloneMap(DEFAULT_KEYMAPS);
  try {
    const legacy = JSON.parse(localStorage.getItem('turtlenes-keymap-p1') || 'null');
    if (legacy) maps[1] = legacy;
  } catch { /* ignore */ }
  return maps;
}
let keymaps = loadKeymaps();
function saveKeymaps() { store.set('keymaps', keymaps); }
function controllerFor(player) { return player === 1 ? emu.controller1 : emu.controller2; }
function keysFor(player, button) {
  return Object.entries(keymaps[player]).filter(([, b]) => b === button).map(([code]) => code);
}
function keyName(code) {
  const named = { ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
    ShiftLeft: 'L-Shift', ShiftRight: 'R-Shift', ControlLeft: 'L-Ctrl', ControlRight: 'R-Ctrl',
    AltLeft: 'L-Alt', AltRight: 'R-Alt', Space: 'Space', Enter: 'Enter', Tab: 'Tab' };
  if (named[code]) return named[code];
  let m = /^Key(.)$/.exec(code); if (m) return m[1];
  m = /^Digit(.)$/.exec(code); if (m) return m[1];
  m = /^Numpad(.+)$/.exec(code); if (m) return 'Num ' + m[1];
  return code;
}
function releaseAllButtons() {
  emu.controller1.buttonState = 0;
  emu.controller2.buttonState = 0;
}

let awaiting = null; // { player, button } while the config dialog waits for a key

function assignKey(player, button, code) {
  [1, 2].forEach(p => { delete keymaps[p][code]; });
  Object.keys(keymaps[player]).forEach(c => { if (keymaps[player][c] === button) delete keymaps[player][c]; });
  keymaps[player][code] = button;
  saveKeymaps();
  releaseAllButtons();
}

function isTypingTarget(t) {
  if (!t || !t.tagName) return false;
  if (t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') return true;
  return t.tagName === 'INPUT' && !['range', 'checkbox', 'radio', 'button'].includes(t.type);
}

window.addEventListener('keydown', (e) => {
  if (awaiting) { handleRebindKey(e); return; }
  if (isTypingTarget(e.target)) return;
  if (e.ctrlKey && e.code === 'KeyO') { e.preventDefault(); doAction('open-rom'); return; }
  if (e.code === 'Backspace') {
    if (emu.loaded) { e.preventDefault(); startRewind(); }
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  let handled = false;
  [1, 2].forEach(p => {
    const btn = keymaps[p][e.code];
    if (btn) { controllerFor(p).setButton(btn, true); handled = true; }
  });
  if (handled) e.preventDefault();
  handleGlobalShortcut(e);
});
window.addEventListener('keyup', (e) => {
  if (e.code === 'Backspace') stopRewind();
  [1, 2].forEach(p => {
    const btn = keymaps[p][e.code];
    if (btn) controllerFor(p).setButton(btn, false);
  });
});
window.addEventListener('blur', () => { releaseAllButtons(); stopRewind(); });

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
// ROM loading, recent list
// ---------------------------------------------------------------------
let recent = store.get('recent', []);

function openHandleDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('turtlenes-recent', 1);
    req.onupgradeneeded = () => { req.result.createObjectStore('handles'); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function putHandle(key, handle) {
  const db = await openHandleDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('handles', 'readwrite');
    tx.objectStore('handles').put(handle, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
async function getHandle(key) {
  const db = await openHandleDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction('handles', 'readonly').objectStore('handles').get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

function addRecent(info, handle) {
  const entry = {
    key: emu.romKey, name: info.filename, mapper: info.mapperNumber,
    mapperName: info.mapperName, time: Date.now(), hasHandle: false,
  };
  if (handle) {
    putHandle(entry.key, handle).then(() => {
      entry.hasHandle = true;
      store.set('recent', recent);
    }).catch(() => { /* handle could not be stored, fall back to re-selecting */ });
  }
  recent = recent.filter(r => r.key !== entry.key);
  recent.unshift(entry);
  recent = recent.slice(0, 10);
  store.set('recent', recent);
}

function populateRecent() {
  const sub = $('sub-recent');
  sub.innerHTML = '';
  if (recent.length === 0) {
    const none = document.createElement('div');
    none.className = 'dropdown-item disabled';
    none.textContent = '(no recent ROMs)';
    sub.appendChild(none);
    return;
  }
  recent.forEach(r => {
    const item = document.createElement('div');
    item.className = 'dropdown-item recent-item';
    item.appendChild(document.createTextNode(r.name));
    const meta = document.createElement('span');
    meta.className = 'recent-meta';
    const d = new Date(r.time);
    meta.textContent = `Mapper ${String(r.mapper).padStart(3, '0')}, ${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    item.appendChild(meta);
    item.addEventListener('click', (e) => { e.stopPropagation(); closeAllMenus(); openRecent(r.key); });
    sub.appendChild(item);
  });
  const sep = document.createElement('div');
  sep.className = 'dropdown-sep';
  sub.appendChild(sep);
  const clear = document.createElement('div');
  clear.className = 'dropdown-item';
  clear.textContent = 'Clear Recent List';
  clear.addEventListener('click', (e) => { e.stopPropagation(); closeAllMenus(); recent = []; store.set('recent', recent); flash('Recent list cleared'); });
  sub.appendChild(clear);
}

async function openRecent(key) {
  const entry = recent.find(r => r.key === key);
  if (!entry) return;
  try {
    const handle = await getHandle(key);
    if (handle) {
      let perm = await handle.queryPermission({ mode: 'read' });
      if (perm !== 'granted') perm = await handle.requestPermission({ mode: 'read' });
      if (perm === 'granted') {
        const file = await handle.getFile();
        await loadFile(file, handle);
        return;
      }
    }
  } catch (e) { /* fall through to manual selection */ }
  showMessage('Open Recent',
    `The browser did not keep access to "${entry.name}", so TurtleNES cannot reopen it automatically.\n\nPress OK to select the file again.`,
    { confirm: true, onOk: () => fileInput.click() });
}

async function openRomPicker() {
  if (window.showOpenFilePicker) {
    try {
      const [handle] = await window.showOpenFilePicker({
        types: [{ description: 'NES ROM', accept: { 'application/octet-stream': ['.nes'] } }],
      });
      const file = await handle.getFile();
      loadFile(file, handle);
      return;
    } catch (e) {
      if (e && e.name === 'AbortError') return;
    }
  }
  fileInput.click();
}

async function loadFile(file, handle) {
  try {
    const buf = await file.arrayBuffer();
    const info = emu.loadRom(buf, file.name);
    onRomLoaded(info, handle || null);
  } catch (e) {
    if (e instanceof RomLoadError) {
      showError(e.message);
    } else {
      showError(`Unexpected error while loading ROM:\n${e.message}`);
      console.error(e);
    }
  }
}

function onRomLoaded(info, handle) {
  noRomScreen.style.display = 'none';
  screenWrap.style.display = '';
  statusRom.textContent = info.filename;
  statusMapper.textContent = `Mapper ${String(info.mapperNumber).padStart(3, '0')} (${info.mapperName})`;
  document.title = `${info.filename} - TurtleNES`;
  populateRomInfoDialog(info);
  restoreCheatsForRom();
  emu.configureRewind({ enabled: store.get('rewind-enabled', true), seconds: store.get('rewind-seconds', 30) });
  updateStateIndicator();
  addRecent(info, handle);
  layout();
  emu.play();
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
  if (fileInput.files[0]) loadFile(fileInput.files[0], null);
  fileInput.value = '';
});
$('btn-open-rom-big').addEventListener('click', () => openRomPicker());

['dragenter', 'dragover'].forEach(evt => {
  document.body.addEventListener(evt, (e) => { e.preventDefault(); });
});
document.body.addEventListener('drop', async (e) => {
  e.preventDefault();
  const file = e.dataTransfer.files && e.dataTransfer.files[0];
  if (!file) return;
  const item = e.dataTransfer.items && e.dataTransfer.items[0];
  const handlePromise = item && item.getAsFileSystemHandle ? item.getAsFileSystemHandle() : null;
  const lower = file.name.toLowerCase();
  if (lower.endsWith('.tnesstate')) { importStateFile(file); return; }
  if (!lower.endsWith('.nes')) { showError('Only .nes ROM files are supported.'); return; }
  let handle = null;
  try {
    const h = handlePromise ? await handlePromise : null;
    if (h && h.kind === 'file') handle = h;
  } catch { /* no handle available */ }
  loadFile(file, handle);
});

// ---------------------------------------------------------------------
// Menu bar
// ---------------------------------------------------------------------
const menuItems = document.querySelectorAll('.menu-item');
let openMenu = null;

function stateValue(name) {
  switch (name) {
    case 'mute': return muted;
    case 'inputdisplay': return inputDisplayVisible;
    case 'speed': return speed;
    case 'scale': return scale;
    case 'filter': return filterMode;
    case 'fsmode': return fsMode;
    default: return false;
  }
}
function refreshMenuChecks() {
  document.querySelectorAll('[data-state]').forEach(el => {
    const [name, val] = el.getAttribute('data-state').split(':');
    const on = val === undefined ? !!stateValue(name) : String(stateValue(name)) === val;
    const chk = el.querySelector('.chk');
    if (chk) chk.classList.toggle('on', on);
  });
}
function hideSubs() {
  document.querySelectorAll('.dropdown[id^="sub-"]').forEach(d => d.classList.remove('visible'));
}
function closeAllMenus() {
  document.querySelectorAll('.dropdown').forEach(d => d.classList.remove('visible'));
  document.querySelectorAll('.menu-item').forEach(m => m.classList.remove('open'));
  openMenu = null;
}
function showMenu(item) {
  closeAllMenus();
  refreshMenuChecks();
  const name = item.getAttribute('data-menu');
  const dropdown = $('menu-' + name);
  const rect = item.getBoundingClientRect();
  dropdown.style.left = rect.left + 'px';
  dropdown.style.top = rect.bottom + 'px';
  dropdown.classList.add('visible');
  item.classList.add('open');
  openMenu = name;
}
menuItems.forEach(item => {
  item.addEventListener('click', (e) => {
    e.stopPropagation();
    if (openMenu === item.getAttribute('data-menu')) { closeAllMenus(); return; }
    showMenu(item);
  });
  item.addEventListener('mouseenter', () => {
    if (openMenu && openMenu !== item.getAttribute('data-menu')) showMenu(item);
  });
});
function showSub(item) {
  hideSubs();
  const sub = $(item.getAttribute('data-sub'));
  if (sub.id === 'sub-recent') populateRecent();
  refreshMenuChecks();
  const rect = item.getBoundingClientRect();
  sub.style.left = rect.right + 'px';
  sub.style.top = rect.top + 'px';
  sub.classList.add('visible');
}
document.querySelectorAll('.dropdown-item.has-sub').forEach(item => {
  item.addEventListener('mouseenter', () => showSub(item));
  item.addEventListener('click', (e) => { e.stopPropagation(); showSub(item); });
});
document.querySelectorAll('.dropdown[id^="menu-"] .dropdown-item:not(.has-sub)').forEach(item => {
  item.addEventListener('mouseenter', hideSubs);
});

document.addEventListener('click', (e) => {
  const item = e.target.closest('.dropdown-item[data-action]');
  if (item && !item.classList.contains('disabled')) {
    doAction(item.getAttribute('data-action'), item);
    closeAllMenus();
    return;
  }
  if (e.target.closest('.dropdown')) return; // clicks on separators or the volume slider keep the menu open
  closeAllMenus();
});

// ---------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------
function needRom() {
  if (emu.loaded) return true;
  flash('No ROM loaded');
  return false;
}

function doAction(action, el) {
  const value = el ? el.getAttribute('data-value') : null;
  switch (action) {
    case 'open-rom': openRomPicker(); break;
    case 'close-rom':
      emu.unloadRom(); noRomScreen.style.display = ''; screenWrap.style.display = 'none';
      statusRom.textContent = 'No ROM loaded'; statusMapper.textContent = '';
      document.title = 'TurtleNES'; updateStateIndicator(); break;
    case 'save-state': doSaveState(); break;
    case 'load-state': doLoadState(); break;
    case 'delete-state': doDeleteState(); break;
    case 'export-state': doExportState(); break;
    case 'import-state': stateInput.click(); break;
    case 'clear-sram':
      if (!needRom()) break;
      if (!emu.cartridge.hasBattery) { flash('This cartridge has no battery save data'); break; }
      showMessage('Clear Cartridge Save Data', 'Delete the battery save data for this game? This cannot be undone.',
        { confirm: true, onOk: () => { emu.clearBatterySave(); flash('Cartridge save data cleared'); } });
      break;
    case 'exit': showMessage('Exit', 'TurtleNES runs inside your browser tab. Close the tab to exit.'); break;

    case 'run': emu.play(); break;
    case 'pause': emu.pause(); break;
    case 'reset': emu.reset(); break;
    case 'stop': emu.pause(); emu.reset(); break;
    case 'frame-advance': if (needRom()) { emu.play(); emu.runFrame(); emu.pause(); renderFrame(); } break;
    case 'speed': setSpeed(parseFloat(value)); break;
    case 'speed-more': $('speed-input').value = String(speed); openDialog('dlg-speed'); break;
    case 'open-rewind': refreshRewindDialog(true); openDialog('dlg-rewind'); break;
    case 'open-cheats': renderCheats(); openDialog('dlg-cheats'); break;
    case 'open-cpucompat':
      $('cpu-official').checked = !emu.cpu.unofficialOpcodesEnabled;
      $('cpu-unofficial').checked = emu.cpu.unofficialOpcodesEnabled;
      openDialog('dlg-cpucompat'); break;

    case 'scale': setScale(parseInt(value, 10)); break;
    case 'fullscreen': toggleFullscreen(); break;
    case 'fsmode': fsMode = value; store.set('fsmode', fsMode); layout(); flash('Fullscreen mode: ' + fsModeLabel(fsMode)); break;
    case 'filter': setFilter(value); break;

    case 'toggle-mute': setMuted(!muted); break;
    case 'configure-p1': openInputConfig(1); break;
    case 'configure-p2': openInputConfig(2); break;
    case 'toggle-inputdisplay': setInputDisplay(!inputDisplayVisible); break;

    case 'open-debugger': case 'open-disasm': openDialog('dlg-debugger'); refreshDebugger(); break;
    case 'open-memviewer': openDialog('dlg-memviewer'); refreshMemViewer(); break;
    case 'open-ppuviewer': case 'open-patterntables': openDialog('dlg-patterntables'); refreshPatternTables(); break;
    case 'open-nametables': openDialog('dlg-nametables'); refreshNametables(); break;
    case 'open-rominfo': if (needRom()) openDialog('dlg-rominfo'); break;

    case 'open-about': openDialog('dlg-about'); break;
    case 'open-docs': window.open('docs.html', '_blank', 'noopener'); break;
    case 'open-tutorial': window.open('docs.html#quick-start', '_blank', 'noopener'); break;
  }
}

$('btn-about-close').addEventListener('click', () => openDialog('dlg-about'));
$('tb-run').addEventListener('click', () => doAction('run'));
$('tb-pause').addEventListener('click', () => doAction('pause'));
$('tb-stop').addEventListener('click', () => doAction('stop'));
$('tb-reset').addEventListener('click', () => doAction('reset'));
$('tb-fullscreen').addEventListener('click', () => doAction('fullscreen'));
$('tb-inputdisplay').addEventListener('click', () => setInputDisplay(!inputDisplayVisible));
$('tb-savestate').addEventListener('click', () => doSaveState());
$('tb-loadstate').addEventListener('click', () => doLoadState());
document.querySelectorAll('.scale-btn').forEach(b => {
  b.addEventListener('click', () => setScale(parseInt(b.getAttribute('data-scale'), 10)));
});
const rewindBtn = $('tb-rewind');
rewindBtn.addEventListener('mousedown', (e) => { e.preventDefault(); startRewind(); });
['mouseup', 'mouseleave'].forEach(ev => rewindBtn.addEventListener(ev, stopRewind));

// ---------------------------------------------------------------------
// Video: scale, filters, fullscreen
// ---------------------------------------------------------------------
const FS_LABELS = { normal: 'Normal', square: 'Square (whole pixels)', aspect: 'Keep Aspect Ratio', fill: 'Fill Screen' };
function fsModeLabel(m) { return FS_LABELS[m] || m; }

function setScale(s) { scale = s; store.set('scale', s); layout(); }
function setFilter(f) {
  filterMode = f;
  store.set('filter', f);
  stage.setAttribute('data-filter', f);
  flash('Filter: ' + f.charAt(0).toUpperCase() + f.slice(1));
}

// Size of the picture in CSS pixels for the current mode.
function computeDisplaySize() {
  if (document.fullscreenElement !== screenWrap && document.webkitFullscreenElement !== screenWrap) {
    return { w: 256 * scale, h: 240 * scale, fullscreen: false };
  }
  const W = screenWrap.clientWidth || window.innerWidth;
  const H = screenWrap.clientHeight || window.innerHeight;
  let w, h;
  switch (fsMode) {
    case 'normal': { const s = Math.min(scale, W / 256, H / 240); w = 256 * s; h = 240 * s; break; }
    case 'square': { const k = Math.max(1, Math.floor(Math.min(W / 256, H / 240))); w = 256 * k; h = 240 * k; break; }
    case 'fill': w = W; h = H; break;
    case 'aspect': default: { const s = Math.min(W / 256, H / 240); w = 256 * s; h = 240 * s; break; }
  }
  return { w, h, fullscreen: true, W, H };
}
function layout() {
  const d = computeDisplaySize();
  stage.style.width = d.w + 'px';
  stage.style.height = d.h + 'px';
  stage.style.setProperty('--row', (d.h / 240) + 'px');
  return d;
}
window.addEventListener('resize', layout);
document.addEventListener('fullscreenchange', layout);
document.addEventListener('webkitfullscreenchange', layout);

function toggleFullscreen() {
  if (!emu.loaded) { flash('Load a ROM before using fullscreen'); return; }
  const active = document.fullscreenElement || document.webkitFullscreenElement;
  if (!active) {
    const req = screenWrap.requestFullscreen || screenWrap.webkitRequestFullscreen;
    if (!req) { showError('This browser does not support fullscreen mode.'); return; }
    const p = req.call(screenWrap);
    if (p && p.catch) p.catch(() => showError('The browser refused to enter fullscreen mode.'));
  } else {
    (document.exitFullscreen || document.webkitExitFullscreen).call(document);
  }
}

// ---------------------------------------------------------------------
// Audio: one Mute control. The audio context is created lazily because
// browsers only allow sound after a user gesture.
// ---------------------------------------------------------------------
let audioCtx = null;
let audioFailed = false;
let nextStartTime = 0;

function unlockAudio() {
  if (audioFailed) return;
  try {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      nextStartTime = audioCtx.currentTime;
    }
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  } catch (e) {
    audioFailed = true;
    audioCtx = null;
  }
}
['pointerdown', 'keydown'].forEach(ev => window.addEventListener(ev, unlockAudio, { passive: true }));

function setMuted(m) {
  muted = m;
  store.set('muted', m);
  if (audioCtx) nextStartTime = audioCtx.currentTime;
  updateStatusBar();
  flash(m ? 'Audio muted' : 'Audio on');
}
$('volume-slider').value = String(Math.round(volume * 100));
$('volume-slider').addEventListener('input', (e) => { volume = e.target.value / 100; store.set('volume', volume); });

emu.audioSampleCallback = (samples) => {
  if (muted || speed !== 1 || !audioCtx || audioCtx.state !== 'running') return;
  const now = audioCtx.currentTime;
  if (nextStartTime < now) nextStartTime = now + 0.02;
  if (nextStartTime - now > 0.3) return; // drop instead of building up latency
  const buffer = audioCtx.createBuffer(1, samples.length, emu.apu.sampleRate);
  buffer.copyToChannel(samples, 0);
  const src = audioCtx.createBufferSource();
  src.buffer = buffer;
  const gain = audioCtx.createGain();
  gain.gain.value = volume;
  src.connect(gain).connect(audioCtx.destination);
  src.start(nextStartTime);
  nextStartTime += buffer.duration;
};

function audioStatusText() {
  if (audioFailed) return 'Audio: Unavailable';
  if (muted) return 'Audio: Muted';
  if (speed !== 1) return 'Audio: Off (speed)';
  if (!audioCtx || audioCtx.state !== 'running') return 'Audio: Click page to start';
  return 'Audio: On';
}

// ---------------------------------------------------------------------
// Speed
// ---------------------------------------------------------------------
function setSpeed(s) {
  if (!(s >= 0.1 && s <= 10)) { showError('Speed must be between 0.1 and 10.'); return; }
  speed = s;
  accumulator = 0;
  if (audioCtx) nextStartTime = audioCtx.currentTime;
  updateStatusBar();
  flash(`Speed: ${s}x` + (s !== 1 ? ' (audio off)' : ''));
}
$('speed-apply').addEventListener('click', () => {
  const v = parseFloat($('speed-input').value);
  if (!(v >= 0.1 && v <= 10)) { showError('Speed must be between 0.1 and 10.'); return; }
  closeDialog('dlg-speed');
  setSpeed(v);
});

// ---------------------------------------------------------------------
// CPU compatibility
// ---------------------------------------------------------------------
emu.cpu.unofficialOpcodesEnabled = store.get('unofficial', false);
$('cpu-apply').addEventListener('click', () => {
  const on = $('cpu-unofficial').checked;
  emu.cpu.unofficialOpcodesEnabled = on;
  if (on) emu.cpu.jammed = false;
  store.set('unofficial', on);
  closeDialog('dlg-cpucompat');
  flash(on ? 'Undocumented opcodes enabled' : 'Official opcodes only');
});

// ---------------------------------------------------------------------
// Save states. Save and Load never open a file picker: they use an
// in-memory slot (also mirrored to localStorage). Only Export/Import
// touch files, and only when chosen explicitly.
// ---------------------------------------------------------------------
const quickStates = new Map();
const stateStorageKey = () => 'state-' + emu.romKey;

function getQuickState() {
  if (!emu.loaded) return null;
  if (quickStates.has(emu.romKey)) return quickStates.get(emu.romKey);
  try {
    const raw = localStorage.getItem('turtlenes-' + stateStorageKey());
    if (raw) {
      const st = emu.deserializeState(raw);
      if (st) { quickStates.set(emu.romKey, st); return st; }
    }
  } catch { /* ignore */ }
  return null;
}
function updateStateIndicator() {
  const el = $('status-state');
  const st = getQuickState();
  if (!emu.loaded || !st) { el.textContent = 'State: empty'; el.title = 'No saved state for this ROM'; return; }
  el.textContent = 'State: ' + clockText(st.timestamp);
  el.title = 'Saved ' + new Date(st.timestamp).toLocaleString();
}

function doSaveState() {
  if (!needRom()) return;
  const existed = !!getQuickState();
  const st = emu.saveState();
  quickStates.set(emu.romKey, st);
  let persisted = true;
  try {
    localStorage.setItem('turtlenes-' + stateStorageKey(), emu.serializeState(st));
  } catch { persisted = false; }
  updateStateIndicator();
  flash((existed ? 'State overwritten at ' : 'State saved at ') + clockText(st.timestamp) +
    (persisted ? '' : ' (kept in memory only, browser storage is full)'));
}
function doLoadState() {
  if (!needRom()) return;
  const st = getQuickState();
  if (!st) { flash('No saved state for this ROM'); return; }
  const result = emu.loadState(st);
  if (!result.ok) { showError('Could not load the saved state.\n\n' + result.reason); return; }
  renderFrame();
  flash('State loaded (saved at ' + clockText(st.timestamp) + ')');
}
function doDeleteState() {
  if (!needRom()) return;
  if (!getQuickState()) { flash('There is no saved state to delete'); return; }
  quickStates.delete(emu.romKey);
  store.remove(stateStorageKey());
  updateStateIndicator();
  flash('Saved state deleted');
}

function doExportState() {
  if (!needRom()) return;
  const saved = getQuickState();
  const st = saved || emu.saveState();
  const text = emu.serializeState(st);
  const base = emu.cartridge.filename.replace(/\.nes$/i, '');
  const blob = new Blob([text], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = base + '.tnesstate';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  flash(saved ? 'Exported the saved state to ' + a.download : 'No saved state yet: exported the current state to ' + a.download);
}

async function importStateFile(file) {
  if (!needRom()) return;
  let text;
  try { text = await file.text(); } catch { showError('The save state file could not be read.'); return; }
  const st = emu.deserializeState(text);
  if (!st) { showError('This file is not a valid TurtleNES save state.'); return; }
  const result = emu.loadState(st);
  if (!result.ok) { showError('Could not import the save state.\n\n' + result.reason); return; }
  renderFrame();
  flash('Save state imported from ' + file.name);
}
stateInput.addEventListener('change', () => {
  if (stateInput.files[0]) importStateFile(stateInput.files[0]);
  stateInput.value = '';
});

// ---------------------------------------------------------------------
// Rewind (hold Backspace or the toolbar button) and timeline
// ---------------------------------------------------------------------
let rewindHeld = false;
let rewindPaused = false;

function startRewind() {
  if (!emu.loaded || rewindHeld) return;
  if (!emu.rewindEnabled) { flash('Rewind is turned off (Emulation > Rewind...)'); return; }
  rewindHeld = true;
}
function stopRewind() {
  if (!rewindHeld) return;
  rewindHeld = false;
  if (rewindPaused) { rewindPaused = false; emu.play(); accumulator = 0; }
}
function rewindTick() {
  if (emu.rewindBuffer.length === 0) { flash('Nothing to rewind yet'); return; }
  if (!rewindPaused) { rewindPaused = emu.running; emu.pause(); }
  emu.rewindStep();
  renderFrame();
  $('screen-toast').textContent = 'Rewinding';
  $('screen-toast').style.display = 'block';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('screen-toast').style.display = 'none'; }, 400);
}

function estimateSnapshotBytes(state) {
  let total = 0;
  const walk = (o) => {
    if (!o || typeof o !== 'object') return;
    if (ArrayBuffer.isView(o)) { total += o.byteLength; return; }
    Object.values(o).forEach(walk);
  };
  walk(state);
  return total + 512;
}
function refreshRewindDialog(syncControls) {
  const len = emu.rewindBuffer.length;
  const slider = $('rewind-slider');
  slider.max = String(Math.max(0, len - 1));
  const cursor = emu._rewindCursor === null ? len - 1 : emu._rewindCursor;
  if (document.activeElement !== slider) slider.value = String(Math.max(0, cursor));
  if (syncControls) {
    $('rewind-enabled').checked = emu.rewindEnabled;
    $('rewind-seconds').value = String(emu.rewindSeconds);
  }
  if (len === 0) {
    $('rewind-info').textContent = emu.rewindEnabled ? 'No history yet.' : 'Rewind recording is off.';
  } else {
    const secs = (len * emu.rewindInterval / 60).toFixed(1);
    const kb = Math.round(len * estimateSnapshotBytes(emu.rewindBuffer[len - 1]) / 1024);
    $('rewind-info').textContent = `${len} snapshots, about ${secs} seconds of history (${kb} KB in memory).`;
  }
}
$('rewind-enabled').addEventListener('change', () => {
  emu.configureRewind({ enabled: $('rewind-enabled').checked });
  store.set('rewind-enabled', emu.rewindEnabled);
  refreshRewindDialog(false);
});
$('rewind-seconds').addEventListener('change', () => {
  emu.configureRewind({ seconds: parseInt($('rewind-seconds').value, 10) });
  store.set('rewind-seconds', emu.rewindSeconds);
  refreshRewindDialog(false);
});
$('rewind-slider').addEventListener('input', () => {
  if (!emu.loaded) return;
  emu.pause();
  emu.rewindSeek(parseInt($('rewind-slider').value, 10));
  renderFrame();
});
$('rewind-run').addEventListener('click', () => { emu.play(); accumulator = 0; });
setInterval(() => { if (isDialogOpen('dlg-rewind')) refreshRewindDialog(false); }, 300);

// ---------------------------------------------------------------------
// Cheats
// ---------------------------------------------------------------------
function persistCheats() {
  if (!emu.loaded) return;
  store.set('cheats-' + emu.romKey, emu.cheats.map(c => ({ code: c.code, label: c.label, enabled: c.enabled })));
}
function restoreCheatsForRom() {
  emu.cheats = [];
  const saved = store.get('cheats-' + emu.romKey, []);
  saved.forEach(s => {
    const r = emu.addCheat(s.code, s.label);
    if (r.cheat) emu.setCheatEnabled(r.cheat.id, s.enabled);
  });
}
function renderCheats() {
  const list = $('cheat-list');
  list.innerHTML = '';
  $('cheat-error').textContent = '';
  if (emu.cheats.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'cheat-empty';
    empty.textContent = emu.loaded ? 'No cheats for this game.' : 'Load a ROM to add cheats.';
    list.appendChild(empty);
    return;
  }
  emu.cheats.forEach(c => {
    const row = document.createElement('div');
    row.className = 'cheat-row' + (c.enabled ? '' : ' off');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = c.enabled;
    cb.addEventListener('change', () => { emu.setCheatEnabled(c.id, cb.checked); persistCheats(); renderCheats(); });
    const code = document.createElement('code');
    code.textContent = c.code;
    const rm = document.createElement('button');
    rm.textContent = 'Remove';
    rm.addEventListener('click', () => { emu.removeCheat(c.id); persistCheats(); renderCheats(); });
    row.append(cb, code, document.createTextNode(c.label || ''), rm);
    list.appendChild(row);
  });
}
$('cheat-add').addEventListener('click', () => {
  if (!emu.loaded) { $('cheat-error').textContent = 'Load a ROM first.'; return; }
  const r = emu.addCheat($('cheat-code').value, $('cheat-label').value);
  if (r.error) { $('cheat-error').textContent = r.error; return; }
  $('cheat-code').value = '';
  $('cheat-label').value = '';
  persistCheats();
  renderCheats();
});

// ---------------------------------------------------------------------
// Controller configuration and input display
// ---------------------------------------------------------------------
let configPlayer = 1;

function openInputConfig(player) {
  configPlayer = player;
  awaiting = null;
  renderInputConfig();
  openDialog('dlg-input');
}
function renderInputConfig() {
  $('input-title').textContent = 'Configure Controller ' + configPlayer;
  $('tab-p1').classList.toggle('active', configPlayer === 1);
  $('tab-p2').classList.toggle('active', configPlayer === 2);
  const table = $('input-config-table');
  table.innerHTML = '';
  BUTTONS.forEach(btn => {
    const row = document.createElement('tr');
    const label = document.createElement('td');
    label.className = 'info-label';
    label.textContent = btn + ':';
    const keys = document.createElement('td');
    keys.className = 'bound-keys';
    const codes = keysFor(configPlayer, btn);
    keys.textContent = codes.length ? codes.map(keyName).join(', ') : '(unbound)';
    const cell = document.createElement('td');
    const change = document.createElement('button');
    const waiting = awaiting && awaiting.player === configPlayer && awaiting.button === btn;
    change.textContent = waiting ? 'Press a key...' : 'Change...';
    change.classList.toggle('waiting', !!waiting);
    change.addEventListener('click', () => { awaiting = { player: configPlayer, button: btn }; renderInputConfig(); });
    cell.appendChild(change);
    row.append(label, keys, cell);
    table.appendChild(row);
  });
  $('input-hint').textContent = awaiting
    ? `Press the key for Controller ${awaiting.player} ${awaiting.button} (Esc cancels).`
    : 'Click Change, then press the key to bind. Bindings apply to the game immediately.';
}
function handleRebindKey(e) {
  e.preventDefault();
  if (e.code === 'Escape') { awaiting = null; renderInputConfig(); return; }
  if (RESERVED_KEYS.has(e.code)) {
    $('input-hint').textContent = `${keyName(e.code)} is reserved for emulator shortcuts. Press another key.`;
    return;
  }
  assignKey(awaiting.player, awaiting.button, e.code);
  awaiting = null;
  renderInputConfig();
  renderPadLabels();
}
$('tab-p1').addEventListener('click', () => { awaiting = null; configPlayer = 1; renderInputConfig(); });
$('tab-p2').addEventListener('click', () => { awaiting = null; configPlayer = 2; renderInputConfig(); });
$('input-defaults').addEventListener('click', () => {
  keymaps[configPlayer] = cloneMap(DEFAULT_KEYMAPS[configPlayer]);
  // Keep the two players from sharing a key after a reset.
  const other = configPlayer === 1 ? 2 : 1;
  Object.keys(keymaps[configPlayer]).forEach(c => { delete keymaps[other][c]; });
  saveKeymaps();
  releaseAllButtons();
  awaiting = null;
  renderInputConfig();
  renderPadLabels();
});

const PAD_CELLS = [
  ['Up', 1, 2], ['Left', 2, 1], ['Right', 2, 3], ['Down', 3, 2],
  ['Select', 2, 5], ['Start', 2, 6], ['B', 2, 8], ['A', 2, 9],
];
function buildPads() {
  const holder = $('pads-holder');
  holder.innerHTML = '';
  [1, 2].forEach(p => {
    const box = document.createElement('div');
    box.className = 'pad-box';
    const title = document.createElement('div');
    title.className = 'pad-title';
    title.textContent = 'Player ' + p;
    const grid = document.createElement('div');
    grid.className = 'pad-grid';
    PAD_CELLS.forEach(([name, row, col]) => {
      const cell = document.createElement('div');
      cell.className = 'pad-btn';
      cell.dataset.player = String(p);
      cell.dataset.button = name;
      cell.style.gridRow = String(row);
      cell.style.gridColumn = String(col);
      cell.appendChild(document.createTextNode(name));
      const small = document.createElement('small');
      cell.appendChild(small);
      grid.appendChild(cell);
    });
    box.append(title, grid);
    holder.appendChild(box);
  });
  renderPadLabels();
}
function renderPadLabels() {
  document.querySelectorAll('.pad-btn').forEach(cell => {
    const codes = keysFor(parseInt(cell.dataset.player, 10), cell.dataset.button);
    cell.querySelector('small').textContent = codes.length ? keyName(codes[0]) : '-';
  });
}
function updatePads() {
  for (const cell of document.querySelectorAll('.pad-btn')) {
    const c = controllerFor(parseInt(cell.dataset.player, 10));
    const bit = BUTTONS.indexOf(cell.dataset.button);
    cell.classList.toggle('down', (c.buttonState & (1 << bit)) !== 0);
  }
}
function setInputDisplay(on) {
  inputDisplayVisible = on;
  if (on) openDialog('dlg-inputdisplay'); else closeDialog('dlg-inputdisplay');
  inputDisplayVisible = on;
  refreshMenuChecks();
}
buildPads();

// ---------------------------------------------------------------------
// Main timing loop. The real NTSC NES runs at about 60.0988 fps; an
// accumulator keeps emulation speed correct on any display refresh rate.
// Speed scales how much emulated time passes per real millisecond.
// ---------------------------------------------------------------------
const NES_FPS = 60.0988;
const FRAME_MS = 1000 / NES_FPS;
let lastTime = performance.now();
let accumulator = 0;
let fpsCounter = 0;
let fpsTimer = 0;
let lastFps = 0;

function tick(now) {
  const delta = Math.min(now - lastTime, 250);
  lastTime = now;
  fpsTimer += delta;

  if (rewindHeld && emu.loaded) {
    rewindTick();
  } else {
    accumulator += delta * speed;
    const maxFrames = Math.max(4, Math.ceil(speed * 3));
    const t0 = performance.now();
    let framesRun = 0;
    while (accumulator >= FRAME_MS && framesRun < maxFrames) {
      if (!emu.running) { accumulator = 0; break; }
      emu.runFrame();
      framesRun++;
      fpsCounter++;
      accumulator -= FRAME_MS;
      if (performance.now() - t0 > 20) { accumulator = 0; break; } // too slow: drop the backlog
    }
    if (framesRun > 0) renderFrame();
  }

  if (fpsTimer >= 1000) {
    lastFps = fpsCounter;
    fpsCounter = 0;
    fpsTimer = 0;
    updateStatusBar();
  }

  if (dialogsVisible.debugger) refreshDebugger();
  if (inputDisplayVisible) updatePads();

  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

function renderFrame() {
  imageData.data.set(emu.ppu.framebuffer);
  ctx.putImageData(imageData, 0, 0);
}

function updateStatusBar() {
  $('status-audio').textContent = audioStatusText();
  if (!emu.loaded) { statusFps.textContent = ''; statusSpeed.textContent = ''; return; }
  statusFps.textContent = `${lastFps} FPS`;
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
// Startup
// ---------------------------------------------------------------------
stage.setAttribute('data-filter', filterMode);
layout();
refreshMenuChecks();
updateStatusBar();
renderFrame();

// Read-only hooks for browser tests
window.__turtlenesUI = {
  get keymaps() { return keymaps; },
  get settings() { return { scale, filterMode, fsMode, muted, speed }; },
  displaySize: computeDisplaySize,
};
