/**
 * generate_pickup_code.js
 * Generates XYZ Vending pickup code using JWT token.
 *
 * Tracks active lockers in pickup_codes/active_lockers.json.
 * Before picking a locker, reconciles tracked lockers against the live
 * pick code list — frees any locker whose code is no longer pending (status != 0).
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

// ── Tracking file ─────────────────────────────────────────────────────────────
function loadActiveLockers() {
  try {
    if (!fs.existsSync(CONFIG.trackingFile)) return {};
    return JSON.parse(fs.readFileSync(CONFIG.trackingFile, 'utf8'));
  } catch {
    console.warn('⚠️  Could not read active_lockers.json — starting fresh.');
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
 * Look up a specific pick code's status by searching the list for it.
 * Returns the pickStatus number, or null if not found.
 */
async function getPickCodeStatus(pickCode) {
  const res = await request(
    `${CONFIG.baseUrl}/api/pickInfo/list?current=1&size=50&pickCode=${pickCode}`,
    { method: 'GET', headers: authHeaders() }
  );
  const records = res.body?.rows || res.body?.data?.records || res.body?.data || [];
  const list    = Array.isArray(records) ? records : [];
  const match   = list.find(r => String(r.pickCode) === String(pickCode));
  return match ? (match.pickStatus ?? match.status ?? null) : null;
}

/**
 * Reconcile active_lockers.json against the live API.
 * Removes any locker whose pick code is no longer status=0 (pending).
 *   status 0 = awaiting pickup  → keep locked
 *   status 1 = completed        → free locker
 *   status 2 = invalid/expired  → free locker
 *   status 3 = ???              → free locker (anything not 0)
 *   null     = not found        → free locker (code was voided/deleted)
 */
async function reconcileActiveLockers(activeLockers) {
  const roadIds = Object.keys(activeLockers);
  if (!roadIds.length) return activeLockers;

  console.log(`\n🔄 Reconciling ${roadIds.length} tracked locker(s) against live API...`);
  const updated = { ...activeLockers };

  for (const roadId of roadIds) {
    const entry     = activeLockers[roadId];
    const status    = await getPickCodeStatus(entry.pickCode);
    const statusStr = status === null ? 'NOT FOUND' : String(status);

    if (status === 0) {
      console.log(`  🔒 Locker ${entry.locker} (code ${entry.pickCode}) — still pending (status=0) → keeping locked`);
    } else {
      console.log(`  ✅ Locker ${entry.locker} (code ${entry.pickCode}) — status=${statusStr} → FREED`);
      delete updated[roadId];
    }
  }

  return updated;
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
 * Fetch the newest pending pick code for a specific roadId.
 * Retries up to maxAttempts times with a delay — handles API propagation lag.
 * No clock/timezone comparison: we identify "our" code by roadId + status=0.
 */
async function getPickCodeForRoad(roadId, scriptStart, { maxAttempts = 6, delayMs = 3000 } = {}) {
  console.log(`🔍 Fetching pending pick code for roadId=${roadId} (scriptStart=${scriptStart}, up to ${maxAttempts} attempts)...`);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await request(
      `${CONFIG.baseUrl}/api/pickInfo/list?current=1&size=20&funId=${CONFIG.funId}`,
      { method: 'GET', headers: authHeaders() }
    );
    const records = res.body?.rows || res.body?.data?.records || res.body?.data || [];
    const list    = Array.isArray(records) ? records : [];

    // roadId is always null in list responses — match by newest createTime + status=0 + goodsName
    // createTime is a Unix ms timestamp. Filter pending codes for this locker by goodsName,
    // then pick the one created AFTER we started (scriptStart), or the most recent overall.
    const pending = list
      .filter(r => (r.pickStatus ?? r.status ?? -1) === 0)
      .sort((a, b) => (b.createTime ?? 0) - (a.createTime ?? 0)); // newest first

    // Prefer a code created after this script started running
    const fresh = pending.find(r => (r.createTime ?? 0) >= scriptStart);
    const match = fresh ?? null;

    if (match) {
      console.log(`✅ Found code ${match.pickCode} (createTime=${match.createTime}, scriptStart=${scriptStart}) on attempt ${attempt}`);
      return match;
    }

    console.log(`  Attempt ${attempt}/${maxAttempts} — no fresh pending code yet (${pending.length} pending total), waiting ${delayMs}ms...`);

    console.log(`  Attempt ${attempt}/${maxAttempts} — no pending code visible yet, waiting ${delayMs}ms...`);
    if (attempt < maxAttempts) await new Promise(r => setTimeout(r, delayMs));
  }

  console.warn(`⚠️  No pending code found for roadId=${roadId} after ${maxAttempts} attempts.`);
  return null;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function findFreeLocker(channels, activeLockers) {
  const activeRoadIds = new Set(Object.keys(activeLockers).map(Number));

  console.log(`\n📦 Total channels: ${channels.length}`);
  console.log(`🔒 Active (locked) lockers: [${[...activeRoadIds].join(', ')}]`);

  channels.forEach(ch => {
    const stock  = ch.roadStock ?? ch.stock ?? ch.goodsNum ?? 0;
    const active = activeRoadIds.has(ch.roadId);
    console.log(`  ${ch.roadColumn}-${ch.roadRow} | roadId=${ch.roadId} | stock=${stock} | inUse=${active}`);
  });

  const free = channels.filter(ch => {
    const stock = ch.roadStock ?? ch.stock ?? ch.goodsNum ?? 0;
    return stock > 0 && !activeRoadIds.has(ch.roadId);
  });

  if (!free.length) throw new Error('No free lockers available! All stocked lockers are assigned.');

  const ch = free[0];
  console.log(`\n✅ Selected: ${ch.roadColumn}-${ch.roadRow} | roadId=${ch.roadId}`);
  return {
    goodsId: ch.goodsId,
    roadId:  ch.roadId,
    column:  ch.roadColumn,
    row:     ch.roadRow,
    stock:   ch.roadStock ?? ch.stock ?? ch.goodsNum,
  };
}

async function main() {
  try {
    if (!CONFIG.token) throw new Error('XYZ_TOKEN secret is not set!');
    console.log('🔑 Using stored JWT token');
    console.log(`📦 funId=${CONFIG.funId}\n`);

    const channels = await getAllChannels();

    // Reconcile tracked lockers — free any whose code is no longer pending
    let activeLockers = loadActiveLockers();
    activeLockers     = await reconcileActiveLockers(activeLockers);
    saveActiveLockers(activeLockers); // save reconciled state before generating

    const locker = await findFreeLocker(channels, activeLockers);
    const scriptStart = Date.now(); // ms timestamp — used to identify the code we just created
    const result = await addPickInfo(locker);

    // Extract pick code from addPickInfo response first
    let pickCode = result?.data?.pickCode
      || (Array.isArray(result?.data) && result.data[0]?.pickCode)
      || result?.pickCode
      || null;
    let orderNo = result?.data?.pickOrderNum
      || (Array.isArray(result?.data) && result.data[0]?.pickOrderNum)
      || null;

    // Only fall back to list if response didn't include the code
    if (!pickCode) {
      console.log('⚠️  pickCode not in response — searching list by createTime...');
      const match = await getPickCodeForRoad(locker.roadId, scriptStart);
      if (match?.pickCode) {
        pickCode = match.pickCode;
        orderNo  = match.pickOrderNum;
      }
    }

    if (!pickCode) throw new Error('No pickup code found. Response: ' + JSON.stringify(result));

    // Save this locker as active
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
