/**
 * generate_pickup_code.js
 * Automates XYZ Vending UI to generate a 6-digit pickup code
 * Uses Puppeteer (headless Chrome) + Tesseract OCR for CAPTCHA solving
 * CAPTCHA strategy: wide crop + multi-preprocessing + majority vote
 */

const puppeteer = require('puppeteer');
const tesseract = require('node-tesseract-ocr');
const sharp     = require('sharp');
const fs        = require('fs');

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const CONFIG = {
  url:      'https://xzyvend.com/login',
  username: process.env.XYZ_USERNAME || '0108668014',
  password: process.env.XYZ_PASSWORD,
  device:   process.env.XYZ_DEVICE   || '默认设备',
  quantity: process.env.XYZ_QUANTITY || '1',
  timeout:  30000,
};
// ─────────────────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Capture CAPTCHA with generous padding so edge digits aren't clipped.
 * Also saves a debug copy so we can inspect what was captured.
 */
async function captureCaptcha(page) {
  const captchaEl = await page.$(
    'img.code-img-wrap, ' +
    'img[alt="点击刷新"], ' +
    'img[alt*="刷新"], '   +
    'img[alt*="验证"]'
  );

  if (!captchaEl) {
    const allImgs = await page.evaluate(() =>
      [...document.querySelectorAll('img')].map(i => ({
        src: i.src.substring(0, 80), className: i.className, alt: i.alt,
      }))
    );
    console.log('  ⚠️  No CAPTCHA img found. All imgs:', JSON.stringify(allImgs));
    throw new Error('Cannot find CAPTCHA image element.');
  }

  const box      = await captchaEl.boundingBox();
  const padding  = 10; // generous padding — never clip edge digits again
  const viewport = page.viewport();

  const clip = {
    x:      Math.max(0, box.x - padding),
    y:      Math.max(0, box.y - padding),
    width:  Math.min(viewport.width  - Math.max(0, box.x - padding), box.width  + padding * 2),
    height: Math.min(viewport.height - Math.max(0, box.y - padding), box.height + padding * 2),
  };

  await page.screenshot({ path: 'captcha_raw.png', clip });
  console.log(`  📸 Captured CAPTCHA (${Math.round(box.width)}×${Math.round(box.height)}) with ${padding}px padding`);

  // Upscale raw capture using lanczos3 — bigger = better OCR
  await sharp('captcha_raw.png')
    .resize(500, 180, { fit: 'fill', kernel: 'lanczos3' })
    .toFile('captcha.png');

  return captchaEl;
}

/**
 * Generate multiple preprocessed versions of the CAPTCHA image.
 * Each strategy targets a different visual characteristic.
 */
async function preprocessVariants(inputPath) {
  const variants = [];

  // Strategy 1: Greyscale + high contrast threshold
  await sharp(inputPath)
    .greyscale().normalise().threshold(100)
    .resize(500, 180, { fit: 'fill' })
    .toFile('captcha_v1.png');
  variants.push({ path: 'captcha_v1.png', name: 'threshold-100' });

  // Strategy 2: Softer threshold
  await sharp(inputPath)
    .greyscale().normalise().threshold(140)
    .resize(500, 180, { fit: 'fill' })
    .toFile('captcha_v2.png');
  variants.push({ path: 'captcha_v2.png', name: 'threshold-140' });

  // Strategy 3: Sharpen then threshold
  await sharp(inputPath)
    .greyscale().sharpen({ sigma: 2, m1: 0, m2: 3 }).normalise().threshold(120)
    .resize(500, 180, { fit: 'fill' })
    .toFile('captcha_v3.png');
  variants.push({ path: 'captcha_v3.png', name: 'sharpen-120' });

  // Strategy 4: Inverted (light digits on dark bg)
  await sharp(inputPath)
    .greyscale().normalise().negate().threshold(120)
    .resize(500, 180, { fit: 'fill' })
    .toFile('captcha_v4.png');
  variants.push({ path: 'captcha_v4.png', name: 'inverted-120' });

  // Strategy 5: No threshold, preserve gradients
  await sharp(inputPath)
    .greyscale().normalise()
    .resize(500, 180, { fit: 'fill' })
    .toFile('captcha_v5.png');
  variants.push({ path: 'captcha_v5.png', name: 'no-threshold' });

  // Strategy 6: Median blur to reduce noise, then threshold
  await sharp(inputPath)
    .greyscale().median(3).normalise().threshold(110)
    .resize(500, 180, { fit: 'fill' })
    .toFile('captcha_v6.png');
  variants.push({ path: 'captcha_v6.png', name: 'median-blur-110' });

  return variants;
}

/**
 * Run Tesseract on one image with multiple PSM modes.
 * Returns the best result — prefers exactly 4 digits.
 */
async function ocrImage(imagePath) {
  const psmModes = [7, 8, 6, 13];
  const results  = [];

  for (const psm of psmModes) {
    try {
      const raw     = await tesseract.recognize(imagePath, {
        lang:                    'eng',
        oem:                     1,
        psm,
        tessedit_char_whitelist: '0123456789',
      });
      const cleaned = raw.replace(/\s+/g, '').trim();
      if (cleaned.length >= 3) results.push(cleaned);
    } catch (_) {}
  }

  // Strongly prefer exactly 4-digit result
  return results.find(r => r.length === 4)
      || results.sort((a, b) => b.length - a.length)[0]
      || '';
}

/**
 * Majority-vote across all preprocessing variants.
 */
async function solveWithVoting() {
  const variants = await preprocessVariants('captcha.png');
  const votes    = {};

  for (const v of variants) {
    const text = await ocrImage(v.path);
    console.log(`  🔬 ${v.name} → "${text}"`);
    if (text) votes[text] = (votes[text] || 0) + 1;
  }

  console.log('  📊 Vote tally:', JSON.stringify(votes));
  if (!Object.keys(votes).length) return '';

  // Prefer 4-digit winner with most votes
  const fourDigit = Object.entries(votes)
    .filter(([k]) => k.length === 4)
    .sort((a, b) => b[1] - a[1])[0];

  if (fourDigit) return fourDigit[0];

  // Fall back to most votes regardless of length
  return Object.entries(votes).sort((a, b) => b[1] - a[1])[0][0];
}

/**
 * Main CAPTCHA solver with retry loop.
 * Detects "Verification code error!" dialog to confirm wrong answer
 * and refreshes before trying again — no wasted navigation timeouts.
 */
async function solveCaptcha(page) {
  for (let attempt = 1; attempt <= 6; attempt++) {
    console.log(`\n🧩 CAPTCHA attempt ${attempt}/6`);

    // Dismiss any open error dialog before doing anything
    const dismissed = await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button')]
        .find(b => ['Confirm', '确定', 'OK'].includes(b.textContent.trim()));
      if (btn) { btn.click(); return true; }
      return false;
    });
    if (dismissed) {
      console.log('  🔔 Dismissed error dialog');
      await sleep(600);
    }

    const captchaEl = await captureCaptcha(page);
    const winner    = await solveWithVoting();
    console.log(`  🏆 Winner: "${winner}"`);

    if (!winner || winner.length < 3) {
      console.log('  ⚠️  No confident result — refreshing CAPTCHA...');
      await captchaEl.click();
      await sleep(1500);
      continue;
    }

    // Fill in the CAPTCHA input
    const captchaInput = await page.$(
      'input[placeholder="Verification Code"], ' +
      'input[placeholder*="验证码"], '            +
      'input[placeholder*="Verification"]'
    );
    if (!captchaInput) throw new Error('CAPTCHA input field not found');

    await captchaInput.click({ clickCount: 3 });
    await captchaInput.type(winner);
    console.log(`  ✅ Typed CAPTCHA: "${winner}"`);

    // Click login button — but DON'T use waitForNavigation (it times out on wrong CAPTCHA)
    const loginBtn =
      (await page.$('button[type="submit"]')) ||
      (await page.$('.login-btn'))             ||
      (await page.$('button'));
    if (!loginBtn) throw new Error('Login button not found');

    await loginBtn.click();

    // Wait briefly, then check: did we navigate away OR get an error dialog?
    await sleep(3000);

    const currentUrl = page.url();
    const hasError   = await page.evaluate(() => {
      const dialog = document.querySelector('.el-message-box, .el-dialog');
      return dialog && dialog.textContent.includes('Verification code error');
    });

    if (hasError) {
      console.log(`  ❌ Wrong CAPTCHA ("${winner}") — retrying...`);
      // Refresh CAPTCHA for next attempt
      const el = await page.$(
        'img.code-img-wrap, img[alt="点击刷新"], img[alt*="刷新"], img[alt*="验证"]'
      );
      if (el) { await el.click(); await sleep(1500); }
      continue;
    }

    if (!currentUrl.includes('/login')) {
      console.log('  ✅ Login successful — navigated away from login page');
      return; // success — no need to return CAPTCHA text anymore
    }

    // Still on login page but no visible error — might be slow, wait more
    console.log('  ⏳ Still on login page, waiting...');
    await sleep(2000);

    const finalUrl = page.url();
    if (!finalUrl.includes('/login')) {
      console.log('  ✅ Login successful after extra wait');
      return;
    }

    console.log('  ⚠️  Unclear result — refreshing CAPTCHA and retrying...');
    const el = await page.$(
      'img.code-img-wrap, img[alt="点击刷新"], img[alt*="刷新"], img[alt*="验证"]'
    );
    if (el) { await el.click(); await sleep(1500); }
  }

  throw new Error('Login failed after 6 CAPTCHA attempts. Check captcha_raw.png / captcha_v*.png artifacts.');
}

// ─── MAIN ────────────────────────────────────────────────────────────────────

async function generatePickupCode() {
  console.log('🚀 Launching browser...');

  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ],
  });

  const page = await browser.newPage();
  // 2× device scale so screenshots are crisper
  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 2 });
  page.on('console', () => {});

  try {
    // ── STEP 1: Navigate & fill credentials ───────────────────────────────────
    console.log('🔐 Navigating to login page...');
    await page.goto(CONFIG.url, { waitUntil: 'networkidle2', timeout: CONFIG.timeout });

    await page.waitForSelector(
      'input[placeholder="Account Number"], input[placeholder*="账号"], input[type="text"]',
      { timeout: CONFIG.timeout }
    );

    const usernameInput =
      (await page.$('input[placeholder="Account Number"]')) ||
      (await page.$('input[placeholder*="账号"]'))          ||
      (await page.$('input[type="text"]'));
    if (!usernameInput) throw new Error('Username input not found');
    await usernameInput.click({ clickCount: 3 });
    await usernameInput.type(CONFIG.username);
    console.log('✏️  Typed username');

    const passwordInput = await page.$('input[type="password"]');
    if (!passwordInput) throw new Error('Password input not found');
    await passwordInput.click({ clickCount: 3 });
    await passwordInput.type(CONFIG.password);
    console.log('✏️  Typed password');

    // ── STEP 2: Solve CAPTCHA + Login (handled inside solveCaptcha) ───────────
    const captchaInput = await page.$(
      'input[placeholder="Verification Code"], ' +
      'input[placeholder*="验证码"], '            +
      'input[placeholder*="Verification"]'
    );
    if (captchaInput) {
      await solveCaptcha(page); // handles fill + click + retry loop internally
    } else {
      // No CAPTCHA — just click login
      const loginBtn =
        (await page.$('button[type="submit"]')) ||
        (await page.$('.login-btn'))             ||
        (await page.$('button'));
      if (!loginBtn) throw new Error('Login button not found');
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle2', timeout: CONFIG.timeout }),
        loginBtn.click(),
      ]);
    }

    console.log('✅ Logged in successfully');
    await page.screenshot({ path: 'after_login.png', fullPage: true });

    // ── STEP 3: Navigate to 取货码管理 ────────────────────────────────────────
    console.log('📍 Navigating to Transaction Management...');

    const menuItems = await page.evaluate(() =>
      [...document.querySelectorAll('li, .el-menu-item, .el-submenu__title, span, div, a')]
        .filter(el => { const t = el.textContent.trim(); return t.length > 1 && t.length < 20; })
        .map(el => ({ tag: el.tagName, text: el.textContent.trim(), className: el.className }))
        .slice(0, 60)
    );
    console.log('📋 Menu items:', JSON.stringify(menuItems, null, 2));

    await page.evaluate(() => {
      const items  = [...document.querySelectorAll('li, .el-submenu__title, .el-menu-item, span, div')];
      const target = items.find(el => el.childElementCount <= 3 && el.textContent.trim().includes('交易管理'));
      if (target) target.click();
    });
    await sleep(1500);
    await page.screenshot({ path: 'after_transaction_click.png', fullPage: true });

    await page.evaluate(() => {
      const items  = [...document.querySelectorAll('li, .el-menu-item, .el-submenu__title, span, div, a')];
      const target = items.find(el => el.childElementCount <= 3 && el.textContent.trim().includes('取货码管理'));
      if (target) target.click();
    });
    await sleep(2000);
    await page.screenshot({ path: 'pickup_code_page.png', fullPage: true });
    console.log('✅ On pickup code management page');

    // ── STEP 4: Click 添加 ────────────────────────────────────────────────────
    console.log('➕ Clicking Add button...');
    await page.evaluate(() => {
      const btns   = [...document.querySelectorAll('button, .el-button, a, div')];
      const addBtn = btns.find(b => b.textContent.trim().includes('添加'));
      if (addBtn) addBtn.click();
    });
    await sleep(1500);
    await page.screenshot({ path: 'after_add_click.png', fullPage: true });

    // ── STEP 5: Select 随机生成 ───────────────────────────────────────────────
    console.log('🎲 Selecting Random Generate mode...');
    await page.evaluate(() => {
      const labels = [...document.querySelectorAll('label, span, .el-radio__label, div')];
      const random = labels.find(el => el.textContent.trim().includes('随机生成'));
      if (random) random.click();
    });
    await sleep(800);

    // ── STEP 6: Select device ─────────────────────────────────────────────────
    console.log(`📦 Selecting device: ${CONFIG.device}...`);
    await page.evaluate(() => {
      const inputs      = [...document.querySelectorAll('.el-select .el-input__inner, input')];
      const deviceInput = inputs.find(el => el.placeholder?.includes('设备') || el.placeholder?.includes('device'));
      if (deviceInput) deviceInput.click();
    });
    await sleep(800);

    await page.evaluate((deviceName) => {
      const options = [...document.querySelectorAll('.el-select-dropdown__item, li')];
      const option  = options.find(el => el.textContent.includes(deviceName));
      if (option) option.click();
    }, CONFIG.device);
    await sleep(800);

    // ── STEP 7: Set quantity ──────────────────────────────────────────────────
    console.log(`🔢 Setting quantity to ${CONFIG.quantity}...`);
    await page.evaluate((qty) => {
      const inputs   = [...document.querySelectorAll('input')];
      const qtyInput = inputs.find(el => el.placeholder?.includes('数量') || el.placeholder?.includes('quantity'));
      if (qtyInput) {
        qtyInput.value = '';
        qtyInput.dispatchEvent(new Event('input',  { bubbles: true }));
        qtyInput.value = qty;
        qtyInput.dispatchEvent(new Event('input',  { bubbles: true }));
        qtyInput.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }, CONFIG.quantity);
    await sleep(500);
    await page.screenshot({ path: 'before_submit.png', fullPage: true });

    // ── STEP 8: Confirm dialog ────────────────────────────────────────────────
    console.log('📨 Submitting form...');
    await page.evaluate(() => {
      const btns       = [...document.querySelectorAll('button, .el-button')];
      const confirmBtn = btns.filter(b =>
        b.textContent.trim() === '确定' &&
        b.closest('.el-dialog, .el-dialog__footer, [class*="dialog"]')
      ).pop();
      if (confirmBtn) confirmBtn.click();
    });
    await sleep(3000);
    await page.screenshot({ path: 'after_submit.png', fullPage: true });

    // ── STEP 9: Extract pickup code ───────────────────────────────────────────
    console.log('🔍 Extracting pickup code from table...');

    const tableDebug = await page.evaluate(() => {
      const table = document.querySelector('.el-table__body, table');
      return table ? table.innerHTML.substring(0, 3000) : 'NO TABLE FOUND';
    });
    console.log('📋 Table HTML:', tableDebug);

    const result = await page.evaluate(() => {
      const rows = [
        ...document.querySelectorAll('.el-table__body tr'),
        ...document.querySelectorAll('table tbody tr'),
        ...document.querySelectorAll('.el-table__row'),
      ];
      if (!rows.length) return { error: 'no rows found' };
      const cells     = [...rows[0].querySelectorAll('td')];
      const cellTexts = cells.map(c => c.innerText?.trim() || c.textContent?.trim());
      return {
        pickCode: cellTexts.find(t => /^\d{6}$/.test(t)),
        orderNo:  cellTexts.find(t => t.length > 15 && /^[0-9a-z]+$/i.test(t)),
        allCells: cellTexts,
      };
    });

    console.log('📋 Table result:', JSON.stringify(result));

    if (!result?.pickCode) {
      throw new Error(
        'Could not extract pickup code from table. ' +
        'All cells: ' + JSON.stringify(result?.allCells) +
        ' Error: '    + (result?.error || 'none')
      );
    }

    console.log('');
    console.log('═══════════════════════════════════');
    console.log(`✅ PICKUP CODE : ${result.pickCode}`);
    console.log(`📋 ORDER NO   : ${result.orderNo}`);
    console.log('═══════════════════════════════════');
    console.log('');

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
