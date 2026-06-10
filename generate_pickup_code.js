/**
 * generate_pickup_code.js
 * Uses stored JWT token directly — no login needed.
 * Token is stored as XYZ_TOKEN GitHub Secret.
 *
 * Flow:
 *   1. Use JWT token from env
 *   2. Auto-detect available channel (stock > 0)
 *   3. Call addPickInfo → get 6-digit pickup code
 */

const https = require('https');

const CONFIG = {
  baseUrl:     'https://xzyvend.com',
  token:       process.env.XYZ_TOKEN   || '',
  funId:       parseInt(process.env.XYZ_FUN_ID || '716'),
  goodsId:     process.env.XYZ_GOODS_ID ? parseInt(process.env.XYZ_GOODS_ID) : null,
  roadId:      process.env.XYZ_ROAD_ID  ? parseInt(process.env.XYZ_ROAD_ID)  : null,
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

function authHeaders() {
  return {
    'Authorization': CONFIG.token,
    'Cookie':        `Admin-Token=${CONFIG.token}`,
    'Content-Type':  'application/json;charset=UTF-8',
    'User-Agent':    'Mozilla/5.0',
    'Accept':        'application/json, text/plain, */*',
    'Origin':        CONFIG.baseUrl,
    'Referer':       `${CONFIG.baseUrl}/transactionManagement/pickUpCodeManagement`,
  };
}

// Auto-detect first available channel with stock > 0
async function detectChannel() {
  if (CONFIG.goodsId && CONFIG.roadId) {
    console.log(`📦 Using fixed channel — goodsId=${CONFIG.goodsId}, roadId=${CONFIG.roadId}`);
    return { goodsId: CONFIG.goodsId, roadId: CONFIG.roadId };
  }

  console.log('🔍 Auto-detecting available channel...');
  const res = await request(
    `${CONFIG.baseUrl}/api/road/getRoadGoodsByFunId?funId=${CONFIG.funId}`,
    { method: 'GET', headers: authHeaders() }
  );

  console.log('Channels status:', res.status);
  console.log('Channels data:', JSON.stringify(res.body));

  const roads = res.body?.data || res.body?.rows || res.body || [];
  const available = Array.isArray(roads)
    ? roads.filter(r => (r.roadStock || r.stock || r.goodsNum || 0) > 0)
    : [];

  console.log(`Found ${Array.isArray(roads) ? roads.length : 0} channels, ${available.length} with stock`);
  available.forEach(r => {
    console.log(`  Channel ${r.roadColumn}-${r.roadRow} | roadId=${r.id||r.roadId} | goodsId=${r.goodsId} | stock=${r.roadStock||r.stock||r.goodsNum}`);
  });

  if (!available.length) throw new Error('No channels with stock! Please restock the machine.');

  const ch = available[0];
  return {
    goodsId: ch.goodsId,
    roadId:  ch.id || ch.roadId,
    stock:   ch.roadStock || ch.stock || ch.goodsNum,
    column:  ch.roadColumn,
    row:     ch.roadRow,
  };
}

// Create pickup code
async function addPickInfo(channel) {
  console.log('\n🎟️  Creating pickup code...');
  const body = {
    funId:         CONFIG.funId,
    pickType:      CONFIG.pickType,
    generateNum:   CONFIG.generateNum,
    goodsPickList: [{ goodsId: channel.goodsId, roadId: channel.roadId }],
  };
  console.log('Request body:', JSON.stringify(body));

  const res = await request(
    `${CONFIG.baseUrl}/api/pickInfo/addPickInfo`,
    { method: 'POST', headers: authHeaders() },
    body
  );
  console.log('Response status:', res.status);
  console.log('Response body:', JSON.stringify(res.body));
  return res.body;
}

// Fetch latest from list if not in response
async function getLatestPickCode() {
  const res = await request(
    `${CONFIG.baseUrl}/api/pickInfo/list?current=1&size=1`,
    { method: 'GET', headers: authHeaders() }
  );
  const records = res.body?.rows || res.body?.data?.records || res.body?.data || [];
  return Array.isArray(records) && records.length ? records[0] : null;
}

async function main() {
  try {
    if (!CONFIG.token) throw new Error('XYZ_TOKEN secret is not set!');
    console.log('🔑 Using stored JWT token');

    const channel = await detectChannel();
    const result  = await addPickInfo(channel);

    // Extract pickup code from response
    let pickCode = result?.data?.pickCode
      || (Array.isArray(result?.data) && result.data[0]?.pickCode)
      || result?.pickCode
      || null;

    let orderNo = result?.data?.pickOrderNum
      || (Array.isArray(result?.data) && result.data[0]?.pickOrderNum)
      || null;

    if (!pickCode) {
      console.log('⚠️  Not in response — checking list...');
      const latest = await getLatestPickCode();
      if (latest?.pickCode) { pickCode = latest.pickCode; orderNo = latest.pickOrderNum; }
    }

    if (!pickCode) throw new Error('No pickup code found. Response: ' + JSON.stringify(result));

    console.log('\n═══════════════════════════════════');
    console.log(`✅ PICKUP CODE : ${pickCode}`);
    console.log(`📋 ORDER NO   : ${orderNo || 'N/A'}`);
    console.log(`📦 CHANNEL    : ${channel.column}-${channel.row}`);
    console.log('═══════════════════════════════════\n');

    const output = { success: true, pickCode, orderNo, funId: CONFIG.funId, goodsId: channel.goodsId, roadId: channel.roadId, generatedAt: new Date().toISOString() };
    console.log('OUTPUT_JSON:' + JSON.stringify(output));

  } catch (err) {
    console.error('❌ Error:', err.message);
    // Check if token expired
    if (err.message.includes('expired') || err.message.includes('token') || err.message.includes('401')) {
      console.error('💡 Token may have expired. Re-export cookies from browser and update XYZ_TOKEN secret.');
    }
    console.log('OUTPUT_JSON:' + JSON.stringify({ success: false, error: err.message }));
    process.exit(1);
  }
}

main();
