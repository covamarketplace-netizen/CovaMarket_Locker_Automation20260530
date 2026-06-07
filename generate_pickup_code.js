/**
 * generate_pickup_code.js
 * Automates XYZ Vending UI to generate a 6-digit pickup code
 * Uses Puppeteer (headless Chrome) + Tesseract OCR for CAPTCHA solving
 *
 * Usage:
 *   node generate_pickup_code.js
 *   Returns: { pickCode: "319508", orderNo: "202605..." }
 */

const puppeteer = require('puppeteer');
const tesseract = require('node-tesseract-ocr');
const fs        = require('fs');

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const CONFIG = {
  url:      '[xzyvend.com](http://xzyvend.com)',
  username: process.env.XYZ_USERNAME || '0108668014',
  password: process.env.XYZ_PASSWORD,
  device:   process.env.XYZ_DEVICE   || '默认设备',
  quantity: process.env.XYZ_QUANTITY || '1',
  timeout:  30000,
};
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Solve CAPTCHA using Tesseract OCR.
 * Screenshots the CAPTCHA element, runs OCR, retries up to 3x by clicking
 * the image to refresh if the result is too short.
 */
async function solveCaptcha(page) {
  const tesseractConfig = {
    lang: 'eng',
    oem:  1,  // LSTM neural net engine
    psm:  8,  // Treat image as a single word
    tessedit_char_whitelist:
      '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz',
  };

  for (let attempt = 1; attempt <= 3; attempt++) {
    console.log(`🧩 CAPTCHA solve attempt ${attempt}/3...`);

    // Locate CAPTCHA image element
    const captchaEl = await page.$(
      'img[src*="captcha"], img[src*="verify"], img[src*="code"], ' +
      '[class*="captcha"] img, [class*="verify"] img, canvas'
    );

    if (!captchaEl) {
      console.log('  ℹ️  No CAPTCHA element found — skipping');
      return null;
    }

    // Screenshot just the CAPTCHA element (not full page)
    await captchaEl.screenshot({ path: 'captcha.png' });
    console.log('  📸 CAPTCHA screenshot captured');

    // Run Tesseract OCR
    const raw     = await tesseract.recognize('captcha.png', tesseractConfig);
    const cleaned = raw.replace(/\s+/g, '').trim();
    console.log(`  🔍 OCR raw: "${raw.trim()}" → cleaned: "${cleaned}"`);

    if (cleaned.length >= 4) {
      console.log(`  ✅ CAPTCHA solved: "${cleaned}"`);
      return cleaned;
    }

    // Too short — refresh CAPTCHA by clicking it and retry
    console.log('  ⚠️  Result too short, refreshing CAPTCHA...');
    await captchaEl.click();
    await page.waitForTimeout(1200);
  }

  throw new Error(
    'Tesseract OCR failed to read CAPTCHA after 3 attempts. ' +
    'Download captcha.png from the Actions artifacts to inspect.'
  );
}

async function generatePickupCode() {
  console.log('🚀 Launching browser...');

  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage', // required for GitHub Actions
      '--disable-gpu',
    ],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });

  // Suppress noisy browser console output
  page.on('console', () => {});

  try {
    // ── STEP 1: Load login page ───────────────────────────────────────────────
    console.log('🔐 Navigating to login page...');
    await page.goto(CONFIG.url, { waitUntil: 'networkidle2', timeout: CONFIG.timeout });

    // Wait for login form to appear
    await page.waitForSelector(
      'input[placeholder="Account Number"], input[placeholder*="账号"], input[type="text"]',
      { timeout: CONFIG.timeout }
    );

    // ── Fill username ─────────────────────────────────────────────────────────
    const usernameInput =
      (await page.$('input[placeholder="Account Number"]')) ||
      (await page.$('input[placeholder*="账号"]'))          ||
      (await page.$('input[type="text"]'));

    if (!usernameInput) throw new Error('Username input not found on login page');
    await usernameInput.click({ clickCount: 3 });
    await usernameInput.type(CONFIG.username);

    // ── Fill password ─────────────────────────────────────────────────────────
    const passwordInput = await page.$('input[type="password"]');
    if (!passwordInput) throw new Error('Password input not found on login page');
    await passwordInput.click({ clickCount: 3 });
    await passwordInput.type(CONFIG.password);

    // ── Handle CAPTCHA if present ─────────────────────────────────────────────
    const captchaInput = await page.$(
      'input[placeholder="Verification Code"], ' +
      'input[placeholder*="验证码"], '            +
      'input[placeholder*="Verification"]'
    );

    if (captchaInput) {
      console.log('🧩 CAPTCHA field detected...');
      const captchaText = await solveCaptcha(page);
      if (captchaText) {
        await captchaInput.click({ clickCount: 3 });
        await captchaInput.type(captchaText);
        console.log(`✏️  Typed CAPTCHA: "${captchaText}"`);
      }
    } else {
      console.log('ℹ️  No CAPTCHA field — proceeding without it');
    }

    // ── Click Sign In ─────────────────────────────────────────────────────────
    const loginBtn =
      (await page.$('button[type="submit"]')) ||
      (await page.$('.login-btn'))             ||
      (await page.$('button'));

    if (!loginBtn) throw new Error('Login button not found');
    await loginBtn.click();
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: CONFIG.timeout });
    console.log('✅ Logged in successfully');

    // ── STEP 2: Navigate to 取货码管理 (Pickup Code Management) ───────────────
    console.log('📍 Navigating to pickup code management...');

    // Click 交易管理 (Transaction Management) in sidebar
    await page.evaluate(() => {
      const items = [...document.querySelectorAll('li, .menu-item, span, div')];
      const target = items.find(el => el.textContent.trim() === '交易管理');
      if (target) target.click();
    });
    await page.waitForTimeout(1000);

    // Click 取货码管理 (Pickup Code Management)
    await page.evaluate(() => {
      const items = [...document.querySelectorAll('li, .menu-item, span, div, a')];
      const target = items.find(el => el.textContent.trim() === '取货码管理');
      if (target) target.click();
    });
    await page.waitForTimeout(1500);
    console.log('✅ On pickup code management page');

    // ── STEP 3: Click 添加 (Add) button ──────────────────────────────────────
    console.log('➕ Clicking Add button...');
    await page.evaluate(() => {
      const btns   = [...document.querySelectorAll('button, .el-button')];
      const addBtn = btns.find(b => b.textContent.trim() === '添加');
      if (addBtn) addBtn.click();
    });
    await page.waitForTimeout(1500);

    // ── STEP 4: Select 随机生成 (Random Generate) radio ──────────────────────
    console.log('🎲 Selecting Random Generate mode...');
    await page.evaluate(() => {
      const labels = [...document.querySelectorAll('label, span, .el-radio__label')];
      const random = labels.find(el => el.textContent.trim() === '随机生成');
      if (random) random.click();
    });
    await page.waitForTimeout(800);

    // ── STEP 5: Select device from dropdown ──────────────────────────────────
    console.log(`📦 Selecting device: ${CONFIG.device}...`);

    // Open the device dropdown
    await page.evaluate(() => {
      const inputs      = [...document.querySelectorAll('.el-select .el-input__inner')];
      const deviceInput = inputs.find(el => el.placeholder?.includes('设备'));
      if (deviceInput) deviceInput.click();
    });
    await page.waitForTimeout(800);

    // Click the matching device option
    await page.evaluate((deviceName) => {
      const options = [...document.querySelectorAll('.el-select-dropdown__item')];
      const option  = options.find(el => el.textContent.includes(deviceName));
      if (option) option.click();
    }, CONFIG.device);
    await page.waitForTimeout(800);

    // ── STEP 6: Set quantity ──────────────────────────────────────────────────
    console.log(`🔢 Setting quantity to ${CONFIG.quantity}...`);
    await page.evaluate((qty) => {
      const inputs   = [...document.querySelectorAll('input')];
      const qtyInput = inputs.find(el =>
        el.placeholder?.includes('数量') ||
        el.placeholder?.includes('quantity')
      );
      if (qtyInput) {
        qtyInput.value = '';
        qtyInput.dispatchEvent(new Event('input',  { bubbles: true }));
        qtyInput.value = qty;
        qtyInput.dispatchEvent(new Event('input',  { bubbles: true }));
        qtyInput.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }, CONFIG.quantity);
    await page.waitForTimeout(500);

    // ── STEP 7: Click 确定 (Confirm) in dialog ────────────────────────────────
    console.log('📨 Submitting form...');
    await page.evaluate(() => {
      const btns = [...document.querySelectorAll('button, .el-button')];
      // Target the 确定 button specifically inside the dialog footer
      const confirmBtn = btns.filter(b =>
        b.textContent.trim() === '确定' &&
        b.closest('.el-dialog, .el-dialog__footer, [class*="dialog"]')
      ).pop(); // .pop() gets the last match (innermost dialog button)
      if (confirmBtn) confirmBtn.click();
    });
    await page.waitForTimeout(2000);

    // ── STEP 8: Extract the generated pickup code from table ──────────────────
    console.log('🔍 Extracting pickup code from table...');

    const result = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('table tbody tr, .el-table__row')];
      if (!rows.length) return null;

      // Most recent entry is at the top (row 0)
      const cells     = [...rows[0].querySelectorAll('td')];
      const cellTexts = cells.map(c => c.textContent.trim());

      return {
        pickCode: cellTexts.find(t => /^\d{6}$/.test(t)),
        orderNo:  cellTexts.find(t => t.length > 15 && /^[0-9a-z]+$/i.test(t)),
        allCells: cellTexts,
      };
    });

    if (!result?.pickCode) {
      throw new Error(
        'Could not extract pickup code from table. ' +
        'All cells: ' + JSON.stringify(result?.allCells)
      );
    }

    console.log('');
    console.log('═══════════════════════════════════');
    console.log(`✅ PICKUP CODE : ${result.pickCode}`);
    console.log(`📋 ORDER NO   : ${result.orderNo}`);
    console.log('═══════════════════════════════════');
    console.log('');

    // Structured output — captured by the workflow
    const output = {
      success:     true,
      pickCode:    result.pickCode,
      orderNo:     result.orderNo,
      device:      CONFIG.device,
      generatedAt: new Date().toISOString(),
    };

    console.log('OUTPUT_JSON:' + JSON.stringify(output));
    return output;

  } catch (err) {
    console.error('❌ Error:', err.message);

    // Full-page screenshot for debugging
    await page.screenshot({ path: 'error_screenshot.png', fullPage: true });
    console.log('📸 Error screenshot saved → error_screenshot.png');

    const output = { success: false, error: err.message };
    console.log('OUTPUT_JSON:' + JSON.stringify(output));
    process.exit(1);

  } finally {
    await browser.close();
  }
}

generatePickupCode();
