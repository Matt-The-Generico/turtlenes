const { chromium } = require('playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell',
    args: ['--no-sandbox'],
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push('pageerror: ' + err.message));

  await page.goto('http://127.0.0.1:8934/index.html', { waitUntil: 'load' });
  await page.waitForTimeout(200);

  // --- Unsupported mapper ---
  await page.$eval('#file-input', () => {}); // no-op, ensure element exists
  await (await page.$('#file-input')).setInputFiles(path.join(__dirname, 'fake_mapper23.nes'));
  await page.waitForTimeout(300);
  const errorDialogVisible1 = await page.$eval('#dlg-error', el => getComputedStyle(el).display !== 'none');
  const errorMsg1 = await page.$eval('#error-message', el => el.textContent);
  await page.click('[data-close="dlg-error"]');
  await page.waitForTimeout(100);

  // Confirm ROM was NOT loaded (screen should still show "no rom" state)
  const stillNoRom = await page.$eval('#no-rom-screen', el => getComputedStyle(el).display !== 'none');

  // --- Invalid / garbage file ---
  await (await page.$('#file-input')).setInputFiles(path.join(__dirname, 'garbage.nes'));
  await page.waitForTimeout(300);
  const errorDialogVisible2 = await page.$eval('#dlg-error', el => getComputedStyle(el).display !== 'none');
  const errorMsg2 = await page.$eval('#error-message', el => el.textContent);

  console.log(JSON.stringify({
    errorDialogVisible1, errorMsg1, stillNoRom,
    errorDialogVisible2, errorMsg2,
    jsErrors: errors,
  }, null, 2));

  await browser.close();
  process.exit(errors.length > 0 ? 1 : 0);
})();
