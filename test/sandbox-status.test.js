import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSubmissionStatus } from '../src/sii/boleta-client.js';
import { SandboxService } from '../src/services/sandbox-service.js';
import { StatusService } from '../src/services/status-service.js';
import { MemorySubmissionStore } from '../src/services/submission-store.js';

const certificationConfig = {
  mode: 'certification',
  issuer: { rut: '76000000-0' },
  credentials: {},
  sii: {
    networkEnabled: true,
    authBaseUrl: 'https://apicert.sii.cl/recursos/v1',
    boletaBaseUrl: 'https://pangal.sii.cl/recursos/v1',
    timeoutMs: 1000
  }
};

const fakeCredentials = {
  privateKeyPem: 'private',
  certificatePem: 'certificate',
  fingerprint256: 'AA:BB:CC',
  validFrom: '2026-01-01T00:00:00.000Z',
  validTo: '2027-01-01T00:00:00.000Z'
};

test('normaliza estados SII sin confundir Track ID con aceptación', () => {
  const received = normalizeSubmissionStatus({ estado: 'PDR', glosa: 'En proceso' }, '100');
  assert.equal(received.accepted, false);
  assert.equal(received.rejected, false);
  assert.equal(received.final, false);

  const accepted = normalizeSubmissionStatus({ estado: 'EPR', informados: 1, aceptados: 1, rechazados: 0, reparos: 0 }, '101');
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.rejected, false);
  assert.equal(accepted.final, true);

  const rejected = normalizeSubmissionStatus({ estado: 'RSC', glosa: 'Rechazado por schema' }, '102');
  assert.equal(rejected.accepted, false);
  assert.equal(rejected.rejected, true);
  assert.equal(rejected.final, true);
});

test('refresca Track ID y persiste aceptación definitiva', async () => {
  const store = new MemorySubmissionStore();
  await store.put('tax-sale-1-boleta_afecta', {
    payloadHash: 'abc',
    state: 'submitted',
    trackId: '123456789012345',
    response: {
      status: 'processing',
      fiscalStage: 'sii_submitted',
      sii: { submitted: true, trackId: '123456789012345', accepted: false }
    }
  });

  const authClient = {
    async authenticate(credentials) {
      assert.equal(credentials, fakeCredentials);
      return { token: 'TOKEN123456' };
    }
  };
  const boletaClient = {
    async getSubmissionStatus({ token, companyRut, trackId }) {
      assert.equal(token, 'TOKEN123456');
      assert.equal(companyRut, '76000000-0');
      assert.equal(trackId, '123456789012345');
      return normalizeSubmissionStatus({ estado: 'EPR', informados: 1, aceptados: 1, rechazados: 0 }, trackId);
    }
  };

  const service = new StatusService(certificationConfig, {
    submissionStore: store,
    authClient,
    boletaClient,
    credentials: fakeCredentials
  });
  const response = await service.refresh({ idempotencyKey: 'tax-sale-1-boleta_afecta' });
  assert.equal(response.status, 'issued');
  assert.equal(response.fiscalStage, 'sii_accepted');
  assert.equal(response.sii.accepted, true);
  assert.equal((await store.get('tax-sale-1-boleta_afecta')).state, 'accepted');
});

test('probe sandbox autentica sin devolver token ni consumir folio', async () => {
  const authClient = {
    async authenticate(credentials) {
      assert.equal(credentials, fakeCredentials);
      return {
        seed: '123456789',
        token: 'TOKEN_SUPER_SECRETO',
        signedSeedVerified: true,
        obtainedAt: '2026-08-31T20:00:00-04:00'
      };
    }
  };
  const service = new SandboxService(certificationConfig, { authClient, credentials: fakeCredentials });
  const result = await service.probe();
  assert.equal(result.ok, true);
  assert.equal(result.authentication.tokenObtained, true);
  assert.equal(result.safe.tokenReturned, false);
  assert.equal(result.safe.folioConsumed, false);
  assert.equal(result.safe.documentSubmitted, false);
  assert.equal('token' in result.authentication, false);
});

test('probe sandbox se niega a usar endpoints de producción', async () => {
  const unsafe = structuredClone(certificationConfig);
  unsafe.sii.authBaseUrl = 'https://api.sii.cl/recursos/v1';
  const service = new SandboxService(unsafe, { credentials: fakeCredentials, authClient: { authenticate: async () => ({}) } });
  await assert.rejects(() => service.probe(), /apicert\.sii\.cl/);
});
