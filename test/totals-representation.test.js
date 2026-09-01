import test from 'node:test';
import assert from 'node:assert/strict';
import { computeTaxTotals, publicRepresentation } from '../src/domain/totals.js';
import { validateIssueRequest } from '../src/domain/tax-document.js';

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

test('boleta oculta receptor extendido en la representación pública (kind boleta)', () => {
  const value = publicRepresentation({ document: document(), issuer, folio: 12 });
  assert.equal(value.kind, 'boleta');
  assert.equal(value.recipient, undefined);
});

test('factura expone receptor extendido con email opcional en la representación', () => {
  const facturaDoc = validateIssueRequest({
    idempotencyKey: 'fac-email-1',
    documentType: 'factura_afecta',
    sale: { id: 'F-1', number: 'F-1', total: 1190, paymentMethod: 'efectivo', completedAt: '2026-09-01T12:00:00-04:00' },
    recipient: { rut: '77808406-6', legalName: 'Cliente SPA', activity: 'Giro', address: 'Dir 1', commune: 'Comuna', email: 'cliente@empresa.cl' },
    items: [{ name: 'Producto', quantity: 1, unitPrice: 1190, subtotal: 1190 }]
  });
  const value = publicRepresentation({ document: facturaDoc, issuer, folio: 5 });
  assert.equal(value.kind, 'factura');
  assert.equal(value.recipient.email, 'cliente@empresa.cl');
});

test('rechaza recipient.email con formato inválido', () => {
  assert.throws(() => validateIssueRequest({
    idempotencyKey: 'fac-email-bad',
    documentType: 'factura_afecta',
    sale: { id: 'F-2', number: 'F-2', total: 1190, paymentMethod: 'efectivo', completedAt: '2026-09-01T12:00:00-04:00' },
    recipient: { rut: '77808406-6', legalName: 'Cliente SPA', activity: 'Giro', address: 'Dir 1', commune: 'Comuna', email: 'no-es-un-correo' },
    items: [{ name: 'Producto', quantity: 1, unitPrice: 1190, subtotal: 1190 }]
  }), /email/);
});
