import test from 'node:test';
import assert from 'node:assert/strict';
import { validateIssueRequest } from '../src/domain/tax-document.js';
import { buildUnsignedBoletaDraft } from '../src/sii/unsigned-boleta.js';

const issuer = {
  rut: '77808406-6',
  legalName: 'SOLUCIONES TI GOVAL LIMITADA',
  activity: 'SERVICIOS DE TECNOLOGIA',
  branchCode: '',
  address: 'DIRECCION DE PRUEBA',
  commune: 'CONSTITUCION',
  city: 'CONSTITUCION'
};

function render(caseNumber, items) {
  const total = items.reduce((sum, item) => sum + item.subtotal, 0);
  const document = validateIssueRequest({
    idempotencyKey: `set-be-${caseNumber}`,
    documentType: 'boleta_afecta',
    sale: {
      id: `SET-${caseNumber}`,
      number: `SET-${caseNumber}`,
      total,
      paymentMethod: 'efectivo',
      completedAt: '2026-08-31T12:00:00-04:00'
    },
    items,
    reference: { code: 'SET', reason: `CASO-${caseNumber}` }
  });
  return buildUnsignedBoletaDraft({ document, issuer, provisionalFolio: caseNumber, paymentMethodCode: 1 });
}

test('set SII BE casos 1 a 3 conserva textos, cantidades, precios y referencia exacta', () => {
  const caso1 = render(1, [
    { name: 'Cambio de aceite', quantity: 1, unitPrice: 19900, subtotal: 19900 },
    { name: 'Alineacion y balanceo', quantity: 1, unitPrice: 9900, subtotal: 9900 }
  ]);
  assert.match(caso1, /<NmbItem>Cambio de aceite<\/NmbItem>/);
  assert.match(caso1, /<NmbItem>Alineacion y balanceo<\/NmbItem>/);
  assert.match(caso1, /<MntTotal>29800<\/MntTotal>/);
  assert.match(caso1, /<CodRef>SET<\/CodRef><RazonRef>CASO-1<\/RazonRef>/);

  const caso2 = render(2, [
    { name: 'Papel de regalo', quantity: 17, unitPrice: 120, subtotal: 2040 }
  ]);
  assert.match(caso2, /<QtyItem>17<\/QtyItem><PrcItem>120<\/PrcItem><MontoItem>2040<\/MontoItem>/);
  assert.match(caso2, /<MntTotal>2040<\/MntTotal>/);
  assert.match(caso2, /<RazonRef>CASO-2<\/RazonRef>/);

  const caso3 = render(3, [
    { name: 'Sandwic', quantity: 2, unitPrice: 1500, subtotal: 3000 },
    { name: 'Bebida', quantity: 2, unitPrice: 550, subtotal: 1100 }
  ]);
  assert.match(caso3, /<NmbItem>Sandwic<\/NmbItem>/);
  assert.match(caso3, /<NmbItem>Bebida<\/NmbItem>/);
  assert.match(caso3, /<MntTotal>4100<\/MntTotal>/);
  assert.match(caso3, /<RazonRef>CASO-3<\/RazonRef>/);
});

test('caso 4 informa línea exenta y separa MntNeto, MntExe, IVA y total', () => {
  const xml = render(4, [
    { name: 'item afecto 1', quantity: 8, unitPrice: 1590, subtotal: 12720 },
    { name: 'item exento 2', quantity: 2, unitPrice: 1000, subtotal: 2000, exempt: true }
  ]);

  assert.match(xml, /<NmbItem>item afecto 1<\/NmbItem>/);
  assert.match(xml, /<IndExe>1<\/IndExe><NmbItem>item exento 2<\/NmbItem>/);
  assert.match(xml, /<MntNeto>10689<\/MntNeto><MntExe>2000<\/MntExe><IVA>2031<\/IVA><MntTotal>14720<\/MntTotal>/);
  assert.match(xml, /<RazonRef>CASO-4<\/RazonRef>/);
});

test('caso 5 informa unidad de medida Kg. exactamente', () => {
  const xml = render(5, [
    { name: 'Arroz', quantity: 5, unitPrice: 700, subtotal: 3500, unitMeasure: 'Kg.' }
  ]);

  assert.match(xml, /<NmbItem>Arroz<\/NmbItem><QtyItem>5<\/QtyItem><UnmdItem>Kg\.<\/UnmdItem><PrcItem>700<\/PrcItem>/);
  assert.match(xml, /<MntTotal>3500<\/MntTotal>/);
  assert.match(xml, /<RazonRef>CASO-5<\/RazonRef>/);
});

test('boleta exenta marca sus líneas como exentas y usa MntExe', () => {
  const document = validateIssueRequest({
    idempotencyKey: 'boleta-exenta-shape',
    documentType: 'boleta_exenta',
    sale: { id: 'EX-1', number: 'EX-1', total: 1000, paymentMethod: 'efectivo' },
    items: [{ name: 'Servicio exento', quantity: 1, unitPrice: 1000, subtotal: 1000 }]
  });
  const xml = buildUnsignedBoletaDraft({ document, issuer, provisionalFolio: 10, paymentMethodCode: 1 });
  assert.match(xml, /<TipoDTE>41<\/TipoDTE>/);
  assert.match(xml, /<IndExe>1<\/IndExe>/);
  assert.match(xml, /<Totales><MntExe>1000<\/MntExe><MntTotal>1000<\/MntTotal><\/Totales>/);
  assert.doesNotMatch(xml, /<IVA>/);
});
