require('dotenv').config();

const orderResults = [];

const shop = process.env.SHOPIFY_STORE;
const clientId = process.env.SHOPIFY_CLIENT_ID;
const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;

const githubToken  = process.env.GITHUB_TOKEN;
const githubOwner  = process.env.GITHUB_OWNER;
const githubRepo   = process.env.GITHUB_REPO;
const githubBranch = process.env.GITHUB_BRANCH || 'main';
const githubFolder = process.env.GITHUB_FOLDER || 'orders';

const today = new Date().toISOString().split('T')[0];

let accessToken = null;
let tokenExpiresAt = 0;

const COUNTRY_DIAL_CODES = {
  AC: '+247', AD: '+376', AE: '+971', AF: '+93', AG: '+1268', AI: '+1264',
  AL: '+355', AM: '+374', AO: '+244', AQ: '+672', AR: '+54', AS: '+1684',
  AT: '+43', AU: '+61', AW: '+297', AX: '+358', AZ: '+994', BA: '+387',
  BB: '+1246', BD: '+880', BE: '+32', BF: '+226', BG: '+359', BH: '+973',
  BI: '+257', BJ: '+229', BL: '+590', BM: '+1441', BN: '+673', BO: '+591',
  BQ: '+599', BR: '+55', BS: '+1242', BT: '+975', BW: '+267', BY: '+375',
  BZ: '+501', CA: '+1', CC: '+61', CD: '+243', CF: '+236', CG: '+242',
  CH: '+41', CI: '+225', CK: '+682', CL: '+56', CM: '+237', CN: '+86',
  CO: '+57', CR: '+506', CU: '+53', CV: '+238', CW: '+599', CX: '+61',
  CY: '+357', CZ: '+420', DE: '+49', DJ: '+253', DK: '+45', DM: '+1767',
  DO: '+1849', DZ: '+213', EC: '+593', EE: '+372', EG: '+20', EH: '+212',
  ER: '+291', ES: '+34', ET: '+251', FI: '+358', FJ: '+679', FK: '+500',
  FM: '+691', FO: '+298', FR: '+33', GA: '+241', GB: '+44', GD: '+1473',
  GE: '+995', GF: '+594', GG: '+44', GH: '+233', GI: '+350', GL: '+299',
  GM: '+220', GN: '+224', GP: '+590', GQ: '+240', GR: '+30', GS: '+500',
  GT: '+502', GU: '+1671', GW: '+245', GY: '+592', HK: '+852', HN: '+504',
  HR: '+385', HT: '+509', HU: '+36', ID: '+62', IE: '+353', IL: '+972',
  IM: '+44', IN: '+91', IO: '+246', IQ: '+964', IR: '+98', IS: '+354',
  IT: '+39', JE: '+44', JM: '+1876', JO: '+962', JP: '+81', KE: '+254',
  KG: '+996', KH: '+855', KI: '+686', KM: '+269', KN: '+1869', KP: '+850',
  KR: '+82', KW: '+965', KY: '+1345', KZ: '+7', LA: '+856', LB: '+961',
  LC: '+1758', LI: '+423', LK: '+94', LR: '+231', LS: '+266', LT: '+370',
  LU: '+352', LV: '+371', LY: '+218', MA: '+212', MC: '+377', MD: '+373',
  ME: '+382', MF: '+590', MG: '+261', MH: '+692', MK: '+389', ML: '+223',
  MM: '+95', MN: '+976', MO: '+853', MP: '+1670', MQ: '+596', MR: '+222',
  MS: '+1664', MT: '+356', MU: '+230', MV: '+960', MW: '+265', MX: '+52',
  MY: '+60', MZ: '+258', NA: '+264', NC: '+687', NE: '+227', NF: '+672',
  NG: '+234', NI: '+505', NL: '+31', NO: '+47', NP: '+977', NR: '+674',
  NU: '+683', NZ: '+64', OM: '+968', PA: '+507', PE: '+51', PF: '+689',
  PG: '+675', PH: '+63', PK: '+92', PL: '+48', PM: '+508', PN: '+872',
  PR: '+1939', PS: '+970', PT: '+351', PW: '+680', PY: '+595', QA: '+974',
  RE: '+262', RO: '+40', RS: '+381', RU: '+7', RW: '+250', SA: '+966',
  SB: '+677', SC: '+248', SD: '+249', SE: '+46', SG: '+65', SH: '+290',
  SI: '+386', SJ: '+47', SK: '+421', SL: '+232', SM: '+378', SN: '+221',
  SO: '+252', SR: '+597', SS: '+211', ST: '+239', SV: '+503', SX: '+1721',
  SY: '+963', SZ: '+268', TC: '+1649', TD: '+235', TG: '+228', TH: '+66',
  TJ: '+992', TK: '+690', TL: '+670', TM: '+993', TN: '+216', TO: '+676',
  TR: '+90', TT: '+1868', TV: '+688', TZ: '+255', UA: '+380', UG: '+256',
  US: '+1', UY: '+598', UZ: '+998', VA: '+379', VC: '+1784', VE: '+58',
  VG: '+1284', VI: '+1340', VN: '+84', VU: '+678', WF: '+681', WS: '+685',
  XK: '+383', YE: '+967', YT: '+262', ZA: '+27', ZM: '+260', ZW: '+263',
};

function formatPhone(rawPhone, countryCode) {
  if (!rawPhone || rawPhone === 'N/A') return 'N/A';

  const dialCode = COUNTRY_DIAL_CODES[countryCode?.toUpperCase()] || '';

  // Already has a + prefix — return as-is
  if (rawPhone.startsWith('+')) return rawPhone;

  // Remove all non-digit characters
  let digits = rawPhone.replace(/\D/g, '');

  if (!dialCode) return '+' + digits;

  // Strip the leading dial code digits if already present (e.g. "601X" when dialCode is "+60")
  const dialDigits = dialCode.replace('+', '');
  if (digits.startsWith(dialDigits)) {
    digits = digits.slice(dialDigits.length);
  }

  // Strip leading 0 (local trunk prefix)
  if (digits.startsWith('0')) {
    digits = digits.slice(1);
  }

  return dialCode + digits;
}

const query = `
query {
  orders(first: 100, query: "created_at:>=${today} AND shipping_method:'Free Pickup'") {
    edges {
      node {
        id
        name
        email
        phone
        shippingAddress {
          name
          phone
          countryCode
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

  const tokenUrl = 'https://' + shop + '.myshopify.com/admin/oauth/access_token';

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
    throw new Error('Token request failed: ' + response.status + ' - ' + errorText);
  }

  const data = await response.json();

  accessToken = data.access_token;
  tokenExpiresAt = Date.now() + (data.expires_in * 1000);

  return accessToken;
}

async function uploadToGithub(filename, contentString) {
  const apiHost = 'api.' + 'github.com';
  const path = githubFolder + '/' + filename;
  const url  = 'https://' + apiHost + '/repos/' + githubOwner + '/' + githubRepo + '/contents/' + path;

  const contentBase64 = Buffer.from(contentString, 'utf-8').toString('base64');

  let sha;
  const head = await fetch(url + '?ref=' + githubBranch, {
    headers: {
      'Authorization': 'Bearer ' + githubToken,
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'shopify-order-sync',
    },
  });
  if (head.ok) {
    const existing = await head.json();
    sha = existing.sha;
  }

  const body = {
    message: 'Add ' + filename,
    content: contentBase64,
    branch: githubBranch,
  };
  if (sha) body.sha = sha;

  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      'Authorization': 'Bearer ' + githubToken,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'shopify-order-sync',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error('GitHub upload failed: ' + res.status + ' - ' + errorText);
  }

  const data = await res.json();
  return data.content.html_url;
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

        const customerName = node.shippingAddress?.name || 'Customer';
        const countryCode  = node.shippingAddress?.countryCode || null;

        const rawPhone =
          node.phone ||
          node.shippingAddress?.phone ||
          null;

        const phone = rawPhone ? formatPhone(rawPhone, countryCode) : 'N/A';

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

        console.log('--- Order: ' + (node.name || node.id) + ' ---');
        console.log("1) Customer Name  :", customerName);
        console.log("2) Email          :", node.email || "N/A");
        console.log("3) Phone          :", phone);
        console.log("4) Order Location :", pickupLocation);
        console.log("5) Pickup Type    :", fulfillmentType);
        console.log("6) Pickup Date    :", dueDate);
        console.log("7) Pickup Time    :", dueTime);
        console.log("-----------------------------\n");

        orderResults.push({
          order_id: node.name || node.id,
          customer_name: customerName,
          email: node.email || "N/A",
          phone: phone,
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
      const filename = 'orders_' + date + '_' + time + '.json';

      const jsonContent = JSON.stringify(orderResults, null, 2);
      const fileUrl = await uploadToGithub(filename, jsonContent);

      console.log('Uploaded ' + orderResults.length + ' orders to GitHub: ' + fileUrl);
    } else {
      console.log("Gagal memproses data atau format response tidak sesuai:", JSON.stringify(data, null, 2));
    }
  } catch (error) {
    console.error("Terjadi error saat fetching data:", error.message);
  }
}

main();
