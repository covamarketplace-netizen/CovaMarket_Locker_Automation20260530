/**
 * generate_pickup_code.js
 * Generates XYZ Vending pickup code using JWT token.
 *
 * The API list endpoint returns ALL statuses (ignores pickStatus param) and
 * sorts OLDEST-FIRST. With 116+ total records, new codes land on the LAST page.
 * Strategy: always fetch the last 2 pages to find newest records.
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
 * Fetch pick list page and return { records, total }.
 * Does NOT pass pickStatus — server ignores it anyway.
 * PAGE SIZE = 50.
 */
async function fetchPickPage(page, size = 50) {
  const res = await request(
    `${CONFIG.baseUrl}/api/pickInfo/list?current=${page}&size=${size}&funId=${CONFIG.funId}`,
    { method: 'GET', headers: authHeaders() }
  );
  const body    = res.body;
  const records = body?.data?.records || body?.rows || body?.data || [];
  const total   = body?.data?.total   || body?.total || 0;
  return {
    records: Array.isArray(records) ? records : [],
    total:   typeof total === 'number' ? total : 0,
  };
}

/**
 * Fetch the NEWEST records from the list.
 * Since the API sorts oldest-first, newest records are on the LAST page(s).
 * Fetches the last 3 pages to cover any new codes.
 * Returns all fetched records (may include non-pending ones — filter yourself).
 */
async function fetchNewestRecords(size = 50) {
  // First fetch page 1 just to get the total count
  const first    = await fetchPickPage(1, size);
  const total    = first.total;
  const lastPage = Math.max(1, Math.ceil(total / size));

  console.log(`  📊 Total records in system: ${total} | Last page: ${lastPage}`);

  // Fetch last 3 pages (newest records)
  const pagesToFetch = [lastPage, lastPage - 1, lastPage - 2].filter(p => p >= 1);
  const allRecords   = [...first.records]; // include page 1 in case total=0 or only 1 page

  for (const page of pagesToFetch) {
    if (page === 1) continue; // already have page 1
    const { records } = await fetchPickPage(page, size);
    allRecords.push(...records);
  }

  return { records: allRecords, total };
}

/**
 * Get pending codes for locker-busy detection.
 * Pending = pickStatus === 0.
 * Fetches page 1 with pickStatus=0 filter (may work for status filtering even if
 * ordering is oldest-first), PLUS the last pages without filter.
 * Returns { names: Set<goodsName>, allCodes: Set<pickCode>, totalOverall }
 */
async function getPendingState() {
  console.log('🔍 Fetching pending pick codes (status=0) for locker selection...');

  // Fetch with status filter — may return oldest pending, good enough for "is locker busy"
  const res = await request(
    `${CONFIG.baseUrl}/api/pickInfo/list?current=1&size=100&funId=${CONFIG.funId}&pickStatus=0`,
    { method: 'GET', headers: authHeaders() }
  );
  const body    = res.body;
  const rawList = body?.data?.records || body?.rows || body?.data || [];
  const list    = Array.isArray(rawList) ? rawList : [];
  const pending = list.filter(r => (r.pickStatus ?? r.status ?? -1) === 0);

  const names = new Set(pending.map(r => r.goodsName).filter(Boolean));
  console.log(`🔒 Lockers with pending codes: [${[...names].join(', ')}] (${pending.length} pending found)`);
  pending.forEach(r =>
    console.log(`  code=${r.pickCode} | locker="${r.goodsName}" | status=${r.pickStatus} | created=${r.createTime}`)
  );

  // Also snapshot ALL codes from newest pages for before/after diff
  console.log('📸 Snapshotting newest records for before-diff...');
  const { records: newestRecords, total: totalOverall } = await fetchNewestRecords();
  const allCodes = new Set(newestRecords.map(r => r.pickCode).filter(Boolean));
  console.log(`  📸 Snapshot: ${allCodes.size} codes from newest pages | ${totalOverall} total records overall`);

  return { names, allCodes, totalOverall };
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
 * Poll the NEWEST pages for any code that wasn't in beforeAllCodes.
 * Does not filter by goodsName or pickStatus.
 */
async function waitForNewPickCode(beforeAllCodes, beforeTotal, { maxAttempts = 8, delayMs = 3000 } = {}) {
  console.log(`🔍 Polling newest pages for new code (before: ${beforeAllCodes.size} codes, ${beforeTotal} total records)...`);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { records, total } = await fetchNewestRecords();

    console.log(`  Attempt ${attempt}/${maxAttempts} — total records now: ${total} (was ${beforeTotal})`);

    // Log newest 5 records on first attempt
    if (attempt === 1) {
      records.slice(0, 5).forEach(r =>
        console.log(`  📋 code=${r.pickCode} locker="${r.goodsName}" status=${r.pickStatus ?? r.status} createTime=${r.createTime}`)
      );
    }

    // Any code not in the before-snapshot is our new one
    const newRecord = records.find(r => r.pickCode && !beforeAllCodes.has(r.pickCode)) ?? null;

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

    const channels                                       = await getAllChannels();
    const { names: pendingNames, allCodes: beforeAllCodes, totalOverall: beforeTotal } = await getPendingState();

    const locker = await findFreeLocker(channels, pendingNames);

    // ── Create the pick code ─────────────────────────────────────────────────
    const result = await addPickInfo(locker);

    // ── Try to get pickCode directly from response ───────────────────────────
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
      console.log('⚠️  pickCode not in response — polling newest pages...');
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
