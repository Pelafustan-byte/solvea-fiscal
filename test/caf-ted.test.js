import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseCaf, assertCafCompatible } from '../src/sii/caf.js';
import { buildTed, verifyTedSignature } from '../src/sii/ted.js';
import { FileFolioStore } from '../src/services/folio-store.js';

function mockAuthorization({ rut = '76000000-0', type = 39, from = 100, to = 102 } = {}) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' }
  });
  const xml = `<?xml version="1.0" encoding="ISO-8859-1"?>\n<AUTORIZACION>\n<CAF version="1.0">\n<DA>\n<RE>${rut}</RE><RS>BOTILLERIA SAN PABLO SPA</RS><TD>${type}</TD><RNG><D>${from}</D><H>${to}</H></RNG><FA>2026-08-31</FA><RSAPK><M>AA==</M><E>AQAB</E></RSAPK><IDK>100</IDK>\n</DA>\n<FRMA algoritmo="SHA1withRSA">VEVTVA==</FRMA>\n</CAF>\n<RSASK>${privateKey}</RSASK>\n<RSAPUBK>${publicKey}</RSAPUBK>\n</AUTORIZACION>`;
  return { xml, privateKey, publicKey };
}

const document = {
  documentType: 'boleta_afecta',
  documentCode: 39,
  sale: { id: 'sale-caf-1', number: 'V-CAF-1', total: 12990, completedAt: '2026-08-31T20:00:00-04:00' },
  recipient: {},
  items: [{ sku: 'SKU-1', name: 'Bebida limón & hielo', quantity: 1, unitPrice: 12990, subtotal: 12990 }]
};

const issuer = {
  rut: '76000000-0',
  legalName: 'BOTILLERIA SAN PABLO SPA',
  activity: 'VENTA DE BEBIDAS',
  address: 'CONSTITUCION',
  commune: 'CONSTITUCION',
  city: 'CONSTITUCION',
  branchCode: ''
};

test('parsea CAF, preserva el bloque y verifica el par de llaves', () => {
  const { xml } = mockAuthorization();
  const caf = parseCaf(xml);
  assert.equal(caf.rut, '76000000-0');
  assert.equal(caf.documentType, 39);
  assert.equal(caf.from, 100);
  assert.equal(caf.to, 102);
  assert.match(caf.cafXml, /^<CAF version="1.0">/);
  assert.doesNotThrow(() => assertCafCompatible(caf, { issuerRut: issuer.rut, documentType: 39 }));
  assert.throws(() => assertCafCompatible(caf, { issuerRut: issuer.rut, documentType: 41 }), /TipoDTE/);
});

test('genera TED SHA1withRSA verificable e incluye CAF', () => {
  const caf = parseCaf(mockAuthorization().xml);
  const ted = buildTed({
    document,
    issuer,
    caf,
    folio: 100,
    timestamp: '2026-08-31T23:45:12.000Z',
    timeZone: 'America/Santiago'
  });
  assert.match(ted.tedXml, /<TED version="1.0">/);
  assert.match(ted.tedXml, /<TD>39<\/TD><F>100<\/F>/);
  assert.match(ted.tedXml, /<RSR>Consumidor Final<\/RSR>/);
  assert.match(ted.tedXml, /<IT1>Bebida limón &amp; hielo<\/IT1>/);
  assert.ok(ted.tedXml.includes(caf.cafXml));
  assert.equal(verifyTedSignature({ ddXml: ted.ddXml, signatureBase64: ted.signatureBase64, publicKeyPem: caf.publicKeyPem }), true);
});

test('reserva folios distintos, persiste e idempotentiza en archivo', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'solvea-fiscal-'));
  try {
    const caf = parseCaf(mockAuthorization({ from: 200, to: 202 }).xml);
    const store = new FileFolioStore({ stateDir: dir });
    const [a, b] = await Promise.all([
      store.reserve({ caf, idempotencyKey: 'sale-a', payloadHash: 'hash-a', timestamp: '2026-08-31T20:00:00Z' }),
      store.reserve({ caf, idempotencyKey: 'sale-b', payloadHash: 'hash-b', timestamp: '2026-08-31T20:00:01Z' })
    ]);
    assert.deepEqual(new Set([a.folio, b.folio]), new Set([200, 201]));

    const again = await store.reserve({ caf, idempotencyKey: 'sale-a', payloadHash: 'hash-a', timestamp: '2099-01-01T00:00:00Z' });
    assert.equal(again.folio, a.folio);
    assert.equal(again.timestamp, a.timestamp);
    await assert.rejects(() => store.reserve({ caf, idempotencyKey: 'sale-a', payloadHash: 'changed', timestamp: '2026-08-31T20:00:02Z' }), /idempotencyKey/);

    const raw = JSON.parse(await readFile(path.join(dir, 'folio-state.json'), 'utf8'));
    assert.equal(Object.keys(raw.reservations).length, 2);
    assert.equal(raw.nextByCaf[caf.id], 202);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
