/**
 * generate_pickup_code.js
 * Automates XYZ Vending UI to generate a 6-digit pickup code
 * Uses Puppeteer (headless Chrome) + Tesseract OCR for CAPTCHA solving
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
 * Preprocess CAPTCHA image for better OCR:
 * - Scale up 3x
 * - Convert to greyscale
 * - Boost contrast
 * - Threshold to pure black/white
 */
async function preprocessCaptcha(inputPath, outputPath) {
  const { data, info } = await sharp(inputPath)
    .raw()
    .toBuffer({ resolveWithObject: true });

  // Convert to greyscale manually and find dark pixels (the blue digits)
  // Blue digits have high blue channel and lower red/green
  const width  = info.width;
  const height = info.height;
  const ch     = info.channels; // 3 = RGB, 4 = RGBA
  const out    = Buffer.alloc(width * height);

  for (let i = 0; i < width * height; i++) {
    const r = data[i * ch + 0];
    const g = data[i * ch + 1];
    const b = data[i * ch + 2];

    // Blue-dominant pixels are the digits — make them black, rest white
    const isDigit = (b > 80) && (b > r + 20) && (b > g + 10);
    out[i] = isDigit ? 0 : 255;
  }

  await sharp(out, { raw: { width, height, channels: 1 } })
    .resize(width * 3, height * 3, { kernel: 'nearest' })
    .png()
    .toFile(outputPath);
}

/**
 * Solve CAPTCHA using Tesseract OCR with image preprocessing.
 */
async function solveCaptcha(page) {
  const tesseractConfig = {
    lang: 'eng',
    oem:  1,
    psm:  7,
    tessedit_char_whitelist: '0123456789',
  };

  for (let attempt = 1; attempt <= 3; attempt++) {
    console.log(`🧩 CAPTCHA solve attempt ${attempt}/3...`);

    const captchaEl = await page.$(
      'img.code-img-wrap, ' +
      'img[alt="点击刷新"], ' +
      'img[alt*="刷新"], ' +
      'img[alt*="验证"]'
    );

    if (!captchaEl) {
      const allImgs = await page.evaluate(() =>
        [...document.querySelectorAll('img')].map(i => ({
          src:       i.src.substring(0, 80),
          className: i.className,
          alt:       i.alt,
          id:        i.id,
        }))
      );
      console.log('  ⚠️  No CAPTCHA img found. All imgs:', JSON.stringify(allImgs, null, 2));
      await page.screenshot({ path: 'captcha_debug.png', fullPage: true });
      throw new Error('Cannot find CAPTCHA image element.');
    }

    // Screenshot raw CAPTCHA
    const box = await captchaEl.boundingBox();
    await page.screenshot({
      path: 'captcha_raw.png',
      clip: { x: box.x, y: box.y, width: box.width, height: box.height },
    });

    // Preprocess: isolate blue digits → black on white, scale 3x
    await preprocessCaptcha('captcha_raw.png', 'captcha.png');
    console.log('  📸 CAPTCHA captured and preprocessed');

    const raw     = await tesseract.recognize('captcha.png', tesseractConfig);
    const cleaned = raw.replace(/\s+/g, '').trim();
    console.log(`  🔍 OCR raw: "${raw.trim()}" → cleaned: "${cleaned}"`);

    if (cleaned.length >= 4) {
      console.log(`  ✅ CAPTCHA solved: "${cleaned}"`);
      return cleaned;
    }

    console.log('  ⚠️  Result too short, refreshing CAPTCHA...');
    await captchaEl.click();
    await sleep(1200);
  }

  throw new Error('Tesseract OCR failed after 3 attempts. Check captcha_raw.png and captcha.png artifacts.');
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
    // ── STEP 1: Login ─────────────────────────────────────────────────────────
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
    }

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

    // ── STEP 2: Navigate to 取货码管理 ────────────────────────────────────────
    console.log('📍 Navigating to Transaction Management...');

    await page.evaluate(() => {
      const items = [...document.querySelectorAll('li, .menu-item, span, div')];
      const target = items.find(el => el.textContent.trim() === '交易管理');
      if (target) target.click();
    });
    await sleep(1500);

    await page.screenshot({ path: 'after_transaction_click.png', fullPage: true });

    await page.evaluate(() => {
      const items = [...document.querySelectorAll('li, .menu-item, span, div, a')];
      const target = items.find(el => el.textContent.trim() === '取货码管理');
      if (target) target.click();
    });
    await sleep(2000);

    await page.screenshot({ path: 'pickup_code_page.png', fullPage: true });
    console.log('✅ On pickup code management page');

    // ── STEP 3: Click 添加 ────────────────────────────────────────────────────
    console.log('➕ Clicking Add button...');
    const addClicked = await page.evaluate(() => {
      const btns   = [...document.querySelectorAll('button, .el-button')];
      const addBtn = btns.find(b => b.textContent.trim() === '添加');
      if (addBtn) { addBtn.click(); return true; }
      return btns.map(b => b.textContent.trim());
    });
    console.log('Add button result:', addClicked);
    await sleep(1500);

    await page.screenshot({ path: 'after_add_click.png', fullPage: true });

    // ── STEP 4: Select 随机生成 ───────────────────────────────────────────────
    console.log('🎲 Selecting Random Generate mode...');
    await page.evaluate(() => {
      const labels = [...document.querySelectorAll('label, span, .el-radio__label')];
      const random = labels.find(el => el.textContent.trim() === '随机生成');
      if (random) random.click();
    });
    await sleep(800);

    // ── STEP 5: Select device ─────────────────────────────────────────────────
    console.log(`📦 Selecting device: ${CONFIG.device}...`);
    await page.evaluate(() => {
      const inputs      = [...document.querySelectorAll('.el-select .el-input__inner')];
      const deviceInput = inputs.find(el => el.placeholder?.includes('设备'));
      if (deviceInput) deviceInput.click();
    });
    await sleep(800);

    await page.evaluate((deviceName) => {
      const options = [...document.querySelectorAll('.el-select-dropdown__item')];
      const option  = options.find(el => el.textContent.includes(deviceName));
      if (option) option.click();
    }, CONFIG.device);
    await sleep(800);

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
    await sleep(500);

    await page.screenshot({ path: 'before_submit.png', fullPage: true });

    // ── STEP 7: Confirm dialog ────────────────────────────────────────────────
    console.log('📨 Submitting form...');
    const confirmClicked = await page.evaluate(() => {
      const btns = [...document.querySelectorAll('button, .el-button')];
      const confirmBtn = btns.filter(b =>
        b.textContent.trim() === '确定' &&
        b.closest('.el-dialog, .el-dialog__footer, [class*="dialog"]')
      ).pop();
      if (confirmBtn) { confirmBtn.click(); return true; }
      return btns.map(b => b.textContent.trim());
    });
    console.log('Confirm button result:', confirmClicked);
    await sleep(3000);

    await page.screenshot({ path: 'after_submit.png', fullPage: true });

    // ── STEP 8: Extract pickup code ───────────────────────────────────────────
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
        ' Error: ' + (result?.error || 'none')
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
