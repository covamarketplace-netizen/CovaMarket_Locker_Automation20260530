/**
 * generate_pickup_code.js
 * Automates XYZ Vending pickup code generation — no login needed.
 * Loads saved cookies from cookies.json exported from browser.
 */

const puppeteer = require('puppeteer');
const fs        = require('fs');

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const CONFIG = {
  url:         'https://xzyvend.com/workPanel/overview',
  cookiesFile: process.env.COOKIES_FILE || 'cookies.json',
  device:      process.env.XYZ_DEVICE   || '默认设备',
  quantity:    process.env.XYZ_QUANTITY || '1',
  timeout:     30000,
};
// ─────────────────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Load cookies from JSON file and inject into the page.
 */
async function loadCookies(page) {
  if (!fs.existsSync(CONFIG.cookiesFile)) {
    throw new Error(`cookies.json not found at: ${CONFIG.cookiesFile}`);
  }
  const raw     = fs.readFileSync(CONFIG.cookiesFile, 'utf8');
  const cookies = JSON.parse(raw);

  // EditThisCookie exports slightly different format — normalise it
  const normalised = cookies.map(c => ({
    name:     c.name,
    value:    c.value,
    domain:   c.domain,
    path:     c.path     || '/',
    httpOnly: c.httpOnly || false,
    secure:   c.secure   || false,
    ...(c.expirationDate ? { expires: Math.floor(c.expirationDate) } : {}),
  }));

  await page.setCookie(...normalised);
  console.log(`🍪 Loaded ${normalised.length} cookies from ${CONFIG.cookiesFile}`);
}

/**
 * Check that we're actually logged in after loading cookies.
 */
async function verifyLoggedIn(page) {
  const isLoginPage = page.url().includes('/login');
  const hasAccount  = await page.evaluate(() =>
    document.body.innerText.includes('0108668014') ||
    document.body.innerText.includes('Customer Role') ||
    document.querySelector('.el-menu, .workPanel, [class*="overview"]') !== null
  );

  if (isLoginPage || !hasAccount) {
    throw new Error(
      'Session expired or cookies invalid — please re-export cookies from your browser and update the XYZ_COOKIES secret.'
    );
  }
  console.log('✅ Session valid — logged in');
}

// ─── MAIN ────────────────────────────────────────────────────────────────────

async function generatePickupCode() {
  console.log('🚀 Launching browser...');

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  page.on('console', () => {});

  try {
    // ── STEP 1: Set cookies then navigate ────────────────────────────────────
    // Must go to the domain first (even a blank page) before setting cookies
    await page.goto('https://xzyvend.com', { waitUntil: 'domcontentloaded', timeout: CONFIG.timeout });
    await loadCookies(page);

    // Now navigate to the dashboard with cookies applied
    console.log('🌐 Navigating to dashboard...');
    await page.goto(CONFIG.url, { waitUntil: 'networkidle2', timeout: CONFIG.timeout });
    await page.screenshot({ path: 'after_load.png', fullPage: true });

    await verifyLoggedIn(page);

    // ── STEP 2: Navigate to 取货码管理 ────────────────────────────────────────
    console.log('📍 Clicking Transaction Management...');

    // Click 交易管理 submenu
    await page.evaluate(() => {
      const items  = [...document.querySelectorAll('li, .el-submenu__title, .el-menu-item, span, div')];
      const target = items.find(el =>
        el.childElementCount <= 3 &&
        (el.textContent.trim().includes('交易管理') || el.textContent.trim().includes('Transaction Mana'))
      );
      if (target) target.click();
      else console.warn('交易管理 not found');
    });
    await sleep(1500);
    await page.screenshot({ path: 'after_transaction_click.png', fullPage: true });

    // Click 取货码管理 submenu item
    console.log('📍 Clicking Pickup Code Management...');
    await page.evaluate(() => {
      const items  = [...document.querySelectorAll('li, .el-menu-item, a, span')];
      const target = items.find(el =>
        el.childElementCount <= 2 &&
        (el.textContent.trim().includes('取货码管理') || el.textContent.trim().includes('Pickup Code'))
      );
      if (target) target.click();
      else console.warn('取货码管理 not found');
    });
    await sleep(2000);
    await page.screenshot({ path: 'pickup_code_page.png', fullPage: true });
    console.log('✅ On pickup code management page');

    // ── STEP 3: Click 添加 ────────────────────────────────────────────────────
    console.log('➕ Clicking Add button...');
    const addClicked = await page.evaluate(() => {
      const btns   = [...document.querySelectorAll('button, .el-button')];
      const addBtn = btns.find(b =>
        b.textContent.trim().includes('添加') || b.textContent.trim().includes('Add')
      );
      if (addBtn) { addBtn.click(); return true; }
      return false;
    });
    console.log('  Add clicked:', addClicked);
    await sleep(1500);
    await page.screenshot({ path: 'after_add_click.png', fullPage: true });

    // ── STEP 4: Select 随机生成 (Random Generate) ─────────────────────────────
    console.log('🎲 Selecting Random Generate mode...');
    await page.evaluate(() => {
      const els = [...document.querySelectorAll('label, span, .el-radio__label, .el-radio')];
      const el  = els.find(e =>
        e.textContent.trim().includes('随机生成') || e.textContent.trim().includes('Random')
      );
      if (el) el.click();
    });
    await sleep(800);

    // ── STEP 5: Select device ─────────────────────────────────────────────────
    console.log(`📦 Selecting device: ${CONFIG.device}...`);

    // Open the device dropdown
    await page.evaluate(() => {
      const inputs = [...document.querySelectorAll('.el-select .el-input__inner, input')];
      const el     = inputs.find(i =>
        i.placeholder?.includes('设备') ||
        i.placeholder?.includes('device') ||
        i.placeholder?.includes('Device')
      );
      if (el) el.click();
    });
    await sleep(800);

    // Pick the device from dropdown
    await page.evaluate((deviceName) => {
      const options = [...document.querySelectorAll('.el-select-dropdown__item, li')];
      const option  = options.find(o => o.textContent.trim().includes(deviceName));
      if (option) option.click();
      else {
        // If device name not found, just pick the first option
        const first = options[0];
        if (first) first.click();
      }
    }, CONFIG.device);
    await sleep(800);
    await page.screenshot({ path: 'after_device_select.png', fullPage: true });

    // ── STEP 6: Set quantity ──────────────────────────────────────────────────
    console.log(`🔢 Setting quantity to ${CONFIG.quantity}...`);
    await page.evaluate((qty) => {
      const inputs = [...document.querySelectorAll('input[type="number"], input')];
      const el     = inputs.find(i =>
        i.placeholder?.includes('数量') ||
        i.placeholder?.includes('quantity') ||
        i.placeholder?.includes('Quantity') ||
        i.type === 'number'
      );
      if (el) {
        el.focus();
        el.value = '';
        el.dispatchEvent(new Event('input',  { bubbles: true }));
        el.value = qty;
        el.dispatchEvent(new Event('input',  { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }, CONFIG.quantity);
    await sleep(500);
    await page.screenshot({ path: 'before_submit.png', fullPage: true });

    // ── STEP 7: Click 确定 (Confirm) ──────────────────────────────────────────
    console.log('📨 Clicking Confirm...');
    const confirmed = await page.evaluate(() => {
      const btns = [...document.querySelectorAll('button, .el-button')];
      // Find 确定 inside a dialog
      const btn  = btns.filter(b =>
        (b.textContent.trim() === '确定' || b.textContent.trim() === 'Confirm') &&
        b.closest('.el-dialog, .el-dialog__footer, [class*="dialog"], [class*="modal"]')
      ).pop();
      if (btn) { btn.click(); return true; }

      // Fallback: any 确定 button
      const fallback = btns.find(b => b.textContent.trim() === '确定');
      if (fallback) { fallback.click(); return 'fallback'; }
      return false;
    });
    console.log('  Confirm result:', confirmed);
    await sleep(3000);
    await page.screenshot({ path: 'after_submit.png', fullPage: true });

    // ── STEP 8: Extract pickup code from table ────────────────────────────────
    console.log('🔍 Extracting pickup code...');

    const tableDebug = await page.evaluate(() => {
      const table = document.querySelector('.el-table__body, table');
      return table ? table.innerHTML.substring(0, 2000) : 'NO TABLE FOUND';
    });
    console.log('📋 Table HTML snippet:', tableDebug);

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
        'Could not extract pickup code. ' +
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
