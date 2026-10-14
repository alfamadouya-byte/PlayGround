/**
 * BILLY'S GLOBAL — serveur API (P1).
 * Express + Firestore (firebase-admin) avec repli mémoire si aucune clé n'est configurée.
 * Règle : le SERVEUR recalcule toujours les prix via pricing.js. Jamais le navigateur.
 */
'use strict';

require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const path = require('path');
const pricing = require('./pricing');

const PORT = Number(process.env.PORT || 3000);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '';

const STATUSES = [
  'PENDING_PAYMENT', 'PAID', 'SOURCING', 'SUPPLIER_CONFIRMED', 'QUALITY_CONTROL',
  'READY_TO_SHIP', 'IN_TRANSIT', 'ARRIVED', 'CUSTOMS', 'CLEARANCE',
  'LOCAL_DELIVERY', 'DELIVERED', 'CANCELLED',
];
// Transitions autorisées (garde-fous, le DG reste maître via confirm-payment).
const TRANSITIONS = {
  PENDING_PAYMENT: ['PAID', 'CANCELLED'], // PAID uniquement via confirm-payment
  PAID: ['SOURCING', 'CANCELLED'],
  SOURCING: ['SUPPLIER_CONFIRMED', 'CANCELLED'],
  SUPPLIER_CONFIRMED: ['QUALITY_CONTROL', 'CANCELLED'],
  QUALITY_CONTROL: ['READY_TO_SHIP', 'CANCELLED'],
  READY_TO_SHIP: ['IN_TRANSIT', 'CANCELLED'],
  IN_TRANSIT: ['ARRIVED', 'CANCELLED'],
  ARRIVED: ['CUSTOMS', 'CANCELLED'],
  CUSTOMS: ['CLEARANCE', 'CANCELLED'],
  CLEARANCE: ['LOCAL_DELIVERY', 'CANCELLED'],
  LOCAL_DELIVERY: ['DELIVERED', 'CANCELLED'],
  DELIVERED: [],
  CANCELLED: [],
};

/* ------------------------------------------------------------------ */
/* Stockage : Firestore si configuré, sinon mémoire (marqué DEMO).     */
/* ------------------------------------------------------------------ */
let db = null;
let firestoreMode = 'memory (DEMO — aucune clé Firestore configurée)';
try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    const admin = require('firebase-admin');
    const creds = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({ credential: admin.credential.cert(creds) });
    db = admin.firestore();
    firestoreMode = 'firestore';
  }
} catch (e) {
  console.error('[store] Firestore indisponible, repli mémoire :', e.message);
}

const mem = {
  products: new Map(), orders: new Map(), vendors: new Map(),
  events: [], audit: [], counters: { orderSeq: 0 },
  pricing: null, // surcharge config/pricing
};

function seedDemoProducts() {
  if (mem.products.size) return;
  const list = [
    ['Smartphone 6.7" 128 Go', 'électronique', 95, 'USD', 0.4, 'ESTIMATION'],
    ['Écouteurs Bluetooth', 'électronique', 8, 'USD', 0.15, 'ESTIMATION'],
    ['Pagne wax (6 yards)', 'textile', 22, 'USD', 1.2, 'ESTIMATION'],
    ['Robe d’été', 'textile', 9, 'USD', 0.4, 'ESTIMATION'],
    ['Chaussures running', 'mode', 18, 'USD', 0.9, 'ESTIMATION'],
    ['Sac à main cuir PU', 'mode', 12, 'USD', 0.7, 'ESTIMATION'],
    ['Mixeur électrique', 'maison', 15, 'USD', 2.1, 'ESTIMATION'],
    ['Set casseroles 10 pièces', 'maison', 28, 'USD', 5.5, 'ESTIMATION'],
    ['Panneau solaire 550 W', 'énergie', 68, 'USD', 28, 'ESTIMATION'],
    ['Groupe électrogène 3 kW', 'énergie', 210, 'USD', 45, 'ESTIMATION'],
    ['Perceuse sans fil 20 V', 'outillage', 32, 'USD', 2.8, 'ESTIMATION'],
    ['Moto 125 cm³ (neuve)', 'moto', null, 'USD', null, 'ESTIMATION'], // -> DEVIS_REQUIS
  ];
  list.forEach(([name, category, supplierPrice, currency, weightKg, source], i) => {
    const id = `demo-${i + 1}`;
    mem.products.set(id, {
      id, name, category, supplierPrice, currency, weightKg, source,
      moq: 1, quantityBreaks: [], image: null, active: true,
      updatedAt: new Date().toISOString(),
    });
  });
}
seedDemoProducts();

async function listProducts() {
  if (db) {
    const snap = await db.collection('products').where('active', '==', true).get();
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  }
  return [...mem.products.values()].filter((p) => p.active);
}
async function getProduct(id) {
  if (db) {
    const d = await db.collection('products').doc(id).get();
    return d.exists ? { id: d.id, ...d.data() } : null;
  }
  return mem.products.get(id) || null;
}
async function saveProduct(id, data) {
  if (db) { await db.collection('products').doc(id).set(data, { merge: true }); return { id, ...data }; }
  mem.products.set(id, { id, ...data });
  return mem.products.get(id);
}
async function nextOrderSeq() {
  if (db) {
    const ref = db.collection('meta').doc('counters');
    const seq = await db.runTransaction(async (t) => {
      const d = await t.get(ref);
      const n = ((d.exists && d.data().orderSeq) || 0) + 1;
      t.set(ref, { orderSeq: n }, { merge: true });
      return n;
    });
    return seq;
  }
  mem.counters.orderSeq += 1;
  return mem.counters.orderSeq;
}
async function saveOrder(order) {
  if (db) { await db.collection('orders').doc(order.code).set(order); return order; }
  mem.orders.set(order.code, order);
  return order;
}
async function getOrder(code) {
  if (db) {
    const d = await db.collection('orders').doc(code).get();
    return d.exists ? d.data() : null;
  }
  return mem.orders.get(code) || null;
}
async function listOrders() {
  if (db) {
    const snap = await db.collection('orders').orderBy('createdAt', 'desc').limit(200).get();
    return snap.docs.map((d) => d.data());
  }
  return [...mem.orders.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}
async function pushAudit(entry) {
  const row = { ...entry, at: new Date().toISOString() };
  if (db) { await db.collection('audit').add(row); return row; }
  mem.audit.push(row);
  return row;
}
async function pushEvent(ev) {
  const row = { ...ev, at: new Date().toISOString() };
  if (db) { await db.collection('events').add(row); return row; }
  mem.events.push(row);
  return row;
}
async function getPricingConfig() {
  if (db) {
    const d = await db.collection('config').doc('pricing').get();
    if (d.exists) return pricing.mergeConfig(d.data());
  } else if (mem.pricing) return pricing.mergeConfig(mem.pricing);
  return pricing.mergeConfig({});
}

/* ------------------------------------------------------------------ */
/* App                                                                 */
/* ------------------------------------------------------------------ */
const app = express();
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '256kb' }));
if (ALLOWED_ORIGIN) app.use(cors({ origin: ALLOWED_ORIGIN.split(',').map((s) => s.trim()) }));
app.use('/api', rateLimit({ windowMs: 60_000, max: 120, standardHeaders: true, legacyHeaders: false }));
app.use(express.static(path.join(__dirname, 'public')));

const fmtGnf = (n) => (n === null || n === undefined ? 'Prix sur devis' : `${Number(n).toLocaleString('fr-FR')} GNF`);

function publicProduct(p, mode, config) {
  let calc = null;
  try {
    calc = pricing.priceLine({
      supplierPrice: p.supplierPrice, currency: p.currency || 'USD',
      weightKg: p.weightKg, qty: 1, mode, category: p.category,
    }, config);
  } catch { calc = { priceState: 'DEVIS_REQUIS', finalPrice: null }; }
  return {
    id: p.id, name: p.name, category: p.category, image: p.image || null,
    moq: p.moq || 1, source: p.source || 'ESTIMATION',
    priceState: calc.priceState, price: calc.finalPrice, priceLabel: fmtGnf(calc.finalPrice),
    estimation: calc.priceState === 'ESTIMATION',
  };
}

/* ------------------------------- Public --------------------------- */
app.get('/health', (_req, res) => res.json({ ok: true, store: firestoreMode, time: new Date().toISOString() }));

app.get('/api/products', async (req, res) => {
  try {
    const mode = ['air', 'sea', 'groupage'].includes(req.query.mode) ? req.query.mode : 'air';
    const config = await getPricingConfig();
    const products = (await listProducts()).map((p) => publicProduct(p, mode, config));
    res.json({ mode, count: products.length, demo: !db, products });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/price', async (req, res) => {
  try {
    const { items, mode = 'air' } = req.body || {};
    if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'items requis (non vide).' });
    const config = await getPricingConfig();
    const full = [];
    for (const it of items) {
      const p = await getProduct(it.productId);
      if (!p) return res.status(404).json({ error: `Produit introuvable : ${it.productId}` });
      full.push({
        supplierPrice: p.supplierPrice, currency: p.currency || 'USD',
        weightKg: p.weightKg, qty: Math.max(1, it.qty | 0 || 1),
        mode: it.mode || mode, category: p.category, name: p.name, productId: p.id,
      });
    }
    const result = pricing.priceCart(full, mode, config);
    res.json({ ...result, priceLabel: fmtGnf(result.finalPrice), demo: !db });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

function makeOrderCode(seq) {
  const year = new Date().getFullYear();
  return `BG-${year}-${String(seq).padStart(6, '0')}`;
}

app.post('/api/orders', async (req, res) => {
  try {
    const { name, phone, address, payMethod = 'manuel', mode = 'air', items } = req.body || {};
    if (!name || !phone || !address) return res.status(400).json({ error: 'Nom, téléphone et adresse requis.' });
    if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'Panier vide.' });
    const config = await getPricingConfig();
    const lines = [];
    for (const it of items) {
      const p = await getProduct(it.productId);
      if (!p || !p.active) return res.status(404).json({ error: `Produit indisponible : ${it.productId}` });
      const qty = Math.max(1, it.qty | 0 || 1);
      if (qty < (p.moq || 1)) return res.status(400).json({ error: `Quantité minimale (${p.moq}) non atteinte pour ${p.name}.` });
      // LE SERVEUR recalcule. Jamais le navigateur.
      const b = pricing.priceLine({
        supplierPrice: p.supplierPrice, currency: p.currency || 'USD',
        weightKg: p.weightKg, qty, mode: it.mode || mode, category: p.category,
      }, config);
      if (b.priceState === 'DEVIS_REQUIS') {
        return res.status(422).json({ error: `« ${p.name} » : prix sur devis — commande impossible en ligne. Contactez-nous.` });
      }
      lines.push({
        productId: p.id, name: p.name, category: p.category, qty, mode: it.mode || mode,
        unitSupplier: p.supplierPrice, currency: p.currency || 'USD', breakdown: b, lineTotal: b.finalPrice,
      });
    }
    // Livraison locale 1× par commande : retirer les doublons (lignes 2..n).
    const localFee = config.localDelivery;
    const extraLocal = localFee * Math.max(0, lines.length - 1);
    const rawTotal = lines.reduce((s, l) => s + l.lineTotal, 0) - extraLocal;
    const cartCheck = pricing.priceCart(lines.map((l) => ({
      supplierPrice: l.unitSupplier, currency: l.currency, weightKg: undefined, qty: 1, mode: l.mode,
    })), mode, config);
    void cartCheck;
    const total = pricing.roundToThousand(rawTotal);
    const priceState = lines.some((l) => l.breakdown.priceState === 'ESTIMATION') ? 'ESTIMATION' : 'CALCULE';
    const seq = await nextOrderSeq();
    const code = makeOrderCode(seq);
    const order = {
      code, customer: { name, phone, address },
      items: lines, total, priceState, mode,
      status: 'PENDING_PAYMENT', payment: { method: payMethod, confirmed: false, confirmedAt: null },
      history: [{ status: 'PENDING_PAYMENT', at: new Date().toISOString(), by: 'system' }],
      createdAt: new Date().toISOString(),
    };
    await saveOrder(order);
    res.status(201).json({ code, total, priceLabel: fmtGnf(total), priceState, status: order.status });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/track/:code', async (req, res) => {
  const o = await getOrder(req.params.code.toUpperCase());
  if (!o) return res.status(404).json({ error: 'Code inconnu. Vérifiez votre code de suivi.' });
  res.json({
    code: o.code, status: o.status, total: o.total, priceLabel: fmtGnf(o.total),
    priceState: o.priceState, mode: o.mode,
    paymentConfirmed: !!o.payment?.confirmed, history: o.history || [],
  });
});

app.post('/api/vendors', async (req, res) => {
  try {
    const { shop, name, phone, city, categories } = req.body || {};
    if (!shop || !name || !phone) return res.status(400).json({ error: 'Boutique, nom et téléphone requis.' });
    const id = `v-${Date.now().toString(36)}`;
    const row = { id, shop, name, phone, city: city || '', categories: categories || '', status: 'PENDING', createdAt: new Date().toISOString() };
    if (db) await db.collection('vendors').doc(id).set(row);
    else mem.vendors.set(id, row);
    res.status(201).json({ id, status: 'PENDING', message: 'Demande reçue. Le DG la validera avant mise en ligne.' });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

const EVENT_TYPES = ['search', 'product_view', 'add_to_cart', 'checkout', 'tata_interaction'];
app.post('/api/events', async (req, res) => {
  const { type, data } = req.body || {};
  if (!EVENT_TYPES.includes(type)) return res.status(400).json({ error: `type attendu : ${EVENT_TYPES.join(', ')}` });
  await pushEvent({ type, data: data || {} });
  res.json({ ok: true });
});

/* Tata — règles sur données réelles uniquement. */
app.post('/api/tata', async (req, res) => {
  try {
    const message = String((req.body || {}).message || '').trim();
    if (!message) return res.status(400).json({ error: 'message requis.' });
    await pushEvent({ type: 'tata_interaction', data: { message: message.slice(0, 200) } });
    const config = await getPricingConfig();
    const products = await listProducts();
    const lower = message.toLowerCase();

    // Suivi de commande : code BG-....
    const codeMatch = message.toUpperCase().match(/BG-[A-Z0-9]+-\d+/);
    if (/(où|ou|suivi|statut|commande|colis|track)/.test(lower) || codeMatch) {
      if (!codeMatch) return res.json({ reply: 'Donnez-moi votre code de suivi (ex. BG-2026-000001) et je vous dirai où en est votre colis.' });
      const o = await getOrder(codeMatch[0]);
      if (!o) return res.json({ reply: `Je ne trouve pas la commande ${codeMatch[0]}. Vérifiez le code.` });
      return res.json({ reply: `Commande ${o.code} : statut ${o.status}, total ${fmtGnf(o.total)}${o.payment?.confirmed ? ' (paiement confirmé)' : ' (en attente de paiement)'}.` });
    }
    // Prix d'un produit nommé.
    const found = products.find((p) => lower.includes(p.name.toLowerCase().split(' ')[0]) || lower.includes(p.name.toLowerCase()));
    if (/(prix|combien|coût|cout|tarif)/.test(lower)) {
      if (found) {
        const b = pricing.priceLine({
          supplierPrice: found.supplierPrice, currency: found.currency || 'USD',
          weightKg: found.weightKg, qty: 1, mode: 'air', category: found.category,
        }, config);
        if (b.priceState === 'DEVIS_REQUIS') return res.json({ reply: `« ${found.name} » : prix sur devis pour le moment. Laissez votre numéro, on vous rappelle.` });
        const tag = b.priceState === 'ESTIMATION' ? ' (estimation)' : '';
        return res.json({ reply: `« ${found.name} » : ${fmtGnf(b.finalPrice)} livré${tag}. Dites-moi la quantité et le mode (avion/bateau/groupage) pour un calcul précis.` });
      }
      return res.json({ reply: 'Dites-moi quel produit vous cherchez (nom ou catégorie) et je calcule son prix livré.' });
    }
    // Catalogue / catégories.
    if (/(produit|catalogue|catégorie|categorie|vendez|avez)/.test(lower)) {
      const cats = [...new Set(products.map((p) => p.category))].join(', ');
      return res.json({ reply: `Nous avons ${products.length} articles (DEMO) dans : ${cats}. Que cherchez-vous ?` });
    }
    if (/(livraison|délai|delai|durée|duree|conakry|labé|labé|labe)/.test(lower)) {
      return res.json({ reply: 'Livraison Chine → Conakry puis Labé : avion le plus rapide, bateau le moins cher, groupage entre les deux. Le prix exact dépend du poids — donnez-moi le produit et la quantité.' });
    }
    if (/(bonjour|salut|bonsoir|hello)/.test(lower)) {
      return res.json({ reply: 'Bonjour ! Je suis Tata, je vous aide à trouver un produit, calculer son prix livré en GNF ou suivre votre commande. Que cherchez-vous ?' });
    }
    return res.json({ reply: "Je n'ai pas encore cette information." });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ------------------------------- Admin ---------------------------- */
function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) return res.status(500).json({ error: 'ADMIN_TOKEN non configuré.' });
  if (req.headers['x-admin-token'] !== ADMIN_TOKEN) return res.status(401).json({ error: 'Non autorisé.' });
  next();
}

app.get('/api/admin/orders', requireAdmin, async (_req, res) => {
  res.json({ orders: await listOrders(), demo: !db });
});

app.patch('/api/admin/orders/:code/status', requireAdmin, async (req, res) => {
  const code = req.params.code.toUpperCase();
  const { status } = req.body || {};
  if (!STATUSES.includes(status)) return res.status(400).json({ error: `Statut attendu : ${STATUSES.join(', ')}` });
  if (status === 'PAID') return res.status(403).json({ error: 'Utilisez confirm-payment pour marquer PAYÉ (preuve de paiement requise).' });
  const o = await getOrder(code);
  if (!o) return res.status(404).json({ error: 'Commande introuvable.' });
  if (!TRANSITIONS[o.status]?.includes(status) && o.status !== status) {
    return res.status(409).json({ error: `Transition refusée : ${o.status} → ${status}.` });
  }
  o.status = status;
  o.history = [...(o.history || []), { status, at: new Date().toISOString(), by: 'admin' }];
  await saveOrder(o);
  await pushAudit({ action: 'order.status', code, to: status, by: 'admin' });
  res.json({ code, status });
});

app.post('/api/admin/orders/:code/confirm-payment', requireAdmin, async (req, res) => {
  const code = req.params.code.toUpperCase();
  const o = await getOrder(code);
  if (!o) return res.status(404).json({ error: 'Commande introuvable.' });
  if (o.status !== 'PENDING_PAYMENT') return res.status(409).json({ error: `Déjà traitée (statut ${o.status}).` });
  o.payment = { ...o.payment, confirmed: true, confirmedAt: new Date().toISOString() };
  o.status = 'PAID';
  o.history = [...(o.history || []), { status: 'PAID', at: new Date().toISOString(), by: 'admin', note: 'paiement confirmé (manuel)' }];
  await saveOrder(o);
  await pushAudit({ action: 'order.confirm-payment', code, by: 'admin', detail: req.body?.reference || 'manuel' });
  res.json({ code, status: 'PAID', paymentConfirmed: true });
});

app.get('/api/admin/dashboard', requireAdmin, async (_req, res) => {
  const orders = await listOrders();
  const paid = orders.filter((o) => o.status !== 'PENDING_PAYMENT' && o.status !== 'CANCELLED');
  const revenue = paid.reduce((s, o) => s + (o.total || 0), 0);
  const margin = paid.reduce((s, o) => s + (o.items || []).reduce((a, l) => a + (l.breakdown?.bgMargin || 0), 0), 0);
  const byStatus = {};
  for (const o of orders) byStatus[o.status] = (byStatus[o.status] || 0) + 1;
  res.json({ revenue, margin: Math.round(margin), orders: orders.length, paid: paid.length, byStatus, demo: !db });
});

app.get('/api/admin/analytics', requireAdmin, async (_req, res) => {
  const events = db
    ? (await db.collection('events').orderBy('at', 'desc').limit(500).get()).docs.map((d) => d.data())
    : mem.events.slice(-500);
  const byType = {};
  for (const e of events) byType[e.type] = (byType[e.type] || 0) + 1;
  res.json({ total: events.length, byType, recent: events.slice(-20).reverse() });
});

app.get('/api/admin/engine', requireAdmin, async (_req, res) => {
  const config = await getPricingConfig();
  const products = await listProducts();
  const orders = await listOrders();
  res.json({
    store: firestoreMode,
    pricingSource: db ? 'config/pricing (Firestore)' : 'valeurs par défaut (ESTIMATIONS)',
    rates: config.rates, freightPerKg: config.freightPerKg,
    counts: { products: products.length, orders: orders.length },
    referenceCheck: pricing.priceLine({ supplierPrice: 1000, currency: 'USD', weightKg: 2, qty: 1, mode: 'air' }, config).finalPrice,
    updatedAt: new Date().toISOString(),
  });
});

app.post('/api/admin/products', requireAdmin, async (req, res) => {
  const { id, name, category, supplierPrice, currency = 'USD', weightKg = null, moq = 1, source = 'SUPPLIER_QUOTE', image = null, active = true } = req.body || {};
  if (!name || !category) return res.status(400).json({ error: 'Nom et catégorie requis.' });
  if (supplierPrice !== null && supplierPrice !== undefined && Number(supplierPrice) < 0) return res.status(400).json({ error: 'Prix invalide.' });
  const pid = id || `p-${Date.now().toString(36)}`;
  const row = {
    name, category, supplierPrice: supplierPrice ?? null, currency,
    weightKg: weightKg ?? null, moq, source, image, active,
    updatedAt: new Date().toISOString(),
  };
  await saveProduct(pid, row);
  await pushAudit({ action: 'product.upsert', id: pid, by: 'admin' });
  res.status(201).json({ id: pid, ...row });
});

async function listVendors() {
  if (db) return (await db.collection('vendors').get()).docs.map((d) => d.data());
  return [...mem.vendors.values()];
}
app.get('/api/admin/vendors', requireAdmin, async (_req, res) => {
  res.json({ vendors: await listVendors(), demo: !db });
});
app.patch('/api/admin/vendors/:id', requireAdmin, async (req, res) => {
  const { status } = req.body || {};
  if (!['APPROVED', 'REJECTED'].includes(status)) return res.status(400).json({ error: 'statut attendu : APPROVED|REJECTED' });
  if (db) {
    const ref = db.collection('vendors').doc(req.params.id);
    const d = await ref.get();
    if (!d.exists) return res.status(404).json({ error: 'Demande introuvable.' });
    await ref.set({ status }, { merge: true });
  } else {
    const v = mem.vendors.get(req.params.id);
    if (!v) return res.status(404).json({ error: 'Demande introuvable.' });
    v.status = status;
  }
  await pushAudit({ action: 'vendor.review', id: req.params.id, to: status, by: 'admin' });
  res.json({ id: req.params.id, status });
});

/* Export pour les tests d'intégration. */
async function testListen(port = 0) {
  return new Promise((resolve) => {
    const s = app.listen(port, () => resolve(s));
  });
}

if (require.main === module) {
  app.listen(PORT, () => console.log(`BILLY'S GLOBAL API : http://localhost:${PORT} [${firestoreMode}]`));
}

module.exports = { app, testListen, STATUSES };
