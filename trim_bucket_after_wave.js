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
