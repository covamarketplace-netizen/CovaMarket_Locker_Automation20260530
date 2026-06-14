/**
 * generate_pickup_code.js
 * Generates XYZ Vending pickup code using JWT token.
 * Auto-detects free locker from channels 1-1 to 1-7 and 2-1 to 2-7.
 * Skips lockers that already have a pending pickup code (待取货).
 */

const https = require('https');

const CONFIG = {
  baseUrl:     'https://xzyvend.com',
  token:       process.env.XYZ_TOKEN  || '',
  funId:       parseInt(process.env.XYZ_FUN_ID || '716'),
  generateNum: 1,
  pickType:    0,
};

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

// Get all channels for this device with their stock and goodsId
async function getAllChannels() {
  console.log('🔍 Getting all channels via getRoadGoodsByFunId...');
  const res = await request(
    `${CONFIG.baseUrl}/api/roadInfo/getRoadGoodsByFunId?funId=${CONFIG.funId}&_t=${Date.now()}`,
    { method: 'GET', headers: authHeaders() }
  );
  console.log('Channels status:', res.status);
  console.log('Channels body:', JSON.stringify(res.body));

  if (res.status !== 200) throw new Error(`getRoadGoodsByFunId failed: ${res.status} ${JSON.stringify(res.body)}`);

  const channels = res.body?.data || res.body?.rows || res.body || [];
  return Array.isArray(channels) ? channels : [];
}

// Get all pending pickup codes to know which lockers are locked
async function getPendingRoadIds() {
  console.log('🔍 Checking pending pickup codes...');
  const res = await request(
    `${CONFIG.baseUrl}/api/pickInfo/list?current=1&size=100&pickStatus=0`,
    { method: 'GET', headers: authHeaders() }
  );
  console.log('Pending codes status:', res.status);

  const records = res.body?.rows || res.body?.data?.records || res.body?.data || [];
  const pending = Array.isArray(records) ? records : [];
  const lockedRoadIds = pending.map(r => r.roadId).filter(Boolean);
  console.log(`Found ${pending.length} pending codes — locked roadIds: [${lockedRoadIds.join(', ')}]`);
  return lockedRoadIds;
}

// Find the first free locker (has stock > 0 AND no pending pickup code)
async function findFreeLocker() {
  const [channels, lockedRoadIds] = await Promise.all([
    getAllChannels(),
    getPendingRoadIds(),
  ]);

  console.log(`\n📦 Total channels: ${channels.length}`);
  channels.forEach(ch => {
    const roadId  = ch.id || ch.roadId;
    const stock   = ch.roadStock || ch.stock || ch.goodsNum || 0;
    const locked  = lockedRoadIds.includes(roadId);
    console.log(`  ${ch.roadColumn}-${ch.roadRow} | roadId=${roadId} | goodsId=${ch.goodsId} | stock=${stock} | locked=${locked}`);
  });

  // Filter: stock > 0 AND not locked
  const free = channels.filter(ch => {
    const roadId = ch.id || ch.roadId;
    const stock  = ch.roadStock || ch.stock || ch.goodsNum || 0;
    return stock > 0 && !lockedRoadIds.includes(roadId);
  });

  if (!free.length) {
    throw new Error(
      'No free lockers available! ' +
      'All lockers are either empty or have pending pickup codes. ' +
      'Please restock or void old pending codes.'
    );
  }

  const ch = free[0];
  const locker = {
    goodsId:  ch.goodsId,
    roadId:   ch.id || ch.roadId,
    column:   ch.roadColumn,
    row:      ch.roadRow,
    stock:    ch.roadStock || ch.stock || ch.goodsNum,
  };

  console.log(`\n✅ Selected free locker: ${locker.column}-${locker.row} | roadId=${locker.roadId} | goodsId=${locker.goodsId} | stock=${locker.stock}`);
  return locker;
}

// Create pickup code for the selected locker
async function addPickInfo(locker) {
  console.log(`\n🎟️  Creating pickup code for locker ${locker.column}-${locker.row}...`);

  const body = {
    funId:         CONFIG.funId,
    pickType:      CONFIG.pickType,
    generateNum:   CONFIG.generateNum,
    goodsPickList: [{ goodsId: locker.goodsId, roadId: locker.roadId }],
  };
  console.log('Request body:', JSON.stringify(body));

  const res = await request(
    `${CONFIG.baseUrl}/api/pickInfo/addPickInfo`,
    { method: 'POST', headers: authHeaders('application/json;charset=UTF-8') },
    body
  );
  console.log('addPickInfo status:', res.status);
  console.log('addPickInfo response:', JSON.stringify(res.body));
  return res.body;
}

// Fetch latest pickup code from list if not in addPickInfo response
async function getLatestPickCode() {
  console.log('🔍 Fetching latest code from list...');
  const res = await request(
    `${CONFIG.baseUrl}/api/pickInfo/list?current=1&size=1`,
    { method: 'GET', headers: authHeaders() }
  );
  const records = res.body?.rows || res.body?.data?.records || res.body?.data || [];
  return Array.isArray(records) && records.length ? records[0] : null;
}

// ── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  try {
    if (!CONFIG.token) throw new Error('XYZ_TOKEN secret is not set!');
    console.log('🔑 Using stored JWT token');
    console.log(`📦 funId=${CONFIG.funId}\n`);

    // Find a free locker
    const locker = await findFreeLocker();

    // Create pickup code
    const result = await addPickInfo(locker);

    // Extract pickup code from response
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
