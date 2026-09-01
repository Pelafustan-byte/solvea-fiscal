import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import forgeModule from 'node-forge';
import { extractPfxCredentials } from '../src/crypto/pfx.js';
import { CertificationSubmissionService, certificationRunId } from '../src/services/certification-submission-service.js';
import { FileFolioStore } from '../src/services/folio-store.js';
import { FileCertificationRunStore } from '../src/services/certification-run-store.js';
import { configuredCaf } from '../src/services/issue-service.js';
import { buildUnsignedEnvioBoletaSet, signEnvioBoleta } from '../src/sii/envio-boleta.js';

const require = createRequire(import.meta.url);
const { DOMParser } = require('@xmldom/xmldom');
const xpath = require('xpath');

const forge = forgeModule?.default || forgeModule;

function mockCaf39({ rut = '77808406-6', from = 46, to = 50 } = {}) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' }
  });
  const xml = `<?xml version="1.0" encoding="ISO-8859-1"?>\n<AUTORIZACION>\n<CAF version="1.0">\n<DA>\n<RE>${rut}</RE><RS>SOLUCIONES TI GOVAL LIMITADA</RS><TD>39</TD><RNG><D>${from}</D><H>${to}</H></RNG><FA>2026-09-01</FA><RSAPK><M>AA==</M><E>AQAB</E></RSAPK><IDK>100</IDK>\n</DA>\n<FRMA algoritmo="SHA1withRSA">VEVTVA==</FRMA>\n</CAF>\n<RSASK>${privateKey}</RSASK>\n<RSAPUBK>${publicKey}</RSAPUBK>\n</AUTORIZACION>`;
  return Buffer.from(xml, 'latin1').toString('base64');
}

function createTestPfx(password = 'solvea-cert-submit-test') {
  const pair = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' }
  });
  const privateKey = forge.pki.privateKeyFromPem(pair.privateKey);
  const publicKey = forge.pki.publicKeyFromPem(pair.publicKey);
  const certificate = forge.pki.createCertificate();
  certificate.publicKey = publicKey;
  certificate.serialNumber = '07';
  certificate.validity.notBefore = new Date(Date.now() - 86400000);
  certificate.validity.notAfter = new Date(Date.now() + 365 * 86400000);
  const attrs = [{ name: 'commonName', value: 'SOLVEA Cert Submit Test' }, { name: 'countryName', value: 'CL' }];
  certificate.setSubject(attrs);
  certificate.setIssuer(attrs);
  certificate.sign(privateKey, forge.md.sha256.create());
  const p12 = forge.pkcs12.toPkcs12Asn1(privateKey, [certificate], password, { algorithm: '3des' });
  const pfx = Buffer.from(forge.asn1.toDer(p12).getBytes(), 'binary').toString('base64');
  return pfx;
}

function buildConfig(stateDir, overrides = {}) {
  return {
    mode: 'certification',
    stateDir,
    timeZone: 'America/Santiago',
    ...overrides,
    sii: {
      networkEnabled: true,
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
      certificatePassword: 'solvea-cert-submit-test',
      caf39Base64: mockCaf39(),
      caf41Base64: '',
      caf33Base64: '',
      caf34Base64: '',
      ...overrides.credentials
    }
  };
}

function fakeAuthClient(token = 'fake-token-123') {
  return { authenticate: async () => ({ token, seed: '1', signedSeedVerified: true, obtainedAt: new Date().toISOString() }) };
}

function fakeBoletaClient({ trackId = '123456789012345', shouldFail = false, status } = {}) {
  return {
    submit: async () => {
      if (shouldFail) throw new Error('network down (simulado)');
      return { trackId, estado: 'REC', receivedAt: new Date().toISOString(), file: 'set.xml', issuerRut: '77808406-6', senderRut: '19105425-3' };
    },
    getSubmissionStatus: async () => status || { trackId, estado: 'EPR', glosa: '', accepted: false, rejected: false, final: false, informados: 5, aceptados: null, rechazados: null, reparos: null, raw: {} }
  };
}

async function withEnv(overrides, handler) {
  const dir = await mkdtemp(path.join(tmpdir(), 'solvea-fiscal-cert-submit-'));
  try {
    const config = buildConfig(dir, overrides);
    const folioStore = new FileFolioStore({ stateDir: dir });
    const runStore = new FileCertificationRunStore({ stateDir: dir });
    return await handler({ config, folioStore, runStore, dir });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('safety lock: submit() no reserva folios ni llama a la red si certificationSubmissionEnabled=false', async () => {
  await withEnv({}, async ({ config, folioStore, runStore }) => {
    const authClient = fakeAuthClient();
    let uploadCalled = false;
    const boletaClient = { submit: async () => { uploadCalled = true; return {}; }, getSubmissionStatus: async () => ({}) };
    const service = new CertificationSubmissionService(config, { folioStore, runStore, authClient, boletaClient });

    await assert.rejects(() => service.submit(), (error) => { assert.equal(error.status, 423); return true; });
    assert.equal(uploadCalled, false);

    const caf = configuredCaf(config, 39);
    const usage = await folioStore.peek({ caf });
    assert.equal(usage.used, 0);
    const run = await service.getRun(certificationRunId(caf));
    assert.equal(run, null);
  });
});

test('reserveSet: exige el lock igual que submit() (consume folios reales)', async () => {
  await withEnv({}, async ({ config, folioStore, runStore }) => {
    const service = new CertificationSubmissionService(config, { folioStore, runStore });
    await assert.rejects(() => service.reserveSet(), (error) => { assert.equal(error.status, 423); return true; });
  });
});

test('con el lock activo: reserva exactamente 46-50, contiguos, y arma el mapping CASO-i -> folio', async () => {
  await withEnv({ sii: { certificationSubmissionEnabled: true } }, async ({ config, folioStore, runStore }) => {
    const service = new CertificationSubmissionService(config, { folioStore, runStore });
    const run = await service.reserveSet();
    assert.equal(run.folioFrom, 46);
    assert.equal(run.folioTo, 50);
    assert.deepEqual(run.mapping.map((m) => m.folio), [46, 47, 48, 49, 50]);
    assert.deepEqual(run.mapping.map((m) => m.caso), [1, 2, 3, 4, 5]);
    assert.equal(run.status, 'RESERVED');

    const caf = configuredCaf(config, 39);
    const usage = await folioStore.peek({ caf });
    assert.equal(usage.used, 5);
    assert.equal(usage.available, 0);
  });
});

test('reserveSet es idempotente: llamarlo dos veces no reserva folios adicionales', async () => {
  await withEnv({ sii: { certificationSubmissionEnabled: true } }, async ({ config, folioStore, runStore }) => {
    const service = new CertificationSubmissionService(config, { folioStore, runStore });
    const first = await service.reserveSet();
    const second = await service.reserveSet();
    assert.deepEqual(first, second);
    const caf = configuredCaf(config, 39);
    const usage = await folioStore.peek({ caf });
    assert.equal(usage.used, 5, 'no debe haber reservado un segundo lote');
  });
});

test('reserveBatch no reserva nada si no hay 5 folios contiguos disponibles (todo o nada)', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'solvea-fiscal-cert-submit-short-'));
  try {
    const config = buildConfig(dir, {
      sii: { certificationSubmissionEnabled: true },
      credentials: { caf39Base64: mockCaf39({ from: 46, to: 48 }) } // sólo 3 folios disponibles
    });
    const folioStore = new FileFolioStore({ stateDir: dir });
    const runStore = new FileCertificationRunStore({ stateDir: dir });
    const service = new CertificationSubmissionService(config, { folioStore, runStore });
    await assert.rejects(() => service.reserveSet(), /contiguos disponibles/);
    const caf = configuredCaf(config, 39);
    const usage = await folioStore.peek({ caf });
    assert.equal(usage.used, 0, 'no debe quedar ninguna reserva parcial');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('concurrencia: dos reserveBatch simultáneos para runId distintos nunca se pisan ni duplican folios', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'solvea-fiscal-cert-submit-concurrency-'));
  try {
    const store = new FileFolioStore({ stateDir: dir });
    const caf = { id: 'concurrency-caf', from: 1, to: 10 };
    const [a, b] = await Promise.all([
      store.reserveBatch({ caf, count: 5, runId: 'run-a' }),
      store.reserveBatch({ caf, count: 5, runId: 'run-b' })
    ]);
    const allFolios = new Set([...a.folios, ...b.folios]);
    assert.equal(allFolios.size, 10, 'los 10 folios repartidos entre ambos runs deben ser todos distintos');
    const usage = await store.peek({ caf });
    assert.equal(usage.used, 10);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('submit() feliz: arma un único EnvioBOLETA con 5 DTE, sube una sola vez y persiste Track ID', async () => {
  await withEnv({ sii: { certificationSubmissionEnabled: true } }, async ({ config, folioStore, runStore }) => {
    let submitCalls = 0;
    const boletaClient = fakeBoletaClient({ trackId: '999888777666555' });
    const originalSubmit = boletaClient.submit;
    boletaClient.submit = async (...args) => { submitCalls += 1; return originalSubmit(...args); };

    const service = new CertificationSubmissionService(config, { folioStore, runStore, authClient: fakeAuthClient(), boletaClient });
    const run = await service.submit();

    assert.equal(submitCalls, 1, 'debe hacer exactamente un upload, no cinco');
    assert.equal(run.status, 'SUBMITTED');
    assert.equal(run.trackId, '999888777666555');
    assert.equal(run.folioFrom, 46);
    assert.equal(run.folioTo, 50);

    const caf = configuredCaf(config, 39);
    const usage = await folioStore.peek({ caf });
    assert.equal(usage.used, 5);
  });
});

test('submit() es idempotente: un segundo llamado no reserva ni sube de nuevo', async () => {
  await withEnv({ sii: { certificationSubmissionEnabled: true } }, async ({ config, folioStore, runStore }) => {
    let submitCalls = 0;
    const boletaClient = fakeBoletaClient();
    const originalSubmit = boletaClient.submit;
    boletaClient.submit = async (...args) => { submitCalls += 1; return originalSubmit(...args); };
    const service = new CertificationSubmissionService(config, { folioStore, runStore, authClient: fakeAuthClient(), boletaClient });

    const first = await service.submit();
    const second = await service.submit();
    assert.equal(submitCalls, 1);
    assert.deepEqual(first, second);
  });
});

test('submit() con fallo de red deja el estado UNCERTAIN y NUNCA libera los folios ni reintenta solo', async () => {
  await withEnv({ sii: { certificationSubmissionEnabled: true } }, async ({ config, folioStore, runStore }) => {
    const boletaClient = fakeBoletaClient({ shouldFail: true });
    const service = new CertificationSubmissionService(config, { folioStore, runStore, authClient: fakeAuthClient(), boletaClient });

    await assert.rejects(() => service.submit());
    const caf = configuredCaf(config, 39);
    const run = await service.getRun(certificationRunId(caf));
    assert.equal(run.status, 'UNCERTAIN');
    assert.equal(run.folioFrom, 46);
    assert.equal(run.folioTo, 50);

    const usage = await folioStore.peek({ caf });
    assert.equal(usage.used, 5, 'los folios siguen consumidos, nunca se liberan automáticamente');

    // Un segundo submit() no reintenta el envío automáticamente: exige primero consultar el
    // estado real en el SII (checkStatus). No se reservan folios nuevos en ningún caso.
    await assert.rejects(
      () => service.submit(),
      (error) => { assert.equal(error.status, 409); assert.match(error.message, /UNCERTAIN/); return true; }
    );
    const usageAfter = await folioStore.peek({ caf });
    assert.equal(usageAfter.used, 5, 'no debe reservar un segundo lote de folios');
  });
});

test('checkStatus(): consulta el SII con el Track ID persistido y actualiza el estado sin tocar folios', async () => {
  await withEnv({ sii: { certificationSubmissionEnabled: true } }, async ({ config, folioStore, runStore }) => {
    const service = new CertificationSubmissionService(config, {
      folioStore, runStore, authClient: fakeAuthClient(),
      boletaClient: fakeBoletaClient({ trackId: '111222333444555' })
    });
    await service.submit();

    const acceptedStatusClient = fakeBoletaClient({
      trackId: '111222333444555',
      status: { trackId: '111222333444555', estado: 'EOK', glosa: '', accepted: true, rejected: false, final: true, informados: 5, aceptados: 5, rechazados: 0, reparos: 0, raw: {} }
    });
    const service2 = new CertificationSubmissionService(config, { folioStore, runStore, authClient: fakeAuthClient(), boletaClient: acceptedStatusClient });
    const run = await service2.checkStatus();
    assert.equal(run.status, 'ACCEPTED');
    assert.equal(run.siiResponse.aceptados, 5);

    const caf = configuredCaf(config, 39);
    const usage = await folioStore.peek({ caf });
    assert.equal(usage.used, 5);
  });
});

test('EnvioBOLETA con los 5 DTE reales: exactamente un SetDTE, 5 DTE, SubTotDTE correcto y orden CASO-1..5 preservado', async () => {
  await withEnv({ sii: { certificationSubmissionEnabled: true } }, async ({ config, folioStore, runStore }) => {
    let capturedXml = '';
    const boletaClient = fakeBoletaClient();
    const originalSubmit = boletaClient.submit;
    boletaClient.submit = async (args) => { capturedXml = args.xml; return originalSubmit(args); };
    const service = new CertificationSubmissionService(config, { folioStore, runStore, authClient: fakeAuthClient(), boletaClient });
    await service.submit();

    const doc = new DOMParser().parseFromString(capturedXml, 'text/xml');
    const setDtes = xpath.select("//*[local-name(.)='SetDTE']", doc);
    assert.equal(setDtes.length, 1, 'debe haber exactamente un SetDTE');
    const dtes = xpath.select("//*[local-name(.)='SetDTE']/*[local-name(.)='DTE']", doc);
    assert.equal(dtes.length, 5, 'debe haber exactamente 5 DTE dentro del SetDTE');
    const subTotDte = xpath.select("//*[local-name(.)='SubTotDTE']", doc);
    assert.equal(subTotDte.length, 1);
    const tpoDte = xpath.select("//*[local-name(.)='SubTotDTE']/*[local-name(.)='TpoDTE']", doc)[0].textContent;
    const nroDte = xpath.select("//*[local-name(.)='SubTotDTE']/*[local-name(.)='NroDTE']", doc)[0].textContent;
    assert.equal(tpoDte, '39');
    assert.equal(nroDte, '5');

    const folios = xpath.select("//*[local-name(.)='SetDTE']/*[local-name(.)='DTE']//*[local-name(.)='Folio']", doc).map((n) => n.textContent);
    assert.deepEqual(folios, ['46', '47', '48', '49', '50'], 'los folios deben aparecer en el orden CASO-1..5 -> 46..50');

    const razonRefs = xpath.select("//*[local-name(.)='RazonRef']", doc).map((n) => n.textContent);
    assert.deepEqual(razonRefs, ['CASO-1', 'CASO-2', 'CASO-3', 'CASO-4', 'CASO-5']);
  });
});

test('el sobre firmado con 5 DTE verifica correctamente contra el certificado (independiente del orquestador)', () => {
  const dteFixture = (folio) => `<?xml version="1.0" encoding="ISO-8859-1"?><DTE version="1.0"><Documento ID="F${folio}T39"><Encabezado><IdDoc><TipoDTE>39</TipoDTE><Folio>${folio}</Folio></IdDoc></Encabezado></Documento><Signature xmlns="http://www.w3.org/2000/09/xmldsig#"><SignedInfo/></Signature></DTE>`;
  const pfxBase64 = createTestPfx('local-set-test');
  const credentials = extractPfxCredentials({ pfxBase64, password: 'local-set-test' });
  const setId = 'SetCertificacion_778084066_46_50';
  const unsigned = buildUnsignedEnvioBoletaSet({
    dteXmlList: [46, 47, 48, 49, 50].map(dteFixture),
    issuerRut: '77808406-6', senderRut: '19105425-3',
    resolutionDate: '2026-08-31', resolutionNumber: 0, setId
  });
  const signed = signEnvioBoleta({ xml: unsigned, credentials, setId });
  assert.equal(signed.verified, true);
});

test('RCOF real: al existir una corrida con folios reservados, usa 46-50 en vez del rango preview', async () => {
  await withEnv({ sii: { certificationSubmissionEnabled: true } }, async ({ config, folioStore, runStore }) => {
    const { prepareCertificationSet, prepareCertificationRcof } = await import('../src/sii/certification-set.js');
    const { IssueService } = await import('../src/services/issue-service.js');
    const service = new CertificationSubmissionService(config, { folioStore, runStore, authClient: fakeAuthClient(), boletaClient: fakeBoletaClient() });
    const run = await service.submit();

    const issueService = new IssueService(config, { folioStore });
    const cases = await prepareCertificationSet(issueService);
    const rcof = prepareCertificationRcof(config, cases, { runFolios: run.mapping.map((m) => m.folio) });

    assert.equal(rcof.preview, false);
    assert.equal(rcof.folios.from, 46);
    assert.equal(rcof.folios.to, 50);
    assert.match(rcof.xml, /<Inicial>46<\/Inicial><Final>50<\/Final>/);
  });
});
