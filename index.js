require('dotenv').config();

const shop = process.env.SHOPIFY_STORE;
const token = process.env.SHOPIFY_ACCESS_TOKEN;
const today = new Date().toISOString().split('T')[0];

// 1. Menggunakan customAttributes (bukan noteAttributes) untuk GraphQL API
const query = `
query {
  orders(first: 100, query: "created_at:>=${today} AND shipping_method:'Free Pickup'") {
    edges {
      node {
        id
        name
        createdAt
        shippingAddress {
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
        // Perubahan: Ambil dari customAttributes, gunakan fallback array kosong jika null
        const attributes = node.customAttributes || [];

        // Perubahan: GraphQL menggunakan 'key' dan 'value' untuk customAttributes
        const dueDate = attributes.find(attr => attr.key === "Order Due Date")?.value || "N/A";
        const dueTime = attributes.find(attr => attr.key === "Order Due Time")?.value || "N/A";
        //const fulfillmentType = attributes.find(attr => attr.key === "Order Fulfillment Type")?.value || "N/A";
        const Location = attributes.find(attr => attr.key === "Order Location")?.value || "N/A";
		const pickupLocation = Location.split('(')[0].trim();
		const match = Location.match(/\(([^)]+)\)/);
		const fulfillmentType = match ? match[1] : Location;

        // Menampilkan hasil ekstraksi data di console
        console.log(`--- Order: ${node.name || node.id} ---`);
        console.log("1) Order Location :", pickupLocation);
        console.log("2) Pickup Type     :", fulfillmentType);
        console.log("3) Pickup Date     :", dueDate);
        console.log("4) Pickup Time     :", dueTime);
        console.log("-----------------------------\n");
      });
    } else {
      console.log("Gagal memproses data atau format response tidak sesuai:", JSON.stringify(data, null, 2));
    }
  } catch (error) {
    console.error("Terjadi error saat fetching data:", error);
  }
}

main();