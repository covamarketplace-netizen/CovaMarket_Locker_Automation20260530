/**
 * generate_pickup_code.js
 * Automates XYZ Vending UI to generate a 6-digit pickup code
 * Uses Puppeteer (headless Chrome) + Tesseract OCR for CAPTCHA solving
 */

const puppeteer = require('puppeteer');
const tesseract = require('node-tesseract-ocr');
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

/**
 * Solve CAPTCHA using Tesseract OCR.
 * The CAPTCHA image uses a base64 inline src with class="code-img-wrap"
 */
async function solveCaptcha(page) {
  const tesseractConfig = {
    lang: 'eng',
    oem:  1,
    psm:  8,
    tessedit_char_whitelist: '0123456789',
  };

  for (let attempt = 1; attempt <= 3; attempt++) {
    console.log(`🧩 CAPTCHA solve attempt ${attempt}/3...`);

    // Target by class or alt attribute (base64 src won't match src* selectors)
    const captchaEl = await page.$(
      'img.code-img-wrap, ' +
      'img[alt="点击刷新"], ' +
      'img[alt*="刷新"], ' +
      'img[alt*="验证"]'
    );

    if (!captchaEl) {
      // Dump all img info for debugging
      const allImgs = await page.evaluate(() =>
        [...document.querySelectorAll('img')].map(i => ({
          src:       i.src.substring(0, 80), // trim base64
          className: i.className,
          alt:       i.alt,
          id:        i.id,
        }))
      );
      console.log('  ⚠️  No CAPTCHA img found. All imgs on page:');
      console.log(JSON.stringify(allImgs, null, 2));
      await page.screenshot({ path: 'captcha_debug.png', fullPage: true });
      throw new Error('Cannot find CAPTCHA image element. Check captcha_debug.png artifact.');
    }

    await captchaEl.screenshot({ path: 'captcha.png' });
    console.log('  📸 CAPTCHA screenshot captured');

    const raw     = await tesseract.recognize('captcha.png', tesseractConfig);
    const cleaned = raw.replace(/\s+/g, '').trim();
    console.log(`  🔍 OCR raw: "${raw.trim()}" → cleaned: "${cleaned}"`);

    if (cleaned.length >= 4) {
      console.log(`  ✅ CAPTCHA solved: "${cleaned}"`);
      return cleaned;
    }

    // Refresh CAPTCHA by clicking it
    console.log('  ⚠️  Result too short, refreshing CAPTCHA...');
    await captchaEl.click();
    await page.waitForTimeout(1200);
  }

  throw new Error('Tesseract OCR failed to read CAPTCHA after 3 attempts. Check captcha.png artifact.');
}

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
  await page.setViewport({ width: 1280, height: 800 });
  page.on('console', () => {});

  try {
    // ── STEP 1: Load login page ───────────────────────────────────────────────
    console.log('🔐 Navigating to login page...');
    await page.goto(CONFIG.url, { waitUntil: 'networkidle2', timeout: CONFIG.timeout });

    await page.screenshot({ path: 'login_page.png', fullPage: true });
    console.log('📸 Login page screenshot saved → login_page.png');

    // ── Fill username ─────────────────────────────────────────────────────────
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

    // ── Fill password ─────────────────────────────────────────────────────────
    const passwordInput = await page.$('input[type="password"]');
    if (!passwordInput) throw new Error('Password input not found');
    await passwordInput.click({ clickCount: 3 });
    await passwordInput.type(CONFIG.password);
    console.log('✏️  Typed password');

    // ── Handle CAPTCHA ────────────────────────────────────────────────────────
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

    // Screenshot before clicking login
    await page.screenshot({ path: 'before_login.png', fullPage: true });
    console.log('📸 Pre-login screenshot saved → before_login.png');

    // ── Click Sign In ─────────────────────────────────────────────────────────
    const loginBtn =
      (await page.$('button[type="submit"]')) ||
      (await page.$('.login-btn'))             ||
      (await page.$('button'));

    if (!loginBtn) throw new Error('Login button not found');

    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: CONFIG.timeout }),
      loginBtn.click(),
    ]);
    console.log('✅ Logged in successfully');

    await page.screenshot({ path: 'after_login.png', fullPage: true });
    console.log('📸 Post-login screenshot saved → after_login.png');

    // ── STEP 2: Navigate to 取货码管理 ────────────────────────────────────────
    console.log('📍 Navigating to pickup code management...');

    await page.evaluate(() => {
      const items = [...document.querySelectorAll('li, .menu-item, span, div')];
      const target = items.find(el => el.textContent.trim() === '交易管理');
      if (target) target.click();
    });
    await page.waitForTimeout(1000);

    await page.evaluate(() => {
      const items = [...document.querySelectorAll('li, .menu-item, span, div, a')];
      const target = items.find(el => el.textContent.trim() === '取货码管理');
      if (target) target.click();
    });
    await page.waitForTimeout(1500);
    console.log('✅ On pickup code management page');

    await page.screenshot({ path: 'pickup_code_page.png', fullPage: true });

    // ── STEP 3: Click 添加 ────────────────────────────────────────────────────
    console.log('➕ Clicking Add button...');
    await page.evaluate(() => {
      const btns   = [...document.querySelectorAll('button, .el-button')];
      const addBtn = btns.find(b => b.textContent.trim() === '添加');
      if (addBtn) addBtn.click();
    });
    await page.waitForTimeout(1500);

    // ── STEP 4: Select 随机生成 ───────────────────────────────────────────────
    console.log('🎲 Selecting Random Generate mode...');
    await page.evaluate(() => {
      const labels = [...document.querySelectorAll('label, span, .el-radio__label')];
      const random = labels.find(el => el.textContent.trim() === '随机生成');
      if (random) random.click();
    });
    await page.waitForTimeout(800);

    // ── STEP 5: Select device ─────────────────────────────────────────────────
    console.log(`📦 Selecting device: ${CONFIG.device}...`);
    await page.evaluate(() => {
      const inputs      = [...document.querySelectorAll('.el-select .el-input__inner')];
      const deviceInput = inputs.find(el => el.placeholder?.includes('设备'));
      if (deviceInput) deviceInput.click();
    });
    await page.waitForTimeout(800);

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

    // ── STEP 7: Confirm dialog ────────────────────────────────────────────────
    console.log('📨 Submitting form...');
    await page.evaluate(() => {
      const btns = [...document.querySelectorAll('button, .el-button')];
      const confirmBtn = btns.filter(b =>
        b.textContent.trim() === '确定' &&
        b.closest('.el-dialog, .el-dialog__footer, [class*="dialog"]')
      ).pop();
      if (confirmBtn) confirmBtn.click();
    });
    await page.waitForTimeout(2000);

    await page.screenshot({ path: 'after_submit.png', fullPage: true });

    // ── STEP 8: Extract pickup code ───────────────────────────────────────────
    console.log('🔍 Extracting pickup code from table...');
    const result = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('table tbody tr, .el-table__row')];
      if (!rows.length) return null;

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
