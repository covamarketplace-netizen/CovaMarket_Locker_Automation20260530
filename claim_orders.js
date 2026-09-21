/**
 * claim_orders.js
 *
 * Solves a race that concurrency + checkout-ref fixes + the permanent
 * processed_order_ids.json file could NOT close on their own: two
 * workflow runs whose JOBS genuinely overlap in wall-clock time (despite
 * `concurrency: group: generate-pickup-code` being configured to prevent
 * exactly this) can both read processed_order_ids.json BEFORE either has
 * written to it, see the same order_id as "not yet processed," and both
 * proceed to do the real work. Confirmed happening in production
 * 2026-09-21: order #1752 got two real locker codes for the same
 * physical locker, 26 seconds apart, because both runs' checkouts landed
 * before either run's commit.
 *
 * THE FIX: don't rely on READING shared state to decide "is this new?" —
 * that read can always race. Instead, ATTEMPT TO WRITE a claim first,
 * and let git's own atomicity on the server decide who wins. A `git
 * push` to the same ref from two places can never both succeed — the
 * second one is always rejected, deterministically, by GitHub itself.
 * That rejection IS the lock. No reliance on job-level timing, no
 * reliance on checkout freshness — the ordering is decided at the one
 * point that's genuinely atomic: the remote ref update.
 *
 * Usage:
 *   node claim_orders.js <input-orders-file> <output-claimed-file>
 *
 * Writes <output-claimed-file> containing ONLY the orders this run
 * successfully claimed (i.e. safe to do real work on). Orders already
 * claimed by someone else (whether processed earlier, or claimed by a
 * concurrently-running duplicate of THIS SAME submission) are silently
 * dropped — not an error, just nothing more to do for them.
 *
 * If claiming succeeds for zero orders (everything in the input was
 * already claimed), writes an empty array and exits 0 — the calling
 * workflow step should treat this as "nothing to do," not a failure.
 *
 * Must be run from the repo root, inside a normal (non-conflicted) git
 * working tree, on the `main` branch, with a `git push` remote already
 * configured with write credentials (same as every other commit step in
 * this pipeline).
 */

const fs = require('fs');
const { execSync } = require('child_process');

const PROCESSED_FILE = 'pickup_codes/processed_order_ids.json';
const MAX_ATTEMPTS = 5;

function sh(cmd) {
  return execSync(cmd, { encoding: 'utf8' });
}

function loadProcessedIds() {
  if (!fs.existsSync(PROCESSED_FILE)) return new Set();
  try {
    return new Set(JSON.parse(fs.readFileSync(PROCESSED_FILE, 'utf8')));
  } catch {
    return new Set();
  }
}

function saveProcessedIds(ids) {
  fs.mkdirSync('pickup_codes', { recursive: true });
  fs.writeFileSync(PROCESSED_FILE, JSON.stringify([...ids], null, 2));
}

function main() {
  const inputFile = process.argv[2];
  const outputFile = process.argv[3];
  if (!inputFile || !outputFile) {
    console.error('Usage: node claim_orders.js <input-orders-file> <output-claimed-file>');
    process.exit(1);
  }

  const allOrders = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
  console.log(`📋 ${allOrders.length} order(s) to attempt claiming...`);

  git_config();

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // Always re-sync to latest BEFORE deciding what's new — this is
    // still just a best-effort read, the actual safety comes from the
    // push below, not from this being "fresh enough."
    try {
      sh('git fetch origin main');
      sh('git reset --hard origin/main');
    } catch (err) {
      console.error(`⚠️  Sync failed on attempt ${attempt}: ${err.message}`);
    }

    const processedIds = loadProcessedIds();
    const toClaim = allOrders.filter((o) => !processedIds.has(o.order_id));

    if (toClaim.length === 0) {
      console.log('⏭️  Every order in this batch is already claimed/processed — nothing new to do.');
      fs.writeFileSync(outputFile, JSON.stringify([]));
      return;
    }

    const claimIds = toClaim.map((o) => o.order_id);
    console.log(`Attempt ${attempt}/${MAX_ATTEMPTS}: trying to claim [${claimIds.join(', ')}]...`);

    const newProcessedIds = new Set([...processedIds, ...claimIds]);
    saveProcessedIds(newProcessedIds);

    try {
      sh(`git add "${PROCESSED_FILE}"`);
      sh(`git commit -m "Claim order(s): ${claimIds.join(', ')} [skip ci]"`);
      sh('git push origin main');
      // Push succeeded — these order_ids are now atomically ours. No one
      // else can claim them, because their own push (if they're racing
      // us right now) will be rejected by GitHub the moment it lands
      // after this one, and their retry will re-sync and see them
      // already here.
      console.log(`✅ Successfully claimed: ${claimIds.join(', ')}`);
      fs.writeFileSync(outputFile, JSON.stringify(toClaim, null, 2));
      return;
    } catch (err) {
      console.warn(`⚠️  Push rejected on attempt ${attempt} — someone else claimed first for at least one ID. Retrying...`);
      // Undo our local commit before the next loop iteration re-syncs
      // and recomputes — otherwise git reset --hard above would discard
      // it anyway, but being explicit here avoids relying on that.
      try {
        sh('git reset --hard HEAD~1');
      } catch {
        // if there was nothing to reset (commit itself failed, e.g.
        // nothing staged because claimIds was somehow already empty),
        // that's fine — next loop iteration's fetch+reset handles it
      }
    }
  }

  console.error(`❌ Could not claim any orders after ${MAX_ATTEMPTS} attempts — repeated push contention. Failing loudly rather than risking a duplicate.`);
  process.exit(1);
}

function git_config() {
  try {
    sh('git config user.name "github-actions[bot]"');
    sh('git config user.email "github-actions[bot]@users.noreply.github.com"');
  } catch {
    // already configured by an earlier step — fine
  }
}

main();
