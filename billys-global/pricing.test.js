/** Tests du moteur de prix — `node --test pricing.test.js`. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { priceLine, priceCart } = require('./pricing');

// Référence contrat : 1 000 USD / 2 kg / aérien = 11 978 000 GNF (config par défaut).
test('référence : 1000 USD / 2 kg / air = 11 978 000 GNF', () => {
  const r = priceLine({ supplierPrice: 1000, currency: 'USD', weightKg: 2, qty: 1, mode: 'air' });
  assert.equal(r.priceState, 'CALCULE');
  assert.equal(r.finalPrice, 11978000);
});

test('remise quantité : -3 pts dès 10, plancher 3 %', () => {
  const un = priceLine({ supplierPrice: 100, currency: 'USD', weightKg: 1, qty: 1, mode: 'sea' });
  const dix = priceLine({ supplierPrice: 100, currency: 'USD', weightKg: 1, qty: 10, mode: 'sea' });
  assert.ok(dix.marginRate < un.marginRate, 'la marge doit baisser avec la quantité');
  assert.equal(un.marginRate, 0.12);
  assert.equal(dix.marginRate, 0.09);
  const gros = priceLine({ supplierPrice: 100, currency: 'USD', weightKg: 1, qty: 1000, mode: 'sea' });
  assert.ok(gros.marginRate >= 0.03, 'plancher de marge respecté');
});

test('DEVIS_REQUIS sans prix, ESTIMATION sans poids, cohérence panier', () => {
  const devis = priceLine({ supplierPrice: 0, currency: 'USD', weightKg: 2, qty: 1, mode: 'air' });
  assert.equal(devis.priceState, 'DEVIS_REQUIS');
  assert.equal(devis.finalPrice, null);

  const est = priceLine({ supplierPrice: 50, currency: 'USD', weightKg: null, qty: 1, mode: 'air' });
  assert.equal(est.priceState, 'ESTIMATION');
  assert.ok(est.finalPrice > 0);

  const cart = priceCart([
    { supplierPrice: 1000, currency: 'USD', weightKg: 2, qty: 1 },
    { supplierPrice: 10, currency: 'USD', weightKg: 0.5, qty: 2 },
  ], 'air');
  assert.equal(cart.lines.length, 2);
  assert.equal(cart.priceState, 'CALCULE');
  // Livraison locale 1× : total panier = somme lignes − 15 000 (ré-arrondi).
  const sum = cart.lines[0].finalPrice + cart.lines[1].finalPrice - 15000;
  assert.ok(Math.abs(cart.finalPrice - Math.round(sum / 1000) * 1000) <= 1000);
});
