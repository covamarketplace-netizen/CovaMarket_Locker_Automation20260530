require('dotenv').config();

const fs = require('fs');
const orderResults = [];
const shop = process.env.SHOPIFY_STORE;
const token = process.env.SHOPIFY_ACCESS_TOKEN;
const today = new Date().toISOString().split('T')[0];

const query = `
query {
  orders(first: 100, query: "created_at:>=${today} AND shipping_method:'Free Pickup'") {
    edges {
      node {
        id
        name
        email
        customer {
          firstName
          lastName
        }
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

async function main() {
  const url = 'https://' + shop + '.myshopify.com/admin/api/2025-07/graphql.json';

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': token,
      },
      body: JSON.stringify({ query }),
    });

    const data = await res.json();

    if (data && data.data && data.data.orders && data.data.orders.edges) {
      const orders = data.data.orders.edges;

      if (orders.length === 0) {
        console.log("Tidak ada order hari ini.");
        return;
      }

      orders.forEach(edge => {
        const node = edge.node;
        const attributes = node.customAttributes || [];

        // Customer name with 3-level fallback
        const firstName = node.customer?.firstName || '';
        const lastName = node.customer?.lastName || '';
        const customerAccountName = `${firstName} ${lastName}`.trim();
        const customerName = customerAccountName || node.shippingAddress?.name || 'Customer';

        const dueDate = attributes.find(attr => attr.key === "Order Due Date")?.value || "N/A";
        const dueTime = attributes.find(attr => attr.key === "Order Due Time")?.value || "N/A";
        const Location = attributes.find(attr => attr.key === "Order Location")?.value || "N/A";
        const pickupLocation = Location.split('(')[0].trim();
        const match = Location.match(/\(([^)]+)\)/);
        const fulfillmentType = match ? match[1] : Location;

        // Skip orders that are not Instant Pickup or Advance Pickup
        const allowedTypes = ['Instant Pickup', 'Advance Pickup'];
        if (!allowedTypes.includes(fulfillmentType)) {
          return;
        }

        // Console output
        console.log(`--- Order: ${node.name || node.id} ---`);
        console.log("1) Customer Name  :", customerName);
        console.log("2) Email          :", node.email || "N/A");
        console.log("3) Order Location :", pickupLocation);
        console.log("4) Pickup Type    :", fulfillmentType);
        console.log("5) Pickup Date    :", dueDate);
        console.log("6) Pickup Time    :", dueTime);
        console.log("-----------------------------\n");

        // Push to array
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

      // Save to JSON file
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
    console.error("Terjadi error saat fetching data:", error);
  }
}

main();
