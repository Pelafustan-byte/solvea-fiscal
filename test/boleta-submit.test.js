import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import forgeModule from 'node-forge';
import { extractPfxCredentials } from '../src/crypto/pfx.js';
import { SiiBoletaClient, boletaBaseUrlForMode } from '../src/sii/boleta-client.js';
import { buildUnsignedEnvioBoleta, signEnvioBoleta, verifyEnvioBoletaSignature } from '../src/sii/envio-boleta.js';
import { FileSubmissionStore } from '../src/services/submission-store.js';

const forge = forgeModule?.default || forgeModule;

function credentials(password = 'solvea-submit-test') {
  const pair = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' }
  });
  const privateKey = forge.pki.privateKeyFromPem(pair.privateKey);
  const publicKey = forge.pki.publicKeyFromPem(pair.publicKey);
  const certificate = forge.pki.createCertificate();
  certificate.publicKey = publicKey;
  certificate.serialNumber = '03';
  certificate.validity.notBefore = new Date(Date.now() - 86400000);
  certificate.validity.notAfter = new Date(Date.now() + 365 * 86400000);
  const attrs = [{ name: 'commonName', value: 'SOLVEA Submit Test' }, { name: 'countryName', value: 'CL' }];
  certificate.setSubject(attrs);
  certificate.setIssuer(attrs);
  certificate.sign(privateKey, forge.md.sha256.create());
  const p12 = forge.pkcs12.toPkcs12Asn1(privateKey, [certificate], password, { algorithm: '3des' });
  const pfx = Buffer.from(forge.asn1.toDer(p12).getBytes(), 'binary').toString('base64');
  return extractPfxCredentials({ pfxBase64: pfx, password });
}

function dteFixture() {
  return `<?xml version="1.0" encoding="ISO-8859-1"?><DTE version="1.0"><Documento ID="F100T39"><Encabezado><IdDoc><TipoDTE>39</TipoDTE><Folio>100</Folio></IdDoc></Encabezado></Documento><Signature xmlns="http://www.w3.org/2000/09/xmldsig#"><SignedInfo/></Signature></DTE>`;
}

test('construye EnvioBOLETA v11 y firma SetDTE', () => {
  const cert = credentials();
  const setId = 'SetDocB0T39_100';
  const unsigned = buildUnsignedEnvioBoleta({
    dteXml: dteFixture(), documentType: 39,
    issuerRut: '76.000.000-0', senderRut: '12.345.678-5',
    resolutionDate: '2026-08-31', resolutionNumber: 0,
    setId, timestamp: '2026-08-31T23:40:00.000Z', timeZone: 'America/Santiago'
  });
  assert.match(unsigned, /<EnvioBOLETA xmlns="http:\/\/www\.sii\.cl\/SiiDte"/);
  assert.match(unsigned, /EnvioBOLETA_v11\.xsd/);
  assert.match(unsigned, /<RutEmisor>76000000-0<\/RutEmisor>/);
  assert.match(unsigned, /<RutEnvia>12345678-5<\/RutEnvia>/);
  assert.match(unsigned, /<RutReceptor>60803000-K<\/RutReceptor>/);
  assert.match(unsigned, /<TpoDTE>39<\/TpoDTE><NroDTE>1<\/NroDTE>/);
  const signed = signEnvioBoleta({ xml: unsigned, credentials: cert, setId });
  assert.equal(signed.verified, true);
  assert.equal(verifyEnvioBoletaSignature(signed.xml, cert.certificatePem, setId).valid, true);
  const tampered = signed.xml.replace('<NroDTE>1</NroDTE>', '<NroDTE>2</NroDTE>');
  assert.equal(verifyEnvioBoletaSignature(tampered, cert.certificatePem, setId).valid, false);
});

test('cliente boleta envía multipart con token y extrae Track ID', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (options.method === 'POST') {
      assert.equal(options.headers.cookie, 'TOKEN=TOKEN123456');
      assert.equal(options.body.get('rutSender'), '12345678');
      assert.equal(options.body.get('dvSender'), '5');
      assert.equal(options.body.get('rutCompany'), '76000000');
      assert.equal(options.body.get('dvCompany'), '0');
      const file = options.body.get('archivo');
      assert.equal(file.name, 'boleta-39-100.xml');
      assert.match(await file.text(), /<EnvioBOLETA/);
      return new Response(JSON.stringify({
        rut_emisor: '76000000-0', rut_envia: '12345678-5', trackid: 123456789012345,
        fecha_recepcion: '2026-08-31 20:45:00', estado: 'REC', file: 'boleta-39-100.xml'
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ trackid: '123456789012345', estado: 'EPR' }), { status: 200 });
  };
  const client = new SiiBoletaClient({ baseUrl: 'https://pangal.sii.cl/recursos/v1/', fetchImpl });
  const submitted = await client.submit({
    token: 'TOKEN123456', senderRut: '12345678-5', companyRut: '76000000-0',
    xml: '<EnvioBOLETA version="1.0"></EnvioBOLETA>', filename: 'boleta-39-100.xml'
  });
  assert.equal(submitted.trackId, '123456789012345');
  assert.equal(submitted.estado, 'REC');
  assert.equal(calls[0].url, 'https://pangal.sii.cl/recursos/v1/boleta.electronica.envio');

  await client.getSubmissionStatus({ token: 'TOKEN123456', companyRut: '76000000-0', trackId: submitted.trackId });
  assert.equal(calls[1].url, 'https://pangal.sii.cl/recursos/v1/boleta.electronica.envio/76000000-0-123456789012345');
  assert.equal(boletaBaseUrlForMode('certification'), 'https://pangal.sii.cl/recursos/v1');
  assert.equal(boletaBaseUrlForMode('production'), 'https://rahue.sii.cl/recursos/v1');
});

test('persiste estado submitting/submitted para evitar reenvío ciego tras reinicio', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'solvea-submit-'));
  try {
    const store = new FileSubmissionStore({ stateDir: dir });
    await store.put('sale-1', { payloadHash: 'abc', state: 'submitting', response: { fiscalStage: 'sii_submitting' } });
    const afterRestart = new FileSubmissionStore({ stateDir: dir });
    assert.equal((await afterRestart.get('sale-1')).state, 'submitting');
    await afterRestart.put('sale-1', { payloadHash: 'abc', state: 'submitted', trackId: '123456789012345', response: { fiscalStage: 'sii_submitted' } });
    const final = await store.get('sale-1');
    assert.equal(final.trackId, '123456789012345');
    assert.equal(final.response.fiscalStage, 'sii_submitted');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
