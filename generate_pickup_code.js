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
 *   1. Count total pending codes globally BEFORE addPickInfo.
 *   2. Snapshot pending pickCode IDs for the target locker BEFORE addPickInfo.
 *   3. Call addPickInfo.
 *   4. Try to extract pickCode directly from the response.
 *   5. If not in response, do ONE quick check of the global total — if it didn't
 *      increase, the API silently did nothing (bad goodsId / roadId), so skip this
 *      locker and try the next free one immediately.
 *   6. Otherwise poll for the new code using before/after snapshot diff (clock-skew-proof).
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
 * Returns { names: Set<string>, totalCount: number, allRecords: array }
 * names  = Set of goodsName values with pending codes (used for locker selection)
 * totalCount = total number of pending records globally (used for silent-fail detection)
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

  // Filter to only truly pending (status=0) records (in case API ignores pickStatus param)
  const pending = allRecords.filter(r => (r.pickStatus ?? r.status ?? -1) === 0);
  const names   = new Set(pending.map(r => r.goodsName).filter(Boolean));

  console.log(`🔒 Lockers with pending codes: [${[...names].join(', ')}] (${pending.length} pending codes total)`);
  pending.forEach(r => {
    console.log(`  code=${r.pickCode} | locker="${r.goodsName}" | status=${r.pickStatus} | created=${r.createTime}`);
  });

  return { names, totalCount: pending.length, allRecords: pending };
}

/**
 * Quick snapshot: pending pickCodes for a specific locker + global total count.
 * Used as the BEFORE snapshot immediately before addPickInfo.
 */
async function snapshotBefore(lockerName) {
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

  const pending     = allRecords.filter(r => (r.pickStatus ?? r.status ?? -1) === 0);
  const forLocker   = pending.filter(r => r.goodsName === lockerName);
  const lockerCodes = new Set(forLocker.map(r => r.pickCode).filter(Boolean));

  console.log(`  📸 Pre-snapshot: ${pending.length} total pending | "${lockerName}" has ${lockerCodes.size} codes [${[...lockerCodes].join(', ')}]`);
  return { lockerCodes, totalCount: pending.length };
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
 * Quick check: did the global pending count increase since the before-snapshot?
 * Fetches just page 1 (fast) — we only need the total count, not all records.
 * Returns { increased: boolean, newTotal: number, allPending: array }
 */
async function quickCountCheck() {
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
  return { newTotal: pending.length, allPending: pending };
}

/**
 * Poll until a NEW pending code appears for the target locker —
 * i.e. a pickCode that was NOT in the before-snapshot.
 * Clock-skew-proof: identifies "our" code by set difference, not createTime.
 */
async function waitForNewPickCode(lockerName, beforeCodes, { maxAttempts = 8, delayMs = 3000 } = {}) {
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

    const pending    = allRecords.filter(r => (r.pickStatus ?? r.status ?? -1) === 0);
    const forLocker  = pending.filter(r => r.goodsName === lockerName);
    const newRecord  = forLocker.find(r => r.pickCode && !beforeCodes.has(r.pickCode)) ?? null;

    if (newRecord) {
      console.log(`✅ Found new code ${newRecord.pickCode} for "${newRecord.goodsName}" (createTime=${newRecord.createTime}) on attempt ${attempt}`);
      return newRecord;
    }

    const seenCodes = forLocker.map(r => r.pickCode).join(', ') || '(none)';
    console.log(`  Attempt ${attempt}/${maxAttempts} — "${lockerName}": [${seenCodes}] | total pending: ${pending.length} — waiting ${delayMs}ms...`);
    if (attempt < maxAttempts) await new Promise(r => setTimeout(r, delayMs));
  }

  console.warn(`⚠️  New pick code not found after ${maxAttempts} attempts.`);
  return null;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function findFreeLockers(channels, pendingNames) {
  console.log(`\n📦 Total channels: ${channels.length}`);

  channels.forEach(ch => {
    const stock      = ch.roadStock ?? ch.stock ?? ch.goodsNum ?? 0;
    const lockerName = `Locker ${ch.roadRow}-${ch.roadColumn}`;
    const inUse      = pendingNames.has(lockerName);
    // Log goodsId explicitly so we can spot null/0 values
    console.log(`  ${ch.roadColumn}-${ch.roadRow} | roadId=${ch.roadId} | goodsId=${ch.goodsId ?? 'NULL'} | stock=${stock} | pendingCode=${inUse}`);
  });

  const free = channels
    .filter(ch => {
      const stock      = ch.roadStock ?? ch.stock ?? ch.goodsNum ?? 0;
      const lockerName = `Locker ${ch.roadRow}-${ch.roadColumn}`;
      const hasGoods   = ch.goodsId != null && ch.goodsId !== 0;
      if (!hasGoods) console.log(`  ⚠️  Skipping ${ch.roadColumn}-${ch.roadRow}: goodsId is null/0`);
      return stock > 0 && !pendingNames.has(lockerName) && hasGoods;
    });

  if (!free.length) throw new Error('No free lockers available! All stocked lockers (with goodsId) have pending pickup codes.');

  return free.map(ch => ({
    goodsId:    ch.goodsId,
    roadId:     ch.roadId,
    column:     ch.roadColumn,
    row:        ch.roadRow,
    stock:      ch.roadStock ?? ch.stock ?? ch.goodsNum,
    lockerName: `Locker ${ch.roadRow}-${ch.roadColumn}`,
  }));
}

async function main() {
  try {
    if (!CONFIG.token) throw new Error('XYZ_TOKEN secret is not set!');
    console.log('🔑 Using stored JWT token');
    console.log(`📦 funId=${CONFIG.funId}\n`);

    const channels                    = await getAllChannels();
    const { names: pendingNames }     = await getPendingState();
    const freeLockers                 = await findFreeLockers(channels, pendingNames);

    console.log(`\n🔓 ${freeLockers.length} free locker(s) to try: ${freeLockers.map(l => l.lockerName).join(', ')}`);

    let pickCode = null;
    let orderNo  = null;
    let usedLocker = null;

    // Try each free locker in order until one successfully creates a code
    for (const locker of freeLockers) {
      console.log(`\n▶️  Trying ${locker.lockerName} (roadId=${locker.roadId}, goodsId=${locker.goodsId})...`);

      // ── Snapshot BEFORE addPickInfo ──────────────────────────────────────
      const { lockerCodes: beforeCodes, totalCount: beforeTotal } = await snapshotBefore(locker.lockerName);

      // ── Create the pick code ─────────────────────────────────────────────
      const result = await addPickInfo(locker);

      // ── Try to get pickCode directly from addPickInfo response ───────────
      pickCode = result?.data?.pickCode
        || (Array.isArray(result?.data) && result.data[0]?.pickCode)
        || result?.pickCode
        || null;
      orderNo = result?.data?.pickOrderNum
        || (Array.isArray(result?.data) && result.data[0]?.pickOrderNum)
        || null;

      if (pickCode) {
        console.log(`✅ pickCode found directly in addPickInfo response: ${pickCode}`);
        usedLocker = locker;
        break;
      }

      // ── Silent-fail detection: check if global total increased ───────────
      console.log('⚠️  pickCode not in response — checking if total pending count increased...');
      await new Promise(r => setTimeout(r, 1500)); // small wait for DB propagation
      const { newTotal, allPending } = await quickCountCheck();
      console.log(`  Total pending before: ${beforeTotal} | after: ${newTotal}`);

      if (newTotal <= beforeTotal) {
        // API accepted the request but created nothing — this locker is broken
        console.warn(`  ❌ Total count did NOT increase (${beforeTotal} → ${newTotal}). addPickInfo silently failed for ${locker.lockerName}. Skipping to next locker.`);
        continue; // try next free locker
      }

      // Total increased — the code exists somewhere, poll for it
      console.log(`  ✅ Total count increased (${beforeTotal} → ${newTotal}). Polling for new code on "${locker.lockerName}"...`);

      // Also check if maybe the code appeared under a different locker name (defensive)
      const anyNew = allPending.find(r => r.pickCode && !beforeCodes.has(r.pickCode));
      if (anyNew && anyNew.goodsName !== locker.lockerName) {
        console.warn(`  ⚠️  New code appeared under "${anyNew.goodsName}" instead of "${locker.lockerName}" — using it anyway`);
        pickCode   = anyNew.pickCode;
        orderNo    = anyNew.pickOrderNum;
        usedLocker = { ...locker, lockerName: anyNew.goodsName };
        break;
      }

      const match = await waitForNewPickCode(locker.lockerName, beforeCodes);
      if (match?.pickCode) {
        pickCode   = match.pickCode;
        orderNo    = match.pickOrderNum;
        usedLocker = locker;
        break;
      }

      console.warn(`  ❌ Could not retrieve code for ${locker.lockerName} after polling. Skipping to next locker.`);
    }

    if (!pickCode || !usedLocker) throw new Error('No pickup code could be generated for any free locker.');

    // ── Save tracking file ────────────────────────────────────────────────────
    const activeLockers = loadActiveLockers();
    activeLockers[usedLocker.roadId] = {
      pickCode,
      orderNo:   orderNo || null,
      locker:    `${usedLocker.column}-${usedLocker.row}`,
      goodsId:   usedLocker.goodsId,
      createdAt: new Date().toISOString(),
    };
    saveActiveLockers(activeLockers);

    console.log('\n═══════════════════════════════════');
    console.log(`✅ PICKUP CODE : ${pickCode}`);
    console.log(`📋 ORDER NO   : ${orderNo || 'N/A'}`);
    console.log(`📦 LOCKER     : ${usedLocker.column}-${usedLocker.row} (roadId=${usedLocker.roadId})`);
    console.log('═══════════════════════════════════\n');

    const output = {
      success:     true,
      pickCode,
      orderNo,
      locker:      `${usedLocker.column}-${usedLocker.row}`,
      funId:       CONFIG.funId,
      goodsId:     usedLocker.goodsId,
      roadId:      usedLocker.roadId,
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
