/**
 * accumulate_advance_orders.js
 *
 * Splits every incoming order file into two paths:
 *
 *   Instant Pickup  -> processed immediately via generate_pickup_code.js,
 *                      exactly like today (unchanged for now — this will
 *                      be upgraded separately once the Instant Pickup
 *                      pool system is built).
 *
 *   Advance Pickup  -> bucketed into
 *                      advance_queue/order_details_<DD>_<Mon>_<YYYY>_slot<N>.json
 *                      accumulating as more customers order the same
 *                      date+slot over the following days. NO pickup code
 *                      is generated here — that only happens at the
 *                      scheduled release for that specific date+slot
 *                      (see release_slot.js).
 *
 * DUPLICATE PROTECTION: the existing "already in bucket" check only
 * catches an order_id that's still SITTING in the current bucket file.
 * Once that order has been successfully released, its bucket entry is
 * removed — at which point this script has no memory it was ever
 * handled. If the upstream order-fetch step ever re-submits the same
 * order_id later (e.g. Shopify's own fulfillment status was never
 * updated to reflect a code was already issued externally), nothing
 * stopped it from being re-bucketed and re-processed from scratch,
 * generating a second real locker + code + email + WhatsApp for an
 * order that already has one. Confirmed happening in production on
 * 2026-09-21. Now also checks the PERMANENT processed_order_ids.json
 * (the same file generate_pickup_code.js writes to on every real
 * success) before ever bucketing an order — this catches it before it
 * even reaches a bucket file, as the first line of defense.
 *
 * Usage: node accumulate_advance_orders.js <path-to-raw-orders.json>
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { formatDateForBucket, slotFromPickupTime } = require('./date_utils');

const QUEUE_DIR = path.join(__dirname, 'advance_queue');
const TOTAL_LOCKERS_PER_LOCATION = 14;
const PROCESSED_ORDERS_FILE = path.join(__dirname, 'pickup_codes', 'processed_order_ids.json');

function loadBucket(file) {
  if (!fs.existsSync(file)) return [];
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function saveBucket(file, orders) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(orders, null, 2));
}

function loadProcessedOrderIds() {
  if (!fs.existsSync(PROCESSED_ORDERS_FILE)) return new Set();
  try {
    return new Set(JSON.parse(fs.readFileSync(PROCESSED_ORDERS_FILE, 'utf8')));
  } catch {
    return new Set();
  }
}

function main() {
  const orderPath = process.env.ORDERS_FILE || process.argv[2];
  if (!orderPath) {
    console.error('Usage: node accumulate_advance_orders.js <path-to-orders.json>');
    console.error('   (or set ORDERS_FILE env var)');
    process.exit(1);
  }

  const orders = JSON.parse(fs.readFileSync(orderPath, 'utf8'));
  console.log(`\n📦 Sorting ${orders.length} order(s) by pickup_type...\n`);

  const processedIds = loadProcessedOrderIds();

  const instantOrders = [];
  const advanceOrders = [];

  for (const order of orders) {
    // Catch a re-submitted, already-fulfilled order as early as possible
    // — before it's even split into Instant/Advance, so it can never
    // reach a second real code generation via either path.
    if (processedIds.has(order.order_id)) {
      console.log(`⏭️  Order ${order.order_id} already has a pickup code from a previous run — skipping entirely (duplicate submission).`);
      continue;
    }

    if (order.pickup_type === 'Instant Pickup') {
      instantOrders.push(order);
    } else if (order.pickup_type === 'Advance Pickup') {
      advanceOrders.push(order);
    } else {
      console.warn(`⚠️  Unknown pickup_type "${order.pickup_type}" for order ${order.order_id} — skipping entirely`);
    }
  }

  // ── Instant Pickup: unchanged, immediate processing ────────────────────
  if (instantOrders.length > 0) {
    console.log(`⚡ ${instantOrders.length} Instant Pickup order(s) — processing immediately...\n`);
    const tempFile = path.join(__dirname, `.instant-batch-${Date.now()}.json`);
    fs.writeFileSync(tempFile, JSON.stringify(instantOrders, null, 2));
    try {
      // stdio:'inherit' so OUTPUT_JSON: lines flow through to whatever
      // called this script, same as if generate_pickup_code.js ran directly.
      execSync(`node generate_pickup_code.js "${tempFile}"`, { stdio: 'inherit' });
    } finally {
      fs.unlinkSync(tempFile);
    }
  }

  // ── Advance Pickup: bucket by date + slot, no code yet ─────────────────
  // Each slot has its own independent 14-order cap now — slot 2 can reuse
  // a slot-1 locker that frees up by 1PM, so acceptance isn't gated by a
  // combined count. Actual fulfillment is resolved at release time by the
  // two-wave process (see release_slot2_wave1.js / wave2.js).
  if (advanceOrders.length > 0) {
    console.log(`\n📅 ${advanceOrders.length} Advance Pickup order(s) — bucketing by date/slot...\n`);

    const grouped = {};
    for (const order of advanceOrders) {
      const parsedDate = new Date(order.pickup_date);
      const dateStr = isNaN(parsedDate.getTime()) ? null : formatDateForBucket(parsedDate);
      const slot = slotFromPickupTime(order.pickup_time);

      if (!dateStr || !slot) {
        console.warn(
          `⚠️  Could not determine bucket for order ${order.order_id} ` +
            `(date="${order.pickup_date}", time="${order.pickup_time}") — skipping`
        );
        continue;
      }

      const key = `${dateStr}_slot${slot}`;
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(order);
    }

    for (const [key, newOrders] of Object.entries(grouped)) {
      const bucketFile = path.join(QUEUE_DIR, `order_details_${key}.json`);
      const existing = loadBucket(bucketFile);
      const existingIds = new Set(existing.map((o) => o.order_id));

      // Cap is per-location within this single slot bucket (file already
      // combines both locations, so count per location separately).
      const countsByLocation = {};
      for (const o of existing) {
        countsByLocation[o.order_location] = (countsByLocation[o.order_location] || 0) + 1;
      }

      let added = 0;
      let rejected = 0;

      for (const order of newOrders) {
        if (existingIds.has(order.order_id)) {
          console.log(`  (already in bucket, skipping duplicate) ${order.order_id}`);
          continue;
        }

        const currentCount = countsByLocation[order.order_location] || 0;
        if (currentCount >= TOTAL_LOCKERS_PER_LOCATION) {
          console.error(
            `❌ REJECTED order ${order.order_id}: ${order.order_location} slot ${slotFromPickupTime(order.pickup_time)} ` +
              `is fully booked for this date (${TOTAL_LOCKERS_PER_LOCATION}/${TOTAL_LOCKERS_PER_LOCATION}). ` +
              `NEEDS MANUAL ATTENTION — customer has not been notified of anything yet.`
          );
          rejected++;
          continue;
        }

        existing.push(order);
        countsByLocation[order.order_location] = currentCount + 1;
        added++;
      }

      saveBucket(bucketFile, existing);
      console.log(
        `✓ ${bucketFile}: +${added} new order(s)` +
          (rejected > 0 ? `, ${rejected} REJECTED (over capacity)` : '') +
          `, ${existing.length} total waiting for release`
      );
    }
  }

  console.log('\nDone.');
}

main();
