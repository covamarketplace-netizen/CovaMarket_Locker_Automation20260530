/**
 * generate_pickup_code.js
 * Generates XYZ Vending pickup code using JWT token.
 * Uses known goodsId=5556 and roadId=96351 directly.
 */

const https = require('https');

const CONFIG = {
  baseUrl:     'https://xzyvend.com',
  token:       process.env.XYZ_TOKEN   || '',
  funId:       parseInt(process.env.XYZ_FUN_ID    || '716'),
  goodsId:     parseInt(process.env.XYZ_GOODS_ID  || '5556'),
  roadId:      parseInt(process.env.XYZ_ROAD_ID   || '96351'),
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

async function addPickInfo() {
  console.log(`\n🎟️  Creating pickup code...`);
  console.log(`   funId=${CONFIG.funId}, goodsId=${CONFIG.goodsId}, roadId=${CONFIG.roadId}`);

  const body = {
    funId:         CONFIG.funId,
    pickType:      CONFIG.pickType,
    generateNum:   CONFIG.generateNum,
    goodsPickList: [{ goodsId: CONFIG.goodsId, roadId: CONFIG.roadId }],
  };

  const res = await request(
    `${CONFIG.baseUrl}/api/pickInfo/addPickInfo`,
    { method: 'POST', headers: authHeaders() },
    body
  );

  console.log('Response status:', res.status);
  console.log('Response body:', JSON.stringify(res.body));
  return res.body;
}

async function getLatestPickCode() {
  console.log('🔍 Fetching latest code from list...');
  const res = await request(
    `${CONFIG.baseUrl}/api/pickInfo/list?current=1&size=1`,
    { method: 'GET', headers: authHeaders() }
  );
  console.log('List response:', JSON.stringify(res.body));
  const records = res.body?.rows || res.body?.data?.records || res.body?.data || [];
  return Array.isArray(records) && records.length ? records[0] : null;
}

async function main() {
  try {
    if (!CONFIG.token) throw new Error('XYZ_TOKEN secret is not set!');
    console.log('🔑 Using stored JWT token');
    console.log(`📦 funId=${CONFIG.funId} | goodsId=${CONFIG.goodsId} | roadId=${CONFIG.roadId}`);

    const result = await addPickInfo();

    // Extract pickup code — try all possible response structures
    let pickCode = result?.data?.pickCode
      || (Array.isArray(result?.data) && result.data[0]?.pickCode)
      || result?.pickCode
      || null;

    let orderNo = result?.data?.pickOrderNum
      || (Array.isArray(result?.data) && result.data[0]?.pickOrderNum)
      || null;

    // If not in response, fetch from list
    if (!pickCode) {
      console.log('⚠️  pickCode not in response — fetching from list...');
      const latest = await getLatestPickCode();
      if (latest?.pickCode) {
        pickCode = latest.pickCode;
        orderNo  = latest.pickOrderNum;
      }
    }

    if (!pickCode) throw new Error('No pickup code found. Full response: ' + JSON.stringify(result));

    console.log('\n═══════════════════════════════════');
    console.log(`✅ PICKUP CODE : ${pickCode}`);
    console.log(`📋 ORDER NO   : ${orderNo || 'N/A'}`);
    console.log('═══════════════════════════════════\n');

    const output = {
      success:     true,
      pickCode,
      orderNo,
      funId:       CONFIG.funId,
      goodsId:     CONFIG.goodsId,
      roadId:      CONFIG.roadId,
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
