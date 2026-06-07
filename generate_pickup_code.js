/**
 * generate_pickup_code.js
 * Automates XYZ Vending UI to generate a 6-digit pickup code
 * Uses Puppeteer (headless Chrome) — works from GitHub Actions
 *
 * Usage:
 *   node generate_pickup_code.js
 *   Returns: { pickCode: "319508", orderNo: "202605..." }
 */

const puppeteer = require('puppeteer');

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const CONFIG = {
  url:      'http://xzyvend.com',
  username: process.env.XYZ_USERNAME || '0108668014',
  password: process.env.XYZ_PASSWORD || 'YOUR_PASSWORD_HERE',
  device:   process.env.XYZ_DEVICE   || '默认设备',
  quantity: process.env.XYZ_QUANTITY || '1',
  timeout:  30000,
};
// ─────────────────────────────────────────────────────────────────────────────

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

  // Suppress console noise
  page.on('console', () => {});

  try {
    // ── STEP 1: Login ────────────────────────────────────────────────────────
    console.log('🔐 Logging in...');
    await page.goto(CONFIG.url, { waitUntil: 'networkidle2', timeout: CONFIG.timeout });

    // Wait for login form
    await page.waitForSelector('input[type="text"], input[placeholder*="账号"], input[placeholder*="用户"]', { timeout: CONFIG.timeout });

    // Fill username
    const usernameInput = await page.$('input[type="text"]') ||
                          await page.$('input[placeholder*="账号"]') ||
                          await page.$('input[placeholder*="用户名"]');
    await usernameInput.click({ clickCount: 3 });
    await usernameInput.type(CONFIG.username);

    // Fill password
    const passwordInput = await page.$('input[type="password"]');
    await passwordInput.click({ clickCount: 3 });
    await passwordInput.type(CONFIG.password);

    // Click login button
    const loginBtn = await page.$('button[type="submit"]') ||
                     await page.$('.login-btn') ||
                     await page.$('button');
    await loginBtn.click();
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: CONFIG.timeout });
    console.log('✅ Logged in');

    // ── STEP 2: Navigate to 取货码管理 ────────────────────────────────────────
    console.log('📍 Navigating to pickup code management...');

    // Click 交易管理 in sidebar
    await page.evaluate(() => {
      const items = [...document.querySelectorAll('li, .menu-item, span, div')];
      const target = items.find(el => el.textContent.trim() === '交易管理');
      if (target) target.click();
    });
    await page.waitForTimeout(1000);

    // Click 取货码管理
    await page.evaluate(() => {
      const items = [...document.querySelectorAll('li, .menu-item, span, div, a')];
      const target = items.find(el => el.textContent.trim() === '取货码管理');
      if (target) target.click();
    });
    await page.waitForTimeout(1500);
    console.log('✅ On pickup code management page');

    // ── STEP 3: Click 添加 ────────────────────────────────────────────────────
    console.log('➕ Clicking Add button...');
    await page.evaluate(() => {
      const btns = [...document.querySelectorAll('button, .el-button')];
      const addBtn = btns.find(b => b.textContent.trim() === '添加');
      if (addBtn) addBtn.click();
    });
    await page.waitForTimeout(1500);

    // ── STEP 4: Select 随机生成 (Random) ──────────────────────────────────────
    console.log('🎲 Selecting Random mode...');
    await page.evaluate(() => {
      // Find all radio labels/spans
      const labels = [...document.querySelectorAll('label, span, .el-radio__label')];
      const random = labels.find(el => el.textContent.trim() === '随机生成');
      if (random) random.click();
    });
    await page.waitForTimeout(800);

    // ── STEP 5: Select device ─────────────────────────────────────────────────
    console.log(`📦 Selecting device: ${CONFIG.device}...`);

    // Click the device dropdown
    await page.evaluate(() => {
      const selects = [...document.querySelectorAll('.el-select, .el-input__inner')];
      const deviceSelect = selects.find(el =>
        el.placeholder === '请选择设备名称' ||
        el.closest('.el-select')
      );
      if (deviceSelect) deviceSelect.click();
    });
    await page.waitForTimeout(800);

    // Click the device option
    await page.evaluate((deviceName) => {
      const options = [...document.querySelectorAll('.el-select-dropdown__item, li')];
      const option = options.find(el => el.textContent.includes(deviceName));
      if (option) option.click();
    }, CONFIG.device);
    await page.waitForTimeout(800);

    // ── STEP 6: Set quantity ──────────────────────────────────────────────────
    console.log('🔢 Setting quantity...');
    await page.evaluate((qty) => {
      const inputs = [...document.querySelectorAll('input')];
      const qtyInput = inputs.find(el =>
        el.placeholder === '请选择随机数量' ||
        el.placeholder?.includes('数量')
      );
      if (qtyInput) {
        qtyInput.value = '';
        qtyInput.dispatchEvent(new Event('input', { bubbles: true }));
        qtyInput.value = qty;
        qtyInput.dispatchEvent(new Event('input', { bubbles: true }));
        qtyInput.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }, CONFIG.quantity);
    await page.waitForTimeout(500);

    // ── STEP 7: Click 确定 ────────────────────────────────────────────────────
    console.log('✅ Submitting form...');
    await page.evaluate(() => {
      // Find 确定 button inside the dialog
      const btns = [...document.querySelectorAll('button, .el-button')];
      const confirmBtn = btns.filter(b =>
        b.textContent.trim() === '确定' &&
        b.closest('.el-dialog, .el-dialog__footer, [class*="dialog"]')
      ).pop(); // last 确定 button (inside dialog)
      if (confirmBtn) confirmBtn.click();
    });
    await page.waitForTimeout(2000);

    // ── STEP 8: Extract the pickup code ──────────────────────────────────────
    console.log('🔍 Extracting pickup code...');

    const result = await page.evaluate(() => {
      // The newest row will be at the top (or bottom) of the table
      const rows = [...document.querySelectorAll('table tbody tr, .el-table__row')];
      if (!rows.length) return null;

      const firstRow = rows[0]; // most recent
      const cells = [...firstRow.querySelectorAll('td')];
      const cellTexts = cells.map(c => c.textContent.trim());

      // Find the 6-digit code (pickCode column)
      const pickCode = cellTexts.find(t => /^\d{6}$/.test(t));
      // Find order number (long alphanumeric)
      const orderNo = cellTexts.find(t => t.length > 15 && /^[0-9a-z]+$/i.test(t));

      return { pickCode, orderNo, allCells: cellTexts };
    });

    if (!result?.pickCode) {
      throw new Error('Could not extract pickup code from table. Cells: ' + JSON.stringify(result?.allCells));
    }

    console.log('');
    console.log('═══════════════════════════════════');
    console.log(`✅ PICKUP CODE: ${result.pickCode}`);
    console.log(`📋 ORDER NO:   ${result.orderNo}`);
    console.log('═══════════════════════════════════');
    console.log('');

    // Output JSON for GitHub Actions to capture
    const output = {
      success: true,
      pickCode: result.pickCode,
      orderNo: result.orderNo,
      device: CONFIG.device,
      generatedAt: new Date().toISOString(),
    };

    console.log('OUTPUT_JSON:' + JSON.stringify(output));
    return output;

  } catch (err) {
    console.error('❌ Error:', err.message);

    // Take screenshot for debugging
    await page.screenshot({ path: 'error_screenshot.png', fullPage: true });
    console.log('📸 Screenshot saved to error_screenshot.png');

    const output = { success: false, error: err.message };
    console.log('OUTPUT_JSON:' + JSON.stringify(output));
    process.exit(1);

  } finally {
    await browser.close();
  }
}

generatePickupCode();
