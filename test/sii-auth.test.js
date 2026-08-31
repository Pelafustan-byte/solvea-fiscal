import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import forgeModule from 'node-forge';
import { extractPfxCredentials } from '../src/crypto/pfx.js';
import { SiiAuthClient, authBaseUrlForMode } from '../src/sii/auth-client.js';
import { signSeedXml, verifySignedSeed } from '../src/sii/seed-signature.js';

const forge = forgeModule?.default || forgeModule;

function testCredentials(password = 'solvea-auth-test') {
  const pair = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' }
  });
  const privateKey = forge.pki.privateKeyFromPem(pair.privateKey);
  const publicKey = forge.pki.publicKeyFromPem(pair.publicKey);
  const certificate = forge.pki.createCertificate();
  certificate.publicKey = publicKey;
  certificate.serialNumber = '02';
  certificate.validity.notBefore = new Date(Date.now() - 86400000);
  certificate.validity.notAfter = new Date(Date.now() + 365 * 86400000);
  const attrs = [
    { name: 'commonName', value: 'SOLVEA SII Auth Test' },
    { name: 'organizationName', value: 'SOLVEA' },
    { name: 'countryName', value: 'CL' }
  ];
  certificate.setSubject(attrs);
  certificate.setIssuer(attrs);
  certificate.sign(privateKey, forge.md.sha256.create());
  const p12 = forge.pkcs12.toPkcs12Asn1(privateKey, [certificate], password, { algorithm: '3des' });
  const pfxBase64 = Buffer.from(forge.asn1.toDer(p12).getBytes(), 'binary').toString('base64');
  return extractPfxCredentials({ pfxBase64, password });
}

test('firma semilla con URI vacía y transform enveloped-signature', () => {
  const credentials = testCredentials();
  const signed = signSeedXml({ seed: '030530912644', credentials });
  assert.equal(signed.verified, true);
  assert.match(signed.xml, /<getToken>/);
  assert.match(signed.xml, /<Semilla>030530912644<\/Semilla>/);
  assert.match(signed.xml, /<Reference URI="">/);
  assert.match(signed.xml, /http:\/\/www\.w3\.org\/2000\/09\/xmldsig#enveloped-signature/);
  assert.match(signed.xml, /http:\/\/www\.w3\.org\/2000\/09\/xmldsig#rsa-sha1/);
  assert.match(signed.xml, /http:\/\/www\.w3\.org\/2000\/09\/xmldsig#sha1/);
  assert.equal(/<getToken[^>]+\bId=/.test(signed.xml), false);
  assert.equal(verifySignedSeed(signed.xml, credentials.certificatePem).valid, true);

  const tampered = signed.xml.replace('030530912644', '999999999999');
  assert.equal(verifySignedSeed(tampered, credentials.certificatePem).valid, false);
});

test('cliente REST obtiene semilla, firma y solicita token sin exponer secretos', async () => {
  const credentials = testCredentials();
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (String(url).endsWith('/boleta.electronica.semilla')) {
      return new Response('<?xml version="1.0" encoding="UTF-8"?><SII:RESPUESTA xmlns:SII="http://www.sii.cl/XMLSchema"><SII:RESP_BODY><SEMILLA>030530912644</SEMILLA></SII:RESP_BODY><SII:RESP_HDR><ESTADO>0</ESTADO></SII:RESP_HDR></SII:RESPUESTA>', {
        status: 200,
        headers: { 'content-type': 'application/xml' }
      });
    }
    if (String(url).endsWith('/boleta.electronica.token')) {
      assert.equal(options.method, 'POST');
      assert.match(String(options.headers['content-type']), /application\/xml/);
      assert.match(String(options.body), /<Reference URI="">/);
      assert.equal(verifySignedSeed(String(options.body), credentials.certificatePem).valid, true);
      return new Response('<?xml version="1.0"?><SII:RESPUESTA xmlns:SII="http://www.sii.cl/XMLSchema"><SII:RESP_BODY><TOKEN>ABC123456789TOKEN</TOKEN></SII:RESP_BODY><SII:RESP_HDR><ESTADO>00</ESTADO></SII:RESP_HDR></SII:RESPUESTA>', {
        status: 200,
        headers: { 'content-type': 'application/xml' }
      });
    }
    return new Response('not found', { status: 404 });
  };

  const client = new SiiAuthClient({ baseUrl: 'https://apicert.sii.cl/recursos/v1/', fetchImpl, timeoutMs: 5000 });
  const auth = await client.authenticate(credentials);
  assert.equal(auth.seed, '030530912644');
  assert.equal(auth.token, 'ABC123456789TOKEN');
  assert.equal(auth.signedSeedVerified, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://apicert.sii.cl/recursos/v1/boleta.electronica.semilla');
  assert.equal(calls[0].options.headers.accept, 'application/xml');
  assert.equal(calls[1].url, 'https://apicert.sii.cl/recursos/v1/boleta.electronica.token');
});

test('rechaza estados SII de error y mantiene bases separadas por ambiente', async () => {
  const client = new SiiAuthClient({
    baseUrl: 'https://apicert.sii.cl/recursos/v1',
    fetchImpl: async () => new Response('<SII:RESPUESTA><RESP_BODY><GLOSA>Semilla rechazada</GLOSA></RESP_BODY><RESP_HDR><ESTADO>5</ESTADO></RESP_HDR></SII:RESPUESTA>', { status: 200 })
  });
  await assert.rejects(() => client.getSeed(), /sin SEMILLA|rechazó/);
  assert.equal(authBaseUrlForMode('certification'), 'https://apicert.sii.cl/recursos/v1');
  assert.equal(authBaseUrlForMode('production'), 'https://api.sii.cl/recursos/v1');
});
