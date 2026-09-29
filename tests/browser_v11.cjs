// Run with a static server on port 8934, for example:
//   python3 -m http.server 8934 --bind 127.0.0.1 &
//   node tests/browser_v11.cjs
const { chromium } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHROMIUM = process.env.TURTLE_CHROMIUM ||
  '/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell';
const URL = 'http://127.0.0.1:8934/index.html';

let failures = 0;
const ok = (cond, label, extra) => {
  if (cond) console.log('ok:   ' + label);
  else { failures++; console.error('FAIL: ' + label + (extra !== undefined ? '  [' + JSON.stringify(extra) + ']' : '')); }
};

function makeRom(name, { mapper = 0, marker = 0xea } = {}) {
  const header = Buffer.alloc(16);
  header.set([0x4e, 0x45, 0x53, 0x1a, 1, 1, (mapper & 0x0f) << 4, mapper & 0xf0]);
  const prg = Buffer.alloc(16384, marker);
  prg[0x3ffc] = 0x00; prg[0x3ffd] = 0x80;
  const file = path.join(os.tmpdir(), name);
  fs.writeFileSync(file, Buffer.concat([header, prg, Buffer.alloc(8192)]));
  return file;
}

(async () => {
  const browser = await chromium.launch({
    executablePath: CHROMIUM,
    args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true });
  const page = await context.newPage();
  const errors = [];
  let chooserCount = 0;
  let downloadCount = 0;
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });
  page.on('filechooser', () => { chooserCount++; });
  page.on('download', () => { downloadCount++; });

  await page.addInitScript(() => {
    window.__audioSources = 0;
    const orig = window.AudioContext && window.AudioContext.prototype.createBufferSource;
    if (orig) window.AudioContext.prototype.createBufferSource = function () { window.__audioSources++; return orig.call(this); };
  });

  await page.goto(URL, { waitUntil: 'load' });
  const nestest = path.join(__dirname, 'nestest.nes');
  await page.setInputFiles('#file-input', nestest);
  await page.waitForTimeout(600);
  const emu = (fn, arg) => page.evaluate(fn, arg);

  ok(await page.$eval('#status-rom', e => e.textContent) === 'nestest.nes', 'ROM loads through the file input');
  ok(await page.$eval('#about-version', e => e.textContent) === '1.1', 'About dialog shows version 1.1');

  // ---- Controllers: both players, input display, configuration ----
  await page.click('#tb-inputdisplay');
  await page.waitForTimeout(100);
  ok(await page.$eval('#dlg-inputdisplay', e => getComputedStyle(e).display !== 'none'), 'input display window opens');
  ok((await page.$$('.pad-btn')).length === 16, 'input display shows 8 buttons for each of 2 players');

  await page.keyboard.down('KeyZ');
  await page.keyboard.down('ArrowUp');
  await page.keyboard.down('KeyO');
  await page.keyboard.down('KeyL');
  await page.waitForTimeout(150);
  const bits = await emu(() => [window.__turtlenes.controller1.buttonState, window.__turtlenes.controller2.buttonState]);
  ok(bits[0] === (0x01 | 0x10), 'Player 1 keys reach controller 1 (A + Up)', bits);
  ok(bits[1] === (0x01 | 0x80), 'Player 2 keys reach controller 2 (A + Right)', bits);
  ok(await page.$('.pad-btn.down[data-player="1"][data-button="A"]') !== null, 'display lights Player 1 A');
  ok(await page.$('.pad-btn.down[data-player="1"][data-button="Up"]') !== null, 'display lights Player 1 Up');
  ok(await page.$('.pad-btn.down[data-player="2"][data-button="A"]') !== null, 'display lights Player 2 A');
  ok(await page.$('.pad-btn.down[data-player="2"][data-button="Right"]') !== null, 'display lights Player 2 Right');
  ok(await page.$('.pad-btn.down[data-player="1"][data-button="B"]') === null, 'display leaves unpressed buttons dark');
  await page.screenshot({ path: '/tmp/shot_inputdisplay.png' });
  for (const k of ['KeyZ', 'ArrowUp', 'KeyO', 'KeyL']) await page.keyboard.up(k);
  await page.waitForTimeout(100);
  ok(await page.$('.pad-btn.down') === null, 'display clears when keys are released');

  // Configuration dialog shows real bindings for each player
  await page.click('[data-menu="input"]');
  await page.click('[data-action="configure-p2"]');
  await page.waitForTimeout(100);
  const p2Title = await page.$eval('#input-title', e => e.textContent);
  const p2Rows = await page.$$eval('#input-config-table tr', rows => rows.map(r => r.children[0].textContent + ' ' + r.children[1].textContent));
  ok(p2Title === 'Configure Controller 2', 'Controller 2 menu item opens the Controller 2 dialog', p2Title);
  ok(p2Rows.includes('A: O') && p2Rows.includes('Up: I'), 'Controller 2 dialog lists its real bindings', p2Rows);
  await page.click('#tab-p1');
  const p1Rows = await page.$$eval('#input-config-table tr', rows => rows.map(r => r.children[0].textContent + ' ' + r.children[1].textContent));
  ok(p1Rows.includes('A: Z') && p1Rows.includes('Up: Up'), 'Controller 1 tab lists Player 1 bindings', p1Rows);
  await page.click('#tab-p2');
  // Rebind Player 2 A to Q
  await page.click('#input-config-table tr:nth-child(1) button');
  await page.keyboard.press('KeyQ');
  await page.waitForTimeout(100);
  const rowA = await page.$eval('#input-config-table tr:nth-child(1)', r => r.children[0].textContent + ' ' + r.children[1].textContent);
  ok(rowA === 'A: Q', 'dialog shows the new binding right after changing it', rowA);
  const map2 = await emu(() => window.__turtlenesUI.keymaps[2]);
  ok(map2.KeyQ === 'A' && map2.KeyO === undefined, 'internal keymap holds the new binding', map2);
  const padLabel = await page.$eval('.pad-btn[data-player="2"][data-button="A"] small', e => e.textContent);
  ok(padLabel === 'Q', 'input display label follows the new binding', padLabel);
  await page.keyboard.down('KeyQ');
  await page.waitForTimeout(80);
  ok(await emu(() => window.__turtlenes.controller2.buttonState & 1) === 1, 'new key drives the game input for Player 2');
  await page.keyboard.up('KeyQ');
  await page.keyboard.down('KeyO');
  await page.waitForTimeout(80);
  ok(await emu(() => window.__turtlenes.controller2.buttonState & 1) === 0, 'old key no longer drives Player 2 A');
  await page.keyboard.up('KeyO');
  // Reopen from scratch: still shows the new binding (no stale copy)
  await page.click('[data-close="dlg-input"]');
  await page.click('[data-menu="input"]');
  await page.click('[data-action="configure-p2"]');
  const rowA2 = await page.$eval('#input-config-table tr:nth-child(1)', r => r.children[1].textContent);
  ok(rowA2 === 'Q', 'reopened dialog still shows the saved binding', rowA2);
  await page.screenshot({ path: '/tmp/shot_inputconfig.png' });
  await page.click('#input-defaults');
  const rowA3 = await page.$eval('#input-config-table tr:nth-child(1)', r => r.children[1].textContent);
  ok(rowA3 === 'O', 'Defaults restores the original binding', rowA3);
  await page.click('[data-close="dlg-input"]');

  // ---- Audio menu ----
  const audioItems = await page.$$eval('#menu-audio .dropdown-item[data-action]', els => els.map(e => e.textContent.trim()));
  ok(audioItems.length === 1 && audioItems[0] === 'Mute Audio', 'audio menu has one control: Mute Audio', audioItems);
  await page.waitForTimeout(1300);
  const audioOn = await page.$eval('#status-audio', e => e.textContent);
  ok(audioOn === 'Audio: On', 'audio starts playing after a user gesture', audioOn);
  const sources1 = await emu(() => window.__audioSources);
  await page.waitForTimeout(500);
  const sources2 = await emu(() => window.__audioSources);
  ok(sources2 - sources1 >= 15, `APU samples are scheduled to Web Audio (${sources2 - sources1} buffers in 0.5s)`);
  await page.click('[data-menu="audio"]');
  await page.click('[data-action="toggle-mute"]');
  await page.waitForTimeout(100);
  ok((await page.$eval('#status-audio', e => e.textContent)) === 'Audio: Muted', 'status bar shows muted state');
  await page.click('[data-menu="audio"]');
  ok(await page.$eval('[data-action="toggle-mute"] .chk', e => e.classList.contains('on')), 'menu item shows a check while muted');
  const s3 = await emu(() => window.__audioSources);
  await page.waitForTimeout(400);
  ok((await emu(() => window.__audioSources)) === s3, 'no audio is scheduled while muted');
  await page.click('[data-action="toggle-mute"]');
  await page.waitForTimeout(100);
  ok((await page.$eval('#status-audio', e => e.textContent)) === 'Audio: On', 'unmuting restores audio');

  // ---- Save / load feedback, no file pickers ----
  await page.evaluate(() => window.__turtlenes.pause());
  const cycles0 = await emu(() => window.__turtlenes.cpu.totalCycles);
  await page.keyboard.press('F5');
  let msg = await page.$eval('#status-msg', e => e.textContent);
  ok(/^State saved at /.test(msg), 'F5 reports "State saved" in the status bar', msg);
  ok(/^State: \d/.test(await page.$eval('#status-state', e => e.textContent)), 'status bar shows the slot timestamp');
  ok(await page.$eval('#screen-toast', e => e.style.display === 'block'), 'on-screen note appears for the save');
  await page.evaluate(() => { const e = window.__turtlenes; e.play(); for (let i = 0; i < 12; i++) e.runFrame(); e.pause(); });
  const cycles1 = await emu(() => window.__turtlenes.cpu.totalCycles);
  ok(cycles1 > cycles0, 'game state changed after saving');
  await page.keyboard.press('F5');
  msg = await page.$eval('#status-msg', e => e.textContent);
  ok(/^State overwritten at /.test(msg), 'saving again reports "State overwritten"', msg);
  // put the slot back to the original state for the round trip: reload cycle count 0 state
  await page.evaluate(() => { window.__turtlenes.loadState(window.__savedRef = null || window.__turtlenes.saveState()); });
  await page.keyboard.press('F7');
  msg = await page.$eval('#status-msg', e => e.textContent);
  ok(/^State loaded \(saved at /.test(msg), 'F7 reports "State loaded"', msg);
  ok((await emu(() => window.__turtlenes.cpu.totalCycles)) === cycles1, 'loading returns emulation to the saved state');
  await page.click('[data-menu="file"]');
  await page.click('[data-action="delete-state"]');
  msg = await page.$eval('#status-msg', e => e.textContent);
  ok(msg === 'Saved state deleted', 'delete reports what happened', msg);
  ok((await page.$eval('#status-state', e => e.textContent)) === 'State: empty', 'slot indicator shows empty after delete');
  await page.keyboard.press('F7');
  msg = await page.$eval('#status-msg', e => e.textContent);
  ok(msg === 'No saved state for this ROM', 'loading an empty slot says so', msg);
  ok(chooserCount === 0 && downloadCount === 0, 'save, load and delete never open a file picker or download', { chooserCount, downloadCount });

  // ---- Export and import files ----
  await page.evaluate(() => { const e = window.__turtlenes; e.play(); for (let i = 0; i < 20; i++) e.runFrame(); e.pause(); });
  await page.keyboard.press('F5'); // "original" state
  const originalCycles = await emu(() => window.__turtlenes.cpu.totalCycles);
  await page.evaluate(() => { const e = window.__turtlenes; e.play(); for (let i = 0; i < 25; i++) e.runFrame(); e.pause(); });
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    (async () => { await page.click('[data-menu="file"]'); await page.click('[data-action="export-state"]'); })(),
  ]);
  const exportPath = path.join(os.tmpdir(), 'export_test.tnesstate');
  await download.saveAs(exportPath);
  ok(download.suggestedFilename() === 'nestest.tnesstate', 'export downloads a .tnesstate file', download.suggestedFilename());
  const exported = JSON.parse(fs.readFileSync(exportPath, 'utf8'));
  ok(exported.format === 'TurtleNES-State' && typeof exported.romKey === 'string', 'exported file carries format and ROM identity');
  ok(['cpu', 'ppu', 'apu', 'bus', 'mapper', 'prgRam', 'controllers'].every(k => k in exported), 'exported file holds CPU, PPU, APU, memory, mapper, PRG RAM and controller state');
  ok(chooserCount === 0, 'export does not use a file chooser');
  await page.evaluate(() => { const e = window.__turtlenes; e.play(); for (let i = 0; i < 30; i++) e.runFrame(); e.pause(); });
  ok((await emu(() => window.__turtlenes.cpu.totalCycles)) > originalCycles, 'game changed again after exporting');
  await page.setInputFiles('#state-input', exportPath);
  await page.waitForTimeout(300);
  msg = await page.$eval('#status-msg', e => e.textContent);
  ok(/^Save state imported from export_test\.tnesstate/.test(msg), 'import reports success', msg);
  ok((await emu(() => window.__turtlenes.cpu.totalCycles)) === originalCycles, 'importing returns the emulator to the exported state');

  // Wrong ROM is refused
  const otherRom = makeRom('other_rom.nes', { marker: 0xea });
  await page.setInputFiles('#file-input', otherRom);
  await page.waitForTimeout(400);
  await page.setInputFiles('#state-input', exportPath);
  await page.waitForTimeout(300);
  const errText = await page.$eval('#error-message', e => e.textContent);
  ok(await page.$eval('#dlg-error', e => getComputedStyle(e).display !== 'none') && /different ROM/.test(errText), 'state from another ROM is refused with a clear error', errText);
  await page.click('[data-close="dlg-error"]');
  // invalid file
  const junk = path.join(os.tmpdir(), 'junk.tnesstate');
  fs.writeFileSync(junk, 'this is not a state');
  await page.setInputFiles('#state-input', junk);
  await page.waitForTimeout(200);
  ok(/not a valid TurtleNES save state/.test(await page.$eval('#error-message', e => e.textContent)), 'garbage state file gives a clear error');
  await page.click('[data-close="dlg-error"]');

  // ---- Recent ROMs ----
  await page.click('[data-menu="file"]');
  await page.hover('[data-sub="sub-recent"]');
  const recentItems = await page.$$eval('#sub-recent .recent-item', els => els.map(e => e.textContent));
  ok(recentItems.length >= 2 && recentItems[0].startsWith('other_rom.nes') && recentItems.some(t => t.startsWith('nestest.nes') && /Mapper 000/.test(t)),
    'Open Recent lists ROMs newest first with mapper info', recentItems);
  await page.screenshot({ path: '/tmp/shot_recent.png' });
  await page.click('#sub-recent .recent-item:nth-child(2)');
  await page.waitForTimeout(500);
  const recentMsgVisible = await page.$eval('#dlg-message', e => getComputedStyle(e).display !== 'none');
  const recentMsg = await page.$eval('#msg-text', e => e.textContent);
  const reopened = await page.$eval('#status-rom', e => e.textContent);
  ok((recentMsgVisible && /select the file again/.test(recentMsg)) || reopened === 'nestest.nes',
    'recent entry either reopens or honestly asks to select the file again', { recentMsg, reopened });
  if (recentMsgVisible) await page.click('#msg-cancel');
  await page.setInputFiles('#file-input', nestest);
  await page.waitForTimeout(500);

  // ---- Filters ----
  for (const f of ['linear', 'scanlines', 'crt', 'nearest']) {
    await page.click('[data-menu="video"]');
    await page.hover('[data-sub="sub-filter"]');
    await page.click(`[data-action="filter"][data-value="${f}"]`);
    const info = await page.evaluate(() => {
      const c = document.getElementById('screen');
      const fx = document.getElementById('screen-fx');
      return { attr: document.getElementById('screen-stage').dataset.filter,
        rendering: getComputedStyle(c).imageRendering, filter: getComputedStyle(c).filter,
        fx: getComputedStyle(fx).display };
    });
    ok(info.attr === f, `filter ${f} applied`, info);
    if (f === 'nearest') ok(/pixelated|crisp/.test(info.rendering) && info.fx === 'none', 'nearest keeps crisp pixels and no overlay', info);
    if (f === 'linear') ok(info.rendering === 'auto' && info.fx === 'none', 'linear uses smooth scaling', info);
    if (f === 'scanlines') ok(/pixelated|crisp/.test(info.rendering) && info.fx === 'block', 'scanlines keep crisp pixels with overlay', info);
    if (f === 'crt') ok(info.fx === 'block' && /contrast/.test(info.filter), 'crt uses overlay and colour filter', info);
    if (f === 'crt') await page.screenshot({ path: '/tmp/shot_crt.png' });
  }

  // ---- Speed ----
  async function measureFps(ms) {
    const f0 = await emu(() => window.__turtlenes.ppu.frameCount);
    await page.waitForTimeout(ms);
    const f1 = await emu(() => window.__turtlenes.ppu.frameCount);
    return (f1 - f0) * 1000 / ms;
  }
  await page.evaluate(() => window.__turtlenes.play());
  const fps1 = await measureFps(1500);
  ok(fps1 > 50 && fps1 < 70, `1x runs at about 60 fps (${fps1.toFixed(1)})`);
  for (const [val, lo, hi] of [[2, 100, 140], [0.5, 22, 38], [4, 190, 270]]) {
    await page.click('[data-menu="emulation"]');
    await page.hover('[data-sub="sub-speed"]');
    await page.click(`[data-action="speed"][data-value="${val}"]`);
    await page.waitForTimeout(300);
    const fps = await measureFps(1500);
    ok(fps > lo && fps < hi, `${val}x changes real emulation rate (${fps.toFixed(1)} fps)`);
    if (val === 2) ok((await page.$eval('#status-audio', e => e.textContent)) === 'Audio: Off (speed)', 'audio is switched off at non-1x speed and the status says so');
  }
  await page.click('[data-menu="emulation"]');
  await page.hover('[data-sub="sub-speed"]');
  await page.click('[data-action="speed"][data-value="1"]');
  await page.waitForTimeout(1500);
  ok((await page.$eval('#status-audio', e => e.textContent)) === 'Audio: On', 'audio returns at 1x');

  // ---- Rewind ----
  await page.waitForTimeout(2000);
  const rc = await emu(() => window.__turtlenes.cpu.totalCycles);
  await page.keyboard.down('Backspace');
  await page.waitForTimeout(600);
  await page.keyboard.up('Backspace');
  const rc2 = await emu(() => window.__turtlenes.cpu.totalCycles);
  ok(rc2 < rc, 'holding Backspace rewinds emulation', { rc, rc2 });
  await page.waitForTimeout(500);
  ok(await emu(() => window.__turtlenes.running), 'emulation resumes after releasing Backspace');
  await page.click('[data-menu="emulation"]');
  await page.click('[data-action="open-rewind"]');
  await page.waitForTimeout(400);
  ok(/snapshots/.test(await page.$eval('#rewind-info', e => e.textContent)), 'rewind window reports buffer contents');
  await page.click('[data-close="dlg-rewind"]');

  // ---- Cheats ----
  await page.click('[data-menu="emulation"]');
  await page.click('[data-action="open-cheats"]');
  await page.fill('#cheat-code', '8000:01');
  await page.click('#cheat-add');
  ok(/work RAM/.test(await page.$eval('#cheat-error', e => e.textContent)), 'bad cheat address gives a clear message');
  await page.fill('#cheat-code', '0300:5A');
  await page.fill('#cheat-label', 'test byte');
  await page.click('#cheat-add');
  await page.waitForTimeout(300);
  ok(await emu(() => window.__turtlenes.bus.ram[0x300]) === 0x5a, 'active cheat writes RAM each frame');
  ok((await page.$$('#cheat-list .cheat-row')).length === 1, 'cheat is listed');
  await page.click('#cheat-list .cheat-row input');
  await page.evaluate(() => { window.__turtlenes.bus.ram[0x300] = 0; });
  await page.waitForTimeout(200);
  ok(await emu(() => window.__turtlenes.bus.ram[0x300]) === 0, 'disabled cheat stops writing');
  await page.click('#cheat-list .cheat-row button');
  ok((await page.$$('#cheat-list .cheat-row')).length === 0, 'cheat removed');
  await page.click('[data-close="dlg-cheats"]');

  // ---- CPU compatibility ----
  await page.click('[data-menu="emulation"]');
  await page.click('[data-action="open-cpucompat"]');
  ok(await page.$eval('#cpu-official', e => e.checked), 'official opcodes are selected by default');
  await page.click('#cpu-unofficial');
  await page.click('#cpu-apply');
  ok(await emu(() => window.__turtlenes.cpu.unofficialOpcodesEnabled) === true, 'undocumented opcodes can be enabled from the dialog');
  await page.click('[data-menu="emulation"]');
  await page.click('[data-action="open-cpucompat"]');
  await page.click('#cpu-official');
  await page.click('#cpu-apply');
  ok(await emu(() => window.__turtlenes.cpu.unofficialOpcodesEnabled) === false, 'and switched back off');

  // ---- Fullscreen geometry ----
  await page.evaluate(() => window.__turtlenes.play());
  await page.click('#tb-fullscreen');
  await page.waitForTimeout(700);
  const isFs = await page.evaluate(() => document.fullscreenElement && document.fullscreenElement.id);
  ok(isFs === 'screen-wrap', 'fullscreen enters on the screen wrapper', isFs);
  if (isFs === 'screen-wrap') {
    const geo = async (mode) => {
      await page.evaluate((m) => {
        document.querySelector(`[data-action="fsmode"][data-value="${m}"]`).click();
      }, mode);
      await page.waitForTimeout(250);
      return page.evaluate(() => {
        const r = document.getElementById('screen-stage').getBoundingClientRect();
        const c = document.getElementById('screen').getBoundingClientRect();
        return { x: r.left, y: r.top, w: r.width, h: r.height, cw: c.width, ch: c.height, W: innerWidth, H: innerHeight };
      });
    };
    const near = (a, b, t = 1.5) => Math.abs(a - b) <= t;
    for (const mode of ['normal', 'square', 'aspect', 'fill']) {
      const g = await geo(mode);
      const centered = near(g.x, (g.W - g.w) / 2) && near(g.y, (g.H - g.h) / 2);
      ok(centered, `fullscreen ${mode}: picture is centered, not at 0,0`, g);
      ok(g.x > 0 || g.y > 0 || mode === 'fill', `fullscreen ${mode}: not pinned to the top-left`, g);
      ok(near(g.cw, g.w) && near(g.ch, g.h), `fullscreen ${mode}: canvas fills the stage`, g);
      if (mode === 'normal') ok(near(g.w, 512) && near(g.h, 480), 'normal uses the current 2x scale', g);
      if (mode === 'square') ok(g.w % 256 === 0 && near(g.w / 256, g.h / 240, 0.001), 'square uses a whole-number multiple', g);
      if (mode === 'aspect') ok(near(g.w / g.h, 256 / 240, 0.01) && (near(g.w, g.W) || near(g.h, g.H)), 'aspect keeps 256:240 and is as large as possible', g);
      if (mode === 'fill') ok(near(g.w, g.W) && near(g.h, g.H), 'fill covers the whole screen', g);
      await page.screenshot({ path: `/tmp/shot_fs_${mode}.png` });
    }
    await page.keyboard.press('F11');
    await page.waitForTimeout(500);
    ok(await page.evaluate(() => !document.fullscreenElement), 'F11 leaves fullscreen');
    const win = await page.evaluate(() => { const r = document.getElementById('screen-stage').getBoundingClientRect(); return [r.width, r.height]; });
    ok(win[0] === 512 && win[1] === 480, 'windowed size returns to the chosen scale', win);
  }

  // ---- Unsupported mapper dialog still works (mapper 5) and lists new mappers ----
  await page.setInputFiles('#file-input', makeRom('mapper5.nes', { mapper: 5 }));
  await page.waitForTimeout(400);
  const un = await page.$eval('#error-message', e => e.textContent);
  ok(/Unsupported mapper: 5/.test(un) && /7 \(AxROM\)/.test(un) && /9 \(MMC2\)/.test(un) && /11 \(Color Dreams\)/.test(un), 'unsupported mapper error is clear and lists supported mappers', un);
  await page.screenshot({ path: '/tmp/shot_unsupported.png' });
  await page.click('[data-close="dlg-error"]');

  // ---- Debugger still works ----
  await page.click('[data-menu="tools"]');
  await page.click('[data-action="open-debugger"]');
  await page.waitForTimeout(200);
  ok(/^[0-9A-F]{4}$/.test(await page.$eval('#reg-pc', e => e.textContent)), 'debugger still shows registers');

  // ---- Documentation link ----
  const [docPage] = await Promise.all([
    context.waitForEvent('page'),
    (async () => { await page.click('[data-menu="help"]'); await page.click('[data-action="open-docs"]'); })(),
  ]);
  await docPage.waitForLoadState();
  ok(/TurtleNES Documentation/.test(await docPage.title()), 'Help > Documentation opens the built-in docs page');
  ok(!/README/.test(await docPage.$eval('body', e => e.textContent)), 'docs page does not tell web users to open a README file');
  await docPage.close();

  ok(errors.length === 0, 'no console or page errors during the whole run', errors);
  await browser.close();
  console.log(failures === 0 ? '\nALL BROWSER v1.1 TESTS PASSED' : `\n${failures} BROWSER TEST(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('TEST CRASH', e); process.exit(2); });
