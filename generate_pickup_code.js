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

// ── Dry-run mode ────────────────────────────────────────────────────────
// Detected via --dry-run flag or DRY_RUN=1 env var. Does everything real
// (fetches live channels/stock, resolves labels, tracks selections to
// prevent overlap within the run) EXCEPT the actual create_pick_order
// call — no real pickup codes get generated on XZY's system.
const DRY_RUN = process.argv.includes('--dry-run') || process.env.DRY_RUN === '1';
const {
  createPickOrder,
  getFunByDept,
  getRoodById,
  getGoodsById,
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

const TRACKING_FILE = path.join(
  __dirname,
  'pickup_codes',
  DRY_RUN ? 'dry_run_active_lockers.json' : 'active_lockers.json'
);

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

// ── goodsId -> goodsName (the REAL, physically-accurate label — confirmed
//    by physical test to match the actual printed door, unlike
//    roadRow/roadColumn which is just an internal index) ─────────────────
let goodsNameCache = null;
async function getGoodsName(goodsId) {
  if (!goodsNameCache) {
    goodsNameCache = {};
    let page = 1;
    let items;
    do {
      items = await getGoodsById(page, 100);
      for (const g of items) goodsNameCache[g.goodsId] = g.goodsName;
      page++;
    } while (items.length === 100 && page <= 5); // safety cap
  }
  return goodsNameCache[goodsId] || `Locker (goodsId ${goodsId})`;
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
      // Only free the locker on an EXPLICIT Completed(1) or Voided(3).
      // 0 (Pending) and 2 (Failed) stay tracked — a failed pickup doesn't
      // necessarily mean the item is gone, so don't auto-release it.
      // pickStatus undefined should now be rare (fixed the array-wrapping
      // bug in findPick — pending codes correctly return pickStatus:0
      // now). If it still happens, stay conservative and leave it tracked
      // rather than guessing.
      if (pickStatus === 1 || pickStatus === 3) {
        console.log(
          `🧹 Removing stale tracker: roadId=${roadId} locker=${entry.locker} — pickStatus=${pickStatus} (confirmed done)`
        );
        delete activeLockers[roadId];
        cleaned++;
      } else if (pickStatus === undefined) {
        console.log(
          `⏳ Skipping roadId=${roadId} locker=${entry.locker} — pickStatus unknown/not yet indexed, leaving tracked`
        );
      }
    } catch (err) {
      // '未查询到取货码信息' (code not found) is confirmed, via real physical
      // testing, to mean the code was already collected — not that it never
      // existed. Free the locker. Any OTHER error stays conservative
      // (leave tracked) since we don't know what it means.
      if (err.message.includes('未查询到取货码信息')) {
        console.log(
          `🧹 Removing stale tracker: roadId=${roadId} locker=${entry.locker} — code not found (confirmed = collected)`
        );
        delete activeLockers[roadId];
        cleaned++;
      } else {
        console.warn(`⚠️  Could not check pickCode ${entry.pickCode} (roadId=${roadId}): ${err.message}`);
      }
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

// ── Locker label resolution — CONFIRMED to differ per machine ─────────────
// Physical testing (2026-08-01) showed the two machines are inconsistent
// with each other, not just with the API's internal indexing:
//
//   funId 716 (LRTLembahSubang): roadId 96358 (roadRow:2, roadColumn:1)
//     physically opened the door labeled "1-2" — matching its goodsName
//     ("Locker 1-2"), NOT roadRow-roadColumn. -> trust goodsName.
//
//   funId 715 (LRTSentulTimur): roadId 903514 (roadRow:3, roadColumn:1)
//     physically opened the door the user counted as row 3, column 1 —
//     matching roadRow-roadColumn EXACTLY, NOT its goodsName
//     ("Locker2 2-3", which matches neither digit order).
//     This also lines up with 715 having confirmed mislabeled products
//     elsewhere ("Locker 3-2" / "Locker 6-2" missing their "2") — this
//     machine's goodsName values look generally unreliable.
//
// Each confirmed by exactly ONE physical test per machine, not all 14
// channels — treat as best evidence so far, not exhaustively verified.
// Re-check if a customer ever reports the wrong door.
const LABEL_SOURCE_BY_FUN_ID = {
  715: 'roadRowColumn',
  716: 'goodsName',
};

async function resolveLockerLabel(funId, channel) {
  const source = LABEL_SOURCE_BY_FUN_ID[funId];
  if (source === 'roadRowColumn') {
    return `${channel.roadRow}-${channel.roadColumn}`;
  }
  // Default / 716: use goodsName
  return getGoodsName(channel.goodsId);
}
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
  const realLabel = await resolveLockerLabel(funId, chosen);
  return {
    goodsId: chosen.goodsId,
    roadId: chosen.roadId,
    roadRow: chosen.roadRow,
    roadColumn: chosen.roadColumn,
    lockerLabel: realLabel,
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
    if (DRY_RUN) {
      console.log('🧪 DRY RUN — no real pickup codes will be created on XZY.\n');
    }

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

        const result = DRY_RUN
          ? {
              pickCode: `DRY${String(i + 1).padStart(3, '0')}`,
              pickOrderNum: `DRYRUN-${Date.now()}-${i + 1}`,
            }
          : await createPickOrder({
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
          pickupDate: order.pickup_date || null,
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
              dryRun: DRY_RUN,
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
