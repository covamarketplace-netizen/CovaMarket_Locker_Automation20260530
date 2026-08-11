/**
 * release_slot.js
 *
 * Finds TODAY's (in MYT) accumulated advance-pickup bucket file for the
 * given slot, and prints its path so the workflow can feed it straight
 * into the existing generate_pickup_code.js — no changes needed there,
 * it already handles "here's an orders.json, generate real codes."
 *
 * After a successful release, run with --archive to move that bucket
 * file aside so it never gets reprocessed by tomorrow's run.
 *
 * Usage:
 *   node release_slot.js <1|2>            -> prints bucket file path (empty if none)
 *   node release_slot.js <1|2> --archive  -> archives today's bucket file
 */

const fs = require('fs');
const path = require('path');
const { nowInMYT, formatDateForBucket } = require('./date_utils');

const QUEUE_DIR = path.join(__dirname, 'advance_queue');
const ARCHIVE_DIR = path.join(QUEUE_DIR, 'released');

function todaysBucketFile(slot) {
  const dateStr = formatDateForBucket(nowInMYT());
  return path.join(QUEUE_DIR, `order_details_${dateStr}_slot${slot}.json`);
}

function main() {
  const slot = process.argv[2];
  const archive = process.argv.includes('--archive');

  if (slot !== '1' && slot !== '2') {
    console.error('Usage: node release_slot.js <1|2> [--archive]');
    process.exit(1);
  }

  const file = todaysBucketFile(slot);

  if (archive) {
    if (fs.existsSync(file)) {
      fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
      const dest = path.join(ARCHIVE_DIR, path.basename(file));
      fs.renameSync(file, dest);
      console.log(`Archived: ${file} -> ${dest}`);
    } else {
      console.log(`Nothing to archive at ${file}`);
    }
    return;
  }

  if (fs.existsSync(file)) {
    let orders = [];
    try {
      orders = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      console.error(''); // malformed file — print nothing, don't crash the workflow
      return;
    }
    if (orders.length === 0) {
      console.log('');
      return;
    }
    console.log(file); // workflow captures this via stdout
  } else {
    console.log(''); // nothing to release today
  }
}

main();
