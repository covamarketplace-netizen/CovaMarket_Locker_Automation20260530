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
 *   1. Snapshot all pending pickCode IDs for the target locker BEFORE the call.
 *   2. Call addPickInfo.
 *   3. Try to extract pickCode directly from the response first.
 *   4. If not in response, poll until a pending code for that locker appears
 *      whose pickCode was NOT in the before-snapshot.
 *   This avoids any reliance on createTime / server clock skew.
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

/**
 * Fetch all pending pick codes for a specific locker name.
 * Returns a Set of pickCode strings currently pending for that locker.
 * Used to snapshot before/after addPickInfo so we can diff for the new code.
 */
async function getPendingCodesForLocker(lockerName) {
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

  const pending = allRecords.filter(r =>
    (r.pickStatus ?? r.status ?? -1) === 0 &&
    r.goodsName === lockerName
  );

  const codes = new Set(pending.map(r => r.pickCode).filter(Boolean));
  console.log(`  📸 Pre-snapshot for "${lockerName}": ${codes.size} existing pending codes [${[...codes].join(', ')}]`);
  return { codes, records: pending };
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
 * Poll until a NEW pending code appears for the target locker —
 * i.e. a pickCode that was NOT in the before-snapshot.
 *
 * This is clock-skew-proof: we identify "our" code by set difference,
 * not by createTime comparison.
 */
async function waitForNewPickCode(lockerName, beforeCodes, { maxAttempts = 10, delayMs = 3000 } = {}) {
  console.log(`🔍 Polling for new pick code on "${lockerName}" (before-snapshot has ${beforeCodes.size} codes)...`);

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

    // Log a sample on first attempt for debugging
    if (attempt === 1) {
      console.log(`  📋 Total records across pages: ${allRecords.length}`);
      allRecords.slice(0, 5).forEach(r =>
        console.log(`  📋 sample: code=${r.pickCode} locker="${r.goodsName}" createTime=${r.createTime} status=${r.pickStatus}`)
      );
    }

    const afterPending = allRecords.filter(r =>
      (r.pickStatus ?? r.status ?? -1) === 0 &&
      r.goodsName === lockerName
    );

    // The new code is whichever pickCode wasn't in the before-snapshot
    const newRecord = afterPending.find(r => r.pickCode && !beforeCodes.has(r.pickCode)) ?? null;

    if (newRecord) {
      console.log(`✅ Found new code ${newRecord.pickCode} for "${newRecord.goodsName}" (createTime=${newRecord.createTime}) on attempt ${attempt}`);
      return newRecord;
    }

    // Log what we're seeing for this locker so far
    const seenCodes = afterPending.map(r => r.pickCode).join(', ') || '(none)';
    console.log(`  Attempt ${attempt}/${maxAttempts} — codes for "${lockerName}": [${seenCodes}] — no new code yet, waiting ${delayMs}ms...`);
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
    const lockerName = `Locker ${ch.roadRow}-${ch.roadColumn}`;
    const inUse      = pendingLockerNames.has(lockerName);
    console.log(`  ${ch.roadColumn}-${ch.roadRow} | roadId=${ch.roadId} | stock=${stock} | pendingCode=${inUse}`);
  });

  const free = channels.filter(ch => {
    const stock      = ch.roadStock ?? ch.stock ?? ch.goodsNum ?? 0;
    const lockerName = `Locker ${ch.roadRow}-${ch.roadColumn}`;
    return stock > 0 && !pendingLockerNames.has(lockerName);
  });

  if (!free.length) throw new Error('No free lockers available! All stocked lockers have pending pickup codes.');

  const ch         = free[0];
  const lockerName = `Locker ${ch.roadRow}-${ch.roadColumn}`;
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

    const channels           = await getAllChannels();
    const pendingLockerNames = await getPendingLockerNames(); // live API is source of truth

    const locker = await findFreeLocker(channels, pendingLockerNames);

    // ── Snapshot BEFORE addPickInfo ──────────────────────────────────────────
    console.log('\n📸 Snapshotting existing pending codes for this locker before creation...');
    const { codes: beforeCodes } = await getPendingCodesForLocker(locker.lockerName);

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
      // ── Fall back: poll using before/after snapshot diff ─────────────────
      console.log('⚠️  pickCode not in addPickInfo response — polling with snapshot diff...');
      const match = await waitForNewPickCode(locker.lockerName, beforeCodes);
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
