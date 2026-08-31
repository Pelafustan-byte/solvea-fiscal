import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import forgeModule from 'node-forge';
import { extractPfxCredentials } from '../src/crypto/pfx.js';
import { signDteXml, verifyDteSignature, XMLDSIG } from '../src/sii/xml-signature.js';

const forge = forgeModule?.default || forgeModule;

function createTestPfx(password = 'solvea-test') {
  const pair = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' }
  });
  const privateKey = forge.pki.privateKeyFromPem(pair.privateKey);
  const publicKey = forge.pki.publicKeyFromPem(pair.publicKey);
  const certificate = forge.pki.createCertificate();
  certificate.publicKey = publicKey;
  certificate.serialNumber = '01';
  certificate.validity.notBefore = new Date(Date.now() - 24 * 60 * 60 * 1000);
  certificate.validity.notAfter = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
  const attributes = [
    { name: 'commonName', value: 'SOLVEA Fiscal Test' },
    { name: 'organizationName', value: 'SOLVEA' },
    { name: 'countryName', value: 'CL' }
  ];
  certificate.setSubject(attributes);
  certificate.setIssuer(attributes);
  certificate.sign(privateKey, forge.md.sha256.create());

  const p12 = forge.pkcs12.toPkcs12Asn1(privateKey, [certificate], password, {
    algorithm: '3des',
    friendlyName: 'SOLVEA Fiscal Test'
  });
  const der = forge.asn1.toDer(p12).getBytes();
  return Buffer.from(der, 'binary').toString('base64');
}

test('extrae llave privada y certificado vigente desde PFX', () => {
  const pfxBase64 = createTestPfx();
  const credentials = extractPfxCredentials({ pfxBase64, password: 'solvea-test' });
  assert.match(credentials.privateKeyPem, /BEGIN RSA PRIVATE KEY|BEGIN PRIVATE KEY/);
  assert.match(credentials.certificatePem, /BEGIN CERTIFICATE/);
  assert.equal(credentials.exponentBase64, 'AQAB');
  assert.ok(credentials.modulusBase64.length > 100);
  assert.match(credentials.fingerprint256, /:/);
  assert.throws(() => extractPfxCredentials({ pfxBase64, password: 'incorrecta' }), /PFX|contraseña/);
});

test('firma Documento con estructura XMLDSIG compatible con SII y verifica la referencia', () => {
  const credentials = extractPfxCredentials({ pfxBase64: createTestPfx(), password: 'solvea-test' });
  const xml = `<?xml version="1.0" encoding="ISO-8859-1"?>\n<DTE version="1.0">\n<Documento ID="F100T39"><Encabezado><IdDoc><TipoDTE>39</TipoDTE><Folio>100</Folio></IdDoc></Encabezado><TED version="1.0"><DD><RE>76000000-0</RE><TD>39</TD><F>100</F></DD><FRMT algoritmo="SHA1withRSA">VEVTVA==</FRMT></TED><TmstFirma>2026-08-31T20:00:00</TmstFirma></Documento>\n</DTE>`;
  const signed = signDteXml({ xml, credentials });

  assert.equal(signed.verified, true);
  assert.equal(signed.documentId, 'F100T39');
  assert.equal(signed.algorithms.canonicalization, XMLDSIG.canonicalization);
  assert.match(signed.xml, /<Signature xmlns="http:\/\/www\.w3\.org\/2000\/09\/xmldsig#">/);
  assert.match(signed.xml, /<CanonicalizationMethod Algorithm="http:\/\/www\.w3\.org\/TR\/2001\/REC-xml-c14n-20010315"\s*\/>/);
  assert.match(signed.xml, /<SignatureMethod Algorithm="http:\/\/www\.w3\.org\/2000\/09\/xmldsig#rsa-sha1"\s*\/>/);
  assert.match(signed.xml, /<Reference URI="#F100T39">/);
  assert.match(signed.xml, /<Transform Algorithm="http:\/\/www\.w3\.org\/TR\/2001\/REC-xml-c14n-20010315"\s*\/>/);
  assert.match(signed.xml, /<DigestMethod Algorithm="http:\/\/www\.w3\.org\/2000\/09\/xmldsig#sha1"\s*\/>/);
  assert.ok(signed.xml.indexOf('<KeyValue>') < signed.xml.indexOf('<X509Data>'));
  assert.match(signed.xml, /<RSAKeyValue>/);
  assert.match(signed.xml, /<Modulus>[\s\S]+<\/Modulus>/);
  assert.match(signed.xml, /<Exponent>AQAB<\/Exponent>/);
  assert.match(signed.xml, /<X509Certificate>[\s\S]+<\/X509Certificate>/);

  const verification = verifyDteSignature(signed.xml, credentials.certificatePem, 'F100T39');
  assert.equal(verification.valid, true);
  assert.equal(verification.signedReferences.length, 1);
  assert.match(verification.signedReferences[0], /<Documento ID="F100T39">/);
});

test('la firma deja de ser válida si se altera el monto firmado', () => {
  const credentials = extractPfxCredentials({ pfxBase64: createTestPfx(), password: 'solvea-test' });
  const xml = `<DTE version="1.0"><Documento ID="F5T39"><Encabezado><Totales><MntTotal>1000</MntTotal></Totales></Encabezado><TmstFirma>2026-08-31T20:00:00</TmstFirma></Documento></DTE>`;
  const signed = signDteXml({ xml, credentials });
  const tampered = signed.xml.replace('<MntTotal>1000</MntTotal>', '<MntTotal>9000</MntTotal>');
  assert.equal(verifyDteSignature(tampered, credentials.certificatePem, 'F5T39').valid, false);
});
