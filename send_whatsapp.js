/**
 * send_whatsapp.js  (PRODUCTION VERSION)
 *
 * Sends a WhatsApp pickup-code notification via Twilio, using an
 * approved WhatsApp Content Template (ContentSid + ContentVariables)
 * instead of a free-form Body string. Meta requires an approved
 * template for any business-initiated message sent outside a
 * customer-initiated 24-hour session window.
 *
 * Template: pickup_code_notification
 * ContentSid: HXe703d3727fc7ea0a5f327d45ad97ad79
 * Category: Utility
 *
 * Required env vars:
 *   TWILIO_ACCOUNT_SID   - from Twilio console
 *   TWILIO_AUTH_TOKEN    - from Twilio console
 *   TWILIO_WA_FROM       - your approved WhatsApp sender, e.g. +19522487543
 *   TO_PHONE             - customer phone e.g. +60123456789
 *   CUSTOMER_NAME
 *   ORDER_ID
 *   PICK_CODE
 *   LOCKER
 *   PICKUP_LOCATION
 *   PICKUP_DATE
 *   PICKUP_TIME
 *
 * Optional:
 *   WHATSAPP_CONTENT_SID - override the ContentSid without editing code
 */

const https = require('https');

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken  = process.env.TWILIO_AUTH_TOKEN;
const from       = process.env.TWILIO_WA_FROM || '+19522487543'; // approved production sender
const to         = process.env.TO_PHONE;
const contentSid = process.env.WHATSAPP_CONTENT_SID || 'HXe703d3727fc7ea0a5f327d45ad97ad79';

if (!accountSid || !authToken) {
  console.error('❌ TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN not set');
  process.exit(1);
}

if (!to) {
  console.error('❌ TO_PHONE not set');
  process.exit(1);
}

const customerName   = process.env.CUSTOMER_NAME    || 'Customer';
const orderId        = process.env.ORDER_ID         || '';
const pickCode       = process.env.PICK_CODE        || '';
const locker         = process.env.LOCKER           || '';
const pickupLocation = process.env.PICKUP_LOCATION  || '';
const pickupDate     = process.env.PICKUP_DATE      || '';
const pickupTime     = process.env.PICKUP_TIME      || '';

if (!pickCode) {
  console.error('❌ PICK_CODE not set');
  process.exit(1);
}

// Map the 7 template variables in order — must match the approved
// template's {{1}}..{{7}} placeholders exactly.
const contentVariables = JSON.stringify({
  '1': customerName,
  '2': orderId,
  '3': pickCode,
  '4': locker,
  '5': pickupLocation,
  '6': pickupDate,
  '7': pickupTime,
});

const body = new URLSearchParams({
  From:             `whatsapp:${from}`,
  To:               `whatsapp:${to}`,
  ContentSid:       contentSid,
  ContentVariables: contentVariables,
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

console.log(`📱 Sending WhatsApp template to ${to} for order ${orderId}...`);
console.log(`   Template: ${contentSid}`);

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
        // Common failure here: template not yet approved by Meta.
        // Check WhatsApp approval status in Console before retrying.
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
