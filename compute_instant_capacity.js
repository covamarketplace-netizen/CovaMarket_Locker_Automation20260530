/**
 * compute_instant_capacity.js
 *
 * Runs at 9:30 PM MYT, right after tomorrow's advance-pickup cutoff.
 * Counts how many lockers are ALREADY committed to tomorrow's advance
 * bookings (across both slots, since one locker serves at most one
 * order per day) and reserves whatever's left as Instant Pickup budget.
 *
 * IMPORTANT: this reserves a COUNT, not specific lockers. We don't yet
 * know which physical roadIds tomorrow's advance releases (7AM/11AM)
 * will actually pick — that's decided live, using the same
 * collision-safe findLockerForOrder logic already in generate_pickup_code.js.
 * This budget just caps how many Instant orders can be accepted, so they
 * can never eat into lockers already promised to confirmed advance
 * customers.
 */

const fs = require('fs');
const path = require('path');
const { nowInMYT, formatDateForBucket } = require('./date_utils');

const QUEUE_DIR = path.join(__dirname, 'advance_queue');
const CAPACITY_FILE = path.join(__dirname, 'pickup_codes', 'instant_capacity.json');
const TOTAL_LOCKERS_PER_LOCATION = 14;

const LOCATIONS = {
  715: 'LRT Sentul Timur',
  716: 'LRT Lembah Subang',
};

function loadBucket(file) {
  if (!fs.existsSync(file)) return [];
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
}

function loadCapacityFile() {
  if (!fs.existsSync(CAPACITY_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(CAPACITY_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveCapacityFile(data) {
  fs.mkdirSync(path.dirname(CAPACITY_FILE), { recursive: true });
  fs.writeFileSync(CAPACITY_FILE, JSON.stringify(data, null, 2));
}

function main() {
  // "Tomorrow" relative to MYT right now (9:30 PM MYT -> next calendar day)
  const tomorrowMYT = new Date(nowInMYT().getTime() + 24 * 60 * 60 * 1000);
  const dateKey = formatDateForBucket(tomorrowMYT);

  console.log(`\n📊 Computing Instant Pickup capacity for ${dateKey}...\n`);

  const slot1File = path.join(QUEUE_DIR, `order_details_${dateKey}_slot1.json`);
  const slot2File = path.join(QUEUE_DIR, `order_details_${dateKey}_slot2.json`);
  const slot1Orders = loadBucket(slot1File);
  const slot2Orders = loadBucket(slot2File);

  const capacityData = loadCapacityFile();
  capacityData[dateKey] = capacityData[dateKey] || {};

  for (const [funId, locationName] of Object.entries(LOCATIONS)) {
    const slot1Count = slot1Orders.filter((o) => o.order_location === locationName).length;
    const slot2Count = slot2Orders.filter((o) => o.order_location === locationName).length;

    // Each slot has its OWN independent 14-locker cap now (matching
    // accumulate_advance_orders.js) — NOT a combined total. A slot1
    // instant order and a slot2 instant order can even end up using the
    // same physical locker later in the day, same as Advance Pickup does.
    const slot1Capacity = Math.max(0, TOTAL_LOCKERS_PER_LOCATION - slot1Count);
    const slot2Capacity = Math.max(0, TOTAL_LOCKERS_PER_LOCATION - slot2Count);

    capacityData[dateKey][funId] = { slot1: slot1Capacity, slot2: slot2Capacity };

    console.log(
      `${locationName} (funId ${funId}): ` +
        `slot1: ${slot1Count} advance -> ${slot1Capacity} instant | ` +
        `slot2: ${slot2Count} advance -> ${slot2Capacity} instant`
    );
  }

  saveCapacityFile(capacityData);
  console.log(`\n✅ Saved to ${CAPACITY_FILE}`);
}

main();
