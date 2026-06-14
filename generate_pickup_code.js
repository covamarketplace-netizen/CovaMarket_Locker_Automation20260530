/**
 * generate_pickup_code.js
 *
 * CONFIRMED FACTS from debugging sessions:
 * 1. addPickInfo always returns {"code":"00000"} with NO pickCode in body.
 * 2. The list API (/api/pickInfo/list) has a 30-60s+ server-side cache.
 *    Polling allRecords total count is unreliable within that window.
 * 3. roadId is NULL in all pick list records — cannot use for matching.
 * 4. goodsName in pick records IS the locker label ("Locker 1-3") — use this.
 * 5. pickCode values are RECYCLED — Set diff on pickCodes produces wrong results.
 * 6. allRecords[last] is NOT reliably the newest — it reflects cached state.
 *
 * CORRECT STRATEGY:
 * - Before: snapshot all pickOrderNums for THIS locker's goodsName with status=0.
 * - Call addPickInfo.
 * - After: poll a TARGETED query (goodsName filter + status=0) for a new orderNum
 *   that wasn't in the before-snapshot. This avoids all global list cache issues.
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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function request(url, options = {}, body = null) {
  return new Promise((resolve, reject) => {
    const parsed  = new URL(url);
    const reqOpts = {
      hostname: parsed.hostname,
      path:     parsed.pathname + parsed.search,
      method:   options.method || 'GET',
      headers:  options.headers || {},
    };
    const req = https.request(reqOpts, (res) => {
      let data = '';
      res.on('data', c => data += c);
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

function loadActiveLockers() {
  try {
    if (!fs.existsSync(CONFIG.trackingFile)) return {};
    return JSON.parse(fs.readFileSync(CONFIG.trackingFile, 'utf8'));
  } catch { return {}; }
}

function saveActiveLockers(data) {
  const dir = path.dirname(CONFIG.trackingFile);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CONFIG.trackingFile, JSON.stringify(data, null, 2));
  console.log(`💾 Saved active_lockers.json (${Object.keys(data).length} entries)`);
}

// ── Channels ──────────────────────────────────────────────────────────────────
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

// ── Full list fetch (for pending detection only) ───────────────────────────────
async function fetchAllRecords(size = 50) {
  const first    = await request(
    `${CONFIG.baseUrl}/api/pickInfo/list?current=1&size=${size}&funId=${CONFIG.funId}&_t=${Date.now()}`,
    { method: 'GET', headers: authHeaders() }
  );
  const firstRecs = first.body?.data?.records || first.body?.rows || first.body?.data || [];
  const total     = first.body?.data?.total   || first.body?.total || 0;
  const lastPage  = Math.max(1, Math.ceil(total / size));
  console.log(`  📊 Total records: ${total} across ${lastPage} pages`);

  const allRecords = Array.isArray(firstRecs) ? [...firstRecs] : [];
  for (let page = 2; page <= lastPage; page++) {
    const res  = await request(
      `${CONFIG.baseUrl}/api/pickInfo/list?current=${page}&size=${size}&funId=${CONFIG.funId}&_t=${Date.now()}`,
      { method: 'GET', headers: authHeaders() }
    );
    const recs = res.body?.data?.records || res.body?.rows || res.body?.data || [];
    if (Array.isArray(recs) && recs.length) allRecords.push(...recs);
  }
  console.log(`  📊 Fetched ${allRecords.length} records total`);
  return allRecords;
}

/**
 * Pending detection: goodsName = "Locker 1-6" (confirmed from logs).
 * Returns Set of locker names that have status=0 codes.
 */
async function getPendingLockerNames() {
  console.log('🔍 Fetching ALL pick records (client-side pending filter)...');
  const allRecords = await fetchAllRecords();

  const pending = allRecords.filter(r => (r.pickStatus ?? r.status ?? -1) === 0);
  const names   = new Set(pending.map(r => r.goodsName).filter(Boolean));

  console.log(`🔒 Pending codes (status=0): ${pending.length} found`);
  pending.forEach(r =>
    console.log(`  code=${r.pickCode} | goodsName="${r.goodsName}" | orderNo=${r.pickOrderNum}`)
  );
  console.log(`🔒 Pending locker names: [${[...names].join(', ')}]`);
  return names;
}

// ── Targeted query for a specific locker ─────────────────────────────────────
/**
 * Query pick records filtered to a specific goodsName (locker label).
 * The server may support goodsName as a filter param — if not, we fetch page 1
 * with pickStatus=0 and filter client-side.
 * Returns array of matching records.
 */
async function fetchPendingForLocker(lockerName) {
  // Try server-side goodsName filter first
  const res = await request(
    `${CONFIG.baseUrl}/api/pickInfo/list?current=1&size=50&funId=${CONFIG.funId}&goodsName=${encodeURIComponent(lockerName)}&pickStatus=0&_t=${Date.now()}`,
    { method: 'GET', headers: authHeaders() }
  );
  const recs = res.body?.data?.records || res.body?.rows || res.body?.data || [];
  if (!Array.isArray(recs)) return [];

  // Filter client-side too in case server ignores the param
  return recs.filter(r =>
    r.goodsName === lockerName &&
    (r.pickStatus ?? r.status ?? -1) === 0
  );
}

/**
 * Snapshot: get all current pending orderNums for THIS locker before addPickInfo.
 * Used to detect which record is genuinely new after the call.
 */
async function snapshotLockerPending(lockerName) {
  console.log(`📸 Snapshotting pending codes for "${lockerName}"...`);
  const recs = await fetchPendingForLocker(lockerName);
  const orderNos = new Set(recs.map(r => r.pickOrderNum).filter(Boolean));
  const codes    = new Set(recs.map(r => r.pickCode).filter(Boolean));
  console.log(`  Found ${recs.length} existing pending record(s): orderNos=[${[...orderNos].join(', ')}] codes=[${[...codes].join(', ')}]`);
  return { orderNos, codes };
}

// ── addPickInfo ───────────────────────────────────────────────────────────────
async function addPickInfo(locker) {
  console.log(`\n🎟️  Creating pickup code for ${locker.lockerName} (goodsId=${locker.goodsId}, roadId=${locker.roadId})...`);
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
 * Poll TARGETED query for this specific locker until a new pickOrderNum appears.
 * This avoids global list cache completely — we only look at records for our locker.
 *
 * Waits 5s before first attempt, then 5s between each.
 * 15 attempts × 5s = 75s max.
 */
async function waitForNewCodeForLocker(lockerName, beforeOrderNos, beforeCodes, { maxAttempts = 15, delayMs = 5000 } = {}) {
  console.log(`\n⏳ Polling targeted query for "${lockerName}" (up to ${maxAttempts * delayMs / 1000}s)...`);
  console.log(`   Before: orderNos=[${[...beforeOrderNos].join(', ')}] codes=[${[...beforeCodes].join(', ')}]`);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await sleep(delayMs);
    const recs = await fetchPendingForLocker(lockerName);
    console.log(`  Attempt ${attempt}/${maxAttempts} — found ${recs.length} pending record(s) for "${lockerName}"`);
    recs.forEach(r => console.log(`    code=${r.pickCode} orderNo=${r.pickOrderNum} status=${r.pickStatus ?? r.status}`));

    // New record = orderNum not seen before OR (no orderNums exist) code not seen before
    const newRec = recs.find(r => {
      if (r.pickOrderNum) return !beforeOrderNos.has(r.pickOrderNum);
      if (r.pickCode)     return !beforeCodes.has(r.pickCode);
      return false;
    });

    if (newRec) {
      console.log(`✅ New record found on attempt ${attempt}: code=${newRec.pickCode} orderNo=${newRec.pickOrderNum}`);
      return newRec;
    }
  }

  console.warn(`⚠️  Targeted polling timed out after ${maxAttempts} attempts.`);
  return null;
}

// ── Locker selection ──────────────────────────────────────────────────────────
async function findFreeLocker(channels, pendingLockerNames) {
  const activeLockers  = loadActiveLockers();
  const activeRoadIds  = new Set(Object.keys(activeLockers));

  console.log(`\n📦 Total channels: ${channels.length}`);
  console.log(`📋 active_lockers.json entries: [${[...activeRoadIds].join(', ')}]`);

  channels.forEach(ch => {
    const stock      = ch.roadStock ?? ch.stock ?? ch.goodsNum ?? 0;
    const lockerName = `Locker ${ch.roadRow}-${ch.roadColumn}`;
    const hasPending = pendingLockerNames.has(lockerName);
    const isActive   = activeRoadIds.has(String(ch.roadId));
    console.log(`  ${ch.roadColumn}-${ch.roadRow} | roadId=${ch.roadId} | goodsId=${ch.goodsId ?? 'NULL'} | stock=${stock} | pendingAPI=${hasPending} | inTracker=${isActive}`);
  });

  const free = channels.filter(ch => {
    const stock      = ch.roadStock ?? ch.stock ?? ch.goodsNum ?? 0;
    const lockerName = `Locker ${ch.roadRow}-${ch.roadColumn}`;
    return stock > 0 && !pendingLockerNames.has(lockerName) && !activeRoadIds.has(String(ch.roadId));
  });

  if (!free.length) {
    // Fallback: ignore tracker, use API state only
    console.warn('⚠️  No free locker excluding tracker — falling back to API pending state only');
    const free2 = channels.filter(ch => {
      const stock      = ch.roadStock ?? ch.stock ?? ch.goodsNum ?? 0;
      const lockerName = `Locker ${ch.roadRow}-${ch.roadColumn}`;
      return stock > 0 && !pendingLockerNames.has(lockerName);
    });
    if (!free2.length) throw new Error('No free lockers available!');
    const ch = free2[0];
    return mkLocker(ch);
  }

  return mkLocker(free[0]);
}

function mkLocker(ch) {
  const lockerName = `Locker ${ch.roadRow}-${ch.roadColumn}`;
  console.log(`\n✅ Selected: ${lockerName} | roadId=${ch.roadId} | goodsId=${ch.goodsId}`);
  return { goodsId: ch.goodsId, roadId: ch.roadId, column: ch.roadColumn, row: ch.roadRow, lockerName };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  try {
    if (!CONFIG.token) throw new Error('XYZ_TOKEN secret is not set!');
    console.log('🔑 Using stored JWT token');
    console.log(`📦 funId=${CONFIG.funId}\n`);

    const channels          = await getAllChannels();
    const pendingLockerNames = await getPendingLockerNames();
    const locker            = await findFreeLocker(channels, pendingLockerNames);

    // ── Snapshot BEFORE ───────────────────────────────────────────────────────
    const { orderNos: beforeOrderNos, codes: beforeCodes } = await snapshotLockerPending(locker.lockerName);

    // ── Create ────────────────────────────────────────────────────────────────
    const result = await addPickInfo(locker);
    if (result?.code !== '00000') {
      throw new Error(`addPickInfo failed: ${JSON.stringify(result)}`);
    }

    // ── Try direct response first ─────────────────────────────────────────────
    let pickCode = result?.data?.pickCode
      || (Array.isArray(result?.data) && result.data[0]?.pickCode)
      || result?.pickCode
      || null;
    let orderNo  = result?.data?.pickOrderNum
      || (Array.isArray(result?.data) && result.data[0]?.pickOrderNum)
      || null;

    if (pickCode) {
      console.log(`✅ pickCode in response: ${pickCode}`);
    } else {
      // ── Targeted poll ─────────────────────────────────────────────────────
      const newRec = await waitForNewCodeForLocker(locker.lockerName, beforeOrderNos, beforeCodes);
      if (newRec) {
        pickCode = newRec.pickCode;
        orderNo  = newRec.pickOrderNum;
      }
    }

    if (!pickCode) {
      throw new Error(
        `addPickInfo returned success but pick code not found after 75s of targeted polling.\n` +
        `Code WAS created server-side — check the UI for locker ${locker.lockerName}.\n` +
        `Response: ${JSON.stringify(result)}`
      );
    }

    // ── Save ──────────────────────────────────────────────────────────────────
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

    console.log('OUTPUT_JSON:' + JSON.stringify({
      success: true, pickCode, orderNo,
      locker:  `${locker.column}-${locker.row}`,
      funId:   CONFIG.funId, goodsId: locker.goodsId, roadId: locker.roadId,
      generatedAt: new Date().toISOString(),
    }));

  } catch (err) {
    console.error('❌ Error:', err.message);
    console.log('OUTPUT_JSON:' + JSON.stringify({ success: false, error: err.message }));
    process.exit(1);
  }
}

main();
