require('dotenv').config();

const fs = require('fs');
const orderResults = [];

const shop = process.env.SHOPIFY_STORE; // example: zh2xq8-hv
const clientId = process.env.SHOPIFY_CLIENT_ID;
const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;

const today = new Date().toISOString().split('T')[0];

let accessToken = null;
let tokenExpiresAt = 0;

const query = `
query {
  orders(first: 100, query: "created_at:>=${today} AND shipping_method:'Free Pickup'") {
    edges {
      node {
        id
        name
        email
        shippingAddress {
          name
          address1
          address2
          city
          provinceCode
          zip
          country
        }
        customAttributes {
          key
          value
        }
      }
    }
  }
}
`;

async function getToken() {
  if (accessToken && Date.now() < tokenExpiresAt - 60000) {
    return accessToken;
  }

  const tokenUrl = `https://${shop}.myshopify.com/admin/oauth/access_token`;

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Token request failed: ${response.status} - ${errorText}`);
  }

  const data = await response.json();

  accessToken = data.access_token;
  tokenExpiresAt = Date.now() + (data.expires_in * 1000);

  return accessToken;
}

async function main() {
  const url = `https://${shop}.myshopify.com/admin/api/2025-07/graphql.json`;

  try {
    const token = await getToken();

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': token,
      },
      body: JSON.stringify({ query }),
    });

    const data = await res.json();

    if (data.errors) {
      console.error("GraphQL errors:", JSON.stringify(data.errors, null, 2));
      return;
    }

    if (data && data.data && data.data.orders && data.data.orders.edges) {
      const orders = data.data.orders.edges;

      if (orders.length === 0) {
        console.log("Tidak ada order hari ini.");
        return;
      }

      orders.forEach(edge => {
        const node = edge.node;
        const attributes = node.customAttributes || [];

        const firstName = node.customer?.firstName || '';
        const lastName = node.customer?.lastName || '';
        const customerAccountName = `${firstName} ${lastName}`.trim();
        const customerName = customerAccountName || node.shippingAddress?.name || 'Customer';

        const dueDate = attributes.find(attr => attr.key === "Order Due Date")?.value || "N/A";
        const dueTime = attributes.find(attr => attr.key === "Order Due Time")?.value || "N/A";
        const location = attributes.find(attr => attr.key === "Order Location")?.value || "N/A";
        const pickupLocation = location.split('(')[0].trim();
        const match = location.match(/\(([^)]+)\)/);
        const fulfillmentType = match ? match[1] : location;

        const allowedTypes = ['Instant Pickup', 'Advance Pickup'];
        if (!allowedTypes.includes(fulfillmentType)) {
          return;
        }

        console.log(`--- Order: ${node.name || node.id} ---`);
        console.log("1) Customer Name  :", customerName);
        console.log("2) Email          :", node.email || "N/A");
        console.log("3) Order Location :", pickupLocation);
        console.log("4) Pickup Type    :", fulfillmentType);
        console.log("5) Pickup Date    :", dueDate);
        console.log("6) Pickup Time    :", dueTime);
        console.log("-----------------------------\n");

        orderResults.push({
          order_id: node.name || node.id,
          customer_name: customerName,
          email: node.email || "N/A",
          order_location: pickupLocation,
          pickup_type: fulfillmentType,
          pickup_date: dueDate,
          pickup_time: dueTime
        });
      });

      if (orderResults.length === 0) {
        console.log("Tidak ada order Instant Pickup atau Advance Pickup hari ini.");
        return;
      }

      const now = new Date();
      const date = now.toISOString().split('T')[0];
      const time = now.toTimeString().split(' ')[0].replace(/:/g, '-');
      const filename = `orders_${date}_${time}.json`;

      fs.writeFileSync(filename, JSON.stringify(orderResults, null, 2));
      console.log(`Saved ${orderResults.length} orders to ${filename}`);
    } else {
      console.log("Gagal memproses data atau format response tidak sesuai:", JSON.stringify(data, null, 2));
    }
  } catch (error) {
    console.error("Terjadi error saat fetching data:", error.message);
  }
}

main();
