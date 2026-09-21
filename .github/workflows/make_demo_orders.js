/**
 * make_demo_orders.js
 *
 * Generates N synthetic order objects for demo purposes — used only
 * with generate_pickup_code.js --demo-mode (or DEMO_MODE=1), never with
 * the real pipeline. Fully independent of real Shopify orders, real
 * locations, and real inventory.
 *
 * Usage:
 *   node make_demo_orders.js <count> <email> [name] [location]
 *
 * Writes to /tmp/demo_orders.json for the workflow to pick up.
 */

const fs = require('fs');

const count = parseInt(process.argv[2], 10) || 1;
const email = process.argv[3];
const name = process.argv[4] || 'Demo Customer';
const location = process.argv[5] || 'Demo Location';

if (!email) {
  console.error('Usage: node make_demo_orders.js <count> <email> [name] [location]');
  process.exit(1);
}

if (count > 200) {
  console.error('❌ Refusing to generate more than 200 demo orders in one run — sanity limit to avoid accidental mass-email.');
  process.exit(1);
}

const orders = [];
for (let i = 0; i < count; i++) {
  orders.push({
    order_id: `#DEMO-${Date.now()}-${i + 1}`,
    customer_name: name,
    email,
    phone: null,
    order_location: location,
    pickup_type: 'Instant Pickup', // demo orders are always framed as "available now"
    pickup_date: null, // filled in by generate_pickup_code.js's Instant Pickup display logic
    pickup_time: null,
  });
}

fs.writeFileSync('/tmp/demo_orders.json', JSON.stringify(orders, null, 2));
console.log(`✅ Generated ${count} demo order(s) for ${email} -> /tmp/demo_orders.json`);
