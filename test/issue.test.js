import test from 'node:test';
import assert from 'node:assert/strict';
import { IssueService } from '../src/services/issue-service.js';
import { isValidRut, normalizeRut } from '../src/domain/rut.js';

const config = {
  mode: 'development',
  issuer: {
    rut: '76000000-0',
    legalName: 'BOTILLERIA SAN PABLO SPA',
    activity: 'VENTA DE BEBIDAS',
    address: 'CONSTITUCION',
    commune: 'CONSTITUCION',
    city: 'CONSTITUCION',
    branchCode: ''
  }
};

const request = {
  idempotencyKey: 'tax-sale-1-boleta_afecta',
  documentType: 'boleta_afecta',
  sale: {
    id: 'sale-1',
    number: 'V-000001',
    subtotal: 12990,
    discount: 0,
    total: 12990,
    paymentMethod: 'cash',
    completedAt: '2026-08-31T20:00:00-04:00'
  },
  recipient: {},
  items: [{ sku: '780000000001', name: 'Producto prueba', quantity: 1, unitPrice: 12990, subtotal: 12990 }]
};

test('normaliza y valida RUT', () => {
  assert.equal(normalizeRut('12.345.678-5'), '12345678-5');
  assert.equal(isValidRut('12.345.678-5'), true);
  assert.equal(isValidRut('12.345.678-9'), false);
});

test('emite borrador idempotente para contrato Botillería San Pablo', () => {
  const service = new IssueService(config);
  const first = service.issue(request);
  const second = service.issue(structuredClone(request));
  assert.equal(first.status, 'processing');
  assert.equal(first.externalId, second.externalId);
  assert.match(first.xml, /<TipoDTE>39<\/TipoDTE>/);
  assert.match(first.xml, /<MedioPago>1<\/MedioPago>/);
  assert.match(first.xml, /TED pendiente de CAF/);
});

test('rechaza reutilización de idempotencyKey con otro monto', () => {
  const service = new IssueService(config);
  service.issue(request);
  const changed = structuredClone(request);
  changed.sale.total = 9990;
  changed.items[0].subtotal = 9990;
  changed.items[0].unitPrice = 9990;
  assert.throws(() => service.issue(changed), /idempotencyKey/);
});
