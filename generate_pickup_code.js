/**
 * generate_pickup_code.js
 * Generates XYZ Vending pickup code using JWT token.
 *
 * KEY FINDINGS from debugging:
 * - API list sorts OLDEST-FIRST. New codes appear on the LAST page.
 * - pickStatus=0 filter is UNRELIABLE — returns incomplete results.
 * - addPickInfo silently no-ops if the locker already has a pending code.
 *
 * Strategy:
 * - Fetch ALL records from ALL pages (client-side paginate), filter status=0 ourselves.
 * - Snapshot ALL pickCodes before addPickInfo.
 * - After addPickInfo, poll ALL pages for any new pickCode not in snapshot.
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
  } catch { return {}; }
}

function saveActiveLockers(data) {
  const dir = path.dirname(CONFIG.trackingFile);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CONFIG.trackingFile, JSON.stringify(data, null, 2));
  console.log(`💾 Saved active_lockers.json (${Object.keys(data).length} active lockers)`);
}

// ── API: channels ─────────────────────────────────────────────────────────────
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
 * Fetch EVERY record from EVERY page — no server-side status filter.
 * Returns { allRecords, allCodes: Set<pickCode>, total }
 */
async function fetchAllRecords(size = 50) {
  // Page 1 to get total
  const first    = await request(
    `${CONFIG.baseUrl}/api/pickInfo/list?current=1&size=${size}&funId=${CONFIG.funId}`,
    { method: 'GET', headers: authHeaders() }
  );
  const firstRecs = first.body?.data?.records || first.body?.rows || first.body?.data || [];
  const total     = first.body?.data?.total   || first.body?.total || 0;
  const lastPage  = Math.max(1, Math.ceil(total / size));

  console.log(`  📊 Total records: ${total} across ${lastPage} pages`);

  const allRecords = Array.isArray(firstRecs) ? [...firstRecs] : [];

  // Fetch remaining pages
  for (let page = 2; page <= lastPage; page++) {
    const res  = await request(
      `${CONFIG.baseUrl}/api/pickInfo/list?current=${page}&size=${size}&funId=${CONFIG.funId}`,
      { method: 'GET', headers: authHeaders() }
    );
    const recs = res.body?.data?.records || res.body?.rows || res.body?.data || [];
    if (Array.isArray(recs) && recs.length) allRecords.push(...recs);
  }

  const allCodes = new Set(allRecords.map(r => r.pickCode).filter(Boolean));
  console.log(`  📊 Fetched ${allRecords.length} records total | ${allCodes.size} unique pickCodes`);
  return { allRecords, allCodes, total };
}

/**
 * Get full pending state by fetching ALL records and filtering client-side.
 * Returns { names: Set<goodsName with pending>, allCodes: Set<all pickCodes>, total }
 */
async function getPendingState() {
  console.log('🔍 Fetching ALL pick records (client-side pending filter)...');
  const { allRecords, allCodes, total } = await fetchAllRecords();

  const pending = allRecords.filter(r => (r.pickStatus ?? r.status ?? -1) === 0);
  const names   = new Set(pending.map(r => r.goodsName).filter(Boolean));

  console.log(`🔒 Pending codes (status=0): ${pending.length} found`);
  pending.forEach(r =>
    console.log(`  code=${r.pickCode} | locker="${r.goodsName}" | status=${r.pickStatus} | created=${r.createTime}`)
  );
  console.log(`🔒 Lockers with pending codes: [${[...names].join(', ')}]`);

  return { names, allCodes, total };
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
 * Poll ALL pages for any pickCode not in beforeAllCodes.
 * No goodsName or status filter — catches the code regardless of how API stores it.
 */
async function waitForNewPickCode(beforeAllCodes, beforeTotal, { maxAttempts = 8, delayMs = 3000 } = {}) {
  console.log(`🔍 Polling ALL pages for new code (before: ${beforeAllCodes.size} codes, ${beforeTotal} total)...`);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { allRecords, total } = await fetchAllRecords();

    console.log(`  Attempt ${attempt}/${maxAttempts} — total now: ${total} (was ${beforeTotal})`);

    if (attempt === 1) {
      // Log the 5 newest (last in array since oldest-first sort)
      allRecords.slice(-5).forEach(r =>
        console.log(`  📋 newest: code=${r.pickCode} locker="${r.goodsName}" status=${r.pickStatus ?? r.status} createTime=${r.createTime}`)
      );
    }

    const newRecord = allRecords.find(r => r.pickCode && !beforeAllCodes.has(r.pickCode)) ?? null;
    if (newRecord) {
      console.log(`✅ Found new code ${newRecord.pickCode} under "${newRecord.goodsName}" status=${newRecord.pickStatus ?? newRecord.status} on attempt ${attempt}`);
      return newRecord;
    }

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
    console.log(`  ${ch.roadColumn}-${ch.roadRow} | roadId=${ch.roadId} | goodsId=${ch.goodsId ?? 'NULL'} | stock=${stock} | pendingCode=${pendingNames.has(lockerName)}`);
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

    const channels = await getAllChannels();
    const { names: pendingNames, allCodes: beforeAllCodes, total: beforeTotal } = await getPendingState();

    const locker = await findFreeLocker(channels, pendingNames);

    // ── Create the pick code ─────────────────────────────────────────────────
    const result = await addPickInfo(locker);

    // ── Try direct from response ─────────────────────────────────────────────
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
      console.log('⚠️  pickCode not in response — polling all pages...');
      const match = await waitForNewPickCode(beforeAllCodes, beforeTotal);
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
