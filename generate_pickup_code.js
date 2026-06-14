/**
 * generate_pickup_code.js
 * Generates XYZ Vending pickup code using JWT token.
 *
 * KEY INSIGHT: The /api/pickInfo/list endpoint returns roadId=null for all
 * records, so we cannot detect which lockers are occupied from the API.
 *
 * SOLUTION: We maintain our own tracking file at pickup_codes/active_lockers.json
 * in the repo. Each entry maps a locker's roadId → { pickCode, orderNo, createdAt }.
 * The GitHub Actions workflow writes this file after each successful generation.
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

// ── Tracking file helpers ─────────────────────────────────────────────────────

/**
 * Load our local tracking of active (in-use) lockers.
 * Returns a map of roadId (string) → { pickCode, orderNo, locker, createdAt }
 */
function loadActiveLockers() {
  try {
    if (!fs.existsSync(CONFIG.trackingFile)) return {};
    const raw = fs.readFileSync(CONFIG.trackingFile, 'utf8');
    return JSON.parse(raw);
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

async function getLatestPickCode() {
  const res = await request(
    `${CONFIG.baseUrl}/api/pickInfo/list?current=1&size=1`,
    { method: 'GET', headers: authHeaders() }
  );
  const records = res.body?.rows || res.body?.data?.records || res.body?.data || [];
  return Array.isArray(records) && records.length ? records[0] : null;
}

// ── Main logic ────────────────────────────────────────────────────────────────

async function findFreeLocker(channels, activeLockers) {
  const activeRoadIds = new Set(Object.keys(activeLockers).map(Number));

  console.log(`\n📦 Total channels: ${channels.length}`);
  console.log(`🔒 Currently active (tracked) lockers: [${[...activeRoadIds].join(', ')}]`);

  channels.forEach(ch => {
    const stock  = ch.roadStock ?? ch.stock ?? ch.goodsNum ?? 0;
    const active = activeRoadIds.has(ch.roadId);
    console.log(`  ${ch.roadColumn}-${ch.roadRow} | roadId=${ch.roadId} | stock=${stock} | inUse=${active}`);
  });

  const free = channels.filter(ch => {
    const stock = ch.roadStock ?? ch.stock ?? ch.goodsNum ?? 0;
    return stock > 0 && !activeRoadIds.has(ch.roadId);
  });

  if (!free.length) {
    throw new Error(
      'No free lockers available! ' +
      'All stocked lockers are already assigned. ' +
      'Check pickup_codes/active_lockers.json and clear completed entries.'
    );
  }

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

    const channels      = await getAllChannels();
    const activeLockers = loadActiveLockers();

    const locker = await findFreeLocker(channels, activeLockers);
    const result = await addPickInfo(locker);

    let pickCode = result?.data?.pickCode
      || (Array.isArray(result?.data) && result.data[0]?.pickCode)
      || result?.pickCode
      || null;
    let orderNo = result?.data?.pickOrderNum
      || (Array.isArray(result?.data) && result.data[0]?.pickOrderNum)
      || null;

    if (!pickCode) {
      console.log('⚠️  pickCode not in response — fetching from list...');
      const latest = await getLatestPickCode();
      if (latest?.pickCode) { pickCode = latest.pickCode; orderNo = latest.pickOrderNum; }
    }

    if (!pickCode) throw new Error('No pickup code found. Response: ' + JSON.stringify(result));

    // Mark this locker as active in our tracking file
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
