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

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Solve CAPTCHA — try multiple PSM modes until one gives 4 digits
 */
async function solveCaptcha(page) {
  // Try different PSM modes — psm 7 and 8 work best for short digit strings
  const psmModes = [7, 8, 6, 13];

  for (let attempt = 1; attempt <= 4; attempt++) {
    console.log(`🧩 CAPTCHA solve attempt ${attempt}/4...`);

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
      throw new Error('Cannot find CAPTCHA image element.');
    }

    // Screenshot at 2x device scale for better resolution
    const box = await captchaEl.boundingBox();
    await page.screenshot({
      path: 'captcha.png',
      clip: {
        x:      Math.max(0, box.x - 2),
        y:      Math.max(0, box.y - 2),
        width:  box.width  + 4,
        height: box.height + 4,
      },
    });
    console.log(`  📸 CAPTCHA screenshot captured (${Math.round(box.width)}x${Math.round(box.height)})`);

    // Try each PSM mode on the same screenshot
    for (const psm of psmModes) {
      const config = {
        lang: 'eng',
        oem:  1,
        psm,
        tessedit_char_whitelist: '0123456789',
      };

      try {
        const raw     = await tesseract.recognize('captcha.png', config);
        const cleaned = raw.replace(/\s+/g, '').trim();
        console.log(`  🔍 PSM ${psm} → raw: "${raw.trim()}" cleaned: "${cleaned}"`);

        if (cleaned.length >= 4) {
          console.log(`  ✅ CAPTCHA solved with PSM ${psm}: "${cleaned}"`);
          return cleaned;
        }
      } catch (e) {
        console.log(`  ⚠️  PSM ${psm} error: ${e.message}`);
      }
    }

    // All PSM modes failed — refresh and try again
    console.log('  ⚠️  All PSM modes failed, refreshing CAPTCHA...');
    await captchaEl.click();
    await sleep(1500);
  }

  throw new Error('Tesseract OCR failed after 4 attempts with all PSM modes. Check captcha.png artifact.');
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

    const menuItems = await page.evaluate(() =>
      [...document.querySelectorAll('li, .el-menu-item, .el-submenu__title, span, div, a')]
        .filter(el => {
          const t = el.textContent.trim();
          return t.length > 1 && t.length < 20;
        })
        .map(el => ({ tag: el.tagName, text: el.textContent.trim(), className: el.className }))
        .slice(0, 60)
    );
    console.log('📋 Menu items:', JSON.stringify(menuItems, null, 2));

    await page.evaluate(() => {
      const items = [...document.querySelectorAll('li, .el-submenu__title, .el-menu-item, span, div')];
      const target = items.find(el =>
        el.childElementCount <= 3 &&
        el.textContent.trim().includes('交易管理')
      );
      if (target) target.click();
    });
    await sleep(1500);

    await page.screenshot({ path: 'after_transaction_click.png', fullPage: true });

    await page.evaluate(() => {
      const items = [...document.querySelectorAll('li, .el-menu-item, .el-submenu__title, span, div, a')];
      const target = items.find(el =>
        el.childElementCount <= 3 &&
        el.textContent.trim().includes('取货码管理')
      );
      if (target) target.click();
    });
    await sleep(2000);

    await page.screenshot({ path: 'pickup_code_page.png', fullPage: true });
    console.log('✅ On pickup code management page');

    // ── STEP 3: Click 添加 ────────────────────────────────────────────────────
    console.log('➕ Clicking Add button...');
    const addClicked = await page.evaluate(() => {
      const btns = [...document.querySelectorAll('button, .el-button, a, div')];
      const addBtn = btns.find(b => b.textContent.trim().includes('添加'));
      if (addBtn) { addBtn.click(); return true; }
      return btns.map(b => b.textContent.trim()).filter(t => t.length > 0 && t.length < 15);
    });
    console.log('Add button result:', addClicked);
    await sleep(1500);

    await page.screenshot({ path: 'after_add_click.png', fullPage: true });

    // ── STEP 4: Select 随机生成 ───────────────────────────────────────────────
    console.log('🎲 Selecting Random Generate mode...');
    await page.evaluate(() => {
      const labels = [...document.querySelectorAll('label, span, .el-radio__label, div')];
      const random = labels.find(el => el.textContent.trim().includes('随机生成'));
      if (random) random.click();
    });
    await sleep(800);

    // ── STEP 5: Select device ─────────────────────────────────────────────────
    console.log(`📦 Selecting device: ${CONFIG.device}...`);
    await page.evaluate(() => {
      const inputs = [...document.querySelectorAll('.el-select .el-input__inner, input')];
      const deviceInput = inputs.find(el =>
        el.placeholder?.includes('设备') ||
        el.placeholder?.includes('device')
      );
      if (deviceInput) deviceInput.click();
    });
    await sleep(800);

    await page.evaluate((deviceName) => {
      const options = [...document.querySelectorAll('.el-select-dropdown__item, li')];
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
      return btns.map(b => b.textContent.trim()).filter(t => t.length > 0 && t.length < 15);
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
