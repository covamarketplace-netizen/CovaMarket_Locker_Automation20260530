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

const CONFIG = {
  baseUrl:        'https://xzyvend.com',
  token:          process.env.XYZ_TOKEN        || '',
  username:       process.env.XYZ_USERNAME     || '',
  password:       process.env.XYZ_PASSWORD     || '',
  anthropicKey:   process.env.ANTHROPIC_API_KEY|| '',
  funId:          parseInt(process.env.XYZ_FUN_ID || '716'),
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
 * Fetch captcha from /api/captchaImage and solve it with Claude Vision.
 * Returns { code, uuid, fetchedAt } — caller must POST login IMMEDIATELY after.
 *
 * KEY INSIGHT: Captcha TTL is ~30s server-side. We must minimise latency:
 *   1. Fetch captcha (fresh UUID via _t cache-buster every call)
 *   2. Send to Claude Haiku instantly (<2s typical response)
 *   3. POST login right away — no extra sleep before submitting
 *
 * Server sends wrong MIME in data URI ("text/plain") — we sniff from magic bytes.
 */
async function solveCaptcha() {
  if (!CONFIG.anthropicKey) {
    throw new Error('ANTHROPIC_API_KEY secret not set — needed to solve captcha for token refresh.');
  }

  const t = Date.now();
  console.log(`🖼️  Fetching fresh captcha (_t=${t})...`);
  const captchaRes = await request(
    `${CONFIG.baseUrl}/api/captchaImage?_t=${t}`,
    {
      method: 'GET',
      headers: {
        'User-Agent':    'Mozilla/5.0',
        'Accept':        'application/json, text/plain, */*',
        'Referer':       `${CONFIG.baseUrl}/login`,
        'Cache-Control': 'no-cache',
        'Pragma':        'no-cache',
      },
    }
  );

  if (captchaRes.status !== 200) {
    throw new Error(`captchaImage fetch failed: HTTP ${captchaRes.status}`);
  }

  const captchaData = captchaRes.body?.data || captchaRes.body;
  const imgBase64   = captchaData?.img || captchaData?.image || null;
  const uuid        = captchaData?.uuid || captchaData?.captchaId || null;

  console.log(`   Captcha UUID: ${uuid}`);

  if (!imgBase64 || !uuid) {
    throw new Error(`Could not extract captcha img/uuid. Body: ${JSON.stringify(captchaRes.body).substring(0, 200)}`);
  }

  // Strip ANY data URI prefix — server wrongly declares MIME as "text/plain"
  const cleanBase64 = imgBase64.replace(/^data:[^;]+;base64,/, '').trim();

  // Sniff actual image format from base64 magic bytes
  // JPEG FF D8 → "/9j", PNG 89504E47 → "iVBORw", GIF 474946 → "R0lGOD"
  let mediaType = 'image/jpeg'; // XYZ Vending always sends JPEG captchas
  if (cleanBase64.startsWith('iVBORw'))      mediaType = 'image/png';
  else if (cleanBase64.startsWith('R0lGOD')) mediaType = 'image/gif';
  console.log(`   Sniffed: ${mediaType} (prefix="${cleanBase64.substring(0, 6)}")`);

  // Solve IMMEDIATELY after fetch to beat TTL
  const fetchedAt = Date.now();
  console.log(`🤖 Solving with Claude Haiku...`);

  const anthropicRes = await request(
    'https://api.anthropic.com/v1/messages',
    {
      method: 'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         CONFIG.anthropicKey,
        'anthropic-version': '2023-06-01',
      },
    },
    {
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 16,
      messages: [{
        role: 'user',
        content: [
          {
            type:   'image',
            source: { type: 'base64', media_type: mediaType, data: cleanBase64 },
          },
          {
            type: 'text',
            text: 'Read the CAPTCHA digits/letters and reply with ONLY those characters. No spaces, no explanation, no punctuation.',
          },
        ],
      }],
    }
  );

  const elapsed     = Date.now() - fetchedAt;
  const captchaCode = (anthropicRes.body?.content?.[0]?.text || '').trim().replace(/\s+/g, '');
  console.log(`✅ Solved: "${captchaCode}" (${elapsed}ms)`);

  if (!captchaCode) {
    throw new Error(`Claude could not read captcha. Response: ${JSON.stringify(anthropicRes.body)}`);
  }

  return { code: captchaCode, uuid, fetchedAt };
}

// ── JWT Refresh ────────────────────────────────────────────────────────────────────────────────
/**
 * Re-login: fetch captcha → solve → POST /api/login immediately.
 * Prints NEW_TOKEN:<token> for GH Actions to capture + update secret.
 * Retries up to maxAttempts with a brand-new captcha each time.
 */
async function refreshToken(maxAttempts = 3) {
  if (!CONFIG.username || !CONFIG.password) {
    throw new Error('XYZ_USERNAME / XYZ_PASSWORD secrets not set. Cannot auto-refresh JWT.');
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    console.log(`\n🔄 Token refresh attempt ${attempt}/${maxAttempts}...`);
    try {
      const { code: captchaCode, uuid, fetchedAt } = await solveCaptcha();
      console.log(`   Captcha age at login POST: ${Date.now() - fetchedAt}ms`);

      // POST login immediately — no sleep, beat the TTL
      const loginRes = await request(
        `${CONFIG.baseUrl}/api/login`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json;charset=UTF-8',
            'User-Agent':   'Mozilla/5.0',
            'Accept':       'application/json, text/plain, */*',
            'Origin':       CONFIG.baseUrl,
            'Referer':      `${CONFIG.baseUrl}/login`,
          },
        },
        {
          username: CONFIG.username,
          password: CONFIG.password,
          code:     captchaCode,
          uuid,
        }
      );

      console.log('Login status:', loginRes.status);
      console.log('Login body:',   JSON.stringify(loginRes.body));

      const newToken =
        loginRes.body?.token            ||
        loginRes.body?.data?.token      ||
        loginRes.body?.data?.adminToken ||
        null;

      if (!newToken) {
        const msg = loginRes.body?.msg || loginRes.body?.message || JSON.stringify(loginRes.body);
        console.warn(`⚠️  Attempt ${attempt} failed: ${msg}`);
        if (attempt < maxAttempts) {
          await sleep(500); // minimal pause before retrying with fresh captcha
          continue;
        }
        throw new Error(`Re-login failed after ${maxAttempts} attempts. Last: ${msg}`);
      }

      CONFIG.token = newToken;
      console.log('✅ Re-login successful!');
      console.log(`NEW_TOKEN:${newToken}`);
      return newToken;

    } catch (err) {
      if (attempt >= maxAttempts) throw err;
      console.warn(`⚠️  Attempt ${attempt} threw: ${err.message} — retrying...`);
      await sleep(500);
    }
  }
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
    }
  }

  if (cleaned > 0) {
    saveActiveLockers(activeLockers);
    console.log(`🧹 Cleaned ${cleaned} stale tracker entry/entries.`);
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
  pending.forEach(r =>
    console.log(`  code=${r.pickCode} | goodsName="${r.goodsName}" | orderNo=${r.pickOrderNum}`)
  );
  console.log(`🔒 Pending locker names: [${[...names].join(', ')}]`);
  return names;
}

// ── Targeted query for a specific locker ─────────────────────────────────────
async function fetchPendingForLocker(lockerName) {
  const res = await withAutoRefresh(() =>
    request(
      `${CONFIG.baseUrl}/api/pickInfo/list?current=1&size=50&funId=${CONFIG.funId}&goodsName=${encodeURIComponent(lockerName)}&pickStatus=0&_t=${Date.now()}`,
      { method: 'GET', headers: authHeaders() }
    )
  );
  const recs = res.body?.data?.records || res.body?.rows || res.body?.data || [];
  if (!Array.isArray(recs)) return [];
  return recs.filter(r =>
    r.goodsName === lockerName &&
    (r.pickStatus ?? r.status ?? -1) === 0
  );
}

async function snapshotLockerPending(lockerName) {
  console.log(`📸 Snapshotting pending codes for "${lockerName}"...`);
  const recs     = await fetchPendingForLocker(lockerName);
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

// ── Poll for new code ─────────────────────────────────────────────────────────
async function waitForNewCodeForLocker(lockerName, beforeOrderNos, beforeCodes, { maxAttempts = 15, delayMs = 5000 } = {}) {
  console.log(`\n⏳ Polling targeted query for "${lockerName}" (up to ${maxAttempts * delayMs / 1000}s)...`);
  console.log(`   Before: orderNos=[${[...beforeOrderNos].join(', ')}] codes=[${[...beforeCodes].join(', ')}]`);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await sleep(delayMs);
    const recs = await fetchPendingForLocker(lockerName);
    console.log(`  Attempt ${attempt}/${maxAttempts} — found ${recs.length} pending record(s) for "${lockerName}"`);
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
  console.log(`\n✅ Selected: ${lockerName} | roadId=${ch.roadId} | goodsId=${ch.goodsId}`);
  return {
    goodsId:     ch.goodsId,
    roadId:      ch.roadId,
    row:         ch.roadRow,
    column:      ch.roadColumn,
    lockerLabel,
    lockerName,
  };
}

async function findFreeLocker(channels, pendingLockerNames, cleanedActiveLockers) {
  const activeRoadIds = new Set(Object.keys(cleanedActiveLockers));

  console.log(`\n📦 Total channels: ${channels.length}`);
  console.log(`📋 active_lockers.json entries after cleanup: [${[...activeRoadIds].join(', ')}]`);

  channels.forEach(ch => {
    const stock      = ch.roadStock ?? ch.stock ?? ch.goodsNum ?? 0;
    const lockerName = `Locker ${ch.roadRow}-${ch.roadColumn}`;
    const hasPending = pendingLockerNames.has(lockerName);
    const isActive   = activeRoadIds.has(String(ch.roadId));
    console.log(`  ${ch.roadRow}-${ch.roadColumn} | roadId=${ch.roadId} | goodsId=${ch.goodsId ?? 'NULL'} | stock=${stock} | pendingAPI=${hasPending} | inTracker=${isActive}`);
  });

  const free = channels.filter(ch => {
    const stock      = ch.roadStock ?? ch.stock ?? ch.goodsNum ?? 0;
    const lockerName = `Locker ${ch.roadRow}-${ch.roadColumn}`;
    return stock > 0 && !pendingLockerNames.has(lockerName) && !activeRoadIds.has(String(ch.roadId));
  });

  if (!free.length) {
    // Fallback: ignore tracker (already cleaned), use API pending state only
    console.warn('⚠️  No free locker (tracker + API) — falling back to API pending state only');
    const free2 = channels.filter(ch => {
      const stock      = ch.roadStock ?? ch.stock ?? ch.goodsNum ?? 0;
      const lockerName = `Locker ${ch.roadRow}-${ch.roadColumn}`;
      return stock > 0 && !pendingLockerNames.has(lockerName);
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
    console.log(`📦 funId=${CONFIG.funId}\n`);

    // ── Fetch channels first, then pick records (sequential to avoid double-refresh race)
    console.log('🔍 Fetching channels...');
    const channels = await getAllChannels();

    console.log('🔍 Fetching ALL pick records (client-side pending filter)...');
    const allRecords = await fetchAllRecords();

    // ── Guard: if channels empty, likely a token issue ────────────────────────
    if (!channels.length) {
      console.warn('⚠️  Got 0 channels — token may have expired. Attempting refresh...');
      await refreshToken();
      // Retry channels fetch after refresh
      const retried = await getAllChannels();
      if (!retried.length) {
        throw new Error('Still got 0 channels after token refresh. Check funId or account access.');
      }
      channels.push(...retried);
    }

    // ── Pending locker names ──────────────────────────────────────────────────
    const pendingLockerNames = await getPendingLockerNames(allRecords);

    // ── Clean stale tracker entries ───────────────────────────────────────────
    const cleanedActiveLockers = await cleanStaleTrackerEntries(allRecords);

    // ── Find free locker ──────────────────────────────────────────────────────
    const locker = await findFreeLocker(channels, pendingLockerNames, cleanedActiveLockers);

    // ── Snapshot BEFORE ───────────────────────────────────────────────────────
    const { orderNos: beforeOrderNos, codes: beforeCodes } = await snapshotLockerPending(locker.lockerName);

    // ── Create pickup code ────────────────────────────────────────────────────
    const result = await addPickInfo(locker);
    if (result?.code !== '00000') {
      throw new Error(`addPickInfo failed: ${JSON.stringify(result)}`);
    }

    // ── Try direct response first ─────────────────────────────────────────────
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
      const newRec = await waitForNewCodeForLocker(locker.lockerName, beforeOrderNos, beforeCodes);
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

    // ── Save ──────────────────────────────────────────────────────────────────
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
      success: true,
      pickCode,
      orderNo,
      locker:      locker.lockerLabel,
      funId:       CONFIG.funId,
      goodsId:     locker.goodsId,
      roadId:      locker.roadId,
      generatedAt: new Date().toISOString(),
    }));

  } catch (err) {
    console.error('❌ Error:', err.message);
    console.log('OUTPUT_JSON:' + JSON.stringify({ success: false, error: err.message }));
    process.exit(1);
  }
}

main();
