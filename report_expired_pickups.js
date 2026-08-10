/**
 * report_expired_pickups.js
 *
 * Scheduled to run ~9:30 PM MYT daily. Finds any tracked locker whose
 * pickup_date has passed and is STILL Pending (a no-show), and emails a
 * checklist so staff can handle it manually: physically clear the item,
 * then click Cancel on the XZY dashboard.
 *
 * DELIBERATELY does NOT auto-cancel — that would need the JWT-based
 * internal API, which can fail silently if the token expires. This
 * script only uses the public appId+key API (XZY_APP_ID/XZY_SECRET_KEY),
 * which never expires and needs no login — safe to run unattended.
 *
 * Manual step required after this email arrives: for each listed code,
 * go to xzyvend.com -> Pick up code management, find it, click Cancel.
 * Physically clear the leftover item from that locker at the same time.
 */

const fs = require('fs');
const path = require('path');
const { findPick, getFunByDept } = require('./xzyvend');

const TRACKING_FILE = path.join(__dirname, 'pickup_codes', 'active_lockers.json');

// GitHub Actions runs in UTC. At 21:30 MYT (=13:30 UTC), the calendar date
// is already the same in both zones, so a plain UTC date comparison here
// is safe (confirmed by testing before writing this).
function isPastDue(pickupDateStr) {
  if (!pickupDateStr) return false;
  const pickupDate = new Date(pickupDateStr);
  if (isNaN(pickupDate.getTime())) return false;

  const today = new Date();
  const todayUTC = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const pickupUTC = Date.UTC(pickupDate.getUTCFullYear(), pickupDate.getUTCMonth(), pickupDate.getUTCDate());

  return pickupUTC <= todayUTC;
}

let funNumberCache = null;
async function getFunNumber(funId) {
  if (!funNumberCache) {
    const res = await getFunByDept(1, 100);
    const list = res?.data?.records || res?.data?.list || res?.data || [];
    funNumberCache = {};
    for (const d of list) funNumberCache[d.funId] = d.funNumber;
  }
  return funNumberCache[funId];
}

const LOCATION_NAMES = { 715: 'LRT Sentul Timur', 716: 'LRT Lembah Subang' };

async function sendReportEmail(items) {
  const gmailUser = process.env.GMAIL_USER || 'covamarketplace@gmail.com';
  const gmailPassword = process.env.GMAIL_PASSWORD || '';
  const toEmail = process.env.ADMIN_ALERT_EMAIL || gmailUser;

  if (!gmailPassword) {
    console.error('⚠️  Cannot send report — GMAIL_PASSWORD not set.');
    console.log(items);
    return;
  }

  const lines = items.map(
    (i) =>
      `- ${LOCATION_NAMES[i.funId] || i.funId} | Locker ${i.locker} | Code ${i.pickCode} | Was due ${i.pickupDate}`
  );

  const message = [
    `The following ${items.length} pickup(s) are past due and were never collected:`,
    '',
    ...lines,
    '',
    'For each one:',
    '  1. Physically remove the leftover item from the locker',
    '  2. Go to xzyvend.com -> Pick up code management, find the code, click Cancel',
    '',
    'This frees the locker for tomorrow. Codes left un-cancelled will still ' +
      'technically work if someone enters them, so please action these before end of day.',
  ].join('\n');

  const mime = [
    `From: CovaMarket Alerts <${gmailUser}>`,
    `To: ${toEmail}`,
    `Subject: 📋 CovaMarket: ${items.length} expired pickup(s) need manual cancellation`,
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
        if (step === 0) {
          socket.write(`EHLO gmail.com\r\n`);
          step = 1;
        } else if (step === 1 && line.includes('250')) {
          socket.write(`AUTH LOGIN\r\n`);
          step = 2;
        } else if (step === 2) {
          socket.write(b64(gmailUser) + '\r\n');
          step = 3;
        } else if (step === 3) {
          socket.write(b64(gmailPassword) + '\r\n');
          step = 4;
        } else if (step === 4) {
          socket.write(`MAIL FROM:<${gmailUser}>\r\n`);
          step = 5;
        } else if (step === 5) {
          socket.write(`RCPT TO:<${toEmail}>\r\n`);
          step = 6;
        } else if (step === 6) {
          socket.write(`DATA\r\n`);
          step = 7;
        } else if (step === 7) {
          socket.write(mime + '\r\n.\r\n');
          step = 8;
        } else if (step === 8) {
          socket.write(`QUIT\r\n`);
          socket.end();
          resolve();
        }
      } catch (err) {
        console.error('Report email failed:', err.message);
        socket.end();
        resolve();
      }
    });
    socket.on('error', (err) => {
      console.error('Report email connection failed:', err.message);
      resolve();
    });
  });
}

async function main() {
  if (!fs.existsSync(TRACKING_FILE)) {
    console.log('No active_lockers.json found — nothing to check.');
    return;
  }

  const activeLockers = JSON.parse(fs.readFileSync(TRACKING_FILE, 'utf8'));
  const entries = Object.entries(activeLockers);

  console.log(`Checking ${entries.length} tracked locker(s) for past-due pickups...\n`);

  const expiredItems = [];

  for (const [roadId, entry] of entries) {
    if (!isPastDue(entry.pickupDate)) continue;

    const funNumber = await getFunNumber(entry.funId);
    if (!funNumber) {
      console.warn(`⚠️  Could not resolve funNumber for funId ${entry.funId}, skipping roadId=${roadId}`);
      continue;
    }

    try {
      const status = await findPick(funNumber, entry.pickCode);
      if (status?.pickStatus === 0) {
        console.log(`⏰ Locker ${entry.locker} (code ${entry.pickCode}) — past due (${entry.pickupDate}), still pending`);
        expiredItems.push({ ...entry, roadId });
      }
      // else: already collected/failed/voided — not our concern here,
      // existing order-processing cleanup handles those.
    } catch (err) {
      if (err.message.includes('未查询到取货码信息')) {
        console.log(`✓ Locker ${entry.locker} — already collected, no action needed`);
      } else {
        console.warn(`⚠️  Could not check pickCode ${entry.pickCode}: ${err.message}`);
      }
    }
  }

  console.log(`\n${'='.repeat(40)}`);
  console.log(`Found ${expiredItems.length} expired pending pickup(s).`);

  if (expiredItems.length > 0) {
    await sendReportEmail(expiredItems);
    console.log('📧 Report emailed.');
  } else {
    console.log('Nothing to report tonight.');
  }
}

main().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
