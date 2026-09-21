/**
 * resolve_tracking_conflict.js
 *
 * Called ONLY when a git push has been rejected and the retry's
 * `git pull --rebase` hits a real content conflict (not just a simple
 * "someone pushed first" fast-forward case, which `git pull --rebase`
 * already resolves fine on its own).
 *
 * WHY THIS EXISTS: git's default conflict resolution compares TEXT
 * LINES, with no idea what the JSON actually means. When two separate
 * workflow runs each independently add one new record to the same
 * tracking file at nearly the same time, git sees "the same lines
 * changed on both sides" and gives up — even though the two changes
 * are just two unrelated facts that both happened and both belong in
 * the file. The previous behavior on an unresolved conflict was to let
 * the whole workflow fail, which SILENTLY DISCARDED that run's local
 * commit — including a real customer's successfully-created pickup
 * code ever being recorded. Confirmed happening in production twice
 * (2026-09-21, orders #1740 and #1713/#1720/#1721).
 *
 * SCOPE — what this can and can't safely fix:
 *
 *   SAFELY AUTO-MERGEABLE (this script handles these):
 *   - pickup_codes/active_lockers.json   — object keyed by roadId; each
 *     entry is independently created by one order. Union of keys is
 *     always correct — there's no scenario where combining "customer
 *     A's locker" and "customer B's locker" from two different orders
 *     is wrong, since they're unrelated facts.
 *   - pickup_codes/processed_order_ids.json — array of order_ids.
 *     Simple set union — same reasoning.
 *   - pickup_codes/instant_lockers_used.json — nested arrays of roadIds
 *     per date/funId/slot. Union per key, deduplicated.
 *   - pickup_codes/latest.json — added 2026-09-21. A pure "last run"
 *     snapshot that every run overwrites completely, so it isn't
 *     additive data at all: the run being replayed (the newest one)
 *     simply wins. It was the file that blocked the merge in the
 *     #229/#230 race.
 *
 *   NOT SAFELY AUTO-MERGEABLE (this script does NOT attempt these —
 *   see the honesty note in the conversation this was built from):
 *   - pickup_codes/instant_capacity.json — these are DECREMENTING
 *     COUNTERS, not additive facts. If two conflicting local copies
 *     each independently decremented the same slot's count by 1 based
 *     on one real order each, a naive merge could double-count OR
 *     under-count the true remaining budget. This script leaves this
 *     file's conflict for the existing manual-resolution failure path
 *     — it is NOT silently guessed at.
 *   - advance_queue/*.json bucket files — mergeable in principle (union
 *     of orders), but re-validating the 14-per-location cap after
 *     merging needs care this script does not yet attempt. Left to the
 *     existing failure path for now.
 *
 * If any file outside the safely-mergeable ones is part of the
 * conflict, this script exits non-zero and changes nothing — the
 * calling workflow step will then fail loudly and visibly, exactly as
 * it does today, rather than silently guessing at a merge it can't be
 * sure is correct.
 *
 * Usage: node resolve_tracking_conflict.js
 * (run from the repo root, with git already in a conflicted, mid-rebase
 * state — i.e. after `git pull --rebase` has reported CONFLICT lines)
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const SAFELY_MERGEABLE = [
  'pickup_codes/active_lockers.json',
  'pickup_codes/processed_order_ids.json',
  'pickup_codes/instant_lockers_used.json',
  'pickup_codes/latest.json',
];

function getConflictedFiles() {
  const out = execSync('git diff --name-only --diff-filter=U', { encoding: 'utf8' });
  return out.split('\n').map((l) => l.trim()).filter(Boolean);
}

// Reads a conflicted file's two sides directly from git's index, rather
// than trying to parse merge-marker text out of the working file (which
// is fragile and format-dependent).
//
// IMPORTANT — stage meaning DURING A REBASE (which is how the workflows
// call this): stage 2 = the upstream branch we're rebasing ONTO (what's
// now on the remote); stage 3 = the local commit being REPLAYED (this
// run's own changes). This is the opposite of a normal `git merge`.
// The union merges below are symmetric so it doesn't matter for them,
// but it DOES matter for latest.json.
function readStage(file, stage) {
  try {
    const raw = execSync(`git show :${stage}:${file}`, { encoding: 'utf8' });
    return JSON.parse(raw);
  } catch {
    return null; // file didn't exist on that side, or isn't valid JSON
  }
}

function mergeActiveLockersOrSimilarObject(ours, theirs) {
  // Both are objects keyed by roadId. Every entry is independently
  // created by a different order — union of keys is always correct.
  // In the rare case the SAME roadId key exists on both sides (would
  // only happen if the same real locker was somehow used twice in the
  // exact same conflict window, which processed_order_ids.json's
  // check should already prevent at the order level), keep whichever
  // side has the more recent createdAt, since that's the actual most
  // current truth about that locker.
  const merged = { ...(ours || {}) };
  for (const [key, value] of Object.entries(theirs || {})) {
    if (!(key in merged)) {
      merged[key] = value;
    } else if (value?.createdAt && merged[key]?.createdAt) {
      merged[key] = new Date(value.createdAt) > new Date(merged[key].createdAt) ? value : merged[key];
    }
    // else: keep "ours" as-is — no createdAt to compare, safest default
  }
  return merged;
}

function mergeOrderIdArray(ours, theirs) {
  return [...new Set([...(ours || []), ...(theirs || [])])];
}

function mergeInstantLockersUsed(ours, theirs) {
  // Structure: { [dateKey]: { [funId]: { [slotKey]: [roadId, ...] } } }
  const merged = JSON.parse(JSON.stringify(ours || {}));
  for (const [dateKey, byFun] of Object.entries(theirs || {})) {
    merged[dateKey] = merged[dateKey] || {};
    for (const [funId, bySlot] of Object.entries(byFun)) {
      merged[dateKey][funId] = merged[dateKey][funId] || {};
      for (const [slotKey, roadIds] of Object.entries(bySlot)) {
        const existing = merged[dateKey][funId][slotKey] || [];
        merged[dateKey][funId][slotKey] = [...new Set([...existing, ...roadIds])];
      }
    }
  }
  return merged;
}

function mergeFile(file) {
  const ours = readStage(file, 2);
  const theirs = readStage(file, 3);

  let merged;
  if (file.endsWith('active_lockers.json')) {
    merged = mergeActiveLockersOrSimilarObject(ours, theirs);
  } else if (file.endsWith('processed_order_ids.json')) {
    merged = mergeOrderIdArray(ours, theirs);
  } else if (file.endsWith('instant_lockers_used.json')) {
    merged = mergeInstantLockersUsed(ours, theirs);
  } else if (file.endsWith('latest.json')) {
    // Pure "last run" snapshot, fully overwritten by every run. During a
    // rebase, stage 3 = the commit being replayed = this run's result,
    // which is the newest, so it wins. Fall back to the other side only
    // if this run's version is missing/unparseable.
    merged = theirs ?? ours;
  } else {
    return false; // shouldn't happen given the caller's filter, but be safe
  }

  fs.writeFileSync(file, JSON.stringify(merged, null, 2) + '\n');
  execSync(`git add "${file}"`);
  console.log(`✅ Merged ${file} at the data level.`);
  return true;
}

function main() {
  const conflicted = getConflictedFiles();
  if (conflicted.length === 0) {
    console.log('No conflicted files found — nothing to do.');
    return;
  }

  console.log(`Conflicted files: ${conflicted.join(', ')}`);

  const unsafe = conflicted.filter((f) => !SAFELY_MERGEABLE.some((safe) => f.endsWith(safe)));
  if (unsafe.length > 0) {
    console.error(
      `❌ Cannot safely auto-merge: ${unsafe.join(', ')}\n` +
        `These files either contain non-additive data (like decrementing counters) or aren't\n` +
        `covered by this script's merge logic yet. Leaving the conflict for manual resolution\n` +
        `rather than guessing — see the header comment in resolve_tracking_conflict.js.`
    );
    process.exit(1);
  }

  for (const file of conflicted) {
    const ok = mergeFile(file);
    if (!ok) {
      console.error(`❌ Don't know how to merge ${file} — aborting.`);
      process.exit(1);
    }
  }

  console.log('✅ All conflicted files merged at the data level. Continuing rebase...');
}

main();
