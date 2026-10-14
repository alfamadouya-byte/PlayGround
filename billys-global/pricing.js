/**
 * BILLY'S GLOBAL — BG Total Landed Cost Engine (pricing.js)
 * SEULE source de vérité pour les prix. Module pur, sans dépendance.
 *
 * Trois états de prix : CALCULE | ESTIMATION | DEVIS_REQUIS
 * - CALCULE     : prix fournisseur + poids connus (source SUPPLIER_QUOTE ou ESTIMATION avec valeurs)
 * - ESTIMATION  : une donnée manque (poids inconnu...) -> valeurs par défaut marquées estimation
 * - DEVIS_REQUIS: pas de prix fournisseur -> aucun chiffre, « Prix sur devis »
 *
 * Toutes les valeurs par défaut sont des ESTIMATIONS à remplacer via config/pricing.
 */

'use strict';

const DEFAULT_CONFIG = Object.freeze({
  rates: Object.freeze({ USD_GNF: 8600, CNY_GNF: 1190 }),
  freightPerKg: Object.freeze({ air: 9000, sea: 1800, groupage: 2600 }),
  customsRate: 0.18,
  customsRateByCategory: Object.freeze({}),
  handlingRate: 0.01,
  qcRate: 0.005,
  transitRate: 0.02,
  localDelivery: 15000,
  baseMargin: 0.12,
  marginByCategory: Object.freeze({}),
  qtyDiscounts: Object.freeze([
    { minQty: 100, points: 0.06 },
    { minQty: 10, points: 0.03 },
  ]),
  marginFloor: 0.03,
  paymentRate: 0.02,
  defaultWeightKg: 1, // utilisé seulement en ESTIMATION (poids inconnu)
});

const PRICE_STATES = Object.freeze(['CALCULE', 'ESTIMATION', 'DEVIS_REQUIS']);
const MODES = Object.freeze(['air', 'sea', 'groupage']);

function roundToThousand(n) {
  return Math.round(n / 1000) * 1000;
}

function mergeConfig(overrides = {}) {
  const c = {
    ...DEFAULT_CONFIG,
    ...overrides,
    rates: { ...DEFAULT_CONFIG.rates, ...(overrides.rates || {}) },
    freightPerKg: { ...DEFAULT_CONFIG.freightPerKg, ...(overrides.freightPerKg || {}) },
    customsRateByCategory: { ...(overrides.customsRateByCategory || {}) },
    marginByCategory: { ...(overrides.marginByCategory || {}) },
    qtyDiscounts: overrides.qtyDiscounts || DEFAULT_CONFIG.qtyDiscounts,
  };
  return c;
}

function toGnfUnitPrice(supplierPrice, currency, rates) {
  if (currency === 'GNF') return supplierPrice;
  if (currency === 'USD') return supplierPrice * rates.USD_GNF;
  if (currency === 'CNY') return supplierPrice * rates.CNY_GNF;
  throw new Error(`Devise inconnue : ${currency} (attendu USD|CNY|GNF)`);
}

function marginRateFor(category, qty, config) {
  const adj = (category && config.marginByCategory[category]) || 0;
  let discount = 0;
  for (const tier of config.qtyDiscounts) {
    if (qty >= tier.minQty && tier.points > discount) discount = tier.points;
  }
  return Math.max(config.marginFloor, config.baseMargin + adj - discount);
}

/**
 * Calcule UNE ligne (un produit × quantité × mode).
 * @returns {object} breakdown complet + finalPrice + priceState + estimationNotes
 */
function priceLine(input, configOverrides = {}) {
  const config = mergeConfig(configOverrides);
  const {
    supplierPrice = null, currency = 'USD', weightKg = null,
    qty = 1, mode = 'air', category = null,
  } = input || {};

  if (!MODES.includes(mode)) throw new Error(`Mode inconnu : ${mode} (attendu air|sea|groupage)`);
  if (!Number.isInteger(qty) || qty < 1) throw new Error('qty doit être un entier >= 1');

  // Pas de prix fournisseur -> DEVIS_REQUIS, aucun chiffre inventé.
  if (supplierPrice === null || supplierPrice === undefined || Number(supplierPrice) <= 0) {
    return {
      priceState: 'DEVIS_REQUIS', finalPrice: null,
      supplierCost: 0, shippingCost: 0, customsCost: 0, transitCost: 0,
      localDeliveryCost: 0, bgMargin: 0, paymentCost: 0, marginRate: 0,
      estimationNotes: ['Prix fournisseur manquant : prix sur devis.'],
      qty, mode,
    };
  }

  const estimationNotes = [];
  let w = weightKg;
  if (w === null || w === undefined || Number(w) <= 0) {
    w = config.defaultWeightKg;
    estimationNotes.push(`Poids inconnu : estimation sur ${w} kg (à confirmer).`);
  }

  const unitGnf = toGnfUnitPrice(Number(supplierPrice), currency, config.rates);
  const supplierCost = unitGnf * qty;
  const shippingCost = Number(w) * qty * config.freightPerKg[mode];
  const customsRate = (category && config.customsRateByCategory[category] !== undefined)
    ? config.customsRateByCategory[category]
    : config.customsRate;
  const customsCost = (supplierCost + shippingCost) * customsRate;
  const transitCost = supplierCost * (config.handlingRate + config.qcRate + config.transitRate);
  const localDeliveryCost = config.localDelivery; // par commande (appliqué 1× par ligne ici, dédupliqué au niveau commande)
  const subtotal = supplierCost + shippingCost + customsCost + transitCost + localDeliveryCost;
  const marginRate = marginRateFor(category, qty, config);
  const bgMargin = subtotal * marginRate;
  const paymentCost = (subtotal + bgMargin) * config.paymentRate;
  const finalPrice = roundToThousand(subtotal + bgMargin + paymentCost);

  return {
    priceState: estimationNotes.length ? 'ESTIMATION' : 'CALCULE',
    finalPrice,
    supplierCost: Math.round(supplierCost),
    shippingCost: Math.round(shippingCost),
    customsCost: Math.round(customsCost),
    transitCost: Math.round(transitCost),
    localDeliveryCost,
    bgMargin: Math.round(bgMargin),
    paymentCost: Math.round(paymentCost),
    marginRate,
    estimationNotes,
    qty, mode,
  };
}

/**
 * Calcule un panier : même moteur ligne par ligne, livraison locale comptée UNE fois.
 */
function priceCart(items, mode = 'air', configOverrides = {}) {
  const lines = (items || []).map((it) => priceLine({ ...it, mode: it.mode || mode }, configOverrides));
  if (lines.some((l) => l.priceState === 'DEVIS_REQUIS')) {
    return { priceState: 'DEVIS_REQUIS', finalPrice: null, lines };
  }
  // Livraison locale : 1× par commande (retirer les doublons des lignes suivantes).
  const config = mergeConfig(configOverrides);
  const localFee = config.localDelivery;
  let total = 0;
  lines.forEach((l, i) => { total += (l.finalPrice - (i > 0 ? localFee : 0)); });
  // Réaligner sur l'arrondi millier après déduplication.
  total = roundToThousand(total);
  const state = lines.some((l) => l.priceState === 'ESTIMATION') ? 'ESTIMATION' : 'CALCULE';
  return { priceState: state, finalPrice: total, lines };
}

module.exports = {
  DEFAULT_CONFIG, PRICE_STATES, MODES,
  mergeConfig, priceLine, priceCart, roundToThousand, marginRateFor,
};
