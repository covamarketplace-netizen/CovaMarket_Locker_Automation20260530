/**
 * send_whatsapp.js
 * Sends a WhatsApp message via Twilio API.
 *
 * Required env vars:
 *   TWILIO_ACCOUNT_SID   - from Twilio console
 *   TWILIO_AUTH_TOKEN    - from Twilio console
 *   TWILIO_WA_FROM       - Twilio sandbox number e.g. +14155238886
 *   TO_PHONE             - customer phone e.g. +60123456789
 *   CUSTOMER_NAME
 *   ORDER_ID
 *   PICK_CODE
 *   LOCKER
 *   PICKUP_LOCATION
 *   PICKUP_DATE
 *   PICKUP_TIME
 */

const https = require('https');

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken  = process.env.TWILIO_AUTH_TOKEN;
const from       = process.env.TWILIO_WA_FROM || '+14155238886'; // Twilio sandbox default
const to         = process.env.TO_PHONE;

if (!accountSid || !authToken) {
  console.error('❌ TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN not set');
  process.exit(1);
}

if (!to) {
  console.error('❌ TO_PHONE not set');
  process.exit(1);
}

const customerName    = process.env.CUSTOMER_NAME    || 'Customer';
const orderId         = process.env.ORDER_ID         || '';
const pickCode        = process.env.PICK_CODE        || '';
const locker          = process.env.LOCKER           || '';
const pickupLocation  = process.env.PICKUP_LOCATION  || '';
const pickupDate      = process.env.PICKUP_DATE      || '';
const pickupTime      = process.env.PICKUP_TIME      || '';

const message = [
  `🎉 Hi ${customerName}! Your CovaMarket order is ready for pickup!`,
  ``,
  `📦 Order     : ${orderId}`,
  `🔑 Pickup Code: *${pickCode}*`,
  `🗄  Locker    : ${locker}`,
  `📍 Location  : ${pickupLocation}`,
  `🗓  Date      : ${pickupDate}`,
  `⏰ Time      : ${pickupTime}`,
  ``,
  `Head to the locker, select your slot and enter your pickup code. See you there! 😊`,
].join('\n');

const body = new URLSearchParams({
  From: `whatsapp:${from}`,
  To:   `whatsapp:${to}`,
  Body: message,
}).toString();

const options = {
  hostname: 'api.twilio.com',
  path:     `/2010-04-01/Accounts/${accountSid}/Messages.json`,
  method:   'POST',
  headers:  {
    'Content-Type':   'application/x-www-form-urlencoded',
    'Authorization':  'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64'),
    'Content-Length': Buffer.byteLength(body),
  },
};

console.log(`📱 Sending WhatsApp to ${to} for order ${orderId}...`);

const req = https.request(options, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    try {
      const json = JSON.parse(data);
      if (res.statusCode >= 200 && res.statusCode < 300) {
        console.log(`✅ WhatsApp sent! SID: ${json.sid}`);
      } else {
        console.error(`❌ Twilio error ${res.statusCode}: ${json.message || data}`);
        process.exit(1);
      }
    } catch {
      console.error(`❌ Failed to parse Twilio response: ${data}`);
      process.exit(1);
    }
  });
});

req.on('error', (err) => {
  console.error(`❌ Request error: ${err.message}`);
  process.exit(1);
});

req.write(body);
req.end();
