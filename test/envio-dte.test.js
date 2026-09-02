import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import forgeModule from 'node-forge';
import { extractPfxCredentials } from '../src/crypto/pfx.js';
import { buildUnsignedEnvioDte, buildUnsignedEnvioDteSet, signEnvioDte, verifyEnvioDteSignature } from '../src/sii/envio-dte.js';

const forge = forgeModule?.default || forgeModule;

function credentials(password = 'solvea-envio-dte-test') {
  const pair = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' }
  });
  const privateKey = forge.pki.privateKeyFromPem(pair.privateKey);
  const publicKey = forge.pki.publicKeyFromPem(pair.publicKey);
  const certificate = forge.pki.createCertificate();
  certificate.publicKey = publicKey;
  certificate.serialNumber = '04';
  certificate.validity.notBefore = new Date(Date.now() - 86400000);
  certificate.validity.notAfter = new Date(Date.now() + 365 * 86400000);
  const attrs = [{ name: 'commonName', value: 'SOLVEA EnvioDTE Test' }, { name: 'countryName', value: 'CL' }];
  certificate.setSubject(attrs);
  certificate.setIssuer(attrs);
  certificate.sign(privateKey, forge.md.sha256.create());
  const p12 = forge.pkcs12.toPkcs12Asn1(privateKey, [certificate], password, { algorithm: '3des' });
  const pfx = Buffer.from(forge.asn1.toDer(p12).getBytes(), 'binary').toString('base64');
  return extractPfxCredentials({ pfxBase64: pfx, password });
}

function dteFixture(documentCode, folio) {
  return `<?xml version="1.0" encoding="ISO-8859-1"?><DTE version="1.0"><Documento ID="F${folio}T${documentCode}"><Encabezado><IdDoc><TipoDTE>${documentCode}</TipoDTE><Folio>${folio}</Folio></IdDoc></Encabezado></Documento><Signature xmlns="http://www.w3.org/2000/09/xmldsig#"><SignedInfo/></Signature></DTE>`;
}

test('construye EnvioDTE (root genérico, no EnvioBOLETA) y firma SetDTE', () => {
  const cert = credentials();
  const setId = 'SetDocDTE_33_1';
  const unsigned = buildUnsignedEnvioDte({
    dteXml: dteFixture(33, 1),
    issuerRut: '77.808.406-6', senderRut: '19.105.425-3',
    resolutionDate: '2026-08-31', resolutionNumber: 0,
    setId, timestamp: '2026-08-31T23:40:00.000Z', timeZone: 'America/Santiago'
  });
  assert.match(unsigned, /<EnvioDTE xmlns="http:\/\/www\.sii\.cl\/SiiDte"/);
  assert.match(unsigned, /EnvioDTE\.xsd/);
  assert.doesNotMatch(unsigned, /EnvioBOLETA/);
  assert.match(unsigned, /<RutEmisor>77808406-6<\/RutEmisor>/);
  assert.match(unsigned, /<RutEnvia>19105425-3<\/RutEnvia>/);
  assert.match(unsigned, /<TpoDTE>33<\/TpoDTE><NroDTE>1<\/NroDTE>/);
  const signed = signEnvioDte({ xml: unsigned, credentials: cert, setId });
  assert.equal(signed.verified, true);
  assert.equal(verifyEnvioDteSignature(signed.xml, cert.certificatePem, setId).valid, true);
  const tampered = signed.xml.replace('<NroDTE>1</NroDTE>', '<NroDTE>2</NroDTE>');
  assert.equal(verifyEnvioDteSignature(tampered, cert.certificatePem, setId).valid, false);
});

test('empaqueta varios DTE de distinto TipoDTE (Factura + NC + ND) en un solo EnvioDTE', () => {
  const cert = credentials();
  const setId = 'SetFacturaCertificacion_8casos';
  const dtes = [
    dteFixture(33, 1), dteFixture(33, 2), dteFixture(33, 3), dteFixture(33, 4),
    dteFixture(61, 1), dteFixture(61, 2), dteFixture(61, 3),
    dteFixture(56, 1)
  ];
  const unsigned = buildUnsignedEnvioDteSet({
    dteXmlList: dtes,
    issuerRut: '77.808.406-6', senderRut: '19.105.425-3',
    resolutionDate: '2026-08-31', resolutionNumber: 0,
    setId, timestamp: '2026-08-31T23:40:00.000Z', timeZone: 'America/Santiago'
  });
  assert.match(unsigned, /<TpoDTE>33<\/TpoDTE><NroDTE>4<\/NroDTE>/);
  assert.match(unsigned, /<TpoDTE>56<\/TpoDTE><NroDTE>1<\/NroDTE>/);
  assert.match(unsigned, /<TpoDTE>61<\/TpoDTE><NroDTE>3<\/NroDTE>/);
  assert.equal((unsigned.match(/<Documento ID="F\d+T\d+">/g) || []).length, 8);
  const signed = signEnvioDte({ xml: unsigned, credentials: cert, setId });
  assert.equal(signed.verified, true);
  assert.equal(verifyEnvioDteSignature(signed.xml, cert.certificatePem, setId).valid, true);
});
