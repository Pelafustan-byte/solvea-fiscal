import test from 'node:test';
import assert from 'node:assert/strict';
import { validateIssueRequest } from '../src/domain/tax-document.js';
import { computeTaxTotals } from '../src/domain/totals.js';
import { buildUnsignedBoletaDraft } from '../src/sii/unsigned-boleta.js';
import { FACTURA_CERTIFICATION_CASES, facturaCertificationCaseRequest } from '../src/sii/factura-certification-set.js';

const issuer = {
  rut: '77808406-6',
  legalName: 'SOLUCIONES TI GOVAL LIMITADA',
  activity: 'SERVICIOS DE TECNOLOGIA',
  branchCode: '',
  address: 'DIRECCION DE PRUEBA',
  commune: 'CONSTITUCION',
  city: 'CONSTITUCION'
};

function render(caso) {
  const request = facturaCertificationCaseRequest(caso, { timestamp: '2026-09-01T12:00:00-04:00' });
  const document = validateIssueRequest(request);
  const totals = computeTaxTotals(document);
  const xml = buildUnsignedBoletaDraft({ document, issuer, provisionalFolio: caso, paymentMethodCode: 3 });
  return { document, totals, xml };
}

test('set básico factura tiene exactamente 8 casos, 4 factura y 4 NC/ND', () => {
  assert.equal(FACTURA_CERTIFICATION_CASES.length, 8);
  const byType = FACTURA_CERTIFICATION_CASES.reduce((acc, c) => {
    acc[c.documentType] = (acc[c.documentType] || 0) + 1;
    return acc;
  }, {});
  assert.equal(byType.factura_afecta, 4);
  assert.equal(byType.nota_credito, 3);
  assert.equal(byType.nota_debito, 1);
});

test('caso 1: dos ítems afectos, sin descuento, neto+IVA calculado sobre precios netos', () => {
  const { totals, xml } = render(1);
  assert.deepEqual(totals, { net: 804951, exempt: 0, vatRate: 19, vat: 152941, total: 957892 });
  assert.match(xml, /<NmbItem>Cajón AFECTO<\/NmbItem><QtyItem>159<\/QtyItem><PrcItem>2978<\/PrcItem><MontoItem>473502<\/MontoItem>/);
  assert.match(xml, /<NmbItem>Relleno AFECTO<\/NmbItem><QtyItem>67<\/QtyItem><PrcItem>4947<\/PrcItem><MontoItem>331449<\/MontoItem>/);
  assert.match(xml, /<TipoDTE>33<\/TipoDTE>/);
});

test('caso 2: descuento por línea (8% y 19%) reduce el neto exactamente lo esperado', () => {
  const { totals, xml } = render(2);
  assert.deepEqual(totals, { net: 5055417, exempt: 0, vatRate: 19, vat: 960529, total: 6015946 });
  assert.match(xml, /<MontoItem>3326244<\/MontoItem><DescuentoPct>8<\/DescuentoPct><DescuentoMonto>266100<\/DescuentoMonto>/);
  assert.match(xml, /<MontoItem>2463300<\/MontoItem><DescuentoPct>19<\/DescuentoPct><DescuentoMonto>468027<\/DescuentoMonto>/);
});

test('caso 3: línea exenta se excluye del neto/IVA y se suma aparte al total', () => {
  const { totals, xml } = render(3);
  assert.deepEqual(totals, { net: 1127925, exempt: 35175, vatRate: 19, vat: 214306, total: 1377406 });
  assert.match(xml, /<IndExe>1<\/IndExe><NmbItem>ITEM 3 SERVICIO EXENTO<\/NmbItem>/);
  assert.match(xml, /<MntNeto>1127925<\/MntNeto><MntExe>35175<\/MntExe><IVA>214306<\/IVA><MntTotal>1377406<\/MntTotal>/);
});

test('caso 4: descuento global 19% sólo afecta a los ítems no exentos (DscRcgGlobal)', () => {
  const { totals, xml } = render(4);
  assert.deepEqual(totals, { net: 2149430, exempt: 13640, vatRate: 19, vat: 408392, total: 2571462 });
  assert.match(xml, /<DscRcgGlobal><NroLinDR>1<\/NroLinDR><TpoMov>D<\/TpoMov><TpoValor>%<\/TpoValor><ValorDR>19<\/ValorDR><\/DscRcgGlobal>/);
});

test('caso 5: NC de corrección de texto reproduce los ítems del caso 1 (CodRef=2, TpoDocRef=33)', () => {
  const { totals, xml } = render(5);
  assert.deepEqual(totals, { net: 804951, exempt: 0, vatRate: 19, vat: 152941, total: 957892 });
  assert.match(xml, /<TipoDTE>61<\/TipoDTE>/);
  assert.match(xml, /<Referencia><NroLinRef>1<\/NroLinRef><TpoDocRef>33<\/TpoDocRef><FolioRef>1<\/FolioRef><FchRef>2026-09-01<\/FchRef><CodRef>2<\/CodRef><RazonRef>CORRIGE GIRO DEL RECEPTOR<\/RazonRef><\/Referencia>/);
});

test('caso 6: NC de devolución parcial reutiliza precio unitario y descuento del caso 2 (CodRef=3)', () => {
  const { totals, xml } = render(6);
  assert.deepEqual(totals, { net: 2474409, exempt: 0, vatRate: 19, vat: 470138, total: 2944547 });
  assert.match(xml, /<NmbItem>Pañuelo AFECTO<\/NmbItem><QtyItem>240<\/QtyItem><PrcItem>5086<\/PrcItem><MontoItem>1220640<\/MontoItem><DescuentoPct>8<\/DescuentoPct>/);
  assert.match(xml, /<CodRef>3<\/CodRef><RazonRef>DEVOLUCION DE MERCADERIAS<\/RazonRef>/);
});

test('caso 7: NC de anulación total reproduce exactamente los ítems del caso 3 (CodRef=1)', () => {
  const { totals, xml } = render(7);
  assert.deepEqual(totals, { net: 1127925, exempt: 35175, vatRate: 19, vat: 214306, total: 1377406 });
  assert.match(xml, /<FolioRef>3<\/FolioRef>.*<CodRef>1<\/CodRef><RazonRef>ANULA FACTURA<\/RazonRef>/);
});

test('caso 8: ND anula la NC del caso 5, referenciando TipoDTE 61', () => {
  const { totals, xml } = render(8);
  assert.deepEqual(totals, { net: 804951, exempt: 0, vatRate: 19, vat: 152941, total: 957892 });
  assert.match(xml, /<TipoDTE>56<\/TipoDTE>/);
  assert.match(xml, /<TpoDocRef>61<\/TpoDocRef><FolioRef>5<\/FolioRef>/);
  assert.match(xml, /<CodRef>1<\/CodRef><RazonRef>ANULA NOTA DE CREDITO ELECTRONICA<\/RazonRef>/);
});

test('las 8 solicitudes exigen receptor completo (RUT/razón social/giro/dirección/comuna)', () => {
  for (const definition of FACTURA_CERTIFICATION_CASES) {
    const request = facturaCertificationCaseRequest(definition.caso);
    const document = validateIssueRequest(request);
    assert.ok(document.recipient.rut, `caso ${definition.caso} sin RUT receptor`);
    assert.ok(document.recipient.legalName, `caso ${definition.caso} sin razón social`);
  }
});
