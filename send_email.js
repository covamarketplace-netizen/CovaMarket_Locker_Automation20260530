/**
 * send_email.js
 *
 * Sends pickup code notification email to customer via Gmail SMTP.
 * Called by GitHub Actions after generate_pickup_code.js succeeds.
 *
 * Usage:
 *   node send_email.js
 *
 * Environment variables:
 *   GMAIL_USER      — covamarketplace@gmail.com
 *   GMAIL_PASSWORD  — app password (dhur ziap nnko dgsl)
 *   TO_EMAIL        — customer email address
 *   CUSTOMER_NAME   — customer name
 *   ORDER_ID        — Shopify order ID / name
 *   PICK_CODE       — 6-digit pickup code
 *   LOCKER          — locker label e.g. "2-1"
 *   PICKUP_LOCATION — location name
 *   PICKUP_DATE     — due date string
 *   PICKUP_TIME     — due time string
 */

const https = require('https');
const tls   = require('tls');
const net   = require('net');

const CONFIG = {
  gmailUser:     process.env.GMAIL_USER       || 'covamarketplace@gmail.com',
  gmailPassword: process.env.GMAIL_PASSWORD   || '',
  toEmail:       process.env.TO_EMAIL         || '',
  customerName:  process.env.CUSTOMER_NAME    || 'Customer',
  orderId:       process.env.ORDER_ID         || 'N/A',
  pickCode:      process.env.PICK_CODE        || '',
  locker:        process.env.LOCKER           || '',
  pickupLocation:process.env.PICKUP_LOCATION  || 'CovaMarket Locker',
  pickupDate:    process.env.PICKUP_DATE      || 'N/A',
  pickupTime:    process.env.PICKUP_TIME      || 'N/A',
};

// ── Build email HTML ──────────────────────────────────────────────────────────
function buildEmail() {
  const subject = `Your CovaMarket Order is Ready for Pickup! 🎉 (${CONFIG.orderId})`;

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  body { font-family: Arial, sans-serif; background: #f4f4f4; margin: 0; padding: 0; }
  .container { max-width: 600px; margin: 30px auto; background: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
  .header { background: #1a1a2e; padding: 30px 40px; text-align: center; }
  .header h1 { color: #ffffff; margin: 0; font-size: 24px; }
  .header p { color: #aaa; margin: 6px 0 0; font-size: 14px; }
  .body { padding: 32px 40px; }
  .greeting { font-size: 16px; color: #333; margin-bottom: 24px; }
  .section-title { font-size: 13px; font-weight: bold; color: #888; text-transform: uppercase; letter-spacing: 0.08em; margin: 24px 0 8px; }
  .info-row { display: flex; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid #f0f0f0; font-size: 15px; }
  .info-label { color: #888; }
  .info-value { color: #222; font-weight: 500; text-align: right; }
  .code-box { background: #1a1a2e; border-radius: 10px; padding: 24px; text-align: center; margin: 28px 0; }
  .code-label { color: #aaa; font-size: 13px; margin-bottom: 10px; text-transform: uppercase; letter-spacing: 0.1em; }
  .code-value { color: #ffffff; font-size: 42px; font-weight: bold; letter-spacing: 0.18em; font-family: 'Courier New', monospace; }
  .locker-badge { display: inline-block; background: #e8f4fd; color: #1565c0; border-radius: 6px; padding: 4px 14px; font-size: 14px; font-weight: 600; margin-top: 10px; }
  .notes { background: #fffbe6; border-left: 4px solid #f5c400; border-radius: 4px; padding: 14px 18px; margin: 24px 0; font-size: 14px; color: #555; }
  .notes ul { margin: 8px 0 0; padding-left: 18px; }
  .notes li { margin-bottom: 6px; }
  .footer { background: #f8f8f8; padding: 20px 40px; text-align: center; font-size: 13px; color: #aaa; border-top: 1px solid #eee; }
  .footer a { color: #888; text-decoration: none; }
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <h1>CovaMarket 🛍️</h1>
    <p>Your order is ready for pickup!</p>
  </div>
  <div class="body">
    <p class="greeting">Hi <strong>${escHtml(CONFIG.customerName)}</strong>,</p>
    <p style="color:#444; font-size:15px; line-height:1.6;">
      Great news — your order is ready and waiting for you! 🎉<br>
      Here are the details you need for a smooth pickup.
    </p>

    <div class="section-title">📍 Pickup Location</div>
    <div class="info-row">
      <span class="info-label">Location</span>
      <span class="info-value">${escHtml(CONFIG.pickupLocation)}</span>
    </div>
    <div class="info-row">
      <span class="info-label">Pickup Date</span>
      <span class="info-value">${escHtml(CONFIG.pickupDate)}</span>
    </div>
    <div class="info-row">
      <span class="info-label">Pickup Time</span>
      <span class="info-value">${escHtml(CONFIG.pickupTime)}</span>
    </div>
    <div class="info-row">
      <span class="info-label">Order</span>
      <span class="info-value">${escHtml(CONFIG.orderId)}</span>
    </div>

    <div class="section-title">🔐 Your Pickup Code</div>
    <div class="code-box">
      <div class="code-label">Present this code to collect your order</div>
      <div class="code-value">${escHtml(CONFIG.pickCode)}</div>
      <div style="margin-top:12px;">
        <span class="locker-badge">Locker ${escHtml(CONFIG.locker)}</span>
      </div>
    </div>

    <div class="notes">
      <strong>📌 Things to Note:</strong>
      <ul>
        <li>This code is unique to your order — please do not share it.</li>
        <li>Please collect your order by <strong>${escHtml(CONFIG.pickupDate)}</strong>.</li>
        <li>Someone else may collect on your behalf — they will need this code.</li>
      </ul>
    </div>

    <p style="color:#444; font-size:14px; line-height:1.6;">
      If you have any questions, reach out to us at
      <a href="mailto:covamarketplace@gmail.com" style="color:#1565c0;">covamarketplace@gmail.com</a>.
    </p>

    <p style="color:#444; font-size:14px;">
      Thank you for shopping with us on <strong>CovaMarket</strong>! 🙏
    </p>
  </div>
  <div class="footer">
    <p>© 2026 CovaMarket &nbsp;|&nbsp; <a href="mailto:covamarketplace@gmail.com">covamarketplace@gmail.com</a></p>
    <p style="margin-top:4px; font-size:11px;">This is an automated message — please do not reply directly to this email.</p>
  </div>
</div>
</body>
</html>`;

  const text = `Hi ${CONFIG.customerName},

Your CovaMarket order (${CONFIG.orderId}) is ready for pickup!

PICKUP LOCATION : ${CONFIG.pickupLocation}
PICKUP DATE     : ${CONFIG.pickupDate}
PICKUP TIME     : ${CONFIG.pickupTime}

YOUR PICKUP CODE: ${CONFIG.pickCode}
LOCKER          : ${CONFIG.locker}

Please present this code to collect your order.
Do not share this code with anyone.

Questions? Email us: covamarketplace@gmail.com

Thank you for shopping with CovaMarket!`;

  return { subject, html, text };
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── SMTP over TLS (port 465) ──────────────────────────────────────────────────
function base64(str) {
  return Buffer.from(str).toString('base64');
}

function buildMimeMessage({ subject, html, text }) {
  const boundary = `----=_Part_${Date.now()}`;
  const from     = `CovaMarket <${CONFIG.gmailUser}>`;
  const to       = CONFIG.toEmail;

  const mime = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    ``,
    `--${boundary}`,
    `Content-Type: text/plain; charset=UTF-8`,
    `Content-Transfer-Encoding: quoted-printable`,
    ``,
    text,
    ``,
    `--${boundary}`,
    `Content-Type: text/html; charset=UTF-8`,
    `Content-Transfer-Encoding: quoted-printable`,
    ``,
    html,
    ``,
    `--${boundary}--`,
  ].join('\r\n');

  return mime;
}

function smtpConversation(socket, mime) {
  return new Promise((resolve, reject) => {
    const lines = [];
    let step = 0;

    const send = (cmd) => {
      console.log(`  → ${cmd.split('\r\n')[0]}`);
      socket.write(cmd + '\r\n');
    };

    const expect = (code, data) => {
      const line = data.toString().trim();
      console.log(`  ← ${line.substring(0, 80)}`);
      lines.push(line);
      return line.startsWith(String(code));
    };

    socket.on('data', (data) => {
      try {
        const line = data.toString().trim();

        if (step === 0) {
          // Server greeting
          if (!expect(220, data)) throw new Error(`Expected 220, got: ${line}`);
          send(`EHLO gmail.com`);
          step = 1;
        } else if (step === 1) {
          if (!line.includes('250')) throw new Error(`EHLO failed: ${line}`);
          if (line.startsWith('250 ') || line.includes('250-SIZE') && data.toString().includes('250 ')) {
            // All EHLO lines received — but we may get them in one chunk
            send(`AUTH LOGIN`);
            step = 2;
          }
        } else if (step === 2) {
          if (!expect(334, data)) throw new Error(`AUTH LOGIN failed: ${line}`);
          send(base64(CONFIG.gmailUser));
          step = 3;
        } else if (step === 3) {
          if (!expect(334, data)) throw new Error(`Username rejected: ${line}`);
          send(base64(CONFIG.gmailPassword));
          step = 4;
        } else if (step === 4) {
          if (!expect(235, data)) throw new Error(`Auth failed: ${line}`);
          send(`MAIL FROM:<${CONFIG.gmailUser}>`);
          step = 5;
        } else if (step === 5) {
          if (!expect(250, data)) throw new Error(`MAIL FROM rejected: ${line}`);
          send(`RCPT TO:<${CONFIG.toEmail}>`);
          step = 6;
        } else if (step === 6) {
          if (!expect(250, data)) throw new Error(`RCPT TO rejected: ${line}`);
          send(`DATA`);
          step = 7;
        } else if (step === 7) {
          if (!expect(354, data)) throw new Error(`DATA command failed: ${line}`);
          socket.write(mime + '\r\n.\r\n');
          step = 8;
        } else if (step === 8) {
          if (!expect(250, data)) throw new Error(`Message send failed: ${line}`);
          send(`QUIT`);
          step = 9;
        } else if (step === 9) {
          socket.destroy();
          resolve('Email sent successfully!');
        }
      } catch (err) {
        socket.destroy();
        reject(err);
      }
    });

    socket.on('error', reject);
    socket.on('close', () => {
      if (step < 9) reject(new Error(`Connection closed at step ${step}`));
    });
  });
}

async function sendEmail() {
  if (!CONFIG.gmailPassword) throw new Error('GMAIL_PASSWORD not set');
  if (!CONFIG.toEmail)       throw new Error('TO_EMAIL not set');
  if (!CONFIG.pickCode)      throw new Error('PICK_CODE not set');

  const { subject, html, text } = buildEmail();
  const mime = buildMimeMessage({ subject, html, text });

  console.log(`📧 Sending email to: ${CONFIG.toEmail}`);
  console.log(`   Subject: ${subject}`);

  // Connect via SSL on port 465
  const socket = tls.connect({
    host: 'smtp.gmail.com',
    port: 465,
    rejectUnauthorized: true,
  });

  const result = await smtpConversation(socket, mime);
  console.log(`✅ ${result}`);
}

sendEmail().catch(err => {
  console.error('❌ Email send failed:', err.message);
  process.exit(1);
});
