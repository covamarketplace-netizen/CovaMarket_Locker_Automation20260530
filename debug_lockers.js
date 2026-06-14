/**
 * debug_lockers.js
 * Dumps raw API responses so we can see exactly what roadId fields
 * the two endpoints return and why they might not be matching.
 */

const https = require('https');

const CONFIG = {
  baseUrl: 'https://xzyvend.com',
  token:   process.env.XYZ_TOKEN || '',
  funId:   parseInt(process.env.XYZ_FUN_ID || '716'),
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
    'User-Agent':    'Mozilla/5.0',
    'Accept':        'application/json, text/plain, */*',
    'Origin':        CONFIG.baseUrl,
    'Referer':       `${CONFIG.baseUrl}/transactionManagement/pickUpCodeManagement`,
  };
}

async function main() {
  if (!CONFIG.token) throw new Error('XYZ_TOKEN not set');

  // ── 1. Channels ────────────────────────────────────────────────────────────
  console.log('\n════════ CHANNELS (getRoadGoodsByFunId) ════════');
  const chRes = await request(
    `${CONFIG.baseUrl}/api/roadInfo/getRoadGoodsByFunId?funId=${CONFIG.funId}&_t=${Date.now()}`,
    { method: 'GET', headers: authHeaders() }
  );
  console.log('HTTP status:', chRes.status);

  const channels = chRes.body?.data || chRes.body?.rows || chRes.body || [];
  const chList   = Array.isArray(channels) ? channels : [];
  console.log(`Total channels: ${chList.length}`);
  console.log('\nFull keys on first channel record:', chList[0] ? Object.keys(chList[0]) : 'N/A');
  console.log('\nPer-channel summary:');
  chList.forEach(ch => {
    console.log(JSON.stringify({
      roadColumn: ch.roadColumn,
      roadRow:    ch.roadRow,
      id:         ch.id,
      roadId:     ch.roadId,
      goodsId:    ch.goodsId,
      stock:      ch.roadStock ?? ch.stock ?? ch.goodsNum,
    }));
  });

  // ── 2. Pickup codes (ALL statuses) ─────────────────────────────────────────
  console.log('\n════════ PICKUP CODES (all statuses) ════════');
  const pkRes = await request(
    `${CONFIG.baseUrl}/api/pickInfo/list?current=1&size=50`,
    { method: 'GET', headers: authHeaders() }
  );
  console.log('HTTP status:', pkRes.status);

  const records = pkRes.body?.rows || pkRes.body?.data?.records || pkRes.body?.data || [];
  const pkList  = Array.isArray(records) ? records : [];
  console.log(`Total codes returned: ${pkList.length}`);
  console.log('\nFull keys on first pickup record:', pkList[0] ? Object.keys(pkList[0]) : 'N/A');
  console.log('\nPer-code summary:');
  pkList.forEach(r => {
    console.log(JSON.stringify({
      pickCode:    r.pickCode,
      pickStatus:  r.pickStatus ?? r.status,
      roadId:      r.roadId,
      roadColumn:  r.roadColumn,
      roadRow:     r.roadRow,
      funId:       r.funId,
    }));
  });

  // ── 3. Cross-match ─────────────────────────────────────────────────────────
  console.log('\n════════ ID CROSS-MATCH ════════');
  const channelIds = chList.map(ch => ch.id ?? ch.roadId);
  const codeIds    = pkList.map(r => r.roadId).filter(Boolean);
  console.log('Channel IDs:    ', JSON.stringify(channelIds));
  console.log('Pickup roadIds: ', JSON.stringify(codeIds));

  const matched = codeIds.filter(id => channelIds.includes(id));
  const missing = codeIds.filter(id => !channelIds.includes(id));
  console.log('Matched IDs:    ', JSON.stringify(matched));
  console.log('Unmatched IDs (in codes but NOT in channels):', JSON.stringify(missing));

  // ── 4. Which channel would be selected right now? ──────────────────────────
  console.log('\n════════ LOCKER SELECTION SIMULATION ════════');
  const lockedSet = new Set(codeIds); // using ALL codes as locked (worst case)
  chList.forEach(ch => {
    const id     = ch.id ?? ch.roadId;
    const stock  = ch.roadStock ?? ch.stock ?? ch.goodsNum ?? 0;
    const locked = lockedSet.has(id);
    const free   = stock > 0 && !locked;
    console.log(`  ${ch.roadColumn}-${ch.roadRow} | id=${id} | stock=${stock} | locked=${locked} | FREE=${free}`);
  });
}

main().catch(err => {
  console.error('❌', err.message);
  process.exit(1);
});
