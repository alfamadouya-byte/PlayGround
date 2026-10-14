/** Parcours complet : visiteur → produit → prix → commande → suivi → admin. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'test-admin-token';
const { testListen } = require('../server');

let base, server;
test.before(async () => {
  server = await testListen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

const adminHeaders = { 'Content-Type': 'application/json', 'x-admin-token': process.env.ADMIN_TOKEN };
const post = (p, body, h) => fetch(base + p, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...(h || {}) }, body: JSON.stringify(body),
}).then(async (r) => ({ status: r.status, json: await r.json() }));

test('parcours visiteur complet + cohérence des prix', async () => {
  // 1. Catalogue (DEMO, ESTIMATION).
  const cat = await fetch(`${base}/api/products?mode=air`).then((r) => r.json());
  assert.ok(cat.count >= 12, '12 produits démo');
  assert.equal(cat.demo, true);
  const phone = cat.products.find((p) => p.id === 'demo-1');
  assert.equal(phone.priceState, 'CALCULE');

  // 2. Prix panier via /api/price (serveur recalcule).
  const priced = await post('/api/price', { items: [{ productId: 'demo-1', qty: 2 }], mode: 'air' });
  assert.equal(priced.status, 200);
  assert.ok(priced.json.finalPrice > 0);

  // 3. Commande.
  const order = await post('/api/orders', {
    name: 'Aïcha Bah', phone: '622000000', address: 'Conakry, Matoto',
    payMethod: 'manuel', mode: 'air', items: [{ productId: 'demo-1', qty: 2 }],
  });
  assert.equal(order.status, 201, JSON.stringify(order.json));
  assert.match(order.json.code, /^BG-[A-Z0-9]+-\d{6}$/);
  assert.equal(order.json.status, 'PENDING_PAYMENT');
  // Cohérence : total commande == prix panier.
  assert.equal(order.json.total, priced.json.finalPrice, 'même prix panier et commande');

  // 4. Suivi public.
  const track = await fetch(`${base}/api/track/${order.json.code}`).then((r) => r.json());
  assert.equal(track.status, 'PENDING_PAYMENT');
  assert.equal(track.total, order.json.total, 'même prix commande et suivi');
  assert.equal(track.paymentConfirmed, false);

  // 5. Sécurité : passer PAYÉ par changement de statut direct = refusé.
  const hack = await fetch(`${base}/api/admin/orders/${order.json.code}/status`, {
    method: 'PATCH', headers: adminHeaders, body: JSON.stringify({ status: 'PAID' }),
  });
  assert.equal(hack.status, 403, 'jamais de PAID sans confirm-payment');

  // 6. Admin confirme le paiement (manuel, P1).
  const confirm = await post(`/api/admin/orders/${order.json.code}/confirm-payment`, { reference: 'test-manuel' }, { 'x-admin-token': process.env.ADMIN_TOKEN });
  assert.equal(confirm.status, 200);
  assert.equal(confirm.json.status, 'PAID');

  // 7. Admin fait avancer le statut.
  const adv = await fetch(`${base}/api/admin/orders/${order.json.code}/status`, {
    method: 'PATCH', headers: adminHeaders, body: JSON.stringify({ status: 'SOURCING' }),
  }).then(async (r) => ({ status: r.status, json: await r.json() }));
  assert.equal(adv.status, 200);
  assert.equal(adv.json.status, 'SOURCING');

  // 8. Dashboard cohérent.
  const dash = await fetch(`${base}/api/admin/dashboard`, { headers: { 'x-admin-token': process.env.ADMIN_TOKEN } }).then((r) => r.json());
  assert.ok(dash.revenue >= order.json.total, 'CA inclut la commande payée');

  // 9. Tata : ne jamais inventer.
  const tataUnknown = await post('/api/tata', { message: 'Quel est le stock à Shenzhen ?' });
  assert.equal(tataUnknown.json.reply, "Je n'ai pas encore cette information.");
  const tataPrice = await post('/api/tata', { message: 'Quel est le prix du smartphone ?' });
  assert.match(tataPrice.json.reply, /GNF/);
});

test('garde-fous : devis requis, admin protégé, health', async () => {
  const devis = await post('/api/orders', {
    name: 'X', phone: '622000001', address: 'Labé', mode: 'air', items: [{ productId: 'demo-12', qty: 1 }],
  });
  assert.equal(devis.status, 422, 'moto sans prix -> devis requis, pas de commande');

  const noAuth = await fetch(`${base}/api/admin/orders`).then((r) => r.status);
  assert.equal(noAuth, 401);

  const health = await fetch(`${base}/health`).then((r) => r.json());
  assert.equal(health.ok, true);
});
