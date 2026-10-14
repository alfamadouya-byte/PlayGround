/** Seed : 12 produits démo (ESTIMATION) via l'API admin. Usage : ADMIN_TOKEN=xxx node scripts/seed.js [baseUrl] */
'use strict';
const base = process.argv[2] || `http://localhost:${process.env.PORT || 3000}`;
const token = process.env.ADMIN_TOKEN;
if (!token) { console.error('ADMIN_TOKEN requis.'); process.exit(1); }

const products = [
  ['Smartphone 6.7" 128 Go', 'électronique', 95, 'USD', 0.4],
  ['Écouteurs Bluetooth', 'électronique', 8, 'USD', 0.15],
  ['Pagne wax (6 yards)', 'textile', 22, 'USD', 1.2],
  ['Robe d’été', 'textile', 9, 'USD', 0.4],
  ['Chaussures running', 'mode', 18, 'USD', 0.9],
  ['Sac à main cuir PU', 'mode', 12, 'USD', 0.7],
  ['Mixeur électrique', 'maison', 15, 'USD', 2.1],
  ['Set casseroles 10 pièces', 'maison', 28, 'USD', 5.5],
  ['Panneau solaire 550 W', 'énergie', 68, 'USD', 28],
  ['Groupe électrogène 3 kW', 'énergie', 210, 'USD', 45],
  ['Perceuse sans fil 20 V', 'outillage', 32, 'USD', 2.8],
  ['Moto 125 cm³ (neuve)', 'moto', null, 'USD', null],
];

(async () => {
  for (const [name, category, supplierPrice, currency, weightKg] of products) {
    const r = await fetch(`${base}/api/admin/products`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-token': token },
      body: JSON.stringify({ name, category, supplierPrice, currency, weightKg, source: 'ESTIMATION', moq: 1 }),
    });
    console.log(r.status, name);
  }
})();
