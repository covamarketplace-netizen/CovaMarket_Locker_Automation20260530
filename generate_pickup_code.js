/**
 * generate_pickup_code.js
 * Generates XYZ Vending pickup code using JWT token.
 *
 * Source of truth for "which lockers are busy" = live API (status=0 pending codes).
 * active_lockers.json is saved for reference only — NOT used for locking decisions.
 *
 * A locker is considered IN USE if any pending (status=0) pick code exists
 * whose goodsName matches the locker name (e.g. "Locker 1-1").
 * Only lockers with NO pending codes AND stock > 0 are eligible for assignment.
 */

const https = require('https');
const fs    = require('fs');
const path  = require('path');

const CONFIG = {
  baseUrl:      'https://xzyvend.com',
  token:        process.env.XYZ_TOKEN || '',
  funId:        parseInt(process.env.XYZ_FUN_ID || '716'),
  generateNum:  1,
  pickType:     0,
  trackingFile: path.join(__dirname, 'pickup_codes', 'active_lockers.json'),
};

// ── HTTP helper ───────────────────────────────────────────────────────────────
function request(url, options = {}, body = null) {
  return new Promise((resolve, reject) => {
    const parsed  = new URL(url);
    const reqOpts = {
      hostname: parsed.hostname,
      path:     parsed.pathname + parsed.search,
      method:   options.method  || 'GET',
      headers:  options.headers || {},
    };
    const req = https.request(reqOpts, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

function authHeaders(contentType = null) {
  const h = {
    'Authorization': CONFIG.token,
    'Cookie':        `Admin-Token=${CONFIG.token}`,
    'User-Agent':    'Mozilla/5.0',
    'Accept':        'application/json, text/plain, */*',
    'Origin':        CONFIG.baseUrl,
    'Referer':       `${CONFIG.baseUrl}/transactionManagement/pickUpCodeManagement`,
  };
  if (contentType) h['Content-Type'] = contentType;
  return h;
}

// ── Tracking file (reference only — not used for locking decisions) ───────────
function loadActiveLockers() {
  try {
    if (!fs.existsSync(CONFIG.trackingFile)) return {};
    return JSON.parse(fs.readFileSync(CONFIG.trackingFile, 'utf8'));
  } catch {
    return {};
  }
}

function saveActiveLockers(data) {
  const dir = path.dirname(CONFIG.trackingFile);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CONFIG.trackingFile, JSON.stringify(data, null, 2));
  console.log(`💾 Saved active_lockers.json (${Object.keys(data).length} active lockers)`);
}

// ── API calls ─────────────────────────────────────────────────────────────────
async function getAllChannels() {
  console.log('🔍 Getting all channels...');
  const res = await request(
    `${CONFIG.baseUrl}/api/roadInfo/getRoadGoodsByFunId?funId=${CONFIG.funId}&_t=${Date.now()}`,
    { method: 'GET', headers: authHeaders() }
  );
  if (res.status !== 200) throw new Error(`getRoadGoodsByFunId failed: ${res.status}`);
  const channels = res.body?.data || res.body?.rows || res.body || [];
  return Array.isArray(channels) ? channels : [];
}

/**
 * Fetch ALL pending (status=0) pick codes from the live API.
 * Returns a Set of goodsName values that are awaiting pickup.
 * e.g. Set { "Locker 1-1", "Locker 2-1" }
 *
 * Fetches up to 100 records to cover all possible pending codes.
 */
async function getPendingLockerNames() {
  console.log('🔍 Fetching all pending pick codes from live API...');
  const res = await request(
    `${CONFIG.baseUrl}/api/pickInfo/list?current=1&size=100&funId=${CONFIG.funId}&pickStatus=0`,
    { method: 'GET', headers: authHeaders() }
  );
  const records = res.body?.data?.records || res.body?.rows || res.body?.data || [];
  const list    = Array.isArray(records) ? records : [];

  // Filter to only truly pending (status=0) records (in case API ignores pickStatus param)
  const pending = list.filter(r => (r.pickStatus ?? r.status ?? -1) === 0);

  const names = new Set(pending.map(r => r.goodsName).filter(Boolean));
  console.log(`🔒 Lockers with pending codes: [${[...names].join(', ')}] (${pending.length} pending codes total)`);
  pending.forEach(r => {
    console.log(`  code=${r.pickCode} | locker="${r.goodsName}" | status=${r.pickStatus} | created=${r.createTime}`);
  });
  return names;
}

async function addPickInfo(locker) {
  console.log(`\n🎟️  Creating pickup code for locker ${locker.column}-${locker.row}...`);
  const body = {
    funId:         CONFIG.funId,
    pickType:      CONFIG.pickType,
    generateNum:   CONFIG.generateNum,
    goodsPickList: [{ goodsId: locker.goodsId, roadId: locker.roadId }],
  };
  const res = await request(
    `${CONFIG.baseUrl}/api/pickInfo/addPickInfo`,
    { method: 'POST', headers: authHeaders('application/json;charset=UTF-8') },
    body
  );
  console.log('addPickInfo status:', res.status);
  console.log('addPickInfo response:', JSON.stringify(res.body));
  return res.body;
}

/**
 * Poll the list for a freshly created code.
 * Identifies "our" code by createTime >= scriptStart (Unix ms).
 * roadId is always null in list responses, so we cannot match by it.
 */
async function getNewPickCode(lockerName, scriptStart, { maxAttempts = 6, delayMs = 3000 } = {}) {
  console.log(`🔍 Waiting for new pick code (scriptStart=${scriptStart})...`);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await request(
      `${CONFIG.baseUrl}/api/pickInfo/list?current=1&size=20&funId=${CONFIG.funId}`,
      { method: 'GET', headers: authHeaders() }
    );
    const records = res.body?.data?.records || res.body?.rows || res.body?.data || [];
    const list    = Array.isArray(records) ? records : [];

    // Our code: created at or after scriptStart, status=0, goodsName matches locker
    const match = list
      .filter(r => (r.pickStatus ?? r.status ?? -1) === 0)
      .filter(r => (r.createTime ?? 0) >= scriptStart)
      .filter(r => !lockerName || r.goodsName === lockerName)
      .sort((a, b) => (b.createTime ?? 0) - (a.createTime ?? 0))[0] ?? null;

    if (match) {
      console.log(`✅ Found new code ${match.pickCode} for "${match.goodsName}" on attempt ${attempt}`);
      return match;
    }

    console.log(`  Attempt ${attempt}/${maxAttempts} — new code not visible yet, waiting ${delayMs}ms...`);
    if (attempt < maxAttempts) await new Promise(r => setTimeout(r, delayMs));
  }

  console.warn(`⚠️  New pick code not found after ${maxAttempts} attempts.`);
  return null;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function findFreeLocker(channels, pendingLockerNames) {
  console.log(`\n📦 Total channels: ${channels.length}`);

  channels.forEach(ch => {
    const stock      = ch.roadStock ?? ch.stock ?? ch.goodsNum ?? 0;
    const lockerName = `Locker ${ch.roadColumn}-${ch.roadRow}`;
    const inUse      = pendingLockerNames.has(lockerName);
    console.log(`  ${ch.roadColumn}-${ch.roadRow} | roadId=${ch.roadId} | stock=${stock} | pendingCode=${inUse}`);
  });

  const free = channels.filter(ch => {
    const stock      = ch.roadStock ?? ch.stock ?? ch.goodsNum ?? 0;
    const lockerName = `Locker ${ch.roadColumn}-${ch.roadRow}`;
    return stock > 0 && !pendingLockerNames.has(lockerName);
  });

  if (!free.length) throw new Error('No free lockers available! All stocked lockers have pending pickup codes.');

  const ch         = free[0];
  const lockerName = `Locker ${ch.roadColumn}-${ch.roadRow}`;
  console.log(`\n✅ Selected: ${lockerName} | roadId=${ch.roadId}`);
  return {
    goodsId:    ch.goodsId,
    roadId:     ch.roadId,
    column:     ch.roadColumn,
    row:        ch.roadRow,
    stock:      ch.roadStock ?? ch.stock ?? ch.goodsNum,
    lockerName,
  };
}

async function main() {
  try {
    if (!CONFIG.token) throw new Error('XYZ_TOKEN secret is not set!');
    console.log('🔑 Using stored JWT token');
    console.log(`📦 funId=${CONFIG.funId}\n`);

    const channels          = await getAllChannels();
    const pendingLockerNames = await getPendingLockerNames(); // live API is source of truth

    const locker      = await findFreeLocker(channels, pendingLockerNames);
    const scriptStart = Date.now();
    const result      = await addPickInfo(locker);

    // Try to extract pick code directly from addPickInfo response
    let pickCode = result?.data?.pickCode
      || (Array.isArray(result?.data) && result.data[0]?.pickCode)
      || result?.pickCode
      || null;
    let orderNo = result?.data?.pickOrderNum
      || (Array.isArray(result?.data) && result.data[0]?.pickOrderNum)
      || null;

    // Fall back to polling the list
    if (!pickCode) {
      console.log('⚠️  pickCode not in response — polling list...');
      const match = await getNewPickCode(locker.lockerName, scriptStart);
      if (match?.pickCode) {
        pickCode = match.pickCode;
        orderNo  = match.pickOrderNum;
      }
    }

    if (!pickCode) throw new Error('No pickup code found. Response: ' + JSON.stringify(result));

    // Save for reference
    const activeLockers = loadActiveLockers();
    activeLockers[locker.roadId] = {
      pickCode,
      orderNo:   orderNo || null,
      locker:    `${locker.column}-${locker.row}`,
      goodsId:   locker.goodsId,
      createdAt: new Date().toISOString(),
    };
    saveActiveLockers(activeLockers);

    console.log('\n═══════════════════════════════════');
    console.log(`✅ PICKUP CODE : ${pickCode}`);
    console.log(`📋 ORDER NO   : ${orderNo || 'N/A'}`);
    console.log(`📦 LOCKER     : ${locker.column}-${locker.row} (roadId=${locker.roadId})`);
    console.log('═══════════════════════════════════\n');

    const output = {
      success:     true,
      pickCode,
      orderNo,
      locker:      `${locker.column}-${locker.row}`,
      funId:       CONFIG.funId,
      goodsId:     locker.goodsId,
      roadId:      locker.roadId,
      generatedAt: new Date().toISOString(),
    };
    console.log('OUTPUT_JSON:' + JSON.stringify(output));

  } catch (err) {
    console.error('❌ Error:', err.message);
    console.log('OUTPUT_JSON:' + JSON.stringify({ success: false, error: err.message }));
    process.exit(1);
  }
}

main();
