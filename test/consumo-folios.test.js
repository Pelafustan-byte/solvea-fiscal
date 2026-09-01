import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import forgeModule from 'node-forge';
import { extractPfxCredentials } from '../src/crypto/pfx.js';
import {
  buildUnsignedConsumoFolios,
  signConsumoFolios,
  verifyConsumoFoliosSignature,
  foliosToRanges
} from '../src/sii/consumo-folios.js';

const forge = forgeModule?.default || forgeModule;

function credentials(password = 'solvea-rcof-test') {
  const pair = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' }
  });
  const privateKey = forge.pki.privateKeyFromPem(pair.privateKey);
  const publicKey = forge.pki.publicKeyFromPem(pair.publicKey);
  const certificate = forge.pki.createCertificate();
  certificate.publicKey = publicKey;
  certificate.serialNumber = '05';
  certificate.validity.notBefore = new Date(Date.now() - 86400000);
  certificate.validity.notAfter = new Date(Date.now() + 365 * 86400000);
  const attrs = [{ name: 'commonName', value: 'SOLVEA RCOF Test' }, { name: 'countryName', value: 'CL' }];
  certificate.setSubject(attrs);
  certificate.setIssuer(attrs);
  certificate.sign(privateKey, forge.md.sha256.create());
  const p12 = forge.pkcs12.toPkcs12Asn1(privateKey, [certificate], password, { algorithm: '3des' });
  const pfx = Buffer.from(forge.asn1.toDer(p12).getBytes(), 'binary').toString('base64');
  return extractPfxCredentials({ pfxBase64: pfx, password });
}

function baseParams(overrides = {}) {
  return {
    documentoId: 'RCOF_CERT_778084066_20260901',
    issuerRut: '77.808.406-6',
    senderRut: '19.105.425-3',
    resolutionDate: '2026-08-31',
    resolutionNumber: 0,
    periodStart: '2026-09-01',
    periodEnd: '2026-09-01',
    secEnvio: 1,
    resumenes: [{
      documentType: 39,
      mntNeto: 43655,
      mntIva: 8295,
      mntExento: 2000,
      mntTotal: 53960,
      foliosEmitidos: 5,
      foliosAnulados: 0,
      foliosUtilizados: 5,
      rangoUtilizados: [{ inicial: 1, final: 5 }]
    }],
    ...overrides
  };
}

test('foliosToRanges agrupa folios consecutivos', () => {
  assert.deepEqual(foliosToRanges([1, 2, 3, 5, 6, 9]), [
    { inicial: 1, final: 3 },
    { inicial: 5, final: 6 },
    { inicial: 9, final: 9 }
  ]);
});

test('construye ConsumoFolios con los tags exactos del XSD oficial (ConsumoFolio_v10.xsd)', () => {
  const xml = buildUnsignedConsumoFolios(baseParams());
  assert.match(xml, /<ConsumoFolios xmlns="http:\/\/www\.sii\.cl\/SiiDte"[^>]*version="1\.0"/);
  assert.match(xml, /ConsumoFolio_v10\.xsd/);
  assert.match(xml, /<DocumentoConsumoFolios ID="RCOF_CERT_778084066_20260901">/);
  assert.match(xml, /<Caratula version="1\.0">/);
  assert.match(xml, /<RutEmisor>77808406-6<\/RutEmisor>/);
  assert.match(xml, /<RutEnvia>19105425-3<\/RutEnvia>/);
  assert.match(xml, /<FchResol>2026-08-31<\/FchResol><NroResol>0<\/NroResol>/);
  assert.match(xml, /<FchInicio>2026-09-01<\/FchInicio><FchFinal>2026-09-01<\/FchFinal>/);
  assert.match(xml, /<SecEnvio>1<\/SecEnvio>/);
  assert.match(xml, /<TmstFirmaEnv>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}<\/TmstFirmaEnv>/);
  assert.match(xml, /<TipoDocumento>39<\/TipoDocumento>/);
  assert.match(xml, /<MntNeto>43655<\/MntNeto><MntIva>8295<\/MntIva><MntExento>2000<\/MntExento><MntTotal>53960<\/MntTotal>/);
  assert.match(xml, /<FoliosEmitidos>5<\/FoliosEmitidos><FoliosAnulados>0<\/FoliosAnulados><FoliosUtilizados>5<\/FoliosUtilizados>/);
  assert.match(xml, /<RangoUtilizados><Inicial>1<\/Inicial><Final>5<\/Final><\/RangoUtilizados>/);
  assert.doesNotMatch(xml, /RangoAnulados/);
});

test('incluye RangoAnulados con folio individual (Final omitido) cuando corresponde', () => {
  const xml = buildUnsignedConsumoFolios(baseParams({
    resumenes: [{
      documentType: 39, mntTotal: 1000, foliosEmitidos: 4, foliosAnulados: 1, foliosUtilizados: 5,
      rangoUtilizados: [{ inicial: 1, final: 4 }],
      rangoAnulados: [{ inicial: 7 }]
    }]
  }));
  assert.match(xml, /<RangoAnulados><Inicial>7<\/Inicial><\/RangoAnulados>/);
});

test('rechaza si FoliosEmitidos + FoliosAnulados no cuadra con FoliosUtilizados', () => {
  assert.throws(() => buildUnsignedConsumoFolios(baseParams({
    resumenes: [{ documentType: 39, mntTotal: 100, foliosEmitidos: 3, foliosAnulados: 1, foliosUtilizados: 5, rangoUtilizados: [] }]
  })), /FoliosUtilizados/);
});

test('rechaza TipoDocumento fuera de 39/41/61', () => {
  assert.throws(() => buildUnsignedConsumoFolios(baseParams({
    resumenes: [{ documentType: 33, mntTotal: 100, foliosEmitidos: 1, foliosAnulados: 0, foliosUtilizados: 1, rangoUtilizados: [] }]
  })), /39, 41 o 61/);
});

test('rechaza más de 3 Resumen', () => {
  const one = baseParams().resumenes[0];
  assert.throws(() => buildUnsignedConsumoFolios(baseParams({ resumenes: [one, one, one, one] })), /máximo 3/);
});

test('firma ConsumoFolios con XMLDSIG y la verificación detecta manipulación', () => {
  const cert = credentials();
  const documentoId = 'RCOF_CERT_778084066_20260901';
  const unsigned = buildUnsignedConsumoFolios(baseParams({ documentoId }));
  const signed = signConsumoFolios({ xml: unsigned, credentials: cert, documentoId });
  assert.equal(signed.verified, true);
  assert.equal(verifyConsumoFoliosSignature(signed.xml, cert.certificatePem, documentoId).valid, true);

  const tampered = signed.xml.replace('<MntTotal>53960</MntTotal>', '<MntTotal>1</MntTotal>');
  assert.equal(verifyConsumoFoliosSignature(tampered, cert.certificatePem, documentoId).valid, false);
});
