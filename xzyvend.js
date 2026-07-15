/**
 * XZY Vending public API client
 * Docs: XZY Vending API Interface Documentation V1.1
 *
 * Handles MD5 request signing, device lookup by IMEI/motherboard number,
 * and pickup code (pickCode) creation.
 *
 * Credentials are read from env vars — never hardcode appId/key in source.
 *   XZY_APP_ID=235
 *   XZY_SECRET_KEY=40FE36E889C30B47E12603F550CB390A
 *
 * In GitHub Actions, set these as repo secrets and pass through `env:`
 * the same way you already do for Twilio / Gmail SMTP creds.
 */

const crypto = require('crypto');

const BASE_URL = 'http://api.xzyvend.com/remotingData';

const APP_ID = process.env.XZY_APP_ID;
const SECRET_KEY = process.env.XZY_SECRET_KEY;

if (!APP_ID || !SECRET_KEY) {
  console.warn(
    '[xzyvend] Warning: XZY_APP_ID / XZY_SECRET_KEY not set in environment.'
  );
}

// Known machines (from CovaMarket_Locker_Automation config)
const MACHINES = {
  LRTLembahSubang: { funId: 716, imei: null },
  LRTPantai: { funId: 715, imei: null },
};

/**
 * Build the MD5 signature per XZY signing rules:
 * 1. Drop empty values and the `sign` key itself
 * 2. Sort remaining keys by ASCII ascending
 * 3. Join as key1=value1&key2=value2...
 * 4. Append &key={secret}
 * 5. MD5, uppercase
 */
function sign(params, secretKey) {
  const keys = Object.keys(params)
    .filter((k) => k !== 'sign' && params[k] !== '' && params[k] != null)
    .sort();

  const stringA = keys.map((k) => `${k}=${params[k]}`).join('&');
  const stringSignTemp = `${stringA}&key=${secretKey}`;

  return crypto
    .createHash('md5')
    .update(stringSignTemp, 'utf8')
    .digest('hex')
    .toUpperCase();
}

/**
 * POST to a remotingData endpoint with an auto-generated signature.
 */
async function callApi(method, params = {}) {
  const fullParams = { appId: APP_ID, ...params };
  fullParams.sign = sign(fullParams, SECRET_KEY);

  if (process.env.XZY_DEBUG) {
    const keys = Object.keys(fullParams)
      .filter((k) => k !== 'sign' && fullParams[k] !== '' && fullParams[k] != null)
      .sort();
    const stringA = keys.map((k) => `${k}=${fullParams[k]}`).join('&');
    const maskedKey = SECRET_KEY ? `${SECRET_KEY.slice(0, 4)}...${SECRET_KEY.slice(-4)}` : '(unset)';
    console.error(`[xzyvend][debug] method: ${method}`);
    console.error(`[xzyvend][debug] params sent:`, fullParams);
    console.error(`[xzyvend][debug] stringA: ${stringA}`);
    console.error(`[xzyvend][debug] stringSignTemp: ${stringA}&key=${maskedKey}`);
    console.error(`[xzyvend][debug] computed sign: ${fullParams.sign}`);
  }

  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(fullParams)) {
    if (v !== undefined && v !== null && v !== '') {
      body.append(k, String(v));
    }
  }

  const res = await fetch(`${BASE_URL}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!res.ok) {
    throw new Error(`[xzyvend] HTTP ${res.status} calling ${method}`);
  }

  const json = await res.json();

  if (process.env.XZY_DEBUG) {
    console.error(`[xzyvend][debug] raw response:`, JSON.stringify(json, null, 2));
  }

  if (json.code && json.code !== '0' && json.code !== 0 && json.error) {
    throw new Error(
      `[xzyvend] API error on ${method}: ${json.error} — ${json.msg || ''}`
    );
  }

  return json;
}

/**
 * List all devices for this merchant (paginated).
 */
async function getFunByDept(current = 1, size = 100) {
  return callApi('getFunByDept', { current, size });
}

/**
 * Find a device's funId by matching its funImei (the motherboard/IMEI
 * number shown in the Cabinet Information panel on-device).
 */
async function findFunByImei(imei, maxPages = 5) {
  for (let page = 1; page <= maxPages; page++) {
    const res = await getFunByDept(page, 100);
    const list = res?.data?.records || res?.data?.list || res?.data || [];
    const items = Array.isArray(list) ? list : [];

    const match = items.find((d) => String(d.funImei) === String(imei));
    if (match) return match;

    if (items.length < 100) break; // last page reached
  }
  return null;
}

/**
 * List all channels for a device (row/column -> goodsId/roadStock mapping).
 */
async function getRoodById(funId) {
  const res = await callApi('getRoodById', { funId });
  return res?.data || [];
}

/**
 * Create a pickup code.
 * pickType: 0 = by channel, 1 = by product, 2 = by operator, 3 = random
 */
async function createPickOrder({
  funId,
  goodsId,
  pickType = 3,
  roadColumn,
  roadRow,
}) {
  const params = { funId, goodsId, pickType };
  if (roadColumn != null) params.roadColumn = roadColumn;
  if (roadRow != null) params.roadRow = roadRow;

  const res = await callApi('create_pick_order', params);
  return res?.data; // includes pickCode
}

/**
 * Look up an existing pickup code's status.
 */
async function findPick(funNumber, pickCode) {
  const res = await callApi('find_pick', { funNumber, pickCode });
  return res?.data;
}

module.exports = {
  sign,
  callApi,
  getFunByDept,
  findFunByImei,
  getRoodById,
  createPickOrder,
  findPick,
  MACHINES,
};

// ---- CLI usage ----
// node xzyvend.js find-fun 867191080283301
// node xzyvend.js create-pick <funId> <goodsId> [pickType] [roadColumn] [roadRow]
if (require.main === module) {
  (async () => {
    const [, , cmd, ...args] = process.argv;

    try {
      if (cmd === 'find-fun') {
        const [imei] = args;
        const device = await findFunByImei(imei);
        console.log(device ? JSON.stringify(device, null, 2) : 'Not found');
      } else if (cmd === 'create-pick') {
        const [funId, goodsId, pickType, roadColumn, roadRow] = args;
        const data = await createPickOrder({
          funId: Number(funId),
          goodsId: Number(goodsId),
          pickType: pickType != null ? Number(pickType) : 3,
          roadColumn: roadColumn != null ? Number(roadColumn) : undefined,
          roadRow: roadRow != null ? Number(roadRow) : undefined,
        });
        console.log(JSON.stringify(data, null, 2));
        console.log(`\nPickup code: ${data?.pickCode}`);
      } else {
        console.log(
          'Usage:\n' +
            '  node xzyvend.js find-fun <imei>\n' +
            '  node xzyvend.js create-pick <funId> <goodsId> [pickType] [roadColumn] [roadRow]'
        );
      }
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
  })();
}
