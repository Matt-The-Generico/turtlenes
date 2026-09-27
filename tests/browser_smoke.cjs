const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

(async () => {
  const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell',
    args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-webgl', '--autoplay-policy=no-user-gesture-required'],
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push('pageerror: ' + err.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push('console.error: ' + msg.text());
  });

  await page.goto('http://127.0.0.1:8934/index.html', { waitUntil: 'load' });
  await page.waitForTimeout(300);

  // Inject nestest.nes as if the user selected it via the file input.
  const romPath = path.join(__dirname, 'nestest.nes');
  const fileInput = await page.$('#file-input');
  await fileInput.setInputFiles(romPath);
  await page.waitForTimeout(500);

  // Check the "no ROM" screen is gone and the canvas is now visible.
  const screenVisible = await page.$eval('#screen-wrap', el => getComputedStyle(el).display !== 'none');
  const statusText = await page.$eval('#status-rom', el => el.textContent);
  const mapperText = await page.$eval('#status-mapper', el => el.textContent);

  // Let it run for ~2 seconds of real time (should be well over 60 frames).
  await page.waitForTimeout(2000);

  const frameCount = await page.evaluate(() => window.__turtlenes.ppu.frameCount);
  const cpuJammed = await page.evaluate(() => window.__turtlenes.cpu.jammed);
  const nonBlackPixels = await page.evaluate(() => {
    const fb = window.__turtlenes.ppu.framebuffer;
    let n = 0;
    for (let i = 0; i < fb.length; i += 4) if (fb[i] || fb[i+1] || fb[i+2]) n++;
    return n;
  });

  // Exercise the menu system: open File menu, open Tools > Debugger, step once.
  await page.click('[data-menu="tools"]');
  await page.click('[data-action="open-debugger"]');
  await page.waitForTimeout(100);
  const debuggerVisible = await page.$eval('#dlg-debugger', el => getComputedStyle(el).display !== 'none');
  const pcText = await page.$eval('#reg-pc', el => el.textContent);
  await page.click('#dbg-step');
  await page.waitForTimeout(300);
  const pcTextAfterStep = await page.$eval('#reg-pc', el => el.textContent);
  const runningAfterStep = await page.evaluate(() => window.__turtlenes.running);
  await page.click('#dbg-step');
  await page.waitForTimeout(300);
  const pcTextAfterStep2 = await page.$eval('#reg-pc', el => el.textContent);

  // Exercise pattern table viewer
  await page.click('[data-close="dlg-debugger"]');
  await page.click('[data-menu="tools"]');
  await page.click('[data-action="open-patterntables"]');
  await page.waitForTimeout(100);
  const ptVisible = await page.$eval('#dlg-patterntables', el => getComputedStyle(el).display !== 'none');

  // Exercise reset via toolbar
  await page.click('#tb-reset');
  await page.waitForTimeout(100);

  console.log(JSON.stringify({
    screenVisible, statusText, mapperText, frameCount, cpuJammed, nonBlackPixels,
    debuggerVisible, pcText, pcTextAfterStep, pcTextAfterStep2, runningAfterStep, ptVisible,
    jsErrors: errors,
  }, null, 2));

  await browser.close();
  process.exit(errors.length > 0 ? 1 : 0);
})();
