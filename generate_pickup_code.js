/**
 * generate_pickup_code.js
 * Generates XYZ Vending pickup code using JWT token.
 *
 * KEY FINDINGS from debugging:
 * - API list sorts OLDEST-FIRST. New codes appear on the LAST page.
 * - pickStatus=0 filter is UNRELIABLE — returns incomplete results.
 * - addPickInfo silently no-ops if locker already has a pending code (returns 00000 either way).
 * - addPickInfo returns {"code":"00000","msg":"请求成功"} with NO pickCode in body.
 * - roadId is NULL in ALL pick list records — cannot use for pending detection.
 * - goodsName in pick records IS the locker label ("Locker 1-6") — use this for pending detection.
 * - The list API has a cache/lag of 10-60s — new records don't appear immediately.
 * - pickCode values can be RECYCLED across runs — Set diff misses recycled codes.
 *
 * Strategy:
 * - Snapshot ALL pickOrderNums + total count before addPickInfo (orderNums are unique per tx).
 * - Filter pending by goodsName matching "Locker {row}-{col}" pattern.
 * - After addPickInfo, poll with longer delays (up to 60s) for total increase OR new orderNum.
 * - If polling times out but addPickInfo returned 00000 (success), treat as soft-success:
 *   save a placeholder in active_lockers.json and re-fetch the latest record for that locker
 *   via a targeted search (pickStatus=0 for this goodsId).
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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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
  console.log(`💾 Saved active_lockers.json (${Object.keys(data).length} entries)`);
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
 * Fetch ALL records from ALL pages. Returns:
 * { allRecords, allOrderNos: Set<pickOrderNum>, total }
 */
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

  const allOrderNos = new Set(allRecords.map(r => r.pickOrderNum).filter(Boolean));
  console.log(`  📊 Fetched ${allRecords.length} records | ${allOrderNos.size} unique orderNos`);
  return { allRecords, allOrderNos, total };
}

/**
 * Pending detection: goodsName in pick records IS the locker label ("Locker 1-6").
 * roadId is always null in pick records — do NOT use it.
 *
 * Returns { pendingLockerNames: Set<"Locker row-col">, allOrderNos, total }
 */
async function getPendingState() {
  console.log('🔍 Fetching ALL pick records (client-side pending filter)...');
  const { allRecords, allOrderNos, total } = await fetchAllRecords();

  const pending            = allRecords.filter(r => (r.pickStatus ?? r.status ?? -1) === 0);
  const pendingLockerNames = new Set(pending.map(r => r.goodsName).filter(Boolean));

  console.log(`🔒 Pending codes (status=0): ${pending.length} found`);
  pending.forEach(r =>
    console.log(`  code=${r.pickCode} | goodsName="${r.goodsName}" | orderNo=${r.pickOrderNum} | status=${r.pickStatus ?? r.status}`)
  );
  console.log(`🔒 Locker names with pending codes: [${[...pendingLockerNames].join(', ')}]`);

  return { pendingLockerNames, allOrderNos, total };
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
 * Poll for the new record using TWO signals:
 *   PRIMARY:   total record count increased → grab last record (newest, oldest-first sort)
 *   SECONDARY: a pickOrderNum appeared that wasn't in beforeAllOrderNos
 *
 * Uses increasing delay: 5s × 12 attempts = up to 60s wait.
 * The API has a known cache lag — previous runs saw 0/8 attempts succeed at 3s intervals.
 */
async function waitForNewPickCode(beforeAllOrderNos, beforeTotal, { maxAttempts = 12, delayMs = 5000 } = {}) {
  console.log(`🔍 Polling for new record (before: ${beforeAllOrderNos.size} orderNos, total=${beforeTotal})...`);
  console.log(`   Strategy: up to ${maxAttempts} attempts × ${delayMs/1000}s = ${maxAttempts * delayMs / 1000}s max wait`);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await sleep(delayMs); // wait FIRST — API always lags
    const { allRecords, allOrderNos, total } = await fetchAllRecords();

    console.log(`  Attempt ${attempt}/${maxAttempts} — total now: ${total} (was ${beforeTotal})`);

    // PRIMARY: count increased → last record is the new one
    if (total > beforeTotal) {
      const newRecord = allRecords[allRecords.length - 1];
      if (newRecord?.pickCode) {
        console.log(`✅ Count increased (${beforeTotal}→${total}). Code=${newRecord.pickCode} orderNo=${newRecord.pickOrderNum} attempt=${attempt}`);
        return { record: newRecord, certain: true };
      }
    }

    // SECONDARY: new orderNum appeared
    const byOrderNo = allRecords.find(r => r.pickOrderNum && !beforeAllOrderNos.has(r.pickOrderNum));
    if (byOrderNo) {
      console.log(`✅ New orderNo detected: ${byOrderNo.pickOrderNum} → code=${byOrderNo.pickCode} attempt=${attempt}`);
      return { record: byOrderNo, certain: true };
    }
  }

  console.warn(`⚠️  Polling timed out after ${maxAttempts} attempts × ${delayMs/1000}s.`);
  return { record: null, certain: false };
}

/**
 * Last-resort recovery after addPickInfo success but polling timeout:
 * Fetch page 1 with pickStatus=0 filter for this specific goodsId.
 * The server-side filter is unreliable for the full list, but may work for a targeted query.
 */
async function recoverCodeByGoodsId(locker) {
  console.log(`\n🔄 Recovery: querying pending codes for goodsId=${locker.goodsId}...`);
  try {
    const res = await request(
      `${CONFIG.baseUrl}/api/pickInfo/list?current=1&size=10&funId=${CONFIG.funId}&goodsId=${locker.goodsId}&pickStatus=0&_t=${Date.now()}`,
      { method: 'GET', headers: authHeaders() }
    );
    const recs = res.body?.data?.records || res.body?.rows || res.body?.data || [];
    console.log(`  Recovery query returned ${Array.isArray(recs) ? recs.length : 0} records`);
    if (Array.isArray(recs) && recs.length > 0) {
      // Sort by createTime desc to get most recent
      const sorted = [...recs].sort((a, b) => (b.createTime || 0) - (a.createTime || 0));
      const latest = sorted[0];
      console.log(`  Latest: code=${latest.pickCode} orderNo=${latest.pickOrderNum} status=${latest.pickStatus ?? latest.status}`);
      return latest;
    }
  } catch (e) {
    console.warn(`  Recovery query failed: ${e.message}`);
  }

  // Also try: fetch the very last page to get the newest record
  console.log(`\n🔄 Recovery: fetching last page to find newest record...`);
  try {
    const { allRecords, total } = await fetchAllRecords();
    console.log(`  Total now: ${total}`);
    const newest = allRecords[allRecords.length - 1];
    if (newest) {
      console.log(`  Last record: code=${newest.pickCode} orderNo=${newest.pickOrderNum} goodsName="${newest.goodsName}" status=${newest.pickStatus ?? newest.status}`);
      // Only trust it if it matches our locker's goodsName pattern
      const expectedName = `Locker ${locker.row}-${locker.column}`;
      if (newest.goodsName === expectedName || newest.goodsName?.includes(locker.column) || newest.goodsName?.includes(locker.row)) {
        console.log(`  ✅ Last record matches locker pattern — using it`);
        return newest;
      }
      console.log(`  ⚠️  Last record goodsName "${newest.goodsName}" doesn't match "${expectedName}" — not using`);
    }
  } catch (e) {
    console.warn(`  Recovery fetch failed: ${e.message}`);
  }

  return null;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function findFreeLocker(channels, pendingLockerNames) {
  console.log(`\n📦 Total channels: ${channels.length}`);
  channels.forEach(ch => {
    const stock      = ch.roadStock ?? ch.stock ?? ch.goodsNum ?? 0;
    // goodsName in pick records = "Locker {row}-{col}" e.g. "Locker 1-6"
    // channel fields: roadRow = row number, roadColumn = col label
    const lockerName = `Locker ${ch.roadRow}-${ch.roadColumn}`;
    const hasPending = pendingLockerNames.has(lockerName);
    console.log(`  ${ch.roadColumn}-${ch.roadRow} | roadId=${ch.roadId} | goodsId=${ch.goodsId ?? 'NULL'} | stock=${stock} | pendingCode=${hasPending} | lockerName="${lockerName}"`);
  });

  // Skip lockers that already have a live pending code in active_lockers.json
  const activeLockers = loadActiveLockers();
  const activeRoadIds = new Set(Object.keys(activeLockers));
  console.log(`\n📋 active_lockers.json has ${activeRoadIds.size} entries: [${[...activeRoadIds].join(', ')}]`);

  const free = channels.filter(ch => {
    const stock      = ch.roadStock ?? ch.stock ?? ch.goodsNum ?? 0;
    const lockerName = `Locker ${ch.roadRow}-${ch.roadColumn}`;
    const hasPending = pendingLockerNames.has(lockerName);
    const isActive   = activeRoadIds.has(String(ch.roadId));
    return stock > 0 && !hasPending && !isActive;
  });

  if (!free.length) {
    // Fall back: ignore active_lockers.json and just use API pending state
    console.warn('⚠️  No free lockers excluding active_lockers.json — falling back to API pending only');
    const free2 = channels.filter(ch => {
      const stock      = ch.roadStock ?? ch.stock ?? ch.goodsNum ?? 0;
      const lockerName = `Locker ${ch.roadRow}-${ch.roadColumn}`;
      return stock > 0 && !pendingLockerNames.has(lockerName);
    });
    if (!free2.length) throw new Error('No free lockers available! All stocked lockers have pending pickup codes.');
    const ch = free2[0];
    console.log(`\n✅ Selected (fallback): Locker ${ch.roadRow}-${ch.roadColumn} | roadId=${ch.roadId} | goodsId=${ch.goodsId}`);
    return { goodsId: ch.goodsId, roadId: ch.roadId, column: ch.roadColumn, row: ch.roadRow, lockerName: `Locker ${ch.roadRow}-${ch.roadColumn}` };
  }

  const ch = free[0];
  console.log(`\n✅ Selected: Locker ${ch.roadRow}-${ch.roadColumn} | roadId=${ch.roadId} | goodsId=${ch.goodsId}`);
  return {
    goodsId:    ch.goodsId,
    roadId:     ch.roadId,
    column:     ch.roadColumn,
    row:        ch.roadRow,
    lockerName: `Locker ${ch.roadRow}-${ch.roadColumn}`,
  };
}

async function main() {
  try {
    if (!CONFIG.token) throw new Error('XYZ_TOKEN secret is not set!');
    console.log('🔑 Using stored JWT token');
    console.log(`📦 funId=${CONFIG.funId}\n`);

    const channels = await getAllChannels();
    const { pendingLockerNames, allOrderNos: beforeAllOrderNos, total: beforeTotal } = await getPendingState();
    const locker   = await findFreeLocker(channels, pendingLockerNames);

    // ── Create the pick code ─────────────────────────────────────────────────
    const result  = await addPickInfo(locker);
    const apiOk   = result?.code === '00000';

    if (!apiOk) {
      throw new Error(`addPickInfo returned non-success: ${JSON.stringify(result)}`);
    }

    // ── Try direct from response ─────────────────────────────────────────────
    let pickCode = result?.data?.pickCode
      || (Array.isArray(result?.data) && result.data[0]?.pickCode)
      || result?.pickCode
      || null;
    let orderNo  = result?.data?.pickOrderNum
      || (Array.isArray(result?.data) && result.data[0]?.pickOrderNum)
      || null;

    if (pickCode) {
      console.log(`✅ pickCode found directly in addPickInfo response: ${pickCode}`);
    } else {
      // ── Poll for new record (handles API cache lag) ──────────────────────
      console.log('⚠️  pickCode not in response — polling with extended timeout...');
      const { record } = await waitForNewPickCode(beforeAllOrderNos, beforeTotal);

      if (record?.pickCode) {
        pickCode = record.pickCode;
        orderNo  = record.pickOrderNum;
      } else {
        // ── Last-resort recovery ─────────────────────────────────────────
        console.warn('⚠️  Polling timed out. Attempting recovery queries...');
        const recovered = await recoverCodeByGoodsId(locker);
        if (recovered?.pickCode) {
          pickCode = recovered.pickCode;
          orderNo  = recovered.pickOrderNum;
          console.log(`✅ Recovered pickCode=${pickCode} via targeted query`);
        }
      }
    }

    if (!pickCode) {
      throw new Error(
        `addPickInfo returned success (00000) but pickCode could not be found after extended polling.\n` +
        `This likely means the API cache hasn't updated yet. The code WAS created — check the UI.\n` +
        `Response: ${JSON.stringify(result)}`
      );
    }

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
