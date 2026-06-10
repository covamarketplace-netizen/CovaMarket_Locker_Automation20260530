/**
 * generate_pickup_code.js
 * Calls XYZ Vending internal API directly using JWT token.
 *
 * Flow:
 *   1. Login → get JWT token
 *   2. Auto-detect available channel (roadId with stock > 0)
 *   3. Call addPickInfo → get 6-digit pickup code
 *   4. Output result as JSON
 *
 * Optional env vars:
 *   XYZ_GOODS_ID  — force a specific product (default: auto-detect first available)
 *   XYZ_ROAD_ID   — force a specific channel  (default: auto-detect first with stock)
 */

const https = require('https');

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const CONFIG = {
  baseUrl:     'https://xzyvend.com',
  username:    process.env.XYZ_USERNAME || '0108668014',
  password:    process.env.XYZ_PASSWORD || '',
  funId:       parseInt(process.env.XYZ_FUN_ID  || '716'),
  // Optional overrides — if not set, script auto-detects
  goodsId:     process.env.XYZ_GOODS_ID ? parseInt(process.env.XYZ_GOODS_ID) : null,
  roadId:      process.env.XYZ_ROAD_ID  ? parseInt(process.env.XYZ_ROAD_ID)  : null,
  generateNum: 1,
  pickType:    0,
};
// ─────────────────────────────────────────────────────────────────────────────

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
        try { resolve({ status: res.status, headers: res.headers, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, headers: res.headers, body: data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

// ─── STEP 1: Login ───────────────────────────────────────────────────────────
async function login() {
  console.log('🔐 Logging in as', CONFIG.username);
  const res = await request(
    `${CONFIG.baseUrl}/api/login`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent':   'Mozilla/5.0',
        'Origin':       CONFIG.baseUrl,
        'Referer':      `${CONFIG.baseUrl}/`,
      },
    },
    { username: CONFIG.username, password: CONFIG.password }
  );

  console.log('Login status:', res.status);
  console.log('Login body:', JSON.stringify(res.body));

  const token = res.body?.token      ||
                res.body?.data?.token ||
                res.headers?.authorization;

  if (!token) throw new Error('Login failed — no token. Body: ' + JSON.stringify(res.body));
  console.log('✅ Logged in');
  return token;
}

// ─── STEP 2: Auto-detect available channel ───────────────────────────────────
async function detectChannel(token) {
  // If both are manually set, skip detection
  if (CONFIG.goodsId && CONFIG.roadId) {
    console.log(`📦 Using fixed channel — goodsId=${CONFIG.goodsId}, roadId=${CONFIG.roadId}`);
    return { goodsId: CONFIG.goodsId, roadId: CONFIG.roadId };
  }

  console.log('\n🔍 Auto-detecting available channel...');

  const res = await request(
    `${CONFIG.baseUrl}/api/road/getRoadGoodsByFunId?funId=${CONFIG.funId}`,
    {
      method: 'GET',
      headers: {
        'Authorization': token,
        'Cookie':        `Admin-Token=${token}`,
        'User-Agent':    'Mozilla/5.0',
        'Accept':        'application/json',
        'Referer':       `${CONFIG.baseUrl}/transactionManagement/pickUpCodeManagement`,
      },
    }
  );

  console.log('Channels response status:', res.status);
  console.log('Channels data:', JSON.stringify(res.body));

  // Find first channel with stock > 0
  const roads = res.body?.data || res.body?.rows || res.body || [];
  const available = Array.isArray(roads)
    ? roads.filter(r => (r.roadStock || r.stock || r.goodsNum || 0) > 0)
    : [];

  console.log(`Found ${roads.length} channels, ${available.length} with stock`);

  if (!available.length) {
    throw new Error('No channels with available stock found! Please restock the machine first.');
  }

  // Log all available channels
  available.forEach(r => {
    console.log(`  Channel ${r.roadColumn}-${r.roadRow} | roadId=${r.id || r.roadId} | goodsId=${r.goodsId} | stock=${r.roadStock || r.stock || r.goodsNum}`);
  });

  // Pick the first available one
  const channel = available[0];
  const result = {
    goodsId: CONFIG.goodsId || channel.goodsId,
    roadId:  CONFIG.roadId  || channel.id || channel.roadId,
    stock:   channel.roadStock || channel.stock || channel.goodsNum,
    column:  channel.roadColumn,
    row:     channel.roadRow,
  };

  console.log(`✅ Selected channel: goodsId=${result.goodsId}, roadId=${result.roadId}, stock=${result.stock}`);
  return result;
}

// ─── STEP 3: Create pickup code ───────────────────────────────────────────────
async function addPickInfo(token, channel) {
  console.log('\n🎟️  Calling addPickInfo...');

  const body = {
    funId:         CONFIG.funId,
    pickType:      CONFIG.pickType,
    generateNum:   CONFIG.generateNum,
    goodsPickList: [{
      goodsId: channel.goodsId,
      roadId:  channel.roadId,
    }],
  };

  console.log('Request body:', JSON.stringify(body));

  const res = await request(
    `${CONFIG.baseUrl}/api/pickInfo/addPickInfo`,
    {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json;charset=UTF-8',
        'Authorization': token,
        'Cookie':        `Admin-Token=${token}`,
        'User-Agent':    'Mozilla/5.0',
        'Origin':        CONFIG.baseUrl,
        'Referer':       `${CONFIG.baseUrl}/transactionManagement/pickUpCodeManagement`,
        'Accept':        'application/json, text/plain, */*',
      },
    },
    body
  );

  console.log('addPickInfo status:', res.status);
  console.log('addPickInfo response:', JSON.stringify(res.body));
  return res.body;
}

// ─── STEP 4: Fetch latest pickup code if not in response ─────────────────────
async function getLatestPickCode(token) {
  const res = await request(
    `${CONFIG.baseUrl}/api/pickInfo/list?current=1&size=1`,
    {
      method: 'GET',
      headers: {
        'Authorization': token,
        'Cookie':        `Admin-Token=${token}`,
        'User-Agent':    'Mozilla/5.0',
        'Accept':        'application/json',
      },
    }
  );
  const records = res.body?.rows || res.body?.data?.records || res.body?.data || [];
  return Array.isArray(records) && records.length ? records[0] : null;
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  try {
    const token   = await login();
    const channel = await detectChannel(token);
    const result  = await addPickInfo(token, channel);

    // Extract pickup code
    let pickCode = null;
    let orderNo  = null;

    if (result?.data?.pickCode) {
      pickCode = result.data.pickCode;
      orderNo  = result.data.pickOrderNum || result.data.orderNo;
    } else if (Array.isArray(result?.data) && result.data[0]?.pickCode) {
      pickCode = result.data[0].pickCode;
      orderNo  = result.data[0].pickOrderNum;
    } else if (result?.pickCode) {
      pickCode = result.pickCode;
    } else {
      console.log('⚠️  pickCode not in response, checking list...');
      const latest = await getLatestPickCode(token);
      if (latest?.pickCode) {
        pickCode = latest.pickCode;
        orderNo  = latest.pickOrderNum;
      }
    }

    if (!pickCode) {
      throw new Error('No pickup code found. Response: ' + JSON.stringify(result));
    }

    console.log('\n═══════════════════════════════════');
    console.log(`✅ PICKUP CODE : ${pickCode}`);
    console.log(`📋 ORDER NO   : ${orderNo || 'N/A'}`);
    console.log(`📦 CHANNEL    : ${channel.column}-${channel.row} (roadId=${channel.roadId})`);
    console.log(`🛒 PRODUCT    : goodsId=${channel.goodsId}`);
    console.log('═══════════════════════════════════\n');

    const output = {
      success:     true,
      pickCode,
      orderNo,
      funId:       CONFIG.funId,
      goodsId:     channel.goodsId,
      roadId:      channel.roadId,
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
