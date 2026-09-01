import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import forgeModule from 'node-forge';
import { IssueService } from '../src/services/issue-service.js';
import { FileFolioStore } from '../src/services/folio-store.js';
import { prepareCertificationSet, validateCertificationSet, certificationCaseRequest } from '../src/sii/certification-set.js';

const forge = forgeModule?.default || forgeModule;

function mockCaf39({ rut = '77808406-6', from = 1, to = 45 } = {}) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' }
  });
  const xml = `<?xml version="1.0" encoding="ISO-8859-1"?>\n<AUTORIZACION>\n<CAF version="1.0">\n<DA>\n<RE>${rut}</RE><RS>SOLUCIONES TI GOVAL LIMITADA</RS><TD>39</TD><RNG><D>${from}</D><H>${to}</H></RNG><FA>2026-08-31</FA><RSAPK><M>AA==</M><E>AQAB</E></RSAPK><IDK>100</IDK>\n</DA>\n<FRMA algoritmo="SHA1withRSA">VEVTVA==</FRMA>\n</CAF>\n<RSASK>${privateKey}</RSASK>\n<RSAPUBK>${publicKey}</RSAPUBK>\n</AUTORIZACION>`;
  return Buffer.from(xml, 'latin1').toString('base64');
}

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
  const attributes = [{ name: 'commonName', value: 'SOLVEA Fiscal Test' }, { name: 'countryName', value: 'CL' }];
  certificate.setSubject(attributes);
  certificate.setIssuer(attributes);
  certificate.sign(privateKey, forge.md.sha256.create());
  const p12 = forge.pkcs12.toPkcs12Asn1(privateKey, [certificate], password, { algorithm: '3des', friendlyName: 'SOLVEA Fiscal Test' });
  const der = forge.asn1.toDer(p12).getBytes();
  return Buffer.from(der, 'binary').toString('base64');
}

function buildConfig(stateDir, overrides = {}) {
  return {
    mode: 'certification',
    stateDir,
    timeZone: 'America/Santiago',
    ...overrides,
    sii: {
      networkEnabled: false,
      certificationSubmissionEnabled: false,
      authBaseUrl: 'https://apicert.sii.cl/recursos/v1',
      boletaBaseUrl: 'https://pangal.sii.cl/recursos/v1',
      timeoutMs: 5000,
      senderRut: '19105425-3',
      receiverRut: '60803000-K',
      resolutionDate: '2026-08-31',
      resolutionNumber: '0',
      ...overrides.sii
    },
    issuer: {
      rut: '77808406-6',
      legalName: 'SOLUCIONES TI GOVAL LIMITADA',
      activity: 'SERVICIOS DE TECNOLOGIA',
      address: 'PJE 13 128 EL FALUCHO',
      commune: 'CONSTITUCION',
      city: 'CONSTITUCION',
      branchCode: '',
      ...overrides.issuer
    },
    credentials: {
      certificatePfxBase64: createTestPfx(),
      certificatePassword: 'solvea-test',
      caf39Base64: mockCaf39(),
      caf41Base64: '',
      caf33Base64: '',
      caf34Base64: '',
      ...overrides.credentials
    }
  };
}

async function withCertificationConfig(overrides, handler) {
  const dir = await mkdtemp(path.join(tmpdir(), 'solvea-fiscal-lock-'));
  try {
    const config = buildConfig(dir, overrides);
    const folioStore = new FileFolioStore({ stateDir: dir });
    const issueService = new IssueService(config, { folioStore });
    return await handler({ config, issueService, folioStore });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('safety lock: con SII_CERTIFICATION_SUBMISSION_ENABLED=false, issue() no reserva folio', async () => {
  await withCertificationConfig({}, async ({ issueService }) => {
    await assert.rejects(
      () => issueService.issue(certificationCaseRequest(1)),
      (error) => { assert.equal(error.status, 423); return true; }
    );
    const usage = await issueService.folioUsage(39);
    assert.equal(usage.used, 0);
  });
});

test('con el lock activo, issue() reserva folio real', async () => {
  await withCertificationConfig({ sii: { certificationSubmissionEnabled: true } }, async ({ issueService }) => {
    const response = await issueService.issue(certificationCaseRequest(1));
    assert.equal(response.folio, '1');
    assert.equal(response.fiscalStage, 'dte_signed');
    const usage = await issueService.folioUsage(39);
    assert.equal(usage.used, 1);
  });
});

test('prepare() nunca reserva folio, sin importar el estado del lock', async () => {
  await withCertificationConfig({}, async ({ issueService }) => {
    for (let i = 0; i < 3; i += 1) {
      const prepared = await issueService.prepare(certificationCaseRequest(2));
      assert.equal(prepared.folioReserved, false);
      assert.equal(prepared.folioConsumed, 0);
      assert.ok(prepared.xml.includes('<TipoDTE>39</TipoDTE>'));
    }
    const usage = await issueService.folioUsage(39);
    assert.equal(usage.used, 0, 'prepare() no debe haber consumido folios');
  });
});

test('validateCertificationSet: set completo y config completa queda LISTO PARA EMISIÓN (sin consumir folios)', async () => {
  await withCertificationConfig({}, async ({ issueService, config }) => {
    const prepared = await prepareCertificationSet(issueService);
    assert.equal(prepared.length, 5);
    assert.ok(prepared.every((r) => r.error === null));
    const result = await validateCertificationSet(config, prepared);
    assert.equal(result.ready, true);
    assert.equal(result.verdict, 'SET LISTO PARA EMISIÓN');
    assert.ok(result.notes.some((n) => n.includes('RCOF')));
    const usage = await issueService.folioUsage(39);
    assert.equal(usage.used, 0);
  });
});

test('validateCertificationSet: reporta errores cuando falta el CAF', async () => {
  await withCertificationConfig({ credentials: { caf39Base64: '' } }, async ({ issueService, config }) => {
    const prepared = await prepareCertificationSet(issueService);
    const result = await validateCertificationSet(config, prepared);
    assert.equal(result.ready, false);
    assert.ok(result.errors.some((e) => e.includes('CAF 39')));
  });
});

function mockCaf33({ rut = '77808406-6', from = 1, to = 5 } = {}) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' }
  });
  const xml = `<?xml version="1.0" encoding="ISO-8859-1"?>\n<AUTORIZACION>\n<CAF version="1.0">\n<DA>\n<RE>${rut}</RE><RS>SOLUCIONES TI GOVAL LIMITADA</RS><TD>33</TD><RNG><D>${from}</D><H>${to}</H></RNG><FA>2026-08-31</FA><RSAPK><M>AA==</M><E>AQAB</E></RSAPK><IDK>100</IDK>\n</DA>\n<FRMA algoritmo="SHA1withRSA">VEVTVA==</FRMA>\n</CAF>\n<RSASK>${privateKey}</RSASK>\n<RSAPUBK>${publicKey}</RSAPUBK>\n</AUTORIZACION>`;
  return Buffer.from(xml, 'latin1').toString('base64');
}

test('factura (DTE 33/34) sigue bloqueada para envío real (HTTP 501)', async () => {
  await withCertificationConfig({
    sii: { networkEnabled: true, certificationSubmissionEnabled: true },
    credentials: { caf33Base64: mockCaf33() }
  }, async ({ issueService }) => {
    await assert.rejects(
      () => issueService.issue({
        idempotencyKey: 'factura-lock-test',
        documentType: 'factura_afecta',
        sale: { id: 'F-1', number: 'F-1', total: 1190, paymentMethod: 'efectivo', completedAt: '2026-09-01T12:00:00-04:00' },
        recipient: { rut: '77808406-6', legalName: 'Cliente Prueba', activity: 'Giro', address: 'Dir', commune: 'Comuna' },
        items: [{ name: 'Producto', quantity: 1, unitPrice: 1190, subtotal: 1190 }]
      }),
      (error) => { assert.equal(error.status, 501); assert.match(error.message, /factura/i); return true; }
    );
  });
});
