/**
 * trim_bucket_after_wave.js
 *
 * After running generate_pickup_code.js on a bucket file, removes only
 * the orders that SUCCEEDED from that bucket — any that failed (most
 * likely "no lockers available yet") stay in the file for a later wave
 * to retry, since by then some slot-1 no-shows may have been detected
 * and freed via the normal cleanStaleTrackerEntries check.
 *
 * With --final, instead of leaving failures for a future wave (there
 * isn't one), moves them to advance_queue/needs_manual_attention/ and
 * emails an alert — these genuinely couldn't be fulfilled today given
 * current locker availability.
 *
 * Usage:
 *   node trim_bucket_after_wave.js <bucketFile> <nodeOutputLogFile> [--final]
 */

const fs = require('fs');
const path = require('path');

function parseSucceededIds(logFile) {
  const log = fs.readFileSync(logFile, 'utf8');
  const succeeded = new Set();
  for (const line of log.split('\n')) {
    if (!line.startsWith('OUTPUT_JSON:')) continue;
    try {
      const data = JSON.parse(line.slice('OUTPUT_JSON:'.length));
      if (data.success && data.orderId) succeeded.add(data.orderId);
    } catch {
      // ignore malformed lines
    }
  }
  return succeeded;
}

// Finds every order that succeeded but had to use a DIFFERENT locker
// than the one assigned the night before — see the fallback added to
// generate_pickup_code.js's useAssignedLocker() call. The order itself
// is fine (customer got a real code), but the ORIGINAL locker is
// presumably stuck on something and needs a human to go check XZY's
// dashboard and cancel whatever's sitting on it — otherwise the next
// order assigned there hits the same problem.
function parseSubstitutions(logFile) {
  const log = fs.readFileSync(logFile, 'utf8');
  const substitutions = [];
  for (const line of log.split('\n')) {
    if (!line.startsWith('OUTPUT_JSON:')) continue;
    try {
      const data = JSON.parse(line.slice('OUTPUT_JSON:'.length));
      if (data.success && data.substituted) substitutions.push(data);
    } catch {
      // ignore malformed lines
    }
  }
  return substitutions;
}

async function sendManualAttentionAlert(remaining) {
  const gmailUser = process.env.GMAIL_USER || 'covamarketplace@gmail.com';
  const gmailPassword = process.env.GMAIL_PASSWORD || '';
  const toEmail = process.env.ADMIN_ALERT_EMAIL || gmailUser;

  if (!gmailPassword) {
    console.error('⚠️  Cannot send alert — GMAIL_PASSWORD not set.');
    return;
  }

  const lines = remaining.map(
    (o) => `- ${o.order_id} | ${o.customer_name} <${o.email}> | ${o.order_location} | ${o.pickup_date} ${o.pickup_time}`
  );

  const message = [
    `${remaining.length} Advance Pickup order(s) could NOT be fulfilled today — `,
    `no locker became available even after the final release attempt.`,
    '',
    ...lines,
    '',
    'These customers have NOT received a pickup code. Please handle manually — ',
    'either find a locker for them today, or contact them about rescheduling.',
  ].join('\n');

  const mime = [
    `From: CovaMarket Alerts <${gmailUser}>`,
    `To: ${toEmail}`,
    `Subject: 🚨 CovaMarket: ${remaining.length} order(s) could not be fulfilled today`,
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
        console.error('Alert email failed:', err.message);
        socket.end();
        resolve();
      }
    });
    socket.on('error', (err) => {
      console.error('Alert email connection failed:', err.message);
      resolve();
    });
  });
}

async function sendSubstitutionAlert(substitutions) {
  const gmailUser = process.env.GMAIL_USER || 'covamarketplace@gmail.com';
  const gmailPassword = process.env.GMAIL_PASSWORD || '';
  const toEmail = process.env.ADMIN_ALERT_EMAIL || gmailUser;

  if (!gmailPassword) {
    console.error('⚠️  Cannot send substitution alert — GMAIL_PASSWORD not set.');
    return;
  }

  const lines = substitutions.map(
    (s) =>
      `- Order ${s.orderId} | ${s.customerName} <${s.customerEmail}> | ${s.orderLocation}\n` +
      `    Planned locker: ${s.originalAssignedLocker}  →  Actually used: ${s.locker}\n` +
      `    Reason: ${s.substitutionReason}`
  );

  const message = [
    `${substitutions.length} order(s) succeeded today, but their PLANNED locker was unavailable`,
    `and a different one was automatically substituted instead.`,
    '',
    `The customer(s) below already received a working pickup code — no action needed`,
    `for them. But please check XZY's dashboard for whatever is stuck on the ORIGINAL`,
    `locker(s) listed and cancel it if appropriate, so it doesn't keep blocking future`,
    `orders assigned there.`,
    '',
    ...lines,
  ].join('\n');

  const mime = [
    `From: CovaMarket Alerts <${gmailUser}>`,
    `To: ${toEmail}`,
    `Subject: ⚠️ CovaMarket: ${substitutions.length} order(s) needed a locker substitution`,
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
        console.error('Substitution alert email failed:', err.message);
        socket.end();
        resolve();
      }
    });
    socket.on('error', (err) => {
      console.error('Substitution alert connection failed:', err.message);
      resolve();
    });
  });
}

async function main() {
  const bucketFile = process.argv[2];
  const logFile = process.argv[3];
  const isFinal = process.argv.includes('--final');

  if (!bucketFile || !logFile) {
    console.error('Usage: node trim_bucket_after_wave.js <bucketFile> <nodeOutputLogFile> [--final]');
    process.exit(1);
  }

  if (!fs.existsSync(bucketFile)) {
    console.log('Bucket file no longer exists — nothing to trim.');
    return;
  }

  const succeededIds = parseSucceededIds(logFile);
  const bucket = JSON.parse(fs.readFileSync(bucketFile, 'utf8'));
  const remaining = bucket.filter((o) => !succeededIds.has(o.order_id));

  console.log(`Trim: ${bucket.length} total, ${succeededIds.size} succeeded, ${remaining.length} still unresolved`);

  // Substitutions matter regardless of wave/final status — a succeeded
  // order with a swapped locker needs staff attention on the SAME day,
  // not just at end-of-day cleanup.
  const substitutions = parseSubstitutions(logFile);
  if (substitutions.length > 0) {
    console.warn(`⚠️  ${substitutions.length} order(s) needed a locker substitution this wave — sending alert.`);
    await sendSubstitutionAlert(substitutions);
  }

  if (remaining.length === 0) {
    fs.unlinkSync(bucketFile);
    console.log('✅ All orders resolved — bucket file removed.');
    return;
  }

  if (!isFinal) {
    fs.writeFileSync(bucketFile, JSON.stringify(remaining, null, 2));
    console.log(`⏳ ${remaining.length} order(s) still waiting — kept for the next wave.`);
    return;
  }

  // Final wave and still unresolved — flag for manual attention.
  const attentionDir = path.join(path.dirname(bucketFile), 'needs_manual_attention');
  fs.mkdirSync(attentionDir, { recursive: true });
  const dest = path.join(attentionDir, path.basename(bucketFile));
  fs.writeFileSync(dest, JSON.stringify(remaining, null, 2));
  fs.unlinkSync(bucketFile);

  console.error(`🚨 ${remaining.length} order(s) could NOT be fulfilled after the final wave — moved to ${dest}`);
  await sendManualAttentionAlert(remaining);
}

main();
