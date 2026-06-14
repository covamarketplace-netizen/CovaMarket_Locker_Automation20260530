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
 *
 * Finding the new code after addPickInfo:
 *   1. Snapshot ALL pending pickCodes globally BEFORE addPickInfo.
 *   2. Call addPickInfo for ONE locker.
 *   3. Try to extract pickCode directly from the response.
 *   4. If not in response, poll: find ANY pending code that wasn't in the
 *      before-snapshot — regardless of goodsName, since the API may store the
 *      new code under "新认设备" or another name instead of the locker name.
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
 * Returns { names: Set<string>, allCodes: Set<string> }
 * names    = Set of goodsName values with pending codes (for locker selection)
 * allCodes = Set of ALL pending pickCodes globally (for before-snapshot)
 */
async function getPendingState() {
  console.log('🔍 Fetching all pending pick codes from live API...');
  const allRecords = [];
  for (const page of [1, 2, 3, 4]) {
    const res = await request(
      `${CONFIG.baseUrl}/api/pickInfo/list?current=${page}&size=50&funId=${CONFIG.funId}&pickStatus=0`,
      { method: 'GET', headers: authHeaders() }
    );
    const records = res.body?.data?.records || res.body?.rows || res.body?.data || [];
    if (Array.isArray(records) && records.length) allRecords.push(...records);
    else break;
  }

  const pending  = allRecords.filter(r => (r.pickStatus ?? r.status ?? -1) === 0);
  const names    = new Set(pending.map(r => r.goodsName).filter(Boolean));
  const allCodes = new Set(pending.map(r => r.pickCode).filter(Boolean));

  console.log(`🔒 Lockers with pending codes: [${[...names].join(', ')}] (${pending.length} pending codes total)`);
  pending.forEach(r => {
    console.log(`  code=${r.pickCode} | locker="${r.goodsName}" | status=${r.pickStatus} | created=${r.createTime}`);
  });

  return { names, allCodes, totalCount: pending.length };
}

async function addPickInfo(locker) {
  console.log(`\n🎟️  Creating pickup code for locker ${locker.column}-${locker.row} (goodsId=${locker.goodsId}, roadId=${locker.roadId})...`);
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
 * Poll for ANY new pending code that wasn't in the global before-snapshot.
 * Does NOT filter by goodsName — the API may store the code under a different
 * name (e.g. "新认设备") than the locker name we sent.
 */
async function waitForNewPickCode(beforeAllCodes, { maxAttempts = 8, delayMs = 3000 } = {}) {
  console.log(`🔍 Polling for any new pending code (before-snapshot had ${beforeAllCodes.size} codes globally)...`);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const allRecords = [];
    for (const page of [1, 2, 3, 4]) {
      const res = await request(
        `${CONFIG.baseUrl}/api/pickInfo/list?current=${page}&size=50&funId=${CONFIG.funId}&pickStatus=0`,
        { method: 'GET', headers: authHeaders() }
      );
      const records = res.body?.data?.records || res.body?.rows || res.body?.data || [];
      if (Array.isArray(records) && records.length) allRecords.push(...records);
      else break;
    }

    const pending = allRecords.filter(r => (r.pickStatus ?? r.status ?? -1) === 0);

    if (attempt === 1) {
      console.log(`  📋 Total pending now: ${pending.length}`);
      pending.slice(0, 5).forEach(r =>
        console.log(`  📋 code=${r.pickCode} locker="${r.goodsName}" createTime=${r.createTime}`)
      );
    }

    // Find any code that wasn't there before — regardless of goodsName
    const newRecord = pending.find(r => r.pickCode && !beforeAllCodes.has(r.pickCode)) ?? null;

    if (newRecord) {
      console.log(`✅ Found new code ${newRecord.pickCode} under "${newRecord.goodsName}" (createTime=${newRecord.createTime}) on attempt ${attempt}`);
      return newRecord;
    }

    console.log(`  Attempt ${attempt}/${maxAttempts} — no new code yet (${pending.length} total pending), waiting ${delayMs}ms...`);
    if (attempt < maxAttempts) await new Promise(r => setTimeout(r, delayMs));
  }

  console.warn(`⚠️  New pick code not found after ${maxAttempts} attempts.`);
  return null;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function findFreeLocker(channels, pendingNames) {
  console.log(`\n📦 Total channels: ${channels.length}`);

  channels.forEach(ch => {
    const stock      = ch.roadStock ?? ch.stock ?? ch.goodsNum ?? 0;
    const lockerName = `Locker ${ch.roadRow}-${ch.roadColumn}`;
    const inUse      = pendingNames.has(lockerName);
    console.log(`  ${ch.roadColumn}-${ch.roadRow} | roadId=${ch.roadId} | goodsId=${ch.goodsId ?? 'NULL'} | stock=${stock} | pendingCode=${inUse}`);
  });

  const free = channels.filter(ch => {
    const stock      = ch.roadStock ?? ch.stock ?? ch.goodsNum ?? 0;
    const lockerName = `Locker ${ch.roadRow}-${ch.roadColumn}`;
    return stock > 0 && !pendingNames.has(lockerName);
  });

  if (!free.length) throw new Error('No free lockers available! All stocked lockers have pending pickup codes.');

  const ch = free[0];
  console.log(`\n✅ Selected: Locker ${ch.roadRow}-${ch.roadColumn} | roadId=${ch.roadId} | goodsId=${ch.goodsId}`);
  return {
    goodsId:    ch.goodsId,
    roadId:     ch.roadId,
    column:     ch.roadColumn,
    row:        ch.roadRow,
    stock:      ch.roadStock ?? ch.stock ?? ch.goodsNum,
    lockerName: `Locker ${ch.roadRow}-${ch.roadColumn}`,
  };
}

async function main() {
  try {
    if (!CONFIG.token) throw new Error('XYZ_TOKEN secret is not set!');
    console.log('🔑 Using stored JWT token');
    console.log(`📦 funId=${CONFIG.funId}\n`);

    const channels                              = await getAllChannels();
    const { names: pendingNames, allCodes: beforeAllCodes } = await getPendingState();

    const locker = await findFreeLocker(channels, pendingNames);

    // ── Create the pick code ─────────────────────────────────────────────────
    const result = await addPickInfo(locker);

    // ── Try to get pickCode directly from addPickInfo response ───────────────
    let pickCode = result?.data?.pickCode
      || (Array.isArray(result?.data) && result.data[0]?.pickCode)
      || result?.pickCode
      || null;
    let orderNo = result?.data?.pickOrderNum
      || (Array.isArray(result?.data) && result.data[0]?.pickOrderNum)
      || null;

    if (pickCode) {
      console.log(`✅ pickCode found directly in addPickInfo response: ${pickCode}`);
    } else {
      // Poll for ANY new pending code — don't filter by goodsName
      console.log('⚠️  pickCode not in response — polling for any new pending code...');
      const match = await waitForNewPickCode(beforeAllCodes);
      if (match?.pickCode) {
        pickCode = match.pickCode;
        orderNo  = match.pickOrderNum;
      }
    }

    if (!pickCode) throw new Error('No pickup code found. Response: ' + JSON.stringify(result));

    // ── Save tracking file ────────────────────────────────────────────────────
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
