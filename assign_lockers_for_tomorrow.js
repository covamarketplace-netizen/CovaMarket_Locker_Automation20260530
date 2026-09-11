/**
 * assign_lockers_for_tomorrow.js
 *
 * Runs at 9:30 PM MYT, right after the advance-booking cutoff. For every
 * order already accumulated in tomorrow's slot1/slot2 buckets, assigns a
 * SPECIFIC locker number — writes it into the order record itself (so
 * the actual release at 7AM/12:20PM targets that exact locker, rather
 * than picking whichever happens to be free) — and emails the complete
 * plan for the day.
 *
 * Assignment is sequential per slot, independently: slot 1's orders get
 * channels 1-1, 1-2, 2-1... in order; slot 2's orders get the SAME
 * sequence, starting over from 1-1, since a slot 2 order may end up
 * reusing whatever a slot 1 order frees up later that morning.
 *
 * This does NOT generate any pickup code — purely a plan. The actual
 * code only gets created at release time, and only succeeds if the
 * assigned locker is genuinely free at that moment.
 *
 * GUARDS AGAINST BAD TRIGGERS (two separate problems, two separate checks):
 *
 * 1. TOO EARLY — this job must only run AFTER the 9 PM advance-booking
 *    cutoff. If something fires it before then (a leftover GitHub cron
 *    drifting into the wrong day, a misconfigured AWS schedule, clock
 *    skew, a stray manual trigger), it would lock in a plan against an
 *    INCOMPLETE order list — orders placed later that evening would be
 *    silently skipped. This is a correctness bug, not just a duplicate
 *    email. So: if current MYT time is before CUTOFF_HOUR_MYT, the job
 *    exits immediately without touching any data, without emailing,
 *    and WITHOUT writing the "already sent" marker below.
 *
 * 2. TOO OFTEN — once it's past cutoff, the job should still only
 *    actually run once per target date. A marker file under
 *    pickup_codes/ records the dateKey once the plan has been
 *    successfully assigned + emailed. Any subsequent run for that same
 *    dateKey (a duplicate trigger later the same night) short-circuits
 *    before re-assigning lockers or sending another email.
 *
 * Critically, the marker is ONLY written by a run that both passed the
 * cutoff check AND completed successfully — a too-early run never
 * writes it, so it can never block the real run from happening later
 * that same night. Delete the marker file manually if you ever need to
 * force a legitimate re-run for a date that's already marked done.
 */

const fs = require('fs');
const path = require('path');
const { getRoodById, getGoodsById } = require('./xzyvend');
const { nowInMYT, formatDateForBucket } = require('./date_utils');

const QUEUE_DIR = path.join(__dirname, 'advance_queue');
const LOCATIONS = { 715: 'LRT Sentul Timur', 716: 'LRT Lembah Subang' };
const LABEL_SOURCE_BY_FUN_ID = { 715: 'roadRowColumn', 716: 'goodsName' };

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
    } while (items.length === 100 && page <= 5);
  }
  return goodsNameCache[goodsId] || `Locker (goodsId ${goodsId})`;
}

async function resolveLabel(funId, channel) {
  if (LABEL_SOURCE_BY_FUN_ID[funId] === 'roadRowColumn') {
    return `${channel.roadRow}-${channel.roadColumn}`;
  }
  return getGoodsName(channel.goodsId);
}

function loadBucket(file) {
  if (!fs.existsSync(file)) return [];
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
}

function saveBucket(file, orders) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(orders, null, 2));
}

// Assigns channels[0], channels[1], ... to orders in order. If there are
// more orders than channels (shouldn't happen — capped at 14 by
// accumulate_advance_orders.js), extras are left unassigned and flagged.
async function assignSequentially(funId, orders, channels) {
  const labels = [];
  for (const ch of channels) labels.push(await resolveLabel(funId, ch));

  const planLines = [];
  for (let i = 0; i < orders.length; i++) {
    if (i >= channels.length) {
      orders[i].assignedRoadId = null;
      orders[i].assignedLocker = null;
      planLines.push(`  ⚠️  ${orders[i].order_id}: NO LOCKER LEFT TO ASSIGN (more orders than lockers — should not happen)`);
      continue;
    }
    const ch = channels[i];
    orders[i].assignedRoadId = ch.roadId;
    orders[i].assignedGoodsId = ch.goodsId;
    orders[i].assignedRoadRow = ch.roadRow;
    orders[i].assignedRoadColumn = ch.roadColumn;
    orders[i].assignedLocker = labels[i];
  }
  return orders;
}

function formatOrderLine(slotLabel, order) {
  return (
    `${slotLabel} | Order ${order.order_id} | ${order.pickup_time} | ${order.pickup_date} | ` +
    `Locker: ${order.assignedLocker || 'UNASSIGNED'} | ${order.order_location} | ` +
    `${order.customer_name} <${order.email}>`
  );
}

async function sendPlanEmail(dateKey, planLines) {
  const gmailUser = process.env.GMAIL_USER || 'covamarketplace@gmail.com';
  const gmailPassword = process.env.GMAIL_PASSWORD || '';
  const toEmail = process.env.ADMIN_ALERT_EMAIL || gmailUser;

  const message = [`Locker assignment plan for ${dateKey}:`, '', ...planLines].join('\n');

  if (!gmailPassword) {
    console.error('⚠️  Cannot send plan email — GMAIL_PASSWORD not set.');
    console.log(message);
    return;
  }

  const mime = [
    `From: CovaMarket Alerts <${gmailUser}>`,
    `To: ${toEmail}`,
    `Subject: 📅 CovaMarket: Locker plan for ${dateKey}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=UTF-8`,
    ``,
    message,
  ].join('\r\n');

  return new Promise((resolve) => {
    const socket = require('tls').connect({ host: 'smtp.gmail.com', port: 465 }, () => {});
    let step = 0;
    const b64 = (s) => Buffer.from(s).toString('base64');
    socket.on('data', (data) => {
      const line = data.toString();
      try {
        if (step === 0) { socket.write(`EHLO gmail.com\r\n`); step = 1; }
        else if (step === 1 && line.includes('250')) { socket.write(`AUTH LOGIN\r\n`); step = 2; }
        else if (step === 2) { socket.write(b64(gmailUser) + '\r\n'); step = 3; }
        else if (step === 3) { socket.write(b64(gmailPassword) + '\r\n'); step = 4; }
        else if (step === 4) { socket.write(`MAIL FROM:<${gmailUser}>\r\n`); step = 5; }
        else if (step === 5) { socket.write(`RCPT TO:<${toEmail}>\r\n`); step = 6; }
        else if (step === 6) { socket.write(`DATA\r\n`); step = 7; }
        else if (step === 7) { socket.write(mime + '\r\n.\r\n'); step = 8; }
        else if (step === 8) { socket.write(`QUIT\r\n`); socket.end(); resolve(); }
      } catch (err) {
        console.error('Plan email failed:', err.message);
        socket.end();
        resolve();
      }
    });
    socket.on('error', (err) => {
      console.error('Plan email connection failed:', err.message);
      resolve();
    });
  });
}

const TOTAL_SLOTS = 3;

// Earliest MYT hour (24h clock) this job is allowed to do real work.
// Must be AT or AFTER the advance-booking cutoff (9 PM MYT). Anything
// that fires before this is treated as premature and is a strict no-op —
// it must NOT write the "already sent" marker, since the real run for
// that same date still needs to happen later tonight.
const CUTOFF_HOUR_MYT = 21;

async function main() {
  const nowMYT = nowInMYT();
  const tomorrowMYT = new Date(nowMYT.getTime() + 24 * 60 * 60 * 1000);
  const dateKey = formatDateForBucket(tomorrowMYT);

  // ── Guard 1: too early ───────────────────────────────────────────────
  // NOTE: nowInMYT() is Date.now() + 8h with NO timezone re-interpretation
  // — per date_utils.js convention, you must read it back with UTC
  // getters (getUTCHours, not getHours) to get the correct MYT wall-clock
  // value regardless of the runner's own local timezone.
  if (nowMYT.getUTCHours() < CUTOFF_HOUR_MYT) {
    console.log(
      `⏭️  It's ${nowMYT.toISOString()} (MYT hour ${nowMYT.getUTCHours()}) — before the ` +
      `${CUTOFF_HOUR_MYT}:00 MYT advance-booking cutoff. Refusing to assign lockers for ` +
      `${dateKey} yet, since today's advance orders are still coming in. This run is a ` +
      `no-op — no data touched, no email sent, no marker written. The real run should ` +
      `still fire later tonight after cutoff.`
    );
    return;
  }

  // ── Guard 2: too often ───────────────────────────────────────────────
  // If this dateKey's plan was already assigned + emailed successfully
  // by a run that passed Guard 1, bail out. Protects against duplicate
  // triggers after cutoff (AWS EventBridge firing more than once, a
  // retried webhook, a leftover GitHub cron still enabled alongside AWS,
  // etc.) without needing to find and fix every possible external cause.
  const markerDir = path.join(__dirname, 'pickup_codes');
  const sentMarkerFile = path.join(markerDir, `.plan_sent_${dateKey}`);
  if (fs.existsSync(sentMarkerFile)) {
    const sentAt = fs.readFileSync(sentMarkerFile, 'utf8').trim();
    console.log(`⏭️  Plan for ${dateKey} was already sent at ${sentAt} — skipping duplicate run.`);
    console.log(`   (Delete ${sentMarkerFile} manually if you need to force a legitimate re-run.)`);
    return;
  }

  console.log(`\n📋 Assigning lockers for ${dateKey}...\n`);

  // Load all 3 slot buckets generically.
  const slotFiles = {};
  const slotOrdersAll = {};
  for (let s = 1; s <= TOTAL_SLOTS; s++) {
    slotFiles[s] = path.join(QUEUE_DIR, `order_details_${dateKey}_slot${s}.json`);
    slotOrdersAll[s] = loadBucket(slotFiles[s]);
  }

  const allPlanLines = [];
  // Fixed instant-eligible locker list, per location per slot — this is
  // the authoritative set consumeInstantCapacity/findLockerForOrder must
  // draw from. An advance locker that frees up early during a slot does
  // NOT get added to this — staff need a stable, known set to pre-stock
  // against, not one that silently grows through the day.
  const instantEligible = {};

  for (const [funIdStr, locationName] of Object.entries(LOCATIONS)) {
    const funId = Number(funIdStr);
    instantEligible[funId] = {};
    for (let s = 1; s <= TOTAL_SLOTS; s++) instantEligible[funId][`slot${s}`] = [];

    let channels = [];
    try {
      channels = await getRoodById(funId);
    } catch (err) {
      console.error(`❌ Could not fetch channels for ${locationName}: ${err.message}`);
      continue;
    }

    const slotOrdersForLocation = {};
    for (let s = 1; s <= TOTAL_SLOTS; s++) {
      slotOrdersForLocation[s] = slotOrdersAll[s].filter((o) => o.order_location === locationName);
      await assignSequentially(funId, slotOrdersForLocation[s], channels);
    }

    console.log(
      `${locationName}: ` +
        Array.from({ length: TOTAL_SLOTS }, (_, i) => `${slotOrdersForLocation[i + 1].length} slot${i + 1}`).join(', ') +
        ' assigned'
    );

    for (let s = 1; s <= TOTAL_SLOTS; s++) {
      for (const o of slotOrdersForLocation[s]) allPlanLines.push(formatOrderLine(`Slot ${s}`, o));
    }

    // Leftover channels per slot — computed independently, since each
    // slot gets its own full assignment sequence and may reuse the same
    // physical locker numbers later in the day.
    for (let s = 1; s <= TOTAL_SLOTS; s++) {
      const slotKey = `slot${s}`;
      const slotOrders = slotOrdersForLocation[s];
      const usedCount = Math.min(slotOrders.length, channels.length);
      const leftover = channels.slice(usedCount);
      instantEligible[funId][slotKey] = leftover.map((ch) => ch.roadId);
      if (leftover.length === 0) continue;

      allPlanLines.push(`Slot ${s} | ${locationName} | AVAILABLE FOR INSTANT PICKUP (${leftover.length}):`);
      for (const ch of leftover) {
        const label = await resolveLabel(funId, ch);
        allPlanLines.push(`  Locker ${label} (roadId ${ch.roadId})`);
      }
    }
  }

  // Save the fixed eligible-locker list for today, so generate_pickup_code.js
  // can restrict Instant Pickup selection to exactly this set.
  const eligibleFile = path.join(__dirname, 'pickup_codes', 'instant_eligible_lockers.json');
  let eligibleData = {};
  if (fs.existsSync(eligibleFile)) {
    try {
      eligibleData = JSON.parse(fs.readFileSync(eligibleFile, 'utf8'));
    } catch {
      eligibleData = {};
    }
  }
  eligibleData[dateKey] = instantEligible;
  fs.mkdirSync(path.dirname(eligibleFile), { recursive: true });
  fs.writeFileSync(eligibleFile, JSON.stringify(eligibleData, null, 2));
  console.log(`✅ Saved instant-eligible locker list to ${eligibleFile}`);

  // assignSequentially mutates the order objects it's given in-place.
  // Since filter() returns new arrays but keeps the SAME object
  // references, those mutations are already reflected in the original
  // slotOrdersAll arrays — no merge-back step needed.
  for (let s = 1; s <= TOTAL_SLOTS; s++) {
    saveBucket(slotFiles[s], slotOrdersAll[s]);
  }

  console.log(`\n✅ Saved assignments to ${Object.values(slotFiles).join(', ')}`);

  if (allPlanLines.length === 0) {
    console.log('No orders for tomorrow — nothing to email.');
    // Still mark as sent — an empty day is a completed run, not a
    // reason to let a duplicate trigger re-process it.
    fs.mkdirSync(markerDir, { recursive: true });
    fs.writeFileSync(sentMarkerFile, new Date().toISOString());
    return;
  }

  console.log('\n' + allPlanLines.join('\n'));
  await sendPlanEmail(dateKey, allPlanLines);
  console.log('\n📧 Locker plan emailed.');

  // Mark this dateKey as done — must happen only after a successful
  // email send, so a genuine failure (e.g. SMTP error) still allows a
  // legitimate retry rather than silently swallowing the plan.
  fs.mkdirSync(markerDir, { recursive: true });
  fs.writeFileSync(sentMarkerFile, new Date().toISOString());
}

main().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
