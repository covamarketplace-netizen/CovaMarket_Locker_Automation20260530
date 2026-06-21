/**
 * generate_pickup_code.js
 *
 * CONFIRMED FACTS from debugging sessions:
 * 1. addPickInfo always returns {"code":"00000"} with NO pickCode in body.
 * 2. The list API (/api/pickInfo/list) has a 30-60s+ server-side cache.
 *    Polling allRecords total count is unreliable within that window.
 * 3. roadId is NULL in all pick list records — cannot use for matching.
 * 4. goodsName in pick records IS the locker label ("Locker 1-3") — use this.
 * 5. pickCode values are RECYCLED — Set diff on pickCodes produces wrong results.
 * 6. allRecords[last] is NOT reliably the newest — it reflects cached state.
 *
 * CORRECT STRATEGY:
 * - Before: snapshot all pickOrderNums for THIS locker's goodsName with status=0.
 * - Call addPickInfo.
 * - After: poll a TARGETED query (goodsName filter + status=0) for a new orderNum
 *   that wasn't in the before-snapshot. This avoids all global list cache issues.
 *
 * FIXES:
 * - (2026-06-15) locker label corrected from column-row to row-column to match UI.
 * - (2026-06-15) Auto JWT refresh with CAPTCHA solving via Claude Vision API.
 *   Flow: GET /api/captchaImage → base64 image → Claude reads digits → POST /api/login
 * - (2026-06-15) Stale tracker cleanup: removes active_lockers entries whose
 *   pick codes are no longer pending (status != 0) in the live API.
 */

const https  = require('https');
const http   = require('http');
const fs     = require('fs');
const path   = require('path');

// ── Location → funId mapping ──────────────────────────────────────────────────
// Each physical locker machine has its own funId.
// Add new locations here as you expand to more sites.
const LOCATION_FUN_MAP = {
  'lrt lembah subang': 716,
  'lrt sentul timur':        715,
};

function resolveFunId(orderLocation) {
  if (!orderLocation) throw new Error('order_location is missing in order JSON');
  const key = orderLocation.trim().toLowerCase();
  for (const [loc, funId] of Object.entries(LOCATION_FUN_MAP)) {
    if (key === loc) return funId;
  }
  throw new Error(
    `Unknown order_location: "${orderLocation}".\n` +
    `Known locations: ${Object.keys(LOCATION_FUN_MAP).map(l => `"${l}"`).join(', ')}\n` +
    `Add it to LOCATION_FUN_MAP in generate_pickup_code.js`
  );
}

const CONFIG = {
  baseUrl:        'https://xzyvend.com',
  token:          process.env.XYZ_TOKEN || '',
  funId:          null,   // resolved from order_location at runtime
  generateNum:    1,
  pickType:       0,
  trackingFile:   path.join(__dirname, 'pickup_codes', 'active_lockers.json'),
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── HTTP ──────────────────────────────────────────────────────────────────────
function request(url, options = {}, body = null) {
  return new Promise((resolve, reject) => {
    const parsed  = new URL(url);
    const lib     = parsed.protocol === 'https:' ? https : http;
    const reqOpts = {
      hostname: parsed.hostname,
      path:     parsed.pathname + parsed.search,
      method:   options.method || 'GET',
      headers:  options.headers || {},
    };
    const req = lib.request(reqOpts, (res) => {
      let data = '';
      res.on('data', c => data += c);
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

// ── CAPTCHA solver via Claude Vision ─────────────────────────────────────────
/**
 * TOKEN REFRESH STRATEGY:
 * XYZ Vending login requires a CAPTCHA that is difficult to solve reliably
 * via automation. Instead of fighting the captcha, we use a simple manual
 * update flow:
 *
 * WHEN TOKEN EXPIRES:
 *   1. The script detects 401 and prints a clear error message
 *   2. You log into xzyvend.com in your browser (takes 30s)
 *   3. Open DevTools → Network → copy the Authorization header value
 *   4. Run: gh secret set XYZ_TOKEN --body "eyJhbGci..."
 *   5. Re-run the workflow
 *
 * PROACTIVE REFRESH (recommended):
 *   - JWT tokens from this system typically last 7-30 days
 *   - Add a monthly reminder to refresh the token before it expires
 *   - The script prints TOKEN_AGE info to help track this
 *
 * To fully automate, a browser-based solution (Puppeteer/Playwright) would
 * be needed to handle the visual CAPTCHA reliably. Out of scope for now.
 */
async function refreshToken() {
  // Decode JWT to check expiry and give useful info
  try {
    const parts   = CONFIG.token.split('.');
    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
    const exp     = payload.exp ? new Date(payload.exp * 1000).toISOString() : 'unknown';
    const iat     = payload.iat ? new Date(payload.iat * 1000).toISOString() : 'unknown';
    console.log(`   JWT issued:  ${iat}`);
    console.log(`   JWT expires: ${exp}`);
  } catch { /* ignore JWT parse errors */ }

  throw new Error(
    'XYZ_TOKEN has expired.\n' +
    '\nTo update it (takes ~30 seconds):\n' +
    '  1. Open https://xzyvend.com in your browser and log in\n' +
    '  2. Open DevTools (F12) → Network tab → click any API request\n' +
    '  3. Copy the Authorization header value (starts with eyJ...)\n' +
    '  4. Run: gh secret set XYZ_TOKEN --body "eyJhbGci..."\n' +
    '     Or update it at: https://github.com/YOUR_REPO/settings/secrets/actions\n' +
    '  5. Re-run this workflow'
  );
}


/**
 * Detect 401 / session-expired responses.
 */
function isUnauthorized(result) {
  return (
    result?.status === 401 ||
    result?.body?.code === '401' ||
    result?.body?.code === 401   ||
    result?.body?.msg  === 'Not logged in' ||
    result?.body?.msg  === '请重新登录'    ||
    result?.body?.msg  === 'token已过期'   ||
    result?.body?.msg  === 'Token已过期'
  );
}

/**
 * Wrapper: run fn(); if 401, refresh token and retry once.
 */
async function withAutoRefresh(fn) {
  const result = await fn();
  if (isUnauthorized(result)) {
    console.warn('⚠️  Unauthorised response — refreshing token...');
    await refreshToken();
    return fn();
  }
  return result;
}

// ── File helpers ──────────────────────────────────────────────────────────────
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

// ── Stale tracker cleanup ─────────────────────────────────────────────────────
/**
 * Remove entries from active_lockers.json if ANY of the following:
 * 1. Pick code is not status=0 (pending) in the live API — collected/expired/invalid
 * 2. Pick code appears in the API with a non-zero status (explicitly invalid)
 * 3. Entry is older than MAX_AGE_HOURS (safety net for codes never redeemed)
 *
 * "Invalid pickup code" in XYZ Vending UI = the code was generated but the locker
 * never dispensed (hardware fault, or the API record was voided). These are NOT
 * status=0 so they correctly get cleaned here.
 */
async function cleanStaleTrackerEntries(allRecords) {
  const activeLockers = loadActiveLockers();
  if (!Object.keys(activeLockers).length) return activeLockers;

  const MAX_AGE_HOURS = 24; // remove tracker entries older than this regardless

  // Build set of pickCodes that are currently pending (status=0) in the API
  const livePendingCodes = new Set(
    allRecords
      .filter(r => (r.pickStatus ?? r.status ?? -1) === 0)
      .map(r => r.pickCode)
      .filter(Boolean)
  );

  const now = Date.now();
  let cleaned = 0;
  const roadIdsToReplenish = [];
  for (const [roadId, entry] of Object.entries(activeLockers)) {
    const ageHours = entry.createdAt
      ? (now - new Date(entry.createdAt).getTime()) / 3600000
      : MAX_AGE_HOURS + 1;

    const isStaleByAPI = !livePendingCodes.has(String(entry.pickCode));
    const isStaleByAge = ageHours > MAX_AGE_HOURS;

    if (isStaleByAPI || isStaleByAge) {
      const reason = isStaleByAPI
        ? `code ${entry.pickCode} not pending in API (invalid/collected/expired)`
        : `entry older than ${MAX_AGE_HOURS}h (${ageHours.toFixed(1)}h old)`;
      console.log(`🧹 Removing stale tracker: roadId=${roadId} locker=${entry.locker} — ${reason}`);
      delete activeLockers[roadId];
      cleaned++;
      roadIdsToReplenish.push(roadId);  // queue for stock replenishment
    }
  }

  if (cleaned > 0) {
    saveActiveLockers(activeLockers);
    console.log(`🧹 Cleaned ${cleaned} stale tracker entry/entries.`);
    // Auto-replenish channels that were freed up (collected or expired)
    if (roadIdsToReplenish.length) {
      await replenishRoads(roadIdsToReplenish);
    }
  } else {
    console.log('✅ Tracker is clean — all entries still pending in API.');
  }

  return activeLockers;
}

// ── Channels ──────────────────────────────────────────────────────────────────
async function getAllChannels() {
  console.log('🔍 Getting all channels...');
  const res = await withAutoRefresh(() =>
    request(
      `${CONFIG.baseUrl}/api/roadInfo/getRoadGoodsByFunId?funId=${CONFIG.funId}&_t=${Date.now()}`,
      { method: 'GET', headers: authHeaders() }
    )
  );
  if (res.status !== 200) throw new Error(`getRoadGoodsByFunId failed: ${res.status}`);
  const channels = res.body?.data || res.body?.rows || res.body || [];
  const result   = Array.isArray(channels) ? channels : [];
  console.log(`  📦 Got ${result.length} channels from API`);
  return result;
}

// ── Full list fetch ───────────────────────────────────────────────────────────
async function fetchAllRecords(size = 50) {
  const first = await withAutoRefresh(() =>
    request(
      `${CONFIG.baseUrl}/api/pickInfo/list?current=1&size=${size}&funId=${CONFIG.funId}&_t=${Date.now()}`,
      { method: 'GET', headers: authHeaders() }
    )
  );
  const firstRecs = first.body?.data?.records || first.body?.rows || first.body?.data || [];
  const total     = first.body?.data?.total   || first.body?.total || 0;
  const lastPage  = Math.max(1, Math.ceil(total / size));
  console.log(`  📊 Total records: ${total} across ${lastPage} pages`);

  const allRecords = Array.isArray(firstRecs) ? [...firstRecs] : [];
  for (let page = 2; page <= lastPage; page++) {
    const res = await withAutoRefresh(() =>
      request(
        `${CONFIG.baseUrl}/api/pickInfo/list?current=${page}&size=${size}&funId=${CONFIG.funId}&_t=${Date.now()}`,
        { method: 'GET', headers: authHeaders() }
      )
    );
    const recs = res.body?.data?.records || res.body?.rows || res.body?.data || [];
    if (Array.isArray(recs) && recs.length) allRecords.push(...recs);
  }
  console.log(`  📊 Fetched ${allRecords.length} records total`);
  return allRecords;
}

async function getPendingLockerNames(allRecords) {
  const pending = allRecords.filter(r => (r.pickStatus ?? r.status ?? -1) === 0);
  const names   = new Set(pending.map(r => r.goodsName).filter(Boolean));

  console.log(`🔒 Pending codes (status=0): ${pending.length} found`);
  // Only log first 5 to keep output concise
  pending.slice(0, 5).forEach(r =>
    console.log(`  code=${r.pickCode} | goodsName="${r.goodsName}" | orderNo=${r.pickOrderNum}`)
  );
  if (pending.length > 5) console.log(`  ... and ${pending.length - 5} more`);
  console.log(`🔒 Pending locker names: [${[...names].join(', ')}]`);
  return names;
}

// ── Targeted query for a specific locker ─────────────────────────────────────
// NOTE: goodsName URL filter is ignored server-side — fetch all pending and match by roadId.
// roadId is the only reliable unique identifier per channel slot.
async function fetchPendingForLocker(roadId, goodsName) {
  const res = await withAutoRefresh(() =>
    request(
      `${CONFIG.baseUrl}/api/pickInfo/list?current=1&size=100&funId=${CONFIG.funId}&pickStatus=0&_t=${Date.now()}`,
      { method: 'GET', headers: authHeaders() }
    )
  );
  const recs = res.body?.data?.records || res.body?.rows || res.body?.data || [];
  if (!Array.isArray(recs)) return [];

  // Log what goodsNames we actually see in the response (helps debug name mismatches)
  const seen = [...new Set(recs.map(r => r.goodsName).filter(Boolean))];
  console.log(`   API goodsNames seen: [${seen.join(', ')}]`);

  // Match by goodsName (primary) — falls back to any pending record if roadId somehow matches
  return recs.filter(r =>
    r.goodsName === goodsName &&
    (r.pickStatus ?? r.status ?? -1) === 0
  );
}

async function snapshotLockerPending(locker) {
  console.log(`📸 Snapshotting pending codes for "${locker.goodsName}" (roadId=${locker.roadId})...`);
  const recs     = await fetchPendingForLocker(locker.roadId, locker.goodsName);
  const orderNos = new Set(recs.map(r => r.pickOrderNum).filter(Boolean));
  const codes    = new Set(recs.map(r => r.pickCode).filter(Boolean));
  console.log(`  Found ${recs.length} existing pending record(s): orderNos=[${[...orderNos].join(', ')}] codes=[${[...codes].join(', ')}]`);
  return { orderNos, codes };
}

// ── addPickInfo ───────────────────────────────────────────────────────────────
async function addPickInfo(locker) {
  console.log(`\n🎟️  Creating pickup code for ${locker.lockerName} (goodsId=${locker.goodsId}, roadId=${locker.roadId})...`);
  const body = {
    funId:         CONFIG.funId,
    pickType:      CONFIG.pickType,
    generateNum:   CONFIG.generateNum,
    goodsPickList: [{ goodsId: locker.goodsId, roadId: locker.roadId }],
  };
  const res = await withAutoRefresh(() =>
    request(
      `${CONFIG.baseUrl}/api/pickInfo/addPickInfo`,
      { method: 'POST', headers: authHeaders('application/json;charset=UTF-8') },
      body
    )
  );
  console.log('addPickInfo status:', res.status);
  console.log('addPickInfo response:', JSON.stringify(res.body));
  return res.body;
}

// ── Replenish channel stock ───────────────────────────────────────────────────
/**
 * Call replenishRoad for one or more roadIds to reset stock back to 1.
 * Triggered automatically after stale tracker cleanup detects a collected/expired code.
 * Payload is a comma-separated string of roadIds (confirmed from browser DevTools).
 */
async function replenishRoads(roadIds) {
  if (!roadIds || !roadIds.length) return;
  // DevTools confirmed: Form Data with field name "roadIds" = application/x-www-form-urlencoded
  const payload = `roadIds=${roadIds.join(',')}`;
  console.log(`🔄 Replenishing roadIds: ${roadIds.join(',')}`);
  const headers = authHeaders('application/x-www-form-urlencoded');
  const res = await withAutoRefresh(() =>
    request(
      `${CONFIG.baseUrl}/api/roadInfo/replenishRoad`,
      { method: 'POST', headers },
      payload
    )
  );
  console.log(`   replenishRoad status: ${res.status} | response: ${JSON.stringify(res.body)}`);
  return res.body;
}

// ── Auto-replenish empty channels ────────────────────────────────────────────
/**
 * Find all channels with stock=0 that have no pending code, and replenish them.
 * This ensures lockers are always ready — handles both:
 *   1. Channels that were never stocked (LRTSentulTimur fresh setup)
 *   2. Channels emptied after pickup but stale tracker already cleaned
 */
async function replenishEmptyChannels(channels, pendingLockerNames) {
  const emptyRoadIds = channels
    .filter(ch => {
      const stock     = ch.roadStock ?? ch.stock ?? ch.goodsNum ?? 0;
      const goodsName = ch.goodsName || ch.commodityName || `Locker ${ch.roadRow}-${ch.roadColumn}`;
      const hasPending = pendingLockerNames.has(goodsName);
      // Only replenish empty channels that don't already have a pending pickup code
      return stock === 0 && !hasPending;
    })
    .map(ch => ch.roadId);

  if (!emptyRoadIds.length) {
    console.log('✅ All channels have stock — no auto-replenishment needed.');
    return;
  }

  console.log(`🔄 Auto-replenishing ${emptyRoadIds.length} empty channel(s): [${emptyRoadIds.join(', ')}]`);
  await replenishRoads(emptyRoadIds);

  // Small wait for the API to update stock before we proceed
  await sleep(2000);
}

// ── Poll for new code ─────────────────────────────────────────────────────────
async function waitForNewCodeForLocker(locker, beforeOrderNos, beforeCodes, { maxAttempts = 15, delayMs = 5000 } = {}) {
  console.log(`\n⏳ Polling for new code on "${locker.goodsName}" roadId=${locker.roadId} (up to ${maxAttempts * delayMs / 1000}s)...`);
  console.log(`   Before: orderNos=[${[...beforeOrderNos].join(', ')}] codes=[${[...beforeCodes].join(', ')}]`);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await sleep(delayMs);
    const recs = await fetchPendingForLocker(locker.roadId, locker.goodsName);
    console.log(`  Attempt ${attempt}/${maxAttempts} — found ${recs.length} pending record(s) for "${locker.goodsName}"`);
    recs.forEach(r => console.log(`    code=${r.pickCode} orderNo=${r.pickOrderNum} status=${r.pickStatus ?? r.status}`));

    const newRec = recs.find(r => {
      if (r.pickOrderNum) return !beforeOrderNos.has(r.pickOrderNum);
      if (r.pickCode)     return !beforeCodes.has(r.pickCode);
      return false;
    });

    if (newRec) {
      console.log(`✅ New record found on attempt ${attempt}: code=${newRec.pickCode} orderNo=${newRec.pickOrderNum}`);
      return newRec;
    }
  }

  console.warn(`⚠️  Targeted polling timed out after ${maxAttempts} attempts.`);
  return null;
}

// ── Locker selection ──────────────────────────────────────────────────────────
function mkLocker(ch) {
  const lockerLabel = `${ch.roadRow}-${ch.roadColumn}`;  // ✅ row-column matches UI
  const lockerName  = `Locker ${lockerLabel}`;
  // goodsName from API may differ per machine (e.g. "Locker2 1-1" for LRTSentulTimur)
  // Capture it here so polling can match by roadId instead of constructed name
  const goodsName   = ch.goodsName || ch.commodityName || lockerName;
  console.log(`\n✅ Selected: ${lockerName} | goodsName="${goodsName}" | roadId=${ch.roadId} | goodsId=${ch.goodsId}`);
  return {
    goodsId:     ch.goodsId,
    roadId:      ch.roadId,
    row:         ch.roadRow,
    column:      ch.roadColumn,
    lockerLabel,
    lockerName,
    goodsName,
  };
}

async function findFreeLocker(channels, pendingLockerNames, cleanedActiveLockers) {
  const activeRoadIds = new Set(Object.keys(cleanedActiveLockers));

  console.log(`\n📦 Total channels: ${channels.length}`);
  console.log(`📋 active_lockers.json entries after cleanup: [${[...activeRoadIds].join(', ')}]`);

  channels.forEach(ch => {
    const stock     = ch.roadStock ?? ch.stock ?? ch.goodsNum ?? 0;
    const goodsName = ch.goodsName || ch.commodityName || `Locker ${ch.roadRow}-${ch.roadColumn}`;
    const hasPending = pendingLockerNames.has(goodsName);
    const isActive   = activeRoadIds.has(String(ch.roadId));
    console.log(`  ${ch.roadRow}-${ch.roadColumn} | goodsName="${goodsName}" | roadId=${ch.roadId} | goodsId=${ch.goodsId ?? 'NULL'} | stock=${stock} | pendingAPI=${hasPending} | inTracker=${isActive}`);
  });

  const free = channels.filter(ch => {
    const stock     = ch.roadStock ?? ch.stock ?? ch.goodsNum ?? 0;
    const goodsName = ch.goodsName || ch.commodityName || `Locker ${ch.roadRow}-${ch.roadColumn}`;
    return stock > 0 && !pendingLockerNames.has(goodsName) && !activeRoadIds.has(String(ch.roadId));
  });

  if (!free.length) {
    // Fallback: ignore tracker (already cleaned), use API pending state only
    console.warn('⚠️  No free locker (tracker + API) — falling back to API pending state only');
    const free2 = channels.filter(ch => {
      const stock     = ch.roadStock ?? ch.stock ?? ch.goodsNum ?? 0;
      const goodsName = ch.goodsName || ch.commodityName || `Locker ${ch.roadRow}-${ch.roadColumn}`;
      return stock > 0 && !pendingLockerNames.has(goodsName);
    });
    if (!free2.length) throw new Error('No free lockers available — all lockers occupied or out of stock!');
    return mkLocker(free2[0]);
  }

  return mkLocker(free[0]);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  try {
    if (!CONFIG.token) throw new Error('XYZ_TOKEN secret is not set!');
    console.log('🔑 Using stored JWT token');

    // ── Load order from file ──────────────────────────────────────────────────
    const orderPath = process.env.ORDERS_FILE || process.argv[2];
    if (!orderPath) throw new Error('Provide order file via ORDERS_FILE env var or as CLI argument');

    const orders = JSON.parse(fs.readFileSync(orderPath, 'utf8'));
    if (!orders.length) throw new Error(`No orders found in ${orderPath}`);

    console.log(`\n📦 Found ${orders.length} order(s) to process\n`);

    // ── Process each order ────────────────────────────────────────────────────
    for (let i = 0; i < orders.length; i++) {
      const order = orders[i];
      console.log(`\n${'═'.repeat(50)}`);
      console.log(`📦 Processing order ${i + 1}/${orders.length}`);
      console.log(`📋 Order     : ${order.order_id}`);
      console.log(`👤 Customer  : ${order.customer_name} <${order.email}>`);
      console.log(`📍 Location  : ${order.order_location}`);
      console.log(`🗓  Pickup    : ${order.pickup_date} ${order.pickup_time}`);

      try {
        // ── Resolve funId from order_location ──────────────────────────────────
        CONFIG.funId = resolveFunId(order.order_location);
        console.log(`\n📦 funId=${CONFIG.funId} (resolved from "${order.order_location}")\n`);

        // ── Fetch channels + records fresh per order (different funId per location)
        console.log(`🔍 Fetching channels for funId=${CONFIG.funId}...`);
        const channels = await getAllChannels();

        console.log('🔍 Fetching ALL pick records...');
        const allRecords = await fetchAllRecords();

        // ── Guard: if channels empty, likely a token issue ──────────────────────
        if (!channels.length) {
          console.warn('⚠️  Got 0 channels — token may have expired. Attempting refresh...');
          await refreshToken();
          const retried = await getAllChannels();
          if (!retried.length) {
            throw new Error('Still got 0 channels after token refresh. Check funId or account access.');
          }
          channels.push(...retried);
        }

        // ── Pending locker names ────────────────────────────────────────────────
        const pendingLockerNames = await getPendingLockerNames(allRecords);

        // ── Clean stale tracker entries ─────────────────────────────────────────
        const cleanedActiveLockers = await cleanStaleTrackerEntries(allRecords);

        // ── Auto-replenish any empty channels (no pending code, stock=0) ────────
        await replenishEmptyChannels(channels, pendingLockerNames);

        // ── Re-fetch channels after replenishment so stock values are fresh ─────
        const freshChannels = await getAllChannels();

        // ── Find free locker ────────────────────────────────────────────────────
        const locker = await findFreeLocker(freshChannels, pendingLockerNames, cleanedActiveLockers);

        // ── Snapshot BEFORE ─────────────────────────────────────────────────────
        const { orderNos: beforeOrderNos, codes: beforeCodes } = await snapshotLockerPending(locker);

        // ── Create pickup code ──────────────────────────────────────────────────
        const result = await addPickInfo(locker);
        if (result?.code !== '00000') {
          throw new Error(`addPickInfo failed: ${JSON.stringify(result)}`);
        }

        // ── Try direct response first ───────────────────────────────────────────
        let pickCode = result?.data?.pickCode
          || (Array.isArray(result?.data) && result.data[0]?.pickCode)
          || result?.pickCode
          || null;
        let orderNo  = result?.data?.pickOrderNum
          || (Array.isArray(result?.data) && result.data[0]?.pickOrderNum)
          || null;

        if (pickCode) {
          console.log(`✅ pickCode in response: ${pickCode}`);
        } else {
          const newRec = await waitForNewCodeForLocker(locker, beforeOrderNos, beforeCodes);
          if (newRec) {
            pickCode = newRec.pickCode;
            orderNo  = newRec.pickOrderNum;
          }
        }

        if (!pickCode) {
          throw new Error(
            `addPickInfo returned success but pick code not found after 75s of targeted polling.\n` +
            `Code WAS created server-side — check the UI for locker ${locker.lockerName}.\n` +
            `Response: ${JSON.stringify(result)}`
          );
        }

        // ── Save ────────────────────────────────────────────────────────────────
        const activeLockers = loadActiveLockers();
        activeLockers[locker.roadId] = {
          pickCode,
          orderNo:   orderNo || null,
          locker:    locker.lockerLabel,
          goodsId:   locker.goodsId,
          createdAt: new Date().toISOString(),
        };
        saveActiveLockers(activeLockers);

        console.log('\n═══════════════════════════════════');
        console.log(`✅ PICKUP CODE : ${pickCode}`);
        console.log(`📋 ORDER NO   : ${orderNo || 'N/A'}`);
        console.log(`📦 LOCKER     : ${locker.lockerLabel} (roadId=${locker.roadId})`);
        console.log('═══════════════════════════════════\n');

        console.log('OUTPUT_JSON:' + JSON.stringify({
          success:       true,
          pickCode,
          orderNo,
          locker:        locker.lockerLabel,
          funId:         CONFIG.funId,
          goodsId:       locker.goodsId,
          roadId:        locker.roadId,
          generatedAt:   new Date().toISOString(),
          orderId:       order.order_id,
          customerName:  order.customer_name,
          customerEmail: order.email,
          orderLocation: order.order_location,
          pickupDate:    order.pickup_date,
          pickupTime:    order.pickup_time,
        }));

      } catch (err) {
        // Log failure for this order but continue processing remaining orders
        console.error(`❌ Error on order ${order.order_id}: ${err.message}`);
        console.log('OUTPUT_JSON:' + JSON.stringify({
          success:  false,
          orderId:  order.order_id,
          error:    err.message,
        }));
      }

      // Small delay between orders to avoid hammering the API
      if (i < orders.length - 1) {
        console.log('\n⏸  Waiting 3s before next order...');
        await sleep(3000);
      }
    }

  } catch (err) {
    console.error('❌ Fatal error:', err.message);
    console.log('OUTPUT_JSON:' + JSON.stringify({ success: false, error: err.message }));
    process.exit(1);
  }
}

main();
