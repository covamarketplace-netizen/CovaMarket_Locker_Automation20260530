/**
 * generate_pickup_code.js — public API version
 *
 * REPLACES the old JWT/dashboard-login approach. That version depended on
 * XYZ_TOKEN, a JWT that expires every 7-30 days and required manually
 * logging into xzyvend.com and copying a fresh token out of DevTools —
 * easy to forget, and the whole pipeline silently stops when it expires.
 *
 * This version uses XZY's signed appId+key API instead (same one used in
 * xzyvend.js). It does not expire and needs no login step, ever.
 *
 * Required env vars:
 *   XZY_APP_ID
 *   XZY_SECRET_KEY
 *
 * Usage:
 *   node generate_pickup_code.js <path-to-orders.json>
 *   or: ORDERS_FILE=<path> node generate_pickup_code.js
 *
 * Output format (OUTPUT_JSON: line) is unchanged from the old version, so
 * whatever GitHub Actions step parses it to feed send_email.js /
 * send_whatsapp.js keeps working without modification.
 *
 * KNOWN GAP vs the old version: no public-API equivalent of replenishRoad
 * has been found yet, so auto-replenishment of empty channels after a
 * pickup isn't handled here. Restocking still needs the dashboard (or ask
 * XZY support if a public replenish endpoint exists). Physical stock
 * levels (roadStock) still update correctly on their own via the hardware
 * regardless of which API is used to read them.
 */

const fs = require('fs');
const path = require('path');
const {
  createPickOrder,
  getFunByDept,
  getRoodById,
  findPick,
} = require('./xzyvend');

// ── Location -> funId mapping (unchanged from the old script) ─────────────
const LOCATION_FUN_MAP = {
  'lrt lembah subang': 716,
  'lrt pantai':        715,
  'lrt sentul timur':  715, // alias for LRT Pantai
};

function resolveFunId(orderLocation) {
  if (!orderLocation) throw new Error('order_location is missing in order JSON');
  const key = orderLocation.trim().toLowerCase();
  for (const [loc, funId] of Object.entries(LOCATION_FUN_MAP)) {
    if (key === loc) return funId;
  }
  throw new Error(
    `Unknown order_location: "${orderLocation}".\n` +
      `Known locations: ${Object.keys(LOCATION_FUN_MAP).map((l) => `"${l}"`).join(', ')}\n` +
      `Add it to LOCATION_FUN_MAP in generate_pickup_code.js`
  );
}

const TRACKING_FILE = path.join(__dirname, 'pickup_codes', 'active_lockers.json');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── File helpers (same file/format as the old script — nothing else that
//    reads active_lockers.json needs to change) ────────────────────────────
function loadActiveLockers() {
  try {
    if (!fs.existsSync(TRACKING_FILE)) return {};
    return JSON.parse(fs.readFileSync(TRACKING_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveActiveLockers(data) {
  const dir = path.dirname(TRACKING_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(TRACKING_FILE, JSON.stringify(data, null, 2));
  console.log(`💾 Saved active_lockers.json (${Object.keys(data).length} entries)`);
}

// ── funId -> funNumber (find_pick needs funNumber, not funId) ─────────────
let funNumberCache = null;
async function getFunNumber(funId) {
  if (!funNumberCache) {
    const res = await getFunByDept(1, 100);
    const list = res?.data?.records || res?.data?.list || res?.data || [];
    funNumberCache = {};
    for (const d of list) funNumberCache[d.funId] = d.funNumber;
  }
  const funNumber = funNumberCache[funId];
  if (!funNumber) throw new Error(`Could not resolve funNumber for funId ${funId}`);
  return funNumber;
}

// ── Clean stale tracker entries ─────────────────────────────────────────
// The old script used one bulk "list all pending codes" call. The public
// API has no bulk equivalent, so we check each tracked code individually
// via find_pick. Fine at this scale (max 14 lockers per machine).
async function cleanStaleTrackerEntries(funId) {
  const activeLockers = loadActiveLockers();
  const entries = Object.entries(activeLockers).filter(([, e]) => e.funId === funId);
  if (!entries.length) return activeLockers;

  const funNumber = await getFunNumber(funId);
  let cleaned = 0;

  for (const [roadId, entry] of entries) {
    try {
      const status = await findPick(funNumber, entry.pickCode);
      const pickStatus = status?.pickStatus;
      // 0 = Pending (still occupied). Anything else = free again.
      if (pickStatus !== 0) {
        console.log(
          `🧹 Removing stale tracker: roadId=${roadId} locker=${entry.locker} — pickStatus=${pickStatus}`
        );
        delete activeLockers[roadId];
        cleaned++;
      }
    } catch (err) {
      console.warn(`⚠️  Could not check pickCode ${entry.pickCode} (roadId=${roadId}): ${err.message}`);
    }
  }

  if (cleaned > 0) {
    saveActiveLockers(activeLockers);
    console.log(`🧹 Cleaned ${cleaned} stale tracker entry/entries.`);
  } else {
    console.log('✅ Tracker is clean — all entries still pending.');
  }

  return activeLockers;
}

// ── Find a locker for this order ────────────────────────────────────────
// Only uses channels that ALREADY have stock. No login/JWT is used
// anywhere in this file — if nothing is stocked, this fails clearly and
// tells you to restock via XZY's H5 mobile page (their own recommended
// method), instead of silently attempting an auto-replenish that would
// require a token that can expire without warning.
async function findLockerForOrder(funId, activeLockers) {
  const channels = await getRoodById(funId);
  console.log(`📦 Total channels for funId ${funId}: ${channels.length}`);

  const activeRoadIds = new Set(Object.keys(activeLockers));

  channels.forEach((ch) => {
    console.log(
      `  ${ch.roadRow}-${ch.roadColumn} | roadId=${ch.roadId} | goodsId=${ch.goodsId} | ` +
        `stock=${ch.roadStock} | tracked=${activeRoadIds.has(String(ch.roadId))}`
    );
  });

  const stocked = channels.filter(
    (ch) => (ch.roadStock ?? 0) > 0 && !activeRoadIds.has(String(ch.roadId))
  );

  if (!stocked.length) {
    throw new Error(
      `No stocked lockers available for funId ${funId}. ` +
        `Please restock via the XZY H5 mobile page, then re-run this order. ` +
        `(No login/token is used in this script — restocking must be done manually.)`
    );
  }

  const chosen = stocked[0];
  return {
    goodsId: chosen.goodsId,
    roadId: chosen.roadId,
    roadRow: chosen.roadRow,
    roadColumn: chosen.roadColumn,
    lockerLabel: `${chosen.roadRow}-${chosen.roadColumn}`,
  };
}

// ── Main ─────────────────────────────────────────────────────────────────
async function main() {
  try {
    if (!process.env.XZY_APP_ID || !process.env.XZY_SECRET_KEY) {
      throw new Error('XZY_APP_ID / XZY_SECRET_KEY not set!');
    }

    const orderPath = process.env.ORDERS_FILE || process.argv[2];
    if (!orderPath) throw new Error('Provide order file via ORDERS_FILE env var or as CLI argument');

    const orders = JSON.parse(fs.readFileSync(orderPath, 'utf8'));
    if (!orders.length) throw new Error(`No orders found in ${orderPath}`);

    console.log(`\n📦 Found ${orders.length} order(s) to process\n`);

    for (let i = 0; i < orders.length; i++) {
      const order = orders[i];
      console.log(`\n${'═'.repeat(50)}`);
      console.log(`📦 Processing order ${i + 1}/${orders.length}: ${order.order_id}`);
      console.log(`👤 Customer  : ${order.customer_name} <${order.email}>`);
      console.log(`📍 Location  : ${order.order_location}`);

      try {
        const funId = resolveFunId(order.order_location);
        console.log(`📦 funId=${funId} (resolved from "${order.order_location}")`);

        await cleanStaleTrackerEntries(funId);
        const activeLockers = loadActiveLockers();

        const locker = await findLockerForOrder(funId, activeLockers);
        console.log(`✅ Selected locker ${locker.lockerLabel} (roadId=${locker.roadId}, goodsId=${locker.goodsId})`);

        const result = await createPickOrder({
          funId,
          goodsId: locker.goodsId,
          pickType: 0,
          roadColumn: locker.roadColumn,
          roadRow: locker.roadRow,
        });

        if (!result?.pickCode) {
          throw new Error(`create_pick_order did not return a pickCode: ${JSON.stringify(result)}`);
        }

        activeLockers[locker.roadId] = {
          pickCode: result.pickCode,
          orderNo: result.pickOrderNum || null,
          locker: locker.lockerLabel,
          goodsId: locker.goodsId,
          funId,
          createdAt: new Date().toISOString(),
        };
        saveActiveLockers(activeLockers);

        console.log('\n═══════════════════════════════════');
        console.log(`✅ PICKUP CODE : ${result.pickCode}`);
        console.log(`📦 LOCKER      : ${locker.lockerLabel} (roadId=${locker.roadId})`);
        console.log('═══════════════════════════════════\n');

        console.log(
          'OUTPUT_JSON:' +
            JSON.stringify({
              success: true,
              pickCode: result.pickCode,
              orderNo: result.pickOrderNum || null,
              locker: locker.lockerLabel,
              funId,
              goodsId: locker.goodsId,
              roadId: locker.roadId,
              generatedAt: new Date().toISOString(),
              orderId: order.order_id,
              customerName: order.customer_name,
              customerEmail: order.email,
              customerPhone: order.phone || null,
              orderLocation: order.order_location,
              pickupDate: order.pickup_date,
              pickupTime: order.pickup_time,
            })
        );
      } catch (err) {
        console.error(`❌ Error on order ${order.order_id}: ${err.message}`);
        console.log(
          'OUTPUT_JSON:' +
            JSON.stringify({
              success: false,
              orderId: order.order_id,
              error: err.message,
            })
        );
      }

      if (i < orders.length - 1) {
        console.log('\n⏸  Waiting 1.5s before next order...');
        await sleep(1500);
      }
    }
  } catch (err) {
    console.error('❌ Fatal error:', err.message);
    console.log('OUTPUT_JSON:' + JSON.stringify({ success: false, error: err.message }));
    process.exit(1);
  }
}

main();
