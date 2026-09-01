import test from 'node:test';
import assert from 'node:assert/strict';
import { computeTaxTotals, publicRepresentation } from '../src/domain/totals.js';

const issuer = {
  rut: '76123456-7',
  legalName: 'Empresa Demo SpA',
  activity: 'Comercio',
  address: 'Calle 1',
  commune: 'Constitucion',
  city: 'Constitucion'
};

function document({ code = 39, type = 'boleta_afecta', total = 22500, items } = {}) {
  return {
    documentCode: code,
    documentType: type,
    sale: { id: 'sale-1', number: '1001', total, paymentMethod: 'debit', completedAt: '2026-08-31T21:00:00-04:00' },
    items: items || [{ sku: 'A', name: 'Producto', quantity: 1, unitPrice: total, subtotal: total, exempt: false, unitMeasure: '' }]
  };
}

test('boleta afecta calcula neto e IVA sólo al final', () => {
  const totals = computeTaxTotals(document());
  assert.deepEqual(totals, { net: 18908, exempt: 0, vatRate: 19, vat: 3592, total: 22500 });
});

test('boleta exenta informa exento y total sin IVA', () => {
  const totals = computeTaxTotals(document({ code: 41, type: 'boleta_exenta', total: 3500 }));
  assert.deepEqual(totals, { net: 0, exempt: 3500, vatRate: 0, vat: 0, total: 3500 });
});

test('boleta mixta separa monto exento del afecto', () => {
  const totals = computeTaxTotals(document({
    total: 14720,
    items: [
      { name: 'Servicio afecto', quantity: 8, unitPrice: 1590, subtotal: 12720, exempt: false },
      { name: 'Servicio exento', quantity: 2, unitPrice: 1000, subtotal: 2000, exempt: true }
    ]
  }));
  assert.deepEqual(totals, { net: 10689, exempt: 2000, vatRate: 19, vat: 2031, total: 14720 });
});

test('representación conserva detalle de carrito y resumen tributario', () => {
  const value = publicRepresentation({ document: document(), issuer, folio: 12 });
  assert.equal(value.folio, '12');
  assert.equal(value.items.length, 1);
  assert.equal(value.items[0].subtotal, 22500);
  assert.deepEqual(value.totals, { net: 18908, exempt: 0, vatRate: 19, vat: 3592, total: 22500 });
  assert.equal(value.issuer.rut, issuer.rut);
});
